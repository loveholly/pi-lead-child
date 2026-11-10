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
//
// P2（交接）加了三件事，都由 daemon 通过 hooks 给：
//   · 交接包里「做过的步骤」：顶层的 tool_execution_start、tool_execution_end 报给 hooks.work（handoffs.ts）。
//   · 每一步的预算状态（D3）：一步调了工具时，在 turn_end 里发一条不显示的自定义消息（pi.sendMessage，triggerTurn=false）。
//     pi 在这一步的工具结果都进了会话以后把它接在后面，发给模型时是一段用户内容。它存进会话：下一次请求的前缀不变，
//     提示缓存照常命中。临时加在上下文末尾（context 钩子）的一行每一步都不同，pi 只在最后一条消息上打缓存标记，
//     那样每一步都要重读整段对话；附在工具结果里又会让界面和读结果的代码看到它。没调工具的一步（最后的回答）不发：
//     多一条消息会让这次运行多调一次模型。
//   · 让出点（D3、D4）：第二步起的 turn_start（工具结果回来以后、下一次模型请求之前）叫 hooks.yieldPoint，
//     调度器在这里决定要不要停下这一轮、请 Lead 交接。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { redLineGateExtension } from "../red-line.js";
import type { LeadSchedulerRuntime, LeadStageInfo } from "./runtime.js";

export const STAGE_A_WARN_MS = 10_000;
// 等模型的第一段输出（B1、B2）等过这么久：记一条「模型回复慢」（D7、S8c）。这不算卡死，不中止。
export const STAGE_B_SLOW_MS = 30_000;
export const STAGE_B_SLOW_MS_ENV = "PLC_LEAD_MODEL_SLOW_MS";

export interface LeadSchedulerExtensionOptions {
  // daemon 的日志（同步写）。不给时不写日志，只写会话文件。
  log?: (line: string) => void;
  // 一行说明宿主现在的负载（core 的 describeHostLoad）。阶段 A 超时的日志附上它。
  hostLoad?: () => string;
  // 这一步在回答哪一轮（关联编号）。
  turnId?: () => string | null;
  stageAWarnMs?: number;
  stageBSlowMs?: number;
  now?: () => number;
  // daemon 的调度器（runtime.ts）：单元编号、阶段、会话文件里的调度记录、阶段 A 超时的事件。不给时只记阶段。
  scheduler?: Pick<LeadSchedulerRuntime, "unit" | "noteStage" | "bindSessionRecorder" | "unbindSessionRecorder" | "noteStageSlow">;
  // 红线以后这一轮能用的工具（red-line.ts）；没有限制时为 null。
  toolGate?: () => ReadonlySet<string> | null;
  // P2：交接的钩子（daemon 给）。
  hooks?: LeadSchedulerHooks;
}

export interface LeadSchedulerHooks {
  // 这个单元做过的步骤（交接包，handoffs.ts）。
  work?: { toolStart(call: { id: string; tool: string; args: unknown }): void; toolEnd(call: { id: string; result: unknown; error: boolean }): void };
  // 每一步的预算状态（D3）：一行字，接在一步的工具结果后面。没有在做的单元时为 null。
  budgetStatus?: () => string | null;
  // 让出点：第 step 步就要开始（step ≥ 2）。
  yieldPoint?: (step: number) => void;
  // P3：这一步现在的状态变了（D11）：等模型等过了 30 秒是 model_slow，有了第一段输出或者这一步结束时是 null。
  stepStatus?: (status: { kind: "model_slow"; since: number } | null) => void;
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
  // 这一步的模型回复里有几个顶层工具调用（有调用时 turn_end 发预算状态）。
  toolCalls: number;
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
  bSlow: boolean;
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

