// Lead 调度器的 pi extension（lead-scheduler spec D7、D12、D13）。P0：记下 Lead 每一步在哪个阶段花了多久。
// P1：每一步带上单元编号；把这一步现在在哪个阶段报给调度器（GET /v1/lead/scheduler）；调度器的记录写进会话文件；
// 红线以后的工具限制（以前是单独的 plc-red-line 扩展）也在这里。
//
// 2026-11-09 Lead 卡了 9 分 42 秒，会话文件里一条记录都没有，只能从旁证反推它停在发请求之前。所以每一步都记阶段：
//   A  请求前准备：turn_start → before_provider_request。正常 p50 0.12 秒、p99 1.3 秒；超过 10 秒说明宿主被占住了。
//   B1 上传和排队：before_provider_request → after_provider_response。
//   B2 等第一段输出：after_provider_response → 第一个 message_update。模型慢不算卡死。
//   C  流式输出：相邻两个 message_update 之间最长的间隔。
//   工具：tool_execution_start → tool_execution_end，每个工具各记一个耗时。
//
// 记在两个地方（D12）：
//   · daemon 的日志，前缀 [sched]：每一步一行；阶段 A 等过阈值时马上一行，带上宿主的负载（线程池、后台重活）。
//   · 会话文件（appendEntry，类型 scheduler）：每一步结束时一条，和对话记录放在一起。
// 日志用同步写：daemon 的 log 写文件，appendEntry 用 appendFileSync，都不经过 I/O 线程池。只记数字、工具名和编号，不记原文。
//
// 阶段 A 的计时器在主线程上：线程池被占满时主线程是空闲的，计时器照常触发。主线程本身被卡住时由 daemon 的
// worker 心跳发现（core 的 host-probes.ts）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { redLineGateExtension } from "../red-line.js";
import type { LeadSchedulerRuntime, LeadStageInfo } from "./runtime.js";

export const STAGE_A_WARN_MS = 10_000;

export interface LeadSchedulerExtensionOptions {
  // daemon 的日志（同步写）。不给时不写日志，只写会话文件。
  log?: (line: string) => void;
  // 一行说明宿主现在的负载（core 的 describeHostLoad）。阶段 A 超时的日志附上它。
  hostLoad?: () => string;
  // 这一步在回答哪一轮（关联编号）。
  turnId?: () => string | null;
  stageAWarnMs?: number;
  now?: () => number;
  // daemon 的调度器（runtime.ts）：单元编号、阶段、会话文件里的调度记录、阶段 A 超时的事件。不给时只记阶段。
  scheduler?: Pick<LeadSchedulerRuntime, "unit" | "noteStage" | "bindSessionRecorder" | "unbindSessionRecorder" | "noteStageSlow">;
  // 红线以后这一轮能用的工具（red-line.ts）；没有限制时为 null。
  toolGate?: () => ReadonlySet<string> | null;
}

export interface LeadStepTiming {
  run: number;
  step: number;
  turnId: string | null;
  // 调度器的单元编号（关联编号，D12）。没有调度器时为 null。
  unitId?: string | null;
  // 各阶段的毫秒数。这一步没走到那个阶段时为 null。
  a: number | null;
  b1: number | null;
  b2: number | null;
  c: number | null;
  stream: number | null;
  tools: Array<{ name: string; ms: number; error: boolean }>;
  totalMs: number;
  stop: string | null;
  status: number | null;
}

interface StepState {
  step: number;
  startedAt: number;
  requestAt: number | null;
  responseAt: number | null;
  status: number | null;
  firstOutputAt: number | null;
  lastOutputAt: number | null;
  maxGapMs: number;
  modelEndAt: number | null;
  stop: string | null;
  tools: Map<string, { name: string; startedAt: number }>;
  toolTimes: Array<{ name: string; ms: number; error: boolean }>;
  aWarned: boolean;
}

function field(value: number | null): number | string {
  return value === null ? "-" : value;
}

