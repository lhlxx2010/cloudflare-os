// The MCP gatekeeper: connects any Model Context Protocol server as a Gadgets capability.
//
// Every call is either an observation or an approval-gated action, `readOnlyHint` decides which,
// writes are queued rather than performed inline, and per-tool TypeScript is generated from the
// server's schemas so Code Mode works.
//
// The endpoint is whatever a user typed, so annotations never earn auto-approval here and a Gadget
// bound to it is owner-only. See `sharing-policy.ts` and the README.
import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  stripTrailingSlashes,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ToolCatalog } from "@gadgets/mcp-shared/client";
import {
  classifyTool,
  type ServerTrust,
} from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { fetchTools, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import { looksLikePortal } from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  requireCompleteCatalogForToolSelection,
  sameEndpoint,
  scopeAllows,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import { validateCustomEndpoint } from "@gadgets/mcp-shared/endpoint";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import {
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import { connectFormHtml } from "./connect-form.js";
import { serverIdFromEndpoint } from "./server-id.js";
import { mcpResourceFor, mcpResources } from "./resources.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import MCP_LOGO_SVG from "./mcp-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";

const VENDOR_ID = "mcp";

// A user-supplied endpoint vouches only for itself, so its annotations never drive auto-approval.
// The tier says nothing about sharing; a Gadget bound to either tier is owner-only.
const TRUST: ServerTrust = "byo";

const logger = createLogger<McpLogFields>({ component: "gatekeeper.mcp", vendorId: VENDOR_ID });

const MCP_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(MCP_LOGO_SVG)}`;
const MCP_AVATAR: AvatarImage = { url: MCP_LOGO_URL };

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp");
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the connect form and the OAuth callback.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce, path) => {
        if (request.method !== "GET" && request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        // A reconnect already knows its endpoint. Ignore a stale or malicious replacement URL.
        if (await account.hasEndpoint()) {
          return continueConnect(account, initiationNonce, null, env, path);
        }
        if (request.method === "GET") {
          if (!(await account.isAwaitingSelection(initiationNonce))) {
            return htmlResponse(INVALID_LINK_HTML, 400);
          }
          return htmlResponse(connectFormHtml(path));
        }
        const form = await request.formData();
        return continueConnect(
          account, initiationNonce, String(form.get("url") ?? ""), env, path);
      },
    });
  },
};

// Validates the endpoint the user typed, then hands off to the account DO, which owns every
// credential. `endpointUrl` is null on a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  endpointUrl: string | null,
  env: Env,
  formPath: string,
): Promise<Response> {
  let target: ConnectedServer | null = null;

  if (endpointUrl !== null) {
    const validated = validateCustomEndpoint(env, endpointUrl);
    if (!validated.ok) {
      return htmlResponse(connectFormHtml(formPath, validated.reason), 400);
    }
    // `serverName` is a placeholder until the handshake reports the server's own name, and `auth` is
    // a guess that `beginConnect` corrects to `"none"` if the endpoint turns out to be public.
    target = {
      endpoint: validated.url,
      serverId: serverIdFromEndpoint(validated.url),
      serverName: hostOf(validated.url),
      provenance: "user",
      auth: "oauth",
    };
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, target);
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(connectFormHtml(
      formPath, err instanceof Error ? err.message : String(err)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "MCP 服务器",
      url: "https://modelcontextprotocol.io",
      logo: MCP_AVATAR,
      color: "#1a1d21",
      tagline: "连接任意 Model Context Protocol 服务器",
      description:
        "连接 Model Context Protocol 服务器，并在 Gadget 中使用其工具。读取操作会立即执行，" +
        "任何写入操作都需要等待你的批准。",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.McpAccount.get(accountId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return mcpResources(fetchOptions(this.env).allowInsecure === true);
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only; the per-tool `callTool` overloads are
    // generated per resource in `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account DO — owns the endpoint choice and every credential for it.

/**
 * One connected MCP server, for one user: `McpAccountBase` plus where this Worker lives and how it
 * mints an account. Nothing outside this object ever sees a credential.
 */
export class McpAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  /**
   * The connect handler needs both over RPC: one to decide whether to show the endpoint form, the
   * other to reject a stale link before doing any work.
   */
  async hasEndpoint(): Promise<boolean> {
    return this.hasConnectedServer();
  }

  async isAwaitingSelection(initiationNonce: string): Promise<boolean> {
    return this.awaitingSelection(initiationNonce);
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env>
  implements GatekeeperUser {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: MCP_AVATAR, baseUrl: getBaseUrl(this.env) };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return mcpResources(fetchOptions(this.env).allowInsecure === true);
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const server = await this.#account().getServer();

    // The account is bound to one endpoint, so a resource URL naming anything else is not this
    // account's to grant, and the protocol-specific resource pattern matches any URL so this is the whole
    // test. Compared in full rather than by origin: one host can front `/mcp` and `/mcp-v2` as
    // unrelated servers, and the facet calls the endpoint recorded on the account regardless.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), server.endpoint)) {
      throw new Error(
        `此连接对应 ${server.endpoint}，而不是 ${endpointOfResourceUrl(requested)}。`);
    }

    // The fragment records how much of the endpoint this binding may call; see `scope.ts`. A
    // per-upstream-server scope belongs to the MCP Server Portals connector, and this gatekeeper
    // treats an endpoint as a single server, so it is refused rather than silently ignored.
    const scope = parseToolScope(requested);
    if (scope.serverId !== undefined) {
      throw new Error(
        `“${url}”将授权范围限定为网关后的单个服务器，但此连接器不支持这种方式。` +
        `请改用 MCP Server Portals 连接器连接此端点。`);
    }
    if (scope.tools !== undefined) {
      validateToolScopeAgainstCatalog(
        scope, await fetchTools(this.env, this.#account(), server.endpoint));
    }

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: server.serverName,
      scope,
    };
    return {
      class: this.ctx.exports.McpGatekeeperImpl({ props }),
      resource: mcpResourceFor(server.endpoint),
    };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, this.#account())),
    };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier

// Required by the `GatekeeperUser` contract but never interrogated, since `addObserver` refuses
// everyone. Carries no props for the same reason.
@validateRpc()
export class McpVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #toolsPromise: Promise<ToolCatalog> | undefined;

  constructor(env: Env, account: DurableObjectStub<McpAccount>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async getEndpoint(): Promise<string> {
    return (await this.#account.getServer()).endpoint;
  }

  // One `tools/list` per configurator frame, shared by every question the form asks.
  #tools(): Promise<ToolCatalog> {
    this.#toolsPromise ??= (async () => {
      const server = await this.#account.getServer();
      return await fetchTools(this.#env, this.#account, server.endpoint);
    })();
    return this.#toolsPromise;
  }

  // Every tool the grant may cover, annotated with whether calls need approval.
  async listToolOptions(): Promise<ConfiguratorUIOption[]> {
    const { tools, truncated } = await this.#tools();
    requireCompleteCatalogForToolSelection(truncated);
    const isPortal = looksLikePortal(tools, truncated);

    return tools
      .filter(tool => scopeAllows({}, tool.name, isPortal))
      .map(tool => ({
        value: tool.name,
        title: tool.title ?? tool.name,
        subtitle: tool.description?.split(/\r?\n/)[0],
        // Surfaced here so the person granting can see, per tool, whether calls will interrupt them.
        meta: classifyTool(tool, TRUST).mode === "read" ? "只读" : "需要批准",
      }));
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  // Display slug, for the binding name and session type; see `ConnectedServer.serverId`.
  serverId: string;
  serverName: string;
  // How much of the endpoint this binding may call. Empty means the whole endpoint, including tools
  // it publishes later.
  scope: ToolScope;
};


export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({ serverHost: hostOf(this.ctx.props.endpoint) });
  }

  /**
   * Namespaces this binding's action-kind tags, so a pre-approval for one server's `create_issue`
   * cannot apply to another's.
   *
   * The whole endpoint is the identity, matching `sameEndpoint` and every other place a grant is
   * compared. `serverId` is a display slug and collides across hosts, but the origin is not enough
   * either: one host can front `/mcp` and `/mcp-v2` as unrelated servers, and keying on the origin
   * let an always-approve decision for a tool on one of them silently auto-apply to the same tool
   * name on the other. `endpointTag` is that identity, shared with `sameEndpoint` so the two
   * cannot drift.
   */
  protected get actionScopeTag(): string {
    return `mcp:${endpointTag(this.ctx.props.endpoint)}`;
  }

  protected account(): ConnectionAccount {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected get trust(): ServerTrust {
    return TRUST;
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return `MCP 服务器 ${hostOf(this.ctx.props.endpoint)}`;
  }

  get serverName(): string {
    return this.ctx.props.serverName;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope, serverName } = this.ctx.props;

    const counts = `${reads} 个只读，${tools.length - reads} 个需要批准`;
    const snippet = scope.tools
      ? `${serverName} 上指定的 ${scope.tools.length} 个 MCP 工具 \u2014 ${counts}。其他工具将被拒绝。`
      : `${serverName} 上的全部 ${tools.length} 个 MCP 工具 \u2014 ${counts}。`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${serverName}: ${scope.tools[0]}` : serverName,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.ctx.props.serverId)}`,
      tsType: sessionTypeName(this.ctx.props.serverId, this.resourceUrl),
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.ctx.props.serverId,
      serverName: this.ctx.props.serverName,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: TRUST,
      tools: await this.tools(),
    });
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
