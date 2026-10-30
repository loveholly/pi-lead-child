import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { LATEST_SCHEMA_VERSION, openDb } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { createRun, getRun, insertDecisionRequest, updateRun } from "@pi-lead-child/store";
import { runFailure } from "@pi-lead-child/runtime";

function names(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function createVersion12Fixture(
  path: string,
  options?: { invalidProofJson?: boolean },
): void {
  const db = openDb(path);
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS artifacts;
        DROP TABLE IF EXISTS item_proof_items;
        CREATE TABLE checkpoints_v12 (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id             INTEGER NOT NULL REFERENCES items(id),
          run_id              INTEGER REFERENCES runs(id),
          source              TEXT NOT NULL
                              CHECK (source IN ('agent_reported','system_derived')),
          kind                TEXT NOT NULL
                              CHECK (kind IN ('progress','milestone','decision',
                                              'delegation','blocked','completed')),
          stage               TEXT,
          title               TEXT NOT NULL,
          summary             TEXT NOT NULL,
          key_facts           TEXT NOT NULL DEFAULT '[]',
          artifact_refs       TEXT NOT NULL DEFAULT '[]',
          related_item_ids    TEXT NOT NULL DEFAULT '[]',
          next_step           TEXT,
          action_type         TEXT CHECK (action_type IN ('approval','decision_request')),
          action_id           INTEGER,
          idempotency_key     TEXT UNIQUE,
          content_hash        TEXT NOT NULL,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          proof_items         TEXT NOT NULL DEFAULT '[]',
          CHECK ((action_type IS NULL) = (action_id IS NULL))
        );
        DROP TABLE checkpoints;
        ALTER TABLE checkpoints_v12 RENAME TO checkpoints;
        CREATE INDEX checkpoints_item_id ON checkpoints(item_id, id);
        CREATE INDEX checkpoints_run_id ON checkpoints(run_id, id);
        CREATE INDEX checkpoints_action ON checkpoints(action_type, action_id, id);
        DELETE FROM schema_migrations WHERE version > 12;
      `);
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }

  const itemId = Number(db.prepare(
    `INSERT INTO items (title, brief, created_by, root_item_id, stage_changed_at)
     VALUES ('migration fixture', 'v12', 'lead', NULL, '2026-07-25T01:00:00.000Z')`,
  ).run().lastInsertRowid);
  db.prepare("UPDATE items SET root_item_id=? WHERE id=?").run(itemId, itemId);
  const runId = Number(db.prepare(
    `INSERT INTO runs (item_id, role, runtime, state, started_at)
     VALUES (?, 'executor', 'codex', 'running', '2026-07-25T01:01:00.000Z')`,
  ).run(itemId).lastInsertRowid);
  const firstProof = JSON.stringify([
    { id: "auth", label: "Auth boundary", state: "pending", evidence: null },
    { id: "obsolete", label: "Old check", state: "pending", evidence: null },
  ]);
  const secondProof = options?.invalidProofJson ? "{broken" : JSON.stringify([
    { id: "auth", label: "Auth boundary", state: "passed", evidence: "paired tests pass" },
    { id: "obsolete", label: "Old check", state: "retired", evidence: null },
    { id: "docs", label: "Docs", state: "pending", evidence: null },
  ]);
  const firstCheckpointId = Number(db.prepare(
    `INSERT INTO checkpoints (
       item_id, run_id, source, kind, stage, title, summary, artifact_refs,
       idempotency_key, content_hash, created_at, proof_items
     ) VALUES (?, ?, 'agent_reported', 'progress', 'build', 'First', 'First summary', ?,
               'fixture:first', 'hash-first', '2026-07-25T01:02:00.000Z', ?)`,
  ).run(itemId, runId, JSON.stringify(["reports/out.txt", "duplicate/ref"]), firstProof)
    .lastInsertRowid);
  db.prepare(
    `INSERT INTO checkpoints (
       item_id, run_id, source, kind, stage, title, summary, artifact_refs,
       idempotency_key, content_hash, created_at, proof_items
     ) VALUES (?, ?, 'agent_reported', 'milestone', 'verify', 'Second', 'Second summary', ?,
               'fixture:second', 'hash-second', '2026-07-25T01:03:00.000Z', ?)`,
  ).run(itemId, runId, JSON.stringify(["duplicate/ref", "final.bin"]), secondProof);
  db.prepare(
    `INSERT INTO conversation_cards
       (item_id, kind, checkpoint_id, idempotency_key, created_at, updated_at)
     VALUES (?, 'checkpoint', ?, 'fixture:card', '2026-07-25T01:04:00.000Z',
             '2026-07-25T01:04:00.000Z')`,
  ).run(itemId, firstCheckpointId);
  db.close();
}

describe("kernel schema migration", () => {
  it("upgrades the previous ledger schema transactionally and is idempotent", () => {
    const dir = tempDir("plc-kernel-migration-");
    const repo = join(dir, "legacy-repo");
    mkdirSync(repo);
    const path = join(dir, "plc.db");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        brief TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        project TEXT,
        workdir TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        notify_quota_used INTEGER NOT NULL DEFAULT 0,
        due_at TEXT,
        remind_at TEXT,
        due_overdue_notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        role TEXT NOT NULL DEFAULT 'executor',
        session_id TEXT,
        session_path TEXT,
        pid INTEGER,
        state TEXT NOT NULL DEFAULT 'starting',
        model TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        last_entry_cursor TEXT
      );
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        attempt_id INTEGER REFERENCES attempts(id),
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        session_cursor TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'note',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy.prepare(
      "INSERT INTO tickets (title, brief, project, workdir, created_by) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy", "keep me", "returns", repo, "lead");
    legacy.prepare("INSERT INTO attempts (ticket_id, model) VALUES (1, 'legacy-model')").run();
    legacy.close();

    const migrated = openDb(path);
    expect(names(migrated, "items")).toEqual(expect.arrayContaining([
      "project_id", "parent_item_id", "root_item_id", "created_by_run_id",
      "plan_state", "requested_runtime", "requested_model", "purpose",
      "review_policy", "active_plan_revision", "first_run_at", "closed_at",
      "stage_changed_at",
    ]));
    expect(names(migrated, "runs")).toEqual(expect.arrayContaining([
      "runtime", "purpose", "runtime_version", "external_session_id", "event_cursor",
      "resumed_from_run_id", "exit_code", "error_code", "error_message", "metadata", "cost_known", "event_log_dirty",
    ]));
    const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row: any) => row.name);
    for (const table of [
      "schema_migrations", "projects", "project_repositories", "project_aliases",
      "project_changes", "item_plan_revisions", "item_plan_memberships",
      "item_dependencies", "ticket_relations", "runtime_events", "dispatch_requests", "dispatch_claims",
      "review_verdicts", "learning_candidates", "capabilities", "capability_runs",
      "checkpoints", "decision_requests", "conversation_cards", "outcome_snapshots",
    ]) expect(tables).toContain(table);
    expect(names(migrated, "review_verdicts")).toEqual(expect.arrayContaining([
      "checkpoint_id", "evidence_refs",
    ]));
    expect(names(migrated, "dispatch_requests")).toEqual(expect.arrayContaining([
      "resume_from_run_id", "instruction",
    ]));
    expect(names(migrated, "item_plan_memberships")).toContain("item_key");

    expect(migrated.prepare("SELECT project, root_item_id FROM items WHERE id=1").get())
      .toEqual({ project: "returns", root_item_id: 1 });
    expect(migrated.prepare("SELECT name FROM projects").all()).toEqual([{ name: "returns" }]);
    expect(migrated.prepare("SELECT runtime, model FROM runs WHERE id=1").get())
      .toEqual({ runtime: "pi", model: "legacy-model" });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    const migrationCount = (migrated.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as any).n;
    migrated.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as any).n)
      .toBe(migrationCount);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM projects").get() as any).n).toBe(1);
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    reopened.close();
  });

  it("upgrades a v10 database with approval attribution and timing backfill", () => {
    const dir = tempDir("plc-checkpoint-migration-");
    const path = join(dir, "plc.db");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER REFERENCES tickets(id),
        requested_by TEXT NOT NULL,
        tool TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        session_exempt INTEGER NOT NULL DEFAULT 0,
        resolved_by TEXT,
        resolved_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, name) VALUES (10, 'kernel-orchestration-v1');
      INSERT INTO tickets (title, brief, status, updated_at)
        VALUES ('done legacy', 'backfill', 'done', '2026-07-24T06:10:00.000Z');
      INSERT INTO attempts (ticket_id, role, runtime, started_at, ended_at)
        VALUES (1, 'executor', 'pi', '2026-07-24T06:00:00.000Z', '2026-07-24T06:05:00.000Z');
      INSERT INTO approvals
        (ticket_id, requested_by, tool, action, expires_at, created_at)
        VALUES (1, 'child', 'sudo', 'install service', '2026-07-25T00:00:00.000Z',
                '2026-07-24T06:02:00.000Z');
    `);
    legacy.close();

    const migrated = openDb(path);
    expect(names(migrated, "approvals")).toContain("run_id");
    expect(migrated.prepare(
      "SELECT first_run_at, closed_at, stage_changed_at FROM items WHERE id = 1",
    ).get()).toEqual({
      first_run_at: "2026-07-24T06:00:00.000Z",
      closed_at: "2026-07-24T06:10:00.000Z",
      stage_changed_at: "2026-07-24T06:10:00.000Z",
    });
    expect(migrated.prepare("SELECT run_id FROM approvals WHERE id = 1").get())
      .toEqual({ run_id: null });
    // 升级后的表是 Item 形状：created_by 非空且受枚举约束，stage 走新枚举
    const postUpgradeItemId = Number(migrated.prepare(
      `INSERT INTO items (title, brief, stage, created_by, updated_at)
       VALUES ('post-upgrade', 'stage timing', 'ready', 'user', '2026-07-24T06:20:00.000Z')`,
    ).run().lastInsertRowid);
    expect(migrated.prepare("SELECT stage_changed_at FROM items WHERE id = ?")
      .get(postUpgradeItemId)).toEqual({ stage_changed_at: expect.any(String) });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("upgrades a v11 plan-membership table before creating the item-key index", () => {
    const dir = tempDir("plc-plan-key-migration-");
    const path = join(dir, "plc.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, name) VALUES
        (10, 'kernel-orchestration-v1'),
        (11, 'checkpoint-control-plane-v1');
      -- v11 库一定带着 tickets：v16 的改名以它的存在为门控，少了它整条改名就不会跑，
      -- 这张 membership 表也就永远等不到 item_key（它是在改名后的表上补的）。
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        created_by TEXT NOT NULL DEFAULT 'user',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE ticket_plan_memberships (
        parent_ticket_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        child_ticket_id INTEGER NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (parent_ticket_id, revision, child_ticket_id)
      );
    `);
    legacy.close();

    const migrated = openDb(path);
    expect(names(migrated, "item_plan_memberships")).toContain("item_key");
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='item_plan_memberships_item_key'",
    ).get()).toEqual({ name: "item_plan_memberships_item_key" });
    expect(migrated.prepare("SELECT name FROM schema_migrations WHERE version=12").get())
      .toEqual({ name: "plan-item-idempotency-v1" });
    migrated.close();
  });

  it("rebuilds populated v12 checkpoints, preserves dependent rows, and backfills proof and artifacts deterministically", () => {
    const dir = tempDir("plc-fidelity-migration-");
    const path = join(dir, "plc.db");
    createVersion12Fixture(path);

    const migrated = openDb(path);
    expect(migrated.prepare("SELECT name FROM schema_migrations WHERE version=13").get())
      .toEqual({ name: "checkpoint-fidelity-storage-v1" });
    expect(names(migrated, "checkpoints")).toEqual(expect.arrayContaining([
      "progress_current", "progress_total", "progress_label", "proof_items",
    ]));
    const checkpointSql = (migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='checkpoints'",
    ).get() as { sql: string }).sql;
    expect(checkpointSql).toMatch(/progress_current IS NULL.*progress_total IS NULL/s);
    expect(checkpointSql).toMatch(/progress_current <= progress_total/s);
    expect(checkpointSql).toMatch(/json_valid\(proof_items\)/);
    expect(() => migrated.prepare(
      `INSERT INTO checkpoints
       (item_id, source, kind, title, summary, content_hash, progress_current)
       VALUES (1, 'system_derived', 'progress', 'bad', 'bad', 'bad-progress', 1)`,
    ).run()).toThrow();

    expect(migrated.prepare(
      `SELECT id, item_id, run_id, idempotency_key, content_hash,
              progress_current, progress_total, progress_label
       FROM checkpoints ORDER BY id`,
    ).all()).toEqual([
      {
        id: 1, item_id: 1, run_id: 1, idempotency_key: "fixture:first",
        content_hash: "hash-first", progress_current: null, progress_total: null,
        progress_label: null,
      },
      {
        id: 2, item_id: 1, run_id: 1, idempotency_key: "fixture:second",
        content_hash: "hash-second", progress_current: null, progress_total: null,
        progress_label: null,
      },
    ]);
    expect(migrated.prepare(
      `SELECT c.id, c.checkpoint_id, p.content_hash
       FROM conversation_cards c JOIN checkpoints p ON p.id=c.checkpoint_id`,
    ).get()).toEqual({ id: 1, checkpoint_id: 1, content_hash: "hash-first" });
    expect(migrated.prepare(
      `SELECT proof_key, label, state, evidence, checkpoint_id, updated_at
       FROM item_proof_items ORDER BY checkpoint_id, proof_key`,
    ).all()).toEqual([
      {
        proof_key: "auth", label: "Auth boundary", state: "passed",
        evidence: "paired tests pass", checkpoint_id: 2,
        updated_at: "2026-07-25T01:03:00.000Z",
      },
      {
        proof_key: "docs", label: "Docs", state: "pending", evidence: null,
        checkpoint_id: 2, updated_at: "2026-07-25T01:03:00.000Z",
      },
    ]);
    expect(migrated.prepare(
      `SELECT ref, name, kind, media_type, description, original_filename, sha256,
              byte_length, storage_key, availability, checkpoint_id, run_id
       FROM artifacts ORDER BY id`,
    ).all()).toEqual([
      {
        ref: "reports/out.txt", name: "out.txt", kind: "reference",
        media_type: "application/octet-stream", description: null, original_filename: null,
        sha256: null, byte_length: null, storage_key: null, availability: "metadata_only",
        checkpoint_id: 1, run_id: 1,
      },
      {
        ref: "duplicate/ref", name: "ref", kind: "reference",
        media_type: "application/octet-stream", description: null, original_filename: null,
        sha256: null, byte_length: null, storage_key: null, availability: "metadata_only",
        checkpoint_id: 1, run_id: 1,
      },
      {
        ref: "final.bin", name: "final.bin", kind: "reference",
        media_type: "application/octet-stream", description: null, original_filename: null,
        sha256: null, byte_length: null, storage_key: null, availability: "metadata_only",
        checkpoint_id: 2, run_id: 1,
      },
    ]);
    expect(() => migrated.prepare(
      `INSERT INTO artifacts (
         item_id, run_id, checkpoint_id, ref, name, kind, media_type,
         sha256, byte_length, storage_key, availability
       ) VALUES (1, 1, 1, 'invalid-sha', 'invalid', 'report', 'text/plain',
                 ?, 1, 'artifacts/blobs/aa/invalid', 'available')`,
    ).run(`${"a".repeat(63)}Z`)).toThrow();
    expect(migrated.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN (
         'checkpoints_item_id','checkpoints_run_id','checkpoints_action',
         'item_proof_items_item_state','item_proof_items_checkpoint',
         'artifacts_item_id','artifacts_checkpoint_id','artifacts_sha256'
       ) ORDER BY name`,
    ).all()).toHaveLength(8);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("rolls migration 13 back completely and restores foreign_keys after a forced proof-backfill failure", () => {
    const dir = tempDir("plc-fidelity-migration-rollback-");
    const path = join(dir, "plc.db");
    createVersion12Fixture(path, { invalidProofJson: true });
    expect(() => openDb(path)).toThrow(/proof|json/i);

    const legacy = new Database(path);
    expect(Number(legacy.pragma("foreign_keys", { simple: true }))).toBe(1);
    legacy.pragma("foreign_keys = ON");
    expect(Number(legacy.pragma("foreign_keys", { simple: true }))).toBe(1);
    expect(names(legacy, "checkpoints")).not.toContain("progress_current");
    expect(legacy.prepare("SELECT id, content_hash FROM checkpoints ORDER BY id").all()).toEqual([
      { id: 1, content_hash: "hash-first" },
      { id: 2, content_hash: "hash-second" },
    ]);
    expect(legacy.prepare("SELECT checkpoint_id FROM conversation_cards").get())
      .toEqual({ checkpoint_id: 1 });
    expect(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 12 });
    expect(legacy.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('artifacts','item_proof_items')",
    ).all()).toEqual([]);
    expect(legacy.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name='checkpoints_v13'
          OR name LIKE 'artifacts_%'
          OR name LIKE 'item_proof_items_%'
       ORDER BY type, name`,
    ).all()).toEqual([]);
    expect(legacy.pragma("foreign_key_check")).toEqual([]);
    legacy.close();
  });

  it("does not leak v13-only schema objects when real openDb fails while recording migration 13", () => {
    const dir = tempDir("plc-fidelity-migration-schema-rollback-");
    const path = join(dir, "plc.db");
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TRIGGER fail_migration_13
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 13
      BEGIN
        SELECT RAISE(FAIL, 'forced migration 13 failure');
      END;
    `);
    seed.close();

    expect(() => openDb(path)).toThrow(/forced migration 13 failure/i);
    const inspected = new Database(path);
    expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 12 });
    expect(names(inspected, "checkpoints")).not.toEqual(expect.arrayContaining([
      "progress_current", "progress_total", "progress_label", "proof_items",
    ]));
    expect(inspected.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN ('artifacts','item_proof_items','checkpoints_v13')
          OR name LIKE 'artifacts_%'
          OR name LIKE 'item_proof_items_%'
       ORDER BY type, name`,
    ).all()).toEqual([]);
    inspected.close();
  });
});

// v26（工单 02）：失败的 Run 带类型化失败。只补列，不回填，也不动 item 和 Run 的生命周期字段。
describe("run typed failure migration (v26)", () => {
  const FAILURE_COLUMNS = ["failure_scope", "failure_retry", "failure_needs", "failure_code", "failure_evidence"];

  it("creates the failure columns on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v26-fresh-"), "plc.db"));
    expect(names(db, "runs")).toEqual(expect.arrayContaining(FAILURE_COLUMNS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=26").get())
      .toEqual({ name: "run-typed-failure-v1" });
    // 列上的 CHECK 拒绝映射表以外的作用域。
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId });
    expect(() => db.prepare("UPDATE runs SET failure_scope='agent' WHERE id=?").run(runId))
      .toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("upgrades a v25 database without touching lifecycle fields, then reopens idempotently", () => {
    const path = join(tempDir("plc-v26-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user", retryLimit: 1 });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    updateRun(seed, runId, {
      state: "failed", endedAt: true, errorCode: "codex_error",
      errorMessage: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    });
    transition(seed, { itemId, to: "blocked", actor: "system", reason: "legacy crash", runId });
    // 退回 v25 的形状：没有这几列，也没有 v26 的账本行。
    for (const column of FAILURE_COLUMNS) seed.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    seed.prepare("DELETE FROM schema_migrations WHERE version=26").run();
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT state, error_code, error_message, ended_at FROM runs WHERE id=?").get(runId);
    seed.close();

    const upgraded = openDb(path);
    expect(names(upgraded, "runs")).toEqual(expect.arrayContaining(FAILURE_COLUMNS));
    expect(upgraded.prepare(`SELECT ${FAILURE_COLUMNS.join(", ")} FROM runs WHERE id=?`).get(runId))
      .toEqual(Object.fromEntries(FAILURE_COLUMNS.map((column) => [column, null])));
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT state, error_code, error_message, ended_at FROM runs WHERE id=?").get(runId))
      .toEqual(runBefore);
    // 没有类型的旧 Run 由兜底分类器按同一张映射表分类：账号余额用完不扣额度。
    expect(runFailure(getRun(upgraded, runId)!)).toMatchObject({ scope: "account", needs: "refill" });
    expect(executorRetryBudget(upgraded, itemId).failures).toBe(0);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "runs").filter((column) => column.startsWith("failure_"))).toEqual(FAILURE_COLUMNS);
    reopened.close();
  });
});

// v27（工单 03）：健康账本。建两张账本表，给派发请求补挂起的三列。
// 账本从空开始，不从历史失败回填：升级不能把历史故障变成一批通知或挂起。
describe("runtime health ledger migration (v27)", () => {
  const REQUEST_COLUMNS = ["suspended_reason", "suspended_incident_id", "retry_of_run_id"];
  const incident = (db: Database.Database, profileKey: string) => db.prepare(
    `INSERT INTO runtime_incidents
     (profile_key, runtime, executable, config_dir, level, model, scope, retry, needs, code, evidence, opened_at)
     VALUES (?, 'codex', '/bin/codex', '/home/.codex', 'profile', '', 'account', 'never', 'refill',
             'out_of_credits', 'out of credits', '2026-10-10T00:00:00.000Z')`,
  ).run(profileKey);

  it("creates the ledger on a fresh database and keeps one open incident per target", () => {
    const db = openDb(join(tempDir("plc-v27-fresh-"), "plc.db"));
    expect(names(db, "runtime_health")).toEqual(expect.arrayContaining([
      "profile_key", "level", "model", "status", "incident_id", "recover_at",
    ]));
    expect(names(db, "runtime_incidents")).toEqual(expect.arrayContaining([
      "profile_key", "level", "model", "scope", "needs", "code", "evidence", "opened_at", "closed_at",
    ]));
    expect(names(db, "dispatch_requests")).toEqual(expect.arrayContaining(REQUEST_COLUMNS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=27").get())
      .toEqual({ name: "runtime-health-ledger-v1" });
    incident(db, "codex:0123456789abcdef");
    // 同一个目标同时只能有一次没关闭的故障。关闭之后，下一次故障才是新的一次。
    expect(() => incident(db, "codex:0123456789abcdef")).toThrow(/UNIQUE constraint failed/);
    db.prepare("UPDATE runtime_incidents SET closed_at=opened_at, close_reason='fixed'").run();
    expect(() => incident(db, "codex:0123456789abcdef")).not.toThrow();
    // 账本状态只有三种。
    expect(() => db.prepare(
      `INSERT INTO runtime_health (profile_key, level, model, runtime, executable, status, updated_at)
       VALUES ('pi:x', 'profile', '', 'pi', '/bin/pi', 'broken', '2026-10-10T00:00:00.000Z')`,
    ).run()).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("upgrades a v26 database without backfilling history or touching lifecycle fields, then reopens", () => {
    const path = join(tempDir("plc-v27-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    updateRun(seed, runId, {
      state: "failed", endedAt: true, errorCode: "codex_error",
      errorMessage: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    });
    transition(seed, { itemId, to: "blocked", actor: "system", reason: "legacy crash", runId });
    seed.prepare(
      `INSERT INTO dispatch_requests (item_id, role, purpose, runtime, model, trigger, idempotency_key)
       VALUES (?, 'executor', 'execution', 'codex', 'gpt-5.5', 'lead', 'legacy:1')`,
    ).run(itemId);
    // 退回 v26 的形状：没有账本表，派发请求没有这三列，也没有 v27 的账本行。
    // suspended_incident_id 带外键，SQLite 不能 DROP COLUMN，所以按 v26 的表体重建这张表。
    seed.pragma("foreign_keys = OFF");
    seed.exec(`
      DROP TABLE runtime_health;
      DROP TABLE runtime_incidents;
      CREATE TABLE dispatch_requests_v26 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id       INTEGER NOT NULL REFERENCES items(id),
        role          TEXT NOT NULL CHECK (role IN ('executor','reviewer')),
        purpose       TEXT NOT NULL,
        runtime       TEXT,
        model         TEXT,
        resume_from_run_id INTEGER REFERENCES runs(id),
        instruction   TEXT,
        plan_owner_item_id INTEGER REFERENCES items(id),
        plan_revision INTEGER,
        trigger       TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state         TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','claimed','started','completed','failed','cancelled')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO dispatch_requests_v26
        SELECT id, item_id, role, purpose, runtime, model, resume_from_run_id, instruction,
               plan_owner_item_id, plan_revision, trigger, idempotency_key, state, created_at, updated_at
        FROM dispatch_requests;
      DROP TABLE dispatch_requests;
      ALTER TABLE dispatch_requests_v26 RENAME TO dispatch_requests;
      CREATE INDEX dispatch_requests_pending ON dispatch_requests(state, item_id, id);
      DELETE FROM schema_migrations WHERE version=27;
    `);
    seed.pragma("foreign_keys = ON");
    expect(names(seed, "dispatch_requests").filter((column) => REQUEST_COLUMNS.includes(column))).toEqual([]);
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId);
    const requestBefore = seed.prepare("SELECT state, runtime, model, trigger FROM dispatch_requests").all();
    seed.close();

    const upgraded = openDb(path);
    expect(names(upgraded, "dispatch_requests")).toEqual(expect.arrayContaining(REQUEST_COLUMNS));
    // 历史上的余额故障不回填进账本：没有故障，没有不健康的目标，没有新通知。
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM runtime_health").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId))
      .toEqual(runBefore);
    expect(upgraded.prepare("SELECT state, runtime, model, trigger FROM dispatch_requests").all()).toEqual(requestBefore);
    expect(upgraded.prepare(`SELECT ${REQUEST_COLUMNS.join(", ")} FROM dispatch_requests`).all())
      .toEqual([Object.fromEntries(REQUEST_COLUMNS.map((column) => [column, null]))]);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "dispatch_requests").filter((column) => REQUEST_COLUMNS.includes(column)))
      .toEqual(REQUEST_COLUMNS);
    reopened.close();
  });
});

// v29（工单 04）：故障的恢复状态。只给 runtime_incidents 补列，不回填。
// 升级前就开着的故障没有探针截止时间，探针把它当作已到期。升级本身不发通知，不改生命周期字段。
describe("runtime incident recovery migration (v29)", () => {
  const RECOVERY_COLUMNS = [
    "next_probe_at", "probe_failures", "last_probe_at", "last_probe_error", "canary_armed_at", "canary_run_id",
  ];

  it("creates the recovery columns on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v29-fresh-"), "plc.db"));
    expect(names(db, "runtime_incidents")).toEqual(expect.arrayContaining(RECOVERY_COLUMNS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=29").get())
      .toEqual({ name: "runtime-incident-recovery-v1" });
    // 最新版本号由最新的迁移测试断言（v34）。
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(29);
    db.close();
  });

  it("upgrades a v27 database without touching open incidents or lifecycle fields, then reopens", () => {
    const path = join(tempDir("plc-v29-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    updateRun(seed, runId, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "out of credits" });
    // v27 的形状：一次开着的故障和它的账本项，但 runtime_incidents 没有恢复状态的列。
    // canary_run_id 带外键，SQLite 不能 DROP COLUMN，所以按 v27 的表体重建这张表。
    seed.pragma("foreign_keys = OFF");
    seed.exec(`
      CREATE TABLE runtime_incidents_v27 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_key   TEXT NOT NULL,
        runtime       TEXT NOT NULL,
        executable    TEXT NOT NULL,
        config_dir    TEXT,
        level         TEXT NOT NULL CHECK (level IN ('profile','model')),
        model         TEXT NOT NULL DEFAULT '',
        scope         TEXT NOT NULL CHECK (scope IN ('runtime','account')),
        retry         TEXT NOT NULL,
        needs         TEXT NOT NULL,
        code          TEXT NOT NULL,
        evidence      TEXT NOT NULL,
        opened_item_id INTEGER REFERENCES items(id),
        opened_run_id INTEGER REFERENCES runs(id),
        opened_at     TEXT NOT NULL,
        closed_at     TEXT,
        close_reason  TEXT,
        CHECK (level = 'model' OR model = ''),
        CHECK ((closed_at IS NULL) = (close_reason IS NULL))
      );
      DROP TABLE runtime_incidents;
      ALTER TABLE runtime_incidents_v27 RENAME TO runtime_incidents;
      DELETE FROM schema_migrations WHERE version=29;
    `);
    seed.prepare(
      `INSERT INTO runtime_incidents
       (profile_key, runtime, executable, config_dir, level, model, scope, retry, needs, code, evidence,
        opened_item_id, opened_run_id, opened_at)
       VALUES ('codex:0123456789abcdef', 'codex', '/bin/codex', '/home/.codex', 'profile', '', 'account', 'never',
               'refill', 'out_of_credits', 'out of credits', ?, ?, '2026-10-01T00:00:00.000Z')`,
    ).run(itemId, runId);
    seed.prepare(
      `INSERT INTO runtime_health (profile_key, level, model, runtime, executable, config_dir, status, incident_id, updated_at)
       VALUES ('codex:0123456789abcdef', 'profile', '', 'codex', '/bin/codex', '/home/.codex', 'unavailable', 1,
               '2026-10-01T00:00:00.000Z')`,
    ).run();
    seed.pragma("foreign_keys = ON");
    expect(names(seed, "runtime_incidents").filter((column) => RECOVERY_COLUMNS.includes(column))).toEqual([]);
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId);
    const incidentBefore = seed.prepare("SELECT * FROM runtime_incidents").all();
    const healthBefore = seed.prepare("SELECT * FROM runtime_health").all();
    seed.close();

    const upgraded = openDb(path);
    expect(names(upgraded, "runtime_incidents")).toEqual(expect.arrayContaining(RECOVERY_COLUMNS));
    // 开着的故障照旧开着，账本照旧不可用。恢复状态从空开始。
    expect(upgraded.prepare(
      `SELECT ${Object.keys((incidentBefore as object[])[0]!).join(", ")} FROM runtime_incidents`,
    ).all()).toEqual(incidentBefore);
    expect(upgraded.prepare(`SELECT ${RECOVERY_COLUMNS.join(", ")} FROM runtime_incidents`).all()).toEqual([{
      next_probe_at: null, probe_failures: 0, last_probe_at: null, last_probe_error: null,
      canary_armed_at: null, canary_run_id: null,
    }]);
    expect(upgraded.prepare("SELECT * FROM runtime_health").all()).toEqual(healthBefore);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId))
      .toEqual(runBefore);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "runtime_incidents").filter((column) => RECOVERY_COLUMNS.includes(column)))
      .toEqual(RECOVERY_COLUMNS);
    reopened.close();
  });
});

// v31（工单 05）：每个 Run 记录它的 RuntimeProfile hash。只给 runs 补一列，不回填。
// v30 由并行的工单 09 使用。schema_migrations 按 MAX(version) 读，所以两个分支各自跳号没有影响。
describe("run runtime profile hash migration (v31)", () => {
  it("creates the column on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v31-fresh-"), "plc.db"));
    expect(names(db, "runs")).toContain("runtime_profile_hash");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=31").get())
      .toEqual({ name: "run-runtime-profile-hash-v1" });
    // 最新版本号由最新的迁移测试断言（v34）。
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(31);
    const itemId = createItem(db, { title: "fresh", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex", runtimeProfileHash: "0123456789abcdef" });
    expect(getRun(db, runId)?.runtime_profile_hash).toBe("0123456789abcdef");
    db.close();
  });

  it("upgrades a v29 database without a backfill or lifecycle changes, then reopens", () => {
    const path = join(tempDir("plc-v31-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "pi" });
    updateRun(seed, runId, { state: "failed", endedAt: true, errorCode: "process_exit", errorMessage: "old node" });
    transition(seed, { itemId, to: "blocked", actor: "system", reason: "legacy crash", runId });
    // v29 的形状：runs 没有这一列，账本里没有 v31。
    seed.exec(`
      ALTER TABLE runs DROP COLUMN runtime_profile_hash;
      DELETE FROM schema_migrations WHERE version >= 30;
    `);
    expect(names(seed, "runs")).not.toContain("runtime_profile_hash");
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT * FROM runs WHERE id=?").get(runId);
    seed.close();

    const upgraded = openDb(path);
    expect(names(upgraded, "runs")).toContain("runtime_profile_hash");
    // 历史 Run 不知道当时的 profile，保持 NULL。其余列和生命周期字段都不变。
    expect(upgraded.prepare("SELECT * FROM runs WHERE id=?").get(runId))
      .toEqual({ ...(runBefore as object), runtime_profile_hash: null });
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "runs").filter((column) => column === "runtime_profile_hash")).toHaveLength(1);
    reopened.close();
  });
});

// v32（工单 06）：内核的退避重试。只给派发请求补"不早于"时间和重试次数两列，不回填。
// 已有的请求两列都为空，照常 claim。升级不改生命周期字段，也不改已有的请求。
describe("dispatch backoff migration (v32)", () => {
  const BACKOFF_COLUMNS = ["not_before", "backoff_attempt"];

  it("creates the backoff columns on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v32-fresh-"), "plc.db"));
    expect(names(db, "dispatch_requests")).toEqual(expect.arrayContaining(BACKOFF_COLUMNS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=32").get())
      .toEqual({ name: "dispatch-backoff-v1" });
    // 最新版本号由最新的迁移测试断言（v34）。
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(32);
    const itemId = createItem(db, { title: "fresh", brief: "b", createdBy: "user" });
    // 重试次数从 1 开始。
    expect(() => db.prepare(
      `INSERT INTO dispatch_requests (item_id, role, purpose, trigger, idempotency_key, backoff_attempt)
       VALUES (?, 'executor', 'execution', 'transient-retry', 'bad', 0)`,
    ).run(itemId)).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("upgrades a v29 database without touching requests or lifecycle fields, then reopens", () => {
    const path = join(tempDir("plc-v32-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    updateRun(seed, runId, {
      state: "failed", endedAt: true, errorCode: "codex_error",
      errorMessage: "Reconnecting... waiting for network (Connection failed: error sending request)",
    });
    seed.prepare(
      `INSERT INTO dispatch_requests (item_id, role, purpose, runtime, model, trigger, idempotency_key)
       VALUES (?, 'executor', 'execution', 'codex', 'gpt-5.5', 'lead', 'legacy:1')`,
    ).run(itemId);
    // 退回 v29 的形状：派发请求没有这两列。backoff_attempt 带 CHECK，SQLite 不能 DROP COLUMN，
    // 所以按 v29 的表体重建这张表。
    seed.pragma("foreign_keys = OFF");
    seed.exec(`
      CREATE TABLE dispatch_requests_v29 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id       INTEGER NOT NULL REFERENCES items(id),
        role          TEXT NOT NULL CHECK (role IN ('executor','reviewer')),
        purpose       TEXT NOT NULL,
        runtime       TEXT,
        model         TEXT,
        resume_from_run_id INTEGER REFERENCES runs(id),
        instruction   TEXT,
        plan_owner_item_id INTEGER REFERENCES items(id),
        plan_revision INTEGER,
        trigger       TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state         TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','claimed','started','completed','failed','cancelled')),
        suspended_reason TEXT,
        suspended_incident_id INTEGER REFERENCES runtime_incidents(id),
        retry_of_run_id INTEGER REFERENCES runs(id),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO dispatch_requests_v29
        SELECT id, item_id, role, purpose, runtime, model, resume_from_run_id, instruction,
               plan_owner_item_id, plan_revision, trigger, idempotency_key, state,
               suspended_reason, suspended_incident_id, retry_of_run_id, created_at, updated_at
        FROM dispatch_requests;
      DROP TABLE dispatch_requests;
      ALTER TABLE dispatch_requests_v29 RENAME TO dispatch_requests;
      CREATE INDEX dispatch_requests_pending ON dispatch_requests(state, item_id, id);
      DELETE FROM schema_migrations WHERE version=32;
    `);
    seed.pragma("foreign_keys = ON");
    expect(names(seed, "dispatch_requests").filter((column) => BACKOFF_COLUMNS.includes(column))).toEqual([]);
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId);
    const requestsBefore = seed.prepare("SELECT * FROM dispatch_requests").all();
    seed.close();

    const upgraded = openDb(path);
    expect(names(upgraded, "dispatch_requests")).toEqual(expect.arrayContaining(BACKOFF_COLUMNS));
    // 升级不回填：历史上的断网不会在升级后变成一次自动重试。已有的请求照常 claim。
    expect(upgraded.prepare(
      `SELECT ${Object.keys((requestsBefore as object[])[0]!).join(", ")} FROM dispatch_requests`,
    ).all()).toEqual(requestsBefore);
    expect(upgraded.prepare(`SELECT ${BACKOFF_COLUMNS.join(", ")} FROM dispatch_requests`).all())
      .toEqual([{ not_before: null, backoff_attempt: null }]);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE trigger='transient-retry'").get())
      .toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT state, error_code, failure_scope, ended_at FROM runs WHERE id=?").get(runId))
      .toEqual(runBefore);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "dispatch_requests").filter((column) => BACKOFF_COLUMNS.includes(column)))
      .toEqual(BACKOFF_COLUMNS);
    // 没有"不早于"时间的旧请求照常 claim。
    expect(createDispatcher(reopened).claimNext()).toMatchObject({ itemId, trigger: "lead", runtime: "codex" });
    reopened.close();
  });
});

// v34（工单 14）：启动垫片。runs 补两列：垫片的身份（launcher）和输出游标（output_cursor），不回填。
// 历史 Run 不是垫片启动的，两列保持 NULL。工单 15 据此只接管垫片启动的 Run。v33 留给并行的工单 11。
describe("run launcher migration (v34)", () => {
  const LAUNCHER_COLUMNS = ["launcher", "output_cursor"];

  it("creates the launcher columns on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v34-fresh-"), "plc.db"));
    expect(names(db, "runs")).toEqual(expect.arrayContaining(LAUNCHER_COLUMNS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=34").get())
      .toEqual({ name: "run-launcher-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
    const itemId = createItem(db, { title: "fresh", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const launcher = {
      version: 1 as const, pid: 4242, childPid: 4243, token: "a".repeat(48),
      dir: "/tmp/launches/r1-abc", controlPath: "/tmp/launches/r1-abc/ctl.sock",
    };
    updateRun(db, runId, { launcher });
    updateRun(db, runId, { outputCursor: { offset: 120, seq: 3 } });
    expect(getRun(db, runId)).toMatchObject({
      launcher: JSON.stringify(launcher), output_cursor: JSON.stringify({ offset: 120, seq: 3 }),
    });
    db.close();
  });

  it("upgrades a v32 database without a backfill or lifecycle changes, then reopens", () => {
    const path = join(tempDir("plc-v34-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    updateRun(seed, runId, { state: "running", pid: 31337 });
    // v32 的形状：runs 没有这两列，账本里没有 v34。
    seed.exec(`
      ALTER TABLE runs DROP COLUMN launcher;
      ALTER TABLE runs DROP COLUMN output_cursor;
      DELETE FROM schema_migrations WHERE version >= 33;
    `);
    expect(names(seed, "runs").filter((column) => LAUNCHER_COLUMNS.includes(column))).toEqual([]);
    const itemBefore = seed.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId);
    const runBefore = seed.prepare("SELECT * FROM runs WHERE id=?").get(runId);
    seed.close();

    const upgraded = openDb(path);
    // 正在运行的旧 Run 保持原样：state 和 pid 不变，两列为 NULL。
    expect(upgraded.prepare("SELECT * FROM runs WHERE id=?").get(runId))
      .toEqual({ ...(runBefore as object), launcher: null, output_cursor: null });
    expect(upgraded.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(itemId))
      .toEqual(itemBefore);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
      .toBe(migrations);
    expect(names(reopened, "runs").filter((column) => LAUNCHER_COLUMNS.includes(column))).toEqual(LAUNCHER_COLUMNS);
    reopened.close();
  });
});

// 最新的 schema 版本写死在这里（release review 8）：加了迁移却没有在这里登记，这条测试会失败。
// 上面每个版本的测试只断言"至少到了那个版本"，所以只有这一处说出准确的数字。
// v35–v37 是工单 #66 复核后的数据更正（packages/store/src/data-corrections.ts）。
describe("schema version", () => {
  it("is exactly the latest migration a fresh database records", () => {
    const db = openDb(join(tempDir("plc-schema-version-"), "plc.db"));

    // v40（2026-10-15）：工单节点 item_milestones（store/test/milestones.test.ts）。
    // v41（2026-10-15，generative UI）：决策请求的 origin。
    // v42（2026-10-16，设置页的连接）：oauth_clients、connections、connection_events（store/test/connections.test.ts）。
    // v43（2026-10-17，Lead 事件主干）：事件日志 events（store/test/event-log-migration.test.ts）。
    // v44（2026-10-17，Lead 事件主干工单 05）：常设指令 standing_orders 和 events.triage（store/test/standing-orders-migration.test.ts）。
    // v45（2026-10-17，Lead 事件主干工单 09）：Jev 分诊的影子判断 event_triage_shadow（store/test/triage-shadow-migration.test.ts）。
    // v46（2026-10-17，Lead 事件主干工单 11）：通道的分道和会话卡 channel_lanes、channel_cards（store/test/channels-migration.test.ts）。
    // v47（2026-10-17，Lead 事件主干工单 15）：凭证的来历 bindings.origin、pairings.origin（store/test/binding-origin-migration.test.ts）。
    // v48（2026-10-17，Lead 事件主干工单 07）：提醒的设置 items.reminder_policy（store/test/reminder-policy-migration.test.ts）。
    // v49（2026-10-19）：Lead 的等待 lead_waits（store/test/lead-waits-migration.test.ts）。
    // v50（2026-10-20，Slack 代查工单 01；master 的 v49 是 lead_waits）：代查 channel_lookups（store/test/channel-lookups-migration.test.ts）。
    // v51（2026-10-21）：按新口径重算 token 用量的一次性数据更正（store/test/token-usage-recompute-migration.test.ts）。
    // v52（2026-10-21，工单详情工单 04）：交付快照 delivery_snapshots（store/test/delivery-snapshots-migration.test.ts）。
    // v53（2026-10-21，工单详情工单 06）：执行计划 item_execution_plans（store/test/execution-plan-migration.test.ts）。
    // v54（2026-10-22，工单详情工单 05）：结构化验收标准 item_acceptance_criteria、criterion_confirmations（store/test/acceptance-criteria-migration.test.ts）。
    // v55（2026-10-22，子 agent 的权限清单）：run_grants、run_grant_changes、run_tool_calls（store/test/run-grants.test.ts）。
    // v56（2026-10-22，工单详情工单 09）：核查员设置 item_reviewer_settings，review_policy 并进 verification_policy
    // （store/test/reviewer-settings-migration.test.ts）。
    // v57（2026-10-22，工单详情工单 10）：核查包和逐条结论 review_packets、review_verdict_details、review_criterion_verdicts
    // （store/test/review-packets-migration.test.ts）。
    // v58（2026-10-22，工单详情工单 11）：授权托管的「核查做不成时由 Lead 凭证据验收」delegation_policies.accept_without_review
    // （store/test/delegation-accept-without-review-migration.test.ts）。
    // v59（2026-10-28，后台检查）：watches、watch_checks（store/test/watches.test.ts）。
    // v60（2026-10-29，Hindsight 为主的记忆）：memory_sync、memory_invalidations（store/test/memory-sync-migration.test.ts）。
    // v61（2026-10-30，自定义控件）：widgets（store/test/widgets-migration.test.ts）。
    // v62（2026-10-30，控件的数据源）：widget_sources（store/test/widgets-migration.test.ts）。
    expect(LATEST_SCHEMA_VERSION).toBe(62);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 62 });
  });
});

// v41（2026-10-15，generative UI）：决策请求记下是谁发起的。只加列，已有的行算 agent 发起。
describe("decision origin migration (v41)", () => {
  it("creates the origin column on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v41-fresh-"), "plc.db"));
    expect(names(db, "decision_requests")).toContain("origin");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=41").get()).toEqual({ name: "decision-origin-v1" });
    db.close();
  });

  it("upgrades a v40 database: existing decisions become agent-origin, nothing else changes, then reopens", () => {
    const path = join(tempDir("plc-v41-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user" });
    const runId = createRun(seed, { itemId, runtime: "codex" });
    const decision = insertDecisionRequest(seed, {
      itemId, runId, kind: "decision", audience: "user", blocking: true, allowCustom: false,
      prompt: "选一个", options: [{ id: "a", label: "A" }],
    });
    // v40 的形状：decision_requests 没有 origin，账本里没有 v41。
    seed.exec("ALTER TABLE decision_requests DROP COLUMN origin; DELETE FROM schema_migrations WHERE version >= 41;");
    const before = seed.prepare("SELECT * FROM decision_requests WHERE id=?").get(decision.id) as object;
    const itemBefore = seed.prepare("SELECT * FROM items WHERE id=?").get(itemId);
    seed.close();

    const upgraded = openDb(path);
    expect(upgraded.prepare("SELECT * FROM decision_requests WHERE id=?").get(decision.id)).toEqual({ ...before, origin: "agent" });
    expect(upgraded.prepare("SELECT * FROM items WHERE id=?").get(itemId)).toEqual(itemBefore);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(migrations);
    reopened.close();
  });
});

// v38（2026-10-15）：派发请求和 Run 记下推理强度（effort）。只加列，不回填，不重建表。
describe("run effort migration (v38)", () => {
  it("creates the effort columns on a fresh database", () => {
    const db = openDb(join(tempDir("plc-v38-fresh-"), "plc.db"));
    expect(names(db, "runs")).toContain("effort");
    expect(names(db, "dispatch_requests")).toContain("effort");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version=38").get()).toEqual({ name: "run-effort-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
    const itemId = createItem(db, { title: "fresh", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "claude", model: "opus", effort: "high" });
    expect(getRun(db, runId)).toMatchObject({ model: "opus", effort: "high" });
    db.close();
  });

  it("upgrades a v37 database without changing any row, then reopens", () => {
    const path = join(tempDir("plc-v38-legacy-"), "plc.db");
    const seed = openDb(path);
    const itemId = createItem(seed, { title: "legacy", brief: "b", createdBy: "user", requestedRuntime: "codex" } as never);
    transition(seed, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(seed, { itemId, runtime: "codex", model: "gpt-6.1-sol" });
    updateRun(seed, runId, { state: "running", pid: 4242 });
    createDispatcher(seed).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "lead", idempotencyKey: "v37-request",
    });
    // v37 的形状：两张表都没有 effort，账本里没有 v38。
    seed.exec(`
      ALTER TABLE runs DROP COLUMN effort;
      ALTER TABLE dispatch_requests DROP COLUMN effort;
      DELETE FROM schema_migrations WHERE version >= 38;
    `);
    const runBefore = seed.prepare("SELECT * FROM runs WHERE id=?").get(runId) as object;
    const requestBefore = seed.prepare("SELECT * FROM dispatch_requests").get() as object;
    const itemBefore = seed.prepare("SELECT * FROM items WHERE id=?").get(itemId);
    seed.close();

    const upgraded = openDb(path);
    expect(upgraded.prepare("SELECT * FROM runs WHERE id=?").get(runId)).toEqual({ ...runBefore, effort: null });
    expect(upgraded.prepare("SELECT * FROM dispatch_requests").get()).toEqual({ ...requestBefore, effort: null });
    expect(upgraded.prepare("SELECT * FROM items WHERE id=?").get(itemId)).toEqual(itemBefore);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    const migrations = (upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    upgraded.close();

    const reopened = openDb(path);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(migrations);
    expect(names(reopened, "runs").filter((column) => column === "effort")).toEqual(["effort"]);
    reopened.close();
  });
});
