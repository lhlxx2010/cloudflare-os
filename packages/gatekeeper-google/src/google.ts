import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor, ActionKind, stripTrailingSlashes } from '@gadgets/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleVerifiedEmail, GmailApi, GmailMessageRaw, GmailOutboundMessage, GoogleAccessToken, normalizeEmailRecipients, revokeGoogleToken } from "./google-api";
import {
  GmailSession, GmailThread, GmailMessage,
  GmailThreadInfo, GmailThreadEntry, GmailMessageInfo, GmailLabel, GmailSystemLabel, EmailContent
} from "./types";
import { GoogleDocSession, DocMetadata } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import type {
  GoogleSpreadsheetSession, SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode,
} from "./sheets-types";
import { docToMarkdown, markdownToDocRequests, computeReplaceOperations, DocSnapshot } from "./markdown-converter";
import { BigQueryApi, DEFAULT_MAX_BYTES_BILLED } from "./bigquery-api";
import {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQuerySession, BigQueryTable,
} from "./bigquery-types";
import {
  calendarEventOverlaps, calendarEventSortKey, eventPatchToGoogle, GoogleCalendarApi,
  validateCalendarTimeWindow,
} from "./calendar-api";
import type {
  CalendarAvailabilityMode, CalendarEvent, CalendarEventDraft, CalendarEventPatch,
  CalendarListEventsOptions, CalendarSendUpdates, CalendarTime, GoogleCalendarCapabilities,
  GoogleCalendarInfo, GoogleCalendarSession, PersonAvailability,
} from "./calendar-types";
import TYPES_CODE from "./types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";
import {
  BigQueryConfiguratorUI,
  CalendarConfiguratorUI,
  GmailConfiguratorUI,
  GoogleDocConfiguratorUI,
  GoogleSheetsConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import GOOGLE_DOC_CONFIGURATOR_HTML from "./generated/google-doc-configurator-ui.txt";
import GOOGLE_SHEETS_CONFIGURATOR_HTML from "./generated/google-sheets-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest, ACCESS_TOKEN_EXPIRY_SAFETY_MS } from "./auth-retry";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "google";
const logger = obsContext.createLogger({
  component: "gatekeeper.google", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one nonce is active at a time;
// the `stage` field tracks where we are in the flow.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;    // 10 minutes

// Ceilings on the OAuth round trips that run while holding the credential mutex. Each must be
// bounded: an unbounded hang keeps the mutex, and every caller waiting for a token then queues
// behind it.
const TOKEN_MINT_TIMEOUT_MS = 20 * 1000;
const AUTH_CODE_EXCHANGE_TIMEOUT_MS = 30 * 1000;
const TOKEN_REVOKE_TIMEOUT_MS = 10 * 1000;

// How long a permanent mint failure suppresses further attempts. Long enough to absorb the burst a
// revoke produces (every outstanding token 401s at once, so callers arrive within milliseconds),
// short enough that the account recovers on its own once the cause is fixed — an admin lifting a
// scope restriction leaves nothing for us to observe, so we have to re-ask Google eventually.
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Base URL (protocol+host+optional path) at which the default fetch handler is served. Should
  // NOT include a trailing slash. Omit for localhost dev server.
  BASE_URL?: string;
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

// Well-known Gmail system label IDs — derived from GmailSystemLabel so the
// type and runtime set can't drift apart.
const SYSTEM_LABEL_IDS: GmailSystemLabel[] = [
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED",
  "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PRIMARY", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];
const SYSTEM_LABELS: Set<string> = new Set(SYSTEM_LABEL_IDS);

// Resolve raw Gmail label IDs into GmailLabel objects with human-readable names.
// System labels use their well-known name; custom labels are resolved via the
// labelMap (fetched from Gmail's labels.list API).
function toLabelObjects(labelIds: string[], labelMap: Map<string, string>): GmailLabel[] {
  return labelIds.map(id => {
    if (SYSTEM_LABELS.has(id)) {
      return { id, name: id as GmailSystemLabel, type: "system" as const };
    }
    let name = labelMap.get(id) || id;
    return { id, name, type: "custom" as const };
  });
}

function validateGmailQueryForGrouping(query: string): void {
  if (new TextEncoder().encode(query).byteLength > MAX_GMAIL_QUERY_BYTES) {
    throw new Error(`Gmail 搜索查询最多为 ${MAX_GMAIL_QUERY_BYTES} 字节。`);
  }
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (const char of query) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '{') {
      stack.push(char);
    } else if (char === ')' || char === '}') {
      const expected = char === ')' ? '(' : '{';
      if (stack.pop() !== expected) throw new Error("Gmail 查询的分组定界符不匹配。");
    }
  }
  if (quote || stack.length > 0) throw new Error("Gmail 查询中存在未闭合的分组或引号。");
}

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/google");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// =======================================================================================

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>授权完成。你可以关闭此标签页并返回 NINT os。
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>授权链接已过期</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1d4ed8; font-size: 1.5rem; margin: 0 0 1rem 0;">授权链接已过期</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">此授权链接无效或已过期。请返回 NINT os 后重试。</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #1d4ed8; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">关闭</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>需要配置</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1d4ed8; font-size: 1.5rem; margin: 0 0 1rem 0;">Google Gatekeeper 尚未配置</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">请参阅 README.md，了解如何配置 OAuth 客户端 ID 和密钥，使此 NINT os 实例能够访问 Google API。</p>
    </div>
  </body>
</html>`;

// OAuth scopes we always request, used to identify the account (name, email, avatar). Not tied to
// any resource type.
const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Minimal scopes for sign-in only (verify the user's email). Used when connecting in "auth" mode;
// the resulting grant is transient. (Same as IDENTITY_SCOPES — sign-in needs no resource scopes.)
const AUTH_SCOPES = IDENTITY_SCOPES;

const BIGQUERY_HOST = "bigquery.googleapis.com";

const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail 邮箱",
  description: "读取电子邮件并应用标签。",
  grantable: true,
};

const GOOGLE_DOC_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/document/d/:docId/*",
  title: "Google 文档",
  description:
      "读取和编辑你选择的文档。",
  grantable: true,
};

const GOOGLE_SHEETS_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  title: "Google 电子表格",
  description: "读取你选择的电子表格中的值。",
  grantable: true,
};

const GOOGLE_CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: "https://calendar.google.com/calendar/:calendarId/*",
  title: "Google 日历",
  description:
      "读取和管理 Google 日历。",
  grantable: true,
};

const BIGQUERY_RESOURCE: SupportedResource = {
  urlPattern: `https://${BIGQUERY_HOST}/:projectId/*`,
  title: "BigQuery",
  description: "选择 Google Cloud 项目，然后可以选择将访问范围缩小到数据集或表。",
  grantable: true,
};

// Accounts connected before per-resource scope tracking received scopes for exactly these
// resources.
const LEGACY_GRANTED_RESOURCE_URL_PATTERNS = [
  GMAIL_RESOURCE.urlPattern,
  GOOGLE_DOC_RESOURCE.urlPattern,
  BIGQUERY_RESOURCE.urlPattern,
];

const RESOURCE_SCOPES: {resource: SupportedResource, scopes: string[]}[] = [
  {
    resource: GMAIL_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  },
  {
    resource: GOOGLE_DOC_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      // Read-only Drive file metadata, used to power the doc picker when connecting a Google Doc.
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  },
  {
    resource: GOOGLE_SHEETS_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      // Read-only Drive file metadata, used to power the spreadsheet picker.
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  },
  {
    resource: GOOGLE_CALENDAR_RESOURCE,
    scopes: [
      // Read-only calendar list, used to power the calendar picker when connecting a calendar.
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  },
  {
    resource: BIGQUERY_RESOURCE,
    scopes: [
      // `bigquery` (not `bigquery.readonly`): dry-runs go through `jobs.insert` for scope
      // enforcement, which `readonly` doesn't permit. Read-only is enforced at the API layer.
      "https://www.googleapis.com/auth/bigquery",
    ],
  },
];

const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);

function validateResourceUrlPatterns(resourceUrlPatterns?: string[]): void {
  if (resourceUrlPatterns === undefined) return;

  let knownPatterns = new Set(RESOURCE_SCOPES.map(entry => entry.resource.urlPattern));
  let unknownPatterns = resourceUrlPatterns.filter(pattern => !knownPatterns.has(pattern));
  if (unknownPatterns.length > 0) {
    throw new Error(`未知的可授权资源 URL 模式：${unknownPatterns.join(", ")}`);
  }
}

// The OAuth scopes to request for the given grantable resource `urlPattern`s.
function resourceUrlPatternsToOAuthScopes(resourceUrlPatterns?: string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);

  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns === undefined ||
        resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

