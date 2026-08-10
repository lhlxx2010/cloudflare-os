import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionItemConfiguratorRpc,
  NotionItemConfiguratorValues,
} from "./notion-item-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.itemUrl === "string" && values.itemUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { itemUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.itemUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="页面或数据库"
        description="搜索已与此连接共享的 Notion 页面和数据库，或粘贴 Notion URL。"
      >
        <Autocomplete
          name="itemUrl"
          value={values.itemUrl}
          placeholder="搜索 Notion…"
          loadOptions={query => ui.listItems(query)}
          onChange={itemUrl => setValues({ itemUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionItemConfiguratorRpc, NotionItemConfiguratorValues>;
