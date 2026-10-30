import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, LATEST_SCHEMA_VERSION } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { supervisorAvailable, supervisorListening, supervisorRequest } from "../src/client.js";
import type { SupervisorStatus } from "../src/protocol.js";
import {
  autoStartRefusal, DEFAULT_DAEMON_READY_TIMEOUT_MS, explicitStartRefusal, itemsBlockingMaintenance, pruneRestartBackups,
  startingDaemonVerdict, startSupervisor, type SupervisorHandle,
} from "../src/server.js";
import { loadSupervisorState } from "../src/state.js";
import { writeBuildProvenance } from "../src/deploy/readiness.js";
import { backupSqlite } from "../src/deploy/backup.js";
import { setTimeout as delay } from "node:timers/promises";

let handle: SupervisorHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function waitStatus(
  dir: string,
  predicate: (status: SupervisorStatus) => boolean,
): Promise<SupervisorStatus> {
  let latest: SupervisorStatus | null = null;
  await vi.waitFor(async () => {
    latest = await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir });
    expect(predicate(latest)).toBe(true);
  }, { timeout: 15_000, interval: 100 });
  return latest!;
}

describe("supervisor.sock", () => {
  // plc 的 daemon stop/restart/upgrade 走这条通道。它和 plc.sock 一样只给本机同一个用户。
  it("is readable and writable by the owner only", async () => {
    const dir = tempDir("plc-supervisor-mode-");
    handle = await startSupervisor({
      dataDir: dir,
      dbPath: join(dir, "plc.db"),
      daemonCommand: { bin: process.execPath, args: ["-e", ""] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      log: () => {},
    });
    expect(statSync(handle.sockPath).mode & 0o777).toBe(0o600);
  });
});

// 客户端（plc）发现 daemon 不在时会自动拉起它。自动拉起不能推翻用户的 plc daemon stop，
// 也不能在维护（备份、升级、重启）进行中插一脚。
describe("auto-start", () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const, desiredState: "running" as const, phase: "running" as const, supervisorPid: 1, daemonPid: null,
    crashCount: 0, lastDaemonExit: null, maintenance: null, updatedAt: "2026-10-13T04:00:00.000Z", ...overrides,
  });

  it("is refused after an explicit stop and while maintenance is really running", () => {
    expect(autoStartRefusal(state(), false)).toBeNull();
    expect(autoStartRefusal(state({ desiredState: "stopped", phase: "stopped" }), false)).toContain("plc daemon stop");
    expect(autoStartRefusal(state({ phase: "backing_up" }), true)).toContain("维护");
  });

  // supervisor 在升级途中死掉，状态文件里留下一条 running 的维护记录。拒绝只看活着的 supervisor 的状态。
  it("is not blocked by a stale maintenance record", () => {
    const stale = state({
      maintenance: { id: "m", action: "upgrade", reason: "r", requiredSchemaVersion: null, requestedAt: "", state: "running",
        startedAt: "", completedAt: null, backupPath: null, error: null },
    });
    expect(autoStartRefusal(stale, false)).toBeNull();
  });

  it("marks a maintenance run that a dead supervisor left unfinished as interrupted", () => {
    const dir = tempDir("plc-supervisor-stale-");
    const path = join(dir, "supervisor-state.json");
    writeFileSync(path, JSON.stringify(state({
      maintenance: { id: "m", action: "upgrade", reason: "r", requiredSchemaVersion: null, requestedAt: "", state: "running",
        startedAt: "2026-10-13T04:00:00.000Z", completedAt: null, backupPath: null, error: null },
    })));
    const loaded = loadSupervisorState(path);
    expect(loaded.maintenance).toMatchObject({ state: "interrupted", completedAt: expect.any(String) });
    expect(loaded.maintenance!.error).toContain("interrupted");
  });

  it("refuses even an explicit start while maintenance is really running", () => {
    expect(explicitStartRefusal(false)).toBeNull();
    expect(explicitStartRefusal(true)).toContain("等");
  });

  it("does not override plc daemon stop, while an explicit start still works", async () => {
    const dir = tempDir("plc-supervisor-auto-");
    const dbFile = join(dir, "plc.db");
    openDb(dbFile).close();
    writeFileSync(join(dir, "fake-active-items.json"), JSON.stringify([]));
    handle = await startSupervisor({
      dataDir: dir, dbPath: dbFile,
      daemonCommand: { bin: resolve("node_modules/.bin/tsx"), args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")] },
      cwd: process.cwd(), env: { PLC_DATA_DIR: dir }, restartBaseMs: 50, restartMaxMs: 200, log: () => {},
    });
    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 });
    await supervisorRequest({ type: "stop_daemon" }, { dataDir: dir, timeoutMs: 35_000 });
    await expect(supervisorRequest({ type: "ensure_running", auto: true }, { dataDir: dir, timeoutMs: 15_000 }))
      .rejects.toMatchObject({ code: "auto_start_refused", message: expect.stringContaining("plc daemon stop") });
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })).maintenanceActive).toBe(false);
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })).supervisor.desiredState).toBe("stopped");
    await expect(supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 }))
      .resolves.toMatchObject({ pid: expect.any(Number) });
  }, 60_000);
});

