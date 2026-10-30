// 定时器带着来源，由决策模型判断（统一的消息事件 spec D16，工单 12；用户 2026-10-27 同意）。
//
// 危险的不是「设定时器」这个动作，而是定时器到点以后要做什么，以及是谁要求设的。所以：
//   · 每个定时器记下来源（TimerOrigin）：用户本人、外部（来源、发信人、消息事件的编号）或者系统（Lead 自己设的）。
//     定时器有三种：跟进（follow_up，收件箱的一行）、提醒（kind=reminder 的工单，改时间也算）、规则（cron 和一次性的 trigger）。
//   · 外部的一轮里设定时器，走决策模型（engine 的 channels/timer-decision.ts）：设并告诉用户、发确认卡问用户、碰底线拒绝。
//   · 到点的时候继承来源：外部来源的定时器叫醒的那一轮按外部的一轮算（改规则被拒，对外的话走出站扩展）。
//   · 外部来源的定时器在提醒列表里标明是谁要求的，用户可以取消（操作层的 timer.cancel）。
//   · 用户取消、确认、改了外部来源的定时器，都记成校准样本（timer.labeled），做法和回复的校准一样。
//
// 确认卡照改规则的确认卡（rule-change-confirmations.ts）的做法：状态记在事件日志里（对象键 timer_request:<编号>），不另建表。
//   timer.request.decided    决策模型的结论（设了、要确认、拒绝），带代价的拆解；
//   timer.request.requested  要确认时存下这一个定时器（参数原样）；
//   timer.request.resolved   用户在卡上的决定（confirm 或 decline），先写它再执行，同一张卡只设一次；
//   timer.request.executed   设好的定时器（或者失败的原因）。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));
const Id = Type.Integer({ minimum: 1 });

// ── 定时器和它的来源 ────────────────────────────────────────────────────────────────

/** 定时器的种类：跟进（收件箱的编号）、提醒（工单编号）、规则（trigger 的编号）、后台检查（watch 的编号，.scratch/lead-watch/spec.md）。 */
export const TIMER_KINDS = ["follow_up", "reminder", "trigger", "watch"] as const;
export type TimerKind = typeof TIMER_KINDS[number];

/** 定时器的编号写成 <种类>:<编号>，例如 follow_up:12、reminder:5、trigger:3、watch:2。 */
export function timerRef(kind: TimerKind, id: number): string {
  return `${kind}:${id}`;
}

export function parseTimerRef(value: string): { kind: TimerKind; id: number } | null {
  const match = /^(follow_up|reminder|trigger|watch):([1-9]\d{0,9})$/u.exec(value.trim());
  return match ? { kind: match[1] as TimerKind, id: Number(match[2]) } : null;
}

/** Lead 设定时器的几个工具（挪动提醒是 reschedule_reminder，和页面上的「改时间」是同一个操作）。 */
export const TIMER_TOOLS = ["follow_up", "create_reminder", "create_once_trigger", "create_cron_trigger", "reschedule_reminder", "watch"] as const;
export type TimerTool = typeof TIMER_TOOLS[number];

export const TimerOriginSchema = Type.Union([
  // 用户本人那一轮设的（turnId 是那一轮；用户在页面上自己改的时间是 null）。
  StrictObject({ kind: Type.Literal("user"), turnId: Nullable(Type.String()) }),
  // 外部的一轮里设的：哪个来源、谁要求的、哪条消息事件。via=tool：这一轮读了外部内容（例如读了 Slack 对话），
  // 说不出是哪条消息、谁要求的，sender 和 messageEvent 是 null。via=message 而 sender 是 null：这一轮读了这条消息
  // （决策模型按它看风险），但 Lead 没指明是它要的，不写成发信人要求的（2026-10-28）。confirmedBy：用户在确认卡上点了「设定时器」（哪台设备、哪张卡）。
  StrictObject({
    kind: Type.Literal("external"),
    via: Type.Union([Type.Literal("message"), Type.Literal("tool")]),
    source: Type.String({ minLength: 1 }),
    sourceLabel: Type.String(),
    sender: Nullable(StrictObject({ id: Type.String(), name: Type.String() })),
    messageEvent: Nullable(Id),
    conversation: Nullable(StrictObject({ key: Type.String({ minLength: 1 }), label: Type.String() })),
    confirmedBy: Type.Optional(StrictObject({ bindingId: Type.Integer(), request: Type.String({ minLength: 1 }), at: Type.String() })),
  }),
  // Lead 自己设的（系统事件、心跳、Lead 自己的判断）。
  StrictObject({ kind: Type.Literal("system") }),
]);
export type TimerOrigin = Static<typeof TimerOriginSchema>;
export type ExternalTimerOrigin = Extract<TimerOrigin, { kind: "external" }>;

