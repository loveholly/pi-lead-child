// 回放：2026-11-24 夜里的挂起风暴。主人合上了笔记本，Mac 睡 8–17 分钟、醒几秒（DarkWake）、再睡。
//   · 每次醒来，就地预算按墙钟算：一个 0 次工具调用的单元「就地做了 8 分多钟」，一醒就被红线停下；
//   · 交接窗口（30 秒）在下一次睡眠里过去，单元挂起；
//   · 挂起的单元叫醒 Lead 开一轮，这一轮又在睡眠里过了预算、又挂起成一个新单元……一夜滚成约 50 个；
//   · 这些单元都记成「答上了」，模型熔断一次都没数到，用户也没收到任何通知；
//   · 空闲车道的压缩也在睡眠里超时，上下文涨到窗口的 111%，开一轮以前没人看一眼。
// 时间线按日志照搬（unit_mwul935s09o：19:05:26 开始，19:05:51 睡 488 秒，19:13:59 醒来就被停下）。人和原文换成编造的。
import { tempDir } from "@pi-lead-child/core/testing";
import { describe, expect, it } from "vitest";
import {
  ClockGapDetector, compactionBeforeTurn, EMPTY_RED_LINE_FAILURE, emptyRedLineUnit, initialSchedulerState, LeadHandoffs,
  ModelHold, modelHoldAfterUnit, redLinePhase, schedulerStep, unitLane,
  type BudgetFacts, type SchedulerEffect, type SchedulerEvent, type SchedulerLimits, type SchedulerState,
} from "../src/index.js";
import { classifyLeadModelError } from "@pi-lead-child/protocol";

const LIMITS: SchedulerLimits = {
  yellowToolCalls: 10, yellowMs: 120_000, budgetMs: 150_000, handoffMs: 30_000,
  queueNoticeMs: 300_000, userQueueNoticeMs: 60_000,
};
const facts = (): BudgetFacts => ({ limits: LIMITS, compacting: false, canAbort: true, waiting: () => [] });
const POLL_MS = 3_000;

// 调度器加上 daemon 的轮询：每一拍先报时钟（ClockGapDetector），再做预算检查。sleep(ms) 期间进程不跑，一拍都没有。
function overnight(start = 1_000_000) {
  let state: SchedulerState = initialSchedulerState();
  let now = start;
  const effects: SchedulerEffect[] = [];
  const clock = new ClockGapDetector({ expectedMs: POLL_MS });
  clock.observe(now);
  const send = (event: SchedulerEvent) => {
    const step = schedulerStep(state, event, now);
    state = step.state;
    effects.push(...step.effects);
    return step.effects;
  };
  const tick = () => {
    const gapMs = clock.observe(now);
    if (gapMs > 0) send({ type: "clock.gap", gapMs });
    send({ type: "budget.check", facts: facts() });
  };
  return {
    send,
    get state() { return state; },
    effects,
    awake(ms: number) { for (let left = ms; left > 0; left -= POLL_MS) { now += Math.min(POLL_MS, left); tick(); } },
    sleep(ms: number) { now += ms; },
    // 醒来时定时器先到点（交接窗口的定时器在醒来那一刻到点），daemon 先报时钟再交给调度器。
    timerFires(event: SchedulerEvent) {
      const gapMs = clock.observe(now);
      if (gapMs > 0) send({ type: "clock.gap", gapMs });
      return send(event);
    },
    of<T extends SchedulerEffect["type"]>(type: T) { return effects.filter((effect) => effect.type === type) as Array<Extract<SchedulerEffect, { type: T }>>; },
  };
}

function openBlockerUnit(m: ReturnType<typeof overnight>, id = "unit_night") {
  m.send({ type: "unit.open", id, lane: unitLane({ source: "system", system: "system:blocker" }), source: "system", origin: "system:blocker", turnId: null });
  m.send({ type: "unit.begin" });
}

describe("the clock gap detector", () => {
  it("reports only the time the process did not run, and ignores normal jitter and clocks that go back", () => {
    const clock = new ClockGapDetector({ expectedMs: 3_000, thresholdMs: 30_000 });
    expect(clock.observe(0)).toBe(0);
    expect(clock.observe(3_000)).toBe(0);
    expect(clock.observe(28_000)).toBe(0);
    // 睡了 488 秒：上一拍以后醒着的最多一拍。
    expect(clock.observe(28_000 + 491_000)).toBe(488_000);
    expect(clock.observe(28_000 + 491_000 - 60_000)).toBe(0);
    expect(clock.observe(28_000 + 491_000 + 3_000)).toBe(0);
  });
});

