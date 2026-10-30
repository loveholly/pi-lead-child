import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setInterval as setNodeInterval, setTimeout as setNodeTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { attachJsonlReader, listenOwnerOnly } from "@pi-lead-child/runtime";
import { LATEST_SCHEMA_VERSION } from "@pi-lead-child/store";
import {
  LEAD_DRAIN_TIMEOUT_MS, SUPERVISOR_FEATURE_DEPLOY_GATE, SUPERVISOR_FEATURE_MAINTENANCE_BACKUP, type DaemonDrainResult,
} from "@pi-lead-child/protocol";
import { deployReadiness, type DeployReadiness } from "./deploy/readiness.js";
import { backupSqlite } from "./deploy/backup.js";
import { findRuntimeExecutable, runtimeSearchPath } from "@pi-lead-child/runtime";
import type {
  MaintenanceRequest,
  SupervisorCommand,
  SupervisorPersistentState,
  SupervisorStatus,
} from "./protocol.js";
import { socketListening } from "./client.js";
import { loadSupervisorState, saveSupervisorState } from "./state.js";
import { autoStartRefusal, explicitStartRefusal } from "./auto-start.js";
import {
  claimInstanceLock, daemonLockPath, instanceLockHeld, supervisorLockPath, type InstanceLock,
} from "./instance-lock.js";
export { autoStartRefusal, explicitStartRefusal } from "./auto-start.js";

// 这个数据目录已经有一个活着的 supervisor。main.ts 据此让开并正常退出。
export class SupervisorAlreadyRunningError extends Error {}

export interface SupervisorOptions {
  dataDir: string;
  dbPath: string;
  daemonCommand: { bin: string; args: string[] };
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  restartBaseMs?: number;
  restartMaxMs?: number;
  // daemon 进程启动以后，最多等多久它回答第一次 status。缺省 DEFAULT_DAEMON_READY_TIMEOUT_MS。
  daemonReadyTimeoutMs?: number;
  // 部署闸门（deploy/readiness.ts）：daemon 从哪个 checkout 的哪个 dist 启动。给了它，每个维护请求（Lead 的重启、
  // 换 Lead 模型后的重启、plc daemon restart/upgrade）都先检查只部署已提交的代码，并在停机前备份数据库。
  // 崩溃后的自动拉起不拦截，只记一条警告。daemon 直接跑源码（PLC_DEV，没有 dist）时不给。
  deployment?: { root: string; distDir: string } | null;
  // 维护前的数据库备份（缺省是 deploy/backup.ts 的 backupSqlite，有时限）。测试用它模拟一次很慢的备份。
  backupDatabase?: (source: string, destination: string) => Promise<void>;
}

export class DeployRefusedError extends Error {
  readonly code = "deploy_refused";
  constructor(readonly reasons: string[]) {
    super(`deploy refused:\n${reasons.map((reason) => `- ${reason}`).join("\n")}`);
  }
}

// 负载高时 daemon 启动会超过 30 秒：2026-10-19 14:54Z 负载约 37，daemon 用了 39 秒才开始监听。
// 进程还活着就接着等，所以这个期限只用来认定启动卡住了，可以比正常启动时间长得多。
export const DEFAULT_DAEMON_READY_TIMEOUT_MS = 120_000;

export type StartingDaemonVerdict = "ready" | "exited" | "timed_out" | "starting";

// 决策边界：一个已经启动、还没回答 status 的 daemon，要不要接着等。
// 回答了就是就绪。进程退出了就不用再等。进程活着就是还在启动，等到期限为止。
export function startingDaemonVerdict(check: {
  answered: boolean;
  exited: boolean;
  waitedMs: number;
  timeoutMs: number;
}): StartingDaemonVerdict {
  if (check.answered) return "ready";
  if (check.exited) return "exited";
  return check.waitedMs >= check.timeoutMs ? "timed_out" : "starting";
}

export interface SupervisorHandle {
  sockPath: string;
  close(): Promise<void>;
}