describe("runtime supervisor", () => {
  it("owns daemon lifecycle, drains maintenance, backs up SQLite and persists status", async () => {
    const dir = tempDir("plc-supervisor-");
    const dbFile = join(dir, "plc.db");
    openDb(dbFile).close();
    const activeFile = join(dir, "fake-active-items.json");
    writeFileSync(activeFile, JSON.stringify([]));

    handle = await startSupervisor({
      dataDir: dir,
      dbPath: dbFile,
      daemonCommand: {
        bin: resolve("node_modules/.bin/tsx"),
        args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")],
      },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 50,
      restartMaxMs: 200,
      log: () => {},
    });

    await expect(supervisorRequest(
      { type: "ensure_running" },
      { dataDir: dir, timeoutMs: 15_000 },
    )).resolves.toMatchObject({ pid: expect.any(Number) });

    const initial = await waitStatus(dir, (status) => Boolean(status.daemon?.pid));
    const firstPid = Number(initial.daemon?.pid);
    expect(initial.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    writeFileSync(activeFile, JSON.stringify([51]));
    await supervisorRequest({
      type: "request_maintenance",
      action: "upgrade",
      reason: "test schema deployment",
      requiredSchemaVersion: LATEST_SCHEMA_VERSION,
    }, { dataDir: dir });
    await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "waiting_for_drain");
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })).daemon?.pid)
      .toBe(firstPid);

    writeFileSync(activeFile, JSON.stringify([]));
    const upgraded = await waitStatus(dir, (status) =>
      status.supervisor.maintenance?.state === "succeeded" && Number(status.daemon?.pid) !== firstPid);
    expect(upgraded.supervisor.maintenance?.backupPath).toSatisfy((path: string | null) =>
      typeof path === "string" && existsSync(path));
    expect(upgraded.supervisor.phase).toBe("running");

    const afterUpgradePid = Number(upgraded.daemon?.pid);
    writeFileSync(join(dir, "fake-lead-busy"), "1\n");
    await supervisorRequest({
      type: "request_maintenance",
      action: "restart",
      reason: "wait for lead turn",
    }, { dataDir: dir });
    const draining = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "waiting_for_drain");
    expect(Number(draining.daemon?.pid)).toBe(afterUpgradePid);
    writeFileSync(join(dir, "fake-lead-busy"), "0\n");
    const drained = await waitStatus(dir, (status) =>
      status.supervisor.maintenance?.state === "succeeded" && Number(status.daemon?.pid) !== afterUpgradePid);
    expect(drained.supervisor.phase).toBe("running");

    await supervisorRequest({ type: "stop_daemon" }, { dataDir: dir, timeoutMs: 30_000 });
    const stopped = await waitStatus(dir, (status) => status.supervisor.desiredState === "stopped");
    expect(stopped.daemon).toBeNull();

    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 30_000 });
    const restarted = await waitStatus(dir, (status) => Boolean(status.daemon?.pid));
    expect(restarted.supervisor.desiredState).toBe("running");
  }, 30_000);

  // 工单 15 之后，经启动垫片启动的 child 在 daemon 重启后被接管（spec D7，用户故事 14）。
  // 所以维护不必等这样的 Run 结束。没有垫片身份的 Run 仍然要等，上面那条用例覆盖它。
  it("restarts at once when every running child can be adopted", async () => {
    const dir = tempDir("plc-supervisor-adopt-");
    const dbFile = join(dir, "plc.db");
    const seed = openDb(dbFile);
    const itemId = createItem(seed, { title: "long run", brief: "b", createdBy: "user" });
    const runId = createRun(seed, { itemId });
    updateRun(seed, runId, { state: "running" });
    seed.prepare("UPDATE runs SET launcher=? WHERE id=?").run(JSON.stringify({
      version: 1, pid: 999_999_999, childPid: null, token: "t".repeat(48),
      dir: join(dir, "launches", "run-1"), controlPath: join(dir, "launches", "run-1", "ctl.sock"),
    }), runId);
    seed.close();
    writeFileSync(join(dir, "fake-active-items.json"), JSON.stringify([itemId]));

    handle = await startSupervisor({
      dataDir: dir,
      dbPath: dbFile,
      daemonCommand: { bin: resolve("node_modules/.bin/tsx"), args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 50,
      restartMaxMs: 200,
      log: () => {},
    });
    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 });
    const firstPid = Number((await waitStatus(dir, (status) => Boolean(status.daemon?.pid))).daemon?.pid);

    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy a fix" }, { dataDir: dir });
    const restarted = await waitStatus(dir, (status) =>
      status.supervisor.maintenance?.state === "succeeded" && Number(status.daemon?.pid) !== firstPid);
    expect(restarted.supervisor.phase).toBe("running");
  }, 30_000);
});

