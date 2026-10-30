import type { Db } from "./db.js";
import type {
  ConversationCard, ItemOperationProjection,
} from "@pi-lead-child/core";

const MAX_OPERATIONS = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const OPERATION_KEYS = new Set(["id", "name", "state", "label", "detail"]);
const OPERATION_STATES = new Set(["started", "running", "completed", "failed"]);

interface ConversationCardRow {
  id: number;
  turn_id: string | null;
  item_id: number | null;
  kind: ConversationCard["kind"];
  checkpoint_id: number | null;
  action_type: "approval" | "decision_request" | null;
  action_id: number | null;
  payload: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

interface ItemExecutionPayload {
  operations: ItemOperationProjection[];
  operationsTruncated: boolean;
}

function chars(value: string): number {
  return Array.from(value).length;
}

function normalizeOperation(operation: ItemOperationProjection): ItemOperationProjection {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("operation must be an object");
  }
  for (const key of Object.keys(operation)) {
    if (!OPERATION_KEYS.has(key)) throw new Error(`unknown operation field '${key}'`);
  }
  if (typeof operation.id !== "string" || !operation.id || chars(operation.id) > 240) {
    throw new Error("operation id must contain 1-240 characters");
  }
  if (typeof operation.name !== "string" || !operation.name || chars(operation.name) > 120) {
    throw new Error("operation name must contain 1-120 characters");
  }
  if (!OPERATION_STATES.has(operation.state)) throw new Error("invalid operation state");
  if (typeof operation.label !== "string" || !operation.label || chars(operation.label) > 160) {
    throw new Error("operation label must contain 1-160 characters");
  }
  if (operation.detail !== null && typeof operation.detail !== "string") {
    throw new Error("operation detail must be a string or null");
  }
  if (operation.detail !== null && chars(operation.detail) > 500) {
    throw new Error("operation detail exceeds 500 characters");
  }
  return {
    id: operation.id,
    name: operation.name,
    state: operation.state,
    label: operation.label,
    detail: operation.detail,
  };
}

function serializePayload(payload: object): string {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("conversation card payload exceeds 16 KiB");
  }
  return serialized;
}

function parseRow(row: ConversationCardRow): ConversationCard {
  const base = {
    id: row.id,
    key: row.idempotency_key,
    turnId: row.turn_id,
    itemId: row.item_id!,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === "ticket_execution") {
    const payload = JSON.parse(row.payload) as ItemExecutionPayload;
    return {
      ...base,
      kind: "ticket_execution",
      turnId: row.turn_id!,
      operations: payload.operations,
      operationsTruncated: payload.operationsTruncated,
    };
  }
  if (row.kind === "checkpoint") {
    return { ...base, kind: "checkpoint", checkpointId: row.checkpoint_id! };
  }
  return {
    ...base,
    kind: "intervention",
    checkpointId: row.checkpoint_id!,
    actionType: row.action_type!,
    actionId: row.action_id!,
  };
}

export function getConversationCardByKey(db: Db, key: string): ConversationCard | undefined {
  const row = db.prepare("SELECT * FROM conversation_cards WHERE idempotency_key = ?").get(key) as
    ConversationCardRow | undefined;
  return row ? parseRow(row) : undefined;
}

// 一条 operation 的 id 是 `${turnId}:${callId}`，在一个 turn 内唯一。终局事件靠它找回
// start 那一刻已经落库的卡片，而不是重新从 payload 推导 item id——SDK 的 tool_execution_end
// 不带 args，重新推导对 spawn_child / cancel_item 这类"只能从入参认出目标"的工具必然失败。
// 用 json_each 让 SQLite 自己过滤：一个 turn 的卡片数是有界的，这条查询恒是小表扫描。
export function itemIdOfCardOperation(
  db: Db,
  turnId: string,
  operationId: string,
): number | undefined {
  const row = db.prepare(
    `SELECT item_id FROM conversation_cards
     WHERE kind = 'ticket_execution' AND turn_id = ?
       AND EXISTS (
         SELECT 1 FROM json_each(payload, '$.operations')
         WHERE json_extract(value, '$.id') = ?
       )
     ORDER BY id LIMIT 1`,
  ).get(turnId, operationId) as { item_id: number | null } | undefined;
  return row?.item_id ?? undefined;
}

