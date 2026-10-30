// Lead 修改常设指令（Lead 事件主干 spec D4，工单 10）。三档的判断在 protocol 的 standing-order-tiers.ts（纯函数）。
//
// 流程：
//   - proposeStandingOrderChange：Lead 提出新增、修改、停用、启用或回滚。在一个 IMMEDIATE 事务里算出改之前和改之后的样子，
//     判断档位：
//       conservative 更保守：马上写新版本（作者 lead），同时写一条 standing_order.changed 事件（digest：在「Lead 动态」里告诉用户）。
//       permissive 更放开：写一条审批（approvals 表，item_id 为空，tool=standing_order.change，24 小时过期），不写新版本。
//       forbidden 碰到硬性规则：什么也不写。
//   - resolveStandingOrderProposal：用户批准或拒绝。只由网关的路由调用（权限 approvals:respond）。批准时再检查一次：
//     指令在提议之后又写了新版本、提议过期了，或者现在碰到硬性规则，提议作废，不生效。批准后写新版本：作者 lead，批准人是用户。
//   - rollbackStandingOrderByUser：用户在设置页回滚到某一版。作者 user，批准人是用户自己，直接生效。
//   - noteExpiredStandingOrderProposal：审批过期以后（engine 的 expireInterventions）告诉 Lead。
// 每写一个新版本，同一条指令还在等批准的旧提议都作废（superseded）：它们的档位是按旧版本判断的。
// 结果（批准、拒绝、过期）经 inbox 告诉 Lead，不叫醒它：是用户自己做的决定，不用 Lead 再转告。
//
// 「更放开」的修改只有一条路生效：resolveStandingOrderProposal 带 approve=true，并且 resolvedBy 是「user via <渠道>」。
// Lead 的工具不调用它；engine 的 resolveApproval（Lead 的 perform_action、Slack 按钮）遇到这类审批直接拒绝。
import {
  classifyStandingOrderChange, STANDING_ORDER_AUTHORS, STANDING_ORDER_CHANGE_OPS, STANDING_ORDER_STATUSES, standingOrderLevel,
  TRIAGE_LEVEL_LABELS, validateStandingOrderDefinition,
  type StandingOrder, type StandingOrderChangeClassification, type StandingOrderChangeFinding, type StandingOrderChangeOp,
  type StandingOrderChangeTier, type StandingOrderDefinition, type StandingOrderState, type StandingOrderStatus,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { createApproval, getApproval, type Approval } from "./approvals.js";
import { appendEvent, clipEventText, type EventRecord } from "./events.js";
import { addInbox } from "./inbox.js";
import { systemStandingOrderSeeds } from "./standing-order-seeds.js";
import { activeStandingOrders, getStandingOrder, recordStandingOrderVersion } from "./standing-orders.js";

// 审批的 tool：这类审批是 Lead 提议的常设指令修改。
export const STANDING_ORDER_PROPOSAL_TOOL = "standing_order.change";
// 提议等用户决定多久。过期了不生效（approvals 的 expireStale）。
export const STANDING_ORDER_PROPOSAL_TTL_MS = 24 * 60 * 60_000;
export const STANDING_ORDER_CHANGED_KIND = "standing_order.changed";
// standing_order.changed 的级别由代码定（digest），不进常设指令：Lead 改了指令一定要告诉用户。
export const STANDING_ORDER_CHANGE_REPORTED = "standing_order_change_reported";

const REASON_MAX = 2_000;
const TITLE_MAX = 200;

export type StandingOrderChangeErrorCode = "invalid_request" | "not_found" | "conflict" | "forbidden";

export class StandingOrderChangeError extends Error {
  constructor(readonly code: StandingOrderChangeErrorCode, message: string) {
    super(message);
    this.name = "StandingOrderChangeError";
  }
}

/** update 时要改的字段。没给的字段沿用现在的版本；limits、escalateTo 给 null 表示清掉。 */
export type StandingOrderPatch = Partial<Pick<StandingOrderDefinition, "title" | "priority" | "condition" | "action" | "limits" | "escalateTo">>;

export interface StandingOrderChangeRequest {
  op: StandingOrderChangeOp;
  id: string;
  // 为什么改。写进新版本的 reason。
  reason: string;
  // create：完整的内容（title、priority、condition、action，limits 和 escalateTo 可以不给）。update：要改的字段。
  patch?: StandingOrderPatch;
  // rollback：回到哪一版。缺省是上一版（最新版本减 1）。
  toVersion?: number;
}

export interface StandingOrderChangePlan {
  op: StandingOrderChangeOp;
  id: string;
  reason: string;
  // 改之前：这条指令现在的版本（停用的也算；库里不合格的系统指令是代码里的种子，第 0 版）。新增时是 null。
  before: StandingOrder | null;
  // 改之前库里的最新版本号。新增时是 null。批准时用它检查指令有没有又变过。
  baseVersion: number | null;
  // 改之后的样子。reason 是这次的原因。
  after: StandingOrderState;
  rollbackTo: number | null;
  classification: StandingOrderChangeClassification;
  // 一句话说明改了什么。
  summary: string;
}

const OP_LABELS: Record<StandingOrderChangeOp, string> = {
  create: "新增", update: "修改", disable: "停用", enable: "启用", rollback: "回滚",
};

function latestVersion(db: Db, id: string): number | null {
  const row = db.prepare("SELECT MAX(version) AS v FROM standing_orders WHERE order_id = ?").get(id) as { v: number | null };
  return row.v;
}

const usable = (order: StandingOrder) => (STANDING_ORDER_AUTHORS as readonly string[]).includes(order.author)
  && (STANDING_ORDER_STATUSES as readonly string[]).includes(order.status)
  && validateStandingOrderDefinition(order).length === 0;

// 这条指令现在的样子：生效的版本（不合格的系统指令换成种子）；没有生效的版本时是最新的停用版本。
function currentOrder(db: Db, id: string): StandingOrder | null {
  const effective = activeStandingOrders(db).find((order) => order.id === id);
  if (effective) return effective;
  const latest = getStandingOrder(db, id);
  return latest && usable(latest) ? latest : null;
}

const definitionOf = (order: StandingOrderDefinition): StandingOrderDefinition => ({
  id: order.id, title: order.title, priority: order.priority, condition: order.condition, action: order.action,
  limits: order.limits, escalateTo: order.escalateTo, reason: order.reason,
});

const has = <K extends keyof StandingOrderPatch>(patch: StandingOrderPatch, key: K): boolean => patch[key] !== undefined;

function checkText(reason: string): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw new StandingOrderChangeError("invalid_request", "要写原因：为什么改这条指令");
  if (text.length > REASON_MAX) throw new StandingOrderChangeError("invalid_request", `原因最多 ${REASON_MAX} 字`);
  return text;
}

