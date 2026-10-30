import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, recoverTicketRun } from "@pi-lead-child/engine";
import { executorRetryBudget } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { failureRecovery } from "@pi-lead-child/runtime";
import { classifyFailure, typedFailure } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";

let db: Db;

function runtimeStatus() {
  return { model: "stub", sessionId: "stub", busy: false, runningItemIds: [], aish: null };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function failedItem(options: {
  runtime?: "codex" | "claude" | "pi";
  model?: string;
  retryLimit?: number;
  errorCode?: string;
  errorMessage?: string;
} = {}) {
  const itemId = createItem(db, {
    title: "runtime recovery",
    brief: "recover the same ticket after an infrastructure failure",
    createdBy: "system",
    runtime: options.runtime ?? "codex",
    model: options.model,
    retryLimit: options.retryLimit,
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, {
    itemId,
    runtime: options.runtime ?? "codex",
    model: options.model ?? "gpt-5.5",
  });
  updateRun(db, runId, {
    state: "failed",
    endedAt: true,
    externalSessionId: "source-session",
    errorCode: options.errorCode ?? "codex_error",
    errorMessage: options.errorMessage ?? "Selected model is at capacity. Please try a different model.",
  });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "runtime failed", runId });
  grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 1 });
  return { itemId, runId };
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-runtime-recovery-"), "plc.db"));
});

// 没有类型的旧 Run 走内核的兜底分类器，recover_ticket_run 从它的结果推出能不能换模型或换 runtime。
const legacyRecovery = (runtime: RuntimeId, errorCode: string, message: string) =>
  failureRecovery(classifyFailure(runtime, { errorCode, message }));

describe("runtime failure classification", () => {
  it("classifies provider capacity and authentication without parsing user instructions", () => {
    expect(legacyRecovery("codex", "codex_error", "Selected model is at capacity. Please try a different model."))
      .toMatchObject({
        category: "model_capacity",
        recoverable: true,
        sameRuntimeModelFallback: true,
        nextRuntimeFallback: true,
      });
    expect(legacyRecovery("claude", "claude_success", "Failed to authenticate: OAuth session expired"))
      .toMatchObject({ category: "authentication", recoverable: true, nextRuntimeFallback: true });
    // 没有证据说明 agent 做了任务却失败，所以是 unknown，不是 task。两者都交给用户决定。
    expect(legacyRecovery("codex", "process_exit", "tests failed"))
      .toMatchObject({ category: "unknown", recoverable: false });
    expect(legacyRecovery("pi", "process_exit", "TypeError: zlib.createZstdDecompress is not a function at undici"))
      .toMatchObject({
        category: "runtime_configuration", recoverable: true,
        sameRuntimeModelFallback: false, nextRuntimeFallback: true,
      });
    expect(legacyRecovery(
      "claude", "unhandled_run_exception",
      "Error: outcome.validations[4].outcome is invalid\n    at normalizeValidations",
    )).toMatchObject({
      category: "host_defect",
      recoverable: false,
      sameRuntimeModelFallback: false,
      nextRuntimeFallback: false,
    });
  });
});

