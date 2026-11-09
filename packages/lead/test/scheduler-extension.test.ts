// Lead 每一步的阶段耗时（lead-scheduler spec D7、D12）。2026-11-09 Lead 在发请求前停了 9 分 42 秒，会话文件里一条
// 记录都没有。现在每一步记 A（请求前准备）、B1、B2、C 和工具的耗时；阶段 A 等过 10 秒时马上记一行，带上宿主的负载。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadSchedulerExtension, stepLine } from "../src/scheduler/extension.js";

type Handler = (event: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ type: string; data: any }> = [];
  const api = {
    on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  };
  const emit = (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event });
  };
  return { api, emit, entries };
}

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());

function setup(hostLoad = 'pool="waiting 9500ms" loopMax=3ms jobs="worktree-delete#4(item-12, 31s, pid 501)"') {
  const lines: string[] = [];
  const pi = fakePi();
  leadSchedulerExtension({ log: (line) => lines.push(line), hostLoad: () => hostLoad, turnId: () => "turn_a", now: () => clock })(pi.api as never);
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
  return { ...pi, lines, advance };
}

const assistant = (stopReason = "stop") => ({ message: { role: "assistant", stopReason } });

describe("the stage timing of Lead's steps", () => {
  it("records stages A, B1, B2, C and each tool of a step", () => {
    const { emit, lines, entries, advance } = setup();
    emit("agent_start");
    emit("turn_start", { turnIndex: 0, timestamp: clock });
    advance(120);
    emit("before_provider_request", { payload: {} });
    advance(800);
    emit("after_provider_response", { status: 200, headers: {} });
    advance(2_000);
    emit("message_update", assistant());
    advance(300);
    emit("message_update", assistant());
    advance(100);
    emit("message_end", assistant("toolUse"));
    emit("tool_execution_start", { toolCallId: "c1", toolName: "grep", args: {} });
    advance(450);
    emit("tool_execution_end", { toolCallId: "c1", toolName: "grep", result: {}, isError: false, durationMs: 450 });
    emit("turn_end", { turnIndex: 0 });

    expect(lines).toEqual(["[sched] step run=1 step=1 turn=turn_a A=120 B1=800 B2=2000 C=300 stream=400 tools=grep:450 total=3770"]);
    expect(entries).toEqual([{ type: "scheduler", data: expect.objectContaining({
      kind: "step", run: 1, step: 1, turnId: "turn_a", a: 120, b1: 800, b2: 2_000, c: 300,
      tools: [{ name: "grep", ms: 450, error: false }], totalMs: 3_770, stop: null,
    }) }]);
  });

  // 回归 2026-11-09：请求前准备停了将近 10 分钟，没有任何记录。
  it("logs at once when stage A passes 10 seconds, with the host's load, and again when the request goes", () => {
    const { emit, lines, entries, advance } = setup();
    emit("agent_start");
    emit("turn_start", { turnIndex: 0, timestamp: clock });
    advance(9_999);
    expect(lines).toEqual([]);
    advance(1);
    expect(lines).toEqual([
      '[sched] stage.slow stage=A run=1 step=1 turn=turn_a waitedMs=10000 thresholdMs=10000 pool="waiting 9500ms" loopMax=3ms jobs="worktree-delete#4(item-12, 31s, pid 501)"',
    ]);
    expect(entries.map((entry) => entry.data.kind)).toEqual(["stage_slow"]);

    advance(572_000);
    emit("before_provider_request", { payload: {} });
    expect(lines[1]).toMatch(/^\[sched\] stage\.over stage=A run=1 step=1 turn=turn_a ms=582000 thresholdMs=10000 pool=/);
  });

  it("says where an aborted step stopped", () => {
    const { emit, lines, advance } = setup();
    emit("agent_start");
    emit("turn_start", { turnIndex: 0, timestamp: clock });
    advance(50);
    emit("before_provider_request", { payload: {} });
    advance(30_000);
    emit("message_end", assistant("aborted"));
    emit("agent_end", {});
    expect(lines).toEqual(["[sched] step run=1 step=1 turn=turn_a A=50 B1=- B2=- C=- stream=- tools=- total=30050 stop=aborted"]);
  });

  it("counts steps per run and starts again with each run", () => {
    const { emit, lines } = setup();
    emit("agent_start");
    emit("turn_start", {});
    emit("turn_end", {});
    emit("turn_start", {});
    emit("turn_end", {});
    emit("agent_end", {});
    emit("agent_start");
    emit("turn_start", {});
    emit("turn_end", {});
    expect(lines.map((line) => line.match(/run=\d+ step=\d+/)![0])).toEqual(["run=1 step=1", "run=1 step=2", "run=2 step=1"]);
  });

  it("writes a non-200 status into the step line", () => {
    expect(stepLine({
      run: 3, step: 2, turnId: null, a: 100, b1: 400, b2: null, c: null, stream: null, tools: [], totalMs: 500, stop: "error", status: 429,
    })).toBe("[sched] step run=3 step=2 turn=- A=100 B1=400 B2=- C=- stream=- tools=- total=500 stop=error status=429");
  });
});
