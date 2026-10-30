import type { Db } from "./db.js";
import type { ItemPriority, RuntimeId, VerificationPolicy } from "@pi-lead-child/core";

export type ContinuationEventType =
  | "review_passed"
  | "review_failed"
  | "capability_deployed"
  | "dependency_satisfied"
  | "automation_blocked";

export type ContinuationState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "waiting_user"
  | "waiting_dependency"
  | "waiting_capability";

export type ContinuationAction =
  | { type: "wait_for_capability"; capabilityId: number }
  | {
      type: "create_task";
      key: string;
      title: string;
      brief: string;
      workdir?: string;
      priority?: ItemPriority;
      project?: string;
      runtime?: RuntimeId;
      model?: string;
      verificationPolicy?: VerificationPolicy;
      relations?: Array<{
        targetTicketId: number;
        relationType: "depends_on" | "implements" | "duplicates" | "supersedes" | "relates_to";
        reason: string;
      }>;
      requestDispatch?: boolean;
    }
  | {
      type: "link_tickets";
      sourceTicketKey?: string;
      sourceTicketId?: number;
      targetTicketId: number;
      relationType: "depends_on" | "implements" | "duplicates" | "supersedes" | "relates_to";
      reason: string;
    }
  | { type: "request_dispatch"; ticketKey?: string; ticketId?: number };

export interface ContinuationRow {
  id: number;
  item_id: number | null;
  delegation_policy_id: number | null;
  trigger_event: ContinuationEventType;
  action_sequence: string;
  context: string;
  current_step: number;
  state: ContinuationState;
  idempotency_key: string;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ContinuationEventRow {
  id: number;
  item_id: number | null;
  event_type: ContinuationEventType;
  payload: string;
  idempotency_key: string;
  state: "pending" | "processed" | "failed";
  created_at: string;
  processed_at: string | null;
  error: string | null;
}

export interface ContinuationContext {
  createdTickets?: Record<string, number>;
  [key: string]: unknown;
}

export function parseContinuationActions(raw: string): ContinuationAction[] {
  const parsed = JSON.parse(raw || "[]") as unknown;
  if (!Array.isArray(parsed)) throw new Error("continuation action_sequence must be an array");
  return parsed as ContinuationAction[];
}

export function parseContinuationContext(raw: string): ContinuationContext {
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as ContinuationContext;
}

export function enqueueContinuationEvent(
  db: Db,
  input: {
    itemId?: number | null;
    eventType: ContinuationEventType;
    payload?: unknown;
    idempotencyKey: string;
  },
): number {
  const existing = db.prepare("SELECT id FROM continuation_events WHERE idempotency_key=?")
    .get(input.idempotencyKey) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare(
    `INSERT INTO continuation_events (item_id, event_type, payload, idempotency_key)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.itemId ?? null,
    input.eventType,
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey,
  );
  return Number(result.lastInsertRowid);
}

export function createContinuation(
  db: Db,
  input: {
    itemId?: number | null;
    delegationPolicyId?: number | null;
    triggerEvent: ContinuationEventType;
    actions: ContinuationAction[];
    context?: ContinuationContext;
    idempotencyKey: string;
    maxRetries?: number;
  },
): number {
  const existing = db.prepare("SELECT id FROM continuations WHERE idempotency_key=?")
    .get(input.idempotencyKey) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare(
    `INSERT INTO continuations (
       item_id, delegation_policy_id, trigger_event, action_sequence, context,
       idempotency_key, max_retries
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.itemId ?? null,
    input.delegationPolicyId ?? null,
    input.triggerEvent,
    JSON.stringify(input.actions),
    JSON.stringify(input.context ?? {}),
    input.idempotencyKey,
    input.maxRetries ?? 3,
  );
  return Number(result.lastInsertRowid);
}

export function runnableContinuations(db: Db, now: Date = new Date()): ContinuationRow[] {
  return db.prepare(
    `SELECT * FROM continuations
     WHERE state IN ('pending','running','waiting_dependency','waiting_capability')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY id`,
  ).all(now.toISOString()) as ContinuationRow[];
}

export function pendingContinuationEvents(db: Db, limit = 100): ContinuationEventRow[] {
  return db.prepare(
    `SELECT * FROM continuation_events
     WHERE state='pending'
     ORDER BY id
     LIMIT ?`,
  ).all(limit) as ContinuationEventRow[];
}

export function updateContinuationEventState(
  db: Db,
  id: number,
  input: { state: ContinuationEventRow["state"]; error?: string | null; processedAt?: Date },
): void {
  db.prepare(
    `UPDATE continuation_events
     SET state=?,
         processed_at=CASE WHEN ? IN ('processed','failed') THEN COALESCE(processed_at, ?) ELSE processed_at END,
         error=?
     WHERE id=?`,
  ).run(
    input.state,
    input.state,
    (input.processedAt ?? new Date()).toISOString(),
    input.error ?? null,
    id,
  );
}

export function updateContinuationState(
  db: Db,
  id: number,
  input: {
    state: ContinuationState;
    currentStep?: number;
    context?: ContinuationContext;
    lastError?: string | null;
    nextRetryAt?: string | null;
    incrementRetry?: boolean;
  },
): void {
  const sets = ["state=?", "updated_at=datetime('now')"];
  const values: unknown[] = [input.state];
  if (input.currentStep !== undefined) {
    sets.push("current_step=?");
    values.push(input.currentStep);
  }
  if (input.context !== undefined) {
    sets.push("context=?");
    values.push(JSON.stringify(input.context));
  }
  if (input.lastError !== undefined) {
    sets.push("last_error=?");
    values.push(input.lastError);
  }
  if (input.nextRetryAt !== undefined) {
    sets.push("next_retry_at=?");
    values.push(input.nextRetryAt);
  }
  if (input.incrementRetry) sets.push("retry_count=retry_count+1");
  if (input.state === "succeeded" || input.state === "failed" || input.state === "waiting_user") {
    sets.push("completed_at=COALESCE(completed_at, datetime('now'))");
  }
  values.push(id);
  db.prepare(`UPDATE continuations SET ${sets.join(", ")} WHERE id=?`).run(...values);
}
