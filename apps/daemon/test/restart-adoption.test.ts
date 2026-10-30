// 工单 15 的 Seam 3：真实的 daemon 进程、真实的 SQLite、真实的垫片和 fake Codex 进程。
// 测试停止 daemon（SIGKILL 或正常停机），在同一个数据目录上启动新的 daemon，再看它怎样处理还在跑的 child。
// 回归：旧代码在重启时杀掉还活着的 child，把 Run 标成失败。
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import {
  launchProcess, parseLauncherIdentity, type LaunchedProcess, type LauncherIdentity,
} from "@pi-lead-child/runtime";
import { expectNoTestProcesses, scriptOf, testProcesses } from "@pi-lead-child/runtime/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { updateRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

let dir: string;
let workdir: string;
let gate: string;
let db: Db;
const daemons: ChildProcess[] = [];
const extraProcesses: ChildProcess[] = [];
const foreignLaunches: LaunchedProcess[] = [];

beforeEach(() => {
  dir = tempDir("plc-restart-");
  workdir = tempDir("plc-restart-work-");
  gate = join(dir, "gate.txt");
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

function launchers(): LauncherIdentity[] {
  return (db.prepare("SELECT launcher FROM runs WHERE launcher IS NOT NULL").all() as Array<{ launcher: string }>)
    .map((row) => parseLauncherIdentity(row.launcher))
    .filter((identity): identity is LauncherIdentity => identity !== null);
}

// 测试结束时按这个顺序停止它启动的进程：
// 1. daemon 的进程组。
// 2. 库里记着身份的 Run：CLI 的进程组和垫片。还有测试自己启动的进程。
// 3. 库里没有身份的垫片。测试杀掉 daemon 时，daemon 可能正在启动下一个 Run（例如成果修复回合）：
//    这个 Run 的垫片和 CLI 已经起来，身份还没有记进库，上一步找不到它们。所以先按测试目录记下它们，
//    再删除数据目录。启动目录不在了，垫片停止 CLI 并退出。垫片在退出前还可能往数据目录里写文件，所以删除时重试。
// 最后检查测试启动的进程都已经退出。还有活着的进程时，测试失败，这些进程被强制停止。
// 最坏情况：等库里记着的进程退出 10 秒，删除目录的重试约 5.5 秒（重试间隔线性增长），检查等 10 秒。
afterEach(async () => {
  const roots = [dir, workdir];
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise((done) => daemon.once("exit", done));
      try { process.kill(-daemon.pid!, "SIGKILL"); } catch { daemon.kill("SIGKILL"); }
      await exited;
    }
  }
  const pids: number[] = [];
  for (const extra of extraProcesses.splice(0)) {
    if (extra.pid) pids.push(extra.pid);
    extra.kill("SIGKILL");
  }
  for (const launched of foreignLaunches.splice(0)) {
    for (const target of [launched.pid ? -launched.pid : 0, launched.pid ?? 0, launched.launcher.pid]) {
      if (!target) continue;
      try { process.kill(target, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    pids.push(launched.launcher.pid, ...(launched.pid ? [launched.pid] : []));
  }
  for (const identity of launchers()) {
    for (const target of [identity.childPid ? -identity.childPid : 0, identity.childPid ?? 0, identity.pid]) {
      if (!target) continue;
      try { process.kill(target, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    pids.push(identity.pid, ...(identity.childPid ? [identity.childPid] : []));
  }
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 10_000 });
  db.close();
  const unregistered = testProcesses(roots);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try {
    await expectNoTestProcesses(roots, { tracked: unregistered });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}, 40_000);

// daemon 的环境不带开发者自己的 PLC_* 设置，只带测试给的。
function daemonEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("PLC_")) env[name] = value;
  }
  return {
    ...env,
    // 上面去掉了根 vitest 配置给的 PLC_DESKTOP_NOTIFY、PLC_GATEWAY_PORT 和 PLC_OPEN_FILES。不补上，daemon 会在
    // 用户桌面上弹通知，网关会去抢用户真实 daemon 的 47130 端口，打开文件会真的执行 open。
    PLC_DESKTOP_NOTIFY: "off",
    PLC_GATEWAY_PORT: "0",
    PLC_OPEN_FILES: "off",
    PLC_DATA_DIR: dir,
    PLC_ORCHESTRATOR_MS: "50",
    PLC_CHILD_LINGER_MS: "0",
    FAKE_CODEX_GATE_FILE: gate,
    ...extra,
  };
}

// daemon 有自己的进程组，测试结束时停止整个组。命令行带上数据目录，测试结束时的检查据此认出它。
async function startDaemonProcess(extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/daemon/test/fake-restart-daemon.ts"), dir], {
    env: daemonEnv(extra) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  daemons.push(child);
  let log = "";
  child.stderr!.setEncoding("utf8").on("data", (text: string) => { log += text; });
  await new Promise<void>((done, fail) => {
    let text = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("ready\n")) done();
    });
    child.once("exit", (code, signal) => fail(new Error(`daemon exited (${code ?? signal}) before it was ready:\n${log}`)));
  });
  return child;
}