async function socketCommand<T = unknown>(
  path: string,
  command: Record<string, unknown>,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`socket command timed out: ${path}`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as { type: string; success?: boolean; data?: T; error?: string };
      if (message.type !== "response") return;
      clearTimeout(timeout);
      socket.end();
      if (message.success === false) reject(new Error(message.error ?? "daemon command failed"));
      else resolve(message.data as T);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

function schemaVersion(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        { version: number | null } | undefined;
      return row?.version ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// 维护要等哪些在跑的工单（spec D7，用户故事 14）。经启动垫片启动的 child 在 daemon 重启后被接管，
// 所以不必等它结束。没有垫片身份的 Run（工单 14 之前启动的）重启后接管不了，仍然要等。
// daemon 报告在跑、库里却找不到可接管的 Run，或者库读不了，也按要等处理：拿不准时宁可等。
export function itemsBlockingMaintenance(dbPath: string, runningItemIds: readonly number[]): number[] {
  if (!runningItemIds.length) return [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const adoptable = db.prepare(
        `SELECT 1 FROM runs
         WHERE item_id=? AND state IN ('starting','running') AND launcher IS NOT NULL
         LIMIT 1`,
      );
      return runningItemIds.filter((itemId) => !adoptable.get(itemId));
    } finally {
      db.close();
    }
  } catch {
    return [...runningItemIds];
  }
}

// Lead 每次重启前都备份一次（一份几十 MB）。只保留最近的 RESTART_BACKUPS_KEPT 份重启备份；
// upgrade 的备份和别的文件不动。
export const RESTART_BACKUPS_KEPT = 10;
const READINESS_CACHE_MS = 30_000;
const RESTART_BACKUP = /^plc-pre-restart-.+\.db$/;

export function pruneRestartBackups(backupDir: string, keep = RESTART_BACKUPS_KEPT): string[] {
  const backups = readdirSync(backupDir).filter((name) => RESTART_BACKUP.test(name)).sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of removed) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(backupDir, `${name}${suffix}`), { force: true });
  }
  return removed;
}

