// 通道框架（Lead 事件主干 spec D2、D10、D14，工单 11）的共享部分：内核自己的事件类型，和会话卡的线上契约。
//
// 一个外部来源（对话型或信号型）由 engine 的通道 registry 登记：来源名、它的事件类型、默认常设指令都由来源插件提供。
// 这里只有和来源无关的部分，不出现任何具体来源的名字：
//   - channel.* 事件：出站动作的幂等记账（requested → completed / failed）、代你行动的闸门的每一次判断、
//     自动回复和撤回、用户在卡片上的动作。来源都是 system，对象键是那条道（对话）的对象键。
//   - 会话卡（ChannelCardDto）：一个对话一张卡，状态原地更新。06 的「一个对象一张卡、Lead 后补充」模式合并时接管它。
//   - 代查（代查与按信心代回 spec D9）：卡带上这张卡最新一次代查（ChannelLookupDto）。收件判断、代查的开始和结束、被拒、
//     代回的决定、发到 PR 的 review 都是 channel.* 事件。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CHANNEL_DELIVERY_MODES, CHANNEL_INTENTS, CHANNEL_RULE_CHANGE_KINDS, DELEGATION_CATEGORIES, SENDER_TRUST_LEVELS } from "./channel-policy.ts";
import {
  ConnectionSourceSchema, LOOKUP_FOUND, LOOKUP_PLAYBOOKS, LOOKUP_STATES, LookupActionSchema, LookupReadRecordSchema, LookupResultSchema,
  LookupReviewCommentSchema, LookupScopeSchema, LookupSourceSchema, type LookupReadRecord, type LookupResult, type LookupScope,
} from "./channel-lookup.ts";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import type { Scope } from "./scopes.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
// 一组字面量的并集。Type.Unsafe 给出准确的静态类型（map 出来的数组不是元组，Static 推不出字面量）。
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

// ── 内核的事件类型 ───────────────────────────────────────────────────────────────────

export const CHANNEL_EVENT_KINDS = {
  outboundRequested: "channel.outbound.requested",
  outboundCompleted: "channel.outbound.completed",
  outboundFailed: "channel.outbound.failed",
  delegationDecided: "channel.delegation.decided",
  replyAutoSent: "channel.reply.auto_sent",
  replyRetracted: "channel.reply.retracted",
  cardAction: "channel.card.action",
  // 代查和按信心代回（spec D3–D8、D13）。
  intakeDecided: "channel.intake.decided",
  lookupStarted: "channel.lookup.started",
  lookupFinished: "channel.lookup.finished",
  lookupDenied: "channel.lookup.denied",
  replyDecided: "channel.reply.decided",
  reviewPosted: "channel.review.posted",
  // 开卡以前，请求 A 判断这条消息不用用户回（用户 2026-10-21）：不开卡，只在「Lead 动态」里记一笔。
  replyNotNeeded: "channel.reply.not_needed",
  // 授权表的决定（落地计划 A5）：按对方的意图，通道做了什么（回表情、代你拒绝、提醒你、代你说一句、要干活、问你、不打扰）。
  authorityDecided: "channel.authority.decided",
  // Lead 改选交接说明里的一句（自动代你处理方案 B，用户 2026-10-30 定 D1）：原来选的、改选的、理由和重算的上限。
  situationRepicked: "channel.situation.repicked",
  // 交给 Lead（落地计划 B）：要干活、要打扰你的消息，和信心模型交回的「问你、交给你」，先交给 Lead 决定（B1、B4）；
  // Lead 的决定（B2）；派出去的子 agent 工单结束（⑦ 的结论）。交给 Lead 的请求就是消息事件（message.received）和交回 Lead 的
  // 子 agent 结果（channel.task.finished，handedBack）：统一消息事件工单 05 删了 channel.lead.requested，工单 06 删了它的类型
  // （旧库里的行不迁移）。
  leadDecided: "channel.lead.decided",
  taskFinished: "channel.task.finished",
  // 校准（落地计划 D2）：信心模型给一份要代你发的草稿打的分（卡上的分数面板，也是校准的样本），
  // 和你在来源里实际做了什么（这个样本的标签）。
  replyScored: "channel.reply.scored",
  replyLabeled: "channel.reply.labeled",
  // 交接说明的草稿（issue 08）：按「做好给你看」「交给你」放到卡上的草稿，你后来做了什么（原样发、改了再发、自己回）。
  // 页边批注的「放宽」建议读它。Lead 自己的回复放到卡上时（D2）不打分，所以不在 channel.reply.labeled 里。
  handbookDraftLabeled: "channel.handbook.draft.labeled",
} as const;

/**
 * 交给 Lead 的请求在哪一步（落地计划 B）：intake 刚收到、授权表判断要干活或者要打扰你（B1）；
 * reply 子 agent 或者 Lead 答完，信心模型的结论是问你或者交给你（B4）。
 */
export const CHANNEL_LEAD_STAGES = ["intake", "reply"] as const;
export type ChannelLeadStage = typeof CHANNEL_LEAD_STAGES[number];

/**
 * Lead 对一个请求的决定（落地计划 B2）：
 *   dispatch 派子 agent 工单；answer Lead 自己写了草稿；push 推送这张卡；told Lead 在这一轮里已经告诉你了；
 *   superseded：同一张卡又来了新消息，这个请求并进新的请求（系统记的）。
 */