// 部署闸门（2026-10-19）：每条重启路径都经过 supervisor 的维护入口。这里检查只部署已提交的代码，并在停 daemon 之前备份数据库。
// 审查 2026-10-19 第 4、5 条：以前闸门只在 Lead 的工具里（换模型的重启、plc daemon restart 都不查），并且先停机再备份。
describe("the deploy gate at the maintenance entry", () => {
  function deployCheckout(dir: string): { root: string; distDir: string; git: (...args: string[]) => string } {
    const root = join(dir, "checkout");
    const distDir = join(root, "apps", "daemon", "dist");
    mkdirSync(join(root, "packages"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "packages", "code.ts"), "export const x = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    mkdirSync(distDir, { recursive: true });
    writeBuildProvenance(root, distDir);
    return { root, distDir, git };
  }

  async function start(
    dir: string, deployment: { root: string; distDir: string },
    backupDatabase?: (source: string, destination: string) => Promise<void>,
  ) {
    const dbFile = join(dir, "plc.db");
    openDb(dbFile).close();
    writeFileSync(join(dir, "fake-active-items.json"), JSON.stringify([]));
    handle = await startSupervisor({
      ...(backupDatabase ? { backupDatabase } : {}),
      dataDir: dir,
      dbPath: dbFile,
      daemonCommand: { bin: resolve("node_modules/.bin/tsx"), args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 50,
      restartMaxMs: 200,
      log: () => {},
      deployment,
    });
    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 });
    return Number((await waitStatus(dir, (status) => Boolean(status.daemon?.pid))).daemon?.pid);
  }

  it("refuses a restart of uncommitted code from any client, and leaves the daemon running", async () => {
    const dir = tempDir("plc-supervisor-gate-");
    const deployment = deployCheckout(dir);
    const pid = await start(dir, deployment);
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })))
      .toMatchObject({ features: expect.arrayContaining(["deploy_gate"]), deploy: { ready: true } });

    writeFileSync(join(deployment.root, "packages", "code.ts"), "export const x = 2;\n");
    const refusal = await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "model switch" }, { dataDir: dir })
      .then(() => null, (error: Error & { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "deploy_refused", message: expect.stringContaining("packages/code.ts") });
    const after = await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir });
    expect(Number(after.daemon?.pid)).toBe(pid);
    expect(after.supervisor.maintenance).toBeNull();
  }, 30_000);

  it("backs up the database before it stops the daemon, for every restart", async () => {
    const dir = tempDir("plc-supervisor-backup-");
    const pid = await start(dir, deployCheckout(dir));
    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy" }, { dataDir: dir });
    const done = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "succeeded" && Number(status.daemon?.pid) !== pid);
    expect(done.supervisor.maintenance?.backupPath).toMatch(/backups\/plc-pre-restart-.+\.db$/);
    expect(existsSync(done.supervisor.maintenance!.backupPath!)).toBe(true);
  }, 30_000);

  it("does not stop the daemon when the backup fails", async () => {
    const dir = tempDir("plc-supervisor-backup-fails-");
    const pid = await start(dir, deployCheckout(dir));
    // backups 是一个普通文件：备份一定失败。
    writeFileSync(join(dir, "backups"), "in the way\n");
    await supervisorRequest({ type: "request_maintenance", action: "upgrade", reason: "migrate" }, { dataDir: dir });
    const failed = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "failed");
    expect(failed.supervisor.maintenance?.error).toContain("database backup failed, the daemon was not stopped");
    expect(Number(failed.daemon?.pid)).toBe(pid);
    expect(failed.supervisor.phase).toBe("running");
  }, 30_000);

  // 审查 2026-10-20 A、C：以前整个维护期间都不拉起崩溃的 daemon，备份还在做时 daemon 崩溃就没人管；
  // 并且备份在排空 Lead 之前做，排空期间 Lead 那一轮写的东西不在备份里。
  it("drains Lead before the backup, and restarts a daemon that crashes during the backup", async () => {
    const dir = tempDir("plc-supervisor-slow-backup-");
    const commands = () => readFileSync(join(dir, "fake-commands.log"), "utf8").split("\n").filter((type) => type && type !== "status");
    let release!: () => void;
    let seenAtBackup: string[] = [];
    let backupBegan!: () => void;
    const backupStarted = new Promise<void>((began) => { backupBegan = began; });
    const firstPid = await start(dir, deployCheckout(dir), async (source, destination) => {
      seenAtBackup = commands();
      backupBegan();
      await new Promise<void>((done) => { release = done; });
      await backupSqlite(source, destination);
    });
    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy" }, { dataDir: dir });
    await backupStarted;
    expect(seenAtBackup).toEqual(["drain"]);

    process.kill(firstPid, "SIGKILL");
    const restarted = await waitStatus(dir, (status) => Number(status.daemon?.pid) > 0 && Number(status.daemon?.pid) !== firstPid);
    const crashRestartPid = Number(restarted.daemon?.pid);
    release();
    const done = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "succeeded");
    expect(Number(done.daemon?.pid)).not.toBe(crashRestartPid);
    expect(existsSync(done.supervisor.maintenance!.backupPath!)).toBe(true);
  }, 45_000);

  // 审查 2026-10-20 B：以前 plc daemon stop 再 start，脏的主 checkout 照样拉起，也不备份。
  it("refuses plc daemon start on uncommitted code unless it is forced, and records the force", async () => {
    const dir = tempDir("plc-supervisor-start-gate-");
    const deployment = deployCheckout(dir);
    await start(dir, deployment);
    await supervisorRequest({ type: "stop_daemon" }, { dataDir: dir, timeoutMs: 30_000 });
    writeFileSync(join(deployment.root, "packages", "code.ts"), "export const x = 5;\n");

    const refusal = await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 })
      .then(() => null, (error: Error & { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "deploy_refused", message: expect.stringContaining("packages/code.ts") });
    await delay(1_500);
    const stopped = await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir });
    expect(stopped.supervisor.desiredState).toBe("stopped");
    expect(stopped.daemon).toBeNull();

    const forced = await supervisorRequest<Record<string, unknown>>({ type: "ensure_running", force: true }, { dataDir: dir, timeoutMs: 15_000 });
    expect(forced.forcedPastDeployGate).toEqual([expect.stringContaining("packages/code.ts")]);
    expect((await waitStatus(dir, (status) => Boolean(status.daemon?.pid))).supervisor.desiredState).toBe("running");
  }, 45_000);

  // 审查 2026-10-20 D：status 每次都跑好几个 git 命令。现在缓存一会儿；维护请求仍然当场再查。
  it("caches the gate's answer in status, but checks again for a maintenance request", async () => {
    const dir = tempDir("plc-supervisor-status-cache-");
    const deployment = deployCheckout(dir);
    await start(dir, deployment);
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })).deploy?.ready).toBe(true);
    writeFileSync(join(deployment.root, "packages", "code.ts"), "export const x = 6;\n");
    expect((await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir })).deploy?.ready).toBe(true);
    const refusal = await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy" }, { dataDir: dir })
      .then(() => null, (error: Error & { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "deploy_refused" });
  }, 30_000);

  it("checks the checkout again right before the stop, after waiting for Lead", async () => {
    const dir = tempDir("plc-supervisor-recheck-");
    const deployment = deployCheckout(dir);
    const pid = await start(dir, deployment);
    writeFileSync(join(dir, "fake-lead-busy"), "1\n");
    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy" }, { dataDir: dir });
    await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "waiting_for_drain");
    writeFileSync(join(deployment.root, "packages", "code.ts"), "export const x = 3;\n");
    writeFileSync(join(dir, "fake-lead-busy"), "0\n");
    const failed = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "failed");
    expect(failed.supervisor.maintenance?.error).toContain("deploy refused");
    expect(Number(failed.daemon?.pid)).toBe(pid);
  }, 30_000);

  it("keeps only the newest restart backups and leaves the others alone", () => {
    const dir = join(tempDir("plc-supervisor-prune-"), "backups");
    mkdirSync(dir);
    for (let day = 10; day <= 22; day += 1) writeFileSync(join(dir, `plc-pre-restart-2026-10-${day}T00-00-00-000Z.db`), "");
    writeFileSync(join(dir, "plc-pre-upgrade-2026-10-01T00-00-00-000Z.db"), "");
    writeFileSync(join(dir, "plc.db.pre-08ffd82-20261016-2101"), "");
    const removed = pruneRestartBackups(dir, 10);
    expect(removed).toEqual([10, 11, 12].map((day) => `plc-pre-restart-2026-10-${day}T00-00-00-000Z.db`));
    expect(readdirSync(dir)).toHaveLength(12);
    expect(readdirSync(dir)).toContain("plc-pre-upgrade-2026-10-01T00-00-00-000Z.db");
  });
});

