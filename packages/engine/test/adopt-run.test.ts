// 工单 15：child manager 接管一个 Run 时的决策边界。接管从输出文件的开头重放，
// seq 不超过 event_cursor 的事件已经落库，所以跳过。例外是 daemon 在事件落库以后、处理之前崩溃：
// 这时终止事件已经落库，Run 却还是 running。接管必须补做它，否则 Run 一直停在 running。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { AsyncEventQueue, RuntimeEventSequencer } from "@pi-lead-child/runtime";
import type { AttachableLaunch } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeEventInput } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createIngestor } from "../src/pipeline/ingest.js";
import { createRuntimeEventStore } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-adopt-run-");
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 这次 Run 的 CLI 一共产生这些事件。重放时 adapter 按同样的顺序、同样的 seq 再产生一遍。
const history: RuntimeEventInput[] = [
  { type: "run.started", runtime: "codex", model: null },
  { type: "message.completed", messageId: "m1", role: "assistant", text: "done" },
  { type: "run.completed", exitCode: 0 },
];

function replay(runId: number): RuntimeEvent[] {
  const sequencer = new RuntimeEventSequencer(runId);
  return history.map((input) => sequencer.event(input));
}

// 一个只会接管的 runtime：attach 重放上面的事件。
function adoptingRuntime(runId: number): AgentRuntime {
  return {
    id: "codex",
    capabilities: {
      streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: false,
      executableReadOnlyReview: true,
    },
    start: async () => { throw new Error("adoption must not start a new CLI"); },
    attach: async () => {
      const queue = new AsyncEventQueue<RuntimeEvent>();
      for (const event of replay(runId)) queue.push(event);
      queue.end();
      return {
        pid: null, events: queue, interrupt: async () => {},
        wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
      };
    },
  };
}

// 接管只读身份里的工具桥。这里没有工具桥，进程已经退出。
const exitedLaunch = (): AttachableLaunch => ({
  state: "exited",
  identity: { version: 1, pid: 1, childPid: 2, token: "t".repeat(48), dir, controlPath: join(dir, "ctl.sock") },
  record: {
    version: 1, runId: null, shimPid: 1, childPid: 2, exitCode: 0, signal: null, spawnError: null, outputBytes: 0,
    endedAt: new Date().toISOString(),
  },
}) as AttachableLaunch;