// closed：Lead 还没决定，卡已经结束了（你在卡上点了、Lead 照你的话做完了），不用再决定（2026-10-26）。
// react、refuse、no_reply：回表情、代你拒绝、收尾的消息（2026-10-26：能代你回的都先交给 Lead），Lead 回了表情、用固定的话拒绝了、
// 判断不用回。工单 06 删了期限和系统兜底的 fallback_dispatch、fallback_push、fallback_auto（旧库里的行不迁移）。
export const CHANNEL_LEAD_DECISIONS = [
  "dispatch", "answer", "push", "told", "superseded", "closed", "react", "refuse", "no_reply",
] as const;
export type ChannelLeadDecision = typeof CHANNEL_LEAD_DECISIONS[number];

/** 授权表的结论（engine 的 channels/authority.ts）。tell：对方在接着回答你最近说的话，告诉你，不派活（spec D3）。 */
export const CHANNEL_AUTHORITY_ACTIONS = ["skip", "react", "refuse", "remind", "closing_reply", "work", "ask", "tell"] as const;
export type ChannelAuthorityActionKind = typeof CHANNEL_AUTHORITY_ACTIONS[number];

/** 打了分的草稿是谁写的（落地计划 D2）：子 agent 工单的结果、Lead 写的回复、收尾时起草的一句。 */
export const CHANNEL_REPLY_DRAFT_KINDS = ["task", "lead_answer", "closing"] as const;
export type ChannelReplyDraftKind = typeof CHANNEL_REPLY_DRAFT_KINDS[number];

/**
 * 校准样本的标签（落地计划 D2）：你在来源里实际做了什么，不只看卡上的按钮。
 *   sent_as_is 照发了草稿；auto_kept 自动发了，撤回窗口里没撤回；rewritten 自己写了别的（卡上改了再发、发了别的草稿，
 *   或者在来源里直接回）；retracted 撤回了自动回复；no_action 什么都没做（这条消息不用回，不校准草稿）。
 */
export const CHANNEL_REPLY_LABELS = ["sent_as_is", "auto_kept", "rewritten", "retracted", "no_action"] as const;
export type ChannelReplyLabel = typeof CHANNEL_REPLY_LABELS[number];

// 一项检查的结果：pass ✓、weak △（过了但不够强，例如概率在门槛附近）、fail ✗。代查的检查和信心模型的分数面板都用它。
export const CHANNEL_LOOKUP_CHECK_STATUSES = ["pass", "weak", "fail"] as const;
export type ChannelLookupCheckStatus = typeof CHANNEL_LOOKUP_CHECK_STATUSES[number];

/** 代回闸门的结论（spec D7）：自动发、卡上问用户、交给用户（没查到或者失败）。 */
export const CHANNEL_REPLY_DECISIONS = ["auto_send", "ask_user", "hand_over"] as const;
export type ChannelReplyDecision = typeof CHANNEL_REPLY_DECISIONS[number];

// reply 回复；retract 撤回；edit 改写一条已经发出去的消息（用回复覆盖「正在处理」）；react 在一条消息上回表情；
// unreact 撤掉自己回的一个表情（2026-10-26）。
export const CHANNEL_OUTBOUND_ACTIONS = ["reply", "retract", "edit", "react", "unreact"] as const;
export type ChannelOutboundActionType = typeof CHANNEL_OUTBOUND_ACTIONS[number];

const Ref = Type.Record(Type.String(), Type.String());
const OrderRef = Type.Object({ id: Type.String(), version: Type.Integer({ minimum: 0 }) });
const Id = Type.Integer({ minimum: 1 });
const Probability = Type.Number({ minimum: 0, maximum: 1 });
const Check = Type.Object({ condition: Type.String(), pass: Type.Boolean(), detail: Type.String() });
// 信心模型的一项（分数面板的一行）：每个因子、代价、拦住代你发的底线。
const ScoreCheck = StrictObject({
  id: Type.String({ minLength: 1 }),
  label: Type.String(),
  status: Literals(CHANNEL_LOOKUP_CHECK_STATUSES),
  // 这一项的数值（例如概率），没有数值时是 null。
  value: Nullable(Type.Number()),
  detail: Type.String(),
});
// 这次打分的分数段里，带标签的样本（按标签的权重加起来，所以可以有小数）。冷启动时 samples 小于 minSamples。
const ScoreCalibration = StrictObject({
  bucket: Probability,
  samples: Type.Number({ minimum: 0 }),
  agreed: Type.Number({ minimum: 0 }),
  minSamples: Type.Integer({ minimum: 1 }),
});
// 信心模型给一份草稿打的分：结论、是不是抽查、原始信心和校准以后的信心、门槛、分数面板、原因。
const ReplyScore = {
  draftKind: Literals(CHANNEL_REPLY_DRAFT_KINDS),
  decision: Literals(CHANNEL_REPLY_DECISIONS),
  // 本该代你发，抽中了抽查，照样放到卡上问你。
  audit: Type.Boolean(),
  raw: Nullable(Probability),
  confidence: Nullable(Probability),
  threshold: Nullable(Probability),
  calibration: Nullable(ScoreCalibration),
  checks: Type.Array(ScoreCheck),
  vetoes: Type.Array(Type.String()),
  reasons: Type.Array(Type.String()),
};
// 代查事件共有的字段：哪个来源、哪张卡、哪一次代查。
const LookupRef = {
  channel: Type.String({ minLength: 1 }),
  cardId: Id,
  lookupId: Id,
  playbook: Literals(LOOKUP_PLAYBOOKS),
};
const Outbound = {
  channel: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  action: Literals(CHANNEL_OUTBOUND_ACTIONS),
  cardId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
};

