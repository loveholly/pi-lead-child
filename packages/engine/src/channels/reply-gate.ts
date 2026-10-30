// 代回闸门（代查与按信心代回 spec D7）在 2026-10-22 退役了（落地计划 A6）：回复决定改用信心模型（confidence-model.ts），
// 结论由 reply-decision.ts 写成卡上的检查和否决项。这里只留还在用的两样：
//   - 旧闸门的否决项：退役以前的代查记录里存的是这些编号，卡片照样显示它们的说法（lookup-dto.ts）；
//   - 信心的分数段：校准按它分段（calibration.ts）。
// 这里不出现任何具体来源的名字。

export const REPLY_VETOES = [
  "sensitive_topic", "draft_commits", "draft_overshares", "sender_trust", "external_shared", "newer_messages", "stale_result",
  "card_closed",
] as const;
export type ReplyVeto = typeof REPLY_VETOES[number];

export const REPLY_VETO_LABELS: Record<ReplyVeto, string> = {
  sensitive_topic: "可能涉及钱、人事、法律或情绪敏感的话题",
  draft_commits: "草稿可能替你做了承诺",
  draft_overshares: "草稿可能说了超过所问的内容，或者敏感的内容",
  sender_trust: "发信人的信任级别不允许代回",
  external_shared: "这是和外部组织共享的对话（或者问不到）",
  newer_messages: "查完以后对方（或你）又发了新消息，结果可能过时",
  stale_result: "结果太久了",
  card_closed: "这张卡已经结束",
};

/** 信心的分数段：floor(c × 10) / 10。多加一点点再取整，免得 0.7 × 10 这样的浮点误差落到下一段。 */
export function replyConfidenceBucket(confidence: number): number {
  const c = Math.min(Math.max(Number.isFinite(confidence) ? confidence : 0, 0), 1);
  return Math.floor(c * 10 + 1e-9) / 10;
}
