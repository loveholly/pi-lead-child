import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem } from "../src/items.js";
import { createCronTrigger, getTrigger } from "../src/triggers.js";
import { runTriggerAction } from "../src/trigger-actions.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

function rawTrigger(createdBy: string, payload: unknown, actionType = "create_item"): void {
  db.prepare(
    `INSERT INTO triggers (label, created_by, source_type, cron_expr, cron_tz, next_fire_at,
                           action_type, action_payload)
     VALUES ('x', ?, 'cron', '0 3 * * 0', 'UTC', '2026-08-02T03:00:00.000Z', ?, ?)`,
  ).run(createdBy, actionType, JSON.stringify(payload));
}

describe("trigger action executor", () => {
  it("creates a reminder at stage scheduled with remind_at injected from the occurrence", () => {
    const id = createCronTrigger(db, {
      label: "weekly", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "交周报" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const itemId = runTriggerAction(db, getTrigger(db, id)!, "2026-08-03T09:00:00.000Z");
    const t = getItem(db, itemId!)!;
    expect(t.kind).toBe("reminder");
    expect(t.stage).toBe("scheduled");
    // 静态模板里没有 remind_at；执行器必须按 occurrence 注入，否则永远不触发
    expect(t.remind_at).toBe("2026-08-03T09:00:00.000Z");
  });

  it("creates a task at the declared initial stage", () => {
    const id = createCronTrigger(db, {
      label: "audit", cronExpr: "0 3 * * 0", tz: "UTC", createdBy: "user",
      action: { type: "create_item",
                payload: { kind: "task", title: "依赖审计", brief: "b", initial_stage: "ready" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const itemId = runTriggerAction(db, getTrigger(db, id)!, "2026-08-02T03:00:00.000Z");
    expect(getItem(db, itemId!)!.stage).toBe("ready");
  });

  it("defaults a task to draft when the template declares no stage", () => {
    rawTrigger("user", { kind: "task", title: "t", brief: "b" });
    const itemId = runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z");
    const item = getItem(db, itemId!)!;
    expect(item.stage).toBe("draft");
    // hold 只对树根生效（§6.6）。trigger 展开出来的 item 恒为根——没有 parent_item_id——
    // 所以那条限制碰不到这里，上面这个 draft 不会因为它而变成 ready。
    expect(item.parent_item_id).toBeNull();
    expect(item.root_item_id).toBe(item.id);
  });

  // spec §5.3「权限传递」：非 user 的 trigger 声明 ready 时静默降级为 draft，并记录原因
  it("downgrades initial_stage ready to draft for a non-user trigger", () => {
    rawTrigger("lead", { kind: "task", title: "t", brief: "b", initial_stage: "ready" });
    const notes: string[] = [];
    const itemId = runTriggerAction(
      db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z", { onNote: (n) => notes.push(n) });
    expect(getItem(db, itemId!)!.stage).toBe("draft");
    expect(notes.join(" ")).toMatch(/downgraded/);
  });

  it("rejects initial_stage outside the kind's machine", () => {
    rawTrigger("user", { kind: "reminder", title: "t", initial_stage: "draft" });
    expect(() => runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z"))
      .toThrow(/initial_stage 'draft' is not valid for kind 'reminder'/);
  });

  it("records the origin trigger on the item it produced", () => {
    rawTrigger("user", { kind: "reminder", title: "t" });
    const itemId = runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z")!;
    const activity = db.prepare(
      "SELECT payload FROM activities WHERE item_id = ? ORDER BY id LIMIT 1",
    ).get(itemId) as { payload: string };
    expect(JSON.parse(activity.payload).from_trigger).toBe(1);
  });

  it("starts a run for create_and_start, at a stage the gate accepts", () => {
    rawTrigger(
      "user", { kind: "task", title: "t", brief: "b" }, "create_and_start");
    const started: number[] = [];
    const itemId = runTriggerAction(
      db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z", { startRun: (t) => started.push(t) })!;
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(started).toEqual([itemId]);
  });

  it("starts a run on an existing task for start_item", () => {
    const target = createItem(db, { title: "t", brief: "b", createdBy: "user" }); // → ready
    rawTrigger("user", { item_id: target }, "start_item");
    const started: number[] = [];
    const returned = runTriggerAction(
      db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z", { startRun: (t) => started.push(t) });
    expect(returned).toBe(target);
    expect(started).toEqual([target]);
  });

  // 闸门在执行器里跑，而不是只在 startRun 里：即便没接上真正的派发器，配错的 trigger
  // 也必须当场失败，而不是安静地什么都不做。
  it("refuses start_item on a draft task", () => {
    const target = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    rawTrigger("user", { item_id: target }, "start_item");
    expect(() => runTriggerAction(
      db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z", { startRun: () => {} }))
      .toThrow(/executor run requires stage/);
  });

  it("refuses start_item on a reminder", () => {
    const target = createItem(db, {
      title: "t", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-02T03:00:00.000Z",
    });
    rawTrigger("user", { item_id: target }, "start_item");
    expect(() => runTriggerAction(
      db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z", { startRun: () => {} }))
      .toThrow(/only a task may have a run/);
  });

  // 没接派发器就静默成功，等于"trigger 响了但什么都没发生"，是最难发现的一类故障。
  it("throws when a run-producing action has no runner wired", () => {
    rawTrigger("user", { kind: "task", title: "t", brief: "b" }, "create_and_start");
    expect(() => runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z"))
      .toThrow(/no runner/);
  });

  it("rejects a payload kind outside the item model", () => {
    rawTrigger("user", { kind: "project", title: "t" });
    expect(() => runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z"))
      .toThrow(/unknown item kind/);
  });
});