export const CHANNEL_KERNEL_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: CHANNEL_EVENT_KINDS.outboundRequested,
    sources: ["system"],
    payload: Type.Object({
      ...Outbound,
      // user_reply：用户点了「用草稿回复」；auto_reply：闸门放行的自动回复；retract：撤回一条自动回复；
      // handling_notice：决定代查以后，在对话里回的一句「正在处理」（只有署名）；reaction：在对方的消息上回表情。
      // 回复改写「正在处理」时 action 是 edit，purpose 照样是 user_reply 或 auto_reply。
      purpose: Type.Union([
        Type.Literal("user_reply"), Type.Literal("auto_reply"), Type.Literal("retract"), Type.Literal("handling_notice"),
        Type.Literal("reaction"),
      ]),
      target: Ref,
      text: Type.Optional(Type.String()),
      emoji: Type.Optional(Type.String()),
    }),
    description: "系统要在外部来源里做一个出站动作（回复、撤回、改写、回表情）。先记这一条，再调用适配器（幂等键是 key）。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.outboundCompleted,
    sources: ["system"],
    payload: Type.Object({ ...Outbound, remoteRef: Ref, duplicate: Type.Boolean() }),
    description: "一个出站动作做成了。同一个幂等键只有一条：重复调用返回这一条的结果，不再调用适配器。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.outboundFailed,
    sources: ["system"],
    payload: Type.Object({ ...Outbound, attempt: Type.Integer({ minimum: 1 }), error: Type.String() }),
    description: "一个出站动作这一次没有做成（下一拍用同一个幂等键再试）。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.delegationDecided,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Type.Integer({ minimum: 1 }),
      // auto_send：自动回复；shadow：闸门的前四条都满足，只是这一类还没开放（影子模式，附上草稿交给用户）；
      // denied：有一条不满足。
      decision: Type.Union([Type.Literal("auto_send"), Type.Literal("shadow"), Type.Literal("denied")]),
      category: Type.Union([Type.String(), Type.Null()]),
      failed: Type.Array(Type.String()),
      checks: Type.Array(Type.Object({ condition: Type.String(), pass: Type.Boolean(), detail: Type.String() })),
      order: OrderRef,
    }),
    description: "代你行动的闸门对一张卡的判断（审计）：五个条件各自的结果和依据的常设指令。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyAutoSent,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Type.Integer({ minimum: 1 }),
      category: Type.String(),
      templateId: Type.String(),
      text: Type.String(),
      summary: Type.String(),
      revokeUntil: Type.String(),
      order: OrderRef,
    }),
    description: "系统按常设指令代用户回复了一条消息（auto 级，做完进摘要），撤回窗口到 revokeUntil。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyRetracted,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Type.Integer({ minimum: 1 }),
      by: Type.String(),
      summary: Type.String(),
    }),
    description: "用户在撤回窗口里撤回了一条自动回复。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.cardAction,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Type.Integer({ minimum: 1 }),
      action: Type.String({ minLength: 1 }),
      by: Type.String(),
      summary: Type.String(),
    }),
    description: "用户在通道的会话卡上做了一个动作（用草稿回复、我自己回、稍后、不回）。",
  },
  // 下面几种的 payload 不带外部的原文：原文在来源的事件里，这里只有判断和计数。summary 是我们自己写的一句话。
  {
    kind: CHANNEL_EVENT_KINDS.intakeDecided,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      // 判断时这条消息所在的卡。开卡以前判断的（先判断要不要回，再开卡）是 null。
      cardId: Nullable(Id),
      // 这条消息要用户回的概率（needs_reply）。没回答时是 null；判断改版以前的事件没有这一项。
      needsReply: Type.Optional(Nullable(Probability)),
      // 判断的是哪一条消息（来源事件的 seq）。
      forSeq: Id,
      // answered：快模型回答了；unavailable：没有可用的模型、超时或出错。unavailable 时不代查，卡照常投递。
      status: Type.Union([Type.Literal("answered"), Type.Literal("unavailable")]),
      // 第 7 版（2026-10-30，自动代你处理方案 B）：交接说明里选中的一句的编号。askKind 是它推出的旧意图。旧事件没有这一项。
      situation: Type.Optional(Nullable(Type.String())),
      // 第 8 版（issue 05）：对方要借你的权限、看他自己多半看不到的东西的概率。没问成时是 null；旧事件没有这一项。
      borrowed: Type.Optional(Nullable(Probability)),
      // issue 10：谁判断的（jev、llm……）；决策模型没有回答、改由 LLM 判断时，原来的后端和原因；LLM 写的理由。旧事件没有这几项。
      backend: Type.Optional(Nullable(Type.String())),
      fallback: Type.Optional(Nullable(Type.Object({ from: Type.String(), reason: Type.String() }))),
      why: Type.Optional(Nullable(Type.String())),
      askKind: Nullable(Type.String()),
      askConfidence: Nullable(Probability),
      // 请求 A 选的仓库（owner/name），none 或者没回答时是 null。
      targetRepo: Nullable(Type.String()),
      // 6 个敏感查询各自的概率（spec D3）。
      sensitive: Type.Record(Type.String(), Probability),
      // 话题的概率（代回的否决项）。
      topics: Type.Optional(Type.Record(Type.String(), Probability)),
      // 第 4 版（2026-10-22）：收尾的种类、要回表情时回哪个、题的版本。旧事件没有这几项。
      closing: Type.Optional(Nullable(Type.String())),
      reaction: Type.Optional(Nullable(Type.String())),
      questionVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      // 模板代回的分类（第 3 版以前的事件才有；模板代回闸门已经退役）：回复的类别、类别的置信度、风险档。
      delegation: Type.Optional(Nullable(Type.Object({
        category: Nullable(Type.String()),
        confidence: Probability,
        risk: Nullable(Type.String()),
      }))),
      error: Type.Optional(Nullable(Type.String())),
      summary: Type.String(),
    }),
    description: "收件判断（请求 A）：快模型认为对方要什么、查哪个仓库、是不是敏感查询。不阻塞投递。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.lookupStarted,
    sources: ["system"],
    payload: Type.Object({
      ...LookupRef,
      itemId: Id,
      runId: Id,
      // 作用域里的仓库。
      repos: Type.Array(Type.String()),
      summary: Type.String(),
    }),
    description: "开始一次代查：开了一张只读的代查工单，起了一个 purpose 为 lookup 的 Run。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.lookupFinished,
    sources: ["system"],
    payload: Type.Object({
      ...LookupRef,
      status: Type.Union([Type.Literal("finished"), Type.Literal("failed"), Type.Literal("cancelled")]),
      found: Nullable(Literals(LOOKUP_FOUND)),
      itemId: Nullable(Id),
      sources: Type.Integer({ minimum: 0 }),
      verifiedSources: Type.Integer({ minimum: 0 }),
      reads: Type.Integer({ minimum: 0 }),
      error: Nullable(Type.String()),
      summary: Type.String(),
    }),
    description: "一次代查结束了（查到、没查到、失败或者取消），出处已经由代码核实。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyNotNeeded,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      // 那条消息的事件。
      forSeq: Id,
      // 请求 A 的回答：要用户回的概率、对方要什么。不按概率判断的（例如机器人发的、外部共享对话里的收尾）概率是 null。
      needsReply: Nullable(Probability),
      askKind: Nullable(Type.String()),
      // 授权表给的原因（第 4 版以后）。
      reason: Type.Optional(Type.String()),
      summary: Type.String(),
    }),
    description: "别人发来的一条消息，开卡以前授权表判断不打扰用户（例如话题结束了、只是感叹、通知、机器人发的）：没有开卡，只记在「Lead 动态」里。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.authorityDecided,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      // 那条消息的事件，和它所在的卡（不开卡的结论是 null）。
      forSeq: Id,
      cardId: Nullable(Id),
      // 请求 A 认出的意图。没问到时是 null。
      intent: Nullable(Type.String()),
      action: Literals(CHANNEL_AUTHORITY_ACTIONS),
      reason: Type.String(),
      // 回表情时回的哪个。
      emoji: Type.Optional(Type.String()),
      // 依据：交接说明（第 7 版以前是授权表）这条常设指令的编号和版本（读不到时是代码里的缺省，版本 0）。
      order: Type.Optional(OrderRef),
      // 交接说明（issue 03）：起作用的一句、它的做法、压过以后的做法、谁定的、压过它的那一句。旧事件没有这几项。
      situation: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      final: Type.Optional(Type.String()),
      by: Type.Optional(Type.String()),
      limit: Type.Optional(Type.String()),
      summary: Type.String(),
    }),
    description: "按交接说明（以前是授权表）决定通道做什么：回表情、代你拒绝、提醒你、代你说一句、要干活、问你、不打扰。代你做了的事进摘要。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.situationRepicked,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      // 那条消息的事件，和交给 Lead 的消息事件。
      forSeq: Id,
      messageEvent: Id,
      // 原来起作用的一句和改选的一句（编号）。
      from: Nullable(Type.String()),
      to: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      // 按改选的一句重算的上限（同 message.received 的 ceiling 里交接说明的几项）。
      situation: Type.Object({ id: Type.String({ minLength: 1 }), text: Type.String() }),
      mode: Type.String(),
      final: Type.String(),
      by: Type.String(),
      limit: Nullable(Type.String()),
      abilities: Type.Array(Type.String()),
      // 底线 4：对方在要求改规则、记忆或偏好。旧事件没有这一项。
      ruleChange: Type.Optional(Type.Boolean()),
      summary: Type.String(),
    }),
    description: "Lead 认为收件判断选错了交接说明里的句子，改选了一句并写了理由。上限按新的一句重算，对方的上限和底线照样生效。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.leadDecided,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      forSeq: Id,
      stage: Literals(CHANNEL_LEAD_STAGES),
      decision: Literals(CHANNEL_LEAD_DECISIONS),
      by: Type.Union([Type.Literal("lead"), Type.Literal("system")]),
      reason: Type.String(),
      // 派了工单的：工单和 Run，以及超出上限被丢掉的部分。
      itemId: Type.Optional(Id),
      runId: Type.Optional(Id),
      dropped: Type.Optional(Type.Array(Type.String())),
      summary: Type.String(),
    }),
    description: "Lead 对交给它的一个外部请求的决定（派工单、自己答、推送、已经告诉你、回表情、用固定的话拒绝、不用回），或者并进了新的请求。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.taskFinished,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      forSeq: Id,
      runId: Id,
      itemId: Id,
      status: Type.Union([Type.Literal("finished"), Type.Literal("failed"), Type.Literal("cancelled")]),
      // 信心模型的结论（没有可回的东西时是交给你）。
      decision: Literals(CHANNEL_REPLY_DECISIONS),
      confidence: Nullable(Probability),
      threshold: Nullable(Probability),
      // 子 agent 经连接中心做了的、别人看得到的写操作有几个（例如提交的 review）。
      actions: Type.Integer({ minimum: 0 }),
      // 信心模型没让代你回、卡还开着：交回 Lead（统一消息事件工单 05，取代 reply 这一步的 channel.lead.requested）。
      // 这一条就是交给 Lead 的请求：messageEvent 是这张卡的消息事件，Lead 的通用工具按它找卡；没有期限（工单 06）。
      // intent 是派工单时的意图。
      handedBack: Type.Optional(Type.Boolean()),
      messageEvent: Type.Optional(Nullable(Id)),
      intent: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      summary: Type.String(),
    }),
    description: "通道派的一张子 agent 工单结束了：做了哪些动作、信心模型的结论（代你回、问你、交给你）。没代你回的交回 Lead。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyScored,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      // 草稿回的是哪一条消息。
      forSeq: Id,
      intent: Nullable(Literals(CHANNEL_INTENTS)),
      ...ReplyScore,
      // 卡上这份草稿的时间（卡的 draft.at）：标签只算在这份草稿上。
      draftAt: Type.String({ minLength: 1 }),
      // 打分用的模型输入（不含校准，2026-10-23 起记）：设置 → 消息通道的「过去 24 小时的消息」用它里面草稿的分数。
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      summary: Type.String(),
    }),
    description: "信心模型给一份要代你发的草稿打了分（子 agent 工单的结果、Lead 写的回复、收尾的一句）：卡上的分数面板，也是校准的样本。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyLabeled,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      // 打分的那一条事件（channel.reply.scored）。
      scoredSeq: Id,
      label: Literals(CHANNEL_REPLY_LABELS),
      // 草稿的标签：1 照发了，0 没照发；null 不校准草稿（什么都没做）。
      value: Type.Union([Type.Literal(0), Type.Literal(1), Type.Null()]),
      // 这个标签顶几个样本。
      weight: Type.Number({ exclusiveMinimum: 0 }),
      // 打分时原始信心的分数段。
      bucket: Nullable(Probability),
      summary: Type.String(),
    }),
    description: "你对一份打了分的草稿实际做了什么（照发、自动发了没撤回、自己写了别的、撤回、什么都没做）：校准的样本，不分任务。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.handbookDraftLabeled,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      // 草稿回的是哪一条消息，和卡上这份草稿的时间。一份草稿只记一次。
      forSeq: Id,
      draftAt: Type.String({ minLength: 1 }),
      // 那条消息按交接说明的结论（Lead 改选过的按改选的）：起作用的一句、它的做法、最后的做法、谁定的。
      situation: Type.String({ minLength: 1 }),
      mode: Type.String(),
      final: Type.String(),
      by: Type.String(),
      label: Literals(CHANNEL_REPLY_LABELS),
      summary: Type.String(),
    }),
    description: "交接说明放到卡上的草稿（做好给你看、交给你），你后来做了什么：原样发、改了再发、自己回。页边批注的「放宽」建议读它。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.lookupDenied,
    sources: ["system"],
    payload: Type.Object({
      channel: Type.String({ minLength: 1 }),
      cardId: Id,
      lookupId: Nullable(Id),
      playbook: Nullable(Literals(LOOKUP_PLAYBOOKS)),
      // 没通过的检查（例如敏感查询、外部客户、配额）。
      failed: Type.Array(Type.String()),
      checks: Type.Array(Check),
      order: Nullable(OrderRef),
      summary: Type.String(),
    }),
    description: "代查闸门没有放行一个请求（敏感查询、发信人不可信、外部共享的对话、没有预算……），卡上写明原因。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.replyDecided,
    sources: ["system"],
    payload: Type.Object({
      ...LookupRef,
      decision: Literals(CHANNEL_REPLY_DECISIONS),
      // 信心 c（最弱的一环）和这次用的门槛；请求 B 没成功时是 null。
      confidence: Nullable(Probability),
      threshold: Nullable(Probability),
      checks: Type.Array(Check),
      vetoes: Type.Array(Type.String()),
      order: Nullable(OrderRef),
      summary: Type.String(),
    }),
    description: "代回闸门对一次代查的判断（审计）：自动发、卡上问用户、交给用户，带每一项检查、否决项和信心。",
  },
  {
    kind: CHANNEL_EVENT_KINDS.reviewPosted,
    sources: ["system"],
    payload: Type.Object({
      ...LookupRef,
      owner: Type.String({ minLength: 1 }),
      repo: Type.String({ minLength: 1 }),
      number: Id,
      // 逐条加上的评论数，和加不上、并进正文的评论数。
      comments: Type.Integer({ minimum: 0 }),
      foldedComments: Type.Integer({ minimum: 0 }),
      url: Nullable(Type.String()),
      by: Type.String(),
      summary: Type.String(),
    }),
    description: "用户确认以后，代查的 review 以 COMMENT 发到了 PR 上（只留评论，不 approve、不 request changes）。",
  },
];

