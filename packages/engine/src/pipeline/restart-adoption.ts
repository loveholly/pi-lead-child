// daemon 重启后接管 child（spec D7，工单 15）。
// 垫片启动的 Run 在 daemon 停机期间继续运行。daemon 启动时，对状态为 starting 或 running 的 Run：
// - 垫片还活着，并且身份匹配（pid 加 Run token，经控制 socket 核对）：接管它，从输出文件补读，再接着看管。
// - 垫片已经退出，留下了退出记录：把输出文件读到末尾，再按退出记录走正常的完成或失败流程。
// - 都不是（没有垫片的旧 Run，或者垫片没留下退出记录就没了）：走孤儿回收（daemon/server.ts 的 recoverOrphans）。
//   孤儿回收把 Run 判为被中断，再重派它。
// 本模块说的"恢复"指接管或重派。两者都受崩溃循环额度约束：同一份工作在一个时间窗口内被恢复超过上限时，
// 不再接管或重派，Run 判为失败，并且只升起一个 blocker。
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createCoordinator } from "../coordinator/service.js";
import { addActivity } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import type { Run, RunPurpose, RuntimeId } from "@pi-lead-child/core";
import { failureNextStep, typedFailure } from "@pi-lead-child/runtime";
import {
  LAUNCH_FILES, launcherWithin, parseLauncherIdentity, readExitRecord, readLaunchRecord, reattachLauncher,
  stopReattachedLauncher, type AttachableLaunch, type LauncherReattach,
} from "@pi-lead-child/runtime";
import { createDispatcher } from "../coordinator/dispatch.js";

// ── 崩溃循环额度的配置 ─────────────────────────────────────────────────────────
// 同一份工作在 windowMs 之内被恢复（接管或重派）超过 limit 次时，判为崩溃循环。
// 默认 5 分钟内最多 5 次。supervisor 在 daemon 崩溃后 1 秒到 30 秒内重启它，崩溃循环一两分钟内就会用完额度。
// 用户手动部署很少在 5 分钟内重启 6 次，所以正常部署不会触发它。
// limit 为 0 表示不接管也不重派：重启时每个活动的 Run 都判为失败，并升起 blocker。limit 最大 100。
export interface CrashLoopBudget {
  limit: number;
  windowMs: number;
}

const DEFAULT_CRASH_LOOP_LIMIT = 5;
const DEFAULT_CRASH_LOOP_WINDOW_MS = 5 * 60_000;
const MAX_CRASH_LOOP_LIMIT = 100;

function crashLoopLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CRASH_LOOP_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_CRASH_LOOP_LIMIT;
  return Math.min(parsed, MAX_CRASH_LOOP_LIMIT);
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function crashLoopBudget(env: Record<string, string | undefined> = process.env): CrashLoopBudget {
  return {
    limit: crashLoopLimit(env.PLC_CRASH_LOOP_LIMIT),
    windowMs: positiveMs(env.PLC_CRASH_LOOP_WINDOW_MS, DEFAULT_CRASH_LOOP_WINDOW_MS),
  };
}

// ── 决策边界 ───────────────────────────────────────────────────────────────────
// recoveries 是这份工作每一次恢复的时间，包括正在做的这一次。
// 窗口是 (now - windowMs, now]：正好 windowMs 之前的那一次不算。
export function crashLoopExceeded(input: { recoveries: readonly Date[]; now: Date; budget: CrashLoopBudget }): boolean {
  const since = input.now.getTime() - input.budget.windowMs;
  const recent = input.recoveries.filter((at) => at.getTime() > since && at.getTime() <= input.now.getTime()).length;
  return recent > input.budget.limit;
}

// ── 额度的账 ───────────────────────────────────────────────────────────────────
// 额度按"同一份工作"计算：Run 来自派发请求时，按请求计算。孤儿回收把请求交回队列，
// 下一次派发是新的 Run，同一个请求的恢复次数仍然累加。不来自派发请求的 Run 按 Run 自己计算。
// 每一次恢复在动手之前先记一条 decision 活动，所以恢复做到一半 daemon 又崩溃，这一次也算数。
// 同一次启动对同一份工作只记一次（按启动时间去重）：接管失败后改走孤儿回收，不会扣两次额度。
export interface RestartDispatch {
  requestId: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
}

