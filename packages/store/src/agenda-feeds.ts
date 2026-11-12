// External agenda feeds (protocol agenda-feeds.ts). Feeds live in kv (`agenda-feed:<name>`, one JSON value each, like
// signal sources); entries live in agenda_entries.
//
// A sync writes a snapshot of the feed's window, then reconciles the pre-created reminders of every entry that has not
// started yet. Reconciliation (spec section 4):
//   - desired: the time the entry wants a reminder at, or null (feed off, entry removed / cancelled / muted / skipped,
//     all-day without allDayAt, or the time already passed for an all-day entry).
//   - The linked reminder L and the last plan P decide what happens:
//       L cancelled by someone else   -> the user does not want it: mute the entry.
//       no L, desired                 -> create a reminder (now at the earliest).
//       L scheduled/fired, no desired -> system cancels L and unlinks it.
//       L scheduled, desired != P     -> shift L by (desired - P): keeps a user's own offset.
//       L fired, desired != P         -> shifted time in the future: back to scheduled at that time.
//       L acked, desired != P         -> the meeting moved after the ack: create a new reminder.
//     desired == P leaves L alone, so a user's own reschedule stays.
// Reminders are created by system (no Lead tool call), so no conversation card appears.
// This module only reads and writes the database; permissions live in engine ui-actions/agenda-feeds.ts.
import { createHash } from "node:crypto";
import {
  AGENDA_CHANGED_KIND, AGENDA_EVENT_SOURCE, AGENDA_FEED_LIMITS, AGENDA_FEED_NAME_PATTERN,
  defaultAgendaFeedRemind, defaultAgendaFeedWindow, normalizeAgendaEntry,
  type AgendaEntryDto, type AgendaEntryPatch, type AgendaFeedDto, type AgendaFeedInput, type AgendaFeedRemind,
  type AgendaFeedUpdate, type AgendaFeedWindow, type AgendaSnapshot, type AgendaSyncResult, type ExternalTimerOrigin,
  type NormalizedAgendaEntry, type ReminderPolicy,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { itemUpdatedEvent, publishGatewayEvent } from "./gateway-events.js";
import { createItem, getItem, setItemTime, transition } from "./items.js";
import { recordReminderTimeSetter } from "./reminders.js";

const PREFIX = "agenda-feed:";
const NAME = new RegExp(AGENDA_FEED_NAME_PATTERN);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── feeds ─────────────────────────────────────────────────────────────────────────

const isoOrNull = (value: unknown): string | null =>
  (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
  (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback);

function windowOf(value: unknown): AgendaFeedWindow {
  const fallback = defaultAgendaFeedWindow();
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    pastHours: intIn(stored.pastHours, 0, AGENDA_FEED_LIMITS.maxPastHours, fallback.pastHours),
    futureDays: intIn(stored.futureDays, 1, AGENDA_FEED_LIMITS.maxFutureDays, fallback.futureDays),
  };
}

function remindOf(value: unknown): AgendaFeedRemind {
  const fallback = defaultAgendaFeedRemind();
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const statuses = Array.isArray(stored.statuses)
    ? [...new Set(stored.statuses.filter((status): status is "confirmed" | "tentative" => status === "confirmed" || status === "tentative"))]
    : [];
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : fallback.enabled,
    minutesBefore: intIn(stored.minutesBefore, 0, AGENDA_FEED_LIMITS.maxMinutesBefore, fallback.minutesBefore),
    level: stored.level === "tell" || stored.level === "interrupt" ? stored.level : fallback.level,
    statuses: statuses.length ? statuses : fallback.statuses,
    allDayAt: typeof stored.allDayAt === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(stored.allDayAt) ? stored.allDayAt : null,
  };
}

function parseFeed(name: string, raw: string): AgendaFeedDto | null {
  let stored: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    stored = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!NAME.test(name)) return null;
  const epoch = new Date(0).toISOString();
  return {
    name,
    label: typeof stored.label === "string" && stored.label ? stored.label : name,
    window: windowOf(stored.window),
    remind: remindOf(stored.remind),
    enabled: stored.enabled !== false,
    createdBy: stored.createdBy === "user" ? "user" : "lead",
    createdAt: isoOrNull(stored.createdAt) ?? epoch,
    updatedAt: isoOrNull(stored.updatedAt) ?? isoOrNull(stored.createdAt) ?? epoch,
    lastSyncAt: isoOrNull(stored.lastSyncAt),
    lastSyncStatus: stored.lastSyncStatus === "ok" || stored.lastSyncStatus === "error" ? stored.lastSyncStatus : null,
    lastError: typeof stored.lastError === "string" ? stored.lastError : null,
    baselinedAt: isoOrNull(stored.baselinedAt),
  };
}