async function stopDaemonProcess(daemon: ChildProcess, signal: NodeJS.Signals, timeoutMs = 10_000): Promise<void> {
  const exited = new Promise<void>((done) => daemon.once("exit", () => done()));
  daemon.kill(signal);
  await Promise.race([
    exited,
    delay(timeoutMs).then(() => { throw new Error(`daemon did not exit within ${timeoutMs}ms after ${signal}`); }),
  ]);
}

function step(line: string): void {
  appendFileSync(gate, `${line}\n`);
}

interface RunRow {
  id: number;
  state: string;
  pid: number | null;
  launcher: string | null;
  exit_code: number | null;
  error_code: string | null;
  failure_code: string | null;
}

function runsOf(itemId: number): RunRow[] {
  return db.prepare(
    "SELECT id, state, pid, launcher, exit_code, error_code, failure_code FROM runs WHERE item_id=? ORDER BY id",
  ).all(itemId) as RunRow[];
}

function runRow(runId: number): RunRow {
  return db.prepare(
    "SELECT id, state, pid, launcher, exit_code, error_code, failure_code FROM runs WHERE id=?",
  ).get(runId) as RunRow;
}

function messages(runId: number): string[] {
  return (db.prepare(
    "SELECT payload FROM runtime_events WHERE run_id=? AND event_type='message.completed' ORDER BY seq",
  ).all(runId) as Array<{ payload: string }>).map((row) => (JSON.parse(row.payload) as { text: string }).text);
}

function eventSeqs(runId: number): number[] {
  return (db.prepare("SELECT seq FROM runtime_events WHERE run_id=? ORDER BY seq").all(runId) as Array<{ seq: number }>)
    .map((row) => row.seq);
}

// 这张工单的 CLI：命令行里有工单工作目录的 fake codex 进程（codex 的 --cd）。
function ticketClis(): Array<{ pid: number }> {
  return testProcesses([workdir]).filter((target) => scriptOf(target.command)?.endsWith("/fake-codex.ts"));
}

// 数据目录里所有启动目录的输出。
function launchOutputs(): string {
  const root = join(dir, "launches");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .map((name) => join(root, name, "output.jsonl"))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("");
}

function dispatchGatedRun(key: string): number {
  const itemId = createItem(db, { title: "long task", brief: "run for a while", createdBy: "user", workdir });
  createDispatcher(db).request({
    itemId, role: "executor", purpose: "execution", runtime: "codex",
    trigger: "test", idempotencyKey: `restart-adoption:${key}`,
  });
  return itemId;
}

// 一个已经 claim、已经开始的派发请求，Run 还没有进程。测试自己给它填上 pid 和身份。
function claimRun(key: string): { itemId: number; runId: number } {
  const itemId = dispatchGatedRun(key);
  const dispatcher = createDispatcher(db);
  const claim = dispatcher.claimNext();
  if (!claim || claim.itemId !== itemId) throw new Error(`expected a claim for item #${itemId}`);
  dispatcher.markStarted(claim);
  return { itemId, runId: claim.runId };
}

