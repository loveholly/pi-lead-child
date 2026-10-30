// v48：提醒的设置（工单 07）。items 加一列 reminder_policy（JSON），只加列，不回填，不改 item 的生命周期字段。
// 三条路径：新库、老库（v47）升级、重新打开。v48 之前建的提醒按缺省设置（tell、不提前、不重复）处理。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_REMINDER_POLICY } from "@pi-lead-child/protocol";
import {
  createItem, getItem, LATEST_SCHEMA_VERSION, openDb, reminderPolicyOf, SCHEMA_MIGRATION_VERSIONS, transition, type Db,
} from "../src/index.js";

const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, remind_at, due_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v48 reminder policy migration", () => {
  it("adds the column in a new database and stores the settings of a new reminder", () => {
    const db = openDb(join(tempDir("plc-v48-fresh-"), "plc.db"));
    expect(columns(db, "items")).toContain("reminder_policy");
    expect(columns(db, "items").at(-1)).toBe("reminder_policy");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 48").get()).toEqual({ name: "reminder-policy-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(48);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(48);
    const policy = { level: "interrupt" as const, earlyMs: 300_000, repeat: { everyMs: 120_000, max: 5 }, ticketId: null, check: null };
    const id = createItem(db, { kind: "reminder", title: "抢票", brief: "", createdBy: "lead", remindAt: "2026-10-18T01:00:00.000Z", reminderPolicy: policy });
    expect(reminderPolicyOf(getItem(db, id)!)).toEqual(policy);
    // 只有提醒有设置；设置不合格时不写。
    expect(() => createItem(db, { title: "任务", brief: "b", createdBy: "user", reminderPolicy: policy })).toThrow(/only a reminder/);
    expect(() => createItem(db, {
      kind: "reminder", title: "x", brief: "", createdBy: "lead", remindAt: "2026-10-18T01:00:00.000Z",
      reminderPolicy: { ...policy, repeat: { everyMs: 1_000, max: 5 } },
    })).toThrow(/invalid reminder settings/);
    db.close();
  });

  it("upgrades a v47 database without changing any item, lifecycle field or event, then reopens", () => {
    const path = join(tempDir("plc-v48-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const waiting = createItem(legacy, { kind: "reminder", title: "交周报", brief: "", createdBy: "lead", remindAt: "2026-10-20T01:00:00.000Z" });
    const fired = createItem(legacy, { kind: "reminder", title: "体检", brief: "", createdBy: "lead", remindAt: "2026-10-01T01:00:00.000Z" });
    transition(legacy, { itemId: fired, to: "fired", actor: "system", reason: "remind_at reached" });
    const acked = createItem(legacy, { kind: "reminder", title: "缴费", brief: "", createdBy: "lead", remindAt: "2026-10-01T01:00:00.000Z" });
    transition(legacy, { itemId: acked, to: "fired", actor: "system", reason: "remind_at reached" });
    transition(legacy, { itemId: acked, to: "acked", actor: "user", reason: "acked by user" });
    // 退回 v47 的样子：没有 reminder_policy 这一列，也没有 v48 的记录。
    legacy.exec("ALTER TABLE items DROP COLUMN reminder_policy");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 48").run();
    expect(columns(legacy, "items")).not.toContain("reminder_policy");
    const legacyColumns = columns(legacy, "items");
    const snapshot = (db: Db) => ({
      items: db.prepare(`SELECT ${legacyColumns.join(", ")} FROM items ORDER BY id`).all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      notifications: db.prepare("SELECT * FROM notifications ORDER BY id").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 48 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    legacy.close();

    const migrated = openDb(path);
    expect(columns(migrated, "items")).toContain("reminder_policy");
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：已有的提醒是 NULL，按缺省设置。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM items WHERE reminder_policy IS NOT NULL").get()).toEqual({ n: 0 });
    for (const id of [waiting, fired, acked]) expect(reminderPolicyOf(getItem(migrated, id)!)).toEqual(DEFAULT_REMINDER_POLICY);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 48").get()).toEqual({ n: 1 });
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  });
});
