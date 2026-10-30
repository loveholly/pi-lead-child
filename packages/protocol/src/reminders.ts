// 提醒的级别、提前提醒、重复推送、准时送达（Lead 事件主干 spec D11，工单 07）。
//
// 一条提醒（items.kind = reminder）创建时由 Lead 定下这些设置，存在 items.reminder_policy（JSON，v48）：
//   · level：interrupt（有时效的事，例如「9 点抢票」）或 tell（普通的事）。拿不准时 Lead 问用户。
//     到点时按它把提醒交给 Lead：interrupt 插进 Lead 正在进行的回合，tell 排在这一轮后面。
//   · earlyMs：提前多久先推一次（例如 9:00 的提醒 8:55 先推）。null 表示不提前。
//   · repeat：没确认时每隔 everyMs 再推一次，最多 max 次（不含到点的那一次）。null 表示不重复。
//   · ticketId：这条提醒关联的工单（可选）。check：到点时 Lead 要先查的事（可选）。两者有一个时，到点后 Lead 先查，
//     再把结果写到提醒卡上；用户已经确认也照样交给 Lead。
// 没有设置的提醒（v48 之前建的）按 tell、不提前、不重复处理（DEFAULT_REMINDER_POLICY）。
//
// 到点时三件事同时发生，前两件不等 Lead（daemon 的 scheduler 那一拍）：
//   1. 准时推送：常设指令 reminder.fire，daemon 直接推（Slack、桌面），每次推送记一条 reminder.pushed，带依据；
//   2. 会话里马上出现到点卡：到点事件（timer.fired）写进日志，「Lead 动态」的投影推出一张提醒卡（ReminderCard）；
//   3. 按级别交给 Lead。
// 这个文件只依赖 typebox 和同包的 events.ts，companion 也读它。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const REMINDER_LEVELS = ["interrupt", "tell"] as const;
export type ReminderLevel = typeof REMINDER_LEVELS[number];

export function isReminderLevel(value: unknown): value is ReminderLevel {
  return typeof value === "string" && (REMINDER_LEVELS as readonly string[]).includes(value);
}

