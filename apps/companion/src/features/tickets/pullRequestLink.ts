import { parseGithubPullRequestUrl } from '@pi-lead-child/protocol';

export type TicketPullRequest = {
  url: string;
  /** 「owner/repo#85」：产物区里的名字。 */
  name: string;
  /** 「#85」：工单卡片上的小标签。 */
  short: string;
};

/**
 * 工单登记的 PR（TicketSummary.workspace.pullRequestUrl，系统开的或 link_pr 登记的）。
 * 不是 GitHub 的 PR 地址时返回 null：界面只给 https://github.com/<owner>/<repo>/pull/<n> 画链接。
 */
export function ticketPullRequest(workspace: { pullRequestUrl?: string | undefined } | null | undefined): TicketPullRequest | null {
  const ref = workspace?.pullRequestUrl ? parseGithubPullRequestUrl(workspace.pullRequestUrl) : null;
  return ref ? { url: ref.url, name: `${ref.owner}/${ref.repo}#${ref.number}`, short: `#${ref.number}` } : null;
}
