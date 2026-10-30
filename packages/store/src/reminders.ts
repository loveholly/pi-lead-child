// 提醒：设置、到点、推送、重复、改时间（Lead 事件主干 spec D11，工单 07）。设置的形状在 protocol 的 reminders.ts。
//
// 到点（fireReminder，scheduler 那一拍调用，一个事务）：
//   1. scheduled → fired（system），和以前一样；
//   2. 一条即时通知（kind=reminder，参数来自常设指令 reminder.fire）：「待你」托盘里那一行，Lead 的 read_notifications 也读它；
//   3. 一条到点事件 timer.fired：级别是提醒自己的级别（interrupt 或 tell），依据是常设指令 reminder.fire。
//      它按 Lead 的事件游标交给 Lead（interrupt 插话，tell 排队），「Lead 动态」的投影据它推出会话里的提醒卡；
//   4. ticket.updated：界面马上重取这条提醒（以前要等客户端自己在到点 70 秒后重取）；
//   5. 接了推送通道时（push=true）：通知记成系统直接送达，记一条 reminder.pushed（依据 reminder.fire），到点事件记成
//      告诉了用户（told_user / interrupted_user）。推送本身在事务提交以后由调用方做（engine 的 scheduler 的 onReminderPush）：
//      先记再推，记不上就不推，同一次推送不会推两次（reminder.pushed 的投递编号是唯一的）。
// 没确认时的重复推送（repeatReminderPush）和提前推送（pushReminderEarly）同样先记一条 reminder.pushed 再推。
// 推到上限、又过了一个间隔还没确认：记一条 reminder.unacknowledged（digest 级，进回来简报）。
// 一次到点怎样结束（确认、取消、改期）在 reminder-occurrence.ts。
import {
  LEAD_TURN_RESPONDING_KIND, parseReminderPolicy, reminderPlannedPushes, reminderPolicyErrors,
  REMINDER_PUSHED_KIND, REMINDER_UNACKNOWLEDGED_KIND, timerOriginOf,
  type EventDisposition, type TimerOrigin, type ReminderCardState, type ReminderLevel, type ReminderPolicy, type ReminderPushOccasion,
} from "@pi-lead-child/protocol";
import { localIso, type Item } from "@pi-lead-child/core";
import type { Db } from "./db.js";
import { addActivity } from "./activities.js";
import { appendEvent, appendEventGuarded, getEvent, listEvents, type EventRecord } from "./events.js";
import { itemUpdatedEvent, publishGatewayEvent } from "./gateway-events.js";
import { getItem, setItemTime, transition } from "./items.js";
import { addNotification, markNotificationDelivered } from "./notifications.js";
import {
  latestReminderFire, reminderEntityKey, reminderEventsSince, reminderPushesSince, reminderRespondingTurn,
} from "./reminder-occurrence.js";
import { reminderFireParams, type ReminderFireParams } from "./standing-orders.js";
import { labelTimer, timerFiredOriginFields } from "./timer-origins.js";

/** 一条提醒的设置。NULL（v48 之前建的）是缺省设置。 */
export function reminderPolicyOf(item: Pick<Item, "reminder_policy">): ReminderPolicy {
  return parseReminderPolicy(item.reminder_policy ?? null);
}

/** 改一条提醒的设置（Lead 的 create_reminder 之后的修改用）。只给提醒；设置不合格时抛错。 */
export function setReminderPolicy(db: Db, id: number, policy: ReminderPolicy): void {
  const row = db.prepare("SELECT kind FROM items WHERE id = ?").get(id) as { kind: string } | undefined;
  if (!row) throw new Error(`item #${id} not found`);
  if (row.kind !== "reminder") throw new Error(`item #${id} is a ${row.kind}; only a reminder has reminder settings`);
  const errors = reminderPolicyErrors(policy);
  if (errors.length) throw new Error(`invalid reminder settings: ${errors.join("; ")}`);
  db.prepare("UPDATE items SET reminder_policy = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(policy), id);
}

/** daemon 要做的一次推送。 */
export interface ReminderPush {
  reminderId: number;
  title: string;
  body: string;
  remindAt: string;
  occasion: ReminderPushOccasion;
  attempt: number;
  planned: number;
  level: ReminderLevel;
  // 推送的文字（Slack、桌面通知用同一句）。
  text: string;
  // 这次推送记下的 reminder.pushed。
  eventSeq: number;
}

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : localIso(at).slice(11, 16);
}

