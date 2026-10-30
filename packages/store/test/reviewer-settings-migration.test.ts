// v56：核查员和执行者一起选，删掉 review_policy（工单详情与验收 spec 5.6、5.9、D3、D12，工单 09；v54 留给并行的工单 05，
// v55 留给并行的分支 claude/agent-grants-8e481a）。
// - 新表 item_reviewer_settings（由 SCHEMA 建）：一张工单一行，记 Lead 或用户选的核查员。
// - review_policy 和 verification_policy 说的是同一件事。代码以后只读 verification_policy，所以旧库里 review_policy='automatic'
//   的工单在迁移时把 verification_policy 设成 independent_reviewer：升级以后仍然要求独立核查。只改这一列。
// - review_policy 这一列留在 items 里：items 的表级 CHECK（C2）引用它，ALTER TABLE DROP COLUMN 做不了，也不为一列重建 items。
// 三条路径：新库、老库升级、重新打开。工单的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createRun, getItem, getReviewerSetting, LATEST_SCHEMA_VERSION, openDb, SCHEMA_MIGRATION_VERSIONS,
  setReviewerSetting, transition, updateRun, type Db,
} from "../src/index.js";

const SETTING_COLUMNS = ["item_id", "runtime", "model", "effort", "chosen_by", "reason", "updated_at"];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit, updated_at FROM items ORDER BY id",
).all();
const policies = (db: Db) => db.prepare(
  "SELECT id, review_policy, verification_policy, acceptance_policy, rework_policy, delivery_policy FROM items ORDER BY id",
).all();

