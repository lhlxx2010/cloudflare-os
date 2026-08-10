import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSiteConfiguratorRpc,
  ConfluenceSiteConfiguratorValues,
} from "./confluence-site-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.siteUrl === "string" && values.siteUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { siteUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.siteUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Confluence 站点" description="选择要连接的 Confluence 站点。">
        <Autocomplete
          name="siteUrl"
          value={values.siteUrl}
          placeholder="搜索站点…"
          loadOptions={query => ui.listSites(query)}
          onChange={siteUrl => setValues({ siteUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSiteConfiguratorRpc, ConfluenceSiteConfiguratorValues>;
