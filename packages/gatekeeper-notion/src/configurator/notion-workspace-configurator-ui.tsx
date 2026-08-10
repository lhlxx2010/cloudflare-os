import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionWorkspaceConfiguratorRpc,
  NotionWorkspaceConfiguratorValues,
} from "./notion-workspace-configurator-types";

export default {
  initial: {},

  // Whole-workspace access takes no parameters, so it is always ready to add.
  isReady() {
    return true;
  },

  resourceUrl() {
    return "https://www.notion.so/";
  },

  render() {
    return <Section>
      <Field
        label="整个工作区"
        description="授予对此 Notion 连接已共享的每个页面和数据库的访问权限。如需限制访问范围，请改为连接单个页面或数据库。"
      >
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionWorkspaceConfiguratorRpc, NotionWorkspaceConfiguratorValues>;