/** 一步的 [sched] 日志行。 */
export function stepLine(timing: LeadStepTiming): string {
  const tools = timing.tools.length
    ? timing.tools.map((tool) => `${tool.name}:${tool.ms}${tool.error ? "!" : ""}`).join(",")
    : "-";
  return [
    "[sched] step",
    ...(timing.unitId !== undefined ? [`unit=${timing.unitId ?? "-"}`] : []),
    `run=${timing.run}`, `step=${timing.step}`, `turn=${timing.turnId ?? "-"}`,
    `A=${field(timing.a)}`, `B1=${field(timing.b1)}`, `B2=${field(timing.b2)}`, `C=${field(timing.c)}`,
    `stream=${field(timing.stream)}`, `tools=${tools}`, `total=${timing.totalMs}`,
    ...(timing.stop ? [`stop=${timing.stop}`] : []),
    ...(timing.status !== null && timing.status !== 200 ? [`status=${timing.status}`] : []),
  ].join(" ");
}

export function leadSchedulerExtension(options: LeadSchedulerExtensionOptions = {}): ExtensionFactory {
  const now = options.now ?? Date.now;
  const warnMs = options.stageAWarnMs ?? STAGE_A_WARN_MS;
  const log = options.log ?? (() => {});
  return (pi) => {
    let run = 0;
    let stepInRun = 0;
    let current: StepState | null = null;
    let stageATimer: ReturnType<typeof setTimeout> | null = null;

    const clearStageATimer = () => {
      if (stageATimer) clearTimeout(stageATimer);
      stageATimer = null;
    };
    const turnId = () => {
      try { return options.turnId?.() ?? null; } catch { return null; }
    };
    const hostLoad = () => {
      try { return options.hostLoad?.() ?? "probes=off"; } catch { return "probes=unavailable"; }
    };
    const record = (data: Record<string, unknown>) => {
      try { pi.appendEntry("scheduler", data); } catch { /* 会话已经关了 */ }
    };
    const scheduler = options.scheduler;
    const unitId = () => (scheduler ? scheduler.unit?.id ?? null : undefined);
    const stage = (step: StepState | null, name: LeadStageInfo["stage"], tool?: string) => {
      if (!scheduler) return;
      try {
        scheduler.noteStage(step ? { run, step: step.step, stage: name, since: now(), ...(tool ? { tool } : {}) } : null);
      } catch { /* 调度器不可用不影响这一步 */ }
    };
    // 调度器的记录（单元的开始和结束、决定、中止）写进会话文件，和对话记录放在一起（D12）。
    scheduler?.bindSessionRecorder(record);
    // 红线以后这一轮只能用交接的工具（以前是单独的 plc-red-line 扩展）。
    if (options.toolGate) redLineGateExtension(options.toolGate, log)(pi);

    const finishStep = (state: StepState) => {
      clearStageATimer();
      const end = now();
      const unit = unitId();
      const timing: LeadStepTiming = {
        run, step: state.step, turnId: turnId(), ...(unit !== undefined ? { unitId: unit } : {}),
        a: state.requestAt === null ? null : state.requestAt - state.startedAt,
        b1: state.requestAt === null || state.responseAt === null ? null : state.responseAt - state.requestAt,
        b2: state.responseAt === null || state.firstOutputAt === null ? null : state.firstOutputAt - state.responseAt,
        c: state.firstOutputAt === null ? null : state.maxGapMs,
        stream: state.firstOutputAt === null || state.modelEndAt === null ? null : state.modelEndAt - state.firstOutputAt,
        tools: state.toolTimes,
        totalMs: end - state.startedAt,
        stop: state.stop,
        status: state.status,
      };
      log(stepLine(timing));
      record({ kind: "step", ...timing, at: new Date(end).toISOString() });
      stage(null, "idle");
    };

    pi.on("agent_start", () => {
      run += 1;
      stepInRun = 0;
    });

    pi.on("turn_start", () => {
      if (current) finishStep(current);
      stepInRun += 1;
      const state: StepState = {
        step: stepInRun, startedAt: now(), requestAt: null, responseAt: null, status: null,
        firstOutputAt: null, lastOutputAt: null, maxGapMs: 0, modelEndAt: null, stop: null,
        tools: new Map(), toolTimes: [], aWarned: false,
      };
      current = state;
      stage(state, "A");
      clearStageATimer();
      stageATimer = setTimeout(() => {
        stageATimer = null;
        if (current !== state || state.requestAt !== null) return;
        state.aWarned = true;
        const waited = now() - state.startedAt;
        const unit = unitId();
        const host = hostLoad();
        log(`[sched] stage.slow stage=A${unit !== undefined ? ` unit=${unit ?? "-"}` : ""} run=${run} step=${state.step} turn=${turnId() ?? "-"} waitedMs=${waited} thresholdMs=${warnMs} ${host}`);
        record({ kind: "stage_slow", stage: "A", run, step: state.step, waitedMs: waited, host, at: new Date().toISOString() });
        // events 表里也记一条（卡死的统计，D12）。
        if (unit) scheduler?.noteStageSlow({ unitId: unit, turnId: turnId(), stage: "A", step: state.step, waitedMs: waited, thresholdMs: warnMs, host });
      }, warnMs);
      stageATimer.unref?.();
    });

    pi.on("before_provider_request", () => {
      const state = current;
      if (!state || state.requestAt !== null) return undefined;
      state.requestAt = now();
      stage(state, "B1");
      clearStageATimer();
      const a = state.requestAt - state.startedAt;
      if (state.aWarned || a >= warnMs) {
        log(`[sched] stage.over stage=A run=${run} step=${state.step} turn=${turnId() ?? "-"} ms=${a} thresholdMs=${warnMs} ${hostLoad()}`);
      }
      return undefined;
    });

    pi.on("after_provider_response", (event) => {
      const state = current;
      if (!state || state.responseAt !== null) return;
      state.responseAt = now();
      state.status = typeof event.status === "number" ? event.status : null;
      stage(state, "B2");
    });

    pi.on("message_update", (event) => {
      const state = current;
      if (!state || (event.message as { role?: string }).role !== "assistant") return;
      const at = now();
      if (state.firstOutputAt === null) {
        state.firstOutputAt = at;
        stage(state, "C");
      } else if (state.lastOutputAt !== null) state.maxGapMs = Math.max(state.maxGapMs, at - state.lastOutputAt);
      state.lastOutputAt = at;
    });

    pi.on("message_end", (event) => {
      const state = current;
      const message = event.message as { role?: string; stopReason?: string };
      if (!state || message.role !== "assistant") return;
      state.modelEndAt = now();
      if (message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse") state.stop = message.stopReason;
    });

    pi.on("tool_execution_start", (event) => {
      if (event.parentToolCallId) return;
      current?.tools.set(event.toolCallId, { name: event.toolName, startedAt: now() });
      stage(current, "tool", event.toolName);
    });

    pi.on("tool_execution_end", (event) => {
      const state = current;
      if (!state || event.parentToolCallId) return;
      const started = state.tools.get(event.toolCallId);
      state.tools.delete(event.toolCallId);
      const ms = typeof event.durationMs === "number" ? Math.round(event.durationMs) : started ? now() - started.startedAt : 0;
      state.toolTimes.push({ name: event.toolName, ms, error: Boolean(event.isError) });
    });

    pi.on("turn_end", () => {
      const state = current;
      current = null;
      if (state) finishStep(state);
    });

    pi.on("agent_end", () => {
      const state = current;
      current = null;
      if (state) finishStep(state);
    });

    pi.on("session_shutdown", () => {
      clearStageATimer();
      scheduler?.unbindSessionRecorder(record);
    });
  };
}
