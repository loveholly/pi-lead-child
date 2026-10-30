import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

function insertRaw(cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO items (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((k) => cols[k]));
}

describe("items.kind column", () => {
  it("defaults to task and accepts the task stage enum", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", stage: "draft" });
    const row = db.prepare("SELECT kind, stage FROM items WHERE id = 1").get() as
      { kind: string; stage: string };
    expect(row.kind).toBe("task");
    expect(row.stage).toBe("draft");
  });

  it("rejects a task carrying a reminder stage", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "scheduled",
    })).toThrow(/CHECK constraint failed/);
  });

  it("rejects a reminder carrying a task stage", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "reminder", stage: "draft",
      remind_at: "2026-08-01T00:00:00.000Z",
    })).toThrow(/CHECK constraint failed/);
  });

  it("accepts a reminder in the reminder stage enum", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    const row = db.prepare("SELECT kind, stage FROM items WHERE id = 1").get() as
      { kind: string; stage: string };
    expect(row.kind).toBe("reminder");
    expect(row.stage).toBe("scheduled");
  });
});

describe("kind immutability", () => {
  it("rejects changing kind on an existing row", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", stage: "draft" });
    expect(() => db.prepare("UPDATE items SET kind = 'reminder' WHERE id = 1").run())
      .toThrow(/item.kind is immutable/);
  });

  it("allows an UPDATE that does not change kind", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", stage: "draft" });
    db.prepare("UPDATE items SET kind = 'task', title = 'x' WHERE id = 1").run();
    expect((db.prepare("SELECT title FROM items WHERE id=1").get() as { title: string }).title)
      .toBe("x");
  });
});

describe("tree integrity", () => {
  it("rejects a task parented to a reminder", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready",
      parent_item_id: 1,
    })).toThrow(/parent\/root of an item must be a task/);
  });

  it("rejects re-pointing an existing task's root at a reminder", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    expect(() => db.prepare("UPDATE items SET root_item_id = 1 WHERE id = 2").run())
      .toThrow(/parent\/root of an item must be a task/);
  });

  it("allows a task parented to a task", () => {
    insertRaw({ title: "p", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    insertRaw({
      title: "c", brief: "b", created_by: "child", kind: "task", stage: "ready",
      parent_item_id: 1, root_item_id: 1,
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(2);
  });

  it("allows the self-root update pattern", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    db.prepare("UPDATE items SET root_item_id = id WHERE id = 1").run();
    expect((db.prepare("SELECT root_item_id AS r FROM items WHERE id=1")
      .get() as { r: number }).r).toBe(1);
  });
});

describe("(C2) reminder carries no execution-side fields", () => {
  const base = {
    title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
    remind_at: "2026-08-01T00:00:00.000Z",
  };

  it("rejects a reminder with a token budget", () => {
    expect(() => insertRaw({ ...base, token_budget: 1000 }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects a reminder with a retry limit", () => {
    expect(() => insertRaw({ ...base, retry_limit: 3 }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects a reminder with a parent", () => {
    insertRaw({ title: "p", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    expect(() => insertRaw({ ...base, parent_item_id: 1 }))
      .toThrow(/CHECK constraint failed/);
  });

  // 溯源列不属于执行侧：spec §6.6 明确 child 可以创建 item，那条 reminder 必须能记下
  // 是哪次 run 建的，否则来源不可追。
  it("allows a reminder to record the run that created it", () => {
    insertRaw({ title: "p", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    db.prepare("INSERT INTO runs (item_id) VALUES (1)").run();
    insertRaw({ ...base, created_by: "child", created_by_run_id: 1 });
    const row = db.prepare("SELECT created_by_run_id AS a FROM items WHERE id = 2")
      .get() as { a: number };
    expect(row.a).toBe(1);
  });
});

describe("(C3) remind_at belongs to reminders only", () => {
  it("rejects a task carrying remind_at", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready",
      remind_at: "2026-08-01T00:00:00.000Z",
    })).toThrow(/CHECK constraint failed/);
  });

  it("rejects clearing remind_at on a scheduled reminder", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    expect(() => db.prepare("UPDATE items SET remind_at = NULL WHERE id = 1").run())
      .toThrow(/CHECK constraint failed/);
  });
});

describe("(C4) only user/lead authored items may rest in draft", () => {
  it("rejects a child-created draft", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "child", kind: "task", stage: "draft",
    })).toThrow(/CHECK constraint failed/);
  });
});

describe("(T2) tree integrity, remaining paths", () => {
  function reminder(): void {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", stage: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
  }

  it("rejects an INSERT whose root is a reminder", () => {
    reminder();
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready",
      root_item_id: 1,
    })).toThrow(/parent\/root of an item must be a task/);
  });

  it("rejects re-pointing an existing task's parent at a reminder", () => {
    reminder();
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready" });
    expect(() => db.prepare("UPDATE items SET parent_item_id = 1 WHERE id = 2").run())
      .toThrow(/parent\/root of an item must be a task/);
  });

  // 触发器不能把完整性外包给 PRAGMA foreign_keys——它默认 OFF，且迁移期间会被显式关掉。
  // 指向不存在的行时子查询返回 NULL，必须用 null-safe 的 IS NOT 才拦得住。
  it("rejects a dangling parent even with foreign keys disabled", () => {
    db.pragma("foreign_keys = OFF");
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready",
      parent_item_id: 999,
    })).toThrow(/parent\/root of an item must be a task/);
  });

  it("rejects a dangling root even with foreign keys disabled", () => {
    db.pragma("foreign_keys = OFF");
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", stage: "ready",
      root_item_id: 999,
    })).toThrow(/parent\/root of an item must be a task/);
  });
});
