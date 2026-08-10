import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantEntityConfiguratorRpc,
  HomeAssistantEntityConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.entityId === "string" && values.entityId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.entityId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="实体" description="选择单个 Home Assistant 实体，例如灯、传感器或开关。">
        <Autocomplete
          name="entityId"
          value={values.entityId}
          placeholder="搜索实体…"
          loadOptions={query => ui.listEntities(query)}
          onChange={entityId => setValues({ entityId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantEntityConfiguratorRpc, HomeAssistantEntityConfiguratorValues>;
