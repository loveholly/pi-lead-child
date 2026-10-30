import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { createRun, getRun, pauseRun, resumeRun } from "../src/runs.js";
import { getItemTiming } from "../src/timing.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
});

describe("run pause/resume", () => {
  it("clears pid on pause and keeps the session", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare("UPDATE runs SET state='running', pid=99, session_id='s1' WHERE id=?").run(id);
    pauseRun(db, id, new Date("2026-07-27T00:00:00.000Z"));
    const a = getRun(db, id)!;
    expect(a.state).toBe("paused");
    expect(a.pid).toBeNull();
    expect(a.session_id).toBe("s1");
    expect(a.paused_at).toBe("2026-07-27T00:00:00.000Z");
  });

  it("accumulates paused_ms across repeated pause/resume", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(id);
    pauseRun(db, id, new Date("2026-07-27T00:00:00.000Z"));
    resumeRun(db, id, new Date("2026-07-27T00:00:10.000Z"));   // +10s
    pauseRun(db, id, new Date("2026-07-27T00:00:20.000Z"));
    resumeRun(db, id, new Date("2026-07-27T00:00:25.000Z"));   // +5s
    const a = getRun(db, id)!;
    expect(a.paused_ms).toBe(15_000);
    expect(a.paused_at).toBeNull();
    expect(a.state).toBe("running");
  });

  it("refuses to pause a run that is not running", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare("UPDATE runs SET state='finished' WHERE id=?").run(id);
    expect(() => pauseRun(db, id, new Date())).toThrow(/cannot pause run in state finished/);
  });

  it("refuses to resume a run that is not paused", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(id);
    expect(() => resumeRun(db, id, new Date()))
      .toThrow(/cannot resume run in state running/);
  });

  it("reports a missing run instead of silently doing nothing", () => {
    expect(() => pauseRun(db, 999)).toThrow(/run 999 not found/);
    expect(() => resumeRun(db, 999)).toThrow(/run 999 not found/);
  });
});

describe("timing excludes paused spans", () => {
  it("subtracts accumulated and in-flight pause time", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare(
      "UPDATE runs SET state='running', started_at=?, paused_ms=? WHERE id=?",
    ).run("2026-07-27T00:00:00.000Z", 10_000, id);
    // 60s 墙钟 - 10s 已累计暂停 = 50s
    let t = getItemTiming(db, itemId, new Date("2026-07-27T00:01:00.000Z"));
    expect(t.activeExecutionMs).toBe(50_000);

    // 再进入暂停 20s：80s 墙钟 - 10s 累计 - 20s 在飞 = 50s，暂停期间不增长
    db.prepare("UPDATE runs SET state='paused', paused_at=? WHERE id=?")
      .run("2026-07-27T00:01:00.000Z", id);
    t = getItemTiming(db, itemId, new Date("2026-07-27T00:01:20.000Z"));
    expect(t.activeExecutionMs).toBe(50_000);
  });

  it("keeps an ended run's paused time out of the total", () => {
    // ended_at 已定的 Run 不能拿 now 去算在飞暂停，否则收工越久扣得越多，耗时会倒着走。
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare(
      `UPDATE runs SET state='finished', started_at=?, ended_at=?, paused_ms=? WHERE id=?`,
    ).run("2026-07-27T00:00:00.000Z", "2026-07-27T00:01:00.000Z", 20_000, id);
    const t = getItemTiming(db, itemId, new Date("2026-07-27T09:00:00.000Z"));
    expect(t.activeExecutionMs).toBe(40_000);
  });

  it("never lets pause time drive a run negative", () => {
    const id = createRun(db, { itemId, role: "executor" });
    db.prepare(
      `UPDATE runs SET state='finished', started_at=?, ended_at=?, paused_ms=? WHERE id=?`,
    ).run("2026-07-27T00:00:00.000Z", "2026-07-27T00:00:10.000Z", 99_000, id);
    expect(getItemTiming(db, itemId, new Date("2026-07-27T00:01:00.000Z")).activeExecutionMs)
      .toBe(0);
  });
});

// 老库上 attempts.state 的 CHECK 依然是不含 paused 的旧枚举，而 SQLite 不能 ALTER CHECK。
// 没有重建迁移，暂停在存量库上会直接撞约束——这条用例就是钉住那次重建。
describe("existing databases accept the paused state", () => {
  function legacyDb(): string {
    const path = join(tempDir("plc-legacy-run-"), "plc.db");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        brief TEXT NOT NULL, created_by TEXT NOT NULL,
        status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        due_overdue_notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        role TEXT NOT NULL DEFAULT 'executor' CHECK (role IN ('executor','reviewer')),
        session_id TEXT, session_path TEXT, pid INTEGER,
        state TEXT NOT NULL DEFAULT 'starting'
              CHECK (state IN ('starting','running','settled','crashed','stopped')),
        model TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT, last_entry_cursor TEXT
      );
      INSERT INTO tickets (title, brief, created_by, status) VALUES ('a','b','user','in_progress');
      INSERT INTO attempts (ticket_id, state, session_id) VALUES (1, 'running', 's-legacy');
    `);
    raw.close();
    return path;
  }

  it("rebuilds the state CHECK and preserves every run", () => {
    const path = legacyDb();
    const migrated = openDb(path);
    expect((migrated.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
    pauseRun(migrated, 1, new Date("2026-07-27T00:00:00.000Z"));
    const a = getRun(migrated, 1)!;
    expect(a.state).toBe("paused");
    expect(a.session_id).toBe("s-legacy");   // 暂停保留 session（spec §3.2）
    expect(a.paused_ms).toBe(0);
    // 重建 DROP 掉旧表时索引会一并消失，必须重放，否则 external session 查询悄悄退化成全表扫描。
    expect(migrated.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='runs_external_session'",
    ).get()).toBeTruthy();
    migrated.close();

    // 幂等：第二次 openDb 不得再重建一遍（重建会丢掉 paused_at）。
    const reopened = openDb(path);
    expect(getRun(reopened, 1)!.state).toBe("paused");
    expect(getRun(reopened, 1)!.paused_at).toBe("2026-07-27T00:00:00.000Z");
  });
});
