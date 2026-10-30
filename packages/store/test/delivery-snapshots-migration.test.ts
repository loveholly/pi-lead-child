// v52：交付快照（工单详情工单 04，spec 5.5、D8）。只加 delivery_snapshots 表和两个索引（由 SCHEMA 建），不改任何已有的表和行，
// 不回填（补存要跑 git，在打开交付视图时做）。三条路径：新库、v51 的老库升级、重新打开。item 的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, getLatestDeliverySnapshot, insertOutcomeSnapshot, LATEST_SCHEMA_VERSION,
  normalizeOutcomePayload, openDb, recordDeliverySnapshot, SCHEMA_MIGRATION_VERSIONS, transition, updateRun,
  type Db, type RecordDeliverySnapshotInput,
} from "../src/index.js";

const SNAPSHOT_COLUMNS = [
  "id", "item_id", "sequence", "revision", "executor_run_id", "outcome_snapshot_id", "reason", "source", "backfilled",
  "trigger_run_id", "trigger_kind", "workspace_id", "base_sha", "head_sha", "commits_json", "commit_count", "files_json", "file_count",
  "additions", "deletions", "truncated", "uncommitted_files", "created_at",
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

function deliveredTicket(db: Db): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "已交付的工单", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "e".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了。", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date("2026-10-20T00:00:00.000Z"),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return { itemId, runId };
}

const snapshotInput = (itemId: number, executorRunId: number, extra: Partial<RecordDeliverySnapshotInput> = {}): RecordDeliverySnapshotInput => ({
  itemId, executorRunId, reason: "delivered", source: "git", baseSha: "a".repeat(40), headSha: "b".repeat(40),
  commits: [{ sha: "b".repeat(40), subject: "plan" }], commitCount: 1,
  files: [{ path: "docs/plan.md", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false, label: null, note: "方案", generated: null }],
  totals: { files: 1, additions: 3, deletions: 0 }, truncated: false, uncommittedFiles: 0, ...extra,
});

describe("the v52 delivery snapshot migration", () => {
  it("creates the table and its two indexes in a new database", () => {
    const db = openDb(join(tempDir("plc-v52-fresh-"), "plc.db"));
    expect(columns(db, "delivery_snapshots")).toEqual(SNAPSHOT_COLUMNS);
    expect(indexes(db, "delivery_snapshots").map((index) => index.name)).toEqual([
      "delivery_snapshots_item", "delivery_snapshots_one_delivered",
    ]);
    expect(indexes(db, "delivery_snapshots").find((index) => index.name === "delivery_snapshots_one_delivered")!.sql)
      .toMatch(/UNIQUE INDEX .* ON delivery_snapshots\(executor_run_id\) WHERE reason = 'delivered'/);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 52").get()).toEqual({ name: "delivery-snapshots-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(52);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // 外键：工单和 Run 都要存在。
    expect(() => recordDeliverySnapshot(db, snapshotInput(999, 999))).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("upgrades a v51 database without changing any other table, row or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v52-legacy-"), "plc.db");
    const legacy = openDb(path);
    const { itemId } = deliveredTicket(legacy);
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    const reviewing = deliveredTicket(legacy);
    const cancelled = createItem(legacy, { title: "取消的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: cancelled, to: "cancelled", actor: "user", reason: "not needed" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v51 的样子：没有 delivery_snapshots，也没有 v52 的记录。
    legacy.exec("DROP TABLE delivery_snapshots");
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 52").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("delivery_snapshots");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      outcomes: db.prepare("SELECT * FROM outcome_snapshots ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 52 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.outcomes.length).toBe(2);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "delivery_snapshots"].sort());
    expect(columns(migrated, "delivery_snapshots")).toEqual(SNAPSHOT_COLUMNS);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不在迁移里回填：补存要跑 git，留给第一次打开交付视图。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM delivery_snapshots").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const recorded = recordDeliverySnapshot(migrated, snapshotInput(reviewing.itemId, reviewing.runId));
    expect(recorded).toMatchObject({ created: true, snapshot: { sequence: 1, revision: 1 } });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 52").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(getLatestDeliverySnapshot(reopened, reviewing.itemId)).toMatchObject({
      id: recorded.snapshot!.id, executorRunId: reviewing.runId, files: [{ path: "docs/plan.md", note: "方案" }],
    });
    expect(getLatestDeliverySnapshot(reopened, itemId)).toBeUndefined();
    reopened.close();
  });

  it("numbers deliveries and revisions itself, and stores one delivered snapshot per delivery", () => {
    const db = openDb(join(tempDir("plc-v52-numbering-"), "plc.db"));
    const { itemId, runId } = deliveredTicket(db);
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, runId)).snapshot).toMatchObject({ sequence: 1, revision: 1 });
    // 重放：同一次交付不再存。
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, runId))).toMatchObject({ created: false, skipped: "duplicate" });
    // 工作区没变：不存。变了：同一次交付的第 2 份。
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, runId, { reason: "workspace_changed" })))
      .toMatchObject({ created: false, skipped: "duplicate" });
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, runId, { reason: "workspace_changed", headSha: "c".repeat(40) })).snapshot)
      .toMatchObject({ sequence: 1, revision: 2, reason: "workspace_changed" });
    // 返工后的交付是第 2 次；旧的交付不能再存新的一份。
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const rework = createRun(db, { itemId });
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, rework)).snapshot).toMatchObject({ sequence: 2, revision: 1 });
    expect(recordDeliverySnapshot(db, snapshotInput(itemId, runId, { reason: "workspace_changed", headSha: "d".repeat(40) })))
      .toMatchObject({ created: false, skipped: "superseded" });
    expect(() => db.prepare(
      `INSERT INTO delivery_snapshots (item_id, sequence, revision, executor_run_id, reason, source, created_at)
       VALUES (?, 3, 1, ?, 'delivered', 'git', 'now')`,
    ).run(itemId, runId)).toThrow(/UNIQUE/);
    db.close();
  });
});