for (const definition of CHANNEL_KERNEL_EVENT_KINDS) registerEventKind(definition);

// ── 会话卡的线上契约 ───────────────────────────────────────────────────────────────

// 卡的状态：
//   open 等你处理；snoozed 稍后再提醒；replying_self 你在来源里回过一句，但没回答对方（卡还开着，不再推送）；
//   replied 你用草稿回复了；auto_replied 系统按常设指令代你回复了（撤回窗口内可以撤回）；
//   resolved_elsewhere 你在来源里自己回复了（别处已处理，不再提醒）；dismissed 你选了不回；
//   handled 你让 Lead 去做卡上的事，Lead 在别处做完了（例如私信了别人），在对方的消息上回了表情（2026-10-26）；
//   left_to_user 你点了「我自己回」：卡马上结束，以后你在来源里的回复只给草稿打校准标签（统一消息事件 spec D11）。
export const CHANNEL_CARD_STATES = [
  "open", "snoozed", "replying_self", "replied", "auto_replied", "resolved_elsewhere", "dismissed", "handled", "left_to_user",
] as const;
export type ChannelCardState = typeof CHANNEL_CARD_STATES[number];
export const CHANNEL_CARD_OPEN_STATES: readonly ChannelCardState[] = ["open", "snoozed", "replying_self"];

