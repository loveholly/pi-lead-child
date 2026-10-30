// v49（2026-10-19）：Lead 的等待（lead_waits，store 的 lead-waits.ts）。只加一张表和两个索引，不改任何已有的表，
// 不回填：升级以前用户做过的操作不会凭空叫醒 Lead。三条路径：新库、老库（v48）升级、重新打开。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, LATEST_SCHEMA_VERSION, listOpenLeadWaits, openDb, registerLeadWait, SCHEMA_MIGRATION_VERSIONS, transition, type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
  .map((row) => row.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, remind_at, due_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v49 lead waits migration", () => {
  it("creates the table in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v49-fresh-"), "plc.db"));
    expect(tables(db)).toContain("lead_waits");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 49").get()).toEqual({ name: "lead-waits-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(49);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(49);
    registerLeadWait(db, { entityKey: "ticket:1", note: "等用户验收", origin: "lead" });
    // 同一个对象同时只有一条在等的（部分唯一索引）。
    expect(() => db.prepare(
      "INSERT INTO lead_waits (entity_key, note, origin, expires_at, created_at, updated_at) VALUES ('ticket:1', 'x', 'lead', 'z', 'a', 'a')",
    ).run()).toThrow(/UNIQUE/u);
    db.close();
  });

  it("upgrades a v48 database without changing any item, lifecycle field or event, then reopens", () => {
    const path = join(tempDir("plc-v49-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    const done = createItem(legacy, { title: "做完的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "cancelled", actor: "user", reason: "not needed" });
    // 退回 v48 的样子：没有 lead_waits，也没有 v49 的记录。
    legacy.exec("DROP TABLE lead_waits");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 49").run();
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 49 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toContain("lead_waits");
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：升级以后没有任何等待。
    expect(listOpenLeadWaits(migrated)).toEqual([]);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 49").get()).toEqual({ n: 1 });
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  });
});
