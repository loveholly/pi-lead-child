import type { CheckpointPolicyConfig } from "@pi-lead-child/core";
import { getCheckpoint } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { timestampEpoch } from "@pi-lead-child/store";
import type { Checkpoint, CheckpointFact, CheckpointKind } from "@pi-lead-child/core";

export interface AgentCheckpointPolicyInput {
  itemId: number;
  runId: number;
  kind: CheckpointKind;
  stage?: string | null;
  title: string;
  summary: string;
  keyFacts?: CheckpointFact[];
  artifactRefs?: string[];
  artifactIdentities?: Array<{
    ref: string;
    sha256: string | null;
    byteLength: number | null;
  }>;
  relatedItemIds?: number[];
  nextStep?: string | null;
  progress?: Checkpoint["progress"];
  proofItems?: Checkpoint["proofItems"];
}

export interface CheckpointPolicyState {
  runStartedAt: string;
  lastCheckpointAt: string | null;
  lastCheckpointRuntimeSeq: number | null;
  completedToolEventsSinceCheckpoint: number;
  domainEventsSinceCheckpoint: number;
  childItemsSinceCheckpoint: number;
  reminderSentAt: string | null;
}

export class CheckpointRateLimitError extends Error {
  readonly code = "rate_limited";

  constructor(readonly retryAfterMs: number) {
    super(`rate_limited: progress checkpoint available in ${retryAfterMs}ms`);
    this.name = "CheckpointRateLimitError";
  }
}

export function assertActiveAgentRun(
  db: Db,
  input: { itemId: number; runId: number },
): void {
  const item = db.prepare(
    "SELECT kind, stage FROM items WHERE id=?",
  ).get(input.itemId) as { kind: string; stage: string } | undefined;
  if (!item) throw new Error(`item #${input.itemId} not found`);
  if (["done", "cancelled", "acked"].includes(item.stage)) {
    throw new Error(`item #${input.itemId} is terminal (${item.stage}); agent intervention is not allowed`);
  }
  const run = db.prepare(
    "SELECT item_id, role, state FROM runs WHERE id=?",
  ).get(input.runId) as {
    item_id: number; role: "executor" | "reviewer"; state: string;
  } | undefined;
  if (!run || run.item_id !== input.itemId) {
    throw new Error(`run #${input.runId} does not belong to item #${input.itemId}`);
  }
  if (!["starting", "running"].includes(run.state)) {
    throw new Error(`run #${input.runId} is not the current active run`);
  }
  const current = db.prepare(
    `SELECT id FROM runs
     WHERE item_id=? AND role=? AND state IN ('starting','running')
     ORDER BY id DESC LIMIT 1`,
  ).get(input.itemId, run.role) as { id: number } | undefined;
  if (current?.id !== input.runId) {
    throw new Error(`run #${input.runId} is superseded by current run #${current?.id ?? "none"}`);
  }
}

function normalizedSemantic(input: AgentCheckpointPolicyInput) {
  return {
    kind: input.kind,
    stage: input.stage?.trim() || null,
    title: input.title.trim(),
    summary: input.summary.trim(),
    keyFacts: (input.keyFacts ?? []).map((fact) => ({
      label: fact.label.trim(), value: fact.value.trim(),
    })),
    artifactRefs: (input.artifactRefs ?? []).map((value) => value.trim()),
    artifactIdentities: (input.artifactIdentities ?? []).map((artifact) => ({
      ref: artifact.ref.trim(),
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    })),
    relatedItemIds: [...(input.relatedItemIds ?? [])],
    nextStep: input.nextStep?.trim() || null,
    progress: input.progress === undefined || input.progress === null
      ? null
      : {
          current: input.progress.current,
          total: input.progress.total,
          label: input.progress.label?.trim() || null,
        },
    proofItems: (input.proofItems ?? []).map((item) => ({
      id: item.id,
      label: item.label.trim(),
      state: item.state,
      evidence: item.evidence?.trim() || null,
    })),
  };
}

function checkpointArtifactIdentities(db: Db, checkpointId: number) {
  return db.prepare(
    `SELECT ref, sha256, byte_length AS byteLength
     FROM artifacts WHERE checkpoint_id=? ORDER BY id`,
  ).all(checkpointId) as Array<{
    ref: string;
    sha256: string | null;
    byteLength: number | null;
  }>;
}

function sameSemantic(db: Db, checkpoint: Checkpoint, input: AgentCheckpointPolicyInput): boolean {
  const normalized = normalizedSemantic(input);
  return checkpoint.kind === normalized.kind
    && checkpoint.stage === normalized.stage
    && checkpoint.title === normalized.title
    && checkpoint.summary === normalized.summary
    && JSON.stringify(checkpoint.keyFacts) === JSON.stringify(normalized.keyFacts)
    && JSON.stringify(checkpoint.artifactRefs) === JSON.stringify(normalized.artifactRefs)
    && JSON.stringify(checkpointArtifactIdentities(db, checkpoint.id))
      === JSON.stringify(normalized.artifactIdentities)
    && JSON.stringify(checkpoint.relatedItemIds) === JSON.stringify(normalized.relatedItemIds)
    && checkpoint.nextStep === normalized.nextStep
    && JSON.stringify(checkpoint.progress) === JSON.stringify(normalized.progress)
    && JSON.stringify(checkpoint.proofItems) === JSON.stringify(normalized.proofItems)
    && checkpoint.actionRef === null;
}

