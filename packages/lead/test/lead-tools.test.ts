import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, pauseRun, resumeRun, updateRun, getRun } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { createLoopbackBinding } from "@pi-lead-child/store";

// 用户轮次来自的配对凭证。它要真的存在、而且没有作废（审查 H1），轮次才能授权 Lead 代做。
const pairedBinding = () => createLoopbackBinding(db, { name: "Mac 网页" }).binding.id;
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createLeadTools, liveTicketMessagePrompt, resumeItemChild, routeTicketMessageToAgentRun, runningChildren, spawnClaimedItem,
  type LeadDeps,
} from "../src/tools.js";
import { createDispatcher } from "@pi-lead-child/engine";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { buildChildPrompt, buildReviewerPrompt, type RunPurpose, type RuntimeId } from "@pi-lead-child/core";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type { TicketSummary } from "@pi-lead-child/protocol";
import { insertDecisionRequest } from "@pi-lead-child/store";
import { addNotification } from "@pi-lead-child/store";
import { listTriggers } from "@pi-lead-child/store";
import { createTurn } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { createWorkspace } from "@pi-lead-child/store";
import { recordDeliverySnapshot } from "@pi-lead-child/store";

let db: Db;
let dir: string;
let deps: LeadDeps;

function tool(name: string) {
  const t = createLeadTools(deps).find((t: any) => t.name === name) as any;
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function toolNames(): string[] {
  return createLeadTools(deps).map((t: any) => t.name);
}

// 参数名集合，而不是"调用会不会抛错"：本期的论点是**非法状态在 schema 层不可表达**。
// 断言运行时抛错只能证明这一次被挡住了，证明不了 lead 连表达它的语法都没有。
function toolParams(name: string): string[] {
  return Object.keys((tool(name).parameters as any).properties ?? {});
}

// 某个 union 参数的字面量取值域。同上：查的是枚举里有没有这个值，不是传进去会不会被拒。
function paramEnum(name: string, param: string): string[] {
  const prop = (tool(name).parameters as any).properties?.[param];
  return (prop?.anyOf ?? []).map((s: any) => s.const);
}

class CapturingRuntime implements AgentRuntime {
  readonly id: RuntimeId = "codex";
  readonly capabilities = {
    streaming: true,
    steering: false,
    resume: true,
    interrupt: true,
    approvals: false,
    mcp: true,
    executableReadOnlyReview: true,
  };

  readonly requests: RuntimeStartRequest[] = [];

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    async function* events(): AsyncIterable<RuntimeEvent> {
      yield {
        runId: request.runId,
        seq: 1,
        occurredAt: "2026-08-14T10:00:00.000Z",
        type: "session.updated",
        externalSessionId: `session-${request.runId}`,
      };
      yield {
        runId: request.runId,
        seq: 2,
        occurredAt: "2026-08-14T10:00:01.000Z",
        type: "run.started",
        runtime: "codex",
        model: request.model ?? null,
      };
      yield {
        runId: request.runId,
        seq: 3,
        occurredAt: "2026-08-14T10:00:02.000Z",
        type: "run.completed",
        exitCode: 0,
      };
    }
    return {
      pid: null,
      events: events(),
      interrupt: async () => {},
      wait: async () => ({
        ok: true,
        exitCode: 0,
        signal: null,
        externalSessionId: `session-${request.runId}`,
        errorCode: null,
        errorMessage: null,
      }),
    };
  }
}

beforeEach(() => {
  dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir; // config.sessionDir 落进临时目录
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
  };
});

