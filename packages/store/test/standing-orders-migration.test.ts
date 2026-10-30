// v44：常设指令（Lead 事件主干 spec D4，工单 05）。加 standing_orders 表（由 SCHEMA 建），给 events 加一列 triage，
// 第一批指令（系统种子）在 openDb 时同步进表。三条路径：新库、老库（v43）升级、重新打开。
// 其他表和行不变，item 的生命周期字段不变，已有的事件不变（triage 是 null：它们由 01 的默认分诊定的级别）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, LATEST_SCHEMA_VERSION, listStandingOrders, openDb, SYSTEM_STANDING_ORDERS,
  transition, updateRun, type Db,
} from "../src/index.js";

const STANDING_ORDER_COLUMNS = [
  "order_id", "version", "title", "priority", "condition", "action", "limits", "escalate_to", "author", "approved_by",
  "status", "reason", "created_at", "seed_revision",
];
const V43_EVENT_COLUMNS = [
  "seq", "event_id", "source", "source_ref", "kind", "entity_key", "entity_version", "occurred_at", "received_at",
  "causation_id", "correlation_id", "payload", "root_cause", "level", "disposition", "disposition_detail", "disposed_at",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const orderRows = (db: Db) => db.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all();
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v44 standing orders migration", () => {
  it("creates the table, the triage column and the first standing orders in a new database", () => {
    const db = openDb(join(tempDir("plc-v44-fresh-"), "plc.db"));
    expect(columns(db, "standing_orders")).toEqual(STANDING_ORDER_COLUMNS);
    expect(columns(db, "events")).toEqual([...V43_EVENT_COLUMNS, "triage"]);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 44").get()).toEqual({ name: "standing-orders-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
    const orders = listStandingOrders(db);
    expect(orders.map((order) => order.id).sort()).toEqual(SYSTEM_STANDING_ORDERS.map((order) => order.id).sort());
    // 新库里每条都是第 1 版，修订号是代码里种子现在的修订号（工单 14 把 model_catalog.announce 改到了 2）。
    const revisions = new Map(SYSTEM_STANDING_ORDERS.map((order) => [order.id, order.seedRevision]));
    expect(orders.every((order) => order.version === 1 && order.author === "system" && order.status === "active"
      && order.approvedBy === null && order.seedRevision === revisions.get(order.id))).toBe(true);
    db.close();
  });

  it("upgrades a v43 database without changing any other table, row, event or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v44-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v43 的样子：没有 standing_orders 表和它的触发器，events 没有 triage 列，也没有 v44 的记录。
    legacy.exec(`
      DROP TRIGGER standing_orders_append_only_update;
      DROP TRIGGER standing_orders_append_only_delete;
      DROP TABLE standing_orders;
      ALTER TABLE events DROP COLUMN triage;
    `);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 44").run();
    expect(columns(legacy, "events")).toEqual(V43_EVENT_COLUMNS);
    const tablesBefore = tables(legacy);
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      events: db.prepare(`SELECT ${V43_EVENT_COLUMNS.join(", ")} FROM events ORDER BY seq`).all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 44 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "standing_orders"].sort());
    expect(columns(migrated, "events")).toEqual([...V43_EVENT_COLUMNS, "triage"]);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 已有的事件不回填依据。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM events WHERE triage IS NOT NULL").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(listStandingOrders(migrated)).toHaveLength(SYSTEM_STANDING_ORDERS.length);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    const ordersAfterUpgrade = orderRows(migrated);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 44").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    // 重新打开不写新版本：同步是幂等的。
    expect(orderRows(reopened)).toEqual(ordersAfterUpgrade);
    reopened.close();
  });

  it("keeps the standing orders, their versions and the events when a database at v44 is reopened", () => {
    const path = join(tempDir("plc-v44-reopen-"), "plc.db");
    const first = openDb(path);
    const itemId = createItem(first, { title: "t", brief: "b", createdBy: "user" });
    transition(first, { itemId, to: "active", actor: "system", reason: "spawn" });
    const ordersBefore = orderRows(first);
    const eventsBefore = first.prepare("SELECT * FROM events ORDER BY seq").all();
    expect(eventsBefore).toHaveLength(1);
    expect(JSON.parse((eventsBefore[0] as { triage: string }).triage)).toEqual({ order: { id: "source.ticket", version: 1 } });
    first.close();

    const reopened = openDb(path);
    expect(orderRows(reopened)).toEqual(ordersBefore);
    expect(reopened.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(eventsBefore);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 44").get()).toEqual({ n: 1 });
    reopened.close();
  });

  it("keeps every version: the table refuses updates and deletes", () => {
    const db = openDb(join(tempDir("plc-v44-append-only-"), "plc.db"));
    expect(() => db.prepare("UPDATE standing_orders SET title = 'x' WHERE order_id = 'inbox.wake_lead'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM standing_orders").run()).toThrow(/append-only/);
    expect(listStandingOrders(db)).toHaveLength(SYSTEM_STANDING_ORDERS.length);
    db.close();
  });
});
