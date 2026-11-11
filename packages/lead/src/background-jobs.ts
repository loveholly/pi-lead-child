// 长的只读工具转后台（lead-scheduler spec D6，P3）。
//
// 只读或幂等的命令（Lead 在 bash 上标 read_only：grep、find、跑测试、构建、读外部系统）超过软时限（缺省 20 秒）还没结束：
// 先给 Lead 返回「还在跑，作业 #id，结束会叫醒你」，这一步就此结束。命令继续在它的子进程里跑，结束后 daemon 把输出作为
// 一件事交给 Lead（走原单元的车道）。这一步结束了，所以在这期间用户的插话能送到，下一个让出点也能来。
// 有副作用的命令不转后台，保持原来的硬时限（hands.ts 的 LEAD_BASH_DEFAULT_TIMEOUT_SECONDS）：转后台以后它的结果没人等，
// 半途出错也没人收拾。
// 以前到了时限会杀掉命令，已经做的工作也丢了；转后台以后工作能保住。
import type { LeadAbortReason } from "./scheduler/controller.js";

export const LEAD_BASH_SOFT_MS_ENV = "PLC_LEAD_BASH_SOFT_MS";
export const DEFAULT_BASH_SOFT_MS = 20_000;
// 转后台的命令最多跑多久（没填 timeout 时）。
export const DEFAULT_BACKGROUND_JOB_MAX_SECONDS = 30 * 60;

export function bashSoftLimitMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_BASH_SOFT_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASH_SOFT_MS;
}

// 免沙箱时直接跑的 run_on_host 的软时限（.scratch/tool-occupancy/spec.md L4）。它在用户的 Mac 上跑，常常是下载、
// brew 升级这类几分钟的事：超过软时限就转后台，这一步结束，结果以后交回 Lead。
export const LEAD_TOOL_SOFT_MS_ENV = "PLC_LEAD_TOOL_SOFT_MS";

export function toolSoftLimitMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_TOOL_SOFT_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASH_SOFT_MS;
}

/**
 * 这一步被中止时，正在跑的命令是停掉还是转后台（.scratch/tool-occupancy/spec.md L4）。用户 /stop、停机排空、
 * 原因不明时停掉。调度器为了把 Lead 空出来而中止（红线、抢占、阶段超时、交接窗口到点、空闲车道让路）时转后台：
 * 这件事没有被取消，停掉它只会让已经做的工作白做，有副作用的命令还会停在一半。
 */
export function detachOnAbort(reason: LeadAbortReason | null): boolean {
  if (!reason) return false;
  return reason.kind !== "user_stop" && reason.kind !== "drain";
}

export interface LeadBackgroundJob {
  id: string;
  tool: string;
  command: string;
  toolCallId: string;
  // 转后台时已经跑了多久。
  softMs: number;
}

/** daemon 给的出口：记下转后台的作业，作业结束时把结果交给 Lead。 */
export interface LeadBackgroundJobs {
  started(job: LeadBackgroundJob): void;
  finished(job: LeadBackgroundJob & { text: string; isError: boolean; ms: number }): void;
}

let jobCounter = 0;
export function newBackgroundJobId(): string {
  jobCounter += 1;
  return `job_${Date.now().toString(36)}${jobCounter.toString(36).padStart(3, "0")}`;
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };

/** 结果的文字（pi 的工具结果是几段文字）。 */
export function toolResultText(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

/**
 * 跑一个只读的工具调用，到了软时限还没结束就转后台。run 拿到作业自己的中止信号（不是这一步的）：转后台以后这一步结束、
 * 被中止都不影响它；转后台之前这一步被中止，缺省作业跟着中止。detachOnAbort 返回 true 时（调度器为了空出 Lead 而中止，
 * 见 detachOnAbort），作业不停，马上转后台。
 */
export async function runWithSoftLimit(options: {
  softMs: number;
  stepSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<ToolResult>;
  job: Omit<LeadBackgroundJob, "softMs">;
  jobs: LeadBackgroundJobs;
  detachOnAbort?: () => boolean;
  // 用户插话时马上转后台（ForegroundWaits.detachAll）。
  waits?: ForegroundWaits;
  now?: () => number;
}): Promise<ToolResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let backgrounded = false;
  let detach: ((why: "detach" | "steer") => void) | undefined;
  const detached = new Promise<"detach" | "steer">((resolve) => { detach = resolve; });
  const onStepAbort = () => {
    if (backgrounded) return;
    if (options.detachOnAbort?.()) detach?.("detach");
    else controller.abort();
  };
  options.stepSignal?.addEventListener("abort", onStepAbort, { once: true });
  if (options.stepSignal?.aborted) onStepAbort();
  const leaveWaits = options.waits?.add(() => detach?.("steer"));
  const running = options.run(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soft = new Promise<"soft">((resolve) => { timer = setTimeout(() => resolve("soft"), options.softMs); });
  let why: "soft" | "detach" | "steer";
  try {
    const first = await Promise.race([running.then((result) => ({ result }), (error: unknown) => ({ error })), soft, detached]);
    if (typeof first === "object") {
      if ("error" in first) throw first.error;
      return first.result;
    }
    why = first;
  } finally {
    clearTimeout(timer);
    leaveWaits?.();
  }
  backgrounded = true;
  options.stepSignal?.removeEventListener("abort", onStepAbort);
  const job: LeadBackgroundJob = { ...options.job, softMs: now() - started };
  options.jobs.started(job);
  void running.then(
    (result) => options.jobs.finished({ ...job, text: toolResultText(result), isError: Boolean(result.isError), ms: now() - started }),
    (error: unknown) => options.jobs.finished({
      ...job, text: error instanceof Error ? error.message : String(error), isError: true, ms: now() - started,
    }),
  );
  return {
    content: [{
      type: "text",
      text: (why === "detach"
        ? `这一步被系统停下了，命令没有停（已经跑了 ${Math.round(job.softMs / 1_000)} 秒），转到后台：作业 ${job.id}。`
        : why === "steer"
          ? `用户插话了，命令没有停（已经跑了 ${Math.round(job.softMs / 1_000)} 秒），转到后台：作业 ${job.id}。先回应用户的插话。`
          : `命令跑了 ${Math.round(job.softMs / 1_000)} 秒还没结束，已经转到后台：作业 ${job.id}。`)
        + "它结束时系统会叫醒你，把输出交给你。现在可以先做别的、先回用户一句；不要再跑一遍同一条命令。",
    }],
    details: { backgroundJob: job.id },
  };
}

/**
 * 这一步里正在等、能转后台的工具调用（runWithSoftLimit 登记）。用户插话时 daemon 调 detachAll：它们马上转后台，
 * 这一步结束，插话送到 Lead，不用等软时限（.scratch/tool-occupancy/eval-2026-11-10.md：以前插话要 15–18 秒才得到回答）。
 * 命令不停，结果照旧作为后台作业交回 Lead。
 */
export class ForegroundWaits {
  readonly #waits = new Set<() => void>();

  /** 登记一个等着的调用；返回注销函数（调用返回时注销）。 */
  add(detach: () => void): () => void {
    this.#waits.add(detach);
    return () => { this.#waits.delete(detach); };
  }

  /** 让所有等着的调用马上转后台，返回有几个。 */
  detachAll(): number {
    const waits = [...this.#waits];
    this.#waits.clear();
    for (const detach of waits) detach();
    return waits.length;
  }
}
