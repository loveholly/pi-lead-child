// v54：结构化验收标准（工单详情与验收 spec 4.3、5.1、D5、D6，工单 05；v55 留给并行的工单 09）。只加
// item_acceptance_criteria、criterion_confirmations、item_acceptance_criterion_revisions、executor_criteria_views 四张表、
// 它们的索引和只许 task 的触发器（由 SCHEMA 建），
// 不改任何已有的表和行，不回填：brief 里写的验收标准不拆成结构化字段（spec 4.3）。
// 三条路径：新库、v53 的老库升级、重新打开。工单的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addAcceptanceCriteria, addInbox, confirmCriterion, createItem, createRun, insertOutcomeSnapshot, LATEST_SCHEMA_VERSION,
  listAcceptanceCriteria, listCriterionConfirmations, normalizeOutcomePayload, openDb, recordDeliverySnapshot,
  SCHEMA_MIGRATION_VERSIONS, transition, updateRun, type Db,
} from "../src/index.js";

const CRITERIA_COLUMNS = [
  "id", "item_id", "position", "text", "revision", "created_by", "created_run_id", "created_at",
  "edited_by", "edited_at", "updated_at", "deleted_by", "deleted_at",
];
const REVISION_COLUMNS = ["criterion_id", "revision", "text", "written_by", "written_at"];
const VIEW_COLUMNS = ["run_id", "item_id", "criteria_json", "seen_at"];
const NEW_TABLES = ["criterion_confirmations", "executor_criteria_views", "item_acceptance_criteria", "item_acceptance_criterion_revisions"];
const CONFIRMATION_COLUMNS = [
  "id", "item_id", "criterion_id", "criterion_revision", "executor_run_id", "delivery_snapshot_id",
  "confirmed_by", "on_behalf_of", "source_turn_id", "confirmed_at", "ended_by", "ended_at", "end_reason",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit, brief FROM items ORDER BY id",
).all();

// 一次交付：执行 Run 结束，有成果，工单进 review，交付快照记下（agent 报的文件）。
function deliver(db: Db, itemId: number): { runId: number; snapshotId: number } {
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "a".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  const { snapshot } = recordDeliverySnapshot(db, {
    itemId, executorRunId: runId, reason: "delivered", source: "agent", baseSha: null, headSha: null,
    commits: [], commitCount: 0, files: [], totals: null, truncated: false, uncommittedFiles: null,
  });
  return { runId, snapshotId: snapshot!.id };
}

describe("the v54 acceptance criteria migration", () => {
  it("creates the four tables in a new database", () => {
    const db = openDb(join(tempDir("plc-v54-fresh-"), "plc.db"));
    expect(columns(db, "item_acceptance_criteria")).toEqual(CRITERIA_COLUMNS);
    expect(columns(db, "criterion_confirmations")).toEqual(CONFIRMATION_COLUMNS);
    expect(columns(db, "item_acceptance_criterion_revisions")).toEqual(REVISION_COLUMNS);
    expect(columns(db, "executor_criteria_views")).toEqual(VIEW_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 54").get()).toEqual({ name: "acceptance-criteria-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(54);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(54);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    // 只属于 task。
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    expect(() => db.prepare(
      "INSERT INTO item_acceptance_criteria (item_id, position, text, created_by, created_at, updated_at) VALUES (?, 1, 'x', 'lead', 'x', 'x')",
    ).run(reminder)).toThrow(/belong to tasks/);
    db.close();
  });

  it("refuses a confirmation by Lead that does not say on whose behalf and in which turn", () => {
    const db = openDb(join(tempDir("plc-v54-check-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const [criterion] = addAcceptanceCriteria(db, { itemId, texts: ["空输入返回 400"], by: "lead" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const { runId, snapshotId } = deliver(db, itemId);
    const insert = (confirmedBy: string, onBehalfOf: string | null, turn: string | null) => db.prepare(
      `INSERT INTO criterion_confirmations (item_id, criterion_id, criterion_revision, executor_run_id, delivery_snapshot_id,
         confirmed_by, on_behalf_of, source_turn_id, confirmed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'x')`,
    ).run(itemId, criterion!.id, runId, snapshotId, confirmedBy, onBehalfOf, turn);
    expect(() => insert("lead", null, null)).toThrow(/CHECK/);
    expect(() => insert("lead", "user", null)).toThrow(/CHECK/);
    expect(() => insert("user", "user", "turn-1")).toThrow(/CHECK/);
    expect(() => insert("child", null, null)).toThrow(/CHECK/);
    insert("lead", "user", "turn-1");
    // 同一次交付的同一条只有一个有效的确认。
    expect(() => insert("user", null, null)).toThrow(/UNIQUE/);
    db.close();
  });

  it("upgrades a v53 database without changing any other table, row or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v54-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "## 验收标准\n- 空输入返回 400", createdBy: "lead" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    deliver(legacy, taskId);
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    const cancelled = createItem(legacy, { title: "取消的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: cancelled, to: "cancelled", actor: "user", reason: "not needed" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v53 的样子：没有四张新表，也没有 v54 的记录。
    legacy.exec(
      "DROP TABLE criterion_confirmations; DROP TABLE item_acceptance_criterion_revisions; DROP TABLE executor_criteria_views;"
        + " DROP TABLE item_acceptance_criteria;",
    );
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 54").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("item_acceptance_criteria");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      outcomes: db.prepare("SELECT * FROM outcome_snapshots ORDER BY id").all(),
      deliveries: db.prepare("SELECT * FROM delivery_snapshots ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 54 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.deliveries).toHaveLength(1);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, ...NEW_TABLES].sort());
    expect(columns(migrated, "item_acceptance_criteria")).toEqual(CRITERIA_COLUMNS);
    expect(columns(migrated, "criterion_confirmations")).toEqual(CONFIRMATION_COLUMNS);
    expect(columns(migrated, "item_acceptance_criterion_revisions")).toEqual(REVISION_COLUMNS);
    expect(columns(migrated, "executor_criteria_views")).toEqual(VIEW_COLUMNS);
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：brief 里的验收标准不拆出来。
    expect(listAcceptanceCriteria(migrated, taskId)).toEqual([]);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 54").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    // 升级以后写下的标准和确认，重新打开还在。
    const fresh = createItem(reopened, { title: "新工单", brief: "b", createdBy: "lead" });
    const [criterion] = addAcceptanceCriteria(reopened, { itemId: fresh, texts: ["空输入返回 400"], by: "lead" });
    transition(reopened, { itemId: fresh, to: "active", actor: "system", reason: "spawn" });
    const { runId, snapshotId } = deliver(reopened, fresh);
    confirmCriterion(reopened, { itemId: fresh, criterionId: criterion!.id, executorRunId: runId, deliverySnapshotId: snapshotId, by: "user" });
    reopened.close();

    const again = openDb(path);
    expect(listAcceptanceCriteria(again, fresh).map((row) => row.text)).toEqual(["空输入返回 400"]);
    expect(listCriterionConfirmations(again, { itemId: fresh, executorRunId: runId }))
      .toMatchObject([{ criterionId: criterion!.id, confirmedBy: "user", endedAt: null }]);
    expect(again.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 54").get()).toEqual({ n: 1 });
    expect(again.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    again.close();
  });
});
