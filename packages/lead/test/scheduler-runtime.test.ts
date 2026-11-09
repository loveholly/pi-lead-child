// 调度器的控制层和运行层（lead-scheduler spec D10）。pi 的 session.abort() 不带原因，还会等 pi 空闲：
//   · 原因先记下（状态机和 controller 的 signal.reason），再叫执行层停下；
//   · 执行层停不下来时，不无限期地等：过了宽限时间照样往下走，并写一条 abort.stuck。
import { describe, expect, it } from "vitest";
import {
  abortExecution, LaneChangeEvent, LeadSchedulerRuntime, LeadTaskController, type SchedulerEffect,
} from "../src/scheduler/index.js";

describe("LeadTaskController", () => {
  it("carries the abort reason on its signal and keeps the first one", () => {
    const controller = new LeadTaskController({ unitId: "unit_a", lane: 0, deadline: 10_000 });
    expect(controller.abortReason).toBeNull();
    controller.abort({ kind: "budget" });
    controller.abort({ kind: "user_stop" });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.abortReason).toEqual({ kind: "budget" });
    expect(controller.signal.reason).toEqual({ kind: "budget" });
  });

  it("fires lanechange when the lane changes", () => {
    const controller = new LeadTaskController({ unitId: "unit_a", lane: 3, deadline: null });
    const seen: Array<[number, number]> = [];
    controller.signal.addEventListener("lanechange", (event) => {
      const change = event as LaneChangeEvent;
      seen.push([change.previous, change.lane]);
    });
    controller.setLane(3);
    controller.setLane(1);
    expect(seen).toEqual([[3, 1]]);
    expect(controller.lane).toBe(1);
  });
});

describe("abortExecution", () => {
  it("returns settled when the execution stops", async () => {
    let clock = 0;
    const result = await abortExecution(() => { clock += 40; }, { graceMs: 1_000, now: () => clock });
    expect(result).toEqual({ settled: true, ms: 40 });
  });

  it("does not wait forever for an execution that does not stop", async () => {
    const result = await abortExecution(() => new Promise(() => {}), { graceMs: 30 });
    expect(result.settled).toBe(false);
    expect(result.ms).toBeGreaterThanOrEqual(25);
  });

  it("reports a stop that throws", async () => {
    const result = await abortExecution(() => { throw new Error("no session"); }, { graceMs: 30 });
    expect(result).toEqual(expect.objectContaining({ settled: true, error: "no session" }));
  });
});