describe("lead tools", () => {
  it("exposes structured runtime recovery without accepting raw command text", async () => {
    expect(toolNames()).toContain("recover_ticket_run");
    expect(toolParams("recover_ticket_run")).toEqual([
      "ticket_id", "run_id", "action", "runtime", "model", "effort", "instruction", "authority_ref",
    ]);

    const itemId = createItem(db, {
      title: "capacity fallback",
      brief: "recover with another model",
      createdBy: "system",
      runtime: "codex",
      model: "gpt-5.5",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5" });
    updateRun(db, runId, {
      state: "failed",
      endedAt: true,
      errorCode: "codex_error",
      errorMessage: "Selected model is at capacity. Please try a different model.",
    });
    grantDelegationPolicy(db, { itemId, createdVia: "test" });

    const result = await tool("recover_ticket_run").execute("recovery", {
      ticket_id: itemId,
      run_id: runId,
      action: "next_model",
      model: "gpt-5.4",
      authority_ref: "lead:test",
    });
    expect(result.content[0].text).toContain('"status": "queued"');
    expect(db.prepare("SELECT trigger, runtime, model FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ trigger: "runtime-recovery", runtime: "codex", model: "gpt-5.4" });
  });

  it("backfills a pre-rollout run's outcome from recorded evidence only", async () => {
    expect(toolParams("register_run_outcome")).toEqual(["ticket_id", "run_id", "authority_ref"]);

    const itemId = createItem(db, { title: "outcome backfill", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff", runId });
    db.prepare("UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?").run(runId);

    const noEvidence = await tool("register_run_outcome").execute("backfill", {
      ticket_id: itemId, run_id: runId, authority_ref: "lead:test",
    });
    expect(noEvidence.content[0].text).toContain('"status": "no_envelope"');
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });

    db.prepare(
      `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
       VALUES (?, 1, 'message.completed', ?, '2026-01-01 00:00:00')`,
    ).run(runId, JSON.stringify({
      type: "message.completed",
      role: "assistant",
      stopReason: "stop",
      text: `PLC_OUTCOME_V1 ${JSON.stringify({
        summary: "Registered the outcome snapshot mechanism.",
        changes: [{ kind: "file", ref: "src/pipeline/outcome-recovery.ts", summary: "Explicit registration" }],
        deliverables: [{ kind: "path", ref: "src/pipeline/outcome-recovery.ts", label: "registry" }],
        validations: [{
          command: "npm test", outcome: "passed", exitCode: 0,
          summary: "suite passed", evidenceRef: null,
        }],
      })}`,
    }));

    const registered = await tool("register_run_outcome").execute("backfill-2", {
      ticket_id: itemId, run_id: runId, authority_ref: "lead:test",
    });
    expect(registered.content[0].text).toContain('"status": "registered"');
    expect(db.prepare(
      "SELECT executor_run_id, source, summary FROM outcome_snapshots WHERE item_id=?",
    ).get(itemId)).toEqual({
      executor_run_id: runId,
      source: "system_recovered",
      summary: "Registered the outcome snapshot mechanism.",
    });
    // Backfilling the executor's own report is not acceptance.
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("query_tickets renders L1 index cards and empty notice", async () => {
    let res = await tool("query_tickets").execute("t1", {});
    expect(res.content[0].text).toContain("无匹配工单");
    createItem(db, { title: "调研 X", brief: "b", createdBy: "lead" });
    res = await tool("query_tickets").execute("t2", {});
    expect(res.content[0].text).toContain("#1");
    expect(res.content[0].text).toContain("[ready]"); // 不 hold 的单子生于 ready
    expect(res.content[0].text).toContain("调研 X");
  });

  it("query_tickets honors the user's literal status filter", async () => {
    const readyId = createItem(db, { title: "ready task", brief: "b", createdBy: "lead" });
    const activeId = createItem(db, { title: "active task", brief: "b", createdBy: "lead" });
    const reviewId = createItem(db, { title: "review task", brief: "b", createdBy: "lead" });
    transition(db, { itemId: activeId, to: "active", actor: "system", reason: "test" });
    transition(db, { itemId: reviewId, to: "active", actor: "system", reason: "test" });
    transition(db, { itemId: reviewId, to: "review", actor: "child", reason: "test" });

    const result = await tool("query_tickets").execute("status", { status: ["active"] });
    const output = result.content[0].text;
    expect(output).toContain(`#${activeId} [active]`);
    expect(output).not.toContain(`#${readyId} [ready]`);
    expect(output).not.toContain(`#${reviewId} [review]`);
  });

  // 2026-10-28 删掉了 accept_review：验收是 ticket_action 的 complete，Lead 凭自己的判断也能验收。
  // 留下的意思：旧交付的 PASS 不能算成对最新交付的托管授权，账本不能写成「按托管验收」。
  it("does not count a superseded reviewer verdict as delegated authority", async () => {
    const itemId = createItem(db, {
      title: "freshness gate",
      brief: "do not accept an older review after rework",
      createdBy: "system",
      verificationPolicy: "independent_reviewer",
      acceptancePolicy: "delegated_to_lead",
      reworkPolicy: "automatic",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "first execution" });
    const firstExecutor = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, firstExecutor, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "first handoff", runId: firstExecutor });

    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare(
      "INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'pass', ?)",
    ).run(reviewer, itemId, "first implementation passed");

    // Simulate a later user-authorized rework and a new implementation cycle.
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const secondExecutor = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, secondExecutor, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "second handoff", runId: secondExecutor });
    grantDelegationPolicy(db, { itemId, createdVia: "test" });

    const accepted = JSON.parse((await tool("ticket_action").execute("stale-review", {
      ticket_id: itemId,
      action: "complete",
      reason: "accept the old pass",
    })).content[0].text);
    expect(accepted.authority).not.toBe("delegated");
  });

  it("get_ticket renders L2 body and activities", async () => {
    const id = createItem(db, { title: "t", brief: "任务说明", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "spawn" });
    const res = await tool("get_ticket").execute("t", { id });
    expect(res.content[0].text).toContain("任务说明");
    expect(res.content[0].text).toContain("transition");
  });

  // 工单 07 审查：每次打开交付的文件都写一条 delivery_file_opened。最近 20 条活动不能被它们挤满，Lead 要看到工单上真正发生的事。
  it("get_ticket leaves file-open records out of the recent activities", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "spawn" });
    for (let index = 0; index < 25; index += 1) {
      addActivity(db, {
        itemId: id, actor: "user", kind: "decision",
        payload: { decision: "delivery_file_opened", path: "docs/plan.md", sequence: 1, location: "workspace", app: "default" },
      });
    }
    const text = (await tool("get_ticket").execute("t", { id })).content[0].text as string;
    expect(text).toContain("spawn");
    expect(text).not.toContain("delivery_file_opened");
  });

  // 工单 04：get_ticket 读交付快照，和工单详情同一份。改了哪些文件以系统的 git diff 为准，不以 agent 自述为准。
  it("get_ticket shows the delivery snapshot the ticket detail shows", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "spawn" });
    expect((await tool("get_ticket").execute("t", { id })).content[0].text)
      .toContain("--- 交付快照（系统记录）---\n（还没有交付快照：这张工单还没交付过）");

    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "delivered" });
    recordDeliverySnapshot(db, {
      itemId: id, executorRunId: runId, reason: "delivered", source: "git", baseSha: "a".repeat(40), headSha: "b".repeat(40),
      commits: [{ sha: "b".repeat(40), subject: "plan" }], commitCount: 1,
      files: [
        { path: "docs/plan.md", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false, label: null, note: "方案", generated: null },
        { path: "src/a.ts", previousPath: null, status: "modified", additions: 1, deletions: 2, binary: false, label: null, note: null, generated: null },
        { path: "package-lock.json", previousPath: null, status: "modified", additions: 9, deletions: 9, binary: false, label: null, note: null, generated: "lock" },
      ],
      totals: { files: 3, additions: 13, deletions: 11 }, truncated: false, uncommittedFiles: 0,
    });
    const text = (await tool("get_ticket").execute("t", { id })).content[0].text as string;
    expect(text).toContain(`第 1 次交付（共 1 次）· 执行 Run #${runId} · 交付时存的`);
    expect(text).toContain("来源：系统跑的 git diff · aaaaaaa → bbbbbbb · 1 个提交 · 改了 3 个文件 +13 −11");
    expect(text).toContain("重点文件（执行 agent 写了说明）：\n- docs/plan.md（新增，+3 −0）：方案");
    expect(text).toContain("其他文件：\n- src/a.ts（修改，+1 −2）");
    expect(text).toContain("lock 或生成的文件 1 个：package-lock.json");
  });

  it("get_session_entries reads JSONL tail (L3)", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId: id });
    const sessPath = join(dir, "s.jsonl");
    writeFileSync(sessPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "做任务" } }),
      JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "好的开始" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }] } }),
    ].join("\n") + "\n");
    updateRun(db, runId, { sessionPath: sessPath });
    const res = await tool("get_session_entries").execute("t", { attempt_id: runId });
    expect(res.content[0].text).toContain("做任务");
    expect(res.content[0].text).toContain("好的开始");
    expect(res.content[0].text).toContain("bash");
  });

  // 原 create_ticket 已按 spec §8 拆成 create_task / create_reminder；这条断言的内容
  // （lead 建的单落 created_by='lead'）原样保留，只换到新入口上。
  it("create_task inserts with created_by lead", async () => {
    const res = await tool("create_task").execute("t", { title: "新任务", brief: "说明" });
    expect(res.content[0].text).toMatch(/#1/);
    expect(getItem(db, 1)!.created_by).toBe("lead");
  });

  it("omitted spawn_child runtime persists the first healthy catalog host instead of pi", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
      runtimeCatalog: {
        entries: [
          {
            id: "codex",
            available: true,
            executable: "/opt/homebrew/bin/codex",
            defaultModel: "openai/gpt-5.5",
            models: ["openai/gpt-5.5"],
            capabilities: runtime.capabilities,
            reason: null,
          },
          {
            id: "claude",
            available: false,
            executable: null,
            defaultModel: null,
            models: [],
            capabilities: { ...runtime.capabilities, executableReadOnlyReview: false },
            reason: "executable not found",
          },
          {
            id: "pi",
            available: true,
            executable: "/repo/node_modules/.bin/pi",
            defaultModel: "openai/gpt-5.5",
            models: ["openai/gpt-5.5"],
            capabilities: { ...runtime.capabilities, mcp: false, executableReadOnlyReview: false },
            reason: null,
          },
        ],
      },
    };
    const itemId = createItem(db, { title: "omit runtime", brief: "b", createdBy: "lead" });
    const res = await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId });
    expect(res.content[0].text).toContain("runtime=codex");
    expect(getItem(db, itemId)).toMatchObject({ requested_runtime: "codex" });
    expect(listActivities(db, itemId).some((row) => {
      const payload = JSON.parse(row.payload) as { decision?: string; runtime?: string; source?: string };
      return payload.decision === "runtime_selected"
        && payload.runtime === "codex"
        && payload.source === "catalog";
    })).toBe(true);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    // 2026-10-15：没有选模型、也没有配置时不传模型，由 Codex 用自己的配置。
    expect(runtime.requests[0]).toMatchObject({ itemId });
    expect(runtime.requests[0]!.model).toBeUndefined();
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  // 2026-10-20：spawn_child 派核查员不给 runtime 时按选核查员的顺序选（能跑命令的 codex 优先，跳过停用的），
  // 不用执行者的 runtime，也不把核查员写回工单。不能跑命令的核查员在提示里被告知这一点。
  // 以前用执行者的 runtime，执行者是 Claude Code 时直接报错「cannot enforce executable read-only review」。
  it("spawn_child picks a reviewer by the reviewer order, not the executor's runtime, and tells a read-only one", async () => {
    class NamedRuntime extends CapturingRuntime {
      constructor(readonly id: RuntimeId, runsCommands: boolean) {
        super();
        (this.capabilities as { executableReadOnlyReview: boolean }).executableReadOnlyReview = runsCommands;
      }
    }
    const codex = new NamedRuntime("codex", true);
    const claude = new NamedRuntime("claude", false);
    const pi = new NamedRuntime("pi", false);
    const entry = (runtime: NamedRuntime) => ({
      id: runtime.id, available: true, executable: `/bin/${runtime.id}`, defaultModel: null, models: [],
      capabilities: runtime.capabilities, reason: null,
    });
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([codex, claude, pi]),
      runtimeCatalog: { entries: [entry(codex), entry(claude), entry(pi)] },
    };
    const delivered = (title: string) => {
      const itemId = createItem(db, { title, brief: `${title}：只核查不改`, createdBy: "user", runtime: "pi" });
      transition(db, { itemId, to: "active", actor: "system", reason: "test" });
      const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
      updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
      transition(db, { itemId, to: "review", actor: "child", reason: "done", runId });
      return itemId;
    };

    const first = delivered("codex reviews");
    expect((await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: first, role: "reviewer" })).content[0].text)
      .toContain("runtime=codex");
    await vi.waitFor(() => expect(codex.requests).toHaveLength(1));
    expect(codex.requests[0]).toMatchObject({ itemId: first, role: "reviewer" });
    expect(codex.requests[0]!.prompt).not.toContain("这次核查不能运行命令");
    // 核查包（工单 10）：系统拼好接在后面，brief 原文在里面；存下了一份。
    expect(codex.requests[0]!.prompt).toContain("## 核查包（系统拼好的，没有经过任何模型）");
    expect(codex.requests[0]!.prompt).toContain("codex reviews：只核查不改");
    expect(db.prepare("SELECT COUNT(*) FROM review_packets WHERE item_id=?").pluck().get(first)).toBe(1);
    expect(getItem(db, first)?.requested_runtime).toBe("pi");
    await vi.waitFor(() => expect(runningChildren().has(first)).toBe(false));

    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    try {
      const second = delivered("claude reviews");
      expect((await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: second, role: "reviewer" })).content[0].text)
        .toContain("runtime=claude");
      await vi.waitFor(() => expect(claude.requests).toHaveLength(1));
      expect(claude.requests[0]!.prompt).toContain(buildReviewerPrompt(getItem(db, second)!));
      expect(claude.requests[0]!.prompt).toContain("这次核查不能运行命令");
      expect(getItem(db, second)?.requested_runtime).toBe("pi");
      await vi.waitFor(() => expect(runningChildren().has(second)).toBe(false));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 2026-10-20：Lead 换核查员。排着的核查改 runtime，没有核查时新排一条。2026-10-21 起它是 ticket_action 的 change_reviewer，
  // 和页面的「换核查员」同一份实现（工单操作层）。
  it("ticket_action change_reviewer moves a queued review to another runtime, and queues one when none is queued", async () => {
    const itemId = createItem(db, { title: "review me", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId });

    const change = async (runtime: string, reason: string) => JSON.parse((await tool("ticket_action").execute("t", {
      ticket_id: itemId, action: "change_reviewer", input: { runtime }, reason,
    })).content[0].text);
    const queued = await change("claude", "用户说 codex 停用了");
    expect(queued).toMatchObject({
      ticket_id: itemId, authority: "lead", result: { deliveryRunId: runId, from: null, to: "claude", created: true },
    });
    const moved = await change("pi", "换一个");
    expect(moved.result).toMatchObject({ dispatchRequestId: queued.result.dispatchRequestId, from: "claude", to: "pi", created: false });
    expect(db.prepare("SELECT runtime, trigger FROM dispatch_requests WHERE id=?").get(queued.result.dispatchRequestId))
      .toEqual({ runtime: "pi", trigger: "lead-review" });
    expect(listActivities(db, itemId).filter((row) => JSON.parse(row.payload).decision === "reviewer_runtime_switched")
      .map((row) => [row.actor, JSON.parse(row.payload).message]))
      .toEqual([["lead", "核查员从 Claude Code 换成 Pi agent：换一个"]]);
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    try {
      await expect(change("codex", "x")).rejects.toThrow(/停用/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("spawn_child runs child in background to settle", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const done = vi.fn();
    deps.onChildDone = done;
    const res = await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: id });
    expect(res.content[0].text).toContain("spawned");
    expect(runningChildren().has(id)).toBe(true);
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(runningChildren().has(id)).toBe(false);
    expect(getItem(db, id)!.stage).toBe("blocked");
    expect(getRun(db, 1)!.state).toBe("finished");
    expect(db.prepare(
      "SELECT idempotency_key FROM checkpoints WHERE run_id=? ORDER BY id DESC LIMIT 1",
    ).get(1)).toEqual({ idempotency_key: "run-handoff-failed:1" });
  });

  it("routes ticket detail messages by resuming the latest agent session", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, {
      title: "review work",
      brief: "needs review",
      createdBy: "system",
      runtime: "codex",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const oldRunId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, oldRunId, {
      state: "failed",
      model: "gpt-5.6-sol",
      externalSessionId: "old-review-session",
      sessionId: "old-review-session",
      endedAt: true,
    });

    const routed = routeTicketMessageToAgentRun(deps, { itemId, message: "这个单需要我干什么" });

    expect(routed).toMatchObject({
      mode: "resumed",
      resumedFromRunId: oldRunId,
      resumedSessionId: "old-review-session",
      role: "reviewer",
      runtime: "codex",
    });
    expect(routed.runId).not.toBe(oldRunId);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({
      itemId,
      runId: routed.runId,
      role: "reviewer",
      purpose: "conversation",
      // 接着原来的 session 说话，用原来的模型（以前会被改写成 gpt-5.5）。
      model: "gpt-5.6-sol",
      resumeSessionId: "old-review-session",
    });
    expect(runtime.requests[0]!.prompt).toContain("这个单需要我干什么");
    expect(runtime.requests[0]!.prompt).toContain("activate_ticket_run");
    expect(runtime.requests[0]!.prompt).toContain("mcp__plc__activate_ticket_run");
    expect(runtime.requests[0]!.prompt).toContain("provider-facing name");
    expect(runtime.requests[0]!.prompt).toContain("do not classify it with keyword or regular-expression matching");
    expect(getRun(db, routed.runId)?.resumed_from_run_id).toBe(oldRunId);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  // 工单 08（spec D13）：续接的会话只记得旧状态（2026-10-16 的 #77：已经 done，reviewer 的旧会话答「还在 review」）。
  // 对话 Run 的输入开头是系统现在的 TicketSummary（deps.ticketSummary，daemon 注入网关生成它的函数），写明以它为准。
  // 2026-10-19：有 Run 在跑时，工单对话的消息插进那个 Run，开头同样是系统现在的 TicketSummary。拿不到摘要时只发原话。
  it("puts the current ticket summary before a message into a live run", () => {
    const summary = { id: 7, title: "live work", stage: "active", status: "active" } as unknown as TicketSummary;
    const input = liveTicketMessagePrompt({ ticketSummary: (id) => (id === 7 ? summary : undefined) }, 7, "顺便看下测试");
    expect(input.startsWith("## Current ticket state (authoritative)\n")).toBe(true);
    expect(JSON.parse(input.match(/```json\n([\s\S]*?)\n```/u)![1]!)).toEqual(summary);
    expect(input.endsWith("## Message from the user in the ticket chat\n顺便看下测试")).toBe(true);
    expect(liveTicketMessagePrompt({ ticketSummary: () => undefined }, 7, "顺便看下测试")).toBe("顺便看下测试");
    expect(liveTicketMessagePrompt({ ticketSummary: () => { throw new Error("starting"); } }, 7, "在吗")).toBe("在吗");
  });

  it("puts the current ticket summary at the start of a resumed conversation's input", async () => {
    const runtime = new CapturingRuntime();
    const itemId = createItem(db, { title: "done work", brief: "b", createdBy: "system", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const oldRunId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, oldRunId, { state: "finished", externalSessionId: "review-session", endedAt: true });
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
    const summary = { id: itemId, title: "done work", stage: "done", status: "done" } as unknown as TicketSummary;
    const asked: number[] = [];
    deps = {
      ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]),
      ticketSummary: (id) => { asked.push(id); return id === itemId ? summary : undefined; },
    };

    routeTicketMessageToAgentRun(deps, { itemId, message: "现在进展怎么样" });

    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    const prompt = runtime.requests[0]!.prompt;
    expect(runtime.requests[0]!.resumeSessionId).toBe("review-session");
    expect(asked).toEqual([itemId]);
    expect(prompt.startsWith("## Current ticket state (authoritative)\n")).toBe(true);
    expect(prompt).toContain("Where your memory disagrees, trust this state.");
    expect(JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/u)![1]!)).toEqual(summary);
    expect(prompt.indexOf("## Current ticket state")).toBeLessThan(prompt.indexOf("现在进展怎么样"));
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  it("routes ticket detail messages by starting a new agent run when no run exists", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, {
      title: "fresh work",
      brief: "needs first run",
      createdBy: "system",
      runtime: "codex",
    });

    const routed = routeTicketMessageToAgentRun(deps, { itemId, message: "先看一下这个单" });

    expect(routed).toMatchObject({
      mode: "started",
      resumedFromRunId: null,
      resumedSessionId: null,
      role: "executor",
      runtime: "codex",
    });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({
      itemId,
      runId: routed.runId,
      role: "executor",
      purpose: "conversation",
      resumeSessionId: undefined,
    });
    expect(runtime.requests[0]!.prompt).toContain("先看一下这个单");
    expect(getRun(db, routed.runId)?.resumed_from_run_id).toBeNull();
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  it("resumes a ticket-agent activation session when the durable execution dispatch starts", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, {
      title: "activated continuation",
      brief: "continue the same work",
      createdBy: "system",
      runtime: "codex",
    });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(itemId);
    const conversationRunId = createRun(db, {
      itemId,
      role: "executor",
      purpose: "conversation",
      runtime: "codex",
    });
    updateRun(db, conversationRunId, {
      state: "finished",
      externalSessionId: "ticket-agent-session",
      sessionId: "ticket-agent-session",
      endedAt: true,
    });
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId,
      role: "executor",
      purpose: "execution",
      runtime: "codex",
      resumeFromRunId: conversationRunId,
      instruction: "继续完成剩余 E2E，并在通过后提交 Review",
      trigger: "ticket-agent-continuation",
      idempotencyKey: `ticket-agent-activation:${conversationRunId}`,
    });
    const claim = dispatcher.claimNext()!;
    dispatcher.markStarted(claim);

    spawnClaimedItem(deps, claim);

    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({
      itemId,
      runId: claim.runId,
      purpose: "execution",
      resumeSessionId: "ticket-agent-session",
    });
    expect(runtime.requests[0]!.prompt).toContain("继续完成剩余 E2E，并在通过后提交 Review");
    expect(getRun(db, claim.runId)?.resumed_from_run_id).toBe(conversationRunId);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  it("routes ticket detail messages as conversation runs without consuming execution retry budget", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, {
      title: "blocked work",
      brief: "ask status",
      createdBy: "system",
      runtime: "codex",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const firstRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, firstRunId, {
      state: "failed",
      externalSessionId: "failed-session",
      sessionId: "failed-session",
      endedAt: true,
    });
    const secondRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, secondRunId, { state: "failed", endedAt: true });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(itemId);

    const routed = routeTicketMessageToAgentRun(deps, { itemId, message: "这个单子现在是什么情况" });

    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(routed).toMatchObject({
      mode: "resumed",
      resumedFromRunId: firstRunId,
      purpose: "conversation",
      runtime: "codex",
    });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({
      itemId,
      runId: routed.runId,
      purpose: "conversation",
      resumeSessionId: "failed-session",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE item_id=? AND purpose='execution' AND state='failed'",
    ).get(itemId)).toEqual({ n: 2 });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  // 用户的决定：工单消息不改变暂停的 Run 的生命周期。以前这里续接暂停的 Run 本身，按 conversation 跑它，
  // 这一回合结束时它就 finished 了。现在另起一个 conversation Run，在暂停的 Run 的 session 的副本上回答。
  it("answers a message for a paused run from a new conversation run on a fork of its session", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const workdir = tempDir("plc-lead-paused-workspace-");
    const itemId = createItem(db, {
      title: "paused work", brief: "keep going", createdBy: "system", runtime: "codex", workdir,
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const workspace = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: workdir, state: "active",
    });
    const pausedRunId = createRun(db, {
      itemId, role: "executor", purpose: "execution", runtime: "codex", workspaceId: workspace.id,
    });
    updateRun(db, pausedRunId, { state: "running", externalSessionId: "paused-session", sessionId: "paused-session" });
    pauseRun(db, pausedRunId);

    const routed = routeTicketMessageToAgentRun(deps, { itemId, message: "你现在做到哪了" });

    expect(routed).toMatchObject({
      mode: "resumed",
      resumedFromRunId: pausedRunId,
      resumedSessionId: "paused-session",
      forkedSession: true,
      role: "executor",
      purpose: "conversation",
    });
    expect(routed.runId).not.toBe(pausedRunId);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    // 暂停的 Run 占着工作区（workspace.ts 把 paused 算作活跃），这只挡释放和清理。对话 Run 照常在同一个工作区上跑。
    expect(getRun(db, routed.runId)).toMatchObject({
      purpose: "conversation", resumed_from_run_id: pausedRunId, workspace_id: workspace.id,
    });
    expect(runtime.requests[0]).toMatchObject({
      runId: routed.runId,
      purpose: "conversation",
      workdir,
      resumeSessionId: "paused-session",
      forkSession: true,
    });
    expect(runtime.requests[0]!.prompt).toContain(`Run #${pausedRunId} of this ticket is paused by the user.`);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
    expect(getRun(db, pausedRunId)).toMatchObject({ state: "paused", purpose: "execution" });
  });

  // 恢复一个暂停的 Run 不新建 Run。所以 id 最大的 Run 不一定是最近跑过的那个：暂停期间的对话 Run id 更大，
  // 可它的 session 是暂停时的副本。之后恢复的执行 Run 才是最近的进展，下一次对话要续接它的 session。
  it("resumes the session of the run that started last, not the run with the highest id", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, { title: "resumed work", brief: "keep going", createdBy: "system", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const executionRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    addActivity(db, { itemId, runId: executionRunId, actor: "system", kind: "attempt_start", payload: {} });
    const chatRunId = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "codex" });
    addActivity(db, { itemId, runId: chatRunId, actor: "system", kind: "attempt_start", payload: {} });
    updateRun(db, chatRunId, { state: "finished", externalSessionId: "chat-fork", sessionId: "chat-fork", endedAt: true });
    // 恢复控制续接了执行 Run：同一行，又一次 attempt_start。
    addActivity(db, { itemId, runId: executionRunId, actor: "system", kind: "attempt_start", payload: {} });
    updateRun(db, executionRunId, {
      state: "finished", externalSessionId: "execution-session", sessionId: "execution-session", endedAt: true,
    });

    const routed = routeTicketMessageToAgentRun(deps, { itemId, message: "做完了吗" });

    expect(routed).toMatchObject({
      mode: "resumed", resumedFromRunId: executionRunId, resumedSessionId: "execution-session", forkedSession: false,
    });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({ resumeSessionId: "execution-session" });
    expect(runtime.requests[0]!.forkSession).toBeFalsy();
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  // 恢复控制续接的是这个 Run 本身：按它原来的 role、purpose、模型和合适的提示跑。以前一律按执行 Run 跑：
  // 暂停的对话 Run 拿到整份任务提示、按执行跑（暂停的执行 Run 旁边多出第二条工作线）；暂停的 reviewer Run
  // 以 executor 过闸门，在 review 里被拒绝，记成失败；暂停的修复回合按执行跑，重做任务。
  describe("resuming a paused run", () => {
    function pausedRun(
      itemId: number,
      input: { role: "executor" | "reviewer"; purpose: RunPurpose; resumedFromRunId?: number },
    ): number {
      const runId = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5-paused", ...input });
      updateRun(db, runId, { state: "running", externalSessionId: `session-${runId}`, sessionId: `session-${runId}` });
      addActivity(db, { itemId, runId, actor: "system", kind: "attempt_start", payload: {} });
      pauseRun(db, runId);
      // 用户的恢复先把 Run 翻回 running（UserActionService.resumeRun），再拉起进程。
      resumeRun(db, runId);
      return runId;
    }

    async function resume(itemId: number, runId: number): Promise<RuntimeStartRequest> {
      const runtime = new CapturingRuntime();
      deps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]) };
      resumeItemChild(deps, { itemId, runId, sessionId: `session-${runId}` });
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
      expect(runtime.requests).toHaveLength(1);
      return runtime.requests[0]!;
    }

    function startedAsRecords(itemId: number): number {
      return (db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='run_started_as'",
      ).get(itemId) as { n: number }).n;
    }

    function activeItem(title: string): number {
      const itemId = createItem(db, {
        title, brief: "keep going", createdBy: "system", runtime: "codex", model: "gpt-5.5-item",
      });
      transition(db, { itemId, to: "active", actor: "system", reason: "start" });
      return itemId;
    }

    it("resumes an execution run with the task prompt and its own model, and names the chats that ran meanwhile", async () => {
      const itemId = activeItem("paused execution");
      const runId = pausedRun(itemId, { role: "executor", purpose: "execution" });
      // 暂停期间，旁边的工单对话在同一个工作区里跑过。
      const chatRunId = createRun(db, { itemId, purpose: "conversation", runtime: "codex" });
      addActivity(db, { itemId, runId: chatRunId, actor: "system", kind: "attempt_start", payload: {} });
      updateRun(db, chatRunId, { state: "finished", endedAt: true });

      const request = await resume(itemId, runId);

      expect(request).toMatchObject({
        runId, role: "executor", purpose: "execution", model: "gpt-5.5-paused", resumeSessionId: `session-${runId}`,
      });
      // child 的提示词里带用户给 Lead 起的名字（缺省 Paimon，2026-10-22）。
      expect(request.prompt).toContain(buildChildPrompt(getItem(db, itemId)!, { leadName: "Paimon" }));
      expect(request.prompt).toContain("用户把 Lead 叫做 Paimon");
      expect(request.prompt).toContain(`ticket conversation run #${chatRunId} ran in the same workspace`);
      expect(getRun(db, runId)).toMatchObject({ state: "finished", purpose: "execution" });
    });

    it("resumes a ticket conversation as a conversation, without the task prompt", async () => {
      const itemId = activeItem("paused chat");
      const runId = pausedRun(itemId, { role: "executor", purpose: "conversation" });

      const request = await resume(itemId, runId);

      expect(request).toMatchObject({ runId, role: "executor", purpose: "conversation" });
      expect(request.prompt).toContain("## Resumed ticket conversation");
      expect(request.prompt).not.toContain(buildChildPrompt(getItem(db, itemId)!));
      expect(getRun(db, runId)).toMatchObject({ state: "finished", purpose: "conversation" });
      expect(startedAsRecords(itemId)).toBe(0);
    });

    it("resumes a reviewer run as a review in the review stage", async () => {
      const itemId = activeItem("paused review");
      transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
      const runId = pausedRun(itemId, { role: "reviewer", purpose: "review" });

      const request = await resume(itemId, runId);

      expect(request).toMatchObject({ runId, role: "reviewer", purpose: "review", model: "gpt-5.5-paused" });
      expect(request.prompt).toContain(buildReviewerPrompt(getItem(db, itemId)!));
      expect(getRun(db, runId)).toMatchObject({ state: "finished", role: "reviewer", purpose: "review" });
      expect(startedAsRecords(itemId)).toBe(0);
    });

    it("resumes an outcome repair turn with the repair prompt for its source run", async () => {
      const itemId = activeItem("paused repair");
      const sourceRunId = createRun(db, { itemId, purpose: "execution", runtime: "codex" });
      updateRun(db, sourceRunId, { state: "finished", endedAt: true, externalSessionId: "source-session" });
      const runId = pausedRun(itemId, { role: "executor", purpose: "outcome_repair", resumedFromRunId: sourceRunId });

      const request = await resume(itemId, runId);

      expect(request).toMatchObject({ runId, role: "executor", purpose: "outcome_repair" });
      expect(request.prompt).toContain(`成果修复回合：工单 #${itemId}`);
      expect(request.prompt).toContain(`Run #${sourceRunId}`);
      expect(request.prompt).not.toContain("ran in the same workspace");
      expect(getRun(db, runId)).toMatchObject({ purpose: "outcome_repair" });
      expect(startedAsRecords(itemId)).toBe(0);
    });
  });

  // running 表按工单登记启动。一次启动结束时，只删它自己的条目：同一张工单之后的启动可能已经换上了自己的条目。
  // 以前 settleChild 按工单删，后来那次启动的条目被删掉，lead 和派发就以为这张工单上没有 Run 在跑。
  it("removes only its own running entry when a run settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new CapturingRuntime();
    const start = runtime.start.bind(runtime);
    runtime.start = async (request) => {
      await gate;
      return start(request);
    };
    deps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]) };
    const done = vi.fn();
    deps.onChildDone = done;
    const itemId = createItem(db, { title: "chat", brief: "b", createdBy: "system", runtime: "codex" });
    routeTicketMessageToAgentRun(deps, { itemId, message: "在吗" });
    // 另一次启动换上了自己的条目。
    const later = new Promise<void>(() => {});
    runningChildren().set(itemId, later);

    release();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(itemId));
    expect(runningChildren().get(itemId)).toBe(later);
    runningChildren().delete(itemId);
  });

  // 对话 Run 的行和工单消息一起写。消息写不进去时，不留一个 starting 的对话 Run：它会挡住恢复和派发，
  // 直到 daemon 重启。
  it("leaves no starting conversation run when the ticket message cannot be recorded", () => {
    const runtime = new CapturingRuntime();
    deps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]) };
    const itemId = createItem(db, { title: "chat", brief: "b", createdBy: "system", runtime: "codex" });
    db.exec(`CREATE TEMP TRIGGER fail_ticket_message BEFORE INSERT ON activities
      WHEN NEW.kind = 'comment' BEGIN SELECT RAISE(ABORT, 'activity write failed'); END`);
    try {
      expect(() => routeTicketMessageToAgentRun(deps, { itemId, message: "在吗" })).toThrow(/activity write failed/);
    } finally {
      db.exec("DROP TRIGGER fail_ticket_message");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(runningChildren().has(itemId)).toBe(false);
    expect(runtime.requests).toHaveLength(0);
  });

  it("exposes ticket agent continuation as a Lead tool with structured output", async () => {
    const runtime = new CapturingRuntime();
    deps = {
      ...deps,
      childPi: undefined,
      runtimeRegistry: new RuntimeRegistry([runtime]),
    };
    const itemId = createItem(db, {
      title: "lead continuation",
      brief: "continue agent",
      createdBy: "system",
      runtime: "codex",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const oldRunId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, oldRunId, {
      state: "finished",
      externalSessionId: "old-agent-session",
      sessionId: "old-agent-session",
      endedAt: true,
    });

    const result = await tool("continue_ticket_agent").execute("t", {
      ticket_id: itemId,
      instruction: "按刚才的反馈继续处理",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      mode: "resumed",
      ticketId: itemId,
      resumedFromRunId: oldRunId,
      resumedSessionId: "old-agent-session",
      role: "executor",
      runtime: "codex",
    });
    expect(payload.runId).not.toBe(oldRunId);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    expect(runtime.requests[0]).toMatchObject({
      resumeSessionId: "old-agent-session",
      runId: payload.runId,
    });
    expect(listActivities(db, itemId).find((activity) => activity.actor === "lead" && activity.run_id === payload.runId))
      .toMatchObject({
      actor: "lead",
      run_id: payload.runId,
    });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
  });

  it("exposes sanitized Supervisor diagnostics and bounded maintenance requests", async () => {
    const status = {
      maintenanceActive: false,
      supervisor: {
        version: 1 as const,
        desiredState: "running" as const,
        phase: "running" as const,
        supervisorPid: 10,
        daemonPid: 11,
        crashCount: 0,
        lastDaemonExit: null,
        maintenance: null,
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
      daemon: { pid: 11, runningItemIds: [] },
      schemaVersion: 18,
      latestSchemaVersion: 18,
      features: ["maintenance_backup", "deploy_gate"],
    };
    const request = {
      id: "maintenance-1",
      action: "upgrade" as const,
      reason: "schema upgrade",
      requiredSchemaVersion: 18,
      requestedAt: "2026-08-17T00:00:00.000Z",
      state: "pending" as const,
      startedAt: null,
      completedAt: null,
      backupPath: null,
      error: null,
    };
    const supervisor = {
      status: vi.fn(async () => status),
      request: vi.fn(async () => request),
    };
    deps = { ...deps, supervisor };

    const health = await tool("get_runtime_health").execute("health", {});
    expect(JSON.parse(health.content[0].text)).toMatchObject({
      schemaVersion: 18,
      childRuntimes: { entries: expect.any(Array) },
    });
    const result = await tool("request_runtime_maintenance").execute("maintenance", {
      action: "upgrade",
      reason: "schema upgrade",
      required_schema_version: 18,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: "maintenance-1", state: "pending" });
    expect(supervisor.request).toHaveBeenCalledWith({
      action: "upgrade",
      reason: "schema upgrade",
      requiredSchemaVersion: 18,
    });
    expect(toolParams("request_runtime_maintenance")).toEqual([
      "action", "reason", "required_schema_version",
    ]);
  });

  // 2026-10-26：会话输入框右下角的模型选择。daemon 给了模型服务时，两个工具读同一份目录、走同一个操作（lead_model / switch），
  // 只在用户本人这一轮里换。
  it("list_lead_models and switch_lead_model use the composer's model service", async () => {
    const switches: unknown[] = [];
    const leadModels = {
      state: () => ({ current: { model: "vibeproxy/claude-sonnet-5", effort: null }, selected: { model: "vibeproxy/claude-sonnet-5", effort: null } }),
      catalog: async () => ({
        ...leadModels.state(),
        models: [{
          model: "vibeproxy/as4/claude-sonnet-5", provider: "vibeproxy", id: "as4/claude-sonnet-5", prefix: "as4", source: "anthropic",
          name: null, image: true, efforts: ["low", "high"], defaultEffort: null, blockedUntil: null,
        }],
      }),
      switch: async (choice: { model: string; effort: string | null }) => {
        switches.push(choice);
        return { previous: leadModels.state().selected, selected: choice, applied: "now" as const };
      },
    };
    let turnId: string | null = null;
    deps = { ...deps, uiActionServices: { leadModels }, currentTurnId: () => turnId };

    const listed = JSON.parse((await tool("list_lead_models").execute("list", {})).content[0].text);
    expect(listed.models).toEqual([{
      model: "vibeproxy/as4/claude-sonnet-5", prefix: "as4", source: "anthropic", image: true, efforts: ["low", "high"],
    }]);

    // 复审 2026-10-27 D：reason 必填，工具不替 Lead 编。
    await expect(tool("switch_lead_model").execute("switch", { model: "vibeproxy/as4/claude-sonnet-5(high)" }))
      .rejects.toThrow(/reason/);
    // 不在用户这一轮里也能换（用户 2026-10-27），记成 Lead 自己换的。
    const own = JSON.parse((await tool("switch_lead_model").execute("switch", {
      model: "vibeproxy/as4/claude-sonnet-5(high)", reason: "现在的模型额度用完了",
    })).content[0].text);
    expect(own).toMatchObject({ authority: "lead" });
    expect(switches).toEqual([{ model: "vibeproxy/as4/claude-sonnet-5", effort: "high" }]);
    switches.splice(0);

    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    turnId = createTurn(db, { originBindingId: binding.id, originKind: "paired:companion", userText: "换成 as4 的 sonnet，high", state: "streaming" }).id;
    const switched = JSON.parse((await tool("switch_lead_model").execute("switch", {
      model: "vibeproxy/as4/claude-sonnet-5(high)", reason: "用户说换成 as4 的 sonnet，high",
    })).content[0].text);
    expect(switched.result).toMatchObject({ applied: "now", selected: { model: "vibeproxy/as4/claude-sonnet-5", effort: "high" } });
    expect(switches).toEqual([{ model: "vibeproxy/as4/claude-sonnet-5", effort: "high" }]);
  });

  it("switch_lead_model writes a configured model and schedules restart after the turn", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: {
        providers: {
          vibeproxy: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8317/v1",
            discover: false,
            models: ["claude-sonnet-5", "gemini-3.7-flash-high"],
          },
        },
        models: ["vibeproxy/gemini-3.7-flash-high"],
      },
    }));
    const supervisor = {
      status: vi.fn(),
      request: vi.fn(),
    };
    const announceLeadStatus = vi.fn();
    const scheduleLeadModelRestart = vi.fn();
    deps = { ...deps, supervisor, announceLeadStatus, scheduleLeadModelRestart };

    expect(toolNames()).toContain("switch_lead_model");
    expect(toolNames()).toContain("list_lead_models");
    expect(toolParams("switch_lead_model")).toEqual(["model", "effort", "reason"]);

    const listed = JSON.parse((await tool("list_lead_models").execute("list", {})).content[0].text);
    expect(listed.selected).toBe("vibeproxy/gemini-3.7-flash-high");
    expect(listed.available).toEqual([
      "vibeproxy/gemini-3.7-flash-high",
      "vibeproxy/claude-sonnet-5",
    ]);

    const switched = JSON.parse((await tool("switch_lead_model").execute("switch", {
      model: "vibeproxy/claude-sonnet-5",
      reason: "user asked for Sonnet 5",
    })).content[0].text);
    expect(switched).toMatchObject({
      switched: true,
      previous: "vibeproxy/gemini-3.7-flash-high",
      selected: "vibeproxy/claude-sonnet-5",
      restart: { scheduled: true, when: "after_turn" },
    });
    expect(switched.status).toContain("【系统】");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models).toEqual([
      "vibeproxy/claude-sonnet-5",
      "vibeproxy/gemini-3.7-flash-high",
    ]);
    expect(supervisor.request).not.toHaveBeenCalled();
    expect(announceLeadStatus).toHaveBeenCalledWith(expect.stringContaining("vibeproxy/claude-sonnet-5"));
    expect(scheduleLeadModelRestart).toHaveBeenCalledWith({
      previous: "vibeproxy/gemini-3.7-flash-high",
      selected: "vibeproxy/claude-sonnet-5",
      reason: "user asked for Sonnet 5",
    });

    supervisor.request.mockClear();
    const same = JSON.parse((await tool("switch_lead_model").execute("switch", {
      model: "vibeproxy/claude-sonnet-5", reason: "user asked for Sonnet 5",
    })).content[0].text);
    expect(same).toMatchObject({ switched: false, selected: "vibeproxy/claude-sonnet-5" });
    expect(supervisor.request).not.toHaveBeenCalled();

    await expect(tool("switch_lead_model").execute("switch", {
      model: "vibeproxy/grok-4.6", reason: "user asked for Grok",
    })).rejects.toThrow(/不在已配置/);
    // 复审 2026-10-27 D：没有操作层服务时（写 config.json 的那条路）也要 reason。
    await expect(tool("switch_lead_model").execute("switch", { model: "vibeproxy/gemini-3.7-flash-high" }))
      .rejects.toThrow(/reason/);
  });

  // 原名 "transition_ticket + record_decision close the loop"。transition_ticket 已删除
  // （它的枚举在广告矩阵不给 lead 的边），那条边改由 cancel_item 承担；2026-10-28 cancel_item 也删了，取消是 ticket_action 的 cancel。
  // "lead 拍不了板"这条断言原样保留，只是从"工具调用被拒"下沉成"矩阵直接拒绝 actor=lead"。
  //
  // 这一版把取消挪到 active 上执行。原来它就地取消那张 review 的单子，而 review→cancelled
  // 现已收归 user——那条边正是 lead 清空用户验收清单的通道。断言的意思没有变弱，反而更准：
  // 在 review 上 lead 两块板都拍不了（done 和 cancelled 都是用户的），它的取消权在验收之前
  // 那几个 stage 上，一条没少。
  it("ticket_action cancel + record_decision close the loop", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    await tool("record_decision").execute("t", { ticket_id: id, decision: "验收通过", reason: "结果正确" });
    // 2026-10-28（用户：「工单操作让 Lead 自己判断」）：验收（review -> done）、否决（review -> cancelled）lead 也能做，
    // 由 Lead 判断（提示词：「终止任务」不等于丢弃已经交付的成果）。这里先打回重做，再取消。
    transition(db, { itemId: id, to: "active", actor: "lead", reason: "返工" });
    await tool("ticket_action").execute("t", { ticket_id: id, action: "cancel", reason: "改走人工" });
    expect(getItem(db, id)!.stage).toBe("cancelled");
    expect(listActivities(db, id).map((a) => a.kind)).toContain("decision");
  });

  it("add_comment records lead comment", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    await tool("add_comment").execute("t", { ticket_id: id, content: "注意边界情况" });
    const acts = listActivities(db, id);
    expect(acts.some((a) => a.kind === "comment" && a.actor === "lead")).toBe(true);
  });

  it("refuses comments that simulate structured relations", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    await expect(tool("add_comment").execute("t", {
      ticket_id: id,
      content: "depends_on #42 because it blocks dispatch",
    })).rejects.toThrow(/link_tickets/);
  });

  it("links, reads, and revokes structured ticket relations", async () => {
    const designId = createItem(db, { title: "设计工单", brief: "design", createdBy: "lead" });
    const implementation = await tool("create_task").execute("t", {
      title: "实施工单",
      brief: "implement design",
      relations: [{
        target_ticket_id: designId,
        relation_type: "implements",
        reason: "implementation is based on the approved design",
      }],
    });
    expect(implementation.content[0].text).toMatch(/relations=#\d+:implements->#1/);

    let relations = await tool("get_ticket_relations").execute("t", { ticket_id: 2 });
    expect(relations.content[0].text).toContain('"relation_type": "implements"');
    expect(relations.content[0].text).toContain("implementation is based on the approved design");

    const duplicate = await tool("link_tickets").execute("t", {
      source_ticket_id: 2,
      target_ticket_id: designId,
      relation_type: "duplicates",
      reason: "same requested work; design is canonical",
    });
    expect(duplicate.content[0].text).toContain("canonical");
    expect(duplicate.content[0].text).toContain(`#${designId} is the canonical ticket`);
    relations = await tool("get_ticket_relations").execute("t", { ticket_id: 2 });
    const relationId = JSON.parse(relations.content[0].text).relations
      .find((relation: any) => relation.relation_type === "duplicates").relation_id;

    await tool("ticket_action").execute("t", {
      ticket_id: 2,
      action: "unlink",
      input: { relationId },
      reason: "not actually duplicate",
    });
    relations = await tool("get_ticket_relations").execute("t", { ticket_id: 2 });
    expect(relations.content[0].text).toContain('"revoked_at"');
    expect(relations.content[0].text).toContain("not actually duplicate");
  });

  it("create_task relations are atomic and surface high-impact risks", async () => {
    const canonical = createItem(db, { title: "Canonical", brief: "b", createdBy: "lead" });
    const duplicate = await tool("create_task").execute("t", {
      title: "Potential duplicate",
      brief: "same work",
      relations: [{
        target_ticket_id: canonical,
        relation_type: "duplicates",
        reason: "same request; existing ticket is canonical",
      }],
    });
    expect(duplicate.content[0].text).toContain("canonical 影响");
    expect(duplicate.content[0].text).toContain("风险：canonical");

    await expect(tool("create_task").execute("t", {
      title: "Bad relation source",
      brief: "will rollback",
      relations: [{
        target_ticket_id: 999,
        relation_type: "implements",
        reason: "missing target should rollback create",
      }],
    })).rejects.toThrow(/target item #999 not found/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Bad relation source'")
      .get()).toEqual({ n: 0 });
  });

  // 2026-10-28（用户：「不要啥都让我审批」）：问用户的决定 Lead 也能自己答；在用户本人这一轮里答的记成代用户做。
  // 2026-10-28 删掉了 resolve_decision_request：决定请求是 perform_action 的 decision resolve，同一个操作。
  it("perform_action answers a decision request of any audience itself, and for the user inside the user's own turn", async () => {
    const itemId = createItem(db, { title: "decision", brief: "b", createdBy: "lead" });
    const leadRequest = insertDecisionRequest(db, {
      itemId, kind: "question", audience: "lead_or_user", prompt: "先修哪个？", options: [], allowCustom: true,
    });
    const own = await tool("perform_action").execute("t", {
      target_type: "decision", target_id: String(leadRequest.id), action: "resolve",
      input: { decision: "respond", resolution: "先修登录" }, reason: "登录挡着别的工单",
    });
    expect(JSON.parse(own.content[0].text)).toMatchObject({ authority: "lead" });
    expect(db.prepare("SELECT resolved_by FROM decision_requests WHERE id=?").get(leadRequest.id)).toEqual({ resolved_by: "lead" });

    const alone = insertDecisionRequest(db, {
      itemId, kind: "question", audience: "user", prompt: "Changelog title?", options: [], allowCustom: true,
    });
    const answered = await tool("perform_action").execute("t", {
      target_type: "decision", target_id: String(alone.id), action: "resolve",
      input: { decision: "respond", resolution: "Fixes" }, reason: "用户以前的 changelog 都这样写",
    });
    expect(JSON.parse(answered.content[0].text)).toMatchObject({ authority: "lead" });
    expect(db.prepare("SELECT resolved_by FROM decision_requests WHERE id=?").get(alone.id)).toEqual({ resolved_by: "lead" });

    // 在用户这一轮开始以前就有（一分钟前）：用户说话时见过它。
    const userRequest = insertDecisionRequest(db, {
      itemId,
      kind: "question",
      audience: "user",
      prompt: "Release label?",
      options: [],
      allowCustom: true,
      now: new Date(Date.now() - 60_000),
    });

    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "用 v2.0", state: "streaming" });
    const relay = createLeadTools({ ...deps, currentTurnId: () => "turn-user" })
      .find((candidate: any) => candidate.name === "perform_action") as any;
    const relayed = await relay.execute("t", {
      target_type: "decision", target_id: String(userRequest.id), action: "resolve",
      input: { decision: "respond", resolution: "v2.0" }, reason: "用户说用 v2.0",
    });
    expect(JSON.parse(relayed.content[0].text)).toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-user" });
    expect(db.prepare("SELECT resolved_by FROM decision_requests WHERE id=?").get(userRequest.id))
      .toEqual({ resolved_by: "lead for user via turn:turn-user" });
  });
});