// 2026-10-16 07:57：部署时 supervisor 停 daemon，直接发 shutdown，打断了 Lead 正在建提醒 #83 的那一轮。
// 现在 supervisor 先请 daemon 排空 Lead（drain），等它回答（这一轮结束，或者 daemon 到时中断了它），才发 shutdown。
describe("stopping the daemon while Lead is answering", () => {
  it("asks the daemon to drain Lead first, and sends shutdown only after the drain answers", async () => {
    const dir = tempDir("plc-supervisor-drain-");
    const dbFile = join(dir, "plc.db");
    openDb(dbFile).close();
    writeFileSync(join(dir, "fake-active-items.json"), JSON.stringify([]));
    handle = await startSupervisor({
      dataDir: dir,
      dbPath: dbFile,
      daemonCommand: { bin: resolve("node_modules/.bin/tsx"), args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 50,
      restartMaxMs: 200,
      log: () => {},
    });
    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 });
    await waitStatus(dir, (status) => Boolean(status.daemon?.pid));
    const commands = () => {
      const path = join(dir, "fake-commands.log");
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((type) => type && type !== "status") : [];
    };

    writeFileSync(join(dir, "fake-lead-busy"), "1\n");
    const stopping = supervisorRequest({ type: "stop_daemon" }, { dataDir: dir, timeoutMs: 30_000 });
    await vi.waitFor(() => expect(commands()).toContain("drain"), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Lead 还在跑这一轮：supervisor 不能先发 shutdown。
    expect(commands()).not.toContain("shutdown");

    writeFileSync(join(dir, "fake-lead-busy"), "0\n");
    await stopping;
    expect(commands()).toEqual(["drain", "shutdown"]);
  }, 30_000);
});

