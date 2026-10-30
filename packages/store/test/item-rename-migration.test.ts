import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { V15_SCHEMA_FIXTURE } from "../testing/index.js";

// v16 改名迁移。输入形状取自 packages/store/testing/fixtures/v15-schema.sql——那是改名前 openDb 产出的物理
// 形状快照，刻意不引用 schema.ts：引用了就变成自我印证，schema.ts 一改输入也跟着改，
// 测试再也证明不了"老库升得上来"。
const FIXTURE = readFileSync(V15_SCHEMA_FIXTURE, "utf8");

function tempDbPath(): string {
  return join(tempDir("plc-item-rename-"), "state.db");
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

function objectNames(db: Db, type: "index" | "trigger"): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all(type) as Array<{ name: string }>).map((row) => row.name);
}

function colNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function rowCount(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * 造一个 v15 形态的库。runStates 决定三条 attempts 各自的 state，用来盯住值映射。
 */
function seedV15(runStates: string[] = ["settled", "crashed", "running"]): string {
  const path = tempDbPath();
  const db = new Database(path);
  db.pragma("foreign_keys = OFF"); // 建表顺序按字母序，FK 目标未必先建
  db.exec(FIXTURE);

  db.exec(`
    -- v15 库的账本必须齐全，否则 v10–v13 会在这个已经是新形状的库上重跑一遍。
    INSERT INTO schema_migrations (version, name) VALUES
      (10, 'kernel-orchestration-v1'), (11, 'checkpoint-control-plane-v1'),
      (12, 'plan-item-idempotency-v1'), (13, 'checkpoint-fidelity-storage-v1'),
      (14, 'item-model-v1'), (15, 'trigger-notification-v1');
    INSERT INTO projects (id, slug, name, created_by) VALUES (1, 'p', 'P', 'user');
    INSERT INTO tickets (id, kind, title, body, status, brief, created_by, root_ticket_id,
                         orchestration_state, status_changed_at, first_started_at)
      VALUES (1, 'task', 'root task', '', 'active', 'b1', 'user', 1, 'none',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO tickets (id, kind, title, body, status, brief, created_by,
                         parent_ticket_id, root_ticket_id, orchestration_state,
                         status_changed_at, completed_at)
      VALUES (2, 'task', 'child task', '', 'done', 'b2', 'lead', 1, 1, 'none',
              '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z');
    INSERT INTO tickets (id, kind, title, body, status, brief, created_by, remind_at,
                         status_changed_at)
      VALUES (3, 'reminder', 'ping me', 'body', 'scheduled', 'b3', 'user',
              '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);

  const attempt = db.prepare(
    "INSERT INTO attempts (id, ticket_id, role, state, runtime) VALUES (?, 1, 'executor', ?, 'pi')",
  );
  runStates.forEach((state, index) => attempt.run(index + 1, state));

  db.exec(`
    INSERT INTO activities (ticket_id, attempt_id, actor, kind, payload)
      VALUES (1, 1, 'lead', 'comment', '{}');
    INSERT INTO approvals (ticket_id, attempt_id, requested_by, tool, action, expires_at)
      VALUES (1, 1, 'child', 'bash', 'run tests', '2026-03-01T00:00:00Z');
    INSERT INTO inbox (ticket_id, dedup_scope, severity, source, summary)
      VALUES (1, 'item:1', 'attention', 'structural', 's');
    INSERT INTO checkpoints (id, ticket_id, attempt_id, source, kind, title, summary,
                             related_ticket_ids, content_hash)
      VALUES (1, 1, 1, 'agent_reported', 'progress', 't', 's', '[2]', 'h');
    INSERT INTO ticket_proof_items (ticket_id, item_id, label, state, checkpoint_id, updated_at)
      VALUES (1, 'proof-a', 'Tests pass', 'passed', 1, '2026-01-01T00:00:00Z');
    INSERT INTO artifacts (ticket_id, attempt_id, checkpoint_id, ref, name, kind, media_type,
                           availability)
      VALUES (1, 1, 1, 'r', 'n', 'reference', 'text/plain', 'metadata_only');
    INSERT INTO decision_requests (ticket_id, attempt_id, kind, audience, prompt)
      VALUES (1, 1, 'decision', 'lead', 'pick one');
    INSERT INTO ticket_plan_revisions (parent_ticket_id, revision, state, created_by_attempt_id)
      VALUES (1, 1, 'open', 1);
    INSERT INTO ticket_plan_memberships (parent_ticket_id, revision, child_ticket_id, item_key)
      VALUES (1, 1, 2, 'k1');
    INSERT INTO ticket_dependencies (parent_ticket_id, plan_revision, ticket_id,
                                     depends_on_ticket_id, created_by_attempt_id)
      VALUES (1, 1, 2, 1, 1);
    INSERT INTO runtime_events (attempt_id, seq, event_type, payload, occurred_at)
      VALUES (1, 1, 'e', '{}', '2026-01-01T00:00:00Z');
    INSERT INTO dispatch_requests (ticket_id, role, purpose, plan_owner_ticket_id, trigger,
                                   idempotency_key)
      VALUES (1, 'executor', 'execution', 1, 'manual', 'idem-1');
    INSERT INTO review_verdicts (attempt_id, ticket_id, verdict, evidence)
      VALUES (1, 1, 'pass', 'e');
    INSERT INTO notifications (ticket_id, kind, urgency, title)
      VALUES (1, 'reminder', 'immediate', 'n');
    INSERT INTO triggers (id, label, created_by, source_type, cron_expr, action_type)
      VALUES (1, 'l', 'user', 'cron', '* * * * *', 'create_item');
    INSERT INTO trigger_fires (trigger_id, dedup_key, occurrence_at, produced_ticket_id)
      VALUES (1, 'd', '2026-01-01T00:00:00Z', 1);
  `);
  db.close();
  return path;
}

function runStates(db: Db): string[] {
  return (db.prepare("SELECT state FROM runs ORDER BY id").all() as Array<{ state: string }>)
    .map((row) => row.state);
}

describe("v16 item rename migration", () => {
  it("renames tables and columns while preserving every row", () => {
    const db = openDb(seedV15());

    expect(tableExists(db, "items")).toBe(true);
    expect(tableExists(db, "tickets")).toBe(false);
    expect(tableExists(db, "runs")).toBe(true);
    expect(tableExists(db, "attempts")).toBe(false);
    expect(tableExists(db, "item_plan_revisions")).toBe(true);
    expect(tableExists(db, "item_plan_memberships")).toBe(true);
    expect(tableExists(db, "item_dependencies")).toBe(true);
    expect(tableExists(db, "item_proof_items")).toBe(true);
    for (const gone of [
      "ticket_plan_revisions", "ticket_plan_memberships",
      "ticket_dependencies", "ticket_proof_items",
    ]) {
      expect(tableExists(db, gone)).toBe(false);
    }

    const cols = colNames(db, "items");
    expect(cols).toEqual(expect.arrayContaining([
      "stage", "plan_state", "first_run_at", "closed_at", "stage_changed_at",
      "parent_item_id", "root_item_id", "created_by_run_id",
    ]));
    for (const gone of [
      "status", "orchestration_state", "first_started_at", "completed_at",
      "status_changed_at", "parent_ticket_id", "root_ticket_id", "created_by_attempt_id",
    ]) {
      expect(cols).not.toContain(gone);
    }

    expect(colNames(db, "runs")).toContain("item_id");
    expect(colNames(db, "runs")).not.toContain("ticket_id");

    expect(rowCount(db, "items")).toBe(3);
    expect(rowCount(db, "runs")).toBe(3);
    // 值随行走，不只是列头改名
    expect(
      db.prepare("SELECT stage, closed_at FROM items WHERE id = 2").get(),
    ).toEqual({ stage: "done", closed_at: "2026-01-03T00:00:00Z" });
    db.close();
  });

  it("renames ticket_id to item_id on every satellite table", () => {
    const db = openDb(seedV15());
    const satellites = [
      "activities", "approvals", "inbox", "checkpoints", "artifacts",
      "decision_requests", "notifications", "dispatch_requests", "review_verdicts",
      "channel_turns", "gateway_events", "learning_candidates", "capability_runs",
      "dispatch_claims", "conversation_cards",
    ];
    for (const table of satellites) {
      const cols = colNames(db, table);
      expect(cols, table).toContain("item_id");
      expect(cols, table).not.toContain("ticket_id");
    }
    for (const table of ["activities", "approvals", "checkpoints", "artifacts",
      "decision_requests", "runtime_events", "review_verdicts", "learning_candidates",
      "capability_runs", "dispatch_claims", "conversation_cards"]) {
      const cols = colNames(db, table);
      if (cols.includes("run_id") || cols.includes("attempt_id")) {
        expect(cols, table).toContain("run_id");
        expect(cols, table).not.toContain("attempt_id");
      }
    }
    expect(colNames(db, "trigger_fires")).toContain("produced_item_id");
    expect(colNames(db, "checkpoints")).toContain("related_item_ids");
    expect(colNames(db, "item_dependencies")).toEqual(
      expect.arrayContaining(["parent_item_id", "item_id", "depends_on_item_id"]),
    );
    expect(colNames(db, "item_plan_memberships")).toEqual(
      expect.arrayContaining(["parent_item_id", "child_item_id"]),
    );
    expect(colNames(db, "dispatch_requests")).toContain("plan_owner_item_id");
    db.close();
  });

  it("renames the proof-item business key out of the way", () => {
    const db = openDb(seedV15());
    const cols = colNames(db, "item_proof_items");
    expect(cols).toEqual(expect.arrayContaining(["item_id", "proof_key"]));
    // 改名前这张表的 item_id 是业务键；改名后 item_id 指事项，业务键叫 proof_key
    expect(cols.filter((c) => c === "item_id")).toHaveLength(1);
    expect(db.prepare("SELECT item_id, proof_key FROM item_proof_items").get())
      .toEqual({ item_id: 1, proof_key: "proof-a" });
    db.close();
  });

  it("maps the two run-state values", () => {
    const db = openDb(seedV15(["settled", "crashed", "running"]));
    expect(runStates(db)).toEqual(["finished", "failed", "running"]);
    db.close();
  });

  it("teaches the runs CHECK the new state vocabulary", () => {
    const db = openDb(seedV15());
    expect(() => db.prepare(
      "INSERT INTO runs (item_id, role, state) VALUES (1, 'executor', 'finished')",
    ).run()).not.toThrow();
    expect(() => db.prepare(
      "INSERT INTO runs (item_id, role, state) VALUES (1, 'executor', 'settled')",
    ).run()).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("leaves no stale index or trigger names behind", () => {
    const db = openDb(seedV15());
    const indexes = objectNames(db, "index");
    const triggers = objectNames(db, "trigger");
    for (const stale of [
      "tickets_by_view", "tickets_by_root", "tickets_remind", "tickets_due",
      "approvals_ticket_status", "approvals_attempt", "attempts_external_session",
      "artifacts_ticket_id", "channel_turns_ticket_created",
      "checkpoints_ticket_id", "checkpoints_attempt_id",
      "conversation_cards_ticket", "decision_requests_ticket_state",
      "decision_requests_attempt", "ticket_dependencies_target",
      "ticket_plan_memberships_item_key",
      "ticket_proof_items_ticket_state", "ticket_proof_items_checkpoint",
    ]) {
      expect(indexes, stale).not.toContain(stale);
    }
    for (const fresh of [
      "items_by_view", "items_by_root", "items_remind", "items_due",
      "approvals_item_status", "approvals_run", "runs_external_session",
      "artifacts_item_id", "channel_turns_item_created",
      "checkpoints_item_id", "checkpoints_run_id",
      "conversation_cards_item", "decision_requests_item_state",
      "decision_requests_run", "item_dependencies_target",
      "item_plan_memberships_item_key",
      "item_proof_items_item_state", "item_proof_items_checkpoint",
    ]) {
      expect(indexes, fresh).toContain(fresh);
    }
    for (const stale of ["tickets_kind_immutable", "tickets_tree_is_task_i",
      "tickets_tree_is_task_u"]) {
      expect(triggers, stale).not.toContain(stale);
    }
    for (const fresh of ["items_kind_immutable", "items_tree_is_task_i",
      "items_tree_is_task_u"]) {
      expect(triggers, fresh).toContain(fresh);
    }
    // 新旧同名的另一面：同一份索引不能既留旧名又生新名，否则两份都在维护
    expect(new Set(indexes).size).toBe(indexes.length);
    db.close();
  });

  it("keeps the renamed triggers enforcing the same invariants", () => {
    const db = openDb(seedV15());
    expect(() => db.prepare("UPDATE items SET kind = 'reminder' WHERE id = 1").run())
      .toThrow(/kind is immutable/);
    expect(() => db.prepare("UPDATE items SET parent_item_id = 3 WHERE id = 2").run())
      .toThrow(/must be a task/);
    db.close();
  });

  it("passes foreign_key_check after the rename", () => {
    const db = openDb(seedV15());
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("is idempotent across reopens", () => {
    const path = seedV15();
    const first = openDb(path);
    const shape = {
      items: colNames(first, "items"),
      runs: colNames(first, "runs"),
      indexes: objectNames(first, "index"),
      triggers: objectNames(first, "trigger"),
      itemRows: rowCount(first, "items"),
      runRows: rowCount(first, "runs"),
      states: runStates(first),
    };
    first.close();

    const second = openDb(path);
    expect(colNames(second, "items")).toEqual(shape.items);
    expect(colNames(second, "runs")).toEqual(shape.runs);
    expect(objectNames(second, "index")).toEqual(shape.indexes);
    expect(objectNames(second, "trigger")).toEqual(shape.triggers);
    expect(rowCount(second, "items")).toBe(shape.itemRows);
    expect(rowCount(second, "runs")).toBe(shape.runRows);
    expect(runStates(second)).toEqual(shape.states);
    // 版本号只记一次
    const applied = second.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 16",
    ).get() as { n: number };
    expect(applied.n).toBe(1);
    second.close();
  });

  it("is born with the new names on a fresh database", () => {
    const db = openDb(tempDbPath());
    expect(tableExists(db, "items")).toBe(true);
    expect(tableExists(db, "runs")).toBe(true);
    expect(tableExists(db, "tickets")).toBe(false);
    expect(tableExists(db, "attempts")).toBe(false);
    expect(colNames(db, "items")).toEqual(expect.arrayContaining(["stage", "plan_state"]));
    expect(objectNames(db, "trigger")).toEqual(expect.arrayContaining([
      "items_kind_immutable", "items_tree_is_task_i", "items_tree_is_task_u",
    ]));
    // 全新库与升级库必须收敛到同一形状，否则迁移只是把问题挪到了两条分叉上
    const upgraded = openDb(seedV15());
    expect(colNames(db, "items")).toEqual(colNames(upgraded, "items"));
    expect(colNames(db, "runs")).toEqual(colNames(upgraded, "runs"));
    expect(objectNames(db, "index")).toEqual(objectNames(upgraded, "index"));
    expect(objectNames(db, "trigger")).toEqual(objectNames(upgraded, "trigger"));
    upgraded.close();
    db.close();
  });
});
