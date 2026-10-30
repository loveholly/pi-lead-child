// 成果修复回合（spec D4，工单 09）。
// 执行 Run 结束了，但成果没有登记：信封缺失、信封无效，或者交接工具没有被调用。
// runtime 支持 resume、修复额度还有剩余时，内核排一个 purpose 为 outcome_repair 的 Run。
// 修复回合 resume 原来的外部 session。提示里有诊断和成果 schema，agent 只补交成果。
// 修复回合结束后，内核从它的最后一条消息里读成果信封，登记在来源 Run 上。
// 修复回合不依赖 plc 工具通道。runs 53、54 失败，正是因为这个通道不可用。
// 修复回合自己不改变工单的 stage。成果登记以后，stage 按现有规则推进。
import { createHash } from "node:crypto";
import { OUTCOME_INPUT_SCHEMA } from "../agent-tools/definitions.js";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { createDispatcher } from "../coordinator/dispatch.js";
import { addActivity } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { itemUpdatedEvent, publishGatewayEvents, runUpdatedEvent } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import {
  insertOutcomeSnapshot,
  isOutcomeNormalizeError,
  normalizeOutcomePayload,
  OUTCOME_SENTINEL,
} from "@pi-lead-child/store";
import {
  OUTCOME_FAILURE_BLOCKER_CODES, outcomeRepairLimit, outcomeRepairRefusal, outcomeRepairRunsUsed, registrationBlockers,
} from "@pi-lead-child/store";
import { typedFailure } from "@pi-lead-child/runtime";
import { getRun, updateRun } from "@pi-lead-child/store";
import type { Item, ItemStage } from "@pi-lead-child/core";
import { clearOutcomeRegistrationBlocker, finalOutcomeEnvelope } from "./outcome-recovery.js";
import { parseMetadata, resolvePendingRegistration } from "./run-registration.js";
import { retractTerminalHandoffBlocker } from "./terminal-handoff.js";

export const OUTCOME_REPAIR_TRIGGER = "outcome-repair";

// 只有成果没交好的三种 blocker 触发修复回合（spec D4）。
// 登记待处理（registration_pending）是宿主缺陷。spec D3 的处理是等宿主修好后重新登记，不重跑 agent。
// 所以它不触发修复回合。它和这三种 blocker 同时出现时，闸门照样放行。
const REPAIR_TRIGGER_CODES: ReadonlySet<string> = new Set(OUTCOME_FAILURE_BLOCKER_CODES);

