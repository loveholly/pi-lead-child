import { Type, type Static, type TProperties } from "typebox";
import { ReminderCardSchema } from "./reminders.ts";
import { SetupChecklistCardSchema, SetupHintCardSchema } from "./setup.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// Lead 处理了、但没有对用户说的事（2026-10-15 方案 A「Lead 动态」）。会话里收成一块淡色的动态，不占对话回合。
// 只有 Lead 自己说了处置的事：deferred（延后）、no_action（不处理）、handled（自己处理好了）。
// 告诉过用户的已经在对话里；自动记的「看过了」和取消的跟进是 Lead 的内部记账，都不列。
export const LEAD_ACTIVITY_DISPOSITIONS = ["handled", "deferred", "no_action"] as const;

export const LeadActivityItemSchema = StrictObject({
  // inbox 行的 id：Lead 在对话里说「#108」时指的就是它。
  id: Type.Integer({ minimum: 1 }),
  // Lead 记下处置的时间。
  at: Type.String(),
  disposition: Type.Union([Type.Literal("handled"), Type.Literal("deferred"), Type.Literal("no_action")]),
  // Lead 写的理由。
  reason: Type.String(),
  // 这件事本身（系统写的摘要）。
  summary: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type LeadActivityItem = Static<typeof LeadActivityItemSchema>;

export const LeadActivityListResponseSchema = StrictObject({
  items: Type.Array(LeadActivityItemSchema),
});
export type LeadActivityListResponse = Static<typeof LeadActivityListResponseSchema>;

// ── 工单 06：会话里的卡片和状态（Lead 事件主干 spec D10、D16）────────────────────────────────
//
// 「Lead 动态」从事件日志算出来，一个对象一张卡：
//   · digest（摘要）、auto（自动处理）级的事件，和常设指令的修改（standing_order.changed），写进日志就出现在会话里，
//     不进 Lead 的模型（工单 04 已经保证），也不打断 Lead 正在写的回答；record 级只进时间轴和工单详情，不进会话。
//   · 同一个对象（entity_key）的事件合成一张卡，状态原地更新；Lead 后来记下的处置（理由）挂在同一张卡下面，不另起气泡。
//   · 每张卡写明依据：分诊时用的常设指令的编号和版本（事件的 triage 字段），和起作用的硬性规则。
//   · interrupt 级的事件不进「Lead 动态」，在输入框上方显示横幅，用户点「知道了」之前一直在。
//   · 别处已处理（处置是 resolved_elsewhere）的卡片显示为结束状态，横幅不再提醒。
// 旧客户端按 StrictObject 校验 GET /v1/lead/activity 的 items，所以新的形状只在客户端要（include=events）时才给。

/** 网关的选收事件名：连接时声明 include=lead_activity 才会收到「Lead 动态」的推送（protocol 的 gatewayEventOptIn）。 */
export const LEAD_ACTIVITY_OPT_IN = "lead_activity";
/** snapshot.required 的 resource：「Lead 动态」的投影变了。payload 带 entityKey、entityVersion 和变化后的卡片。 */
export const LEAD_ACTIVITY_RESOURCE = "lead-activity";
/** GET /v1/lead/activity?include=events：返回 LeadActivityView。 */
export const LEAD_ACTIVITY_INCLUDE = "events";
/** 再加 include=reminders（工单 07）：LeadActivityView 带上会话里的提醒卡（reminders）。旧 daemon 不认识它，回的 view 没有这一项。 */
export const LEAD_ACTIVITY_REMINDERS_INCLUDE = "reminders";
// include=setup：再带上首次启动引导的准备清单卡和建议卡（.scratch/onboarding）。
export const LEAD_ACTIVITY_SETUP_INCLUDE = "setup";

// 一条依据：常设指令（编号、版本，effect 是它起的作用，例如 inbox_merged），或者硬性规则（写在代码里，不进常设指令表）。
// version 为 0 表示库里读不到，用的是代码里的种子。
export const LeadActivityBasisSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("order"),
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 0 }),
    effect: Type.Optional(Type.String()),
  }),
  StrictObject({ kind: Type.Literal("rule"), name: Type.String({ minLength: 1 }) }),
]);
export type LeadActivityBasis = Static<typeof LeadActivityBasisSchema>;

// 卡片的类别：digest 摘要、auto 自动处理、standing_order 常设指令改了、lead（Lead 自己处理掉、没有对用户说的事）。
export const LEAD_ACTIVITY_CARD_KINDS = ["digest", "auto", "standing_order", "lead"] as const;
export type LeadActivityCardKind = typeof LEAD_ACTIVITY_CARD_KINDS[number];

