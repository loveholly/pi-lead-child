// 上下文包里提到的对象现在的状态（统一消息事件 spec D5 第 3 项，工单 04）：一个对象一行。查不到时是 null，Lead 看到「没查到」。
//   - PR：用本机的 gh 只读地查（gh pr view --json）：开着、草稿、合并了还是关了，标题，review 的结论，最后更新的时间。
//     owner、repo、编号先按格式校验，再作为参数交给 gh（不经过 shell）。拼包的时间到了上限时按 signal 放弃。
//   - 仓库：通道内核按请求 A 的候选仓库马上写本地的位置（engine 的 context-pack.ts，编辑以后同步重拼时也有），这里不再查。
//   - Jira：还没有接，null。
import { execFile } from "node:child_process";
import type { ChannelHubOptions } from "@pi-lead-child/engine";

type ObjectStatus = NonNullable<NonNullable<ChannelHubOptions["contextPack"]>["objectStatus"]>;

/** 运行 gh（只读），返回标准输出。失败时抛错。 */
export type GhRunner = (args: string[], signal: AbortSignal) => Promise<string>;

const GH_TIMEOUT_MS = 8_000;
const PR_REF = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/u;
const PR_STATES: Record<string, string> = { OPEN: "开着", MERGED: "已合并", CLOSED: "已关闭" };
const REVIEW_LABELS: Record<string, string> = { APPROVED: "已批准", CHANGES_REQUESTED: "要求修改", REVIEW_REQUIRED: "等 review" };

/** 本机的 gh。 */
export const localGh: GhRunner = (args, signal) => new Promise((resolve, reject) => {
  execFile("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, signal, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

export function contextObjectStatus(options: { gh: GhRunner | null }): ObjectStatus {
  return async (object, { signal }) => {
    if (object.kind === "pull_request") return options.gh ? pullRequestStatus(object.ref, options.gh, signal) : null;
    return null;
  };
}

async function pullRequestStatus(ref: string, gh: GhRunner, signal: AbortSignal): Promise<string | null> {
  const match = PR_REF.exec(ref);
  if (!match) return null;
  const [, owner, repo, number] = match;
  const output = await gh(["pr", "view", number!, "--repo", `${owner}/${repo}`, "--json", "state,isDraft,title,reviewDecision,mergedAt,updatedAt"], signal);
  const pr = JSON.parse(output) as { state?: unknown; isDraft?: unknown; title?: unknown; reviewDecision?: unknown; mergedAt?: unknown; updatedAt?: unknown };
  const state = typeof pr.state === "string" ? PR_STATES[pr.state] ?? pr.state.toLowerCase() : "状态不明";
  const parts = [`${state}${pr.isDraft === true && pr.state === "OPEN" ? "（草稿）" : ""}`];
  if (typeof pr.title === "string" && pr.title.trim()) parts.push(`标题「${pr.title.trim().slice(0, 80)}」`);
  if (typeof pr.reviewDecision === "string" && REVIEW_LABELS[pr.reviewDecision]) parts.push(`review ${REVIEW_LABELS[pr.reviewDecision]}`);
  const when = typeof pr.mergedAt === "string" && pr.mergedAt ? `合并于 ${pr.mergedAt.slice(0, 10)}`
    : typeof pr.updatedAt === "string" && pr.updatedAt ? `更新于 ${pr.updatedAt.slice(0, 10)}` : null;
  if (when) parts.push(when);
  return parts.join("，");
}
