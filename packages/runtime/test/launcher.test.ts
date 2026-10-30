// 工单 14 的 Seam 2：启动垫片的进程边界。真实的垫片进程、真实的 CLI 进程（node -e 脚本）。
// 断言只看外部能观察到的东西：CLI 的输出和退出、垫片写下的文件、文件的权限、控制 socket 的应答。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { RuntimeEventSequencer } from "../src/event-queue.js";
import {
  LAUNCH_FILES, launchProcess, readExitRecord, readLaunchRecord, type LaunchedProcess, type LaunchSpec,
} from "../src/launcher.js";
import { outputCursorOf } from "../src/output-cursor.js";
import { expectNoTestProcesses } from "../testing/process-leaks.js";

const dirs: string[] = [];
const launched: LaunchedProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const child of launched.splice(0)) {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    try { process.kill(child.launcher.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    await vi.waitFor(() => expect(alive(child.launcher.pid)).toBe(false), { timeout: 5_000 });
  }
  // 测试启动的进程都已经停止：没有指向测试目录的垫片，也没有它们的 CLI。
  await expectNoTestProcesses(dirs);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // 最坏情况：每个垫片等 5 秒，检查等 10 秒。
}, 30_000);

function baseDir(): string {
  const dir = tempDir("plc-launch-test-");
  dirs.push(dir);
  return dir;
}

async function launch(script: string, overrides: Partial<LaunchSpec> = {}): Promise<LaunchedProcess> {
  const child = await launchProcess({
    runId: 7,
    command: process.execPath,
    args: ["-e", script],
    env: { PATH: process.env.PATH ?? "" },
    baseDir: baseDir(),
    ...overrides,
  });
  launched.push(child);
  return child;
}

interface Collected {
  stdout: string;
  stderr: string;
  exit: [number | null, NodeJS.Signals | null] | null;
  close: [number | null, NodeJS.Signals | null];
}

function collect(child: LaunchedProcess): Promise<Collected> {
  let stdout = "";
  let stderr = "";
  let exit: Collected["exit"] = null;
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  child.on("exit", (code, signal) => { exit = [code, signal]; });
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ stdout, stderr, exit, close: [code, signal] }));
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("the exit record", () => {
  it("matches the real exit code of the CLI", async () => {
    const child = await launch("process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(7)");
    const result = await collect(child);
    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exit: [7, null], close: [7, null] });
    expect(readExitRecord(child.launcher.dir)).toMatchObject({
      exitCode: 7, signal: null, spawnError: null, childPid: child.pid, shimPid: child.launcher.pid, runId: 7,
    });
    expect(child.exitCode).toBe(7);
  });

  it("matches the signal that killed the CLI", async () => {
    const child = await launch("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)");
    const result = collect(child);
    await vi.waitFor(() => expect(readFileSync(join(child.launcher.dir, LAUNCH_FILES.output), "utf8")).toContain("ready"));
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await result).toMatchObject({ exit: [null, "SIGKILL"], close: [null, "SIGKILL"] });
    expect(readExitRecord(child.launcher.dir)).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("records a CLI that cannot start, the same way node reports it", async () => {
    const child = await launch("", { command: "/definitely/missing/cli" });
    const errors: Error[] = [];
    child.on("error", (error) => errors.push(error));
    const result = await collect(child);
    expect(child.pid).toBeUndefined();
    expect(errors.map((error) => error.message)).toEqual(["spawn /definitely/missing/cli ENOENT"]);
    expect(result).toMatchObject({ exit: null, close: [-2, null] });
    expect(readExitRecord(child.launcher.dir)).toMatchObject({
      exitCode: null, signal: null, childPid: null,
      spawnError: { code: "ENOENT", message: "spawn /definitely/missing/cli ENOENT" },
    });
  });

  it("is written after the whole output, so a reader that sees it has the complete output", async () => {
    const child = await launch("for (let i = 0; i < 2000; i++) process.stdout.write(`line ${i}\\n`); process.stderr.write('tail\\n')");
    const result = await collect(child);
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(2000);
    expect(result.stderr).toBe("tail\n");
    const record = readExitRecord(child.launcher.dir)!;
    expect(record.outputBytes).toBe(statSync(join(child.launcher.dir, LAUNCH_FILES.output)).size);
  });
});

