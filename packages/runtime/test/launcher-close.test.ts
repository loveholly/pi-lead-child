// #592：daemon 自己新建的启动目录（plc-launch-*）要等垫片退出以后才删除，删除以后才发 close。
// 以前 close 之后立刻删除目录，垫片这时可能还在关闭控制 socket（删除 ctl.sock）。Linux 上 Node 24 的 rmSync
// 遇到同时被删的条目会只删一部分却不报错，测试文件结束时目录还在，CI 判这个文件失败。
// 这里用一个假垫片，不起真实进程，所以不需要 unix socket：只检查「垫片退出」和「删除目录、发 close」的先后。
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { LAUNCH_FILES, LaunchedProcess } from "../src/launcher.js";

class FakeShim extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

// 一个已经结束的启动目录：输出为空，退出记录已经写好。垫片写完退出记录以后、退出之前，就是这个样子。
function finishedLaunchDir(): string {
  const dir = join(tempDir("plc-launch-close-"), "launch");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, LAUNCH_FILES.output), "");
  writeFileSync(join(dir, LAUNCH_FILES.control), "");
  writeFileSync(join(dir, LAUNCH_FILES.exit), `${JSON.stringify({
    version: 1, runId: 7, shimPid: 999_999, childPid: null, exitCode: 0, signal: null, spawnError: null,
    outputBytes: 0, endedAt: new Date().toISOString(),
  })}\n`);
  return dir;
}

function launched(shim: FakeShim, dir: string): LaunchedProcess {
  return new LaunchedProcess({
    shim: shim as unknown as ChildProcess,
    identity: { version: 1, pid: 999_999, childPid: null, token: "t", dir, controlPath: join(dir, LAUNCH_FILES.control) },
    spawnError: null,
    hasStdin: false,
    removeDirOnClose: true,
    control: null,
  });
}

function closed(child: LaunchedProcess): { done: Promise<void>; fired: () => boolean } {
  let fired = false;
  const done = new Promise<void>((resolve) => child.once("close", () => {
    fired = true;
    resolve();
  }));
  return { done, fired: () => fired };
}

describe("the launch directory that the launcher created itself", () => {
  it("is removed only after the shim exits, and before close", async () => {
    const dir = finishedLaunchDir();
    const shim = new FakeShim();
    const child = launched(shim, dir);
    const close = closed(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // 退出记录已经读到，CLI 已经退出。垫片还没有退出：它可能还在用这个目录。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(close.fired()).toBe(false);
    expect(existsSync(dir)).toBe(true);

    shim.exit();
    await close.done;
    expect(existsSync(dir)).toBe(false);
  });

  it("is removed right away when the shim has already exited", async () => {
    const dir = finishedLaunchDir();
    const shim = new FakeShim();
    shim.exitCode = 0;
    const child = launched(shim, dir);
    await closed(child).done;
    expect(existsSync(dir)).toBe(false);
  });
});