function grantedResourcesFromScopes(grantedOAuthScopes: string[]): string[] {
  let granted = new Set(grantedOAuthScopes);
  return RESOURCE_SCOPES
      .filter(entry => entry.scopes.every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}

const GOOGLE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GOOGLE_LOGO_SVG)}`;

// Main HTTP UI entrypoint. We only use this to initiate and complete OAuth requests to Google.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`请求路径 ${url.pathname} 与 BASE_URL 路径 ${basePath} 不匹配`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      // Add newly-requested scopes to any the user already granted, rather than replacing them.
      newUrl.searchParams.set("include_granted_scopes", "true");
      newUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("错误：未提供“state”");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("错误：“state”格式不正确");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("错误：未提供“code”");

      let userObjectId = ctx.exports.UserAccount.idFromString(doId);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    } else {
      return new Response("未找到", {status: 404});
    }
  }
}

// =======================================================================================

// Top-level API exposed to the Workshop.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google",
      url: "https://google.com",
      logo: { url: GOOGLE_LOGO_URL },
      color: "#e8f0fe",
      tagline: "起草回复、编辑文档、读取表格、管理日历并分析数据",
      description:
          "连接你的 Google 账户，让 NINT os 访问 Gmail、Google Docs、Google Sheets、" +
          "Google Calendar 和 BigQuery。你可以构建用于分流邮件、起草和编辑文档、读取电子表格、" +
          "寻找专注时间、安排会议或对数据运行分析查询的智能体。",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let requestedScopes = authOnly
        ? AUTH_SCOPES
        : resourceUrlPatternsToOAuthScopes(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedScopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return [
      TYPES_CODE, DOCS_TYPES_CODE, SHEETS_TYPES_CODE, CALENDAR_TYPES_CODE, BIGQUERY_TYPES_CODE,
    ].join("\n");
  }
}

export class UserAccount extends DurableObject<Env> {
  // Serialize minting, reconnect, and revoke against each other. Minting is a network round trip, so
  // without this a single invalidated token has every concurrent caller mint its own — a burst
  // against Google's token endpoint that may get rate-limited, turning a recoverable 401 into a hard
  // failure. It also keeps a mint from interleaving with credentials being replaced or wiped.
  //
  // A promise chain rather than blockConcurrencyWhile: that would freeze the whole object for the
  // duration of the fetch, and an exception or a 30s overrun inside it resets the Durable Object.
  // Same pattern as the Slack and Supabase gatekeepers.
  #credentialUpdate: Promise<void> = Promise.resolve();

  // The last mint that failed permanently — revoked credentials, or a scope an admin has blocked.
  #mintFailure: { error: Error; at: number } | undefined;

  async #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedScopes: string[], ephemeral?: boolean) {
    // If we have no API key in 1 hour, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Prepare this account for a reconnect flow. The next acceptAuthCode() call will replace the
  // existing refresh token and notify via credentialsRestored() instead of complete().
  //
  // `requestedScopes` is the full set of OAuth scopes to request on the reauthorization. For a
  // plain reconnect this is the previously-granted set; for a scope expansion it's the union of
  // the granted scopes and the newly-needed ones.
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // The grantable resource `urlPattern`s currently granted on this account. Used to decide
  // whether ensureResources() needs to expand.
  //
  // Legacy accounts connected before granular scope tracking have no recorded granted scopes.
  // Report only the resources included in that historical grant, so newer resources correctly
  // trigger OAuth scope expansion.
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    let granted = this.ctx.storage.kv.get<string[]>("grantedScopes");
    if (granted === undefined) {
      return [...LEGACY_GRANTED_RESOURCE_URL_PATTERNS];
    }
    return grantedResourcesFromScopes(granted);
  }

  // Called by the fetch handler when the user visits the initiation URL. Verifies the initiation
  // nonce, consumes it, and returns a fresh OAuth nonce plus the scopes to request. Returns null if
  // the nonce is invalid or expired.
  async beginOAuthFlow(initiationNonce: string): Promise<{oauthNonce: string, scopes: string[]} | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    // Replace the consumed initiation nonce with a fresh OAuth nonce.
    let oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    // Fall back to all scopes for legacy flows that didn't record a requested set.
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes")
        ?? resourceUrlPatternsToOAuthScopes();
    return {oauthNonce, scopes};
  }

  // Returns false if the OAuth nonce is invalid or expired.
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    // Verify and consume the OAuth nonce.
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("Google Gatekeeper 尚未配置。");
    }

    // The credential swap is serialized against minting and revoke, but the callbacks below are
    // not: they are outbound RPCs that can re-enter this object, and awaiting one while holding the
    // mutex would deadlock. So the locked section returns what the notifications need and the
    // notifications happen after it releases.
    let completion = await this.#updateCredentials(async () => {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        // Must have timed out.
        throw new Error("完成授权所用时间过长，请重试。");
      }

      let response = await exchangeAuthCode(
          code, clientId, clientSecret, getBaseUrl(this.env) + "/oauth",
          AbortSignal.timeout(AUTH_CODE_EXCHANGE_TIMEOUT_MS));

      if (!response.refreshToken) {
        throw new Error("OAuth 交换未返回刷新令牌。");
      }

      this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      // Record what Google actually granted (the user may have declined some requested scopes).
      this.ctx.storage.kv.put<string[]>("grantedScopes", response.grantedScopes);
      this.ctx.storage.kv.delete("requestedScopes");

      let reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
      if (reconnecting) this.ctx.storage.kv.delete("reconnecting");
      return { callback, reconnecting: !!reconnecting };
    });

    let callback = completion.callback;
    if (completion.reconnecting) {
      // Reconnect flow: credentials replaced above, notify restoration.
      await callback.credentialsRestored();
    } else {
      // Initial connect flow: create the user entrypoint and notify completion.
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller has read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call the provider's revoke endpoint (that could
      // invalidate the user's other grants for this OAuth client); we just drop our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }

    return true;
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  /**
   * Whether the stored token still satisfies this request, i.e. can be served without minting.
   *
   * A `staleToken` request comes from a caller that just had a 401. It must not be answered from the
   * expiry check — the whole point is that Google rejected a token that had not yet expired. It is
   * satisfied only if the stored token is no longer the one that failed, which means another caller
   * already replaced it and this caller should take theirs.
   */
  #tokenSatisfies(cached: GoogleAccessToken | undefined, opts?: AccessTokenRequest)
      : cached is GoogleAccessToken {
    if (!cached) return false;
    // Expiry gates every path — no request, however it is phrased, is answered with a token that is
    // already inside the safety window.
    if (cached.expires.valueOf() <= Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) return false;
    if (opts?.staleToken !== undefined) return cached.token !== opts.staleToken;
    return !opts?.forceRefresh;
  }

  async getAccessToken(opts?: AccessTokenRequest): Promise<GoogleAccessToken> {
    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("Google Gatekeeper 尚未配置。");
    }

    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      throw new Error("尚未设置刷新令牌");
    }

    // Fast path, deliberately outside the lock: the overwhelmingly common case is a valid cached
    // token, and that must not serialize behind anything.
    let cached = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
    if (this.#tokenSatisfies(cached, opts)) {
      return cached;
    }

    // Serialized so a burst of concurrent 401s collapses into one token exchange. The re-check
    // inside the lock is what does the collapsing — the lock alone would just queue the mints.
    return this.#updateCredentials(async () => {
      let fresh = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
      if (this.#tokenSatisfies(fresh, opts)) {
        return fresh;
      }

      // A mint already established that these credentials are permanently dead. Fail the same way
      // without asking Google again — see #mintFailure.
      if (this.#mintFailure && Date.now() - this.#mintFailure.at < MINT_FAILURE_COOLDOWN_MS) {
        throw this.#mintFailure.error;
      }

      // Re-read rather than closing over the outer value: the credentials may have been replaced
      // while this call waited for the lock.
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (!refreshToken) {
        throw new Error("尚未设置刷新令牌");
      }

      // Logged before the exchange so a mint that fails or hangs still leaves a trace. The events
      // are distinct because their rates mean different things: `expiry` should tick about once per
      // token lifetime, whereas `rejected` means a token was invalidated early and the 401 retry
      // healed it — and a burst of 401s should still produce exactly one.
      logger.info("minting Google access token", {
        event: opts?.staleToken !== undefined
            ? "google.token.mint.rejected"
            : "google.token.mint.expiry",
      });

      // TODO: If new refresh token returned, use it.
      let result = await getAccessToken(refreshToken, clientId, clientSecret,
          AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS));
      if (!result.ok) {
        // Both are permanent, so both mark the connection dead. They differ in the remedy:
        // re-authenticating fixes a revoked grant but cannot grant a scope an admin has blocked.
        let error = new Error(
            result.reason === "policyBlocked"
                ? "A Google Workspace admin has restricted access this connection needs " +
                  `(${result.detail}). Ask your administrator to allow it — re-authenticating ` +
                  "will not help."
                : "Google credentials have expired or been revoked. Please re-authenticate.");
        // Recorded before notifying so only the first caller of a burst does either.
        this.#mintFailure = { error, at: Date.now() };
        this.#notifyCredentialsDead();
        throw error;
      }

      // Backstop for the credential mutators: the mutex already keeps them from interleaving with a
      // mint, so this should be unreachable. It stays because publishing a token minted against a
      // refresh token that is no longer current would resurrect a revoked account.
      if (this.ctx.storage.kv.get<string>("refreshToken") !== refreshToken) {
        logger.warn("discarded a Google access token minted against superseded credentials", {
          event: "google.token.mint.superseded",
        });
        let current = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
        if (current) return current;
        throw new Error("刷新期间 Google 凭据发生变化，请重试。");
      }

      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", result.token);
      return result.token;
    });
  }

  // Tell the workshop the credentials are permanently dead so the UI prompts a reconnect instead of
  // every call failing opaquely. Fire and forget — a notification failure must not mask the error.
  #notifyCredentialsDead(): void {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    callback?.credentialsExpired().catch(notifyErr => {
      logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed", error: notifyErr,
      });
    });
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login). Serialized so the wipe cannot land in the
    // middle of a mint, leaving a freshly minted token behind on a deleted account.
    await this.#updateCredentials(async () => {
      if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.deleteAll();
      }
    });
  }

  async revoke(): Promise<void> {
    await this.#updateCredentials(async () => {
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (refreshToken) {
        await revokeGoogleToken(refreshToken, AbortSignal.timeout(TOKEN_REVOKE_TIMEOUT_MS));
      }
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let tokenPromise = obj.getAccessToken();
    let grantedResourcesPromise = obj.getGrantedResourceUrlPatterns();
    let token = await tokenPromise;
    let description = await getGoogleAccountDescription(token.token);

    description.grantedResourceUrlPatterns = await grantedResourcesPromise;
    return description;
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Contract is Promise<string | null>: never throw. The access token fetch can throw if the
    // (possibly transient sign-in) grant has been cleaned up, and the userinfo call can throw on a
    // non-2xx response — treat any failure as "no email available".
    try {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      let token = await obj.getAccessToken();
      if (!token) return null;
      return await getGoogleVerifiedEmail(token.token);
    } catch {
      return null;
    }
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = new URL(url);

    if (parsed.hostname === "docs.google.com" &&
        parsed.pathname.startsWith("/document/d/")) {
      // Extract document ID from URL path: /document/d/{documentId}/...
      let documentId = parsed.pathname.split("/")[3];
      if (!documentId) {
        throw new Error("Google Docs URL 无效：未找到文档 ID");
      }
      let props: GoogleDocGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        documentId,
      };
      return {class: this.ctx.exports.GoogleDocGatekeeperImpl({props}), resource: GOOGLE_DOC_RESOURCE};
    }

    if (parsed.hostname === "docs.google.com" &&
        parsed.pathname.startsWith("/spreadsheets/d/")) {
      let spreadsheetId = parsed.pathname.split("/")[3];
      if (!spreadsheetId) {
        throw new Error("Google Sheets URL 无效：未找到电子表格 ID");
      }
      let props: GoogleSheetsGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        spreadsheetId,
      };
      return {
        class: this.ctx.exports.GoogleSheetsGatekeeperImpl({ props }),
        resource: GOOGLE_SHEETS_RESOURCE,
      };
    }

    if (parsed.hostname === "calendar.google.com" && parsed.pathname.startsWith("/calendar/")) {
      let calendarId = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
      if (!calendarId) {
        throw new Error("Google Calendar URL 无效：未找到日历 ID");
      }
      if (calendarId === "primary") {
        throw new Error(
          "Google Calendar 绑定必须使用稳定的日历 ID，不能使用相对于账户的“primary”别名。");
      }
      // Default to the least-privilege scope unless the URL explicitly opts into all calendars.
      let availabilityMode: CalendarAvailabilityMode =
          parsed.searchParams.get("availability") === "allVisible" ? "allVisible" : "thisCalendar";
      let props: GoogleCalendarGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        calendarId,
        availabilityMode,
      };
      return {
        class: this.ctx.exports.GoogleCalendarGatekeeperImpl({props}),
        resource: GOOGLE_CALENDAR_RESOURCE,
      };
    }

    if (parsed.hostname === BIGQUERY_HOST) {
      if (parsed.protocol !== "https:") {
        throw new Error(`BigQuery 资源 URL 必须使用 https：${url}`);
      }
      if (parsed.search || parsed.hash) {
        throw new Error("BigQuery 资源 URL 不得包含查询字符串或片段。");
      }

      // Synthetic path: /<projectId>/<datasetId>/<tableId> (each segment optional after the first).
      let segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
          .map(segment => decodeURIComponent(segment));
      if (segments.length > 3) {
        throw new Error(
            "BigQuery 资源 URL 必须为 /<projectId>、/<projectId>/<datasetId> " +
            "或 /<projectId>/<datasetId>/<tableId>。");
      }
      let projectId = segments[0] || undefined;
      let datasetId = segments[1] || undefined;
      let tableId = segments[2] || undefined;
      if (!projectId) {
        throw new Error("BigQuery 资源 URL 必须包含项目 ID。");
      }
      if (tableId && !datasetId) {
        throw new Error("未指定数据集时，无法将范围限制到表。");
      }

      let props: BigQueryGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        scopedProjectId: projectId,
        scopedDatasetId: datasetId,
        scopedTableId: tableId,
      };
      return {
        class: this.ctx.exports.BigQueryGatekeeperImpl({props}),
        resource: BIGQUERY_RESOURCE,
      };
    }

    // Default: Gmail
    let props: GmailGatekeeperImplProps = {...this.ctx.props};

    // Parse the URL hash to extract a search or label scope. Keep labels as
    // opaque names; startSession resolves them to Gmail label IDs so label text
    // can never be interpreted as search syntax.
    let hash = parsed.hash;
    if (hash.startsWith("#search/")) {
      // Gmail's own UI encodes spaces in hash searches as `+`, while
      // decodeURIComponent() only decodes `%20`. Normalize both forms.
      const encodedQuery = hash.slice("#search/".length).replace(/\+/g, " ");
      const query = decodeURIComponent(encodedQuery);
      validateGmailQueryForGrouping(query);
      props.searchQuery = query;
    } else if (hash.startsWith("#label/")) {
      const labelName = decodeURIComponent(hash.slice("#label/".length));
      if (!labelName || new TextEncoder().encode(labelName).byteLength > 320) {
        throw new Error("Gmail 标签名称必须为 1 至 320 字节。");
      }
      props.labelName = labelName;
    } else if (hash && hash !== "#inbox") {
      throw new Error(
        "Unsupported Gmail view. Connect the inbox, an explicit search, or an explicit label.");
    }

    return {class: this.ctx.exports.GmailGatekeeperImpl({props}), resource: GMAIL_RESOURCE};
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let getToken = async () => {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      return await obj.getAccessToken();
    };

    if (resourceUrlPattern === BIGQUERY_RESOURCE.urlPattern) {
      return {
        iframeHtml: BIGQUERY_CONFIGURATOR_HTML,
        ui: new RpcStub(new BigQueryConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GMAIL_RESOURCE.urlPattern) {
      return {
        iframeHtml: GMAIL_CONFIGURATOR_HTML,
        ui: new RpcStub(new GmailConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_CALENDAR_RESOURCE.urlPattern) {
      return {
        iframeHtml: CALENDAR_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalendarConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_DOC_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_DOC_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleDocConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_SHEETS_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_SHEETS_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleSheetsConfiguratorUI(getToken)),
      };
    }

    throw new Error(`不支持的资源配置器类型：${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    await obj.revoke();
  }

  async reconnect(): Promise<{url: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let initiationNonce = generateNonce();
    // Re-request the scopes already granted so a plain reconnect doesn't narrow access.
    let requestedScopes = resourceUrlPatternsToOAuthScopes(await obj.getGrantedResourceUrlPatterns());
    await obj.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let granted = new Set(await obj.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) {
      return {};
    }

    // Request the union of what's already granted and what's newly needed, so the expansion never
    // drops existing access.
    let unionPatterns = new Set([...granted, ...resourceUrlPatterns]);
    let requestedScopes = resourceUrlPatternsToOAuthScopes([...unionPatterns]);
    let initiationNonce = generateNonce();
    await obj.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  // Mint a verifier representing this account, used by the Google gatekeepers' addObserver to confirm
  // a prospective observer may read a bound resource. The verifier carries this user's own account
  // id, so the access checks run against the observer's *own* Google token. (The Gmail gatekeeper
  // uses strategy A — it never consults the verifier — but getVerifier must still exist because the
  // overseer mints one on every open.)
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: GoogleVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GoogleVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Google spans several strategies (see each gatekeeper's observer methods):
//   - Gmail Mailbox — strategy A (private-only): addObserver always throws, so the verifier is never
//     consulted (but must exist).
//   - Google Doc — strategy B (ACL check, single unit): hasDocAccess answers whether the observer's
//     own token can open the bound document (Docs API returns 401/403/404 otherwise).
//   - Google Sheets — strategy B (ACL check, single unit): hasSpreadsheetAccess answers whether the
//     observer's own token can open the bound spreadsheet.
//   - Google Calendar — strategies B/C: hasCalendarWriterAccess covers the bound calendar, while
//     hasCalendarFreeBusyAccess covers foreign calendars read by an all-visible availability query.
//   - BigQuery — strategy C (data-set tracking by dataset): hasDatasetAccess answers whether the
//     observer's own token has IAM access to a dataset (BigQuery returns 401/403/404 otherwise).
// The overseer only ever hands this verifier back to a Google gatekeeper, which may therefore trust
// the boolean results.

type GoogleVerifierProps = {
  userObjectId: string;
};

// Extract the HTTP status from the ad-hoc Error messages thrown by the Google API helpers
// (which embed it as `: <status> ` or `[http=<status>]`). Returns undefined if not found.
function httpStatusFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  let m = error.message.match(/\[http=(\d{3})\]/) ?? error.message.match(/:\s(\d{3})(?:\s|$)/);
  return m ? Number(m[1]) : undefined;
}

// True if an error means "the observer's token cannot access this resource" (as opposed to a
// transient failure, which is rethrown so the open fails loudly rather than silently denying).
function isNoAccessStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

// The non-standard methods the Google gatekeepers call on their own verifier (see addObserver). Not
// part of the generic GatekeeperUserVerifier contract.
export interface GoogleVerifierApi extends GatekeeperUserVerifier {
  hasDocAccess(documentId: string): Promise<boolean>;
  hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean>;
  hasCalendarWriterAccess(calendarId: string): Promise<boolean>;
  hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean>;
  hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean>;
}

type ObserverCheck<T> = {
  excludeObservers?: string[];
  pendingSets: T[];
  commit(): void;
};

type ObservedSetState = true | "pending" | "observed";

@validateRpc()
export class GoogleVerifier extends WorkerEntrypoint<Env, GoogleVerifierProps>
    implements GoogleVerifierApi {
  async #getToken(opts?: AccessTokenRequest): Promise<string> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return (await account.getAccessToken(opts)).token;
  }

  async hasDocAccess(documentId: string): Promise<boolean> {
    let api = new GoogleDocsApi(opts => this.#getToken(opts));
    try {
      await api.getDocument(documentId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean> {
    let api = new GoogleSheetsApi(opts => this.#getToken(opts));
    try {
      await api.getSpreadsheet(spreadsheetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasCalendarWriterAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      let calendar = await api.getCalendar(calendarId);
      return calendar.accessRole === "writer" || calendar.accessRole === "owner";
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      return await api.hasFreeBusyAccess(calendarId);
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean> {
    let api = new BigQueryApi(opts => this.#getToken(opts));
    try {
      await api.getDataset(projectId, datasetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }
}

class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(this.#actionKey(id));
  }

  put(id: number, action: Action): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  list(): {id: number, action: Action}[] {
    return [...this.#kv.list<Action>({prefix: "pending:action:"})]
        .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
        .filter(({id}) => Number.isFinite(id))
        .toSorted((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
  }
}

// =======================================================================================
// Gmail capability stubs
//
// Capability-based API: GmailSession returns GmailThread[] stubs, which return
// GmailMessage[] stubs, etc. Each stub is an RpcTarget that can be passed across
// Worker boundaries. Actions go through the approval queue; reads go through
// authorizeObservation for audit logging.
//
// Approval model:
//   submitAction (requires approval): all side-effecting actions — archive, trash,
//                                     markRead, markUnread, send (reply / replyAll /
//                                     forward all share the `send` action type)
//   authorizeObservation (audit-only): all reads
//
// All side-effecting actions go through the approval queue. Policy configuration
// determines which actions are auto-approved vs. requiring human review — it is
// not up to the gatekeeper to make that decision.
//
// Outbound-email semantics: send(), reply(), replyAll(), and forward() submit
// compact semantic actions (recipients/body/source message ID). Nothing is
// written to the user's mailbox before approval. applyAction() refetches any
// immutable source message, builds the raw RFC 5322/MIME payload, and delivers
// it via messages.send. There is therefore no pre-approval side effect, no
// large MIME blob in action storage, and no draft to clean up on rejection.

// ── Action types ────────────────────────────────────────────────────

type GmailAction =
  | { type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string }
  | { type: "send"; to: string[]; subject: string; body: string }
  | {
      type: "reply";
      sourceMessageId: string;
      threadId: string;
      body: string;
      replyAll: boolean;
      sourceWasSent: boolean;
    }
  | { type: "forward"; sourceMessageId: string; to: string[]; body?: string };

// ── Session context ─────────────────────────────────────────────────
// Shared context passed to all stubs created within a session.

type GmailSessionContext = {
  gmailApi: GmailApi;
  approvalQueue: RpcStub<ApprovalQueue>;
  pendingActions: PendingActionStore<GmailAction>;
  // SESSION PATH: the raw search query passed to the Gmail API for listThreads/search.
  // This handles historical + new messages. See GmailGatekeeperImplProps.searchQuery.
  searchQuery: string | undefined;
  labelId: string | undefined;
  labelName: string | undefined;
  resolveLabels: (labelIds: string[]) => Promise<GmailLabel[]>;
};

// ── GmailSessionImpl ────────────────────────────────────────────────

const MAX_GMAIL_RECIPIENTS = 100;
const MAX_GMAIL_SUBJECT_BYTES = 998;
const MAX_GMAIL_BODY_BYTES = 64 * 1024;
const MAX_GMAIL_QUERY_BYTES = 4096;
const MAX_GMAIL_ADDRESS_BYTES = 320;
const MAX_GMAIL_VISIBLE_THREAD_MESSAGES = 100;

function validateOutboundInput(to: string[], subject: string, body: string): void {
  if (to.length === 0 || to.length > MAX_GMAIL_RECIPIENTS) {
    throw new Error(`电子邮件收件人数必须为 1 至 ${MAX_GMAIL_RECIPIENTS} 人。`);
  }
  if (to.some(address => address.length === 0 ||
      new TextEncoder().encode(address).byteLength > MAX_GMAIL_ADDRESS_BYTES)) {
    throw new Error("收件人地址长度无效。");
  }
  if (new TextEncoder().encode(subject).byteLength > MAX_GMAIL_SUBJECT_BYTES) {
    throw new Error(`电子邮件主题最多为 ${MAX_GMAIL_SUBJECT_BYTES} 个 UTF-8 字节。`);
  }
  if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
    throw new Error(`电子邮件正文最多为 ${MAX_GMAIL_BODY_BYTES} 字节。`);
  }
}

@validateRpc()
class GmailSessionImpl extends RpcTarget implements GmailSession {
  #ctx: GmailSessionContext;

  constructor(ctx: GmailSessionContext) {
    super();
    this.#ctx = ctx;
  }

  // TODO: The dup'd approvalQueue RPC stub should be disposed when the session ends.

  async listThreads(): Promise<Cursor<GmailThreadEntry>> {
    const scopeDescription = this.#ctx.searchQuery
      ? "已连接的 Gmail 搜索范围"
      : this.#ctx.labelId
        ? "已连接的 Gmail 标签范围"
        : "Gmail 收件箱";

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "列出 Gmail 会话",
      description:
        `为${scopeDescription}中的最新会话创建游标。` +
        (this.#ctx.searchQuery
          ? `\n\n${formatApprovalField("搜索限制", this.#ctx.searchQuery)}`
          : "") +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("必需标签", this.#ctx.labelName)}`
          : ""),
    });

    const labelIds = this.#ctx.labelId
      ? [this.#ctx.labelId]
      : (!this.#ctx.searchQuery ? ["INBOX"] : undefined);
    return new GmailThreadCursorImpl(this.#ctx, this.#ctx.searchQuery, labelIds);
  }

  async search(query: string): Promise<Cursor<GmailThreadEntry>> {
    validateGmailQueryForGrouping(query);
    // A leading boolean operator could bind outside the appended group.
    if (this.#ctx.searchQuery && /^(OR|AND)\b/i.test(query.trim())) {
      throw new Error("查询不能以 OR/AND 开头。");
    }

    const effectiveQuery = this.#ctx.searchQuery
      ? `(${this.#ctx.searchQuery}) (${query})`
      : query;

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "搜索 Gmail",
      description:
        "为符合此有效查询的 Gmail 会话创建游标。\n\n" +
        formatApprovalField("查询", effectiveQuery) +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("必需标签", this.#ctx.labelName)}`
          : ""),
    });

    // A full-mailbox binding may search all mail. Only an explicit label scope
    // attenuates search results; listThreads() separately defaults to INBOX.
    const labelIds = this.#ctx.labelId ? [this.#ctx.labelId] : undefined;
    return new GmailThreadCursorImpl(this.#ctx, effectiveQuery, labelIds);
  }

  async send(to: string[], subject: string, body: string): Promise<void> {
    // send() composes a brand-new outbound message, which isn't tied to any
    // particular thread. For search/label-scoped bindings the user only
    // granted access to a subset of their mail, so composing arbitrary new
    // outbound mail is out of scope — reject it. (reply/forward remain
    // available, since those act on a specific message capability that the
    // caller already obtained through the scoped session.)
    if (this.#ctx.searchQuery || this.#ctx.labelId) {
      throw new Error(
        "限定到搜索或标签的 Gmail 绑定不支持 send()。" +
        "请对特定邮件使用 reply()/forward()，或连接完整邮箱。");
    }

    validateOutboundInput(to, subject, body);
    const message = this.#ctx.gmailApi.buildSendRaw(to, subject, body);
    await submitGmailAction(
      this.#ctx,
      { type: "send", to: message.to, subject: message.subject, body: message.body },
      {
        title: sanitizeApprovalTitle(`发送电子邮件：${message.subject}`),
        description: describeOutboundMessage("发送一封新电子邮件。", message),
      });
  }
}

function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function formatApprovalField(label: string, value: string): string {
  // Use a fence longer than any backtick run in the value, so untrusted email
  // fields render verbatim and cannot forge surrounding approval Markdown.
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  return `**${label}:**\n\n${fence}\n${value}\n${fence}`;
}

function describeOutboundMessage(intro: string, message: GmailOutboundMessage): string {
  let fields = [
    formatApprovalField("发件人", message.from),
    formatApprovalField("收件人", message.to.join(", ")),
    ...(message.cc.length > 0 ? [formatApprovalField("抄送", message.cc.join(", "))] : []),
    formatApprovalField("主题", message.subject),
    formatApprovalField("正文", message.body),
    ...message.attachments.map(attachment => formatApprovalField(
      "附件",
      `${attachment.filename} (${attachment.contentType})\n${attachment.description}`)),
  ];
  return `${intro}\n\n${fields.join("\n\n")}`;
}

async function submitGmailAction(
    ctx: GmailSessionContext,
    action: GmailAction,
    desc: { title: string; description: string }): Promise<void> {
  if (ctx.pendingActions.list().length >= 100) {
    throw new Error("待处理的 Gmail 操作过多，请先处理现有操作再添加新操作。");
  }
  let actionId = ctx.pendingActions.submit(action);
  try {
    await ctx.approvalQueue.submitAction(actionId, { ...desc, implementsRevert: false });
  } catch (err) {
    ctx.pendingActions.remove(actionId);
    throw err;
  }
}

// ── GmailThreadCursorImpl ───────────────────────────────────────────
// Lazily fetches pages from the Gmail API as the gadget calls next().
// Each next() returns a batch of GmailThreadEntry objects (thread info +
// capability), or null when exhausted. Pages are fetched in batches of 20.
//
// The cursor itself is a capability. The initial listThreads()/search() call
// authorizes creation; each next() separately authorizes the page it returns.

@validateRpc()
class GmailThreadCursorImpl extends RpcTarget implements Cursor<GmailThreadEntry> {
  #ctx: GmailSessionContext;
  #query: string | undefined;
  #labelIds: string[] | undefined;
  #pageToken: string | undefined;
  #exhausted = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: GmailSessionContext, query: string | undefined, labelIds?: string[]) {
    super();
    this.#ctx = ctx;
    this.#query = query;
    this.#labelIds = labelIds;
  }

  next(): Promise<GmailThreadEntry[] | null> {
    const result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<GmailThreadEntry[] | null> {
    if (this.#exhausted) return null;

    let result: {threads: Array<{id: string; snippet?: string}>; nextPageToken?: string};
    let pageToken = this.#pageToken;
    let exhausted = false;
    let skippedPages = 0;
    do {
      const previousToken = pageToken;
      result = await this.#ctx.gmailApi.listThreads(
        20, this.#query, pageToken, this.#labelIds);
      pageToken = result.nextPageToken;
      exhausted = !result.nextPageToken;
      if (result.nextPageToken && result.nextPageToken === previousToken) {
        throw new Error("Gmail 返回了重复的会话分页令牌。");
      }
      skippedPages++;
    } while (result.threads.length === 0 && !exhausted && skippedPages < 20);

    if (result.threads.length === 0) {
      if (!exhausted) throw new Error("Gmail 返回了过多空白会话页面。");
      this.#pageToken = pageToken;
      this.#exhausted = true;
      return null;
    }

    // Stay below the Workers six-outgoing-connection limit while enriching the
    // page with metadata.
    const entries: GmailThreadEntry[] = [];
    for (let i = 0; i < result.threads.length; i += 5) {
      const batch = await Promise.all(result.threads.slice(i, i + 5).map(async thread => {
        const metadata = await this.#ctx.gmailApi.getThreadInfo(thread.id);
        const info: GmailThreadInfo = {
          ...metadata,
          ...(thread.snippet !== undefined ? {snippet: thread.snippet} : {}),
        };
        const stub = new GmailThreadStub(this.#ctx, thread.id, info);
        return { info, thread: stub };
      }));
      entries.push(...batch);
    }

    await this.#ctx.approvalQueue.authorizeObservation({
      title: `读取 ${entries.length} 个 Gmail 会话`,
      description:
        `获取下一页 Gmail 会话。\n\n` +
        formatApprovalField("主题", entries.map(entry => entry.info.subject).join("\n")),
    });

    this.#pageToken = pageToken;
    this.#exhausted = exhausted;
    return entries;
  }
}

// ── GmailThreadStub ─────────────────────────────────────────────────

@validateRpc()
class GmailThreadStub extends RpcTarget implements GmailThread {
  #ctx: GmailSessionContext;
  #threadId: string;
  #cachedInfo: GmailThreadInfo | undefined;

  constructor(ctx: GmailSessionContext, threadId: string, cachedInfo?: GmailThreadInfo) {
    super();
    this.#ctx = ctx;
    this.#threadId = threadId;
    this.#cachedInfo = cachedInfo;
  }

  async #ensureInfo(): Promise<GmailThreadInfo> {
    if (!this.#cachedInfo) {
      this.#cachedInfo = await this.#ctx.gmailApi.getThreadInfo(this.#threadId);
    }
    return this.#cachedInfo;
  }

  async getMetadata(): Promise<GmailThreadInfo> {
    const info = await this.#ensureInfo();

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`会话信息：${info.subject}`),
      description: `获取会话 ${this.#threadId} 的元数据。`,
    });

    return info;
  }

  async messages(): Promise<GmailMessage[]> {
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`获取邮件：${thread.snippet || "（无摘要）"}`),
      description: `获取会话 ${this.#threadId} 中的所有邮件。`,
    });

    return thread.messages.map(message =>
      new GmailMessageStub(this.#ctx, message.id, this.#threadId)
    );
  }

  async messagesVisibleTo(address: string): Promise<GmailMessage[]> {
    if (new TextEncoder().encode(address).byteLength > MAX_GMAIL_ADDRESS_BYTES) {
      throw new Error(`电子邮件地址最多为 ${MAX_GMAIL_ADDRESS_BYTES} 字节。`);
    }
    const [normalizedAddress] = normalizeEmailRecipients([address]);
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`涉及 ${normalizedAddress} 的邮件`),
      description:
        "列出此会话中涉及所请求地址的邮件。\n\n" +
        formatApprovalField("地址", normalizedAddress) + "\n\n" +
        formatApprovalField("会话摘要", thread.snippet || "（无摘要）"),
    });

    if (thread.messages.length > MAX_GMAIL_VISIBLE_THREAD_MESSAGES) {
      throw new Error(
        `此会话有 ${thread.messages.length} 封邮件；messagesVisibleTo() 最多支持 ` +
        `${MAX_GMAIL_VISIBLE_THREAD_MESSAGES} 封。`);
    }

    const target = normalizedAddress.toLowerCase();
    const visible: GmailMessage[] = [];
    // Fetch only participant metadata, at most five messages at once.
    for (let i = 0; i < thread.messages.length; i += 5) {
      const batch = thread.messages.slice(i, i + 5);
      const participantSets = await Promise.all(batch.map(message =>
        this.#ctx.gmailApi.getMessageParticipants(message.id).catch(err => {
          logger.warn("getMessageParticipants failed", {
            event: "gmail.message.participants.get.failed",
            messageId: message.id, error: err,
          });
          return null;
        })));
      for (let j = 0; j < batch.length; j++) {
        if (participantSets[j]?.has(target)) {
          visible.push(new GmailMessageStub(this.#ctx, batch[j].id, this.#threadId));
        }
      }
    }
    return visible;
  }

  async #submitThreadAction(
      type: "archive" | "trash" | "markRead" | "markUnread",
      titlePrefix: string,
      intro: string): Promise<void> {
    const info = await this.#ensureInfo();
    const subject = info.subject || "（无主题）";
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`执行${titlePrefix}前读取会话：${subject}`),
      description: "读取准备此操作所需的当前 Gmail 会话元数据。",
    });
    await submitGmailAction(
      this.#ctx,
      { type, threadId: this.#threadId },
      {
        title: sanitizeApprovalTitle(`${titlePrefix}: ${subject}`),
        description:
          `${intro}\n\n` +
          formatApprovalField("主题", subject) +
          (info.snippet !== undefined
            ? `\n\n${formatApprovalField("摘要", info.snippet)}`
            : ""),
      });
  }

  async archive(): Promise<void> {
    await this.#submitThreadAction("archive", "归档", "将此会话从收件箱中移除。");
  }

  async trash(): Promise<void> {
    await this.#submitThreadAction("trash", "移至垃圾箱", "将此会话移至垃圾箱。");
  }

  async markRead(): Promise<void> {
    await this.#submitThreadAction("markRead", "标为已读", "将此会话中的每封邮件标为已读。");
  }

  async markUnread(): Promise<void> {
    await this.#submitThreadAction("markUnread", "标为未读", "将此会话中的每封邮件标为未读。");
  }
}

