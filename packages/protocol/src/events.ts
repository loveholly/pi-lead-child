// 事件信封和事件类型的注册表（Lead 事件主干 spec D1、D2，工单 01）。
//
// 所有输入都是事件：写进一条只追加的日志（store 的 events 表），再经过分诊，得到级别和处置。
// 这里只定义信封的形状和每种事件的 payload schema；写入在 packages/store 的 appendEvent。
// 未注册的 kind 不能写入。内部来源的类型是下面的 INTERNAL_EVENT_KINDS；外部来源（通道，工单 11）的类型由
// 通道的 registry 在登记适配器时调用 registerEventKind 注册，来源由 registerExternalEventSource 登记。
//
// payload 的 schema 只钉住核心字段，允许多出来的字段：双写的写入点和 schema 在同一个仓库里，
// 但校验失败会让原来的写入一起回滚，所以这里宁可宽一点（additionalProperties 不设 false）。
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { TICKET_REPLY_ACTIONS_KIND, TicketReplyActionIdSchema } from "./ticket-chat.ts";
import {
  MESSAGE_CONTEXT_EVENT_KIND, MESSAGE_EVENT_KIND, MessageContextPackedPayloadSchema, MessageEventSchema, MessageReceivedPayloadSchema,
} from "./message-events.ts";

// 内部来源：daemon 自己的来源。外部来源（对话型和信号型的通道，工单 11）不在这里，由通道的 registry 调用
// registerExternalEventSource 登记。内核按「是不是内部来源」判断，不按名字（lead-input 的 busyPlacement、分诊的硬性规则）。
export const EVENT_SOURCES = ["user", "ticket", "run", "timer", "lead", "system"] as const;
export type InternalEventSource = typeof EVENT_SOURCES[number];
// 外部来源的名字只在运行时登记，所以类型是 string。`string & {}` 让内部来源的字面量仍然有补全。
export type EventSource = InternalEventSource | (string & {});

// 外部来源的名字：小写字母开头，和常设指令条件里的 sources 一样（standing-orders.ts）。
export const EXTERNAL_EVENT_SOURCE_PATTERN = /^[a-z][a-z0-9_-]*$/;
const externalSources = new Set<string>();

/** 登记一个外部来源（通道的 registry 调用）。同一个名字登记两次不报错；和内部来源重名时报错。 */
export function registerExternalEventSource(source: string): void {
  if (!EXTERNAL_EVENT_SOURCE_PATTERN.test(source)) throw new Error(`外部来源的名字 ${source} 要是小写字母开头的单词`);
  if ((EVENT_SOURCES as readonly string[]).includes(source)) throw new Error(`${source} 是内部来源，不能登记成外部来源`);
  externalSources.add(source);
}

export function isExternalEventSource(source: string): boolean {
  return externalSources.has(source);
}

/** 能写进事件日志的来源：内部来源，或者登记过的外部来源。 */
export function isKnownEventSource(source: unknown): source is EventSource {
  return typeof source === "string" && ((EVENT_SOURCES as readonly string[]).includes(source) || externalSources.has(source));
}

// 分诊后的级别（spec D3）。用户自己发给 Lead 的消息不分诊，级别固定为 conversation。
export const EVENT_LEVELS = ["record", "digest", "auto", "tell", "interrupt", "conversation"] as const;
export type EventLevel = typeof EVENT_LEVELS[number];

// 最终处置（spec D5）。seen 是「回合成功后系统记成看过了」（现有行为，inbox.ts 的 recordSeenDispositions）。
export const EVENT_DISPOSITIONS = [
  "handled_by_rule", "auto_handled", "digested", "told_user", "interrupted_user",
  "handled", "deferred", "no_action", "superseded", "resolved_elsewhere", "seen",
] as const;
export type EventDisposition = typeof EVENT_DISPOSITIONS[number];

// 失败事件的根因（spec D1）。字段名照 spec 写成 snake_case：它原样存进 events.root_cause（JSON）。
export const RootCauseSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  scope: Type.Optional(Type.String()),
  needs: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  next_step: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  // spec D1 之外多记的一项：重试有没有用（Run 的类型化失败里的 retry）。Lead 判断能不能自己修时用。
  retry: Type.Optional(Type.String()),
});
export type RootCause = Static<typeof RootCauseSchema>;

