import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues,
} from "./workspace-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  async resourceUrl({ ui }) {
    return await ui.getWorkspaceUrl();
  },

  render() {
    return <Section>
      <Field
        label="整个工作区"
        description="此连接允许客户端读取你可以访问的频道和私信、浏览 Slack 工作区成员，并搜索消息。"
      >
        <span />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