// 创建路径按参数集拆成两个工具（spec §8）。拆分的全部意义在最后两条断言里：
// "给提醒配执行预算"必须在 schema 层就说不出口，而不是运行时被拒。
describe("create_task / create_reminder", () => {
  it("create_reminder produces a scheduled reminder and nothing executable", async () => {
    const res = await tool("create_reminder").execute("t", {
      title: "三点开会", remind_at: "2026-08-01T07:00:00.000Z",
    });
    expect(res.content[0].text).toMatch(/#1/);
    const t = getItem(db, 1)!;
    expect(t.kind).toBe("reminder");
    expect(t.stage).toBe("scheduled");
    expect(t.remind_at).toBe("2026-08-01T07:00:00.000Z");
    expect(t.workdir).toBeNull();
    expect(t.token_budget).toBeNull();
    expect(t.purpose).toBeNull();
  });

  it("create_task with hold produces a draft that is not yet runnable", async () => {
    await tool("create_task").execute("t", { title: "重构 X", brief: "b", hold: true });
    const t = getItem(db, 1)!;
    expect(t.kind).toBe("task");
    expect(t.stage).toBe("draft");
    expect(t.created_by).toBe("lead");
  });

  // 诉求（defect 2）：#19、#38、#40 三张单子挂着同一个标题「Phase -1：复核审计计划…」，
  // 同一个树根 #18。#38 的 child 崩了三次（编排器的 retry 循环给了它三个 Run），lead 接着
  // create_task 又把同一件事从头建了一遍，成了 #40。Item 与 Run 是两条生命周期：一次崩掉的
  // 执行取的是**同一张 Item 上的新 Run**，永远不是新 Item。提示词管软纪律，这里管结构。
  describe("create_task refuses to rebuild an item that already exists", () => {
    const PHASE = "Phase -1：复核审计计划与当前 HEAD 的执行就绪状态";

    it("rejects a title duplicating a live sibling and points at spawn_child", async () => {
      await tool("create_task").execute("t", { title: "总工单", brief: "b" });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 1 });

      await expect(tool("create_task").execute("t", {
        title: PHASE, brief: "b", parent_ticket_id: 1,
      })).rejects.toThrow(/#2[\s\S]*spawn_child/);
      // 没有第三张单子被建出来。
      expect(getItem(db, 3)).toBeUndefined();
    });

    // 前缀/后缀的空白不该成为绕过它的办法——lead 复述标题时很容易多带一个空格。
    it("normalises whitespace before comparing", async () => {
      await tool("create_task").execute("t", { title: "总工单", brief: "b" });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 1 });
      await expect(tool("create_task").execute("t", {
        title: `  ${PHASE} `, brief: "b", parent_ticket_id: 1,
      })).rejects.toThrow(/spawn_child/);
    });

    // ——— 以下三条说明它为什么打不到正当的工作上 ———

    // 1. 已终结的同名单子不拦：那条线已经收摊，重开一张同名的正是合法用法。
    it("allows the same title once the earlier sibling is terminal", async () => {
      await tool("create_task").execute("t", { title: "总工单", brief: "b" });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 1 });
      transition(db, { itemId: 2, to: "cancelled", actor: "lead", reason: "换方案" });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 1 });
      expect(getItem(db, 3)!.title).toBe(PHASE);
    });

    // 2. 只在同一棵树内比较：另一棵迁移树里同样有 Phase -1，那是另一件工作。
    it("allows the same title under a different root", async () => {
      await tool("create_task").execute("t", { title: "总工单 A", brief: "b" });
      await tool("create_task").execute("t", { title: "总工单 B", brief: "b" });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 1 });
      await tool("create_task").execute("t", { title: PHASE, brief: "b", parent_ticket_id: 2 });
      expect(getItem(db, 4)!.root_item_id).toBe(2);
    });

    // 3. 根工单之间不比较：两个根各是自己的根，永远不是彼此的兄弟。
    //    「写周报」这种反复出现的独立任务因此一次都不会被拦。
    it("never fires between two root tasks", async () => {
      await tool("create_task").execute("t", { title: "写周报", brief: "b" });
      await tool("create_task").execute("t", { title: "写周报", brief: "b" });
      expect(getItem(db, 2)!.title).toBe("写周报");
    });
  });

  // 诉求（defect 3）：重试耗尽后 lead 必须看得见"到此为止"，而不是一次次重开。
  describe("exhausted retries are visible to lead and stop spawn_child", () => {
    const PI_EXIT = "Pi process exited before agent_end (1)";

    const burnBudget = (id: number) => {
      // retry_limit 缺省 1：首跑 + 1 次重试 = 2 次执行失败即耗尽。
      for (let n = 0; n < 2; n++) {
        transition(db, {
          itemId: id, to: "active", actor: "system", reason: "spawn",
        });
        const runId = createRun(db, { itemId: id });
        updateRun(db, runId, {
          state: "failed", endedAt: true, errorCode: "process_exit", errorMessage: PI_EXIT,
        });
        transition(db, { itemId: id, to: "blocked", actor: "system", reason: PI_EXIT });
      }
    };

    it("spawn_child refuses and tells lead to hand the decision back", async () => {
      await tool("create_task").execute("t", { title: "t", brief: "b" });
      burnBudget(1);
      await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 1 }))
        .rejects.toThrow(/重试已耗尽[\s\S]*用户/);
      expect(runningChildren().has(1)).toBe(false);
    });

    it("get_ticket shows the retry budget so lead can see it is spent", async () => {
      await tool("create_task").execute("t", { title: "t", brief: "b" });
      const before = await tool("get_ticket").execute("t", { id: 1 });
      expect(before.content[0].text).toMatch(/执行失败 0\/1/);

      burnBudget(1);
      const after = await tool("get_ticket").execute("t", { id: 1 });
      expect(after.content[0].text).toMatch(/执行失败 2\/1/);
      expect(after.content[0].text).toMatch(/重试已耗尽/);
    });

    it("turns an authenticated natural-language authorization into one bounded retry", async () => {
      await tool("create_task").execute("t", { title: "t", brief: "b" });
      burnBudget(1);
      db.prepare("UPDATE items SET plan_state='failed' WHERE id=1").run();
      const turn = createTurn(db, {
        id: "retry-authority-turn",
        originBindingId: pairedBinding(),
        originKind: "paired:companion",
        itemId: 1,
        userText: "允许 #1 再执行一次",
        state: "streaming",
      });
      deps.currentTurnId = () => turn.id;

      const first = await tool("authorize_retry").execute("authorize", {
        ticket_id: 1,
        additional_attempts: 1,
      });
      expect(JSON.parse(first.content[0].text)).toMatchObject({
        itemId: 1,
        failures: 2,
        previousRetryLimit: 1,
        retryLimit: 2,
        sourceTurnId: turn.id,
        deduplicated: false,
      });
      expect(getItem(db, 1)).toMatchObject({ retry_limit: 2, plan_state: "none", stage: "blocked" });

      const replay = await tool("authorize_retry").execute("authorize-replay", {
        ticket_id: 1,
        additional_attempts: 1,
      });
      expect(JSON.parse(replay.content[0].text)).toMatchObject({ retryLimit: 2, deduplicated: true });
      expect(getItem(db, 1)!.retry_limit).toBe(2);

      await tool("spawn_child").execute("spawn", { reason: "测试开跑", ticket_id: 1 });
      // fake-pi 经 tsx 启动，整套测试负载高时要一秒以上。默认 1 秒超时会把 child 留在模块级 running 表里，
      // 下一条用例在同号工单上 spawn_child 时报"已有 child 在运行"。
      await vi.waitFor(() => expect(runningChildren().has(1)).toBe(false), { timeout: 10_000 });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE item_id=1 AND purpose='execution'",
      ).get()).toEqual({ n: 3 });
      const authorization = listActivities(db, 1).find((activity) =>
        activity.actor === "user" && activity.kind === "decision" && activity.payload.includes("retry_authorized"));
      expect(authorization).toMatchObject({ session_cursor: turn.id });
    });

    it("rejects retry authorization without a current authenticated user turn", async () => {
      await tool("create_task").execute("t", { title: "t", brief: "b" });
      burnBudget(1);
      deps.currentTurnId = () => null;
      await expect(tool("authorize_retry").execute("missing-turn", {
        ticket_id: 1,
        additional_attempts: 1,
      })).rejects.toThrow(/current authenticated user turn/);

      const forged = createTurn(db, {
        id: "forged-retry-turn",
        originKind: "cli",
        userText: "retry",
        state: "streaming",
      });
      deps.currentTurnId = () => forged.id;
      await expect(tool("authorize_retry").execute("forged-turn", {
        ticket_id: 1,
        additional_attempts: 1,
      })).rejects.toThrow(/authenticated paired user turn/);
    });

    it("keeps retry authorization parameters structured and free of raw user text", () => {
      expect(toolParams("authorize_retry")).toEqual(["ticket_id", "additional_attempts"]);
    });
  });

  it("create_reminder has no parameter for execution config", () => {
    const params = toolParams("create_reminder");
    for (const forbidden of [
      "workdir", "runtime", "model", "budget", "token_budget", "parent_ticket_id",
    ]) {
      expect(params).not.toContain(forbidden);
    }
  });

  it("create_task has no remind_at parameter", () => {
    expect(toolParams("create_task")).not.toContain("remind_at");
  });

  it("drops create_ticket and set_ticket_schedule in favour of the split tools", () => {
    expect(toolNames()).not.toContain("create_ticket");
    expect(toolNames()).not.toContain("set_ticket_schedule");
  });

  // 诉求 1：提醒不是工作，不能出现在任务列表里。
  it("keeps reminders out of the task list", async () => {
    await tool("create_reminder").execute("t", {
      title: "交周报", remind_at: "2026-08-01T07:00:00.000Z",
    });
    await tool("create_task").execute("t", { title: "重构 X", brief: "b" });
    const tasks = await tool("list_items").execute("t", { view: "tasks" });
    expect(tasks.content[0].text).not.toContain("交周报");
    const reminders = await tool("list_items").execute("t", { view: "reminders" });
    expect(reminders.content[0].text).toContain("交周报");
    expect(reminders.content[0].text).not.toContain("重构 X");
  });
});