// 2026-10-19 14:53Z 部署 f87d743：机器负载约 37，新 daemon 14:54:01Z 启动，14:54:40Z 才开始监听。
// 维护在 14:54:31Z 记成失败（等就绪的期限固定 30 秒）。之后 phase 一直是 degraded，daemon 好了也没回到 running。
// 测试不真等 30 秒：fake daemon 拿到 daemon.lock 以后先不监听，测试把 supervisor 看到的时钟（Date）往前拨。
// 计时器照常走，只有 Date 被拨动。
describe("a daemon that starts slower than the ready deadline", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function supervise(dir: string): Promise<number> {
    const dbFile = join(dir, "plc.db");
    openDb(dbFile).close();
    writeFileSync(join(dir, "fake-active-items.json"), JSON.stringify([]));
    handle = await startSupervisor({
      dataDir: dir,
      dbPath: dbFile,
      daemonCommand: { bin: resolve("node_modules/.bin/tsx"), args: [resolve("packages/supervisor/test/fake-supervised-daemon.ts")] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 50,
      restartMaxMs: 200,
      log: () => {},
    });
    await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: 15_000 });
    return Number((await waitStatus(dir, (status) => Boolean(status.daemon?.pid))).daemon?.pid);
  }

  // 维护停掉旧 daemon、拉起新 daemon。新 daemon 拿到锁，还没监听。返回它的 pid。
  async function restartIntoSlowStart(dir: string): Promise<number> {
    writeFileSync(join(dir, "fake-hold-start"), "");
    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy under load" }, { dataDir: dir });
    const holding = join(dir, "fake-holding");
    await vi.waitFor(() => expect(existsSync(holding)).toBe(true), { timeout: 15_000, interval: 50 });
    return Number(readFileSync(holding, "utf8"));
  }

  it("keeps waiting for a live daemon past 30 s, so the maintenance succeeds", async () => {
    const dir = tempDir("plc-supervisor-slow-start-");
    const firstPid = await supervise(dir);
    const slowPid = await restartIntoSlowStart(dir);
    expect(slowPid).not.toBe(firstPid);

    vi.setSystemTime(Date.now() + 31_000);
    await new Promise((done) => setTimeout(done, 1_000));
    // 进程还活着，只是启动慢：维护还在等，没有记成失败。
    const waiting = await supervisorRequest<SupervisorStatus>({ type: "status" }, { dataDir: dir });
    expect(waiting.supervisor.maintenance).toMatchObject({ state: "running", error: null });

    unlinkSync(join(dir, "fake-hold-start"));
    const done = await waitStatus(dir, (status) => status.supervisor.maintenance?.state !== "running");
    expect(done.supervisor.maintenance).toMatchObject({ state: "succeeded", error: null });
    expect(done.supervisor.phase).toBe("running");
    expect(Number(done.daemon?.pid)).toBe(slowPid);
  }, 45_000);

  it("returns to running once the daemon answers, even after the maintenance gave up on it", async () => {
    const dir = tempDir("plc-supervisor-slow-recover-");
    await supervise(dir);
    const slowPid = await restartIntoSlowStart(dir);

    // 拨过任何期限：维护放弃等待，记成失败。
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const failed = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "failed");
    expect(failed.supervisor.maintenance?.error).toContain("did not become ready");

    unlinkSync(join(dir, "fake-hold-start"));
    // daemon 好了：phase 回到 running，用的还是这个 daemon，没有再重启一次。
    const recovered = await waitStatus(dir, (status) => status.supervisor.phase === "running" && Boolean(status.daemon?.pid));
    expect(Number(recovered.daemon?.pid)).toBe(slowPid);
    const persisted = JSON.parse(readFileSync(join(dir, "supervisor-state.json"), "utf8"));
    expect(persisted).toMatchObject({ phase: "running", daemonPid: slowPid });
  }, 45_000);

  it("stops waiting as soon as the new daemon exits, and starts another one", async () => {
    const dir = tempDir("plc-supervisor-start-exit-");
    const firstPid = await supervise(dir);
    writeFileSync(join(dir, "fake-exit-on-start"), "");
    await supervisorRequest({ type: "request_maintenance", action: "restart", reason: "deploy a broken build" }, { dataDir: dir });

    const failed = await waitStatus(dir, (status) => status.supervisor.maintenance?.state === "failed");
    expect(failed.supervisor.maintenance?.error).toContain("exited");
    const recovered = await waitStatus(dir, (status) =>
      status.supervisor.phase === "running" && Boolean(status.daemon?.pid) && Number(status.daemon?.pid) !== firstPid);
    expect(recovered.supervisor.desiredState).toBe("running");
  }, 45_000);
});

