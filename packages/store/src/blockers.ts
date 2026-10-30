import type { AttentionIntervention } from "./attention.js";
import type { Db } from "./db.js";
import { addInbox } from "./inbox.js";
import { addNotification } from "./notifications.js";
import { getCheckpoint } from "./checkpoints.js";
import type { Checkpoint } from "@pi-lead-child/core";

export type BlockerSource = "structural" | "semantic";

export interface RaiseBlockerInput {
  itemId: number;
  runId?: number | null;
  code: string;
  payloadKind?: string;
  title: string;
  summary: string;
  impact?: string;
  nextStep?: string;
  source: BlockerSource;
  dedupKey?: string;
  evidence?: Record<string, unknown>;
  intervention?: AttentionIntervention;
  leadNextStep?: string;
  /**
   * 要不要用户行动（2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈）。
   * false：只交给 Lead，不发用户通知；Lead 处理不了时由 daemon 升级（inbox.ts 的 escalateLeadRow）。
   * 默认 true：例如重试或返工额度用完，要用户决定。
   */
  needsUser?: boolean;
  at?: Date;
}

export interface RaisedBlocker {
  blockerKey: string;
  inboxId: number | null;
  /** 只交给 Lead 的 blocker 没有用户通知，是 null。 */
  notificationId: number | null;
  created: boolean;
}

