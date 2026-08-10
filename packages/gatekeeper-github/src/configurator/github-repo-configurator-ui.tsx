import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}` } : {};
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="仓库" description="搜索你的仓库，或输入 GitHub URL。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="搜索或粘贴仓库 URL…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
