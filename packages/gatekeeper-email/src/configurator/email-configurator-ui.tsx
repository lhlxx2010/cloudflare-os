import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues } from "./email-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.emailName === "string" && values.emailName.trim().length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const user = segments[segments.length - 1];
    return user ? { emailName: decodeURIComponent(user) } : {};
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.emailName);
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="邮箱名称" description="选择此连接可接收邮件的邮箱地址本地部分。">
        <TextInput
          name="emailName"
          value={values.emailName}
          placeholder="通知"
          onChange={emailName => setValues({ emailName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues>;