/** 推送的一句话。 */
export function reminderPushText(args: {
  title: string; remindAt: string; occasion: ReminderPushOccasion; attempt: number; planned: number; at: Date;
}): string {
  if (args.occasion === "early") {
    const minutes = Math.max(1, Math.round((Date.parse(args.remindAt) - args.at.getTime()) / 60_000));
    return `${minutes} 分钟后：${args.title}（${clock(args.remindAt)}）`;
  }
  if (args.occasion === "repeat") {
    return `还没确认：${args.title}（${clock(args.remindAt)} 到点，第 ${args.attempt}/${args.planned} 次提醒）`;
  }
  return `提醒：${args.title}（${clock(args.remindAt)}）`;
}

function titleOf(item: Pick<Item, "title" | "display_title">): string {
  return item.display_title ?? item.title;
}

// 记一次推送。投递编号重复（这一次已经记过、推过）时返回 null，调用方不再推。
function recordPush(
  db: Db, reminder: Item, rule: ReminderFireParams,
  args: { occasion: ReminderPushOccasion; attempt: number; planned: number; level: ReminderLevel; remindAt: string; sourceRef: string; at: Date },
): ReminderPush | null {
  const title = titleOf(reminder);
  const text = reminderPushText({ title, remindAt: args.remindAt, occasion: args.occasion, attempt: args.attempt, planned: args.planned, at: args.at });
  const { event, inserted } = appendEvent(db, {
    source: "timer",
    sourceRef: args.sourceRef,
    kind: REMINDER_PUSHED_KIND,
    entityKey: reminderEntityKey(reminder.id),
    occurredAt: args.at.toISOString(),
    level: "record",
    payload: {
      itemId: reminder.id, title, remindAt: args.remindAt, occasion: args.occasion, attempt: args.attempt,
      planned: args.planned, level: args.level, text,
    },
  }, { basis: { order: rule.order }, receivedAt: args.at });
  if (!inserted) return null;
  return {
    reminderId: reminder.id, title, body: reminder.body, remindAt: args.remindAt, occasion: args.occasion,
    attempt: args.attempt, planned: args.planned, level: args.level, text, eventSeq: event.seq,
  };
}

export interface FiredReminder {
  fire: EventRecord;
  notificationId: number;
  // push=true 时的那一次推送。
  push: ReminderPush | null;
}

/** 提醒到点（见文件头）。一个事务。push：调用方接了推送通道（daemon），事务提交以后它照 push 推出去。 */
export function fireReminder(
  db: Db, reminder: Item, at: Date, options: { push: boolean; rule?: ReminderFireParams },
): FiredReminder {
  return db.transaction((): FiredReminder => {
    const rule = options.rule ?? reminderFireParams(db);
    const policy = reminderPolicyOf(reminder);
    const iso = at.toISOString();
    const remindAt = reminder.remind_at ?? iso;
    const planned = reminderPlannedPushes(policy);
    const title = titleOf(reminder);
    transition(db, { itemId: reminder.id, to: "fired", actor: "system", reason: "remind_at reached", now: at });
    const notificationId = addNotification(db, {
      itemId: reminder.id, kind: rule.notificationKind, urgency: rule.urgency,
      title: `${rule.titlePrefix}${title}`, body: reminder.body, createdAt: iso,
    });
    // 到点事件。级别是提醒自己的级别，依据是常设指令 reminder.fire。事件本身的问题不让到点回滚（appendEventGuarded）：
    // 到点、通知照常提交，日志里改记一条 system.event_rejected。
    const { event: fire } = appendEventGuarded(db, () => ({
      source: "timer",
      sourceRef: `reminder:${reminder.id}:fired:${iso}`,
      kind: "timer.fired",
      entityKey: reminderEntityKey(reminder.id),
      occurredAt: iso,
      level: policy.level,
      payload: {
        timer: "reminder", scheduledAt: remindAt, itemId: reminder.id, title, wakeLead: true,
        remindAt, level: policy.level, planned, ticketId: policy.ticketId, check: policy.check,
        // 谁要求设的：外部来源的提醒到点交给 Lead 的那一轮按外部的一轮算（spec D16，timer-origins.ts）。
        ...timerFiredOriginFields(reminderTimeOrigin(db, reminder.id)),
      },
    }), { basis: { order: rule.order }, receivedAt: at });
    // 没问就设的外部来源提醒照常到点了：校准样本「照做」。
    labelTimer(db, "reminder", reminder.id, "kept", "system", at);
    publishGatewayEvent(db, itemUpdatedEvent(reminder.id, at));
    let push: ReminderPush | null = null;
    if (options.push && fire.kind === "timer.fired") {
      markNotificationDelivered(db, notificationId, "fallback", at);
      push = recordPush(db, reminder, rule, {
        occasion: "due", attempt: 1, planned, level: policy.level, remindAt,
        sourceRef: `reminder:${reminder.id}:push:${fire.seq}:1`, at,
      });
      // 系统已经告诉了用户。Lead 后来用 record_disposition 写到卡上的话覆盖它；横幅只看确认，不看处置。
      const disposition: EventDisposition = policy.level === "interrupt" ? "interrupted_user" : "told_user";
      db.prepare(
        "UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ? WHERE seq = ? AND disposition IS NULL",
      ).run(disposition, JSON.stringify({ via: "push", standingOrder: rule.order }), iso, fire.seq);
    }
    return { fire, notificationId, push };
  })();
}