describe("the launch files", () => {
  it("are private to the current user", async () => {
    const child = await launch("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)");
    const result = collect(child);
    await vi.waitFor(() => expect(existsSync(child.launcher.controlPath)).toBe(true));
    expect(mode(child.launcher.dir)).toBe(0o700);
    expect(mode(join(child.launcher.dir, LAUNCH_FILES.output))).toBe(0o600);
    expect(mode(join(child.launcher.dir, LAUNCH_FILES.log))).toBe(0o600);
    expect(mode(child.launcher.controlPath)).toBe(0o600);
    child.kill("SIGTERM");
    await result;
    expect(mode(join(child.launcher.dir, LAUNCH_FILES.exit))).toBe(0o600);
  });

  // daemon 在记下 runs.launcher 之前被杀掉时，下一个 daemon 按启动记录认出这个垫片（工单 15 的缺口）。
  // 记录里有 token，所以文件只给当前用户，token 也不进垫片的日志和命令行。
  it("include a private launch record that names the shim, while the token stays out of its log and argv", async () => {
    const child = await launch("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)");
    const record = join(child.launcher.dir, LAUNCH_FILES.record);
    expect(mode(record)).toBe(0o600);
    expect(existsSync(`${record}.tmp`)).toBe(false);
    expect(readLaunchRecord(child.launcher.dir)).toEqual({ runId: 7, identity: { ...child.launcher, childPid: null } });
    await vi.waitFor(() => expect(readFileSync(join(child.launcher.dir, LAUNCH_FILES.output), "utf8")).toContain("ready"));
    expect(readFileSync(join(child.launcher.dir, LAUNCH_FILES.log), "utf8")).not.toContain(child.launcher.token);
    const argv = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(child.launcher.pid)], { encoding: "utf8" });
    expect(argv).toContain("launcher-shim.mjs");
    expect(argv).not.toContain(child.launcher.token);
  });

  it("frame stdout by line, in the order the shim received the output", async () => {
    const child = await launch([
      "process.stdout.write('par');",
      "setTimeout(() => process.stdout.write('tial\\nnext'), 100);",
      "setTimeout(() => process.stderr.write('warn'), 200);",
      "setTimeout(() => process.stdout.write(' line\\n'), 300);",
    ].join(""));
    const result = await collect(child);
    expect(result.stdout).toBe("partial\nnext line\n");
    const frames = readFileSync(join(child.launcher.dir, LAUNCH_FILES.output), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(frames).toEqual([
      { stream: "stdout", text: "partial\n" },
      { stream: "stderr", text: "warn" },
      { stream: "stdout", text: "next line\n" },
    ]);
  });

  it("only lets the shim remove private temporary paths on exit", async () => {
    for (const path of [process.cwd(), tmpdir(), "relative/dir", join(tmpdir(), "..", "escape")]) {
      await expect(launch("process.exit(0)", { removeOnExit: [path] })).rejects.toThrow(/refuses to remove/);
    }
    const temporary = tempDir("plc-remove-on-exit-");
    const child = await launch("process.exit(0)", { removeOnExit: [temporary] });
    await collect(child);
    expect(existsSync(temporary)).toBe(false);
  });

  it("are removed after the run when no launch directory was given", async () => {
    const child = await launch("process.exit(0)", { baseDir: undefined });
    await collect(child);
    expect(existsSync(child.launcher.dir)).toBe(false);
  });
});

describe("the output cursor of a launched process", () => {
  // 超过 1 MiB 的一行被垫片拆成几帧。游标要停在这一行的第一帧，续读时 adapter 才拿到完整的一行。
  it("stays at the first frame of a stdout line that the shim split into several frames", async () => {
    const child = await launch("process.stdout.write('x'.repeat(1_200_000) + '\\n'); process.stdout.write('next\\n')");
    const sequencer = new RuntimeEventSequencer(7);
    const cursors: Array<{ length: number; cursor: unknown }> = [];
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const event = sequencer.event({ type: "runtime.stderr", text: `line of ${line.length}` });
        cursors.push({ length: line.length, cursor: outputCursorOf(event) });
      }
    });
    await new Promise((resolve) => child.once("close", resolve));
    const output = readFileSync(join(child.launcher.dir, LAUNCH_FILES.output));
    const frames = output.toString("utf8").split("\n").filter(Boolean);
    expect(frames.length).toBeGreaterThan(2);
    const nextFrameStart = output.lastIndexOf(Buffer.from(JSON.stringify({ stream: "stdout", text: "next\n" })));
    expect(cursors).toEqual([
      { length: 1_200_000, cursor: { offset: 0, seq: 0 } },
      { length: 4, cursor: { offset: nextFrameStart, seq: 1 } },
    ]);
  });
});

