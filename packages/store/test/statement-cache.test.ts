import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { cacheStatements, openDb, setSlowStatementLog } from "../src/db.js";

const require = createRequire(import.meta.url);

// 2026-11-03：45 秒的 CPU profile 里有 16.7 秒花在重复编译同样的 SQL 上，daemon 主线程被占满。
describe("statement cache", () => {
  it("reuses the compiled statement for the same SQL", () => {
    const db = openDb(join(tempDir("plc-stmt-cache-"), "plc.db"));
    const sql = "SELECT count(*) AS n FROM items";
    expect(db.prepare(sql)).toBe(db.prepare(sql));
    expect(db.prepare(sql).get()).toEqual({ n: 0 });
    db.close();
  });

  it("compiles a separate statement while the cached one is iterating", () => {
    const db = cacheStatements(new Database(":memory:"));
    db.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2)");
    const sql = "SELECT v FROM t ORDER BY v";
    const seen: number[] = [];
    for (const row of db.prepare(sql).iterate() as Iterable<{ v: number }>) {
      seen.push(row.v, ...(db.prepare(sql).all() as Array<{ v: number }>).map((inner) => inner.v));
    }
    expect(seen).toEqual([1, 1, 2, 2, 1, 2]);
    db.close();
  });

  it("drops the least recently used statement past the limit", () => {
    const db = cacheStatements(new Database(":memory:"), 2);
    const a = db.prepare("SELECT 1");
    const b = db.prepare("SELECT 2");
    expect(db.prepare("SELECT 1")).toBe(a);
    db.prepare("SELECT 3");
    expect(db.prepare("SELECT 1")).toBe(a);
    expect(db.prepare("SELECT 2")).not.toBe(b);
    db.close();
  });

  // acceptance-criteria.test.ts 的 deliver() 用 pluck() 读 stage，之后 liveDeliveryRun 拿到的是字符串，不是行。
  it("keeps the shared statement in its default mode when a caller plucks, binds or reads raw", () => {
    const db = cacheStatements(new Database(":memory:"));
    db.exec("CREATE TABLE t (id INTEGER, v TEXT); INSERT INTO t VALUES (1, 'a')");
    const sql = "SELECT v FROM t WHERE id=?";
    expect(db.prepare(sql).pluck().get(1)).toBe("a");
    expect(db.prepare(sql).raw().get(1)).toEqual(["a"]);
    expect(db.prepare(sql).bind(1).get()).toEqual({ v: "a" });
    expect(db.prepare(sql).get(1)).toEqual({ v: "a" });
    db.close();
  });

  it("does not cache SQL that fails to compile", () => {
    const db = cacheStatements(new Database(":memory:"));
    expect(() => db.prepare("SELECT * FROM missing")).toThrow(/no such table/);
    db.exec("CREATE TABLE missing (v INTEGER)");
    expect(db.prepare("SELECT * FROM missing").all()).toEqual([]);
    db.close();
  });
});

// 2026-11-04：busy_timeout 是 5 秒，别的进程拿着写锁时 daemon 在主线程上同步等。先记下慢语句，看它发生过没有。
describe("slow statement log", () => {
  it("logs a slow statement once a minute with its SQL text and no parameters", () => {
    const db = openDb(join(tempDir("plc-slow-sql-"), "plc.db"));
    const lines: string[] = [];
    setSlowStatementLog((line) => lines.push(line), 0);
    try {
      const sql = "SELECT count(*) AS n FROM items WHERE title = ?";
      db.prepare(sql).get("secret-title");
      db.prepare(sql).get("secret-title");
      db.prepare(sql).all("secret-title");
      db.prepare("SELECT count(*) AS n FROM runs").get();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[slow-sql\] \d+ ms get: SELECT count\(\*\) AS n FROM items WHERE title = \?$/);
      expect(lines[1]).toContain("FROM runs");
      expect(lines.join("\n")).not.toContain("secret-title");
    } finally {
      setSlowStatementLog(null);
      db.close();
    }
  });

  // lead-scheduler P0b（审计第 3 项）：daemon 的写大多走 db.transaction(...).immediate()。better-sqlite3 的 BEGIN IMMEDIATE
  // 在原生层编译，不经过上面的计时，所以等别的进程放开写锁的时间以前看不到。本机实测：别的进程拿着写锁多久，
  // daemon 的主线程就停多久（300 毫秒→360，1.5 秒→1.5 秒，4 秒→4.0–4.1 秒），最长 5 秒（busy_timeout）。
  it("logs how long a transaction waited for another process to release the write lock", async () => {
    const dir = tempDir("plc-lock-wait-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const lines: string[] = [];
    setSlowStatementLog((line) => lines.push(line), 100);
    const holder = spawn(process.execPath, ["-e", `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new Database(${JSON.stringify(dbPath)});
      db.prepare("BEGIN IMMEDIATE").run();
      process.stdout.write("locked\\n");
      const end = Date.now() + 400;
      while (Date.now() < end) {}
      db.prepare("COMMIT").run();
      db.close();
    `], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
      const started = performance.now();
      db.transaction(() => { db.prepare("UPDATE items SET updated_at = updated_at").run(); }).immediate();
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThan(150);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[sched\] db\.lock_wait waitedMs=\d+ mode=immediate thresholdMs=100$/);
      expect(Number(/waitedMs=(\d+)/.exec(lines[0]!)![1])).toBeGreaterThan(150);
      // 已经在事务里时是 SAVEPOINT，不等锁，也不记。
      db.transaction(() => db.transaction(() => undefined).immediate()).immediate();
      expect(lines).toHaveLength(1);
    } finally {
      setSlowStatementLog(null);
      await new Promise((resolve) => holder.exitCode !== null ? resolve(undefined) : holder.once("exit", resolve));
      db.close();
    }
  });

  it("logs a lock wait that ran out of busy_timeout, with the error", async () => {
    const dir = tempDir("plc-lock-wait-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    db.pragma("busy_timeout = 200");
    const lines: string[] = [];
    setSlowStatementLog((line) => lines.push(line), 100);
    const holder = spawn(process.execPath, ["-e", `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new Database(${JSON.stringify(dbPath)});
      db.prepare("BEGIN IMMEDIATE").run();
      process.stdout.write("locked\\n");
      const end = Date.now() + 800;
      while (Date.now() < end) {}
      db.prepare("COMMIT").run();
      db.close();
    `], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
      expect(() => db.transaction(() => undefined).immediate()).toThrow(/locked|busy/i);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[sched\] db\.lock_wait waitedMs=\d+ mode=immediate thresholdMs=100 error=SQLITE_BUSY$/);
    } finally {
      setSlowStatementLog(null);
      await new Promise((resolve) => holder.exitCode !== null ? resolve(undefined) : holder.once("exit", resolve));
      db.close();
    }
  });

  it("stays quiet under the threshold", () => {
    const db = openDb(join(tempDir("plc-slow-sql-"), "plc.db"));
    const lines: string[] = [];
    setSlowStatementLog((line) => lines.push(line), 60_000);
    try {
      db.prepare("SELECT count(*) AS n FROM items").get();
      expect(lines).toEqual([]);
    } finally {
      setSlowStatementLog(null);
      db.close();
    }
  });
});
