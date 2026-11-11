// 工具不听中止时，这一步也要停得下来（.scratch/tool-occupancy/spec.md L1，2026-11-10）。
//
// pi 的对话循环对每个工具只做一次 await tool.execute(id, args, signal, onUpdate)（pi-agent-core 的
// executePreparedToolCall）。工具不理 signal，这一步就结束不了；session.abort() 等 pi 空闲，也跟着挂住。
// 2026-11-10 那一次：run_on_host 在前台下载 3.2 GB，红线到点中止（abort reason=budget），5 秒后 abort.stuck，
// 用户的插话排在后面十几分钟。Lead 的 80 个自定义工具里只有 2 个接收 signal，大多只读写数据库，几毫秒就返回，平时看不出来。
//
// 这里给会话里的每个工具包一层，不靠工具自己听 signal：
//   · 工具在中止以前返回：原样交给 pi。
//   · 这一步被中止：给工具 graceMs 去响应 signal。宽限内返回的，原样交给 pi。
//   · 过了宽限还没返回：马上给 pi 一个结果（「它还在跑，转到后台：作业 #id」），这一步就能结束。工具本身接着跑，
//     结束时它的结果经 LeadBackgroundJobs 交回 Lead（daemon 写一条叫醒 Lead 的收件箱）。工作不丢（spec I3）。
//
// 包在 agent.state.tools 上：Lead 的自定义工具、hands.ts 换过的 bash/edit/write、pi 的内置工具、SoL-Pi 和扩展注册的
// 工具都从这里进 pi 的对话循环。pi 每次换工具表（setActiveToolsByName、扩展重载）都写 agent.state.tools，所以包在
// 它的 setter 上，新的工具进来时也包上。
import { newBackgroundJobId, toolResultText, type LeadBackgroundJob, type LeadBackgroundJobs } from "./background-jobs.js";

export const LEAD_TOOL_ABORT_GRACE_MS_ENV = "PLC_LEAD_TOOL_ABORT_GRACE_MS";
// 调度器等中止落地的宽限是 5 秒（scheduler/runtime.ts 的 DEFAULT_ABORT_GRACE_MS），这里要比它短，留出 pi 收尾的时间。
export const DEFAULT_TOOL_ABORT_GRACE_MS = 2_000;

export function toolAbortGraceMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_TOOL_ABORT_GRACE_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_ABORT_GRACE_MS;
}

const GUARDED = Symbol.for("plc.lead.toolAbortGuard");

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };

export interface ToolAbortGuardOptions {
  graceMs?: number;
  // daemon 给的出口：过了宽限还在跑的工具记成后台作业，结束时把结果交给 Lead。不给时只写日志。
  jobs?: LeadBackgroundJobs;
  log?: (line: string) => void;
  now?: () => number;
}

/** 这个工具已经包过了吗（测试和 session.ts 的自检用）。 */
export function isAbortGuarded(tool: unknown): boolean {
  return Boolean(tool && typeof tool === "object" && (tool as Record<symbol, unknown>)[GUARDED]);
}

function summaryOf(params: unknown): string {
  if (params && typeof params === "object") {
    const command = (params as { command?: unknown }).command;
    if (typeof command === "string") return command.slice(0, 300);
  }
  try {
    return (JSON.stringify(params) ?? "").slice(0, 300);
  } catch {
    return "";
  }
}

/** 给一个工具包上中止兜底。已经包过的原样返回。 */
export function guardToolAbort<T extends { name: string; execute: (...args: any[]) => any }>(tool: T, options: ToolAbortGuardOptions = {}): T {
  if (isAbortGuarded(tool)) return tool;
  const now = options.now ?? Date.now;
  const original = tool.execute;
  const execute = (toolCallId: string, params: unknown, signal?: AbortSignal, ...rest: unknown[]): Promise<unknown> => {
    const started = now();
    // 同步调用工具（和 pi 一样），它挂 abort 监听的时机不变；同步抛的错也变成 rejected。
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(original.call(tool, toolCallId, params, signal, ...rest));
    } catch (error) {
      running = Promise.reject(error);
    }
    if (!signal) return running;
    type Outcome = { value: unknown } | { error: unknown };
    const settled: Promise<Outcome> = running.then((value) => ({ value }), (error: unknown) => ({ error }));
    const unwrap = (outcome: Outcome): unknown => {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    };
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: Outcome) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        try {
          resolve(unwrap(outcome));
        } catch (error) {
          reject(error);
        }
      };
      const detach = () => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        const job: LeadBackgroundJob = {
          id: newBackgroundJobId(), tool: tool.name, command: summaryOf(params), toolCallId, softMs: now() - started,
        };
        options.log?.(`[sched] tool.detached tool=${tool.name} call=${toolCallId} job=${job.id} ms=${job.softMs}`);
        options.jobs?.started(job);
        void settled.then((outcome) => {
          const failed = "error" in outcome;
          const text = failed
            ? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
            : toolResultText(outcome.value as ToolResult);
          options.log?.(`[sched] tool.detached_end tool=${tool.name} job=${job.id} ms=${now() - started} error=${failed}`);
          options.jobs?.finished({ ...job, text, isError: failed || Boolean((outcome as { value?: ToolResult }).value?.isError), ms: now() - started });
        });
        resolve({
          content: [{
            type: "text",
            text: `这一步被系统中止了，${tool.name} 过了 ${Math.round(job.softMs / 1_000)} 秒还没结束，它没有停：转到后台，作业 ${job.id}。`
              + (options.jobs ? "它结束时系统会叫醒你，把结果交给你。" : "")
              + "不要再调一次同样的调用；它做的事可能已经做了一部分。",
          }],
          details: { backgroundJob: job.id, detached: true },
        });
      };
      const onAbort = () => {
        if (done || timer) return;
        timer = setTimeout(detach, options.graceMs ?? toolAbortGraceMs());
      };
      void settled.then(finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return { ...tool, execute, [GUARDED]: true } as T;
}

/**
 * 给 pi 会话的 agent 装上中止兜底：现在的工具表包一遍，以后每次换工具表（写 agent.state.tools）都包上新的。
 * 和 step-interrupt.ts 一样直接动 pi Agent 的成员：agent.state 是 pi-agent-core 的 createMutableAgentState 建的普通对象，
 * tools 是它的 getter/setter。
 */
export function installToolAbortGuard(agent: { state: { tools: any[] } }, options: ToolAbortGuardOptions = {}): void {
  const state = agent.state as Record<string, any>;
  const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
  if (!descriptor?.get || !descriptor.set) throw new Error("pi agent.state.tools 不是 getter/setter，工具中止兜底装不上");
  const get = descriptor.get.bind(state);
  const set = descriptor.set.bind(state);
  const wrap = (tools: any[]) => tools.map((tool) => guardToolAbort(tool, options));
  Object.defineProperty(state, "tools", {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get,
    set: (next: any[]) => set(wrap(next)),
  });
  set(wrap(get()));
}
