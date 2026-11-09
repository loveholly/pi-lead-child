// Lead 调度器的决策层（lead-scheduler spec D9）：纯函数状态机，用假时钟逐条驱动。
// 以前这些规则在 daemon 的 server.ts 里（checkLeadBudget、stopForRedLine、continueAfterRedLine、noticeQueue……），
// 只能起一个 daemon 来测。现在每一种决定都在这里按表测一遍。
import { describe, expect, it } from "vitest";
import {
  abortedByRedLine, abortedForRestart, canInterruptForSteer, countedWaiting, handoffGate, initialSchedulerState, isBusy,
  redLinePhase, schedulerStep, stoppedByUser, unitLane,
  type BudgetFacts, type SchedulerEffect, type SchedulerEvent, type SchedulerLimits, type SchedulerState, type WaitingEntry,
} from "../src/scheduler/index.js";

const LIMITS: SchedulerLimits = {
  yellowToolCalls: 10, yellowMs: 120_000, budgetMs: 150_000, writeGraceMs: 30_000, handoffMs: 180_000,
  queueNoticeMs: 300_000, userQueueNoticeMs: 60_000,
};

const user = (waitedMs: number, extra: Partial<WaitingEntry> = {}): WaitingEntry => ({
  who: "用户", conversation: "和你的对话", count: 1, waitedMs, user: true, lane: 0, ...extra,
});
const colleague = (waitedMs: number, who = "Nina"): WaitingEntry => ({
  who, conversation: `${who} 的私信`, count: 1, waitedMs, lane: 1,
});

function facts(waiting: WaitingEntry[] | ((answering: boolean) => WaitingEntry[]) = [], extra: Partial<BudgetFacts> = {}): BudgetFacts {
  return {
    limits: LIMITS, compacting: false, canAbort: true,
    waiting: (options) => (typeof waiting === "function" ? waiting(options?.answering !== false) : waiting),
    ...extra,
  };
}

// 一个用假时钟驱动的状态机。
function machine(start = 1_000_000) {
  let state: SchedulerState = initialSchedulerState();
  let now = start;
  const effects: SchedulerEffect[] = [];
  const send = (event: SchedulerEvent) => {
    const step = schedulerStep(state, event, now);
    state = step.state;
    effects.push(...step.effects);
    return step.effects;
  };
  return {
    send,
    get state() { return state; },
    get now() { return now; },
    advance(ms: number) { now += ms; },
    effects,
    of<T extends SchedulerEffect["type"]>(type: T) { return effects.filter((effect) => effect.type === type) as Array<Extract<SchedulerEffect, { type: T }>>; },
    logs(prefix = "[sched]") { return effects.flatMap((effect) => effect.type === "log" && effect.line.startsWith(prefix) ? [effect.line] : []); },
  };
}

function openUnit(m: ReturnType<typeof machine>, source: "user" | "system" | "aish" = "user", origin: string | null = null) {
  const lane = unitLane({ source, system: origin });
  m.send({ type: "unit.open", id: "unit_a", lane, source, origin, turnId: source === "user" ? "turn_u1" : null });
  m.send({ type: "unit.begin" });
}

describe("lanes (D1, D2)", () => {
  it.each([
    [{ source: "user" as const }, 0],
    [{ source: "aish" as const }, 1],
    [{ source: "system" as const, system: "system:blocker", externalMessage: true }, 1],
    [{ source: "system" as const, system: "system:blocker" }, 2],
    [{ source: "system" as const, system: "system:reminder" }, 2],
    [{ source: "system" as const, system: "system:notification" }, 2],
    [{ source: "system" as const, system: "system:digest" }, 3],
    [{ source: "system" as const, system: "system:heartbeat" }, 3],
    [{ source: "system" as const, system: "system:precipitate" }, 4],
  ])("puts %o in lane L%i", (input, lane) => {
    expect(unitLane(input)).toBe(lane);
  });
});

