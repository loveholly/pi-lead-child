// v58：授权托管时预先勾选「核查做不成时由 Lead 凭证据验收」（工单详情与验收 spec 5.8、D11，工单 11）。
// delegation_policies 加一列 accept_without_review，只加列，不回填：已有的授权照旧是没勾（核查做不成时等你验收）。
// 三条路径：新库、老库（v57）升级、重新打开。工单的生命周期字段、已有的授权和活动都不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  activeDelegationPolicy, createItem, createRun, getItem, grantDelegationPolicy, LATEST_SCHEMA_VERSION, openDb,
  SCHEMA_MIGRATION_VERSIONS, transition, updateRun, type Db,
} from "../src/index.js";

const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, verification_policy, acceptance_policy, rework_policy, updated_at FROM items ORDER BY id",
).all();

function delegatedInReview(db: Db): number {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered", runId });
  grantDelegationPolicy(db, { itemId, createdVia: "test" });
  return itemId;
}

describe("the v58 delegation accept-without-review migration", () => {
  it("adds the column in a new database, defaulting to not checked", () => {
    const db = openDb(join(tempDir("plc-v58-fresh-"), "plc.db"));
    expect(columns(db, "delegation_policies").at(-1)).toBe("accept_without_review");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 58").get()).toEqual({ name: "delegation-accept-without-review-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(58);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(58);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    expect(new Set(SCHEMA_MIGRATION_VERSIONS).size).toBe(SCHEMA_MIGRATION_VERSIONS.length);
    const unchecked = delegatedInReview(db);
    expect(activeDelegationPolicy(db, unchecked)?.accept_without_review).toBe(0);
    const itemId = createItem(db, { title: "勾了", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer" });
    expect(grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true }).accept_without_review).toBe(1);
    expect(() => db.prepare("UPDATE delegation_policies SET accept_without_review=2 WHERE item_id=?").run(itemId)).toThrow(/CHECK/);
    db.close();
  });

  it("upgrades a v57 database: existing grants stay unchecked, nothing else changes, then reopens", () => {
    const path = join(tempDir("plc-v58-legacy-"), "plc.db");
    const legacy = openDb(path);
    const delegated = delegatedInReview(legacy);
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    // 退回 v57 的样子：没有这一列，也没有 v58 的记录。
    legacy.exec("ALTER TABLE delegation_policies DROP COLUMN accept_without_review");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 58").run();
    const legacyColumns = columns(legacy, "delegation_policies");
    expect(legacyColumns).not.toContain("accept_without_review");
    const snapshot = (db: Db) => ({
      policies: db.prepare(`SELECT ${legacyColumns.join(", ")} FROM delegation_policies ORDER BY id`).all(),
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version <> 58 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(columns(migrated, "delegation_policies")).toEqual([...legacyColumns, "accept_without_review"]);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    expect(getItem(migrated, delegated)?.stage).toBe("review");
    expect(getItem(migrated, done)).toMatchObject({ stage: "done", closed_at: expect.any(String) });
    // 不回填：已有的授权是没勾的。
    expect(activeDelegationPolicy(migrated, delegated)?.accept_without_review).toBe(0);
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 58").get()).toEqual({ version: 58 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 58").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    reopened.close();
  });
});
