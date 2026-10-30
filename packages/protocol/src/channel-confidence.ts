// 信心模型的参数和「自动代你处理」面板的契约（2026-10-23，设置 → 消息通道，方案 C，.scratch/confidence-model/panel-design.md）。
//
// 参数存在常设指令 channel.authority 里（standing-orders.ts 的 STANDING_ORDER_RULE_PARAMS），和授权表一起，有版本和历史：
//   - autoReply：自动代你处理的开关。关着时通道不代你做任何对外的事（代你回复、approve、回表情、代你拒绝），一律问你；
//     只记录的照旧只记录。没写时是开着（2026-10-23 用户：部署以后维持现状）。
//   - model：信心模型的参数（engine 的 confidence-model.ts 的 ConfidenceModelParams 里能调的几项）。没写时用缺省。
// 改参数走两个操作（ui-actions.ts 的 channel_policy）：update 只有你本人能做（含放宽），tighten Lead 能做（只能收紧）。
// 收紧还是放宽由 standing-order-tiers.ts 的 RULE_PARAM_CHECKS["channel.authority"] 判断。
// 测一条消息（test）和评估过去 24 小时的消息（replay）只读，不发任何东西：test 让请求 A、B 真的给这条消息打分；replay 用请求 A
// 当时的结果，草稿没记下分数的现在调请求 B。
// 这里不出现任何具体来源的名字。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_CLOSING_KINDS, CHANNEL_INTENT_PERMISSIONS, CHANNEL_INTENTS, SENDER_TRUST_LEVELS,
  type ChannelAuthorityTable,
} from "./channel-policy.ts";

const StrictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Probability = Type.Number({ minimum: 0, maximum: 1 });

// ── 参数 ──────────────────────────────────────────────────────────────────────────

export const CHANNEL_LOCK_MODES = ["hard", "weighted"] as const;
export type ChannelLockMode = typeof CHANNEL_LOCK_MODES[number];

export const ChannelConfidenceTuningSchema = StrictObject({
  // 话题可能涉及钱、人事、法律、情绪：超过它加一档（到 50% 加两档）。
  topicStep: Type.Number({ minimum: 0, maximum: 0.5 }),
  // 草稿可能替你承诺、多说：到它加一档（到 50% 是底线）。
  draftRiskStep: Type.Number({ minimum: 0, maximum: 0.5 }),
  // 出处全部核实不过时乘多少；「有据」「理解」最低乘多少。
  verifiedFloor: Probability,
  groundedFloor: Probability,
  understoodFloor: Probability,
});

export const ChannelConfidenceParamsSchema = StrictObject({
  // L1 到 L4 的门槛：信心不低于这一档的门槛才代你发。L5 和以上不自动发。
  tiers: Type.Tuple([Probability, Probability, Probability, Probability]),
  // 要回的概率低于它、又没人请你做事的，只记录。
  noReplyBelow: Probability,
  // 必要维度的指数：越大，分数不够高时扣得越多。
  weights: StrictObject({ needs_reply: Type.Number({ minimum: 0.1, maximum: 3 }), fulfills: Type.Number({ minimum: 0.1, maximum: 3 }) }),
  // 校准时模型的分数顶几个你的做法。
  priorStrength: Type.Number({ minimum: 1, maximum: 100 }),
  // 你的做法少于 20 个样本时，代价多加几档。
  coldStartTiers: Type.Integer({ minimum: 0, maximum: 3 }),
  // hard：碰到底线就只问你；weighted：底线的概率乘进信心。
  lockMode: Literals(CHANNEL_LOCK_MODES),
  tuning: ChannelConfidenceTuningSchema,
});
export type ChannelConfidenceParams = Static<typeof ChannelConfidenceParamsSchema>;

// 缺省值。和 engine 的 CONFIDENCE_MODEL_DEFAULTS、CONFIDENCE_TUNING_DEFAULTS 一样（engine 的测试核对）。
export const CHANNEL_CONFIDENCE_DEFAULTS: ChannelConfidenceParams = {
  tiers: [0.6, 0.75, 0.9, 0.95],
  noReplyBelow: 0.3,
  weights: { needs_reply: 0.5, fulfills: 0.5 },
  priorStrength: 10,
  coldStartTiers: 0,
  lockMode: "hard",
  tuning: { topicStep: 0.2, draftRiskStep: 0.4, verifiedFloor: 0.2, groundedFloor: 0.6, understoodFloor: 0.9 },
};

