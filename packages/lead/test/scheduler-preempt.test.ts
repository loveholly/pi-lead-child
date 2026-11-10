// Lead 调度器 P3「抢占」（lead-scheduler spec D4、D5、D10，用户 2026-11-09 的决定 1）：用户本人的消息到达，正在跑的单元不是
// L0 时，Lead 在等模型就马上中止这一步、单元挂起；有工具在跑（写操作不能打断）就等到下一个让出点。L0 的单元不抢占。
// 决策层用假时钟逐条驱动。
import { describe, expect, it } from "vitest";
import {
  abortedForPreempt, initialSchedulerState, schedulerStep, unitLane,
  type BudgetFacts, type SchedulerEffect, type SchedulerEvent, type SchedulerLimits, type SchedulerState,
} from "../src/scheduler/index.js";

const LIMITS: SchedulerLimits = {
  yellowToolCalls: 100, yellowMs: 600_000, budgetMs: 150_000, writeGraceMs: 30_000, handoffMs: 30_000,
  queueNoticeMs: 300_000, userQueueNoticeMs: 60_000,
};
const facts = (): BudgetFacts => ({ limits: LIMITS, compacting: false, canAbort: true, waiting: () => [] });

function machine(start = 1_000_000) {
  let state: SchedulerState = initialSchedulerState();
  let now = start;
  const effects: SchedulerEffect[] = [];
  return {
    send(event: SchedulerEvent) {
      const step = schedulerStep(state, event, now);
      state = step.state;
      effects.push(...step.effects);
      return step.effects;
    },
    get state() { return state; },
    advance(ms: number) { now += ms; },
    of<T extends SchedulerEffect["type"]>(type: T) { return effects.filter((effect) => effect.type === type) as Array<Extract<SchedulerEffect, { type: T }>>; },
    logs() { return effects.flatMap((effect) => (effect.type === "log" && effect.line.startsWith("[sched]") ? [effect.line] : [])); },
  };
}

function open(m: ReturnType<typeof machine>, source: "user" | "system" | "aish", origin: string | null = null) {
  m.send({ type: "unit.open", id: "unit_s", lane: unitLane({ source, system: origin }), source, origin, turnId: null });
  m.send({ type: "unit.begin" });
}

describe("preempting a unit for the user's own message (D4, D10)", () => {
  it("stops the step and suspends an L2 unit that waits for the model", () => {
    const m = machine();
    open(m, "system", "system:blocker");
    m.advance(8_000);
    m.send({ type: "preempt.request", by: "turn_user", stage: "B2" });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "preempt", by: "turn_user" } }]);
    expect(m.of("unit.suspend")).toEqual([{ type: "unit.suspend", reason: "preempt" }]);
    expect(abortedForPreempt(m.state)).toBe(true);
    const line = m.logs().find((entry) => entry.includes("decision=preempt "))!;
    expect(line).toContain("lane=L2");
    expect(line).toContain("by=turn_user");
    expect(line).toContain("at=model");
    expect(line).toContain("elapsedMs=8000");
  });

  it("also preempts a unit that an external person's message opened (L1)", () => {
    const m = machine();
    open(m, "aish");
    m.send({ type: "preempt.request", by: "turn_user", stage: "B1" });
    expect(m.of("unit.suspend")).toHaveLength(1);
  });

  it("does not preempt the user's own unit", () => {
    const m = machine();
    open(m, "user");
    m.send({ type: "preempt.request", by: "turn_user2", stage: "B2" });
    expect(m.of("abort")).toEqual([]);
    expect(m.of("unit.suspend")).toEqual([]);
    expect(m.logs().some((line) => line.includes("decision=no_preempt") && line.includes("reason=l0_unit"))).toBe(true);
  });

  // D5：写操作是提交，不被打断。到下一个让出点（工具结果回来以后、下一次模型请求之前）再中止。
  it("waits for a running write, then preempts at the next yield point", () => {
    const m = machine();
    open(m, "system", "system:blocker");
    m.send({ type: "tool.start", id: "w1", name: "bash", write: true, top: true, facts: facts() });
    m.send({ type: "preempt.request", by: "turn_user", stage: "tool" });
    expect(m.of("abort")).toEqual([]);
    expect(m.logs().some((line) => line.includes("decision=preempt_wait") && line.includes("tool=bash") && line.includes("write=true"))).toBe(true);
    m.advance(12_000);
    m.send({ type: "tool.end", id: "w1" });
    m.send({ type: "yield.check", facts: facts(), stepP90Ms: 19_000 });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "preempt", by: "turn_user" } }]);
    expect(m.of("unit.suspend")).toEqual([{ type: "unit.suspend", reason: "preempt" }]);
    const line = m.logs().find((entry) => entry.includes("decision=preempt "))!;
    expect(line).toContain("at=yield_point");
    expect(line).toContain("waitedMs=12000");
  });

  it("does not preempt while the red line stops the unit, and only once", () => {
    const red = machine();
    open(red, "system", "system:blocker");
    red.advance(150_000);
    red.send({ type: "budget.check", facts: facts() });
    red.send({ type: "preempt.request", by: "turn_user", stage: "B2" });
    expect(red.of("abort").map((effect) => effect.reason.kind)).toEqual(["budget"]);
    expect(red.logs().some((line) => line.includes("reason=red_line"))).toBe(true);
    const twice = machine();
    open(twice, "system", "system:blocker");
    twice.send({ type: "preempt.request", by: "turn_a", stage: "B2" });
    twice.send({ type: "preempt.request", by: "turn_b", stage: "B2" });
    expect(twice.of("abort")).toHaveLength(1);
    expect(twice.of("unit.suspend")).toHaveLength(1);
  });

  // P3 收尾：排着等抢占的用户消息都取消了，撤回等着的抢占；让出点照常往下做。
  it("withdraws a pending preemption, and the yield point then lets the unit go on", () => {
    const m = machine();
    open(m, "system", "system:blocker");
    m.send({ type: "tool.start", id: "w1", name: "bash", write: true, top: true, facts: facts() });
    m.send({ type: "preempt.request", by: "turn_user", stage: "tool" });
    m.advance(4_000);
    m.send({ type: "preempt.withdraw", by: "turn_user" });
    expect(m.logs().find((line) => line.includes("decision=preempt_withdrawn"))).toMatch(/by=turn_user waitedMs=4000/u);
    m.send({ type: "tool.end", id: "w1" });
    m.send({ type: "yield.check", facts: facts(), stepP90Ms: 19_000 });
    expect(m.of("abort")).toEqual([]);
    expect(m.of("unit.suspend")).toEqual([]);
    // 没有等着的抢占时，撤回什么也不做。
    const before = m.logs().length;
    m.send({ type: "preempt.withdraw", by: "turn_user" });
    expect(m.logs()).toHaveLength(before);
  });

  it("closes a preempted unit as suspended", () => {
    const m = machine();
    open(m, "system", "system:blocker");
    m.send({ type: "preempt.request", by: "turn_user", stage: "B2" });
    m.send({ type: "unit.close", outcome: "suspended" });
    expect(m.logs().find((line) => line.startsWith("[sched] unit.end"))).toMatch(/outcome=suspended .*aborts=preempt/u);
  });
});
