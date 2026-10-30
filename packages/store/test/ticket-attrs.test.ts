import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem, listItems, updateItemAttrs } from "../src/items.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = tempDir("plc-");
  db = openDb(join(dir, "plc.db"));
});

describe("priority/project attributes", () => {
  it("defaults to normal priority and null project", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    const t = getItem(db, id)!;
    expect(t.priority).toBe("normal");
    expect(t.project).toBeNull();
  });

  it("accepts priority and project on create, filters and sorts", () => {
    createItem(db, { title: "low", brief: "b", createdBy: "user", priority: "low", project: "alpha" });
    createItem(db, { title: "urgent", brief: "b", createdBy: "user", priority: "urgent", project: "alpha" });
    createItem(db, { title: "other", brief: "b", createdBy: "user", project: "beta" });
    const alpha = listItems(db, { project: "alpha" });
    expect(alpha.map((t) => t.title)).toEqual(["urgent", "low"]); // 优先级降序
    expect(listItems(db, { project: "beta" }).length).toBe(1);
    expect(listItems(db).length).toBe(3);
  });

  it("filters by text across title/brief/body", () => {
    createItem(db, { title: "调研 WAL", brief: "SQLite 写前日志", createdBy: "user" });
    const id2 = createItem(db, { title: "工具", brief: "CSV 统计", createdBy: "user" });
    db.prepare("UPDATE items SET body = '包含 WAL 对比表' WHERE id = ?").run(id2);
    expect(listItems(db, { text: "WAL" }).length).toBe(2);   // title + body 各中一
    expect(listItems(db, { text: "CSV" }).length).toBe(1);   // brief 命中
    expect(listItems(db, { text: "不存在" }).length).toBe(0);
  });

  it("updates attrs on an existing item", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    updateItemAttrs(db, id, { priority: "high", project: "gamma" });
    const t = getItem(db, id)!;
    expect(t.priority).toBe("high");
    expect(t.project).toBe("gamma");
  });

  it("migrates a pre-M2.1 database in place (existing rows preserved)", () => {
    // 构造无 priority/project 列的旧库并写入一行
    const oldPath = join(dir, "old.db");
    const raw = new Database(oldPath);
    raw.exec(`CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'backlog',
      brief TEXT NOT NULL, workdir TEXT, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT, total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0, notify_quota_used INTEGER NOT NULL DEFAULT 0
    );`);
    raw.prepare("INSERT INTO tickets (title, brief, created_by) VALUES ('遗留', 'b', 'user')").run();
    raw.close();

    const migrated = openDb(oldPath);
    const t = migrated.prepare("SELECT * FROM items WHERE id = 1").get() as any;
    expect(t.title).toBe("遗留");
    expect(t.priority).toBe("normal");
    expect(t.project).toBeNull();
  });
});