/** 开关没写时的样子：开着（2026-10-23 用户：部署以后维持现状）。 */
export const CHANNEL_AUTO_REPLY_DEFAULT = true;

/** 参数合不合格，schema 以外的检查：各档的门槛从低到高。返回问题；空数组表示可以用。 */
export function channelConfidenceProblems(params: ChannelConfidenceParams): string[] {
  const problems: string[] = [];
  for (let index = 1; index < params.tiers.length; index++) {
    if (params.tiers[index]! < params.tiers[index - 1]!) problems.push(`L${index + 1} 的门槛不能低于 L${index} 的`);
  }
  return problems;
}

const IntentAuthoritySchema = StrictObject({
  action: Literals(CHANNEL_INTENT_PERMISSIONS),
  minConfidence: Type.Optional(Probability),
});

export const ChannelAuthorityTableSchema = StrictObject(
  Object.fromEntries(CHANNEL_INTENTS.map((intent) => [intent, IntentAuthoritySchema])) as Record<typeof CHANNEL_INTENTS[number], typeof IntentAuthoritySchema>,
);

// 面板上改的一整份：开关、授权表、信心模型的参数。
export const ChannelPolicyParamsSchema = StrictObject({
  autoReply: Type.Boolean(),
  intents: ChannelAuthorityTableSchema,
  confidence: ChannelConfidenceParamsSchema,
});
export type ChannelPolicyParams = Static<typeof ChannelPolicyParamsSchema>;

export const CHANNEL_POLICY_DEFAULTS: ChannelPolicyParams = {
  autoReply: CHANNEL_AUTO_REPLY_DEFAULT,
  intents: CHANNEL_AUTHORITY_DEFAULTS as ChannelPolicyParams["intents"],
  confidence: CHANNEL_CONFIDENCE_DEFAULTS,
};

// ── 读：GET /v1/channels/policy/:source ──────────────────────────────────────────

// 改了以后网关发 snapshot.required，payload 是 {resource: "channel-policy"}，客户端重新读。
export const CHANNEL_POLICY_RESOURCE = "channel-policy";

export const ChannelPolicyDtoSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  // 现在生效的（没有批准过的放宽不算数）。
  params: ChannelPolicyParamsSchema,
  // 最新版本里写的。和 params 不一样时，界面写明哪一项没生效。
  requested: ChannelPolicyParamsSchema,
  defaults: ChannelPolicyParamsSchema,
  // 参数存在哪一条常设指令。读不到时是 null（用代码里的缺省）。
  order: Nullable(Type.Object({
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 0 }),
    author: Type.String(),
    approvedBy: Nullable(Type.String()),
    createdAt: Nullable(Type.String()),
    // 这一条对哪个来源生效："*" 是所有来源共用的。
    scope: Type.String({ minLength: 1 }),
  })),
});
export type ChannelPolicyDto = Static<typeof ChannelPolicyDtoSchema>;

// ── 测一条消息：POST /v1/channels/policy/:source/test ────────────────────────────

export const CHANNEL_POLICY_AUDIENCES = ["dm", "group_dm", "private_channel", "public_channel"] as const;
export const CHANNEL_POLICY_SENDERS = ["colleague", "external", "customer"] as const;
export const CHANNEL_POLICY_FOUND = ["yes", "partial", "no", "failed", "not_needed"] as const;
export const CHANNEL_POLICY_TEXT_MAX = 2_000;