// 决策边界：一个已经启动、还没回答 status 的 daemon，要不要接着等。
describe("waiting for a daemon that is starting", () => {
  it("keeps waiting while the process is alive, and stops when it exits or passes the limit", () => {
    const verdict = (answered: boolean, exited: boolean, waitedMs: number) =>
      startingDaemonVerdict({ answered, exited, waitedMs, timeoutMs: DEFAULT_DAEMON_READY_TIMEOUT_MS });
    // 2026-10-19 14:54Z：负载约 37，daemon 39 秒才开始监听。进程活着，它还在启动。
    expect(verdict(false, false, 39_000)).toBe("starting");
    expect(verdict(true, false, 39_000)).toBe("ready");
    expect(verdict(false, true, 1_000)).toBe("exited");
    expect(verdict(false, false, DEFAULT_DAEMON_READY_TIMEOUT_MS)).toBe("timed_out");
  });
});

// 决策边界：维护要等哪些在跑的工单。拿不准时宁可等。
describe("items that block maintenance", () => {
  it("waits only for runs that a new daemon cannot adopt", () => {
    const dir = tempDir("plc-supervisor-blockers-");
    const dbFile = join(dir, "plc.db");
    const db = openDb(dbFile);
    const run = (withLauncher: boolean): number => {
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
      const runId = createRun(db, { itemId });
      updateRun(db, runId, { state: "running" });
      if (withLauncher) db.prepare("UPDATE runs SET launcher='{}' WHERE id=?").run(runId);
      return itemId;
    };
    const adoptable = run(true);
    const legacy = run(false);
    const unknown = 9_999;
    db.close();

    expect(itemsBlockingMaintenance(dbFile, [])).toEqual([]);
    expect(itemsBlockingMaintenance(dbFile, [adoptable])).toEqual([]);
    expect(itemsBlockingMaintenance(dbFile, [adoptable, legacy, unknown])).toEqual([legacy, unknown]);
    expect(itemsBlockingMaintenance(join(dir, "missing.db"), [adoptable])).toEqual([adoptable]);
  });
});