async function runningRun(itemId: number): Promise<{ run: RunRow; launcher: LauncherIdentity }> {
  return vi.waitFor(() => {
    const run = runsOf(itemId)[0];
    expect(run?.state).toBe("running");
    const launcher = parseLauncherIdentity(run!.launcher);
    expect(launcher?.childPid).toBeGreaterThan(0);
    return { run: run!, launcher: launcher! };
  }, { timeout: 15_000, interval: 50 });
}

describe("a daemon restart", () => {
  it("adopts a child that is still running, reads what it wrote while the daemon was down, and completes the run", async () => {
    const itemId = dispatchGatedRun("adopt");
    let daemon = await startDaemonProcess();
    const { run, launcher } = await runningRun(itemId);
    step("step before the crash");
    await vi.waitFor(() => expect(messages(run.id)).toEqual(["before the crash"]), { timeout: 10_000 });

    await stopDaemonProcess(daemon, "SIGKILL");
    step("step while the daemon is down");
    await vi.waitFor(() => expect(readFileSync(join(launcher.dir, "output.jsonl"), "utf8"))
      .toContain("while the daemon is down"), { timeout: 10_000 });

    daemon = await startDaemonProcess();
    // 旧代码：孤儿回收杀掉 child，Run 被标成 failed。
    await delay(300);
    expect(alive(launcher.childPid!)).toBe(true);
    expect(runRow(run.id).state).toBe("running");
    await vi.waitFor(() => expect(messages(run.id)).toEqual(["before the crash", "while the daemon is down"]),
      { timeout: 10_000 });

    step("step after the restart");
    step("finish");
    await vi.waitFor(() => expect(runRow(run.id)).toMatchObject({ state: "finished", exit_code: 0 }), { timeout: 15_000 });
    expect(messages(run.id)).toEqual(["before the crash", "while the daemon is down", "after the restart"]);
    // 补读没有重复或跳过事件：seq 从 1 起连续。
    const seqs = eventSeqs(run.id);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities WHERE run_id=? AND kind='crash'").get(run.id))
      .toEqual({ n: 0 });
    await vi.waitFor(() => expect(alive(launcher.pid)).toBe(false), { timeout: 10_000 });
    expect(getItem(db, itemId)!.stage).not.toBe("cancelled");
  }, 60_000);

  // 正常停机不停止正在执行的 child。旧代码的 close 等 child 结束，所以 daemon 一直不退出。
  it("does not stop a running child on a normal shutdown, and the next daemon adopts it", async () => {
    const itemId = dispatchGatedRun("graceful");
    let daemon = await startDaemonProcess();
    const { run, launcher } = await runningRun(itemId);
    step("step before the shutdown");
    await vi.waitFor(() => expect(messages(run.id)).toEqual(["before the shutdown"]), { timeout: 10_000 });

    await stopDaemonProcess(daemon, "SIGTERM", 5_000);
    expect(alive(launcher.childPid!)).toBe(true);
    expect(runRow(run.id).state).toBe("running");

    step("step while the daemon is down");
    daemon = await startDaemonProcess();
    step("finish");
    await vi.waitFor(() => expect(runRow(run.id)).toMatchObject({ state: "finished", exit_code: 0 }), { timeout: 15_000 });
    expect(messages(run.id)).toEqual(["before the shutdown", "while the daemon is down"]);
  }, 60_000);

  // child 在 daemon 停机期间退出：重启后把输出读到末尾，再按退出记录走正常的完成或失败流程。
  it.each([
    { line: "finish", state: "finished", exitCode: 0, errorCode: null },
    { line: "fail", state: "failed", exitCode: null, errorCode: "remote_error" },
  ])("completes or fails a run whose child ended with '$line' while the daemon was down", async (outcome) => {
    const itemId = dispatchGatedRun(`exit-${outcome.line}`);
    let daemon = await startDaemonProcess();
    const { run, launcher } = await runningRun(itemId);
    await stopDaemonProcess(daemon, "SIGKILL");

    step("step while the daemon is down");
    step(outcome.line);
    await vi.waitFor(() => expect(existsSync(join(launcher.dir, "exit.json"))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(alive(launcher.pid)).toBe(false), { timeout: 10_000 });
    expect(runRow(run.id).state).toBe("running");

    daemon = await startDaemonProcess();
    await vi.waitFor(() => expect(runRow(run.id)).toMatchObject({
      state: outcome.state, exit_code: outcome.exitCode, error_code: outcome.errorCode,
    }), { timeout: 15_000 });
    expect(messages(run.id)).toEqual(["while the daemon is down"]);
    // 结局只处理一次：一个终止事件，一条 attempt_end。
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=? AND event_type IN ('run.completed','run.failed')",
    ).get(run.id)).toEqual({ n: 1 });
    await vi.waitFor(() => expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE run_id=? AND kind='attempt_end'",
    ).get(run.id)).toEqual({ n: 1 }), { timeout: 10_000 });
    // 结局来自退出记录，不是孤儿回收：没有"daemon 重启回收"的记录。
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE run_id=? AND kind='crash' AND payload LIKE '%daemon restart%'",
    ).get(run.id)).toEqual({ n: 0 });
  }, 60_000);

  // 身份核对：记下的 pid 被别的进程复用，或者控制 socket 后面是一个不认识这个 Run token 的垫片。
  // 两种情况都不接管，也不给那个进程发信号。Run 走孤儿回收：判为被中断，请求交回队列。
  it("neither adopts nor signals a process that reuses a recorded pid, or a shim that does not know the run token", async () => {
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    extraProcesses.push(decoy);
    const foreign = await launchProcess({
      runId: 999, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" }, baseDir: join(dir, "launches"),
    });
    foreignLaunches.push(foreign);

    const reused = claimRun("pid-reused");
    const goneDir = join(dir, "launches", `r${reused.runId}-gone`);
    updateRun(db, reused.runId, {
      state: "running", pid: decoy.pid!,
      launcher: {
        version: 1, pid: decoy.pid!, childPid: decoy.pid!, token: "a".repeat(48),
        dir: goneDir, controlPath: join(goneDir, "ctl.sock"),
      },
    });
    const wrongToken = claimRun("wrong-token");
    updateRun(db, wrongToken.runId, {
      state: "running", pid: foreign.pid!, launcher: { ...foreign.launcher, token: "b".repeat(48) },
    });

    await startDaemonProcess();
    for (const claim of [reused, wrongToken]) {
      expect(runRow(claim.runId)).toMatchObject({ state: "failed", failure_code: "run_interrupted" });
    }
    await delay(500);
    expect(alive(decoy.pid!)).toBe(true);
    expect(alive(foreign.launcher.pid)).toBe(true);
    expect(alive(foreign.pid!)).toBe(true);
  }, 60_000);
});