export function enforceStandaloneCheckpointPolicy(
  db: Db,
  input: AgentCheckpointPolicyInput,
  config: CheckpointPolicyConfig,
  now: Date,
  options?: { exactReplay?: "bounded" | "unbounded" },
): Checkpoint | null {
  const unbounded = options?.exactReplay === "unbounded";
  const dedupeThreshold = new Date(now.getTime() - config.dedupeWindowMs).toISOString();
  const recent = db.prepare(
    `SELECT id FROM checkpoints
     WHERE run_id=? AND source='agent_reported'
       ${unbounded ? "" : "AND julianday(created_at) >= julianday(?)"}
     ORDER BY id DESC`,
  ).all(...(unbounded ? [input.runId] : [input.runId, dedupeThreshold])) as Array<{ id: number }>;
  for (const row of recent) {
    const checkpoint = getCheckpoint(db, row.id);
    if (checkpoint && sameSemantic(db, checkpoint, input)) return checkpoint;
  }

  if (input.kind !== "progress") return null;
  const latest = db.prepare(
    `SELECT created_at FROM checkpoints
     WHERE run_id=? AND source='agent_reported' AND kind='progress'
     ORDER BY id DESC LIMIT 1`,
  ).get(input.runId) as { created_at: string } | undefined;
  if (!latest) return null;
  const elapsed = now.getTime() - Date.parse(latest.created_at);
  if (Number.isFinite(elapsed) && elapsed < config.progressMinIntervalMs) {
    throw new CheckpointRateLimitError(config.progressMinIntervalMs - Math.max(0, elapsed));
  }
  return null;
}

function scalarCount(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

export function readCheckpointPolicyState(
  db: Db,
  input: { itemId: number; runId: number },
): CheckpointPolicyState {
  const run = db.prepare(
    "SELECT item_id, started_at FROM runs WHERE id=?",
  ).get(input.runId) as { item_id: number; started_at: string } | undefined;
  if (!run || run.item_id !== input.itemId) {
    throw new Error(`run #${input.runId} does not belong to item #${input.itemId}`);
  }
  const latestCheckpoint = db.prepare(
    `SELECT created_at FROM checkpoints
     WHERE item_id=? AND (run_id=? OR run_id IS NULL)
       AND julianday(created_at) >= julianday(?)
     ORDER BY id DESC LIMIT 1`,
  ).get(input.itemId, input.runId, run.started_at) as { created_at: string } | undefined;
  const baseline = latestCheckpoint?.created_at ?? run.started_at;
  const lastCheckpointRuntimeSeq = latestCheckpoint
    ? (db.prepare(
        `SELECT MAX(seq) AS seq FROM runtime_events
         WHERE run_id=? AND julianday(occurred_at) <= julianday(?)`,
      ).get(input.runId, latestCheckpoint.created_at) as { seq: number | null }).seq
    : null;
  const completedToolEventsSinceCheckpoint = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM runtime_events
     WHERE run_id=? AND event_type='tool.completed' AND seq > ?`,
    input.runId,
    lastCheckpointRuntimeSeq ?? 0,
  );
  const domainEventsSinceCheckpoint = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM activities
     WHERE item_id=? AND julianday(created_at) > julianday(?)
       AND kind IN ('transition','milestone','decision','notification')
       AND json_extract(payload, '$.checkpointId') IS NULL
       AND COALESCE(json_extract(payload, '$.kind'), '') NOT IN
         ('checkpoint_reminder','watchdog_stall')`,
    input.itemId,
    baseline,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM item_plan_revisions
     WHERE parent_item_id=? AND sealed_at IS NOT NULL
       AND julianday(sealed_at) > julianday(?)`,
    input.itemId,
    baseline,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM approvals
     WHERE item_id=? AND julianday(created_at) > julianday(?)`,
    input.itemId,
    baseline,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM decision_requests
     WHERE item_id=? AND julianday(created_at) > julianday(?)`,
    input.itemId,
    baseline,
  );
  const childItemsSinceCheckpoint = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM items
     WHERE parent_item_id=? AND (
       julianday(created_at) > julianday(?)
       OR (closed_at IS NOT NULL AND julianday(closed_at) > julianday(?))
     )`,
    input.itemId,
    baseline,
    baseline,
  );
  const reminder = db.prepare(
    `SELECT created_at FROM activities
     WHERE item_id=? AND run_id=? AND kind='notification'
       AND json_extract(payload, '$.kind')='checkpoint_reminder'
     ORDER BY id DESC LIMIT 1`,
  ).get(input.itemId, input.runId) as { created_at: string } | undefined;

  return {
    runStartedAt: run.started_at,
    lastCheckpointAt: latestCheckpoint?.created_at ?? null,
    lastCheckpointRuntimeSeq,
    completedToolEventsSinceCheckpoint,
    domainEventsSinceCheckpoint,
    childItemsSinceCheckpoint,
    reminderSentAt: reminder?.created_at ?? null,
  };
}

function elapsedMs(from: string, to: Date): number {
  const parsed = timestampEpoch(from);
  return parsed === null ? -1 : to.getTime() - parsed;
}

export function checkpointReminderDue(
  state: CheckpointPolicyState,
  config: CheckpointPolicyConfig,
  now: Date,
): boolean {
  if (state.reminderSentAt !== null
      && elapsedMs(state.reminderSentAt, now) < config.reminderCooldownMs) {
    return false;
  }
  const baseline = state.lastCheckpointAt ?? state.runStartedAt;
  const toolThresholdReached = elapsedMs(baseline, now) >= config.silenceMs
    && state.completedToolEventsSinceCheckpoint >= config.silenceToolEvents;
  const domainThresholdReached = state.domainEventsSinceCheckpoint
    + state.childItemsSinceCheckpoint >= config.silenceDomainEvents;
  return toolThresholdReached || domainThresholdReached;
}
