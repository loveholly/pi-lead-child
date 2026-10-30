// 信心计算模型（设计见 .scratch/confidence-model/design.md）：纯函数，不读库、不调模型。
// 落地计划 A6（2026-10-22）接进了 hub：代查结束以后、收尾时代你说一句以前，hub 用它决定代你回还是问你
// （reply-decision.ts 把结论写成卡上显示的检查和否决项）。前面几步（不打扰、回表情、拒绝、提醒、收尾）调授权表（authority.ts）。
//
// 两条轴：
//   - 信心：用户会不会照发这条草稿。必要维度（要回、做到）相乘（不互相补偿），再乘代码量出来的事实和次要因素（有据、理解），
//     最后按用户在卡上的选择校准。
//   - 代价：错了有多糟。受众定基础档，撤不回、发信人、话题、承诺、多说、对方在要求改规则、延后执行、到点后要对外做事各加档，
//     冷启动再加一档。
//     每一档有一个门槛。授权表可以给一个意图更低的最低信心（例如 review、approve 的 35%），门槛取两者中低的。
//     例外（用户 2026-10-27，统一消息事件工单 08）：请求 A 判断对方在要求改规则时，门槛按代价档位算，不用授权表的最低信心。
// 结论：机器人发的、多半不用回的，不打扰（只记录）；前提不满足或者碰了底线就问用户；信心不低于这一档的门槛就自动发；
// 没查到、失败、没有草稿就交给用户。
// 第二版（用户 2026-10-21：15 个真实用例全部问他，这东西就没用了；看个 PR 不该问）：加「不打扰」；「有据」降成次要因素；
// 门槛按错发的代价比较小重定；冷启动不再加档；承诺、多说到 0.4 才加档；出处按比例扣分；没有 Jev 时一律问。
// 第三版（用户 2026-10-22 定的原则）：模型前面加一张授权表，按对方的意图写清楚能替用户做什么——代码 review 和 approve、
// 业务和技术咨询、项目进度可以代查代回；结尾回一句客套或者回个表情；会议邀约和提醒只提醒用户；涉密的直接拒绝；别的问用户。
// 授权表是用户给的授权，按意图写；信心公式不按意图分支（用户 2026-10-21：不为某一种任务单独写信心的题或公式）。
// 这里不出现任何具体来源的名字。
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_CLOSING_KINDS, CHANNEL_INTENT_LABELS, CHANNEL_INTENTS, CHANNEL_RULE_CHANGE_FLAG, CHANNEL_WORK_INTENTS,
  NEVER_DELEGATED_TRUST, SENDER_TRUST_LABELS,
  type ChannelAuthorityTable, type ChannelClosingKind, type ChannelIntent, type SenderTrust,
} from "@pi-lead-child/protocol";
import { decideChannelAuthority } from "./authority.js";
import { replyConfidenceBucket } from "./reply-gate.js";

/**
 * 结论：auto_send 代你回复（review 就是发评论再回一句）；approve 批准 PR 并回复；react 在对方的消息上回表情；
 * remind 不回，提醒你；refuse 用固定的话代你拒绝；ask_user 卡上问你；hand_over 交给你（查不到可靠结论）；skip 不打扰。
 */
export const CONFIDENCE_DECISIONS = ["auto_send", "approve", "react", "remind", "refuse", "ask_user", "hand_over", "skip"] as const;
export type ConfidenceDecision = typeof CONFIDENCE_DECISIONS[number];

// 对方的意图和收尾的种类：定义在 protocol 的 channel-policy.ts（请求 A、授权表、界面都用同一份）。
export const CONFIDENCE_INTENTS = CHANNEL_INTENTS;
export type ConfidenceIntent = ChannelIntent;
export const CONFIDENCE_INTENT_LABELS = CHANNEL_INTENT_LABELS;
/** 要查、要回内容的意图：要有代查的结果和核实过的出处。 */
export const REQUEST_INTENTS: readonly ConfidenceIntent[] = CHANNEL_WORK_INTENTS;
// 附和和告别分开（2026-10-22）：对一句附和代你发文字太多了，回个表情就够；告别在私信里通常要回一句。
export const CLOSING_KINDS = CHANNEL_CLOSING_KINDS;
export type ClosingKind = ChannelClosingKind;

/** 回复会被谁看到：1 对 1 私信、群聊、私有频道、公开频道。外部共享的对话是底线，不在这里。 */
export const CONFIDENCE_AUDIENCES = ["dm", "group_dm", "private_channel", "public_channel"] as const;
export type ConfidenceAudience = typeof CONFIDENCE_AUDIENCES[number];

/**
 * 必要维度：缺一不可，相乘。权重以后按用户的选择拟合。
 * 「有据」不在这里：2026-10-21 用 Jev 实测，它分不开用户的选择（照发的 2%–31%，没发的 12%–50%），
 * 分数还取决于给请求 B 看了多少材料（同一个 review 从 28% 到 63%）。它做次要因素。
 */
export const NECESSARY_DIMENSIONS = ["needs_reply", "fulfills"] as const;
export type NecessaryDimension = typeof NECESSARY_DIMENSIONS[number];

export const NECESSARY_LABELS: Record<NecessaryDimension, string> = {
  needs_reply: "要回",
  fulfills: "做到",
};

