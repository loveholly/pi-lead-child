// v50：代查（Slack 代查与按信心代回 spec D1，工单 01；v49 是 master 的 lead_waits）。只加 channel_lookups 表和三个索引（由 SCHEMA 建），
// 不改任何已有的表和行，不回填。三条路径：新库、v49 的老库升级、重新打开。item 的生命周期字段不变，卡和事件不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createChannelLookup, createItem, createRun, getActiveLookupForCard, LATEST_SCHEMA_VERSION, openChannelCard, openDb,
  recordChannelLaneMessage, SCHEMA_MIGRATION_VERSIONS, transition, updateChannelCard, updateRun, type ChannelLookupIntake, type Db,
} from "../src/index.js";

const LOOKUP_COLUMNS = [
  "id", "card_id", "source", "object_key", "for_seq", "playbook", "state", "requester", "question", "intake", "scope", "item_id",
  "run_id", "result", "reads", "verification", "reply", "version", "created_at", "updated_at", "finished_at",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const indexes = (db: Db, table: string) => (db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
).all(table) as { name: string; sql: string }[]);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

const INTAKE: ChannelLookupIntake = {
  answered: true, askKind: "lookup", askConfidence: 0.8, targetRepo: "acme/orders", sensitive: {}, topics: {}, gate: null,
  at: "2026-10-19T06:30:00.000Z",
};

function cardIn(db: Db, objectKey: string): number {
  const lane = recordChannelLaneMessage(db, {
    source: "hook", objectKey, label: "对话", message: { at: new Date().toISOString(), seq: null, role: "them", sender: "A", text: "hi" },
  });
  return openChannelCard(db, {
    laneId: lane.id, source: "hook", objectKey, delivery: "card", seq: 1,
    sender: { id: "a", name: "A", trust: "colleague" }, excerpt: "hi", replyTarget: {},
  }).id;
}

const lookupInput = (cardId: number, objectKey: string) => ({
  cardId, source: "hook", objectKey, forSeq: 1, playbook: "lookup" as const,
  requester: { id: "a", name: "A", trust: "colleague" as const }, question: "订单 123 的 webhook 为什么没触发？", intake: INTAKE,
});

describe("the v50 channel lookup migration", () => {
  it("creates the table and its three indexes in a new database", () => {
    const db = openDb(join(tempDir("plc-v50-fresh-"), "plc.db"));
    expect(columns(db, "channel_lookups")).toEqual(LOOKUP_COLUMNS);
    expect(indexes(db, "channel_lookups").map((index) => index.name)).toEqual([
      "channel_lookups_card", "channel_lookups_item", "channel_lookups_one_active",
    ]);
    expect(indexes(db, "channel_lookups").find((index) => index.name === "channel_lookups_one_active")!.sql)
      .toMatch(/UNIQUE INDEX .* ON channel_lookups\(card_id\) WHERE state IN \('queued', 'running'\)/);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 50").get()).toEqual({ name: "channel-lookups-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(50);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(50);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // 外键：卡、工单、Run 都要存在。
    expect(() => createChannelLookup(db, lookupInput(999, "hook:none"))).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("upgrades a v49 database without changing any other table, row, card, event or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v50-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    const cancelled = createItem(legacy, { title: "取消的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: cancelled, to: "cancelled", actor: "user", reason: "not needed" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // v49 时已经有的会话卡：迁移不碰它。
    const cardId = cardIn(legacy, "hook:t1");
    updateChannelCard(legacy, cardId, { state: "dismissed", resolvedAt: "2026-10-18T00:00:00.000Z" });
    cardIn(legacy, "hook:t2");
    // 退回 v49 的样子：没有 channel_lookups，也没有 v50 的记录。
    legacy.exec("DROP TABLE channel_lookups");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 50").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("channel_lookups");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      lanes: db.prepare("SELECT * FROM channel_lanes ORDER BY id").all(),
      cards: db.prepare("SELECT * FROM channel_cards ORDER BY id").all(),
      orders: db.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 50 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.cards.length).toBe(2);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "channel_lookups"].sort());
    expect(columns(migrated, "channel_lookups")).toEqual(LOOKUP_COLUMNS);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM channel_lookups").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const openCard = (migrated.prepare("SELECT id FROM channel_cards WHERE object_key = 'hook:t2'").get() as { id: number }).id;
    const lookup = createChannelLookup(migrated, lookupInput(openCard, "hook:t2"));
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 50").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(getActiveLookupForCard(reopened, openCard)).toMatchObject({ id: lookup.id, state: "queued", version: 1 });
    reopened.close();
  });

  it("allows at most one unfinished lookup per card", () => {
    const db = openDb(join(tempDir("plc-v50-one-active-"), "plc.db"));
    const cardId = cardIn(db, "hook:t1");
    const first = createChannelLookup(db, lookupInput(cardId, "hook:t1"));
    expect(() => createChannelLookup(db, lookupInput(cardId, "hook:t1"))).toThrow(/UNIQUE/);
    expect(() => createChannelLookup(db, { ...lookupInput(cardId, "hook:t1"), state: "running" })).toThrow(/UNIQUE/);
    // 被拒的那一次不占位置。
    expect(createChannelLookup(db, { ...lookupInput(cardId, "hook:t1"), state: "denied" }).state).toBe("denied");
    db.prepare("UPDATE channel_lookups SET state = 'cancelled' WHERE id = ?").run(first.id);
    expect(createChannelLookup(db, lookupInput(cardId, "hook:t1")).id).not.toBe(first.id);
    db.close();
  });
});