/** 提前推送到点了的提醒：还在等，设了提前提醒，到了提醒时刻减去提前量，还没到提醒时刻，这一次的提前推送还没推。 */
export function remindersDueEarly(db: Db, now: Date): Item[] {
  const rows = db.prepare(
    `SELECT * FROM items
     WHERE kind = 'reminder' AND stage = 'scheduled' AND remind_at IS NOT NULL AND remind_at > ?
       AND reminder_policy IS NOT NULL AND json_valid(reminder_policy)
       AND json_type(reminder_policy, '$.earlyMs') = 'integer'
     ORDER BY remind_at, id`,
  ).all(now.toISOString()) as Item[];
  return rows.filter((item) => {
    const earlyMs = reminderPolicyOf(item).earlyMs;
    if (earlyMs === null || Date.parse(item.remind_at!) - earlyMs > now.getTime()) return false;
    return !db.prepare("SELECT 1 FROM events WHERE source = 'timer' AND source_ref = ?").get(earlyRef(item));
  });
}

function earlyRef(item: Pick<Item, "id" | "remind_at">): string {
  return `reminder:${item.id}:early:${item.remind_at}`;
}

/** 提前推一次（见 remindersDueEarly）。已经推过时返回 null。 */
export function pushReminderEarly(db: Db, reminder: Item, at: Date, rule?: ReminderFireParams): ReminderPush | null {
  return db.transaction((): ReminderPush | null => {
    const current = getItem(db, reminder.id);
    if (!current || current.stage !== "scheduled" || !current.remind_at) return null;
    const policy = reminderPolicyOf(current);
    return recordPush(db, current, rule ?? reminderFireParams(db), {
      occasion: "early", attempt: 0, planned: reminderPlannedPushes(policy), level: policy.level,
      remindAt: current.remind_at, sourceRef: earlyRef(current), at,
    });
  })();
}

/** 设了重复推送、到点了还没确认的提醒。 */
export function remindersAwaitingRepeat(db: Db): Item[] {
  return db.prepare(
    `SELECT * FROM items
     WHERE kind = 'reminder' AND stage = 'fired'
       AND reminder_policy IS NOT NULL AND json_valid(reminder_policy)
       AND json_type(reminder_policy, '$.repeat') = 'object'
     ORDER BY id`,
  ).all() as Item[];
}

export interface ReminderRepeatStep {
  // 这一拍要推的一次。没到时间、不用推时是 null。
  push: ReminderPush | null;
  // 推到上限、又过了一个间隔还没确认：这一拍记下的 reminder.unacknowledged。
  unacknowledged: EventRecord | null;
}

/**
 * 没确认时的重复推送（一个事务）。离上一次推送满了一个间隔、还没推满次数：再推一次。
 * 推满了、又过了一个间隔：记一次「还没确认」（digest 级，依据 reminder.fire），只记一次。到点时没有推送（没接通道）的不重复。
 */
