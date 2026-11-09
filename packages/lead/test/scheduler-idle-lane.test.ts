// 空闲车道的决策层（lead-scheduler spec D8，P4）：假时钟、表驱动，覆盖每一种决定。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDLE_LANE_LIMITS, idleLaneLimitsFromEnv, idleLaneStep, initialIdleLaneState, inlineDecision, nextIdleCheckAt, promoteLine,
  type IdleLaneEffect, type IdleLaneEvent, type IdleLaneLimits, type IdleLaneState,
} from "../src/scheduler/index.js";

const LIMITS: IdleLaneLimits = { ...DEFAULT_IDLE_LANE_LIMITS, graceMs: 15_000, deferMaxMs: 300_000, retryMs: 120_000 };

// 从 t=0 开始，按 [时间, 事件] 依次喂给状态机，返回最后的状态和全部的事。
function run(steps: Array<[number, IdleLaneEvent]>, limits = LIMITS, start: IdleLaneState = initialIdleLaneState(0)) {
  let state = start;
  const effects: Array<{ at: number; effect: IdleLaneEffect }> = [];
  for (const [at, event] of steps) {
    const step = idleLaneStep(state, event, at, limits);
    state = step.state;
    for (const effect of step.effects) effects.push({ at, effect });
  }
  return { state, effects, kinds: effects.filter(({ effect }) => effect.type !== "log" && effect.type !== "record").map(({ effect }) => effect.type), logs: effects.flatMap(({ effect }) => (effect.type === "log" ? [effect.line] : [])) };
}

const tick = (ratio: number | null, extra: Partial<Extract<IdleLaneEvent, { type: "tick" }>> = {}): IdleLaneEvent => ({ type: "tick", ratio, pendingInput: false, starting: false, ...extra });

describe("idle lane: starting idle work", () => {
  it.each([
    // [说明, 空闲了多久, 水位, 有没有排着的输入, 在探网络, 期望]
    ["before the idle grace: nothing", 14_999, 0.82, false, false, []],
    ["idle long enough, context under both lines: nothing", 15_000, 0.5, false, false, []],
    ["idle long enough, over the notes line: notes first", 15_000, 0.75, false, false, ["precipitate.start"]],
    ["over the compaction line but notes not done: notes first", 20_000, 0.85, false, false, ["precipitate.start"]],
    ["a queued input waits for Lead: nothing", 60_000, 0.82, true, false, []],
    ["a system turn is probing the network: nothing", 60_000, 0.9, false, true, []],
    // 提级：过了 85%，不等空闲满 graceMs，也不管排着的输入（子进程不占 Lead，取对话只碰会话几毫秒）。
    ["over the promote line, right after a unit: the summary starts", 0, 0.86, false, false, ["compact.start"]],
    ["over the promote line with a queued input: the summary starts", 1_000, 0.9, true, false, ["compact.start"]],
    ["over the promote line, idle long enough, notes pending: notes first", 15_000, 0.9, false, false, ["precipitate.start"]],
    ["context unknown (just compacted): nothing", 60_000, null, false, false, []],
  ] as const)("%s", (_name, at, ratio, pendingInput, starting, expected) => {
    const { kinds } = run([[at, tick(ratio, { pendingInput, starting })]]);
    expect(kinds).toEqual(expected);
  });

  it("compacts in the idle lane after the notes are done, and logs the numbers it used", () => {
    const { kinds, logs, state } = run([
      [16_000, tick(0.75)],
      [16_000, { type: "busy", unitId: "unit_p", lane: 4 }],
      [40_000, { type: "precipitate.ended", outcome: "done" }],
      [40_000, { type: "idle" }],
      [50_000, tick(0.83)],
      [55_000, tick(0.83)],
    ]);
    expect(kinds).toEqual(["precipitate.start", "compact.start"]);
    expect(state.compact).toMatchObject({ phase: "preparing", promoted: false });
    expect(logs.at(-1)).toMatch(/^\[sched\] idle\.start job=compact id=idle_compact_\w+ ratio=0\.83 line=0\.8 idleMs=15000 failures=0$/);
  });

  it("promotes the summary at a unit boundary when the context is nearly full, and logs why", () => {
    const { kinds, logs, state } = run([
      [0, { type: "busy", unitId: "unit_a", lane: 0 }],
      [6_000, { type: "idle" }],
      [6_000, tick(0.87, { boundary: true, pendingInput: true })],
    ]);
    expect(kinds).toEqual(["compact.start"]);
    expect(state.compact).toMatchObject({ phase: "preparing", promoted: true });
    expect(logs[0]).toMatch(/^\[sched\] idle\.start job=compact id=idle_compact_\w+ ratio=0\.87 line=0\.85 promoted=true why=boundary step=0\.00 threshold=- idleMs=0 failures=0$/);
  });

  it("moves the promote line two steps before pi's line when steps are big (dev: one read is 9.5% of the window)", () => {
    expect(promoteLine({ stepMax: 0 }, LIMITS, 0.8975)).toBe(0.85);
    expect(promoteLine({ stepMax: 0.095 }, LIMITS, 0.8975)).toBeCloseTo(0.7075);
    expect(promoteLine({ stepMax: 0.2 }, LIMITS, 0.8975)).toBe(0.7);
    expect(promoteLine({ stepMax: 0.01 }, LIMITS, 0.959)).toBe(0.85);
    const at = (ratio: number, time: number): [number, IdleLaneEvent] => [time, tick(ratio, { boundary: true, pendingInput: true, thresholdRatio: 0.8975 })];
    const { kinds, logs } = run([
      [0, { type: "busy", unitId: "unit_a", lane: 0 }], [6_000, { type: "idle" }], at(0.655, 6_000),
      [6_100, { type: "busy", unitId: "unit_b", lane: 0 }], [12_000, { type: "idle" }], at(0.75, 12_000),
    ]);
    expect(kinds).toEqual(["compact.start"]);
    expect(logs[0]).toMatch(/idle\.start job=compact .*ratio=0\.75 line=0\.71 promoted=true why=boundary step=0\.(09|10) threshold=0\.90 /);
  });

  it("keeps the step size across a compaction, so the first boundary after it can promote", () => {
    const at = (ratio: number | null, time: number): [number, IdleLaneEvent] => [time, tick(ratio, { boundary: true, thresholdRatio: 0.92 })];
    const { kinds } = run([
      [0, { type: "busy", unitId: "unit_a", lane: 0 }], [5_000, { type: "idle" }], at(0.65, 5_000),
      [5_100, { type: "busy", unitId: "unit_b", lane: 0 }], [10_000, { type: "idle" }], at(0.75, 10_000),
      [10_000, { type: "compacted", how: "overflow" }],
      [10_100, { type: "busy", unitId: "unit_c", lane: 0 }], [15_000, { type: "idle" }], at(0.75, 15_000),
    ]);
    // 第一次在 0.75（线 0.72）就提级，压缩后的第一次也一样。
    expect(kinds).toEqual(["compact.start", "compact.cancel", "compact.start"]);
  });

  it("never starts while a unit runs", () => {
    const { kinds } = run([[0, { type: "busy", unitId: "unit_a", lane: 0 }], [600_000, tick(0.95)]]);
    expect(kinds).toEqual([]);
  });
});

