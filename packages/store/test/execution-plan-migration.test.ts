// v53：执行计划（工单详情与验收 spec 5.2，工单 06；v52 留给并行的交付快照）。只加 item_execution_plans 表、它的索引和
// 只许 task 的触发器（由 SCHEMA 建），不改任何已有的表和行，不回填：proof_items 不迁移成计划（D2，没有历史数据要迁移）。
// 三条路径：新库、v51 的老库升级、重新打开。工单的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, getExecutionPlan, insertCheckpoint, LATEST_SCHEMA_VERSION, openDb, recordExecutionPlan,
  SCHEMA_MIGRATION_VERSIONS, transition, updateRun, type Db,
} from "../src/index.js";

const PLAN_COLUMNS = ["item_id", "revision", "run_id", "steps", "created_at"];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v53 execution plan migration", () => {
  it("creates the table in a new database", () => {
    const db = openDb(join(tempDir("plc-v53-fresh-"), "plc.db"));
    expect(columns(db, "item_execution_plans")).toEqual(PLAN_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 53").get()).toEqual({ name: "execution-plans-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(53);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // 只属于 task；Run 要存在（外键）。
    const insert = db.prepare(
      "INSERT INTO item_execution_plans (item_id, revision, run_id, steps, created_at) VALUES (?, 1, ?, '[]', 'x')",
    );
    expect(() => insert.run(999, 999)).toThrow(/belong to tasks/);
    const taskId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(() => insert.run(taskId, 999)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("upgrades a v51 database without changing any other table, row or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v53-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    // 老的 proof items：留在原处，不迁移成计划。
    insertCheckpoint(legacy, {
      itemId: taskId, runId, source: "agent_reported", kind: "milestone", title: "协议核对", summary: "通过了 1 项",
      proofItems: [{ id: "auth", label: "授权边界", state: "passed", evidence: "测试通过" }],
    });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    const cancelled = createItem(legacy, { title: "取消的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: cancelled, to: "cancelled", actor: "user", reason: "not needed" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v51 的样子：没有 item_execution_plans，也没有 v53 的记录。
    legacy.exec("DROP TABLE item_execution_plans");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 53").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("item_execution_plans");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      checkpoints: db.prepare("SELECT * FROM checkpoints ORDER BY id").all(),
      proof: db.prepare("SELECT * FROM item_proof_items ORDER BY item_id, proof_key").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 53 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.proof).toHaveLength(1);
    expect(before.events.length).toBeGreaterThan(0);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "item_execution_plans"].sort());
    expect(columns(migrated, "item_execution_plans")).toEqual(PLAN_COLUMNS);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：老工单没有计划。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM item_execution_plans").get()).toEqual({ n: 0 });
    expect(getExecutionPlan(migrated, taskId)).toBeNull();
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 53").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    // 升级以后写下的计划，重新打开还在。
    const fresh = createItem(reopened, { title: "新工单", brief: "b", createdBy: "user" });
    const freshRun = createRun(reopened, { itemId: fresh });
    recordExecutionPlan(reopened, { itemId: fresh, runId: freshRun, steps: [{ id: "a", title: "第一步", status: "pending" }] });
    reopened.close();

    const again = openDb(path);
    expect(getExecutionPlan(again, fresh)?.steps).toEqual([{ id: "a", title: "第一步", status: "pending", note: null }]);
    expect(again.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 53").get()).toEqual({ n: 1 });
    expect(again.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    again.close();
  });
});