export function repeatReminderPush(db: Db, reminder: Item, now: Date, rule?: ReminderFireParams): ReminderRepeatStep {
  return db.transaction((): ReminderRepeatStep => {
    const none: ReminderRepeatStep = { push: null, unacknowledged: null };
    const current = getItem(db, reminder.id);
    if (!current || current.stage !== "fired") return none;
    const policy = reminderPolicyOf(current);
    if (!policy.repeat) return none;
    const fire = latestReminderFire(db, current.id);
    if (!fire) return none;
    const pushes = reminderPushesSince(db, current.id, fire.seq);
    if (!pushes.length) return none;
    const lastAt = Date.parse(pushes.at(-1)!.occurredAt);
    if (now.getTime() - lastAt < policy.repeat.everyMs) return none;
    const planned = reminderPlannedPushes(policy);
    const order = rule ?? reminderFireParams(db);
    const remindAt = String(fire.payload.remindAt ?? current.remind_at ?? fire.occurredAt);
    const title = titleOf(current);
    if (pushes.length >= planned) {
      const { event, inserted } = appendEvent(db, {
        source: "timer",
        sourceRef: `reminder:${current.id}:unacked:${fire.seq}`,
        kind: REMINDER_UNACKNOWLEDGED_KIND,
        entityKey: reminderEntityKey(current.id),
        occurredAt: now.toISOString(),
        level: "digest",
        payload: {
          itemId: current.id, title, remindAt, pushes: pushes.length,
          summary: `提醒「${title}」（${clock(remindAt)}）推了 ${pushes.length} 次，用户还没确认`,
        },
      }, { basis: { order: order.order }, receivedAt: now });
      return { push: null, unacknowledged: inserted ? event : null };
    }
    const attempt = pushes.length + 1;
    const push = recordPush(db, current, order, {
      occasion: "repeat", attempt, planned, level: policy.level, remindAt,
      sourceRef: `reminder:${current.id}:push:${fire.seq}:${attempt}`, at: now,
    });
    return { push, unacknowledged: null };
  })();
}

export class ReminderRescheduleError extends Error {
  constructor(readonly code: "not_found" | "not_reminder" | "closed" | "invalid_time", message: string) {
    super(message);
    this.name = "ReminderRescheduleError";
  }
}

// 用户给的新时间早于现在多少以内还收下（路上的延迟）。更早的拒绝：那是写错了。
const PAST_TOLERANCE_MS = 60_000;

/**
 * 给提醒改时间（「改时间」「10 分钟后再提醒」、Lead 的 reschedule_reminder）。改的是时间，不改生命周期的终态：
 *   · 还在等（scheduled）：只改 remind_at；
 *   · 已经到点（fired）：改 remind_at，提醒回到等待（fired → scheduled，system 代 by 走这条边），到新的时间再响。
 *     这一次到点随之结束（横幅收起、通知确认，reminder-occurrence.ts）；
 *   · 已确认、已取消：拒绝（ReminderRescheduleError closed）。用户给的时间已经过去了：拒绝（invalid_time）。
 * 发一条 ticket.updated。返回改完的提醒。
 */
export function rescheduleReminder(
  db: Db, id: number, remindAt: Date, args: { by: "user" | "lead"; now?: Date },
): Item {
  return db.transaction((): Item => {
    const now = args.now ?? new Date();
    const item = getItem(db, id);
    if (!item) throw new ReminderRescheduleError("not_found", `reminder #${id} not found`);
    if (item.kind !== "reminder") {
      throw new ReminderRescheduleError("not_reminder", `item #${id} is a ${item.kind}; only a reminder has a remind time`);
    }
    if (item.stage === "acked" || item.stage === "cancelled") {
      throw new ReminderRescheduleError("closed", `reminder #${id} is ${item.stage}; it cannot be moved to a new time`);
    }
    if (Number.isNaN(remindAt.getTime())) throw new ReminderRescheduleError("invalid_time", "invalid remind time");
    // 用户在界面上写了一个已经过去的时间：拒绝（写错了）。Lead 的 reschedule_reminder 照旧什么时间都收（以前就这样）。
    if (args.by === "user" && remindAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
      throw new ReminderRescheduleError("invalid_time", `the new time ${remindAt.toISOString()} is in the past`);
    }
    const iso = remindAt.toISOString();
    if (item.stage === "fired") {
      db.prepare("UPDATE items SET remind_at = ?, updated_at = ? WHERE id = ?").run(iso, now.toISOString(), id);
      transition(db, {
        itemId: id, to: "scheduled", actor: "system", requestedBy: args.by,
        reason: `rescheduled by ${args.by} to ${iso}`, now,
      });
    } else {
      setItemTime(db, id, { remindAt: iso });
    }
    publishGatewayEvent(db, itemUpdatedEvent(id, now));
    return getItem(db, id)!;
  })();
}

