// 重活不在 daemon 进程里做（lead-scheduler spec P0、D7、D12）。
//
// 2026-11-09：daemon 用 fs.promises.rm 在后台删一个带 node_modules 的 worktree。Node 的异步 rm 把每个文件的删除都排进
// I/O 线程池（4 个线程），整棵树删完以前，进程里别的异步文件操作和 DNS 解析都要排队。Lead 的会话在同一个进程里，
// 它发请求前的异步操作等了 9–14 分钟。本机实验：后台删 3 万个文件时，读一个 5 字节的文件等到删完才返回。
//
// 所以删整个目录树交给子进程：/bin/rm -rf，macOS 上再用 taskpolicy -b 降低它的 I/O 优先级。子进程不占 daemon 的线程池，
// daemon 只等它退出。正在跑的后台重活登记在这里，探针（host-probes.ts）和 Lead 的阶段日志用它说出卡顿的原因。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export interface HostJob {
  id: number;
  // 种类，例如 worktree-delete、checkout-delete。日志和卡顿说明里用它。
  kind: string;
  // 给人看的对象，例如「workspace #12」。不写消息原文。
  label: string;
  pid: number | null;
  startedAt: number;
}

const jobs = new Map<number, HostJob>();
let nextJobId = 1;
let jobLog: ((line: string) => void) | null = null;

/** daemon 的日志。后台作业的开始和结束各记一行（spec D12 第 11 条）。 */
export function setHostJobLog(sink: ((line: string) => void) | null): void {
  jobLog = sink;
}

/** 正在跑的后台重活，按开始时间排。 */
export function runningHostJobs(): HostJob[] {
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** 一行说明：正在跑哪些后台重活、跑了多久。没有时为 "none"。 */
export function describeHostJobs(now = Date.now()): string {
  const running = runningHostJobs();
  if (!running.length) return "none";
  return running
    .map((job) => `${job.kind}#${job.id}(${job.label}, ${Math.round((now - job.startedAt) / 1_000)}s${job.pid ? `, pid ${job.pid}` : ""})`)
    .join("; ");
}

/** [sched] 日志的一行：事件名加 key=value。有空格或引号的值用 JSON 字符串写。 */
export function schedLine(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = value === null ? "null" : String(value);
      return `${key}=${/^[\w.:#/@+-]*$/.test(text) && text !== "" ? text : JSON.stringify(text)}`;
    });
  return ["[sched]", event, ...parts].join(" ");
}

