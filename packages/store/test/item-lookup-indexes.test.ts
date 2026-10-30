// runs(item_id) 和 activities(item_id, id) 两个索引（事件主干审查后的后续事项）。Lead 的读工具、工单详情和派发都按
// item_id 查这两张表，没有索引时每次都扫全表。索引写在 SCHEMA 里，不占迁移号。
// 三条路径：新库、老库（v43 的库和 v16 之前的库）升级、重新打开。只加索引，表、行和迁移账本都不变。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { V15_SCHEMA_FIXTURE } from "../testing/index.js";
import {
  addActivity, createItem, createRun, openDb, transition, updateRun, type Db,
} from "../src/index.js";

const INDEXES = { runs_item: ["runs", ["item_id"]], activities_item: ["activities", ["item_id", "id"]] } as const;

// 每个索引所在的表和列；索引不存在时为 null。
const indexShape = (db: Db, name: string) => {
  const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    { tbl_name: string } | undefined;
  if (!row) return null;
  const columns = (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as { name: string }[])
    .map((column) => column.name);
  return [row.tbl_name, columns];
};
const expectIndexes = (db: Db) => {
  for (const [name, shape] of Object.entries(INDEXES)) expect(indexShape(db, name), name).toEqual(shape);
};
const indexNames = (db: Db) => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all() as { name: string }[]).map((row) => row.name);
const migrations = (db: Db) => db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
const snapshot = (db: Db) => ({
  items: db.prepare("SELECT * FROM items ORDER BY id").all(),
  runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
  activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
  migrations: migrations(db),
});

// 一张做完的工单：一个 Run，几条活动。
function seed(db: Db): number {
  const itemId = createItem(db, { title: "已有的工单", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
  addActivity(db, { itemId, runId, actor: "lead", kind: "comment", payload: { text: "进展" } });
  transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
  transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
  return itemId;
}

describe("the runs and activities lookup indexes", () => {
  it("exist in a new database", () => {
    const db = openDb(join(tempDir("plc-item-index-fresh-"), "plc.db"));
    expectIndexes(db);
    db.close();
  });

  it("are added to a v43 database without changing any table, row or migration, and survive a reopen", () => {
    const path = join(tempDir("plc-item-index-v43-"), "plc.db");
    const legacy = openDb(path);
    seed(legacy);
    // 退回加索引之前的 v43 库：没有这两个索引。
    legacy.exec("DROP INDEX runs_item; DROP INDEX activities_item");
    expect(indexShape(legacy, "runs_item")).toBeNull();
    expect(indexShape(legacy, "activities_item")).toBeNull();
    const before = snapshot(legacy);
    const indexesBefore = indexNames(legacy);
    legacy.close();

    const upgraded = openDb(path);
    expectIndexes(upgraded);
    expect(indexNames(upgraded)).toEqual([...indexesBefore, "activities_item", "runs_item"].sort());
    // 只加索引：行不变，迁移账本不变（不占新的版本号）。
    expect(snapshot(upgraded)).toEqual(before);
    upgraded.close();

    const reopened = openDb(path);
    expectIndexes(reopened);
    expect(indexNames(reopened)).toEqual([...indexesBefore, "activities_item", "runs_item"].sort());
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  });

  // v16 之前的库在第一次打开时会重建 runs（migrateRunsShape），它跑在 exec(SCHEMA) 之后。
  // 没有重放的话，第一次打开后 runs_item 随旧表消失，要到下一次打开才有。
  it("are present after the first open of a database from before v16, which rebuilds runs", () => {
    const path = join(tempDir("plc-item-index-v15-"), "plc.db");
    const raw = new Database(path);
    raw.pragma("foreign_keys = OFF"); // 建表顺序按字母序，FK 目标未必先建
    raw.exec(readFileSync(V15_SCHEMA_FIXTURE, "utf8"));
    raw.exec(`
      INSERT INTO schema_migrations (version, name) VALUES
        (10, 'kernel-orchestration-v1'), (11, 'checkpoint-control-plane-v1'),
        (12, 'plan-item-idempotency-v1'), (13, 'checkpoint-fidelity-storage-v1'),
        (14, 'item-model-v1'), (15, 'trigger-notification-v1');
      INSERT INTO tickets (id, kind, title, body, status, brief, created_by, root_ticket_id,
                           orchestration_state, status_changed_at)
        VALUES (1, 'task', 'root task', '', 'active', 'b1', 'user', 1, 'none', '2026-01-01T00:00:00Z');
      INSERT INTO attempts (id, ticket_id, role, state, runtime) VALUES (1, 1, 'executor', 'settled', 'pi');
      INSERT INTO activities (ticket_id, attempt_id, actor, kind, payload) VALUES (1, 1, 'lead', 'comment', '{}');
    `);
    raw.close();

    const first = openDb(path);
    expectIndexes(first);
    const indexesAfterFirstOpen = indexNames(first);
    first.close();
    const reopened = openDb(path);
    expect(indexNames(reopened)).toEqual(indexesAfterFirstOpen);
    reopened.close();
  });

  it("are used when runs and activities are read by item", () => {
    const db = openDb(join(tempDir("plc-item-index-plan-"), "plc.db"));
    seed(db);
    seed(db);
    const plan = (sql: string, ...params: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail);

    // runs.ts 的 listRuns，以及 Lead 的读工具找最近一次失败的 Run。
    const listRuns = plan("SELECT * FROM runs WHERE item_id = ? ORDER BY id", 1);
    expect(listRuns.join("\n")).toMatch(/SEARCH runs USING (COVERING )?INDEX runs_item \(item_id=\?\)/);
    expect(listRuns.join("\n")).not.toContain("TEMP B-TREE");
    const lastFailed = plan("SELECT * FROM runs WHERE item_id = ? AND state = 'failed' ORDER BY id DESC LIMIT 1", 1);
    expect(lastFailed.join("\n")).toMatch(/INDEX runs_item \(item_id=\?\)/);
    expect(lastFailed.join("\n")).not.toContain("TEMP B-TREE");

    // activities.ts 的 listActivities 和 listRecentActivities（Lead 的 get_ticket）。
    const listActivities = plan("SELECT * FROM activities WHERE item_id = ? ORDER BY id LIMIT ?", 1, 100);
    expect(listActivities.join("\n")).toMatch(/SEARCH activities USING (COVERING )?INDEX activities_item \(item_id=\?\)/);
    expect(listActivities.join("\n")).not.toContain("TEMP B-TREE");
    const recent = plan("SELECT * FROM activities WHERE item_id = ? ORDER BY id DESC LIMIT ?", 1, 20);
    expect(recent.join("\n")).toMatch(/INDEX activities_item \(item_id=\?\)/);
    expect(recent.join("\n")).not.toContain("TEMP B-TREE");
    db.close();
  });
});
