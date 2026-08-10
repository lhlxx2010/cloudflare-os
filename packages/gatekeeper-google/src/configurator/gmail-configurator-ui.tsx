import { Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GmailConfiguratorRpc, GmailConfiguratorValues } from "./gmail-configurator-types";

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "search") return typeof values.query === "string" && values.query.trim().length > 0;
    if (mode === "label") return typeof values.label === "string" && values.label.trim().length > 0;
    return false;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const hash = new URL(resourceUrl).hash.replace(/^#/, "");
    if (hash.startsWith("search/")) {
      return { mode: "search", query: decodeURIComponent(hash.slice("search/".length)) };
    }
    if (hash.startsWith("label/")) {
      return { mode: "label", label: decodeURIComponent(hash.slice("label/".length)) };
    }
    return { mode: "all" };
  },

  resourceUrl({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "search") {
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(values.query ?? "")}`;
    }
    if (mode === "label") {
      return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(values.label ?? "")}`;
    }
    return "https://mail.google.com/mail/u/0/";
  },

  render({ values, setValues, clearFields }) {
    const mode = values.mode ?? "all";
    return <Section>
      <Field label="邮箱范围" description="选择此连接是可以访问全部 Gmail 邮件，还是仅访问范围更小的 Gmail 原生视图。">
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: "全部 Gmail 邮件", description: "允许访问整个邮箱。" },
            { value: "search", title: "搜索条件", description: "允许访问符合 Gmail 搜索条件的邮件。" },
            { value: "label", title: "标签", description: "允许访问带有指定 Gmail 标签的邮件。" },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "search" && nextMode !== "label") return;
            clearFields("query", "label");
            setValues({ mode: nextMode, query: null, label: null });
          }}
        />
      </Field>

      {mode === "search" && <Field label="搜索条件" description="使用与 Gmail 搜索相同的查询语法。">
        <TextInput
          name="query"
          value={values.query}
          placeholder="from:alerts@example.com newer_than:30d"
          onChange={query => setValues({ query })}
        />
      </Field>}

      {mode === "label" && <Field label="标签" description="请使用 Gmail 中显示的准确标签名称。">
        <TextInput
          name="label"
          value={values.label}
          placeholder="收据"
          onChange={label => setValues({ label })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GmailConfiguratorRpc, GmailConfiguratorValues>;