describe("adopting a run", () => {
  it("completes a run whose terminal event was stored but not handled before the daemon died", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    // 旧 daemon 落库了全部三个事件，在处理终止事件之前崩溃。
    const store = createRuntimeEventStore(db, { dataDir: dir });
    for (const event of replay(runId)) store.persist(event);
    expect(getRun(db, runId)).toMatchObject({ state: "running", event_cursor: "3" });

    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", "1"), prompt: "",
      runId, runtime: adoptingRuntime(runId), adopt: { launch: exitedLaunch() }, lingerMs: 0,
    });
    expect(getRun(db, runId)).toMatchObject({ state: "finished", exit_code: 0 });
    // 已经落库的事件不重复。
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=?").get(runId)).toEqual({ n: 3 });
    // 接管不是一次新的尝试：没有新的 attempt_start，结束时记一条 attempt_end。
    expect(db.prepare("SELECT kind, COUNT(*) AS n FROM activities WHERE run_id=? AND kind LIKE 'attempt_%' GROUP BY kind")
      .all(runId)).toEqual([{ kind: "attempt_end", n: 1 }]);
  });

  // 跳过已经处理的事件时，内核在这些事件里积累的状态也要重建：累计用量和 LLM error 结局。
  // 否则接管后的累计用量会被再算一遍，LLM error 结局会被当成交接失败。
  it("rebuilds what the run had accumulated before the daemon died", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const sequencer = new RuntimeEventSequencer(runId);
    const events = ([
      { type: "run.started", runtime: "codex", model: null },
      { type: "usage.updated", mode: "cumulative", inputTokens: 60, outputTokens: 40, totalTokens: 100, costUsd: null },
      { type: "message.completed", messageId: "m1", role: "assistant", text: "provider failed", stopReason: "error" },
      { type: "usage.updated", mode: "cumulative", inputTokens: 90, outputTokens: 60, totalTokens: 150, costUsd: null },
      { type: "run.completed", exitCode: 0 },
    ] as RuntimeEventInput[]).map((input) => sequencer.event(input));
    // 旧 daemon 处理了前三个事件。
    const store = createRuntimeEventStore(db, { dataDir: dir });
    const ingestor = createIngestor(db, { itemId, runId });
    for (const event of events.slice(0, 3)) {
      store.persist(event);
      ingestor.onEvent(event);
    }
    expect(getItem(db, itemId)).toMatchObject({ stage: "active", total_tokens: 100 });
    const blockersBefore = db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId);

    const runtime = adoptingRuntime(runId);
    runtime.attach = async () => {
      const queue = new AsyncEventQueue<RuntimeEvent>();
      for (const event of events) queue.push(event);
      queue.end();
      return {
        pid: null, events: queue, interrupt: async () => {},
        wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
      };
    };
    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", "1"), prompt: "",
      runId, runtime, adopt: { launch: exitedLaunch() }, lingerMs: 0,
    });
    expect(getRun(db, runId)).toMatchObject({ state: "finished" });
    // 累计用量只多算了接管以后的 50。LLM error 结局让工单进 blocked，不再另升「交接失败」。
    expect(getItem(db, itemId)).toMatchObject({ stage: "blocked", total_tokens: 150 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual(blockersBefore);
  });

  // 工单 #66：resume 的会话不存在时，Run 在同一个 Run 里开了第二个进程（manager.ts 的 startFreshSession）。
  // 第二个进程的 adapter 从 1 编号，内核把它接在第一个进程的事件后面，并把这个偏移记在垫片身份里。
  // daemon 重启后接管第二个进程时，重放的事件要加上同一个偏移：不然它们和第一个进程的事件撞 seq，
  // 被 INSERT OR IGNORE 丢掉，终止事件就不在事件日志里。
  it("replays the second process of a run after the events of its first process", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex", purpose: "conversation" });
    updateRun(db, runId, { state: "running", externalSessionId: "fresh-thread" });
    const first = new RuntimeEventSequencer(runId);
    const firstEvents = ([
      { type: "run.started", runtime: "codex", model: null },
      { type: "session.updated", externalSessionId: "expired-thread" },
      { type: "runtime.stderr", text: "no rollout found for thread id expired-thread\n" },
    ] as RuntimeEventInput[]).map((input) => first.event(input));
    const secondInputs: RuntimeEventInput[] = [
      { type: "run.started", runtime: "codex", model: null },
      { type: "session.updated", externalSessionId: "fresh-thread" },
      { type: "message.completed", messageId: "m1", role: "assistant", text: "answer" },
      { type: "run.completed", exitCode: 0 },
    ];
    const second = () => {
      const sequencer = new RuntimeEventSequencer(runId);
      return secondInputs.map((input) => sequencer.event(input));
    };
    // 旧 daemon 落库了第一个进程的事件，和第二个进程的前三个事件（加上偏移 3），然后崩溃。
    const store = createRuntimeEventStore(db, { dataDir: dir });
    for (const event of firstEvents) store.persist(event);
    for (const event of second().slice(0, 3)) store.persist({ ...event, seq: event.seq + 3 });
    expect(getRun(db, runId)).toMatchObject({ event_cursor: "6" });

    const runtime = adoptingRuntime(runId);
    runtime.attach = async () => {
      const queue = new AsyncEventQueue<RuntimeEvent>();
      for (const event of second()) queue.push(event);
      queue.end();
      return {
        pid: null, events: queue, interrupt: async () => {},
        wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
      };
    };
    const launch = exitedLaunch();
    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", "1"), prompt: "",
      runId, runtime, purpose: "conversation", lingerMs: 0,
      adopt: { launch: { ...launch, identity: { ...launch.identity, seqBase: 3 } } as AttachableLaunch },
    });

    expect(getRun(db, runId)).toMatchObject({ state: "finished", external_session_id: "fresh-thread" });
    expect(db.prepare("SELECT seq, event_type FROM runtime_events WHERE run_id=? ORDER BY seq").all(runId)).toEqual([
      { seq: 1, event_type: "run.started" },
      { seq: 2, event_type: "session.updated" },
      { seq: 3, event_type: "runtime.stderr" },
      { seq: 4, event_type: "run.started" },
      { seq: 5, event_type: "session.updated" },
      { seq: 6, event_type: "message.completed" },
      { seq: 7, event_type: "run.completed" },
    ]);
  });

  it("does not handle the events of an adopted run a second time", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "finished", exitCode: 0 });
    const store = createRuntimeEventStore(db, { dataDir: dir });
    for (const event of replay(runId)) store.persist(event);
    const before = db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=?").get(runId);

    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", "1"), prompt: "",
      runId, runtime: adoptingRuntime(runId), adopt: { launch: exitedLaunch() }, lingerMs: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=?").get(runId)).toEqual(before);
  });
});
