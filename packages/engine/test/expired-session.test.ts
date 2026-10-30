// 工单 #66 的 Run #71：用户在工单里发了一句话。内核 resume 工单 agent 原来的 Claude 会话，
// 但 Claude Code 已经按保留期删了这个会话的记录，CLI 立即失败（"No conversation found with session ID"）。
// 旧代码把它归为 unknown，给 lead 发「Run crashed」，用户只看到一条红色错误。
// 决策边界在 runItem：resume 的会话不存在时，同一个 Run 里开一个新会话，提示由调用方给出；只重开一次。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren, runItem } from "../src/children/manager.js";
import { expiredSessionContext } from "../src/pipeline/expired-session.js";
import { ClaudeRuntime, parseLauncherIdentity } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, createRun, getRun, pauseRun, transition, updateRun } from "@pi-lead-child/store";
import { appendAssistantDelta, completeTurn, createTurn } from "@pi-lead-child/store";
import { insertOutcomeSnapshot, normalizeOutcomePayload } from "@pi-lead-child/store";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_CLAUDE = [resolve("packages/runtime/testing/fake-claude.ts")];
const EXPIRED = "20fd5938-01a7-42ce-b4b4-bb1a98831c80";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-expired-session-");
  db = openDb(join(dir, "plc.db"));
  // child 继承测试进程的环境。fake Claude 不读开发者真实的配置。
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// fake Claude 的会话存档在 dir/sessions 下。存档是空的：要 resume 的会话已经被清理。
function claude(): { runtime: ClaudeRuntime; starts: () => Array<{ resume: string | null; session: string | null; prompt: string }> } {
  const store = mkdtempSync(join(dir, "sessions-"));
  const log = join(dir, "claude-starts.jsonl");
  const runtime = new ClaudeRuntime({
    bin: TSX, prefixArgs: FAKE_CLAUDE,
    env: { FAKE_CLAUDE_SCENARIO: "sessions", FAKE_CLAUDE_SESSION_DIR: store, FAKE_CLAUDE_LOG: log },
  });
  const starts = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { runtime, starts };
}

function conversationOpts(runtime: AgentRuntime, overrides: Record<string, unknown> = {}) {
  return {
    dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "pi-sessions"),
    prompt: "RESUME: 现在还需要我做什么", purpose: "conversation" as const, role: "executor" as const,
    runtime, runtimeId: runtime.id, lingerMs: 0, resumeSessionId: EXPIRED,
    ...overrides,
  };
}

const decisions = (runId: number, decision: string) => (db.prepare(
  `SELECT payload FROM activities WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?`,
).all(runId, decision) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));