// ── GmailMessageStub ────────────────────────────────────────────────

@validateRpc()
class GmailMessageStub extends RpcTarget implements GmailMessage {
  #ctx: GmailSessionContext;
  #messageId: string;
  #threadId: string;
  #cachedRaw: GmailMessageRaw | undefined;

  constructor(ctx: GmailSessionContext, messageId: string, threadId: string, cachedRaw?: GmailMessageRaw) {
    super();
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
    this.#cachedRaw = cachedRaw;
  }

  async #getRaw(): Promise<GmailMessageRaw> {
    if (!this.#cachedRaw) {
      this.#cachedRaw = await this.#ctx.gmailApi.getMessage(this.#messageId);
    }
    return this.#cachedRaw;
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const raw = await this.#getRaw();
    const rawInfo = await this.#ctx.gmailApi.parseMessageInfo(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`邮件信息：${rawInfo.subject}`),
      description: `获取邮件 ${this.#messageId} 的元数据。`,
    });

    // Resolve raw label IDs to GmailLabel objects.
    const labels = await this.#ctx.resolveLabels(rawInfo.labelIds);
    return {
      id: this.#messageId,
      from: rawInfo.from,
      to: rawInfo.to,
      cc: rawInfo.cc,
      subject: rawInfo.subject,
      timestamp: rawInfo.timestamp,
      labels,
    };
  }

  async thread(): Promise<GmailThread> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `获取邮件所属会话`,
      description: `从邮件 ${this.#messageId} 转到其所属会话。`,
    });
    return new GmailThreadStub(this.#ctx, this.#threadId);
  }

  async getContent(): Promise<EmailContent> {
    const raw = await this.#getRaw();
    const { info, content } = await this.#ctx.gmailApi.parseMessage(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`读取邮件：${info.subject}`),
      description: `获取邮件 ${this.#messageId} 的正文内容。`,
    });

    return content;
  }

  async reply(body: string): Promise<void> {
    if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`电子邮件正文最多为 ${MAX_GMAIL_BODY_BYTES} 字节。`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "读取邮件标头以准备回复",
      description: "读取计算回复收件人与会话关联所需的源邮件标头。",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, false);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: false,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`回复：${message.subject}`),
        description: describeOutboundMessage("发送回复。", message),
      });
  }

  async replyAll(body: string): Promise<void> {
    if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`电子邮件正文最多为 ${MAX_GMAIL_BODY_BYTES} 字节。`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "读取邮件标头以准备回复全部",
      description: "读取计算回复全部收件人与会话关联所需的源邮件标头。",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, true);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: true,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`回复全部：${message.subject}`),
        description: describeOutboundMessage("向所有收件人发送回复。", message),
      });
  }

  async forward(to: string[], body?: string): Promise<void> {
    const normalizedTo = normalizeEmailRecipients(to);
    if (normalizedTo.length === 0 || normalizedTo.length > MAX_GMAIL_RECIPIENTS) {
      throw new Error(`电子邮件收件人数必须为 1 至 ${MAX_GMAIL_RECIPIENTS} 人。`);
    }
    if (new TextEncoder().encode(body ?? '').byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`电子邮件正文最多为 ${MAX_GMAIL_BODY_BYTES} 字节。`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "读取邮件以准备转发",
      description: "读取准备转发所需的完整源邮件和附件元数据。",
    });
    const message = await this.#ctx.gmailApi.buildForwardRaw(original, normalizedTo, body);
    validateOutboundInput(message.to, message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      { type: "forward", sourceMessageId: this.#messageId, to: normalizedTo, body },
      {
        title: sanitizeApprovalTitle(`转发：${message.subject}`),
        description: describeOutboundMessage(
          "转发现有邮件，并无损附上完整原始邮件。",
          message),
      });
  }
}

