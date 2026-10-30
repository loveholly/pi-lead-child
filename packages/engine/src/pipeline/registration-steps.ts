// 登记的后续步骤（spec D3），以及 daemon 启动时的重新登记（工单 08）。
// 进程退出后，child manager 逐步执行这些步骤，每一步各自提交。
// 启动修复用同一份步骤代码重新登记。这样，宿主代码修好以后，重新登记走的就是修好的代码。
import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { itemUpdatedEvent, publishGatewayEvents, runUpdatedEvent } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import type { Item, Run } from "@pi-lead-child/core";
import type { IngestOutcome } from "./ingest.js";
import {
  AFTER_OUTCOME_ROLLOUT_SQL,
  clearOutcomeRegistrationBlocker,
  recordInvalidOutcomeEnvelope,
  recordOutcomeRegistrationMissing,
  recoverOutcomeSnapshot,
} from "./outcome-recovery.js";
import {
  parseMetadata,
  pendingRegistration,
  REREGISTRATION_SCOPE_SQL,
  registrationPendingReason,
  resolvePendingRegistration,
  type RegistrationStep,
  type RunRegistration,
} from "./run-registration.js";
import { criticalHandoffToolName, recordTerminalHandoffFailure, type CriticalToolFailure } from "./terminal-handoff.js";
import { isDeliveryRun } from "./delivery-run.js";
import { reregisterOutcomeRepairs, type OutcomeRepairResult } from "./outcome-repair.js";

/** 成果恢复这一步。调用方负责事务。 */
export function outcomeRecoveryStep(db: Db, input: { itemId: number; runId: number; at: Date }): void {
  // 只有交付 Run 有成果可恢复（delivery-run.ts）。对话 Run 回答用户，不交付成果：
  // 它结束时找不到成果信封是常态，不能据此写下"成果缺失"、升起 blocker 或把 review 打回 blocked。
  const run = getRun(db, input.runId);
  if (!run || !isDeliveryRun(run)) return;
  const recovered = recoverOutcomeSnapshot(db, { ...input, textRecovery: "if_ticket_update_attempted" });
  if (recovered.status === "no_envelope") {
    // 活跃路径：这个 Run 刚结束，自我恢复也刚失败。工单不能停在 review 装作有成果
    // 在等人验收（工单 #66）。
    recordOutcomeRegistrationMissing(db, { ...input, demoteUnrecoveredReview: true });
  } else if (recovered.status === "invalid_envelope") {
    recordInvalidOutcomeEnvelope(db, { ...input, reason: recovered.reason, demoteLatestExecutor: true });
  }
}

/** 交接检查这一步。ingest 要求终态交接、工单仍在 active 时，记下交接失败。调用方负责事务。 */
export function handoffCheckStep(
  db: Db,
  input: { itemId: number; runId: number; at: Date; ingest: IngestOutcome | undefined },
): void {
  const handoffFailed = input.ingest?.type === "terminal_handoff_required"
    && recordTerminalHandoffFailure(db, {
      itemId: input.itemId,
      runId: input.runId,
      at: input.at,
      criticalToolFailure: input.ingest.criticalToolFailure,
    });
  if (!handoffFailed) {
    publishGatewayEvents(db, [
      runUpdatedEvent(input.itemId, input.runId, input.at),
      itemUpdatedEvent(input.itemId, input.at),
    ]);
  }
}

// ——— 启动时重新登记（工单 08）———

// 每次启动最多处理这么多个 Run。启动修复必须有边界。
export const REREGISTRATION_LIMIT_PER_START = 20;

// 重新登记没有完成的原因。这些情况下，事务整体回滚，Run 保持原样，下次启动再试。
export type ReregistrationKeepReason =
  // 现有规则会因为 LLM 错误结局把工单转为 blocked。
  | "llm_error"
  // 现有规则需要升起新的 blocker 或通知。重新登记只减少 blocker，不新增。
  | "needs_new_blocker"
  // 登记完以后，工单仍然停在 blocked。撤回 blocker 会让 blocked 没有理由。
  | "still_blocked";

export type ReregistrationResult =
  | { status: "registered"; runId: number; fromStep: RegistrationStep }
  | { status: "kept"; runId: number; reason: ReregistrationKeepReason }
  | { status: "error"; runId: number; error: string };

export interface ReregistrationSummary {
  registered: number;
  kept: number;
  errors: number;
  results: ReregistrationResult[];
  // 登记没有完成的成果修复回合（工单 09），用当前代码再登记一次的结果。
  outcomeRepairs: OutcomeRepairResult[];
}

class KeepPending extends Error {
  constructor(readonly reason: ReregistrationKeepReason) {
    super(`registration kept pending: ${reason}`);
  }
}

// runs.metadata.reregistration：最近一次重新登记的结果。registered 的 Run 退出候选。
// kept 和 error 的 Run 排在没试过的 Run 后面。这样，同几个 Run 不会一直占满上限。
interface RunReregistration {
  state: "registered" | "kept" | "error";
  fromStep?: RegistrationStep;
  reason?: string;
  at: string;
}