describe("2026-11-24 night: the in-place budget counts only awake time", () => {
  it("does not stop a unit that the machine slept through (old behavior: red line at 513 s with 0 tool calls)", () => {
    const m = overnight();
    openBlockerUnit(m);
    m.awake(25_000);
    m.sleep(488_000);
    m.awake(10_000);
    // 以前：elapsedMs=513488 decision=red_line_stop。现在：醒着才 35 秒，不停。
    expect(m.of("abort")).toEqual([]);
    expect(redLinePhase(m.state)).toBeNull();
    expect(m.state.unit?.pausedMs).toBe(488_000);
    expect(m.of("record").some((effect) => effect.payload.decision === "clock_gap")).toBe(true);
  });

  it("still stops a unit at the budget of awake time", () => {
    const m = overnight();
    openBlockerUnit(m);
    m.awake(60_000);
    m.sleep(600_000);
    m.awake(87_000);
    expect(m.of("abort")).toEqual([]);
    m.awake(9_000);
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "budget" } }]);
  });

  it("moves the hand-off window past a sleep: the timer that fires on wake re-arms instead of suspending the unit", () => {
    const m = overnight();
    openBlockerUnit(m);
    m.awake(150_000);
    expect(m.of("abort")).toHaveLength(1);
    m.send({ type: "prompt.returned", limits: LIMITS });
    expect(redLinePhase(m.state)).toBe("handoff");
    m.awake(9_000);
    m.sleep(93_000);
    // 以前：sinceStopMs=103867 decision=suspend reason=handoff_timeout。
    const fired = m.timerFires({ type: "handoff.timeout" });
    expect(fired.filter((effect) => effect.type === "unit.suspend")).toEqual([]);
    const rearm = fired.find((effect) => effect.type === "handoff.rearm") as Extract<SchedulerEffect, { type: "handoff.rearm" }>;
    expect(rearm.inMs).toBeGreaterThan(15_000);
    expect(rearm.inMs).toBeLessThanOrEqual(21_000);
    expect(redLinePhase(m.state)).toBe("handoff");
    // 醒着把剩下的窗口过完还没交：照常挂起。
    m.awake(rearm.inMs);
    m.timerFires({ type: "handoff.timeout" });
    expect(m.of("unit.suspend")).toEqual([{ type: "unit.suspend", reason: "handoff_timeout" }]);
  });
});

describe("2026-11-24 night: a suspended unit's reminder does not become a new suspended unit", () => {
  function service() {
    const dir = tempDir("plc-overnight-");
    const logs: string[] = [];
    const records: Array<[string, Record<string, unknown>]> = [];
    let unit: any = null;
    let now = 2_000_000;
    const scheduler = { get unit() { return unit; }, get state() { return { unit, draining: false, starting: false }; } };
    const handoffs = new LeadHandoffs({
      dataDir: dir, scheduler: scheduler as never, log: (line) => logs.push(line),
      record: (kind, payload) => records.push([kind, payload]), now: () => now,
      isWrite: (name) => name === "bash", isExternalTool: () => false, ticketOpen: () => true,
    });
    const begin = (id: string, text: string, wakeFor?: string) => {
      unit = { id, lane: 2, turnId: null, budgetStartedAt: now, openedAt: now, steps: 1 };
      handoffs.beginUnit({ unitId: id, turnId: null, goal: { text, source: "system", origin: "system:blocker", lane: 2, arrivedAt: "x" }, ...(wakeFor ? { wakeFor } : {}) });
    };
    const end = (id: string) => { handoffs.endUnit(id); unit = null; };
    return { handoffs, logs, records, begin, end, advance: (ms: number) => { now += ms; } };
  }

  it("keeps one suspended unit through many empty wake turns (old behavior: one new unit per wake, about 50 by morning)", () => {
    const s = service();
    s.begin("unit_first", "工单 #12 已结束，等合并决定");
    const first = s.handoffs.suspend("handoff_timeout")!;
    s.end("unit_first");
    for (let night = 0; night < 20; night += 1) {
      const wake = s.handoffs.nextWake();
      if (!wake) break;
      s.begin(`unit_wake_${night}`, "（有被打断的工作挂起了……）", wake.pkg.id);
      // 这一轮一个工具都没调，又被红线停下，窗口到时挂起。
      expect(s.handoffs.suspend("handoff_timeout")).toBeNull();
      s.end(`unit_wake_${night}`);
      s.handoffs.noteWake(wake.pkg.id, wake.lane);
      s.advance(20 * 60_000);
    }
    expect(s.handoffs.suspended().map((pkg) => pkg.id)).toEqual([first.id]);
    expect(s.logs.filter((line) => line.startsWith("[sched] suspend.skipped "))).toHaveLength(2);
    expect(s.logs.find((line) => line.startsWith("[sched] suspend.skipped "))).toMatch(new RegExp(`why=empty_wake into=${first.id}`, "u"));
    // 每个挂起的单元最多叫醒两次（第二次提一级），之后不再叫：不会整夜每 10–30 分钟叫一次。
    expect(s.handoffs.nextWake()).toBeNull();
  });

  it("still suspends a wake turn that did real work, so that work is not lost", () => {
    const s = service();
    s.begin("unit_first", "工单 #12 已结束，等合并决定");
    const first = s.handoffs.suspend("handoff_timeout")!;
    s.end("unit_first");
    s.begin("unit_wake", "（有被打断的工作挂起了……）", first.id);
    s.handoffs.toolStart({ id: "t1", tool: "get_ticket", args: { ticket_id: 12 } });
    s.handoffs.toolEnd({ id: "t1", result: "done", error: false });
    expect(s.handoffs.suspend("handoff_timeout")).not.toBeNull();
    expect(s.handoffs.suspended()).toHaveLength(2);
  });

  it("merges an empty unit into a suspended one with the same goal instead of storing it twice", () => {
    const s = service();
    s.begin("unit_a", "Slack 在 19:02 到 19:04 之间的消息没有补全");
    const kept = s.handoffs.suspend("handoff_timeout")!;
    s.end("unit_a");
    s.begin("unit_b", "Slack 在 19:02 到 19:04 之间的消息没有补全");
    expect(s.handoffs.suspend("handoff_timeout")).toBeNull();
    s.end("unit_b");
    expect(s.handoffs.suspended().map((pkg) => pkg.id)).toEqual([kept.id]);
    expect(s.logs.find((line) => line.startsWith("[sched] suspend.skipped "))).toMatch(new RegExp(`why=merged into=${kept.id}`, "u"));
    expect(s.records.find(([, payload]) => payload.decision === "suspend_skipped")?.[1]).toMatchObject({ why: "merged", into: kept.id });
  });
});

