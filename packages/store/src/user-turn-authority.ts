import { bindingOriginLabel, bindingOriginOf, type BindingOrigin, type Scope } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { bindingScopes } from "./gateway.js";

// 对话里的结构化授权（authorize_retry，以及工单操作层里 Lead 代你做的操作，engine 的 ticket-actions/authority.ts）
// 以哪一轮为凭：当前还在进行的已配对用户轮次。
// 轮次行由网关在认证过的配对连接上创建，Lead 改不了它；Lead 只负责把这一轮里用户的话理解成结构化参数。
// Lead 自己发起的回合（system:*）和已经结束的轮次都不算。
// 来自的凭证已经作废的轮次也不算（审查 H1）：「不是我」作废了凭证以后，它那一轮即使还在进行，也不能再授权任何事。
// 这一轮的凭证自己做不了的操作也不算（.scratch/child-self-approve/options.md）：Lead 代做的权限不能大过这一轮的凭证。
// 例如 child 用 plc 的 CLI 凭证开一轮聊天说「批准 #N」，这个凭证没有 approvals:respond，Lead 也就不能凭这一轮代批。
export interface PairedUserTurn {
  id: string;
  origin_binding_id: number;
  origin_kind: string;
  state: string;
  // 这一轮开始的时间（用户的消息到达时）。
  created_at: string;
}

// 用户本人设的跟进到点、daemon 只为它开的一轮（用户 2026-10-27：「定时器是只有我能发的」）算用户的一轮，凭的是
// timer:<跟进的 inbox 编号>。这个编号由 daemon 给，Lead 填不了。跟进要是在用户本人的一轮里设的（payload.setBy，inbox.ts 的
// addLeadFollowUp），凭的是设它那一轮来自的配对凭证：凭证作废了、scope 不够、跟进取消了或者还没到点都不算。
// 这一轮开始的时间按设它的那一轮算：之后才出现的东西（例如新的审批），用户设定时器时没见过。
export const SCHEDULED_TURN_PREFIX = "timer:";

/** 跟进记下的「谁设的」：用户本人那一轮的编号、来自的凭证、那一轮开始的时间。 */
export interface FollowUpSetBy {
  turnId: string;
  bindingId: number;
  startedAt: string;
}

function scheduledUserTurn(db: Db, turnId: string, label: string, scope: Scope): PairedUserTurn {
  const inboxId = Number(turnId.slice(SCHEDULED_TURN_PREFIX.length));
  const row = Number.isSafeInteger(inboxId)
    ? db.prepare("SELECT payload FROM inbox WHERE id=?").get(inboxId) as { payload: string } | undefined
    : undefined;
  let payload: { kind?: unknown; notBefore?: unknown; setBy?: Partial<FollowUpSetBy>; disposition?: { kind?: unknown } } = {};
  try {
    payload = row ? JSON.parse(row.payload) : {};
  } catch {
    payload = {};
  }
  const setBy = payload.setBy;
  if (!row || payload.kind !== "lead_followup" || !setBy || typeof setBy.bindingId !== "number" || typeof setBy.startedAt !== "string") {
    throw new Error(`${label} ${turnId} is not a follow-up the user set in their own turn`);
  }
  // 取消的跟进：inbox 行是 consumed，取消记在 disposition 里（inbox.ts 的 cancelLeadFollowUp）。
  if (payload.disposition?.kind === "cancelled") throw new Error(`${label} ${turnId} was cancelled`);
  if (typeof payload.notBefore !== "string" || payload.notBefore > new Date().toISOString()) {
    throw new Error(`${label} ${turnId} is not due yet`);
  }
  const binding = db.prepare("SELECT status, kind, origin, scopes FROM bindings WHERE id=?").get(setBy.bindingId) as {
    status: string; kind: string; origin: string | null; scopes: string | null;
  } | undefined;
  if (!binding || binding.status !== "active") {
    throw new Error(`${label} ${turnId} was set from a credential that is no longer active`);
  }
  const credential = { kind: binding.kind, origin: binding.origin, scopes: binding.scopes ?? "[]" };
  if (!bindingScopes(credential).includes(scope)) {
    const origin = bindingOriginOf(credential);
    throw new UserTurnScopeError(turnId, scope, origin,
      `${label} needs ${scope}, and ${turnId} was set from ${bindingOriginLabel(origin)}, which does not carry it`);
  }
  return { id: turnId, origin_binding_id: setBy.bindingId, origin_kind: "paired:timer", state: "streaming", created_at: setBy.startedAt };
}

/** 这一轮的凭证没有这个操作要的 scope。调用方据此写明是哪种凭证、用户去哪里点。 */
export class UserTurnScopeError extends Error {
  constructor(readonly turnId: string, readonly scope: Scope, readonly origin: BindingOrigin, message: string) {
    super(message);
    this.name = "UserTurnScopeError";
  }
}

/**
 * 当前已认证的配对用户轮次，并且这一轮的凭证有这个操作要的 scope（scope：用户自己点这个操作时，页面入口要的 scope）。
 * 不是时抛错；凭证不够时抛 UserTurnScopeError。
 */
export function activePairedUserTurn(db: Db, turnId: string | null, label: string, scope: Scope): PairedUserTurn {
  if (!turnId) throw new Error(`${label} requires the current authenticated user turn`);
  if (turnId.startsWith(SCHEDULED_TURN_PREFIX)) return scheduledUserTurn(db, turnId, label, scope);
  const turn = db.prepare(
    `SELECT t.id, t.origin_binding_id, t.origin_kind, t.state, t.created_at,
            b.status AS binding_status, b.kind AS binding_kind, b.origin AS binding_origin, b.scopes AS binding_scopes
     FROM channel_turns t LEFT JOIN bindings b ON b.id = t.origin_binding_id
     WHERE t.id=?`,
  ).get(turnId) as {
    id: string;
    origin_binding_id: number | null;
    origin_kind: string;
    state: string;
    created_at: string;
    binding_status: string | null;
    binding_kind: string | null;
    binding_origin: string | null;
    binding_scopes: string | null;
  } | undefined;
  if (!turn || turn.origin_binding_id === null || !turn.origin_kind.startsWith("paired:")) {
    throw new Error(`${label} must come from an authenticated paired user turn`);
  }
  if (!["queued", "streaming"].includes(turn.state)) {
    throw new Error(`${label} turn ${turn.id} is no longer active`);
  }
  if (turn.binding_status !== "active") {
    throw new Error(`${label} turn ${turn.id} came from a credential that is no longer active`);
  }
  const credential = { kind: turn.binding_kind ?? "", origin: turn.binding_origin, scopes: turn.binding_scopes ?? "[]" };
  if (!bindingScopes(credential).includes(scope)) {
    const origin = bindingOriginOf(credential);
    throw new UserTurnScopeError(turn.id, scope, origin,
      `${label} needs ${scope}, and turn ${turn.id} came from ${bindingOriginLabel(origin)}, which does not carry it`);
  }
  return {
    id: turn.id, origin_binding_id: turn.origin_binding_id, origin_kind: turn.origin_kind, state: turn.state,
    created_at: turn.created_at,
  };
}
