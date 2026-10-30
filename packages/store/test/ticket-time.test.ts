import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import {
  createItem, getItem, setItemTime, remindersToFire, itemsOverdue,
  markOverdueNotified, transition,
} from "../src/items.js";
let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("item time fields", () => {
  it("remind_at drives remindersToFire, and firing is what makes it one-shot", () => {
    // remind_at 现在是 reminder 这个 kind 自己的字段（C3）：task 上挂不了，也不该挂。
    const id = createItem(db, {
      title: "交房租", brief: "提醒交房租", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T10:00:00Z",
    });
    expect(remindersToFire(db, "2026-07-24T00:00:00Z").length).toBe(0);
    expect(remindersToFire(db, "2026-07-25T10:00:01Z").length).toBe(1);
    // 幂等来自 stage，不是抹掉 remind_at：响过一次就落到 fired，下轮自然选不中。
    transition(db, { itemId: id, to: "fired", actor: "system", reason: "due" });
    expect(remindersToFire(db, "2026-07-25T10:00:01Z").length).toBe(0);
    expect(getItem(db, id)!.remind_at).toBe("2026-07-25T10:00:00Z"); // 触发时刻仍在
  });

  it("due_at overdue detection dedups via markOverdueNotified", () => {
    const id = createItem(db, { title: "报告", brief: "交报告", createdBy: "user" });
    setItemTime(db, id, { dueAt: "2026-07-20T00:00:00Z" });
    const now = "2026-07-21T00:00:00Z";
    expect(itemsOverdue(db, now).length).toBe(1);
    markOverdueNotified(db, id);
    expect(itemsOverdue(db, now).length).toBe(0); // 不重复提醒
  });

  it("done item is not flagged overdue", () => {
    const id = createItem(db, { title: "x", brief: "x", createdBy: "user" });
    setItemTime(db, id, { dueAt: "2026-07-20T00:00:00Z" });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(id);
    expect(itemsOverdue(db, "2026-07-21T00:00:00Z").length).toBe(0);
  });

  it("changing due_at resets overdue-notified flag", () => {
    const id = createItem(db, { title: "x", brief: "x", createdBy: "user" });
    setItemTime(db, id, { dueAt: "2026-07-20T00:00:00Z" });
    markOverdueNotified(db, id);
    setItemTime(db, id, { dueAt: "2026-08-01T00:00:00Z" }); // 改期
    expect(getItem(db, id)!.due_overdue_notified).toBe(0);
  });
});
