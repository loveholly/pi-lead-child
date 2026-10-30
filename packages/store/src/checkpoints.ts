import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { appendEventGuarded, itemEntityKey } from "./events.js";
import type {
  Checkpoint,
  CheckpointActionRef,
  CheckpointFact,
  CheckpointKind,
  CheckpointProgress,
  CheckpointProofItem,
  CheckpointSource,
} from "@pi-lead-child/core";

const CHECKPOINT_KEYS = new Set([
  "itemId", "runId", "source", "kind", "stage", "title", "summary", "keyFacts",
  "artifactRefs", "relatedItemIds", "nextStep", "actionRef", "progress", "proofItems",
  "idempotencyKey",
]);
const CHECKPOINT_KINDS = new Set<CheckpointKind>([
  "progress", "milestone", "decision", "delegation", "blocked", "completed",
]);
const CHECKPOINT_SOURCES = new Set<CheckpointSource>(["agent_reported", "system_derived"]);
const CHECKPOINT_ACTION_TYPES = new Set<CheckpointActionRef["type"]>([
  "approval", "decision_request",
]);
const CHECKPOINT_PROOF_STATES = new Set<CheckpointProofItem["state"]>([
  "pending", "passed", "failed", "retired",
]);
const PROOF_ITEM_KEYS = new Set(["id", "label", "state", "evidence"]);
const PROGRESS_KEYS = new Set(["current", "total", "label"]);
const MAX_DOMAIN_INTEGER = 2_147_483_647;
const MAX_PROOF_ITEMS_PER_CHECKPOINT = 20;
const MAX_CURRENT_PROOF_ITEMS = 200;

export interface InsertCheckpointInput {
  itemId: number;
  runId: number | null;
  source: CheckpointSource;
  kind: CheckpointKind;
  stage?: string | null;
  title: string;
  summary: string;
  keyFacts?: CheckpointFact[];
  artifactRefs?: string[];
  relatedItemIds?: number[];
  nextStep?: string | null;
  actionRef?: CheckpointActionRef | null;
  progress?: CheckpointProgress | null;
  proofItems?: CheckpointProofItem[];
  idempotencyKey?: string | null;
}

