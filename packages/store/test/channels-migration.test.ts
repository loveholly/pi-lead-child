// v46：通道（工单 11）。只加 channel_lanes、channel_cards 两张表（由 SCHEMA 建），不改任何已有的表和行，不回填。
// 三条路径：新库、老库升级、重新打开。item 的生命周期字段不变，事件不变。
// 老库是「v46 之前」的样子：它可能已经有了后来的迁移（v47，工单 15，只给 bindings、pairings 加列）。v46 补在后面也对：
// 两个迁移都只加表或加列，互不依赖，按任意顺序执行结果一样。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, getOpenChannelCard, LATEST_SCHEMA_VERSION, openChannelCard, openDb, recordChannelLaneMessage,
  SCHEMA_MIGRATION_VERSIONS, transition, updateRun, type Db,
} from "../src/index.js";

const LANE_COLUMNS = ["id", "source", "object_key", "label", "context", "summary", "last_seq", "created_at", "updated_at"];
const CARD_COLUMNS = [
  "id", "lane_id", "source", "object_key", "version", "state", "delivery", "first_seq", "last_seq", "message_count", "sender",
  "excerpt", "reply_target", "draft", "gate", "sent", "snoozed_until", "revoke_until", "resolved_at", "resolution", "created_at",
  "updated_at",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

function lane(db: Db, objectKey: string) {
  return recordChannelLaneMessage(db, {
    source: "hook", objectKey, label: "对话", message: { at: new Date().toISOString(), seq: null, role: "them", sender: "A", text: "hi" },
  });
}

describe("the v46 channel migration", () => {
  it("creates the lane and card tables in a new database", () => {
    const db = openDb(join(tempDir("plc-v46-fresh-"), "plc.db"));
    expect(columns(db, "channel_lanes")).toEqual(LANE_COLUMNS);
    expect(columns(db, "channel_cards")).toEqual(CARD_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 46").get()).toEqual({ name: "channels-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(46);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(46);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    db.close();
  });

  it("upgrades a database from before v46 (which already has v47) without changing any other table, row, event or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v46-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v46 之前的样子：没有通道的两张表，也没有 v46 的记录。v47 的列还在。
    expect(columns(legacy, "bindings")).toContain("origin");
    legacy.exec("DROP TABLE channel_cards; DROP TABLE channel_lanes;");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 46").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("channel_lanes");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      orders: db.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all(),
      shadow: db.prepare("SELECT * FROM event_triage_shadow ORDER BY id").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 46 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "channel_cards", "channel_lanes"].sort());
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM channel_cards").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    const created = lane(migrated, "hook:t1");
    openChannelCard(migrated, {
      laneId: created.id, source: "hook", objectKey: "hook:t1", delivery: "card", seq: 1,
      sender: { id: "a", name: "A", trust: "colleague" }, excerpt: "hi", replyTarget: {},
    });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 46").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(getOpenChannelCard(reopened, "hook:t1")).toMatchObject({ state: "open", version: 1, delivery: "card" });
    reopened.close();
  });

  it("runs v46 and v47 in either order: both only add tables or columns", () => {
    const path = join(tempDir("plc-v46-v47-"), "plc.db");
    const fresh = openDb(path);
    const expected = { lanes: columns(fresh, "channel_lanes"), bindings: columns(fresh, "bindings"), pairings: columns(fresh, "pairings") };
    // 两个都退回：没有通道的表，bindings 和 pairings 没有 origin，也没有 v46、v47 的记录。
    fresh.exec(`
      DROP TABLE channel_cards; DROP TABLE channel_lanes;
      ALTER TABLE bindings DROP COLUMN origin; ALTER TABLE pairings DROP COLUMN origin;
    `);
    fresh.prepare("DELETE FROM schema_migrations WHERE version IN (46, 47)").run();
    fresh.close();
    const upgraded = openDb(path);
    expect({ lanes: columns(upgraded, "channel_lanes"), bindings: columns(upgraded, "bindings"), pairings: columns(upgraded, "pairings") })
      .toEqual(expected);
    expect(upgraded.prepare("SELECT version, name FROM schema_migrations WHERE version IN (46, 47) ORDER BY version").all())
      .toEqual([{ version: 46, name: "channels-v1" }, { version: 47, name: "binding-origin-v1" }]);
    upgraded.close();
    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (46, 47)").get()).toEqual({ n: 2 });
    reopened.close();
  });

  it("allows at most one unfinished card per conversation", () => {
    const db = openDb(join(tempDir("plc-v46-one-open-"), "plc.db"));
    const created = lane(db, "hook:t1");
    const input = {
      laneId: created.id, source: "hook", objectKey: "hook:t1", delivery: "card" as const, seq: 1,
      sender: { id: "a", name: "A", trust: "colleague" as const }, excerpt: "hi", replyTarget: {},
    };
    const first = openChannelCard(db, input);
    expect(() => openChannelCard(db, input)).toThrow(/UNIQUE/);
    db.prepare("UPDATE channel_cards SET state = 'dismissed' WHERE id = ?").run(first.id);
    expect(openChannelCard(db, input).id).not.toBe(first.id);
    db.close();
  });
});
