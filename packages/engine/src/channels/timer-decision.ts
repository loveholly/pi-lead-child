// 外部的人要求设定时器时怎么判断（统一的消息事件 spec D16，工单 12；用户 2026-10-27：「能不能不要全是写死的规则……
// 这不是可以通过我们的决策模型算法来决定吗」）。纯函数，不读库、不调模型。
//
// 危险的不是「设定时器」这个动作，而是到点以后要做什么、是谁要求的。所以按决策模型算，不按工具清单拦：
//   1. 底线（拒绝，写明原因）：对方在要求改规则（Jev 的标记，工单 08）：到点的那一轮不能改系统的规则（spec D10）；
//      授权表判这条消息要代你拒绝（涉密）或者只记录。
//   2. 授权表的权限上限（Jev 的意图，入站时算好的）：只提醒你的定时器是延后的「告诉你」，在任何上限里；到点要对外做事的，
//      要授权表让代你做事（work）才行，不然问你。外部客户的底线不变：问你。
//   3. 信心模型的代价轴（confidence-model.ts 的 confidenceCostOf）：受众是到点时的受众（只提醒你时算 1 对 1），加上
//      「延后执行」「到点后要对外做事」两个通用的因素，和发信人、话题一样加档。不超过 TIMER_SET_MAX_LEVEL 就设，并告诉你；
//      超过就问你。
// 结论只是设不设：到点的那一轮还是按外部的一轮算（改规则被拒，对外的话走出站扩展），那才是底线的代码检查。
// 这里不出现任何具体来源的名字，也不按任务类型分支。
import {
  CHANNEL_INTENT_LABELS, CHANNEL_RULE_CHANGE_FLAG, CHANNEL_RULE_CHANGE_LABELS, NEVER_DELEGATED_TRUST, isChannelIntent,
  type MessageCeiling, type MessageInbound, type SenderTrust, type TimerDecisionKind,
} from "@pi-lead-child/protocol";
import {
  CONFIDENCE_MODEL_DEFAULTS, confidenceCostOf,
  type ConfidenceAudience, type ConfidenceModelParams, type ConfidenceModelResult, type CostTopic,
} from "./confidence-model.js";

/**
 * 不问你就设的最高代价档：「中」（2）。只提醒你的定时器是 1 对 1（1 档）加延后执行（1 档）；再多一档（发信人认不出、
 * 话题沾钱或人事、到点要对外做事）就问你。定时器没有草稿可打分，所以按代价档判断，不按信心。
 */
export const TIMER_SET_MAX_LEVEL = 2;

// 授权表的结论（MessageCeiling.authority）在给人看的话里怎么说。
const AUTHORITY_WORDS: Record<string, string> = {
  work: "要干活", ask: "问你", tell: "告诉你", remind: "提醒你", refuse: "代你拒绝", skip: "只记录", react: "回表情",
  closing_reply: "收尾时代你说一句",
};

export interface TimerRequestInput {
  // 要求设定时器的那条外部消息的前置处理结论和权限上限（消息事件，工单 03）。说不出是哪条消息时（例如这一轮读了外部对话）是 null。
  inbound: MessageInbound | null;
  ceiling: MessageCeiling | null;
  // 发信人的信任级别。说不出是谁时是 unknown。
  sender: { trust: SenderTrust };
  // 请求 A 的分数：话题、认对方要什么的把握。没问到时是 null（按「话题没问到」加档）。
  scores: { topics: Readonly<Partial<Record<CostTopic, number>>>; askConfidence: number | null } | null;
  // 到点后要对外做事：在哪种对话里、多少人。只提醒你时是 null。
  outward: { audience: ConfidenceAudience; members: number | null } | null;
  // 这个来源带标签的样本有多少（冷启动按它算）。
  calibration: { samples: number };
}

export interface TimerDecision {
  decision: TimerDecisionKind;
  cost: ConfidenceModelResult["cost"];
  // 给人看的几句话：为什么设、为什么问你、为什么不设。
  reasons: string[];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** 外部的人要求设一个定时器：设并告诉你、问你（确认卡）、还是碰到底线不设。纯函数。 */
export function decideTimerRequest(input: TimerRequestInput, params: ConfidenceModelParams = CONFIDENCE_MODEL_DEFAULTS): TimerDecision {
  const intent = input.inbound?.intent && isChannelIntent(input.inbound.intent) ? input.inbound.intent : null;
  const ruleChange = input.inbound?.ruleChange ?? null;
  const flagged = ruleChange !== null && ruleChange >= CHANNEL_RULE_CHANGE_FLAG;
  const outward = input.outward;
  const cost = confidenceCostOf({
    intent: intent ? { kind: intent, closing: null } : null,
    facts: {
      audience: outward?.audience ?? "dm", members: outward?.members ?? null, retractable: true, senderTrust: input.sender.trust,
      deferred: true, outwardLater: outward !== null,
    },
    scores: { topics: input.scores?.topics ?? {}, draftCommits: null, draftOvershares: null, ruleChange: flagged ? ruleChange : null },
    calibration: input.calibration,
  }, params);
  // 只提醒你：受众就是你一个人。
  if (!outward) cost.steps[0] = { ...cost.steps[0]!, detail: "到点只提醒你，不对外" };

  // 1. 底线。
  if (flagged) {
    const kinds = (input.inbound?.ruleChangeKinds ?? []).map((kind) => CHANNEL_RULE_CHANGE_LABELS[kind]).join("、") || "系统的规则";
    return {
      decision: "refuse", cost,
      reasons: [`对方在要求改规则（${kinds}，${pct(ruleChange!)}）：到点的那一轮不能改系统的规则，这是底线，不设`],
    };
  }
  const authority = input.ceiling?.authority ?? null;
  if (authority === "refuse" || authority === "skip") {
    return { decision: "refuse", cost, reasons: [`授权表对这条消息是「${AUTHORITY_WORDS[authority]}」：不替对方设定时器`] };
  }

  // 2. 权限上限和外部客户。3. 代价。
  const asks: string[] = [];
  if (NEVER_DELEGATED_TRUST.includes(input.sender.trust)) asks.push("底线：发信人是外部客户，不替他设定时器，问你");
  if (outward && authority !== "work") {
    const ceiling = authority === null ? "这一轮说不出是哪条消息，没有权限上限"
      : `这条消息的权限上限是「${AUTHORITY_WORDS[authority] ?? authority}」${intent ? `（${CHANNEL_INTENT_LABELS[intent]}）` : ""}`;
    asks.push(`到点要替你对外做事，授权表没让代你做：${ceiling}`);
  }
  // 每一档为什么在 cost.steps 里（卡上的「代价」一行），这里只写结论。
  if (cost.level > TIMER_SET_MAX_LEVEL) asks.push(`代价在第 ${cost.level} 档（${cost.name}），高于不问你就设的第 ${TIMER_SET_MAX_LEVEL} 档`);
  if (asks.length) return { decision: "confirm", cost, reasons: asks };
  const what = outward ? "到点在授权表允许的范围里替你做事" : "到点只提醒你、撤得回、不对外";
  return { decision: "set", cost, reasons: [`代价在第 ${cost.level} 档（${cost.name}）：${what}，设了，告诉你一声`] };
}
