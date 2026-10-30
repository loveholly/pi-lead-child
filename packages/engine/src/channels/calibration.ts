// 校准（落地计划 D2，design.md 第 8 节）：信心模型给代你发的草稿打分，你在来源里实际做了什么是这份草稿的标签。
//   - 样本不分任务：子 agent 工单的结果、Lead 写的回复、收尾时起草的一句，都是这个来源的样本（hub 记成 channel.reply.scored）。
//   - 标签看你的实际做法，不只看卡上的按钮：你点「不回」，可能是草稿太傻，你自己在来源里回了。
//       照发草稿 1，顶 1 个样本；自动发了、撤回窗口里没撤回 1，顶 0.5 个；自己写了别的（卡上改了再发，或者在来源里直接回）0，
//       顶 1 个；撤回了自动回复 0，顶 3 个；什么都没做：这条消息不用回，不校准草稿。
//   - 本该代你发的抽 5% 照样放到卡上问你，并标明是抽查：不然高分段永远没有标签。
// 纯函数，不读库。这里不出现任何具体来源的名字。
import type { ChannelReplyDecision, ChannelReplyLabel } from "@pi-lead-child/protocol";
import type { ConfidenceModelInput } from "./confidence-model.js";
import { replyConfidenceBucket } from "./reply-gate.js";

/** 每种标签：草稿的标签值（null 不校准草稿）、顶几个样本、给人看的说法。 */
export const CHANNEL_REPLY_LABEL_RULES: Readonly<Record<ChannelReplyLabel, { value: 0 | 1 | null; weight: number; words: string }>> = {
  sent_as_is: { value: 1, weight: 1, words: "照发了草稿" },
  auto_kept: { value: 1, weight: 0.5, words: "自动发了，撤回窗口里没撤回" },
  rewritten: { value: 0, weight: 1, words: "自己写了别的" },
  retracted: { value: 0, weight: 3, words: "撤回了自动回复" },
  no_action: { value: null, weight: 1, words: "什么都没做：这条消息不用回" },
};

/** 本该代你发的抽多少照样问你。 */
export const CHANNEL_REPLY_AUDIT_RATE = 0.05;
/** 卡结束以后等多久再定标签：你可能晚一点才在来源里回。 */
export const CHANNEL_REPLY_LABEL_SETTLE_MS = 30 * 60_000;

/** 抽查：信心模型说代你发的，按 rate 的概率改成问你。random 给 [0, 1) 的均匀数。 */
export function auditsReply(decision: string, rate: number, random: () => number): boolean {
  return decision === "auto_send" && rate > 0 && random() < rate;
}

/**
 * 一个来源所有带标签的样本，按分数段加权加起来（信心模型的 calibration 输入）。什么都没做的不校准草稿。
 * bucket 是打分时原始信心的分数段。
 */
export function calibrationFromLabels(
  rows: ReadonlyArray<{ bucket: number; value: 0 | 1 | null; weight: number }>,
): ConfidenceModelInput["calibration"] {
  const buckets = new Map<number, { bucket: number; samples: number; agreed: number }>();
  let samples = 0;
  for (const row of rows) {
    if (row.value === null || !(row.weight > 0) || !Number.isFinite(row.bucket)) continue;
    const bucket = replyConfidenceBucket(row.bucket);
    const entry = buckets.get(bucket) ?? { bucket, samples: 0, agreed: 0 };
    entry.samples += row.weight;
    entry.agreed += row.weight * row.value;
    buckets.set(bucket, entry);
    samples += row.weight;
  }
  return { samples, buckets: [...buckets.values()].sort((a, b) => a.bucket - b.bucket) };
}

/** 一个还没有标签的样本，和它那张卡现在的样子。时间都是毫秒。 */
export interface ReplySampleFacts {
  // 打分时的结论。
  decision: ChannelReplyDecision;
  scoredAt: number;
  card: {
    open: boolean;
    // 卡停在「已代你回复」，代你发的那一条还在。
    autoReplied: boolean;
    revokeUntil: number | null;
    // 你从卡上发了一条（发了别的草稿，或者改了再发）。
    userSent: boolean;
    resolvedAt: number | null;
  };
  // 这条消息以后、卡结束 settleMs 以内，你在来源里自己说了几句。
  selfReplies: number;
  now: number;
  settleMs: number;
}

/**
 * 卡上的按钮没有当场定下标签的样本（照发、改了再发、撤回当场就定），等卡结束再按你在来源里的做法定：
 * 代你发了的等撤回窗口过去；别的等卡结束 settleMs 以后，看你在来源里回没回。还不能定时是 null。
 */
export function settledReplyLabel(facts: ReplySampleFacts): ChannelReplyLabel | null {
  const { card } = facts;
  if (facts.decision === "auto_send" && card.autoReplied) {
    return card.revokeUntil !== null && facts.now >= card.revokeUntil ? "auto_kept" : null;
  }
  if (card.open) return null;
  if (card.userSent) return "rewritten";
  if (facts.now < (card.resolvedAt ?? facts.scoredAt) + facts.settleMs) return null;
  return facts.selfReplies > 0 ? "rewritten" : "no_action";
}
