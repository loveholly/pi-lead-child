// v55：子 agent 的权限清单（run_grants、run_grant_changes、run_tool_calls）。只加三张表，不改已有的表和行，不回填。
// 三条路径：新库、v53 的老库升级、重新打开。工单和 Run 的生命周期字段不变。另外测存取的规则：乐观锁、坏数据故障关闭、审计脱敏。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { computeRunGrant, widenRunGrant, DEFAULT_INTENT_GRANT_BOUNDS } from "@pi-lead-child/protocol";
import {
  applyRunGrantChange, createItem, createRun, getRunGrant, grantChangeRevertedBy, insertRunGrant, LATEST_SCHEMA_VERSION,
  latestRunGrantOfItem, listRunGrantChanges, listRunToolCalls, listRunWrites, openDb, recordRunToolCall, RunGrantConflictError,
  SCHEMA_MIGRATION_VERSIONS, settleRunToolCall, transition, updateRun, type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();
const NEW_TABLES = ["run_grant_changes", "run_grants", "run_tool_calls"];

const PR = { owner: "Acme", repo: "x", number: 101 };
const reviewGrant = () => computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo: () => null });

function seedRun(db: Db): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "代查", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  return { itemId, runId };
}

describe("the v55 run grant migration", () => {
  it("creates the tables in a new database", () => {
    const db = openDb(join(tempDir("plc-v55-fresh-"), "plc.db"));
    for (const table of NEW_TABLES) expect(tables(db)).toContain(table);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 55").get()).toEqual({ name: "run-grants-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(55);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // Run 要存在（外键）。
    expect(() => db.prepare(
      "INSERT INTO run_grants (run_id, item_id, intent, grant_json, bound_json, scope_json, created_at, updated_at) VALUES (999, 999, 'x', '{}', '{}', '{}', 'x', 'x')",
    ).run()).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("upgrades a v53 database without changing any other table, row or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v55-legacy-"), "plc.db");
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
    // 退回 v53 的样子。
    for (const table of NEW_TABLES) legacy.exec(`DROP TABLE ${table}`);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 55").run();
    const tablesBefore = tables(legacy);
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 55 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, ...NEW_TABLES].sort());
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：老的 Run 没有清单。
    expect(getRunGrant(migrated, runId)).toBeNull();
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 55").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    const fresh = seedRun(reopened);
    insertRunGrant(reopened, { ...fresh, ...reviewGrant(), bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
    reopened.close();

    const again = openDb(path);
    expect(getRunGrant(again, fresh.runId)?.grant.rules).toHaveLength(3);
    expect(again.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    again.close();
  });
});

describe("run grant storage", () => {
  it("stores the grant with its bound, scope and dropped parts, and a created entry in the ledger", () => {
    const db = openDb(join(tempDir("plc-v55-store-"), "plc.db"));
    const { itemId, runId } = seedRun(db);
    const { grant } = reviewGrant();
    const record = insertRunGrant(db, {
      itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR },
      dropped: ["这个意图不能发 APPROVE"], reason: "PR review",
    });
    expect(record).toMatchObject({ runId, itemId, intent: "code_review", grant, invalid: false, revision: 1, dropped: ["这个意图不能发 APPROVE"] });
    expect(latestRunGrantOfItem(db, itemId)?.runId).toBe(runId);
    expect(listRunGrantChanges(db, runId)).toMatchObject([{ change: "created", revision: 1, actor: "lead", rules: grant.rules }]);
    db.close();
  });

  it("applies a widening with an optimistic revision check and records who did it", () => {
    const db = openDb(join(tempDir("plc-v55-widen-"), "plc.db"));
    const { itemId, runId } = seedRun(db);
    const { grant } = reviewGrant();
    insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
    const widened = widenRunGrant(grant, { pullRequest: PR, reviewEvents: ["APPROVE"] }, () => null);
    const { record, change } = applyRunGrantChange(db, {
      runId, expectedRevision: 1, grant: widened.grant, change: "widened", rules: widened.added,
      actor: "lead", onBehalfTurnId: "turn-1", reason: "用户说加上 approve",
    });
    expect(record.revision).toBe(2);
    expect(change).toMatchObject({ change: "widened", revision: 2, actor: "lead", onBehalfTurnId: "turn-1", rules: widened.added });
    // 别人已经改过：拒绝，不覆盖。
    expect(() => applyRunGrantChange(db, {
      runId, expectedRevision: 1, grant, change: "reverted", rules: widened.added, actor: "user", revertsChangeId: change.id,
    })).toThrow(RunGrantConflictError);
    expect(grantChangeRevertedBy(db, change.id)).toBeNull();
    const reverted = applyRunGrantChange(db, {
      runId, expectedRevision: 2, grant, change: "reverted", rules: widened.added, actor: "user", revertsChangeId: change.id,
    });
    expect(reverted.record.grant).toEqual(grant);
    expect(grantChangeRevertedBy(db, change.id)?.id).toBe(reverted.change.id);
    db.close();
  });

  it("reads a grant that does not match the schema as an empty grant (fail closed)", () => {
    const db = openDb(join(tempDir("plc-v55-invalid-"), "plc.db"));
    const { itemId, runId } = seedRun(db);
    insertRunGrant(db, { itemId, runId, ...reviewGrant(), bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
    db.prepare("UPDATE run_grants SET grant_json = ? WHERE run_id = ?").run(JSON.stringify({ version: 1, intent: "code_review", rules: "everything" }), runId);
    const record = getRunGrant(db, runId)!;
    expect(record.invalid).toBe(true);
    expect(record.grant.rules).toEqual([]);
    db.close();
  });

  it("records tool calls with a redacted, clipped argument preview and lists the successful writes", () => {
    const db = openDb(join(tempDir("plc-v55-calls-"), "plc.db"));
    const { itemId, runId } = seedRun(db);
    recordRunToolCall(db, {
      runId, itemId, connection: "github", tool: "merge_pull_request", access: "write", decision: "refused",
      reason: "清单里没有这个写操作", args: { owner: "Acme", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    const id = recordRunToolCall(db, {
      runId, itemId, connection: "github", tool: "pull_request_review_write", access: "write", decision: "allowed",
      ruleId: "review:acme/x#101:comment", target: "Acme/x#101", args: { body: "x".repeat(5_000) },
    });
    settleRunToolCall(db, id, { outcome: "ok", summary: "在 Acme/x#101 上发了 review（COMMENT）", url: "https://github.com/Acme/x/pull/101" });
    const calls = listRunToolCalls(db, runId);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argsPreview).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(calls[1]!.argsPreview!.length).toBeLessThanOrEqual(2_001);
    expect(listRunWrites(db, runId)).toMatchObject([{ tool: "pull_request_review_write", url: "https://github.com/Acme/x/pull/101" }]);
    db.close();
  });
});