// =======================================================================================

type GmailGatekeeperImplProps = {
  userObjectId: string;

  // Optional free-form Gmail search restriction.
  searchQuery?: string;

  // Optional exact Gmail label name. Resolved to a label ID at session start;
  // never interpolated into Gmail search syntax.
  labelName?: string;
}

@validateRpc()
export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailSession> {
  #tokens = new AccessTokenCache(opts => {
    let stub = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async #getSelfEmail(): Promise<string> {
    let cached = this.ctx.storage.kv.get<string>("selfEmail");
    if (cached) return cached;

    let token = await this.#getAccessToken();
    let desc = await getGoogleAccountDescription(token);
    if (!desc.uniqueName) {
      throw new Error("Google 账户没有电子邮件地址");
    }
    this.ctx.storage.kv.put("selfEmail", desc.uniqueName);
    return desc.uniqueName;
  }

  async describe(): Promise<ResourceDescription> {
    const labelName = this.ctx.props.labelName;
    if (labelName) {
      return {
        url: `https://mail.google.com/mail/#label/${encodeURIComponent(labelName)}`,
        title: `Gmail 标签：${labelName}`,
        snippet: `带有标签 ${labelName} 的 Gmail 会话`,
        suggestedBindingName: "GMAIL_LABEL",
        tsType: "GmailSession",
      };
    }

    let searchQuery = this.ctx.props.searchQuery;
    if (searchQuery) {
      return {
        url: `https://mail.google.com/mail/#search/${encodeURIComponent(searchQuery)}`,
        title: `Gmail: ${searchQuery}`,
        snippet: `符合以下条件的 Gmail 会话：${searchQuery}`,
        suggestedBindingName: "GMAIL_SEARCH",
        tsType: "GmailSession",
      };
    }

    return {
      url: "https://mail.google.com/mail/",
      title: "Gmail 收件箱",
      snippet: "你的个人 Gmail 收件箱",
      suggestedBindingName: "GMAIL_INBOX",
      tsType: "GmailSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GmailSession> {
    let selfEmail = await this.#getSelfEmail();
    let gmailApi = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

    // In-memory label map cache for the session lifetime. Fetched once on
    // first label resolution, shared across all stubs in this session.
    let labelMapCache: Map<string, string> | undefined;
    const getLabelMap = async () => {
      if (!labelMapCache) labelMapCache = await gmailApi.listLabels();
      return labelMapCache;
    };
    let labelId: string | undefined;
    if (this.ctx.props.labelName) {
      const labelMap = await getLabelMap();
      labelId = [...labelMap].find(([, name]) => name === this.ctx.props.labelName)?.[0];
      if (!labelId) {
        throw new Error(`未找到 Gmail 标签：${this.ctx.props.labelName}`);
      }
    }

    const ctx: GmailSessionContext = {
      gmailApi,
      approvalQueue: approvalQueue.dup(),
      pendingActions: new PendingActionStore<GmailAction>(this.ctx.storage.kv),
      searchQuery: this.ctx.props.searchQuery,
      labelId,
      labelName: this.ctx.props.labelName,
      resolveLabels: async (labelIds: string[]): Promise<GmailLabel[]> =>
        toLabelObjects(labelIds, await getLabelMap()),
    };

    return new GmailSessionImpl(ctx);
  }

  // ---------------------------------------------------------------------------
  async applyAction(actionId: number): Promise<void> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    const action = pendingActions.get(actionId);
    if (!action) throw new Error(`未知的待处理 Gmail 操作：${actionId}`);

    const selfEmail = await this.#getSelfEmail();
    const gmailApi = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

    switch (action.type) {
      case "archive":
        await gmailApi.modifyThread(action.threadId, [], ["INBOX"]);
        break;
      case "trash":
        await gmailApi.trashThread(action.threadId);
        break;
      case "markRead":
        await gmailApi.modifyThread(action.threadId, [], ["UNREAD"]);
        break;
      case "markUnread":
        await gmailApi.modifyThread(action.threadId, ["UNREAD"], []);
        break;
      case "send": {
        const message = gmailApi.buildSendRaw(action.to, action.subject, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      case "reply": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildReplyRaw(
          original, action.body, action.replyAll, action.sourceWasSent);
        await gmailApi.sendRawMessage(message.raw, action.threadId);
        break;
      }
      case "forward": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildForwardRaw(original, action.to, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      default:
        action satisfies never;
        throw new Error(`未知的操作类型：${(action as {type: string}).type}`);
    }

    pendingActions.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    if (!pendingActions.get(actionId)) {
      throw new Error(`未知的待处理 Gmail 操作：${actionId}`);
    }
    pendingActions.remove(actionId);
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("尚未实现撤销");
  }

  // Observer tracking — strategy A (private-only). Full access to a mailbox/label/search is too
  // personal to extend to any non-owner observer (a Gmail mailbox has no per-recipient ACL we could
  // verify an observer against — the mailing-list decomposition discussed in the plan is explicitly
  // out of scope). So no non-owner observer may ever observe Gmail data: addObserver always throws.
  // (This is enforced here in addition to any prohibitAllSharing usage, so the lockdown holds even
  // when sharing is otherwise permitted.) removeObserver is a no-op since none is ever recorded.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "Gmail data cannot be shared with other users: this workspace reads a personal Gmail mailbox, " +
      "which may only be observed by its owner.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  documentId: string;
  submittedAt: number;
  baseRevisionId: string;
  invalidatedReason?: string;
}

type GoogleDocReplaceAction = GoogleDocActionBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocActionBase & {
  type: "appendText";
  markdown: string;
}

type GoogleDocAction = GoogleDocReplaceAction | GoogleDocAppendAction;

type GoogleDocPendingAction = {id: number, action: GoogleDocAction};

type GoogleDocSimulatedContentCache = {
  baseRevisionId: string;
  pendingFingerprint: string;
  markdown: string;
  pendingActions: GoogleDocAction[];
  computedAt: number;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

function previewMarkdown(markdown: string, maxLength: number): string {
  return markdown.length > maxLength ? markdown.slice(0, maxLength) + "..." : markdown;
}

function findUniqueMarkdown(markdown: string, oldMarkdown: string, operation: string): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}：oldMarkdown 不能为空。`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated document. ` +
      `Make sure the text exactly matches content returned by getContent().`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated document. ` +
      `Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  markdown: string,
  oldMarkdown: string,
  newMarkdown: string,
  operation: string,
): string {
  if (oldMarkdown === newMarkdown) {
    return markdown;
  }

  let index = findUniqueMarkdown(markdown, oldMarkdown, operation);
  return markdown.slice(0, index) + newMarkdown + markdown.slice(index + oldMarkdown.length);
}