// spec §6.4 的 actor 矩阵必须在**工具表**上可见，而不只是在 stages.ts 里。
// 这些断言刻意检查"工具不存在 / 枚举值不存在"，不是"调用会抛错"：后者只证明这一次被挡住，
// 前者才是"lead 连提出这个请求的语法都没有"。
describe("lead tool surface honours the actor matrix", () => {
  // 诉求 3 的一半：建完先别跑，且 lead 无法代替用户确认。另一半（用户确认得了）在控制面测试。
  //
  // 这里断言的是 lead 的**缺省**权限面。confirm_item 现在存在，但它不在这张表里——
  // 它只在用户给过一条未撤销的授权时才被激活（test/lead-trust.test.ts）。
  // 缺省面必须保持空手：授权若成了缺省，"随时可撤"就没有意义了。
  // ticket_action 的 confirm 在缺省面上，但它只认当前已认证的用户轮次：确认的仍是用户这一轮说的话
  // （见下方 "a held draft the user asks to start in the current turn"）。
  it("gives lead no way to confirm a draft by default", () => {
    for (const forbidden of ["confirm_item", "unconfirm_item", "start_item"]) {
      expect(toolNames()).not.toContain(forbidden);
    }
  });

  // 诉求 4 的一半：暂停/恢复没有单独的工具，经 ticket_action 做。2026-10-28 起由 Lead 判断；读过外部内容的一轮里做不了。
  it("pauses a run through ticket_action, and not in a turn that read outside content", async () => {
    expect(toolNames()).not.toContain("pause_run");
    expect(toolNames()).not.toContain("resume_run");
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    deps.currentTurnId = () => null;
    deps.turnOrigin = () => ({ external: true, timer: null });
    // 2026-10-29 兜底授权卡：不再是死路，存下这个操作、给用户一张确认卡，什么都还没做。
    const refused = await tool("ticket_action").execute("t", { ticket_id: id, action: "pause_run", reason: "Slack 里说先停" });
    expect(refused).toMatchObject({ isError: true, details: { userAction: { kind: "confirm_rule_change" } } });
    expect(JSON.parse(refused.content[0].text).refusal.message).toMatch(/这一轮读过外部内容/);
    expect(getRun(db, runId)!.state).toBe("running");
    deps.turnOrigin = () => ({ external: false, timer: null });
    await tool("ticket_action").execute("t", { ticket_id: id, action: "pause_run", reason: "Run 卡住了，先停一下" });
    expect(getRun(db, runId)!.state).toBe("paused");
  });

  // ticket_action 的说明从操作定义生成：每个操作都列出来，不在工具里手写一份。
  it("lists every ticket action in the ticket_action description and schema", async () => {
    const { TICKET_ACTION_IDS } = await import("@pi-lead-child/protocol");
    expect(paramEnum("ticket_action", "action").sort()).toEqual([...TICKET_ACTION_IDS].sort());
    for (const id of TICKET_ACTION_IDS) expect(tool("ticket_action").description).toContain(`- ${id}（`);
    expect(toolParams("ticket_action")).toEqual(["ticket_id", "action", "input", "reason"]);
  });

  // 既有缺陷（本期关闭）：transition_ticket 以 actor='lead' 落笔，却在枚举里挂着
  // active/blocked/review/done，工具描述还承诺"验收通过→done"。矩阵里 lead 在 task 上
  // 只有 *→cancelled 这一条边（stages.ts 的 5 处 ["user","lead"] 全是 →cancelled），
  // 其余每一个取值传进去都必然被拒。让 schema 与矩阵一致的唯一写法是把这个工具删掉，
  // 由 cancel_item 承担那条唯一的边——留着它并"收紧到 blocked/review"仍然是在广告
  // 矩阵不给的权限。（2026-10-28 cancel_item 也删了，取消是 ticket_action 的 cancel。）
  it("removes transition_ticket", () => {
    expect(toolNames()).not.toContain("transition_ticket");
  });

  // 恢复是 user-only：Lead 可以解释如何恢复，但不能把普通对话伪装成用户控制面动作。
  it("does not expose restore as a Lead tool", () => {
    expect(toolNames()).not.toContain("restore_item");
    expect(toolNames()).not.toContain("restore_task_from_user_request");
  });

  // 审查 M6：删掉的工具名不能留在别的工具说明、提示词和 Lead 自带的 skill 里，否则 Lead 会去调一个不存在的工具。
  // 2026-10-28 删掉的 7 个和新入口重复的旧工具也在这里守着。
  it("names no removed tool in any tool description, the system prompt or Lead's own skills", async () => {
    const { LEAD_SYSTEM_PROMPT } = await import("../src/prompt.js");
    const { LEAD_SKILLS_DIR } = await import("../src/session.js");
    const { readdirSync, readFileSync } = await import("node:fs");
    const skills = readdirSync(LEAD_SKILLS_DIR).map((name) => readFileSync(`${LEAD_SKILLS_DIR}/${name}/SKILL.md`, "utf8"));
    const texts = [LEAD_SYSTEM_PROMPT, ...skills, ...createLeadTools(deps).map((t: any) => `${t.name}: ${t.description}`)];
    for (const gone of [
      "authorize_start", "open_pull_request", "accept_review", "request_rework", "cancel_item", "stop_child",
      "revoke_ticket_relation", "resolve_approval", "resolve_decision_request",
    ]) {
      expect(texts.filter((text) => text.includes(gone)).map((text) => text.slice(0, 40))).toEqual([]);
    }
  });

  // 停下 Run 是 ticket_action 的 stop_run（工单操作层，和页面的「停下」同一份实现）。旧的 stop_run 工具删掉了。
  it("lets lead cancel, ack and stop", () => {
    for (const name of ["ack_reminder", "ticket_action"]) {
      expect(toolNames()).toContain(name);
    }
    for (const gone of ["stop_run", "change_reviewer", "authorize_start", "open_pull_request", "cancel_item", "stop_child"]) {
      expect(toolNames()).not.toContain(gone);
    }
  });

  it("ticket_action cancels a task as lead", async () => {
    await tool("create_task").execute("t", { title: "t", brief: "b" });
    await tool("ticket_action").execute("t", { ticket_id: 1, action: "cancel", reason: "改走人工" });
    expect(getItem(db, 1)!.stage).toBe("cancelled");
  });

  // 以前 cancel_item 一律拒绝取消待验收（review）的工单。2026-10-28（用户：「工单操作让 Lead 自己判断」）起 Lead 自己判断，
  // 走 ticket_action 的 cancel；「终止所有任务」不等于丢弃已经交付的成果写在 skill ticket-planning 里。cancel_item 删掉了。
  // 提醒的「知道了」只属于用户（ui-action-parity P03）：acked 是终态，被事件叫醒的一轮不能替用户确认；用户这一轮里可以。
  it("ack_reminder closes a fired reminder in any turn, on the user's behalf in the user's own turn", async () => {
    await tool("create_reminder").execute("t", { title: "r", remind_at: "2026-08-01T07:00:00.000Z" });
    await tool("create_reminder").execute("t", { title: "r2", remind_at: "2026-08-01T07:00:00.000Z" });
    for (const itemId of [1, 2]) transition(db, { itemId, to: "fired", actor: "system", reason: "due", now: new Date(Date.now() - 60_000) });
    const woken = JSON.parse((await tool("ack_reminder").execute("t", { ticket_id: 1, reason: "提醒到点了，事情已经做完" })).content[0].text);
    expect(woken).toMatchObject({ authority: "lead" });
    expect(getItem(db, 1)!.stage).toBe("acked");
    createTurn(db, { id: "turn-ack", originBindingId: pairedBinding(), originKind: "paired:companion", userText: "交了", state: "streaming" });
    deps.currentTurnId = () => "turn-ack";
    const relayed = JSON.parse((await tool("ack_reminder").execute("t", { ticket_id: 2, reason: "用户说交了" })).content[0].text);
    expect(relayed).toMatchObject({ authority: "on_behalf" });
    expect(getItem(db, 2)!.stage).toBe("acked");
  });

  it("update_item edits attributes but never kind, stage or remind_at", async () => {
    await tool("create_task").execute("t", { title: "旧标题", brief: "b" });
    await tool("update_item").execute("t", { ticket_id: 1, title: "新标题", priority: "high" });
    expect(getItem(db, 1)!.title).toBe("新标题");
    expect(getItem(db, 1)!.priority).toBe("high");
    for (const forbidden of ["kind", "stage", "status", "remind_at"]) {
      expect(toolParams("update_item")).not.toContain(forbidden);
    }
  });

  it("reschedule_reminder is the only entry that moves remind_at", async () => {
    await tool("create_reminder").execute("t", { title: "r", remind_at: "2026-08-01T07:00:00.000Z" });
    await tool("reschedule_reminder").execute("t", {
      ticket_id: 1, remind_at: "2026-08-02T07:00:00.000Z", reason: "用户说改到明天",
    });
    expect(getItem(db, 1)!.remind_at).toBe("2026-08-02T07:00:00.000Z");
  });

  it("defer_item hides a task from the task list until its date", async () => {
    await tool("create_task").execute("t", { title: "以后再说", brief: "b" }); // → ready
    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    await tool("defer_item").execute("t", { ticket_id: 1, until: later });
    const tasks = await tool("list_items").execute("t", { view: "tasks" });
    expect(tasks.content[0].text).not.toContain("以后再说");
  });

  it("read_notifications surfaces what the user must be told", async () => {
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "该交周报了" });
    const res = await tool("read_notifications").execute("t", {});
    expect(res.content[0].text).toContain("该交周报了");
  });

  it("ticket_action stop_run stops a live run as lead without touching the item stage", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    deps.currentTurnId = () => null;
    await tool("ticket_action").execute("t", { ticket_id: id, action: "stop_run", input: { runId }, reason: "不需要了" });
    expect(getRun(db, runId)!.state).toBe("stopped");
    expect(getItem(db, id)!.stage).toBe("active");
    expect(listActivities(db, id).find((activity) => activity.kind === "decision")).toMatchObject({ actor: "lead" });
  });
});