function startJob(kind: string, label: string): HostJob {
  const job: HostJob = { id: nextJobId++, kind, label, pid: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}

function endJob(job: HostJob, fields: Record<string, string | number | boolean | null>): void {
  jobs.delete(job.id);
  jobLog?.(schedLine("job.end", { id: job.id, kind: job.kind, label: job.label, pid: job.pid, ms: Date.now() - job.startedAt, ...fields }));
}

// 删除的目标必须是一个具体的目录：绝对路径，不是根目录、用户目录或它们的上级，至少三层深。
// rm -rf 交给子进程以后，一个算错的路径就是一次不能撤销的删除，所以这里先挡住明显不对的目标。
export function assertRemovableTree(path: string): string {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("removeTree: the path is empty or invalid");
  if (!isAbsolute(path)) throw new Error(`removeTree: ${path} is not an absolute path`);
  const target = resolve(path);
  const home = resolve(homedir());
  const depth = target.split(sep).filter(Boolean).length;
  if (depth < 3) throw new Error(`removeTree: refusing to remove ${target}: too close to the root`);
  if (target === home || home.startsWith(`${target}${sep}`)) throw new Error(`removeTree: refusing to remove ${target}: the home directory or above it`);
  return target;
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

// I/O 优先级（macOS 的 taskpolicy）：
//   · background：taskpolicy -b，后台策略，I/O 和 CPU 都降到最低。没有人等的删除用它（回收区）。
//     2026-11-09 本机实测，删 3 万个小文件：rm -rf 5.6 秒，taskpolicy -b 51 秒，-d utility 4.9 秒。
//     PLC_BACKGROUND_DELETE_IO=utility 把它换成 utility（测试用它，免得一个删除等将近一分钟）。
//   · utility：taskpolicy -d utility，比交互的 I/O 低一档，但不会被饿着。有人在等的删除用它。
export type TreeDeletePriority = "background" | "utility";

/** 按 I/O 优先级包一层 taskpolicy（macOS）。别的系统上原样返回，io 是 default。 */
export function priorityCommand(
  command: string, args: readonly string[], priority: TreeDeletePriority,
): { command: string; args: string[]; io: TreeDeletePriority | "default" } {
  const effective = priority === "background" && process.env.PLC_BACKGROUND_DELETE_IO === "utility" ? "utility" : priority;
  if (process.platform === "darwin" && existsSync(TASKPOLICY)) {
    const policy = effective === "background" ? ["-b"] : ["-d", "utility"];
    return { command: TASKPOLICY, args: [...policy, command, ...args], io: effective };
  }
  return { command, args: [...args], io: "default" };
}

export function removeTreeCommand(
  target: string, priority: TreeDeletePriority = "background",
): { command: string; args: string[]; io: TreeDeletePriority | "default" } {
  return priorityCommand("/bin/rm", ["-rf", "--", target], priority);
}

export interface RemoveTreeOptions {
  kind?: string;
  label?: string;
  // 缺省 background。有人在等这次删除时传 utility。
  priority?: TreeDeletePriority;
}

/**
 * 在子进程里删一整个目录树（rm -rf），等它退出。目录不在也算成功。daemon 进程里不做任何递归删除。
 * 失败时抛错，错误里带 rm 的最后一段输出。
 */
export async function removeTree(path: string, options: RemoveTreeOptions = {}): Promise<void> {
  const target = assertRemovableTree(path);
  const result = await runHostChild({
    kind: options.kind ?? "tree-delete",
    label: options.label ?? target.split(sep).slice(-2).join(sep),
    command: "/bin/rm", args: ["-rf", "--", target],
    priority: options.priority ?? "background",
  });
  if (result.code !== 0) {
    throw new Error(`rm -rf ${target} exited ${result.code ?? result.signal}: ${result.stderr.trim().slice(-500)}`);
  }
}

// ── 子进程里的后台作业（P0 的删除和 P4 的空闲车道共用）──────────────────────────────────────

export interface HostChildOptions {
  // 种类和给人看的对象，进 job.start、job.end 两行日志和卡顿说明。不写消息原文。
  kind: string;
  label: string;
  command: string;
  args: readonly string[];
  // I/O 优先级（taskpolicy）。缺省 background。
  priority?: TreeDeletePriority;
  // 写进子进程的标准输入（例如压缩要摘要的对话和模型的凭据）。不进日志，不落盘，不进命令行和环境变量。
  stdin?: string;
  // 收集标准输出（最多 maxStdoutBytes，超过时按失败处理）。不收集时丢掉。
  captureStdout?: boolean;
  maxStdoutBytes?: number;
  // 超过这个时间还没退出：先 SIGTERM，2 秒后 SIGKILL。结果的 timedOut 为真。
  timeoutMs?: number;
  // 中止（例如 daemon 停机）：和超时一样先 SIGTERM，再 SIGKILL。
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  // 子进程起来了（pid）。
  onSpawn?: (pid: number | null) => void;
}

export interface HostChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  // 标准错误的最后 2000 字。
  stderr: string;
  ms: number;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * 在子进程里跑一件后台重活，登记成后台作业，起止各记一行 [sched] job.*（spec D12 第 11 条），等它退出。
 * 子进程不占 daemon 的主线程和 I/O 线程池；daemon 只读写管道。spawn 本身失败时抛错。
 */
export function runHostChild(options: HostChildOptions): Promise<HostChildResult> {
  const job = startJob(options.kind, options.label);
  const started = Date.now();
  const maxStdout = options.maxStdoutBytes ?? 8 * 1024 * 1024;
  return new Promise<HostChildResult>((resolvePromise, reject) => {
    const { command, args, io } = priorityCommand(options.command, options.args, options.priority ?? "background");
    let stderr = "";
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: [options.stdin === undefined ? "ignore" : "pipe", options.captureStdout ? "pipe" : "ignore", "pipe"],
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      endJob(job, { exit: null, error: error instanceof Error ? error.message : String(error) });
      reject(error);
      return;
    }
    job.pid = child.pid ?? null;
    jobLog?.(schedLine("job.start", { id: job.id, kind: options.kind, label: options.label, pid: job.pid, io }));
    options.onSpawn?.(job.pid);
    let killTimer: NodeJS.Timeout | null = null;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000);
      killTimer.unref();
    };
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : null;
    timer?.unref();
    const onAbort = () => { aborted = true; stop(); };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        if (!overflow) { overflow = true; stop(); }
        return;
      }
      stdout.push(chunk);
    });
    if (options.stdin !== undefined && child.stdin) {
      // 子进程先退出时写管道会报 EPIPE：结果按它的退出码算，这里不另外报错。
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const result: HostChildResult = {
        code: overflow ? null : code, signal, stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: overflow ? `stdout over ${maxStdout} bytes` : stderr, ms: Date.now() - started, timedOut, aborted,
      };
      endJob(job, {
        exit: result.code, ...(signal ? { signal } : {}), ...(timedOut ? { timedOut: true } : {}), ...(aborted ? { aborted: true } : {}),
        ...(error ? { error } : {}),
      });
      resolvePromise(result);
    };
    child.once("error", (error) => finish(null, null, error.message));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

// ── 空闲车道的闸门（lead-scheduler spec D8，P4）────────────────────────────────────────────
//
// 没有人在等的后台重活（回收区的删除）在 Lead 空闲时才开始：daemon 装上闸门（它问 Lead 的调度器）。没装时马上放行，
// 测试和别的进程照旧。已经在跑的子进程不停：它在自己的进程里、按后台优先级跑，做完这一块再让（下一块等 Lead 空闲）。
export type HostIdleGate = (job: { kind: string; label: string }) => Promise<void>;
let idleGate: HostIdleGate | null = null;

export function setHostIdleGate(gate: HostIdleGate | null): void {
  idleGate = gate;
}

/** 等到 Lead 空闲（daemon 装了闸门时），再开始这一件没有人在等的后台重活。闸门出错时放行。 */
export async function waitForHostIdle(kind: string, label: string): Promise<void> {
  const gate = idleGate;
  if (!gate) return;
  try {
    await gate({ kind, label });
  } catch { /* 闸门坏了不能让删除永远不做 */ }
}

/**
 * 登记一件在别处跑的后台重活（例如一个只能在进程里做的大操作），做完自动注销。卡顿时它出现在说明里。
 */
export async function trackHostJob<T>(kind: string, label: string, work: () => Promise<T>): Promise<T> {
  const job = startJob(kind, label);
  jobLog?.(schedLine("job.start", { id: job.id, kind, label, pid: null }));
  try {
    const result = await work();
    endJob(job, { ok: true });
    return result;
  } catch (error) {
    endJob(job, { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    throw error;
  }
}