describe("LeadSchedulerRuntime", () => {
  function runtime(stop: () => unknown) {
    const logs: string[] = [];
    const records: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const session: Array<Record<string, unknown>> = [];
    const executed: SchedulerEffect[] = [];
    const rt = new LeadSchedulerRuntime({
      log: (line) => logs.push(line), record: (kind, payload) => records.push({ kind, payload }),
      execute: (effect) => executed.push(effect), stopExecution: stop, abortGraceMs: 30,
      newUnitId: () => "unit_t",
    });
    rt.bindSessionRecorder((data) => session.push(data));
    return { rt, logs, records, session, executed };
  }

  it("records the reason before it asks the execution layer to stop, and logs how long the stop took", async () => {
    let reasonSeenByStop: unknown = null;
    const { rt, logs } = runtime(() => { reasonSeenByStop = rt.unit?.aborts.at(-1); });
    rt.openUnit({ source: "user", lane: 0, origin: null, turnId: "turn_1" });
    const controller = rt.controller!;
    rt.dispatch({ type: "stop.request", canAbort: true });
    expect(reasonSeenByStop).toEqual({ kind: "user_stop" });
    expect(controller.abortReason).toEqual({ kind: "user_stop" });
    await rt.aborting;
    expect(logs.find((line) => line.startsWith("[sched] abort.done"))).toMatch(/unit=unit_t seg=1 reason=user_stop settled=true ms=\d+/u);
  });

  it("goes on and logs abort.stuck when the execution layer does not stop in time", async () => {
    const { rt, logs } = runtime(() => new Promise(() => {}));
    rt.openUnit({ source: "user", lane: 0, origin: null, turnId: "turn_1" });
    rt.dispatch({ type: "drain.start" });
    rt.dispatch({ type: "drain.abort" });
    const result = await rt.aborting;
    expect(result?.settled).toBe(false);
    expect(logs.some((line) => line.startsWith("[sched] abort.stuck unit=unit_t seg=1 reason=drain settled=false"))).toBe(true);
  });

  it("aborts the hand-off segment with its own controller", async () => {
    let stops = 0;
    const { rt } = runtime(() => { stops += 1; });
    rt.openUnit({ source: "user", lane: 0, origin: null, turnId: "turn_1" });
    const first = rt.controller!;
    rt.dispatch({ type: "unit.begin" });
    rt.dispatch({ type: "stop.request", canAbort: true });
    expect(first.signal.aborted).toBe(true);
    rt.dispatch({ type: "stop.request", canAbort: true });
    // 同一段再中止一次：controller 不再触发，执行层照样再叫一次（和以前的 session.abort() 一样）。
    expect(stops).toBe(2);
    const second = rt.nextSegment()!;
    expect(second).not.toBe(first);
    expect(second.signal.aborted).toBe(false);
    expect(second.unitId).toBe(first.unitId);
  });

  it("writes unit records to the events table and the session file, and passes daemon effects to execute", () => {
    const { rt, records, session, executed } = runtime(() => {});
    rt.openUnit({ source: "system", lane: 2, origin: "system:blocker", turnId: null });
    rt.dispatch({ type: "unit.begin" });
    rt.dispatch({ type: "queue.check", facts: {
      limits: { yellowToolCalls: 10, yellowMs: 120_000, budgetMs: 150_000, writeGraceMs: 1, handoffMs: 1, queueNoticeMs: 0, userQueueNoticeMs: 0 },
      compacting: false, canAbort: true,
      waiting: () => [{ who: "Nina", conversation: "Nina 的私信", count: 1, waitedMs: 5, lane: 1 }],
    } });
    rt.closeUnit("answered");
    expect(records.map((record) => record.kind)).toEqual(["unit_started", "decided", "unit_ended"]);
    expect(session.map((entry) => entry.kind)).toEqual(["unit_started", "decided", "unit_ended"]);
    expect(executed.map((effect) => effect.type)).toEqual(["notice.queue"]);
    expect(rt.busy).toBe(false);
    expect(rt.controller).toBeNull();
  });

  it("describes the running unit and the waiting lanes", () => {
    let clock = 1_000;
    const rt = new LeadSchedulerRuntime({ log: () => {}, now: () => clock, newUnitId: () => "unit_s" });
    rt.openUnit({ source: "user", lane: 0, origin: null, turnId: "turn_9" });
    rt.dispatch({ type: "unit.begin" });
    rt.noteStage({ run: 1, step: 2, stage: "A", since: 1_000 });
    clock = 13_000;
    const snapshot = rt.snapshot({
      waiting: [{ who: "Nina", conversation: "Nina 的私信", count: 2, waitedMs: 130_000, lane: 1 }], host: "pool=ok", budgetMs: 150_000,
    });
    expect(snapshot.unit).toEqual(expect.objectContaining({
      id: "unit_s", lane: "L0", turnId: "turn_9", elapsedMs: 12_000, deadlineMs: 10_000,
      budget: expect.objectContaining({ usedMs: 12_000, budgetMs: 150_000 }),
      stage: { stage: "A", step: 2, sinceMs: 12_000 },
    }));
    expect(snapshot.lanes[1]).toEqual({
      lane: "L1", deadlineMs: 120_000,
      waiting: [{ who: "Nina", conversation: "Nina 的私信", count: 2, waitedMs: 130_000, overdue: true }],
    });
    expect(snapshot.host).toBe("pool=ok");
  });
});
