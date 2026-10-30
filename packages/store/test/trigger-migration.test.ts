import { describe, it, expect } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";

// v14 形状的库：tickets 已是 Item 模型，但 inbox 的 ticket_id 还是 NOT NULL 且没有
// dedup_scope，schedules 表还在。这是 v15 迁移唯一需要认得的输入形状。
const LEGACY_V14 = `
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'task',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  brief TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  project TEXT, project_id INTEGER,
  due_at TEXT, defer_until TEXT, remind_at TEXT,
  due_overdue_notified INTEGER NOT NULL DEFAULT 0,
  parent_ticket_id INTEGER, root_ticket_id INTEGER,
  workdir TEXT, requested_runtime TEXT, requested_model TEXT,
  purpose TEXT, review_policy TEXT,
  max_depth INTEGER, max_children INTEGER, max_concurrency INTEGER,
  token_budget INTEGER, cost_budget_usd REAL, retry_limit INTEGER,
  orchestration_state TEXT, active_plan_revision INTEGER,
  created_by TEXT NOT NULL,
  created_by_attempt_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT, first_started_at TEXT, completed_at TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  severity TEXT NOT NULL CHECK (severity IN ('blocker','attention')),
  source TEXT NOT NULL CHECK (source IN ('structural','semantic')),
  summary TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, brief TEXT NOT NULL, cron TEXT NOT NULL,
  workdir TEXT, priority TEXT NOT NULL DEFAULT 'normal', project TEXT,
  spawn INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function seedV14(): string {
  const path = join(tempDir("plc-v15-"), "plc.db");
  const legacy = new Database(path);
  legacy.exec(LEGACY_V14);
  for (const version of [10, 11, 12, 13, 14]) {
    legacy.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(version, `legacy-${version}`);
  }
  legacy.prepare(
    "INSERT INTO tickets (title, brief, created_by, status) VALUES ('t','b','user','draft')",
  ).run();
  legacy.prepare(
    "INSERT INTO inbox (ticket_id, severity, source, summary) VALUES (1,'blocker','structural','旧告警')",
  ).run();
  legacy.prepare(
    `INSERT INTO schedules (title, brief, cron, workdir, priority, project, spawn, next_run_at, enabled)
     VALUES ('体检提醒','去体检','0 9 1 * *',NULL,'normal',NULL,0,'2026-08-01T09:00:00.000Z',1)`,
  ).run();
  legacy.prepare(
    `INSERT INTO schedules (title, brief, cron, workdir, priority, project, spawn, next_run_at, enabled)
     VALUES ('每周汇总','汇总本周工单','0 9 * * 1','/tmp/w','high','plc',1,'2026-08-03T09:00:00.000Z',0)`,
  ).run();
  legacy.close();
  return path;
}

describe("v15 trigger/notification migration", () => {
  it("migrates schedules into triggers preserving cron, spawn and enabled", () => {
    const db = openDb(seedV14());
    const rows = db.prepare("SELECT * FROM triggers ORDER BY id").all() as Array<{
      label: string; enabled: number; created_by: string; source_type: string;
      cron_expr: string; next_fire_at: string; action_type: string; action_payload: string;
    }>;
    expect(rows).toHaveLength(2);

    const [remind, spawn] = rows;
    expect(remind.label).toBe("体检提醒");
    expect(remind.source_type).toBe("cron");
    expect(remind.cron_expr).toBe("0 9 1 * *");
    expect(remind.next_fire_at).toBe("2026-08-01T09:00:00.000Z");
    expect(remind.enabled).toBe(1);
    // spawn=0 曾经每次触发新建一条永不执行的工单（spec §1）；现在产提醒。
    expect(remind.action_type).toBe("create_item");
    expect(JSON.parse(remind.action_payload).kind).toBe("reminder");

    // spawn=1 的语义由 create_and_start 承接（spec §12）
    expect(spawn.action_type).toBe("create_and_start");
    expect(JSON.parse(spawn.action_payload).kind).toBe("task");
    expect(JSON.parse(spawn.action_payload).workdir).toBe("/tmp/w");
    expect(JSON.parse(spawn.action_payload).brief).toBe("汇总本周工单");
    expect(spawn.enabled).toBe(0); // 停用状态原样保留

    // created_by 一律 user：存量 schedule 都是用户意图，且 (C5) 要求 create_and_start
    // 只能挂在 user 建的 trigger 上。
    expect(rows.every((r) => r.created_by === "user")).toBe(true);
  });

  it("drops the schedules table", () => {
    const db = openDb(seedV14());
    expect(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedules'",
    ).get()).toBeUndefined();
  });

  it("rebuilds inbox with a nullable item_id and a backfilled dedup_scope", () => {
    const db = openDb(seedV14());
    const row = db.prepare("SELECT item_id, dedup_scope, summary FROM inbox WHERE id = 1")
      .get() as { item_id: number; dedup_scope: string; summary: string };
    expect(row.summary).toBe("旧告警");
    expect(row.dedup_scope).toBe("item:1");
    // 新形状真的生效了，而不只是列建出来了
    db.prepare(
      `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary)
       VALUES (NULL, 'sys:watchdog', 'attention', 'structural', 's')`,
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n).toBe(2);
  });

  it("records version 15 exactly once and is a no-op on reopen", () => {
    const path = seedV14();
    const first = openDb(path);
    const snapshot = first.prepare("SELECT id, label, action_type FROM triggers ORDER BY id").all();
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT id, label, action_type FROM triggers ORDER BY id").all())
      .toEqual(snapshot);
    expect((second.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 15",
    ).get() as { n: number }).n).toBe(1);
  });

  it("is a no-op on a database created fresh from the current schema", () => {
    const path = join(tempDir("plc-v15-fresh-"), "plc.db");
    const fresh = openDb(path);
    expect((fresh.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 15",
    ).get() as { n: number }).n).toBe(1);
    expect((fresh.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n).toBe(0);
    fresh.close();
    expect(() => openDb(path).close()).not.toThrow();
  });
});