/**
 * 候选：工单最新的执行 Run 已经 finished，但登记没有完成。有两种：
 *   - 某一步抛错，Run 上记着登记待处理（工单 07）。
 *   - daemon 在退出事务之后、登记之前崩溃。Run 上没有标记，也没有 attempt_end 活动。
 *     child manager 在登记的各步之后才写 attempt_end。有这条活动，就说明登记已经走完。
 *     完整的登记会把工单推出 active（等子工单时除外），所以这种 Run 的工单还在 active。
 * 只看成果功能上线之后结束的 Run。没试过的 Run 排在前面，其余按上次尝试的时间排。
 */
function candidateRunIds(db: Db, limit: number): number[] {
  const rows = db.prepare(
    `SELECT r.id
     FROM runs r
     JOIN items i ON i.id = r.item_id
     WHERE r.state = 'finished'
       AND ${REREGISTRATION_SCOPE_SQL}
       AND ${AFTER_OUTCOME_ROLLOUT_SQL}
       AND COALESCE(json_extract(r.metadata, '$.reregistration.state'), '') <> 'registered'
       AND (
         json_extract(r.metadata, '$.registration.state') = 'pending'
         OR (
           json_extract(r.metadata, '$.registration') IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM activities ended WHERE ended.run_id = r.id AND ended.kind = 'attempt_end'
           )
           AND i.stage = 'active'
           AND COALESCE(i.plan_state, 'none') NOT IN ('waiting', 'integrating')
         )
       )
     ORDER BY json_extract(r.metadata, '$.reregistration.at') IS NOT NULL,
              json_extract(r.metadata, '$.reregistration.at'),
              r.id
     LIMIT ?`,
  ).all(limit) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

// 记下最近一次重新登记的结果。这是内部记录，不面向用户。写不进去时不影响结果。
function recordAttempt(db: Db, runId: number, reregistration: RunReregistration): void {
  try {
    db.transaction(() => {
      const run = getRun(db, runId);
      if (run) updateRun(db, runId, { metadata: { ...parseMetadata(run.metadata), reregistration } });
    }).immediate();
  } catch {
    // 只影响下次启动的排序。
  }
}

/**
 * 工单停在 blocked，而且正是这个 Run 的登记待处理把它从 active 转过来的，之后没人再动过 stage。
 * 只有这时，重新登记才撤销这个 blocked，再按现有规则推进 stage。
 * 别人造成的 blocked 有别人的理由，重新登记不改它。
 */
function blockedByThisRegistration(db: Db, item: Item, run: Run, registration: RunRegistration | null): boolean {
  if (!registration || item.stage !== "blocked") return false;
  const last = db.prepare(
    `SELECT run_id,
            json_extract(payload, '$.from') AS from_stage,
            json_extract(payload, '$.to') AS to_stage,
            json_extract(payload, '$.reason') AS reason
     FROM activities
     WHERE item_id = ? AND kind = 'transition'
     ORDER BY id DESC
     LIMIT 1`,
  ).get(item.id) as { run_id: number | null; from_stage: string; to_stage: string; reason: string } | undefined;
  return last?.run_id === run.id
    && last.from_stage === "active"
    && last.to_stage === "blocked"
    && last.reason === registrationPendingReason(run.id, registration.step);
}

function endedWithLlmError(db: Db, runId: number): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM runtime_events
     WHERE run_id = ? AND event_type = 'message.completed' AND json_extract(payload, '$.stopReason') = 'error'
     LIMIT 1`,
  ).get(runId));
}

function lastCriticalToolFailure(db: Db, runId: number): CriticalToolFailure | null {
  const rows = db.prepare(
    "SELECT payload FROM runtime_events WHERE run_id = ? AND event_type = 'tool.failed' ORDER BY seq",
  ).all(runId) as Array<{ payload: string }>;
  let failure: CriticalToolFailure | null = null;
  for (const row of rows) {
    const event = parseMetadata(row.payload);
    const name = criticalHandoffToolName(event.name);
    if (name) failure = { name, error: String(event.error ?? "critical tool call failed").slice(0, 2_000) };
  }
  return failure;
}

/**
 * ingest 对 run.completed 的结论，按已落库的事件推导。规则与 ingest.ts 的 settle 相同：
 *   - 工单在 active，Run 以 LLM 错误结局：settle 把工单转为 blocked。
 *   - 工单在 active，没有等子工单：需要终态交接。
 * settle 读的是 ingestor 在内存里攒的状态，所以这里按事件重算，不重放 ingestor。
 * 重放会重写结束时间，也会重复累计用量。
 */
function settledIngest(db: Db, run: Run, item: Item): IngestOutcome | undefined {
  if (run.purpose === "conversation" || item.stage !== "active") return undefined;
  if (endedWithLlmError(db, run.id)) throw new KeepPending("llm_error");
  if (["waiting", "integrating"].includes(item.plan_state ?? "none")) return undefined;
  return { type: "terminal_handoff_required", criticalToolFailure: lastCriticalToolFailure(db, run.id) };
}

function blockerWatermark(db: Db): { inbox: number; notifications: number } {
  return {
    inbox: (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM inbox").get() as { id: number }).id,
    notifications: (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM notifications").get() as { id: number }).id,
  };
}

// 两张表的 id 都是 AUTOINCREMENT，不会复用，所以比水位高的行就是这次新写的。
function raisedSince(db: Db, mark: { inbox: number; notifications: number }): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM inbox WHERE id > ? AND severity = 'blocker' LIMIT 1").get(mark.inbox)
    || db.prepare("SELECT 1 FROM notifications WHERE id > ? LIMIT 1").get(mark.notifications),
  );
}

/**
 * 用当前代码重新登记一个候选 Run。整个过程在一笔事务里：要么登记完成，要么什么都不留下。
 * 登记完成的条件：每一步都不抛错，没有新的 blocker 或通知，工单最后不在 blocked。
 */
export function reregisterRun(db: Db, input: { runId: number; at: Date }): ReregistrationResult {
  const { runId, at } = input;
  let result: ReregistrationResult;
  try {
    const fromStep = db.transaction((): RegistrationStep => {
      const run = getRun(db, runId);
      const item = run ? getItem(db, run.item_id) : undefined;
      if (!run || !item) throw new Error(`run #${runId} or its item is missing`);
      const registration = pendingRegistration(run.metadata);
      // 没有标记的 Run 是 daemon 崩溃留下的，登记一步也没有做。
      const fromStep = registration?.step ?? "ingest";
      const itemId = item.id;
      const mark = blockerWatermark(db);

      // 1. 撤销登记待处理造成的 blocked。工单回到这个 Run 结束时的 active，现有规则从这里接着走。
      //    没有 blocked → review 这条边，所以先回 active，再由成果恢复按现有规则推进。
      if (blockedByThisRegistration(db, item, run, registration)) {
        transition(db, {
          itemId,
          to: "active",
          actor: "system",
          reason: `run #${runId} registration resumed after restart`,
          runId,
          now: at,
        });
      }
      // 2. ingest：按落库的事件推导它的结论。
      const ingest = settledIngest(db, run, getItem(db, itemId)!);
      // 3. 成果恢复。从出错的那一步开始：交接检查出错时，成果恢复已经完成，不再重做。
      if (fromStep === "ingest" || fromStep === "outcome_recovery") outcomeRecoveryStep(db, { itemId, runId, at });
      // 4. 交接检查。
      handoffCheckStep(db, { itemId, runId, at, ingest });

      // 只减少 blocker。现有规则要求新的 blocker 时，这次不登记。这个 Run 留给人或修复回合（工单 09）。
      if (raisedSince(db, mark)) throw new KeepPending("needs_new_blocker");
      if (getItem(db, itemId)!.stage === "blocked") throw new KeepPending("still_blocked");

      resolvePendingRegistration(db, runId, at);
      clearOutcomeRegistrationBlocker(db, runId);
      const reregistration: RunReregistration = { state: "registered", fromStep, at: at.toISOString() };
      updateRun(db, runId, { metadata: { ...parseMetadata(getRun(db, runId)!.metadata), reregistration } });
      addActivity(db, {
        itemId,
        runId,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "registration_reregistered",
          runId,
          fromStep,
          stage: getItem(db, itemId)!.stage,
        },
      });
      return fromStep;
    }).immediate();
    return { status: "registered", runId, fromStep };
  } catch (error) {
    if (error instanceof KeepPending) {
      result = { status: "kept", runId, reason: error.reason };
    } else {
      // 宿主缺陷可能还在。这个 Run 保持原样，不影响其他候选，也不让 daemon 启动失败。
      const message = error instanceof Error ? error.message : String(error);
      result = { status: "error", runId, error: message.split(/\r?\n/)[0]!.slice(0, 200) };
    }
  }
  recordAttempt(db, runId, {
    state: result.status === "kept" ? "kept" : "error",
    reason: result.status === "kept" ? result.reason : "host_error",
    at: at.toISOString(),
  });
  return result;
}

/**
 * daemon 启动时调用。幂等：登记完成的 Run 退出候选，没完成的 Run 原样保留。
 * 有边界：只处理成果功能上线之后的 Run，每次最多处理 limit 个。
 */
export function reregisterFinishedRuns(
  db: Db,
  options: { at?: Date; limit?: number } = {},
): ReregistrationSummary {
  const at = options.at ?? new Date();
  const results = candidateRunIds(db, options.limit ?? REREGISTRATION_LIMIT_PER_START)
    .map((runId) => reregisterRun(db, { runId, at }));
  // 修复回合的信封也是执行结果。宿主修好以后，直接登记它，不重跑 agent（工单 09）。
  const outcomeRepairs = reregisterOutcomeRepairs(db, {
    at, limit: options.limit ?? REREGISTRATION_LIMIT_PER_START,
  });
  return {
    registered: results.filter((result) => result.status === "registered").length,
    kept: results.filter((result) => result.status === "kept").length,
    errors: results.filter((result) => result.status === "error").length,
    results,
    outcomeRepairs,
  };
}