export function restartDispatchOf(db: Db, runId: number): RestartDispatch | null {
  const row = db.prepare(
    `SELECT c.request_id, r.role, r.purpose
     FROM dispatch_claims c JOIN dispatch_requests r ON r.id=c.request_id
     WHERE c.run_id=?`,
  ).get(runId) as { request_id: number; role: "executor" | "reviewer"; purpose: RunPurpose } | undefined;
  return row ? { requestId: row.request_id, role: row.role, purpose: row.purpose } : null;
}

export type RestartAction = "adopt" | "reclaim";

// 记下这一次恢复，并判断额度是否用完。调用方负责事务。
export function recordRestartRecovery(
  db: Db,
  input: { run: Pick<Run, "id" | "item_id">; dispatch: RestartDispatch | null; action: RestartAction; budget: CrashLoopBudget; now: Date },
): { exceeded: boolean; recoveries: number } {
  const budgetKey = input.dispatch ? `request:${input.dispatch.requestId}` : `run:${input.run.id}`;
  const at = input.now.toISOString();
  const rows = () => (db.prepare(
    `SELECT json_extract(payload, '$.at') AS at FROM activities
     WHERE item_id=? AND kind='decision'
       AND json_extract(payload, '$.decision')='restart_recovery'
       AND json_extract(payload, '$.budgetKey')=?`,
  ).all(input.run.item_id, budgetKey) as Array<{ at: string | null }>);
  if (!rows().some((row) => row.at === at)) {
    addActivity(db, {
      itemId: input.run.item_id, runId: input.run.id, actor: "system", kind: "decision",
      payload: { decision: "restart_recovery", action: input.action, budgetKey, at },
    });
  }
  const recoveries = rows().flatMap((row) => {
    const recorded = row.at ? new Date(row.at) : null;
    return recorded && Number.isFinite(recorded.getTime()) ? [recorded] : [];
  });
  return {
    exceeded: crashLoopExceeded({ recoveries, now: input.now, budget: input.budget }),
    recoveries: recoveries.filter((recorded) => recorded.getTime() > input.now.getTime() - input.budget.windowMs).length,
  };
}

// 记下这一次恢复。额度用完时，在同一笔事务里把 Run 判为崩溃循环（failCrashLoopRun），返回 false。
// 接管和孤儿回收都调用它。调用方负责事务，以及在事务之后停止进程。
export function chargeRestartRecovery(
  db: Db,
  input: { run: Run; dispatch: RestartDispatch | null; action: RestartAction; budget: CrashLoopBudget; now: Date },
): boolean {
  const recovery = recordRestartRecovery(db, input);
  if (!recovery.exceeded) return true;
  failCrashLoopRun(db, { ...input, recoveries: recovery.recoveries });
  return false;
}

