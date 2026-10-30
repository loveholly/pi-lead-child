import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { buildChildPrompt, EXPRESSION_SECTION } from "@pi-lead-child/core";
import { openDb } from "@pi-lead-child/store";
import { addAcceptanceCriteria, createItem, createRun, getItem, recordExecutionPlan } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { liveChildren } from "../src/children/manager.js";
import { listInbox } from "@pi-lead-child/store";
import { assertRunAllowed } from "@pi-lead-child/store";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle } from "@pi-lead-child/runtime";
import { classifyFailure } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";

class FakeRuntime implements AgentRuntime {
  constructor(
    readonly id: RuntimeId,
    private readonly fail = false,
    private readonly failure = { code: "test_crash", message: "runtime crashed" },
  ) {}
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };

  async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
    const now = new Date().toISOString();
    const events: RuntimeEvent[] = [
      { type: "session.updated", runId: request.runId, seq: 1, occurredAt: now, externalSessionId: "thread-1", runtimeVersion: "test" },
      { type: "run.started", runId: request.runId, seq: 2, occurredAt: now, runtime: this.id, model: request.model ?? null },
      { type: "usage.updated", runId: request.runId, seq: 3, occurredAt: now, mode: "cumulative", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null },
      this.fail
        ? {
            type: "run.failed", runId: request.runId, seq: 4, occurredAt: now, exitCode: 1,
            errorCode: this.failure.code, error: this.failure.message,
            // 假 runtime 像真 adapter 一样给出类型：用同一个分类函数。
            failure: classifyFailure(this.id, { errorCode: this.failure.code, message: this.failure.message }),
          }
        : { type: "run.completed", runId: request.runId, seq: 4, occurredAt: now, exitCode: 0 },
    ];
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => this.fail ? ({
        ok: false, exitCode: 1, signal: null, externalSessionId: "thread-1",
        errorCode: this.failure.code, errorMessage: this.failure.message,
      }) : ({
        ok: true, exitCode: 0, signal: null, externalSessionId: "thread-1",
        errorCode: null, errorMessage: null,
      }),
    };
  }
}

class ReplayedTerminalRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };

  async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
    const now = new Date().toISOString();
    const events: RuntimeEvent[] = [
      {
        type: "run.started", runId: request.runId, seq: 1,
        occurredAt: now, runtime: this.id, model: null,
      },
      {
        type: "run.completed", runId: request.runId, seq: 2,
        occurredAt: now, exitCode: 0,
      },
      {
        type: "run.failed", runId: request.runId, seq: 2,
        occurredAt: now, exitCode: 1, errorCode: "stale_replay", error: "must be ignored",
        failure: { scope: "unknown", retry: "never", needs: "none", code: "unknown", evidence: "must be ignored" },
      },
    ];
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => ({
        ok: true, exitCode: 0, signal: null, externalSessionId: null,
        errorCode: null, errorMessage: null,
      }),
    };
  }
}

class ExplodingEventStreamRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };

  async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
    const now = new Date().toISOString();
    return {
      pid: null,
      events: (async function* () {
        yield {
          type: "run.started" as const,
          runId: request.runId,
          seq: 1,
          occurredAt: now,
          runtime: "codex" as const,
          model: null,
        };
        throw new Error("event stream decoder exploded");
      })(),
      interrupt: async () => {},
      wait: async () => ({
        ok: false, exitCode: null, signal: null, externalSessionId: null,
        errorCode: "stream_error", errorMessage: "event stream decoder exploded",
      }),
    };
  }
}

