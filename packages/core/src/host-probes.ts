// 宿主探针（lead-scheduler spec D7、D12）：daemon 进程有没有被占住，被什么占住。
//
// 三种卡法，三个探针：
//   · 主线程被同步调用卡住：定时器都不跑了，主线程上的东西发现不了。一个 worker thread 看主线程的心跳
//     （SharedArrayBuffer + Atomics，不经过线程池），心跳停了超过阈值就自己同步写一行日志。主线程恢复以后，
//     它的定时器发现自己晚了多久，再记一行。
//   · I/O 线程池被占满：主线程空闲，定时器照常跑。定时测一次 fs.stat 要多久；一次 stat 等过阈值还没回来，
//     马上记一行，带上正在跑的后台重活（host-jobs.ts）。
//   · 主线程延迟的分布：perf_hooks.monitorEventLoopDelay，每分钟一条摘要。
//
// 日志都是同步写的（D12）：worker 用 fs.writeSync 写 daemon 的标准输出，主线程用 daemon 的 log（写文件是同步的）。
// 日志里只有数字和后台作业的种类，不写消息原文。
import { stat } from "node:fs/promises";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { describeHostJobs, schedLine } from "./host-jobs.js";

export interface HostProbeOptions {
  log: (line: string) => void;
  // 线程池探针 stat 的目录（daemon 的数据目录）。
  dir: string;
  // worker 写日志的文件描述符（daemon 的标准输出是 1）。null：不起 worker。
  workerFd?: number | null;
  summaryMs?: number;
  poolEveryMs?: number;
  // 一次 stat 等过这么久算线程池忙。
  poolWarnMs?: number;
  // 主线程的定时器晚了这么久算被卡住过。
  lagWarnMs?: number;
  // 主线程的心跳停了这么久，worker 记一行。
  blockedMs?: number;
}

export interface HostProbeSnapshot {
  at: number;
  // 主线程延迟（毫秒），上一次摘要以来。
  loop: { p50: number; p99: number; max: number };
  // 线程池：最近一次 stat 用了多久；正在等的那一次已经等了多久（没有在等时为 null）；上一次摘要以来最长的一次。
  pool: { lastMs: number | null; waitingMs: number | null; maxMs: number };
  jobs: string;
}

export interface HostProbes {
  snapshot(): HostProbeSnapshot;
  stop(): void;
}

let current: HostProbes | null = null;

/** 正在运行的探针的读数。没有启动探针时为 null（测试里起的 daemon）。 */
export function hostProbeSnapshot(): HostProbeSnapshot | null {
  return current?.snapshot() ?? null;
}

/** 一行说明宿主现在的负载：线程池在等多久、主线程延迟、正在跑的后台重活。卡顿的日志附上它。 */
export function describeHostLoad(): string {
  const snap = hostProbeSnapshot();
  const jobs = describeHostJobs();
  if (!snap) return `probes=off jobs=${jobs}`;
  const pool = snap.pool.waitingMs !== null ? `waiting ${snap.pool.waitingMs}ms` : `last ${snap.pool.lastMs ?? "?"}ms`;
  return `pool=${JSON.stringify(pool)} loopMax=${snap.loop.max}ms jobs=${JSON.stringify(jobs)}`;
}

