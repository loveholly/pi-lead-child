// 工单 15：启动目录的清理规则。真实的 SQLite、真实的垫片。
// 活动的 Run 的目录不动；结束超过保留时间的目录删除；不活动的 Run 留下的垫片，核对身份后停止。
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { sweepLaunchDirectories } from "../src/pipeline/restart-adoption.js";
import { launchProcess, type LaunchedProcess } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

const day = 24 * 60 * 60_000;
let dir: string;
let db: Db;
const launched: LaunchedProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = tempDir("plc-launch-sweep-");
  db = openDb(join(dir, "plc.db"));
});

afterEach(async () => {
  for (const child of launched.splice(0)) {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    try { process.kill(child.launcher.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    await vi.waitFor(() => expect(alive(child.launcher.pid)).toBe(false), { timeout: 5_000 });
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(state: "running" | "finished" | "failed"): number {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state });
  return runId;
}

// 一个已经结束的启动目录：退出记录写于 endedAt。
function finishedLaunch(runId: number, endedAt: Date): string {
  const launch = join(dir, "launches", `r${runId}-done`);
  mkdirSync(launch, { recursive: true });
  writeFileSync(join(launch, "output.jsonl"), "");
  writeFileSync(join(launch, "exit.json"), JSON.stringify({
    version: 1, runId, shimPid: 1, childPid: 2, exitCode: 0, signal: null, spawnError: null, outputBytes: 0,
    endedAt: endedAt.toISOString(),
  }));
  return launch;
}

describe("the launch directory sweep", () => {
  it("removes the directories of runs that ended before the retention time, and keeps the others", async () => {
    const now = new Date();
    const old = finishedLaunch(run("finished"), new Date(now.getTime() - 8 * day));
    const recent = finishedLaunch(run("failed"), new Date(now.getTime() - 1 * day));
    const active = finishedLaunch(run("running"), new Date(now.getTime() - 30 * day));
    const unknown = finishedLaunch(9_999, new Date(now.getTime() - 8 * day));

    expect(await sweepLaunchDirectories(db, { dataDir: dir, now, retentionMs: 7 * day })).toEqual({ removed: 2, stopped: 0 });
    expect([old, recent, active, unknown].map(existsSync)).toEqual([false, true, true, false]);
    // 幂等：再扫一遍，没有可删的。
    expect(await sweepLaunchDirectories(db, { dataDir: dir, now, retentionMs: 7 * day })).toEqual({ removed: 0, stopped: 0 });
  });

  it("removes at most the limit, oldest runs first", async () => {
    const now = new Date();
    const launches = [run("finished"), run("finished"), run("finished")]
      .map((runId) => finishedLaunch(runId, new Date(now.getTime() - 8 * day)));
    expect(await sweepLaunchDirectories(db, { dataDir: dir, now, retentionMs: 7 * day, limit: 2 }))
      .toEqual({ removed: 2, stopped: 0 });
    expect(launches.map(existsSync)).toEqual([false, false, true]);
  });

  // daemon 被强杀时，Run 已经结束、但进程还在停留（例如 pi 等下一条 prompt）。没有人会再看管它。
  it("stops the verified shim of a run that is no longer active", async () => {
    const runId = run("finished");
    const child = await launchProcess({
      runId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" }, baseDir: join(dir, "launches"), killGraceMs: 300,
    });
    launched.push(child);
    child.stdout.resume();
    child.stderr.resume();
    child.detach();
    updateRun(db, runId, { launcher: child.launcher });

    expect(await sweepLaunchDirectories(db, { dataDir: dir, retentionMs: 7 * day })).toEqual({ removed: 0, stopped: 1 });
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => expect(existsSync(join(child.launcher.dir, "exit.json"))).toBe(true), { timeout: 5_000 });
  });

  it("removes a directory without an exit record only when its output has not changed for the retention time", async () => {
    const runId = run("failed");
    const launch = join(dir, "launches", `r${runId}-lost`);
    mkdirSync(launch, { recursive: true });
    writeFileSync(join(launch, "output.jsonl"), "");
    expect(await sweepLaunchDirectories(db, { dataDir: dir, retentionMs: 7 * day })).toEqual({ removed: 0, stopped: 0 });
    const stale = new Date(Date.now() - 8 * day);
    utimesSync(join(launch, "output.jsonl"), stale, stale);
    expect(await sweepLaunchDirectories(db, { dataDir: dir, retentionMs: 7 * day })).toEqual({ removed: 1, stopped: 0 });
    expect(existsSync(launch)).toBe(false);
  });
});
