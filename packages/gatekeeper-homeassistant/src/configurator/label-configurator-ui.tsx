import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantLabelConfiguratorRpc,
  HomeAssistantLabelConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.labelId === "string" && values.labelId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.labelId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="标签" description="选择一个 Home Assistant 标签。此绑定将授予对带有该标签的所有实体的访问权限。">
        <Autocomplete
          name="labelId"
          value={values.labelId}
          placeholder="搜索标签…"
          loadOptions={query => ui.listLabels(query)}
          onChange={labelId => setValues({ labelId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantLabelConfiguratorRpc, HomeAssistantLabelConfiguratorValues>;
