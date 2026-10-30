import type { Db } from "@pi-lead-child/store";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { addActivity } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import { getItem, transition, updateOrchestrationState } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";
import { failureNextStep, typedFailure } from "@pi-lead-child/runtime";
import type { RuntimeId, TypedFailure } from "@pi-lead-child/core";

// 运行边界上逃出的异常是宿主代码的缺陷（spec D1：host / never / code_fix）。
// 它不扣工单的重试额度，"下一步"也只说明需要修复宿主代码，不请 lead 判断要不要重试。
function hostExceptionFailure(detail: string): TypedFailure {
  return typedFailure("host_exception", { errorCode: "unhandled_run_exception", message: detail });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function parseMetadata(serialized: string): Record<string, unknown> {
  try {
    const value = JSON.parse(serialized);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function alreadyReported(db: Db, itemId: number, runId: number): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM inbox WHERE item_id = ? AND json_extract(payload, '$.blockerKey') = ? LIMIT 1",
  ).get(itemId, `run-crash:${runId}`));
}

function addAttemptEndIfMissing(db: Db, itemId: number, runId: number): void {
  const exists = db.prepare(
    "SELECT 1 FROM activities WHERE run_id=? AND kind='attempt_end' LIMIT 1",
  ).get(runId);
  if (!exists) {
    addActivity(db, {
      itemId,
      runId,
      actor: "system",
      kind: "attempt_end",
      payload: { finalItemStage: getItem(db, itemId)?.stage, reason: "unhandled_run_exception" },
    });
  }
}

function recordLeadAlert(
  db: Db,
  args: { itemId: number; runId: number; detail: string; runState: string; runtime: RuntimeId },
): void {
  raiseBlocker(db, {
    // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
    needsUser: false,
    itemId: args.itemId,
    runId: args.runId,
    code: "unhandled_run_exception",
    payloadKind: "unhandled_run_exception",
    title: `Run #${args.runId} 出现未捕获异常`,
    summary: `Run #${args.runId} 在运行边界触发未捕获异常：${args.detail.slice(0, 1_600)}`,
    nextStep: failureNextStep(args.runtime, hostExceptionFailure(args.detail)),
    source: "structural",
    dedupKey: `run-crash:${args.runId}`,
    evidence: {
      runId: args.runId,
      runState: args.runState,
      detail: args.detail,
    },
  });
}

function recordMinimalFailure(
  db: Db,
  args: { itemId: number; runId: number; detail: string; at: Date },
): boolean {
  return db.transaction(() => {
    const run = getRun(db, args.runId);
    if (!run || run.item_id !== args.itemId) return false;
    if (alreadyReported(db, args.itemId, args.runId)) return false;

    if (run.state === "starting" || run.state === "running") {
      updateRun(db, args.runId, {
        state: "failed",
        endedAt: true,
        exitCode: null,
        errorCode: "unhandled_run_exception",
        errorMessage: args.detail,
        failure: hostExceptionFailure(args.detail),
        metadata: {
          ...parseMetadata(run.metadata),
          unhandledException: { detectedAt: args.at.toISOString(), detail: args.detail },
        },
      });
      addActivity(db, {
        itemId: args.itemId,
        runId: args.runId,
        actor: "system",
        kind: "crash",
        payload: { errorCode: "unhandled_run_exception", reason: args.detail },
      });
      const item = getItem(db, args.itemId);
      // 成果修复回合不改变工单的 stage（工单 09）。宿主异常仍然升起下面的 blocker。
      if (item?.stage === "active" && run.purpose !== "outcome_repair") {
        transition(db, {
          itemId: args.itemId,
          to: "blocked",
          actor: "system",
          reason: "unhandled agent run exception",
          runId: args.runId,
          now: args.at,
        });
      }
      if (run.role === "executor" && run.purpose === "execution") {
        const budget = executorRetryBudget(db, args.itemId);
        if (budget.exhausted && getItem(db, args.itemId)?.plan_state !== "failed") {
          updateOrchestrationState(db, args.itemId, "failed");
        }
      }
    }

    addAttemptEndIfMissing(db, args.itemId, args.runId);
    recordLeadAlert(db, {
      itemId: args.itemId,
      runId: args.runId,
      detail: args.detail,
      runState: getRun(db, args.runId)?.state ?? run.state,
      runtime: run.runtime,
    });
    return true;
  }).immediate();
}

/**
 * Final process boundary for exceptions that escaped the runtime event pipeline.
 * This function never throws: the original run exception must remain the caller-visible error.
 */
export function recordUnhandledRunFailure(
  db: Db,
  args: { itemId: number; runId: number; error: unknown; at?: Date },
): boolean {
  const at = args.at ?? new Date();
  const detail = errorMessage(args.error).slice(0, 4_000);
  try {
    const recorded = recordMinimalFailure(db, { ...args, detail, at });
    if (!recorded) return false;
    const run = getRun(db, args.runId);
    if (!run || run.state !== "failed") return true;

    try {
      createCheckpointDomainService({ db, now: () => at }).recordSystemCheckpoint({
        itemId: args.itemId,
        runId: args.runId,
        kind: "blocked",
        title: "Agent Run 未捕获异常",
        summary: `Run #${args.runId} 在运行边界触发未捕获异常：${detail.slice(0, 1_600)}`,
        nextStep: failureNextStep(run.runtime, hostExceptionFailure(detail)),
        keyFacts: [
          { label: "Run", value: `#${args.runId}` },
          { label: "错误类型", value: "unhandled_run_exception" },
        ],
        idempotencyKey: `run-crash:${args.runId}`,
        leadVisible: true,
        precedingEvents: [runUpdatedEvent(args.itemId, args.runId, at)],
      });
    } catch {
      // 基础结算和 Lead blocker 已经落账。网关/卡片投影故障不能让兜底再次抛错。
    }
    return true;
  } catch {
    // 连最小结算都失败时也保留原异常；调用方的 onChildDone 仍会把它广播给控制面。
    return false;
  }
}
