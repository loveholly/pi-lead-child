// 通道派给子 agent 的工单（landing.md 第 2、3 节）：派工单的接口、交回的结果。
//
// 链路：通道收消息 → Jev 判断意图 → Lead 决定派工单（B2，统一消息事件工单 05 以后是通用的 dispatch_agent_task，或者 B3 超期时系统按缺省兜底）
// → daemon 的派单器（apps/daemon 的 agent-tasks.ts）按这里的 AgentTaskRequest 开一张工单和一个带权限清单的 Run
// → 子 agent 在清单的范围里干活，所有对外的读写都经连接中心 → 结束时交回 AgentTaskOutcome，交给发起方的回调（通道的 ⑦），
// 不叫醒 Lead。
//
// 原话是不可信的外部文字：它只进子 agent 的提示词（包在不可信的标签里），不进工单的标题和正文，也不进 Lead 的上下文。
import { Type, type Static, type TProperties } from "typebox";
import { ConnectionSourceSchema, LOOKUP_FOUND, LOOKUP_LIMITS, LookupReadRecordSchema, LookupSourceSchema } from "./channel-lookup.ts";
import {
  ExternalGrantScopeSchema, GrantIntentSchema, IntentGrantBoundSchema, RunGrantSchema, type RunGrant,
} from "./run-grants.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

export const AGENT_TASK_LIMITS = {
  summaryChars: 1_000,
  messageChars: 8_000,
  contextChars: 16_000,
  refChars: 200,
} as const;

/**
 * 派一张工单要的东西。
 *   intent     意图（protocol 的 GrantIntent）。
 *   request    请求的结构化描述（B1）：来源、发信人、要做什么（Lead 写的一两句话）、来源里的引用。不带原话。
 *   untrusted  对方的原话和上下文：只给子 agent，包在不可信的标签里。
 *   scope      Lead 选的范围（protocol 的 GrantScope）。不给的项按上限取满。
 *   bound      通道的授权表给的上限。不给时用 DEFAULT_INTENT_GRANT_BOUNDS。
 *   callback   结果交回谁：kind 是发起方注册的回调名（例如 channel），ref 原样带回（例如通道卡的编号）。
 */
export const AgentTaskRequestSchema = StrictObject({
  intent: GrantIntentSchema,
  request: StrictObject({
    source: Type.String({ minLength: 1, maxLength: 60 }),
    requester: Type.String({ minLength: 1, maxLength: 120 }),
    summary: Type.String({ minLength: 1, maxLength: AGENT_TASK_LIMITS.summaryChars }),
    ref: Type.Optional(Type.String({ maxLength: AGENT_TASK_LIMITS.refChars })),
  }),
  untrusted: StrictObject({
    message: Type.String({ maxLength: AGENT_TASK_LIMITS.messageChars }),
    context: Type.Optional(Type.String({ maxLength: AGENT_TASK_LIMITS.contextChars })),
  }),
  scope: ExternalGrantScopeSchema,
  bound: Type.Optional(IntentGrantBoundSchema),
  callback: StrictObject({
    kind: Type.String({ minLength: 1, maxLength: 60 }),
    ref: Type.String({ minLength: 1, maxLength: AGENT_TASK_LIMITS.refChars }),
  }),
});
export type AgentTaskRequest = Static<typeof AgentTaskRequestSchema>;

/** 派单器的回答：开好的工单和 Run，算出来的清单，以及超出上限被丢掉的部分（给 Lead 看）。 */
export interface AgentTaskDispatch {
  itemId: number;
  runId: number;
  grant: RunGrant;
  dropped: string[];
}

/**
 * 子 agent 经连接中心成功做了的一个写操作（C3）。出处是连接中心的审计（store 的 run_tool_calls），不是子 agent 自己说的。
 */
export const AgentTaskActionSchema = StrictObject({
  connection: Type.String(),
  tool: Type.String(),
  summary: Type.String(),
  target: Nullable(Type.String()),
  url: Nullable(Type.String()),
  // 别人看不看得到（例如没提交的 pending review 看不到）。草稿只该提看得到的。
  visible: Type.Boolean(),
  at: Type.String(),
});
export type AgentTaskAction = Static<typeof AgentTaskActionSchema>;

export const AgentTaskSourceSchema = Type.Union([LookupSourceSchema, ConnectionSourceSchema]);
export type AgentTaskSource = Static<typeof AgentTaskSourceSchema>;

/**
 * 子 agent 交的结构化结果（C4，submit_result 的参数）：答案、出处、给对方的草稿。
 * 做了哪些动作（带链接）不由子 agent 填：交回时由代码按连接中心的审计填（AgentTaskOutcome.actions）。
 * 出处由代码按连接中心的读取记录核实，verified 由代码填，没通过的原因并进 caveats。
 */
export const AgentTaskResultSchema = StrictObject({
  found: Literals(LOOKUP_FOUND),
  // 给用户看的答案，第一句是结论。
  answer: Type.String({ maxLength: LOOKUP_LIMITS.answerChars }),
  sources: Type.Array(AgentTaskSourceSchema, { maxItems: LOOKUP_LIMITS.sources }),
  // 查过哪些地方。
  checked: Type.Array(Type.String({ maxLength: 300 }), { maxItems: LOOKUP_LIMITS.checked }),
  caveats: Type.Array(Type.String({ maxLength: 500 }), { maxItems: LOOKUP_LIMITS.caveats }),
  // 给对方的回复草稿（对方的语言，不带署名）。只说做完的事。
  replyDraft: Type.String({ maxLength: LOOKUP_LIMITS.draftChars }),
});
export type AgentTaskResult = Static<typeof AgentTaskResultSchema>;

/** 一次子 agent 的工单结束时交回发起方的东西。result.sources[].verified 已经由代码按连接中心的读取记录填好。 */
export const AgentTaskOutcomeSchema = StrictObject({
  runId: Type.Integer({ minimum: 1 }),
  itemId: Type.Integer({ minimum: 1 }),
  callback: StrictObject({ kind: Type.String(), ref: Type.String() }),
  status: Type.Union([Type.Literal("finished"), Type.Literal("failed"), Type.Literal("cancelled")]),
  result: Type.Union([AgentTaskResultSchema, Type.Null()]),
  actions: Type.Array(AgentTaskActionSchema),
  reads: Type.Array(LookupReadRecordSchema),
  error: Nullable(Type.String()),
  // 交回时的清单（放宽过的话是放宽以后的）。
  grant: RunGrantSchema,
});
export type AgentTaskOutcome = Static<typeof AgentTaskOutcomeSchema>;

/** 派单器（daemon 实现）。Lead 的 dispatch_agent_task 和 B3 的兜底都调它。 */
export interface AgentTaskDispatcher {
  dispatch(request: AgentTaskRequest): Promise<AgentTaskDispatch>;
  cancel(runId: number): Promise<void>;
  /** 发起方登记自己的回调（例如通道登记 channel）。结束的工单按 callback.kind 交给它；同名的回调后登记的生效。 */
  onFinished(kind: string, handler: (outcome: AgentTaskOutcome) => void): void;
}