// 一条测试用的消息，和模型给它打的分（再算一遍时原样带回来，不用再问模型）。
export const ChannelPolicyScoredCaseSchema = StrictObject({
  text: Type.String({ maxLength: CHANNEL_POLICY_TEXT_MAX }),
  draftText: Type.String({ maxLength: CHANNEL_POLICY_TEXT_MAX }),
  intent: Nullable(StrictObject({ kind: Literals(CHANNEL_INTENTS), closing: Nullable(Literals(CHANNEL_CLOSING_KINDS)) })),
  found: Literals(CHANNEL_POLICY_FOUND),
  scores: StrictObject({
    needsReply: Nullable(Probability),
    askConfidence: Nullable(Probability),
    fulfills: Nullable(Probability),
    grounded: Nullable(Probability),
    draftCommits: Nullable(Probability),
    draftOvershares: Nullable(Probability),
    topics: Type.Record(Type.String({ maxLength: 40 }), Probability),
    sensitiveQueries: Nullable(Type.Record(Type.String({ maxLength: 60 }), Probability)),
  }),
  facts: StrictObject({
    audience: Literals(CHANNEL_POLICY_AUDIENCES),
    members: Nullable(Type.Integer({ minimum: 0 })),
    externalShared: Nullable(Type.Boolean()),
    senderTrust: Literals(SENDER_TRUST_LEVELS),
    sources: StrictObject({ total: Type.Integer({ minimum: 0, maximum: 100 }), verified: Type.Integer({ minimum: 0, maximum: 100 }) }),
  }),
  // 草稿的分数是谁打的：jev 快模型；fallback 不是 Jev（LLM 兜底，或者没有问成）。信心模型只在 jev 时代你发。
  scoredBy: Literals(["jev", "fallback"] as const),
});
export type ChannelPolicyScoredCase = Static<typeof ChannelPolicyScoredCaseSchema>;

export const ChannelPolicyTestCaseSchema = Type.Union([
  // 一条消息（面板上的例子也是这样填好的）：请求 A 判断意图、要不要回、话题和敏感查询；写了草稿时请求 B 给草稿打分。
  StrictObject({
    kind: Type.Literal("message"),
    text: Type.String({ minLength: 1, maxLength: CHANNEL_POLICY_TEXT_MAX }),
    audience: Literals(CHANNEL_POLICY_AUDIENCES),
    sender: Literals(CHANNEL_POLICY_SENDERS),
    draft: Type.Optional(Type.String({ maxLength: CHANNEL_POLICY_TEXT_MAX })),
    // 假设 Lead 已经查到了，草稿有一处核实过的出处（测试不会真的去查）。
    assumeFound: Type.Boolean(),
  }),
  // 上一次测试的结果，换了参数再算一遍（不调模型）。
  StrictObject({ kind: Type.Literal("scored"), scored: ChannelPolicyScoredCaseSchema }),
]);
export type ChannelPolicyTestCase = Static<typeof ChannelPolicyTestCaseSchema>;

export const ChannelPolicyTestRequestSchema = StrictObject({
  // 用哪一份参数算（面板上还没保存的）。不给时用现在生效的。
  params: Type.Optional(ChannelPolicyParamsSchema),
  case: ChannelPolicyTestCaseSchema,
});
export type ChannelPolicyTestRequest = Static<typeof ChannelPolicyTestRequestSchema>;

const AnswerSchema = Type.Object({ ok: Type.Boolean(), text: Type.String() });

// 这次测试真的问了模型几次：请求 A、B 各一次（没写草稿时没有 B）。再算一遍（scored）时是空的。
export const ChannelPolicyModelCallSchema = Type.Object({
  request: Literals(["A", "B"] as const),
  // 哪个后端回答的（jev、llm）。没有问成时是 null。
  backend: Nullable(Type.String()),
  model: Nullable(Type.String()),
  ms: Type.Integer({ minimum: 0 }),
  ok: Type.Boolean(),
  error: Nullable(Type.String()),
});
export type ChannelPolicyModelCall = Static<typeof ChannelPolicyModelCallSchema>;