function writeFeed(db: Db, feed: AgendaFeedDto): void {
  const { name, ...value } = feed;
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`${PREFIX}${name}`, JSON.stringify(value));
}

export function getAgendaFeed(db: Db, name: string): AgendaFeedDto | null {
  if (!NAME.test(name)) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`${PREFIX}${name}`) as { value: string } | undefined;
  return row ? parseFeed(name, row.value) : null;
}

/** All feeds, by name. Broken rows are skipped. */
export function listAgendaFeeds(db: Db): AgendaFeedDto[] {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key")
    .all(PREFIX, `${PREFIX}￿`) as Array<{ key: string; value: string }>;
  return rows.map((row) => parseFeed(row.key.slice(PREFIX.length), row.value)).filter((feed): feed is AgendaFeedDto => feed !== null);
}

/** Create a feed. Returns null when one with the same name exists. */
export function createAgendaFeed(db: Db, input: AgendaFeedInput, args: { by: "user" | "lead"; now: Date }): AgendaFeedDto | null {
  return db.transaction((): AgendaFeedDto | null => {
    if (!NAME.test(input.name)) throw new Error(`invalid agenda feed name: ${input.name}`);
    if (getAgendaFeed(db, input.name)) return null;
    const at = args.now.toISOString();
    const feed: AgendaFeedDto = {
      name: input.name, label: input.label,
      window: windowOf({ ...defaultAgendaFeedWindow(), ...(input.window ?? {}) }),
      remind: remindOf({ ...defaultAgendaFeedRemind(), ...(input.remind ?? {}) }),
      enabled: true, createdBy: args.by, createdAt: at, updatedAt: at,
      lastSyncAt: null, lastSyncStatus: null, lastError: null, baselinedAt: null,
    };
    writeFeed(db, feed);
    return feed;
  })();
}

/**
 * Change a feed's label, window or reminder rule, or turn it on and off. Reconciles its future entries in the same
 * transaction, so a new lead time moves the pre-created reminders right away. Returns null when the feed is gone.
 */
export function updateAgendaFeed(
  db: Db, name: string, patch: AgendaFeedUpdate & { enabled?: boolean }, now: Date,
): { feed: AgendaFeedDto; reminders: AgendaSyncResult["reminders"] } | null {
  return db.transaction(() => {
    const current = getAgendaFeed(db, name);
    if (!current) return null;
    const feed: AgendaFeedDto = {
      ...current,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      window: patch.window ? windowOf({ ...current.window, ...patch.window }) : current.window,
      remind: patch.remind ? remindOf({ ...current.remind, ...patch.remind }) : current.remind,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: now.toISOString(),
    };
    writeFeed(db, feed);
    return { feed, reminders: reconcileAgendaFeed(db, name, now) };
  })();
}

/** Record a failed sync (for example the source's command broke). Entries and reminders stay as they are. */
export function recordAgendaFeedError(db: Db, name: string, error: string, now: Date): void {
  const feed = getAgendaFeed(db, name);
  if (!feed) return;
  writeFeed(db, { ...feed, lastSyncAt: now.toISOString(), lastSyncStatus: "error", lastError: error.slice(0, 1_000) });
}

/**
 * Delete a feed: its reminders that have not been acknowledged are cancelled, its entries go. Reminders the user
 * already acknowledged stay as history.
 */
export function deleteAgendaFeed(db: Db, name: string, now: Date): { cancelled: number } {
  return db.transaction(() => {
    let cancelled = 0;
    for (const row of entryRows(db, "SELECT * FROM agenda_entries WHERE feed = ? AND reminder_item_id IS NOT NULL", [name])) {
      if (cancelLinkedReminder(db, row, "agenda feed deleted", now)) cancelled++;
    }
    db.prepare("DELETE FROM agenda_entries WHERE feed = ?").run(name);
    db.prepare("DELETE FROM kv WHERE key = ?").run(`${PREFIX}${name}`);
    return { cancelled };
  })();
}

// ── entries ───────────────────────────────────────────────────────────────────────

