import { describe, it, expect } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";

// v13 形状的 tickets：有全部 kernel / checkpoint 列，但没有 kind / defer_until，
// 且 status 还是旧枚举。这是 v14 迁移唯一需要认得的输入形状。
const LEGACY_TICKETS = `
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog'
         CHECK (status IN ('backlog','assigned','in_progress',
                           'blocked','review','done','cancelled')),
  brief TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  project TEXT,
  project_id INTEGER,
  workdir TEXT,
  parent_ticket_id INTEGER REFERENCES tickets(id),
  root_ticket_id INTEGER REFERENCES tickets(id),
  created_by_attempt_id INTEGER,
  orchestration_state TEXT NOT NULL DEFAULT 'none',
  requested_runtime TEXT,
  requested_model TEXT,
  purpose TEXT NOT NULL DEFAULT 'execution',
  review_policy TEXT NOT NULL DEFAULT 'manual',
  max_depth INTEGER, max_children INTEGER, max_concurrency INTEGER,
  token_budget INTEGER, cost_budget_usd REAL,
  retry_limit INTEGER NOT NULL DEFAULT 1,
  active_plan_revision INTEGER,
  first_started_at TEXT,
  completed_at TEXT,
  status_changed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  notify_quota_used INTEGER NOT NULL DEFAULT 0,
  due_at TEXT, remind_at TEXT,
  due_overdue_notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  role TEXT NOT NULL DEFAULT 'executor',
  session_id TEXT, session_path TEXT, pid INTEGER,
  state TEXT NOT NULL DEFAULT 'starting',
  model TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT, last_entry_cursor TEXT
);
`;

const LEGACY_ROWS: Array<[string, string, string]> = [
  ["backlog", "b1", "user"],
  ["assigned", "a1", "lead"],
  ["in_progress", "p1", "child"],
  ["blocked", "k1", "child"],
  ["review", "r1", "system"],
  ["done", "d1", "user"],
  ["cancelled", "c1", "user"],
];

function seedLegacy(): string {
  const path = join(tempDir("plc-v14-"), "plc.db");
  const legacy = new Database(path);
  legacy.exec(LEGACY_TICKETS);
  const insert = legacy.prepare(
    "INSERT INTO tickets (status, title, brief, created_by, total_tokens) VALUES (?, ?, ?, ?, 7)",
  );
  for (const [status, title, createdBy] of LEGACY_ROWS) insert.run(status, title, title, createdBy);
  legacy.prepare("UPDATE tickets SET root_ticket_id = id").run();
  legacy.prepare("UPDATE tickets SET parent_ticket_id = 1, root_ticket_id = 1 WHERE id = 3").run();
  legacy.prepare("INSERT INTO attempts (ticket_id, model) VALUES (1, 'legacy-model')").run();
  legacy.close();
  return path;
}

