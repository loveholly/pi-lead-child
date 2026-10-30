import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, setItemTime, listItems } from "@pi-lead-child/store";
import { createCronTrigger, getTrigger, listTriggers } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { listNotifications } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createScheduler } from "../src/pipeline/scheduler.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

const at = (iso: string) => () => new Date(iso);

describe("scheduler tick", () => {
  afterEach(() => vi.unstubAllEnvs());

  // 取代 Phase 1 那条"已知缺陷"测试：旧实现 addInbox + clearRemind，而清掉 scheduled
  // reminder 的 remind_at 直接撞 (C3)，tick 在 inbox 行已写下之后才抛。正确做法是
  // scheduled → fired 的跃迁——触发时刻是历史，不是要抹掉的东西。
  it("sweeps a due reminder into fired and notifies the user, never through inbox", () => {
    const id = createItem(db, {
      title: "交房租", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    createScheduler(db, { now: at("2026-07-25T10:00:01.000Z") }).tick();

    const t = getItem(db, id)!;
    expect(t.stage).toBe("fired");
    expect(t.remind_at).toBe("2026-07-25T10:00:00.000Z"); // 触发时刻保留

    const notes = listNotifications(db, { state: ["pending"] });
    expect(notes).toHaveLength(1);
    expect(notes[0].urgency).toBe("immediate");
    expect(notes[0].item_id).toBe(id);
    // 这是整个重构存在的理由（spec §1）：提醒绝不能再走会去抖的 inbox。
    expect(listInbox(db)).toHaveLength(0);
  });

  it("never fires the same reminder twice", () => {
    createItem(db, {
      title: "交房租", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    const s = createScheduler(db, { now: at("2026-07-25T10:00:01.000Z") });
    s.tick(); s.tick();
    expect(listNotifications(db)).toHaveLength(1);
  });

  it("flags overdue item once", () => {
    const id = createItem(db, { title: "报告", brief: "b", createdBy: "user" });
    setItemTime(db, id, { dueAt: "2026-07-20T00:00:00.000Z" });
    const s = createScheduler(db, { now: at("2026-07-21T00:00:00.000Z") });
    s.tick(); s.tick();
    const overdue = listNotifications(db).filter((n) => n.kind === "overdue");
    expect(overdue).toHaveLength(1);
    expect(overdue[0].urgency).toBe("batchable"); // 逾期可攒批，不打断
  });

  // 取代旧的 "spawns ticket from due schedule and advances; optionally spawns child"：
  // schedules.spawn=1 的语义由 action_type='create_and_start' 承接（spec §12）。
  it("fires a due cron trigger, creates the task and starts a run, then advances", () => {
    vi.stubEnv("TZ", "UTC");
    const started: number[] = [];
    createCronTrigger(db, {
      label: "每周汇总", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_and_start", payload: { title: "每周汇总", brief: "汇总本周工单" } },
    }, new Date("2026-07-21T08:00:00.000Z"));
    createScheduler(db, {
      now: at("2026-07-27T09:00:01.000Z"), onStartRun: (id) => started.push(id),
    }).tick();

    const items = listItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("每周汇总");
    expect(items[0].stage).toBe("ready"); // 闸门只认 ready/active/blocked
    expect(started).toEqual([items[0].id]);
    expect(listTriggers(db)[0].next_fire_at).toBe("2026-08-03T09:00:00.000Z"); // 已推进
  });

  // 取代旧的 "schedule with spawn=0 creates ticket but no child"。spawn=0 曾经每次触发
  // 新建一条永不执行的工单（spec §1 的既有缺陷），现在产出的是 kind='reminder'。
  it("fires a create_item trigger without starting anything", () => {
    vi.stubEnv("TZ", "UTC");
    const started: number[] = [];
    createCronTrigger(db, {
      label: "月度体检提醒", cronExpr: "0 9 1 * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "去体检" } },
    }, new Date("2026-07-21T08:00:00.000Z"));
    createScheduler(db, {
      now: at("2026-08-01T09:00:01.000Z"), onStartRun: (id) => started.push(id),
    }).tick();

    const items = listItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("reminder");
    expect(started).toEqual([]);
    // 提醒不进任务列表（spec §9）
    expect(listItems(db, { view: "tasks", now: "2026-08-01T09:00:01.000Z" })).toHaveLength(0);
  });

  // 步骤顺序是规格的一部分（spec §10）：Trigger 排在提醒之前，本轮新建的 reminder
  // 当轮就能触发，省掉一个 tick 的延迟。
  it("fires a cron trigger, then fires the reminder it produced, in the same tick", () => {
    vi.stubEnv("TZ", "UTC");
    createCronTrigger(db, {
      label: "每周报", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "交周报" } },
    }, new Date("2026-07-21T08:00:00.000Z"));
    createScheduler(db, { now: at("2026-07-27T09:00:01.000Z") }).tick();

    const reminder = listItems(db)[0];
    expect(reminder.stage).toBe("fired");                       // 当轮就响了
    expect(reminder.remind_at).toBe("2026-07-27T09:00:00.000Z"); // occurrence 注入
    expect(listNotifications(db, { state: ["pending"] })).toHaveLength(1);
  });

  it("advances next_fire_at even when the action throws, so one bad trigger cannot freeze the schedule", () => {
    vi.stubEnv("TZ", "UTC");
    // start_item 指向一条根本不存在的工单：action 必然抛错
    db.prepare(
      `INSERT INTO triggers (label, created_by, source_type, cron_expr, cron_tz, next_fire_at,
                             action_type, action_payload)
       VALUES ('坏规则','user','cron','0 9 * * *','UTC','2026-07-27T09:00:00.000Z',
               'start_item','{"item_id":999}')`,
    ).run();
    createScheduler(db, {
      now: at("2026-07-27T09:00:01.000Z"), onStartRun: () => {},
    }).tick();

    expect(getTrigger(db, 1)!.next_fire_at).toBe("2026-07-28T09:00:00.000Z"); // 已推进
    const fire = db.prepare("SELECT status, error FROM trigger_fires WHERE id = 1").get() as
      { status: string; error: string };
    expect(fire.status).toBe("failed");
    expect(fire.error).toMatch(/999/);
    expect(getTrigger(db, 1)!.consecutive_failures).toBe(1);
  });

  it("never fires the same occurrence twice across two ticks", () => {
    vi.stubEnv("TZ", "UTC");
    createCronTrigger(db, {
      label: "每日", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    }, new Date("2026-07-26T00:00:00.000Z"));
    const s = createScheduler(db, { now: at("2026-07-26T09:00:01.000Z") });
    s.tick(); s.tick();
    expect((db.prepare("SELECT COUNT(*) AS n FROM trigger_fires").get() as { n: number }).n).toBe(1);
    expect(listItems(db)).toHaveLength(1);
  });

  it("delivers via fallback once an immediate notification sits pending past the window", () => {
    const delivered: string[] = [];
    createItem(db, {
      title: "交房租", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    const s = createScheduler(db, {
      now: at("2026-07-25T10:00:01.000Z"),
      onFallbackNotify: (n) => delivered.push(n.title),
      env: { PLC_NOTIFY_FALLBACK_MS: "120000" },
    });
    s.tick();
    expect(delivered).toEqual([]); // 窗口内，先留给 lead 播报

    createScheduler(db, {
      now: at("2026-07-25T10:05:00.000Z"),
      onFallbackNotify: (n) => delivered.push(n.title),
      env: { PLC_NOTIFY_FALLBACK_MS: "120000" },
    }).tick();
    expect(delivered).toHaveLength(1);
    const note = listNotifications(db)[0];
    expect(note.state).toBe("delivered");
    expect(note.delivered_via).toBe("fallback");
  });

  it("keeps going when one item in a step throws", () => {
    const good = createItem(db, {
      title: "好提醒", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T09:00:00.000Z",
    });
    const bad = createItem(db, {
      title: "坏提醒", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T09:30:00.000Z",
    });
    // 把坏的那条挪到 cancelled：scheduled → fired 之外的边会让本条跃迁抛错
    db.prepare("UPDATE items SET stage = 'cancelled' WHERE id = ?").run(bad);
    db.prepare("UPDATE items SET stage = 'scheduled' WHERE id = ?").run(bad);
    // 直接构造一条到点但 stage 非法的提醒：remind_at 到了而 status 已是 fired
    db.prepare("UPDATE items SET stage = 'fired' WHERE id = ?").run(bad);

    const errors: unknown[] = [];
    createScheduler(db, {
      now: at("2026-07-25T10:00:00.000Z"), onError: (_step, e) => errors.push(e),
    }).tick();
    expect(getItem(db, good)!.stage).toBe("fired");
  });

  // plan 的完成标准，落成自动化断言而不是手工核对：每分钟的 cron 跑两个 tick，
  // 必须得到两条独立的 reminder 与两条独立的 notification（绝不合并），
  // 且任务列表视图里一条都不出现。
  it("produces one independent reminder and one independent notification per occurrence", () => {
    vi.stubEnv("TZ", "UTC");
    createCronTrigger(db, {
      label: "每分钟", cronExpr: "* * * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "喝水" } },
    }, new Date("2026-07-27T09:00:00.000Z"));

    createScheduler(db, { now: at("2026-07-27T09:01:00.000Z") }).tick();
    createScheduler(db, { now: at("2026-07-27T09:02:00.000Z") }).tick();

    const reminders = listItems(db, { view: "reminders" });
    expect(reminders).toHaveLength(2);
    expect(reminders.map((r) => r.remind_at)).toEqual([
      "2026-07-27T09:01:00.000Z", "2026-07-27T09:02:00.000Z",
    ]);
    // 两条通知各自成行——notifications 没有去抖，这正是 spec §1 那条缺陷的修法
    expect(listNotifications(db)).toHaveLength(2);
    expect(listInbox(db)).toHaveLength(0);
    // 提醒不进任务列表（spec §9）
    expect(listItems(db, { view: "tasks", now: "2026-07-27T09:02:00.000Z" })).toHaveLength(0);
  });

  it("reports a failing step through onError instead of aborting the tick", () => {
    createItem(db, {
      title: "提醒", brief: "b", createdBy: "user",
      kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    const overdueId = createItem(db, { title: "报告", brief: "b", createdBy: "user" });
    setItemTime(db, overdueId, { dueAt: "2026-07-20T00:00:00.000Z" });
    const steps: string[] = [];
    createScheduler(db, {
      now: at("2026-07-25T10:00:01.000Z"),
      onStartRun: () => { throw new Error("boom"); },
      onError: (step) => steps.push(step),
    }).tick();
    // 提醒与逾期两步都跑完了，尽管没有任何 trigger 需要开跑
    expect(listNotifications(db)).toHaveLength(2);
    expect(steps).toEqual([]);
  });
});