// 诉求 3 的端到端形态：lead 把一个 task 建成 hold 之后，没有用户在当前轮次要求开工，用尽它拥有的一切也开不动它。
// 前面几条断言的是"工具不存在"，这一条断言的是"即使绕过工具表，闸门也拦得住"——
// 两层都要成立，因为将来会有人给 lead 加新工具。
describe("a task the lead held cannot be started by the lead", () => {
  it("leaves a held create_task in draft and refuses spawn_child until the user confirms", async () => {
    await tool("create_task").execute("t", { title: "重构 X", brief: "b", hold: true });
    expect(getItem(db, 1)!.stage).toBe("draft");

    // 唯一能开跑的工具是 spawn_child，而 Run 闸门只认 ready/active/blocked（spec §6.5）。
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 1 }))
      .rejects.toThrow(/工单还是草稿/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=1").get())
      .toEqual({ n: 0 });

    // 用户确认之后（这条边只有 user 有）才跑得起来。
    transition(db, { itemId: 1, to: "ready", actor: "user", reason: "confirmed" });
    await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 1 });
    await vi.waitFor(() => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=1").get())
        .toEqual({ n: 1 });
    }, { timeout: 5000 });
  });

  // 2026-10-28：确认开跑由 Lead 判断（「建完先别跑」写在工单说明里，Lead 遵守），store 不再挡 lead。
  it("lets the store confirm a held draft as lead", () => {
    createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
    transition(db, { itemId: 1, to: "ready", actor: "lead", reason: "x" });
    expect(getItem(db, 1)!.stage).toBe("ready");
  });
});

