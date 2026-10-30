import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import {
  createOnceTrigger, createCronTrigger, getTrigger, dueTriggers, advanceTrigger,
  recordTriggerFailure, clearTriggerFailures, setTriggerEnabled,
  claimTriggerOccurrence, completeTriggerFire, nextRun, listTriggers,
} from "../src/triggers.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

function insertTrigger(cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO triggers (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => cols[k]));
}

describe("triggers table", () => {
  it("requires fire_at for a once source", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "user", source_type: "once",
      action_type: "create_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("requires cron_expr for a cron source", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "user", source_type: "cron",
      action_type: "create_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("requires webhook_path for a webhook source", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "user", source_type: "webhook",
      action_type: "create_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  // spec §5.3 (C5)：自动开跑的能力只有 user 建的 trigger 才有
  it("refuses create_and_start on a non-user trigger", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "lead", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_and_start", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("refuses start_item on a non-user trigger", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "system", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "start_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("allows create_and_start on a user trigger", () => {
    insertTrigger({
      label: "x", created_by: "user", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_and_start", action_payload: "{}",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n).toBe(1);
  });

  it("dedups fires by (trigger_id, dedup_key)", () => {
    insertTrigger({
      label: "x", created_by: "user", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_item", action_payload: "{}",
    });
    const fire = () => db.prepare(
      `INSERT INTO trigger_fires (trigger_id, dedup_key, occurrence_at)
       VALUES (1, '2026-08-03T01:00:00.000Z', '2026-08-03T01:00:00.000Z')`,
    ).run();
    fire();
    expect(fire).toThrow(/UNIQUE constraint failed/);
  });
});

describe("notifications table", () => {
  it("accepts an item-less notification", () => {
    db.prepare(
      "INSERT INTO notifications (kind, urgency, title) VALUES ('crash','immediate','boom')",
    ).run();
    const row = db.prepare("SELECT item_id, state FROM notifications WHERE id=1").get() as
      { item_id: number | null; state: string };
    expect(row.item_id).toBeNull();
    expect(row.state).toBe("pending");
  });

  it("rejects an urgency outside the enum", () => {
    expect(() => db.prepare(
      "INSERT INTO notifications (kind, urgency, title) VALUES ('crash','whenever','boom')",
    ).run()).toThrow(/CHECK constraint failed/);
  });
});

describe("inbox dedup_scope", () => {
  it("accepts an item-less inbox row carrying its own scope", () => {
    db.prepare(
      `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary)
       VALUES (NULL, 'sys:watchdog', 'attention', 'structural', 's')`,
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n).toBe(1);
  });

  it("refuses a scope that disagrees with the item it hangs on", () => {
    db.prepare(
      "INSERT INTO items (title, brief, created_by, stage) VALUES ('t','b','user','draft')",
    ).run();
    expect(() => db.prepare(
      `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary)
       VALUES (1, 'sys:elsewhere', 'attention', 'structural', 's')`,
    ).run()).toThrow(/CHECK constraint failed/);
  });
});

describe("trigger DAO", () => {
  it("computes next_fire_at on create for a cron trigger", () => {
    const id = createCronTrigger(db, {
      label: "weekly", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "周报" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const t = getTrigger(db, id)!;
    // 2026-07-27 本身就是周一，从当天 00:00 起算的下一次是当天 09:00，不是下周一。
    expect(t.next_fire_at).toBe("2026-07-27T09:00:00.000Z");
    expect(t.cron_tz).toBe("UTC");
    expect(JSON.parse(t.action_payload).title).toBe("周报");
  });

  it("computes next_fire_at as fire_at for a once trigger", () => {
    const id = createOnceTrigger(db, {
      label: "one", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "会议" } },
    });
    expect(getTrigger(db, id)!.next_fire_at).toBe("2026-08-01T10:00:00.000Z");
  });

  it("advances a cron trigger relative to now, skipping missed occurrences", () => {
    const id = createCronTrigger(db, {
      label: "daily", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    // 停机三天后才醒来：只排下一次，不补跑错过的三次
    advanceTrigger(db, id, new Date("2026-07-30T12:00:00.000Z"));
    expect(getTrigger(db, id)!.next_fire_at).toBe("2026-07-31T09:00:00.000Z");
  });

  it("disables a once trigger after it advances", () => {
    const id = createOnceTrigger(db, {
      label: "one", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    });
    advanceTrigger(db, id, new Date("2026-08-01T10:00:01.000Z"));
    const t = getTrigger(db, id)!;
    expect(t.enabled).toBe(0);
    expect(t.next_fire_at).toBeNull();
  });

  it("lists only due, enabled triggers", () => {
    const soon = createOnceTrigger(db, {
      label: "soon", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    });
    createOnceTrigger(db, {
      label: "later", fireAt: "2026-09-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "y" } },
    });
    const off = createOnceTrigger(db, {
      label: "off", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "z" } },
    });
    setTriggerEnabled(db, off, false);
    expect(dueTriggers(db, new Date("2026-08-02T00:00:00.000Z")).map((t) => t.id)).toEqual([soon]);
  });

  it("records a one-shot trigger failure instead of silently dropping it", () => {
    const id = createOnceTrigger(db, {
      label: "one-shot failure", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "task", title: "x", brief: "b" } },
    });
    advanceTrigger(db, id, new Date("2026-08-01T10:00:01.000Z"));
    expect(recordTriggerFailure(db, id, "action failed")).toBe(true);
    // 2026-10-15 起先交给 Lead：一条持久的说明叫醒 Lead，Lead 能补做就补做；处理不了时 daemon 升级给用户。
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    const row = db.prepare("SELECT severity, summary, payload FROM inbox WHERE dedup_scope=?").get(`trigger-failed:${id}`) as {
      severity: string; summary: string; payload: string;
    };
    expect(row).toMatchObject({ severity: "attention", summary: "一次性规则「one-shot failure」执行失败：action failed" });
    expect(JSON.parse(row.payload)).toMatchObject({ kind: "trigger_failed", wakeLead: true, needsUser: false });
  });

  it("auto-disables after PLC_TRIGGER_MAX_FAILURES consecutive failures", () => {
    const id = createCronTrigger(db, {
      label: "bad", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "task", title: "x", brief: "b" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    for (let i = 0; i < 5; i++) recordTriggerFailure(db, id, "boom");
    expect(getTrigger(db, id)!.enabled).toBe(0);
  });

  it("resets the failure streak on success", () => {
    const id = createCronTrigger(db, {
      label: "flaky", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "task", title: "x", brief: "b" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    for (let i = 0; i < 4; i++) recordTriggerFailure(db, id, "boom");
    clearTriggerFailures(db, id);
    for (let i = 0; i < 4; i++) recordTriggerFailure(db, id, "boom");
    expect(getTrigger(db, id)!.enabled).toBe(1); // 连续 4 次不足以熔断
  });

  // spec §10：占坑与推进必须同一事务，且排在 action 之前。否则 action 抛错时
  // next_fire_at 永远停在过去，每 tick 重试同一条，整条 schedule 冻结。
  it("claims an occurrence and advances next_fire_at in one step", () => {
    const id = createCronTrigger(db, {
      label: "daily", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const fireId = claimTriggerOccurrence(
      db, getTrigger(db, id)!, "2026-07-28T09:00:00.000Z", new Date("2026-07-28T09:00:01.000Z"));
    expect(fireId).not.toBeNull();
    expect(getTrigger(db, id)!.next_fire_at).toBe("2026-07-29T09:00:00.000Z");
    expect(getTrigger(db, id)!.fire_count).toBe(1);
  });

  it("refuses to claim the same occurrence twice", () => {
    const id = createCronTrigger(db, {
      label: "daily", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const t = getTrigger(db, id)!;
    claimTriggerOccurrence(db, t, "2026-07-28T09:00:00.000Z", new Date("2026-07-28T09:00:01.000Z"));
    expect(claimTriggerOccurrence(
      db, t, "2026-07-28T09:00:00.000Z", new Date("2026-07-28T09:00:02.000Z"))).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM trigger_fires").get() as { n: number }).n).toBe(1);
  });

  it("records the outcome of a fire", () => {
    const id = createOnceTrigger(db, {
      label: "one", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    });
    const fireId = claimTriggerOccurrence(
      db, getTrigger(db, id)!, "2026-08-01T10:00:00.000Z", new Date("2026-08-01T10:00:01.000Z"))!;
    completeTriggerFire(db, fireId, { status: "failed", error: "boom" });
    const row = db.prepare("SELECT status, error FROM trigger_fires WHERE id = ?").get(fireId) as
      { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
  });
});

// 原 test/schedules.test.ts 的 cron 用例。schedules 已被 triggers 吸收（spec §5.6），
// 但 cron 语义必须逐字不变（spec §10），所以这些断言原样搬过来。
describe("nextRun (cron)", () => {
  it("computes next Monday 9am UTC", () => {
    // 显式传 tz="UTC"：不依赖跑测试机器的本机时区
    expect(nextRun("0 9 * * 1", new Date("2026-07-21T00:00:00Z"), "UTC"))
      .toBe("2026-07-27T09:00:00.000Z");
  });
  it("rejects invalid cron", () => {
    expect(() => nextRun("nonsense", new Date("2026-07-21T00:00:00Z"))).toThrow();
  });
  it("nextRun 按指定时区解析：上海周一 09:00 = UTC 01:00", () => {
    const from = new Date("2026-07-22T00:00:00Z"); // 周三
    expect(nextRun("0 9 * * 1", from, "Asia/Shanghai")).toBe("2026-07-27T01:00:00.000Z");
  });
  it("nextRun 缺省用本机时区（与显式传本机时区结果一致）", () => {
    const from = new Date("2026-07-22T00:00:00Z");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(nextRun("0 9 * * 1", from)).toBe(nextRun("0 9 * * 1", from, tz));
  });
});

describe("cron trigger lifecycle (was: schedules DAO)", () => {
  // createCronTrigger/advanceTrigger 吃 nextRun 缺省本机时区时结果会随机器漂移，
  // 这里锁 TZ=UTC，断言的是 UTC 语义的 next_fire_at。
  beforeEach(() => vi.stubEnv("TZ", "UTC"));
  afterEach(() => vi.unstubAllEnvs());

  it("creates with a computed next_fire_at, lists, advances", () => {
    const now = new Date("2026-07-21T08:00:00Z");
    const id = createCronTrigger(db, {
      label: "每周汇总", cronExpr: "0 9 * * 1", createdBy: "user",
      action: {
        type: "create_and_start",
        payload: { kind: "task", title: "每周汇总", brief: "汇总本周工单", initial_stage: "ready" },
      },
    }, now);
    const t = listTriggers(db)[0];
    expect(t.id).toBe(id);
    expect(t.action_type).toBe("create_and_start"); // 原 spawn=1
    expect(t.next_fire_at).toBe("2026-07-27T09:00:00.000Z");
    expect(dueTriggers(db, now).length).toBe(0);                                  // 未到点
    expect(dueTriggers(db, new Date("2026-07-27T09:00:01Z")).length).toBe(1);     // 到点
    advanceTrigger(db, id, new Date("2026-07-27T09:00:01Z"));
    expect(listTriggers(db)[0].next_fire_at).toBe("2026-08-03T09:00:00.000Z");    // 下周一
  });
});