// 卡上的动作：用草稿回复、我自己回、稍后、不回；自动回复以后在撤回窗口里撤回；改一下再发（带用户的文字）；
// 停掉正在跑的子 agent 工单（cancel_lookup，名字沿用代查的）。旧代查的「重新查」「发到 PR 并回复」随代查退役了
// （落地计划 D1，2026-10-22）：PR 上的评论由子 agent 在工具的规矩里发。
// handled：卡上的事在别处做完了（2026-10-26），带一句做了什么（note），缺省在对方的消息上回 ✅。页面上没有这个按钮，
// 是 Lead 照你的话做完以后用的；请求体照样收它（操作层的两个入口）。
export const CHANNEL_CARD_ACTIONS = [
  "send_draft", "reply_myself", "snooze", "dismiss", "undo_auto_reply", "send_edited", "cancel_lookup", "handled",
] as const;
export type ChannelCardAction = typeof CHANNEL_CARD_ACTIONS[number];

// 每个动作要的 scope（网关按动作检查）。在来源里以用户的身份发言、改卡的状态是「这台设备是主人」（tickets:create）。
export const CHANNEL_CARD_ACTION_SCOPES: Record<ChannelCardAction, Extract<Scope, "tickets:create" | "approvals:respond">> = {
  send_draft: "tickets:create",
  reply_myself: "tickets:create",
  snooze: "tickets:create",
  dismiss: "tickets:create",
  undo_auto_reply: "tickets:create",
  send_edited: "tickets:create",
  cancel_lookup: "tickets:create",
  handled: "tickets:create",
};