describe("idle lane: the summary written in a child process", () => {
  const started = (state: IdleLaneState) => run([
    [16_000, tick(0.85)],
  ], LIMITS, { ...state, precipitate: { ...state.precipitate, done: true } });

  it("applies the summary at once when Lead is idle (no grace: it takes milliseconds)", () => {
    const first = started(initialIdleLaneState(0));
    const { kinds, state } = run([
      [16_001, { type: "compact.summarizing", tokens: 320_000, messages: 400 }],
      [70_000, { type: "compact.ready", ms: 54_000, chars: 7_000, chunks: 1 }],
    ], LIMITS, first.state);
    expect(kinds).toEqual(["compact.apply"]);
    expect(state.compact.phase).toBe("applying");
  });

  it("keeps the summary while Lead is busy and applies it when the unit ends", () => {
    const first = started(initialIdleLaneState(0));
    const { kinds, logs } = run([
      [16_001, { type: "compact.summarizing", tokens: 320_000, messages: 400 }],
      // 用户发话：摘要照常在子进程里写（不占 Lead），接上等空闲。
      [20_000, { type: "busy", unitId: "unit_u", lane: 0 }],
      [20_000, { type: "input", lane: 0, what: "user" }],
      [70_000, { type: "compact.ready", ms: 54_000, chars: 7_000, chunks: 1 }],
      [80_000, { type: "idle" }],
      [80_000, tick(0.86)],
    ], LIMITS, first.state);
    expect(kinds).toEqual(["compact.apply"]);
    expect(logs.some((line) => /idle\.yield job=compact .*action=continue_in_child apply=when_idle/.test(line))).toBe(true);
    expect(logs.some((line) => /idle\.wait job=compact .*why=lead_busy unit=unit_u lane=L0/.test(line))).toBe(true);
  });

  it("retries a failed summary with backoff, and the timer wakes for the retry", () => {
    const first = started(initialIdleLaneState(0));
    const failed = run([
      [16_001, { type: "compact.summarizing", tokens: 1, messages: 1 }],
      [30_000, { type: "compact.failed", error: "503 from the model", ms: 14_000 }],
    ], LIMITS, first.state);
    expect(failed.state.compact).toMatchObject({ phase: "idle", failures: 1, retryAt: 150_000 });
    expect(nextIdleCheckAt(failed.state, LIMITS, 30_000)).toBe(150_000);
    expect(run([[149_999, tick(0.85)]], LIMITS, failed.state).kinds).toEqual([]);
    const again = run([[150_000, tick(0.85)]], LIMITS, failed.state);
    expect(again.kinds).toEqual(["compact.start"]);
    // 第二次失败等 4 分钟（翻倍）。
    const twice = run([
      [150_001, { type: "compact.summarizing", tokens: 1, messages: 1 }],
      [160_000, { type: "compact.failed", error: "503", ms: 10_000 }],
    ], LIMITS, again.state);
    expect(twice.state.compact.retryAt).toBe(160_000 + 240_000);
  });

  it("drops a summary when the session was compacted elsewhere meanwhile, and stops the child", () => {
    const first = started(initialIdleLaneState(0));
    const { kinds, state } = run([
      [16_001, { type: "compact.summarizing", tokens: 1, messages: 1 }],
      [20_000, { type: "compacted", how: "overflow" }],
    ], LIMITS, first.state);
    expect(kinds).toEqual(["compact.cancel"]);
    expect(state.compact.phase).toBe("idle");
    expect(state.precipitate.done).toBe(false);
  });

  it("re-arms the notes after its own summary is applied", () => {
    const first = started(initialIdleLaneState(0));
    const { state, logs } = run([
      [16_001, { type: "compact.summarizing", tokens: 1, messages: 1 }],
      [30_000, { type: "compact.ready", ms: 14_000, chars: 10, chunks: 1 }],
      [30_010, { type: "compact.applied", tokensBefore: 330_000 }],
    ], LIMITS, first.state);
    expect(state.compact.phase).toBe("idle");
    expect(state.precipitate).toMatchObject({ done: false, yields: 0 });
    expect(logs.at(-1)).toMatch(/idle\.applied job=compact .*totalMs=14010 tokensBefore=330000 deferrals=0/);
  });
});