function afterState(db: Db, request: StandingOrderChangeRequest, before: StandingOrder | null, baseVersion: number | null, reason: string): {
  after: StandingOrderState; rollbackTo: number | null;
} {
  const patch = request.patch ?? {};
  const need = (what: string) => {
    if (!before) throw new StandingOrderChangeError("not_found", `没有常设指令 ${request.id}。用 list_standing_orders 看全部编号；要新增用 op=create`);
    return what;
  };
  switch (request.op) {
    case "create": {
      if (baseVersion !== null || systemStandingOrderSeeds().some((seed) => seed.id === request.id)) {
        throw new StandingOrderChangeError("conflict", `已经有常设指令 ${request.id}，要改它用 op=update`);
      }
      for (const key of ["title", "priority", "condition", "action"] as const) {
        if (!has(patch, key)) throw new StandingOrderChangeError("invalid_request", `新增指令要给 ${key}`);
      }
      return {
        after: {
          id: request.id, title: patch.title!, priority: patch.priority!, condition: patch.condition!, action: patch.action!,
          limits: patch.limits ?? null, escalateTo: patch.escalateTo ?? null, reason, status: "active",
        },
        rollbackTo: null,
      };
    }
    case "update": {
      need("update");
      if (!Object.values(patch).some((value) => value !== undefined)) {
        throw new StandingOrderChangeError("invalid_request", "update 要给至少一个要改的字段（title、priority、condition、action、limits、escalate_to）");
      }
      return {
        after: {
          ...definitionOf(before!),
          ...(has(patch, "title") ? { title: patch.title! } : {}),
          ...(has(patch, "priority") ? { priority: patch.priority! } : {}),
          ...(has(patch, "condition") ? { condition: patch.condition! } : {}),
          ...(has(patch, "action") ? { action: patch.action! } : {}),
          ...(has(patch, "limits") ? { limits: patch.limits! } : {}),
          ...(has(patch, "escalateTo") ? { escalateTo: patch.escalateTo! } : {}),
          reason,
          status: before!.status,
        },
        rollbackTo: null,
      };
    }
    case "disable":
    case "enable": {
      need(request.op);
      const status: StandingOrderStatus = request.op === "disable" ? "disabled" : "active";
      if (before!.status === status) {
        throw new StandingOrderChangeError("conflict", `常设指令 ${request.id} 已经是${request.op === "disable" ? "停用" : "生效"}的`);
      }
      return { after: { ...definitionOf(before!), reason, status }, rollbackTo: null };
    }
    case "rollback": {
      need("rollback");
      if (baseVersion === null) throw new StandingOrderChangeError("not_found", `常设指令 ${request.id} 在库里还没有版本，不能回滚`);
      const toVersion = request.toVersion ?? baseVersion - 1;
      if (!Number.isInteger(toVersion) || toVersion < 1 || toVersion >= baseVersion) {
        throw new StandingOrderChangeError("invalid_request", `只能回滚到 v1 到 v${baseVersion - 1} 之间的一版（现在是 v${baseVersion}）`);
      }
      const target = getStandingOrder(db, request.id, toVersion);
      if (!target || !usable(target)) {
        throw new StandingOrderChangeError("invalid_request", `常设指令 ${request.id} 的 v${toVersion} 读不出来或者不合格，不能回滚到它`);
      }
      return { after: { ...definitionOf(target), reason, status: target.status }, rollbackTo: toVersion };
    }
  }
}

