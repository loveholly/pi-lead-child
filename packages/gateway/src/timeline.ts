// 日程（左栏改版阶段 3）：GET /v1/timeline 的投影。/v1/agenda 原样保留给旧客户端：AgendaItemSchema 是 StrictObject，
// 给它加字段，旧客户端会拒收整条。
//
// 每种时间怎样进日程：
// - 节点（item_milestones）：截止、提测、发布、核查、自定义，带出处。时间已过、工单没结束 → 过期；工单结束后显示为完成，
//   不改节点状态。
// - 提醒（kind = reminder 的 remind_at）：fired 没有确认 → 未确认；7 天后进过期区（决定 3）。
// - 推迟开始（task 的 defer_until）：到点后工单开跑，这一项消失。
// - 例行任务：将来的按 trigger 展开；过去的只来自 trigger_fires（已执行、失败）。
// 风险由 TicketSummary 派生（ticketTurn），不在客户端推算。
import {
  MILESTONE_KIND_LABELS,
  ticketTurn,
  type TicketSummary,
  type TimelineEntry,
  type AgendaEntryDto,
  type Locale,
  type TimelineResponse,
} from "@pi-lead-child/protocol";
import {
  agendaEntriesByReminder,
  agendaNote,
  listAgendaEntries,
  listAgendaFeeds,
  reminderPolicyOf,
  firedOccurrences,
  getLocale,
  listItems,
  listMilestones,
  listTriggers,
  triggerOccurrences,
  type Db,
  type ItemMilestone,
  type MilestoneActor,
} from "@pi-lead-child/store";
import type { Item } from "@pi-lead-child/core";
import { timelineMessages } from "./timeline.messages.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 节点在这么近的将来（或已经过了），工单却阻塞或在等你，就标出风险。
const RISK_WINDOW_MS = 48 * HOUR;
// 已触发、没有确认的提醒，过了这么久进「已过期」（决定 3）。
const REMINDER_OVERDUE_AFTER_MS = 7 * DAY;
const OVERDUE_LIMIT = 50;

export type TimelineInput = {
  from: Date;
  to: Date;
  timezone: string;
  now: Date;
  // Add external agenda entries (kind=external) and fold their pre-created reminders into them. Only new clients ask.
  includeExternal?: boolean;
  summaryOf: (item: Item) => TicketSummary;
  routineDetail: (actionPayload: string) => { description: string; project: string | null };
};

function iso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ticketTitle(summary: TicketSummary): string {
  return summary.displayTitle ?? summary.title;
}

function risk(summary: TicketSummary, at: string, now: Date, locale: Locale): TimelineEntry["risk"] {
  const m = timelineMessages(locale);
  if (new Date(at).getTime() - now.getTime() > RISK_WINDOW_MS) return null;
  const turn = ticketTurn(summary);
  if (turn === "ended") return null;
  if (summary.stage === "blocked") return { reason: "ticket_blocked", label: m.ticketBlocked };
  if (turn === "user") return { reason: "ticket_needs_user", label: m.ticketNeedsUser };
  if (turn === "queued" && !summary.hasRun) return { reason: "not_started", label: m.notStarted };
  return null;
}

function externalEntry(entry: AgendaEntryDto, feedLabel: string, reminder: Item | null, nowIso: string): TimelineEntry {
  const remindAt = reminder ? iso(reminder.remind_at) : null;
  // A timed entry is over once it starts; an all-day entry only after its day (or its end) has passed.
  const over = entry.allDay
    ? (entry.endsAt ?? new Date(Date.parse(entry.startsAt) + 24 * 60 * 60_000).toISOString()) <= nowIso
    : entry.startsAt < nowIso;
  const status: TimelineEntry["status"] = reminder?.stage === "fired" ? "unacked" : over ? "done" : "upcoming";
  return {
    id: `external:${entry.id}`,
    kind: "external",
    at: entry.startsAt,
    allDay: entry.allDay,
    title: entry.title,
    ticketId: null,
    project: null,
    status,
    risk: null,
    editable: false,
    external: {
      feed: entry.feed, feedLabel, entryId: entry.id, endsAt: entry.endsAt, location: entry.location, url: entry.url,
      status: entry.status, muted: entry.muted,
      reminder: reminder && remindAt
        ? { id: reminder.id, at: remindAt, level: reminderPolicyOf(reminder).level, stage: reminder.stage }
        : null,
    },
  };
}