// 要带文字的动作（请求体的 text）。别的动作不收文字。
export const CHANNEL_CARD_TEXT_ACTIONS: readonly ChannelCardAction[] = ["send_edited"];
// 要带一句说明的动作（请求体的 note）：做了什么。可以带回哪个表情（emoji）、不回表情（react: false）。
export const CHANNEL_CARD_NOTE_ACTIONS: readonly ChannelCardAction[] = ["handled"];
export const CHANNEL_CARD_NOTE_MAX = 300;
// 代你回的表情名（不带冒号，例如 white_check_mark、+1）。来源按自己的规矩再查一遍。
export const CHANNEL_EMOJI_NAME_PATTERN = "^[a-z0-9_+'-]{1,100}$";
// 「卡上的事做完了」缺省回的表情：✅。
export const CHANNEL_HANDLED_EMOJI = "white_check_mark";
/** 用户在卡上写的文字最多多少字。 */
export const CHANNEL_CARD_TEXT_MAX = 4_000;

export const ChannelCardSenderSchema = StrictObject({
  id: Type.String(),
  name: Type.String(),
  trust: Literals(SENDER_TRUST_LEVELS),
});

/**
 * 卡上的代查（spec D9）：这张卡最新一次代查。外部的原文（答案里引用的、出处的摘录）是不可信的数据，只用来显示。
 * 回复的草稿不在这里：hub 把代查的草稿放进卡的 draft（Lead 也能改），卡上只有一份草稿。
 */