function appendMarkdownForSimulation(markdown: string, appendedMarkdown: string): string {
  let normalizedAppend = appendedMarkdown.endsWith("\n") ? appendedMarkdown : appendedMarkdown + "\n";

  if (markdown.length === 0) {
    return normalizedAppend;
  }

  if (markdown.endsWith("\n\n")) {
    return markdown + normalizedAppend;
  }

  if (markdown.endsWith("\n")) {
    return markdown + "\n" + normalizedAppend;
  }

  return markdown + "\n\n" + normalizedAppend;
}

function applyGoogleDocActionToMarkdown(markdown: string, action: GoogleDocAction): string {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(
          markdown, action.oldMarkdown, action.newMarkdown, "replaceText");
    case "appendText":
      return appendMarkdownForSimulation(markdown, action.markdown);
    default:
      action satisfies never;
      throw new Error(`未知的操作类型：${(action as any).type}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateGoogleDocAction(
  pendingActions: PendingActionStore<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.put(pending.id, pending.action);
  }
}

function invalidateUnreplayableGoogleDocActions(
  pendingActions: PendingActionStore<GoogleDocAction>,
  baseMarkdown: string,
  pending: GoogleDocPendingAction[],
  context: string,
): {markdown: string, pendingActions: GoogleDocAction[]} {
  let markdown = baseMarkdown;
  let replayedActions: GoogleDocAction[] = [];
  for (let i = 0; i < pending.length; i++) {
    let action = pending[i].action;
    if (action.invalidatedReason) {
      continue;
    }

    try {
      markdown = applyGoogleDocActionToMarkdown(markdown, action);
    } catch (error) {
      invalidateGoogleDocAction(
          pendingActions,
          pending[i],
          `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
          `Reject it and retry if it is still needed.`);
      continue;
    }
    replayedActions.push(action);
  }

  return {markdown, pendingActions: replayedActions};
}

function materializeGoogleDocAction(snapshot: DocSnapshot, action: GoogleDocAction): any[] {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          snapshot.markdown, action.oldMarkdown, "applyAction(replaceText)");
      let result = computeReplaceOperations(
          snapshot.sourceMap,
          snapshot.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          action.newMarkdown);
      return result.requests;
    }

    case "appendText": {
      let insertAt = snapshot.bodyEndIndex - 1;
      return markdownToDocRequests("\n" + action.markdown, insertAt);
    }

    default:
      action satisfies never;
      throw new Error(`未知的操作类型：${(action as any).type}`);
  }
}

type GoogleDocGatekeeperImplProps = {
  userObjectId: string;
  documentId: string;
}

// All Google Doc edits (replaceText, appendText, ...) are grouped under a single action kind
const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "文档编辑",
};

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = {};
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(this.ctx.props.documentId);
    return {
      url: `https://docs.google.com/document/d/${this.ctx.props.documentId}/edit`,
      title: doc.title,
      snippet: `Google 文档：${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return DOCS_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [EDIT_DOCUMENT_ACTION];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    return new GoogleDocSessionImpl(
        api,
        this.ctx.props.documentId,
        approvalQueue.dup(),
        pendingActions,
        this.ctx.storage,
        this.#simulationCache);
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`未知的待处理 Google 文档操作：${actionId}`);
    }
    let pendingRecord = pending[pendingIndex];

    let action = pendingRecord.action;
    if (action.invalidatedReason) {
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      return;
    }

    let firstPending = pending.find(({action}) => !action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google 文档编辑必须按顺序批准。请先批准较早的编辑 ${firstPending?.id}，` +
        `再批准编辑 ${actionId}。`);
    }

    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(action.documentId);
    let snapshot = docToMarkdown(doc);
    let requests: any[];
    try {
      requests = materializeGoogleDocAction(snapshot, action);
    } catch (error) {
      logger.error("dropping stale Google Doc action during apply", {
        event: "google.doc.action.apply.stale.dropped",
        actionId, error,
      });
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      await this.ctx.storage.put("docSnapshot", snapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          snapshot.markdown,
          pending.slice(pendingIndex + 1),
          `编辑 ${actionId} 被丢弃后，无法重放待处理的 Google 文档编辑`);
      return;
    }
    if (requests.length > 0) {
      await api.batchUpdate(action.documentId, requests, snapshot.revisionId);
    }
    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;

    try {
      let refreshedSnapshot = snapshot;
      if (requests.length > 0) {
        refreshedSnapshot = docToMarkdown(await api.getDocument(action.documentId));
      }
      await this.ctx.storage.put("docSnapshot", refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot.markdown,
          pending.slice(pendingIndex + 1),
          `编辑 ${actionId} 应用后，无法重放待处理的 Google 文档编辑`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete("docSnapshot");
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`未知的待处理 Google 文档操作：${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete("docSnapshot");

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("尚未实现撤销");
  }

  // Observer tracking — strategy B (ACL check, single unit). The binding is one document, so we just
  // confirm the observer can open it with their own token (hasDocAccess, via the Drive/Docs ACL).
  // The document is the atomic unit (everything read through this binding is that one doc), so no
  // observers are tracked and removeObserver is a no-op. The overseer re-runs addObserver on every
  // open, catching loss of access promptly.
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.ctx.props.documentId))) {
      throw new Error(
        "此协作者无权访问已绑定的 Google 文档，因此不能查看此工作区从中读取的数据。");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocsApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;

  constructor(
    docsApi: GoogleDocsApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
  }

  async #getSnapshot(forceRefresh?: boolean): Promise<DocSnapshot> {
    if (!forceRefresh) {
      let cached = await this.#storage.get<DocSnapshot>("docSnapshot");
      if (cached) {
        let age = Date.now() - cached.fetchedAt;
        if (age < 10_000) {
          return cached;
        }
        // TTL expired — check if document has changed.
        let currentRevisionId = await this.#docsApi.getRevisionId(this.#documentId);
        if (currentRevisionId === cached.revisionId) {
          cached.fetchedAt = Date.now();
          await this.#storage.put("docSnapshot", cached);
          return cached;
        }
      }
    }

    // Fetch full document and build snapshot.
    let doc = await this.#docsApi.getDocument(this.#documentId);
    let snapshot = docToMarkdown(doc);
    await this.#storage.put("docSnapshot", snapshot);
    return snapshot;
  }

  async #getSimulatedContent(): Promise<{
    snapshot: DocSnapshot,
    markdown: string,
    pendingActions: GoogleDocAction[],
  }> {
    let snapshot = await this.#getSnapshot();
    let pending = this.#pendingActions.list();
    let pendingFingerprint = googleDocPendingFingerprint(pending);
    let cached = this.#simulationCache.current;
    if (cached && cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === pendingFingerprint) {
      return {
        snapshot,
        markdown: cached.markdown,
        pendingActions: cached.pendingActions,
      };
    }

    let {markdown, pendingActions} = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot.markdown,
        pending,
        "无法在当前文档上重放待处理的 Google 文档编辑");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.list()),
      markdown,
      pendingActions,
      computedAt: Date.now(),
    };
    return {snapshot, markdown, pendingActions};
  }

  async getMetadata(): Promise<DocMetadata> {
    let {snapshot, pendingActions} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "读取 Google 文档元数据",
      description: "读取文档标题和修改时间。",
    });

    // The Docs API doesn't return lastModified directly (that's a Drive API field).
    // For now, use the fetch timestamp as an approximation.
    // TODO: Use Drive API files.get for actual modifiedTime.
    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), snapshot.fetchedAt);
    return {
      title: snapshot.title ?? "未命名文档",
      lastModified: new Date(lastModified),
    };
  }

  async getContent(): Promise<string> {
    let {markdown} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "读取 Google 文档内容",
      description: "以 Markdown 读取文档的完整模拟内容。",
    });

    return markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }

    let {snapshot, markdown} = await this.#getSimulatedContent();
    findUniqueMarkdown(markdown, oldMarkdown, "replaceText");

    let action: GoogleDocAction = {
      type: "replaceText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      oldMarkdown,
      newMarkdown,
    };

    let oldPreview = previewMarkdown(oldMarkdown, 80);
    let newPreview = previewMarkdown(newMarkdown, 80);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "编辑 Google 文档",
        description:
          `替换文档中的文本。\n\n` +
          `**原文本：** ${oldPreview}\n\n` +
          `**新文本：** ${newPreview}`,
        implementsRevert: false,
        // Group all document edits under one tag
        actionKind: EDIT_DOCUMENT_ACTION,
        autoApprovable: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }

  async appendText(markdown: string): Promise<void> {
    let {snapshot} = await this.#getSimulatedContent();

    let action: GoogleDocAction = {
      type: "appendText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      markdown,
    };

    let preview = previewMarkdown(markdown, 100);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "追加到 Google 文档",
        description: `将内容追加到文档末尾：\n\n${preview}`,
        implementsRevert: false,
        // Same "editDocument" tag as replaceText
        actionKind: EDIT_DOCUMENT_ACTION,
        autoApprovable: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }
}

// =======================================================================================
// Google Sheets Gatekeeper
// =======================================================================================

type GoogleSheetsGatekeeperImplProps = {
  userObjectId: string;
  spreadsheetId: string;
};

@validateRpc()
export class GoogleSheetsGatekeeperImpl
    extends DurableObject<Env, GoogleSheetsGatekeeperImplProps>
    implements Gatekeeper<GoogleSpreadsheetSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
    return account.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleSheetsApi(opts => this.#getAccessToken(opts));
    let spreadsheet = await api.getSpreadsheet(this.ctx.props.spreadsheetId);
    return {
      url: `https://docs.google.com/spreadsheets/d/${this.ctx.props.spreadsheetId}/edit`,
      title: spreadsheet.title,
      snippet: `Google 电子表格：${spreadsheet.title}（只读）`,
      suggestedBindingName: "GOOGLE_SHEET",
      tsType: "GoogleSpreadsheetSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return SHEETS_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleSpreadsheetSession> {
    let api = new GoogleSheetsApi(opts => this.#getAccessToken(opts));
    return new GoogleSpreadsheetSessionImpl(
      api, this.ctx.props.spreadsheetId, approvalQueue.dup(),
    );
  }

  // Read-only — no side-effecting actions.
  async applyAction(_action: number): Promise<void> {
    throw new Error("Google Sheets 为只读，不提供任何操作。");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("Google Sheets 为只读，不提供任何操作。");
  }
  revertAction(_action: number): Promise<void> {
    throw new Error("Google Sheets 为只读，不提供任何操作。");
  }

  // Observer tracking — strategy B (ACL check, single unit). Google applies sharing permissions at
  // spreadsheet granularity, so an observer must be able to open this spreadsheet with their own
  // account. The overseer re-runs this check on every open, catching revoked access.
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasSpreadsheetAccess(this.ctx.props.spreadsheetId))) {
      throw new Error(
        "此协作者无权访问已绑定的 Google 电子表格，因此不能查看此工作区从中读取的数据。",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GoogleSpreadsheetSessionImpl extends RpcTarget implements GoogleSpreadsheetSession {
  #api: GoogleSheetsApi;
  #spreadsheetId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
    api: GoogleSheetsApi,
    spreadsheetId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
    this.#api = api;
    this.#spreadsheetId = spreadsheetId;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getSpreadsheet(): Promise<SpreadsheetInfo> {
    let spreadsheet = await this.#api.getSpreadsheet(this.#spreadsheetId);
    await this.#approvalQueue.authorizeObservation({
      title: "读取 Google 电子表格元数据",
      description:
        `读取“${spreadsheet.title}”的元数据，包括其中 ${spreadsheet.sheets.length} 个工作表。`,
    });
    return spreadsheet;
  }

  async readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    return (await this.#readRanges([range], options))[0];
  }

  async readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    return this.#readRanges(ranges, options);
  }

  async #readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    let result = await this.#api.readRanges(
      this.#spreadsheetId, ranges, options?.valueMode,
    );
    let cellCount = result.reduce(
      (total, range) => total + range.values.reduce((sum, row) => sum + row.length, 0),
      0,
    );
    await this.#approvalQueue.authorizeObservation({
      title: result.length === 1
        ? `读取 Google Sheets 范围 ${result[0].range}`
        : `读取 ${result.length} 个 Google Sheets 范围`,
      description:
        `从已连接电子表格的 ${result.length} 个限定范围中读取 ${cellCount.toLocaleString()} 个单元格。`,
    });
    return result;
  }
}

