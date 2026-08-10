import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantInstanceConfiguratorRpc,
  HomeAssistantInstanceConfiguratorValues,
} from "./instance-configurator-types";

// The whole-instance resource has no user-selectable inputs — once the user has connected an
// account, the resource URL is fully determined. The configurator just displays a confirmation
// of which HA instance is being connected and signals readiness.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  // Note: the sandboxed configurator UI runtime doesn't support useEffect-style hooks, so we
  // can't lazily fetch and display the actual HA instance name here. We render static text
  // and let the user trust that the configurator wires up the correct account; the `ui`
  // capability is only used by `resourceUrl` above.
  render() {
    return <Section>
      <Field
        label="整个实例的访问权限"
        description="此绑定将授予对所连接 Home Assistant 实例中每个区域、设备、实体和仪表板的访问权限。">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantInstanceConfiguratorRpc, HomeAssistantInstanceConfiguratorValues>;
