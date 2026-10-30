// 登记待处理（spec D3）。
// 进程退出以后，第一笔事务只写退出事实。登记的后续步骤各自提交。
// 某一步抛错时，Run 保持 finished。这里记下"登记待处理"和 host 作用域的诊断，并升起 blocker。
// 执行结果已经保留。宿主代码修好以后，可以重新登记，不必重跑 agent（工单 08）。
import type { Db } from "@pi-lead-child/store";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { addActivity } from "@pi-lead-child/store";
import { stripDiagnosticStack } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import type { TypedFailure } from "@pi-lead-child/core";
import { failureNextStep, typedFailure } from "@pi-lead-child/runtime";
import { deliveryRunSql } from "./delivery-run.js";

// 登记的步骤，按执行顺序排列。前一步抛错时，后面的步骤不再执行。
export type RegistrationStep = "ingest" | "outcome_recovery" | "handoff_check" | "review_automation";

const REGISTRATION_PENDING_BLOCKER = "registration_pending";

const STEP_LABELS: Record<RegistrationStep, string> = {
  ingest: "ingest",
  outcome_recovery: "成果恢复",
  handoff_check: "交接检查",
  review_automation: "评审自动化",
};

// runs.metadata.registration 的形状。工单 08 按 state='pending' 找到要重新登记的 Run。
// 登记成功后，state 改成 registered。出错的步骤和诊断保留下来，作为历史事实。
export interface RunRegistration {
  state: "pending" | "registered";
  step: RegistrationStep;
  failure: TypedFailure;
  detectedAt: string;
  registeredAt?: string;
}

function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.stack || error.message : String(error);
  return text.slice(0, 4_000);
}

// 给人看的原因只取第一行。堆栈只进诊断证据，不进 blocker 的摘要。
function reasonLine(detail: string): string {
  return (stripDiagnosticStack(detail).split(/\r?\n/)[0] ?? detail).slice(0, 200);
}