describe("the control socket", () => {
  it("carries stdin to a CLI that is a child of the shim, not of the daemon", async () => {
    const child = await launch([
      "process.stdout.write(JSON.stringify({ ppid: process.ppid }) + '\\n');",
      "process.stdin.setEncoding('utf8').on('data', (text) => {",
      "  for (const line of text.split('\\n').filter(Boolean)) process.stdout.write('echo:' + line + '\\n');",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join(""), { stdin: true });
    const result = collect(child);
    child.stdin!.write("steer one\n");
    child.stdin!.write("steer two\n");
    child.stdin!.end();
    const { stdout, close } = await result;
    const [first, ...rest] = stdout.split("\n").filter(Boolean);
    expect(JSON.parse(first!).ppid).toBe(child.launcher.pid);
    expect(child.launcher.pid).not.toBe(process.pid);
    expect(rest).toEqual(["echo:steer one", "echo:steer two"]);
    expect(close).toEqual([0, null]);
  });

  it("refuses a connection that does not know the run token", async () => {
    const child = await launch("setInterval(() => {}, 1000)");
    const result = collect(child);
    await vi.waitFor(() => expect(existsSync(child.launcher.controlPath)).toBe(true));
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(child.launcher.controlPath);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", token: "0".repeat(48) })}\n`);
        socket.write(`${JSON.stringify({ id: "1", type: "signal", signal: "SIGKILL" })}\n`);
      });
      socket.on("data", (chunk: string) => { text += chunk; });
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    expect(JSON.parse(reply.split("\n")[0]!)).toMatchObject({ type: "hello", ok: false, error: "unauthorized" });
    expect(reply.split("\n").filter(Boolean)).toHaveLength(1);
    await delay(200);
    expect(alive(child.pid!)).toBe(true);
    child.kill("SIGKILL");
    await result;
  });

  it("signals the whole process group of the CLI", async () => {
    const child = await launch([
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join(""));
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    const closed = new Promise((resolve) => child.once("close", resolve));
    await vi.waitFor(() => expect(stdout).toContain("grandchild"));
    const grandchild = JSON.parse(stdout.split("\n")[0]!).grandchild as number;
    expect(alive(grandchild)).toBe(true);
    child.kill("SIGTERM");
    await closed;
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5_000 });
  });
});

describe("the shim", () => {
  it("ends a CLI that ignores SIGTERM with SIGKILL after the grace period when the shim is terminated", async () => {
    const child = await launch(
      "process.on('SIGTERM', () => process.stdout.write('ignored SIGTERM\\n')); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      { killGraceMs: 200 },
    );
    const result = collect(child);
    await vi.waitFor(() => expect(readFileSync(join(child.launcher.dir, LAUNCH_FILES.output), "utf8")).toContain("ready"));
    process.kill(child.launcher.pid, "SIGTERM");
    const { stdout, close } = await result;
    expect(stdout).toContain("ignored SIGTERM");
    expect(close).toEqual([null, "SIGKILL"]);
  });

  // 回归：启动目录被删除以后（例如测试删掉了数据目录），没有人还能读到输出、读到退出记录，也连不上控制 socket。
  // 旧的垫片和 CLI 在这之后一直运行。现在垫片停止 CLI 并退出，CLI 忽略 SIGTERM 时，宽限期后用 SIGKILL。
  it("stops the CLI and exits when its launch directory is removed", async () => {
    const child = await launch(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      { killGraceMs: 200 },
    );
    await vi.waitFor(() => expect(readFileSync(join(child.launcher.dir, LAUNCH_FILES.output), "utf8")).toContain("ready"));
    rmSync(dirname(child.launcher.dir), { recursive: true, force: true });
    await vi.waitFor(() => {
      expect(alive(child.pid!)).toBe(false);
      expect(alive(child.launcher.pid)).toBe(false);
    }, { timeout: 5_000 });
  });

  // 启动目录被删除后退出时，垫片照样删除 removeOnExit 里的路径和 /tmp 下的控制 socket 目录。
  // Claude 的 MCP 配置目录里有工具桥 token，不能留下。
  it("removes its private paths when it exits because its launch directory is gone", async () => {
    const secret = tempDir("plc-launch-test-secret-");
    dirs.push(secret);
    // 启动目录的路径太长时，控制 socket 放在 /tmp 下的私有目录里（unix socket 的路径有长度上限）。
    const base = baseDir();
    const child = await launch("setInterval(() => {}, 1000)", { baseDir: join(base, "x".repeat(60)), removeOnExit: [secret] });
    const controlDir = dirname(child.launcher.controlPath);
    expect(controlDir.startsWith("/tmp/plc-ctl-")).toBe(true);
    rmSync(base, { recursive: true, force: true });
    await vi.waitFor(() => expect(alive(child.launcher.pid)).toBe(false), { timeout: 5_000 });
    expect(existsSync(secret)).toBe(false);
    expect(existsSync(controlDir)).toBe(false);
  });

  it("runs in its own process group, and so does the CLI", async () => {
    const child = await launch("setInterval(() => {}, 1000)");
    const result = collect(child);
    const group = (pid: number) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    expect(group(child.launcher.pid)).toBe(child.launcher.pid);
    expect(group(child.pid!)).toBe(child.pid);
    expect(group(process.pid)).not.toBe(child.pid);
    child.kill("SIGKILL");
    await result;
  });
});