function parsePayload(serialized: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(serialized || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function findInboxBlocker(
  db: Db, itemId: number, matches: (payload: Record<string, unknown>) => boolean,
): number | null {
  const rows = db.prepare(
    "SELECT id, payload FROM inbox WHERE item_id = ? AND severity = 'blocker' ORDER BY id",
  ).all(itemId) as Array<{ id: number; payload: string }>;
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (payload && matches(payload)) return row.id;
  }
  return null;
}

function hasInboxBlocker(db: Db, itemId: number, blockerKey: string): number | null {
  return findInboxBlocker(db, itemId, (payload) => payload.blockerKey === blockerKey);
}

function normalizeText(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * A blocker is a cross-channel fact: Lead must receive it, and the user must
 * be able to learn about it even when Lead is busy or unavailable.
 * Since 2026-10-15 every blocker reaches Lead first, and Lead decides how to
 * tell the user. A blocker that needs the user also records a notification: a
 * fact the user must receive, delivered through Lead. A Lead-first blocker
 * (needsUser: false) records none. When Lead cannot work, the daemon escalates
 * the backlog to the user (inbox.ts, escalateLeadBacklog).
 *
 * The key is exact-event deduplication, not natural-language similarity. The
 * inbox keeps the structured payload for Lead; notifications keep the durable
 * user-facing fact and use the same key for exactly-once insertion.
 */
export function raiseBlocker(db: Db, args: RaiseBlockerInput): RaisedBlocker {
  const blockerKey = args.dedupKey?.trim()
    || `${args.code}:item:${args.itemId}:run:${args.runId ?? "none"}`;
  const impact = normalizeText(args.impact, "当前工单无法继续执行或进入下一阶段。");
  const nextStep = normalizeText(args.nextStep, "Lead 需要检查失败证据，判断是否可以安全恢复或重试。");
  const body = [
    args.summary.trim(),
    `影响：${impact}`,
    `下一步：${nextStep}`,
  ].join("\n");
  const needsUser = args.needsUser ?? true;
  const payload = {
    kind: args.payloadKind ?? "blocker",
    blocker: true,
    needsUser,
    blockerKey,
    blockerCode: args.code,
    runId: args.runId ?? null,
    title: args.title.trim(),
    summary: args.summary.trim(),
    impact,
    nextStep,
    ...(args.intervention ? { intervention: args.intervention } : {}),
    ...(args.leadNextStep ? { leadNextStep: args.leadNextStep } : {}),
    ...(args.evidence ?? {}),
    evidence: args.evidence ?? {},
  };
  const existingInboxId = hasInboxBlocker(db, args.itemId, blockerKey);
  const inbox = existingInboxId === null
      ? addInbox(db, {
        itemId: args.itemId,
        severity: "blocker",
        source: args.source,
        summary: `工单 #${args.itemId} 阻塞：${args.title.trim()}：${args.summary.trim().slice(0, 240)}`,
        payload,
        // blocker 的事件去重由 blockerKey 负责；不能再被 inbox 熔断成“异常频繁”。
        lossless: true,
      })
    : { id: existingInboxId, suppressed: true };
  const notificationId = !needsUser ? null : addNotification(db, {
    itemId: args.itemId,
    kind: args.code,
    urgency: "immediate",
    title: `工单 #${args.itemId} 阻塞：${args.title.trim()}`,
    body,
    createdAt: (args.at ?? new Date()).toISOString(),
    dedupKey: `blocker:${blockerKey}`,
  });
  return {
    blockerKey,
    inboxId: inbox.id,
    notificationId,
    created: existingInboxId === null,
  };
}

export function raiseBlockerFromCheckpoint(
  db: Db,
  checkpoint: Checkpoint,
  options?: { dedupKey?: string; at?: Date; needsUser?: boolean },
): RaisedBlocker {
  const impact = checkpoint.keyFacts.find((fact) => /^(影响|impact)$/i.test(fact.label))?.value;
  return raiseBlocker(db, {
    // agent 报告自己受阻：先交给 Lead，它能答的自己答，答不了再找用户。
    needsUser: options?.needsUser ?? false,
    itemId: checkpoint.itemId,
    runId: checkpoint.runId,
    code: "blocked_checkpoint",
    title: checkpoint.title,
    summary: checkpoint.summary,
    impact,
    nextStep: checkpoint.nextStep ?? undefined,
    source: checkpoint.source === "agent_reported" ? "semantic" : "structural",
    dedupKey: options?.dedupKey ?? `checkpoint:${checkpoint.id}`,
    evidence: {
      checkpointId: checkpoint.id,
      source: checkpoint.source,
      keyFacts: checkpoint.keyFacts,
    },
    at: options?.at,
  });
}

/**
 * 撤回 raiseBlockerFromCheckpoint 为这些检查点升起的 blocker：inbox 行和通知。检查点本身保留。
 * 工单停在 blocked 时，启动时的补发会把它最新的 blocked 检查点再升成一条 blocker。
 * 这条 blocker 和检查点自己的 blocker 说的是同一件事，所以撤回时要一起撤回。
 */
export function retractCheckpointBlockers(db: Db, checkpointKeys: readonly string[]): number {
  let removed = 0;
  for (const key of checkpointKeys) {
    const checkpoint = db.prepare("SELECT id FROM checkpoints WHERE idempotency_key=?").get(key) as
      { id: number } | undefined;
    if (!checkpoint) continue;
    const blockerKey = `checkpoint:${checkpoint.id}`;
    removed += db.prepare(
      "DELETE FROM inbox WHERE severity='blocker' AND json_extract(payload, '$.blockerKey')=?",
    ).run(blockerKey).changes;
    removed += db.prepare("DELETE FROM notifications WHERE dedup_key=?").run(`blocker:${blockerKey}`).changes;
  }
  return removed;
}

/**
 * Repairs old blocked items whose checkpoint was written before blocker
 * delivery became a mandatory side effect.
 */
// 崩溃、交接失败、登记待处理这几条路径，检查点和它的 blocker 用同一个键（例如 run-crash:<runId>）。
// 这样的 blocker 已经升起过，补发就会给用户多一条通知。重启是常规操作（工单 15），
// 所以每次重启都会重复一次。inbox 行或通知任意一个还在，就算已经升起过。
// raiseBlockerFromCheckpoint 升起的 blocker 不管用什么键，证据里都有 checkpointId，也算升起过。
// 2026-10-29 以前 child 的 ticket_update 用 ticket-update:<检查点 id> 作键，修复认不出，
// 重启后把已经处置过的阻塞又交给了 Lead 一次（#366、#367、#433）。
function checkpointBlockerRaised(db: Db, itemId: number, checkpointId: number, key: string | null): boolean {
  if (key !== null && hasInboxBlocker(db, itemId, key) !== null) return true;
  if (findInboxBlocker(db, itemId, (payload) => payload.checkpointId === checkpointId) !== null) return true;
  return key !== null
    && Boolean(db.prepare("SELECT 1 FROM notifications WHERE dedup_key=? LIMIT 1").get(`blocker:${key}`));
}

export function repairMissingBlockerAlerts(db: Db, at = new Date()): number {
  const rows = db.prepare(
    `SELECT c.id, c.item_id, c.idempotency_key
     FROM checkpoints c
     JOIN items i ON i.id = c.item_id
     WHERE i.stage = 'blocked' AND c.kind = 'blocked'
       AND c.id = (
         SELECT MAX(latest.id) FROM checkpoints latest
         WHERE latest.item_id = c.item_id AND latest.kind = 'blocked'
       )
     ORDER BY c.id`,
  ).all() as Array<{ id: number; item_id: number; idempotency_key: string | null }>;
  let repaired = 0;
  for (const row of rows) {
    if (checkpointBlockerRaised(db, row.item_id, row.id, row.idempotency_key || null)) continue;
    const checkpoint = getCheckpoint(db, row.id);
    if (!checkpoint) continue;
    const result = raiseBlockerFromCheckpoint(db, checkpoint, { at });
    if (result.created) repaired++;
  }
  return repaired;
}
