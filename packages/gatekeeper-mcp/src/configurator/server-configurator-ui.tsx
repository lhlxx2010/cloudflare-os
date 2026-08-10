import {
  CheckboxList, Field, h, RadioCards, Section, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

export default {
  initial: { mode: "all", tools: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    return {
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
    };
  },

  isReady({ values }) {
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    const endpoint = await ui.getEndpoint();
    if (values.mode === "all") return endpoint;

    const params = new URLSearchParams();
    const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
      .map(decodeURIComponent);
    for (const tool of selected) params.append("tool", tool);
    if (selected.length === 0) params.append("tool", "");
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    const mode = values.mode === "choose" ? "choose" : "all";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      <Field label="工具" description="选择此连接可以调用该服务器上的哪些工具。">
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
                "仅允许你勾选的工具，其他工具（包括日后新增的工具）都将被拒绝。",
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>
      <Field
        label="允许的工具"
        description={mode === "all"
          ? "只读工具会立即返回数据，其余工具将排队等待你的批准。"
          : selectedCount > 0
            ? `已选择 ${selectedCount} 个。只读工具会立即返回数据，其余工具将排队等待你的批准。`
            : "请至少勾选一个工具以授予权限。"}>
        <CheckboxList
          name="tools"
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions())
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
