// 长的只读工具转后台（lead-scheduler spec D6，P3）。
//
// 只读或幂等的命令（Lead 在 bash 上标 read_only：grep、find、跑测试、构建、读外部系统）超过软时限（缺省 20 秒）还没结束：
// 先给 Lead 返回「还在跑，作业 #id，结束会叫醒你」，这一步就此结束。命令继续在它的子进程里跑，结束后 daemon 把输出作为
// 一件事交给 Lead（走原单元的车道）。这一步结束了，所以在这期间用户的插话能送到，下一个让出点也能来。
// 有副作用的命令不转后台，保持原来的硬时限（hands.ts 的 LEAD_BASH_DEFAULT_TIMEOUT_SECONDS）：转后台以后它的结果没人等，
// 半途出错也没人收拾。
// 以前到了时限会杀掉命令，已经做的工作也丢了；转后台以后工作能保住。
export const LEAD_BASH_SOFT_MS_ENV = "PLC_LEAD_BASH_SOFT_MS";
export const DEFAULT_BASH_SOFT_MS = 20_000;
// 转后台的命令最多跑多久（没填 timeout 时）。
export const DEFAULT_BACKGROUND_JOB_MAX_SECONDS = 30 * 60;

export function bashSoftLimitMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_BASH_SOFT_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASH_SOFT_MS;
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
 * 被中止都不影响它；转后台之前这一步被中止（抢占、/stop），作业跟着中止。
 */
export async function runWithSoftLimit(options: {
  softMs: number;
  stepSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<ToolResult>;
  job: Omit<LeadBackgroundJob, "softMs">;
  jobs: LeadBackgroundJobs;
  now?: () => number;
}): Promise<ToolResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let backgrounded = false;
  const onStepAbort = () => { if (!backgrounded) controller.abort(); };
  options.stepSignal?.addEventListener("abort", onStepAbort, { once: true });
  if (options.stepSignal?.aborted) controller.abort();
  const running = options.run(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soft = new Promise<"soft">((resolve) => { timer = setTimeout(() => resolve("soft"), options.softMs); });
  try {
    const first = await Promise.race([running.then((result) => ({ result }), (error: unknown) => ({ error })), soft]);
    if (first !== "soft") {
      if ("error" in first) throw first.error;
      return first.result;
    }
  } finally {
    clearTimeout(timer);
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
      text: `命令跑了 ${Math.round(job.softMs / 1_000)} 秒还没结束，已经转到后台：作业 ${job.id}。它结束时系统会叫醒你，把输出交给你。`
        + "现在可以先做别的、先回用户一句；不要再跑一遍同一条命令。",
    }],
    details: { backgroundJob: job.id },
  };
}