// 卡片的状态：
//   open：还有事件没有处置（Lead 还没看）；seen：都有处置了（Lead 看过、规则处理掉、按根因合并、升级）；
//   handled：Lead 记下了处置和理由（挂在卡下面）；resolved_elsewhere：别处已处理，结束状态，不再提醒。
export const LEAD_ACTIVITY_CARD_STATES = ["open", "seen", "handled", "resolved_elsewhere"] as const;
export type LeadActivityCardState = typeof LEAD_ACTIVITY_CARD_STATES[number];

export const LeadActivityEntrySchema = StrictObject({
  seq: Type.Integer({ minimum: 1 }),
  at: Type.String(),
  kind: Type.String(),
  level: Type.Union([Type.String(), Type.Null()]),
  summary: Type.String(),
});
export type LeadActivityEntry = Static<typeof LeadActivityEntrySchema>;

export const LeadActivityNoteSchema = StrictObject({
  disposition: Type.Union([Type.Literal("handled"), Type.Literal("deferred"), Type.Literal("no_action")]),
  reason: Type.String(),
  at: Type.String(),
});
export type LeadActivityNote = Static<typeof LeadActivityNoteSchema>;

export const LEAD_ACTIVITY_LIMITS = { basis: 8, entries: 5 } as const;

export const LeadActivityOwnerActionSchema = StrictObject({
  // 主人操作的事件编号：和会话里那一轮的编号（ownerActionTurnId）对得上。
  eventId: Type.String({ minLength: 1 }),
  action: Type.String({ minLength: 1 }),
  // 对你说的那句话：「允许GitHub写入：在 PR #119 …」。
  summary: Type.String(),
  // 操作的对象：「GitHub 的写入确认」。同一个对象的同一种操作在会话里合成一行。
  target: Type.String(),
  // 操作做了，但结果没成（写入确认执行失败）。
  failed: Type.Boolean(),
});
export type LeadActivityOwnerAction = Static<typeof LeadActivityOwnerActionSchema>;

// 卡上的一个按钮：一个操作层的操作（ui-actions.ts），页面按 POST /v1/actions/<target.type>/<target.id>/<action> 调它，
// input 是 {}。例如 Lead 改了常驻偏好，卡上带「撤销」：{target: {type: "core_memory_change", id: "<改动编号>"}, action: "undo"}。
// 网关算卡时用操作层的同一个判断：现在做不了时卡上没有这个字段。
export const LeadActivityCardActionSchema = StrictObject({
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  action: Type.String({ minLength: 1, maxLength: 64 }),
  // 按钮上的字，例如「撤销」。
  label: Type.String({ minLength: 1 }),
});
export type LeadActivityCardAction = Static<typeof LeadActivityCardActionSchema>;

export const LeadActivityCardSchema = StrictObject({
  // 卡的身份：<对象键>@<这张卡第一条事件的 seq>；没有事件的旧处置（工单 04 之前的 inbox 行）是 inbox:<id>。
  key: Type.String({ minLength: 1 }),
  // 卡属于哪个对象（spec D1 的 entity_key）：ticket:77、reminder:83、standing_order:inbox.wake_lead。
  entityKey: Type.String({ minLength: 1 }),
  // 投影的版本（spec D16）：来一条事件、记一条处置都变大。客户端只接受不比手上旧的版本。
  entityVersion: Type.Integer({ minimum: 1 }),
  // 卡里最新一条事件的 seq。旧处置是 0。客户端用它和快照的 watermark 比，认出快照之后才有的卡。
  lastSeq: Type.Integer({ minimum: 0 }),
  // 卡在会话里的位置：第一条事件发生的时间（旧处置是 Lead 记下处置的时间）。状态原地更新，位置不变。
  at: Type.String(),
  updatedAt: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  kind: Type.Union([Type.Literal("digest"), Type.Literal("auto"), Type.Literal("standing_order"), Type.Literal("lead")]),
  state: Type.Union([Type.Literal("open"), Type.Literal("seen"), Type.Literal("handled"), Type.Literal("resolved_elsewhere")]),
  // 最新一条事件说的事。
  summary: Type.String(),
  // 这张卡合了几条事件。
  count: Type.Integer({ minimum: 1 }),
  // 依据：最新一条事件的分诊依据（常设指令的编号和版本，硬性规则）。
  basis: Type.Array(LeadActivityBasisSchema, { maxItems: LEAD_ACTIVITY_LIMITS.basis }),
  // Lead 后来的补充：它记下的处置和理由。没有时是 null。
  lead: Type.Union([LeadActivityNoteSchema, Type.Null()]),
  // 最近几条事件，新的在后。
  entries: Type.Array(LeadActivityEntrySchema, { maxItems: LEAD_ACTIVITY_LIMITS.entries }),
  // 这件事是你允许以后才做的（2026-10-28 改版稿第 2 组）：同一个对象上你做的主人操作（owner_action.performed）。
  // 会话里那一行「你刚刚允许…」按 eventId 并进这一行，不再单独画。没有时不带这个字段（旧客户端照常读）。
  ownerAction: Type.Optional(LeadActivityOwnerActionSchema),
  // 卡上能点的操作（2026-10-29：Lead 改了常驻偏好，带「撤销」）。卡里最新一条事件是 Lead 的、现在还能撤销的改动时才有；
  // 撤销以后同一张卡原地更新，这个字段没了。没有时不带这个字段（旧客户端照常读）。
  action: Type.Optional(LeadActivityCardActionSchema),
});
export type LeadActivityCard = Static<typeof LeadActivityCardSchema>;