// 回归：测试杀掉 daemon 时，daemon 可能正在启动一个 Run。全量运行时常见的是成果修复回合。
// 这个 Run 的垫片和 CLI 已经起来，身份还没有记进库。以前测试的清理只按库里的身份停止进程，
// 这一对进程就一直活着，三天里在机器上积累了 82 个孤儿进程。afterEach 的检查让这种泄漏变成测试失败。
describe("a daemon killed while it is starting a run", () => {
  it("leaves no shim or CLI running after the test", async () => {
    const itemId = dispatchGatedRun("killed-while-starting");
    await startDaemonProcess({ FAKE_DAEMON_HOLD_START: "1" });
    // CLI 已经在写输出，Run 却还没有垫片的身份。afterEach 在这时杀掉 daemon。
    await vi.waitFor(() => expect(launchOutputs()).toContain("thread.started"), { timeout: 15_000 });
    expect(runsOf(itemId)).toMatchObject([{ state: "starting", launcher: null }]);
  }, 30_000);

  // 回归：下一个 daemon 认不出这个垫片。它回收并重派这个 Run，旧的 CLI 却还在运行，同一张工单上有两个 CLI。
  // 现在下一个 daemon 按启动目录里的启动记录核对这个垫片，先停止它，再回收和重派。
  it("lets the next daemon stop the CLI left behind, so the ticket never has two CLIs", async () => {
    const itemId = dispatchGatedRun("two-clis");
    const first = await startDaemonProcess({ FAKE_DAEMON_HOLD_START: "1" });
    await vi.waitFor(() => expect(launchOutputs()).toContain("thread.started"), { timeout: 15_000 });
    const [left] = ticketClis();
    expect(left).toBeDefined();
    await stopDaemonProcess(first, "SIGKILL");

    // 从新 daemon 启动之前开始数这张工单的 CLI，直到新的 Run 跑起来以后。
    const counts: number[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        counts.push(ticketClis().length);
        await delay(50);
      }
    })();
    try {
      await startDaemonProcess();
      // 原来的 Run 被回收，请求回到队列，新的 Run 启动了新的 CLI。
      await vi.waitFor(() => expect(runsOf(itemId).map((run) => run.state)).toEqual(["failed", "running"]), { timeout: 15_000 });
      await vi.waitFor(() => expect(ticketClis()).toHaveLength(1), { timeout: 10_000 });
      await delay(500);
    } finally {
      sampling = false;
      await sampler;
    }
    expect(runsOf(itemId)[0]).toMatchObject({ failure_code: "run_interrupted" });
    expect(alive(left!.pid)).toBe(false);
    expect(Math.max(...counts)).toBe(1);
  }, 60_000);
});