/** 加代价档的话题（请求 A）。不含 commitment：对方的请求沾承诺不算，只看草稿（draft_commits）。 */
export const COST_TOPICS = ["money", "personnel", "legal", "emotional"] as const;
export type CostTopic = typeof COST_TOPICS[number];
const COST_TOPIC_LABELS: Record<CostTopic, string> = { money: "钱", personnel: "人事", legal: "法律", emotional: "情绪" };

/** 底线（锁定维度）：不参加权重拟合，Lead 改不了。 */
export const CONFIDENCE_LOCKS = ["customer", "external_shared", "sensitive_query", "draft_commits", "draft_overshares"] as const;
export type ConfidenceLock = typeof CONFIDENCE_LOCKS[number];

export const CONFIDENCE_LOCK_LABELS: Record<ConfidenceLock, string> = {
  customer: "外部客户",
  external_shared: "外部共享的对话",
  sensitive_query: "敏感查询",
  draft_commits: "替你承诺",
  draft_overshares: "多说或泄露",
};

/** 概率型底线的线：不低于它就锁定（hard 模式）。 */
export const CONFIDENCE_LOCK_LIMIT = 0.5;
/**
 * 话题的概率高于它加一档，不低于 CONFIDENCE_LOCK_LIMIT 加两档。严格大于：没有 Jev 时 LLM 兜底说「不涉及」的概率固定是 0.2，
 * 不能算涉及（和退役的代回闸门一样）。
 */
export const CONFIDENCE_COST_STEP = 0.2;
/**
 * 草稿的承诺、多说不低于它加一档（不低于 CONFIDENCE_LOCK_LIMIT 是底线）。比话题高：Jev 对没问题的草稿也常给 10%–37%
 * （2026-10-21 实测：只留评论的 review 承诺 12%–24%、多说 32%–37%）。
 */
export const CONFIDENCE_DRAFT_RISK_STEP = 0.4;

export const CONFIDENCE_TIER_NAMES = ["", "低", "中", "高", "很高", "最高"] as const;

// 「对方在要求改规则」这一档（请求 A 的 rule_change，工单 08）。带这一档时门槛按代价档位算（用户 2026-10-27 选的选项 1）。
const RULE_CHANGE_STEP = "rule_change";
const RULE_CHANGE_BAR = "门槛按代价档位算，不用授权表的最低信心";

/**
 * 调节参数（2026-10-23，信心模型面板）：以前写死在公式里的几个数。缺省值就是原来的常量，不给时行为完全不变。
 *   topicStep、draftRiskStep：话题、草稿的承诺和多说从多少开始加档（CONFIDENCE_COST_STEP、CONFIDENCE_DRAFT_RISK_STEP）；
 *   verifiedFloor：出处全部核实不过时乘多少；groundedFloor、understoodFloor：「有据」「理解」最低乘多少（分数是 0 时）。
 */
export interface ConfidenceTuning {
  topicStep: number;
  draftRiskStep: number;
  verifiedFloor: number;
  groundedFloor: number;
  understoodFloor: number;
}

export const CONFIDENCE_TUNING_DEFAULTS: ConfidenceTuning = {
  topicStep: CONFIDENCE_COST_STEP,
  draftRiskStep: CONFIDENCE_DRAFT_RISK_STEP,
  verifiedFloor: 0.2,
  groundedFloor: 0.6,
  understoodFloor: 0.9,
};

export interface ConfidenceModelParams {
  // 这个来源打开了自动代回。
  autoReply: boolean;
  // 要回的概率低于它、又不是请人代查的消息，不打扰（和 hub 的 noReplyBelow 一样）。
  noReplyBelow: number;
  // 必要维度的指数。先验都是 0.5：两项是同一个模型对同一段文字的回答，彼此相关，指数 1 会重复扣分。
  weights: Readonly<Record<NecessaryDimension, number>>;
  // 第 1 到 4 档的门槛（下标 0 不用）。第 5 档和以上不自动发。
  tierThresholds: readonly [number, number, number, number, number];
  // 带标签的样本少于它时是冷启动。
  coldStartSamples: number;
  // 冷启动时代价加几档。缺省 0：安全靠撤回窗口、底线和抽查，不靠多问。
  coldStartTiers: number;
  // 校准时先验分数顶几个样本。
  priorStrength: number;
  maxResultAgeMs: number;
  // hard：底线命中就锁定（我们的提议）。weighted：底线的概率乘进信心，(1 - p) ^ lockWeight（用户的提议）。
  // 接进闸门时这一项是代码里的常量，不是常设指令的参数。
  lockMode: "hard" | "weighted";
  lockWeight: number;
  // 授权表（常设指令 channel.authority）：按意图写能替你做什么。收紧 Lead 可以改，放开要你批准。
  authority: ChannelAuthorityTable;
  // 调节参数。不给或者缺一项时用 CONFIDENCE_TUNING_DEFAULTS。
  tuning?: Partial<ConfidenceTuning>;
}

/** 授权表的缺省（protocol 的 CHANNEL_AUTHORITY_DEFAULTS）。 */
export const CONFIDENCE_AUTHORITY_DEFAULTS = CHANNEL_AUTHORITY_DEFAULTS;