// ── 谁定的提醒时间（ui-action-parity plan.md P04）──────────────────────────────────────────
// 时间是谁定的，看定下它的那一刻：你本人在页面上定的，或者你在这一轮里让 Lead 定的（建提醒、改时间），算你定的；
// Lead 自己决定的（被事件叫醒的一轮）算 Lead 定的。每次定下时间记一条活动（REMINDER_TIME_SET）。Lead 自己改了你定的时间，
// 改时间的那条 ui_action.performed 的 detail 写 overrodeUser，收件箱的「Lead 已处理」据此告诉你（和改日程节点一样）。
// 每次定下时间也记下是谁要求的（origin，spec D16）：外部的人在外部的一轮里要求的，记来源、发信人和消息事件。

export const REMINDER_TIME_SET = "定下提醒时间";
export type ReminderTimeSetter = "user" | "lead";

/** 记下这条提醒的时间是谁定的。sourceTurnId：你在哪一轮里让 Lead 定的。origin：谁要求的（不给时按 setBy 算）。 */
export function recordReminderTimeSetter(
  db: Db, itemId: number,
  input: { remindAt: string; setBy: ReminderTimeSetter; actor: "user" | "lead"; sourceTurnId?: string | null; origin?: TimerOrigin | null },
): void {
  addActivity(db, {
    itemId, actor: input.actor, kind: "decision",
    ...(input.sourceTurnId ? { sessionCursor: input.sourceTurnId } : {}),
    payload: {
      decision: REMINDER_TIME_SET, remindAt: input.remindAt, setBy: input.setBy,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
  });
}

/**
 * 这条提醒现在的时间是谁要求的（spec D16）：最近一次定下时间的记录里的来源；没有记来源的（上线以前）按谁定的算：
 * 你定的是用户本人，Lead 定的是系统。没有记录时按建它的人算。
 */
export function reminderTimeOrigin(db: Db, itemId: number): TimerOrigin {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.setBy') AS set_by, json_extract(payload, '$.sourceTurnId') AS turn_id,
            json_extract(payload, '$.origin') AS origin FROM activities
     WHERE item_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, REMINDER_TIME_SET) as { set_by: string | null; turn_id: string | null; origin: string | null } | undefined;
  if (row) {
    let stored: unknown = null;
    try {
      stored = row.origin ? JSON.parse(row.origin) : null;
    } catch {
      stored = null;
    }
    return timerOriginOf(stored) ?? (row.set_by === "user" ? { kind: "user", turnId: row.turn_id ?? null } : { kind: "system" });
  }
  return reminderTimeSetter(db, itemId) === "user" ? { kind: "user", turnId: null } : { kind: "system" };
}

/** 这条提醒现在的时间是谁定的：最近一次定下时间的记录；没有记录（上线以前建的）时按建它的人算。 */
export function reminderTimeSetter(db: Db, itemId: number): ReminderTimeSetter {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.setBy') AS set_by FROM activities
     WHERE item_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, REMINDER_TIME_SET) as { set_by: string } | undefined;
  if (row) return row.set_by === "user" ? "user" : "lead";
  const created = db.prepare("SELECT created_by FROM items WHERE id = ?").get(itemId) as { created_by: string } | undefined;
  return created?.created_by === "user" ? "user" : "lead";
}

export interface LeadReminderOverride {
  eventId: string;
  itemId: number;
  title: string;
  from: string | null;
  to: string;
  reason: string;
  at: string;
}

