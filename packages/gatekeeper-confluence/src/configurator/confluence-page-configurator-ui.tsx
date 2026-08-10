import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluencePageConfiguratorRpc,
  ConfluencePageConfiguratorValues,
} from "./confluence-page-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.pageUrl === "string" && values.pageUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { pageUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.pageUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="页面或博客文章"
        description="搜索已与此连接共享的页面和博客文章，或粘贴 Confluence URL。"
      >
        <Autocomplete
          name="pageUrl"
          value={values.pageUrl}
          placeholder="搜索 Confluence…"
          loadOptions={query => ui.listPages(query)}
          onChange={pageUrl => setValues({ pageUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluencePageConfiguratorRpc, ConfluencePageConfiguratorValues>;
