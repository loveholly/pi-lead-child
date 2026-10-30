import { createHash } from "node:crypto";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { itemUpdatedEvent, publishGatewayEvents, runUpdatedEvent } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { raiseBlocker, retractCheckpointBlockers } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import {
  extractOutcomeEnvelope,
  getOutcomeSnapshotForRun,
  insertOutcomeSnapshot,
  isOutcomeNormalizeError,
  normalizeOutcomePayload,
  OUTCOME_SENTINEL,
  type OutcomeCompleteness,
} from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { REREGISTRATION_SCOPE_SQL, resolvePendingRegistration } from "./run-registration.js";
import { deliveryRunSql, isDeliveryRun, latestDeliveryRunId } from "./delivery-run.js";
import { criticalHandoffToolName } from "./terminal-handoff.js";

export type OutcomeTextRecovery = "always" | "if_ticket_update_attempted";

export type OutcomeRecoveryStatus =
  | "already_present"
  | "recovered"
  | "no_envelope"
  | "invalid_envelope"
  | "not_recoverable";

export interface OutcomeRecoveryResult {
  status: OutcomeRecoveryStatus;
  snapshotId: number | null;
  completeness: OutcomeCompleteness | null;
  transitionedToReview: boolean;
  clearedRegistrationBlocker: boolean;
  reason: string | null;
}

interface AssistantMessageRow {
  seq: number;
  payload: string;
}

interface RuntimeAssistantMessage {
  type?: string;
  role?: string;
  text?: string;
  stopReason?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseRuntimeMessage(row: AssistantMessageRow): RuntimeAssistantMessage | null {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RuntimeAssistantMessage
      : null;
  } catch {
    return null;
  }
}

// 这个 Run 的助手消息里最后一个成果信封。修复回合（工单 09）也用它读修复回合自己的消息。
export function finalOutcomeEnvelope(db: Db, runId: number): {
  seq: number;
  rawJson: string;
  parsed: unknown;
  hadAssistantError: boolean;
} | null {
  const rows = db.prepare(
    `SELECT seq, payload FROM runtime_events
     WHERE run_id=? AND event_type='message.completed'
     ORDER BY seq`,
  ).all(runId) as AssistantMessageRow[];
  let latest: { seq: number; rawJson: string; parsed: unknown } | null = null;
  let hadAssistantError = false;
  for (const row of rows) {
    const message = parseRuntimeMessage(row);
    if (!message || message.type !== "message.completed" || message.role !== "assistant") continue;
    if (message.stopReason === "error") hadAssistantError = true;
    const text = typeof message.text === "string" ? message.text : "";
    const envelope = extractOutcomeEnvelope(text);
    if (envelope) latest = { seq: row.seq, ...envelope };
  }
  return latest ? { ...latest, hadAssistantError } : null;
}

function recoverableRun(db: Db, input: { itemId: number; runId: number }): boolean {
  const run = getRun(db, input.runId);
  if (!run || run.item_id !== input.itemId) return false;
  // 对话 Run 和修复回合都不是交付（delivery-run.ts）：它们没有自己的成果可以恢复。
  if (!isDeliveryRun(run) || run.state !== "finished") return false;
  if (run.exit_code !== null && run.exit_code !== 0) return false;
  if (run.error_code || run.error_message) return false;
  return true;
}

export function ticketUpdateAttempted(db: Db, runId: number): boolean {
  const receipt = db.prepare(
    "SELECT 1 FROM kv WHERE key LIKE ? LIMIT 1",
  ).get(`agent-tool-receipt:v1:${runId}:ticket_update:%`);
  if (receipt) return true;
  const rows = db.prepare(
    `SELECT payload FROM runtime_events
     WHERE run_id=? AND event_type IN ('tool.started','tool.completed','tool.failed')`,
  ).all(runId) as Array<{ payload: string }>;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { name?: unknown };
      if (criticalHandoffToolName(parsed.name) === "ticket_update") return true;
    } catch {
      // Malformed tool payloads cannot authorize text recovery.
    }
  }
  return false;
}

