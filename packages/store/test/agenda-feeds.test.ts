// External agenda feeds: snapshot sync, pre-created reminders and their reconciliation, the v66 migration.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createAgendaFeed, createItem, deleteAgendaFeed, getAgendaEntry, getAgendaFeed, getItem, LATEST_SCHEMA_VERSION, listAgendaEntries,
  listEvents, openDb, reminderPolicyOf, reminderTimeOrigin, rescheduleReminder, SCHEMA_MIGRATION_VERSIONS, setAgendaEntryRemind,
  syncAgendaFeed, transition, updateAgendaFeed, type Db,
} from "../src/index.js";

const NOW = new Date("2026-11-12T08:00:00.000Z");
const at = (iso: string) => new Date(iso);
const minutes = (n: number) => n * 60_000;

function fresh(): Db {
  const db = openDb(join(tempDir("plc-agenda-"), "plc.db"));
  createAgendaFeed(db, { name: "work", label: "Work calendar" }, { by: "lead", now: NOW });
  return db;
}

function entry(key: string, startsAt: string, extra: Record<string, unknown> = {}) {
  return { key, title: `Meeting ${key}`, startsAt, ...extra };
}

function reminderOf(db: Db, key: string) {
  const row = listAgendaEntries(db, { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z", includeRemoved: true })
    .find((candidate) => candidate.key === key)!;
  return { entry: row, item: row.reminderItemId === null ? null : getItem(db, row.reminderItemId)! };
}

describe("agenda feed sync", () => {
  it("pre-creates an important reminder five minutes before each confirmed meeting, set by the system for an external source", () => {
    const db = fresh();
    const result = syncAgendaFeed(db, "work", {
      entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-13T02:30:00Z")],
    }, NOW)!;
    expect(result).toMatchObject({ received: 2, inserted: 2, rejected: 0, baseline: true, changedEvent: null });
    expect(result.reminders.created).toBe(2);
    const { item } = reminderOf(db, "a");
    expect(item).toMatchObject({ kind: "reminder", stage: "scheduled", created_by: "system", title: "Meeting a" });
    expect(item!.remind_at).toBe("2026-11-12T09:55:00.000Z");
    expect(reminderPolicyOf(item!).level).toBe("interrupt");
    expect(reminderTimeOrigin(db, item!.id)).toMatchObject({ kind: "external", source: "agenda", sourceLabel: "Work calendar" });
    expect(getAgendaFeed(db, "work")).toMatchObject({ lastSyncStatus: "ok", baselinedAt: NOW.toISOString() });
    db.close();
  });

  it("skips cancelled, tentative, source-skipped and past meetings, and all-day entries unless the feed sets a time", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", {
      entries: [
        entry("cancelled", "2026-11-12T10:00:00Z", { status: "cancelled" }),
        entry("tentative", "2026-11-12T11:00:00Z", { status: "tentative" }),
        entry("declined", "2026-11-12T12:00:00Z", { remind: { skip: true } }),
        entry("past", "2026-11-12T07:00:00Z"),
        entry("allday", "2026-11-14"),
      ],
    }, NOW);
    for (const key of ["cancelled", "tentative", "declined", "past", "allday"]) expect(reminderOf(db, key).item).toBeNull();
    expect(reminderOf(db, "allday").entry.allDay).toBe(true);

    updateAgendaFeed(db, "work", { remind: { allDayAt: "09:00", statuses: ["confirmed", "tentative"] } }, NOW);
    const allDay = reminderOf(db, "allday").item!;
    const local = new Date(allDay.remind_at!);
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 10, 14, 9, 0]);
    expect(reminderOf(db, "tentative").item!.remind_at).toBe("2026-11-12T10:55:00.000Z");
    db.close();
  });

  it("reminds right away for a meeting that starts within the lead time", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("soon", "2026-11-12T08:03:00Z")] }, NOW);
    expect(reminderOf(db, "soon").item!.remind_at).toBe(NOW.toISOString());
    db.close();
  });

  it("rejects bad entries and duplicate keys without failing the snapshot", () => {
    const db = fresh();
    const result = syncAgendaFeed(db, "work", {
      entries: [
        entry("ok", "2026-11-12T10:00:00Z"),
        entry("ok", "2026-11-12T11:00:00Z"),
        entry("bad-time", "tomorrow"),
        entry("bad-url", "2026-11-12T10:00:00Z", { url: "javascript:alert(1)" }),
        { key: "no-title", startsAt: "2026-11-12T10:00:00Z" },
      ],
    }, NOW)!;
    expect(result).toMatchObject({ inserted: 1, rejected: 4 });
    db.close();
  });
});

