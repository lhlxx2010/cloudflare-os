import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSpaceConfiguratorRpc,
  ConfluenceSpaceConfiguratorValues,
} from "./confluence-space-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.spaceUrl === "string" && values.spaceUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { spaceUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.spaceUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="空间" description="搜索已与此连接共享的空间。">
        <Autocomplete
          name="spaceUrl"
          value={values.spaceUrl}
          placeholder="搜索空间…"
          loadOptions={query => ui.listSpaces(query)}
          onChange={spaceUrl => setValues({ spaceUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSpaceConfiguratorRpc, ConfluenceSpaceConfiguratorValues>;