/** 用户确认了一条 interrupt 级的事件（工单 06 的横幅）。 */
export const EVENT_ACKNOWLEDGED_KIND = "event.acknowledged";

// 对象键：类型前缀加冒号，例如 ticket:77、run:91、chat:main、reminder:83。
export const ENTITY_KEY_PATTERN = /^[a-z][a-z0-9_.-]*:.+$/;

/** appendEvent 的输入。没给的时间、编号由 store 补上；没给 level 时由分诊决定。 */
export interface EventEnvelope {
  source: EventSource;
  // 来源自己的投递编号（spec D2）。同一个 (source, sourceRef) 只记一条；没有编号时为空，不去重。
  sourceRef?: string | null;
  kind: string;
  entityKey: string;
  entityVersion?: number | null;
  occurredAt?: string;
  causationId?: string | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  rootCause?: RootCause | null;
  level?: EventLevel;
  eventId?: string;
}

export interface EventKindDefinition {
  kind: string;
  // 这个类型可以来自哪些来源。
  sources: readonly EventSource[];
  payload: TSchema;
  // 异常类：级别是 tell 或 interrupt 时必须带 root_cause（spec D1）。kind 以 .failed 结尾的不论级别都要带。
  anomaly?: boolean;
  // 这种事件能不能了结 Lead 的等待（2026-10-19，lead-waits.ts）：user_action 是用户的一次操作，
  // state_change 是对象的状态变了。不写的（Run 的进展、工具调用记录、Lead 自己的事）不叫醒在等的 Lead。
  waitSignal?: "user_action" | "state_change";
  description: string;
}

const registry = new Map<string, EventKindDefinition>();

export function registerEventKind(definition: EventKindDefinition): void {
  if (registry.has(definition.kind)) throw new Error(`event kind ${definition.kind} is already registered`);
  if (!definition.sources.length) throw new Error(`event kind ${definition.kind} needs at least one source`);
  registry.set(definition.kind, definition);
}

export function eventKindDefinition(kind: string): EventKindDefinition | undefined {
  return registry.get(kind);
}

export function listEventKinds(): EventKindDefinition[] {
  return [...registry.values()];
}

export function eventRequiresRootCause(kind: string, level: EventLevel | null | undefined): boolean {
  if (kind.endsWith(".failed")) return true;
  return Boolean(registry.get(kind)?.anomaly) && (level === "tell" || level === "interrupt");
}

/** 校验一个信封。返回所有问题；空数组表示可以写入。level 是分诊后的级别，用来判断要不要根因。 */
export function validateEventEnvelope(envelope: EventEnvelope, level: EventLevel | null | undefined): string[] {
  const errors: string[] = [];
  const definition = registry.get(envelope.kind);
  if (!definition) return [`事件类型 ${envelope.kind} 没有注册`];
  if (!isKnownEventSource(envelope.source)) {
    errors.push(`source ${String(envelope.source)} 不是已知的来源`);
  } else if (!definition.sources.includes(envelope.source)) {
    errors.push(`${envelope.kind} 的 source 只能是 ${definition.sources.join("、")}，不能是 ${envelope.source}`);
  }
  if (typeof envelope.entityKey !== "string" || !ENTITY_KEY_PATTERN.test(envelope.entityKey)) {
    errors.push(`entityKey ${String(envelope.entityKey)} 要写成「类型:编号」，例如 ticket:77`);
  }
  if (envelope.entityVersion !== undefined && envelope.entityVersion !== null
    && (!Number.isInteger(envelope.entityVersion) || envelope.entityVersion < 1)) {
    errors.push("entityVersion 要是正整数");
  }
  if (envelope.sourceRef !== undefined && envelope.sourceRef !== null
    && (typeof envelope.sourceRef !== "string" || envelope.sourceRef.length === 0)) {
    errors.push("sourceRef 要是非空字符串，或者不给");
  }
  if (envelope.occurredAt !== undefined && Number.isNaN(Date.parse(envelope.occurredAt))) {
    errors.push(`occurredAt ${envelope.occurredAt} 不是时间`);
  }
  if (level !== undefined && level !== null && !(EVENT_LEVELS as readonly string[]).includes(level)) {
    errors.push(`level ${String(level)} 不是已知的级别`);
  }
  if (!Value.Check(definition.payload, envelope.payload ?? {})) {
    const first = [...Value.Errors(definition.payload, envelope.payload ?? {})][0];
    errors.push(`${envelope.kind} 的 payload 不符合 schema${first ? `：${first.instancePath || "/"} ${first.message}` : ""}`);
  }
  if (envelope.rootCause !== undefined && envelope.rootCause !== null && !Value.Check(RootCauseSchema, envelope.rootCause)) {
    errors.push(`${envelope.kind} 的 root_cause 至少要有非空的 code`);
  } else if (eventRequiresRootCause(envelope.kind, level) && !envelope.rootCause) {
    errors.push(`${envelope.kind}（级别 ${level ?? "未定"}）是失败事件，必须带 root_cause`);
  }
  return errors;
}