// 2026-10-19 线上（Lead 会话 019f7f53）：#100 是 hold 草稿，用户在对话里说「让 Claude code 针对 100
// 先出个方案吧」。spawn_child(#100) 被拒，Lead 没有能落库的确认路径，于是建了 #101 去跑——同一件事两张工单。
// 当时加了 authorize_start；2026-10-21 起它是 ticket_action 的 confirm（工单操作层，和页面的「确认开跑」同一份实现），
// 账本写「Lead 代你确认」：actor=lead、onBehalfOf=user、sourceTurnId 是这一轮。
describe("a held draft the user asks to start in the current turn", () => {
  const userTurn = (id = "start-turn") => createTurn(db, {
    id, originBindingId: pairedBinding(), originKind: "paired:companion",
    userText: "让 Claude code 针对 1 中我提出的问题先出个方案吧，但是先不要写代码", state: "streaming",
  });
  const confirm = () => tool("ticket_action").execute("t", { ticket_id: 1, action: "confirm", reason: "用户说先出个方案" });
  const itemCount = () => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  // running 是模块级的表：前面用例在同号工单上起的 child 收尾之前，spawn_child 会报"已有 child 在运行"。
  beforeEach(async () => { await Promise.allSettled([...runningChildren().values()]); });

  it("runs the original ticket instead of a duplicate", async () => {
    await tool("create_task").execute("t", { title: "入口分流方案", brief: "b", hold: true });
    const turn = userTurn();
    deps.currentTurnId = () => turn.id;

    // spawn_child 仍然被闸门拒绝，但报错给出两条路，并说不要另建工单。
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 1 }))
      .rejects.toThrow(/工单还是草稿[\s\S]*ticket_action\(ticket_id=1, action="confirm"\)[\s\S]*确认开跑[\s\S]*不要为同一件事另建工单/);

    const confirmed = JSON.parse((await confirm()).content[0].text);
    expect(confirmed).toMatchObject({
      ticket_id: 1, action: "confirm", authority: "on_behalf", on_behalf_of_turn: turn.id, result: { stage: "ready" },
    });
    await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 1 });
    await vi.waitFor(() => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=1").get()).toEqual({ n: 1 });
    }, { timeout: 5000 });
    await vi.waitFor(() => expect(runningChildren().has(1)).toBe(false), { timeout: 5000 });
    expect(itemCount()).toBe(1);
    const confirmation = listActivities(db, 1).find((activity) => activity.kind === "transition"
      && JSON.parse(activity.payload).to === "ready");
    expect(confirmation!.actor).toBe("lead");
    expect(JSON.parse(confirmation!.payload)).toMatchObject({ from: "draft", onBehalfOf: "user", sourceTurnId: turn.id });
  });

  it("names the draft root when a subtask under it is spawned", async () => {
    await tool("create_task").execute("t", { title: "总工单", brief: "b", hold: true });
    await tool("create_task").execute("t", { title: "Phase 1", brief: "b", parent_ticket_id: 1 });
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: 2 }))
      .rejects.toThrow(/树根 #1[\s\S]*ticket_action\(ticket_id=1, action="confirm"\)/);
  });

  // 2026-10-28：Lead 自己发起的一轮也能确认（账本写 Lead 自己做的）；读过外部内容的一轮里不能。
  it("confirms in a Lead-initiated turn as Lead, and not in a turn that read outside content", async () => {
    await tool("create_task").execute("t", { title: "t", brief: "b", hold: true });
    deps.currentTurnId = () => null;
    deps.turnOrigin = () => ({ external: true, timer: null });
    expect(await confirm()).toMatchObject({ isError: true, details: { userAction: { kind: "confirm_rule_change" } } });
    expect(getItem(db, 1)!.stage).toBe("draft");
    deps.turnOrigin = () => ({ external: false, timer: null });
    const heartbeat = createTurn(db, { id: "heartbeat", originKind: "system:heartbeat", userText: "", state: "streaming" });
    deps.currentTurnId = () => heartbeat.id;
    expect(JSON.parse((await confirm()).content[0].text)).toMatchObject({ authority: "lead", result: { stage: "ready" } });
  });

  it("keeps the request structured and free of raw user text", () => {
    expect(toolParams("ticket_action")).not.toContain("user_text");
    expect(toolParams("ticket_action")).not.toContain("quote");
  });
});