    // 钩子出错不影响这一步。
    const hook = (call: () => void) => {
      try { call(); } catch (error) { log(`[sched] hook.failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
    };
    const clearStageATimer = () => {
      if (stageATimer) clearTimeout(stageATimer);
      stageATimer = null;
    };
    // 模型回复慢（P3，D7 的 B2、S8c）：请求发出以后 slowMs 还没有第一段输出，记一条，带上已经等了多久。不中止：
    // 经过代理时响应头要等模型想完才回（P0 的发现），B1 和 B2 一起算。
    const envSlow = Number(process.env[STAGE_B_SLOW_MS_ENV]);
    const slowMs = options.stageBSlowMs ?? (Number.isFinite(envSlow) && envSlow > 0 ? envSlow : STAGE_B_SLOW_MS);
    let stageBTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStageBTimer = () => {
      if (stageBTimer) clearTimeout(stageBTimer);
      stageBTimer = null;
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
      clearStageBTimer();
      // 这一步一直没等到输出就结束了（中止、出错）：界面上的「模型回复慢」撤掉。
      if (state.bSlow) {
        state.bSlow = false;
        hook(() => options.hooks?.stepStatus?.(null));
      }
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
        tools: new Map(), toolTimes: [], aWarned: false, bSlow: false, toolCalls: 0,
      };
      current = state;
      stage(state, "A");
      // 让出点（P2）：上一批工具的结果回来了，这一步的模型请求还没发。
      if (state.step >= 2) hook(() => options.hooks?.yieldPoint?.(state.step));
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
      clearStageBTimer();
      stageBTimer = setTimeout(() => {
        stageBTimer = null;
        if (current !== state || state.firstOutputAt !== null || state.requestAt === null) return;
        state.bSlow = true;
        const waited = now() - state.requestAt;
        const unit = unitId();
        const where = state.responseAt === null ? "B1" : "B2";
        log(`[sched] stage.slow stage=B${unit !== undefined ? ` unit=${unit ?? "-"}` : ""} run=${run} step=${state.step} turn=${turnId() ?? "-"} at=${where} waitedMs=${waited} thresholdMs=${slowMs} model_slow=true stall=false`);
        record({ kind: "stage_slow", stage: "B", at: new Date().toISOString(), run, step: state.step, waitedMs: waited, where });
        if (unit) scheduler?.noteStageSlow({ unitId: unit, turnId: turnId(), stage: "B", step: state.step, waitedMs: waited, thresholdMs: slowMs, where });
        const since = state.requestAt;
        hook(() => options.hooks?.stepStatus?.({ kind: "model_slow", since }));
      }, slowMs);
      stageBTimer.unref?.();
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
        clearStageBTimer();
        if (state.bSlow && state.requestAt !== null) {
          log(`[sched] stage.over stage=B run=${run} step=${state.step} turn=${turnId() ?? "-"} ms=${at - state.requestAt} thresholdMs=${slowMs}`);
          state.bSlow = false;
          hook(() => options.hooks?.stepStatus?.(null));
        }
        stage(state, "C");
      } else if (state.lastOutputAt !== null) state.maxGapMs = Math.max(state.maxGapMs, at - state.lastOutputAt);
      state.lastOutputAt = at;
    });

    pi.on("message_end", (event) => {
      const state = current;
      const message = event.message as { role?: string; stopReason?: string; content?: Array<{ type?: string }> };
      if (!state || message.role !== "assistant") return;
      state.modelEndAt = now();
      state.toolCalls = Array.isArray(message.content) ? message.content.filter((block) => block?.type === "toolCall").length : 0;
      if (message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse") state.stop = message.stopReason;
    });

    pi.on("tool_execution_start", (event) => {
      if (event.parentToolCallId) return;
      current?.tools.set(event.toolCallId, { name: event.toolName, startedAt: now() });
      stage(current, "tool", event.toolName);
      hook(() => options.hooks?.work?.toolStart({ id: event.toolCallId, tool: event.toolName, args: event.args }));
    });


    pi.on("tool_execution_end", (event) => {
      const state = current;
      if (!state || event.parentToolCallId) return;
      const started = state.tools.get(event.toolCallId);
      state.tools.delete(event.toolCallId);
      const ms = typeof event.durationMs === "number" ? Math.round(event.durationMs) : started ? now() - started.startedAt : 0;
      state.toolTimes.push({ name: event.toolName, ms, error: Boolean(event.isError) });
      hook(() => options.hooks?.work?.toolEnd({ id: event.toolCallId, result: event.result, error: Boolean(event.isError) }));
    });

    pi.on("turn_end", (event) => {
      const state = current;
      current = null;
      if (state) finishStep(state);
      // 每一步的预算状态（D3）：这一步调了工具，运行会接着调模型，这一行接在工具结果后面。
      const results = (event as { toolResults?: unknown[] }).toolResults;
      if (!options.hooks?.budgetStatus || !Array.isArray(results) || !results.length) return;
      let line: string | null = null;
      try { line = options.hooks.budgetStatus(); } catch { line = null; }
      if (!line) return;
      try {
        pi.sendMessage({ customType: "plc-budget", content: line, display: false }, { triggerTurn: false });
      } catch { /* 会话已经关了 */ }
    });

    pi.on("agent_end", () => {
      const state = current;
      current = null;
      if (state) finishStep(state);
    });

    pi.on("session_shutdown", () => {
      clearStageATimer();
      clearStageBTimer();
      scheduler?.unbindSessionRecorder(record);
    });
  };
}
