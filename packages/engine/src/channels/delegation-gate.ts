// 模板代回闸门（工单 11，spec D14）在 2026-10-22 退役了（落地计划 A5）：授权表（authority.ts）按请求 A 认出的意图决定
// 通道做什么，影子模式也不再用。起草器和它的回复模板在 2026-10-27 删了（统一消息事件工单 06：草稿只由 Lead 写）。
// 这里只留旧卡上闸门结论的说法：退役以前开的卡还带着闸门的结论，卡片照样显示它的原因。

// ── 旧卡上闸门的结论 ──────────────────────────────────────────────────────────────

export const DELEGATION_GATE_CONDITIONS = [
  "category", "sender_trust", "risk_confidence", "sensitive_topics", "shadow_approved", "reply_template", "revocable",
] as const;
export type DelegationGateCondition = typeof DELEGATION_GATE_CONDITIONS[number];

export const DELEGATION_GATE_LABELS: Record<DelegationGateCondition, string> = {
  category: "类别不在代回的白名单里",
  sender_trust: "发信人的信任级别不允许代回",
  risk_confidence: "风险不低，或者置信度不够",
  sensitive_topics: "可能涉及承诺、钱、人事、法律或情绪敏感的话题",
  shadow_approved: "这一类还没有通过影子模式并由你批准开放",
  reply_template: "草稿不是白名单里的回复模板",
  revocable: "这个来源不能撤回自动回复",
};