// 额度用完：Run 判为失败（宿主作用域，不扣工单的重试额度），请求不再回到队列，升起一个 blocker。
// blocker 的 key 是检查点的 key，所以启动时的 blocker 补发（repairMissingBlockerAlerts）不会再发第二条。
// 执行 Run 的工单从 active 转为 blocked。评审、集成、对话和修复回合不改 stage，和派发失败的规则一致。
// 调用方负责事务，以及在事务之后停止进程。
export function failCrashLoopRun(
  db: Db,
  input: { run: Run; dispatch: RestartDispatch | null; recoveries: number; budget: CrashLoopBudget; now: Date },
): void {
  const { run, now, budget } = input;
  const minutes = Math.max(1, Math.round(budget.windowMs / 60_000));
  const message = `daemon restarted ${input.recoveries} times within ${minutes} minutes while run #${run.id} was active`;
  const failure = typedFailure("restart_crash_loop", { errorCode: "restart_crash_loop", message });
  updateRun(db, run.id, {
    state: "failed", endedAt: true, errorCode: "restart_crash_loop", errorMessage: message, failure,
  });
  addActivity(db, {
    itemId: run.item_id, runId: run.id, actor: "system", kind: "decision",
    payload: {
      decision: "restart_crash_loop",
      recoveries: input.recoveries,
      limit: budget.limit,
      windowMs: budget.windowMs,
      dispatchRequestId: input.dispatch?.requestId ?? null,
    },
  });
  if (run.role === "executor" && run.purpose === "execution" && getItem(db, run.item_id)?.stage === "active") {
    transition(db, {
      itemId: run.item_id, to: "blocked", actor: "system", reason: "daemon restart crash loop", runId: run.id, now,
    });
  }
  const nextStep = failureNextStep(run.runtime, failure);
  const recorded = createCoordinator({ db, now: () => now }).recordSystemCheckpoint({
    itemId: run.item_id,
    runId: run.id,
    kind: "blocked",
    title: "Run stopped after repeated daemon restarts",
    summary: `daemon 在 ${minutes} 分钟内重启了 ${input.recoveries} 次，Run #${run.id} 每次都被接管或重派。`
      + "系统停止了这个 Run，不再接管或重派它。",
    nextStep,
    keyFacts: [
      { label: "Recoveries", value: String(input.recoveries) },
      { label: "Limit", value: String(budget.limit) },
      { label: "Failure scope", value: failure.scope },
    ],
    idempotencyKey: `restart-crash-loop:${run.id}`,
    leadVisible: true,
    precedingEvents: [runUpdatedEvent(run.item_id, run.id)],
  });
  raiseBlocker(db, {
    // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
    needsUser: false,
    itemId: run.item_id,
    runId: run.id,
    code: "restart_crash_loop",
    title: "daemon 反复重启，Run 已停止",
    summary: `工单 #${run.item_id} 的 Run #${run.id}：daemon 在 ${minutes} 分钟内重启了 ${input.recoveries} 次。`,
    nextStep,
    source: "structural",
    dedupKey: `checkpoint:${recorded.checkpoint.id}`,
    evidence: {
      checkpointId: recorded.checkpoint.id,
      recoveries: input.recoveries,
      limit: budget.limit,
      windowMs: budget.windowMs,
    },
    at: now,
  });
  // Run 已经是 failed，所以请求结算为 failed，claim 删除，请求不再回到队列。
  if (input.dispatch) createDispatcher(db).completeRun(run.id);
}

// ── 接管 ───────────────────────────────────────────────────────────────────────
const ACTIVE_STATES: readonly Run["state"][] = ["starting", "running"];

export interface RestartCandidate {
  run: Run;
  dispatch: RestartDispatch | null;
  // 垫片的核对结果。Run 不是垫片启动的时为 null。
  launch: LauncherReattach | null;
}

// 第一步只读：找出活动的 Run，核对每个垫片。核对是异步的，这一步不写库，
// 所以它和后面的启动修复不会交错。身份指向 launchRoot 以外的路径时，不核对它，Run 走孤儿回收。
export async function planRestartRecovery(
  db: Db,
  options: { launchRoot: string; timeoutMs?: number },
): Promise<RestartCandidate[]> {
  const runs = db.prepare(
    "SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY id",
  ).all() as Run[];
  return Promise.all(runs.map(async (run) => {
    const identity = parseLauncherIdentity(run.launcher);
    const trusted = identity && launcherWithin(identity, options.launchRoot) ? identity : null;
    return {
      run,
      dispatch: restartDispatchOf(db, run.id),
      launch: trusted ? await reattachLauncher(trusted, run.id, { timeoutMs: options.timeoutMs }) : null,
    };
  }));
}

export interface RestartRecoveryResult {
  adopted: number;
  crashLooped: number;
  // 要走孤儿回收的 Run。
  reclaim: Set<number>;
}

