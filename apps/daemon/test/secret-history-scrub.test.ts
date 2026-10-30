// 历史记录里的密钥明文的清理（spec 的方案 E）。只由部署流程执行；这里只在临时目录里测。
// 复审意见 2：plc.db 的 gateway_events、backups/*.db、plc.db.bak-*、artifacts/blobs/ 都要覆盖，UPDATE 之后要 VACUUM。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, openDb } from "@pi-lead-child/store";
import { scrubSecretHistory } from "../src/secret-history-scrub.js";

const KEY = "am-live-7Hq2Zx9Lw4Pr8Kt1Vb6Nc3";
const BLOB = "5b586b0000000000000000000000000000000000000000000000000000000000";

function seed(): string {
  const dir = tempDir("plc-scrub-history-");
  for (const [area, name] of [
    ["runtime-events", "run-109.jsonl"], ["sessions/item-96", "s.jsonl"], ["lead-sessions", "l.jsonl"],
    ["launches/r109", "output.jsonl"], ["logs", "daemon.log"],
  ] as const) {
    mkdirSync(join(dir, area), { recursive: true });
    writeFileSync(join(dir, area, name), `{"out":"AM_API_KEY=${KEY}"}\nnothing here\n`);
  }
  const db = openDb(join(dir, "plc.db"));
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId, role: "executor", purpose: "execution" });
  db.prepare("INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, 1, 'tool.completed', ?, 't')")
    .run(runId, JSON.stringify({ result: `AM_API_KEY=${KEY}` }));
  db.prepare("INSERT INTO gateway_events (event_id, event_type, required_scope, payload, occurred_at) VALUES ('e1', 'run.event', 'tickets:view', ?, 't')")
    .run(JSON.stringify({ output: `AM_API_KEY=${KEY}` }));
  // 删掉的行留在旧页里：行里查不到，文件里还有。
  // items 有锁住 kind 一列的触发器（BEFORE UPDATE OF kind），别的列照常清理。
  db.prepare("UPDATE items SET body = ? WHERE id = ?").run(`env: AM_API_KEY=${KEY}`, itemId);
  db.prepare("INSERT INTO kv (key, value) VALUES ('leftover', ?)").run(`AM_API_KEY=${KEY}`);
  db.prepare("DELETE FROM kv WHERE key = 'leftover'").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  mkdirSync(join(dir, "backups"));
  copyFileSync(join(dir, "plc.db"), join(dir, "backups", "plc-20261018.db"));
  copyFileSync(join(dir, "plc.db"), join(dir, "plc.db.bak-20261012-160928-v34"));
  mkdirSync(join(dir, "artifacts", "blobs", "5b"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "blobs", "5b", BLOB), `log line AM_API_KEY=${KEY}\n`);
  // 一个只追加的表：触发器拒绝 UPDATE。
  const ledger = new Database(join(dir, "backups", "append-only.db"));
  ledger.exec(`CREATE TABLE notes (body TEXT);
    CREATE TRIGGER notes_append_only BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'append only'); END;`);
  ledger.prepare("INSERT INTO notes VALUES (?)").run(`AM_API_KEY=${KEY}`);
  ledger.close();
  return dir;
}

const fileHas = (path: string) => readFileSync(path).includes(Buffer.from(KEY));

describe("scrubbing secret values out of history", () => {
  it("finds every place in a dry run and changes nothing", () => {
    const dir = seed();
    const report = scrubSecretHistory({ dataDir: dir, values: [KEY], apply: false });
    expect(report.text.matched).toBe(5);
    const plc = report.databases.find((db) => db.path === join(dir, "plc.db"))!;
    expect(plc.tables).toMatchObject({ runtime_events: 1, gateway_events: 1, items: 1 });
    expect(plc.readOnlyTables).toEqual([]);
    expect(plc.rawHits).toBeGreaterThanOrEqual(2);
    expect(report.databases.map((db) => db.path)).toEqual(expect.arrayContaining([
      join(dir, "backups", "plc-20261018.db"), join(dir, "plc.db.bak-20261012-160928-v34"),
    ]));
    expect(report.needsDecision).toEqual(expect.arrayContaining([
      { path: join("artifacts", "blobs", "5b", BLOB), reason: expect.stringContaining("sha256") },
      { path: join("backups", "append-only.db"), reason: expect.stringContaining("只追加") },
    ]));
    expect(fileHas(join(dir, "launches/r109/output.jsonl"))).toBe(true);
    expect(fileHas(join(dir, "plc.db"))).toBe(true);
  });

  it("with apply, clears text files, every table, the backups and the free pages, and leaves the blob for you", () => {
    const dir = seed();
    const report = scrubSecretHistory({ dataDir: dir, values: [KEY], apply: true });
    for (const path of ["runtime-events/run-109.jsonl", "sessions/item-96/s.jsonl", "lead-sessions/l.jsonl", "launches/r109/output.jsonl", "logs/daemon.log"]) {
      expect(readFileSync(join(dir, path), "utf8"), path).toContain("AM_API_KEY=[REDACTED]");
    }
    for (const path of ["plc.db", "backups/plc-20261018.db", "plc.db.bak-20261012-160928-v34"]) {
      expect(fileHas(join(dir, path)), path).toBe(false);
      const db = report.databases.find((entry) => entry.path === join(dir, path))!;
      expect(db).toMatchObject({ integrityBefore: "ok", integrityAfter: "ok", vacuumed: true });
    }
    expect(fileHas(join(dir, "artifacts", "blobs", "5b", BLOB))).toBe(true);
    const again = scrubSecretHistory({ dataDir: dir, values: [KEY], apply: false });
    expect(again.text.matched).toBe(0);
    expect(again.databases.map((db) => db.path)).toEqual([join(dir, "backups", "append-only.db")]);
  });
});