export function isExternalTimerOrigin(value: unknown): value is ExternalTimerOrigin {
  return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "external"
    && typeof (value as { source?: unknown }).source === "string";
}

/** 读存下的来源（JSON 里的一项）。读不懂时为 null。 */
export function timerOriginOf(value: unknown): TimerOrigin | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "user" || kind === "system") return value as TimerOrigin;
  return isExternalTimerOrigin(value) ? value : null;
}

/** 给人看的「谁要求的」：「Ethan（Slack）」；说不出是谁时「Slack 的外部内容」。 */
export function timerRequesterLabel(origin: ExternalTimerOrigin): string {
  const where = origin.sourceLabel || origin.source;
  return origin.sender ? `${origin.sender.name}（${where}）` : `${where} 的外部内容`;
}

/**
 * 给人看的「这个定时器是怎么来的」，后面接名词（「定时器」「「…」」）：有发信人时是「Ethan（Slack）要求的」；
 * 没有时是「读了「Ethan 的私信」里的消息以后设的」。只有 Lead 指明了是哪条消息要的，来源里才有发信人（2026-10-28：
 * 以前系统拿这一轮的第一条外部消息当要求人，Aurum 的消息叫醒的一轮里 Lead 接着做用户本人的跟进，卡上写成 Aurum 要求的）。
 */
export function timerAskedBy(origin: ExternalTimerOrigin): string {
  if (origin.sender) return `${timerRequesterLabel(origin)}要求的`;
  const where = origin.conversation?.label ? `「${origin.conversation.label}」里的消息` : `${origin.sourceLabel || origin.source} 的外部内容`;
  return `读了${where}以后设的`;
}

/** 到点后要对外做事时，在哪种对话里（和信心模型的受众一样）。 */
export const TIMER_OUTWARD_AUDIENCES = ["dm", "group_dm", "private_channel", "public_channel"] as const;
export type TimerOutwardAudience = typeof TIMER_OUTWARD_AUDIENCES[number];
export const TIMER_OUTWARD_AUDIENCE_LABELS: Record<TimerOutwardAudience, string> = {
  dm: "1 对 1 私信", group_dm: "群聊", private_channel: "私有频道", public_channel: "公开频道",
};
export const TimerOutwardSchema = StrictObject({
  audience: Literals(TIMER_OUTWARD_AUDIENCES),
  // 发到哪个对话（例如 slack:C123:main），Lead 知道时写。
  conversation: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export type TimerOutward = Static<typeof TimerOutwardSchema>;

// ── 决策模型的结论 ────────────────────────────────────────────────────────────────

/** set 设了并告诉用户；confirm 发确认卡问用户；refuse 碰到底线，不设。 */
export const TIMER_DECISIONS = ["set", "confirm", "refuse"] as const;
export type TimerDecisionKind = typeof TIMER_DECISIONS[number];

const CostStepSchema = StrictObject({
  id: Type.String({ minLength: 1 }), label: Type.String(), levels: Type.Integer(), detail: Type.String(),
});
export const TimerCostSchema = StrictObject({
  level: Type.Integer({ minimum: 0 }),
  name: Type.String(),
  steps: Type.Array(CostStepSchema),
});
export type TimerCost = Static<typeof TimerCostSchema>;

// ── 确认卡 ───────────────────────────────────────────────────────────────────────

export const TIMER_REQUEST_ID = /^tmr_[A-Za-z0-9_-]{8,40}$/;
const RequestId = Type.String({ pattern: "^tmr_[A-Za-z0-9_-]{8,40}$" });

// 没决定的确认卡过多久作废（和改规则的确认卡一样）。
export const TIMER_REQUEST_TTL_MS = 24 * 60 * 60_000;

//   pending 等你决定；running 你点了「设定时器」，正在设；done 设好了（timer 是它的编号）；failed 没设成（原因在 resultPreview）；
//   declined 你点了「不设」；expired 没决定，过期作废了。
export const TimerRequestStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"),
  Type.Literal("declined"), Type.Literal("expired"),
]);
export type TimerRequestState = Static<typeof TimerRequestStateSchema>;

export const TimerRequestDecisionSchema = Type.Union([Type.Literal("confirm"), Type.Literal("decline")]);
export type TimerRequestDecision = Static<typeof TimerRequestDecisionSchema>;

