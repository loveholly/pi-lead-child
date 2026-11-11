// 工具中止兜底的决策边界（tool-abort-guard.ts，.scratch/tool-occupancy/spec.md L1）：工具先返回、宽限内响应中止、
// 过了宽限还不返回三种结局；以及 run_on_host 用的「中止时停掉还是转后台」（background-jobs.ts 的 detachOnAbort）。
import { describe, expect, it } from "vitest";
import {
  detachOnAbort, ForegroundWaits, runWithSoftLimit, type LeadBackgroundJob, type LeadBackgroundJobs,
} from "../src/background-jobs.js";
import { guardToolAbort, installToolAbortGuard, isAbortGuarded } from "../src/tool-abort-guard.js";

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };
const result = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
const textOf = (value: unknown) => ((value as Result).content ?? []).map((part) => part.text ?? "").join("");

function recorder() {
  const started: LeadBackgroundJob[] = [];
  const finished: Array<LeadBackgroundJob & { text: string; isError: boolean; ms: number }> = [];
  const jobs: LeadBackgroundJobs = { started: (job) => { started.push(job); }, finished: (job) => { finished.push(job); } };
  return { jobs, started, finished };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("guardToolAbort", () => {
  it("passes the result through when the tool returns before any abort", async () => {
    const tool = guardToolAbort({ name: "quick", execute: async (..._args: unknown[]) => result("好了") }, { graceMs: 50 });
    expect(textOf(await tool.execute("c1", {}, new AbortController().signal))).toBe("好了");
  });

  it("passes the error through when the tool throws before any abort", async () => {
    const tool = guardToolAbort({ name: "broken", execute: async (..._args: unknown[]) => { throw new Error("坏了"); } }, { graceMs: 50 });
    await expect(tool.execute("c1", {}, new AbortController().signal)).rejects.toThrow("坏了");
  });

  it("calls the tool as is when pi gives no signal", async () => {
    const tool = guardToolAbort({ name: "plain", execute: async (_id: string, params: { n: number }) => result(String(params.n + 1)) });
    expect(textOf(await tool.execute("c1", { n: 1 }))).toBe("2");
  });

  it("keeps the tool's own answer when it stops within the grace after an abort", async () => {
    const { jobs, started } = recorder();
    const tool = guardToolAbort({
      name: "listens",
      execute: (_id: string, _params: unknown, signal: AbortSignal) => new Promise<Result>((resolve) => {
        signal.addEventListener("abort", () => resolve(result("停下了")), { once: true });
      }),
    }, { graceMs: 200, jobs });
    const controller = new AbortController();
    const running = tool.execute("c1", {}, controller.signal);
    controller.abort();
    expect(textOf(await running)).toBe("停下了");
    expect(started).toEqual([]);
  });

  it("ends the step after the grace when the tool ignores the abort, and hands the late result back as a background job", async () => {
    const { jobs, started, finished } = recorder();
    const lines: string[] = [];
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "deaf", execute: (..._args: unknown[]) => late.promise }, { graceMs: 30, jobs, log: (line) => lines.push(line) });
    const controller = new AbortController();
    const running = tool.execute("call-7", { command: "softwareupdate -d x" }, controller.signal);
    controller.abort();
    const answer = await running as Result;
    expect(textOf(answer)).toContain("转到后台");
    expect(answer.details).toMatchObject({ detached: true, backgroundJob: started[0]!.id });
    expect(started[0]).toMatchObject({ tool: "deaf", toolCallId: "call-7", command: "softwareupdate -d x" });
    expect(lines.some((line) => line.startsWith("[sched] tool.detached tool=deaf"))).toBe(true);

    late.resolve(result("下载完了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]).toMatchObject({ id: started[0]!.id, text: "下载完了", isError: false });
  });

  it("reports a late failure of a detached tool as an error", async () => {
    const { jobs, finished } = recorder();
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "deaf", execute: (..._args: unknown[]) => late.promise }, { graceMs: 10, jobs });
    const controller = new AbortController();
    controller.abort();
    await tool.execute("c1", {}, controller.signal);
    late.reject(new Error("磁盘满了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]).toMatchObject({ text: "磁盘满了", isError: true });
  });

  it("wraps a tool once, and keeps its name, description and parameters", () => {
    const original = { name: "t", description: "说明", parameters: { type: "object" }, execute: async () => result("") };
    const once = guardToolAbort(original);
    expect(isAbortGuarded(original)).toBe(false);
    expect(isAbortGuarded(once)).toBe(true);
    expect(guardToolAbort(once)).toBe(once);
    expect(once).toMatchObject({ name: "t", description: "说明", parameters: { type: "object" } });
  });
});

describe("installToolAbortGuard", () => {
  it("wraps the current tools and every tool list set later", () => {
    let tools: any[] = [{ name: "a", execute: async () => result("") }];
    const agent = { state: { get tools() { return tools; }, set tools(next: any[]) { tools = next.slice(); } } };
    installToolAbortGuard(agent);
    expect(agent.state.tools.every(isAbortGuarded)).toBe(true);
    agent.state.tools = [{ name: "b", execute: async () => result("") }, ...agent.state.tools];
    expect(agent.state.tools.map((tool) => [tool.name, isAbortGuarded(tool)])).toEqual([["b", true], ["a", true]]);
  });
});

describe("stopping or detaching a host command when the step is aborted", () => {
  it("stops it for the user's /stop, the shutdown drain and an unknown cause, and detaches it for the scheduler's own aborts", () => {
    expect(detachOnAbort(null)).toBe(false);
    expect(detachOnAbort({ kind: "user_stop" })).toBe(false);
    expect(detachOnAbort({ kind: "drain" })).toBe(false);
    expect(detachOnAbort({ kind: "budget" })).toBe(true);
    expect(detachOnAbort({ kind: "preempt", by: "user" })).toBe(true);
    expect(detachOnAbort({ kind: "handoff_timeout" })).toBe(true);
    expect(detachOnAbort({ kind: "stage_timeout", stage: "C" })).toBe(true);
    expect(detachOnAbort({ kind: "idle_yield", by: "L0" })).toBe(true);
  });

  it("detaches at once when detachOnAbort says so, without stopping the job", async () => {
    const { jobs, started, finished } = recorder();
    const step = new AbortController();
    let jobSignal: AbortSignal | null = null;
    const late = deferred<Result>();
    const running = runWithSoftLimit({
      softMs: 60_000, stepSignal: step.signal, jobs, detachOnAbort: () => true,
      job: { id: "job_x", tool: "run_on_host", command: "sleep", toolCallId: "c1" },
      run: (signal) => { jobSignal = signal; return late.promise; },
    });
    step.abort();
    const answer = await running;
    expect(textOf(answer)).toContain("这一步被系统停下了，命令没有停");
    expect(jobSignal!.aborted).toBe(false);
    expect(started).toHaveLength(1);
    late.resolve(result("做完了"));
    await expect.poll(() => finished.length).toBe(1);
  });

  it("stops the job when detachOnAbort says no", async () => {
    const { jobs, started } = recorder();
    const step = new AbortController();
    const answer = runWithSoftLimit({
      softMs: 60_000, stepSignal: step.signal, jobs, detachOnAbort: () => false,
      job: { id: "job_y", tool: "run_on_host", command: "sleep", toolCallId: "c1" },
      run: (signal) => new Promise<Result>((resolve) => {
        signal.addEventListener("abort", () => resolve(result("停掉了")), { once: true });
      }),
    });
    step.abort();
    expect(textOf(await answer)).toBe("停掉了");
    expect(started).toEqual([]);
  });
});

describe("moving a waiting call to the background when the user steers in", () => {
  it("detaches at once without stopping the job, and says the user steered in", async () => {
    const { jobs, started, finished } = recorder();
    const waits = new ForegroundWaits();
    let jobSignal: AbortSignal | null = null;
    const late = deferred<Result>();
    const running = runWithSoftLimit({
      softMs: 60_000, jobs, waits,
      job: { id: "job_s", tool: "run_on_host", command: "sleep", toolCallId: "c1" },
      run: (signal) => { jobSignal = signal; return late.promise; },
    });
    expect(waits.detachAll()).toBe(1);
    const answer = await running;
    expect(textOf(answer)).toContain("用户插话了，命令没有停");
    expect(jobSignal!.aborted).toBe(false);
    expect(started).toHaveLength(1);
    late.resolve(result("做完了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(waits.detachAll()).toBe(0);
  });

  it("leaves a call that already returned alone", async () => {
    const { jobs, started } = recorder();
    const waits = new ForegroundWaits();
    const answer = await runWithSoftLimit({
      softMs: 60_000, jobs, waits,
      job: { id: "job_q", tool: "bash", command: "ls", toolCallId: "c1" },
      run: async () => result("很快"),
    });
    expect(textOf(answer)).toBe("很快");
    expect(waits.detachAll()).toBe(0);
    expect(started).toEqual([]);
  });
});