describe("idle lane: pi wants to compact in the middle of a unit", () => {
  it.each([
    // [说明, 原因, 写好的摘要有效, 忙着, 第一次推迟以来, 期望]
    ["a valid summary is ready: use it", "threshold", true, true, null, "supply"],
    ["overflow: never deferred", "overflow", false, true, null, "allow"],
    ["threshold while idle: compact as usual", "threshold", false, false, null, "allow"],
    ["threshold in a unit, first time: defer", "threshold", false, true, null, "defer"],
    ["threshold in a unit, deferred 4 min 59 s: defer", "threshold", false, true, 299_000, "defer"],
    ["threshold in a unit, deferred 5 min: compact anyway", "threshold", false, true, 300_000, "allow"],
    ["manual without a summary: as usual", "manual", false, true, null, "allow"],
  ] as const)("%s", (_name, reason, ready, busy, deferredFor, expected) => {
    const now = 1_000_000;
    const base = initialIdleLaneState(0);
    const state: IdleLaneState = {
      ...base,
      ...(busy ? { busyUnit: "unit_u", busyLane: 0 as const, busySince: 0, idleSince: null } : {}),
      compact: { ...base.compact, deferredSince: deferredFor === null ? null : now - deferredFor, deferrals: deferredFor === null ? 0 : 3 },
    };
    expect(inlineDecision(state, reason, ready, now, LIMITS)).toBe(expected);
  });

  it("defers, starts writing the summary at once (promoted), and logs the deferral once per ten", () => {
    const busy: IdleLaneEvent = { type: "busy", unitId: "unit_u", lane: 0 };
    const inline: IdleLaneEvent = { type: "inline", reason: "threshold", ready: false };
    const steps: Array<[number, IdleLaneEvent]> = [[0, busy], [1_000, inline]];
    for (let index = 2; index <= 10; index += 1) steps.push([index * 1_000, inline]);
    const { kinds, logs, state } = run(steps);
    expect(kinds.slice(0, 2)).toEqual(["inline", "compact.start"]);
    expect(kinds.filter((kind) => kind === "compact.start")).toHaveLength(1);
    expect(state.compact).toMatchObject({ promoted: true, deferrals: 10, deferredSince: 1_000 });
    const deferLines = logs.filter((line) => line.includes("idle.defer"));
    expect(deferLines).toHaveLength(2);
    expect(deferLines[0]).toMatch(/idle\.defer job=compact id=idle_compact_\w+ reason=threshold unit=unit_u lane=L0 deferrals=1 dueMs=0 deferMaxMs=300000 promoted=true/);
  });

  it("compacts in place after the deadline and says so in the log (the fallback)", () => {
    const { kinds, logs } = run([
      [0, { type: "busy", unitId: "unit_u", lane: 1 }],
      [1_000, { type: "inline", reason: "threshold", ready: false }],
      [301_000, { type: "inline", reason: "threshold", ready: false }],
    ]);
    expect(kinds).toEqual(["inline", "compact.start", "inline"]);
    expect(logs.at(-1)).toMatch(/^\[sched\] idle\.compact\.forced unit=unit_u lane=L1 reason=threshold dueMs=300000 deferMaxMs=300000 deferrals=1 job=idle_compact_\w+ phase=preparing$/);
  });
});

