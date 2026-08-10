import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues } from "./github-issue-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.issueNumber === "string" && values.issueNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, issueNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/issues/${values.issueNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="仓库" description="搜索你的仓库，或输入 GitHub URL。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="搜索或粘贴仓库 URL…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, issueNumber: null })}
        />
      </Field>

      <Field label="议题" description="在所选仓库中选择一个议题。">
        <Autocomplete
          name="issueNumber"
          value={values.issueNumber}
          placeholder={values.repoFullName ? "搜索议题…" : "请先选择仓库"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listIssues(values.repoFullName, query)}
          onChange={issueNumber => setValues({ issueNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues>;