export const LeadInterruptSchema = StrictObject({
  // interrupt:<seq>
  key: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 1 }),
  entityKey: Type.String({ minLength: 1 }),
  // 用户确认、别处已处理、Lead 记处置都会让它变大。
  entityVersion: Type.Integer({ minimum: 1 }),
  lastSeq: Type.Integer({ minimum: 1 }),
  at: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  kind: Type.String(),
  summary: Type.String(),
  rootCause: Type.Union([StrictObject({ code: Type.String(), message: Type.Optional(Type.String()) }), Type.Null()]),
  basis: Type.Array(LeadActivityBasisSchema, { maxItems: LEAD_ACTIVITY_LIMITS.basis }),
  // 用户点「知道了」的时间。没确认、也不是别处已处理的，横幅一直在。
  acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
  resolvedElsewhere: Type.Boolean(),
});
export type LeadInterrupt = Static<typeof LeadInterruptSchema>;

/** 横幅上要不要显示它：用户还没确认，也不是别处已处理的。 */
export function leadInterruptOpen(interrupt: Pick<LeadInterrupt, "acknowledgedAt" | "resolvedElsewhere">): boolean {
  return interrupt.acknowledgedAt === null && !interrupt.resolvedElsewhere;
}

export const LeadActivityViewSchema = StrictObject({
  // 旧的在前。
  cards: Type.Array(LeadActivityCardSchema),
  // 横幅上的事：还没确认的 interrupt 级事件，旧的在前。
  interrupts: Type.Array(LeadInterruptSchema),
  // 算这份快照时事件日志的最大 seq。
  watermark: Type.Integer({ minimum: 0 }),
  // 会话里的提醒卡（工单 07），旧的在前。只在客户端要（include=reminders）时才有。
  reminders: Type.Optional(Type.Array(ReminderCardSchema)),
  // 首次启动引导（.scratch/onboarding）：准备清单卡（没有时是 null）和建议卡（旧的在前）。只在客户端要（include=setup）时才有。
  setup: Type.Optional(Type.Union([SetupChecklistCardSchema, Type.Null()])),
  setupHints: Type.Optional(Type.Array(SetupHintCardSchema)),
});
export type LeadActivityView = Static<typeof LeadActivityViewSchema>;

/** 「Lead 动态」投影变化的推送（snapshot.required 的 payload）。card、interrupt、reminder 只有一个。 */
export const LeadActivityPushSchema = Type.Object({
  resource: Type.Literal(LEAD_ACTIVITY_RESOURCE),
  entityKey: Type.String({ minLength: 1 }),
  entityVersion: Type.Integer({ minimum: 1 }),
  card: Type.Optional(LeadActivityCardSchema),
  interrupt: Type.Optional(LeadInterruptSchema),
  // 会话里的一张提醒卡（工单 07）。旧客户端不认识这一项，忽略它（payload 的校验是开放的）。
  reminder: Type.Optional(ReminderCardSchema),
  // 准备清单卡、一张建议卡（首次启动引导）。旧客户端忽略。
  setup: Type.Optional(SetupChecklistCardSchema),
  setupHint: Type.Optional(SetupHintCardSchema),
}, { additionalProperties: true });
export type LeadActivityPush = Static<typeof LeadActivityPushSchema>;

export const LeadInterruptAckResponseSchema = StrictObject({ interrupt: LeadInterruptSchema });
export type LeadInterruptAckResponse = Static<typeof LeadInterruptAckResponseSchema>;

/** 旧 daemon（没有 include=events）给的一条 Lead 处置，换成卡片：一行 inbox 一张卡，没有依据，版本是 1。 */
export function leadActivityCardFromItem(item: LeadActivityItem): LeadActivityCard {
  return {
    key: `inbox:${item.id}`,
    entityKey: item.ticketId !== null ? `ticket:${item.ticketId}` : `inbox:${item.id}`,
    entityVersion: 1,
    lastSeq: 0,
    at: item.at,
    updatedAt: item.at,
    ticketId: item.ticketId,
    kind: "lead",
    state: "handled",
    summary: item.summary,
    count: 1,
    basis: [],
    lead: { disposition: item.disposition, reason: item.reason, at: item.at },
    entries: [],
  };
}
