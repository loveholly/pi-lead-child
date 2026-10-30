import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren } from "../src/children/manager.js";
import { createWatchdog } from "../src/pipeline/watchdog.js";
import { createRun, pauseRun, updateRun } from "@pi-lead-child/store";
import { executorRetryBudget, getItem } from "@pi-lead-child/store";
import { insertCheckpoint } from "@pi-lead-child/store";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" }); // → ready
  transition(db, { itemId, to: "active", actor: "system", reason: "" });
  // 伪造存活 child 与陈旧活动时间。Run 必须真存在且在跑：item 停在 active 不再等于有进程
  // 在跑（暂停时 Run 转 paused、item 不动），watchdog 因此要求一个非暂停的活跃 Run。
  const runId = createRun(db, { itemId, role: "executor" });
  updateRun(db, runId, { state: "running" });
  liveChildren().set(itemId, { rpc: {} as any, proc: {} as any, runId, streaming: true });
  db.prepare("UPDATE items SET last_activity_at = datetime('now', '-20 minutes') WHERE id = ?").run(itemId);
});
afterEach(() => { liveChildren().clear(); });

describe("watchdog stall detection", () => {
  it("first strike → attention, second consecutive → blocker", () => {
    const wd = createWatchdog(db, { stallMs: 15 * 60_000 });
    wd.check();
    expect(listInbox(db, { severity: "attention" }).some((r) => r.summary.includes("疑似卡死"))).toBe(true);
    wd.check();
    expect(listInbox(db, { severity: "blocker" }).some((r) => r.summary.includes("疑似卡死"))).toBe(true);
  });

  it("recovered activity resets strikes; no live child → silent", () => {
    const wd = createWatchdog(db, { stallMs: 15 * 60_000 });
    wd.check();
    db.prepare("UPDATE items SET last_activity_at = datetime('now') WHERE id = ?").run(itemId);
    wd.check(); // 恢复，清零
    db.prepare("UPDATE items SET last_activity_at = datetime('now', '-20 minutes') WHERE id = ?").run(itemId);
    liveChildren().clear(); // 无存活 child
    wd.check();
    expect(listInbox(db, { severity: "blocker" }).length).toBe(0);
  });
});

// 暂停是用户主动行为，不是停滞（spec §5.2）。这两条用例必须成对出现：只留 paused 那条，
// 它会因为"查询根本没匹配到任何行"而假绿——running 那条正是用来证明查询确实会命中。
describe("watchdog and paused runs", () => {
  function stalledItem(): { store: Db; runId: number } {
    const store = openDb(join(tempDir("plc-wd-"), "plc.db"));
    const id = createItem(store, { title: "t", brief: "b", createdBy: "system" }); // → ready
    transition(store, { itemId: id, to: "active", actor: "system", reason: "start" });
    store.prepare("UPDATE items SET last_activity_at=? WHERE id=?")
      .run("2026-07-27T00:00:00.000Z", id);
    const runId = createRun(store, { itemId: id, role: "executor" });
    updateRun(store, runId, { state: "running" });
    // checkStalls 只看有存活 child 的工单；不注册的话两条用例都会静默通过。
    liveChildren().clear();
    liveChildren().set(id, { rpc: {} as any, proc: {} as any, runId, streaming: true });
    return { store, runId };
  }

  const runWatchdog = (store: Db): void => {
    createWatchdog(store, {
      stallMs: 1000,
      now: () => new Date("2026-07-27T01:00:00.000Z"),
    }).check();
  };

  it("raises a stall while the run is still running", () => {
    const { store } = stalledItem();
    runWatchdog(store);
    expect(listInbox(store).map((r) => r.severity)).toEqual(["attention"]);
  });

  it("does not raise a stall for an item whose only run is paused", () => {
    const { store, runId } = stalledItem();
    pauseRun(store, runId);
    runWatchdog(store);
    expect(listInbox(store)).toEqual([]);
  });
});

