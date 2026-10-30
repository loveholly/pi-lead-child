// 不能代回时怎样投递给用户（Lead 事件主干 spec D10，工单 11）：纯函数。
//
// 四种投递：推送加会话卡、会话卡、摘要、只记录。按来源的常设指令 channel.delivery，依次看 pushWhen、cardWhen、
// digestWhen，取第一个匹配的；都不匹配时只记录。pushWhen 是这个来源的打断阈值：外部来源永远不插进 Lead 正在进行的回合
// （硬性规则，lead-input 的 busyPlacement），它的紧急程度只影响这里的投递方式。
// 来源没有这条指令时，进摘要：消息不丢，也不打扰用户。
import {
  matchesStandingOrderCondition,
  type ChannelDeliveryMode, type ConditionSubject, type StandingOrderCondition, type StandingOrderRef,
} from "@pi-lead-child/protocol";

export interface ChannelDeliveryPolicyInput {
  pushWhen: StandingOrderCondition | null;
  cardWhen: StandingOrderCondition | null;
  digestWhen: StandingOrderCondition | null;
  order: StandingOrderRef;
}

export interface ChannelDeliveryDecision {
  mode: ChannelDeliveryMode;
  // 哪一档的条件匹配了；default 是来源没有投递指令时的缺省。
  matched: "pushWhen" | "cardWhen" | "digestWhen" | "none" | "default";
  order: StandingOrderRef | null;
}

/** 一件事怎样投递。subject 是事件的 { source, kind, entityKey, payload }。 */
export function channelDeliveryDecision(policy: ChannelDeliveryPolicyInput | null, subject: ConditionSubject): ChannelDeliveryDecision {
  if (!policy) return { mode: "digest", matched: "default", order: null };
  const tiers: Array<[ChannelDeliveryDecision["matched"], StandingOrderCondition | null, ChannelDeliveryMode]> = [
    ["pushWhen", policy.pushWhen, "push_card"],
    ["cardWhen", policy.cardWhen, "card"],
    ["digestWhen", policy.digestWhen, "digest"],
  ];
  for (const [matched, condition, mode] of tiers) {
    if (condition && matchesStandingOrderCondition(condition, subject)) return { mode, matched, order: policy.order };
  }
  return { mode: "record", matched: "none", order: policy.order };
}
