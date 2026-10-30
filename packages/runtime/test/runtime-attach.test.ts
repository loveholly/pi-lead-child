// 工单 15：adapter 接管 daemon 重启前启动的 CLI（Seam 2，真实的垫片和 fake CLI）。
// 接管从输出文件的开头重放。内核靠 seq 去重，所以重放产生的事件必须和原来的事件一模一样：
// 同样的类型、同样的 seq、同样的内容。只有 occurredAt 可以不同。
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuntime } from "../src/claude.js";
import { CodexRuntime } from "../src/codex.js";
import { launcherWithin, launchProcess, reattachLauncher, type LauncherIdentity } from "../src/launcher.js";
import { PiRuntime } from "../src/pi.js";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle } from "../src/types.js";

const TSX = resolve("node_modules/.bin/tsx");
const dirs: string[] = [];
const identities: LauncherIdentity[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plc-runtime-attach-"));
  dirs.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  const pids: number[] = [];
  for (const identity of identities.splice(0)) {
    for (const target of [identity.childPid ? -identity.childPid : 0, identity.pid]) {
      if (!target) continue;
      try { process.kill(target, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    pids.push(identity.pid);
  }
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5_000 });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 事件的内容，去掉时间。
function content(events: RuntimeEvent[]): Array<Omit<RuntimeEvent, "occurredAt">> {
  return events.map(({ occurredAt: _occurredAt, ...rest }) => rest);
}

async function collect(handle: RuntimeHandle, until?: (event: RuntimeEvent) => boolean): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (until?.(event)) break;
  }
  return events;
}

const runId = 41;
const startRequest = (launchDir: string, env: Record<string, string> = {}) => ({
  itemId: 1, runId, role: "executor" as const, purpose: "execution" as const, prompt: "do it",
  workdir: process.cwd(), sessionDir: join(tempDir(), "session"), launchDir, env, model: "fake-model",
});

async function attach(runtime: AgentRuntime, identity: LauncherIdentity, expected: "alive" | "exited"): Promise<RuntimeHandle> {
  const launch = await reattachLauncher(identity, runId);
  expect(launch.state).toBe(expected);
  if (launch.state === "gone") throw new Error(launch.reason);
  return runtime.attach!({
    itemId: 1, runId, role: "executor", purpose: "execution", workdir: process.cwd(), model: "fake-model",
    toolChannel: false, launch,
  });
}

const runtimes: Array<{ name: string; runtime: () => AgentRuntime; finish?: (handle: RuntimeHandle) => Promise<void> }> = [
  {
    name: "Codex",
    runtime: () => new CodexRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
      env: { FAKE_CODEX_SCENARIO: "tools" },
    }),
  },
  {
    name: "Claude",
    runtime: () => new ClaudeRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-claude.ts")],
      env: { FAKE_CLAUDE_SCENARIO: "happy" },
    }),
  },
  {
    // pi 在 agent_end 之后还活着，等下一条 prompt。中断它，垫片才写下退出记录。
    name: "pi",
    runtime: () => new PiRuntime({ bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_SCENARIO: "tool" } }),
    finish: (handle) => handle.interrupt("test done"),
  },
];

describe.each(runtimes)("the $name adapter, attaching to a CLI that exited while the daemon was down", ({ runtime, finish }) => {
  it("replays exactly the events of the original run", async () => {
    const launchDir = tempDir();
    const adapter = runtime();
    const original = await adapter.start(startRequest(launchDir));
    identities.push(original.process!.launcher!);
    const events = await collect(original);
    await finish?.(original);
    await original.wait();
    expect(events.at(-1)?.type).toMatch(/^run\.(completed|failed)$/);
    // 外部 session 在输出的前面，重放必须重建它。
    expect(events.some((event) => event.type === "session.updated")).toBe(true);
    await vi.waitFor(() => expect(existsSync(join(original.process!.launcher!.dir, "exit.json"))).toBe(true));
    await vi.waitFor(() => expect(alive(original.process!.launcher!.pid)).toBe(false));

    const adopted = await attach(runtime(), original.process!.launcher!, "exited");
    const replayed = await collect(adopted);
    expect(content(replayed)).toEqual(content(events));
    expect((await adopted.wait()).exitCode).toBe((await original.wait()).exitCode);
  }, 30_000);
});

// pi 的 resume 找不到 session 文件时，adapter 自己发一条诊断（工单 13）。它不在输出文件里。
// 接管时必须在同一位置重放它，否则后面每个事件的编号都少一，daemon 会按编号跳过一个真实的事件（工单 15）。
describe("the pi adapter, attaching after a resume that fell back to a new session", () => {
  it("replays its own notice at the same position", async () => {
    const launchDir = tempDir();
    const runtime = () => new PiRuntime({ bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_SCENARIO: "tool" } });
    const original = await runtime().start({ ...startRequest(launchDir), resumeSessionId: "session-missing" });
    identities.push(original.process!.launcher!);
    const events = await collect(original);
    await original.interrupt("test done");
    await original.wait();
    expect(events[0]).toMatchObject({ type: "runtime.stderr", seq: 1, text: expect.stringContaining("no usable session file") });
    await vi.waitFor(() => expect(alive(original.process!.launcher!.pid)).toBe(false));

    const adopted = await attach(runtime(), original.process!.launcher!, "exited");
    expect(content(await collect(adopted))).toEqual(content(events));
  }, 30_000);
});