// 还没有结束的修复请求。修复回合结束时，它自己的请求要到下一轮派发才结算。
// 所以 Run 已经结束的请求不算。
function openRepairRequest(db: Db, sourceRunId: number): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM dispatch_requests request
     WHERE request.purpose='outcome_repair' AND request.resume_from_run_id=?
       AND request.state IN ('pending','claimed','started')
       AND NOT EXISTS (
         SELECT 1 FROM dispatch_claims claim JOIN runs run ON run.id=claim.run_id
         WHERE claim.request_id=request.id AND run.state IN ('finished','failed','stopped')
       )
     LIMIT 1`,
  ).get(sourceRunId));
}

export type OutcomeRepairSkipReason =
  | "not_execution_run"
  | "budget_exhausted"
  | "not_repairable"
  | "no_outcome_failure"
  | "resume_unsupported"
  | "no_session"
  | "already_requested";

export type OutcomeRepairPlan =
  | { eligible: true; itemId: number; sourceRunId: number; attempt: number; limit: number; diagnosis: string }
  | { eligible: false; reason: OutcomeRepairSkipReason; detail?: string };

/**
 * 这个执行 Run 现在该不该有一个修复回合。只读，不写库。条件如下：
 *   - 修复额度还有剩余。
 *   - 闸门放行：Run 是工单最新的执行 Run，已经 finished，成果没有登记；工单停在 blocked 或 active。
 *   - Run 挂着交接失败、成果缺失或信封无效的 blocker。
 *   - runtime 支持 resume，Run 有外部 session。
 *   - 没有还在排队或运行的修复请求。
 */
export function planOutcomeRepair(db: Db, input: { sourceRunId: number; resume: boolean }): OutcomeRepairPlan {
  const skip = (reason: OutcomeRepairSkipReason, detail?: string): OutcomeRepairPlan =>
    ({ eligible: false, reason, ...(detail ? { detail } : {}) });
  const source = getRun(db, input.sourceRunId);
  const item = source ? getItem(db, source.item_id) : undefined;
  if (!source || !item || source.role !== "executor" || source.purpose !== "execution") {
    return skip("not_execution_run");
  }
  const limit = outcomeRepairLimit();
  const used = outcomeRepairRunsUsed(db, source.id);
  if (used >= limit) return skip("budget_exhausted");
  const refusal = outcomeRepairRefusal(db, {
    itemId: item.id, role: "executor", stage: item.stage, sourceRunId: source.id,
  });
  if (refusal) return skip("not_repairable", refusal);
  const blockers = registrationBlockers(db, item.id, source.id);
  if (!blockers.some((blocker) => REPAIR_TRIGGER_CODES.has(blocker.code))) return skip("no_outcome_failure");
  if (!input.resume) return skip("resume_unsupported");
  if (!source.external_session_id) return skip("no_session");
  if (openRepairRequest(db, source.id)) return skip("already_requested");
  const diagnosis = blockers
    .map((blocker) => `「${blocker.title}」${blocker.summary}`)
    .join("\n")
    .slice(0, 2_000);
  return { eligible: true, itemId: item.id, sourceRunId: source.id, attempt: used + 1, limit, diagnosis };
}

/**
 * 条件满足时，为这个执行 Run 排一个修复回合，返回派发请求的 id。条件不满足时返回 null。
 * 修复回合固定在来源 Run 的 runtime 和模型上，因为只有同一个 runtime 能 resume 这个 session。
 */
export function requestOutcomeRepair(db: Db, input: { sourceRunId: number; resume: boolean }): number | null {
  return db.transaction(() => {
    const plan = planOutcomeRepair(db, input);
    if (!plan.eligible) return null;
    const source = getRun(db, plan.sourceRunId)!;
    const requestId = createDispatcher(db).request({
      itemId: plan.itemId,
      role: "executor",
      purpose: "outcome_repair",
      runtime: source.runtime,
      model: source.model ?? undefined,
      resumeFromRunId: source.id,
      instruction: plan.diagnosis,
      trigger: OUTCOME_REPAIR_TRIGGER,
      idempotencyKey: `outcome-repair:${source.id}:${plan.attempt}`,
    });
    addActivity(db, {
      itemId: plan.itemId,
      runId: source.id,
      actor: "system",
      kind: "decision",
      payload: {
        decision: "outcome_repair_requested",
        sourceRunId: source.id,
        dispatchRequestId: requestId,
        attempt: plan.attempt,
        limit: plan.limit,
      },
    });
    return requestId;
  }).immediate();
}

/** 修复回合的提示。session 里已经有原来的任务和纪律，这里只说明这一回合要做什么。 */
export function buildOutcomeRepairPrompt(input: {
  item: Pick<Item, "id" | "title">;
  sourceRunId: number;
  diagnosis: string | null;
}): string {
  return [
    `## 成果修复回合：工单 #${input.item.id}（${input.item.title}）`,
    `这个 session 里的执行回合是 Run #${input.sourceRunId}。它已经结束，但宿主没有登记到它的成果。`,
    "## 诊断",
    input.diagnosis?.trim() || `Run #${input.sourceRunId} 已结束，但成果没有登记。`,
    "## 这一回合要做的事",
    `- 不要重做任务，不要修改文件，也不要运行新的命令。只根据 Run #${input.sourceRunId} 已经完成的工作补交成果。`,
    "- 这一回合不能改变工单的状态。不要调用 ticket_update。",
    `- 在最后一条消息里单独输出一行：${OUTCOME_SENTINEL} 加一个空格，再加一个 JSON 对象。这一行不要换行。宿主从这一行登记成果。`,
    "- JSON 必须符合下面的成果 schema。summary 必填。changes、deliverables、validations 都要给出，没有内容时写空数组。",
    "- validations 如实填写：没有运行的命令写 not_run，失败的命令写 failed。不要在成果里写 secret。",
    "## 成果 schema",
    JSON.stringify(OUTCOME_INPUT_SCHEMA),
    "## 示例",
    `${OUTCOME_SENTINEL} ${JSON.stringify({
      summary: "Implemented the requested behavior.",
      changes: [{ kind: "file", ref: "src/example.ts", summary: "Added the behavior" }],
      deliverables: [{ kind: "path", ref: "src/example.ts", label: "implementation" }],
      validations: [{ command: "npm test", outcome: "passed", exitCode: 0, summary: "All assigned tests pass", evidenceRef: null }],
    })}`,
  ].join("\n");
}

