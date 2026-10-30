// 账本的写入守卫（2026-10-19 审查）：plc.db 可以读，不能由 daemon 以外的进程写。
// 事故里的命令是 `sqlite3 ~/.pi-lead-child/plc.db "UPDATE connections SET write_policy = 'direct' WHERE provider = 'github';"`。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  dropLedgerGuards, insertConnection, LEDGER_WRITER_FUNCTION, ledgerGuardDropSql, ledgerGuardedTables, ledgerGuardProblems,
  ledgerGuardTriggers, missingLedgerGuards, openDb, openExistingDb,
} from "../src/index.js";
import { V15_SCHEMA_FIXTURE } from "../testing/index.js";

const hasSqlite3 = spawnSync("sqlite3", ["-version"], { stdio: "ignore" }).status === 0;

function ledger(): { path: string; githubId: number } {
  const path = join(tempDir("plc-ledger-guard-"), "plc.db");
  const db = openDb(path);
  const row = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
  db.close();
  return { path, githubId: row.id };
}

describe("the ledger write guard", () => {
  it.skipIf(!hasSqlite3)("rejects the 10-19 sqlite3 UPDATE, and still answers a read-only query", () => {
    const { path, githubId } = ledger();
    const update = spawnSync("sqlite3", [path, "UPDATE connections SET write_policy = 'direct' WHERE provider = 'github';"], { encoding: "utf8" });
    expect(update.status).not.toBe(0);
    expect(update.stderr).toContain(LEDGER_WRITER_FUNCTION);
    const read = execFileSync("sqlite3", ["-readonly", path, `SELECT write_policy FROM connections WHERE id = ${githubId};`], { encoding: "utf8" });
    expect(read.trim()).toBe("confirm");
  });

  it("rejects inserts, updates and deletes from a connection that is not the daemon's", () => {
    const { path, githubId } = ledger();
    const foreign = new Database(path);
    try {
      expect(() => foreign.prepare("UPDATE connections SET write_policy = 'direct' WHERE id = ?").run(githubId)).toThrow(LEDGER_WRITER_FUNCTION);
      expect(() => foreign.prepare("DELETE FROM connection_events").run()).toThrow(LEDGER_WRITER_FUNCTION);
      expect(() => foreign.prepare("INSERT INTO kv (key, value) VALUES ('x', 'y')").run()).toThrow(LEDGER_WRITER_FUNCTION);
      expect(() => foreign.prepare("UPDATE items SET stage = 'done'").run()).toThrow(LEDGER_WRITER_FUNCTION);
      expect(foreign.prepare("SELECT write_policy FROM connections WHERE id = ?").get(githubId)).toEqual({ write_policy: "confirm" });
    } finally {
      foreign.close();
    }
  });

  it("lets the daemon's connections write: openDb and openExistingDb", () => {
    const { path, githubId } = ledger();
    const daemon = openDb(path);
    daemon.prepare("UPDATE kv SET value = value").run();
    daemon.prepare("INSERT INTO kv (key, value) VALUES ('daemon', 'ok')").run();
    daemon.close();
    const cli = openExistingDb(path);
    cli.prepare("UPDATE connections SET label = 'GitHub (cli)' WHERE id = ?").run(githubId);
    cli.close();
  });

  it("guards every ordinary table, skips the FTS tables, and stays the same on reopen", () => {
    const { path } = ledger();
    const db = openDb(path);
    const tables = ledgerGuardedTables(db);
    expect(tables).toContain("connections");
    expect(tables).toContain("items");
    expect(tables.some((name) => name.startsWith("notes_fts"))).toBe(false);
    const triggers = ledgerGuardTriggers(db);
    expect(triggers).toHaveLength(tables.length * 3);
    db.close();
    const again = openDb(path);
    expect(ledgerGuardTriggers(again)).toEqual(triggers);
    again.close();
  });
});