describe("the identity check before attaching", () => {
  // 库里的身份只在指向数据目录的启动目录时才用：daemon 不去连别处的 socket，也不读别处的文件。
  it("trusts only identities inside the launch directory of the data directory", () => {
    const root = "/data/launches";
    const identity: LauncherIdentity = {
      version: 1, pid: 10, childPid: 11, token: "t".repeat(48), dir: `${root}/r7-abc123`, controlPath: `${root}/r7-abc123/ctl.sock`,
    };
    expect(launcherWithin(identity, root)).toBe(true);
    expect(launcherWithin({ ...identity, controlPath: "/tmp/plc-ctl-xyz/ctl.sock" }, root)).toBe(true);
    expect(launcherWithin({ ...identity, dir: "/elsewhere/r7-abc123", controlPath: "/elsewhere/r7-abc123/ctl.sock" }, root)).toBe(false);
    expect(launcherWithin({ ...identity, dir: `${root}/../r7-abc123` }, root)).toBe(false);
    expect(launcherWithin({ ...identity, dir: `${root}/plc-launch-abc` }, root)).toBe(false);
    expect(launcherWithin({ ...identity, controlPath: "/var/run/other.sock" }, root)).toBe(false);
    expect(launcherWithin({ ...identity, controlPath: "/tmp/other/ctl.sock" }, root)).toBe(false);
  });

  // 控制 socket 的 hello 回复必须报告记下的垫片 pid 和这个 Run 的 id。token 对、Run 不对，也不接管。
  it("finds a live shim only with the run's own token and run id", async () => {
    const child = await launchProcess({
      runId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" }, baseDir: tempDir(),
    });
    identities.push(child.launcher);
    child.detach();

    const found = await reattachLauncher(child.launcher, runId);
    expect(found).toMatchObject({ state: "alive", hello: { shimPid: child.launcher.pid, runId, childPid: child.pid } });
    if (found.state === "alive") found.control.close();
    expect(await reattachLauncher(child.launcher, runId + 1)).toMatchObject({ state: "gone" });
    expect(await reattachLauncher({ ...child.launcher, token: "c".repeat(48) }, runId)).toMatchObject({ state: "gone" });
    expect(await reattachLauncher({ ...child.launcher, pid: child.launcher.pid + 1 }, runId)).toMatchObject({ state: "gone" });
    const missing = join(tempDir(), "ctl.sock");
    expect(await reattachLauncher({ ...child.launcher, controlPath: missing, dir: tempDir() }, runId))
      .toMatchObject({ state: "gone" });
    expect(alive(child.pid!)).toBe(true);
  }, 30_000);
});

describe("an adapter attaching to a CLI that is still running", () => {
  // daemon 正常停机时分离进程（detach），CLI 继续运行。新的 handle 重放已有的输出，再接着读新的输出。
  it("replays what the CLI wrote, then follows it to the end (Codex)", async () => {
    const gate = join(tempDir(), "gate.txt");
    writeFileSync(gate, "step one\n");
    const runtime = () => new CodexRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
      env: { FAKE_CODEX_SCENARIO: "gated", FAKE_CODEX_GATE_FILE: gate },
    });
    const original = await runtime().start(startRequest(tempDir()));
    const identity = original.process!.launcher!;
    identities.push(identity);
    const before = await collect(original, (event) => event.type === "message.completed");
    original.process!.detach!();
    appendFileSync(gate, "step two\n");
    await vi.waitFor(() => expect(readFileSync(join(identity.dir, "output.jsonl"), "utf8")).toContain("two"));
    expect(alive(identity.childPid!)).toBe(true);

    const adopted = await attach(runtime(), identity, "alive");
    const replayed = collect(adopted);
    appendFileSync(gate, "finish\n");
    const events = await replayed;
    expect(content(events.slice(0, before.length))).toEqual(content(before));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.type === "message.completed").map((event) => event.type === "message.completed" && event.text))
      .toEqual(["one", "two"]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", exitCode: 0 });
  }, 30_000);

  // pi 的 steer 走 stdin。接管以后，stdin 仍经控制 socket 送达 pi。
  it("steers an adopted pi through the control socket", async () => {
    const commands = join(tempDir(), "commands.log");
    const runtime = () => new PiRuntime({
      bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_SCENARIO: "slow", FAKE_PI_COMMAND_LOG: commands },
    });
    const original = await runtime().start(startRequest(tempDir()));
    const identity = original.process!.launcher!;
    identities.push(identity);
    const before = await collect(original, (event) => event.type === "run.started");
    original.process!.detach!();

    const adopted = await attach(runtime(), identity, "alive");
    await adopted.steer!("keep going");
    const events = await collect(adopted, (event) => event.type === "run.completed");
    expect(content(events.slice(0, before.length))).toEqual(content(before));
    expect(events.at(-1)?.type).toBe("run.completed");
    const sent = readFileSync(commands, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    // 接管以后不再发启动时的 get_state 和 prompt。
    expect(sent.map((command) => command.type)).toEqual(["get_state", "prompt", "steer"]);
    await adopted.interrupt("test done");
  }, 30_000);
});
