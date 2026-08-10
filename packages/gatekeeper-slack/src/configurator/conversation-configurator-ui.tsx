import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConversationConfiguratorRpc, ConversationConfiguratorValues,
} from "./conversation-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.conversationId === "string" && values.conversationId.length > 0;
  },

  async resourceUrl({ values, ui }) {
    const teamId = await ui.getTeamId();
    return `https://app.slack.com/client/${teamId}/${encodeURIComponent(values.conversationId ?? "")}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const conversationId = segments[2];
    return conversationId ? { conversationId: decodeURIComponent(conversationId) } : {};
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="会话"
        description="选择此连接可以读取的频道或私信。"
      >
        <Autocomplete
          name="conversationId"
          value={values.conversationId}
          placeholder="搜索频道和私信…"
          loadOptions={query => ui.listConversations(query)}
          onChange={conversationId => setValues({ conversationId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConversationConfiguratorRpc, ConversationConfiguratorValues>;
