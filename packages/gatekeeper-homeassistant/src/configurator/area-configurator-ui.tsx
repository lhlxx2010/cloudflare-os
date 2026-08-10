import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantAreaConfiguratorRpc,
  HomeAssistantAreaConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.areaId === "string" && values.areaId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.areaId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="区域" description="选择一个 Home Assistant 区域（房间）。">
        <Autocomplete
          name="areaId"
          value={values.areaId}
          placeholder="搜索区域…"
          loadOptions={query => ui.listAreas(query)}
          onChange={areaId => setValues({ areaId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantAreaConfiguratorRpc, HomeAssistantAreaConfiguratorValues>;