describe("the unit lifecycle", () => {
  it("is busy from open to close, and logs both with the unit id and the turn id", () => {
    const m = machine();
    expect(isBusy(m.state)).toBe(false);
    openUnit(m);
    expect(isBusy(m.state)).toBe(true);
    m.send({ type: "step.end" });
    m.advance(4_000);
    m.send({ type: "unit.close", outcome: "answered" });
    expect(isBusy(m.state)).toBe(false);
    expect(m.logs()).toEqual([
      "[sched] unit.start unit=unit_a lane=L0 turn=turn_u1 source=user origin=- deadlineMs=10000",
      "[sched] unit.end unit=unit_a lane=L0 turn=turn_u1 outcome=answered ms=4000 steps=1 toolCalls=0 aborts=- redLine=-",
    ]);
    expect(m.of("record").map((effect) => effect.kind)).toEqual(["unit_started", "unit_ended"]);
  });

  it("keeps the old busy flag's behavior when a second unit opens over a running one", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "unit.open", id: "unit_b", lane: 0, source: "user", origin: null, turnId: "turn_u2" });
    expect(m.state.unit?.id).toBe("unit_b");
    expect(m.logs().some((line) => line.startsWith("[sched] unit.overlap unit=unit_b replaces=unit_a"))).toBe(true);
  });
});

describe("the yellow light", () => {
  it("reminds once after the tool-call limit", () => {
    const m = machine();
    openUnit(m);
    for (let call = 0; call < 10; call += 1) m.send({ type: "tool.start", id: `c${call}`, name: "grep", write: false, top: true, facts: facts() });
    m.send({ type: "tool.start", id: "c10", name: "grep", write: false, top: true, facts: facts() });
    expect(m.of("remind.yellow")).toEqual([expect.objectContaining({ reason: "tool_calls", toolCalls: 10 })]);
  });

  it("does not count nested codemode calls", () => {
    const m = machine();
    openUnit(m);
    for (let call = 0; call < 20; call += 1) m.send({ type: "tool.start", id: `n${call}`, name: "grep", write: false, top: false, facts: facts() });
    expect(m.of("remind.yellow")).toEqual([]);
    expect(m.state.unit?.toolCalls).toBe(0);
  });

  it("reminds after the duration limit on the poll", () => {
    const m = machine();
    openUnit(m);
    m.advance(119_000);
    m.send({ type: "budget.check", facts: facts() });
    expect(m.of("remind.yellow")).toEqual([]);
    m.advance(1_000);
    m.send({ type: "budget.check", facts: facts() });
    m.send({ type: "budget.check", facts: facts() });
    expect(m.of("remind.yellow")).toEqual([expect.objectContaining({ reason: "duration" })]);
  });

  it("does nothing while the context is being compacted", () => {
    const m = machine();
    openUnit(m);
    m.advance(200_000);
    m.send({ type: "budget.check", facts: facts([user(200_000)], { compacting: true }) });
    expect(m.effects.filter((effect) => effect.type !== "log" && effect.type !== "record")).toEqual([]);
  });
});