describe("checkpoint silence watchdog", () => {
  it("persists reminder cooldown across instances and never fabricates agent checkpoints", () => {
    liveChildren().clear();
    const activeItemId = createItem(db, { title: "active", brief: "b", createdBy: "lead" });
    transition(db, { itemId: activeItemId, to: "active", actor: "system", reason: "start" });
    const activeRunId = createRun(db, { itemId: activeItemId });
    updateRun(db, activeRunId, { state: "running" });
    db.prepare("UPDATE runs SET started_at=? WHERE id=?")
      .run("2026-07-24T08:00:00.000Z", activeRunId);
    for (let seq = 1; seq <= 8; seq++) {
      const occurredAt = `2026-07-24T08:${String(seq).padStart(2, "0")}:00.000Z`;
      db.prepare(
        `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
         VALUES (?, ?, 'tool.completed', '{}', ?)`,
      ).run(activeRunId, seq, occurredAt);
    }
    const reminders: string[] = [];
    liveChildren().set(activeItemId, {
      runId: activeRunId,
      streaming: true,
      handle: {
        pid: null,
        events: (async function* () {})(),
        steer: async (message: string) => { reminders.push(message); },
        interrupt: async () => {},
        wait: async () => ({
          ok: true, exitCode: 0, signal: null, externalSessionId: null,
          errorCode: null, errorMessage: null,
        }),
      },
    });
    const config = {
      dedupeWindowMs: 60_000,
      progressMinIntervalMs: 120_000,
      silenceMs: 15 * 60_000,
      silenceToolEvents: 8,
      silenceDomainEvents: 3,
      reminderCooldownMs: 15 * 60_000,
    };

    createWatchdog(db, {
      checkpointPolicy: config,
      now: () => new Date("2026-07-24T08:16:00.000Z"),
    }).check();
    createWatchdog(db, {
      checkpointPolicy: config,
      now: () => new Date("2026-07-24T08:17:00.000Z"),
    }).check();

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("submit_checkpoint");
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE json_extract(payload, '$.kind')='checkpoint_reminder'",
    ).get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n).toBe(0);

    insertCheckpoint(db, {
      itemId: activeItemId,
      runId: activeRunId,
      source: "agent_reported",
      kind: "milestone",
      title: "Phase complete",
      summary: "The semantic phase conclusion is now recorded.",
    }, { now: new Date("2026-07-24T08:18:00.000Z") });
    createWatchdog(db, {
      checkpointPolicy: config,
      now: () => new Date("2026-07-24T08:40:00.000Z"),
    }).check();
    expect(reminders).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n).toBe(1);
  });

  it("uses persisted domain and child counters without waiting for the silence timer", () => {
    liveChildren().clear();
    const parentId = createItem(db, { title: "parent", brief: "b", createdBy: "lead" });
    transition(db, { itemId: parentId, to: "active", actor: "system", reason: "start" });
    const parentRunId = createRun(db, { itemId: parentId });
    updateRun(db, parentRunId, { state: "running" });
    db.prepare("UPDATE runs SET started_at=? WHERE id=?")
      .run("2026-07-24T09:00:00.000Z", parentRunId);
    db.prepare(
      `INSERT INTO activities (item_id, run_id, actor, kind, payload, created_at)
       VALUES (?, ?, 'child', 'transition', '{}', ?)`,
    ).run(parentId, parentRunId, "2026-07-24T09:01:00.000Z");
    const childId = createItem(db, {
      title: "child", brief: "b", createdBy: "child", parentItemId: parentId,
      rootItemId: parentId, createdByRunId: parentRunId,
    });
    db.prepare("UPDATE items SET created_at=? WHERE id=?")
      .run("2026-07-24T09:02:00.000Z", childId);
    const reminders: string[] = [];
    liveChildren().set(parentId, {
      runId: parentRunId,
      streaming: true,
      handle: {
        pid: null,
        events: (async function* () {})(),
        steer: async (message: string) => { reminders.push(message); },
        interrupt: async () => {},
        wait: async () => ({
          ok: true, exitCode: 0, signal: null, externalSessionId: null,
          errorCode: null, errorMessage: null,
        }),
      },
    });

    createWatchdog(db, {
      checkpointPolicy: {
        dedupeWindowMs: 60_000,
        progressMinIntervalMs: 120_000,
        silenceMs: 900_000,
        silenceToolEvents: 8,
        silenceDomainEvents: 2,
        reminderCooldownMs: 900_000,
      },
      now: () => new Date("2026-07-24T09:03:00.000Z"),
    }).check();
    expect(reminders).toHaveLength(1);
  });
});