export function buildTimeline(db: Db, input: TimelineInput): TimelineResponse {
  const { now } = input;
  // 风险提示和执行结果读的时候现算，按用户现在选的语言。
  const locale = getLocale(db);
  const m = timelineMessages(locale);
  const nowIso = now.toISOString();
  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();
  const inRange = (at: string) => at >= fromIso && at < toIso;
  const items = new Map(listItems(db).map((item) => [item.id, item]));
  const summaries = new Map<number, TicketSummary>();
  const summaryOf = (item: Item) => {
    let summary = summaries.get(item.id);
    if (!summary) {
      summary = input.summaryOf(item);
      summaries.set(item.id, summary);
    }
    return summary;
  };
  const entries: TimelineEntry[] = [];
  const overdue: TimelineEntry[] = [];

  // 每个节点最后一次修改：谁、什么时候。出处显示它（「Lead 记下」「你改过」）。
  const lastChanges = new Map(
    (db.prepare(
      `SELECT milestone_id, actor, created_at FROM item_milestone_changes
       WHERE id IN (SELECT MAX(id) FROM item_milestone_changes GROUP BY milestone_id)`,
    ).all() as { milestone_id: number; actor: MilestoneActor; created_at: string }[])
      .map((row) => [row.milestone_id, row]),
  );

  const milestoneEntry = (milestone: ItemMilestone, item: Item): TimelineEntry => {
    const summary = summaryOf(item);
    const ended = ticketTurn(summary) === "ended";
    const status: TimelineEntry["status"] = milestone.state === "done" ? "done"
      : milestone.state === "missed" ? "failed"
        : ended ? "done"
          : milestone.at < nowIso ? "overdue"
            : "upcoming";
    const last = lastChanges.get(milestone.id);
    return {
      id: `milestone:${milestone.id}`,
      kind: "milestone",
      at: milestone.at,
      allDay: milestone.all_day === 1,
      title: ticketTitle(summary),
      ticketId: item.id,
      project: summary.project,
      milestone: {
        id: milestone.id,
        kind: milestone.kind,
        label: milestone.label ?? MILESTONE_KIND_LABELS[milestone.kind],
        state: milestone.state,
      },
      provenance: {
        actor: last?.actor ?? milestone.source_actor,
        runId: milestone.source_run_id,
        turnId: milestone.source_turn_id,
        quote: milestone.source_quote,
        confidence: milestone.confidence,
        at: iso(last?.created_at ?? milestone.updated_at) ?? milestone.updated_at,
      },
      status,
      risk: status === "upcoming" || status === "overdue" ? risk(summary, milestone.at, now, locale) : null,
      editable: true,
    };
  };

  for (const milestone of listMilestones(db, { states: ["planned", "done", "missed"] })) {
    const item = items.get(milestone.item_id);
    if (!item) continue;
    const entry = milestoneEntry(milestone, item);
    if (inRange(milestone.at)) entries.push(entry);
    if (entry.status === "overdue") overdue.push(entry);
  }

  // External agenda entries: one row per entry, carrying its pre-created reminder (one object, one row: P4.1).
  const foldedReminders = new Set<number>();
  if (input.includeExternal) {
    const labels = new Map(listAgendaFeeds(db).map((feed) => [feed.name, feed.label]));
    for (const entry of listAgendaEntries(db, { from: fromIso, to: toIso })) {
      const reminder = entry.reminderItemId !== null ? items.get(entry.reminderItemId) : undefined;
      if (reminder) foldedReminders.add(reminder.id);
      entries.push(externalEntry(entry, labels.get(entry.feed) ?? entry.feed, reminder ?? null, nowIso));
    }
    // A reminder whose entry starts outside the range still belongs to that entry: do not list it on its own either.
    for (const id of agendaEntriesByReminder(db, [...items.values()].filter((item) => item.kind === "reminder").map((item) => item.id)).keys()) {
      foldedReminders.add(id);
    }
  }

  for (const item of items.values()) {
    if (item.kind === "reminder") {
      if (foldedReminders.has(item.id)) continue;
      const remindAt = iso(item.remind_at);
      if (!remindAt || item.stage === "cancelled") continue;
      const status: TimelineEntry["status"] = item.stage === "fired" ? "unacked" : item.stage === "acked" ? "done" : "upcoming";
      const entry: TimelineEntry = {
        id: `reminder:${item.id}`, kind: "reminder", at: remindAt, allDay: false, title: item.title,
        ticketId: item.id, project: item.project, status, risk: null, editable: false,
      };
      if (inRange(remindAt)) entries.push(entry);
      if (status === "unacked" && now.getTime() - new Date(remindAt).getTime() >= REMINDER_OVERDUE_AFTER_MS) {
        overdue.push({ ...entry, status: "unacked" });
      }
      continue;
    }
    // 推迟开始：到点后工单开跑，这一项消失。
    const deferUntil = iso(item.defer_until);
    if (deferUntil && deferUntil > nowIso && inRange(deferUntil)) {
      const summary = summaryOf(item);
      if (ticketTurn(summary) === "ended") continue;
      entries.push({
        id: `defer:${item.id}`, kind: "deferred_start", at: deferUntil, allDay: false, title: ticketTitle(summary),
        ticketId: item.id, project: summary.project, status: "upcoming", risk: null, editable: false,
      });
    }
  }

  // 例行任务。将来的从现在起按 trigger 展开；过去的只列真的触发过的（trigger_fires）。
  const fires = db.prepare(
    `SELECT f.id, f.trigger_id, f.occurrence_at, f.status, f.error, f.produced_item_id, t.label, t.action_payload
     FROM trigger_fires f JOIN triggers t ON t.id = f.trigger_id
     WHERE f.occurrence_at >= ? AND f.occurrence_at < ?`,
  ).all(fromIso, toIso) as {
    id: number; trigger_id: number; occurrence_at: string; status: "pending" | "succeeded" | "failed";
    error: string | null; produced_item_id: number | null; label: string; action_payload: string;
  }[];
  for (const fire of fires) {
    const at = iso(fire.occurrence_at) ?? fire.occurrence_at;
    const routine = input.routineDetail(fire.action_payload);
    entries.push({
      id: `fire:${fire.id}`,
      kind: "routine_fired",
      at,
      allDay: false,
      title: fire.label,
      ticketId: fire.produced_item_id,
      project: routine.project,
      status: fire.status === "succeeded" ? "done" : fire.status === "failed" ? "failed" : "upcoming",
      risk: null,
      editable: false,
      detail: fire.status === "failed"
        ? m.fireFailed(fire.error)
        : fire.status === "succeeded"
          ? m.fireDone(fire.produced_item_id)
          : m.fireRunning,
    });
  }
  const futureFrom = new Date(Math.max(input.from.getTime(), now.getTime()));
  if (futureFrom < input.to) {
    for (const trigger of listTriggers(db, { enabledOnly: true })) {
      const fired = firedOccurrences(db, trigger.id, { from: futureFrom.toISOString(), to: toIso });
      const routine = input.routineDetail(trigger.action_payload);
      for (const at of triggerOccurrences(trigger, { from: futureFrom, to: input.to, timezone: input.timezone })) {
        if (fired.has(at)) continue;
        entries.push({
          id: `routine:${trigger.id}:${at}`, kind: "routine", at, allDay: false, title: trigger.label,
          ticketId: null, project: routine.project, status: "upcoming", risk: null, editable: false,
          ...(routine.description ? { detail: routine.description } : {}),
        });
      }
    }
  }

  entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  // 过期区：新的在前，最多 50 条。
  overdue.sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id));
  return {
    entries,
    overdue: overdue.slice(0, OVERDUE_LIMIT),
    generatedAt: nowIso,
    leadNote: agendaNote(db),
  };
}