// 门槛 t 和代价 K 的关系：错发一次的损失是对发一次的收益的 K 倍时，t = K / (K + 1)。
//   L1 0.60（K=1.5）、L2 0.75（K=3）、L3 0.90（K=9）、L4 0.95（K=19）。
//   私信里错发一次带署名、能撤回、对方知道是助手，坏处和对发一两次的好处差不多。
export const CONFIDENCE_MODEL_DEFAULTS: ConfidenceModelParams = {
  autoReply: true,
  noReplyBelow: 0.3,
  weights: { needs_reply: 0.5, fulfills: 0.5 },
  tierThresholds: [1, 0.6, 0.75, 0.9, 0.95],
  coldStartSamples: 20,
  coldStartTiers: 0,
  priorStrength: 10,
  maxResultAgeMs: 30 * 60_000,
  lockMode: "hard",
  lockWeight: 4,
  authority: CONFIDENCE_AUTHORITY_DEFAULTS,
};

export interface ConfidenceModelInput {
  // 对方的意图。null：还没判断（按 other）。
  intent: { kind: ConfidenceIntent; closing: ClosingKind | null } | null;
  // 授权表已经在入站算过（统一消息事件 spec D3、D9，工单 05）：Lead 在事件轮里写的回复，授权表的结论是这条消息事件的权限上限，
  // Lead 在上限里做事。出站只看信心：证据、回复检查、校准，加上底线和代价，不再按意图跑一遍授权表（第 1–6 步和「授权表没让代你回」）。
  // 意图仍然参与第 7 步：要查、要回内容的请求没有代查过就交给你。
  authorityAtInbound?: boolean;
  // 有没有要发的草稿。
  draft: boolean;
  // 代查的结果。不用代查的草稿（模板、Lead 起草的）是 not_needed。
  found: "yes" | "partial" | "no" | "failed" | "not_needed";
  // 模型打的分（Jev 的概率）。没问到时是 null。
  scores: {
    needsReply: number | null; // 请求 A needs_reply
    askConfidence: number | null; // 请求 A ask_kind 的置信度
    fulfills: number | null; // 请求 B fulfills_request
    grounded: number | null; // 请求 B grounded
    draftCommits: number | null; // 请求 B draft_commits
    draftOvershares: number | null; // 请求 B draft_overshares
    topics: Readonly<Partial<Record<CostTopic, number>>>; // 请求 A 的话题，缺的按没问到
    sensitiveQueries: Readonly<Record<string, number>> | null; // 请求 A 的 6 个敏感查询，null 是没问到
    // 请求 A rule_change：对方在要求改助手或系统的规则的概率（统一消息事件 spec D10 的 Jev 标记，工单 08）。没问到、
    // 第 6 版以前的判断是 null 或者没有。
    ruleChange?: number | null;
  };
  // 代码量出来的事实。
  facts: {
    audience: ConfidenceAudience;
    // 频道的人数。问不到时是 null。
    members: number | null;
    // null：问不到，按外部共享对待。
    externalShared: boolean | null;
    senderTrust: SenderTrust;
    // 发信人是机器人或应用。
    bot: boolean;
    // 分数是谁打的：jev，或者没有 Jev 时 LLM 兜底的固定值（fallback）。
    scoredBy: "jev" | "fallback";
    // 要发的东西都能撤回吗。回复和评论能改能删，算能撤回；approve、merge 撤不回（它们本身是承诺，走底线）。
    retractable: boolean;
    // 要做的事不是现在做，而是到点才做（例如定时器，统一消息事件 spec D16）：那时用户可能不在，情况也可能变了。没有时不加档。
    deferred?: boolean;
    // 到点以后要替用户在外部对话里发言或做事（不只是提醒用户）。受众是到点时那个对话的受众。没有时不加档。
    outwardLater?: boolean;
    canReply: boolean;
    // 出处核实：核实通过的和全部的。
    sources: { total: number; verified: number };
    // 查完以后，道里又来了几条消息。
    newerMessages: number;
    resultAgeMs: number;
    cardOpen: boolean;
    // 请你 approve 时，代码查 PR 得到的事实（GitHub）。null：没查。
    approval: {
      checksPassed: boolean | null; // 检查都通过了
      threadsResolved: boolean | null; // review 的评论都 resolve 了
      isDraft: boolean | null; // PR 是 draft
      headUnchanged: boolean | null; // 现在的提交就是 review 过的那一个
      blockingFindings: number | null; // 自己的 review 找到的要改的问题
    } | null;
  };
  // 你对打过分的草稿实际做了什么（不分任务，按标签的权重加起来，calibration.ts）。buckets 是各分数段的样本，按 0.1 分段。
  calibration: {
    samples: number;
    buckets: ReadonlyArray<{ bucket: number; samples: number; agreed: number }>;
  };
}

export interface ConfidenceFactor {
  id: string;
  label: string;
  kind: "necessary" | "fact" | "secondary" | "lock";
  // 原始的分数（概率）或者事实的值。
  value: number | null;
  // 必要维度的指数；别的是 null。
  weight: number | null;
  // 乘进信心的倍数。
  factor: number;
  // 对信心的贡献，百分点。负数是扣分。各项加起来等于 原始信心 - 100。
  points: number;
  detail: string;
}

export interface ConfidenceCostStep {
  id: string;
  label: string;
  levels: number;
  detail: string;
}

export interface ConfidenceLockCheck {
  id: ConfidenceLock;
  label: string;
  value: number | null;
  hit: boolean;
  detail: string;
}