describe("reminder reconciliation", () => {
  it("moves the reminder with the meeting and keeps a reminder the user moved relative to the meeting", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T12:00:00Z")] }, NOW);
    // The user moves b's reminder 30 minutes before the meeting instead of 5.
    const b = reminderOf(db, "b").item!;
    rescheduleReminder(db, b.id, at("2026-11-12T11:30:00Z"), { by: "user", now: NOW });

    // Same snapshot again: nothing moves, the user's time stays.
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T12:00:00Z")] }, NOW);
    expect(getItem(db, b.id)!.remind_at).toBe("2026-11-12T11:30:00.000Z");

    // Both meetings move one hour later.
    const result = syncAgendaFeed(db, "work", {
      entries: [entry("a", "2026-11-12T11:00:00Z"), entry("b", "2026-11-12T13:00:00Z")],
    }, NOW)!;
    expect(result.reminders.moved).toBe(2);
    expect(reminderOf(db, "a").item!.remind_at).toBe("2026-11-12T10:55:00.000Z");
    expect(getItem(db, b.id)!.remind_at).toBe("2026-11-12T12:30:00.000Z");
    const lastSetter = db.prepare(
      "SELECT actor, payload FROM activities WHERE item_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT 1",
    ).get(reminderOf(db, "a").item!.id) as { actor: string; payload: string };
    expect(lastSetter.actor).toBe("system");
    expect(JSON.parse(lastSetter.payload).remindAt).toBe("2026-11-12T10:55:00.000Z");
    expect(reminderOf(db, "b").item!.id).toBe(b.id);
    db.close();
  });

  it("cancels the reminder of a cancelled meeting and of one that disappeared from a complete snapshot", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T12:00:00Z")] }, NOW);
    const a = reminderOf(db, "a").item!;
    const b = reminderOf(db, "b").item!;
    const result = syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z", { status: "cancelled" })] }, NOW)!;
    expect(result).toMatchObject({ removed: 1 });
    expect(result.reminders.cancelled).toBe(2);
    expect(getItem(db, a.id)!.stage).toBe("cancelled");
    expect(getItem(db, b.id)!.stage).toBe("cancelled");
    expect(reminderOf(db, "a").entry.reminderItemId).toBeNull();
    expect(reminderOf(db, "b").entry.removedAt).toBe(NOW.toISOString());
    // A system cancel is not a user mute: the meeting coming back gets a new reminder.
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T12:00:00Z")] }, NOW);
    expect(reminderOf(db, "a").item).toMatchObject({ stage: "scheduled" });
    expect(reminderOf(db, "b").entry.removedAt).toBeNull();
    expect(reminderOf(db, "b").item!.id).not.toBe(b.id);
    db.close();
  });

  it("removes nothing from an incomplete snapshot, nor outside the sync window", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("near", "2026-11-12T10:00:00Z"), entry("far", "2026-12-20T10:00:00Z")] }, NOW);
    expect(syncAgendaFeed(db, "work", { entries: [], complete: false }, NOW)!.removed).toBe(0);
    expect(syncAgendaFeed(db, "work", { entries: [] }, NOW)!.removed).toBe(1);
    expect(reminderOf(db, "near").entry.removedAt).not.toBeNull();
    expect(reminderOf(db, "far").entry.removedAt).toBeNull();
    db.close();
  });

  it("treats a reminder the user cancelled as a mute, and unmuting brings a new one", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z")] }, NOW);
    const first = reminderOf(db, "a").item!;
    transition(db, { itemId: first.id, to: "cancelled", actor: "user", reason: "not needed" });
    const result = syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:30:00Z")] }, NOW)!;
    expect(result.reminders).toMatchObject({ muted: 1, created: 0 });
    expect(reminderOf(db, "a").entry.muted).toBe(true);

    const unmuted = setAgendaEntryRemind(db, reminderOf(db, "a").entry.id, { muted: false }, NOW)!;
    expect(unmuted.muted).toBe(false);
    const second = getItem(db, unmuted.reminderItemId!)!;
    expect(second.id).not.toBe(first.id);
    expect(second.remind_at).toBe("2026-11-12T10:25:00.000Z");
    db.close();
  });

  it("mutes one entry and changes one entry's lead time right away", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z")] }, NOW);
    const id = reminderOf(db, "a").entry.id;
    const reminder = reminderOf(db, "a").item!;
    setAgendaEntryRemind(db, id, { minutesBefore: 15 }, NOW);
    expect(getItem(db, reminder.id)!.remind_at).toBe("2026-11-12T09:45:00.000Z");
    setAgendaEntryRemind(db, id, { muted: true }, NOW);
    expect(getItem(db, reminder.id)!.stage).toBe("cancelled");
    expect(getAgendaEntry(db, id)).toMatchObject({ muted: true, reminderItemId: null });
    // A later sync keeps the user's mute.
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z")] }, NOW);
    expect(getAgendaEntry(db, id)!.reminderItemId).toBeNull();
    db.close();
  });

  it("puts a fired reminder back to waiting when the meeting moves later, and reminds again after an ack", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T11:00:00Z")] }, NOW);
    const a = reminderOf(db, "a").item!;
    const b = reminderOf(db, "b").item!;
    transition(db, { itemId: a.id, to: "fired", actor: "system", reason: "remind_at reached" });
    transition(db, { itemId: b.id, to: "fired", actor: "system", reason: "remind_at reached" });
    transition(db, { itemId: b.id, to: "acked", actor: "user", reason: "seen" });

    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T12:00:00Z"), entry("b", "2026-11-12T13:00:00Z")] }, NOW);
    expect(getItem(db, a.id)).toMatchObject({ stage: "scheduled", remind_at: "2026-11-12T11:55:00.000Z" });
    // The move is on record as the system's, for the external source, like any other reschedule.
    const activities = db.prepare("SELECT actor, kind, payload FROM activities WHERE item_id = ? ORDER BY id").all(a.id) as
      Array<{ actor: string; kind: string; payload: string }>;
    const back = activities.find((row) => row.kind === "transition" && JSON.parse(row.payload).to === "scheduled")!;
    expect(back.actor).toBe("system");
    expect(JSON.parse(back.payload).reason).toContain("agenda entry moved");
    const setter = activities.filter((row) => row.kind === "decision").at(-1)!;
    expect(setter.actor).toBe("system");
    expect(JSON.parse(setter.payload)).toMatchObject({ remindAt: "2026-11-12T11:55:00.000Z", origin: { kind: "external", source: "agenda" } });
    expect(getItem(db, b.id)!.stage).toBe("acked");
    const again = reminderOf(db, "b").item!;
    expect(again.id).not.toBe(b.id);
    expect(again).toMatchObject({ stage: "scheduled", remind_at: "2026-11-12T12:55:00.000Z" });
    db.close();
  });

  it("does not remind again after an ack when only the lead time changes into the past", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T08:04:00Z")] }, NOW);
    const first = reminderOf(db, "a").item!;
    transition(db, { itemId: first.id, to: "fired", actor: "system", reason: "remind_at reached" });
    transition(db, { itemId: first.id, to: "acked", actor: "user", reason: "seen" });
    updateAgendaFeed(db, "work", { remind: { minutesBefore: 10 } }, NOW);
    expect(reminderOf(db, "a").item!.id).toBe(first.id);
    db.close();
  });

  it("follows the feed: a new default lead time moves reminders, turning reminders off cancels them", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z")] }, NOW);
    const reminder = reminderOf(db, "a").item!;
    updateAgendaFeed(db, "work", { remind: { minutesBefore: 10, level: "tell" } }, NOW);
    expect(getItem(db, reminder.id)!.remind_at).toBe("2026-11-12T09:50:00.000Z");
    updateAgendaFeed(db, "work", { enabled: false }, NOW);
    expect(getItem(db, reminder.id)!.stage).toBe("cancelled");
    db.close();
  });

  it("deleting a feed cancels its open reminders and drops its entries", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", { entries: [entry("a", "2026-11-12T10:00:00Z")] }, NOW);
    const reminder = reminderOf(db, "a").item!;
    expect(deleteAgendaFeed(db, "work", NOW)).toEqual({ cancelled: 1 });
    expect(getItem(db, reminder.id)!.stage).toBe("cancelled");
    expect(getAgendaFeed(db, "work")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agenda_entries").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("agenda change events", () => {
  it("raises no event for the baseline, then one digest event per sync for soon meetings that moved, got cancelled or vanished", () => {
    const db = fresh();
    syncAgendaFeed(db, "work", {
      entries: [entry("a", "2026-11-12T10:00:00Z"), entry("b", "2026-11-12T11:00:00Z"), entry("c", "2026-11-12T12:00:00Z"),
        entry("far", "2026-11-20T10:00:00Z")],
    }, NOW);
    expect(listEvents(db, { kind: "agenda.changed" })).toHaveLength(0);

    const result = syncAgendaFeed(db, "work", {
      entries: [entry("a", "2026-11-12T10:30:00Z"), entry("b", "2026-11-12T11:00:00Z", { status: "cancelled" }),
        entry("far", "2026-11-21T10:00:00Z")],
    }, NOW)!;
    const events = listEvents(db, { kind: "agenda.changed" });
    expect(events).toHaveLength(1);
    expect(result.changedEvent).toBe(events[0]!.seq);
    expect(events[0]).toMatchObject({ source: "agenda", level: "digest" });
    expect(events[0]!.payload).toMatchObject({ feed: "work", moved: 1, cancelled: 1, removed: 1 });
    expect(String(events[0]!.payload.summary)).not.toContain("Meeting");

    // A sync with no change raises nothing.
    syncAgendaFeed(db, "work", {
      entries: [entry("a", "2026-11-12T10:30:00Z"), entry("b", "2026-11-12T11:00:00Z", { status: "cancelled" }),
        entry("far", "2026-11-21T10:00:00Z")],
    }, NOW);
    expect(listEvents(db, { kind: "agenda.changed" })).toHaveLength(1);
    db.close();
  });
});

describe("the v66 agenda entries migration", () => {
  it("has the table and the version in a new database", () => {
    const db = openDb(join(tempDir("plc-v66-fresh-"), "plc.db"));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 66").get()).toEqual({ name: "agenda-entries-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(66);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agenda_entries'").get()).toBeTruthy();
    db.close();
  });

  it("upgrades a v65 database without touching items, then reopens", () => {
    const path = join(tempDir("plc-v66-legacy-"), "plc.db");
    const legacy = openDb(path);
    const reminder = createItem(legacy, { kind: "reminder", title: "r", brief: "", createdBy: "user", remindAt: "2026-11-12T10:00:00.000Z" });
    transition(legacy, { itemId: reminder, to: "fired", actor: "system", reason: "remind_at reached" });
    legacy.exec("DROP TABLE agenda_entries");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 66").run();
    const before = legacy.prepare("SELECT * FROM items ORDER BY id").all();
    legacy.close();

    const upgraded = openDb(path);
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 66").get()).toEqual({ name: "agenda-entries-v1" });
    expect(upgraded.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(before);
    expect(getItem(upgraded, reminder)!.stage).toBe("fired");
    upgraded.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 66").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(before);
    reopened.close();
  });
});