export interface CheckpointPage {
  items: Checkpoint[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export interface InsertCheckpointResult {
  checkpoint: Checkpoint;
  deduplicated: boolean;
}

interface CheckpointRow {
  id: number;
  item_id: number;
  run_id: number | null;
  source: CheckpointSource;
  kind: CheckpointKind;
  stage: string | null;
  title: string;
  summary: string;
  key_facts: string;
  artifact_refs: string;
  related_item_ids: string;
  next_step: string | null;
  action_type: CheckpointActionRef["type"] | null;
  action_id: number | null;
  idempotency_key: string | null;
  content_hash: string;
  progress_current: number | null;
  progress_total: number | null;
  progress_label: string | null;
  proof_items: string;
  created_at: string;
  run_role: "executor" | "reviewer" | null;
  run_runtime: Checkpoint["author"]["runtime"];
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function requireString(value: string, field: string, min: number, max: number): void {
  const length = charLength(value);
  if (length < min || length > max) {
    throw new Error(`${field} must contain ${min}-${max} characters`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${field} field '${key}'`);
  }
}

function normalizeProgress(value: unknown): CheckpointProgress | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("progress must be an object or null");
  assertExactKeys(value, PROGRESS_KEYS, "progress");
  const current = value.current;
  const total = value.total;
  if (!Number.isSafeInteger(current) || Number(current) < 0 || Number(current) > MAX_DOMAIN_INTEGER) {
    throw new Error("progress current must be a safe integer in range");
  }
  if (!Number.isSafeInteger(total) || Number(total) < 1 || Number(total) > MAX_DOMAIN_INTEGER) {
    throw new Error("progress total must be a positive safe integer in range");
  }
  if (Number(current) > Number(total)) throw new Error("progress current may not exceed total");
  if (value.label !== null && value.label !== undefined && typeof value.label !== "string") {
    throw new Error("progress label must be a string or null");
  }
  const label = typeof value.label === "string" ? value.label.trim() || null : null;
  if (label) requireString(label, "progress label", 1, 120);
  return { current: Number(current), total: Number(total), label };
}

function normalizeProofItems(value: unknown, field = "proofItems"): CheckpointProofItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_PROOF_ITEMS_PER_CHECKPOINT) {
    throw new Error(`${field} may contain at most ${MAX_PROOF_ITEMS_PER_CHECKPOINT} entries`);
  }
  const ids = new Set<string>();
  return value.map((rawItem, index) => {
    if (!isRecord(rawItem)) throw new Error(`${field}[${index}] must be an object`);
    assertExactKeys(rawItem, PROOF_ITEM_KEYS, field);
    if (typeof rawItem.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(rawItem.id)) {
      throw new Error(`${field}[${index}] id is invalid`);
    }
    if (ids.has(rawItem.id)) throw new Error(`${field} contains duplicate id '${rawItem.id}'`);
    ids.add(rawItem.id);
    if (typeof rawItem.label !== "string") throw new Error(`${field}[${index}] label must be a string`);
    const label = rawItem.label.trim();
    requireString(label, "proof label", 1, 160);
    if (!CHECKPOINT_PROOF_STATES.has(rawItem.state as CheckpointProofItem["state"])) {
      throw new Error(`${field}[${index}] state is invalid`);
    }
    if (rawItem.evidence !== null && rawItem.evidence !== undefined && typeof rawItem.evidence !== "string") {
      throw new Error(`${field}[${index}] evidence must be a string or null`);
    }
    const evidence = typeof rawItem.evidence === "string" ? rawItem.evidence.trim() || null : null;
    if (evidence) requireString(evidence, "proof evidence", 1, 1_000);
    return {
      id: rawItem.id,
      label,
      state: rawItem.state as CheckpointProofItem["state"],
      evidence,
    };
  });
}

export function parseStoredProofItems(serialized: string, checkpointId: number): CheckpointProofItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`checkpoint ${checkpointId} proof JSON is invalid`, { cause: error });
  }
  try {
    return normalizeProofItems(parsed, `checkpoint ${checkpointId} proof items`);
  } catch (error) {
    throw new Error(`checkpoint ${checkpointId} proof items are invalid: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

interface NormalizedCheckpointInput extends Required<
  Omit<InsertCheckpointInput, "idempotencyKey" | "progress" | "proofItems">
> {
  progress: CheckpointProgress | null;
  proofItems: CheckpointProofItem[];
  idempotencyKey: string | null;
}

function normalize(input: InsertCheckpointInput): NormalizedCheckpointInput {
  if (!isRecord(input)) throw new Error("checkpoint input must be an object");
  for (const key of Object.keys(input)) {
    if (!CHECKPOINT_KEYS.has(key)) throw new Error(`unknown checkpoint field '${key}'`);
  }
  if (!Number.isInteger(input.itemId) || input.itemId < 1) {
    throw new Error("itemId must be a positive integer");
  }
  if (input.runId !== null && (!Number.isInteger(input.runId) || input.runId < 1)) {
    throw new Error("runId must be a positive integer or null");
  }
  if (!CHECKPOINT_SOURCES.has(input.source)) throw new Error("invalid checkpoint source");
  if (!CHECKPOINT_KINDS.has(input.kind)) throw new Error("invalid checkpoint kind");
  if (!Array.isArray(input.keyFacts ?? [])) throw new Error("keyFacts must be an array");
  if (!Array.isArray(input.artifactRefs ?? [])) throw new Error("artifactRefs must be an array");
  if (!Array.isArray(input.relatedItemIds ?? [])) {
    throw new Error("relatedItemIds must be an array");
  }
  const keyFacts = (input.keyFacts ?? []).map((fact, index) => {
    if (!isRecord(fact)) throw new Error(`keyFacts[${index}] must be an object`);
    assertExactKeys(fact, new Set(["label", "value"]), "keyFacts");
    if (typeof fact.label !== "string" || typeof fact.value !== "string") {
      throw new Error(`keyFacts[${index}] label and value must be strings`);
    }
    const normalizedFact = { label: fact.label.trim(), value: fact.value.trim() };
    requireString(normalizedFact.label, "keyFacts label", 1, 80);
    requireString(normalizedFact.value, "keyFacts value", 1, 240);
    return normalizedFact;
  });
  const artifactRefs = (input.artifactRefs ?? []).map((artifactRef, index) => {
    if (typeof artifactRef !== "string" || !artifactRef.trim()) {
      throw new Error(`artifactRefs[${index}] must be a non-empty string`);
    }
    return artifactRef.trim();
  });
  const relatedItemIds = (input.relatedItemIds ?? []).map((itemId, index) => {
    if (!Number.isInteger(itemId) || itemId < 1) {
      throw new Error(`relatedItemIds[${index}] must be a positive integer`);
    }
    return itemId;
  });
  let actionRef: CheckpointActionRef | null = null;
  if (input.actionRef !== undefined && input.actionRef !== null) {
    if (!isRecord(input.actionRef)) throw new Error("actionRef must be an object or null");
    assertExactKeys(input.actionRef, new Set(["type", "id"]), "actionRef");
    if (!CHECKPOINT_ACTION_TYPES.has(input.actionRef.type as CheckpointActionRef["type"])) {
      throw new Error("invalid actionRef type");
    }
    if (!Number.isInteger(input.actionRef.id) || input.actionRef.id < 1) {
      throw new Error("actionRef id must be a positive integer");
    }
    actionRef = { type: input.actionRef.type as CheckpointActionRef["type"], id: input.actionRef.id };
  }
  const normalized = {
    itemId: input.itemId,
    runId: input.runId,
    source: input.source,
    kind: input.kind,
    stage: input.stage?.trim() || null,
    title: input.title.trim(),
    summary: input.summary.trim(),
    keyFacts,
    artifactRefs,
    relatedItemIds,
    nextStep: input.nextStep?.trim() || null,
    actionRef,
    progress: normalizeProgress(input.progress),
    proofItems: normalizeProofItems(input.proofItems),
    idempotencyKey: input.idempotencyKey ?? null,
  };
  requireString(normalized.title, "title", 1, 160);
  requireString(normalized.summary, "summary", 1, 2_000);
  if (normalized.stage) requireString(normalized.stage, "stage", 1, 120);
  if (normalized.nextStep) requireString(normalized.nextStep, "nextStep", 1, 500);
  if (normalized.keyFacts.length > 8) throw new Error("keyFacts may contain at most 8 entries");
  if (normalized.artifactRefs.length > 20) {
    throw new Error("artifactRefs may contain at most 20 entries");
  }
  if (normalized.relatedItemIds.length > 20) {
    throw new Error("relatedItemIds may contain at most 20 entries");
  }
  if (normalized.kind === "delegation" && normalized.relatedItemIds.length === 0) {
    throw new Error("delegation checkpoint requires a related item");
  }
  if (normalized.kind === "blocked" && !normalized.actionRef && !normalized.nextStep) {
    throw new Error("blocked checkpoint requires an action reference or next step");
  }
  if (normalized.source === "agent_reported" && normalized.runId === null) {
    throw new Error("agent_reported checkpoint requires an run");
  }
  if (normalized.source === "system_derived" && !normalized.idempotencyKey) {
    throw new Error("system_derived checkpoint requires an idempotency key");
  }
  return normalized;
}

function checkpointHash(input: ReturnType<typeof normalize>): string {
  const payload: Record<string, unknown> = {
    runId: input.runId,
    kind: input.kind,
    stage: input.stage,
    title: input.title,
    summary: input.summary,
    keyFacts: input.keyFacts,
    artifactRefs: input.artifactRefs,
    relatedItemIds: input.relatedItemIds,
    nextStep: input.nextStep,
    actionRef: input.actionRef,
  };
  if (input.progress !== null) payload.progress = input.progress;
  if (input.proofItems.length > 0) payload.proofItems = input.proofItems;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateRelations(db: Db, input: ReturnType<typeof normalize>): void {
  const item = db.prepare("SELECT 1 FROM items WHERE id = ?").get(input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  if (input.runId !== null) {
    const run = db.prepare("SELECT item_id, role, state FROM runs WHERE id = ?").get(input.runId) as
      { item_id: number; role: "executor" | "reviewer"; state: string } | undefined;
    if (!run) throw new Error(`run ${input.runId} not found`);
    if (run.item_id !== input.itemId) {
      throw new Error(`run ${input.runId} does not belong to item ${input.itemId}`);
    }
    if (input.source === "agent_reported" && !["starting", "running"].includes(run.state)) {
      throw new Error(`run ${input.runId} is not the current active run`);
    }
    if (input.source === "agent_reported") {
      const current = db.prepare(
        `SELECT id FROM runs
         WHERE item_id = ? AND role = ? AND state IN ('starting','running')
         ORDER BY id DESC LIMIT 1`,
      ).get(input.itemId, run.role) as { id: number } | undefined;
      if (current?.id !== input.runId) {
        throw new Error(`run ${input.runId} is superseded by current run ${current?.id ?? "none"}`);
      }
    }
  }
  if (!input.actionRef) return;
  const table = input.actionRef.type === "approval" ? "approvals" : "decision_requests";
  const authority = db.prepare(`SELECT item_id, ${
    input.actionRef.type === "approval" ? "status" : "state"
  } AS state FROM ${table} WHERE id = ?`).get(input.actionRef.id) as
    { item_id: number | null; state: string } | undefined;
  if (!authority) throw new Error(`${input.actionRef.type} ${input.actionRef.id} not found`);
  if (authority.item_id !== input.itemId) {
    throw new Error(`${input.actionRef.type} ${input.actionRef.id} belongs to another item`);
  }
  if (input.kind === "completed" && authority.state === "pending") {
    throw new Error("completed checkpoint cannot reference an unresolved blocker");
  }
}

interface CurrentProofRow {
  item_id: number;
  // proof item 的业务键。物理列 v16 起叫 proof_key，因为 item_id 已经让给了事项外键。
  proof_key: string;
  label: string;
  state: "pending" | "passed" | "failed";
  evidence: string | null;
  checkpoint_id: number;
  updated_at: string;
}

function applyProofUpdates(
  db: Db,
  itemId: number,
  checkpointId: number,
  proofItems: CheckpointProofItem[],
  updatedAt: string,
): void {
  if (proofItems.length === 0) return;
  const current = new Map(
    (db.prepare(
      `SELECT proof_key, label, state, evidence, checkpoint_id, updated_at
       FROM item_proof_items WHERE item_id=?`,
    ).all(itemId) as Array<Omit<CurrentProofRow, "item_id">>)
      .map((row) => [row.proof_key, row]),
  );
  for (const item of proofItems) {
    if (item.state === "retired") {
      if (!current.has(item.id)) {
        throw new Error(`cannot retire missing current proof item '${item.id}'`);
      }
      current.delete(item.id);
    } else {
      current.set(item.id, {
        proof_key: item.id,
        label: item.label,
        state: item.state,
        evidence: item.evidence,
        checkpoint_id: checkpointId,
        updated_at: updatedAt,
      });
    }
  }
  if (current.size > MAX_CURRENT_PROOF_ITEMS) {
    throw new Error(`item proof quota exceeds ${MAX_CURRENT_PROOF_ITEMS} current items`);
  }

  const remove = db.prepare(
    "DELETE FROM item_proof_items WHERE item_id=? AND proof_key=? AND checkpoint_id<=?",
  );
  const upsert = db.prepare(
    `INSERT INTO item_proof_items
       (item_id, proof_key, label, state, evidence, checkpoint_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, proof_key) DO UPDATE SET
       label=excluded.label,
       state=excluded.state,
       evidence=excluded.evidence,
       checkpoint_id=excluded.checkpoint_id,
       updated_at=excluded.updated_at
     WHERE excluded.checkpoint_id >= item_proof_items.checkpoint_id`,
  );
  for (const item of proofItems) {
    if (item.state === "retired") {
      remove.run(itemId, item.id, checkpointId);
    } else {
      upsert.run(
        itemId,
        item.id,
        item.label,
        item.state,
        item.evidence,
        checkpointId,
        updatedAt,
      );
    }
  }
}

function expectedProofMaterialization(db: Db): CurrentProofRow[] {
  const rows = db.prepare(
    "SELECT id, item_id, proof_items, created_at FROM checkpoints ORDER BY id",
  ).all() as Array<{
    id: number;
    item_id: number;
    proof_items: string;
    created_at: string;
  }>;
  const byItem = new Map<number, Map<string, CurrentProofRow>>();
  for (const row of rows) {
    const current = byItem.get(row.item_id) ?? new Map<string, CurrentProofRow>();
    byItem.set(row.item_id, current);
    for (const item of parseStoredProofItems(row.proof_items, row.id)) {
      if (item.state === "retired") {
        if (!current.has(item.id)) {
          throw new Error(`checkpoint ${row.id} cannot retire missing proof item '${item.id}'`);
        }
        current.delete(item.id);
      } else {
        current.set(item.id, {
          item_id: row.item_id,
          proof_key: item.id,
          label: item.label,
          state: item.state,
          evidence: item.evidence,
          checkpoint_id: row.id,
          updated_at: row.created_at,
        });
      }
    }
    if (current.size > MAX_CURRENT_PROOF_ITEMS) {
      throw new Error(
        `checkpoint ${row.id} exceeds ${MAX_CURRENT_PROOF_ITEMS} current proof items`,
      );
    }
  }
  return [...byItem.values()].flatMap((items) => [...items.values()])
    .sort((left, right) => left.item_id - right.item_id
      || left.proof_key.localeCompare(right.proof_key));
}

function actualProofMaterialization(db: Db): CurrentProofRow[] {
  return db.prepare(
    `SELECT item_id, proof_key, label, state, evidence, checkpoint_id, updated_at
     FROM item_proof_items ORDER BY item_id, proof_key`,
  ).all() as CurrentProofRow[];
}

function proofRowKey(row: Pick<CurrentProofRow, "item_id" | "proof_key">): string {
  return `${row.item_id}\0${row.proof_key}`;
}

function proofDriftCount(expected: CurrentProofRow[], actual: CurrentProofRow[]): number {
  const expectedByKey = new Map(expected.map((row) => [proofRowKey(row), JSON.stringify(row)]));
  const actualByKey = new Map(actual.map((row) => [proofRowKey(row), JSON.stringify(row)]));
  const keys = new Set([...expectedByKey.keys(), ...actualByKey.keys()]);
  let count = 0;
  for (const key of keys) {
    if (expectedByKey.get(key) !== actualByKey.get(key)) count++;
  }
  return count;
}

export function repairItemProofMaterialization(db: Db): number {
  const repair = () => {
    const expected = expectedProofMaterialization(db);
    const actual = actualProofMaterialization(db);
    const repaired = proofDriftCount(expected, actual);
    if (repaired === 0) return 0;
    db.prepare("DELETE FROM item_proof_items").run();
    const insert = db.prepare(
      `INSERT INTO item_proof_items
       (item_id, proof_key, label, state, evidence, checkpoint_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of expected) {
      insert.run(
        row.item_id,
        row.proof_key,
        row.label,
        row.state,
        row.evidence,
        row.checkpoint_id,
        row.updated_at,
      );
    }
    return repaired;
  };
  return db.inTransaction ? repair() : db.transaction(repair).immediate();
}

export function verifyItemProofMaterialization(db: Db): void {
  const expected = expectedProofMaterialization(db);
  const actual = actualProofMaterialization(db);
  if (proofDriftCount(expected, actual) !== 0) {
    throw new Error("item proof materialization verification failed");
  }
}

function parseRow(row: CheckpointRow): Checkpoint {
  const system = row.source === "system_derived";
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    author: {
      kind: system ? "system" : row.run_role ?? "executor",
      runtime: system ? null : row.run_runtime,
    },
    source: row.source,
    kind: row.kind,
    stage: row.stage,
    title: row.title,
    summary: row.summary,
    keyFacts: JSON.parse(row.key_facts) as CheckpointFact[],
    artifactRefs: JSON.parse(row.artifact_refs) as string[],
    relatedItemIds: JSON.parse(row.related_item_ids) as number[],
    nextStep: row.next_step,
    actionRef: row.action_type && row.action_id !== null
      ? { type: row.action_type, id: row.action_id }
      : null,
    progress: row.progress_current !== null && row.progress_total !== null
      ? {
          current: row.progress_current,
          total: row.progress_total,
          label: row.progress_label,
        }
      : null,
    proofItems: parseStoredProofItems(row.proof_items, row.id),
    createdAt: row.created_at,
  };
}

const CHECKPOINT_SELECT = `
  SELECT c.*, a.role AS run_role, a.runtime AS run_runtime
  FROM checkpoints c
  LEFT JOIN runs a ON a.id = c.run_id`;

export function getCheckpoint(db: Db, id: number): Checkpoint | undefined {
  const row = db.prepare(`${CHECKPOINT_SELECT} WHERE c.id = ?`).get(id) as CheckpointRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function insertCheckpointWithResult(
  db: Db,
  rawInput: InsertCheckpointInput,
  options?: { now?: Date; dedupeWindowMs?: number },
): InsertCheckpointResult {
  const write = (): InsertCheckpointResult => {
    const input = normalize(rawInput);
    validateRelations(db, input);
    const hash = checkpointHash(input);
    const now = options?.now ?? new Date();
    const createdAt = now.toISOString();

    if (input.idempotencyKey) {
      const existing = db.prepare(
        "SELECT id, item_id, content_hash FROM checkpoints WHERE idempotency_key = ?",
      ).get(input.idempotencyKey) as {
        id: number; item_id: number; content_hash: string;
      } | undefined;
      if (existing) {
        if (existing.item_id !== input.itemId || existing.content_hash !== hash) {
          throw new Error(`idempotency key '${input.idempotencyKey}' already has different content`);
        }
        return { checkpoint: getCheckpoint(db, existing.id)!, deduplicated: true };
      }
    }

    const configuredWindow = Number(process.env.PLC_CHECKPOINT_DEDUPE_WINDOW_MS ?? 60_000);
    const dedupeWindowMs = options?.dedupeWindowMs
      ?? (Number.isFinite(configuredWindow) ? configuredWindow : 60_000);
    if (input.source === "agent_reported" && input.runId !== null
      && input.idempotencyKey === null && dedupeWindowMs > 0) {
      const threshold = new Date(now.getTime() - dedupeWindowMs).toISOString();
      const duplicate = db.prepare(
        `SELECT id FROM checkpoints
         WHERE run_id = ? AND source = 'agent_reported' AND content_hash = ?
           AND julianday(created_at) >= julianday(?)
         ORDER BY id DESC LIMIT 1`,
      ).get(input.runId, hash, threshold) as { id: number } | undefined;
      if (duplicate) {
        return { checkpoint: getCheckpoint(db, duplicate.id)!, deduplicated: true };
      }
    }

    const result = db.prepare(
      `INSERT INTO checkpoints (
         item_id, run_id, source, kind, stage, title, summary, key_facts, artifact_refs,
         related_item_ids, next_step, action_type, action_id, idempotency_key, content_hash,
         progress_current, progress_total, progress_label, proof_items, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.itemId, input.runId, input.source, input.kind, input.stage, input.title,
      input.summary, JSON.stringify(input.keyFacts), JSON.stringify(input.artifactRefs),
      JSON.stringify(input.relatedItemIds), input.nextStep, input.actionRef?.type ?? null,
      input.actionRef?.id ?? null, input.idempotencyKey, hash,
      input.progress?.current ?? null, input.progress?.total ?? null, input.progress?.label ?? null,
      JSON.stringify(input.proofItems), createdAt,
    );
    const checkpointId = Number(result.lastInsertRowid);
    applyProofUpdates(db, input.itemId, checkpointId, input.proofItems, createdAt);
    // 双写（Lead 事件主干，工单 01）：每个新的 checkpoint 一条事件，和它同一个事务。去重命中的不记。
    // 事件出错不让 checkpoint 的写入回滚（appendEventGuarded）。
    appendEventGuarded(db, () => ({
      source: "ticket",
      sourceRef: `checkpoint:${checkpointId}`,
      kind: "checkpoint.recorded",
      entityKey: itemEntityKey(db, input.itemId),
      occurredAt: createdAt,
      payload: {
        checkpointId, itemId: input.itemId, runId: input.runId, checkpointKind: input.kind,
        checkpointSource: input.source, title: input.title, summary: input.summary, nextStep: input.nextStep,
      },
    }));
    return {
      checkpoint: getCheckpoint(db, checkpointId)!,
      deduplicated: false,
    };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

/** 指向这个审批或决策请求的最新一个检查点（child 写这一步时的标题和摘要）。没有时是 null。 */
export function latestCheckpointIdForAction(db: Db, type: CheckpointActionRef["type"], id: number): number | null {
  const row = db.prepare(
    "SELECT id FROM checkpoints WHERE action_type = ? AND action_id = ? ORDER BY id DESC LIMIT 1",
  ).get(type, id) as { id: number } | undefined;
  return row?.id ?? null;
}

export function insertCheckpoint(
  db: Db,
  rawInput: InsertCheckpointInput,
  options?: { now?: Date; dedupeWindowMs?: number },
): Checkpoint {
  return insertCheckpointWithResult(db, rawInput, options).checkpoint;
}

export function listCheckpoints(
  db: Db,
  query: { itemId: number; beforeId?: number; afterId?: number; limit?: number },
): CheckpointPage {
  if (query.beforeId !== undefined && query.afterId !== undefined) {
    throw new Error("beforeId and afterId are mutually exclusive");
  }
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1-200");
  let rows: CheckpointRow[];
  if (query.afterId !== undefined) {
    rows = db.prepare(
      `${CHECKPOINT_SELECT} WHERE c.item_id = ? AND c.id > ? ORDER BY c.id ASC LIMIT ?`,
    ).all(query.itemId, query.afterId, limit + 1) as CheckpointRow[];
  } else {
    const filter = query.beforeId === undefined ? "" : "AND c.id < ?";
    const params = query.beforeId === undefined
      ? [query.itemId, limit + 1]
      : [query.itemId, query.beforeId, limit + 1];
    rows = db.prepare(
      `SELECT * FROM (${CHECKPOINT_SELECT} WHERE c.item_id = ? ${filter}
        ORDER BY c.id DESC LIMIT ?) ORDER BY id ASC`,
    ).all(...params) as CheckpointRow[];
  }
  const hasMore = rows.length > limit;
  if (hasMore) {
    if (query.afterId !== undefined) rows = rows.slice(0, limit);
    else rows = rows.slice(rows.length - limit);
  }
  const items = rows.map(parseRow);
  const smallest = items[0]?.id;
  const hasOlder = smallest !== undefined && !!db.prepare(
    "SELECT 1 FROM checkpoints WHERE item_id = ? AND id < ? LIMIT 1",
  ).get(query.itemId, smallest);
  return { items, hasMore, nextBeforeId: hasOlder ? smallest : null };
}