// worker 的代码（字符串，打包以后照样能用）。BigInt64Array 的第 0 格是主线程的心跳（Date.now()），
// 第 1 格是停止标志，第 2 格只用来 Atomics.wait 睡觉（不经过线程池）。
const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const cells = new BigInt64Array(workerData.buffer);
const { fd, blockedMs } = workerData;
let reportedAt = 0;
const write = (line) => { try { writeSync(fd, "[" + new Date().toISOString() + "] " + line + "\\n"); } catch {} };
for (;;) {
  Atomics.wait(cells, 2, 0n, 250);
  if (Atomics.load(cells, 1) === 1n) break;
  const now = Date.now();
  const silent = now - Number(Atomics.load(cells, 0));
  if (silent >= blockedMs) {
    if (reportedAt === 0 || now - reportedAt >= 5000) {
      reportedAt = now;
      write("[sched] probe.main_blocked silentMs=" + silent + " thresholdMs=" + blockedMs + " source=worker");
    }
  } else {
    reportedAt = 0;
  }
}
`;

export function startHostProbes(options: HostProbeOptions): HostProbes {
  const log = options.log;
  const summaryMs = options.summaryMs ?? 60_000;
  const poolEveryMs = options.poolEveryMs ?? 2_000;
  const poolWarnMs = options.poolWarnMs ?? 1_000;
  const lagWarnMs = options.lagWarnMs ?? 1_000;
  const blockedMs = options.blockedMs ?? 2_000;
  const timers: NodeJS.Timeout[] = [];

  // 主线程延迟的分布。直方图记的是相邻两次采样的间隔，里面包含采样的间隔本身（resolution），读数要减掉它。
  const LOOP_RESOLUTION_MS = 20;
  let histogram: IntervalHistogram | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    histogram.enable();
  } catch {
    histogram = null;
  }
  const delayMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e6) - LOOP_RESOLUTION_MS);
  const loopStats = () => histogram
    ? { p50: delayMs(histogram.percentile(50)), p99: delayMs(histogram.percentile(99)), max: delayMs(histogram.max) }
    : { p50: 0, p99: 0, max: 0 };

  // 线程池探针：同一时间只有一次 stat 在等。
  let poolStartedAt: number | null = null;
  let poolLastMs: number | null = null;
  let poolMaxMs = 0;
  let poolWarned = false;
  const probePool = () => {
    const now = Date.now();
    if (poolStartedAt !== null) {
      const waited = now - poolStartedAt;
      if (!poolWarned && waited >= poolWarnMs) {
        poolWarned = true;
        log(schedLine("probe.pool_busy", { waitingMs: waited, thresholdMs: poolWarnMs, jobs: describeHostJobs(now) }));
      }
      return;
    }
    const started = now;
    poolStartedAt = started;
    poolWarned = false;
    stat(options.dir).catch(() => undefined).then(() => {
      const ms = Date.now() - started;
      poolStartedAt = null;
      poolLastMs = ms;
      poolMaxMs = Math.max(poolMaxMs, ms);
      if (ms >= poolWarnMs) log(schedLine("probe.pool_recovered", { waitedMs: ms, thresholdMs: poolWarnMs, jobs: describeHostJobs() }));
    });
  };

  // 主线程恢复以后，看定时器晚了多久。
  let expectedTick = Date.now() + 500;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - expectedTick;
    expectedTick = now + 500;
    if (lag >= lagWarnMs) log(schedLine("probe.main_lag", { lateMs: lag, thresholdMs: lagWarnMs, jobs: describeHostJobs(now) }));
  }, 500);
  timers.push(lagTimer);

  timers.push(setInterval(probePool, poolEveryMs));
  probePool();

  timers.push(setInterval(() => {
    const loop = loopStats();
    log(schedLine("probe.summary", {
      loopP50: loop.p50, loopP99: loop.p99, loopMax: loop.max,
      poolLast: poolLastMs, poolMax: poolMaxMs, poolWaiting: poolStartedAt === null ? null : Date.now() - poolStartedAt,
      jobs: describeHostJobs(),
    }));
    histogram?.reset();
    poolMaxMs = 0;
  }, summaryMs));

  // worker 心跳。
  let worker: Worker | null = null;
  let cells: BigInt64Array | null = null;
  if (options.workerFd !== null && options.workerFd !== undefined) {
    try {
      const buffer = new SharedArrayBuffer(3 * BigInt64Array.BYTES_PER_ELEMENT);
      cells = new BigInt64Array(buffer);
      Atomics.store(cells, 0, BigInt(Date.now()));
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { buffer, fd: options.workerFd, blockedMs },
        stdout: false, stderr: false,
      });
      worker.unref();
      worker.on("error", (error: Error) => log(schedLine("probe.worker_error", { error: error.message })));
      const beat = cells;
      timers.push(setInterval(() => { Atomics.store(beat, 0, BigInt(Date.now())); }, 250));
    } catch (error) {
      log(schedLine("probe.worker_error", { error: error instanceof Error ? error.message : String(error) }));
      worker = null;
    }
  }
  for (const timer of timers) timer.unref();
  log(schedLine("probe.start", { poolEveryMs, poolWarnMs, lagWarnMs, blockedMs: worker ? blockedMs : null, summaryMs }));

  const probes: HostProbes = {
    snapshot: () => ({
      at: Date.now(),
      loop: loopStats(),
      pool: { lastMs: poolLastMs, waitingMs: poolStartedAt === null ? null : Date.now() - poolStartedAt, maxMs: poolMaxMs },
      jobs: describeHostJobs(),
    }),
    stop: () => {
      for (const timer of timers) clearInterval(timer);
      histogram?.disable();
      if (cells) {
        Atomics.store(cells, 1, 1n);
        Atomics.notify(cells, 2);
      }
      void worker?.terminate();
      if (current === probes) current = null;
    },
  };
  current = probes;
  return probes;
}