interface EntryRow {
  id: number;
  feed: string;
  key: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: number;
  status: AgendaEntryDto["status"];
  location: string | null;
  url: string | null;
  source_skip: number;
  source_minutes_before: number | null;
  muted: number;
  minutes_before: number | null;
  reminder_item_id: number | null;
  reminder_planned_at: string | null;
  content_hash: string;
  first_seen_at: string;
  updated_at: string;
  removed_at: string | null;
}

function entryRows(db: Db, sql: string, params: unknown[]): EntryRow[] {
  return db.prepare(sql).all(...params) as EntryRow[];
}

function toDto(row: EntryRow): AgendaEntryDto {
  return {
    id: row.id, feed: row.feed, key: row.key, title: row.title, startsAt: row.starts_at, endsAt: row.ends_at,
    allDay: row.all_day === 1, status: row.status, location: row.location, url: row.url,
    sourceSkip: row.source_skip === 1, sourceMinutesBefore: row.source_minutes_before,
    muted: row.muted === 1, minutesBefore: row.minutes_before,
    reminderItemId: row.reminder_item_id, reminderPlannedAt: row.reminder_planned_at,
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, removedAt: row.removed_at,
  };
}

export function getAgendaEntry(db: Db, id: number): AgendaEntryDto | null {
  const row = db.prepare("SELECT * FROM agenda_entries WHERE id = ?").get(id) as EntryRow | undefined;
  return row ? toDto(row) : null;
}

/** Entries that start in [from, to), by start. Removed ones only when asked. */
export function listAgendaEntries(
  db: Db, query: { from: string; to: string; feed?: string; includeRemoved?: boolean; limit?: number },
): AgendaEntryDto[] {
  const clauses = ["starts_at >= ?", "starts_at < ?"];
  const params: unknown[] = [query.from, query.to];
  if (query.feed) {
    clauses.push("feed = ?");
    params.push(query.feed);
  }
  if (!query.includeRemoved) clauses.push("removed_at IS NULL");
  params.push(Math.max(1, Math.min(query.limit ?? 1_000, 5_000)));
  return entryRows(db, `SELECT * FROM agenda_entries WHERE ${clauses.join(" AND ")} ORDER BY starts_at, id LIMIT ?`, params).map(toDto);
}

/** The entry a pre-created reminder belongs to, by the reminder's item id. */
export function agendaEntriesByReminder(db: Db, itemIds: readonly number[]): Map<number, AgendaEntryDto> {
  const result = new Map<number, AgendaEntryDto>();
  if (!itemIds.length) return result;
  const rows = entryRows(
    db, `SELECT * FROM agenda_entries WHERE reminder_item_id IN (${itemIds.map(() => "?").join(",")})`, [...itemIds],
  );
  for (const row of rows) result.set(row.reminder_item_id!, toDto(row));
  return result;
}

function contentHash(entry: NormalizedAgendaEntry): string {
  return createHash("sha256").update(JSON.stringify([
    entry.title, entry.startsAt, entry.endsAt, entry.allDay, entry.status, entry.location, entry.url,
    entry.sourceSkip, entry.sourceMinutesBefore,
  ])).digest("hex");
}

// ── reconciliation ────────────────────────────────────────────────────────────────

/** The reminder time the entry wants now, or null for none. */
export function desiredReminderAt(feed: AgendaFeedDto, entry: AgendaEntryDto, now: Date): Date | null {
  if (!feed.enabled || !feed.remind.enabled) return null;
  if (entry.removedAt || entry.muted || entry.sourceSkip) return null;
  if (entry.status === "cancelled" || !(feed.remind.statuses as readonly string[]).includes(entry.status)) return null;
  const start = new Date(entry.startsAt);
  if (entry.allDay) {
    if (!feed.remind.allDayAt) return null;
    const [hours, minutes] = feed.remind.allDayAt.split(":").map(Number) as [number, number];
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hours, minutes);
    // An all-day entry first seen after its reminder time gets no late reminder.
    return at.getTime() > now.getTime() ? at : null;
  }
  const minutes = entry.minutesBefore ?? entry.sourceMinutesBefore ?? feed.remind.minutesBefore;
  return new Date(start.getTime() - minutes * MINUTE);
}

/** Has the entry started (timed) or its day begun (all-day)? Reconciliation leaves such entries alone. */
function started(entry: AgendaEntryDto, now: Date): boolean {
  if (!entry.allDay) return Date.parse(entry.startsAt) <= now.getTime();
  return Date.parse(entry.endsAt ?? new Date(Date.parse(entry.startsAt) + DAY).toISOString()) <= now.getTime();
}

