// 工单节点（左栏改版阶段 3）：一张工单可以有截止、提测、发布、核查和自定义的日期，每个都有出处和修改历史。
// items.due_at 变成派生值：最早的未完成截止节点，在同一个事务里同步。
// v40 只新增两张表：老库回填一次（每个有 due_at 的 task 一个截止节点），新库没有回填，重开不重复，items 的列不变。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { LATEST_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import { createItem, getItem, setItemTime } from "../src/items.js";
import {
  createMilestone,
  leadOverridesOfUser,
  listMilestoneChanges,
  listMilestones,
  nextPlannedMilestones,
  updateMilestone,
} from "../src/milestones.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-milestones-"), "plc.db")); });

const task = (title = "修复 review 状态投影") => createItem(db, { title, brief: "b", createdBy: "user" });

describe("a milestone", () => {
  it("records who set it, from which words, and every change after that", () => {
    const id = task();
    const milestone = createMilestone(db, id, { kind: "test_handoff", at: "2026-10-16T10:00:00.000Z" }, {
      actor: "lead", quote: "明天下午六点提测", confidence: "high",
    });
    expect(milestone).toMatchObject({
      kind: "test_handoff", state: "planned", source_actor: "lead", source_quote: "明天下午六点提测", confidence: "high",
    });

    updateMilestone(db, milestone.id, { at: "2026-10-17T10:00:00.000Z" }, { actor: "user", reason: "推迟一天" });
    updateMilestone(db, milestone.id, { state: "done" }, { actor: "user" });

    expect(listMilestoneChanges(db, milestone.id).map((change) => [change.change, change.actor])).toEqual([
      ["created", "lead"], ["moved", "user"], ["completed", "user"],
    ]);
    expect(listMilestones(db, { itemId: id })[0]).toMatchObject({ state: "done", at: "2026-10-17T10:00:00.000Z" });
  });

  it("belongs to a task only, and a custom one needs a label", () => {
    const reminder = createItem(db, { title: "交周报", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-10-17T09:00:00.000Z" });
    expect(() => createMilestone(db, reminder, { kind: "due", at: "2026-10-17T09:00:00.000Z" }, { actor: "user" })).toThrow(/tasks/);
    expect(() => createMilestone(db, task(), { kind: "custom", at: "2026-10-17T09:00:00.000Z" }, { actor: "user" })).toThrow(/label/);
  });

  it("keeps the confidence only for a date that Lead or a child inferred", () => {
    const milestone = createMilestone(db, task(), { kind: "release", at: "2026-10-20T00:00:00.000Z" }, { actor: "user", confidence: "low" });
    expect(milestone.confidence).toBeNull();
  });

  it("is never deleted: cancelling and restoring are changes", () => {
    const milestone = createMilestone(db, task(), { kind: "review", at: "2026-10-18T00:00:00.000Z" }, { actor: "user" });
    updateMilestone(db, milestone.id, { state: "cancelled" }, { actor: "user" });
    const restored = updateMilestone(db, milestone.id, { state: "planned" }, { actor: "user" });
    expect(restored.change?.change).toBe("restored");
    expect(restored.milestone.closed_at).toBeNull();
  });
});

describe("items.due_at", () => {
  it("follows the earliest planned due milestone, and moving it resets the overdue alert", () => {
    const id = task();
    const first = createMilestone(db, id, { kind: "due", at: "2026-10-16T10:00:00.000Z" }, { actor: "user" });
    createMilestone(db, id, { kind: "due", at: "2026-10-20T10:00:00.000Z" }, { actor: "user" });
    // 提测不是截止：不影响 due_at。
    createMilestone(db, id, { kind: "test_handoff", at: "2026-10-15T10:00:00.000Z" }, { actor: "user" });
    expect(getItem(db, id)?.due_at).toBe("2026-10-16T10:00:00.000Z");

    db.prepare("UPDATE items SET due_overdue_notified = 1 WHERE id = ?").run(id);
    updateMilestone(db, first.id, { state: "cancelled" }, { actor: "user" });
    const item = getItem(db, id)!;
    expect(item.due_at).toBe("2026-10-20T10:00:00.000Z");
    expect(item.due_overdue_notified).toBe(0);
  });

  it("is set through a due milestone by setItemTime, and cleared by cancelling it", () => {
    const id = task();
    setItemTime(db, id, { dueAt: "2026-10-16T10:00:00.000Z" }, { actor: "lead" });
    setItemTime(db, id, { dueAt: "2026-10-17T10:00:00.000Z" }, { actor: "lead" });
    const [due] = listMilestones(db, { itemId: id });
    expect(due).toMatchObject({ kind: "due", at: "2026-10-17T10:00:00.000Z", source_actor: "lead" });
    expect(listMilestoneChanges(db, due!.id).map((change) => change.change)).toEqual(["created", "moved"]);

    setItemTime(db, id, { dueAt: null }, { actor: "lead" });
    expect(getItem(db, id)?.due_at).toBeNull();
    expect(listMilestones(db, { itemId: id })[0]?.state).toBe("cancelled");
  });

  it("stays a plain field on a reminder", () => {
    const id = createItem(db, { title: "交周报", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-10-17T09:00:00.000Z" });
    setItemTime(db, id, { dueAt: "2026-10-17T18:00:00.000Z" });
    expect(getItem(db, id)?.due_at).toBe("2026-10-17T18:00:00.000Z");
    expect(listMilestones(db, { itemId: id })).toEqual([]);
  });
});

describe("the next milestone of each ticket", () => {
  it("is the earliest planned one of any kind", () => {
    const id = task();
    createMilestone(db, id, { kind: "due", at: "2026-10-20T10:00:00.000Z" }, { actor: "user" });
    const handoff = createMilestone(db, id, { kind: "test_handoff", at: "2026-10-16T10:00:00.000Z" }, { actor: "user" });
    expect(nextPlannedMilestones(db).get(id)?.id).toBe(handoff.id);
    updateMilestone(db, handoff.id, { state: "done" }, { actor: "user" });
    expect(nextPlannedMilestones(db).get(id)?.kind).toBe("due");
  });
});

describe("Lead changing a date the user set", () => {
  it("is listed so the inbox can tell the user", () => {
    const milestone = createMilestone(db, task(), { kind: "test_handoff", at: "2026-10-16T10:00:00.000Z" }, { actor: "user" });
    const update = updateMilestone(db, milestone.id, { at: "2026-10-17T10:00:00.000Z" }, { actor: "lead", reason: "#72 还阻塞，提测顺延一天" });
    expect(update.overrodeUser).toBe(true);
    expect(leadOverridesOfUser(db, "2026-01-01T00:00:00.000Z").map((entry) => entry.change.reason)).toEqual(["#72 还阻塞，提测顺延一天"]);
    // Lead 再改自己改过的，不算。
    expect(updateMilestone(db, milestone.id, { at: "2026-10-18T10:00:00.000Z" }, { actor: "lead", reason: "再顺延" }).overrodeUser).toBe(false);
  });
});

describe("the v40 migration", () => {
  const itemColumns = (handle: Db) => (handle.pragma("table_info(items)") as { name: string }[]).map((column) => column.name);

  it("gives every task with a due date one due milestone, once, and changes no item", () => {
    const path = join(tempDir("plc-milestones-legacy-"), "plc.db");
    const legacy = openDb(path);
    const withDue = createItem(legacy, { title: "有截止", brief: "b", createdBy: "user", project: "pi-lead-child" });
    const done = createItem(legacy, { title: "已完成", brief: "b", createdBy: "user" });
    const withoutDue = createItem(legacy, { title: "没有截止", brief: "b", createdBy: "user" });
    const reminder = createItem(legacy, { title: "提醒", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-10-17T09:00:00.000Z" });
    legacy.prepare("UPDATE items SET due_at = '2026-10-16T10:00:00.000Z', due_overdue_notified = 1 WHERE id = ?").run(withDue);
    legacy.prepare("UPDATE items SET due_at = '2026-09-01T10:00:00.000Z', stage = 'done' WHERE id = ?").run(done);
    legacy.prepare("UPDATE items SET due_at = '2026-10-17T18:00:00.000Z' WHERE id = ?").run(reminder);
    // 退回 v39 的样子：没有节点表，也没有 v40 的记录。
    legacy.exec("DROP TRIGGER item_milestones_task_only; DROP TABLE item_milestone_changes; DROP TABLE item_milestones");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 40").run();
    const columnsBefore = itemColumns(legacy);
    const itemsBefore = legacy.prepare("SELECT * FROM items ORDER BY id").all();
    legacy.close();

    const migrated = openDb(path);
    expect(itemColumns(migrated)).toEqual(columnsBefore);
    expect(migrated.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
    const backfilled = migrated.prepare("SELECT item_id, kind, at, state, source_actor FROM item_milestones ORDER BY item_id").all();
    expect(backfilled).toEqual([
      { item_id: withDue, kind: "due", at: "2026-10-16T10:00:00.000Z", state: "planned", source_actor: "system" },
      { item_id: done, kind: "due", at: "2026-09-01T10:00:00.000Z", state: "planned", source_actor: "system" },
    ]);
    expect(migrated.prepare("SELECT change, actor, reason FROM item_milestone_changes ORDER BY id").all()).toEqual([
      { change: "created", actor: "system", reason: "v40 backfill" },
      { change: "created", actor: "system", reason: "v40 backfill" },
    ]);
    expect(withoutDue).toBeGreaterThan(0);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM item_milestones").get()).toEqual({ n: 2 });
    expect(reopened.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
  });

  it("creates the tables in a new database without backfilling anything", () => {
    const fresh = openDb(join(tempDir("plc-milestones-fresh-"), "plc.db"));
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM item_milestones").get()).toEqual({ n: 0 });
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 40").get()).toEqual({ n: 1 });
  });
});