// =======================================================================================
// Google Calendar Gatekeeper
// =======================================================================================

type GoogleCalendarActionBase = {
  calendarId: string;
  submittedAt: number;
  sendUpdates: CalendarSendUpdates;
}

type GoogleCalendarCreateAction = GoogleCalendarActionBase & {
  type: "createEvent";
  event: CalendarEventDraft;
}

type GoogleCalendarUpdateAction = GoogleCalendarActionBase & {
  type: "updateEvent";
  eventId: string;
  patch: CalendarEventPatch;
}

type GoogleCalendarAction = GoogleCalendarCreateAction | GoogleCalendarUpdateAction;

type GoogleCalendarRevertInfo =
  | {
      type: "createdEvent";
      calendarId: string;
      eventId: string;
      sendUpdates: CalendarSendUpdates;
    }
  | {
      type: "updatedEvent";
      calendarId: string;
      eventId: string;
      // Prior values of exactly the fields that were changed, so the edit can be patched back.
      previous: CalendarEventPatch;
      sendUpdates: CalendarSendUpdates;
    };

type GoogleCalendarGatekeeperImplProps = {
  userObjectId: string;
  calendarId: string;
  availabilityMode: CalendarAvailabilityMode;
}

function previewCalendarTime(time: CalendarTime): string {
  if (time.kind === "date") return time.date;
  return time.dateTime.toISOString();
}

function pendingCalendarEventFromDraft(
  id: number,
  action: GoogleCalendarCreateAction,
  opts: CalendarListEventsOptions,
): CalendarEvent {
  return {
    id: `pending:create:${id}`,
    title: action.event.title,
    start: action.event.start,
    end: action.event.end,
    status: "confirmed",
    ...(action.event.location ? {location: action.event.location} : {}),
    ...(opts.includeDescriptions && action.event.description ? {description: action.event.description} : {}),
    ...(action.event.attendees ? {attendees: action.event.attendees} : {}),
    ...(action.event.transparency ? {transparency: action.event.transparency} : {}),
    ...(action.event.visibility ? {visibility: action.event.visibility} : {}),
    pending: true,
  };
}

// Apply a pending updateEvent's patch onto a fetched event in place, so listEvents() reflects the
// edit before it's approved.
function applyCalendarPatchToEvent(
  event: CalendarEvent,
  patch: CalendarEventPatch,
  opts: CalendarListEventsOptions,
): void {
  if (patch.title !== undefined) event.title = patch.title;
  if (patch.start !== undefined) event.start = patch.start;
  if (patch.end !== undefined) event.end = patch.end;
  if (patch.location !== undefined) event.location = patch.location;
  if (patch.transparency !== undefined) event.transparency = patch.transparency;
  if (patch.visibility !== undefined) event.visibility = patch.visibility;
  if (patch.description !== undefined && opts.includeDescriptions) {
    event.description = patch.description;
  }
  if (patch.attendees !== undefined) {
    event.attendees = patch.attendees;
  }
}

// Build the undo patch for an updateEvent.
function priorCalendarPatch(oldEvent: CalendarEvent, patch: CalendarEventPatch): CalendarEventPatch {
  let previous: CalendarEventPatch = {};
  if (patch.title !== undefined) previous.title = oldEvent.title;
  if (patch.start !== undefined) previous.start = oldEvent.start;
  if (patch.end !== undefined) previous.end = oldEvent.end;
  if (patch.location !== undefined) previous.location = oldEvent.location ?? "";
  if (patch.description !== undefined) previous.description = oldEvent.description ?? "";
  if (patch.transparency !== undefined) previous.transparency = oldEvent.transparency ?? "opaque";
  if (patch.visibility !== undefined) previous.visibility = oldEvent.visibility ?? "default";
  if (patch.attendees !== undefined) {
    previous.attendees = (oldEvent.attendees ?? []).map(a => ({
      email: a.email,
      ...(a.displayName ? {displayName: a.displayName} : {}),
      ...(a.optional ? {optional: a.optional} : {}),
    }));
  }
  return previous;
}

function summarizeCalendarPatch(patch: CalendarEventPatch): string {
  let parts: string[] = [];
  if (patch.title !== undefined) parts.push(`标题 → “${patch.title}”`);
  if (patch.start !== undefined) parts.push(`开始 → ${previewCalendarTime(patch.start)}`);
  if (patch.end !== undefined) parts.push(`结束 → ${previewCalendarTime(patch.end)}`);
  if (patch.location !== undefined) parts.push(`地点 → “${patch.location}”`);
  if (patch.description !== undefined) parts.push("描述");
  if (patch.attendees !== undefined) {
    parts.push(`参与者 → ${patch.attendees.map(a => a.email).join(", ") || "（无）"}`);
  }
  if (patch.transparency !== undefined) parts.push(`透明度 → ${patch.transparency}`);
  if (patch.visibility !== undefined) parts.push(`可见性 → ${patch.visibility}`);
  return parts.length ? parts.join("；") : "（无更改）";
}