describe("ticket runtime recovery", () => {
  it("queues a same-runtime model fallback and resumes the source session", () => {
    const { itemId, runId } = failedItem();
    const result = recoverTicketRun(db, {
      itemId,
      failedRunId: runId,
      action: "next_model",
      model: "gpt-5.4",
      authorityRef: "review_failure:run-42",
    });

    expect(result).toMatchObject({
      status: "queued",
      runtime: "codex",
      model: "gpt-5.4",
      resumedFromRunId: runId,
      category: "model_capacity",
    });
    expect(db.prepare(
      "SELECT runtime, model, resume_from_run_id, trigger FROM dispatch_requests WHERE item_id=?",
    ).get(itemId)).toEqual({
      runtime: "codex",
      model: "gpt-5.4",
      resume_from_run_id: runId,
      trigger: "runtime-recovery",
    });
    expect(db.prepare("SELECT requested_runtime, requested_model FROM items WHERE id=?").get(itemId))
      .toEqual({ requested_runtime: "codex", requested_model: "gpt-5.4" });
    expect(createControlPlaneService(db, { runtime: runtimeStatus }).getItem(itemId)?.ticket.executionState)
      .toMatchObject({ kind: "recovery", state: "waiting_dispatch", label: "正在恢复 · 等待 agent", reason: expect.stringContaining("capacity") });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='runtime_recovery_queued'`,
    ).get(itemId)).toEqual({ n: 1 });
  });

  it("switches runtime after a recoverable failure without crossing native sessions", () => {
    const { itemId, runId } = failedItem();
    const result = recoverTicketRun(db, {
      itemId,
      failedRunId: runId,
      action: "switch_runtime",
      runtime: "claude",
      authorityRef: "runtime-recovery:capacity",
    });

    expect(result).toMatchObject({ status: "queued", runtime: "claude", model: null, resumedFromRunId: null });
    expect(db.prepare("SELECT runtime, model, resume_from_run_id FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ runtime: "claude", model: null, resume_from_run_id: null });
  });

  it("uses configured candidates for auto mode, is idempotent, and stops after bounded steps", () => {
    vi.stubEnv("PLC_CODEX_FALLBACK_MODELS", "gpt-5.4");
    const { itemId, runId } = failedItem();
    const first = recoverTicketRun(db, {
      itemId,
      failedRunId: runId,
      action: "auto",
      authorityRef: "auto-recovery:test",
    });
    const replay = recoverTicketRun(db, {
      itemId,
      failedRunId: runId,
      action: "auto",
      authorityRef: "auto-recovery:test",
    });

    expect(first.status).toBe("queued");
    expect(replay.status).toBe("already_queued");
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ n: 1 });
  });

  it("does not consume business retry budget for infrastructure failures", () => {
    const { itemId } = failedItem({ retryLimit: 0 });
    expect(executorRetryBudget(db, itemId)).toMatchObject({ failures: 0, retryLimit: 0, exhausted: false });
  });

  // 2026-10-15 用户决定：能力要通用，判断交给 Lead。代码只限制机密、安全和 token 滥用。
  // 以前任务失败、未知失败和宿主缺陷一律 needs_user；现在 Lead 可以带着新的指令重试，
  // token 的上限还在：执行的重试额度在派发时照样生效，每条失败链最多恢复 3 次。
  it("lets Lead retry a task failure or a host defect, and keeps the executor retry budget at dispatch", () => {
    const taskFailure = failedItem({ errorCode: "process_exit", errorMessage: "tests failed", retryLimit: 1 });
    expect(recoverTicketRun(db, {
      itemId: taskFailure.itemId, failedRunId: taskFailure.runId, action: "retry",
      instruction: "先修复失败的测试，再交付。", authorityRef: "lead:task-retry",
    })).toMatchObject({ status: "queued", runtime: "codex", model: "gpt-5.5", category: "unknown" });
    const request = db.prepare("SELECT runtime, model, instruction FROM dispatch_requests WHERE item_id=?")
      .get(taskFailure.itemId) as { runtime: string; model: string; instruction: string };
    expect(request).toMatchObject({ runtime: "codex", model: "gpt-5.5" });
    expect(request.instruction).toContain("先修复失败的测试，再交付。");

    const hostDefect = failedItem({
      runtime: "claude",
      errorCode: "unhandled_run_exception",
      errorMessage: "Error: outcome.validations[3].outcome is invalid",
    });
    expect(recoverTicketRun(db, {
      itemId: hostDefect.itemId, failedRunId: hostDefect.runId, action: "switch_runtime", runtime: "codex",
      authorityRef: "lead:host-defect",
    })).toMatchObject({ status: "queued", runtime: "codex", category: "host_defect" });

    // 额度用完的工单：恢复照样能排，派发器认领时作废它，不会多跑一次。
    const exhausted = failedItem({ errorCode: "process_exit", errorMessage: "tests failed", retryLimit: 0 });
    db.prepare("UPDATE runs SET error_code='process_exit' WHERE id=?").run(exhausted.runId);
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(exhausted.itemId);
    recoverTicketRun(db, { itemId: exhausted.itemId, failedRunId: exhausted.runId, action: "retry", authorityRef: "lead:test" });
    expect(executorRetryBudget(db, exhausted.itemId).exhausted).toBe(true);
    const dispatcher = createDispatcher(db);
    for (let claims = 0; claims < 5 && dispatcher.claimNext(); claims++) { /* 认领前面两张工单的请求 */ }
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=?").get(exhausted.itemId)).toEqual({ state: "cancelled" });
  });

  it("restarts a stopped run on the same runtime and model, and stops after three recoveries in one chain", () => {
    const { itemId, runId } = failedItem({ retryLimit: 10 });
    db.prepare("UPDATE runs SET state='stopped' WHERE id=?").run(runId);
    expect(recoverTicketRun(db, { itemId, failedRunId: runId, action: "retry", authorityRef: "lead:stuck" }))
      .toMatchObject({ status: "queued", runtime: "codex", model: "gpt-5.5" });
    // 同一条失败链：再失败两次，各恢复一次；第四次超出预算，交给用户。
    let last = runId;
    for (let step = 0; step < 3; step++) {
      const next = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5" });
      updateRun(db, next, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "stuck again" });
      db.prepare("UPDATE dispatch_requests SET state='completed'").run();
      last = next;
      const result = recoverTicketRun(db, { itemId, failedRunId: last, action: "retry", authorityRef: "lead:stuck" });
      expect(result.status).toBe(step < 2 ? "queued" : "needs_user");
    }
  });

  it("refuses a finished run and a run that is still going", () => {
    const { itemId, runId } = failedItem();
    db.prepare("UPDATE runs SET state='finished', error_code=NULL WHERE id=?").run(runId);
    expect(() => recoverTicketRun(db, { itemId, failedRunId: runId, action: "retry", authorityRef: "lead:test" }))
      .toThrow(/finished/);
    const running = createRun(db, { itemId, runtime: "codex" });
    expect(() => recoverTicketRun(db, { itemId, failedRunId: running, action: "retry", authorityRef: "lead:test" }))
      .toThrow(/stop it first/);
  });

  // 2026-10-15 用户决定：Lead 能处理的自己处理。换模型或换 runtime 不改任务、验收和返工额度，所以不再要求委托授权。
  it("recovers without a delegation policy and records who decided", () => {
    const noAuthority = failedItem();
    db.prepare("DELETE FROM delegation_policies WHERE item_id=?").run(noAuthority.itemId);
    expect(recoverTicketRun(db, {
      itemId: noAuthority.itemId,
      failedRunId: noAuthority.runId,
      action: "switch_runtime",
      runtime: "claude",
      authorityRef: "lead:self-heal",
    })).toMatchObject({ status: "queued", runtime: "claude" });
    expect(db.prepare(
      `SELECT actor, json_extract(payload, '$.authorityRef') AS authority FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='runtime_recovery_queued'`,
    ).get(noAuthority.itemId)).toEqual({ actor: "lead", authority: "lead:self-heal" });
  });

  // 回归（工单 #66）：以前 recover_ticket_run 只接受执行 Run，Codex 拒绝 gpt-5.5 的核查就没有办法换模型。
  it("recovers a failed review as a review on its own session and leaves the executor's choice alone", () => {
    const itemId = createItem(db, { title: "review recovery", brief: "b", createdBy: "system", runtime: "claude", model: "opus" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-5.5" });
    updateRun(db, reviewer, {
      state: "failed", endedAt: true, externalSessionId: "review-session", errorCode: "codex_error",
      errorMessage: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      failure: typedFailure("model_unsupported", { errorCode: "codex_error", message: "model is not supported" }),
    });

    expect(recoverTicketRun(db, {
      itemId, failedRunId: reviewer, action: "next_model", model: "gpt-6.1-sol", authorityRef: "lead:self-heal",
    })).toMatchObject({ status: "queued", runtime: "codex", model: "gpt-6.1-sol", resumedFromRunId: reviewer });
    expect(db.prepare("SELECT role, purpose, runtime, model, resume_from_run_id FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-6.1-sol", resume_from_run_id: reviewer });
    // 执行者的 runtime 和模型不变。
    expect(db.prepare("SELECT requested_runtime, requested_model FROM items WHERE id=?").get(itemId))
      .toEqual({ requested_runtime: "claude", requested_model: "opus" });
  });

  it("passes Lead's instruction to a recovered review, and keeps the review read-only", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "system", runtime: "claude" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-5.5" });
    updateRun(db, reviewer, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "stream disconnected" });

    // 2026-10-20：任何 runtime 都能接核查（以前 claude 在这里被拒）。恢复以后仍是只读、独立的核查。
    expect(recoverTicketRun(db, {
      itemId, failedRunId: reviewer, action: "switch_runtime", runtime: "claude",
      instruction: "重点核对迁移脚本。", authorityRef: "lead:test",
    })).toMatchObject({ status: "queued" });
    const request = db.prepare("SELECT runtime, role, instruction FROM dispatch_requests WHERE item_id=?").get(itemId) as {
      runtime: string; role: string; instruction: string;
    };
    expect(request).toMatchObject({ runtime: "claude", role: "reviewer" });
    expect(request.instruction).toContain("只读、独立");
    expect(request.instruction).toContain("重点核对迁移脚本。");
  });

  it("recovers a learning run through the dispatcher like any other run", () => {
    const { itemId, runId } = failedItem();
    db.prepare("UPDATE runs SET purpose='learning' WHERE id=?").run(runId);
    expect(recoverTicketRun(db, { itemId, failedRunId: runId, action: "retry", authorityRef: "lead:test" }))
      .toMatchObject({ status: "queued" });
    expect(db.prepare("SELECT purpose FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ purpose: "learning" });
  });

  // 工单对话没有派发请求：它从一条消息开始。调用方（Lead 的工具）提供发消息的办法；
  // 默认重发原来的那条消息，Lead 也可以换成自己的话。换模型和换 runtime 跟别的 Run 一样。
  it("resends a failed ticket chat through the caller's message route, on the chosen model", () => {
    const { itemId } = failedItem();
    const chat = createRun(db, { itemId, purpose: "conversation", runtime: "codex", model: "gpt-5.5" });
    updateRun(db, chat, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "model is not supported" });
    db.prepare(
      "INSERT INTO activities (item_id, run_id, actor, kind, payload) VALUES (?, ?, 'user', 'comment', ?)",
    ).run(itemId, chat, JSON.stringify({ content: "测试为什么失败？", route: "ticket_agent_start" }));

    expect(() => recoverTicketRun(db, {
      itemId, failedRunId: chat, action: "next_model", model: "gpt-6.1-sol", authorityRef: "lead:test",
    })).toThrow(/message route/);

    const sent: unknown[] = [];
    const result = recoverTicketRun(db, {
      itemId, failedRunId: chat, action: "next_model", model: "gpt-6.1-sol", authorityRef: "lead:test",
      startConversation: (target) => { sent.push(target); return 4242; },
    });
    expect(sent).toEqual([{ runtime: "codex", model: "gpt-6.1-sol", effort: null, message: "测试为什么失败？" }]);
    expect(result).toMatchObject({ status: "started", runId: 4242, dispatchRequestId: null, model: "gpt-6.1-sol" });
    expect(db.prepare(
      `SELECT json_extract(payload, '$.runId') AS runId, json_extract(payload, '$.purpose') AS purpose FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='runtime_recovery_queued'`,
    ).get(itemId)).toEqual({ runId: 4242, purpose: "conversation" });
  });
});
