import type { Db } from "./db.js";
import type {
  DecisionOption, DecisionRequest, DecisionRequestAudience, DecisionRequestKind,
} from "@pi-lead-child/core";

interface DecisionRequestRow {
  id: number;
  item_id: number;
  run_id: number | null;
  origin?: string | null;
  kind: DecisionRequestKind;
  audience: DecisionRequestAudience;
  blocking: number;
  allow_custom: number;
  prompt: string;
  options: string;
  state: DecisionRequest["state"];
  resolution_kind: DecisionRequest["resolutionKind"];
  selected_option_id: string | null;
  resolution_text: string | null;
  dismissal_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface InsertDecisionRequestInput {
  itemId: number;
  runId?: number | null;
  origin?: "agent" | "lead";
  kind: DecisionRequestKind;
  audience: DecisionRequestAudience;
  blocking?: boolean;
  allowCustom?: boolean;
  prompt: string;
  options?: Array<{ id: string; label: string; description?: string | null }>;
  expiresAt?: string | null;
  now?: Date;
}

export type DecisionResolution =
  | { kind: "option"; optionId: string; resolvedBy: string; now?: Date }
  | { kind: "text"; text: string; resolvedBy: string; now?: Date }
  | { kind: "dismissed"; reason?: string; resolvedBy: string; now?: Date };

function parseRow(row: DecisionRequestRow): DecisionRequest {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    origin: row.origin === "lead" ? "lead" : "agent",
    kind: row.kind,
    audience: row.audience,
    blocking: row.blocking === 1,
    allowCustom: row.allow_custom === 1,
    prompt: row.prompt,
    options: (JSON.parse(row.options) as Array<{
      id: string; label: string; description?: string | null;
    }>).map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description ?? null,
    })),
    state: row.state,
    resolutionKind: row.resolution_kind,
    selectedOptionId: row.selected_option_id,
    resolutionText: row.resolution_text,
    dismissalReason: row.dismissal_reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function getDecisionRequest(db: Db, id: number): DecisionRequest | undefined {
  const row = db.prepare("SELECT * FROM decision_requests WHERE id = ?").get(id) as
    DecisionRequestRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function insertDecisionRequest(db: Db, input: InsertDecisionRequestInput): DecisionRequest {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("decision prompt is required");
  const options = (input.options ?? []).map((option) => ({
    id: option.id.trim(), label: option.label.trim(), description: option.description?.trim() || null,
  }));
  const optionIds = new Set<string>();
  for (const option of options) {
    if (!option.id || !option.label) throw new Error("decision option id and label are required");
    if (optionIds.has(option.id)) throw new Error(`duplicate decision option '${option.id}'`);
    optionIds.add(option.id);
  }
  if (!db.prepare("SELECT 1 FROM items WHERE id = ?").get(input.itemId)) {
    throw new Error(`item ${input.itemId} not found`);
  }
  if (input.runId !== undefined && input.runId !== null) {
    const run = db.prepare("SELECT item_id FROM runs WHERE id = ?").get(input.runId) as
      { item_id: number } | undefined;
    if (!run || run.item_id !== input.itemId) {
      throw new Error(`run ${input.runId} does not belong to item ${input.itemId}`);
    }
  }
  const result = db.prepare(
    `INSERT INTO decision_requests (
       item_id, run_id, origin, kind, audience, blocking, allow_custom, prompt, options,
       expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.itemId, input.runId ?? null, input.origin ?? "agent", input.kind, input.audience,
    input.blocking === false ? 0 : 1, input.allowCustom ? 1 : 0, prompt,
    JSON.stringify(options), input.expiresAt ?? null, (input.now ?? new Date()).toISOString(),
  );
  return getDecisionRequest(db, Number(result.lastInsertRowid))!;
}

function normalizedResolution(request: DecisionRequest, resolution: DecisionResolution) {
  if (resolution.kind === "option") {
    if (!request.options.some((option) => option.id === resolution.optionId)) {
      throw new Error(`decision option '${resolution.optionId}' is not available`);
    }
    return {
      state: "resolved" as const,
      resolutionKind: "option" as const,
      selectedOptionId: resolution.optionId,
      resolutionText: null,
      dismissalReason: null,
    };
  }
  if (resolution.kind === "text") {
    if (request.options.length > 0 && !request.allowCustom) {
      throw new Error("custom text resolution is not allowed");
    }
    const text = resolution.text.trim();
    if (!text) throw new Error("resolution text is required");
    return {
      state: "resolved" as const,
      resolutionKind: "text" as const,
      selectedOptionId: null,
      resolutionText: text,
      dismissalReason: null,
    };
  }
  return {
    state: "dismissed" as const,
    resolutionKind: "dismissed" as const,
    selectedOptionId: null,
    resolutionText: null,
    dismissalReason: resolution.reason?.trim() || null,
  };
}

export function resolveDecisionRequest(
  db: Db,
  id: number,
  resolution: DecisionResolution,
): "resolved" | "idempotent" | "conflict" {
  const write = db.transaction((): "resolved" | "idempotent" | "conflict" => {
    const request = getDecisionRequest(db, id);
    if (!request) throw new Error(`decision request ${id} not found`);
    const normalized = normalizedResolution(request, resolution);
    const sameResolution = (current: DecisionRequest) => current.state === normalized.state
      && current.resolutionKind === normalized.resolutionKind
      && current.selectedOptionId === normalized.selectedOptionId
      && current.resolutionText === normalized.resolutionText
      && current.dismissalReason === normalized.dismissalReason;
    if (request.state !== "pending") return sameResolution(request) ? "idempotent" : "conflict";
    const resolvedAt = (resolution.now ?? new Date()).toISOString();
    const result = db.prepare(
      `UPDATE decision_requests
       SET state = ?, resolution_kind = ?, selected_option_id = ?, resolution_text = ?,
           dismissal_reason = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? AND state = 'pending'`,
    ).run(
      normalized.state, normalized.resolutionKind, normalized.selectedOptionId,
      normalized.resolutionText, normalized.dismissalReason, resolution.resolvedBy, resolvedAt, id,
    );
    if (result.changes === 1) return "resolved";
    const current = getDecisionRequest(db, id);
    return current && sameResolution(current) ? "idempotent" : "conflict";
  });
  return write.immediate();
}

export function expireDecisionRequests(db: Db, now: Date): number[] {
  const ids = db.prepare(
    `UPDATE decision_requests
     SET state = 'expired', resolution_kind = 'expired', resolved_at = ?
     WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
     RETURNING id`,
  ).all(now.toISOString(), now.toISOString()) as Array<{ id: number }>;
  return ids.map((row) => row.id).sort((left, right) => left - right);
}

export interface PendingDecisionProjectionGap {
  authority: DecisionRequest;
  checkpointId: number | null;
  cardId: number | null;
}

export function findPendingDecisionProjectionGaps(db: Db): PendingDecisionProjectionGap[] {
  const rows = db.prepare(
    `SELECT d.*,
       (SELECT c.id FROM checkpoints c
        WHERE c.action_type = 'decision_request' AND c.action_id = d.id
          AND c.item_id = d.item_id
        ORDER BY c.id DESC LIMIT 1) AS checkpoint_id,
       (SELECT cc.id FROM conversation_cards cc
        JOIN checkpoints c ON c.id = cc.checkpoint_id
        WHERE cc.kind = 'intervention'
          AND cc.action_type = 'decision_request' AND cc.action_id = d.id
          AND cc.item_id = d.item_id
          AND c.item_id = d.item_id
          AND c.action_type = 'decision_request' AND c.action_id = d.id
        ORDER BY cc.id DESC LIMIT 1) AS card_id
     FROM decision_requests d
     WHERE d.state = 'pending' AND (
       NOT EXISTS (SELECT 1 FROM checkpoints c
                   WHERE c.action_type = 'decision_request' AND c.action_id = d.id
                     AND c.item_id = d.item_id)
       OR NOT EXISTS (
         SELECT 1 FROM conversation_cards cc
         JOIN checkpoints c ON c.id = cc.checkpoint_id
         WHERE cc.kind = 'intervention'
           AND cc.action_type = 'decision_request' AND cc.action_id = d.id
           AND cc.item_id = d.item_id
           AND c.item_id = d.item_id
           AND c.action_type = 'decision_request' AND c.action_id = d.id
       )
     )
     ORDER BY d.id`,
  ).all() as Array<DecisionRequestRow & { checkpoint_id: number | null; card_id: number | null }>;
  return rows.map((row) => {
    const { checkpoint_id, card_id, ...authorityRow } = row;
    return { authority: parseRow(authorityRow), checkpointId: checkpoint_id, cardId: card_id };
  });
}