// 第二步：按核对结果接管、停止或交给孤儿回收。每个 Run 先在一笔事务里记下这一次恢复并判断额度，
// 提交之后再动进程。接管只是开始看管（adopt 同步返回），事件处理在之后的事件循环里进行。
export function applyRestartRecovery(
  db: Db,
  candidates: readonly RestartCandidate[],
  deps: {
    budget: CrashLoopBudget;
    now?: Date;
    canAdopt(runtime: RuntimeId): boolean;
    adopt(run: Run, launch: AttachableLaunch): void;
    log?(line: string): void;
  },
): RestartRecoveryResult {
  const now = deps.now ?? new Date();
  const result: RestartRecoveryResult = { adopted: 0, crashLooped: 0, reclaim: new Set() };
  for (const candidate of candidates) {
    const { launch } = candidate;
    const live = launch && launch.state !== "gone" ? launch : null;
    if (!live || !deps.canAdopt(candidate.run.runtime)) {
      // 不能接管这个 runtime：停止核对过身份的垫片，再走孤儿回收。
      if (live?.state === "alive") stopReattachedLauncher(live);
      result.reclaim.add(candidate.run.id);
      continue;
    }
    const verdict = db.transaction(() => {
      const run = getRun(db, candidate.run.id);
      if (!run || !ACTIVE_STATES.includes(run.state)) return "skip" as const;
      return chargeRestartRecovery(db, { run, dispatch: candidate.dispatch, action: "adopt", budget: deps.budget, now })
        ? "adopt" as const
        : "crash_loop" as const;
    }).immediate();
    if (verdict !== "adopt") {
      if (live.state === "alive") stopReattachedLauncher(live);
      if (verdict === "crash_loop") result.crashLooped += 1;
      continue;
    }
    try {
      deps.adopt(candidate.run, live);
      result.adopted += 1;
    } catch (error) {
      deps.log?.(`[restart] adopting run #${candidate.run.id} failed: ${String(error)}`);
      if (live.state === "alive") stopReattachedLauncher(live);
      result.reclaim.add(candidate.run.id);
    }
  }
  return result;
}

// ── 启动目录的清理 ─────────────────────────────────────────────────────────────
// <数据目录>/launches/ 下每次启动一个目录（工单 14）。清理规则：
// - 活动的 Run 的目录不动：接管要从头读它。
// - 有退出记录、Run 已经不活动、结束超过 retentionMs 的目录，删除。
// - 没有退出记录、Run 已经不活动的目录：垫片可能还活着（例如 daemon 被强杀时 pi 还在停留）。
//   能核对身份时停止它，退出记录写下后，下一次启动按上一条处理。
//   不能核对身份时，输出文件超过 retentionMs 没有变化才删除。
// 每次启动最多删除或停止 limit 个，最多查看 4 倍于 limit 的目录。按 Run id 从小到大处理，所以最旧的目录先被删除。
// 一个目录出错时跳过它，不影响 daemon 启动。保留时间默认 7 天（PLC_LAUNCH_RETENTION_MS）。
const DEFAULT_LAUNCH_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LAUNCH_SWEEP_LIMIT = 200;
const LAUNCH_DIR_NAME = /^r(\d+)-[^/]+$/;

export function launchRetentionMs(env: Record<string, string | undefined> = process.env): number {
  return positiveMs(env.PLC_LAUNCH_RETENTION_MS, DEFAULT_LAUNCH_RETENTION_MS);
}

