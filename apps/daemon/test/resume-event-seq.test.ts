// 恢复一个暂停的 Run 时，新进程的 adapter 从 seq 1 编号。旧代码从 event_cursor（暂停前最后落库的 seq，K）
// 开始处理：新进程的前 K 个事件撞上 runtime_events 的 (run_id, seq)，INSERT OR IGNORE 把它们丢掉，
// manager 也当成已经处理过的事件跳过。暂停前事件够多时，恢复这一段的消息、工具调用、甚至 run.completed
// 都没有落库、没有发给 companion，Run 一直停在 running。
// 这里走真实的 daemon：派发、网关的暂停和恢复、事件落库和网关事件，都是生产代码。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createDispatcher } from "@pi-lead-child/engine";
import {
  AsyncEventQueue, classifyFailure, CodexRuntime, RuntimeEventSequencer, RuntimeRegistry,
} from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeEvent, RuntimeEventInput, RuntimeExit, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { plcClient } from "./plc-client.js";

const THREAD = "codex-thread-paused";

// 第一次启动：做了一段工作（5 个事件），然后一直运行，直到被暂停。暂停时和真实的 Codex 一样以 interrupted 失败。
// 第二次启动（恢复，resume 同一个 thread）：接着做完，有一个工具调用、一条回答和 run.completed。
class PausableCodex implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities: RuntimeCapabilities = { ...new CodexRuntime().capabilities };
  readonly requests: RuntimeStartRequest[] = [];

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const sequencer = new RuntimeEventSequencer(request.runId);
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const emit = (input: RuntimeEventInput) => queue.push(sequencer.event(input));
    let resolveExit!: (exit: RuntimeExit) => void;
    const exited = new Promise<RuntimeExit>((resolve) => { resolveExit = resolve; });
    const finish = (exit: Omit<RuntimeExit, "signal" | "externalSessionId">) => {
      queue.end();
      resolveExit({ ...exit, signal: null, externalSessionId: THREAD });
    };
    emit({ type: "run.started", runtime: "codex", model: "gpt-5.5" });
    emit({ type: "session.updated", externalSessionId: THREAD });
    if (this.requests.length === 1) {
      emit({ type: "tool.started", callId: "before-pause", name: "shell", args: { command: "npm test" } });
      emit({ type: "tool.completed", callId: "before-pause", name: "shell", result: "1 failing" });
      emit({ type: "message.completed", messageId: "m-before", role: "assistant", text: "Found the failing test." });
      return {
        pid: null,
        events: queue,
        interrupt: async (reason) => {
          emit({
            type: "run.failed", exitCode: null, errorCode: "interrupted", error: reason,
            failure: classifyFailure("codex", { errorCode: "interrupted", message: reason }),
          });
          finish({ ok: false, exitCode: null, errorCode: "interrupted", errorMessage: reason });
        },
        wait: () => exited,
      };
    }
    emit({ type: "tool.started", callId: "after-resume", name: "shell", args: { command: "npm test" } });
    emit({ type: "tool.completed", callId: "after-resume", name: "shell", result: "all passing" });
    emit({ type: "message.completed", messageId: "m-after", role: "assistant", text: "Fixed it; the suite passes." });
    emit({ type: "run.completed", exitCode: 0 });
    finish({ ok: true, exitCode: 0, errorCode: null, errorMessage: null });
    return { pid: null, events: queue, interrupt: async () => {}, wait: () => exited };
  }
}

// 不调用模型的 lead session。
const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-resume-seq-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_ORCHESTRATOR_MS", "50");
  vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("resuming a paused run", () => {
  it("stores and publishes the events of the resumed process, and the run reaches its end", async () => {
    const itemId = createItem(db, { title: "fix the suite", brief: "make npm test pass", createdBy: "user" });
    createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      trigger: "test", idempotencyKey: "resume-seq",
    });
    const codex = new PausableCodex();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: sessionFactory as never,
      runtimeRegistry: new RuntimeRegistry([codex]), log: () => {}, gatewayPort: 0,
    });
    const events = (runId: number) => db.prepare(
      "SELECT seq, event_type, payload FROM runtime_events WHERE run_id=? ORDER BY seq",
    ).all(runId) as Array<{ seq: number; event_type: string; payload: string }>;
    try {
      // 第一段：5 个事件都落库以后暂停。
      await vi.waitFor(() => expect(codex.requests).toHaveLength(1), { timeout: 10_000 });
      const runId = codex.requests[0]!.runId;
      await vi.waitFor(() => expect(events(runId)).toHaveLength(5), { timeout: 10_000 });
      const plc = await plcClient(daemon);
      await plc.performAttemptAction(runId, "pause");
      await vi.waitFor(() => expect(getRun(db, runId)?.state).toBe("paused"), { timeout: 10_000 });
      const beforeResume = events(runId).length;
      const publishedBefore = (db.prepare("SELECT MAX(seq) AS seq FROM gateway_events").get() as { seq: number }).seq;

      // 恢复：同一个 Run、同一个 thread，新进程。
      await plc.performAttemptAction(runId, "resume");
      await vi.waitFor(() => expect(getRun(db, runId)?.state).toBe("finished"), { timeout: 10_000 });
      expect(codex.requests[1]).toMatchObject({ runId, resumeSessionId: THREAD });

      // 恢复这一段的 6 个事件都落库了，接在暂停前的事件后面。
      const stored = events(runId);
      expect(stored.map((event) => event.seq)).toEqual(stored.map((_, index) => index + 1));
      expect(stored.slice(beforeResume).map((event) => event.event_type)).toEqual([
        "run.started", "session.updated", "tool.started", "tool.completed", "message.completed", "run.completed",
      ]);
      expect(JSON.parse(stored.at(-2)!.payload)).toMatchObject({ text: "Fixed it; the suite passes." });
      // 也发给了 companion：恢复以后的工具调用和回答各有网关事件。
      // 只看这个 Run 的：它没有交接成果，之后内核会排一个修复回合，那是另一个 Run。
      const published = (db.prepare(
        "SELECT event_type, payload FROM gateway_events WHERE item_id=? AND seq>? ORDER BY seq",
      ).all(itemId, publishedBefore) as Array<{ event_type: string; payload: string }>)
        .map((event) => ({ type: event.event_type, payload: JSON.parse(event.payload) as Record<string, unknown> }))
        .filter((event) => event.payload.attemptId === runId);
      expect(published.filter((event) => event.type.startsWith("child.tool."))
        .map((event) => [event.type, event.payload.toolCallId])).toEqual([
        ["child.tool.started", "after-resume"],
        ["child.tool.completed", "after-resume"],
      ]);
      expect(published.some((event) => event.type === "ticket.updated")).toBe(true);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