// ── 第 1 期的内部事件类型 ──────────────────────────────────────────────────────────

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Id = Type.Integer({ minimum: 1 });

const TurnPayload = Type.Object({
  turnId: Type.String({ minLength: 1 }),
  originKind: Type.String({ minLength: 1 }),
  itemId: Type.Optional(Nullable(Id)),
});
const TurnFailedPayload = Type.Object({
  turnId: Type.String({ minLength: 1 }),
  originKind: Type.String({ minLength: 1 }),
  itemId: Type.Optional(Nullable(Id)),
  error: Type.String(),
  // true：这一轮在等自动重试（channel_turns 回到 queued），用户的消息还没有结局。
  willRetry: Type.Boolean(),
});

const RunPayload = Type.Object({
  runId: Id,
  itemId: Id,
  role: Type.String(),
  purpose: Type.String(),
  runtime: Type.String(),
  from: Type.String(),
  to: Type.String(),
  exitCode: Type.Optional(Nullable(Type.Integer())),
  errorCode: Type.Optional(Nullable(Type.String())),
});

const InboxPayload = Type.Object({
  inboxId: Id,
  itemId: Nullable(Id),
  scope: Type.String({ minLength: 1 }),
  severity: Type.Union([Type.Literal("blocker"), Type.Literal("attention")]),
  inboxSource: Type.Union([Type.Literal("structural"), Type.Literal("semantic")]),
  summary: Type.String(),
  inboxKind: Type.Optional(Nullable(Type.String())),
  // 这一条自己的叫醒标记和要不要用户（inbox.ts 的 inboxWakesLead、inboxNeedsUser）。
  wakeLead: Type.Boolean(),
  needsUser: Type.Boolean(),
  // row：这一条自己有一行 inbox；merged：并进了同 scope 的 attention 行；folded：被熔断折进「异常频繁」的行。
  delivery: Type.Union([Type.Literal("row"), Type.Literal("merged"), Type.Literal("folded")]),
  // 只在 folded 时有：这一条打开了熔断的聚合行（之后折进来的只加计数）。
  fuseOpened: Type.Optional(Type.Boolean()),
  // 这一条原始的 inbox payload，原样保留。
  payload: Type.Record(Type.String(), Type.Unknown()),
});

// 关于 Lead 自己的事件（工单 14）：以前是 daemon 内存里的 leadSelfNotes，重启就丢。现在写进日志，
// 按 Lead 的事件游标交给它：当前局面里单独一节「关于你自己」，不按预算截断。entity_key 都是 LEAD_SELF_ENTITY_KEY。
export const LEAD_SELF_EVENT_KINDS = ["lead.compaction_failed", "lead.model_switched"] as const;
export const LEAD_SELF_ENTITY_KEY = "lead:main";