describe("resuming a runtime session that no longer exists", () => {
  it("answers in a fresh session of the same run, records why, and keeps the new session", async () => {
    const itemId = createItem(db, { title: "ticket 66", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const { runtime, starts } = claude();
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, conversationOpts(runtime, {
      freshSessionPrompt: () => "FRESH: 工单上下文 + 现在还需要我做什么",
      onEvent: (event: RuntimeEvent) => { seen.push(event); },
    }));

    // 第一次 resume 原来的会话，失败。第二次不带 --resume，用调用方给的提示开新会话。只有这两次。
    const [resumed, fresh] = starts();
    expect(starts()).toHaveLength(2);
    expect(resumed).toMatchObject({ resume: EXPIRED, session: null, prompt: "RESUME: 现在还需要我做什么" });
    expect(fresh).toMatchObject({ resume: null, session: expect.stringMatching(/^claude-session-/) });
    expect(fresh!.prompt).toContain("FRESH: 工单上下文 + 现在还需要我做什么");

    // 用户看到的是一次正常的回答：Run 正常结束，失败没有传给调用方。
    const run = getRun(db, runId)!;
    expect(run).toMatchObject({ state: "finished", error_code: null, failure_code: null });
    expect(seen.filter((event) => event.type === "run.failed")).toEqual([]);
    expect(seen.filter((event) => event.type === "message.completed")).toEqual([
      expect.objectContaining({ text: `answer in ${fresh!.session}` }),
    ]);
    // 下一条消息 resume 新会话。
    expect(run.external_session_id).toBe(fresh!.session);

    // 记下发生了什么：原来的会话不存在，开了新会话。
    expect(decisions(runId, "runtime_session_expired")).toEqual([
      expect.objectContaining({ expiredSessionId: EXPIRED, runtime: "claude", reason: expect.stringContaining(EXPIRED) }),
    ]);
    // 能自己恢复的失败不是崩溃：没有分类为失败，没有 blocked 检查点，也没有 blocker。
    expect(decisions(runId, "runtime_failure_classified")).toEqual([]);
    expect(db.prepare("SELECT title FROM checkpoints WHERE run_id=? AND kind='blocked'").all(runId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId)).toEqual({ n: 0 });

    // 两个进程的事件都落在这个 Run 的事件日志里，seq 连续，不互相覆盖，只有一个终止事件。
    const events = db.prepare("SELECT seq, event_type FROM runtime_events WHERE run_id=? ORDER BY seq")
      .all(runId) as Array<{ seq: number; event_type: string }>;
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.event_type === "session.updated")).toHaveLength(2);
    expect(events.filter((event) => event.event_type === "run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "run.failed")).toEqual([]);
    // daemon 重启后接管新进程时，重放的 seq 要接在第一个进程的事件后面（spec D7）。
    const firstProcessEvents = events.findIndex((event, index) => index > 0 && event.event_type === "run.started");
    expect(parseLauncherIdentity(run.launcher)?.seqBase).toBe(firstProcessEvents);
  }, 30_000);

  // 过期会话的发布评审 L1：开新会话之前已经检查过一次 Run 还在跑，可新进程启动（await runtime.start）的这段时间里
  // 用户暂停了 Run。暂停中断的是已经退出的旧进程，新进程没人管：库里是 paused，进程却接着跑、接着回答。
  // 现在新进程启动以后再看一次：Run 已被暂停或停止，就马上中断新进程，按用户的动作收尾。
  it("stops the fresh session when the user pauses the run while it is starting", async () => {
    const itemId = createItem(db, { title: "ticket 66", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const { runtime, starts } = claude();
    const start = runtime.start.bind(runtime);
    let calls = 0;
    runtime.start = async (request: RuntimeStartRequest) => {
      calls += 1;
      // 第二次启动是新会话：启动途中用户按了暂停（pauseRun 先翻状态，再中断 live 表里的进程）。
      if (calls === 2) {
        pauseRun(db, request.runId);
        liveChildren().delete(itemId);
      }
      return start(request);
    };
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, conversationOpts(runtime, {
      freshSessionPrompt: () => "FRESH: 工单上下文 + 现在还需要我做什么",
      onEvent: (event: RuntimeEvent) => { seen.push(event); },
    }));

    // 新会话的进程起来了（start 调了两次），随即被中断：它可能来不及写下自己的启动记录。
    expect(calls).toBe(2);
    expect(starts().length).toBeGreaterThanOrEqual(1);
    expect(getRun(db, runId)!.state).toBe("paused");
    expect(seen.filter((event) => event.type === "message.completed")).toEqual([]);
  }, 30_000);

  // 发布评审（reliability-backlog 5756aba 第 1 处）：普通的恢复也有同样的窗口。用户恢复 Run，runtime.start 返回之前
  // 又按了暂停：这时 live 表里还没有这个 child，暂停杀不到进程。ingest 不再把暂停的 Run 改回 running 以后，
  // 库里是 paused，进程却还在跑。现在进程一挂进 live 表就再看一次状态，已暂停就中断它。
  it("stops a resumed run's process when the user pauses it before the process is registered", async () => {
    const itemId = createItem(db, { title: "ticket", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const runId = createRun(db, { itemId, purpose: "conversation" });
    updateRun(db, runId, { state: "running" });
    const { runtime } = claude();
    const start = runtime.start.bind(runtime);
    runtime.start = async (request: RuntimeStartRequest) => {
      pauseRun(db, request.runId);
      return start(request);
    };
    const seen: RuntimeEvent[] = [];
    await runItem(db, itemId, conversationOpts(runtime, {
      runId, resumeSessionId: undefined, prompt: "现在还需要我做什么",
      onEvent: (event: RuntimeEvent) => { seen.push(event); },
    }));

    expect(getRun(db, runId)!.state).toBe("paused");
    expect(seen.filter((event) => event.type === "message.completed")).toEqual([]);
  }, 30_000);

  it("fails with an error that says what happened when the fresh session fails too, and retries only once", async () => {
    const itemId = createItem(db, { title: "ticket 66", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const runtime = new ScriptedClaude([
      [
        { type: "run.started", runtime: "claude", model: null },
        {
          type: "run.failed", exitCode: 1, errorCode: "claude_error_during_execution",
          error: `No conversation found with session ID: ${EXPIRED}`,
        },
      ],
      [
        { type: "run.started", runtime: "claude", model: null },
        { type: "run.failed", exitCode: 1, errorCode: "claude_exit", error: "Claude exited with code 1" },
      ],
    ]);
    const seen: RuntimeEvent[] = [];
    const { runId } = await runItem(db, itemId, conversationOpts(runtime, {
      freshSessionPrompt: () => "FRESH",
      onEvent: (event: RuntimeEvent) => { seen.push(event); },
    }));

    expect(runtime.requests.map((request) => request.resumeSessionId ?? null)).toEqual([EXPIRED, null]);
    const failures = seen.filter((event) => event.type === "run.failed");
    expect(failures).toHaveLength(1);
    const error = (failures[0] as Extract<RuntimeEvent, { type: "run.failed" }>).error;
    // 先说原来的会话不在了、系统开了新会话，再说新会话为什么失败。
    expect(error).toContain(EXPIRED);
    expect(error).toContain("新会话");
    expect(error).toContain("Claude exited with code 1");
    expect(getRun(db, runId)).toMatchObject({ state: "failed", error_message: error });
  });

  // 调用方没有给新会话的提示（例如成果修复回合：新会话不知道原来做了什么，补交不了成果）。
  // 这时不重开，失败按会话不存在分类，不再是 unknown。
  it("classifies the failure as session_not_found when the caller gives no fresh prompt", async () => {
    const itemId = createItem(db, { title: "ticket 66", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const { runtime, starts } = claude();
    const { runId } = await runItem(db, itemId, conversationOpts(runtime));

    expect(starts()).toHaveLength(1);
    expect(getRun(db, runId)).toMatchObject({
      state: "failed", failure_code: "session_not_found", failure_scope: "attempt", failure_retry: "never",
    });
    // 工单对话失败只是这一句话没答上：不写 blocked 检查点（它会作为「需要介入」卡片出现在 Lead 会话里，
    // 和失败的回执重复，工单也没有受阻）。原因记在 Run 上（上面的 failure_code），回执里的「技术详情」给出原文。
    expect(db.prepare("SELECT title FROM checkpoints WHERE run_id=? AND kind='blocked'").all(runId)).toEqual([]);
  }, 30_000);
});

// 新会话不记得原来的对话。它的提示要带上工单到现在的事实：状态、最新一次交付的成果、核查结论、最近的对话。
describe("expiredSessionContext", () => {
  it("names the latest delivery outcome, the review verdict and the recent chat turns", () => {
    const itemId = createItem(db, { title: "ticket 66", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const delivery = createRun(db, { itemId });
    updateRun(db, delivery, { state: "finished" });
    transition(db, { itemId, to: "review", actor: "child", reason: "test", runId: delivery });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: delivery, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "a".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "Installed the three skills",
        changes: [{ kind: "file", ref: "skills/a/SKILL.md", summary: "added skill a" }],
        deliverables: [{ kind: "path", ref: "skills/a/SKILL.md", label: "skill a" }],
        validations: [{ command: "npm test", outcome: "passed", exitCode: 0, summary: "green", evidenceRef: null }],
      }, { workdir: dir }),
    });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'fail', ?)")
      .run(reviewer, itemId, "skill b is missing");
    const done = createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "装好了吗" });
    appendAssistantDelta(db, done.id, "装好了。");
    completeTurn(db, done.id);
    // 正在回答的这一轮（就是这一次的消息）不算。
    createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "现在还需要我做什么" });

    const context = expiredSessionContext(db, itemId);
    expect(context).toContain("原来的会话已经不存在");
    expect(context).toContain("### 工单状态\nreview");
    expect(context).toContain(`Run #${delivery}：Installed the three skills`);
    expect(context).toContain("skills/a/SKILL.md");
    expect(context).toContain("npm test：passed");
    expect(context).toContain(`Run #${reviewer} 的结论是 fail。证据：skill b is missing`);
    expect(context).toContain("- 消息：装好了吗\n  回答：装好了。");
    expect(context).not.toContain("现在还需要我做什么");
  });

  it("says so when there is no delivery, verdict or finished chat yet", () => {
    const itemId = createItem(db, { title: "new ticket", brief: "b", createdBy: "user" });
    const context = expiredSessionContext(db, itemId);
    expect(context).toContain("还没有交付。");
    expect(context).toContain("还没有独立核查的结论。");
    expect(context).toContain("这张工单还没有完成的对话。");
  });
});

// 每次启动按顺序回放一份录制，并记下启动请求。
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