function applyPendingCalendarActions(
  events: CalendarEvent[],
  pending: {id: number, action: GoogleCalendarAction}[],
  opts: CalendarListEventsOptions,
): CalendarEvent[] {
  let byId = new Map(events.map(event => [event.id, {...event}]));
  let added: CalendarEvent[] = [];

  for (let {id, action} of pending) {
    if (action.type === "createEvent") {
      let event = pendingCalendarEventFromDraft(id, action, opts);
      if (calendarEventOverlaps(event, opts.timeMin, opts.timeMax)) added.push(event);
    } else if (action.type === "updateEvent") {
      let existing = byId.get(action.eventId);
      if (existing) {
        applyCalendarPatchToEvent(existing, action.patch, opts);
        existing.pending = true;
        if (!calendarEventOverlaps(existing, opts.timeMin, opts.timeMax)) {
          byId.delete(action.eventId);
        }
      }
    } else {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }

  return [...byId.values(), ...added]
      .toSorted((a, b) => calendarEventSortKey(a) - calendarEventSortKey(b));
}

function validateEventTimes(start: CalendarTime, end: CalendarTime): void {
  if (start.kind !== end.kind) {
    throw new Error("事件开始和结束必须同时为全天（date）或同时为定时（dateTime）。");
  }
  let startMs = start.kind === "date" ? Date.parse(start.date) : start.dateTime.valueOf();
  let endMs = end.kind === "date" ? Date.parse(end.date) : end.dateTime.valueOf();
  if (!(endMs > startMs)) throw new Error("事件结束时间必须晚于开始时间。");
}

function summarizePeople(people: string[]): string {
  if (people.length <= 5) return people.join(", ");
  return `${people.slice(0, 5).join(", ")}，另有 ${people.length - 5} 个`;
}

export class GoogleCalendarGatekeeperImpl
    extends DurableObject<Env, GoogleCalendarGatekeeperImplProps>
    implements Gatekeeper<GoogleCalendarSession> {
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  // Revert data for already-applied actions, keyed by action id. The overseer no longer round-trips
  // revert info through applyAction()/revertAction(), so we persist it in our own storage.
  #revertKey(actionId: number): string {
    return `revert:info:${actionId}`;
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let calendar = await api.getCalendar(this.ctx.props.calendarId);
    let availability = this.ctx.props.availabilityMode === "allVisible"
        ? "空闲状态查询涵盖此账户可见的所有日历。"
        : "空闲状态查询仅限此日历。";
    return {
      url: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(this.ctx.props.calendarId)}`,
      title: `日历：${calendar.summary}`,
      snippet: `Google 日历：${calendar.summary}。${availability}`,
      suggestedBindingName: "GOOGLE_CALENDAR",
      tsType: "GoogleCalendarSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CALENDAR_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleCalendarSession> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    return new GoogleCalendarSessionImpl(
      api,
      this.ctx.props.calendarId,
      this.ctx.props.availabilityMode,
      approvalQueue.dup(),
      pendingActions,
      calendarIds => this.#prepareAvailabilityCalendarObservation(calendarIds),
    );
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    let action = pendingActions.get(actionId);
    if (!action) {
      throw new Error(`未知的待处理 Google Calendar 操作：${actionId}`);
    }

    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    switch (action.type) {
      case "createEvent": {
        let created = await api.createEvent(action.calendarId, action.event, action.sendUpdates);
        pendingActions.remove(actionId);
        this.ctx.storage.kv.put<GoogleCalendarRevertInfo>(this.#revertKey(actionId), {
          type: "createdEvent",
          calendarId: action.calendarId,
          eventId: created.id,
          sendUpdates: action.sendUpdates,
        });
        return;
      }
      case "updateEvent": {
        let oldEvent = await api.getEvent(action.calendarId, action.eventId);
        let previous = priorCalendarPatch(oldEvent, action.patch);
        await api.patchEvent(
          action.calendarId, action.eventId,
          eventPatchToGoogle(action.patch), action.sendUpdates);
        pendingActions.remove(actionId);
        this.ctx.storage.kv.put<GoogleCalendarRevertInfo>(this.#revertKey(actionId), {
          type: "updatedEvent",
          calendarId: action.calendarId,
          eventId: action.eventId,
          previous,
          sendUpdates: action.sendUpdates,
        });
        return;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`未知的操作类型：${String(_exhaustive)}`);
      }
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    pendingActions.remove(actionId);
  }

  async revertAction(actionId: number)
      : Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    let revertInfo =
        this.ctx.storage.kv.get<GoogleCalendarRevertInfo>(this.#revertKey(actionId));
    if (!revertInfo) {
      return {
        message: "此 Google Calendar 操作已无法自动撤销，请在 Google Calendar 中手动撤销。",
      };
    }

    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    switch (revertInfo.type) {
      case "createdEvent":
        await api.deleteEvent(revertInfo.calendarId, revertInfo.eventId, revertInfo.sendUpdates);
        break;
      case "updatedEvent":
        await api.patchEvent(
          revertInfo.calendarId, revertInfo.eventId,
          eventPatchToGoogle(revertInfo.previous), revertInfo.sendUpdates);
        break;
      default: {
        const _exhaustive: never = revertInfo;
        void _exhaustive;
      }
    }
    this.ctx.storage.kv.delete(this.#revertKey(actionId));
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // No hooks for Google Calendar.
  }

  // Observer tracking combines strategy B for the selected calendar with strategy C for the
  // optional all-visible availability scope. Full event reads can include private event details,
  // which Google hides from readers, so observers must currently be writers or owners.
  // TODO: Let the binding owner choose whether private events are included. A public-only mode
  // could admit readers instead of requiring writer access from every collaborator.

  #observerKey(id: string): string { return `observer:${id}`; }
  #availabilityCalendarKey(calendarId: string): string {
    return `observedAvailabilityCalendar:${encodeURIComponent(calendarId)}`;
  }

  #isAvailabilityCalendarObserved(calendarId: string): boolean {
    let state = this.ctx.storage.kv.get<ObservedSetState>(this.#availabilityCalendarKey(calendarId));
    return state === true || state === "observed";
  }

  #listTrackedAvailabilityCalendars(): string[] {
    let prefix = "observedAvailabilityCalendar:";
    return [...this.ctx.storage.kv.list<ObservedSetState>({prefix})]
        .map(([key]) => decodeURIComponent(key.slice(prefix.length)));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<GoogleVerifierApi>]> {
    let prefix = "observer:";
    for (let [key, verifier] of this.ctx.storage.kv.list<Fetcher<GoogleVerifierApi>>({prefix})) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  async #prepareAvailabilityCalendarObservation(
    calendarIds: string[],
  ): Promise<ObserverCheck<string>> {
    let pendingCalendarIds = [...new Set(calendarIds)]
        .filter(calendarId => !this.#isAvailabilityCalendarObserved(calendarId));
    if (pendingCalendarIds.length === 0) return {pendingSets: pendingCalendarIds, commit() {}};

    for (let calendarId of pendingCalendarIds) {
      let key = this.#availabilityCalendarKey(calendarId);
      if (this.ctx.storage.kv.get<ObservedSetState>(key) === undefined) {
        this.ctx.storage.kv.put(key, "pending");
      }
    }

    let observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      let access = await Promise.all(pendingCalendarIds.map(
        calendarId => verifier.hasCalendarFreeBusyAccess(calendarId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    let excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);

    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingSets: pendingCalendarIds,
      commit: () => {
        for (let calendarId of pendingCalendarIds) {
          this.ctx.storage.kv.put(this.#availabilityCalendarKey(calendarId), "observed");
        }
      },
    };
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasCalendarWriterAccess(this.ctx.props.calendarId))) {
      throw new Error(
        "此协作者没有已绑定 Google Calendar 的写入权限，因此不能查看其中的事件详情。");
    }
    let checked = new Set<string>();
    while (true) {
      let calendarIds = this.#listTrackedAvailabilityCalendars()
          .filter(calendarId => !checked.has(calendarId));
      if (calendarIds.length === 0) {
        if (this.ctx.props.availabilityMode === "allVisible") {
          this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        }
        return;
      }
      let availabilityAccess = await Promise.all(
        calendarIds.map(calendarId => verifier.hasCalendarFreeBusyAccess(calendarId)));
      for (let [index, calendarId] of calendarIds.entries()) {
        if (!availabilityAccess[index]) {
          throw new Error(
            `此协作者无法查看 ${calendarId} 的空闲/忙碌状态，而此工作区已读取该日历的可用时间，` +
            "因此不能允许其查看这些数据。");
        }
      }
      for (let calendarId of calendarIds) checked.add(calendarId);
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }
}

class GoogleCalendarSessionImpl extends RpcTarget implements GoogleCalendarSession {
  #api: GoogleCalendarApi;
  #calendarId: string;
  #availabilityMode: CalendarAvailabilityMode;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleCalendarAction>;
  #observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>;

  constructor(
    api: GoogleCalendarApi,
    calendarId: string,
    availabilityMode: CalendarAvailabilityMode,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleCalendarAction>,
    observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>,
  ) {
    super();
    this.#api = api;
    this.#calendarId = calendarId;
    this.#availabilityMode = availabilityMode;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#observeAvailabilityCalendars = observeAvailabilityCalendars;
  }

  async getCapabilities(): Promise<GoogleCalendarCapabilities> {
    return {availabilityMode: this.#availabilityMode};
  }

  async getCalendar(): Promise<GoogleCalendarInfo> {
    let calendar = await this.#api.getCalendar(this.#calendarId);
    await this.#approvalQueue.authorizeObservation({
      title: "读取 Google Calendar 元数据",
      description: `读取 Google Calendar ${calendar.summary}（${calendar.id}）的元数据。`,
    });
    return calendar;
  }

  async listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 366);
    let events = await this.#api.listEvents(this.#calendarId, opts);
    let simulated = applyPendingCalendarActions(events, this.#pendingActions.list(), opts);

    await this.#approvalQueue.authorizeObservation({
      title: "列出 Google Calendar 事件",
      description:
          `列出日历 ${this.#calendarId} 从 ${opts.timeMin.toISOString()} 到 ` +
          `${opts.timeMax.toISOString()} 的 ${simulated.length} 个事件。` +
          (opts.includeDescriptions ? "包含事件描述。" : ""),
    });

    return simulated;
  }

  async checkAvailability(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 90);
    let people = [...new Set(opts.people.map(person => person.trim()).filter(Boolean))];
    if (people.length === 0) throw new Error("至少需要一个人员或日历。");
    if (people.length > 50) throw new Error("一次最多可检查 50 个人员/日历。");
    if (people.includes("primary")) {
      throw new Error(
        "可用时间检查必须使用稳定的日历 ID 或电子邮件地址，不能使用相对于账户的“primary”别名。" );
    }

    let foreign = people.filter(id => id !== this.#calendarId);
    if (foreign.length > 0 && this.#availabilityMode === "thisCalendar") {
      throw new Error(
          "此连接仅允许检查已绑定日历的可用时间。请重新连接并选择“我可见的所有日历”，" +
          "以检查其他日历的可用时间。");
    }

    let availability = await this.#api.freeBusy({...opts, people});
    let successfulForeign = availability
        .filter(result => foreign.includes(result.email) && !result.error)
        .map(result => result.email);
    let check = successfulForeign.length > 0
        ? await this.#observeAvailabilityCalendars(successfulForeign)
        : {pendingSets: [], commit() {}};

    await this.#approvalQueue.authorizeObservation({
      title: "检查 Google Calendar 可用时间",
      description:
          `检查 ${summarizePeople(people)} 从 ${opts.timeMin.toISOString()} 到 ` +
          `${opts.timeMax.toISOString()} 的空闲/忙碌状态。仅返回忙碌时间段，不读取事件详情。`,
      excludeObservers: check.excludeObservers,
    });
    check.commit();

    return availability;
  }

  async createEvent(
    event: CalendarEventDraft,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!event.title.trim()) throw new Error("事件标题为必填项。");
    validateEventTimes(event.start, event.end);
    let action: GoogleCalendarAction = {
      type: "createEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      event,
    };
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `创建日历事件：${event.title}`,
        description:
            `在日历 ${this.#calendarId} 上创建事件 **${event.title}**，时间为 ` +
            `${previewCalendarTime(event.start)} 至 ${previewCalendarTime(event.end)}。` +
            (event.attendees?.length ? `参与者：${event.attendees.map(a => a.email).join(", ")}。` : "") +
            `发送更新：${action.sendUpdates}。`,
        implementsRevert: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }

  async updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!eventId.trim()) throw new Error("eventId 为必填项。");
    if (Object.keys(patch).length === 0) throw new Error("patch 必须至少修改一个字段。");
    if (patch.start !== undefined || patch.end !== undefined) {
      // Validate the resulting start/end pair. If only one side is patched, fetch the event to
      // get the other side.
      let start = patch.start;
      let end = patch.end;
      if (start === undefined || end === undefined) {
        let current = await this.#api.getEvent(this.#calendarId, eventId);
        start ??= current.start;
        end ??= current.end;
      }
      validateEventTimes(start, end);
    }
    let action: GoogleCalendarAction = {
      type: "updateEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      eventId,
      patch,
    };
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `更新日历事件 ${eventId}`,
        description:
            `更新日历 ${this.#calendarId} 上的事件 ${eventId}：` +
            `${summarizeCalendarPatch(patch)}。发送更新：${action.sendUpdates}。`,
        implementsRevert: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }
}

// =======================================================================================
// BigQuery Gatekeeper
// =======================================================================================
//
// Scope enforcement: when a session is scoped to a project/dataset/table, every query is
// dry-run first (via `BigQueryApi.dryRun`) and rejected if it references tables outside the
// scope. The dry-run also gives us the bytesProcessed estimate, which we cross-check against
// `maximumBytesBilled` before actually executing — defense in depth, since BigQuery will also
// enforce maximumBytesBilled server-side.

type BigQueryGatekeeperImplProps = {
  userObjectId: string;
  // When set, narrows the session's authority. Project is required for any narrower scope.
  scopedProjectId?: string;
  scopedDatasetId?: string;
  scopedTableId?: string;
};

@validateRpc()
export class BigQueryGatekeeperImpl
    extends DurableObject<Env, BigQueryGatekeeperImplProps>
    implements Gatekeeper<BigQuerySession> {
  #tokens = new AccessTokenCache(opts => {
      let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let { scopedProjectId: p, scopedDatasetId: d, scopedTableId: t } = this.ctx.props;
    let path = p ? (d ? (t ? `/${p}/${d}/${t}` : `/${p}/${d}`) : `/${p}`) : "";
    let label = t ? `${p}.${d}.${t}` : d ? `${p}.${d}` : p ?? null;
    return {
      url: `https://${BIGQUERY_HOST}${path}`,
      title: label ? `BigQuery（${label}）` : "BigQuery",
      snippet: t
          ? `查询 BigQuery 表“${p}.${d}.${t}”（只读）`
          : d
              ? `查询 BigQuery 数据集“${p}.${d}”（只读）`
              : p
                  ? `查询项目“${p}”中的 BigQuery 数据集（只读）`
                  : "浏览 BigQuery 项目和数据集（只读）",
      suggestedBindingName: "BIGQUERY",
      tsType: "BigQuerySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return BIGQUERY_TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BigQuerySession> {
    let api = new BigQueryApi(opts => this.#getAccessToken(opts));
    return new BigQuerySessionImpl(
      api,
      approvalQueue.dup(),
      this.ctx.props.scopedProjectId,
      this.ctx.props.scopedDatasetId,
      this.ctx.props.scopedTableId,
      datasets => this.#prepareDatasetObservation(datasets),
    );
  }

  // Read-only — no side-effecting actions.
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("BigQuery Gatekeeper 没有可撤销的写入操作");
  }

  // -------------------------------------------------------------------------
  // Observer tracking — strategy C (data-set tracking by dataset). Even a project- or table-scoped
  // binding is tracked at dataset granularity: users may have IAM access to different datasets, so we
  // record which datasets' data the Gadget has actually observed and verify each observer against
  // them. addObserver requires access to every already-observed dataset; later, the first observation
  // of a *new* dataset excludes any observer lacking it (see #prepareDatasetObservation). Verified
  // observers are remembered (their verifier stored) so that forward-exclusion re-check can run. The
  // overseer re-runs addObserver on every open, catching loss of access promptly.

  #observerKey(id: string): string { return `observer:${id}`; }
  // A dataset is identified by project + dataset id; "/" cannot appear in either, so it is an
  // unambiguous separator.
  #datasetKey(projectId: string, datasetId: string): string {
    return `observedDataset:${projectId}/${datasetId}`;
  }

  #isDatasetObserved(projectId: string, datasetId: string): boolean {
    let state = this.ctx.storage.kv.get<ObservedSetState>(this.#datasetKey(projectId, datasetId));
    return state === true || state === "observed";
  }

  #listTrackedDatasets(): { projectId: string; datasetId: string }[] {
    let prefix = "observedDataset:";
    return [...this.ctx.storage.kv.list<ObservedSetState>({ prefix })].map(([key]) => {
      let rest = key.slice(prefix.length);
      let slash = rest.indexOf("/");
      return { projectId: rest.slice(0, slash), datasetId: rest.slice(slash + 1) };
    });
  }

  *#listObservers(): IterableIterator<[string, Fetcher<GoogleVerifierApi>]> {
    let prefix = "observer:";
    for (let [key, verifier] of this.ctx.storage.kv.list<Fetcher<GoogleVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Marks unknown datasets pending and returns current observers who cannot access any pending
  // dataset in this attempt. Authorization promotes them; failed attempts remain pending and are
  // rechecked on retry.
  async #prepareDatasetObservation(
    datasets: { projectId: string; datasetId: string }[],
  ): Promise<ObserverCheck<{ projectId: string; datasetId: string }>> {
    let seen = new Set<string>();
    let pendingDatasets = datasets.filter(d => {
      let key = `${d.projectId}/${d.datasetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !this.#isDatasetObserved(d.projectId, d.datasetId);
    });
    if (pendingDatasets.length === 0) return {pendingSets: pendingDatasets, commit() {}};
    for (let d of pendingDatasets) {
      let key = this.#datasetKey(d.projectId, d.datasetId);
      if (this.ctx.storage.kv.get<ObservedSetState>(key) === undefined) {
        this.ctx.storage.kv.put(key, "pending");
      }
    }
    let observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      let access = await Promise.all(pendingDatasets.map(
        d => verifier.hasDatasetAccess(d.projectId, d.datasetId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    let excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingSets: pendingDatasets,
      commit: () => {
        for (let d of pendingDatasets) {
          this.ctx.storage.kv.put(this.#datasetKey(d.projectId, d.datasetId), "observed");
        }
      },
    };
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    let checked = new Set<string>();
    while (true) {
      let datasets = this.#listTrackedDatasets()
          .filter(d => !checked.has(`${d.projectId}/${d.datasetId}`));
      if (datasets.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await Promise.all(datasets.map(
        d => verifier.hasDatasetAccess(d.projectId, d.datasetId),
      ));
      for (let [index, d] of datasets.entries()) {
        if (!access[index]) {
          throw new Error(
            `此协作者无权访问 BigQuery 数据集 \`${d.projectId}.${d.datasetId}\`，` +
            `而此工作区已读取其中的数据，因此不能允许其查看这些数据。`);
        }
        checked.add(`${d.projectId}/${d.datasetId}`);
      }
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }
}

