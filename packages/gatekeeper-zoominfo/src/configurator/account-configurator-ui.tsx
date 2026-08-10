import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ZoomInfoAccountConfiguratorRpc,
  ZoomInfoAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected and
// signals readiness. The sandboxed runtime has no effect hooks, so we render static text and rely
// on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="整个账户的访问权限"
        description="此绑定将授予对所连接 ZoomInfo 账户的访问权限，包括查找、公司/联系人/意向/Scoop/新闻搜索、记录扩充（会消耗额度）、推荐和账户情报；所有功能均受该账户 ZoomInfo 权限限制。">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ZoomInfoAccountConfiguratorRpc, ZoomInfoAccountConfiguratorValues>;
