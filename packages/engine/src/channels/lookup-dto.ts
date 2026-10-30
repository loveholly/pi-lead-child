// 卡上的代查（代查与按信心代回 spec D9）：store 的一次代查 → 线上的 ChannelLookupDto。纯函数。
// 外部的原文（答案、出处的摘录）原样放进去，是给人看的不可信数据；回复的草稿在卡的 draft 里，这里没有。
// 这里不出现任何具体来源的名字。
import type { ChannelLookupDto, LookupScope } from "@pi-lead-child/protocol";
import type { ChannelLookup } from "@pi-lead-child/store";
import { REPLY_VETO_LABELS, type ReplyVeto } from "./reply-gate.js";

// 旧代查被代查闸门拒绝的原因（代查在 2026-10-22 退役，落地计划 D1）：旧记录的卡上照样显示这些说法。
const LOOKUP_GATE_LABELS: Record<string, string> = {
  ask_kind: "不是一个要查的请求",
  sender_trust: "发信人的信任级别不允许代查",
  external_shared: "这是和外部组织共享的对话（或者问不到），不代查",
  sensitive_query: "有人提了敏感请求，没有查",
  target: "认不出要查哪个仓库（或者哪个 PR）",
  quota_requester: "这个人今天的代查次数用完了",
  quota_daily: "今天的代查次数用完了",
  concurrency: "同时进行的代查满了",
};

/** 卡上最多列多少条读取记录（count 是全部的次数）。 */
export const LOOKUP_DTO_READS_MAX = 100;

/** 作用域里的仓库名：本地的 owner/name 或目录名、GitHub 的 owner/repo、PR。去重。 */
export function lookupScopeRepos(scope: LookupScope): string[] {
  return [
    ...scope.local.map((entry) => entry.repo),
    ...scope.github.map((entry) => `${entry.owner}/${entry.repo}`),
    ...(scope.pullRequest ? [`${scope.pullRequest.owner}/${scope.pullRequest.repo}#${scope.pullRequest.number}`] : []),
  ].filter((name, index, all) => all.indexOf(name) === index);
}

export function lookupDto(lookup: ChannelLookup, context: {
  laneLabel: string;
  externalShared: boolean | null;
  newerMessages: number;
  ownerName: string | null;
}): ChannelLookupDto {
  const result = lookup.result;
  const verification = lookup.verification;
  const failed = (lookup.intake.gate?.failed ?? []) as string[];
  return {
    id: lookup.id,
    state: lookup.state,
    playbook: lookup.playbook,
    repos: lookupScopeRepos(lookup.scope),
    ticketId: lookup.itemId,
    startedAt: lookup.createdAt,
    finishedAt: lookup.finishedAt,
    result: result ? {
      found: result.found, answer: result.answer, sources: result.sources,
      connectionSources: result.connectionSources ?? [], actions: result.actions ?? [],
      checked: result.checked, caveats: result.caveats,
    } : null,
    review: result?.review ? {
      summary: result.review.summary, commentCount: result.review.comments.length, comments: result.review.comments,
    } : null,
    reads: { count: lookup.reads.length, items: lookup.reads.slice(0, LOOKUP_DTO_READS_MAX) },
    confidence: verification && lookup.reply ? {
      value: verification.confidence,
      threshold: verification.threshold,
      checks: verification.checks.map((check) => ({
        id: check.id, label: check.label, status: check.status, value: check.value, detail: check.detail,
      })),
      vetoes: verification.vetoes.map((veto) => REPLY_VETO_LABELS[veto as ReplyVeto] ?? veto),
      calibration: verification.calibration ? {
        bucket: verification.calibration.bucket, samples: verification.calibration.samples, agreed: verification.calibration.agreed,
        minSamples: Math.max(1, verification.calibration.minSamples),
      } : null,
    } : null,
    reply: lookup.reply ? { decision: lookup.reply.decision, reasons: lookup.reply.reasons, at: lookup.reply.at } : null,
    audience: { label: context.laneLabel, externalShared: context.externalShared !== false },
    ownerName: context.ownerName,
    newerMessages: Math.max(0, context.newerMessages),
    deniedReasons: lookup.state === "denied"
      ? failed.map((condition) => LOOKUP_GATE_LABELS[condition] ?? condition)
      : [],
    error: lookup.state === "failed" || lookup.state === "cancelled" ? verification?.error ?? null : null,
  };
}