function levelPhrase(order: StandingOrderState): string {
  const level = standingOrderLevel(order);
  return level ? `${level}（${TRIAGE_LEVEL_LABELS[level]}）` : order.action.type === "rule" ? `规则 ${order.action.rule}` : "";
}

function planSummary(plan: Omit<StandingOrderChangePlan, "summary">): string {
  const { op, id, after, rollbackTo, classification } = plan;
  const head = op === "create" ? `新增常设指令 ${id}「${after.title}」：${levelPhrase(after)}`
    : op === "rollback" ? `把常设指令 ${id} 回滚到 v${rollbackTo}`
    : `${OP_LABELS[op]}常设指令 ${id}「${after.title}」`;
  const details = classification.findings.slice(0, 4).map((item) => item.detail);
  return clipEventText([head, ...details].join("；"), 600);
}

/**
 * 算出一次修改的计划：改之前、改之后、档位。只读，不写库。请求不合格时抛 StandingOrderChangeError。
 * 判断用现在生效的全部指令（activeStandingOrders）。
 */
export function planStandingOrderChange(db: Db, request: StandingOrderChangeRequest): StandingOrderChangePlan {
  if (!(STANDING_ORDER_CHANGE_OPS as readonly string[]).includes(request.op)) {
    throw new StandingOrderChangeError("invalid_request", `op 要是 ${STANDING_ORDER_CHANGE_OPS.join("、")} 之一`);
  }
  if (typeof request.id !== "string" || !request.id) throw new StandingOrderChangeError("invalid_request", "要给指令编号 id");
  const reason = checkText(request.reason);
  if (request.patch?.title !== undefined && (typeof request.patch.title !== "string" || request.patch.title.length > TITLE_MAX)) {
    throw new StandingOrderChangeError("invalid_request", `标题最多 ${TITLE_MAX} 字`);
  }
  const before = currentOrder(db, request.id);
  const baseVersion = latestVersion(db, request.id);
  const { after, rollbackTo } = afterState(db, request, before, baseVersion, reason);
  const errors = validateStandingOrderDefinition(after);
  if (errors.length) {
    const hint = errors.some((error) => error.startsWith("escalateTo")) ? "（改级别时，escalate_to 要一起改成更高的级别或者 null）" : "";
    throw new StandingOrderChangeError("invalid_request", `新内容不合格：${errors.join("；")}${hint}`);
  }
  const classification = classifyStandingOrderChange({ active: activeStandingOrders(db), before, after });
  const plan = { op: request.op, id: request.id, reason, before, baseVersion, after, rollbackTo, classification };
  return { ...plan, summary: planSummary(plan) };
}

// ── 写新版本 ──────────────────────────────────────────────────────────────────────

interface WriteMeta {
  author: "lead" | "user";
  approvedBy: string | null;
  // conservative：Lead 的更保守的修改；permissive：用户批准的 Lead 的修改；user：用户自己改的。
  tier: "conservative" | "permissive" | "user";
  approvalId: number | null;
  now: Date;
}