export function recoverOutcomeSnapshot(
  db: Db,
  input: {
    itemId: number;
    runId: number;
    at?: Date;
    textRecovery?: OutcomeTextRecovery;
  },
): OutcomeRecoveryResult {
  const write = (): OutcomeRecoveryResult => {
    const unregistered = (
      status: OutcomeRecoveryStatus,
      reason: string | null = null,
    ): OutcomeRecoveryResult => ({
      status,
      snapshotId: null,
      completeness: null,
      transitionedToReview: false,
      clearedRegistrationBlocker: false,
      reason,
    });
    const existing = getOutcomeSnapshotForRun(db, input.runId);
    if (existing) {
      return {
        status: "already_present",
        snapshotId: existing.id,
        completeness: existing.completeness,
        transitionedToReview: false,
        clearedRegistrationBlocker: false,
        reason: null,
      };
    }
    if (!recoverableRun(db, input)) return unregistered("not_recoverable");
    const item = getItem(db, input.itemId);
    if (!item) return unregistered("not_recoverable");
    if (input.textRecovery === "if_ticket_update_attempted" && !ticketUpdateAttempted(db, input.runId)) {
      return unregistered("no_envelope");
    }
    const envelope = finalOutcomeEnvelope(db, input.runId);
    if (!envelope) return unregistered("no_envelope");
    if (envelope.hadAssistantError) return unregistered("not_recoverable");
    let outcome;
    try {
      outcome = normalizeOutcomePayload(envelope.parsed, {
        workdir: item.workdir,
        allowPartial: true,
      });
    } catch (error) {
      if (!isOutcomeNormalizeError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return unregistered("invalid_envelope", message.split(/\r?\n/)[0] ?? message);
    }
    const at = input.at ?? new Date();
    const inserted = insertOutcomeSnapshot(db, {
      itemId: input.itemId,
      executorRunId: input.runId,
      source: "system_recovered",
      sourceEventSeq: envelope.seq,
      sourceOutputSha256: sha256(envelope.rawJson),
      recoveryNote: `Recovered from ${OUTCOME_SENTINEL} in runtime event seq ${envelope.seq}.`,
      outcome,
      now: at,
    });
    // 成果已经登记，这个 Run 的登记待处理（工单 07）随之结束。
    resolvePendingRegistration(db, input.runId, at);
    let transitionedToReview = false;
    const latestItem = getItem(db, input.itemId);
    if (latestItem?.stage === "active"
        && outcome.completeness === "complete"
        && !["waiting", "integrating"].includes(latestItem.plan_state ?? "none")) {
      transition(db, {
        itemId: input.itemId,
        to: "review",
        actor: "system",
        reason: "recovered outcome snapshot from successful runtime output",
        runId: input.runId,
        now: at,
      });
      transitionedToReview = true;
    }
    return {
      status: "recovered",
      snapshotId: inserted.snapshot.id,
      completeness: outcome.completeness,
      transitionedToReview,
      // "No outcome could be recovered" stops being true the moment one is. A
      // late-arriving envelope must retract the actionable blocker it caused,
      // otherwise the run stays blocked on a question that already has an answer.
      clearedRegistrationBlocker: clearOutcomeRegistrationBlocker(db, input.runId),
      reason: null,
    };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

/**
 * 这个 Run 是不是这张工单当前最新的交付 Run（delivery-run.ts）。
 *
 * 只有"刚刚结束的那次交付交不出成果"才有资格改写 stage。补历史时翻出来的某个旧 Run
 * 说明不了当前这一刻的状态，不能拿它把工单打回 blocked。对话 Run 不算交付：用户在工单里
 * 问一句话，不能让最新的交付"变旧"。
 */
function isLatestDeliveryRun(db: Db, itemId: number, runId: number): boolean {
  return latestDeliveryRunId(db, itemId) === runId;
}

export function recordOutcomeRegistrationMissing(
  db: Db,
  input: {
    itemId: number;
    runId: number;
    at?: Date;
    /**
     * 活跃执行路径专用。
     *
     * runtime 在交付 Run 结束的那一刻会先试着从自己的输出里自我恢复终态；恢复成功就把工单
     * 推到 review，失败则落一条 outcome_registration_missing。一次交付交不出成果时，review
     * 这句"有东西在等你验收"就不成立了，所以活跃路径把 stage 收回到 blocked。
     *
     * 只针对交付 Run。工单 #66 上 Run #50/#51 是用户提问（purpose=conversation），不是
     * "两次恢复失败"；最后一次交付 Run #49 已经登记了成果快照。早先的复盘把它们当成执行，
     * 结果是用户在 review 工单里问一句话，工单就会被打回 blocked。
     *
     * 启动修复（repairOutcomeSnapshots）刻意不传这个开关——它在重建历史，不在描述此刻，
     * 让它批量改写历史工单的 stage 会正面违反"启动修复必须有界"的内核不变量。
     */
    demoteUnrecoveredReview?: boolean;
  },
): boolean {
  const write = (): boolean => {
    const item = getItem(db, input.itemId);
    const run = getRun(db, input.runId);
    if (!item || !run || run.item_id !== input.itemId || !isDeliveryRun(run)) return false;
    // done/cancelled are accepted terminal facts. A later schema feature may not
    // retroactively reopen them or create user-facing blockers for historical data.
    if (item.stage !== "review") return false;
    // 只有最新的那次交付交不出成果，才说明此刻的状态。启动修复翻出来的旧交付（#66 的 Run #48，
    // 早已被 Run #49 取代）没有成果，不能再给用户升起一条 blocker（启动修复必须有界）。
    if (!isLatestDeliveryRun(db, input.itemId, input.runId)) return false;
    if (getOutcomeSnapshotForRun(db, input.runId)) return false;
    const checkpointKey = `outcome-registration-missing:${input.runId}`;
    if (db.prepare("SELECT 1 FROM checkpoints WHERE idempotency_key=?").get(checkpointKey)) return false;
    const at = input.at ?? new Date();
    createCheckpointDomainService({ db, now: () => at }).recordSystemCheckpoint({
      itemId: input.itemId,
      runId: input.runId,
      kind: "blocked",
      title: "Outcome registration missing",
      // 只说这个 Run 自己的结局。以前写 "reached ${item.stage}"：#66 上 Run #48 以 blocked 结束，
      // 工单是 3 秒前被 Run #49 推进 review 的，这句话却说 Run #48 进了 review。
      summary: `Run #${input.runId} ended without a structured outcome snapshot that could be recovered.`,
      nextStep: `Review the run log, then call register_run_outcome(ticket_id, run_id=${input.runId}, authority_ref) `
        + "to register the outcome the run actually reported; do not infer reviewer evidence from executor text.",
      keyFacts: [
        { label: "Run", value: `#${input.runId}` },
        { label: "Item status", value: item.stage },
      ],
      idempotencyKey: checkpointKey,
      leadVisible: true,
      precedingEvents: [runUpdatedEvent(input.itemId, input.runId, at)],
    });
    raiseBlocker(db, {
      // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
      needsUser: false,
      itemId: input.itemId,
      runId: input.runId,
      code: "outcome_registration_missing",
      payloadKind: "outcome_registration_missing",
      title: "Outcome registration missing",
      summary: `Run #${input.runId} has no structured outcome snapshot.`,
      nextStep: `Call register_run_outcome for run #${input.runId} to register the outcome it actually reported, `
        + "or record that the historical outcome is unrecoverable.",
      source: "structural",
      dedupKey: checkpointKey,
      evidence: { runId: input.runId, itemStage: item.stage },
      at,
    });
    if (input.demoteUnrecoveredReview && isLatestDeliveryRun(db, input.itemId, input.runId)) {
      transition(db, {
        itemId: input.itemId,
        to: "blocked",
        actor: "system",
        reason: `outcome self-recovery failed: run #${input.runId} ended without a registrable outcome`,
        runId: input.runId,
        now: at,
      });
    }
    return true;
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

/**
 * Child 已经正常结束，但信封校验失败。这是宿主收口缺陷，不是 Claude/Codex/Pi 没跑完。
 * 抛出校验错误会变成 unhandled_run_exception，界面误写成“运行失败”，重试闸门也不计数，
 * 于是同一缺陷会被再派一次。这里必须停在 blocked，并要求用户确认后再动账本。
 */
export function recordInvalidOutcomeEnvelope(
  db: Db,
  input: {
    itemId: number;
    runId: number;
    at?: Date;
    reason?: string | null;
    demoteLatestExecutor?: boolean;
  },
): boolean {
  const write = (): boolean => {
    const item = getItem(db, input.itemId);
    const run = getRun(db, input.runId);
    if (!item || !run || run.item_id !== input.itemId || !isDeliveryRun(run)) return false;
    if (["done", "cancelled", "acked"].includes(item.stage)) return false;
    if (getOutcomeSnapshotForRun(db, input.runId)) return false;
    const checkpointKey = `invalid-outcome-envelope:${input.runId}`;
    if (db.prepare("SELECT 1 FROM checkpoints WHERE idempotency_key=?").get(checkpointKey)) return false;
    const at = input.at ?? new Date();
    const reason = (input.reason ?? "outcome envelope is invalid")
      .split(/\r?\n/)[0]
      ?.replace(/^Error:\s*/, "")
      .slice(0, 200) ?? "outcome envelope is invalid";
    createCheckpointDomainService({ db, now: () => at }).recordSystemCheckpoint({
      itemId: input.itemId,
      runId: input.runId,
      kind: "blocked",
      title: "成果登记失败",
      summary: `Run #${input.runId} 已结束，但成果信封无法写入账本（${reason}）。`
        + "这是系统收口问题，不是执行器没跑完。",
      nextStep: "请确认是否先修成果登记，还是授权后再试。不要在同一缺陷上再派一次。",
      keyFacts: [
        { label: "Run", value: `#${input.runId}` },
        { label: "原因", value: reason.slice(0, 240) },
      ],
      idempotencyKey: checkpointKey,
      leadVisible: true,
      precedingEvents: [runUpdatedEvent(input.itemId, input.runId, at)],
    });
    raiseBlocker(db, {
      // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
      needsUser: false,
      itemId: input.itemId,
      runId: input.runId,
      code: "invalid_outcome_envelope",
      payloadKind: "invalid_outcome_envelope",
      title: "成果登记失败",
      summary: `Run #${input.runId} 的成果信封校验失败：${reason}`,
      nextStep: "请确认是否先修成果登记，还是授权后再试。不要在同一缺陷上再派一次。",
      source: "structural",
      dedupKey: checkpointKey,
      intervention: "propose",
      leadNextStep: `不要 spawn_child 或 recover_ticket_run 换 runtime。检查 Run #${input.runId} 的成果信封，`
        + "等用户确认后再登记或开宿主修复。",
      evidence: { runId: input.runId, itemStage: item.stage, reason },
      at,
    });
    addActivity(db, {
      itemId: input.itemId,
      runId: input.runId,
      actor: "system",
      kind: "decision",
      payload: {
        decision: "invalid_outcome_envelope",
        runId: input.runId,
        reason,
      },
    });
    if (input.demoteLatestExecutor && isLatestDeliveryRun(db, input.itemId, input.runId)
        && ["active", "review"].includes(item.stage)) {
      transition(db, {
        itemId: input.itemId,
        to: "blocked",
        actor: "system",
        reason: `outcome envelope invalid: run #${input.runId} ended without a registrable outcome`,
        runId: input.runId,
        now: at,
      });
    }
    return true;
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

export type ExplicitOutcomeRegistrationStatus =
  | "registered"
  | "already_present"
  | "no_envelope"
  | "invalid_envelope"
  | "not_recoverable";

export interface ExplicitOutcomeRegistrationResult {
  status: ExplicitOutcomeRegistrationStatus;
  snapshotId: number | null;
  completeness: OutcomeCompleteness | null;
  clearedRegistrationBlocker: boolean;
}

/**
 * Clears the *actionable* half of an `outcome_registration_missing` blocker once
 * the outcome has actually been registered. The blocked checkpoint stays: "no
 * outcome was registered when this run ended" remains a true historical fact.
 * Only the inbox item and the notification are removed, because those two claim
 * "someone still has to do something about this", which is no longer true.
 */
export function clearOutcomeRegistrationBlocker(db: Db, runId: number): boolean {
  // 三种登记 blocker 的去重键，也是它们检查点的幂等键。
  // registration_pending 来自工单 07：登记的某一步抛错。成果登记成功后，它同样不再成立。
  const keys = [
    `outcome-registration-missing:${runId}`,
    `invalid-outcome-envelope:${runId}`,
    `registration-pending:${runId}`,
  ];
  const inbox = db.prepare(
    `DELETE FROM inbox
     WHERE json_extract(payload, '$.runId')=?
       AND json_extract(payload, '$.blockerCode') IN (
         'outcome_registration_missing',
         'invalid_outcome_envelope',
         'registration_pending'
       )`,
  ).run(runId);
  // Notification bodies are human text, so key off the durable dedup key.
  const notifications = db.prepare("DELETE FROM notifications WHERE dedup_key IN (?, ?, ?)")
    .run(...keys.map((key) => `blocker:${key}`));
  // 启动时的补发可能为同一张检查点又升起一条 blocker。它也不再成立。
  const copies = retractCheckpointBlockers(db, keys);
  return inbox.changes > 0 || notifications.changes > 0 || copies > 0;
}

/**
 * Explicit, authority-carrying registration for one named executor run.
 *
 * `repairOutcomeSnapshots` deliberately refuses to touch runs that finished
 * before the outcome feature rolled out (schema migration 20), so that a new
 * ledger feature cannot invent history or manufacture blockers for accepted
 * work. The cost of that rule is that a run which *did* emit a real
 * `PLC_OUTCOME_V1` envelope, but completed while the host was still running
 * pre-feature code, has no way back into the registry at all.
 *
 * This is that way back, and it is deliberately narrow:
 *   - it only ever reads evidence already on record in `runtime_events`; with no
 *     envelope it registers nothing and says so, rather than synthesising a
 *     summary from run text;
 *   - it requires an explicit `authorityRef`, recorded in the ledger, so the
 *     registration is attributable rather than ambient;
 *   - it never transitions a terminal item and never fabricates reviewer
 *     evidence — registering the executor's own outcome is not acceptance.
 */
export function registerOutcomeForRun(
  db: Db,
  input: { itemId: number; runId: number; authorityRef: string; at?: Date },
): ExplicitOutcomeRegistrationResult {
  const authorityRef = input.authorityRef.trim();
  if (!authorityRef) throw new Error("registerOutcomeForRun requires an authority_ref");
  const write = (): ExplicitOutcomeRegistrationResult => {
    if (!getItem(db, input.itemId)) throw new Error(`item #${input.itemId} not found`);
    const run = getRun(db, input.runId);
    if (!run || run.item_id !== input.itemId) {
      throw new Error(`run #${input.runId} does not belong to item #${input.itemId}`);
    }
    const at = input.at ?? new Date();
    const recovered = recoverOutcomeSnapshot(db, {
      itemId: input.itemId,
      runId: input.runId,
      at,
    });
    if (recovered.status === "already_present") {
      return {
        status: "already_present",
        snapshotId: recovered.snapshotId,
        completeness: recovered.completeness,
        clearedRegistrationBlocker: false,
      };
    }
    if (recovered.status !== "recovered") {
      const status = recovered.status === "no_envelope"
        ? "no_envelope"
        : recovered.status === "invalid_envelope"
          ? "invalid_envelope"
          : "not_recoverable";
      return {
        status,
        snapshotId: null,
        completeness: null,
        clearedRegistrationBlocker: false,
      };
    }
    const { clearedRegistrationBlocker } = recovered;
    addActivity(db, {
      itemId: input.itemId,
      runId: input.runId,
      actor: "lead",
      kind: "decision",
      payload: {
        decision: "outcome_registered_from_run_evidence",
        runId: input.runId,
        snapshotId: recovered.snapshotId,
        completeness: recovered.completeness,
        authorityRef,
        clearedRegistrationBlocker,
      },
    });
    publishGatewayEvents(db, [
      runUpdatedEvent(input.itemId, input.runId, at),
      itemUpdatedEvent(input.itemId, at),
    ]);
    return {
      status: "registered",
      snapshotId: recovered.snapshotId,
      completeness: recovered.completeness,
      clearedRegistrationBlocker,
    };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

// 成果功能上线（迁移 20）之后结束的 Run。启动修复只碰这些 Run，不回填历史数据。
// 这是一段固定的 SQL，要求 runs 的别名是 r。
export const AFTER_OUTCOME_ROLLOUT_SQL = `datetime(COALESCE(r.ended_at, r.started_at)) >= datetime(COALESCE(
         (SELECT applied_at FROM schema_migrations WHERE version=20),
         '9999-12-31 23:59:59'
       ))`;

export function repairOutcomeSnapshots(db: Db, at = new Date()): number {
  // 重新登记（工单 08）负责的登记待处理 Run，这里不碰。重新登记按现有规则推进 stage，并且隔离宿主缺陷。
  // 这里再恢复一次会有两个问题。宿主缺陷还在时，抛错会让 daemon 启动失败。
  // 宿主修好时，成果补上了，工单却留在 blocked。
  // 修复回合（工单 09）也不碰：它的成果登记在来源 Run 上，它自己没有成果快照。
  const candidates = db.prepare(
    `SELECT r.id AS run_id, r.item_id
     FROM runs r
     WHERE r.state='finished' AND ${deliveryRunSql("r")}
       AND ${AFTER_OUTCOME_ROLLOUT_SQL}
       AND NOT (
         COALESCE(json_extract(r.metadata, '$.registration.state'), '') = 'pending'
         AND ${REREGISTRATION_SCOPE_SQL}
       )
       AND NOT EXISTS (
         SELECT 1 FROM outcome_snapshots snapshot
         WHERE snapshot.executor_run_id=r.id
       )
     ORDER BY r.id`,
  ).all() as Array<{ run_id: number; item_id: number }>;
  let repaired = 0;
  for (const candidate of candidates) {
    const result = recoverOutcomeSnapshot(db, {
      itemId: candidate.item_id,
      runId: candidate.run_id,
      at,
    });
    if (result.status === "recovered") {
      repaired++;
      publishGatewayEvents(db, [
        runUpdatedEvent(candidate.item_id, candidate.run_id, at),
        itemUpdatedEvent(candidate.item_id, at),
      ]);
      continue;
    }
    if (result.status === "no_envelope"
        && recordOutcomeRegistrationMissing(db, {
          itemId: candidate.item_id,
          runId: candidate.run_id,
          at,
        })) {
      repaired++;
    }
  }
  return repaired;
}