// ——— 修复回合结束后 ———

export type OutcomeRepairFailureReason =
  | "source_missing"
  | "not_repairable"
  | "run_failed"
  | "session_expired"
  | "llm_error"
  | "no_envelope"
  | "invalid_envelope"
  | "stage_not_repairable"
  | "partial_outcome"
  | "host_error";

const FAILURE_TEXT: Record<OutcomeRepairFailureReason, string> = {
  source_missing: "找不到来源 Run",
  not_repairable: "来源 Run 已经不需要或不能修复",
  run_failed: "修复回合没有正常结束",
  // 修复回合只能在来源 Run 的会话里补交成果。新会话不知道来源 Run 做了什么，所以内核不为它开新会话。
  session_expired: "来源 Run 的会话已经不存在（CLI 按保留期删除了它的记录），修复回合无法补交成果",
  llm_error: "修复回合以 LLM 错误结束",
  no_envelope: `最后一条消息里没有 ${OUTCOME_SENTINEL} 成果信封`,
  invalid_envelope: "成果信封无效",
  stage_not_repairable: "工单不在可以修复的状态",
  partial_outcome: "成果不完整，工单不能进入 Review",
  host_error: "宿主登记出错",
};

export type OutcomeRepairResult =
  | { status: "repaired"; repairRunId: number; sourceRunId: number; snapshotId: number; stage: ItemStage }
  | { status: "failed"; repairRunId: number; sourceRunId: number | null; reason: OutcomeRepairFailureReason };

class RepairFailed extends Error {
  constructor(readonly reason: OutcomeRepairFailureReason, readonly detail: string | null = null) {
    super(`outcome repair failed: ${reason}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 工单停在 blocked，而且正是来源 Run 的登记失败把它转过来的，之后没人再动过 stage。
 * 交接失败、成果缺失、信封无效和登记待处理，都是 system 以来源 Run 的名义把工单转为 blocked。
 * 别人造成的 blocked 有别人的理由，修复回合不改它。工单 08 的重新登记用同样的规则。
 */
function blockedBySourceRegistration(db: Db, itemId: number, sourceRunId: number): boolean {
  const last = db.prepare(
    `SELECT run_id, actor, json_extract(payload, '$.to') AS to_stage
     FROM activities
     WHERE item_id=? AND kind='transition'
     ORDER BY id DESC
     LIMIT 1`,
  ).get(itemId) as { run_id: number | null; actor: string; to_stage: string } | undefined;
  return last?.run_id === sourceRunId && last.actor === "system" && last.to_stage === "blocked";
}

function recordRepairCheckpoint(
  db: Db,
  input: {
    itemId: number; repairRunId: number; result: "repaired" | "failed";
    title: string; summary: string; nextStep: string; at: Date;
  },
): void {
  createCheckpointDomainService({ db, now: () => input.at }).recordSystemCheckpoint({
    itemId: input.itemId,
    runId: input.repairRunId,
    // 不用 blocked：修复回合不升起新的 blocker。lead 只收到这一条说明。
    kind: "progress",
    title: input.title,
    summary: input.summary,
    nextStep: input.nextStep,
    // 宿主出错的修复回合在启动时还会再登记一次（工单 08 的重新登记），所以成功和失败各用一个键。
    idempotencyKey: `outcome-repair-${input.result}:${input.repairRunId}`,
    leadVisible: true,
    precedingEvents: [runUpdatedEvent(input.itemId, input.repairRunId, input.at)],
  });
}

/**
 * 修复回合失败：来源 Run 原来的 blocker 保留，stage 不变。这里只记下结果，并给 lead 一条说明。
 * host_error 不是最终结果：daemon 启动时会再登记一次。之后的最终结果可以替换它。
 * 这个函数不抛错。记录失败时，原来的 blocker 仍然在。
 */
export function recordOutcomeRepairFailure(
  db: Db,
  input: { repairRunId: number; reason: OutcomeRepairFailureReason; detail?: string | null; at?: Date },
): OutcomeRepairResult {
  const at = input.at ?? new Date();
  const repair = getRun(db, input.repairRunId);
  const sourceRunId = repair?.resumed_from_run_id ?? null;
  // 原因只取第一行，并且先脱敏：报错文本里可能带着凭据，它会进活动和检查点。
  const detail = input.detail
    ? typedFailure("host_registration_failed", { errorCode: null, message: input.detail }).evidence.split(/\r?\n/)[0]!.slice(0, 200)
    : null;
  const reasonText = detail ? `${FAILURE_TEXT[input.reason]}：${detail}` : FAILURE_TEXT[input.reason];
  try {
    db.transaction(() => {
      if (!repair) return;
      const current = getRun(db, repair.id)!;
      const recorded = parseMetadata(current.metadata).outcomeRepair as { reason?: string } | undefined;
      if (recorded && (recorded.reason !== "host_error" || input.reason === "host_error")) return;
      updateRun(db, repair.id, {
        metadata: {
          ...parseMetadata(current.metadata),
          outcomeRepair: { state: "failed", sourceRunId, reason: input.reason, detail, at: at.toISOString() },
        },
      });
      addActivity(db, {
        itemId: repair.item_id,
        runId: repair.id,
        actor: "system",
        kind: "decision",
        payload: { decision: "outcome_repair_failed", sourceRunId, repairRunId: repair.id, reason: input.reason, detail },
      });
      recordRepairCheckpoint(db, {
        itemId: repair.item_id,
        repairRunId: repair.id,
        result: "failed",
        title: "成果修复回合没有补交成果",
        summary: `修复回合 Run #${repair.id} 没有补交 Run #${sourceRunId ?? "-"} 的成果：${reasonText}。原来的 blocker 保留。`,
        nextStep: "按原来 blocker 的下一步处理。",
        at,
      });
    }).immediate();
  } catch {
    // 失败记录只是说明。原来的 blocker 已经在账本上。
  }
  return { status: "failed", repairRunId: input.repairRunId, sourceRunId, reason: input.reason };
}