export interface StandingOrderWritten {
  order: StandingOrder;
  event: EventRecord;
  // 因为这个新版本作废的提议（审批号）。
  superseded: number[];
}

// 写新版本和 standing_order.changed 事件，作废同一条指令的旧提议。调用方在写事务里。
function writeVersion(db: Db, plan: StandingOrderChangePlan, meta: WriteMeta): StandingOrderWritten {
  const latest = latestVersion(db, plan.id);
  if (latest !== plan.baseVersion) {
    throw new StandingOrderChangeError("conflict", `常设指令 ${plan.id} 在这之后又写了新版本（现在是 v${latest}），要按新版本重新判断`);
  }
  const { status, ...definition } = plan.after;
  const order = recordStandingOrderVersion(db, definition, {
    author: meta.author, status, approvedBy: meta.approvedBy, at: meta.now,
  });
  const superseded = voidPendingProposals(db, plan.id, meta.now, meta.approvalId);
  const { event } = appendEvent(db, {
    source: meta.author === "lead" ? "lead" : "system",
    sourceRef: `standing_order:${order.id}:v${order.version}`,
    kind: STANDING_ORDER_CHANGED_KIND,
    entityKey: `standing_order:${order.id}`,
    entityVersion: order.version,
    occurredAt: meta.now.toISOString(),
    level: "digest",
    payload: {
      orderId: order.id,
      version: order.version,
      previousVersion: plan.baseVersion,
      title: order.title,
      author: meta.author,
      approvedBy: meta.approvedBy,
      change: plan.op,
      tier: meta.tier,
      reason: clipEventText(plan.reason, 1_000),
      summary: plan.summary,
      approvalId: meta.approvalId,
      rolledBackTo: plan.rollbackTo,
    },
  }, { basis: { order: null, hardRules: [STANDING_ORDER_CHANGE_REPORTED] }, receivedAt: meta.now });
  return { order, event, superseded };
}

// ── 提议（审批） ──────────────────────────────────────────────────────────────────

// 审批的 payload。appliedVersion 和 voided 在处理时写进去。
interface ProposalPayload {
  kind: "standing_order_change";
  op: StandingOrderChangeOp;
  orderId: string;
  baseVersion: number | null;
  rollbackTo: number | null;
  reason: string;
  summary: string;
  definition: StandingOrderDefinition;
  status: StandingOrderStatus;
  tier: StandingOrderChangeTier;
  findings: StandingOrderChangeFinding[];
  appliedVersion?: number;
  // 系统作废的原因：superseded（指令又写了新版本，或者 Lead 提了新的提议）、hard_rule（批准时碰到硬性规则）。
  voided?: "superseded" | "hard_rule";
}

export type StandingOrderProposalState = "pending" | "approved" | "rejected" | "expired";