describe("2026-11-24 night: empty units cut by the red line trip the model breaker and tell the user", () => {
  it("recognizes a unit cut by the red line without one tool call", () => {
    expect(emptyRedLineUnit({ totalToolCalls: 0, aborts: [{ kind: "budget" }, { kind: "handoff_timeout" }] })).toBe(true);
    expect(emptyRedLineUnit({ totalToolCalls: 0, aborts: [{ kind: "handoff_timeout" }] })).toBe(true);
    expect(emptyRedLineUnit({ totalToolCalls: 2, aborts: [{ kind: "budget" }] })).toBe(false);
    expect(emptyRedLineUnit({ totalToolCalls: 0, aborts: [] })).toBe(false);
    expect(emptyRedLineUnit({ totalToolCalls: 0, aborts: [{ kind: "user_stop" }] })).toBe(false);
    expect(emptyRedLineUnit(null)).toBe(false);
  });

  it("is counted as a model failure, not as network or an account problem", () => {
    expect(classifyLeadModelError(EMPTY_RED_LINE_FAILURE)).toBe("unknown");
  });

  it("counts a finished unit that was an empty cut as a failure, not as an answer that lifts the breaker", () => {
    const empty = { totalToolCalls: 0, aborts: [{ kind: "budget" as const }, { kind: "handoff_timeout" as const }] };
    // 以前：这一轮记成答上了，modelHold.lift 把连续失败清零，熔断一夜都没打开。
    expect(modelHoldAfterUnit(true, empty)).toBe("fail");
    expect(modelHoldAfterUnit(true, { totalToolCalls: 3, aborts: [{ kind: "budget" }] })).toBe("lift");
    expect(modelHoldAfterUnit(true, { totalToolCalls: 0, aborts: [] })).toBe("lift");
    expect(modelHoldAfterUnit(false, empty)).toBeNull();
  });

  it("opens the breaker after three empty cuts in a row, which pauses automatic turns and tells the user once", () => {
    const changes: boolean[] = [];
    const hold = new ModelHold({ log: () => {}, onChange: (held) => changes.push(held), setTimer: () => () => {}, now: () => 5_000_000 });
    const empty = { totalToolCalls: 0, aborts: [{ kind: "budget" as const }, { kind: "handoff_timeout" as const }] };
    const unitEnds = (unit: typeof empty) => {
      const verdict = modelHoldAfterUnit(true, unit);
      if (verdict === "fail") hold.failed("turn", EMPTY_RED_LINE_FAILURE);
      else if (verdict === "lift") hold.lift("lead_turn");
    };
    unitEnds(empty);
    unitEnds(empty);
    expect(hold.held).toBe(false);
    unitEnds(empty);
    expect(hold.held).toBe(true);
    expect(hold.state).toMatchObject({ kind: "breaker", source: "turn" });
    // onChange(true) 是 daemon 告诉用户的那一下（noticeModelHold）。
    expect(changes).toEqual([true]);
  });
});

describe("compaction before a turn", () => {
  it.each([
    [{ due: null, ratio: 0.5, thresholdRatio: 0.9 }, null],
    [{ due: null, ratio: 0.92, thresholdRatio: 0.9 }, "threshold"],
    // 2026-11-24 夜里：上下文到了窗口的 111%，以前没有压缩失败留下的 due 就直接开一轮。
    [{ due: null, ratio: 1.11, thresholdRatio: 0.9 }, "overflow"],
    [{ due: "threshold", ratio: 1.11, thresholdRatio: 0.9 }, "overflow"],
    [{ due: "threshold", ratio: null, thresholdRatio: 0.9 }, "threshold"],
    [{ due: "overflow", ratio: 0.2, thresholdRatio: 0.9 }, "overflow"],
    [{ due: null, ratio: null, thresholdRatio: 0.9 }, null],
    [{ due: null, ratio: 0.95, thresholdRatio: null }, null],
  ] as const)("%o → %s", (input, expected) => {
    expect(compactionBeforeTurn(input)).toBe(expected);
  });
});
