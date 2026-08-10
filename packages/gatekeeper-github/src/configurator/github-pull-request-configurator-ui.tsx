import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues } from "./github-pull-request-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.pullNumber === "string" && values.pullNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, pullNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/pull/${values.pullNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="仓库" description="搜索你的仓库，或输入 GitHub URL。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="搜索或粘贴仓库 URL…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, pullNumber: null })}
        />
      </Field>

      <Field label="拉取请求" description="在所选仓库中选择一个拉取请求。">
        <Autocomplete
          name="pullNumber"
          value={values.pullNumber}
          placeholder={values.repoFullName ? "搜索拉取请求…" : "请先选择仓库"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listPullRequests(values.repoFullName, query)}
          onChange={pullNumber => setValues({ pullNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues>;
