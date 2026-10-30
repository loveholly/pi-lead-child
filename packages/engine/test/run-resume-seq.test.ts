// 恢复一个暂停的 Run：同一个 Run，新进程。adapter 每次启动都从 seq 1 编号。
// 决策边界在 runItem：新进程的事件接在这个 Run 已经落库的事件后面，偏移记进垫片身份，接管时按它重放。
// 内核自己产生的失败事件也接在后面。以前它们撞上已经落库的 seq，被 INSERT OR IGNORE 丢掉。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { ClaudeRuntime, parseLauncherIdentity, RuntimeEventSequencer } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEventInput } from "@pi-lead-child/runtime";
import { createRuntimeEventStore, openDb, type Db } from "@pi-lead-child/store";
import { createItem, createRun, getRun, transition, updateRun } from "@pi-lead-child/store";

const TSX = resolve("node_modules/.bin/tsx");
const SESSION = "claude-session-paused";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-resume-seq-");
  db = openDb(join(dir, "plc.db"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 一个暂停过的执行 Run：暂停前落库了 4 个事件，现在要恢复（UserActionService 已经把它翻回 running）。
function pausedRun(): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user", workdir: join(dir, "work") });
  transition(db, { itemId, to: "active", actor: "system", reason: "test" });
  const runId = createRun(db, { itemId, runtime: "claude" });
  const sequencer = new RuntimeEventSequencer(runId);
  const store = createRuntimeEventStore(db, { dataDir: dir });
  for (const input of [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION },
    { type: "message.completed", messageId: "m-before", role: "assistant", text: "half done" },
    { type: "usage.updated", mode: "cumulative", inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
  ] as RuntimeEventInput[]) store.persist(sequencer.event(input));
  updateRun(db, runId, { state: "running", sessionId: SESSION, externalSessionId: SESSION });
  return { itemId, runId };
}

const resumeOpts = (runId: number, runtime: AgentRuntime) => ({
  dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "pi-sessions"), prompt: "continue",
  runId, runtime, runtimeId: runtime.id, lingerMs: 0, resumeSessionId: SESSION,
});

const storedEvents = (runId: number) => db.prepare(
  "SELECT seq, event_type FROM runtime_events WHERE run_id=? ORDER BY seq",
).all(runId) as Array<{ seq: number; event_type: string }>;

describe("resuming a paused run in a new process", () => {
  it("numbers the new process's events after the run's stored events and records the offset", async () => {
    const { itemId, runId } = pausedRun();
    // fake Claude 的会话存档里有这个会话，resume 成功。
    const sessions = mkdtempSync(join(dir, "sessions-"));
    writeFileSync(join(sessions, SESSION), "");
    const claude = new ClaudeRuntime({
      bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-claude.ts")],
      env: { FAKE_CLAUDE_SCENARIO: "sessions", FAKE_CLAUDE_SESSION_DIR: sessions },
    });

    await runItem(db, itemId, resumeOpts(runId, claude));

    const events = storedEvents(runId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.slice(0, 5).map((event) => event.event_type)).toEqual([
      "run.started", "session.updated", "message.completed", "usage.updated", "run.started",
    ]);
    expect(events.at(-1)?.event_type).toBe("run.completed");
    const run = getRun(db, runId)!;
    expect(run.state).toBe("finished");
    // daemon 重启后接管这个进程时，重放的事件同样接在第 4 个后面。
    expect(parseLauncherIdentity(run.launcher)?.seqBase).toBe(4);
  }, 30_000);

  it("stores the kernel's own failure of a resumed run after the run's stored events", async () => {
    const { itemId, runId } = pausedRun();
    const broken: AgentRuntime = {
      id: "claude",
      capabilities: new ClaudeRuntime().capabilities,
      start: async () => { throw new Error("spawn claude ENOENT"); },
    };

    await runItem(db, itemId, resumeOpts(runId, broken));

    expect(storedEvents(runId).at(-1)).toEqual({ seq: 5, event_type: "run.failed" });
    expect(getRun(db, runId)).toMatchObject({ state: "failed", event_cursor: "5" });
  });
});
