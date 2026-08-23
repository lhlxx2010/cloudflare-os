import {
  Autocomplete, CheckboxList, Field, h, RadioCards, Section,
  type ConfiguratorUIOption, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

let pendingServers: Promise<ConfiguratorUIOption[]> | null = null;
let loadedServers: ConfiguratorUIOption[] | null = null;

function serverOptions(ui: McpServerConfiguratorRpc): Promise<ConfiguratorUIOption[]> {
  pendingServers ??= (async () => {
    loadedServers = await ui.listServerOptions();
    return loadedServers;
  })();
  return pendingServers;
}

async function loadServerOptions(
  ui: McpServerConfiguratorRpc,
  query = "",
): Promise<ConfiguratorUIOption[]> {
  const servers = await serverOptions(ui);
  const needle = query.trim().toLowerCase();
  return needle
    ? servers.filter(server =>
        server.value.toLowerCase().includes(needle) || server.title.toLowerCase().includes(needle))
    : servers;
}

export default {
  initial: { server: null, mode: "all", tools: null, endpointKind: "unknown" },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    const server = params.get("server")?.trim() || null;
    return {
      server,
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
      endpointKind: server ? "portal" : "unknown",
    };
  },

  isReady({ values }) {
    if (values.endpointKind !== "portal" || !values.server) return false;
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    if (!values.server) throw new Error("添加前，请先选择此门户背后的服务器。");
    const endpoint = await ui.getEndpoint();
    const params = new URLSearchParams({ server: values.server });
    if (values.mode !== "all") {
      const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
        .map(decodeURIComponent);
      for (const tool of selected) params.append("tool", tool);
      if (selected.length === 0) params.append("tool", "");
    }
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    if (values.endpointKind === "unknown") {
      void serverOptions(ui).then(
        servers => setValues({
          endpointKind: servers.length > 0 ? "portal" : "empty",
          server: servers.length === 1 ? servers[0].value : values.server,
        }),
        () => setValues({ endpointKind: "unavailable" }),
      );
    }

    if (values.endpointKind === "unavailable") {
      return <Section>
        <Field
          label="服务器"
          description={
            "无法连接 Portal 以列出其背后的服务器，因此暂时没有可授权的内容。请关闭后重试；" +
            "如果问题持续发生，请联系管理员检查 Portal 配置和上下文优化设置。"
          }
        />
      </Section>;
    }

    if (values.endpointKind === "empty") {
      return <Section>
        <Field
          label="服务器"
          description={
            "Portal 没有返回任何直接的上游工具。如果本应存在服务器，请在关闭 Code Mode " +
            "（`?codemode=off`）后连接，并移除 `optimize_context` 参数；否则请在 Portal 中启用服务器后重试。"
          }
        />
      </Section>;
    }

    const soleServer = loadedServers?.length === 1 ? loadedServers[0] : null;
    const mode = values.mode === "choose" ? "choose" : "all";
    const toolsReady = Boolean(values.server);
    const serverKey = values.server ?? "";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      {!soleServer && <Field
        label="服务器"
        description="选择要授权的门户后端服务器，随后将显示其工具。"
      >
        <Autocomplete
          name="server"
          value={values.server}
          placeholder="搜索此门户背后的服务器…"
          loadOptions={query => loadServerOptions(ui, query)}
          onChange={server => setValues({ server, tools: null })}
          onClear={() => setValues({ server: null, tools: null })}
        />
      </Field>}

      {toolsReady && <Field
        label={soleServer ? `工具 · ${soleServer.title}` : "工具"}
        description="选择此连接可以调用该服务器上的哪些工具。"
      >
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: "所有工具",
              description: "此服务器提供的每个工具，包括日后新增的工具。",
            },
            {
              value: "choose",
              title: "选择工具",
              description:
                "仅允许你从最多显示的 200 个工具中勾选的工具，其他工具（包括日后新增的工具）都将被拒绝。",
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>}

      {toolsReady && <Field
        label="允许的工具"
        description={mode === "all"
          ? "只读工具会立即返回数据，其余工具将排队等待你的批准。"
          : selectedCount > 0
            ? `已选择 ${selectedCount} 个。只读工具会立即返回数据，其余工具将排队等待你的批准。`
            : "请至少勾选一个工具以授予权限。"}
      >
        <CheckboxList
          name={`tools:${serverKey}`}
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions(serverKey))
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
