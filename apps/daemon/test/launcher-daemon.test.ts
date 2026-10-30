// 工单 14 的 Seam 3：真实的 daemon 进程、真实的派发循环、真实的 fake CLI 进程。
// 回归：旧代码里 child 的 stdio 是 daemon 的管道。daemon 进程一死，child 下一次写 stdout 就出错退出。
// 启动垫片持有 child 的 stdio，所以 daemon 死了以后 child 还在跑。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { recoverOrphans } from "../src/server.js";
import { applyRestartRecovery, planRestartRecovery } from "@pi-lead-child/engine";
import { parseLauncherIdentity } from "@pi-lead-child/runtime";
import { expectNoTestProcesses, testProcesses } from "@pi-lead-child/runtime/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";

let dir: string;
let workdir: string;
let db: Db;
let host: ChildProcess | null = null;
const childPids = new Set<number>();
const shimPids = new Set<number>();

beforeEach(() => {
  dir = tempDir("plc-launcher-daemon-");
  workdir = tempDir("plc-launcher-work-");
  db = openDb(join(dir, "plc.db"));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 先杀 child 的进程组，再杀它本身。垫片在 child 退出后自己退出。
function killChild(pid: number): void {
  for (const target of [-pid, pid]) {
    try { process.kill(target, "SIGKILL"); } catch { /* 已经退出 */ }
  }
}

afterEach(async () => {
  if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
  host = null;
  for (const pid of childPids) killChild(pid);
  // 垫片在 CLI 退出后写完退出记录才退出。等它退出，再删目录。
  await vi.waitFor(() => expect([...childPids, ...shimPids].filter(alive)).toEqual([]), { timeout: 10_000 });
  childPids.clear();
  shimPids.clear();
  db.close();
  // 上面没有记下的垫片，在数据目录删除以后停止 CLI 并退出。最后检查测试启动的进程都已经退出。
  // 最坏情况：等进程退出 10 秒，删除目录的重试约 5.5 秒（重试间隔线性增长），检查等 10 秒。
  const roots = [dir, workdir];
  const leftovers = testProcesses(roots);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try {
    await expectNoTestProcesses(roots, { tracked: leftovers });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}, 40_000);

function startHost(heartbeatFile: string): ChildProcess {
  // 命令行带上数据目录，测试结束时的检查据此认出它。
  const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/daemon/test/fake-launcher-daemon.ts"), dir], {
    env: {
      ...process.env,
      PLC_DATA_DIR: dir,
      PLC_ORCHESTRATOR_MS: "50",
      PLC_CHILD_LINGER_MS: "0",
      FAKE_CODEX_HEARTBEAT_FILE: heartbeatFile,
      FAKE_CODEX_HEARTBEAT_MS: "20000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr!.setEncoding("utf8").resume();
  return child;
}

function beats(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

interface HostIdentity { childPid: number; shimPid: number; dir: string; token: string; controlPath: string }

function startLauncherHost(env: Record<string, string>): { child: ChildProcess; identity: Promise<HostIdentity> } {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/daemon/test/fake-launcher-host.ts"), dir], {
    env: { ...process.env, HOST_LAUNCH_DIR: join(dir, "launches"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.setEncoding("utf8").resume();
  const identity = new Promise<HostIdentity>((done, fail) => {
    let text = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) done(JSON.parse(text.split("\n")[0]!) as HostIdentity);
    });
    child.once("exit", (code) => { if (!text.includes("\n")) fail(new Error(`host exited (${code})`)); });
  });
  return { child, identity };
}

describe("the launcher host process", () => {
  // 行为保持不变（工单 14）：以前宿主一退出，child 就因为管道断开而退出。现在宿主退出时显式停止它。
  it("stops its children when it exits normally", async () => {
    const started = startLauncherHost({ HOST_MODE: "exit" });
    host = started.child;
    const identity = await started.identity;
    childPids.add(identity.childPid);
    shimPids.add(identity.shimPid);
    await vi.waitFor(() => expect(alive(identity.childPid)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(existsSync(join(identity.dir, "exit.json"))).toBe(true), { timeout: 5_000 });
    expect(JSON.parse(readFileSync(join(identity.dir, "exit.json"), "utf8"))).toMatchObject({
      childPid: identity.childPid, exitCode: null, signal: "SIGTERM",
    });
  }, 30_000);

  // 和 plc work 一样，宿主没有自己的信号处理函数。以前终端的 Ctrl-C 同时送到 child（同一个进程组），
  // 管道也随宿主一起断开。现在 child 在自己的进程组里，所以宿主在信号结束它之前先停止 child。
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("stops its children when %s ends it", async (signal) => {
    const started = startLauncherHost({ HOST_MODE: "wait" });
    host = started.child;
    const identity = await started.identity;
    childPids.add(identity.childPid);
    shimPids.add(identity.shimPid);
    const hostExited = new Promise<NodeJS.Signals | null>((done) => host!.once("exit", (_code, received) => done(received)));
    host.kill(signal);
    expect(await hostExited).toBe(signal);
    await vi.waitFor(() => expect(alive(identity.childPid)).toBe(false), { timeout: 10_000 });
  }, 30_000);

  // daemon 被强杀以后重启：runtime 不能接管时，重启经核对过身份的垫片停止还活着的 CLI（工单 15），
  // 再走孤儿回收。垫片给整个进程组发 SIGTERM，宽限期后发 SIGKILL。
  // 以前回收只给 CLI 发一次 SIGTERM，忽略 SIGTERM 的 CLI 会和重派的新 Run 一起跑。
  it("lets the restart stop a surviving CLI through its verified shim, even if the CLI ignores SIGTERM", async () => {
    const itemId = createItem(db, { title: "orphan", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const started = startLauncherHost({
      HOST_MODE: "wait", HOST_CLI_IGNORES_SIGTERM: "1", HOST_KILL_GRACE_MS: "300", HOST_RUN_ID: String(runId),
    });
    host = started.child;
    const identity = await started.identity;
    childPids.add(identity.childPid);
    shimPids.add(identity.shimPid);
    // CLI 打印 ready 之前，它忽略 SIGTERM 的处理函数可能还没装上。
    await vi.waitFor(() => expect(readFileSync(join(identity.dir, "output.jsonl"), "utf8")).toContain("ready"));
    const hostExited = new Promise((done) => host!.once("exit", done));
    host.kill("SIGKILL");
    await hostExited;
    expect(alive(identity.childPid)).toBe(true);

    updateRun(db, runId, {
      state: "running", pid: identity.childPid,
      launcher: {
        version: 1, pid: identity.shimPid, childPid: identity.childPid, token: identity.token,
        dir: identity.dir, controlPath: identity.controlPath,
      },
    });
    const restart = applyRestartRecovery(db, await planRestartRecovery(db, { launchRoot: join(dir, "launches") }), {
      budget: { limit: 5, windowMs: 60_000 },
      canAdopt: () => false,
      adopt: () => { throw new Error("the runtime cannot adopt"); },
    });
    expect([...restart.reclaim]).toEqual([runId]);
    expect(recoverOrphans(db, { runIds: restart.reclaim })).toBe(1);
    await vi.waitFor(() => expect(alive(identity.childPid)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(existsSync(join(identity.dir, "exit.json"))).toBe(true), { timeout: 5_000 });
    const record = JSON.parse(readFileSync(join(identity.dir, "exit.json"), "utf8"));
    expect({ exitCode: record.exitCode, signal: record.signal }).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(getRun(db, runId)!.state).toBe("failed");
  }, 30_000);

  // 来自工单 10：Claude 的 MCP 配置里有工具桥 token。daemon 死了，CLI 之后才退出，配置目录由垫片删除。
  it("leaves the Claude MCP config to the shim, which removes it when the CLI exits after the host died", async () => {
    const capture = join(dir, "claude-capture.json");
    const started = startLauncherHost({ HOST_MODE: "wait", HOST_RUNTIME: "claude", FAKE_CLAUDE_CAPTURE: capture });
    host = started.child;
    const identity = await started.identity;
    childPids.add(identity.childPid);
    shimPids.add(identity.shimPid);
    const mcpConfigPath = await vi.waitFor(() => {
      const path = JSON.parse(readFileSync(capture, "utf8")).mcpConfigPath as string;
      expect(existsSync(path)).toBe(true);
      return path;
    }, { timeout: 10_000 });

    const hostExited = new Promise((done) => host!.once("exit", done));
    host.kill("SIGKILL");
    await hostExited;
    await delay(300);
    expect(alive(identity.childPid)).toBe(true);
    expect(existsSync(mcpConfigPath)).toBe(true);

    process.kill(-identity.childPid, "SIGTERM");
    await vi.waitFor(() => expect(existsSync(join(identity.dir, "exit.json"))).toBe(true), { timeout: 10_000 });
    expect(existsSync(mcpConfigPath)).toBe(false);
    expect(existsSync(join(mcpConfigPath, ".."))).toBe(false);
  }, 30_000);
});

describe("a child started by the daemon", () => {
  it("keeps running after the daemon process is killed", async () => {
    const itemId = createItem(db, { title: "long task", brief: "run for a while", createdBy: "user", workdir });
    createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex",
      trigger: "test", idempotencyKey: "launcher-daemon:1",
    });
    const heartbeat = join(dir, "heartbeat.log");
    host = startHost(heartbeat);

    const run = await vi.waitFor(() => {
      const row = db.prepare("SELECT id, state, pid FROM runs WHERE item_id=?").get(itemId) as
        { id: number; state: string; pid: number | null } | undefined;
      expect(row?.state).toBe("running");
      expect(row?.pid).toBeGreaterThan(0);
      expect(beats(heartbeat)).toBeGreaterThanOrEqual(2);
      return row!;
    }, { timeout: 15_000, interval: 50 });
    childPids.add(run.pid!);
    const launcher = parseLauncherIdentity(
      (db.prepare("SELECT * FROM runs WHERE id=?").get(run.id) as { launcher?: string | null }).launcher ?? null,
    );
    if (launcher) shimPids.add(launcher.pid);

    const hostExited = new Promise((done) => host!.once("exit", done));
    host.kill("SIGKILL");
    await hostExited;

    // 旧代码：child 在 daemon 死后的第一次写入时因为管道断开而退出。
    await delay(1_000);
    const before = beats(heartbeat);
    await delay(500);
    expect(alive(run.pid!)).toBe(true);
    expect(beats(heartbeat)).toBeGreaterThan(before);
    // 垫片继续把 child 的输出追加进这个 Run 的文件，daemon 重启后可以从文件补读（工单 15）。
    const output = join(launcher!.dir, "output.jsonl");
    const size = statSync(output).size;
    await delay(300);
    expect(statSync(output).size).toBeGreaterThan(size);
  }, 30_000);
});