function originOf(feed: AgendaFeedDto): ExternalTimerOrigin {
  return {
    kind: "external", via: "tool", source: AGENDA_EVENT_SOURCE, sourceLabel: feed.label,
    sender: null, messageEvent: null, conversation: null,
  };
}

function link(db: Db, entryId: number, itemId: number | null, planned: string | null, now: Date): void {
  db.prepare("UPDATE agenda_entries SET reminder_item_id = ?, reminder_planned_at = ?, updated_at = ? WHERE id = ?")
    .run(itemId, planned, now.toISOString(), entryId);
}

function createReminderFor(db: Db, feed: AgendaFeedDto, entry: AgendaEntryDto, at: Date): number {
  const policy: ReminderPolicy = { level: feed.remind.level, earlyMs: null, repeat: null, ticketId: null, check: null };
  const remindAt = at.toISOString();
  const id = createItem(db, {
    kind: "reminder", title: entry.title, brief: "", createdBy: "system", remindAt, reminderPolicy: policy,
  });
  // The time is set by the system for an external source: the turn the reminder wakes counts as an external turn.
  recordReminderTimeSetter(db, id, { remindAt, setBy: "lead", actor: "system", origin: originOf(feed) });
  return id;
}

function cancelLinkedReminder(db: Db, row: Pick<EntryRow, "id" | "reminder_item_id">, reason: string, now: Date): boolean {
  if (row.reminder_item_id === null) return false;
  const item = getItem(db, row.reminder_item_id);
  let cancelled = false;
  if (item && item.kind === "reminder" && (item.stage === "scheduled" || item.stage === "fired")) {
    transition(db, { itemId: item.id, to: "cancelled", actor: "system", reason, now });
    publishGatewayEvent(db, itemUpdatedEvent(item.id, now));
    cancelled = true;
  }
  link(db, row.id, null, null, now);
  return cancelled;
}

type ReconcileOutcome = "none" | "created" | "moved" | "cancelled" | "muted";

