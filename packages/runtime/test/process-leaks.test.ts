// 测试进程检查（testing/process-leaks.ts）的决策边界：哪些进程算作测试留下的进程，哪些不算。
// 兜底检查按脚本认进程。同一个脚本也可能由别人运行，所以它只认本进程名下的进程和孤儿，并且只报告，不停止进程。
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  expectNoTestProcesses, expectProcessesGone, killTestProcesses, scriptOf, scriptProcesses, testProcesses,
} from "../testing/process-leaks.js";

const NODE = process.execPath;
let dir: string;
let script: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = tempDir("plc-leaks-");
  script = join(dir, "fixture.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  killTestProcesses(testProcesses([dir]));
  await expectNoTestProcesses([dir]);
  rmSync(dir, { recursive: true, force: true });
});

function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: "ignore" });
  children.push(child);
  return child;
}

// 运行 fixture 脚本的 node 进程。
function fixturePid(): Promise<number> {
  return vi.waitFor(() => {
    const found = testProcesses([dir]).find((target) => scriptOf(target.command) === script);
    expect(found).toBeDefined();
    return found!.pid;
  }, { timeout: 5_000 });
}

function counted(): number[] {
  return scriptProcesses([script]).map((target) => target.pid);
}

describe("the script that a node process runs", () => {
  it("skips node options and the tsx entry", () => {
    expect(scriptOf("/bin/node /r/launcher-shim.mjs")).toBe("/r/launcher-shim.mjs");
    expect(scriptOf("/bin/node --import=tsx /r/fake-codex.ts exec --json --cd /w")).toBe("/r/fake-codex.ts");
    expect(scriptOf("/bin/node --import tsx /r/fake-restart-daemon.ts /d")).toBe("/r/fake-restart-daemon.ts");
    expect(scriptOf("/bin/node /r/node_modules/tsx/dist/cli.mjs /r/fake-pi.ts --mode rpc")).toBe("/r/fake-pi.ts");
    expect(scriptOf("/bin/node --require /r/preflight.cjs --import file:///r/loader.mjs /r/fake-pi.ts --mode rpc"))
      .toBe("/r/fake-pi.ts");
  });

  it("is not a file that only appears among the arguments", () => {
    expect(scriptOf("/bin/node -e setInterval(()=>{},1000) /r/launcher-shim.mjs")).toBeNull();
    expect(scriptOf("/bin/node /r/other.mjs /r/launcher-shim.mjs")).toBe("/r/other.mjs");
    expect(scriptOf("tail -f /r/launcher-shim.mjs")).toBeNull();
    expect(scriptOf("vim /r/launcher-shim.mjs")).toBeNull();
  });
});

describe("the processes that run a script", () => {
  it("count a process that this process started", async () => {
    const child = start(NODE, [script]);
    await vi.waitFor(() => expect(counted()).toContain(child.pid));
  });

  it("count an orphan, because nobody else looks after it", async () => {
    const shell = start("sh", ["-c", `${NODE} ${script} &`]);
    await new Promise((done) => shell.once("exit", done));
    const pid = await fixturePid();
    expect(counted()).toContain(pid);
  });

  // 例如另一个 vitest 或者源码模式的 daemon 启动的垫片：它的父进程还活着，并且不是本进程的子孙。
  it("do not count a process that another live process looks after", async () => {
    const shell = start("sh", ["-c", `(${NODE} ${script} & wait) &`]);
    await new Promise((done) => shell.once("exit", done));
    const pid = await fixturePid();
    expect(counted()).not.toContain(pid);
  });

  it("do not count a process that only names the script, such as tail or node -e", async () => {
    const tail = start("tail", ["-f", script]);
    const inline = start(NODE, ["-e", "setInterval(() => {}, 1000)", script]);
    await vi.waitFor(() => expect(testProcesses([dir]).map((target) => target.pid)).toContain(inline.pid));
    expect(counted()).not.toContain(tail.pid);
    expect(counted()).not.toContain(inline.pid);
  });

  it("are reported but not stopped when the check must not kill", async () => {
    const child = start(NODE, [script]);
    await vi.waitFor(() => expect(counted()).toContain(child.pid));
    await expect(expectProcessesGone(() => scriptProcesses([script]), { kill: false, timeoutMs: 200 }))
      .rejects.toThrow(`pid=${child.pid}`);
    // 被杀掉的子进程在回收之前还是僵尸，kill(pid, 0) 照样成功。所以看它有没有退出事件。
    const exited = await Promise.race([
      new Promise<boolean>((done) => child.once("exit", () => done(true))),
      delay(500).then(() => false),
    ]);
    expect(exited).toBe(false);
  });
});