// 回滚（审查发现 1）：触发器写在库文件里，没有注册写入函数的旧代码打开装过守卫的库，第一条写语句就失败。
describe("rolling back past the ledger guard", () => {
  // 旧代码（master 28390d7 之前）的写法：普通连接，没有写入函数。
  const oldCodeWrite = (path: string) => {
    const old = new Database(path);
    try {
      old.prepare("INSERT INTO kv (key, value) VALUES ('old-code', 'wrote')").run();
    } finally {
      old.close();
    }
  };

  it("breaks old code until the guard is uninstalled, and uninstalling lets a plain connection write", () => {
    const { path } = ledger();
    expect(() => oldCodeWrite(path)).toThrow(LEDGER_WRITER_FUNCTION);
    const ops = openExistingDb(path);
    expect(dropLedgerGuards(ops)).toBeGreaterThan(0);
    expect(ledgerGuardTriggers(ops)).toEqual([]);
    ops.close();
    oldCodeWrite(path);
  });

  it.skipIf(!hasSqlite3)("can be uninstalled with sqlite3 alone when the new code cannot run", () => {
    const { path } = ledger();
    const db = openExistingDb(path, { readonly: true });
    const sql = ledgerGuardDropSql(db);
    db.close();
    execFileSync("sqlite3", [path], { input: sql });
    oldCodeWrite(path);
  });

  it("is left off by PLC_LEDGER_GUARD=off, and comes back when the switch is removed", () => {
    const { path } = ledger();
    process.env.PLC_LEDGER_GUARD = "off";
    try {
      openDb(path).close();
      oldCodeWrite(path);
    } finally {
      delete process.env.PLC_LEDGER_GUARD;
    }
    const db = openDb(path);
    expect(missingLedgerGuards(db)).toEqual([]);
    db.close();
    expect(() => oldCodeWrite(path)).toThrow(LEDGER_WRITER_FUNCTION);
  });

  it("finds a guard replaced by an empty trigger of the same name, and openDb puts the real one back (review round 3, finding 3)", () => {
    const { path } = ledger();
    const foreign = new Database(path);
    foreign.exec(`DROP TRIGGER "plc_ledger_guard_connections_update";
      CREATE TRIGGER "plc_ledger_guard_connections_update" BEFORE UPDATE ON "connections" BEGIN SELECT 1; END;`);
    foreign.prepare("UPDATE connections SET write_policy = 'direct'").run();
    foreign.close();
    const ops = openExistingDb(path);
    expect(ledgerGuardProblems(ops)).toEqual({ missing: [], altered: ["plc_ledger_guard_connections_update"] });
    expect(missingLedgerGuards(ops)).toEqual(["plc_ledger_guard_connections_update"]);
    ops.close();
    openDb(path).close();
    const again = new Database(path);
    expect(() => again.prepare("UPDATE connections SET write_policy = 'confirm'").run()).toThrow(LEDGER_WRITER_FUNCTION);
    again.close();
  });

  it("names the triggers a DROP TRIGGER removed", () => {
    const { path } = ledger();
    const foreign = new Database(path);
    foreign.exec('DROP TRIGGER "plc_ledger_guard_connections_update"');
    foreign.close();
    const db = openExistingDb(path);
    expect(missingLedgerGuards(db)).toEqual(["plc_ledger_guard_connections_update"]);
    db.close();
  });
});

// 旧库升级（AGENTS.md 的 legacy 路径）：v15 的库经 openDb 迁移到最新，守卫装在迁移之后的表上。
describe("upgrading a legacy ledger", () => {
  it("migrates a v15 ledger, then guards every table, and the guard survives a reopen", () => {
    const path = join(tempDir("plc-ledger-guard-legacy-"), "plc.db");
    const seed = new Database(path);
    seed.pragma("journal_mode = WAL");
    seed.pragma("foreign_keys = OFF");
    seed.exec(readFileSync(V15_SCHEMA_FIXTURE, "utf8"));
    seed.exec(`INSERT INTO schema_migrations (version, name) VALUES
      (10, 'kernel-orchestration-v1'), (11, 'checkpoint-control-plane-v1'), (12, 'plan-item-idempotency-v1'),
      (13, 'checkpoint-fidelity-storage-v1'), (14, 'item-model-v1'), (15, 'trigger-notification-v1');`);
    seed.close();
    const db = openDb(path);
    expect(missingLedgerGuards(db)).toEqual([]);
    expect(ledgerGuardedTables(db)).toContain("items");
    db.close();
    const again = openDb(path);
    expect(missingLedgerGuards(again)).toEqual([]);
    again.close();
    const foreign = new Database(path);
    expect(() => foreign.prepare("UPDATE items SET title = 'x'").run()).toThrow(LEDGER_WRITER_FUNCTION);
    foreign.close();
  });
});