describe("the red line", () => {
  it("reminds a second time and does not stop when nobody waits on a system unit", () => {
    const m = machine();
    openUnit(m, "system", "system:blocker");
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts() });
    m.send({ type: "budget.check", facts: facts() });
    expect(m.of("remind.second")).toHaveLength(1);
    expect(m.of("abort")).toEqual([]);
    expect(m.logs().some((line) => line.includes("decision=red_line_remind"))).toBe(true);
  });

  it("stops a system unit once someone starts to wait", () => {
    const m = machine();
    openUnit(m, "system", "system:digest");
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts() });
    m.advance(10_000);
    m.send({ type: "budget.check", facts: facts([colleague(2_000)]) });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "budget" } }]);
    expect(redLinePhase(m.state)).toBe("aborting");
    expect(abortedByRedLine(m.state)).toBe(true);
  });

  it("lets a running write finish within the grace period, then stops", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "tool.start", id: "w1", name: "bash", write: true, top: true, facts: facts([user(0)]) });
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)]) });
    expect(m.of("abort")).toEqual([]);
    expect(m.of("redline.recheck")).toEqual([{ type: "redline.recheck", afterMs: 250 }]);
    expect(m.logs().filter((line) => line.includes("decision=write_wait"))).toHaveLength(1);
    m.advance(250);
    m.send({ type: "write.recheck", canAbort: true });
    // 同一个写操作只记一次日志。
    expect(m.logs().filter((line) => line.includes("decision=write_wait"))).toHaveLength(1);
    m.send({ type: "tool.end", id: "w1" });
    m.advance(250);
    m.send({ type: "write.recheck", canAbort: true });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "budget" } }]);
  });

  it("stops anyway when the write outlasts the grace period", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "tool.start", id: "w1", name: "bash", write: true, top: true, facts: facts([user(0)]) });
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)]) });
    m.advance(30_000);
    m.send({ type: "write.recheck", canAbort: true });
    expect(m.of("abort")).toHaveLength(1);
    expect(m.effects.some((effect) => effect.type === "log" && effect.line.includes("bash still runs after the grace period"))).toBe(true);
  });

  it("steers the red-line message when the session cannot abort", () => {
    const m = machine();
    openUnit(m);
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)], { canAbort: false }) });
    expect(m.of("abort")).toEqual([]);
    expect(m.of("redline.steer")).toHaveLength(1);
    expect(redLinePhase(m.state)).toBe("handoff");
  });

  it("asks Lead to hand off when the stopped prompt returns, then closes the window on time", () => {
    const m = machine();
    openUnit(m);
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)]) });
    m.send({ type: "prompt.returned", limits: LIMITS });
    expect(m.of("redline.handoff")).toEqual([expect.objectContaining({ timeoutMs: 180_000, elapsedMs: 150_000 })]);
    expect(redLinePhase(m.state)).toBe("handoff");
    expect(m.state.unit?.segment).toBe(2);
    expect(handoffGate(m.state, "tools")).toBe("tools");
    m.send({ type: "handoff.timeout" });
    expect(redLinePhase(m.state)).toBe("closing");
    expect(m.of("abort").map((effect) => effect.reason.kind)).toEqual(["budget", "handoff_timeout"]);
    m.send({ type: "handoff.done" });
    expect(redLinePhase(m.state)).toBe("done");
    expect(handoffGate(m.state, "tools")).toBeNull();
  });

  it("does not hand off when the unit was interrupted for a restart", () => {
    const m = machine();
    openUnit(m);
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)]) });
    m.send({ type: "drain.start" });
    m.send({ type: "drain.abort" });
    m.send({ type: "prompt.returned", limits: LIMITS });
    expect(m.of("redline.handoff")).toEqual([]);
    expect(abortedForRestart(m.state)).toBe(true);
  });

  it("restarts both lights when a queued message starts in the same run, but not in the middle of a red line", () => {
    const m = machine();
    openUnit(m);
    m.advance(150_000);
    m.send({ type: "budget.check", facts: facts([user(150_000)]) });
    m.send({ type: "budget.restart", why: "follow_up" });
    expect(redLinePhase(m.state)).toBe("aborting");
    m.send({ type: "prompt.returned", limits: LIMITS });
    m.send({ type: "handoff.done" });
    m.send({ type: "budget.restart", why: "follow_up" });
    expect(m.state.unit?.redLine).toBeNull();
    expect(m.state.unit?.budgetStartedAt).toBe(m.now);
  });
});