/** Bring one entry's pre-created reminder in line with what the entry wants (see the file header). */
function reconcileEntry(db: Db, feed: AgendaFeedDto, entry: AgendaEntryDto, now: Date): ReconcileOutcome {
  if (started(entry, now)) return "none";
  const nowMs = now.getTime();
  let linked = entry.reminderItemId !== null ? getItem(db, entry.reminderItemId) ?? null : null;
  if (entry.reminderItemId !== null && (!linked || linked.kind !== "reminder")) {
    link(db, entry.id, null, null, now);
    linked = null;
  }
  // Someone else (the user, or Lead for the user) cancelled the reminder: the user does not want this one.
  if (linked && linked.stage === "cancelled") {
    db.prepare("UPDATE agenda_entries SET muted = 1, reminder_planned_at = NULL, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), entry.id);
    return "muted";
  }
  const desired = desiredReminderAt(feed, entry, now);
  if (desired === null) {
    if (linked && (linked.stage === "scheduled" || linked.stage === "fired")) {
      cancelLinkedReminder(db, { id: entry.id, reminder_item_id: linked.id }, reasonForNone(entry, feed), now);
      return "cancelled";
    }
    if (entry.reminderPlannedAt !== null) link(db, entry.id, linked?.id ?? null, null, now);
    return "none";
  }
  const desiredIso = desired.toISOString();
  const planned = entry.reminderPlannedAt;
  // After an ack only a later time (the meeting moved later) earns a new reminder: a lead-time change that lands in the
  // past must not fire an acknowledged reminder again.
  if (!linked || (linked.stage === "acked" && planned !== desiredIso && desired.getTime() > nowMs)) {
    const id = createReminderFor(db, feed, entry, new Date(Math.max(desired.getTime(), nowMs)));
    link(db, entry.id, id, desiredIso, now);
    publishGatewayEvent(db, itemUpdatedEvent(id, now));
    return "created";
  }
  if (planned === desiredIso || linked.stage === "acked") return "none";
  // Shift by how far the plan moved. Without a user reschedule the item sits at the plan, so this lands on desired.
  const base = linked.remind_at ? Date.parse(linked.remind_at) : Date.parse(planned ?? desiredIso);
  const delta = planned === null ? desired.getTime() - base : desired.getTime() - Date.parse(planned);
  const shifted = new Date(base + delta);
  if (linked.stage === "scheduled") {
    setItemTime(db, linked.id, { remindAt: new Date(Math.max(shifted.getTime(), nowMs)).toISOString() });
  } else if (shifted.getTime() > nowMs) {
    // Fired already, and the meeting moved later: wait again for the new time.
    db.prepare("UPDATE items SET remind_at = ?, updated_at = ? WHERE id = ?").run(shifted.toISOString(), now.toISOString(), linked.id);
    transition(db, { itemId: linked.id, to: "scheduled", actor: "system", reason: "agenda entry moved", now });
  }
  link(db, entry.id, linked.id, desiredIso, now);
  publishGatewayEvent(db, itemUpdatedEvent(linked.id, now));
  return "moved";
}

function reasonForNone(entry: AgendaEntryDto, feed: AgendaFeedDto): string {
  if (entry.removedAt) return "agenda entry removed";
  if (entry.status === "cancelled") return "agenda entry cancelled";
  if (entry.muted) return "agenda entry muted";
  if (entry.sourceSkip) return "agenda source skips this entry";
  if (!feed.enabled || !feed.remind.enabled) return "agenda feed reminders off";
  return "agenda entry needs no reminder";
}

function emptyCounts(): AgendaSyncResult["reminders"] {
  return { created: 0, moved: 0, cancelled: 0, muted: 0 };
}

function count(counts: AgendaSyncResult["reminders"], outcome: ReconcileOutcome): void {
  if (outcome !== "none") counts[outcome]++;
}

/** Reconcile every entry of a feed that has not started yet. Call inside or outside a transaction. */
export function reconcileAgendaFeed(db: Db, name: string, now: Date): AgendaSyncResult["reminders"] {
  return db.transaction(() => {
    const counts = emptyCounts();
    const feed = getAgendaFeed(db, name);
    if (!feed) return counts;
    // Entries that started more than a day ago cannot need anything; the bound keeps the scan small.
    const rows = entryRows(db, "SELECT * FROM agenda_entries WHERE feed = ? AND starts_at >= ? ORDER BY starts_at, id",
      [name, new Date(now.getTime() - DAY).toISOString()]);
    for (const row of rows) count(counts, reconcileEntry(db, feed, toDto(row), now));
    return counts;
  })();
}

/** The user's (or Lead's) own setting for one entry: mute it, or change its lead time. Reconciles right away. */
export function setAgendaEntryRemind(db: Db, id: number, patch: AgendaEntryPatch, now: Date): AgendaEntryDto | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM agenda_entries WHERE id = ?").get(id) as EntryRow | undefined;
    if (!row) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.muted !== undefined) {
      sets.push("muted = ?");
      values.push(patch.muted ? 1 : 0);
      // Unmuting an entry whose reminder the user had cancelled: forget that reminder so a new one gets created.
      if (!patch.muted && row.reminder_item_id !== null && getItem(db, row.reminder_item_id)?.stage === "cancelled") {
        sets.push("reminder_item_id = NULL", "reminder_planned_at = NULL");
      }
    }
    if (patch.minutesBefore !== undefined) {
      sets.push("minutes_before = ?");
      values.push(patch.minutesBefore);
    }
    sets.push("updated_at = ?");
    values.push(now.toISOString());
    db.prepare(`UPDATE agenda_entries SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const feed = getAgendaFeed(db, row.feed);
    const entry = getAgendaEntry(db, id)!;
    if (feed) reconcileEntry(db, feed, entry, now);
    return getAgendaEntry(db, id);
  })();
}

// ── sync ──────────────────────────────────────────────────────────────────────────

/**
 * Write a snapshot of the feed's window and reconcile reminders, in one transaction (spec section 3).
 * Bad entries are skipped and counted. Returns null when the feed does not exist.
 */
export function syncAgendaFeed(db: Db, name: string, snapshot: AgendaSnapshot, now: Date): AgendaSyncResult | null {
  return db.transaction((): AgendaSyncResult | null => {
    const feed = getAgendaFeed(db, name);
    if (!feed) return null;
    const at = now.toISOString();
    const baseline = feed.baselinedAt === null;
    const result: AgendaSyncResult = {
      feed: name, received: snapshot.entries.length, rejected: 0, inserted: 0, updated: 0, removed: 0,
      reminders: emptyCounts(), baseline, changedEvent: null,
    };
    const horizon = now.getTime() + AGENDA_FEED_LIMITS.changeHorizonHours * HOUR;
    const near = (iso: string) => Date.parse(iso) > now.getTime() && Date.parse(iso) <= horizon;
    const changes = { moved: 0, cancelled: 0, removed: 0, entryIds: [] as number[] };
    const noteChange = (row: EntryRow, kind: "moved" | "cancelled" | "removed", newStart: string) => {
      if (baseline) return;
      if (row.reminder_item_id === null && row.reminder_planned_at === null) return;
      if (!near(row.starts_at) && !near(newStart)) return;
      changes[kind]++;
      changes.entryIds.push(row.id);
    };

    const seen = new Set<string>();
    for (const raw of snapshot.entries.slice(0, AGENDA_FEED_LIMITS.maxEntries)) {
      const parsed = normalizeAgendaEntry(raw);
      if (!parsed.ok || seen.has(parsed.entry.key)) {
        result.rejected++;
        continue;
      }
      const entry = parsed.entry;
      seen.add(entry.key);
      const hash = contentHash(entry);
      const existing = db.prepare("SELECT * FROM agenda_entries WHERE feed = ? AND key = ?").get(name, entry.key) as EntryRow | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO agenda_entries (feed, key, title, starts_at, ends_at, all_day, status, location, url,
             source_skip, source_minutes_before, content_hash, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(name, entry.key, entry.title, entry.startsAt, entry.endsAt, entry.allDay ? 1 : 0, entry.status, entry.location,
          entry.url, entry.sourceSkip ? 1 : 0, entry.sourceMinutesBefore, hash, at, at);
        result.inserted++;
        continue;
      }
      if (existing.content_hash === hash && existing.removed_at === null) continue;
      if (existing.starts_at !== entry.startsAt) noteChange(existing, "moved", entry.startsAt);
      else if (existing.status !== "cancelled" && entry.status === "cancelled") noteChange(existing, "cancelled", entry.startsAt);
      db.prepare(
        `UPDATE agenda_entries SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, status = ?, location = ?, url = ?,
           source_skip = ?, source_minutes_before = ?, content_hash = ?, removed_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(entry.title, entry.startsAt, entry.endsAt, entry.allDay ? 1 : 0, entry.status, entry.location, entry.url,
        entry.sourceSkip ? 1 : 0, entry.sourceMinutesBefore, hash, at, existing.id);
      result.updated++;
    }
    result.rejected += Math.max(0, snapshot.entries.length - AGENDA_FEED_LIMITS.maxEntries);

    // A complete snapshot: entries inside the window that the source no longer lists are gone.
    if (snapshot.complete !== false) {
      const from = new Date(now.getTime() - feed.window.pastHours * HOUR).toISOString();
      const to = new Date(now.getTime() + feed.window.futureDays * DAY).toISOString();
      const inWindow = entryRows(db,
        "SELECT * FROM agenda_entries WHERE feed = ? AND removed_at IS NULL AND starts_at >= ? AND starts_at < ?", [name, from, to]);
      for (const row of inWindow) {
        if (seen.has(row.key)) continue;
        noteChange(row, "removed", row.starts_at);
        db.prepare("UPDATE agenda_entries SET removed_at = ?, updated_at = ? WHERE id = ?").run(at, at, row.id);
        result.removed++;
      }
    }

    result.reminders = reconcileAgendaFeed(db, name, now);
    writeFeed(db, {
      ...feed, lastSyncAt: at, lastSyncStatus: "ok", lastError: null, baselinedAt: feed.baselinedAt ?? at,
    });

    const total = changes.moved + changes.cancelled + changes.removed;
    if (total > 0) {
      const { event, inserted } = appendEvent(db, {
        source: AGENDA_EVENT_SOURCE,
        sourceRef: `${name}:changed:${at}`,
        kind: AGENDA_CHANGED_KIND,
        entityKey: `agenda:${name}`,
        occurredAt: at,
        level: "digest",
        payload: {
          feed: name, label: feed.label, moved: changes.moved, cancelled: changes.cancelled, removed: changes.removed,
          entryIds: changes.entryIds,
          // No titles: the summary shows outside the external tag.
          summary: `${feed.label}: ${total} upcoming ${total === 1 ? "entry" : "entries"} changed`,
        },
      }, { receivedAt: now });
      if (inserted) result.changedEvent = event.seq;
    }
    return result;
  })();
}