export const ChannelPolicyTestResultSchema = Type.Object({
  scored: ChannelPolicyScoredCaseSchema,
  // 模型没打成分时的原因（例如没有快模型）。打成了是 null。
  scoreError: Nullable(Type.String()),
  calls: Type.Array(ChannelPolicyModelCallSchema),
  decision: Type.String(),
  // 能否代处理（看授权表和底线，不看信心）、能否代回（不问你，直接发）。
  handle: AnswerSchema,
  reply: AnswerSchema,
  confidence: Nullable(Probability),
  raw: Nullable(Probability),
  threshold: Nullable(Probability),
  tier: Type.Object({
    level: Type.Integer({ minimum: 0 }),
    base: Type.String(),
    steps: Type.Array(Type.String()),
  }),
  factors: Type.Array(Type.Object({
    id: Type.String(), label: Type.String(), kind: Type.String(), value: Nullable(Type.Number()), weight: Nullable(Type.Number()),
    factor: Type.Number(), points: Type.Number(), detail: Type.String(),
  })),
  calibration: Nullable(Type.Object({ bucket: Type.Number(), samples: Type.Number(), agreed: Type.Number(), points: Type.Number() })),
  // 一票否决：前提和底线，逐项。
  vetoes: Type.Array(Type.Object({ label: Type.String(), value: Type.String(), pass: Type.Boolean(), note: Nullable(Type.String()) })),
  reasons: Type.Array(Type.String()),
});
export type ChannelPolicyTestResult = Static<typeof ChannelPolicyTestResultSchema>;

// ── 过去 24 小时的消息：POST /v1/channels/policy/:source/replay ──────────────────────

export const CHANNEL_POLICY_REPLAY_HOURS = 24;
// 一次最多给几份草稿调请求 B（之前算过的不算在内）。超过的那几条按「没评估」显示。
export const CHANNEL_POLICY_REPLAY_MAX_CALLS = 40;

export const ChannelPolicyReplayRequestSchema = StrictObject({ params: ChannelPolicyParamsSchema });
export type ChannelPolicyReplayRequest = Static<typeof ChannelPolicyReplayRequestSchema>;

// why：能否代回的那一句（不能时是第一条原因，例如一票否决的哪一项）。
const ReplayOutcomeSchema = Type.Object({ decision: Type.String(), handle: Type.Boolean(), reply: Type.Boolean(), why: Type.String() });
const ReplayCountSchema = Type.Object({ handle: Type.Integer({ minimum: 0 }), reply: Type.Integer({ minimum: 0 }) });

export const ChannelPolicyReplayResultSchema = Type.Object({
  since: Type.String(),
  until: Type.String(),
  // 这段时间里别人发来、请求 A 判断过的消息。
  total: Type.Integer({ minimum: 0 }),
  // 现在生效的参数、你改的参数：各有几条能代处理、能代回。
  before: ReplayCountSchema,
  after: ReplayCountSchema,
  // 这一次给草稿调了几次请求 B（之前算过的草稿不再调），其中几次没问成。
  calls: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  // 新的在前。
  items: Type.Array(Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    cardId: Nullable(Type.Integer({ minimum: 1 })),
    at: Type.String(),
    sender: Type.String(),
    text: Type.String(),
    intent: Type.String(),
    draft: Nullable(Type.String()),
    // 草稿的分数从哪里来：no_draft 没有草稿；recorded 打分时记下的；called 这次调了请求 B；cached 之前调过；
    // failed 请求 B 没问成；skipped 这次调的次数到了上限，没评估。
    scoring: Literals(["no_draft", "recorded", "called", "cached", "failed", "skipped"] as const),
    before: ReplayOutcomeSchema,
    after: ReplayOutcomeSchema,
    // 当时授权表的决定（channel.authority.decided）。没有记录时是 null。
    then: Nullable(Type.String()),
  })),
});
export type ChannelPolicyReplayResult = Static<typeof ChannelPolicyReplayResultSchema>;

/** 授权表加上信心模型的参数：从常设指令的参数读出一整份，没写的用缺省。 */
export function channelPolicyParamsOf(params: {
  intents: ChannelAuthorityTable; autoReply?: boolean; model?: ChannelConfidenceParams;
}): ChannelPolicyParams {
  return {
    autoReply: params.autoReply ?? CHANNEL_AUTO_REPLY_DEFAULT,
    intents: params.intents as ChannelPolicyParams["intents"],
    confidence: params.model ?? CHANNEL_CONFIDENCE_DEFAULTS,
  };
}

// ── 响应 ──────────────────────────────────────────────────────────────────────────

export const ChannelPolicyResponseSchema = Type.Object({ policy: ChannelPolicyDtoSchema });
export const ChannelPolicyTestResponseSchema = Type.Object({ result: ChannelPolicyTestResultSchema });
export const ChannelPolicyReplayResponseSchema = Type.Object({ result: ChannelPolicyReplayResultSchema });