export interface ConfidenceModelResult {
  decision: ConfidenceDecision;
  // 校准以前的信心。缺必要维度时是 null。
  raw: number | null;
  // 最终信心（校准以后）。
  confidence: number | null;
  // 这一档的门槛。null：最高档，不自动发。
  threshold: number | null;
  cost: { base: number; level: number; name: string; coldStart: boolean; steps: ConfidenceCostStep[] };
  factors: ConfidenceFactor[];
  calibration: { bucket: number; samples: number; agreed: number; points: number } | null;
  locks: ConfidenceLockCheck[];
  preconditions: string[];
  reasons: string[];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
// 下限到 1 的距离。取到 9 位小数：1 - 0.9 在浮点里不是 0.1，缺省时要和原来的公式一模一样。
const span = (floor: number) => Math.round((1 - floor) * 1e9) / 1e9;
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function audienceBase(audience: ConfidenceAudience, members: number | null): { level: number; detail: string } {
  if (audience === "dm") return { level: 1, detail: "1 对 1 私信" };
  if (audience === "group_dm") return { level: 2, detail: "群聊" };
  if (audience === "private_channel") return { level: 2, detail: "私有频道" };
  if (members === null) return { level: 3, detail: "公开频道（人数不知道）" };
  if (members <= 50) return { level: 2, detail: `公开频道（${members} 人）` };
  if (members <= 500) return { level: 3, detail: `公开频道（${members} 人）` };
  return { level: 4, detail: `公开频道（${members} 人）` };
}

/** 代价轴要的输入：信心模型的输入里算代价的那几项。 */
export interface ConfidenceCostInput {
  intent: ConfidenceModelInput["intent"];
  facts: Pick<ConfidenceModelInput["facts"], "audience" | "members" | "retractable" | "senderTrust" | "deferred" | "outwardLater">;
  scores: Pick<ConfidenceModelInput["scores"], "topics" | "draftCommits" | "draftOvershares" | "ruleChange">;
  calibration: Pick<ConfidenceModelInput["calibration"], "samples">;
}

/**
 * 代价轴（纯函数）：错了有多糟，几档，每一档为什么。信心模型和别的决策（例如外部的人要求设定时器，timer-decision.ts）
 * 用同一份：不为某一种事单独写代价的公式。
 */
export function confidenceCostOf(input: ConfidenceCostInput, params: ConfidenceModelParams = CONFIDENCE_MODEL_DEFAULTS): ConfidenceModelResult["cost"] {
  return costOf(input, params);
}

function costOf(input: ConfidenceCostInput, params: ConfidenceModelParams): ConfidenceModelResult["cost"] {
  const { facts, scores } = input;
  const tuning = { ...CONFIDENCE_TUNING_DEFAULTS, ...params.tuning };
  const base = audienceBase(facts.audience, facts.members);
  const steps: ConfidenceCostStep[] = [{ id: "audience", label: "受众", levels: base.level, detail: base.detail }];
  if (!facts.retractable) steps.push({ id: "retract", label: "撤不回", levels: 1, detail: "要发的东西有撤不回的（例如 PR 上的 review）" });
  if (facts.senderTrust === "unknown" || facts.senderTrust === "external") {
    steps.push({ id: "sender", label: "发信人", levels: 1, detail: `发信人是${SENDER_TRUST_LABELS[facts.senderTrust]}` });
  }
  const missing = COST_TOPICS.filter((topic) => !probability(scores.topics[topic]));
  if (missing.length) {
    steps.push({ id: "topic", label: "话题", levels: 2, detail: "话题没问到" });
  } else {
    const top = COST_TOPICS.reduce((best, topic) => scores.topics[topic]! > scores.topics[best]! ? topic : best);
    const value = scores.topics[top]!;
    const levels = value >= CONFIDENCE_LOCK_LIMIT ? 2 : value > tuning.topicStep ? 1 : 0;
    if (levels) steps.push({ id: "topic", label: "话题", levels, detail: `可能涉及${COST_TOPIC_LABELS[top]}（${pct(value)}）` });
  }
  for (const [id, label, value] of [
    ["commits", "承诺", scores.draftCommits], ["overshares", "多说", scores.draftOvershares],
  ] as const) {
    if (probability(value) && value >= tuning.draftRiskStep) steps.push({ id, label, levels: 1, detail: `${label} ${pct(value)}` });
  }
  // 对方在要求改规则（用户 2026-10-27）：权限上限不在代码里收窄，这里加一档，门槛跟着变高，而且不用授权表的最低信心
  // （evaluateConfidenceModel）。外部的一轮改不了规则由动作层的代码检查保证（工单 07），这一档管的是代你回什么、做什么。
  // 延后执行、到点后要对外做事（统一消息事件 spec D16，工单 12）：和受众、撤不撤得回一样各加一档，不分是什么事。
  if (facts.deferred) steps.push({ id: "deferred", label: "延后执行", levels: 1, detail: "到点才做：那时你可能不在，情况也可能变了" });
  if (facts.outwardLater) {
    steps.push({ id: "outward_later", label: "到点后要对外做事", levels: 1, detail: "到点以后要替你在外部对话里发言或做事，不只是提醒你" });
  }
  const ruleChange = probability(scores.ruleChange) && scores.ruleChange >= CHANNEL_RULE_CHANGE_FLAG ? scores.ruleChange : null;
  if (ruleChange !== null) {
    steps.push({ id: RULE_CHANGE_STEP, label: "改规则", levels: 1, detail: `对方在要求改规则（${pct(ruleChange)}）` });
  }
  const coldStart = input.calibration.samples < params.coldStartSamples;
  if (coldStart && params.coldStartTiers > 0) {
    steps.push({ id: "cold_start", label: "冷启动", levels: params.coldStartTiers, detail: `样本 ${input.calibration.samples}/${params.coldStartSamples}` });
  }
  const level = steps.reduce((sum, step) => sum + step.levels, 0);
  // 授权表的最低信心本来会把门槛压低：卡上写明这次不用它。
  const minimum = params.authority[input.intent?.kind ?? "other"].minConfidence;
  const rule = steps.find((step) => step.id === RULE_CHANGE_STEP);
  if (rule && level < 5 && minimum !== undefined && minimum < params.tierThresholds[level]!) rule.detail += `，${RULE_CHANGE_BAR}`;
  return { base: base.level, level, name: CONFIDENCE_TIER_NAMES[Math.min(level, 5)]!, coldStart, steps };
}

function locksOf(input: ConfidenceModelInput): ConfidenceLockCheck[] {
  const { facts, scores } = input;
  const queries = scores.sensitiveQueries;
  const queryValues = queries ? Object.entries(queries).filter(([, value]) => probability(value)) : [];
  const topQuery = queryValues.reduce<[string, number] | null>((best, entry) => !best || entry[1] > best[1] ? entry : best, null);
  // 没问到的按命中：底线宁可错拦。
  const sensitive = queries === null || topQuery === null ? 1 : topQuery[1];
  const customer = NEVER_DELEGATED_TRUST.includes(facts.senderTrust) ? 1 : 0;
  const external = facts.externalShared === false ? 0 : 1;
  const commits = probability(scores.draftCommits) ? scores.draftCommits : 1;
  const overshares = probability(scores.draftOvershares) ? scores.draftOvershares : 1;
  const entries: Array<[ConfidenceLock, number, string]> = [
    ["customer", customer, customer ? "发信人是外部客户" : "不是外部客户"],
    ["external_shared", external, facts.externalShared === null ? "问不到是不是外部共享" : external ? "和外部组织共享" : "没有和外部组织共享"],
    ["sensitive_query", sensitive, queries === null ? "敏感查询没问到" : topQuery ? `最高 ${topQuery[0]} ${pct(topQuery[1])}` : "敏感查询没有回答"],
    ["draft_commits", commits, probability(scores.draftCommits) ? pct(commits) : "没问到"],
    ["draft_overshares", overshares, probability(scores.draftOvershares) ? pct(overshares) : "没问到"],
  ];
  return entries.map(([id, value, detail]) => ({
    id, label: CONFIDENCE_LOCK_LABELS[id], value, hit: value >= CONFIDENCE_LOCK_LIMIT, detail,
  }));
}

// 各项的贡献：把 1 - 原始信心 按各项倍数的对数分给它们。和乘的顺序无关，加起来正好等于总的扣分。
function attribute(factors: Array<Omit<ConfidenceFactor, "points">>, raw: number): ConfidenceFactor[] {
  const logs = factors.map((factor) => Math.log(Math.max(factor.factor, 1e-9)));
  const total = logs.reduce((sum, value) => sum + value, 0);
  return factors.map((factor, index) => ({
    ...factor,
    points: total === 0 ? 0 : -(1 - raw) * 100 * (logs[index]! / total),
  }));
}

/** 信心计算模型。纯函数。 */
export function evaluateConfidenceModel(input: ConfidenceModelInput, params: ConfidenceModelParams = CONFIDENCE_MODEL_DEFAULTS): ConfidenceModelResult {
  const { scores, facts } = input;
  const tuning = { ...CONFIDENCE_TUNING_DEFAULTS, ...params.tuning };
  const cost = costOf(input, params);
  const locks = locksOf(input);
  const threshold = cost.level >= 5 ? null : params.tierThresholds[cost.level]!;

  // 信心的各项。
  const draft: Array<Omit<ConfidenceFactor, "points">> = [];
  // 对方明确请你做事（请求 A 认出是代查、review 一类的请求）时，「要回」至少是认出这个意图的把握：
  // 2026-10-22 实测，只发一个 PR 链接时 needs_reply 只有 28%，可是对方就是在请你 review。
  const requestedKind = input.intent?.kind ?? "other";
  const requested = REQUEST_INTENTS.includes(requestedKind) && probability(scores.askConfidence)
    && (!probability(scores.needsReply) || scores.askConfidence > scores.needsReply);
  const values: Record<NecessaryDimension, number | null> = {
    needs_reply: requested ? scores.askConfidence : scores.needsReply, fulfills: scores.fulfills,
  };
  const missing: NecessaryDimension[] = [];
  for (const dimension of NECESSARY_DIMENSIONS) {
    const value = values[dimension];
    const weight = params.weights[dimension];
    if (!probability(value)) {
      missing.push(dimension);
      continue;
    }
    draft.push({
      id: dimension, label: NECESSARY_LABELS[dimension], kind: "necessary", value, weight,
      factor: Math.pow(value, weight),
      detail: `${pct(value)}${dimension === "needs_reply" && requested ? "（对方明确请你做事）" : ""}${weight === 1 ? "" : `，指数 ${weight}`}`,
    });
  }
  // 核实不过的出处可能是编的，也可能只是空白、换行对不上：按核实通过的比例扣分，全错时乘 verifiedFloor（缺省 0.2）。
  const unverified = facts.sources.total - facts.sources.verified;
  const share = facts.sources.total ? facts.sources.verified / facts.sources.total : 1;
  draft.push({
    id: "verified", label: "核实", kind: "fact", value: unverified, weight: null,
    factor: tuning.verifiedFloor + span(tuning.verifiedFloor) * share * share,
    detail: unverified > 0 ? `${facts.sources.total} 处出处，${unverified} 处核实不过（可能是编的）`
      : facts.sources.total ? `${facts.sources.total} 处出处都核实通过` : "没有引用出处",
  });
  const grounded = probability(scores.grounded) ? scores.grounded : 0;
  draft.push({
    id: "grounded", label: "有据", kind: "secondary", value: probability(scores.grounded) ? grounded : null, weight: null,
    factor: tuning.groundedFloor + span(tuning.groundedFloor) * grounded, detail: probability(scores.grounded) ? `请求 B ${pct(grounded)}` : "没问到",
  });
  const understood = probability(scores.askConfidence) ? scores.askConfidence : 0;
  draft.push({
    id: "understood", label: "理解", kind: "secondary", value: probability(scores.askConfidence) ? understood : null, weight: null,
    factor: tuning.understoodFloor + span(tuning.understoodFloor) * understood, detail: probability(scores.askConfidence) ? `请求 A 认对方要什么 ${pct(understood)}` : "没问到",
  });
  if (input.found === "partial") {
    draft.push({ id: "partial", label: "只查到一部分", kind: "secondary", value: null, weight: null, factor: 0.9, detail: "found=partial" });
  }
  if (facts.sources.verified >= 2 && unverified === 0) {
    draft.push({ id: "corroborated", label: "多处互证", kind: "secondary", value: facts.sources.verified, weight: null, factor: 1.03, detail: `${facts.sources.verified} 处出处` });
  }
  if (params.lockMode === "weighted") {
    for (const lock of locks) {
      draft.push({
        id: `lock_${lock.id}`, label: lock.label, kind: "lock", value: lock.value, weight: params.lockWeight,
        factor: Math.pow(1 - lock.value!, params.lockWeight), detail: `(1 - ${pct(lock.value!)}) ^ ${params.lockWeight}`,
      });
    }
  }
  const product = draft.reduce((value, factor) => value * factor.factor, 1);
  const raw = missing.length ? null : clamp01(product);
  const factors = raw === null ? draft.map((factor) => ({ ...factor, points: 0 })) : attribute(draft, raw);

  // 校准：这一段的样本把先验分数拉向用户实际照发的比例。
  let confidence: number | null = null;
  let calibration: ConfidenceModelResult["calibration"] = null;
  if (raw !== null) {
    const bucket = replyConfidenceBucket(raw);
    const stats = input.calibration.buckets.find((entry) => Math.abs(entry.bucket - bucket) < 1e-9) ?? { samples: 0, agreed: 0 };
    confidence = (stats.agreed + params.priorStrength * raw) / (stats.samples + params.priorStrength);
    calibration = { bucket, samples: stats.samples, agreed: stats.agreed, points: (confidence - raw) * 100 };
  }

  const intent: ConfidenceIntent = input.intent?.kind ?? "other";
  const authority = params.authority[intent];
  const done = (decision: ConfidenceDecision, reasons: string[], preconditions: string[] = [], at: number | null = threshold) =>
    ({ decision, raw, confidence, threshold: at, cost, factors, calibration, locks, preconditions, reasons });

  // 1–6. 授权表（authority.ts）：不打扰、回表情、代你拒绝、提醒你、收尾、问你；要干活的往下算。
  // 授权表先看要不要回（spec D3），那是入站时定派不派活。这里活已经干了：要干活的意图查过了（found 不是 not_needed），
  // 有人请你查就不算不用回，「要不要回」不交给授权表。授权表已经在入站算过的（authorityAtInbound）跳过这几步。
  const lookedUp = REQUEST_INTENTS.includes(intent) && input.found !== "not_needed";
  const ruled: ReturnType<typeof decideChannelAuthority> = input.authorityAtInbound
    ? { kind: "work", intent, reason: "授权表已经在入站算过（这条消息的权限上限）" }
    : decideChannelAuthority({
      intent: input.intent?.kind ?? null, closing: input.intent?.closing ?? null, reaction: null,
      needsReply: lookedUp ? null : scores.needsReply, sensitive: scores.sensitiveQueries, sender: { trust: facts.senderTrust, bot: facts.bot },
      externalShared: facts.externalShared,
      audience: facts.audience === "dm" ? "direct" : facts.audience === "group_dm" ? "group" : "channel",
      capabilities: { reply: facts.canReply, react: true }, reactable: true, noReplyBelow: params.noReplyBelow,
    }, params.authority);
  if (ruled.kind === "skip") return done("skip", [ruled.reason]);
  // 自动代你处理关着（2026-10-23）：不代你做任何对外的事。回表情改成只记录，代你拒绝改成问你。
  if (ruled.kind === "react") return params.autoReply ? done("react", [ruled.reason]) : done("skip", ["自动代你处理关着：收尾的消息只记录"]);
  if (ruled.kind === "refuse") {
    return params.autoReply ? done("refuse", [`${ruled.reason}，并记进摘要`]) : done("ask_user", [`自动代你处理关着：${ruled.reason.replace(/，用固定的话拒绝$/, "")}，问你`]);
  }
  if (ruled.kind === "remind") return done("remind", [ruled.reason]);
  // 告诉你（对方在接着回答你）：不代你回，问你。这里没有给「你最近说过话」，正常算不到这一步。
  if (ruled.kind === "tell") return done("ask_user", [ruled.reason]);
  if (ruled.kind === "closing_reply") {
    // 收尾时代你说一句：现在不方便代你回的不打扰你；没有草稿的回个表情；草稿替你承诺或者多说了的问你。
    const quiet = !params.autoReply || !facts.canReply || !facts.cardOpen || facts.newerMessages > 0 || facts.scoredBy !== "jev";
    if (quiet) return done("skip", ["收尾的消息，现在不方便代你回，不打扰你"]);
    if (!input.draft) return done("react", ["收尾，没有草稿：回个表情"]);
    const risky = locks.filter((lock) => (lock.id === "draft_commits" || lock.id === "draft_overshares") && lock.hit);
    if (risky.length) return done("ask_user", risky.map((lock) => `底线：${lock.label}（${lock.detail}）`));
    return done("auto_send", [ruled.reason]);
  }
  // 授权表的「问你」（底线、没开放的意图、别的请求）：不是要干活的意图时，分数照算，卡上照样显示。
  if (ruled.kind === "ask" && !REQUEST_INTENTS.includes(intent)) return done("ask_user", [ruled.reason]);

  // 7. 要查、要回内容的请求：要查到完整的结论，并且至少有一处核实过的出处（review 的评论落在读过的行上也算）。
  if (REQUEST_INTENTS.includes(intent)) {
    const reason = input.found === "no" ? "没查到" : input.found === "failed" ? "代查失败"
      : input.found === "not_needed" ? "没有代查过" : input.found === "partial" ? "只查到一部分，不算可靠结论"
      : !input.draft ? "没有草稿" : facts.sources.verified < 1 ? "没有核实过的出处" : null;
    if (reason) return done("hand_over", [`${CONFIDENCE_INTENT_LABELS[intent]}：${reason}，交给你`], [reason]);
  } else if (!input.draft || input.found === "no" || input.found === "failed") {
    const reason = !input.draft ? "没有草稿" : input.found === "no" ? "没查到" : "代查失败";
    return done("hand_over", [reason], [reason]);
  }

  // 前提：不满足时不自动发，但分数照算，卡上照样显示。
  const preconditions: string[] = [];
  if (!params.autoReply) preconditions.push("这个来源没有打开自动代回");
  if (!facts.canReply) preconditions.push("这个来源不能回复");
  if (facts.scoredBy !== "jev") preconditions.push("没有 Jev，分数是兜底的固定值");
  if (!facts.cardOpen) preconditions.push("卡已经结束");
  if (facts.newerMessages > 0) preconditions.push(`查完以后又有 ${facts.newerMessages} 条新消息，要先重新判断`);
  if (facts.resultAgeMs > params.maxResultAgeMs) preconditions.push("结果太久了");

  const reasons = [...preconditions];
  if (authority.action !== "auto" && !input.authorityAtInbound) reasons.push(`${CONFIDENCE_INTENT_LABELS[intent]}：授权表没让代你回`);
  // review 和 approve 的动作由代码限定（只留评论；approve 要过事实那一关），「替你承诺」不拦它们。
  const structural = intent === "code_review" || intent === "approve";
  const hits = params.lockMode === "hard"
    ? locks.filter((lock) => lock.hit && !(structural && lock.id === "draft_commits")) : [];
  for (const lock of hits) reasons.push(`底线：${lock.label}（${lock.detail}）`);
  if (missing.length) reasons.push(`缺${missing.map((dimension) => NECESSARY_LABELS[dimension]).join("、")}的分数`);
  // 门槛：档位的门槛和授权表的最低信心取低的。对方在要求改规则时只按档位算（用户 2026-10-27 选的选项 1），别的档照旧。
  const ruleChange = cost.steps.some((step) => step.id === RULE_CHANGE_STEP);
  const bar = threshold === null ? null : ruleChange ? threshold : Math.min(threshold, authority.minConfidence ?? threshold);
  const floorSkipped = ruleChange && bar !== null && authority.minConfidence !== undefined && authority.minConfidence < bar;
  if (confidence !== null) {
    if (bar === null) {
      reasons.push(`代价在最高档（L${cost.level}），不自动发`);
    } else if (confidence < bar) {
      const worst = factors.filter((factor) => factor.points < 0).sort((a, b) => a.points - b.points)[0];
      reasons.push(`信心 ${pct(confidence)} 低于门槛 ${pct(bar)}`
        + (floorSkipped ? `（对方在要求改规则，${RULE_CHANGE_BAR}）` : "")
        + (worst ? `，扣分最多的是${worst.label}（${worst.detail}，${Math.round(worst.points)}）` : ""));
    }
  }
  if (reasons.length || confidence === null || bar === null || confidence < bar) return done("ask_user", reasons, preconditions, bar);

  // 8. approve：事实都过了才批准；有一项没过，问你（卡上写哪一项）。
  if (intent === "approve") {
    const facts2 = facts.approval;
    const gaps = !facts2 ? ["没查 PR 的状态"] : [
      facts2.checksPassed !== true && "检查没有都通过", facts2.threadsResolved !== true && "还有评论没 resolve",
      facts2.isDraft !== false && "PR 是 draft", facts2.headUnchanged !== true && "review 以后又有新的提交",
      facts2.blockingFindings !== 0 && "你的 review 找到了要改的问题",
    ].filter((gap): gap is string => typeof gap === "string");
    if (gaps.length) return done("ask_user", [`请你 approve，但${gaps.join("、")}`], preconditions, bar);
    return done("approve", [`检查都通过、评论都 resolve、review 没有要改的问题，信心 ${pct(confidence)}：批准并回复`], preconditions, bar);
  }
  return done("auto_send", [`${CONFIDENCE_INTENT_LABELS[intent]}：信心 ${pct(confidence)} 不低于门槛 ${pct(bar)}，没碰底线，代你回`], preconditions, bar);
}

// ── 校准：用用户在卡上的选择拟合必要维度的指数 ─────────────────────────────────────────

/** 用户的选择怎么算标签：照发算 1，改了再发、不回、自己回算 0，撤回算 0 并且顶 3 个样本，自动发了没撤回算 1 但只顶半个。 */
export const CONFIDENCE_LABELS: Readonly<Record<string, { label: 0 | 1; weight: number }>> = {
  send_draft: { label: 1, weight: 1 },
  post_review: { label: 1, weight: 1 },
  auto_kept: { label: 1, weight: 0.5 },
  send_edited: { label: 0, weight: 1 },
  reply_myself: { label: 0, weight: 1 },
  replied_in_source: { label: 0, weight: 1 },
  dismiss: { label: 0, weight: 1 },
  undo_auto_reply: { label: 0, weight: 3 },
};

export interface ConfidenceSample {
  values: Readonly<Record<NecessaryDimension, number>>;
  // 不参加拟合的各项（事实、次要因素）乘起来的倍数。
  rest: number;
  label: 0 | 1;
  weight?: number;
}

export interface ConfidenceFit {
  fitted: boolean;
  weights: Record<NecessaryDimension, number>;
  logLoss: number;
  brier: number;
  samples: number;
}

const predict = (sample: ConfidenceSample, weights: Readonly<Record<NecessaryDimension, number>>) =>
  Math.min(NECESSARY_DIMENSIONS.reduce((value, dimension) =>
    value * Math.pow(Math.max(sample.values[dimension], 1e-3), weights[dimension]), Math.max(sample.rest, 1e-3)), 1 - 1e-6);

function scoreFit(samples: readonly ConfidenceSample[], weights: Readonly<Record<NecessaryDimension, number>>) {
  let loss = 0;
  let brier = 0;
  let total = 0;
  for (const sample of samples) {
    const weight = sample.weight ?? 1;
    const q = predict(sample, weights);
    loss -= weight * (sample.label ? Math.log(q) : Math.log(1 - q));
    brier += weight * (q - sample.label) ** 2;
    total += weight;
  }
  return { logLoss: total ? loss / total : 0, brier: total ? brier / total : 0 };
}

/**
 * 拟合必要维度的指数：信心 = rest × Π 分数^指数，按样本的对数似然做投影梯度上升，指数夹在 [0.1, 3]
 * （大于 0 才不互相补偿），并向先验收缩。样本少于 minSamples 时不拟合，原样返回先验。底线不在这里。
 */
export function fitConfidenceWeights(
  samples: readonly ConfidenceSample[],
  prior: Readonly<Record<NecessaryDimension, number>> = CONFIDENCE_MODEL_DEFAULTS.weights,
  options: { minSamples?: number; iterations?: number; rate?: number; shrink?: number } = {},
): ConfidenceFit {
  const minSamples = options.minSamples ?? 50;
  const weights = { ...prior };
  if (samples.length < minSamples) return { fitted: false, weights, samples: samples.length, ...scoreFit(samples, weights) };
  const iterations = options.iterations ?? 3_000;
  const rate = options.rate ?? 0.5;
  const shrink = options.shrink ?? 0.01;
  const total = samples.reduce((sum, sample) => sum + (sample.weight ?? 1), 0);
  for (let step = 0; step < iterations; step++) {
    const gradient = Object.fromEntries(NECESSARY_DIMENSIONS.map((dimension) => [dimension, 0])) as Record<NecessaryDimension, number>;
    for (const sample of samples) {
      const q = predict(sample, weights);
      const slope = (sample.weight ?? 1) * (sample.label - q) / (1 - q);
      for (const dimension of NECESSARY_DIMENSIONS) gradient[dimension] += slope * Math.log(Math.max(sample.values[dimension], 1e-3));
    }
    for (const dimension of NECESSARY_DIMENSIONS) {
      const next = weights[dimension] + rate * (gradient[dimension] / total - shrink * (weights[dimension] - prior[dimension]));
      weights[dimension] = Math.min(Math.max(next, 0.1), 3);
    }
  }
  return { fitted: true, weights, samples: samples.length, ...scoreFit(samples, weights) };
}