describe("v14 item model migration", () => {
  it("maps legacy statuses and marks every existing row as a task", () => {
    const db = openDb(seedLegacy());
    const rows = db.prepare("SELECT id, kind, stage, title FROM items ORDER BY id")
      .all() as Array<{ id: number; kind: string; stage: string; title: string }>;

    expect(rows).toHaveLength(LEGACY_ROWS.length);
    expect(rows.every((r) => r.kind === "task")).toBe(true);
    expect(rows.map((r) => r.stage)).toEqual([
      "ready",     // backlog → ready：旧 backlog 可被直接派发
      "active",    // assigned → active
      "active",    // in_progress → active
      "blocked", "review", "done", "cancelled",
    ]);
    expect(rows.map((r) => r.title)).toEqual(LEGACY_ROWS.map(([, title]) => title));
  });

  it("preserves payload columns and the item tree", () => {
    const db = openDb(seedLegacy());
    const child = db.prepare("SELECT * FROM items WHERE id = 3").get() as {
      parent_item_id: number; root_item_id: number; total_tokens: number;
      retry_limit: number; purpose: string; created_by: string;
    };
    expect(child.parent_item_id).toBe(1);
    expect(child.root_item_id).toBe(1);
    expect(child.total_tokens).toBe(7);
    expect(child.retry_limit).toBe(1);
    expect(child.purpose).toBe("execution");
    expect(child.created_by).toBe("child");
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
  });

  it("installs the new columns, constraints and indexes", () => {
    const db = openDb(seedLegacy());
    const cols = (db.pragma("table_info(items)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("kind");
    expect(cols).toContain("defer_until");
    expect(cols).not.toContain("notify_quota_used");

    // 约束真的生效了，而不只是列建出来了
    expect(() => db.prepare("UPDATE items SET kind = 'reminder' WHERE id = 1").run())
      .toThrow(/item.kind is immutable/);
    expect(() => db.prepare(
      "INSERT INTO items (title, brief, created_by, stage) VALUES ('x','x','child','draft')",
    ).run()).toThrow(/CHECK constraint failed/);

    const idx = (db.pragma("index_list(items)") as Array<{ name: string }>).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining([
      "items_by_view", "items_by_root", "items_remind", "items_due",
    ]));
  });

  // 存量 remind_at 的去向是一个有意的取舍，不是疏漏：迁移后一切皆 task，(C3) 不允许 task
  // 带 remind_at。存量提醒是 prompt.ts:38 那条约定造出来的，特征很稳定：有 remind_at、
  // 从未执行过、还停在 backlog。三条同时成立才改判为 reminder——kind 由 (T1) 锁死为不可变，
  // 所以宁可漏判（丢一个提醒时间，用户可重设）也不能误判（真任务变成永不能执行的工单）。
  it("converts a never-executed backlog row carrying remind_at into a reminder", () => {
    const path = seedLegacy();
    const legacy = new Database(path);
    // id 6 是 'done'/'d1'，先摆回 backlog 且无 attempt，构造一条纯提醒
    legacy.prepare("UPDATE tickets SET status='backlog', remind_at=? WHERE id = 6")
      .run("2026-08-01T00:00:00.000Z");
    legacy.close();

    const db = openDb(path);
    const row = db.prepare("SELECT kind, stage, remind_at FROM items WHERE id = 6")
      .get() as { kind: string; stage: string; remind_at: string | null };
    expect(row.kind).toBe("reminder");
    expect(row.stage).toBe("scheduled");
    expect(row.remind_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("nulls every execution column on a converted reminder so C2 holds", () => {
    const path = seedLegacy();
    const legacy = new Database(path);
    legacy.prepare(
      `UPDATE tickets SET status='backlog', remind_at=?, workdir='/tmp', token_budget=999,
                          root_ticket_id=id, total_tokens=7 WHERE id = 6`,
    ).run("2026-08-01T00:00:00.000Z");
    legacy.close();

    const db = openDb(path);
    const row = db.prepare("SELECT * FROM items WHERE id = 6").get() as Record<string, unknown>;
    expect(row.kind).toBe("reminder");
    for (const c of ["workdir", "token_budget", "root_item_id", "parent_item_id",
                     "purpose", "review_policy", "retry_limit", "plan_state"]) {
      expect(row[c]).toBeNull();
    }
    expect(row.total_tokens).toBe(0);
  });

  it("keeps a row that has already run as a task and drops its remind_at", () => {
    const path = seedLegacy();
    const legacy = new Database(path);
    // id 1 是 backlog 且 seedLegacy 已给它挂了一条 attempt —— 跑过就不是提醒
    legacy.prepare("UPDATE tickets SET remind_at = ? WHERE id = 1")
      .run("2026-08-01T00:00:00.000Z");
    legacy.close();

    const db = openDb(path);
    const row = db.prepare("SELECT kind, remind_at FROM items WHERE id = 1")
      .get() as { kind: string; remind_at: string | null };
    expect(row.kind).toBe("task");
    expect(row.remind_at).toBeNull();
  });

  it("keeps a row past backlog as a task even when it carries remind_at", () => {
    const path = seedLegacy();
    const legacy = new Database(path);
    legacy.prepare("UPDATE tickets SET remind_at = ? WHERE id = 5")  // 'review'
      .run("2026-08-01T00:00:00.000Z");
    legacy.close();

    const db = openDb(path);
    const row = db.prepare("SELECT kind, stage, remind_at FROM items WHERE id = 5")
      .get() as { kind: string; stage: string; remind_at: string | null };
    expect(row.kind).toBe("task");
    expect(row.stage).toBe("review");
    expect(row.remind_at).toBeNull();
  });

  it("keeps rows whose created_by falls outside the new enum", () => {
    const path = seedLegacy();
    const legacy = new Database(path);
    legacy.prepare("UPDATE tickets SET created_by = 'migration:legacy' WHERE id = 1").run();
    legacy.close();

    const db = openDb(path);
    expect((db.prepare("SELECT created_by AS c FROM items WHERE id = 1")
      .get() as { c: string }).c).toBe("system");
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n)
      .toBe(LEGACY_ROWS.length);
  });

  it("records version 14 exactly once and is a no-op on reopen", () => {
    const path = seedLegacy();
    const first = openDb(path);
    const snapshot = first.prepare("SELECT id, kind, stage FROM items ORDER BY id").all();
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT id, kind, stage FROM items ORDER BY id").all())
      .toEqual(snapshot);
    expect((second.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14",
    ).get() as { n: number }).n).toBe(1);
  });

  it("is a no-op on a database created fresh from the current schema", () => {
    const path = join(tempDir("plc-v14-fresh-"), "plc.db");
    const fresh = openDb(path);
    expect((fresh.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14",
    ).get() as { n: number }).n).toBe(1);
    fresh.close();
    expect(() => openDb(path).close()).not.toThrow();
  });
});
