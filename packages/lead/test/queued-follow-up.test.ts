// 排着的追问（2026-10-29）：Claude Code 的 child 是一次性的 `claude -p`，执行中不能插话（steering=false）。以前 Lead 的指令
// 在这时直接报错「当前 child runtime 不支持执行中 steering」，没有排队等这一轮结束再发的路（用户：「Claude code 既不支持
// steer 也不支持 followup 吗」）。现在指令记在账本上，这一轮结束以后系统续接它的会话发过去。
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren } from "@pi-lead-child/engine";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import { createItem, createRun, getRun, listActivities, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";
import { createLeadTools, runningChildren, spawnItemChild, type LeadDeps } from "../src/tools.js";

// 像 Claude Code：执行中不能插话；第一次的 Run 等 release() 才结束。
class GatedRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: true,
  };
  readonly requests: RuntimeStartRequest[] = [];
  private gate: () => void = () => {};
  private readonly gated = new Promise<void>((resolve) => { this.gate = resolve; });
  release(): void { this.gate(); }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const first = this.requests.length === 1;
    const gated = this.gated;
    async function* events(): AsyncIterable<RuntimeEvent> {
      yield { runId: request.runId, seq: 1, occurredAt: new Date().toISOString(), type: "session.updated", externalSessionId: `session-${request.runId}` };
      yield { runId: request.runId, seq: 2, occurredAt: new Date().toISOString(), type: "run.started", runtime: "claude", model: null };
      if (first) await gated;
      yield { runId: request.runId, seq: 3, occurredAt: new Date().toISOString(), type: "run.completed", exitCode: 0 };
    }
    return {
      pid: null, events: events(), interrupt: async () => {},
      wait: async () => {
        if (first) await gated;
        return { ok: true, exitCode: 0, signal: null, externalSessionId: `session-${request.runId}`, errorCode: null, errorMessage: null };
      },
    };
  }
}

let db: Db;
let deps: LeadDeps;
let runtime: GatedRuntime;
const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;

beforeEach(() => {
  const dir = tempDir("plc-queued-follow-up-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(join(dir, "plc.db"));
  runtime = new GatedRuntime();
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([runtime]) };
});

describe("an instruction for a child that cannot be steered", () => {
  it("is queued while the turn runs and sent to the resumed session when the turn ends", async () => {
    const itemId = createItem(db, { title: "升级依赖", brief: "b", createdBy: "lead", runtime: "claude" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const started = JSON.parse((await tool("continue_ticket_agent").execute("t", { ticket_id: itemId, instruction: "开始做" })).content[0].text);
    await vi.waitFor(() => expect(liveChildren().get(itemId)?.streaming).toBe(true), { timeout: 10_000 });

    const queued = JSON.parse((await tool("continue_ticket_agent").execute("t", {
      ticket_id: itemId, instruction: "base 改成 master，PR 里只留升级的提交",
    })).content[0].text);
    expect(queued).toMatchObject({ mode: "queued", runId: started.runId });
    expect(runtime.requests).toHaveLength(1);

    runtime.release();
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(2), { timeout: 10_000 });
    expect(runtime.requests[1]).toMatchObject({ resumeSessionId: `session-${started.runId}` });
    expect(runtime.requests[1]!.prompt).toContain("base 改成 master，PR 里只留升级的提交");
    const delivered = listActivities(db, itemId).map((row) => JSON.parse(row.payload)).filter((p) => p.decision === "agent_followup_delivered");
    expect(delivered).toHaveLength(1);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
  }, 30_000);
});

// 2026-10-29 用户截图：Lead「找不到执行者的临时目录（它的 $TMPDIR 和我的不同）……那『半个小时』是我估的」。
describe("where a Claude Code child keeps its temp files", () => {
  it("is in read_run_events, so Lead can read the child's logs instead of guessing", async () => {
    const itemId = createItem(db, { title: "升级依赖", brief: "b", createdBy: "lead", workdir: "/Users/x/Work/admin.example.com" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "running", externalSessionId: "38f8692c-e2b2" });
    const text = (await tool("read_run_events").execute("t", { run_id: runId })).content[0].text as string;
    const root = `/private/tmp/claude-${process.getuid!()}`;
    expect(text).toContain(`$TMPDIR 是 ${root}`);
    expect(text).toContain(`${root}/-Users-x-Work-admin-example-com/38f8692c-e2b2/tasks/`);
  });
});

// 2026-10-29 #159：用户 fetch 以后 Lead 用 spawn_child 重新开跑，开的是新会话，前面 72 分钟的上下文全丢了。
describe("starting an executor on a ticket that already has its session", () => {
  it("resumes that session instead of opening a new one", async () => {
    const itemId = createItem(db, { title: "升级依赖", brief: "b", createdBy: "lead", runtime: "claude" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const old = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, old, { state: "finished", endedAt: true, externalSessionId: "session-old" });
    transition(db, { itemId, to: "blocked", actor: "child", reason: "等 fetch" });
    runtime.release();
    expect(spawnItemChild(deps, itemId, {})).toContain(`续接 Run #${old} 的会话`);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1), { timeout: 10_000 });
    expect(runtime.requests[0]).toMatchObject({ resumeSessionId: "session-old" });
    expect(getRun(db, runtime.requests[0]!.runId)!.resumed_from_run_id).toBe(old);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
  });

  it("opens a new session when asked to start fresh", async () => {
    const itemId = createItem(db, { title: "升级依赖", brief: "b", createdBy: "lead", runtime: "claude" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const old = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, old, { state: "finished", endedAt: true, externalSessionId: "session-old" });
    runtime.release();
    spawnItemChild(deps, itemId, { freshSession: true });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1), { timeout: 10_000 });
    expect(runtime.requests[0]!.resumeSessionId).toBeUndefined();
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
  });
});