/** Lead 自己改了用户定的提醒时间（since 之后）。收件箱的「Lead 已处理」把它们告诉用户。 */
export function leadReminderOverridesOfUser(db: Db, sinceIso: string): LeadReminderOverride[] {
  const rows = db.prepare(
    `SELECT e.event_id, e.payload, e.occurred_at, i.id AS item_id, i.title, i.display_title FROM events e
     JOIN items i ON i.id = CAST(json_extract(e.payload, '$.target.id') AS INTEGER)
     WHERE e.kind = 'ui_action.performed' AND e.entity_key LIKE 'reminder:%'
       AND json_extract(e.payload, '$.action') = 'reschedule'
       AND json_extract(e.payload, '$.detail.overrodeUser') = 1
       AND e.occurred_at > ?
     ORDER BY e.seq`,
  ).all(sinceIso) as Array<{
    event_id: string; payload: string; occurred_at: string; item_id: number; title: string; display_title: string | null;
  }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as { reason?: string; detail?: { from?: string | null; to?: string } };
    return {
      eventId: row.event_id, itemId: row.item_id, title: row.display_title ?? row.title,
      from: payload.detail?.from ?? null, to: payload.detail?.to ?? "", reason: payload.reason ?? "", at: row.occurred_at,
    };
  });
}

// ── 一次到点的状态（会话里的提醒卡、交给 Lead 时的卡片状态）────────────────────────

export interface ReminderFireState {
  reminderId: number;
  title: string;
  remindAt: string;
  level: ReminderLevel;
  policy: ReminderPolicy;
  state: ReminderCardState;
  closedAt: string | null;
  closedBy: "user" | "lead" | "system" | null;
  nextAt: string | null;
  pushes: {
    count: number; planned: number; lastAt: string | null; nextAt: string | null; exhausted: boolean; earlyAt: string | null;
  };
  // Lead 回应这次到点的那一轮。
  leadTurnId: string | null;
  // Lead 写到卡上的话（record_disposition 记在到点事件上的理由）。
  lead: { disposition: "handled" | "deferred" | "no_action"; reason: string; at: string } | null;
  // 这张卡里最新的一条事件。
  lastSeq: number;
  updatedAt: string;
}

const LEAD_NOTE_DISPOSITIONS: ReadonlySet<string> = new Set(["handled", "deferred", "no_action"]);
const FIRE_CARD_KINDS: ReadonlySet<string> = new Set([
  REMINDER_PUSHED_KIND, REMINDER_UNACKNOWLEDGED_KIND, "stage.changed", LEAD_TURN_RESPONDING_KIND,
]);

function actorOf(value: unknown): "user" | "lead" | "system" | null {
  return value === "user" || value === "lead" || value === "system" ? value : null;
}