describe("the crash-loop budget", () => {
  function blockers(itemId: number): Array<{ payload: string }> {
    return db.prepare("SELECT payload FROM inbox WHERE item_id=? AND severity='blocker'").all(itemId) as Array<{ payload: string }>;
  }

  // 额度是 5 分钟内 1 次：第一次重启接管，第二次重启超过额度。Run 判为失败，child 被停止，只有一个 blocker。
  // 之后再重启，不会再接管、重派，也不会再升起 blocker。
  it("stops a run that every restart adopts again, and raises exactly one blocker", async () => {
    const env = { PLC_CRASH_LOOP_LIMIT: "1", PLC_CRASH_LOOP_WINDOW_MS: "300000" };
    const itemId = dispatchGatedRun("crash-loop");
    let daemon = await startDaemonProcess(env);
    const { run, launcher } = await runningRun(itemId);
    await stopDaemonProcess(daemon, "SIGKILL");

    daemon = await startDaemonProcess(env);
    step("step after the first restart");
    await vi.waitFor(() => expect(messages(run.id)).toEqual(["after the first restart"]), { timeout: 10_000 });
    expect(runRow(run.id).state).toBe("running");
    await stopDaemonProcess(daemon, "SIGKILL");

    daemon = await startDaemonProcess(env);
    expect(runRow(run.id)).toMatchObject({ state: "failed", failure_code: "restart_crash_loop" });
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    await vi.waitFor(() => expect(alive(launcher.childPid!)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(alive(launcher.pid)).toBe(false), { timeout: 10_000 });
    expect(blockers(itemId)).toHaveLength(1);
    // 宿主缺陷先交给 Lead（2026-10-15 起）：用户不收通知，Lead 处理不了时才升级。
    expect(JSON.parse(blockers(itemId)[0]!.payload)).toMatchObject({ blockerCode: "restart_crash_loop", runId: run.id, needsUser: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE item_id=?").get(itemId)).toEqual({ n: 0 });

    await stopDaemonProcess(daemon, "SIGKILL");
    await startDaemonProcess(env);
    await delay(500);
    expect(runsOf(itemId)).toHaveLength(1);
    expect(blockers(itemId)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ state: "failed" });
  }, 90_000);
});
