import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SupabaseOrganizationConfiguratorRpc,
  SupabaseOrganizationConfiguratorValues,
} from "./supabase-organization-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.slug === "string" && values.slug.length > 0;
  },

  resourceUrl({ values }) {
    return `https://supabase.com/dashboard/org/${values.slug}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="组织" description="搜索所连接 Supabase 账户中的组织。">
        <Autocomplete
          name="slug"
          value={values.slug}
          placeholder="搜索组织…"
          loadOptions={query => ui.listOrganizations(query)}
          onChange={slug => setValues({ slug })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseOrganizationConfiguratorRpc, SupabaseOrganizationConfiguratorValues>;
