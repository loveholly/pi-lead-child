// v43：事件日志（Lead 事件主干 spec D1、D15，工单 01）。只加 events 表：表由 SCHEMA 建，迁移只记版本。
// 三条路径：新库、老库（v42）升级、重新打开。其他表和行不变，item 的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, LATEST_SCHEMA_VERSION, openDb, transition, updateRun, type Db,
} from "../src/index.js";

// v44（工单 05）在末尾加了一列 triage（分诊依据）。新建的 events 表带着它。
const EVENT_COLUMNS = [
  "seq", "event_id", "source", "source_ref", "kind", "entity_key", "entity_version", "occurred_at", "received_at",
  "causation_id", "correlation_id", "payload", "root_cause", "level", "disposition", "disposition_detail", "disposed_at",
  "triage",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v43 event log migration", () => {
  it("creates the events table in a new database and records v43", () => {
    const db = openDb(join(tempDir("plc-v43-fresh-"), "plc.db"));
    expect(columns(db, "events")).toEqual(EVENT_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 43").get()).toEqual({ name: "event-log-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    db.close();
  });

  it("adds the table to a v42 database without changing any other table, row or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v43-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "attention", source: "structural", summary: "旧通知" });
    // 退回 v42 的样子：没有 events 表、它的触发器和索引，也没有 v43 的记录。
    legacy.exec("DROP TRIGGER events_inbox_retracted; DROP TRIGGER events_notification_retracted; DROP TABLE events");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 43").run();
    const tablesBefore = tables(legacy);
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 43 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "events"].sort());
    expect(columns(migrated, "events")).toEqual(EVENT_COLUMNS);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    // 迁移不从历史回填事件：升级不会凭空产生一批要处置的事。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 43").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    reopened.close();
  });

  it("keeps the log and the version when a database at v43 is reopened", () => {
    const path = join(tempDir("plc-v43-reopen-"), "plc.db");
    const first = openDb(path);
    const itemId = createItem(first, { title: "t", brief: "b", createdBy: "user" });
    transition(first, { itemId, to: "active", actor: "system", reason: "spawn" });
    const eventsBefore = first.prepare("SELECT * FROM events ORDER BY seq").all();
    expect(eventsBefore).toHaveLength(1);
    first.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(eventsBefore);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 43").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