describe("idle lane: the notes turn yields to new input", () => {
  const running = () => run([
    [16_000, tick(0.75)],
    [16_000, { type: "busy", unitId: "unit_p", lane: 4 }],
  ]);

  it("asks the L4 unit to stop once, whoever comes", () => {
    const { state } = running();
    const { kinds, logs } = run([
      [20_000, { type: "input", lane: 0, what: "user" }],
      [20_500, { type: "input", lane: 2, what: "event" }],
    ], LIMITS, state);
    expect(kinds).toEqual(["yield.unit"]);
    expect(logs[0]).toMatch(/^\[sched\] idle\.yield job=precipitate id=idle_precipitate_\w+ unit=unit_p by=L0 what=user action=abort_at_yield_point runMs=4000$/);
  });

  it("runs again at the next idle moment after a yield (resume), but not after it finished", () => {
    const { state } = running();
    const yielded = run([
      [20_000, { type: "input", lane: 0, what: "user" }],
      [20_400, { type: "idle" }],
      [20_400, { type: "precipitate.ended", outcome: "yielded" }],
      [21_000, { type: "busy", unitId: "unit_u", lane: 0 }],
      [30_000, { type: "idle" }],
      [45_000, tick(0.76)],
    ], LIMITS, state);
    expect(yielded.kinds).toEqual(["yield.unit", "precipitate.start"]);
    expect(yielded.state.precipitate.yields).toBe(1);
    const finished = run([
      [20_000, { type: "idle" }],
      [20_000, { type: "precipitate.ended", outcome: "done" }],
      [60_000, tick(0.76)],
    ], LIMITS, state);
    expect(finished.kinds).toEqual([]);
  });

  it("does not stop units that are not idle work", () => {
    const { kinds } = run([[0, { type: "busy", unitId: "unit_u", lane: 0 }], [1_000, { type: "input", lane: 0, what: "user" }]]);
    expect(kinds).toEqual([]);
  });
});

describe("idle lane: limits and timers", () => {
  it("reads the limits from the environment", () => {
    expect(idleLaneLimitsFromEnv({ PLC_LEAD_IDLE_GRACE_MS: "5000", PLC_LEAD_IDLE_COMPACT_RATIO: "0.6", PLC_LEAD_COMPACT_DEFER_MAX_MS: "20000" }))
      .toMatchObject({ graceMs: 5_000, compactRatio: 0.6, deferMaxMs: 20_000 });
    expect(idleLaneLimitsFromEnv({ PLC_LEAD_IDLE_COMPACT_RATIO: "2", PLC_LEAD_IDLE_GRACE_MS: "-1" }))
      .toMatchObject({ graceMs: DEFAULT_IDLE_LANE_LIMITS.graceMs, compactRatio: DEFAULT_IDLE_LANE_LIMITS.compactRatio });
  });

  it("wakes once at the end of the grace, and not again while nothing waits", () => {
    const state = initialIdleLaneState(1_000);
    expect(nextIdleCheckAt(state, LIMITS, 1_000)).toBe(16_000);
    // 那一刻看过以后不再等。
    expect(nextIdleCheckAt(state, LIMITS, 16_000)).toBeNull();
    // graceMs 为 0：空闲的那一刻就要看一次（还没看过）。
    expect(nextIdleCheckAt(state, { ...LIMITS, graceMs: 0 }, 999)).toBe(1_000);
    expect(nextIdleCheckAt({ ...state, busyUnit: "unit_x", idleSince: null }, LIMITS, 2_000)).toBeNull();
  });

  it("holds background work while Lead is busy and releases it after the grace", () => {
    const { state, logs } = run([
      [0, { type: "busy", unitId: "unit_u", lane: 0 }],
      [100, { type: "gate.wait", kind: "worktree-delete", label: "wt-1" }],
      [5_000, { type: "idle" }],
    ]);
    expect(state.gated).toBe(1);
    expect(logs[0]).toBe("[sched] idle.wait job=trash kind=worktree-delete label=wt-1 why=lead_busy unit=unit_u lane=L0");
    expect(run([[19_999, tick(0.1)]], LIMITS, state).kinds).toEqual([]);
    const released = run([[20_000, tick(0.1)]], LIMITS, state);
    expect(released.kinds).toEqual(["gate.release"]);
    expect(released.state.gated).toBe(0);
  });
});
