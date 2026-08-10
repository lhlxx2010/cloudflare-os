import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantDeviceConfiguratorRpc,
  HomeAssistantDeviceConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.deviceId === "string" && values.deviceId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.deviceId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="设备" description="选择一个实体设备。此绑定将授予对该设备所提供全部实体的访问权限。">
        <Autocomplete
          name="deviceId"
          value={values.deviceId}
          placeholder="搜索设备…"
          loadOptions={query => ui.listDevices(query)}
          onChange={deviceId => setValues({ deviceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantDeviceConfiguratorRpc, HomeAssistantDeviceConfiguratorValues>;