export function upsertItemExecutionCard(
  db: Db,
  input: {
    turnId: string;
    itemId: number;
    operation: ItemOperationProjection;
    now?: Date;
  },
): Extract<ConversationCard, { kind: "ticket_execution" }> {
  const write = db.transaction(() => {
    const normalizedOperation = normalizeOperation(input.operation);
    // 卡片 key 是线上契约（protocol 的 ^turn:.+:ticket:[0-9]+$），内部改名不跟。
    const key = `turn:${input.turnId}:ticket:${input.itemId}`;
    const existing = getConversationCardByKey(db, key);
    if (existing && existing.kind !== "ticket_execution") {
      throw new Error(`conversation card key '${key}' has incompatible kind`);
    }
    const operations = existing ? [...existing.operations] : [];
    const operationIndex = operations.findIndex((operation) => operation.id === normalizedOperation.id);
    if (operationIndex >= 0) operations[operationIndex] = normalizedOperation;
    else operations.push(normalizedOperation);
    let operationsTruncated = existing?.operationsTruncated ?? false;
    if (operations.length > MAX_OPERATIONS) {
      operations.splice(1, operations.length - MAX_OPERATIONS);
      operationsTruncated = true;
    }
    const payload = serializePayload({ operations, operationsTruncated });
    const now = (input.now ?? new Date()).toISOString();
    if (existing) {
      db.prepare(
        "UPDATE conversation_cards SET payload = ?, updated_at = ? WHERE id = ?",
      ).run(payload, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO conversation_cards
          (turn_id, item_id, kind, payload, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'ticket_execution', ?, ?, ?, ?)`,
      ).run(input.turnId, input.itemId, payload, key, now, now);
    }
    return getConversationCardByKey(db, key) as Extract<ConversationCard, { kind: "ticket_execution" }>;
  });
  return write.immediate();
}

export function ensureCheckpointCard(
  db: Db,
  input: { itemId: number; checkpointId: number; turnId?: string | null; now?: Date },
): Extract<ConversationCard, { kind: "checkpoint" }> {
  const write = db.transaction(() => {
    const key = `checkpoint:${input.checkpointId}`;
    const checkpoint = db.prepare("SELECT item_id FROM checkpoints WHERE id = ?")
      .get(input.checkpointId) as { item_id: number } | undefined;
    if (!checkpoint || checkpoint.item_id !== input.itemId) {
      throw new Error("checkpoint card does not match its item");
    }
    const now = (input.now ?? new Date()).toISOString();
    db.prepare(
      `INSERT INTO conversation_cards
        (turn_id, item_id, kind, checkpoint_id, payload, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'checkpoint', ?, '{}', ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(input.turnId ?? null, input.itemId, input.checkpointId, key, now, now);
    const existing = getConversationCardByKey(db, key);
    if (!existing || existing.kind !== "checkpoint" || existing.itemId !== input.itemId
      || existing.checkpointId !== input.checkpointId
      || existing.turnId !== (input.turnId ?? null)) {
      throw new Error(`card key '${key}' has incompatible checkpoint projection`);
    }
    return existing;
  });
  return write.immediate();
}

export function ensureInterventionCard(
  db: Db,
  input: {
    itemId: number;
    checkpointId: number;
    actionType: "approval" | "decision_request";
    actionId: number;
    turnId?: string | null;
    now?: Date;
  },
): Extract<ConversationCard, { kind: "intervention" }> {
  const write = db.transaction(() => {
    const checkpoint = db.prepare(
      "SELECT item_id, action_type, action_id FROM checkpoints WHERE id = ?",
    ).get(input.checkpointId) as {
      item_id: number; action_type: string | null; action_id: number | null;
    } | undefined;
    if (!checkpoint || checkpoint.item_id !== input.itemId
      || checkpoint.action_type !== input.actionType || checkpoint.action_id !== input.actionId) {
      throw new Error("intervention card checkpoint does not match its authority");
    }
    const key = `intervention:${input.actionType}:${input.actionId}`;
    const now = (input.now ?? new Date()).toISOString();
    db.prepare(
      `INSERT INTO conversation_cards
        (turn_id, item_id, kind, checkpoint_id, action_type, action_id, payload,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'intervention', ?, ?, ?, '{}', ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(
      input.turnId ?? null, input.itemId, input.checkpointId, input.actionType,
      input.actionId, key, now, now,
    );
    const existing = getConversationCardByKey(db, key);
    if (!existing || existing.kind !== "intervention" || existing.itemId !== input.itemId
      || existing.checkpointId !== input.checkpointId || existing.actionType !== input.actionType
      || existing.actionId !== input.actionId || existing.turnId !== (input.turnId ?? null)) {
      throw new Error(`card key '${key}' has incompatible intervention projection`);
    }
    return existing;
  });
  return write.immediate();
}

export interface ConversationCardPage {
  items: ConversationCard[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export function listConversationCardPage(
  db: Db,
  query?: {
    beforeId?: number;
    afterId?: number;
    limit?: number;
    itemIds?: number[];
    keys?: string[];
  },
): ConversationCardPage {
  if (query?.beforeId !== undefined && query.afterId !== undefined) {
    throw new Error("beforeId and afterId are mutually exclusive");
  }
  const limit = query?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1-200");
  // 工单对话 Run 的崩溃记录不是会话里的一张卡片：失败的回执已经说了这件事，工单也没有受阻。
  // 现在不再写这种卡片（engine 的 recordRunCrash）；这里在读的时候跳过以前写下的（#66 的 Run #71），不改数据。
  const where: string[] = [`NOT EXISTS (
    SELECT 1 FROM checkpoints c JOIN runs r ON r.id = c.run_id
    WHERE c.id = conversation_cards.checkpoint_id
      AND r.purpose = 'conversation'
      AND c.idempotency_key LIKE 'run-crash:%'
  )`];
  const values: unknown[] = [];
  if (query?.beforeId !== undefined) { where.push("id < ?"); values.push(query.beforeId); }
  if (query?.afterId !== undefined) { where.push("id > ?"); values.push(query.afterId); }
  if (query?.itemIds?.length) {
    where.push(`item_id IN (${query.itemIds.map(() => "?").join(",")})`);
    values.push(...query.itemIds);
  }
  if (query?.keys?.length) {
    where.push(`idempotency_key IN (${query.keys.map(() => "?").join(",")})`);
    values.push(...query.keys);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  let rows: ConversationCardRow[];
  if (query?.afterId !== undefined) {
    rows = db.prepare(
      `SELECT * FROM conversation_cards ${clause} ORDER BY id ASC LIMIT ?`,
    ).all(...values, limit + 1) as ConversationCardRow[];
  } else {
    rows = db.prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_cards ${clause} ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    ).all(...values, limit + 1) as ConversationCardRow[];
  }
  const hasMore = rows.length > limit;
  if (hasMore) {
    if (query?.afterId !== undefined) rows = rows.slice(0, limit);
    else rows = rows.slice(rows.length - limit);
  }
  const items = rows.map(parseRow);
  const smallest = items[0]?.id;
  const filterWhere = query?.itemIds?.length
    ? ` AND item_id IN (${query.itemIds.map(() => "?").join(",")})`
    : "";
  const keyWhere = query?.keys?.length
    ? ` AND idempotency_key IN (${query.keys.map(() => "?").join(",")})`
    : "";
  const olderValues: unknown[] = [smallest ?? 0, ...(query?.itemIds ?? []), ...(query?.keys ?? [])];
  const hasOlder = smallest !== undefined && !!db.prepare(
    `SELECT 1 FROM conversation_cards WHERE id < ?${filterWhere}${keyWhere} LIMIT 1`,
  ).get(...olderValues);
  return { items, hasMore, nextBeforeId: hasOlder ? smallest : null };
}

export function listConversationCards(
  db: Db,
  query?: {
    beforeId?: number;
    afterId?: number;
    limit?: number;
    itemIds?: number[];
    keys?: string[];
  },
): ConversationCard[] {
  return listConversationCardPage(db, query).items;
}

/**
 * 这条 blocker 通知说的事，Lead 会话里是不是已经有一张检查点卡片：同一个检查点（键 checkpoint:<id>），
 * 或者同一次 Run 崩溃（键 run-crash:<runId>，和检查点的 idempotency_key 相同）。
 * 有卡片时，兜底投递不再往会话里贴同一件事（一件事一张卡片），只推桌面和 Slack。
 */
export function blockerHasConversationCard(db: Db, notificationDedupKey: string | null): boolean {
  if (!notificationDedupKey?.startsWith("blocker:")) return false;
  const key = notificationDedupKey.slice("blocker:".length);
  const checkpointId = /^checkpoint:(\d+)$/.exec(key)?.[1];
  const row = checkpointId
    ? db.prepare("SELECT 1 FROM conversation_cards WHERE checkpoint_id = ? LIMIT 1").get(Number(checkpointId))
    : db.prepare(
      `SELECT 1 FROM conversation_cards cc JOIN checkpoints c ON c.id = cc.checkpoint_id
       WHERE c.idempotency_key = ? LIMIT 1`,
    ).get(key);
  return row !== undefined;
}

/**
 * 这条 blocker inbox 行在会话里有没有别的记录：同一件事的通知（raiseBlocker 用 blocker:<blockerKey> 去重，
 * 由 Lead 播报或兜底投递），或者一张卡片（检查点卡片，或者审批、决策请求的介入卡片）。
 * 都没有时（例如派发重试用完、reviewer 重试用完只写了一行 inbox），daemon 自己在会话里写一行。
 */
export function blockerHasConversationRecord(db: Db, row: { payload: string | null }): boolean {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload || "{}") as Record<string, unknown>; } catch { payload = {}; }
  if (typeof payload.blockerKey === "string") {
    const key = `blocker:${payload.blockerKey}`;
    if (db.prepare("SELECT 1 FROM notifications WHERE dedup_key = ? LIMIT 1").get(key)) return true;
    if (blockerHasConversationCard(db, key)) return true;
  }
  if ((payload.authorityType === "approval" || payload.authorityType === "decision_request")
      && typeof payload.authorityId === "number"
      && db.prepare("SELECT 1 FROM conversation_cards WHERE action_type = ? AND action_id = ? LIMIT 1")
        .get(payload.authorityType, payload.authorityId)) {
    return true;
  }
  const evidence = payload.evidence as Record<string, unknown> | undefined;
  const checkpointId = typeof payload.checkpointId === "number" ? payload.checkpointId
    : typeof evidence?.checkpointId === "number" ? evidence.checkpointId : null;
  if (checkpointId !== null
      && db.prepare("SELECT 1 FROM conversation_cards WHERE checkpoint_id = ? LIMIT 1").get(checkpointId)) {
    return true;
  }
  return false;
}