/**
 * 修复回合正常结束后调用。整个登记在一笔事务里：要么全部完成，要么什么都不留下。
 *   1. 从修复回合的最后一个成果信封读出成果，登记在来源 Run 上。
 *   2. 来源 Run 的登记待处理随之结束。
 *   3. stage 按现有规则推进：撤销来源 Run 的登记失败造成的 blocked，成果完整时进入 review。
 *   4. 撤回来源 Run 的登记相关 blocker。
 * 登记完以后工单仍然停在 blocked，或者成果不完整、工单还停在 active，都算修复失败，事务回滚。
 */
export function completeOutcomeRepair(db: Db, input: { repairRunId: number; at?: Date }): OutcomeRepairResult {
  const at = input.at ?? new Date();
  const repairRunId = input.repairRunId;
  try {
    const repaired = db.transaction(() => {
      const repair = getRun(db, repairRunId);
      const sourceRunId = repair?.resumed_from_run_id ?? null;
      const source = sourceRunId === null ? undefined : getRun(db, sourceRunId);
      const item = repair ? getItem(db, repair.item_id) : undefined;
      if (!repair || repair.purpose !== "outcome_repair" || !source || !item || source.item_id !== item.id) {
        throw new RepairFailed("source_missing");
      }
      // 修复回合进行期间，情况可能变了：成果已经由别的途径登记，或者工单又跑了新的执行 Run。
      // 闸门的条件仍然要成立。这个修复回合自己已经结束，所以额度不算它。
      const refusal = outcomeRepairRefusal(db, {
        itemId: item.id, role: repair.role, stage: item.stage, sourceRunId: source.id, repairRunId: repair.id,
      });
      if (refusal) throw new RepairFailed("not_repairable", refusal);
      if (repair.state !== "finished" || (repair.exit_code !== null && repair.exit_code !== 0)) {
        throw new RepairFailed("run_failed");
      }
      const envelope = finalOutcomeEnvelope(db, repair.id);
      if (!envelope) throw new RepairFailed("no_envelope");
      if (envelope.hadAssistantError) throw new RepairFailed("llm_error");
      let outcome;
      try {
        outcome = normalizeOutcomePayload(envelope.parsed, { workdir: item.workdir, allowPartial: true });
      } catch (error) {
        if (!isOutcomeNormalizeError(error)) throw error;
        throw new RepairFailed("invalid_envelope", error instanceof Error ? error.message : String(error));
      }

      // 1. 成果登记在来源 Run 上。证据在修复回合的事件里，所以 seq 不写进快照，写进说明。
      const inserted = insertOutcomeSnapshot(db, {
        itemId: item.id,
        executorRunId: source.id,
        source: "system_recovered",
        sourceOutputSha256: sha256(envelope.rawJson),
        recoveryNote: `Recovered from ${OUTCOME_SENTINEL} in outcome repair run #${repair.id} (event seq ${envelope.seq}).`,
        outcome,
        now: at,
      });
      // 2. 来源 Run 的登记待处理（工单 07）随之结束。
      resolvePendingRegistration(db, source.id, at);

      // 3. stage。没有 blocked → review 这条边，所以先回 active，再按成果恢复的规则推进。
      if (item.stage === "blocked") {
        if (!blockedBySourceRegistration(db, item.id, source.id)) throw new RepairFailed("stage_not_repairable");
        transition(db, {
          itemId: item.id, to: "active", actor: "system",
          reason: `run #${source.id} outcome repaired by run #${repair.id}`, runId: source.id, now: at,
        });
      }
      const waiting = ["waiting", "integrating"].includes(getItem(db, item.id)!.plan_state ?? "none");
      if (!waiting) {
        if (outcome.completeness !== "complete") throw new RepairFailed("partial_outcome");
        transition(db, {
          itemId: item.id, to: "review", actor: "system",
          reason: `repaired outcome snapshot from outcome repair run #${repair.id}`, runId: source.id, now: at,
        });
      }

      // 4. 撤回来源 Run 的登记相关 blocker。检查点保留，它们是历史事实。
      const blockerTitles = registrationBlockers(db, item.id, source.id).map((blocker) => blocker.title);
      clearOutcomeRegistrationBlocker(db, source.id);
      retractTerminalHandoffBlocker(db, source.id);

      const stage = getItem(db, item.id)!.stage;
      updateRun(db, repair.id, {
        metadata: {
          ...parseMetadata(repair.metadata),
          outcomeRepair: {
            state: "repaired", sourceRunId: source.id, snapshotId: inserted.snapshot.id, at: at.toISOString(),
          },
        },
      });
      addActivity(db, {
        itemId: item.id,
        runId: repair.id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "outcome_repaired",
          sourceRunId: source.id,
          repairRunId: repair.id,
          snapshotId: inserted.snapshot.id,
          completeness: outcome.completeness,
          stage,
        },
      });
      recordRepairCheckpoint(db, {
        itemId: item.id,
        repairRunId: repair.id,
        result: "repaired",
        title: "成果已补交",
        summary: `修复回合 Run #${repair.id} 补交了 Run #${source.id} 的成果。成果已登记，`
          + `${blockerTitles.length ? `「${[...new Set(blockerTitles)].join("」「")}」` : "登记相关的 blocker "}已撤回。`,
        nextStep: stage === "review" ? "工单进入 Review。" : "工单继续等待子工单。",
        at,
      });
      publishGatewayEvents(db, [runUpdatedEvent(item.id, source.id, at), itemUpdatedEvent(item.id, at)]);
      return {
        status: "repaired" as const, repairRunId: repair.id, sourceRunId: source.id,
        snapshotId: inserted.snapshot.id, stage,
      };
    }).immediate();
    return repaired;
  } catch (error) {
    if (error instanceof RepairFailed) {
      return recordOutcomeRepairFailure(db, { repairRunId, reason: error.reason, detail: error.detail, at });
    }
    // 宿主缺陷：这一次修复失败，原来的 blocker 保留。不抛错，Run 保持 finished。
    const message = error instanceof Error ? error.message : String(error);
    return recordOutcomeRepairFailure(db, { repairRunId, reason: "host_error", detail: message, at });
  }
}

/**
 * daemon 启动时调用（工单 08 的重新登记）。修复回合已经 finished，但它的登记没有完成，就用当前代码再登记一次：
 *   - daemon 在修复回合退出之后、登记之前崩溃。这时 metadata 里没有 outcomeRepair。
 *   - 登记时宿主出错（host_error）。宿主代码修好以后，不重跑 agent，直接用修复回合留下的信封登记。
 * 幂等：完成的修复回合有最终结果，不再是候选。有边界：每次最多处理 limit 个。
 */
export function reregisterOutcomeRepairs(db: Db, options: { at?: Date; limit?: number } = {}): OutcomeRepairResult[] {
  const rows = db.prepare(
    `SELECT id FROM runs
     WHERE purpose='outcome_repair' AND state='finished'
       AND (json_extract(metadata, '$.outcomeRepair') IS NULL
            OR json_extract(metadata, '$.outcomeRepair.reason')='host_error')
     ORDER BY id
     LIMIT ?`,
  ).all(options.limit ?? 20) as Array<{ id: number }>;
  return rows.map((row) => completeOutcomeRepair(db, { repairRunId: row.id, at: options.at }));
}