export function parseMetadata(serialized: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(serialized);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function pendingRegistration(metadata: string): RunRegistration | null {
  const registration = parseMetadata(metadata).registration as Partial<RunRegistration> | undefined;
  return registration?.state === "pending" ? registration as RunRegistration : null;
}

// 登记待处理把工单从 active 转为 blocked 时写的原因。重新登记（工单 08）用它认出这个 blocked 是谁造成的。
export function registrationPendingReason(runId: number, step: RegistrationStep): string {
  return `run #${runId} registration pending: ${step} failed`;
}

// 启动时的重新登记（工单 08）负责的 Run：工单最新的执行 Run，不是对话 Run，工单没有终结。
// 旧 Run 的成果登记进来，会盖过新 Run 的成果，所以只看最新的那个。
// 修复回合（工单 09）也不算：它的成果登记在来源 Run 上，来源 Run 仍然是最新的执行 Run。
// 这是一段固定的 SQL，要求 runs 的别名是 r。启动时的成果修复用它让出这些 Run。
// "最新的执行 Run"就是最新的交付 Run，规则只在 delivery-run.ts 写一份。
export const REREGISTRATION_SCOPE_SQL = `(
  ${deliveryRunSql("r")}
  AND r.id = (
    SELECT MAX(latest.id) FROM runs latest
    WHERE latest.item_id = r.item_id AND ${deliveryRunSql("latest")}
  )
  AND (SELECT owner.stage FROM items owner WHERE owner.id = r.item_id) NOT IN ('done', 'cancelled', 'acked')
)`;

/**
 * 成果登记成功以后，结束这个 Run 的登记待处理。没有待处理的登记时，什么也不做。
 * 调用方负责事务：它和撤回 blocker 在同一笔事务里提交。
 */
export function resolvePendingRegistration(db: Db, runId: number, at: Date): boolean {
  const run = getRun(db, runId);
  const pending = run ? pendingRegistration(run.metadata) : null;
  if (!run || !pending) return false;
  const registration: RunRegistration = { ...pending, state: "registered", registeredAt: at.toISOString() };
  updateRun(db, runId, { metadata: { ...parseMetadata(run.metadata), registration } });
  return true;
}

/**
 * 记下一个 finished Run 的登记待处理。这个函数不抛错。
 * 返回 false 表示没有记下：Run 不是 finished，或者连最小的记录都写不进去。
 * 调用方这时应该把原来的异常继续抛出，交给 runItem 的兜底边界。
 */
export function recordRegistrationPending(
  db: Db,
  input: { itemId: number; runId: number; step: RegistrationStep; error: unknown; at?: Date },
): boolean {
  const at = input.at ?? new Date();
  const label = STEP_LABELS[input.step];
  const failure = typedFailure("host_registration_failed", {
    errorCode: "registration_step_failed",
    message: errorDetail(input.error),
  });
  // 原因取自已经脱敏的证据。原始报错可能带着凭据，它不进 blocker、活动和检查点。
  const reason = reasonLine(failure.evidence);
  let recorded: { created: boolean } | null;
  try {
    recorded = db.transaction(() => {
      const run = getRun(db, input.runId);
      if (!run || run.item_id !== input.itemId || run.state !== "finished") return null;
      // 已经记过就不再重复记：活动、blocker 和 stage 都只写一次。
      if (pendingRegistration(run.metadata)) return { created: false };
      const registration: RunRegistration = {
        state: "pending", step: input.step, failure, detectedAt: at.toISOString(),
      };
      updateRun(db, input.runId, { metadata: { ...parseMetadata(run.metadata), registration } });
      addActivity(db, {
        itemId: input.itemId,
        runId: input.runId,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "registration_pending",
          step: input.step,
          scope: failure.scope,
          retry: failure.retry,
          needs: failure.needs,
          code: failure.code,
          reason,
        },
      });
      raiseBlocker(db, {
        // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
        needsUser: false,
        itemId: input.itemId,
        runId: input.runId,
        code: REGISTRATION_PENDING_BLOCKER,
        payloadKind: REGISTRATION_PENDING_BLOCKER,
        title: "运行结果登记待处理",
        summary: `Run #${input.runId} 已结束，退出码已保存。登记步骤「${label}」出错：${reason}。`
          + "执行结果已保留，这不是执行器的失败。",
        nextStep: failureNextStep(run.runtime, failure),
        source: "structural",
        dedupKey: `registration-pending:${input.runId}`,
        intervention: "propose",
        leadNextStep: `不要 spawn_child 或 recover_ticket_run 重跑。Run #${input.runId} 的执行结果已保留。`
          + "把登记错误告诉用户，等宿主代码修复后再登记。",
        evidence: {
          runId: input.runId,
          step: input.step,
          reason,
          failure: { scope: failure.scope, retry: failure.retry, needs: failure.needs, code: failure.code },
        },
        at,
      });
      // Run 结束时工单还在 active，说明没有一步推进过它。工单不能看起来还在执行，所以转为 blocked。
      // review 等其他 stage 保持不变。对话 Run 和 reviewer 不改变工单的执行状态。
      const item = getItem(db, input.itemId);
      if (run.role === "executor" && run.purpose !== "conversation" && item?.stage === "active") {
        transition(db, {
          itemId: input.itemId,
          to: "blocked",
          actor: "system",
          reason: registrationPendingReason(input.runId, input.step),
          runId: input.runId,
          now: at,
        });
      }
      return { created: true };
    }).immediate();
  } catch {
    return false;
  }
  if (!recorded) return false;
  if (!recorded.created) return true;

  // 检查点和网关投影可能正是出错的那一步，所以它们放在最小记录之后，并且出错时不影响结果。
  try {
    const run = getRun(db, input.runId)!;
    createCheckpointDomainService({ db, now: () => at }).recordSystemCheckpoint({
      itemId: input.itemId,
      runId: input.runId,
      kind: "blocked",
      title: "运行结果登记待处理",
      summary: `Run #${input.runId} 已结束，但登记步骤「${label}」出错：${reason}。执行结果已保留。`,
      nextStep: failureNextStep(run.runtime, failure),
      keyFacts: [
        { label: "Run", value: `#${input.runId}` },
        { label: "登记步骤", value: label },
        { label: "Failure scope", value: failure.scope },
        { label: "原因", value: reason },
      ],
      idempotencyKey: `registration-pending:${input.runId}`,
      leadVisible: true,
      precedingEvents: [runUpdatedEvent(input.itemId, input.runId, at)],
    });
  } catch {
    // 最小记录和 blocker 已经落库。投影故障不能让这个函数再抛错。
  }
  return true;
}