// 开 PR 推送分支，是对外发布的操作。2026-10-21 起它是 ticket_action 的 open_pr；2026-10-29 起 Lead 在哪一轮都能开，
// 读过外部内容的一轮（用户本人这一轮除外）不直接开，给用户一张确认卡，不碰仓库。
describe("ticket_action open_pr", () => {
  const openPr = () => tool("ticket_action").execute("t", { ticket_id: 1, action: "open_pr", reason: "run finished" });
  // 2026-10-28：开 PR 由 Lead 判断；读过外部内容的一轮里，在碰交付之前就被拒。
  it("refuses in a turn that read outside content, before it touches the delivery", async () => {
    await tool("create_task").execute("t", { title: "t", brief: "b" });
    deps.currentTurnId = () => null;
    deps.turnOrigin = () => ({ external: true, timer: null });
    expect(await openPr()).toMatchObject({ isError: true, details: { userAction: { kind: "confirm_rule_change" } } });
    deps.turnOrigin = () => ({ external: false, timer: null });
    // 用户这一轮：过了这道关，接着按交付的前提检查（这张工单直接改在用户的目录里，没有单独的分支）。
    const turn = createTurn(db, {
      id: "pr-turn", originBindingId: pairedBinding(), originKind: "paired:companion", userText: "开个 PR", state: "streaming",
    });
    deps.currentTurnId = () => turn.id;
    await expect(openPr()).rejects.toThrow("这张工单直接改在你的目录里，没有单独的分支要合并。");
  });
});

