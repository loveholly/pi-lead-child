// 工单 15：崩溃循环额度。
// 决策边界是 crashLoopExceeded：一份工作在时间窗口里的恢复次数超过上限时，判为崩溃循环。
// 后半部分走孤儿回收（没有垫片的 Run，请求交回队列），覆盖完整的落库流程：
// 同一个请求被反复交回队列，超过额度后 Run 判为失败，请求不再回到队列，只升起一个 blocker。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { recoverOrphans } from "../src/server.js";
import {
  chargeRestartRecovery, crashLoopBudget, crashLoopExceeded, restartDispatchOf, type CrashLoopBudget,
} from "@pi-lead-child/engine";
import { repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";

const minute = 60_000;
const at = (offsetMs: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + offsetMs);

describe("crashLoopExceeded", () => {
  const budget: CrashLoopBudget = { limit: 5, windowMs: 5 * minute };
  const now = at(0);
  const recoveries = (count: number, spacingMs = 10_000) =>
    Array.from({ length: count }, (_, index) => at(-index * spacingMs));

  it("allows up to the limit of recoveries inside the window", () => {
    expect(crashLoopExceeded({ recoveries: recoveries(5), now, budget })).toBe(false);
  });

  it("stops the recovery that goes over the limit", () => {
    expect(crashLoopExceeded({ recoveries: recoveries(6), now, budget })).toBe(true);
  });

  it("does not count a recovery exactly one window ago, or older ones", () => {
    const old = [at(-5 * minute), at(-6 * minute), at(-60 * minute)];
    expect(crashLoopExceeded({ recoveries: [...recoveries(5), ...old], now, budget })).toBe(false);
    expect(crashLoopExceeded({ recoveries: [...recoveries(5), at(-5 * minute + 1)], now, budget })).toBe(true);
  });

  it("does not count recoveries recorded after now", () => {
    expect(crashLoopExceeded({ recoveries: [...recoveries(5), at(1)], now, budget })).toBe(false);
  });

  it("treats a limit of 0 as: never adopt or redispatch", () => {
    expect(crashLoopExceeded({ recoveries: [now], now, budget: { ...budget, limit: 0 } })).toBe(true);
  });
});

describe("crashLoopBudget", () => {
  it("defaults to 5 recoveries in 5 minutes", () => {
    expect(crashLoopBudget({})).toEqual({ limit: 5, windowMs: 5 * minute });
  });

  it("reads PLC_CRASH_LOOP_LIMIT and PLC_CRASH_LOOP_WINDOW_MS", () => {
    expect(crashLoopBudget({ PLC_CRASH_LOOP_LIMIT: "2", PLC_CRASH_LOOP_WINDOW_MS: "60000" }))
      .toEqual({ limit: 2, windowMs: 60_000 });
    expect(crashLoopBudget({ PLC_CRASH_LOOP_LIMIT: "0" }).limit).toBe(0);
  });

  it("falls back to the defaults for values that are not valid, and caps the limit", () => {
    expect(crashLoopBudget({ PLC_CRASH_LOOP_LIMIT: "-1", PLC_CRASH_LOOP_WINDOW_MS: "soon" }))
      .toEqual({ limit: 5, windowMs: 5 * minute });
    expect(crashLoopBudget({ PLC_CRASH_LOOP_LIMIT: "2.5", PLC_CRASH_LOOP_WINDOW_MS: "0" }))
      .toEqual({ limit: 5, windowMs: 5 * minute });
    expect(crashLoopBudget({ PLC_CRASH_LOOP_LIMIT: "100000" }).limit).toBe(100);
  });
});

describe("the startup repair of runs without a shim", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = tempDir("plc-crash-loop-");
    db = openDb(join(dir, "plc.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 模拟一次派发：claim 请求、开始 Run。pid 指向一个不存在的进程，所以回收不会碰到任何真实进程。
  function claimAndStart(itemId: number): number {
    const dispatcher = createDispatcher(db);
    const claim = dispatcher.claimNext();
    if (!claim || claim.itemId !== itemId) throw new Error("expected a claim");
    dispatcher.markStarted(claim);
    updateRun(db, claim.runId, { state: "running", pid: 999_999_999 });
    if (getItem(db, itemId)!.stage !== "active") transition(db, { itemId, to: "active", actor: "system", reason: "test run" });
    return claim.runId;
  }

  function blockers(itemId: number): number {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'",
    ).get(itemId) as { n: number }).n;
  }

  it("stops returning the same request to the queue after the budget, with exactly one blocker", () => {
    const budget: CrashLoopBudget = { limit: 2, windowMs: 5 * minute };
    const itemId = createItem(db, { title: "loop", brief: "b", createdBy: "user" });
    const requestId = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "loop:1",
    });

    // 前两次重启：请求交回队列（原来的行为），每次派出一个新的 Run。
    for (const offset of [0, 10_000]) {
      const runId = claimAndStart(itemId);
      recoverOrphans(db, { budget, now: at(offset) });
      expect(getRun(db, runId)).toMatchObject({ state: "failed", failure_code: "run_interrupted" });
      expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    }
    const blockersBefore = blockers(itemId);

    // 第三次重启超过额度：Run 判为宿主作用域的失败，请求不再回到队列，只多一个 blocker。
    const runId = claimAndStart(itemId);
    recoverOrphans(db, { budget, now: at(20_000) });
    expect(getRun(db, runId)).toMatchObject({
      state: "failed", failure_scope: "host", failure_code: "restart_crash_loop",
    });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "failed" });
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockers(itemId)).toBe(blockersBefore + 1);
    // 宿主缺陷先交给 Lead（2026-10-15 起）：用户不收通知，Lead 处理不了时才升级。
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE item_id=? AND kind='restart_crash_loop'",
    ).get(itemId)).toEqual({ n: 0 });
    // 宿主的问题不扣工单的重试额度。
    expect(executorRetryBudget(db, itemId).failures).toBe(0);

    // 启动修复幂等：再跑一遍回收和 blocker 补发，不会再升起 blocker。
    recoverOrphans(db, { budget, now: at(30_000) });
    repairMissingBlockerAlerts(db, at(30_000));
    expect(blockers(itemId)).toBe(blockersBefore + 1);
  });

  // 接管失败后，同一次启动改走孤儿回收。这一次重启只扣一次额度。
  it("charges one restart once, even when the adoption falls back to the orphan reclaim", () => {
    const budget: CrashLoopBudget = { limit: 1, windowMs: 5 * minute };
    const itemId = createItem(db, { title: "fallback", brief: "b", createdBy: "user" });
    createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "fallback:1",
    });
    const runId = claimAndStart(itemId);
    const run = getRun(db, runId)!;
    db.transaction(() => {
      expect(chargeRestartRecovery(db, {
        run, dispatch: restartDispatchOf(db, runId), action: "adopt", budget, now: at(0),
      })).toBe(true);
    }).immediate();
    recoverOrphans(db, { budget, now: at(0) });
    expect(getRun(db, runId)).toMatchObject({ state: "failed", failure_code: "run_interrupted" });
  });

  it("does not count recoveries that happened before the window", () => {
    const budget: CrashLoopBudget = { limit: 1, windowMs: 5 * minute };
    const itemId = createItem(db, { title: "slow", brief: "b", createdBy: "user" });
    const requestId = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "slow:1",
    });
    for (const offset of [0, 10 * minute, 20 * minute]) {
      claimAndStart(itemId);
      recoverOrphans(db, { budget, now: at(offset) });
      expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    }
  });
});
