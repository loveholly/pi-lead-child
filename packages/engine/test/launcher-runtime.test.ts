// 工单 14 的 Seam 2：adapter 经启动垫片启动 CLI。用 fake CLI 断言 adapter 的外部行为。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runItem } from "../src/children/manager.js";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { readExitRecord, type LauncherIdentity } from "@pi-lead-child/runtime";
import { PiRuntime } from "@pi-lead-child/runtime";
import type { RuntimeEvent, RuntimeHandle } from "@pi-lead-child/runtime";
import { openDb } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_PI = resolve("packages/runtime/testing/fake-pi.ts");
const dirs: string[] = [];
const handles: RuntimeHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plc-launch-runtime-"));
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
  for (const handle of handles.splice(0)) {
    if (handle.pid) {
      try { process.kill(-handle.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    const shim = handle.process?.launcher?.pid;
    if (shim) {
      try { process.kill(shim, "SIGKILL"); } catch { /* 已经退出 */ }
      await vi.waitFor(() => expect(alive(shim)).toBe(false), { timeout: 5_000 });
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startPi(scenario: string, env: Record<string, string> = {}) {
  return new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI] }).start({
    itemId: 1, runId: 31, role: "executor", purpose: "execution", prompt: "do it",
    workdir: process.cwd(), sessionDir: join(tempDir(), "session"), launchDir: tempDir(),
    env: { FAKE_SCENARIO: scenario, ...env },
  }).then((handle) => {
    handles.push(handle);
    return handle;
  });
}

async function collect(handle: RuntimeHandle): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

describe("runItem with the launcher", () => {
  it("records the launcher identity and an output cursor at the frame of the last persisted event", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", "item-1"), prompt: "do it", lingerMs: 0,
      runtime: new CodexRuntime({
        bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
        env: { FAKE_CODEX_SCENARIO: "happy" },
      }),
    });
    const run = getRun(db, runId)!;
    expect(run.state).toBe("finished");

    const launcher = JSON.parse(run.launcher!) as LauncherIdentity;
    expect(launcher).toMatchObject({ version: 1, childPid: run.pid });
    expect(launcher.token).toMatch(/^[0-9a-f]{48}$/);
    expect(launcher.dir.startsWith(join(dir, "launches") + "/")).toBe(true);
    expect(readExitRecord(launcher.dir)).toMatchObject({ shimPid: launcher.pid, exitCode: 0, runId });

    // 游标指向产生最后一个带位置事件的那一帧（turn.completed 产生 usage.updated），
    // seq 是那一帧之前最后一个事件（message.completed）的 seq。
    const output = readFileSync(join(launcher.dir, "output.jsonl"));
    const lineStart = output.lastIndexOf(0x0a, output.indexOf(Buffer.from("turn.completed"))) + 1;
    expect(lineStart).toBeGreaterThan(0);
    const messageSeq = (db.prepare(
      "SELECT seq FROM runtime_events WHERE run_id=? AND event_type='message.completed'",
    ).get(runId) as { seq: number }).seq;
    expect(JSON.parse(run.output_cursor!)).toEqual({ offset: lineStart, seq: messageSeq });
    db.close();
  });
});

describe("pi through the launcher", () => {
  it("delivers a steer to the CLI through the control socket of the shim", async () => {
    const commands = join(tempDir(), "commands.log");
    const handle = await startPi("slow", { FAKE_PI_COMMAND_LOG: commands });
    const shim = handle.process?.launcher?.pid;
    expect(shim).toBeGreaterThan(0);
    // pi 的父进程是垫片，所以写给 pi 的 stdin 只能经过垫片。
    const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(handle.pid)], { encoding: "utf8" }).trim());
    expect(parent).toBe(shim);

    await vi.waitFor(() => expect(readFileSync(commands, "utf8")).toContain("\"prompt\""), { timeout: 10_000 });
    await handle.steer!("change direction");
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    const received = readFileSync(commands, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(received).toContainEqual({ type: "steer", message: "change direction" });
    await handle.interrupt("test complete");
  });

  it("reports the whole stderr and the real exit code when pi crashes", async () => {
    const handle = await startPi("crash_big_stderr");
    const events = await collect(handle);
    const failed = events.find((event) => event.type === "run.failed") as Extract<RuntimeEvent, { type: "run.failed" }>;
    expect(failed).toMatchObject({ errorCode: "process_exit", exitCode: 3 });
    expect(failed.error).toContain("END-OF-STDERR");
    expect(await handle.wait()).toMatchObject({ ok: false, exitCode: 3, signal: null });
  });
});