export interface StandingOrderProposal {
  approvalId: number;
  orderId: string;
  op: StandingOrderChangeOp;
  state: StandingOrderProposalState;
  voidedReason: string | null;
  summary: string;
  reason: string;
  baseVersion: number | null;
  appliedVersion: number | null;
  rollbackTo: number | null;
  definition: StandingOrderDefinition;
  proposedStatus: StandingOrderStatus;
  findings: StandingOrderChangeFinding[];
  requestedAt: string;
  expiresAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/** 这条审批是不是 Lead 提议的常设指令修改。 */
export function isStandingOrderProposal(approval: Pick<Approval, "tool" | "item_id">): boolean {
  return approval.tool === STANDING_ORDER_PROPOSAL_TOOL && approval.item_id === null;
}

/**
 * 推给用户的一行审批说明（daemon 在审批快过期、还没送到用户时推送）。常设指令的提议只能在确认卡或设置页里决定，
 * 所以不说「回复批准」。
 */
export function pendingApprovalLine(approval: Approval): string {
  if (!isStandingOrderProposal(approval)) return `工单 #${approval.item_id ?? "-"} 需审批「${approval.tool}」：${approval.action}`;
  return `${approval.action}（在会话里的确认卡或设置 → 常设指令里批准）`;
}

function parsePayload(approval: Approval): ProposalPayload | null {
  try {
    const value = JSON.parse(approval.payload) as ProposalPayload;
    return value && value.kind === "standing_order_change" && typeof value.orderId === "string" ? value : null;
  } catch {
    return null;
  }
}

// approvals.created_at 是 datetime('now') 的格式（UTC，没有时区）。统一成 ISO。
function isoTime(value: string | null): string | null {
  if (value === null) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function toProposal(approval: Approval, now: Date): StandingOrderProposal | null {
  const payload = parsePayload(approval);
  if (!payload) return null;
  // 过了期限还没有处理的，按过期显示（expireStale 下一拍会把它记成 expired）。
  const overdue = approval.status === "pending" && Date.parse(approval.expires_at) <= now.getTime();
  return {
    approvalId: approval.id,
    orderId: payload.orderId,
    op: payload.op,
    state: overdue ? "expired" : approval.status,
    voidedReason: payload.voided ?? null,
    summary: payload.summary,
    reason: payload.reason,
    baseVersion: payload.baseVersion,
    appliedVersion: payload.appliedVersion ?? null,
    rollbackTo: payload.rollbackTo,
    definition: payload.definition,
    proposedStatus: payload.status,
    findings: Array.isArray(payload.findings) ? payload.findings : [],
    requestedAt: isoTime(approval.created_at) ?? approval.created_at,
    expiresAt: isoTime(approval.expires_at) ?? approval.expires_at,
    resolvedBy: approval.resolved_by,
    resolvedAt: isoTime(approval.resolved_at),
  };
}

/** 读一个提议（包括已经处理过的）。不是常设指令的提议时返回 undefined。 */
export function getStandingOrderProposal(db: Db, approvalId: number, now: Date = new Date()): StandingOrderProposal | undefined {
  const approval = getApproval(db, approvalId);
  if (!approval || !isStandingOrderProposal(approval)) return undefined;
  return toProposal(approval, now) ?? undefined;
}

/** 提议，从新到旧。pendingOnly 时只列还在等用户决定的。orderId 只列这条指令的。 */
export function listStandingOrderProposals(
  db: Db, options: { orderId?: string; pendingOnly?: boolean; limit?: number; now?: Date } = {},
): StandingOrderProposal[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
  const where = ["tool = ?", "item_id IS NULL"];
  const values: unknown[] = [STANDING_ORDER_PROPOSAL_TOOL];
  if (options.pendingOnly) where.push("status = 'pending'");
  if (options.orderId !== undefined) {
    where.push("json_valid(payload) AND json_extract(payload, '$.orderId') = ?");
    values.push(options.orderId);
  }
  const now = options.now ?? new Date();
  return (db.prepare(`SELECT * FROM approvals WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...values, limit) as Approval[])
    .map((approval) => toProposal(approval, now))
    .filter((proposal): proposal is StandingOrderProposal => proposal !== null
      && (!options.pendingOnly || proposal.state === "pending"));
}

// 把一条还在等的提议记成过期（系统作废）。payload 记下原因。返回有没有改。
function voidProposal(db: Db, approval: Approval, reason: NonNullable<ProposalPayload["voided"]>, now: Date): boolean {
  const payload = parsePayload(approval);
  return db.prepare(
    `UPDATE approvals SET status = 'expired', resolved_by = ?, resolved_at = ?, payload = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(`system: ${reason}`, now.toISOString(), JSON.stringify({ ...(payload ?? {}), voided: reason }), approval.id).changes > 0;
}

// 同一条指令还在等的提议都作废（except 是正在批准的那一个）。返回作废了哪些。
function voidPendingProposals(db: Db, orderId: string, now: Date, except: number | null): number[] {
  const rows = db.prepare(
    `SELECT * FROM approvals WHERE tool = ? AND item_id IS NULL AND status = 'pending'
       AND json_valid(payload) AND json_extract(payload, '$.orderId') = ?`,
  ).all(STANDING_ORDER_PROPOSAL_TOOL, orderId) as Approval[];
  return rows.filter((row) => row.id !== except && voidProposal(db, row, "superseded", now)).map((row) => row.id);
}

function approvalAction(plan: StandingOrderChangePlan): string {
  return clipEventText(`Lead 提议${OP_LABELS[plan.op]}常设指令 ${plan.id}：${plan.summary}。原因：${plan.reason}`, 800);
}

// 告诉 Lead 它的提议有了结果。不叫醒它：用户自己做的决定，下一轮 Lead 自然会看到。
function tellLead(db: Db, proposal: { approvalId: number; orderId: string }, state: string, summary: string): void {
  addInbox(db, {
    dedupScope: `standing-order-proposal:${proposal.approvalId}`,
    severity: "attention",
    source: "structural",
    lossless: true,
    summary,
    payload: {
      kind: "standing_order_proposal", approvalId: proposal.approvalId, orderId: proposal.orderId, state,
      wakeLead: false, needsUser: false,
    },
  });
}

export type StandingOrderProposeResult =
  | { outcome: "applied"; plan: StandingOrderChangePlan; written: StandingOrderWritten }
  | { outcome: "pending_approval"; plan: StandingOrderChangePlan; proposal: StandingOrderProposal; superseded: number[] }
  | { outcome: "refused"; plan: StandingOrderChangePlan }
  | { outcome: "unchanged"; plan: StandingOrderChangePlan };

/**
 * Lead 提出一次修改（propose_standing_order_change）。在一个 IMMEDIATE 事务里判断档位并处理：
 * 更保守的马上写新版本；更放开的写审批，等用户批准；碰到硬性规则的什么也不写。请求不合格时抛 StandingOrderChangeError。
 */
export function proposeStandingOrderChange(
  db: Db, request: StandingOrderChangeRequest, options: { now?: Date } = {},
): StandingOrderProposeResult {
  const now = options.now ?? new Date();
  return db.transaction((): StandingOrderProposeResult => {
    const plan = planStandingOrderChange(db, request);
    if (!plan.classification.changed) return { outcome: "unchanged", plan };
    if (plan.classification.tier === "forbidden") return { outcome: "refused", plan };
    if (plan.classification.tier === "conservative") {
      return { outcome: "applied", plan, written: writeVersion(db, plan, { author: "lead", approvedBy: null, tier: "conservative", approvalId: null, now }) };
    }
    // 更放开：同一条指令更早的提议作废，换成这一个。
    const superseded = voidPendingProposals(db, plan.id, now, null);
    const payload: ProposalPayload = {
      kind: "standing_order_change", op: plan.op, orderId: plan.id, baseVersion: plan.baseVersion, rollbackTo: plan.rollbackTo,
      reason: plan.reason, summary: plan.summary, definition: definitionOf(plan.after), status: plan.after.status,
      tier: plan.classification.tier, findings: plan.classification.findings,
    };
    const approvalId = createApproval(db, {
      requestedBy: "lead", tool: STANDING_ORDER_PROPOSAL_TOOL, action: approvalAction(plan), payload,
      ttlMs: STANDING_ORDER_PROPOSAL_TTL_MS, now,
    });
    return { outcome: "pending_approval", plan, proposal: getStandingOrderProposal(db, approvalId, now)!, superseded };
  }).immediate();
}

// 只有用户能批准：resolvedBy 要写成「user via <渠道>」，渠道不能是 lead。和 engine 的 assertExplicitUserChannel 一样。
function assertUserResolver(resolvedBy: string): void {
  const channel = /^user via (.+)$/.exec(resolvedBy ?? "")?.[1]?.trim();
  if (!channel || channel.toLowerCase() === "lead") {
    throw new StandingOrderChangeError("forbidden", "只有用户能批准或回滚常设指令（要写明是哪个渠道的用户）");
  }
}

export interface StandingOrderProposalResolution {
  proposal: StandingOrderProposal;
  // 批准后写的新版本和事件。拒绝时是 null。
  written: StandingOrderWritten | null;
}

/**
 * 用户批准或拒绝 Lead 的一个提议。只由网关的路由调用（权限 approvals:respond）；Lead 的工具走不到这里。
 * 已经处理过、过期、或者指令在提议之后又变了时抛 conflict（后两种同时把提议记成过期）。
 */
export function resolveStandingOrderProposal(
  db: Db, approvalId: number, decision: { approve: boolean; resolvedBy: string; now?: Date },
): StandingOrderProposalResolution {
  assertUserResolver(decision.resolvedBy);
  const now = decision.now ?? new Date();
  const result = db.transaction((): StandingOrderProposalResolution | { conflict: string } => {
    const approval = getApproval(db, approvalId);
    const payload = approval && isStandingOrderProposal(approval) ? parsePayload(approval) : null;
    if (!approval || !payload) throw new StandingOrderChangeError("not_found", `没有常设指令的提议 #${approvalId}`);
    if (approval.status !== "pending") return { conflict: `提议 #${approvalId} 已经处理过了（${approval.status}）` };
    const ref = { approvalId, orderId: payload.orderId };
    if (Date.parse(approval.expires_at) <= now.getTime()) {
      db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now.toISOString(), approvalId);
      tellLead(db, ref, "expired", `你提议的常设指令修改 #${approvalId}（${payload.summary}）过期了，用户没来得及决定，没有生效。`);
      return { conflict: `提议 #${approvalId} 过期了，没有生效` };
    }
    if (!decision.approve) {
      db.prepare("UPDATE approvals SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(decision.resolvedBy, now.toISOString(), approvalId);
      tellLead(db, ref, "rejected", `${decision.resolvedBy} 没有批准你提议的常设指令修改 #${approvalId}（${payload.summary}）。指令照旧。`);
      return { proposal: getStandingOrderProposal(db, approvalId, now)!, written: null };
    }
    const base = latestVersion(db, payload.orderId);
    if (base !== payload.baseVersion) {
      voidProposal(db, approval, "superseded", now);
      tellLead(db, ref, "superseded", `你提议的常设指令修改 #${approvalId} 作废了：指令 ${payload.orderId} 在这之后又写了新版本（v${base}）。`);
      return { conflict: `常设指令 ${payload.orderId} 在提议之后又变了（现在是 v${base}），这个提议作废` };
    }
    // 按现在生效的指令再判断一次：碰到硬性规则就不生效（例如代码在这之间加了规则）。
    const before = currentOrder(db, payload.orderId);
    const after: StandingOrderState = { ...payload.definition, status: payload.status };
    const classification = classifyStandingOrderChange({ active: activeStandingOrders(db), before, after });
    if (classification.tier === "forbidden" || validateStandingOrderDefinition(after).length) {
      voidProposal(db, approval, "hard_rule", now);
      tellLead(db, ref, "refused", `你提议的常设指令修改 #${approvalId} 不能生效：${classification.findings.map((item) => item.detail).join("；")}`);
      return { conflict: `这个提议碰到硬性规则，不能生效：${classification.findings.map((item) => item.detail).join("；")}` };
    }
    const plan: StandingOrderChangePlan = {
      op: payload.op, id: payload.orderId, reason: payload.reason, before, baseVersion: payload.baseVersion, after,
      rollbackTo: payload.rollbackTo, classification, summary: payload.summary,
    };
    const written = writeVersion(db, plan, { author: "lead", approvedBy: decision.resolvedBy, tier: "permissive", approvalId, now });
    db.prepare(
      `UPDATE approvals SET status = 'approved', resolved_by = ?, resolved_at = ?, payload = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(decision.resolvedBy, now.toISOString(), JSON.stringify({ ...payload, appliedVersion: written.order.version }), approvalId);
    tellLead(db, ref, "approved",
      `${decision.resolvedBy} 批准了你提议的常设指令修改 #${approvalId}，已经生效：${payload.orderId} v${written.order.version}（${payload.summary}）。`);
    return { proposal: getStandingOrderProposal(db, approvalId, now)!, written };
  }).immediate();
  if ("conflict" in result) throw new StandingOrderChangeError("conflict", result.conflict);
  return result;
}

/**
 * 用户在设置页回滚一条指令到某一版：写一个新版本，内容等于那一版，作者 user，批准人是用户自己，直接生效。
 * 碰到硬性规则（例如那一版是停用的规则）时拒绝。
 */
export function rollbackStandingOrderByUser(
  db: Db, input: { id: string; toVersion: number; resolvedBy: string; now?: Date },
): StandingOrderWritten {
  assertUserResolver(input.resolvedBy);
  const now = input.now ?? new Date();
  return db.transaction((): StandingOrderWritten => {
    const plan = planStandingOrderChange(db, {
      op: "rollback", id: input.id, toVersion: input.toVersion, reason: `用户在设置页回滚到 v${input.toVersion}`,
    });
    if (!plan.classification.changed) {
      throw new StandingOrderChangeError("conflict", `现在的版本和 v${input.toVersion} 一样，不用回滚`);
    }
    if (plan.classification.tier === "forbidden") {
      throw new StandingOrderChangeError("forbidden", plan.classification.findings.map((item) => item.detail).join("；"));
    }
    return writeVersion(db, plan, { author: "user", approvedBy: input.resolvedBy, tier: "user", approvalId: null, now });
  }).immediate();
}

/**
 * 用户在设置页直接改一条指令（例如设置 → 消息通道的自动代你处理，2026-10-23）：写一个新版本，作者 user，批准人是用户自己，
 * 直接生效，放宽也一样（是用户本人的决定）。碰到硬性规则时拒绝；内容没变时抛 conflict。
 */
export function updateStandingOrderByUser(
  db: Db, input: { id: string; patch: StandingOrderPatch; reason: string; resolvedBy: string; now?: Date },
): { plan: StandingOrderChangePlan; written: StandingOrderWritten } {
  assertUserResolver(input.resolvedBy);
  const now = input.now ?? new Date();
  return db.transaction(() => {
    const plan = planStandingOrderChange(db, { op: "update", id: input.id, patch: input.patch, reason: input.reason });
    if (!plan.classification.changed) throw new StandingOrderChangeError("conflict", "内容和现在的版本一样，不用改");
    if (plan.classification.tier === "forbidden") {
      throw new StandingOrderChangeError("forbidden", plan.classification.findings.map((item) => item.detail).join("；"));
    }
    return { plan, written: writeVersion(db, plan, { author: "user", approvedBy: input.resolvedBy, tier: "user", approvalId: null, now }) };
  }).immediate();
}

/** 一条审批过期了（engine 的 expireInterventions 调用）：是常设指令的提议时告诉 Lead。调用方在写事务里。 */
export function noteExpiredStandingOrderProposal(db: Db, approval: Approval): void {
  if (!isStandingOrderProposal(approval)) return;
  const payload = parsePayload(approval);
  if (!payload || payload.voided) return;
  tellLead(db, { approvalId: approval.id, orderId: payload.orderId }, "expired",
    `你提议的常设指令修改 #${approval.id}（${payload.summary}）过期了，用户没来得及决定，没有生效。还要改的话重新提。`);
}

// ── 执行记录 ──────────────────────────────────────────────────────────────────────

export interface StandingOrderExecution {
  seq: number;
  kind: string;
  level: string | null;
  entityKey: string;
  summary: string;
  receivedAt: string;
  disposition: string | null;
  // 依据的是这条指令的哪一版。
  version: number;
  // level：这条指令给它定的级别；其余是 triage.applied 里记的作用（inbox_merged、merged_root_cause、escalate_to_tell……）。
  effect: string;
  payload: Record<string, unknown>;
}

interface ExecutionRow {
  seq: number; kind: string; level: string | null; entity_key: string; payload: string; received_at: string;
  disposition: string | null; triage: string;
}

function eventSummary(kind: string, entityKey: string, payload: Record<string, unknown>): string {
  for (const key of ["summary", "title", "note", "text", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return clipEventText(value.trim(), 300);
  }
  return `${kind} ${entityKey}`;
}

/**
 * 一条指令最近的执行记录：事件日志里分诊依据（triage.order 或 triage.applied）指向它的事件，从新到旧。
 * 只看最新的 scanWindow 条事件（缺省 20000），表很大时也不全表扫描。
 */
export function recentStandingOrderExecutions(
  db: Db, id: string, options: { limit?: number; scanWindow?: number } = {},
): StandingOrderExecution[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
  const scanWindow = Math.min(Math.max(Math.trunc(options.scanWindow ?? 20_000), 1), 200_000);
  const rows = db.prepare(
    `SELECT seq, kind, level, entity_key, payload, received_at, disposition, triage FROM events
     WHERE seq > (SELECT COALESCE(MAX(seq), 0) FROM events) - ?
       AND triage IS NOT NULL AND json_valid(triage)
       AND (json_extract(triage, '$.order.id') = ?
         OR EXISTS (SELECT 1 FROM json_each(triage, '$.applied') WHERE json_extract(value, '$.id') = ?))
     ORDER BY seq DESC LIMIT ?`,
  ).all(scanWindow, id, id, limit) as ExecutionRow[];
  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    let triage: { order?: { id?: string; version?: number } | null; applied?: Array<{ id?: string; version?: number; effect?: string }> } = {};
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* 坏了的 payload 按空的显示 */ }
    try { triage = JSON.parse(row.triage) as typeof triage; } catch { /* 上面的 json_valid 已经挡掉 */ }
    const applied = triage.order?.id === id ? null : triage.applied?.find((entry) => entry.id === id) ?? null;
    return {
      seq: row.seq,
      kind: row.kind,
      level: row.level,
      entityKey: row.entity_key,
      summary: eventSummary(row.kind, row.entity_key, payload),
      receivedAt: row.received_at,
      disposition: row.disposition,
      version: Number((applied ?? triage.order)?.version ?? 0),
      effect: applied ? String(applied.effect ?? "applied") : "level",
      payload,
    };
  });
}