export const ChannelLookupDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  state: Literals(LOOKUP_STATES),
  playbook: Literals(LOOKUP_PLAYBOOKS),
  // 作用域里的仓库：owner/name，本地仓库没有远端时是目录名。
  repos: Type.Array(Type.String()),
  // 代查工单（线上叫 ticket）。还没开工单（排队、被拒）时是 null。
  ticketId: Nullable(Type.Integer({ minimum: 1 })),
  startedAt: Type.String(),
  finishedAt: Nullable(Type.String()),
  // 查到了什么。还没结束、失败或者被拒时是 null。出处的 verified 由代码核实以后填。
  result: Type.Union([StrictObject({
    found: Literals(LOOKUP_FOUND),
    answer: Type.String(),
    sources: Type.Array(LookupSourceSchema),
    // 引用连接查询结果的出处（例如 CDP），和子 agent 经连接中心做了的写操作（例如在 PR 上提交的 review，带链接）。
    connectionSources: Type.Array(ConnectionSourceSchema),
    actions: Type.Array(LookupActionSchema),
    checked: Type.Array(Type.String()),
    caveats: Type.Array(Type.String()),
  }), Type.Null()]),
  // PR review 剧本的结果。
  review: Type.Union([StrictObject({
    summary: Type.String(),
    commentCount: Type.Integer({ minimum: 0 }),
    comments: Type.Array(LookupReviewCommentSchema),
  }), Type.Null()]),
  // 这次代查读过什么（审计）。count 是全部的次数，items 可能只是其中一部分。
  reads: StrictObject({
    count: Type.Integer({ minimum: 0 }),
    items: Type.Array(LookupReadRecordSchema),
  }),
  // 信心的拆解：信心、这次用的门槛、每项检查、否决项、这一段的校准历史。代回闸门还没判断时是 null。
  confidence: Type.Union([StrictObject({
    value: Nullable(Probability),
    threshold: Nullable(Probability),
    checks: Type.Array(StrictObject({
      id: Type.String({ minLength: 1 }),
      label: Type.String(),
      status: Literals(CHANNEL_LOOKUP_CHECK_STATUSES),
      // 这一项的数值（例如概率），没有数值时是 null。
      value: Nullable(Type.Number()),
      detail: Type.String(),
    })),
    vetoes: Type.Array(Type.String()),
    // 同一个分数段里带标签的样本（不分任务，按标签的权重加起来，落地计划 D2）。冷启动时 samples 小于 minSamples。
    calibration: Type.Union([ScoreCalibration, Type.Null()]),
  }), Type.Null()]),
  // 代回的决定和原因。还没判断时是 null。
  reply: Type.Union([StrictObject({
    decision: Literals(CHANNEL_REPLY_DECISIONS),
    reasons: Type.Array(Type.String()),
    at: Type.String(),
  }), Type.Null()]),
  // 谁能看到回复：对话的名字、是不是和外部组织共享的对话。
  audience: StrictObject({ label: Type.String(), externalShared: Type.Boolean() }),
  // 主人在来源里的名字（凭据的 accountName）：发出时披露署名里写的名字（spec D8）。hub 还没取到凭据时是 null。
  ownerName: Nullable(Type.String()),
  // 查的那条消息以后，这条道里又来了几条消息（过时提示；结果是多久以前的看 finishedAt）。
  newerMessages: Type.Integer({ minimum: 0 }),
  // 没有查的原因（被拒时），给人看的话。
  deniedReasons: Type.Array(Type.String()),
  // 没查成的原因（失败时）。
  error: Nullable(Type.String()),
});
export type ChannelLookupDto = Static<typeof ChannelLookupDtoSchema>;

/**
 * 通道对这张卡最新一条消息的处理（落地计划 D3）：授权表的结论，交给 Lead 以后 Lead 的决定，
 * 和信心模型给草稿打的分。旧卡、请求 A 没有判断过的是 null。
 */
export const ChannelCardHandlingSchema = StrictObject({
  authority: Type.Union([StrictObject({
    intent: Nullable(Literals(CHANNEL_INTENTS)),
    action: Literals(CHANNEL_AUTHORITY_ACTIONS),
    reason: Type.String(),
  }), Type.Null()]),
  lead: Type.Union([StrictObject({
    stage: Literals(CHANNEL_LEAD_STAGES),
    // 还在排队等 Lead 处理时是 null。
    decision: Type.Union([Literals(CHANNEL_LEAD_DECISIONS), Type.Null()]),
    by: Type.Union([Type.Literal("lead"), Type.Literal("system"), Type.Null()]),
    // 旧 daemon 给的期限（工单 06 删了期限和兜底，新 daemon 不给）。客户端不再用它。
    deadlineAt: Type.Optional(Type.String()),
    // Lead 写给用户的一句话（推送的正文、怎么告诉的），或者系统记的原因（例如并进了新的请求）。
    note: Nullable(Type.String()),
  }), Type.Null()]),
  // 信心模型给卡上这份草稿打的分（分数面板，落地计划 D2、D3）。草稿没有打过分（模板、按对话起草的）时是 null。
  reply: Type.Union([StrictObject({ ...ReplyScore, at: Type.String() }), Type.Null()]),
  // 这张卡上的消息里，请求 A 判断对方在要求改规则（统一消息事件 spec D10 的 Jev 标记，工单 08）：要改哪几类（概率从高到低）、
  // 最高的概率。卡上写明没有照做（channelRuleChangeNotice）。没有这样的消息时是 null；旧的 daemon 不给。
  ruleChange: Type.Optional(Nullable(StrictObject({
    kinds: Type.Array(Literals(CHANNEL_RULE_CHANGE_KINDS)),
    probability: Probability,
  }))),
});
export type ChannelCardHandling = Static<typeof ChannelCardHandlingSchema>;

