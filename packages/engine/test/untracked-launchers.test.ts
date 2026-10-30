// daemon 在启动垫片以后、记下 runs.launcher 之前被杀掉时，库里没有这个垫片的身份。
// 下一个 daemon 启动时按启动记录核对并停止它，然后才回收和重派这个 Run（stopUntrackedLaunchers）。
// 这里是这条规则的决策边界：真实的 SQLite、真实的垫片。端到端的用例在 apps/daemon/test/restart-adoption.test.ts。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { stopUntrackedLaunchers } from "../src/pipeline/restart-adoption.js";
import { LAUNCH_FILES, launchProcess, type LaunchedProcess } from "@pi-lead-child/runtime";
import { expectNoTestProcesses, testProcesses } from "@pi-lead-child/runtime/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

let dir: string;
let db: Db;
const launched: LaunchedProcess[] = [];
const decoys: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = tempDir("plc-untracked-");
  db = openDb(join(dir, "plc.db"));
});

// 测试自己启动的垫片、CLI 和诱饵进程都停止，然后检查没有留下进程。最坏情况：检查等 10 秒。
afterEach(async () => {
  for (const child of launched.splice(0)) {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    try { process.kill(child.launcher.pid, "SIGKILL"); } catch { /* 已经退出 */ }
  }
  for (const decoy of decoys.splice(0)) decoy.kill("SIGKILL");
  const leftovers = testProcesses([dir]);
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await expectNoTestProcesses([dir], { tracked: leftovers });
}, 30_000);

function startingRun(): number {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "starting" });
  return runId;
}

// 一个由 daemon 启动、之后 daemon 不再看管的垫片：CLI 一直运行。
async function shim(runId: number): Promise<LaunchedProcess> {
  const child = await launchProcess({
    runId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    env: { PATH: process.env.PATH ?? "" }, baseDir: join(dir, "launches"), killGraceMs: 300,
  });
  launched.push(child);
  child.stdout.resume();
  child.stderr.resume();
  child.detach();
  return child;
}

const launchRoot = () => join(dir, "launches");

describe("a launcher that no run recorded", () => {
  it("is stopped after its identity is verified, and the daemon waits until it has exited", async () => {
    const child = await shim(startingRun());
    expect(await stopUntrackedLaunchers(db, { launchRoot: launchRoot() })).toBe(1);
    // 垫片写下退出记录以后才退出，所以等待结束时，退出记录已经在了。
    expect(existsSync(join(child.launcher.dir, LAUNCH_FILES.exit))).toBe(true);
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 5_000 });
    // 幂等：再执行一次，没有要停止的垫片。
    expect(await stopUntrackedLaunchers(db, { launchRoot: launchRoot() })).toBe(0);
  });

  it("is left to the restart adoption when the run's identity names it", async () => {
    const runId = startingRun();
    const child = await shim(runId);
    updateRun(db, runId, { state: "running", launcher: child.launcher });
    expect(await stopUntrackedLaunchers(db, { launchRoot: launchRoot() })).toBe(0);
    expect(alive(child.pid!)).toBe(true);
  });

  // 启动记录在磁盘上，可能被改写。核对不通过时，记录里的 pid 不能收到信号。
  it("is not signalled when its launch record does not verify", async () => {
    const runId = startingRun();
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    decoys.push(decoy);
    const launch = join(launchRoot(), `r${runId}-forged`);
    mkdirSync(launch, { recursive: true, mode: 0o700 });
    writeFileSync(join(launch, LAUNCH_FILES.record), JSON.stringify({
      version: 1, pid: decoy.pid, childPid: null, token: "a".repeat(48),
      dir: launch, controlPath: join(launch, LAUNCH_FILES.control), runId,
    }), { mode: 0o600 });
    expect(await stopUntrackedLaunchers(db, { launchRoot: launchRoot() })).toBe(0);
    await delay(300);
    expect(alive(decoy.pid!)).toBe(true);
  });

  it("is left alone when the database does not know its run", async () => {
    const child = await shim(9_999);
    expect(await stopUntrackedLaunchers(db, { launchRoot: launchRoot() })).toBe(0);
    expect(alive(child.pid!)).toBe(true);
  });
});
