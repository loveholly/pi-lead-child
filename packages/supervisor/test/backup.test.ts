// 维护前的在线备份（审查 2026-10-20 A）：以前按缺省每步 100 页复制，没有时限；另一个连接每写一次，备份就从头开始，
// 约 60 MB 的库在频繁写入时一分钟也完不成。现在一步复制全部页面，并且到时限就放弃、删掉半成品。
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { backupSqlite } from "../src/deploy/backup.js";

function busyDatabase(dir: string): string {
  const path = join(dir, "plc.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = db.prepare("INSERT INTO rows (body) VALUES (?)");
  db.transaction(() => { for (let i = 0; i < 4_000; i += 1) insert.run("x".repeat(1_000)); })();
  db.close();
  return path;
}

describe("backupSqlite", () => {
  it("finishes while another connection keeps writing", async () => {
    const dir = tempDir("plc-backup-");
    const source = busyDatabase(dir);
    const writer = new Database(source);
    const insert = writer.prepare("INSERT INTO rows (body) VALUES ('w')");
    const timer = setInterval(() => insert.run(), 5);
    try {
      const destination = join(dir, "copy.db");
      const started = Date.now();
      await backupSqlite(source, destination, { timeoutMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(10_000);
      const copy = new Database(destination, { readonly: true });
      expect((copy.prepare("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n).toBeGreaterThanOrEqual(4_000);
      copy.close();
    } finally {
      clearInterval(timer);
      writer.close();
    }
  });

  it("gives up at the time limit and leaves no half-written copy", async () => {
    const dir = tempDir("plc-backup-timeout-");
    const source = busyDatabase(dir);
    const destination = join(dir, "copy.db");
    await expect(backupSqlite(source, destination, { timeoutMs: 0, pagesPerStep: 1 })).rejects.toThrow(/did not finish within 0 ms/);
    expect(existsSync(destination)).toBe(false);
  });
});