// 2026-10-15 live：一个忙着的 supervisor 750 ms 内没回 status，launchd 拉起的新 supervisor 就以为它不在，
// 删掉 socket 自己接管。之后两个 supervisor 同时在跑，没有子进程的那个还每秒探测 daemon：
// daemon 1.5 s 没回 status，它就再起一个 daemon（那个 daemon 发现已有实例，exit 0），并把这次退出记成崩溃。
// Lead 读到这条记录，告诉用户「daemon 17:56 又退出过一次」。真实的 daemon 一直在跑。
// 判断「已经有实例在跑」只能看连接能不能建立：进程活着但忙时，内核照样接受连接。
describe("single instance while the other side is busy", () => {
  const servers: Server[] = [];
  const accepted = new Set<Socket>();
  afterEach(async () => {
    // 先停 supervisor：它还在探测这些 socket。再断开已接受的连接，否则 close 一直等它们。
    await handle?.close();
    handle = null;
    for (const socket of accepted) socket.destroy();
    accepted.clear();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  });
  // 只接受连接、从不回答的 socket：一个活着但正忙的进程。
  async function busySocket(path: string): Promise<void> {
    const server = createServer((socket) => { accepted.add(socket); });
    servers.push(server);
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(path, () => done()); });
  }

  it("does not take over the socket from a supervisor that is alive but slow", async () => {
    const dir = tempDir("plc-supervisor-busy-");
    await busySocket(join(dir, "supervisor.sock"));
    await expect(startSupervisor({
      dataDir: dir,
      dbPath: join(dir, "plc.db"),
      daemonCommand: { bin: process.execPath, args: ["-e", ""] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      log: () => {},
    })).rejects.toThrow("supervisor already running");
  });

  it("does not start a second daemon while the daemon socket is listening but slow", async () => {
    const dir = tempDir("plc-supervisor-busy-daemon-");
    await busySocket(join(dir, "plc.sock"));
    const marker = join(dir, "spawned");
    handle = await startSupervisor({
      dataDir: dir,
      dbPath: join(dir, "plc.db"),
      daemonCommand: { bin: process.execPath, args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`] },
      cwd: process.cwd(),
      env: { PLC_DATA_DIR: dir },
      restartBaseMs: 100,
      restartMaxMs: 200,
      log: () => {},
    });
    await new Promise((done) => setTimeout(done, 4_000));
    expect(existsSync(marker)).toBe(false);
    expect(loadSupervisorState(join(dir, "supervisor-state.json")).crashCount).toBe(0);
  }, 15_000);

  it("reports a listening supervisor socket, so plc does not start another supervisor", async () => {
    const dir = tempDir("plc-supervisor-listening-");
    expect(await supervisorListening(dir)).toBe(false);
    await busySocket(join(dir, "supervisor.sock"));
    expect(await supervisorAvailable(dir)).toBe(false);
    expect(await supervisorListening(dir)).toBe(true);
  });
});