// 2026-10-29：Run #185 停在 starting、一条事件都没有，12 分钟没人处理（Lead 手动停掉重跑才好）。
// 以前看门狗只在 15 分钟后发一条「疑似卡死」。启动看门狗：Run 在 starting、没有任何事件、超过阈值时，
// 停掉它的 child，按可续跑的中断记下（run_interrupted，不扣重试额度），自动重排一次；同一张工单连续两次时交给 Lead。
describe("a run stuck at start", () => {
  const AT = new Date("2026-10-29T10:20:00.000Z");

  function startingRun(options: { purpose?: "execution" | "conversation"; minutesAgo?: number; previousStalled?: boolean } = {}) {
    const id = createItem(db, { title: "卡在启动", brief: "b", createdBy: "lead" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "start" });
    // 上一个同类 Run 也是启动卡住的。
    if (options.previousStalled) {
      const previous = createRun(db, { itemId: id, role: "executor", runtime: "codex", model: "gpt-5.5" });
      updateRun(db, previous, { state: "failed", endedAt: true, errorCode: "start_stalled" });
    }
    const runId = createRun(db, { itemId: id, role: "executor", runtime: "codex", model: "gpt-5.5", purpose: options.purpose });
    db.prepare("UPDATE runs SET started_at=? WHERE id=?")
      .run(new Date(AT.getTime() - (options.minutesAgo ?? 12) * 60_000).toISOString(), runId);
    const interrupted: string[] = [];
    liveChildren().set(id, {
      runId, streaming: false,
      handle: {
        pid: null,
        events: (async function* () {})(),
        interrupt: async (reason: string) => { interrupted.push(reason); },
        wait: async () => ({ ok: false, exitCode: null, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
      },
    });
    return { id, runId, interrupted };
  }
  const check = () => createWatchdog(db, { startStallMs: 5 * 60_000, now: () => AT }).check();
  const requestsOf = (id: number) => db.prepare(
    "SELECT role, purpose, runtime, model, trigger, state, retry_of_run_id AS retryOf FROM dispatch_requests WHERE item_id=?",
  ).all(id);

  it("stops the child, records a resumable interruption, and dispatches the run again once", () => {
    const { id, runId, interrupted } = startingRun();
    check();
    expect(db.prepare("SELECT state, error_code, failure_scope, failure_retry, failure_code FROM runs WHERE id=?").get(runId))
      .toEqual({
        state: "failed", error_code: "start_stalled", failure_scope: "attempt", failure_retry: "resume", failure_code: "run_interrupted",
      });
    expect(interrupted).toHaveLength(1);
    expect(liveChildren().has(id)).toBe(false);
    expect(requestsOf(id)).toEqual([{
      role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5", trigger: "start-stall-retry", state: "pending",
      retryOf: runId,
    }]);
    // 第一次不打扰 Lead，也不扣工单的重试额度。
    expect(listInbox(db).filter((row) => row.item_id === id)).toEqual([]);
    expect(executorRetryBudget(db, id).failures).toBe(0);
    expect(getItem(db, id)!.stage).toBe("active");
  });

  // Run 建好以后、runtime 起来以前要准备工作区（装依赖、核查前记指纹）。#185 克隆 node_modules 用了 19 分钟，在第 12 分钟
  // 被当成卡死停掉。这时 child 还没挂上 live 表，只在超过准备的上限（这里 45 分钟）时才算挂死。
  it("leaves a run that is still being prepared alone until the preparation limit", () => {
    const preparing = startingRun({ minutesAgo: 19 });
    liveChildren().delete(preparing.id);
    check();
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(preparing.runId)).toEqual({ state: "starting" });
    const hung = startingRun({ minutesAgo: 46 });
    liveChildren().delete(hung.id);
    check();
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(hung.runId)).toMatchObject({ state: "failed" });
  });

  it("leaves a run alone before the threshold, and a run that already reported an event", () => {
    const early = startingRun({ minutesAgo: 4 });
    const talking = startingRun();
    db.prepare("INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, 1, 'runtime.stderr', '{}', ?)")
      .run(talking.runId, AT.toISOString());
    check();
    for (const { runId } of [early, talking]) {
      expect(db.prepare("SELECT state FROM runs WHERE id=?").get(runId)).toEqual({ state: "starting" });
    }
    expect([...early.interrupted, ...talking.interrupted]).toEqual([]);
  });

  it("hands the ticket to Lead instead of dispatching a third time after two stalls in a row", () => {
    const { id, runId } = startingRun({ previousStalled: true });
    check();
    expect(requestsOf(id)).toEqual([]);
    const blockers = listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === id)
      .map((row) => JSON.parse(row.payload) as { needsUser: boolean; runId: number; leadNextStep?: string });
    expect(blockers).toEqual([expect.objectContaining({ needsUser: false, runId })]);
    expect(blockers[0]!.leadNextStep).toContain("recover_ticket_run");
    expect(getItem(db, id)!.stage).toBe("blocked");
  });

  it("does not dispatch a stuck ticket chat again, and tells Lead so it can resend the message", () => {
    const { id, runId } = startingRun({ purpose: "conversation" });
    check();
    expect(db.prepare("SELECT state, failure_code FROM runs WHERE id=?").get(runId)).toEqual({ state: "failed", failure_code: "run_interrupted" });
    expect(requestsOf(id)).toEqual([]);
    const notes = listInbox(db).filter((row) => row.item_id === id).map((row) => JSON.parse(row.payload) as {
      kind?: string; wakeLead?: boolean; leadNextStep?: string;
    });
    expect(notes).toEqual([expect.objectContaining({ kind: "conversation_run_failed", wakeLead: true })]);
    expect(notes[0]!.leadNextStep).toContain("recover_ticket_run");
    expect(getItem(db, id)!.stage).toBe("active");
  });
});
