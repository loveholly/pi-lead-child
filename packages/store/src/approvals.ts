// 审批门禁（DESIGN-GATEWAY §5）：不可逆动作（发送/支付/删除类）执行前必须获批。
import type { Db } from "./db.js";
import type { Approval } from "@pi-lead-child/core";

export type { Approval } from "@pi-lead-child/core";

const DEFAULT_TTL_MS = 30 * 60_000;

export function createApproval(
  db: Db,
  args: {
    itemId?: number; requestedBy: "child" | "lead"; tool: string; action: string;
    runId?: number; payload?: unknown; ttlMs?: number; now?: Date;
  },
): number {
  if (args.runId !== undefined) {
    const run = db.prepare("SELECT item_id FROM runs WHERE id = ?").get(args.runId) as
      { item_id: number } | undefined;
    if (!run) throw new Error(`run ${args.runId} not found`);
    if (args.itemId === undefined || run.item_id !== args.itemId) {
      throw new Error(`run ${args.runId} does not belong to item ${args.itemId ?? "none"}`);
    }
  }
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (args.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  const r = db.prepare(
    `INSERT INTO approvals (item_id, run_id, requested_by, tool, action, payload, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.itemId ?? null, args.runId ?? null, args.requestedBy, args.tool, args.action,
    JSON.stringify(args.payload ?? {}), expiresAt,
  );
  return Number(r.lastInsertRowid);
}

export function getApproval(db: Db, id: number): Approval | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Approval | undefined;
}

export function pendingApprovals(db: Db): Approval[] {
  return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as Approval[];
}

export function resolveApproval(
  db: Db,
  id: number,
  status: "approved" | "rejected",
  by: string,
  opts?: { sessionExempt?: boolean },
): boolean {
  return resolveApprovalAuthority(db, id, {
    status,
    resolvedBy: by,
    sessionExempt: opts?.sessionExempt ?? false,
  }) === "resolved";
}

export type ApprovalAuthorityResult = "resolved" | "idempotent" | "conflict";

export function resolveApprovalAuthority(
  db: Db,
  id: number,
  resolution: {
    status: "approved" | "rejected";
    resolvedBy: string;
    sessionExempt: boolean;
    now?: Date;
  },
): ApprovalAuthorityResult {
  const approval = getApproval(db, id);
  if (!approval) throw new Error(`approval ${id} not found`);
  const expectedSessionExempt = resolution.sessionExempt ? 1 : 0;
  const identical = approval.status === resolution.status
    && approval.session_exempt === expectedSessionExempt;
  if (approval.status !== "pending") return identical ? "idempotent" : "conflict";
  const result = db.prepare(
    `UPDATE approvals
     SET status = ?, resolved_by = ?, resolved_at = ?, session_exempt = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(
    resolution.status,
    resolution.resolvedBy,
    (resolution.now ?? new Date()).toISOString(),
    expectedSessionExempt,
    id,
  );
  if (result.changes === 1) return "resolved";
  const current = getApproval(db, id);
  return current?.status === resolution.status && current.session_exempt === expectedSessionExempt
    ? "idempotent"
    : "conflict";
}

/**
 * 用户否认了一次批准（工单 15 的「不是我」）：还没有人用它时，批准改为拒绝，会话豁免一并取消。
 * 只改 status 是 approved 的行。返回有没有改。
 */
export function withdrawApproval(db: Db, id: number, by: string, now: Date = new Date()): boolean {
  return db.prepare(
    `UPDATE approvals SET status = 'rejected', session_exempt = 0, resolved_by = ?, resolved_at = ?
     WHERE id = ? AND status = 'approved'`,
  ).run(by, now.toISOString(), id).changes === 1;
}

/** 只取消一条批准的会话豁免（被批准的动作已经执行，批准本身不改）。返回有没有改。 */
export function clearApprovalSessionExemption(db: Db, id: number): boolean {
  return db.prepare("UPDATE approvals SET session_exempt = 0 WHERE id = ? AND session_exempt = 1").run(id).changes === 1;
}

// 到期未响应 → expired（返回被过期的 id，供通知）
export function expireStale(db: Db, now: Date): number[] {
  const stale = db.prepare(
    `UPDATE approvals SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND expires_at <= ?
     RETURNING id`,
  ).all(now.toISOString(), now.toISOString()) as Array<{ id: number }>;
  return stale.map((row) => row.id).sort((left, right) => left - right);
}

// 会话豁免：同工单同 tool 已有 approved + session_exempt → 后续免批
export function isSessionExempt(db: Db, itemId: number, tool: string): boolean {
  const r = db.prepare(
    "SELECT 1 FROM approvals WHERE item_id = ? AND tool = ? AND status = 'approved' AND session_exempt = 1 LIMIT 1",
  ).get(itemId, tool);
  return !!r;
}

export interface PendingApprovalProjectionGap {
  authority: Approval;
  checkpointId: number | null;
  cardId: number | null;
}

export function findPendingApprovalProjectionGaps(db: Db): PendingApprovalProjectionGap[] {
  const rows = db.prepare(
    `SELECT a.*,
       (SELECT c.id FROM checkpoints c
        WHERE c.action_type = 'approval' AND c.action_id = a.id
          AND c.item_id = a.item_id
        ORDER BY c.id DESC LIMIT 1) AS checkpoint_id,
       (SELECT cc.id FROM conversation_cards cc
        JOIN checkpoints c ON c.id = cc.checkpoint_id
        WHERE cc.kind = 'intervention'
          AND cc.action_type = 'approval' AND cc.action_id = a.id
          AND cc.item_id = a.item_id
          AND c.item_id = a.item_id
          AND c.action_type = 'approval' AND c.action_id = a.id
        ORDER BY cc.id DESC LIMIT 1) AS card_id
     FROM approvals a
     WHERE a.status = 'pending' AND a.item_id IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM checkpoints c
                   WHERE c.action_type = 'approval' AND c.action_id = a.id
                     AND c.item_id = a.item_id)
       OR NOT EXISTS (
         SELECT 1 FROM conversation_cards cc
         JOIN checkpoints c ON c.id = cc.checkpoint_id
         WHERE cc.kind = 'intervention'
           AND cc.action_type = 'approval' AND cc.action_id = a.id
           AND cc.item_id = a.item_id
           AND c.item_id = a.item_id
           AND c.action_type = 'approval' AND c.action_id = a.id
       )
     )
     ORDER BY a.id`,
  ).all() as Array<Approval & { checkpoint_id: number | null; card_id: number | null }>;
  return rows.map(({ checkpoint_id, card_id, ...authority }) => ({
    authority,
    checkpointId: checkpoint_id,
    cardId: card_id,
  }));
}