export const TimerRequestDtoSchema = StrictObject({
  id: RequestId,
  state: TimerRequestStateSchema,
  tool: Literals(TIMER_TOOLS),
  // 一句话说这个定时器：什么时候、做什么。系统按存下的参数写，Lead 改不了。
  what: Type.String({ minLength: 1 }),
  // 第一次到点的时间（ISO）。cron 规则写下一次。
  at: Nullable(Type.String()),
  // cron 规则的表达式。不是 cron 时是 null。
  repeat: Nullable(Type.String()),
  // 到点后要对外做事：在哪种对话里。只提醒你时是 null。
  outward: Nullable(TimerOutwardSchema),
  origin: TimerOriginSchema,
  // 「Ethan（Slack）」。
  requester: Type.String(),
  // 为什么要确认：决策模型写的几句话，和代价的拆解。
  reasons: Type.Array(Type.String()),
  cost: TimerCostSchema,
  // Lead 写的「为什么设」（可以是空的）。
  note: Type.String(),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  resolvedAt: Nullable(Type.String()),
  resolvedBy: Nullable(Type.String()),
  // 设好的定时器的编号（follow_up:12 这样）。没设时是 null。
  timer: Nullable(Type.String()),
  resultPreview: Nullable(Type.String()),
});
export type TimerRequestDto = Static<typeof TimerRequestDtoSchema>;

export const TimerRequestResponseSchema = StrictObject({ request: TimerRequestDtoSchema });
export type TimerRequestResponse = Static<typeof TimerRequestResponseSchema>;

export const ResolveTimerRequestSchema = StrictObject({ decision: TimerRequestDecisionSchema });
export type ResolveTimerRequest = Static<typeof ResolveTimerRequestSchema>;

// ── 提醒列表里别人要求设的定时器 ────────────────────────────────────────────────────────

export const ExternalTimerDtoSchema = StrictObject({
  ref: Type.String({ minLength: 1 }),
  kind: Literals(TIMER_KINDS),
  // 提醒和规则的标题；跟进是 Lead 写的那句话。
  title: Type.String(),
  // 下一次到点的时间（ISO）。
  at: Nullable(Type.String()),
  // cron 规则的表达式。
  repeat: Nullable(Type.String()),
  requester: StrictObject({ name: Type.String(), source: Type.String(), sourceLabel: Type.String() }),
  messageEvent: Nullable(Id),
  // 用户在确认卡上点过「设定时器」。
  confirmed: Type.Boolean(),
});
export type ExternalTimerDto = Static<typeof ExternalTimerDtoSchema>;

export const ExternalTimersResponseSchema = StrictObject({ timers: Type.Array(ExternalTimerDtoSchema) });
export type ExternalTimersResponse = Static<typeof ExternalTimersResponseSchema>;

// ── 提醒列表里的后台检查（.scratch/lead-watch/spec.md D5）────────────────────────────────────────
// 所有来源的、还在等的后台检查都列（外部来源的定时器列表只列外部的），写明谁设的；用户能取消（timer.cancel）。
// 单独一个列表：旧客户端的 ExternalTimerDto 不认识 kind=watch，混进去会让整个列表校验失败。

export const WatchTimerDtoSchema = StrictObject({
  ref: Type.String({ minLength: 1 }),
  // 盯的是什么（Lead 写的 label）。
  title: Type.String(),
  check: Type.Union([Type.Literal("command"), Type.Literal("agent")]),
  // 一句话：怎样查（「每 10 秒查一次，最晚到 10-28 14:38」）。
  schedule: Type.String(),
  // 下一次检查的时间（ISO）；正在查时 running 为 true。
  nextAt: Nullable(Type.String()),
  running: Type.Boolean(),
  lastStatus: Nullable(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("error")])),
  lastCheckedAt: Nullable(Type.String()),
  // 谁设的：用户本人那一轮让 Lead 设的、Lead 自己设的、外部的人要求的。
  setBy: Type.Union([Type.Literal("user"), Type.Literal("lead"), Type.Literal("external")]),
  // 外部来源时：谁要求的（说不出是谁时 name 是空的）。
  requester: Nullable(StrictObject({ name: Type.String(), sourceLabel: Type.String() })),
});
export type WatchTimerDto = Static<typeof WatchTimerDtoSchema>;

export const WatchTimersResponseSchema = StrictObject({ watches: Type.Array(WatchTimerDtoSchema) });
export type WatchTimersResponse = Static<typeof WatchTimersResponseSchema>;

// POST /v1/timers/:ref/cancel 的回答：操作层 timer.cancel 的结果。
export const CancelTimerResponseSchema = StrictObject({ result: StrictObject({ ref: Type.String({ minLength: 1 }), state: Type.Literal("cancelled") }) });
export type CancelTimerResponse = Static<typeof CancelTimerResponseSchema>;

// ── 校准 ─────────────────────────────────────────────────────────────────────────