@validateRpc()
class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;
  // Records the datasets an observation reveals and returns observers to exclude (see
  // BigQueryGatekeeperImpl.#prepareDatasetObservation).
  #observe: (datasets: { projectId: string; datasetId: string }[]) =>
    Promise<ObserverCheck<{ projectId: string; datasetId: string }>>;

  constructor(
    api: BigQueryApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    scopedProjectId: string | undefined,
    scopedDatasetId: string | undefined,
    scopedTableId: string | undefined,
    observe: (datasets: { projectId: string; datasetId: string }[]) =>
      Promise<ObserverCheck<{ projectId: string; datasetId: string }>>,
  ) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#scopedProjectId = scopedProjectId;
    this.#scopedDatasetId = scopedDatasetId;
    this.#scopedTableId = scopedTableId;
    this.#observe = observe;
  }

  // Authorize an observation that reveals data belonging to specific dataset(s), tracking them and
  // excluding observers who lack access to a newly-seen one. Use for every read that exposes dataset
  // data; pass an empty `datasets` for reads that reveal none (e.g. echoing the scoped project id).
  async #authorizeDatasets(
    datasets: { projectId: string; datasetId: string }[],
    description: ObservationDescription,
  ): Promise<void> {
    let check = datasets.length > 0 ? await this.#observe(datasets) : {pendingSets: [], commit() {}};
    await this.#approvalQueue.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  // The unique datasets referenced by a dry-run's `referencedTables` (format "project.dataset.table",
  // matching #checkScopedTables's parsing).
  static #datasetsFromReferencedTables(referenced: string[]): { projectId: string; datasetId: string }[] {
    let out: { projectId: string; datasetId: string }[] = [];
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length === 3) out.push({ projectId: parts[0], datasetId: parts[1] });
    }
    return out;
  }

  // --- helpers -----------------------------------------------------------

  // Pick the project to bill the query against. When scoped, the scoped project is used and
  // the caller cannot override. When unscoped, the caller must declare a default project via
  // `defaultDataset.projectId` (BigQuery requires a billing project on every query).
  #billingProject(): string {
    if (this.#scopedProjectId) return this.#scopedProjectId;
    throw new Error(
      "此会话未限定到项目。请连接到特定 BigQuery 项目（例如 " +
      "https://bigquery.googleapis.com/my-project）后再运行查询。");
  }

  #effectiveDataset(opts: { defaultDataset?: string } | undefined): string | undefined {
    if (this.#scopedDatasetId) {
      if (opts?.defaultDataset && opts.defaultDataset !== this.#scopedDatasetId) {
        throw new Error(
          `无法将 defaultDataset 覆盖为“${opts.defaultDataset}”；` +
          `此连接限定到“${this.#scopedDatasetId}”。`);
      }
      return this.#scopedDatasetId;
    }
    return opts?.defaultDataset;
  }

  // Note: callers can still probe whether out-of-scope tables exist by attempting queries
  // and observing which error class fires (out-of-scope vs. not-found vs. DML-rejected).
  // The data is protected; the namespace is partly leaky.
  #checkScopedTables(referenced: string[]): void {
    if (!this.#scopedProjectId) throw new Error("BigQuery 查询需要限定到项目的绑定。");
    // Empty referencedTables is fine for project-only scope (e.g. `SELECT 1`,
    // `SELECT CURRENT_TIMESTAMP()`) — there are no tables to scope-check. Only require
    // at least one referenced table when the binding narrows to a specific dataset or
    // table, since otherwise there's nothing to verify the scope against.
    if (referenced.length === 0) {
      if (this.#scopedDatasetId || this.#scopedTableId) {
        throw new Error(
          "BigQuery 试运行未报告任何引用的表；由于无法验证资源范围，已拒绝执行。");
      }
      return;
    }
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length !== 3) {
        throw new Error(`无法解析引用的表“${ref}”。`);
      }
      let [proj, ds, tbl] = parts;
      if (proj !== this.#scopedProjectId) {
        throw new Error(
          `查询引用了项目“${proj}”，但此连接限定到“${this.#scopedProjectId}”。`);
      }
      if (this.#scopedDatasetId && ds !== this.#scopedDatasetId) {
        throw new Error(
          `查询引用了数据集“${proj}.${ds}”，但此连接限定到` +
          `“${this.#scopedProjectId}.${this.#scopedDatasetId}”。`);
      }
      if (this.#scopedTableId && tbl !== this.#scopedTableId) {
        throw new Error(
          `查询引用了表“${ref}”，但此连接限定到` +
          `“${this.#scopedProjectId}.${this.#scopedDatasetId}.${this.#scopedTableId}”。`);
      }
    }
  }

  #assertReadOnlyEstimate(estimate: {
    statementType?: string;
    ddlOperationPerformed?: string;
    hasScript: boolean;
    hasDmlStats: boolean;
    referencedRoutines?: string[];
  }): void {
    if (estimate.hasScript || estimate.statementType === "SCRIPT") {
      throw new Error("仅允许单条只读 SELECT 查询。");
    }
    if (estimate.ddlOperationPerformed) {
      throw new Error("不允许 DDL 语句。");
    }
    if (estimate.hasDmlStats) {
      throw new Error("不允许 DML 语句。");
    }
    // Allowlist (fail-closed): require an explicit SELECT statementType. BigQuery's dry-run
    // doesn't always populate statementType for every form, so a missing value should be
    // treated as "unknown" and rejected — not assumed safe just because the explicit DDL/DML
    // guards above didn't trip.
    if (!estimate.statementType) {
      throw new Error(
        "BigQuery 试运行未报告语句类型，已拒绝执行。");
    }
    if (estimate.statementType !== "SELECT") {
      throw new Error(
        `仅允许只读 SELECT 查询（收到 ${estimate.statementType}）。`);
    }
    if (estimate.referencedRoutines && estimate.referencedRoutines.length > 0) {
      throw new Error(
        "不允许引用例程的查询，因为无法通过 referencedTables 限定其数据访问范围。");
    }
  }

  // --- API ---------------------------------------------------------------

  async query(sql: string, opts?: BigQueryQueryOptions): Promise<BigQueryQueryResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);
    let maxBytes = opts?.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED;

    // Always dry-run first to enforce scope and get a cost estimate. Dry-runs are free
    // (BigQuery doesn't bill for them), and the response includes `referencedTables`
    // parsed by Google's own SQL engine — the only reliable way to check scope on
    // arbitrary SQL.
    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);
    if (estimate.bytesProcessed > maxBytes) {
      throw new Error(
        `查询将处理 ${(estimate.bytesProcessed / 1e9).toFixed(2)} GB，超过 ` +
        `${(maxBytes / 1e9).toFixed(2)} GB 的限制。可传入更高的 \`maximumBytesBilled\` 覆盖此限制。`);
    }

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery 查询：${preview}`,
      description:
        `SQL 预览：\`${preview}\`${sql.length > preview.length ? "..." : ""}\n` +
        (defaultDataset ? `默认数据集：\`${defaultDataset}\`\n` : "") +
        `计费项目：\`${billingProject}\`\n` +
        `引用的表：${estimate.referencedTables.join(", ")}\n` +
        `预计处理字节数：${estimate.bytesProcessed.toLocaleString()}\n` +
        `最大计费字节数：${maxBytes.toLocaleString()}。`,
      prohibitAllSharing: true,
    });

    let result = await this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset,
      maximumBytesBilled: maxBytes,
    });

    return result;
  }

  async dryRun(
    sql: string,
    opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">,
  ): Promise<BigQueryDryRunResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);

    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery 试运行：${preview}`,
      description:
        `预计处理字节数：${estimate.bytesProcessed.toLocaleString()}\n` +
        `引用的表：${estimate.referencedTables.join(", ") || "（无）"}`,
      prohibitAllSharing: true,
    });

    return estimate;
  }

  async getProject(): Promise<BigQueryProject> {
    let result: BigQueryProject = { projectId: this.#scopedProjectId! };
    // Echoes the project id the Gadget was bound to — reveals no dataset data, so no attribution.
    await this.#authorizeDatasets([], {
      title: "获取 BigQuery 项目",
      description: `返回限定范围的项目：\`${this.#scopedProjectId}\`。`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async listDatasets(projectId?: string): Promise<BigQueryDataset[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `无法列出“${projectId}”中的数据集；此连接限定到“${this.#scopedProjectId}”。`);
    }
    let p = this.#scopedProjectId ?? projectId;
    if (!p) {
      throw new Error("会话未限定范围时，listDatasets 需要 projectId。");
    }

    if (this.#scopedDatasetId) {
      let dataset = await this.#api.getDataset(p, this.#scopedDatasetId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: this.#scopedDatasetId }], {
        title: `列出 ${p} 中的数据集`,
        description: `返回限定范围的数据集 \`${p}.${this.#scopedDatasetId}\`（1 个数据集）。`,
        prohibitAllSharing: true,
      });
      return [dataset];
    }

    let result = await this.#api.listDatasets(p);
    // Listing reveals each dataset's existence/name, so attribute to all of them.
    await this.#authorizeDatasets(result.map(ds => ({ projectId: p, datasetId: ds.datasetId })), {
      title: `列出 ${p} 中的数据集`,
      description: `列出 \`${p}\` 中的 ${result.length} 个数据集。`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async listTables(datasetId?: string, projectId?: string): Promise<BigQueryTable[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `无法列出项目“${projectId}”中的表；此连接限定到“${this.#scopedProjectId}”。`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `无法列出数据集“${datasetId}”中的表；此连接限定到“${this.#scopedDatasetId}”。`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    if (!p) throw new Error("会话未限定范围时，listTables 需要 projectId。");
    if (!d) throw new Error("会话未限定范围时，listTables 需要 datasetId。");

    if (this.#scopedTableId) {
      let { table } = await this.#api.getTable(p, d, this.#scopedTableId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
        title: `列出 ${p}.${d} 中的表`,
        description: `返回限定范围的表 \`${p}.${d}.${this.#scopedTableId}\`（1 张表）。`,
        prohibitAllSharing: true,
      });
      return [table];
    }

    let result = await this.#api.listTables(p, d);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `列出 ${p}.${d} 中的表`,
      description: `列出 \`${p}.${d}\` 中的 ${result.length} 张表。`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async describeTable(
    tableId?: string,
    datasetId?: string,
    projectId?: string,
  ): Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `无法描述项目“${projectId}”中的表；此连接限定到“${this.#scopedProjectId}”。`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `无法描述数据集“${datasetId}”中的表；此连接限定到“${this.#scopedDatasetId}”。`);
    }
    if (this.#scopedTableId && tableId && tableId !== this.#scopedTableId) {
      throw new Error(
        `无法描述表“${tableId}”；此连接限定到“${this.#scopedTableId}”。`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    let t = this.#scopedTableId ?? tableId;
    if (!p) throw new Error("会话未限定范围时，describeTable 需要 projectId。");
    if (!d) throw new Error("会话未限定范围时，describeTable 需要 datasetId。");
    if (!t) throw new Error("会话未限定范围时，describeTable 需要 tableId。");

    let result = await this.#api.getTable(p, d, t);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `描述 ${p}.${d}.${t}`,
      description:
        `描述表 \`${p}.${d}.${t}\`（${result.schema.length} 列）。`,
      prohibitAllSharing: true,
    });
    return result;
  }
}