// 一个数据目录只有一个 supervisor。它先拿 supervisor.lock，拿到以后才碰 supervisor.sock、状态文件和 daemon。
// 拿不到就让开（SupervisorAlreadyRunningError）。持锁的 supervisor 退出（包括崩溃）以后，下一个才进得来。
// 以前用 750 毫秒的 status 探活：daemon 卡住时活着的 supervisor 回答得慢，第二个 supervisor 就删掉
// supervisor.sock 自己接管（2026-10-15 09:25Z）。
export async function startSupervisor(opts: SupervisorOptions): Promise<SupervisorHandle> {
  mkdirSync(opts.dataDir, { recursive: true });
  const lock = claimInstanceLock(supervisorLockPath(opts.dataDir));
  if (!lock) throw new SupervisorAlreadyRunningError(`supervisor already running for ${opts.dataDir}; standing down`);
  try {
    return await runSupervisor(opts, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function runSupervisor(opts: SupervisorOptions, lock: InstanceLock): Promise<SupervisorHandle> {
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const sockPath = join(opts.dataDir, "supervisor.sock");
  const daemonSockPath = join(opts.dataDir, "plc.sock");
  const statePath = join(opts.dataDir, "supervisor-state.json");
  const logsDir = join(opts.dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  if (existsSync(sockPath)) {
    // 拿到了锁，却还有进程在 supervisor.sock 上 listen：那是不认识这把锁的旧版本 supervisor。也让开。
    if (await socketListening(sockPath)) {
      throw new SupervisorAlreadyRunningError(`supervisor already running at ${sockPath}; standing down`);
    }
    unlinkSync(sockPath);
  }

  const state = loadSupervisorState(statePath);
  state.supervisorPid = process.pid;
  saveSupervisorState(statePath, state);

  let child: ChildProcess | null = null;
  let closing = false;
  let maintenanceRunning = false;
  // 维护已经让 daemon 停下（发了 shutdown，新的还没起来）。只有这段时间里 daemon 退出不算崩溃。
  // 以前整个维护期间都不拉起：备份还在做时 daemon 崩溃，也没人拉起它（审查 2026-10-20 A）。
  let daemonDown = false;
  let restartTimer: ReturnType<typeof setNodeTimeout> | null = null;
  let daemonOutFd: number | null = null;
  let daemonErrFd: number | null = null;

  const persist = () => saveSupervisorState(statePath, state);

  const daemonStatus = async (): Promise<Record<string, unknown> | null> => {
    try {
      return await socketCommand<Record<string, unknown>>(daemonSockPath, { type: "status" }, 1_500);
    } catch {
      return null;
    }
  };

  // 有没有 daemon 进程活着。plc.sock 不回答 status 还不够：daemon 可能在启动、在退出，或者卡住了。
  // 持有 daemon.lock 的进程退出以后，才算没有 daemon。
  // 探测会短暂拿一下锁，所以只在本 supervisor 没有正在启动的 child 时调用。
  const daemonLockHeld = () => instanceLockHeld(daemonLockPath(opts.dataDir));

  const waitForDaemonStopped = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await daemonStatus()) && !daemonLockHeld()) return;
      await delay(250);
    }
    throw new Error(`daemon did not become stopped within ${timeoutMs}ms`);
  };

  // 等本 supervisor 拉起的 daemon 回答第一次 status。以前固定等 30 秒：2026-10-19 14:54Z 负载约 37，
  // daemon 39 秒才开始监听，维护在第 30 秒把这个健康的 daemon 记成了失败。
  const readyTimeoutMs = opts.daemonReadyTimeoutMs ?? DEFAULT_DAEMON_READY_TIMEOUT_MS;
  const waitForStartedDaemon = async (started: ChildProcess): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    for (;;) {
      const status = await daemonStatus();
      const verdict = startingDaemonVerdict({
        answered: Boolean(status),
        // spawn 失败时 pid 是 undefined。
        exited: started.pid === undefined || started.exitCode !== null || started.signalCode !== null,
        waitedMs: Date.now() - startedAt,
        timeoutMs: readyTimeoutMs,
      });
      if (verdict === "ready") return status!;
      if (verdict === "exited") {
        throw new Error(`daemon pid ${started.pid ?? "?"} exited before it answered status `
          + `(code=${started.exitCode}, signal=${started.signalCode})`);
      }
      if (verdict === "timed_out") {
        const listening = await socketListening(daemonSockPath);
        throw new Error(`daemon did not become ready within ${readyTimeoutMs}ms `
          + `(pid ${started.pid} is alive, ${listening ? "listening but not answering status" : "not listening"})`);
      }
      await delay(250);
    }
  };

  const closeLogFds = () => {
    if (daemonOutFd !== null) closeSync(daemonOutFd);
    if (daemonErrFd !== null && daemonErrFd !== daemonOutFd) closeSync(daemonErrFd);
    daemonOutFd = null;
    daemonErrFd = null;
  };

  const scheduleRestart = () => {
    if (closing || state.desiredState !== "running" || daemonDown || restartTimer) return;
    const base = Math.max(100, opts.restartBaseMs ?? 1_000);
    const maximum = Math.max(base, opts.restartMaxMs ?? 30_000);
    const wait = Math.min(maximum, base * (2 ** Math.min(state.crashCount, 5)));
    state.phase = "degraded";
    persist();
    restartTimer = setNodeTimeout(() => {
      restartTimer = null;
      void ensureDaemon().catch((error) => {
        log(`daemon restart failed: ${error.message}`);
        scheduleRestart();
      });
    }, wait);
  };

  const spawnDaemon = async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const existing = await daemonStatus();
      if (existing) {
        state.daemonPid = Number(existing.pid ?? 0) || null;
        state.phase = "running";
        persist();
        return existing;
      }
      // daemon 的 socket 在监听，只是 status 没有及时回答：它在忙，不是不在。不再起第二个。
      if (!child && await socketListening(daemonSockPath)) {
        state.phase = "running";
        persist();
        return {};
      }
      if (child) {
        const starting = child;
        const ready = await waitForStartedDaemon(starting);
        state.daemonPid = Number(ready.pid ?? starting.pid ?? 0) || null;
        state.phase = "running";
        persist();
        return ready;
      }
      // 另一个 daemon 进程持有 daemon.lock，却没在时限内回答 status：它在启动、在退出，或者卡住了。
      // 不拉起第二个：第二个会被锁拒绝并以 0 退出，这里却会记成一次崩溃（2026-10-15 09:56Z）。
      // 等它回答（接管它），或者等它退出、放掉锁。从这里到 spawn 之间没有 await，别的流程插不进来。
      if (!daemonLockHeld()) break;
      if (Date.now() >= deadline) {
        throw new Error(`a daemon holds ${daemonLockPath(opts.dataDir)} but did not answer status within ${readyTimeoutMs}ms`);
      }
      await delay(250);
    }

    // 崩溃后的自动拉起、开机启动：不拦截（拦截就等于停服），只把不符合部署闸门的原因记下来。
    const startRefusal = deployRefusal();
    if (startRefusal.length) log(`starting the daemon from a build the deploy gate would refuse: ${startRefusal.join(" ")}`);
    daemonOutFd = openSync(join(logsDir, "coordinatord.out.log"), "a");
    daemonErrFd = openSync(join(logsDir, "coordinatord.err.log"), "a");
    state.phase = "starting";
    persist();
    const spawned = spawn(opts.daemonCommand.bin, opts.daemonCommand.args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        PATH: runtimeSearchPath(opts.env?.PATH ?? process.env.PATH),
        PLC_SUPERVISED: "1",
      },
      stdio: ["ignore", daemonOutFd, daemonErrFd],
    });
    child = spawned;
    state.daemonPid = spawned.pid ?? null;
    persist();
    spawned.once("error", (error) => {
      log(`daemon spawn error: ${error.message}`);
      state.phase = "degraded";
      persist();
    });
    spawned.once("exit", (code, signal) => {
      child = null;
      closeLogFds();
      state.daemonPid = null;
      state.lastDaemonExit = { code, signal, at: new Date().toISOString() };
      if (!closing && state.desiredState === "running" && !daemonDown) {
        state.crashCount += 1;
        scheduleRestart();
      } else {
        state.phase = state.desiredState === "stopped" ? "stopped" : state.phase;
        persist();
      }
    });
    const ready = await waitForStartedDaemon(spawned);
    state.daemonPid = Number(ready.pid ?? spawned.pid ?? 0) || null;
    state.phase = "running";
    state.crashCount = 0;
    persist();
    return ready;
  };

  // explicit：用户的 plc daemon start（ensure_running 不带 auto）。要启动新的 daemon 时它也过部署闸门
  // （审查 2026-10-20 B：以前 plc daemon stop 再 start，脏的主 checkout 照样拉起）。闸门拒绝时 desiredState 不改，
  // 巡检也就不会把它当成崩溃再拉起来。force 是显式的绕过，记在日志里，回答里也写明。
  // 崩溃后的拉起、开机启动、维护里的启动不是 explicit：不拦截，spawnDaemon 只记一条警告。
  const ensureDaemon = async (start: { explicit?: boolean; force?: boolean } = {}): Promise<Record<string, unknown>> => {
    let forcedPast: string[] | null = null;
    if (start.explicit) {
      const refusal = deployRefusal();
      if (refusal.length && !(await daemonStatus())) {
        if (!start.force) throw new DeployRefusedError(refusal);
        forcedPast = refusal;
        log(`plc daemon start --force: starting past the deploy gate: ${refusal.join(" ")}`);
      }
    }
    state.desiredState = "running";
    persist();
    const status = await spawnDaemon();
    return forcedPast ? { ...status, forcedPastDeployGate: forcedPast } : status;
  };

  // 先请 daemon 排空 Lead（2026-10-16 提醒 #83）：它不再开新的回合，等正在跑的这一轮，到时还没结束就正式中断它。
  // 等它回答以后才发 shutdown。以前只在重启前查一次 busy，查完到停机之间开始的一轮照样被打断；plc daemon stop
  // 和 supervisor 停机连这一次都不查。daemon 自己最多等 LEAD_DRAIN_TIMEOUT_MS，中断后再等几秒收尾，这里多给一点余量。
  // 不认识 drain 的旧 daemon 回答失败：照旧发 shutdown（它的 close 不排空）。
  // 排空以后一直没有 shutdown 时（例如维护的备份失败了），daemon 过一会儿自己恢复 Lead 的回合（PLC_LEAD_DRAIN_EXPIRY_MS）。
  // 返回 daemon 有没有回答。
  const drainDaemon = async (): Promise<boolean> => {
    const status = await daemonStatus();
    if (!status) return false;
    try {
      const drain = await socketCommand<DaemonDrainResult>(
        daemonSockPath, { type: "drain", timeoutMs: LEAD_DRAIN_TIMEOUT_MS }, LEAD_DRAIN_TIMEOUT_MS + 8_000,
      );
      if (drain?.interrupted) log("daemon interrupted the running Lead turn before the stop");
    } catch (error: any) {
      log(`daemon drain before stop failed (${error.message}); sending shutdown`);
    }
    return true;
  };

  const shutdownDaemon = async (answered: boolean): Promise<void> => {
    if (answered) {
      try { await socketCommand(daemonSockPath, { type: "shutdown" }, 3_000); } catch { /* process exit closes socket */ }
      try { await waitForDaemonStopped(20_000); } catch {
        if (child?.pid) child.kill("SIGTERM");
        await waitForDaemonStopped(10_000);
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const childDeadline = Date.now() + 10_000;
    while (child && Date.now() < childDeadline) await delay(50);
    if (child) throw new Error("daemon process did not exit after shutdown");
    state.daemonPid = null;
    persist();
  };

  const stopDaemon = async (persistStopped: boolean): Promise<void> => {
    if (persistStopped) state.desiredState = "stopped";
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    state.phase = "stopped";
    persist();
    await shutdownDaemon(await drainDaemon());
  };

  const backupDatabase = async (request: MaintenanceRequest): Promise<string> => {
    const backupDir = join(opts.dataDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(backupDir, `plc-pre-${request.action}-${stamp}.db`);
    await (opts.backupDatabase ?? ((source, target) => backupSqlite(source, target)))(opts.dbPath, destination);
    pruneRestartBackups(backupDir);
    return destination;
  };

  const deployRefusal = (): string[] => {
    if (!opts.deployment) return [];
    const readiness = deployReadiness(opts.deployment.root, opts.deployment.distDir);
    return readiness.ready ? [] : readiness.reasons;
  };

  // 停机之前的那几步失败时：daemon 照常在跑，这次维护记成失败，不拉起任何东西。
  const refuseBeforeStop = (request: MaintenanceRequest, error: string): void => {
    request.state = "failed";
    request.completedAt = new Date().toISOString();
    request.error = error;
    state.phase = "running";
    persist();
    log(`maintenance ${request.id} refused before the stop: ${error}`);
  };

  const executeMaintenance = async (request: MaintenanceRequest): Promise<void> => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    request.state = "running";
    request.startedAt = new Date().toISOString();
    state.phase = request.backup ? "backing_up" : "restarting";
    persist();
    try {
      // 等排空的这段时间里 checkout 可能变了：停机之前再查一次。
      const refusal = deployRefusal();
      if (refusal.length) {
        refuseBeforeStop(request, new DeployRefusedError(refusal).message);
        return;
      }
      // 顺序：先排空 Lead，再在线备份，最后才停 daemon（审查 2026-10-20 C：先备份的话，排空期间 Lead 那一轮写的东西不在备份里）。
      // 备份失败就不停机（审查 2026-10-19 第 4 条：以前先停机再备份，备份失败时巡检直接用新 dist 拉起 daemon，
      // 迁移就在没有备份的情况下执行了）。排空了却没有停机的 daemon 过一会儿自己恢复 Lead 的回合。
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const answered = await drainDaemon();
      if (request.backup) {
        try {
          request.backupPath = await backupDatabase(request);
          persist();
        } catch (error: any) {
          refuseBeforeStop(request, `database backup failed, the daemon was not stopped: ${error.message}`);
          return;
        }
      }
      daemonDown = true;
      state.phase = "restarting";
      persist();
      await shutdownDaemon(answered);
      state.phase = "restarting";
      persist();
      const status = await ensureDaemon();
      state.phase = "verifying";
      persist();
      const version = schemaVersion(opts.dbPath);
      const required = request.requiredSchemaVersion ?? LATEST_SCHEMA_VERSION;
      if (version === null || version < required) {
        throw new Error(`schema verification failed: current=${version ?? "unknown"}, required=${required}`);
      }
      if (!status.pid) throw new Error("daemon health verification returned no pid");
      request.state = "succeeded";
      request.completedAt = new Date().toISOString();
      request.error = null;
      state.phase = "running";
      persist();
    } catch (error: any) {
      request.state = "failed";
      request.completedAt = new Date().toISOString();
      request.error = error.message;
      state.phase = "degraded";
      persist();
    } finally {
      maintenanceRunning = false;
      daemonDown = false;
      // 维护失败以后再看一次 daemon：它可能已经好了（只是启动慢），也可能不在了。scheduleRestart 走 ensureDaemon：
      // 回答 status 就回到 running，还在启动就接着等，不在了才重新拉起。要在 maintenanceRunning 和 daemonDown
      // 清掉以后调用，否则它直接返回：以前在 catch 里调用，phase 一直停在 degraded（2026-10-19 14:54Z）。
      // 只在 phase 是 degraded 时调用：停机之前就被拒绝的维护（部署闸门、备份失败，refuseBeforeStop）没动 daemon，
      // phase 还是 running，不用再看。
      if (request.state === "failed" && state.phase === "degraded") scheduleRestart();
    }
  };

  const maintenanceTick = async () => {
    const request = state.maintenance;
    if (!request || !["pending", "waiting_for_drain"].includes(request.state) || maintenanceRunning) return;
    const status = await daemonStatus();
    const running = Array.isArray(status?.runningItemIds) ? status.runningItemIds : [];
    // lead 的回合在 daemon 进程里，接管不了，所以照旧要等。
    const leadBusy = status?.busy === true;
    if (leadBusy || itemsBlockingMaintenance(opts.dbPath, running).length) {
      request.state = "waiting_for_drain";
      state.phase = "waiting_for_drain";
      persist();
      return;
    }
    void executeMaintenance(request);
  };

  const requestMaintenance = (command: Extract<SupervisorCommand, { type: "request_maintenance" }>) => {
    if (state.maintenance && ["pending", "waiting_for_drain", "running"].includes(state.maintenance.state)) {
      throw new Error(`maintenance request ${state.maintenance.id} is already ${state.maintenance.state}`);
    }
    // 部署闸门：没提交的代码不能部署。拒绝时 daemon 不动，原因原样返回给请求方。
    const refusal = deployRefusal();
    if (refusal.length) throw new DeployRefusedError(refusal);
    const request: MaintenanceRequest = {
      id: randomUUID(),
      action: command.action,
      reason: command.reason.trim(),
      requiredSchemaVersion: command.requiredSchemaVersion ?? null,
      requestedAt: new Date().toISOString(),
      state: "pending",
      startedAt: null,
      completedAt: null,
      backupPath: null,
      // 每次维护都备份：它们都会让新的 dist 跑起来，迁移可能随之执行。
      backup: true,
      error: null,
    };
    if (!request.reason) throw new Error("maintenance reason is required");
    state.maintenance = request;
    persist();
    queueMicrotask(() => void maintenanceTick());
    return request;
  };

  // status 里的闸门判断要跑好几个 git 命令，而 status 被频繁调用（plc、Lead 的 get_runtime_health）：缓存一会儿
  // （审查 2026-10-20 D）。维护请求和 plc daemon start 不用缓存，当场再查。
  let readinessCache: { at: number; value: DeployReadiness } | null = null;
  const cachedReadiness = (deployment: { root: string; distDir: string }): DeployReadiness => {
    const now = Date.now();
    if (!readinessCache || now - readinessCache.at > READINESS_CACHE_MS) {
      readinessCache = { at: now, value: deployReadiness(deployment.root, deployment.distDir) };
    }
    return readinessCache.value;
  };

  const status = async (): Promise<SupervisorStatus> => {
    const daemon = await daemonStatus();
    if (daemon) state.daemonPid = Number(daemon.pid ?? 0) || state.daemonPid;
    else if (!child) state.daemonPid = null;
    persist();
    return {
      supervisor: structuredClone(state),
      maintenanceActive: maintenanceRunning,
      daemon,
      schemaVersion: schemaVersion(opts.dbPath),
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
      features: [SUPERVISOR_FEATURE_MAINTENANCE_BACKUP, SUPERVISOR_FEATURE_DEPLOY_GATE],
      ...(opts.deployment ? { deploy: cachedReadiness(opts.deployment) } : {}),
      executables: {
        codex: findRuntimeExecutable(process.env.PLC_CODEX_BIN ?? "codex"),
        claude: findRuntimeExecutable(process.env.PLC_CLAUDE_BIN ?? "claude"),
        pi: findRuntimeExecutable(join(opts.cwd, "node_modules", ".bin", "pi")),
      },
    };
  };

  const clients = new Set<Socket>();
  const server: Server = createServer((socket) => {
    clients.add(socket);
    const respond = (id: string | undefined, success: boolean, data?: unknown, error?: string, code?: string) => {
      socket.write(`${JSON.stringify({ type: "response", id, success, data, error, ...(code ? { code } : {}) })}\n`);
    };
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let command: SupervisorCommand;
      try { command = JSON.parse(line) as SupervisorCommand; }
      catch { respond(undefined, false, undefined, "parse error"); return; }
      void (async () => {
        try {
          switch (command.type) {
            case "status": respond(command.id, true, await status()); break;
            case "ensure_running": {
              const refusal = command.auto
                ? autoStartRefusal(state, maintenanceRunning)
                : explicitStartRefusal(maintenanceRunning, state);
              const code = !refusal ? undefined : maintenanceRunning ? "maintenance_in_progress" : "auto_start_refused";
              if (refusal) respond(command.id, false, undefined, refusal, code);
              else respond(command.id, true, await ensureDaemon({ explicit: !command.auto, force: command.force === true }));
              break;
            }
            case "stop_daemon": await stopDaemon(true); respond(command.id, true, await status()); break;
            case "request_maintenance": respond(command.id, true, requestMaintenance(command)); break;
            case "shutdown": respond(command.id, true); queueMicrotask(() => void close()); break;
            default: respond(undefined, false, undefined, "unknown supervisor command");
          }
        } catch (error: any) {
          respond(command.id, false, undefined, error.message, error.code);
        }
      })();
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  // 0600：plc 的 daemon stop/restart/upgrade 走这里，只给本机同一个用户。
  // 所在目录先收紧成 0700，listen 之后再把 socket 改成 0600（见 listenOwnerOnly）。
  await listenOwnerOnly(server, sockPath, (err) => log(`supervisor socket error: ${err.message}`));
  log(`supervisor listening on ${sockPath}`);

  const timer = setNodeInterval(() => {
    void maintenanceTick();
    if (state.desiredState === "running" && !daemonDown && !child) {
      void socketListening(daemonSockPath).then((listening) => {
        // plc.sock 不接受连接、但还持有 daemon.lock 的 daemon 还活着（例如卡住了，accept 队列满了），不算 daemon 没了。
        if (!listening && !child && !daemonLockHeld()) scheduleRestart();
      }).catch((error: Error) => log(`daemon check failed: ${error.message}`));
    }
  }, 1_000);

  if (state.desiredState === "running") {
    void ensureDaemon().catch((error) => {
      log(`initial daemon start failed: ${error.message}`);
      scheduleRestart();
    });
  } else {
    state.phase = "stopped";
    persist();
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    if (restartTimer) clearTimeout(restartTimer);
    await stopDaemon(false).catch((error) => log(`daemon stop during supervisor close failed: ${error.message}`));
    for (const client of clients) client.destroy();
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(sockPath)) unlinkSync(sockPath);
    state.supervisorPid = null;
    state.daemonPid = null;
    persist();
    closeLogFds();
    lock.release();
    log("supervisor closed");
  }

  return { sockPath, close };
}