describe("the queue notice", () => {
  it("tells Lead once when an external person waits past the threshold in a system unit", () => {
    const m = machine();
    openUnit(m, "system", "system:blocker");
    m.send({ type: "queue.check", facts: facts([colleague(299_000)]) });
    expect(m.of("notice.queue")).toEqual([]);
    m.send({ type: "queue.check", facts: facts([colleague(300_000)]) });
    m.send({ type: "queue.check", facts: facts([colleague(400_000)]) });
    expect(m.of("notice.queue")).toEqual([{ type: "notice.queue", waiting: [colleague(300_000)] }]);
  });

  it("uses the shorter threshold for the user's own queued messages and leaves out the message being answered", () => {
    const m = machine();
    openUnit(m);
    const waiting = (answering: boolean) => [...(answering ? [user(200_000)] : []), user(60_000, { firstLines: ["顺便看一下 acme/b"] })];
    m.send({ type: "queue.check", facts: facts(waiting) });
    expect(m.of("notice.queue")).toEqual([{ type: "notice.queue", waiting: [user(60_000, { firstLines: ["顺便看一下 acme/b"] })] }]);
  });
});

// 优先级反转（spec「背景」，用户 2026-11-09 的决定 2）：外部的人的消息不能抢占用户本人的 L0 单元。
describe("external messages do not preempt the user's unit", () => {
  it("counts only L0 waits in an L0 unit, and every wait elsewhere", () => {
    const waiting = [user(10_000), colleague(2_000)];
    expect(countedWaiting({ lane: 0 }, waiting)).toEqual([user(10_000)]);
    expect(countedWaiting({ lane: 2 }, waiting)).toEqual(waiting);
  });

  it("does not tell Lead about a colleague in the user's unit, and still tells it about the user's own queued messages", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "queue.check", facts: facts([colleague(600_000)]) });
    expect(m.of("notice.queue")).toEqual([]);
    expect(m.logs().filter((line) => line.includes("decision=queue_hold"))).toHaveLength(1);
    m.send({ type: "queue.check", facts: facts([colleague(601_000)]) });
    expect(m.logs().filter((line) => line.includes("decision=queue_hold"))).toHaveLength(1);
    m.send({ type: "queue.check", facts: facts([colleague(700_000), user(61_000)]) });
    expect(m.of("notice.queue")).toEqual([{ type: "notice.queue", waiting: [user(61_000)] }]);
  });

  it("stops the user's unit at the budget even when the user's message has no text, and names only the user", () => {
    const m = machine();
    openUnit(m);
    m.advance(150_000);
    // 图片消息没有文字：以前 daemon 不把它算作在等，红线只提醒。
    m.send({ type: "budget.check", facts: facts([]) });
    expect(m.of("remind.second")).toEqual([]);
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "budget" } }]);
    expect(m.logs().find((line) => line.includes("decision=red_line_stop"))).toContain("waiting=L0:unit");
  });

  it("leaves the colleague out of the red-line decision and the yellow reminder of the user's unit", () => {
    const m = machine();
    openUnit(m);
    m.advance(120_000);
    m.send({ type: "budget.check", facts: facts([user(120_000), colleague(1_000)]) });
    expect(m.of("remind.yellow")[0]?.waiting).toEqual([user(120_000)]);
    m.advance(30_000);
    m.send({ type: "budget.check", facts: facts([user(150_000), colleague(31_000)]) });
    const decision = m.logs().find((line) => line.includes("decision=red_line_stop"))!;
    expect(decision).toContain("waiting=L0:user:1:150s");
    expect(decision).toContain("queued=L1:external:1:31s");
    expect(m.state.unit?.redLine?.waiting).toEqual([user(150_000)]);
  });
});

describe("/stop and drain", () => {
  it("stops a running unit with the user_stop reason, and does nothing when Lead is idle", () => {
    const m = machine();
    expect(m.send({ type: "stop.request", canAbort: true })).toEqual([]);
    openUnit(m);
    expect(m.send({ type: "stop.request", canAbort: false })).toEqual([]);
    m.send({ type: "stop.request", canAbort: true });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "user_stop" } }]);
    expect(stoppedByUser(m.state)).toBe(true);
    expect(canInterruptForSteer(m.state)).toBe(false);
  });

  it("drains: no new units, the running one is interrupted once, an expired drain takes the interruption back", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "drain.start" });
    expect(m.state.draining).toBe(true);
    expect(canInterruptForSteer(m.state)).toBe(false);
    m.send({ type: "drain.abort" });
    m.send({ type: "drain.abort" });
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "drain" } }]);
    m.send({ type: "drain.expire" });
    expect(m.state.draining).toBe(false);
    expect(abortedForRestart(m.state)).toBe(false);
  });
});

