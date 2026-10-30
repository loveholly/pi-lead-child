// 工单 06 的 Seam 3：daemon 重启。真实的 daemon、真实的派发循环、真实 SQLite。
// 退避的"不早于"时间以绝对值存在派发请求上。daemon 重启后只等剩下的时间，不从头再等一个退避。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createDispatcher } from "@pi-lead-child/engine";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedEvent, type RecordedRun } from "@pi-lead-child/runtime/testing";

const fixture = JSON.parse(
  readFileSync(RUNTIME_FAILURES_FIXTURE, "utf8"),
) as { runs: Array<RecordedRun & { historicalRunId: number }> };
const run64 = fixture.runs.find((run) => run.historicalRunId === 64)!;
const SESSION_64 = "01a11b33-cb4e-77e3-a94e-2efdf972d1ab";

const resumedAndFinished: RecordedEvent[] = [
  { type: "run.started", runtime: "codex", model: "gpt-5.5" },
  { type: "session.updated", externalSessionId: SESSION_64 },
  { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
  { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
  {
    type: "message.completed", messageId: "m-done", role: "assistant",
    text: `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Installed the skills", changes: [], deliverables: [], validations: [] })}`,
  },
  { type: "run.completed", exitCode: 0 },
];

// 每次启动按顺序回放一份录制，并记下启动请求和启动时刻。两个 daemon 共用同一个实例。
class ScriptedCodex implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities: RuntimeCapabilities = { ...new CodexRuntime().capabilities };
  readonly starts: Array<{ at: number; request: RuntimeStartRequest }> = [];

  constructor(private readonly recordings: RecordedEvent[][]) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.starts.push({ at: Date.now(), request });
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "codex", events }).start(request);
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
  dir = tempDir("plc-transient-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_ORCHESTRATOR_MS", "50");
  vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
  vi.stubEnv("PLC_TRANSIENT_RETRY_BASE_MS", "3000");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

function start(runtime: ScriptedCodex) {
  return startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory as never,
    runtimeRegistry: new RuntimeRegistry([runtime]), log: () => {},
  });
}

describe("a transient retry across a daemon restart", () => {
  it("waits only for the remaining time of the persisted not-before deadline, then resumes the session", async () => {
    const itemId = createItem(db, { title: "historical item 77", brief: "install the skills", createdBy: "user" });
    createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      trigger: "test", idempotencyKey: "replay:64",
    });
    const codex = new ScriptedCodex([run64.events, resumedAndFinished]);
    const retryRequest = () => db.prepare(
      "SELECT id, state, not_before FROM dispatch_requests WHERE trigger='transient-retry'",
    ).get() as { id: number; state: string; not_before: string } | undefined;

    // 第一个 daemon 派出 run 64，它断网失败。内核排了一个重试，不早于失败时间加 3 秒。
    const first = await start(codex);
    try {
      await vi.waitFor(() => expect(retryRequest()).toBeDefined(), { timeout: 8_000, interval: 25 });
    } finally {
      await first.close();
    }
    const deadline = Date.parse(retryRequest()!.not_before);
    expect(codex.starts).toHaveLength(1);

    // daemon 停了一阵子。剩下的时间比一个完整的退避短。
    await delay(1_500);
    expect(Date.now()).toBeLessThan(deadline);
    const restartedAt = Date.now();
    const second = await start(codex);
    try {
      await vi.waitFor(() => expect(codex.starts).toHaveLength(2), { timeout: 10_000, interval: 25 });
      await vi.waitFor(() => expect(retryRequest()!.state).toBe("completed"), { timeout: 10_000, interval: 25 });
    } finally {
      await second.close();
    }

    // 重试在不早于时间之后才开始，但远早于"从重启时刻再等一个完整退避"。
    const retriedAt = codex.starts[1]!.at;
    expect(retriedAt).toBeGreaterThanOrEqual(deadline);
    expect(retriedAt).toBeLessThan(restartedAt + 3_000);
    // 它 resume 的是 run 64 原来的外部 session，工单不扣额度，成果交接后进入 review。
    expect(codex.starts[1]!.request.resumeSessionId).toBe(SESSION_64);
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(getItem(db, itemId)!.stage).toBe("review");
  }, 30_000);
});
