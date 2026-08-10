import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SpotifyAccountConfiguratorRpc,
  SpotifyAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected
// and signals readiness. The sandboxed runtime has no effect hooks, so we render static text and
// rely on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

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
        description="此绑定将授予对所连接 Spotify 账户的访问权限，包括个人资料、目录搜索、你的音乐库、播放列表，以及 Spotify Connect 设备上的播放控制。">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyAccountConfiguratorRpc, SpotifyAccountConfiguratorValues>;
