// 工单 #113：机器很忙时，plc 的 MCP 服务器没在 Claude Code 的启动时限内握手。旧代码第一次就判 tool_channel_unavailable、
// 打开 Claude Code 故障、挂起派发；探针又只跑 --version 和 auth status，故障被关掉、下一个执行又超时，一天反复 10 次。
// 决策边界在 runItem：adapter 报「启动超时」时，同一个 Run 里重新拉起一次 CLI，只重试一次。
// 重试也失败才按原来的逻辑开故障。不是超时的工具通道失败（配置坏了）不重试。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { createItem, getRun, openDb, openRuntimeIncidents, type Db } from "@pi-lead-child/store";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-tool-channel-retry-");
  db = openDb(join(dir, "plc.db"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 每次 start 回放下一份录制。录制里的失败按真实 adapter 的分类函数补上类型（ReplayRuntime）。
class ScriptedClaude implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities = new ClaudeRuntime().capabilities;
  readonly requests: RuntimeStartRequest[] = [];

  constructor(private readonly recordings: RecordedEvent[][]) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events }).start(request);
  }
}

// 文本和 claude.ts 在 init 事件里认出启动超时时写的一样。
const TIMED_OUT: RecordedEvent[] = [
  { type: "run.started", runtime: "claude", model: null },
  { type: "session.updated", externalSessionId: "timed-out-session" },
  {
    type: "run.failed", exitCode: null, errorCode: "claude_tool_channel_timeout",
    error: "MCP 服务器 plc 的状态是 failed，plc 工具通道没有就绪：启动超时（从拉起 CLI 到初始化用了 95 秒，MCP_TIMEOUT 是 90 秒）",
  },
];
const CONFIG_BROKEN: RecordedEvent[] = [
  { type: "run.started", runtime: "claude", model: null },
  {
    type: "run.failed", exitCode: null, errorCode: "claude_tool_channel_unavailable",
    error: "MCP 服务器 plc 的配置无效，plc 工具通道没有就绪",
  },
];
const ANSWERED: RecordedEvent[] = [
  { type: "run.started", runtime: "claude", model: null },
  { type: "session.updated", externalSessionId: "answered-session" },
  { type: "message.completed", messageId: "m1", role: "assistant", text: "done" },
  { type: "run.completed", exitCode: 0 },
];

function opts(runtime: AgentRuntime, seen: RuntimeEvent[]) {
  return {
    dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions"),
    prompt: "做这张工单", purpose: "conversation" as const, role: "executor" as const,
    runtime, runtimeId: runtime.id, lingerMs: 0,
    onEvent: (event: RuntimeEvent) => { seen.push(event); },
  };
}

const ticket = () => createItem(db, { title: "ticket 113", brief: "b", createdBy: "user", workdir: join(dir, "work") });
const decisions = (runId: number) => (db.prepare(
  `SELECT payload FROM activities WHERE run_id=? AND kind='decision'
     AND json_extract(payload, '$.decision')='tool_channel_start_retried'`,
).all(runId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));
const storedEvents = (runId: number) => db.prepare(
  "SELECT seq, event_type, payload FROM runtime_events WHERE run_id=? ORDER BY seq",
).all(runId) as Array<{ seq: number; event_type: string; payload: string }>;

describe("a plc tool channel that times out at start", () => {
  it("restarts the CLI once in the same run, and the run goes on without an incident", async () => {
    const itemId = ticket();
    const runtime = new ScriptedClaude([TIMED_OUT, ANSWERED]);
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, opts(runtime, seen));

    // 同一个 Run 里拉起两次，用的是同一个请求。
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]!.runId).toBe(runId);
    expect(runtime.requests[1]!.prompt).toBe(runtime.requests[0]!.prompt);
    expect(getRun(db, runId)).toMatchObject({ state: "finished", failure_code: null, external_session_id: "answered-session" });
    // 第一次超时不是崩溃：没有失败事件，没有故障。
    expect(seen.filter((event) => event.type === "run.failed")).toEqual([]);
    expect(openRuntimeIncidents(db)).toEqual([]);

    // 这个 Run 的事件里能看出：超时后重试了一次。seq 连续，只有一个终止事件。
    const events = storedEvents(runId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    const notices = events.filter((event) => event.event_type === "runtime.stderr");
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0]!.payload).text).toMatch(/plc 工具通道启动超时.*重试一次/);
    expect(events.filter((event) => event.event_type === "run.failed")).toEqual([]);
    expect(events.filter((event) => event.event_type === "run.completed")).toHaveLength(1);
    expect(decisions(runId)).toEqual([
      expect.objectContaining({ runtime: "claude", errorCode: "claude_tool_channel_timeout" }),
    ]);
  });

  it("opens the incident when the retry times out too, and retries only once", async () => {
    const itemId = ticket();
    const runtime = new ScriptedClaude([TIMED_OUT, TIMED_OUT, ANSWERED]);
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, opts(runtime, seen));

    expect(runtime.requests).toHaveLength(2);
    expect(getRun(db, runId)).toMatchObject({ state: "failed", failure_code: "tool_channel_unavailable" });
    expect(seen.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(openRuntimeIncidents(db)).toEqual([expect.objectContaining({ runtime: "claude" })]);
    expect(decisions(runId)).toHaveLength(1);
    expect(storedEvents(runId).filter((event) => event.event_type === "runtime.stderr")).toHaveLength(1);
  });

  it("does not retry a tool channel failure that is not a timeout", async () => {
    const itemId = ticket();
    const runtime = new ScriptedClaude([CONFIG_BROKEN, ANSWERED]);
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, opts(runtime, seen));

    expect(runtime.requests).toHaveLength(1);
    expect(getRun(db, runId)).toMatchObject({ state: "failed", failure_code: "tool_channel_unavailable" });
    expect(openRuntimeIncidents(db)).toEqual([expect.objectContaining({ runtime: "claude" })]);
    expect(decisions(runId)).toEqual([]);
    expect(storedEvents(runId).filter((event) => event.event_type === "runtime.stderr")).toEqual([]);
  });
});