// spec §8 的 trigger 工具改名，以及 (C5) 在 schema 层的落点。
describe("trigger tools", () => {
  it("renames the schedule tools onto the trigger vocabulary", () => {
    for (const name of [
      "create_cron_trigger", "create_once_trigger", "list_triggers", "set_trigger_enabled",
    ]) {
      expect(toolNames()).toContain(name);
    }
    for (const gone of ["create_schedule", "list_schedules", "set_schedule_enabled"]) {
      expect(toolNames()).not.toContain(gone);
    }
  });

  // (C5)：会自动开跑的 trigger 只有 user 建得了。lead 建的 trigger created_by='lead'，
  // 所以这两个能力必须在 schema 层就不存在——否则 lead 能建一条 cron 规则，在零用户确认的
  // 情况下拿到运行中的 child，正是 §6.4 声称结构上不可能的事。执行器的降级兜底仍在，
  // 但那是第二道防线，不该是唯一一道。
  it("cannot express an auto-starting rule in either trigger tool", () => {
    for (const name of ["create_cron_trigger", "create_once_trigger"]) {
      const schema = JSON.stringify(tool(name).parameters);
      expect(schema).not.toContain("create_and_start");
      expect(schema).not.toContain("start_item");
      // 没有 initial_stage / spawn 这两个旋钮，lead 就说不出"到点直接开跑"。
      expect(toolParams(name)).not.toContain("initial_stage");
      expect(toolParams(name)).not.toContain("spawn");
    }
  });

  it("create_cron_trigger stores a lead-owned create_item rule", async () => {
    await tool("create_cron_trigger").execute("t", {
      label: "交周报", cron: "0 9 * * 1", kind: "reminder", title: "交周报",
    });
    const rows = listTriggers(db);
    expect(rows.length).toBe(1);
    expect(rows[0].created_by).toBe("lead");
    expect(rows[0].action_type).toBe("create_item");
    expect(JSON.parse(rows[0].action_payload).kind).toBe("reminder");
  });

  it("create_once_trigger schedules a one-shot task that still waits for confirmation", async () => {
    await tool("create_once_trigger").execute("t", {
      label: "明天建单", fire_at: "2026-08-01T07:00:00.000Z",
      kind: "task", title: "review PR", brief: "b",
    });
    const rows = listTriggers(db);
    expect(rows[0].source_type).toBe("once");
    expect(rows[0].action_type).toBe("create_item");
    expect(JSON.parse(rows[0].action_payload).initial_stage).toBe("draft");
  });

  it("does not let Lead re-enable an auto-start trigger", async () => {
    await tool("create_cron_trigger").execute("t", {
      label: "日报", cron: "0 1 * * *", kind: "reminder", title: "日报",
    });
    await tool("set_trigger_enabled").execute("t", { trigger_id: 1, enabled: false });
    await expect(tool("set_trigger_enabled").execute("t", {
      trigger_id: 1,
      enabled: true,
    })).rejects.toThrow(/user.*control|user-only|re-enable/i);
    expect(listTriggers(db)[0].enabled).toBe(0);
  });

  it("set_trigger_enabled toggles a rule and list_triggers shows it", async () => {
    await tool("create_cron_trigger").execute("t", {
      label: "日报", cron: "0 1 * * *", kind: "reminder", title: "日报",
    });
    await tool("set_trigger_enabled").execute("t", { trigger_id: 1, enabled: false });
    expect(listTriggers(db)[0].enabled).toBe(0);
    const list = await tool("list_triggers").execute("t", {});
    expect(list.content[0].text).toContain("日报");
  });

  it("exposes workspace lifecycle through the same authority action tools", async () => {
    const workdir = tempDir("plc-lead-workspace-action-");
    const itemId = createItem(db, { title: "workspace", brief: "b", createdBy: "user", workdir });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    const workspace = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: workdir, state: "active",
    });
    const released = JSON.parse((await tool("release_workspace").execute("release", {
      item_id: itemId, reason: "lead action test",
    })).content[0].text);
    expect(released).toMatchObject({
      target: { type: "workspace", id: String(workspace.id) }, authority: "lead",
      result: { action: "release", status: "released", workspace: { id: workspace.id } },
    });
    const cleaned = JSON.parse((await tool("cleanup_workspace").execute("cleanup", {
      item_id: itemId, reason: "lead action test",
    })).content[0].text);
    expect(cleaned).toMatchObject({ authority: "lead", result: { action: "cleanup", status: "cleaned", workspace: { state: "archived" } } });
  });

});
