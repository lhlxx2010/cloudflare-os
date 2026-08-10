import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  LinearWorkspaceConfiguratorRpc,
  LinearWorkspaceConfiguratorValues,
} from "./linear-workspace-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.workspaceUrlKey === "string" && values.workspaceUrlKey.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [workspaceUrlKey] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return workspaceUrlKey ? { workspaceUrlKey } : {};
  },

  resourceUrl({ values }) {
    return `https://linear.app/${values.workspaceUrlKey}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="工作区" description="此账户连接的 Linear 工作区。">
        <Autocomplete
          name="workspaceUrlKey"
          value={values.workspaceUrlKey}
          placeholder="选择你的工作区…"
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspaceUrlKey => setValues({ workspaceUrlKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearWorkspaceConfiguratorRpc, LinearWorkspaceConfiguratorValues>;