export async function sweepLaunchDirectories(
  db: Db,
  input: { dataDir: string; now?: Date; retentionMs?: number; limit?: number },
): Promise<{ removed: number; stopped: number }> {
  const root = join(input.dataDir, "launches");
  if (!existsSync(root)) return { removed: 0, stopped: 0 };
  const now = (input.now ?? new Date()).getTime();
  const retentionMs = input.retentionMs ?? launchRetentionMs();
  const limit = input.limit ?? LAUNCH_SWEEP_LIMIT;
  const entries = readdirSync(root)
    .flatMap((name) => {
      const match = LAUNCH_DIR_NAME.exec(name);
      return match ? [{ name, runId: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.runId - right.runId || left.name.localeCompare(right.name));
  let removed = 0;
  let stopped = 0;
  for (const entry of entries.slice(0, limit * 4)) {
    if (removed + stopped >= limit) break;
    const dir = join(root, entry.name);
    try {
      const run = getRun(db, entry.runId);
      if (run && ACTIVE_STATES.includes(run.state)) continue;
      const record = readExitRecord(dir);
      if (record) {
        const endedAt = Date.parse(record.endedAt);
        if (Number.isFinite(endedAt) && now - endedAt >= retentionMs) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
        continue;
      }
      const identity = parseLauncherIdentity(run?.launcher ?? null);
      if (run && identity?.dir === dir && launcherWithin(identity, root)) {
        const launch = await reattachLauncher(identity, run.id);
        if (launch.state === "alive") {
          stopReattachedLauncher(launch);
          stopped += 1;
          continue;
        }
        if (launch.state === "exited") continue;
      }
      const output = join(dir, LAUNCH_FILES.output);
      const changedAt = existsSync(output) ? statSync(output).mtimeMs : statSync(dir).mtimeMs;
      if (now - changedAt >= retentionMs) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // 跳过这个目录。下一次启动再处理它。
    }
  }
  return { removed, stopped };
}

// ── 库里没有身份的垫片 ─────────────────────────────────────────────────────────
// daemon 在启动垫片以后、记下 runs.launcher 之前被杀掉时，库里没有这个垫片的身份。下一个 daemon 回收并重派这个 Run，
// 旧的 CLI 却还在运行，同一张工单上就有两个 CLI。launchProcess 在交出启动说明之前写下启动记录（launch.json），
// 所以 daemon 启动时、孤儿回收之前，按启动记录找出这样的垫片：
// - 有退出记录的目录跳过：垫片已经退出。没有启动记录的目录跳过：它来自写启动记录之前的版本。
// - 库里的身份指向这个目录时跳过：活动的 Run 由接管处理，不活动的 Run 由启动目录的清理处理。
// - 库里没有这个 Run 时跳过：Run 在启动垫片之前就已经建好，库里没有它，说明说不清这个垫片属于谁。
// - 其余的垫片经控制 socket 核对身份（token、shimPid、runId）。核对通过才发 SIGTERM，然后等它退出：
//   垫片给 CLI 的进程组发 SIGTERM，宽限期后发 SIGKILL，写下退出记录，再退出。核对不通过时不发信号。
// 等待有上限。超时以后不再等，垫片照样会在宽限期后停止 CLI。
const UNTRACKED_STOP_TIMEOUT_MS = 10_000;

export async function stopUntrackedLaunchers(
  db: Db,
  input: { launchRoot: string; timeoutMs?: number },
): Promise<number> {
  const root = input.launchRoot;
  if (!existsSync(root)) return 0;
  const launches = readdirSync(root).flatMap((name) => {
    const match = LAUNCH_DIR_NAME.exec(name);
    return match ? [{ dir: join(root, name), runId: Number(match[1]) }] : [];
  });
  const stopped = await Promise.all(launches.map(async ({ dir, runId }) => {
    try {
      if (readExitRecord(dir)) return false;
      const record = readLaunchRecord(dir);
      if (!record || record.runId !== runId || !launcherWithin(record.identity, root)) return false;
      const run = getRun(db, runId);
      if (!run || parseLauncherIdentity(run.launcher)?.dir === dir) return false;
      const launch = await reattachLauncher(record.identity, runId);
      if (launch.state !== "alive") return false;
      const exited = new Promise<void>((done) => launch.control.onClose(done));
      if (launch.control.open) {
        try { process.kill(launch.identity.pid, "SIGTERM"); } catch { /* 已经退出 */ }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((done) => { timer = setTimeout(done, input.timeoutMs ?? UNTRACKED_STOP_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      launch.control.close();
      return true;
    } catch {
      // 跳过这个目录。下一次启动再处理它。
      return false;
    }
  }));
  return stopped.filter(Boolean).length;
}