export const ChannelCardDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  // 版本：每次改动加 1。客户端只接受更高的版本（spec D16）。
  version: Type.Integer({ minimum: 1 }),
  source: Type.String({ minLength: 1 }),
  sourceLabel: Type.String(),
  objectKey: Type.String({ minLength: 1 }),
  // 这条道（对话）叫什么，例如「张三的私信」。
  laneLabel: Type.String(),
  sender: ChannelCardSenderSchema,
  // 原文摘录（最新一条，截断过）。
  excerpt: Type.String(),
  messageCount: Type.Integer({ minimum: 1 }),
  // 这张卡里对方连发的最近几条（最多 5 条，旧的在前），卡片撑开以后叠在同一个名字下（画布外部消息状态 7，2026-10-27）。
  // 对话只留最近 20 条，被挤掉时只剩摘录。外部的原文，只用来显示。
  recent: Type.Optional(Type.Array(StrictObject({ at: Type.String(), text: Type.String() }), { maxItems: 5 })),
  delivery: Literals(CHANNEL_DELIVERY_MODES),
  state: Literals(CHANNEL_CARD_STATES),
  draft: Type.Union([StrictObject({ text: Type.String(), drafter: Type.String() }), Type.Null()]),
  // 代你行动的闸门怎么判的。pending：还在等分类。
  gate: Type.Union([StrictObject({
    decision: Type.Union([Type.Literal("pending"), Type.Literal("shadow"), Type.Literal("denied"), Type.Literal("auto_send")]),
    category: Type.Union([Literals(DELEGATION_CATEGORIES), Type.Null()]),
    reasons: Type.Array(Type.String()),
  }), Type.Null()]),
  // 这张卡最新一次代查（2026-10-22 起是子 agent 工单）。没有过的卡是 null。
  lookup: Type.Union([ChannelLookupDtoSchema, Type.Null()]),
  handling: Type.Union([ChannelCardHandlingSchema, Type.Null()]),
  // 发出去的回复（用草稿回复、自动回复）。
  sentText: Nullable(Type.String()),
  // 卡怎么结束的（2026-10-26）：谁（user 你；lead Lead 代你；system 系统）、哪个动作、Lead 写的一句说明。没结束时是 null。
  outcome: Type.Optional(Nullable(StrictObject({
    by: Type.Union([Type.Literal("user"), Type.Literal("lead"), Type.Literal("system")]),
    action: Type.String(),
    note: Nullable(Type.String()),
  }))),
  snoozedUntil: Nullable(Type.String()),
  revokeUntil: Nullable(Type.String()),
  resolvedAt: Nullable(Type.String()),
  // 现在能做的动作。
  actions: Type.Array(Literals(CHANNEL_CARD_ACTIONS)),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ChannelCardDto = Static<typeof ChannelCardDtoSchema>;

export const ChannelCardListResponseSchema = StrictObject({ items: Type.Array(ChannelCardDtoSchema) });
export type ChannelCardListResponse = Static<typeof ChannelCardListResponseSchema>;

export const ChannelCardActionRequestSchema = StrictObject({
  action: Literals(CHANNEL_CARD_ACTIONS),
  // 客户端看到的版本。给了而卡已经变了时回 409，免得按旧的样子做决定。
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  // 用户自己写的文字（只有 CHANNEL_CARD_TEXT_ACTIONS 里的动作收，并且必须有）。
  text: Type.Optional(Type.String({ minLength: 1, maxLength: CHANNEL_CARD_TEXT_MAX })),
  // 做了什么（只有 CHANNEL_CARD_NOTE_ACTIONS 里的动作收，并且必须有），回哪个表情、回不回。
  note: Type.Optional(Type.String({ minLength: 1, maxLength: CHANNEL_CARD_NOTE_MAX })),
  emoji: Type.Optional(Type.String({ pattern: CHANNEL_EMOJI_NAME_PATTERN })),
  react: Type.Optional(Type.Boolean()),
});
export type ChannelCardActionRequest = Static<typeof ChannelCardActionRequestSchema>;

export const ChannelCardActionResponseSchema = StrictObject({ card: ChannelCardDtoSchema });
export type ChannelCardActionResponse = Static<typeof ChannelCardActionResponseSchema>;

// 卡变了以后，网关推一条 snapshot.required，payload 是这个。客户端据此重取 /v1/channels/cards。
export const CHANNEL_CARDS_SNAPSHOT_RESOURCE = "channel-cards";

// ── 代查的存取校验 ──────────────────────────────────────────────────────────────────
// store 写 channel_lookups 的 JSON 列以前用这些校验（store 不直接依赖 typebox）：存进去的东西不合格，卡的 DTO 就过不了
// 严格 schema，所以宁可在写的时候失败。

export function validLookupScope(value: unknown): value is LookupScope {
  return Value.Check(LookupScopeSchema, value);
}

export function validLookupResult(value: unknown): value is LookupResult {
  return Value.Check(LookupResultSchema, value);
}

export function validLookupReads(value: unknown): value is LookupReadRecord[] {
  return Array.isArray(value) && value.every((record) => Value.Check(LookupReadRecordSchema, record));
}