describe("the v56 reviewer settings migration", () => {
  it("creates the table in a new database and keeps it to tasks", () => {
    const db = openDb(join(tempDir("plc-v56-fresh-"), "plc.db"));
    expect(columns(db, "item_reviewer_settings")).toEqual(SETTING_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 56").get()).toEqual({ name: "reviewer-choice-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(56);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(56);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // 并行的分支各占一个版本号（2026-10-22 审查 M2：本工单原来用 v55，和 claude/agent-grants-8e481a 撞了）。
    expect(new Set(SCHEMA_MIGRATION_VERSIONS).size).toBe(SCHEMA_MIGRATION_VERSIONS.length);
    // 新建的工单不再写 review_policy。
    const taskId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(db.prepare("SELECT review_policy, verification_policy FROM items WHERE id=?").get(taskId))
      .toEqual({ review_policy: null, verification_policy: "lead_static" });
    const reminderId = createItem(db, { kind: "reminder", title: "r", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    expect(() => setReviewerSetting(db, reminderId, { runtime: "claude", chosenBy: "lead" })).toThrow(/belong to tasks/);
    expect(() => setReviewerSetting(db, 999, { runtime: "claude", chosenBy: "lead" })).toThrow(/belong to tasks/);
    db.close();
  });

  it("stores one reviewer per ticket and replaces it", () => {
    const db = openDb(join(tempDir("plc-v56-setting-"), "plc.db"));
    const taskId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    expect(getReviewerSetting(db, taskId)).toBeNull();
    setReviewerSetting(db, taskId, { runtime: "claude", model: "opus", effort: "high", chosenBy: "lead", reason: "brief 里写着严禁调用 codex" });
    expect(getReviewerSetting(db, taskId)).toEqual({
      itemId: taskId, runtime: "claude", model: "opus", effort: "high", chosenBy: "lead",
      reason: "brief 里写着严禁调用 codex", updatedAt: expect.any(String),
    });
    setReviewerSetting(db, taskId, { runtime: "pi", chosenBy: "user" });
    expect(getReviewerSetting(db, taskId)).toMatchObject({ runtime: "pi", model: null, effort: null, chosenBy: "user", reason: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_reviewer_settings").get()).toEqual({ n: 1 });
    expect(() => setReviewerSetting(db, taskId, { runtime: "gemini" as never, chosenBy: "lead" })).toThrow(/unknown runtime/);
    db.close();
  });

  it("upgrades an older database: review_policy=automatic still requires an independent reviewer, nothing else changes", () => {
    const path = join(tempDir("plc-v56-legacy-"), "plc.db");
    const legacy = openDb(path);
    // 旧库的四种组合。#a 是两列说法不一致的旧行：以前 review_policy='automatic' 单独就要求独立核查。
    const a = createItem(legacy, { title: "automatic, lead_static", brief: "b", createdBy: "child" });
    const b = createItem(legacy, { title: "automatic, independent", brief: "b", createdBy: "child" });
    const c = createItem(legacy, { title: "manual, lead_static", brief: "b", createdBy: "lead" });
    const d = createItem(legacy, { title: "automatic, user, done", brief: "b", createdBy: "user" });
    const reminder = createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    const setPolicies = legacy.prepare("UPDATE items SET review_policy=?, verification_policy=? WHERE id=?");
    setPolicies.run("automatic", "lead_static", a);
    setPolicies.run("automatic", "independent_reviewer", b);
    setPolicies.run("manual", "lead_static", c);
    setPolicies.run("automatic", "user", d);
    // 生命周期各不相同：进行中、待验收、已完成、已取消。
    transition(legacy, { itemId: a, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: a, runtime: "codex" });
    updateRun(legacy, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(legacy, { itemId: a, to: "review", actor: "child", reason: "delivered", runId });
    transition(legacy, { itemId: d, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: d, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: d, to: "done", actor: "user", reason: "accepted" });
    transition(legacy, { itemId: c, to: "cancelled", actor: "user", reason: "not needed" });
    // 退回 v56 以前的样子：没有 item_reviewer_settings，也没有 v56 的记录。
    legacy.exec("DROP TABLE IF EXISTS item_reviewer_settings");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 56").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("item_reviewer_settings");
    const snapshot = (db: Db) => ({
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version <> 56 ORDER BY version").all(),
      // items 除了 verification_policy 以外的每一列。
      items: (db.prepare("SELECT * FROM items ORDER BY id").all() as Record<string, unknown>[])
        .map(({ verification_policy: _ignored, ...rest }) => rest),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(policies(migrated)).toEqual([
      { id: a, review_policy: "automatic", verification_policy: "independent_reviewer", acceptance_policy: "user_only", rework_policy: "ask_user", delivery_policy: "notify_only" },
      { id: b, review_policy: "automatic", verification_policy: "independent_reviewer", acceptance_policy: "user_only", rework_policy: "ask_user", delivery_policy: "notify_only" },
      { id: c, review_policy: "manual", verification_policy: "lead_static", acceptance_policy: "user_only", rework_policy: "ask_user", delivery_policy: "notify_only" },
      // 以前 review_policy='automatic' 单独就要求独立核查，所以由用户核对的这张也一样改。
      { id: d, review_policy: "automatic", verification_policy: "independent_reviewer", acceptance_policy: "user_only", rework_policy: "ask_user", delivery_policy: "notify_only" },
      { id: reminder, review_policy: null, verification_policy: null, acceptance_policy: null, rework_policy: null, delivery_policy: null },
    ]);
    expect(tables(migrated)).toEqual([...tablesBefore, "item_reviewer_settings"].sort());
    expect(columns(migrated, "item_reviewer_settings")).toEqual(SETTING_COLUMNS);
    // review_policy 这一列还在（C2 引用它，删不掉），代码不再读写它。
    expect(columns(migrated, "items")).toContain("review_policy");
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    expect(getItem(migrated, a)?.stage).toBe("review");
    expect(getItem(migrated, d)).toMatchObject({ stage: "done", closed_at: expect.any(String) });
    // 不回填：升级以前没有人选过核查员。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM item_reviewer_settings").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 56").get()).toEqual({ version: 56 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const policiesAfter = policies(migrated);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 56").get()).toEqual({ n: 1 });
    expect(policies(reopened)).toEqual(policiesAfter);
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    // 升级以后选的核查员，重新打开还在。
    setReviewerSetting(reopened, a, { runtime: "claude", chosenBy: "user" });
    reopened.close();

    const again = openDb(path);
    expect(getReviewerSetting(again, a)).toMatchObject({ runtime: "claude", chosenBy: "user" });
    expect(policies(again)).toEqual(policiesAfter);
    expect(again.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    again.close();
  });
});