/** 一次到点现在的样子，从事件日志算：到这条提醒下一次到点为止的推送、结束它的那次 stage 变化、Lead 回应它的那一轮。 */
export function reminderFireState(db: Db, fire: EventRecord): ReminderFireState {
  const reminderId = Number(fire.payload.itemId);
  const item = getItem(db, reminderId);
  const policy = item ? reminderPolicyOf(item) : parseReminderPolicy(null);
  const later = reminderEventsSince(db, reminderId, fire.seq);
  const nextFireIndex = later.findIndex((event) => event.kind === "timer.fired" && event.payload.timer === "reminder");
  // 卡上看得见的事件：推送、还没确认、stage 变化、Lead 回应它的那一轮。别的（例如横幅的确认）不改卡，不算进版本。
  const own = (nextFireIndex < 0 ? later : later.slice(0, nextFireIndex)).filter((event) => FIRE_CARD_KINDS.has(event.kind));
  const nextFire = nextFireIndex < 0 ? null : later[nextFireIndex]!;
  const closing = own.find((event) => event.kind === "stage.changed" && event.payload.from === "fired");
  const to = closing ? String(closing.payload.to) : nextFire ? "scheduled" : item?.stage === "fired" ? null : item?.stage ?? null;
  const state: ReminderCardState = to === "acked" ? "acked" : to === "cancelled" ? "cancelled" : to === "scheduled" ? "snoozed" : "fired";
  const level: ReminderLevel = fire.level === "interrupt" ? "interrupt" : fire.level === "tell" ? "tell" : policy.level;
  const remindAt = String(fire.payload.remindAt ?? fire.payload.scheduledAt ?? fire.occurredAt);
  const pushes = own.filter((event) => event.kind === REMINDER_PUSHED_KIND && event.payload.occasion !== "early");
  const planned = Number(fire.payload.planned) > 0 ? Number(fire.payload.planned) : reminderPlannedPushes(policy);
  const lastPush = pushes.at(-1) ?? null;
  const everyMs = policy.repeat?.everyMs ?? null;
  const open = state === "fired";
  const early = listEvents(db, {
    entityKey: reminderEntityKey(reminderId), kind: REMINDER_PUSHED_KIND, beforeSeq: fire.seq, order: "desc", limit: 5,
  }).find((event) => event.payload.occasion === "early" && event.payload.remindAt === remindAt) ?? null;
  const nextAt = state !== "snoozed" ? null
    : nextFire ? String(nextFire.payload.remindAt ?? nextFire.occurredAt)
      : item?.stage === "scheduled" ? item.remind_at : null;
  const lead = fire.disposition && LEAD_NOTE_DISPOSITIONS.has(fire.disposition)
    ? {
      disposition: fire.disposition as "handled" | "deferred" | "no_action",
      reason: typeof fire.dispositionDetail?.reason === "string" ? fire.dispositionDetail.reason : "",
      at: fire.disposedAt ?? fire.receivedAt,
    }
    : null;
  const lastEvent = own.at(-1) ?? fire;
  const updatedAt = [fire.occurredAt, lastEvent.occurredAt, lead?.at ?? fire.occurredAt]
    .reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest));
  return {
    reminderId,
    title: String(fire.payload.title ?? item?.title ?? `提醒 #${reminderId}`),
    remindAt,
    level,
    policy,
    state,
    closedAt: closing?.occurredAt ?? (state === "fired" ? null : nextFire?.occurredAt ?? null),
    closedBy: closing ? actorOf(closing.payload.requestedBy) ?? actorOf(closing.payload.actor) : null,
    nextAt,
    pushes: {
      count: pushes.length,
      planned,
      lastAt: lastPush?.occurredAt ?? null,
      nextAt: open && everyMs !== null && lastPush && pushes.length < planned
        ? new Date(Date.parse(lastPush.occurredAt) + everyMs).toISOString() : null,
      exhausted: open && policy.repeat !== null && pushes.length >= planned,
      earlyAt: early?.occurredAt ?? null,
    },
    leadTurnId: reminderRespondingTurn(own, fire.seq),
    lead,
    lastSeq: lastEvent.seq,
    updatedAt,
  };
}

/** 最近的几次提醒到点（seq 大于 afterSeq 的最新 limit 条），从旧到新。会话里的提醒卡按它们算。 */
export function listReminderFires(db: Db, query: { afterSeq: number; limit: number }): EventRecord[] {
  // 走 events_kind 索引；Lead 自己的跟进到点也是 timer.fired，按对象键排除，不让它们挤掉提醒。
  const rows = db.prepare(
    `SELECT seq FROM events
     WHERE kind = 'timer.fired' AND seq > ? AND entity_key LIKE 'reminder:%'
     ORDER BY seq DESC LIMIT ?`,
  ).all(query.afterSeq, Math.max(1, Math.trunc(query.limit))) as Array<{ seq: number }>;
  return rows.reverse().flatMap(({ seq }) => {
    const event = getEvent(db, seq);
    return event && event.payload.timer === "reminder" ? [event] : [];
  });
}

/** 记下「Lead 的这一轮在回应这些事件」（lead.turn_responding，工单 07）。daemon 在这一轮落成会话里的一轮时调用。 */
export function recordLeadTurnResponding(
  db: Db, args: { turnId: string; events: ReadonlyArray<Pick<EventRecord, "seq" | "entityKey">>; at?: Date },
): EventRecord | null {
  if (!args.events.length) return null;
  const entityKeys = [...new Set(args.events.map((event) => event.entityKey))];
  return db.transaction(() => appendEvent(db, {
    source: "lead",
    sourceRef: `turn:${args.turnId}:responding`,
    kind: LEAD_TURN_RESPONDING_KIND,
    entityKey: entityKeys[0]!,
    level: "record",
    ...(args.at ? { occurredAt: args.at.toISOString() } : {}),
    payload: { turnId: args.turnId, seqs: args.events.map((event) => event.seq), entityKeys },
  }).event)();
}
