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

export function removeTreeCommand(
  target: string, priority: TreeDeletePriority = "background",
): { command: string; args: string[]; io: TreeDeletePriority | "default" } {
  const effective = priority === "background" && process.env.PLC_BACKGROUND_DELETE_IO === "utility" ? "utility" : priority;
  if (process.platform === "darwin" && existsSync(TASKPOLICY)) {
    const policy = effective === "background" ? ["-b"] : ["-d", "utility"];
    return { command: TASKPOLICY, args: [...policy, "/bin/rm", "-rf", "--", target], io: effective };
  }
  return { command: "/bin/rm", args: ["-rf", "--", target], io: "default" };
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
export function removeTree(path: string, options: RemoveTreeOptions = {}): Promise<void> {
  const target = assertRemovableTree(path);
  const kind = options.kind ?? "tree-delete";
  const label = options.label ?? target.split(sep).slice(-2).join(sep);
  const job = startJob(kind, label);
  return new Promise<void>((resolvePromise, reject) => {
    const { command, args, io } = removeTreeCommand(target, options.priority ?? "background");
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      endJob(job, { exit: null, error: error instanceof Error ? error.message : String(error) });
      reject(error);
      return;
    }
    job.pid = child.pid ?? null;
    jobLog?.(schedLine("job.start", { id: job.id, kind, label, pid: job.pid, io }));
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
    child.once("error", (error) => {
      endJob(job, { exit: null, error: error.message });
      reject(error);
    });
    child.once("close", (code, signal) => {
      endJob(job, { exit: code, ...(signal ? { signal } : {}) });
      if (code === 0) resolvePromise();
      else reject(new Error(`rm -rf ${target} exited ${code ?? signal}: ${stderr.trim().slice(-500)}`));
    });
  });
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