// 用户对外部来源的定时器做了什么（和回复的校准一样，calibration.ts 的 CHANNEL_REPLY_LABEL_RULES）：
//   confirmed 在确认卡上点了「设定时器」1，顶 1 个样本（照发）；declined 点了「不设」0，顶 1 个（不回）；
//   kept 没问就设的，到点了，没取消也没改 1，只顶半个（自动发了没撤回）；edited 改了时间 0，顶 1 个（改了再发）；
//   cancelled 没问就设的被取消了 0，顶 3 个（撤回了自动回复）。一个决策只记一个标签（先到的算）。
export const TIMER_LABELS = ["confirmed", "declined", "kept", "edited", "cancelled"] as const;
export type TimerLabel = typeof TIMER_LABELS[number];
export const TIMER_LABEL_RULES: Readonly<Record<TimerLabel, { value: 0 | 1; weight: number; words: string }>> = {
  confirmed: { value: 1, weight: 1, words: "在确认卡上点了「设定时器」" },
  declined: { value: 0, weight: 1, words: "在确认卡上点了「不设」" },
  kept: { value: 1, weight: 0.5, words: "到点了，没有取消也没有改" },
  edited: { value: 0, weight: 1, words: "改了时间" },
  cancelled: { value: 0, weight: 3, words: "取消了" },
};

// ── 事件 ──────────────────────────────────────────────────────────────────────────

export const TIMER_REQUEST_DECIDED_KIND = "timer.request.decided";
export const TIMER_REQUEST_REQUESTED_KIND = "timer.request.requested";
export const TIMER_REQUEST_RESOLVED_KIND = "timer.request.resolved";
export const TIMER_REQUEST_EXECUTED_KIND = "timer.request.executed";
export const TIMER_LABELED_KIND = "timer.labeled";

export const TIMER_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: TIMER_REQUEST_DECIDED_KIND,
    sources: ["system"],
    payload: Type.Object({
      decision: Literals(TIMER_DECISIONS),
      tool: Literals(TIMER_TOOLS),
      origin: TimerOriginSchema,
      cost: TimerCostSchema,
      reasons: Type.Array(Type.String()),
      // 设了的定时器（{kind, id}）。要确认、拒绝时是 null；要确认时 request 是确认卡的编号。
      timer: Nullable(Type.Object({ kind: Literals(TIMER_KINDS), id: Id })),
      request: Nullable(RequestId),
      summary: Type.String(),
    }),
    description: "外部的一轮里 Lead 要设一个定时器，决策模型的结论：设了、要用户确认、或者碰到底线不设（spec D16）。",
  },
  {
    kind: TIMER_REQUEST_REQUESTED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: RequestId,
      tool: Literals(TIMER_TOOLS),
      // 存下的参数（engine 的 TimerSpec），确认以后原样设。
      spec: Type.Record(Type.String(), Type.Unknown()),
      origin: TimerOriginSchema,
      cost: TimerCostSchema,
      reasons: Type.Array(Type.String()),
      note: Type.String(),
      expiresAt: Type.String({ minLength: 1 }),
    }),
    description: "外部的一轮里要设的定时器代价不够低，系统存下它，等用户在确认卡上决定。",
  },
  {
    kind: TIMER_REQUEST_RESOLVED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: RequestId,
      decision: TimerRequestDecisionSchema,
      actor: Type.Literal("user"),
      resolvedBy: Type.String({ minLength: 1 }),
      bindingId: Nullable(Type.Integer()),
    }),
    description: "用户在定时器的确认卡上点了「设定时器」或「不设」。",
  },
  {
    kind: TIMER_REQUEST_EXECUTED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: RequestId,
      state: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
      timer: Nullable(Type.String()),
      result: Type.String(),
    }),
    description: "用户确认以后，系统照存下的参数设了这个定时器（来源仍然是要求设它的人）。",
  },
  {
    kind: TIMER_LABELED_KIND,
    sources: ["system"],
    payload: Type.Object({
      // 这个样本属于哪个决策（timer.request.decided 的编号）。
      decidedSeq: Id,
      label: Literals(TIMER_LABELS),
      value: Type.Union([Type.Literal(0), Type.Literal(1)]),
      weight: Type.Number({ minimum: 0 }),
      // 外部的来源（例如 slack）：校准按来源算，和回复一样。
      channel: Type.String({ minLength: 1 }),
      // 代价档：决策时的档位。
      level: Type.Integer({ minimum: 0 }),
      timer: Nullable(Type.String()),
      by: Type.Union([Type.Literal("user"), Type.Literal("system")]),
      summary: Type.String(),
    }),
    description: "外部来源的定时器的校准样本：用户确认、不设、取消、改了它，或者它照常到点了。",
  },
];

for (const definition of TIMER_EVENT_KINDS) registerEventKind(definition);