const ReminderLevelSchema = Type.Union([Type.Literal("interrupt"), Type.Literal("tell")]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 设置的上下限。写入时校验；Lead 的工具参数按分钟给，换算成毫秒。 */
export const REMINDER_LIMITS = {
  earlyMinMs: MINUTE,
  earlyMaxMs: 24 * HOUR,
  repeatMinEveryMs: MINUTE,
  repeatMaxEveryMs: 24 * HOUR,
  repeatMaxCount: 20,
  checkMaxChars: 300,
} as const;

/** 「10 分钟后再提醒」。 */
export const REMINDER_SNOOZE_MS = 10 * MINUTE;

export const ReminderRepeatSchema = StrictObject({
  everyMs: Type.Integer({ minimum: REMINDER_LIMITS.repeatMinEveryMs, maximum: REMINDER_LIMITS.repeatMaxEveryMs }),
  // 重复几次，不含到点的那一次。
  max: Type.Integer({ minimum: 1, maximum: REMINDER_LIMITS.repeatMaxCount }),
});
export type ReminderRepeat = Static<typeof ReminderRepeatSchema>;

export const ReminderPolicySchema = StrictObject({
  level: ReminderLevelSchema,
  earlyMs: Nullable(Type.Integer({ minimum: REMINDER_LIMITS.earlyMinMs, maximum: REMINDER_LIMITS.earlyMaxMs })),
  repeat: Nullable(ReminderRepeatSchema),
  ticketId: Nullable(Type.Integer({ minimum: 1 })),
  check: Nullable(Type.String({ minLength: 1, maxLength: REMINDER_LIMITS.checkMaxChars })),
});
export type ReminderPolicy = Static<typeof ReminderPolicySchema>;

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = Object.freeze({
  level: "tell", earlyMs: null, repeat: null, ticketId: null, check: null,
}) as ReminderPolicy;

/** 写入前的校验。返回所有问题；空数组表示可以写。 */
export function reminderPolicyErrors(policy: unknown): string[] {
  if (Value.Check(ReminderPolicySchema, policy)) return [];
  return [...Value.Errors(ReminderPolicySchema, policy)].slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message}`);
}

/**
 * 读 items.reminder_policy。NULL（v48 之前建的提醒）是缺省设置。
 * 读不懂的内容不抛错：级别读得出来就用它，其余按缺省；读不出来时整份按缺省。到点推送不能因为一列坏了就不发。
 */
export function parseReminderPolicy(raw: string | null | undefined): ReminderPolicy {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_REMINDER_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_REMINDER_POLICY;
  }
  if (Value.Check(ReminderPolicySchema, parsed)) return parsed;
  const level = parsed && typeof parsed === "object" ? (parsed as { level?: unknown }).level : undefined;
  return isReminderLevel(level) ? { ...DEFAULT_REMINDER_POLICY, level } : DEFAULT_REMINDER_POLICY;
}

/** 到点后要不要 Lead 先查一件事（关联了工单，或者写了要查的事）。 */
export function reminderNeedsCheck(policy: Pick<ReminderPolicy, "ticketId" | "check">): boolean {
  return policy.ticketId !== null || policy.check !== null;
}

/** 一次到点一共会推几次（到点的那一次加重复的次数）。 */
export function reminderPlannedPushes(policy: Pick<ReminderPolicy, "repeat">): number {
  return 1 + (policy.repeat?.max ?? 0);
}

// ── 事件 ──────────────────────────────────────────────────────────────────────────

/** daemon 推送了一次提醒（准时、提前或重复）。依据是常设指令 reminder.fire（triage 字段）。 */
export const REMINDER_PUSHED_KIND = "reminder.pushed";
/** 重复推送到了上限，用户还没确认：进「待你」托盘和回来简报（digest 级）。 */
export const REMINDER_UNACKNOWLEDGED_KIND = "reminder.unacknowledged";
/**
 * Lead 的一轮在回应哪些事件（工单 07）。daemon 为一件事单独开一轮、这一轮落成会话里的一轮时记下。
 * 界面据此把这一轮说的话挂在那件事的卡下面，不另起气泡。现在只给提醒用。
 */
export const LEAD_TURN_RESPONDING_KIND = "lead.turn_responding";

export const REMINDER_PUSH_OCCASIONS = ["early", "due", "repeat"] as const;
export type ReminderPushOccasion = typeof REMINDER_PUSH_OCCASIONS[number];

const ReminderPushedPayload = Type.Object({
  itemId: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  // 这一次到点对应的提醒时刻（items.remind_at）。同一次到点的推送都带同一个值。
  remindAt: Type.String({ minLength: 1 }),
  occasion: Type.Union([Type.Literal("early"), Type.Literal("due"), Type.Literal("repeat")]),
  // 这一次到点的第几次推送（提前的那一次是 0）。
  attempt: Type.Integer({ minimum: 0 }),
  // 这一次到点一共会推几次（reminderPlannedPushes）。
  planned: Type.Integer({ minimum: 1 }),
  level: ReminderLevelSchema,
  text: Type.String(),
});

export const REMINDER_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: REMINDER_PUSHED_KIND,
    sources: ["timer"],
    payload: ReminderPushedPayload,
    description: "daemon 按常设指令 reminder.fire 推送了一次提醒：提前、准时或没确认时的重复。",
  },
  {
    kind: REMINDER_UNACKNOWLEDGED_KIND,
    sources: ["timer"],
    waitSignal: "state_change",
    payload: Type.Object({
      itemId: Type.Integer({ minimum: 1 }),
      title: Type.String(),
      remindAt: Type.String({ minLength: 1 }),
      pushes: Type.Integer({ minimum: 1 }),
      summary: Type.String(),
    }),
    description: "提醒推到了重复的上限，用户还没确认。留在「待你」托盘，进回来简报。",
  },
  {
    kind: LEAD_TURN_RESPONDING_KIND,
    sources: ["lead"],
    payload: Type.Object({
      turnId: Type.String({ minLength: 1 }),
      seqs: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
      entityKeys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    description: "Lead 的一轮在回应这些事件。界面把这一轮说的话挂在那件事的卡下面。",
  },
];

for (const definition of REMINDER_EVENT_KINDS) registerEventKind(definition);

// ── 会话里的提醒卡（到点卡）────────────────────────────────────────────────────────
//
// 一次到点一张卡（key 是 reminder:<id>@<到点事件的 seq>），从到点到确认都在原地更新。卡的位置是到点的时间。
// 状态从事件日志算（gateway 的 lead-activity.ts）：
//   fired      到点了，用户还没确认（「知道了」「10 分钟后再提醒」）；
//   acked      用户（或者替用户的 Lead）确认了，收成一行「09:00 抢票 · 09:01 已确认」；
//   snoozed    改到了别的时间（「10 分钟后再提醒」或者「改时间」），到那时另起一张卡；
//   cancelled  取消了。
// 推送的情况（pushes）、Lead 回应它的那一轮（leadTurnId）和 Lead 写到卡上的话（lead）都挂在这张卡上。

export const REMINDER_CARD_STATES = ["fired", "acked", "snoozed", "cancelled"] as const;
export type ReminderCardState = typeof REMINDER_CARD_STATES[number];

export const ReminderCardPushesSchema = StrictObject({
  // 这次到点推了几次（不含提前的那一次）。
  count: Type.Integer({ minimum: 0 }),
  planned: Type.Integer({ minimum: 1 }),
  lastAt: Nullable(Type.String()),
  // 下一次重复推送的时间。不再推时是 null。
  nextAt: Nullable(Type.String()),
  // 推到了上限，用户还没确认。
  exhausted: Type.Boolean(),
  // 提前推的那一次。
  earlyAt: Nullable(Type.String()),
});
export type ReminderCardPushes = Static<typeof ReminderCardPushesSchema>;

export const ReminderCardNoteSchema = StrictObject({
  disposition: Type.Union([Type.Literal("handled"), Type.Literal("deferred"), Type.Literal("no_action")]),
  reason: Type.String(),
  at: Type.String(),
});

export const ReminderCardSchema = StrictObject({
  key: Type.String({ minLength: 1 }),
  entityKey: Type.String({ minLength: 1 }),
  // 投影的版本（spec D16）：卡里最新一条事件的 seq，Lead 写了话再加 1。
  entityVersion: Type.Integer({ minimum: 1 }),
  lastSeq: Type.Integer({ minimum: 1 }),
  // 到点事件的 seq。
  seq: Type.Integer({ minimum: 1 }),
  // 卡的位置：到点的时间。
  at: Type.String(),
  updatedAt: Type.String(),
  reminderId: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  // 这一次到点对应的提醒时刻。
  remindAt: Type.String(),
  level: ReminderLevelSchema,
  state: Type.Union([Type.Literal("fired"), Type.Literal("acked"), Type.Literal("snoozed"), Type.Literal("cancelled")]),
  // 卡结束（确认、改期、取消）的时间和谁做的。
  closedAt: Nullable(Type.String()),
  closedBy: Nullable(Type.Union([Type.Literal("user"), Type.Literal("lead"), Type.Literal("system")])),
  // 改期以后的新时间。
  nextAt: Nullable(Type.String()),
  pushes: ReminderCardPushesSchema,
  ticketId: Nullable(Type.Integer({ minimum: 1 })),
  check: Nullable(Type.String()),
  // Lead 回应这次到点的那一轮（lead.turn_responding）：这一轮说的话挂在卡下面，不另起气泡。
  leadTurnId: Nullable(Type.String()),
  // Lead 写到卡上的话（record_disposition 的理由）：插进别的回合时，Lead 用它补一句。
  lead: Nullable(ReminderCardNoteSchema),
});
export type ReminderCard = Static<typeof ReminderCardSchema>;

/** 提醒的设置在线上的样子（TicketDetail.reminder）。 */
export const ReminderSettingsSchema = ReminderPolicySchema;
export type ReminderSettings = ReminderPolicy;

/** POST /v1/reminders/:id/reschedule 的请求：给新的时间，或者「再过几分钟」。两个都不给时是 10 分钟以后。 */
export const ReminderRescheduleRequestSchema = StrictObject({
  remindAt: Type.Optional(Type.String({ minLength: 1 })),
  snoozeMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 * 60 })),
});
export type ReminderRescheduleRequest = Static<typeof ReminderRescheduleRequestSchema>;