// 回放：事故的时间线按比例照搬，人和原文换成编造的。
describe("replays", () => {
  // 2026-11-09 13:34：用户的小请求，Lead 在用户自己的这一轮里卡在发请求前 9 分 42 秒。13:37:18 红线判断「没有人在等」，
  // 只提醒；13:45:10 一位同事的两个词的闲聊 DM 到了，只等了 2 秒，红线就停下了用户的这一轮。
  // 期望：L0 单元在就地预算到期时停下，停下的依据是用户本人；同事的 DM 只排队，不出现在停下的依据里。
  it("2026-11-09: stops the user's unit at the budget because of the user, and the colleague's DM only queues", () => {
    const m = machine();
    openUnit(m);
    m.send({ type: "tool.start", id: "abandon", name: "ticket_action", write: false, top: true, facts: facts([user(0)]) });
    m.send({ type: "tool.start", id: "grep", name: "bash", write: true, top: true, facts: facts([user(0)]) });
    m.advance(10_000);
    m.send({ type: "tool.end", id: "abandon" });
    m.send({ type: "tool.end", id: "grep" });
    // 之后一直卡着：每秒轮询一次。
    let stoppedAt: number | null = null;
    for (let second = 11; second <= 600 && stoppedAt === null; second += 1) {
      m.advance(1_000);
      const dm = second >= 140 ? [colleague((second - 140) * 1_000)] : [];
      // 用户本人只有这一轮正在回答的那一条：排队说明不算它。
      const waiting = (answering: boolean) => [...(answering ? [user(second * 1_000)] : []), ...dm];
      m.send({ type: "queue.check", facts: facts(waiting) });
      m.send({ type: "budget.check", facts: facts(waiting) });
      if (m.of("abort").length) stoppedAt = second;
    }
    expect(stoppedAt).toBe(150);
    expect(m.of("remind.second")).toEqual([]);
    const decision = m.logs().find((line) => line.includes("decision=red_line_stop"))!;
    expect(decision).toMatch(/unit=unit_a lane=L0 turn=turn_u1 decision=red_line_stop elapsedMs=150000 budgetMs=150000 waiting=L0:user:1:150s queued=L1:external:1:10s/u);
    expect(m.of("notice.queue")).toEqual([]);
    expect(m.state.unit?.redLine?.waiting.every((entry) => entry.lane === 0)).toBe(true);
  });

  // 2026-11-03：一轮就地查了 6 分多钟，三条用户消息排了 6–9 分钟。期望：在就地预算到期时停下，交接。
  it("2026-11-03: stops the in-place investigation at the budget while the user's messages queue", () => {
    const m = machine();
    openUnit(m);
    let toolCall = 0;
    for (let second = 1; second <= 400 && !m.of("abort").length; second += 1) {
      m.advance(1_000);
      if (second % 7 === 0) {
        toolCall += 1;
        m.send({ type: "tool.start", id: `t${toolCall}`, name: "call_connection_tool", write: false, top: true, facts: facts([user(second * 1_000)]) });
        m.send({ type: "tool.end", id: `t${toolCall}` });
      }
      const queued = second >= 60 ? [user(second * 1_000, { count: second >= 120 ? 3 : 1 })] : [user(second * 1_000)];
      m.send({ type: "budget.check", facts: facts(queued) });
    }
    expect(m.of("remind.yellow")).toEqual([expect.objectContaining({ reason: "tool_calls" })]);
    expect(m.of("abort")).toEqual([{ type: "abort", reason: { kind: "budget" } }]);
    expect(m.now - 1_000_000).toBe(150_000);
    m.send({ type: "prompt.returned", limits: LIMITS });
    expect(m.of("redline.handoff")).toHaveLength(1);
  });
});