export const INTERNAL_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: "user.message",
    sources: ["user"],
    waitSignal: "user_action",
    payload: Type.Object({
      turnId: Type.String({ minLength: 1 }),
      originKind: Type.String({ minLength: 1 }),
      itemId: Type.Optional(Nullable(Id)),
      text: Type.String(),
      // 统一的消息事件（unified-message-events spec D1，工单 03）：你本人的入口也产生同一个结构，只做身份校验，不分诊。
      message: Type.Optional(MessageEventSchema),
    }),
    description: "用户发来的一条消息（channel_turns 新建了一轮）。",
  },
  {
    // 统一的消息事件（unified-message-events spec D1、D2，工单 03）：外部通道的一条消息通过了共用入站层（message-events.ts）。
    // tell 级：Lead 单独一轮看到它，正文包在外部标签里。Lead 处理以前对方改了消息，换成并进编辑的新一条，旧的记成 superseded。
    kind: MESSAGE_EVENT_KIND,
    sources: ["system"],
    payload: MessageReceivedPayloadSchema,
    description: "别人在外部通道发给你的一条消息通过了入站判断，交给 Lead：正文是外部的，带前置处理的结论和权限上限。",
  },
  {
    // 上下文包（unified-message-events spec D5，工单 04）：消息事件的上下文包拼好了。record 级，只记大小（多少条、多少字、
    // 缺了哪几项、拼了多久），不记内容，给 token 成本的统计用。
    kind: MESSAGE_CONTEXT_EVENT_KIND,
    sources: ["system"],
    payload: MessageContextPackedPayloadSchema,
    description: "一条外部消息事件的上下文包拼好了：多少条、多少字、缺了哪几项。",
  },
  {
    kind: "lead.turn_completed",
    sources: ["lead"],
    payload: TurnPayload,
    description: "Lead 的一轮答完了。",
  },
  {
    kind: "lead.turn_failed",
    sources: ["lead"],
    payload: TurnFailedPayload,
    description: "Lead 的一轮失败了（模型报错、断网、被重启打断、没有回复）。",
  },
  {
    // Lead 自己的上下文压缩失败了（spec D9，工单 02；工单 14 从内存队列改成事件，重启不丢）。
    // 级别按来源 lead 的默认指令（source.lead）：record。它不单独叫醒 Lead，写进下一轮的当前局面「关于你自己」一节。
    // kind 以 .failed 结尾，必须带 root_cause。
    kind: "lead.compaction_failed",
    sources: ["lead"],
    payload: Type.Object({
      // pi 给的压缩原因（threshold、overflow）。
      reason: Type.String(),
      detail: Type.String(),
      timedOut: Type.Boolean(),
      // 写给 Lead 的话：当前局面里原样给它。
      note: Type.String({ minLength: 1 }),
    }),
    description: "Lead 的上下文压缩失败了（pi 报错，或者超时被 daemon 中止）。",
  },
  {
    // Lead 的模型换了（spec D9，工单 02；工单 14 改成事件）：一轮遇到限流后按 lead.models 的顺序换下一个，
    // 或者限流的恢复时间到了换回第一个。级别同上：record，写进这一轮（用新模型跑的那一轮）的当前局面。
    kind: "lead.model_switched",
    sources: ["lead"],
    payload: Type.Object({
      from: Type.String(),
      to: Type.String({ minLength: 1 }),
      reason: Type.String(),
      // true：换回第一个模型。
      restored: Type.Boolean(),
      // 什么时候换回第一个模型（ISO）；没有时是 null。
      restoreAt: Nullable(Type.String()),
      note: Type.String({ minLength: 1 }),
      // true：要告诉用户（2026-10-19）。这时级别是 tell，Lead 不说时系统替它说。
      mustTell: Type.Optional(Type.Boolean()),
    }),
    description: "Lead 的模型换了：限流、额度用尽、授权失败、模型不可用后换下一个，或者恢复时间到了换回第一个。",
  },
  {
    // Lead 把一件事交给用户自己去做（lead-tools-and-routing spec D14）：Lead 用 record_handback 记。只记录，不再交回给 Lead。
    // category：floor 碰到底线；presence 要用户本人在场（登录、Touch ID、付款、他自己的决定）；gap 能力缺口（系统缺工具或权限）。
    // 属于能力缺口的推回就是要修的缺陷，get_system_usage 按类别数。
    kind: "lead.handed_back",
    sources: ["lead"],
    payload: Type.Object({
      category: Type.Union([Type.Literal("floor"), Type.Literal("presence"), Type.Literal("gap")]),
      what: Type.String({ minLength: 1 }),
      reason: Type.String(),
      turnId: Nullable(Type.String()),
    }),
    description: "Lead 把一件事交给用户自己去做：碰到底线、要用户本人在场，或者系统缺工具、缺权限（能力缺口）。",
  },
  {
    kind: "ticket_agent.turn_completed",
    sources: ["ticket"],
    payload: TurnPayload,
    description: "工单对话里，工单的 agent 答完了一轮。",
  },
  {
    kind: "ticket_agent.turn_failed",
    sources: ["ticket"],
    payload: TurnFailedPayload,
    description: "工单对话里，工单的 agent 这一轮没有答完。",
  },
  {
    // 工单 agent 的这段回复在等你决定要不要做哪几个动作（2026-10-19，SmartModel 判断，daemon 的 ticket-reply-actions.ts）。
    // record 级，写入时就记处置 handled_by_rule：它只给界面用，不交给 Lead，也不进影子分诊。
    kind: TICKET_REPLY_ACTIONS_KIND,
    sources: ["ticket"],
    payload: Type.Object({
      turnId: Type.String({ minLength: 1 }),
      itemId: Id,
      actions: Type.Array(TicketReplyActionIdSchema),
      // 回答这次判断的后端（jev、llm）。
      backend: Type.String(),
    }),
    description: "工单对话里，SmartModel 判断工单 agent 的回复在问用户要不要做哪几个动作。",
  },
  {
    kind: "stage.changed",
    sources: ["ticket"],
    waitSignal: "state_change",
    payload: Type.Object({
      itemId: Id,
      itemKind: Type.Union([Type.Literal("task"), Type.Literal("reminder")]),
      from: Type.String(),
      to: Type.String(),
      actor: Type.String(),
      reason: Type.String(),
      runId: Type.Optional(Nullable(Id)),
      // Lead 在用户这一轮里代用户走的边（工单操作层）：actor 是 lead，onBehalfOf 是 user，sourceTurnId 是那一轮。
      onBehalfOf: Type.Optional(Type.Literal("user")),
      sourceTurnId: Type.Optional(Type.String()),
      // Lead 凭用户的长期授权（plc trust lead --confirm）走的边：actor 是 lead，onBehalfOf 是 user，这里是哪一份授权。
      underGrant: Type.Optional(Type.Object({ grantId: Id, capability: Type.String() })),
      // Lead 凭自己的权限走的边，但是用户在自己这一轮里让它做的：那一轮的编号（只记出处，不是授权）。
      requestedInTurn: Type.Optional(Type.String()),
    }),
    description: "工单或提醒的 stage 变了（items.ts 的 transition）。",
  },
  {
    kind: "checkpoint.recorded",
    sources: ["ticket"],
    payload: Type.Object({
      checkpointId: Id,
      itemId: Id,
      runId: Nullable(Id),
      checkpointKind: Type.String(),
      checkpointSource: Type.String(),
      title: Type.String(),
      summary: Type.String(),
      nextStep: Type.Optional(Nullable(Type.String())),
    }),
    description: "工单记了一个 checkpoint。",
  },
  { kind: "run.started", sources: ["run"], payload: RunPayload, description: "Run 起来了（starting → running）。" },
  { kind: "run.resumed", sources: ["run"], payload: RunPayload, description: "暂停的 Run 恢复了（paused → running）。" },
  { kind: "run.paused", sources: ["run"], payload: RunPayload, description: "Run 被暂停了。" },
  { kind: "run.finished", sources: ["run"], payload: RunPayload, description: "Run 正常结束了。" },
  { kind: "run.failed", sources: ["run"], payload: RunPayload, description: "Run 失败了，root_cause 来自 runs 的类型化失败和错误码。" },
  { kind: "run.stopped", sources: ["run"], payload: RunPayload, description: "Run 被停止了。" },
  {
    kind: "inbox.blocker",
    sources: ["system"],
    payload: InboxPayload,
    anomaly: true,
    description: "交给 Lead 的一条 blocker（inbox）。",
  },
  {
    kind: "inbox.attention",
    sources: ["system"],
    payload: InboxPayload,
    description: "交给 Lead 的一条 attention（inbox）。",
  },
  {
    kind: "notification.created",
    sources: ["system"],
    payload: Type.Object({
      notificationId: Id,
      itemId: Nullable(Id),
      notificationKind: Type.String(),
      urgency: Type.Union([Type.Literal("immediate"), Type.Literal("batchable")]),
      title: Type.String(),
      body: Type.String(),
      dedupKey: Nullable(Type.String()),
    }),
    description: "给用户的一条通知（notifications）。",
  },
  {
    kind: "timer.fired",
    sources: ["timer"],
    payload: Type.Object({
      timer: Type.Union([Type.Literal("reminder"), Type.Literal("lead_followup")]),
      scheduledAt: Type.String(),
      itemId: Type.Optional(Nullable(Id)),
      inboxId: Type.Optional(Id),
      title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      wakeLead: Type.Boolean(),
    }),
    description: "定时器到点：提醒到点，或者 Lead 给自己设的跟进到点。",
  },
  {
    // 到时限还没有处置的事件升一级（spec D3，工单 05）：原事件记成 superseded，指向这一条；这一条带着更高的级别，
    // 按游标读日志的人（04）能读到它。entity_key、correlation_id、root_cause 照抄原事件。
    kind: "event.escalated",
    sources: ["system"],
    payload: Type.Object({
      escalatedSeq: Id,
      escalatedEventId: Type.String({ minLength: 1 }),
      escalatedKind: Type.String({ minLength: 1 }),
      escalatedSource: Type.String({ minLength: 1 }),
      fromLevel: Type.String(),
      toLevel: Type.String(),
      // 原事件收到以后等了多久（毫秒）。
      waitedMs: Type.Integer({ minimum: 0 }),
      summary: Type.String(),
      // 按根因合并进原事件的那些事件（seq）。
      mergedSeqs: Type.Array(Id),
    }),
    description: "一个事件到时限还没有处置，按常设指令升了一级。原事件记成 superseded，指向这一条。",
  },
  {
    // 一条常设指令写了新版本（spec D4，工单 10）：Lead 更保守的修改直接生效、用户批准了 Lead 的修改，或者用户在设置页回滚。
    // 级别由写入方定（digest：在「Lead 动态」里告诉用户），依据是硬性规则 standing_order_change_reported，常设指令改不了它。
    // entity_key 是 standing_order:<编号>，entity_version 是新版本号。Lead 写的来源是 lead，用户写的来源是 system
    // （来源 user 只给用户发给 Lead 的消息）。
    kind: "standing_order.changed",
    sources: ["lead", "system"],
    payload: Type.Object({
      orderId: Type.String({ minLength: 1 }),
      version: Id,
      // 改之前的最新版本。新增的指令是 null。
      previousVersion: Nullable(Type.Integer({ minimum: 0 })),
      title: Type.String(),
      author: Type.Union([Type.Literal("lead"), Type.Literal("user")]),
      approvedBy: Nullable(Type.String()),
      change: Type.String({ minLength: 1 }),
      // conservative：Lead 的更保守的修改；permissive：用户批准了 Lead 的修改；user：用户自己改的。
      tier: Type.String({ minLength: 1 }),
      reason: Type.String(),
      summary: Type.String(),
      approvalId: Type.Optional(Nullable(Id)),
      rolledBackTo: Type.Optional(Nullable(Id)),
    }),
    description: "一条常设指令写了新版本：Lead 更保守的修改、用户批准的修改，或者用户的回滚。",
  },
  {
    // 用户在输入框上方的横幅上点了「知道了」（spec D10，工单 06）：确认了一条 interrupt 级的事件。
    // 这是用户的动作，不是用户发给 Lead 的消息，所以来源是 system（来源 user 只给用户发给 Lead 的消息）。
    // entity_key 照抄被确认的事件，causation_id 是它的 event_id；source_ref 是 ack:<event_id>，同一条只记一次。
    // 级别是 record：横幅靠它判断「用户确认过了」，Lead 的当前局面里只记一行。被确认的事件同时记处置 interrupted_user。
    kind: EVENT_ACKNOWLEDGED_KIND,
    sources: ["system"],
    waitSignal: "user_action",
    payload: Type.Object({
      acknowledgedSeq: Id,
      acknowledgedEventId: Type.String({ minLength: 1 }),
      acknowledgedKind: Type.String({ minLength: 1 }),
      // 点「知道了」的那个客户端（binding）。
      bindingId: Nullable(Id),
    }),
    description: "用户确认了一条 interrupt 级的事件（横幅上的「知道了」）。被确认的事件记成 interrupted_user。",
  },
  {
    // 双写阶段（spec D15）的保护：一条事件构造、校验或分诊出错时，原来的写入照常提交，日志里改记这一条。
    // schema 尽量宽：原来的信封可能根本没有构造出来。
    kind: "system.event_rejected",
    sources: ["system"],
    payload: Type.Object({
      rejectedKind: Type.Optional(Nullable(Type.String())),
      rejectedSource: Type.Optional(Nullable(Type.String())),
      rejectedSourceRef: Type.Optional(Nullable(Type.String())),
      entityKey: Type.Optional(Nullable(Type.String())),
      error: Type.String(),
    }),
    description: "一条双写的事件没有写成（构造、注册、校验或分诊出错），原来的写入照常提交。",
  },
];

for (const definition of INTERNAL_EVENT_KINDS) registerEventKind(definition);