describe("generic child manager", () => {
  it.each(["pi", "codex", "claude"] as const)(
    "records deterministic run start lifecycle for %s",
    async (runtimeId) => {
    const dir = tempDir("plc-manager-runtime-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });

    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new FakeRuntime(runtimeId),
      model: "gpt-test",
      lingerMs: 0,
    });

    expect(getRun(db, result.runId)).toMatchObject({
      runtime: runtimeId,
      model: "gpt-test",
      external_session_id: "thread-1",
      runtime_version: "test",
      event_cursor: "4",
      state: "finished",
      cost_known: 0,
    });
    expect(getItem(db, itemId)).toMatchObject({ stage: "blocked", total_tokens: 15 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=?").get(result.runId) as any).n)
      .toBe(4);
    expect(db.prepare(
      "SELECT kind, idempotency_key FROM checkpoints WHERE run_id=? ORDER BY id",
    ).all(result.runId)).toEqual([
      { kind: "progress", idempotency_key: `run-start:${result.runId}` },
      { kind: "blocked", idempotency_key: `run-handoff-failed:${result.runId}` },
    ]);
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all()).toEqual([
      { event_type: "attempt.started" },
      { event_type: "ticket.updated" },
      { event_type: "attempt.updated" },
      { event_type: "ticket.updated" },
    ]);
    expect(getItem(db, itemId)?.first_run_at).toBeTruthy();
  });

  it.each(["pi", "codex", "claude"] as const)(
    "records one deterministic crash checkpoint for %s",
    async (runtimeId) => {
      const dir = tempDir("plc-manager-crash-");
      const dbPath = join(dir, "plc.db");
      const db = openDb(dbPath);
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });

      const result = await runItem(db, itemId, {
        dbPath,
        dataDir: dir,
        sessionDir: join(dir, "sessions", "item-1"),
        prompt: "do it",
        runtime: new FakeRuntime(runtimeId, true),
        lingerMs: 0,
      });

      expect(getRun(db, result.runId)?.state).toBe("failed");
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      expect(db.prepare(
        "SELECT kind, idempotency_key FROM checkpoints WHERE run_id=? ORDER BY id",
      ).all(result.runId)).toEqual([
        { kind: "progress", idempotency_key: `run-start:${result.runId}` },
        { kind: "blocked", idempotency_key: `run-crash:${result.runId}` },
      ]);
      expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all()).toEqual([
        { event_type: "attempt.started" },
        { event_type: "ticket.updated" },
        { event_type: "attempt.updated" },
        { event_type: "ticket.updated" },
      ]);
    },
  );

  // 「Run crashed」这张检查点是 leadVisible 的，它的 next_step 就是 lead 读到的下一步。
  // 重试预算用尽之后还写着 "retry"，等于指使 lead 去撞闸门——系统说停，卡片说再来一次。
  it("flips the crash checkpoint's next step once retries are exhausted", async () => {
    const dir = tempDir("plc-manager-exhausted-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const nextStepOf = (runId: number) => (db.prepare(
      "SELECT next_step FROM checkpoints WHERE run_id=? AND kind='blocked'",
    ).get(runId) as { next_step: string }).next_step;

    const run = async () => runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
      prompt: "do it", runtime: new FakeRuntime("pi", true), lingerMs: 0,
    });

    // retry_limit 缺省 1：首跑之后预算还在，下一步仍然是"再试一次"。
    const first = await run();
    expect(nextStepOf(first.runId)).toMatch(/retry/i);
    expect(getItem(db, itemId)?.plan_state).not.toBe("failed");

    // 第二次失败把预算用光：改口成"停了，交给用户"。
    const second = await run();
    expect(nextStepOf(second.runId)).toMatch(/exhausted \(2\/1\)/);
    expect(nextStepOf(second.runId)).toMatch(/Do not retry/);
    expect(getItem(db, itemId)?.plan_state).toBe("failed");

    // 而且真的跑不动了——闸门挡在每一条派发路径前面。
    await expect(run()).rejects.toThrow(/重试已耗尽/);
  });

  // 满载是 attempt 作用域（spec D1）：检查点只做说明，不再让 lead 调 recover_ticket_run。
  it("explains a provider capacity failure without asking Lead to recover it", async () => {
    const dir = tempDir("plc-manager-recovery-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new FakeRuntime("codex", true, {
        code: "codex_error",
        message: "Selected model is at capacity. Please try a different model.",
      }),
      lingerMs: 0,
    });

    // 工单 06：内核排了退避重试，工单没有受阻，所以这次失败的检查点是 progress，不是 blocked。
    const checkpoint = db.prepare(
      "SELECT next_step, key_facts FROM checkpoints WHERE run_id=? AND kind='progress' AND idempotency_key='run-crash:' || run_id",
    ).get(result.runId) as { next_step: string; key_facts: string };
    expect(checkpoint.next_step).not.toContain("recover_ticket_run");
    expect(checkpoint.next_step).toContain("瞬时失败");
    expect(checkpoint.next_step).toContain("自动重试");
    expect(JSON.parse(checkpoint.key_facts)).toEqual(expect.arrayContaining([
      { label: "Failure category", value: "model_capacity" },
      { label: "Failure scope", value: "attempt" },
    ]));
    expect(db.prepare(
      "SELECT json_extract(payload, '$.decision') AS decision, json_extract(payload, '$.category') AS category FROM activities WHERE run_id=? AND kind='decision'",
    ).all(result.runId)).toContainEqual({ decision: "runtime_failure_classified", category: "model_capacity" });
  });

  it("names the failing agent when authentication fails", async () => {
    const dir = tempDir("plc-manager-auth-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new FakeRuntime("claude", true, {
        code: "claude_success",
        message: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
      model: "claude-opus-5",
      lingerMs: 0,
    });

    expect(db.prepare(
      "SELECT title, summary, key_facts FROM checkpoints WHERE run_id=? AND kind='blocked'",
    ).get(result.runId)).toMatchObject({
      title: "Claude Code 认证失败",
      summary: expect.stringContaining("Claude Code · Run #"),
    });
    const keyFacts = JSON.parse((db.prepare(
      "SELECT key_facts FROM checkpoints WHERE run_id=? AND kind='blocked'",
    ).get(result.runId) as { key_facts: string }).key_facts);
    expect(keyFacts).toEqual(expect.arrayContaining([
      { label: "Agent", value: "Claude Code" },
      { label: "Runtime", value: "claude" },
      { label: "Model", value: "claude-opus-5" },
      { label: "Failure category", value: "authentication" },
    ]));
  });

  it("falls back to core failure state when crash checkpoint projection fails", async () => {
    const dir = tempDir("plc-manager-crash-rollback-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    db.exec(`
      CREATE TRIGGER fail_crash_outbox
      BEFORE INSERT ON gateway_events
      WHEN NEW.event_type = 'attempt.updated'
      BEGIN
        SELECT RAISE(FAIL, 'crash outbox unavailable');
      END;
    `);

    await expect(runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new FakeRuntime("codex", true),
      lingerMs: 0,
    })).rejects.toThrow(/crash outbox unavailable/i);
    const run = db.prepare("SELECT * FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1")
      .get(itemId) as any;
    expect(run).toMatchObject({
      state: "failed",
      exit_code: null,
      error_code: "unhandled_run_exception",
    });
    expect(run.error_message).toMatch(/crash outbox unavailable/i);
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(db.prepare("SELECT idempotency_key FROM checkpoints ORDER BY id").all()).toEqual([
      { idempotency_key: `run-start:${run.id}` },
    ]);
    expect(listInbox(db, { severity: "blocker" })).toEqual([
      expect.objectContaining({
        item_id: itemId,
        summary: expect.stringContaining("未捕获异常"),
      }),
    ]);
    expect(liveChildren().has(itemId)).toBe(false);
  });

  it("catches an unexpected runtime stream exception and alerts lead", async () => {
    const dir = tempDir("plc-manager-boundary-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });

    await expect(runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new ExplodingEventStreamRuntime(),
      lingerMs: 0,
    })).rejects.toThrow(/event stream decoder exploded/);

    const run = db.prepare("SELECT * FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1")
      .get(itemId) as any;
    expect(run).toMatchObject({
      state: "failed",
      error_code: "unhandled_run_exception",
    });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(db.prepare(
      "SELECT title FROM checkpoints WHERE idempotency_key=?",
    ).get(`run-crash:${run.id}`)).toEqual({ title: "Agent Run 未捕获异常" });
    const blockers = listInbox(db, { severity: "blocker" });
    expect(blockers).toHaveLength(1);
    expect(JSON.parse(blockers[0]!.payload)).toMatchObject({
      kind: "unhandled_run_exception",
      runId: run.id,
      detail: expect.stringContaining("event stream decoder exploded"),
    });
    expect(liveChildren().has(itemId)).toBe(false);
  });

  it("gives Pi, Codex, and Claude the same checkpoint discipline with positive and negative examples", () => {
    const prompt = buildChildPrompt({ id: 1, title: "t", brief: "b", body: "" } as any);
    expect(prompt).toContain("Pi, Codex, Claude");
    expect(prompt).toContain("submit_checkpoint");
    expect(prompt).toContain("request_decision");
    expect(prompt).toContain("request_approval");
    // 工具签名对 agent 是冻结契约，submit_checkpoint 只认 related_ticket_ids
    // （agent-tools/definitions.ts:93 的 schema + 303 的 assertKeys 白名单），
    // 所以提示词里也必须是这个键，不随内部改名走。
    expect(prompt).toContain("related_ticket_ids");
    expect(prompt).toContain("progress={current,total,label}");
    // 执行计划（工单 06）：三个 runtime 用同一个 update_plan；proof_items 并进计划（D2），验证结果只走 outcome.validations。
    expect(prompt).not.toContain("proof_items");
    expect(prompt).toContain("update_ticket_plan");
    expect(prompt).not.toMatch(/\bupdate_plan\b/);
    expect(prompt).toContain("pending、in_progress、done、skipped、blocked");
    expect(prompt).toContain("返工");
    expect(prompt).toContain("验收标准");
    expect(prompt).toContain("outcome.validations");
    expect(prompt).toContain("relative_path");
    expect(prompt).toContain("Positive example");
    expect(prompt).toContain("Negative example");
    expect(prompt).toContain("ticket_update(status='review', checkpoint={kind:'completed'");
  });

  // 2026-10-19：新会话的第一条提示带上「表达」一节（代替 STE 文风规则）。续接的会话里已经有它，再发一次只是浪费 token。
  it("appends the expression section to the first prompt of a new session only", async () => {
    const dir = tempDir("plc-manager-style-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const prompts: { prompt: string; resumeSessionId?: string }[] = [];
    class RecordingRuntime extends FakeRuntime {
      override async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
        prompts.push({ prompt: request.prompt, resumeSessionId: request.resumeSessionId });
        return super.start(request);
      }
    }
    const common = { dbPath, dataDir: dir, runtime: new RecordingRuntime("codex"), lingerMs: 0 };
    const fresh = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    await runItem(db, fresh, { ...common, sessionDir: join(dir, "sessions", "fresh"), prompt: "do it" });
    const resumed = createItem(db, { title: "t2", brief: "b", createdBy: "system" });
    await runItem(db, resumed, { ...common, sessionDir: join(dir, "sessions", "resumed"), prompt: "go on", resumeSessionId: "thread-1" });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.prompt).toBe(`do it\n\n${EXPRESSION_SECTION}`);
    expect(prompts[1]).toEqual({ prompt: "go on", resumeSessionId: "thread-1" });
  });

  // 审查 H1（工单 06）：执行 Run 开新会话、不续接时（换 runtime 的恢复、不续接的派发、直接启动），agent 不记得计划。
  // 所以每一次执行者启动都在提示里带上现在的计划。核查员不带：它对照验收标准，不对照计划（spec 5.2，审查 L1）。
  it("puts the current plan into every executor start, and not into a reviewer start", async () => {
    const dir = tempDir("plc-manager-plan-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const prompts: Array<{ role: string; prompt: string }> = [];
    class RecordingRuntime extends FakeRuntime {
      override async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
        prompts.push({ role: request.role, prompt: request.prompt });
        return super.start(request);
      }
    }
    const itemId = createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
    const earlier = createRun(db, { itemId, runtime: "codex" });
    recordExecutionPlan(db, {
      itemId, runId: earlier,
      steps: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "in_progress", note: "先补测试" },
      ],
    });
    const common = { dbPath, dataDir: dir, runtime: new RecordingRuntime("claude"), lingerMs: 0 };
    await runItem(db, itemId, { ...common, sessionDir: join(dir, "sessions", "executor"), prompt: "do it" });
    // 假 runtime 没有交付，执行 Run 结束后工单是 blocked。核查 Run 只能开在 review 阶段的工单上。
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(itemId);
    await runItem(db, itemId, { ...common, sessionDir: join(dir, "sessions", "reviewer"), prompt: "review it", role: "reviewer" });

    expect(prompts.map((entry) => entry.role)).toEqual(["executor", "reviewer"]);
    expect(prompts[0]!.prompt).toContain("## 执行计划");
    expect(prompts[0]!.prompt).toContain('- [done] read："读现有的解析器"');
    expect(prompts[0]!.prompt).toContain('- [in_progress] fix："修复空输入"（备注："先补测试"）');
    expect(prompts[1]!.prompt).not.toContain("执行计划");
    expect(prompts[1]!.prompt).not.toContain("读现有的解析器");
  });

  // 工单 05（spec 5.1、D6）：执行者每次启动，提示里都有逐条编号的验收标准（启动那一刻的版本），以及有异议时用
  // request_decision 提出、不能自己改。核查员的逐条核查包是工单 10 的事，这里不带。
  it("numbers the acceptance criteria in every executor start", async () => {
    const dir = tempDir("plc-manager-criteria-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const prompts: Array<{ role: string; prompt: string }> = [];
    class RecordingRuntime extends FakeRuntime {
      override async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
        prompts.push({ role: request.role, prompt: request.prompt });
        return super.start(request);
      }
    }
    const itemId = createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
    const [first, second] = addAcceptanceCriteria(db, { itemId, texts: ["空输入返回 400", "错误信息写明字段名"], by: "lead" });
    const common = { dbPath, dataDir: dir, runtime: new RecordingRuntime("claude"), lingerMs: 0 };
    await runItem(db, itemId, { ...common, sessionDir: join(dir, "sessions", "executor"), prompt: "do it" });
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(itemId);
    await runItem(db, itemId, { ...common, sessionDir: join(dir, "sessions", "reviewer"), prompt: "review it", role: "reviewer" });

    expect(prompts.map((entry) => entry.role)).toEqual(["executor", "reviewer"]);
    expect(prompts[0]!.prompt).toContain("## 验收标准（系统记录，逐条编号）");
    expect(prompts[0]!.prompt).toContain(`1. （id ${first!.id}）"空输入返回 400"`);
    expect(prompts[0]!.prompt).toContain(`2. （id ${second!.id}）"错误信息写明字段名"`);
    expect(prompts[0]!.prompt).toContain("request_decision");
    // 核查员不带执行者的这一节：它看的是核查包（工单 10），标准在里面，带着它看到的版本。
    expect(prompts[1]!.prompt).not.toContain("## 验收标准（系统记录，逐条编号）");
    expect(prompts[1]!.prompt).toContain("## 核查包（系统拼好的，没有经过任何模型）");
    expect(prompts[1]!.prompt).toContain(`1. （id ${first!.id}，第 1 版）"空输入返回 400"`);
  });

  // 复核 P1-10：#66 的成果摘要、检查说明和证据都是英文，因为提示词里的正例全是英文。
  it("asks for the user-facing text in Chinese and keeps commands and paths as they are", () => {
    const prompt = buildChildPrompt({ id: 1, title: "t", brief: "b", body: "" } as any);
    expect(prompt).toContain("写给用户看的文字用中文");
    expect(prompt).toContain("命令、文件路径、代码标识符和报错原文保持原样");
    expect(prompt).toContain("outcome:{summary:'实现了最终协议。'");
    expect(prompt).not.toMatch(/title:'(?:Implementation complete|Regression suite passes|Protocol verified)'/);
  });

  it("ignores a stale terminal event replay instead of creating contradictory crash state", async () => {
    const dir = tempDir("plc-manager-replay-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });

    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      runtime: new ReplayedTerminalRuntime(),
      lingerMs: 0,
    });

    expect(getRun(db, result.runId)).toMatchObject({
      state: "finished",
      error_code: null,
      error_message: null,
    });
    expect(db.prepare(
      "SELECT kind, idempotency_key FROM checkpoints WHERE run_id=? ORDER BY id",
    ).all(result.runId)).toEqual([
      { kind: "progress", idempotency_key: `run-start:${result.runId}` },
      { kind: "blocked", idempotency_key: `run-handoff-failed:${result.runId}` },
    ]);
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=?",
    ).get(result.runId) as any).n).toBe(2);
  });

  it("does not register a text-only envelope on the live path without a ticket_update attempt", async () => {
    const dir = tempDir("plc-manager-text-only-envelope-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const envelope = `PLC_OUTCOME_V1 ${JSON.stringify({
      summary: "Looked finished",
      changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
      deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
      validations: [{
        command: "npm test",
        outcome: "skipped",
        exitCode: 0,
        summary: "ok",
        evidenceRef: null,
      }],
    })}`;

    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      lingerMs: 0,
      runtime: {
        id: "claude",
        capabilities: {
          streaming: true, steering: false, resume: true, interrupt: true,
          approvals: true, mcp: true, executableReadOnlyReview: true,
        },
        async start(request) {
          const now = new Date().toISOString();
          const events: RuntimeEvent[] = [
            { type: "session.updated", runId: request.runId, seq: 1, occurredAt: now, externalSessionId: "thread-1", runtimeVersion: "test" },
            { type: "run.started", runId: request.runId, seq: 2, occurredAt: now, runtime: "claude", model: request.model ?? null },
            {
              type: "message.completed",
              runId: request.runId,
              seq: 3,
              occurredAt: now,
              messageId: "m-1",
              role: "assistant",
              text: envelope,
              stopReason: "stop",
            },
            { type: "run.completed", runId: request.runId, seq: 4, occurredAt: now, exitCode: 0 },
          ];
          return {
            pid: null,
            events: (async function* () { yield* events; })(),
            interrupt: async () => {},
            wait: async () => ({
              ok: true, exitCode: 0, signal: null, externalSessionId: "thread-1",
              errorCode: null, errorMessage: null,
            }),
          };
        },
      },
    });

    expect(getRun(db, result.runId)).toMatchObject({
      state: "finished",
      error_code: null,
    });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(db.prepare(
      "SELECT idempotency_key FROM checkpoints WHERE run_id=? AND kind='blocked'",
    ).get(result.runId)).toEqual({
      idempotency_key: `run-handoff-failed:${result.runId}`,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
  });

  // 工单 07 起，未知的枚举值只降级不作废。仍然作废信封的是 summary 缺失或无效，所以样本用空 summary。
  it("keeps a finished Claude run finished when a ticket_update backup envelope is illegal", async () => {
    const dir = tempDir("plc-manager-invalid-envelope-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const envelope = `PLC_OUTCOME_V1 ${JSON.stringify({
      summary: "",
      changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
      deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
      validations: [{
        command: "npm test",
        outcome: "passed",
        exitCode: 0,
        summary: "ok",
        evidenceRef: null,
      }],
    })}`;

    const result = await runItem(db, itemId, {
      dbPath,
      dataDir: dir,
      sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it",
      lingerMs: 0,
      runtime: {
        id: "claude",
        capabilities: {
          streaming: true, steering: false, resume: true, interrupt: true,
          approvals: true, mcp: true, executableReadOnlyReview: true,
        },
        async start(request) {
          const now = new Date().toISOString();
          const events: RuntimeEvent[] = [
            { type: "session.updated", runId: request.runId, seq: 1, occurredAt: now, externalSessionId: "thread-1", runtimeVersion: "test" },
            { type: "run.started", runId: request.runId, seq: 2, occurredAt: now, runtime: "claude", model: request.model ?? null },
            {
              type: "tool.started",
              runId: request.runId,
              seq: 3,
              occurredAt: now,
              callId: "tu-1",
              name: "mcp__plc__ticket_update",
              args: { status: "review" },
            },
            {
              type: "tool.failed",
              runId: request.runId,
              seq: 4,
              occurredAt: now,
              callId: "tu-1",
              name: "mcp__plc__ticket_update",
              error: "lost receipt",
            },
            {
              type: "message.completed",
              runId: request.runId,
              seq: 5,
              occurredAt: now,
              messageId: "m-1",
              role: "assistant",
              text: envelope,
              stopReason: "stop",
            },
            { type: "run.completed", runId: request.runId, seq: 6, occurredAt: now, exitCode: 0 },
          ];
          return {
            pid: null,
            events: (async function* () { yield* events; })(),
            interrupt: async () => {},
            wait: async () => ({
              ok: true, exitCode: 0, signal: null, externalSessionId: "thread-1",
              errorCode: null, errorMessage: null,
            }),
          };
        },
      },
    });

    expect(getRun(db, result.runId)).toMatchObject({
      state: "finished",
      error_code: null,
    });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(db.prepare(
      "SELECT title, idempotency_key FROM checkpoints WHERE run_id=? AND kind='blocked'",
    ).get(result.runId)).toEqual({
      title: "成果登记失败",
      idempotency_key: `invalid-outcome-envelope:${result.runId}`,
    });
    expect(JSON.parse((listInbox(db, { severity: "blocker" })[0] as { payload: string }).payload)).toMatchObject({
      kind: "invalid_outcome_envelope",
      intervention: "propose",
    });
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .toThrow(/成果登记失败[\s\S]*同一宿主缺陷/);
  });
});
