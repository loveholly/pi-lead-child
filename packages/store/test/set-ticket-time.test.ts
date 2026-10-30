// setItemTime 的 kind 分流（约束 C3）。单独成文件而不是并进 tickets.test.ts：
// 那个文件正在做夹具迁移，这里只钉这一条新行为。
import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem, setItemTime } from "../src/items.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("setItemTime", () => {
  it("refuses remind_at on a task and names the replacement", () => {
    const id = createItem(db, { title: "写周报", brief: "写周报", createdBy: "user" });
    expect(() => setItemTime(db, id, { remindAt: "2026-07-28T09:00:00.000Z" }))
      .toThrow(/create_reminder/);
    // 拦在 SQL 之前，所以行没有被动过——不是"写进去再被 CHECK 弹回来"。
    expect(getItem(db, id)!.remind_at).toBeNull();
  });

  it("still sets due_at on a task and resets the overdue flag", () => {
    const id = createItem(db, { title: "写周报", brief: "写周报", createdBy: "user" });
    db.prepare("UPDATE items SET due_overdue_notified = 1 WHERE id = ?").run(id);
    setItemTime(db, id, { dueAt: "2026-07-31T18:00:00.000Z" });
    const t = getItem(db, id)!;
    expect(t.due_at).toBe("2026-07-31T18:00:00.000Z");
    expect(t.due_overdue_notified).toBe(0);
  });

  it("reschedules a reminder", () => {
    const id = createItem(db, {
      title: "取快递", brief: "取快递", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-28T09:00:00.000Z",
    });
    setItemTime(db, id, { remindAt: "2026-07-29T09:00:00.000Z" });
    expect(getItem(db, id)!.remind_at).toBe("2026-07-29T09:00:00.000Z");
  });

  it("refuses to clear remind_at on a scheduled reminder", () => {
    const id = createItem(db, {
      title: "取快递", brief: "取快递", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-28T09:00:00.000Z",
    });
    // 清空等于造一条永远不会到点的 reminder（C3 的第二条），要停就该取消。
    expect(() => setItemTime(db, id, { remindAt: null })).toThrow(/cancel it instead/);
    expect(getItem(db, id)!.remind_at).toBe("2026-07-28T09:00:00.000Z");
  });
});
