// 核查包和逐条结论的存和取（v57，工单详情与验收 spec 5.7、5.9、D8，工单 10）。表的说明在 schema.ts 的 REVIEW_PACKETS_SCHEMA。
// 核查包由 engine 的 review-packet.ts 拼，这里只存和取。「有没有结论」仍看 review_verdicts（总结论和证据）；
// 这里存的是结论里结构化的那一部分（逐条结论、escalate），结论落定以后不能再改（触发器）。
import type {
  ReviewCriterionResult, ReviewCriterionVerdict, ReviewEscalation, ReviewEscalationReason, ReviewPacket, ReviewPacketSummary,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export interface StoredReviewPacket {
  runId: number;
  itemId: number;
  executorRunId: number | null;
  deliverySequence: number | null;
  deliverySnapshotId: number | null;
  previousRunId: number | null;
  packet: ReviewPacket;
  summary: ReviewPacketSummary;
  createdAt: string;
}

interface ReviewPacketRow {
  run_id: number;
  item_id: number;
  executor_run_id: number | null;
  delivery_sequence: number | null;
  delivery_snapshot_id: number | null;
  previous_run_id: number | null;
  packet_json: string;
  summary_json: string;
  created_at: string;
}

function packetOf(row: ReviewPacketRow): StoredReviewPacket {
  return {
    runId: row.run_id,
    itemId: row.item_id,
    executorRunId: row.executor_run_id,
    deliverySequence: row.delivery_sequence,
    deliverySnapshotId: row.delivery_snapshot_id,
    previousRunId: row.previous_run_id,
    packet: JSON.parse(row.packet_json) as ReviewPacket,
    summary: JSON.parse(row.summary_json) as ReviewPacketSummary,
    createdAt: row.created_at,
  };
}

export function getReviewPacket(db: Db, runId: number): StoredReviewPacket | undefined {
  const row = db.prepare("SELECT * FROM review_packets WHERE run_id=?").get(runId) as ReviewPacketRow | undefined;
  return row ? packetOf(row) : undefined;
}

export interface RecordReviewPacketInput {
  runId: number;
  itemId: number;
  executorRunId: number | null;
  deliverySequence: number | null;
  deliverySnapshotId: number | null;
  previousRunId: number | null;
  packet: ReviewPacket;
  summary: ReviewPacketSummary;
  now?: Date;
}

/**
 * 存一个核查 Run 的核查包。已经有一份时不再存，返回已有的那一份：开新会话重试、续接都给核查员同一份（存下以后不改）。
 */
export function recordReviewPacket(db: Db, input: RecordReviewPacketInput): StoredReviewPacket {
  return db.transaction((): StoredReviewPacket => {
    const existing = getReviewPacket(db, input.runId);
    if (existing) return existing;
    db.prepare(
      `INSERT INTO review_packets (
         run_id, item_id, executor_run_id, delivery_sequence, delivery_snapshot_id, previous_run_id, packet_json, summary_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId, input.itemId, input.executorRunId, input.deliverySequence, input.deliverySnapshotId, input.previousRunId,
      JSON.stringify(input.packet), JSON.stringify(input.summary), (input.now ?? new Date()).toISOString(),
    );
    return getReviewPacket(db, input.runId)!;
  })();
}

export interface ReviewVerdictDetails {
  runId: number;
  itemId: number;
  executorRunId: number | null;
  escalate: ReviewEscalation | null;
  criteria: ReviewCriterionVerdict[];
  submittedAt: string;
}

export interface ReviewVerdictDetailsInput {
  runId: number;
  itemId: number;
  executorRunId: number | null;
  escalate: ReviewEscalation | null;
  criteria: ReviewCriterionVerdict[];
  now?: Date;
}

interface DetailsRow {
  run_id: number;
  item_id: number;
  executor_run_id: number | null;
  escalate_reason: ReviewEscalationReason | null;
  escalate_note: string | null;
  submitted_at: string;
}

interface CriterionVerdictRow {
  criterion_id: number;
  criterion_revision: number;
  position: number;
  result: ReviewCriterionResult;
  evidence: string;
}

export function getReviewVerdictDetails(db: Db, runId: number): ReviewVerdictDetails | undefined {
  const row = db.prepare("SELECT * FROM review_verdict_details WHERE run_id=?").get(runId) as DetailsRow | undefined;
  if (!row) return undefined;
  const criteria = (db.prepare(
    `SELECT criterion_id, criterion_revision, position, result, evidence FROM review_criterion_verdicts
     WHERE run_id=? ORDER BY position, criterion_id`,
  ).all(runId) as CriterionVerdictRow[]).map((entry) => ({
    criterionId: entry.criterion_id,
    number: entry.position,
    revision: entry.criterion_revision,
    result: entry.result,
    evidence: entry.evidence,
  }));
  return {
    runId: row.run_id,
    itemId: row.item_id,
    executorRunId: row.executor_run_id,
    escalate: row.escalate_reason && row.escalate_note ? { reason: row.escalate_reason, note: row.escalate_note } : null,
    criteria,
    submittedAt: row.submitted_at,
  };
}

/**
 * 写下核查员交的结构化结论（整行替换）。结论已经在 review_verdicts 落定时，触发器拒绝替换。
 * 调用方先核对过逐条结论和核查包对得上（engine 的 review-verdict.ts）。
 */
export function writeReviewVerdictDetails(db: Db, input: ReviewVerdictDetailsInput): void {
  db.transaction(() => {
    db.prepare("DELETE FROM review_criterion_verdicts WHERE run_id=?").run(input.runId);
    db.prepare("DELETE FROM review_verdict_details WHERE run_id=?").run(input.runId);
    db.prepare(
      `INSERT INTO review_verdict_details (run_id, item_id, executor_run_id, escalate_reason, escalate_note, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId, input.itemId, input.executorRunId, input.escalate?.reason ?? null, input.escalate?.note ?? null,
      (input.now ?? new Date()).toISOString(),
    );
    const insert = db.prepare(
      `INSERT INTO review_criterion_verdicts (
         run_id, item_id, executor_run_id, criterion_id, criterion_revision, position, result, evidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of input.criteria) {
      insert.run(
        input.runId, input.itemId, input.executorRunId, entry.criterionId, entry.revision, entry.number, entry.result, entry.evidence,
      );
    }
  })();
}

/** 结论的结构化部分有没有变（同一个结论重交时只能一字不差）。 */
export function sameReviewVerdictDetails(
  existing: Pick<ReviewVerdictDetails, "escalate" | "criteria">,
  next: Pick<ReviewVerdictDetailsInput, "escalate" | "criteria">,
): boolean {
  return JSON.stringify({ escalate: existing.escalate, criteria: existing.criteria })
    === JSON.stringify({ escalate: next.escalate, criteria: next.criteria });
}
