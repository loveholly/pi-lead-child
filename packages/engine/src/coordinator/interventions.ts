import type {
  KernelIntervention,
  KernelInterventionRef,
} from "@pi-lead-child/protocol";
import { activePairedUserTurn, addActivity } from "@pi-lead-child/store";
import { disposeCorrelatedEvents, recordInboxEvent, recordUserRequestExpired } from "@pi-lead-child/store";
import {
  createApproval,
  expireStale,
  findPendingApprovalProjectionGaps,
  getApproval,
  isSessionExempt,
  isStandingOrderProposal,
  noteExpiredStandingOrderProposal,
  resolveApprovalAuthority,
} from "@pi-lead-child/store";
import { insertCheckpointWithResult } from "@pi-lead-child/store";
import {
  ensureCheckpointCard,
  ensureInterventionCard,
  getConversationCardByKey,
} from "@pi-lead-child/store";
import {
  expireDecisionRequests,
  findPendingDecisionProjectionGaps,
  getDecisionRequest,
  insertDecisionRequest,
  addInbox,
  resolveDecisionRequest,
} from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { itemUpdatedEvent, publishGatewayEvents } from "@pi-lead-child/store";
import type {
  Approval,
  CheckpointFact,
  DecisionRequest,
  DecisionRequestAudience,
  DecisionRequestKind,
} from "@pi-lead-child/core";
import type { CheckpointDomainService } from "./checkpoints.js";

export class InterventionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterventionConflictError";
  }
}

// 谁处理的。Lead 在用户本人当前这一轮里代他做时带上 onBehalfOf：那一轮由操作层（ui-actions/ 的 approval、decision 的 resolve）
// 核对过，这里再核对一次（assertOnBehalfTurn，纵深防御：不经过操作层的调用方不能只靠一个字段冒充用户）。
// 账本照样写 actor=lead，另外记下代谁、凭哪一轮。
export interface InterventionOnBehalf {
  actor: "user";
  sourceTurnId: string;
}

export type InterventionActor =
  | { kind: "lead"; resolvedBy: string; onBehalfOf?: InterventionOnBehalf }
  | { kind: "user"; resolvedBy: string };

// 代用户做的，按用户算受众（决定请求的 audience）。
function audienceActor(actor: InterventionActor): "lead" | "user" {
  return actor.kind === "lead" && actor.onBehalfOf ? "user" : actor.kind;
}

// 代用户做的那一轮现在还是用户本人当前已认证的配对轮次吗，这一轮的凭证能做用户的决定吗（store 的 activePairedUserTurn）。
// 不是时抛错。用户在确认卡上点了「确认这一次」的（rule_change:<编号>，外部的一轮里被拦下的审批）由操作层核对过那张卡
// （ui-actions 的 confirmedAuthority）。2026-10-28 起 Lead 自己也能处理审批，代用户只影响账本怎样记。
const CONFIRM_CARD_TURN_PREFIX = "rule_change:";

function assertOnBehalfTurn(db: Db, actor: InterventionActor, label: string): void {
  if (actor.kind === "lead" && actor.onBehalfOf && !actor.onBehalfOf.sourceTurnId.startsWith(CONFIRM_CARD_TURN_PREFIX)) {
    activePairedUserTurn(db, actor.onBehalfOf.sourceTurnId, label, "approvals:respond");
  }
}

function behalfPayload(actor: InterventionActor): { onBehalfOf?: "user"; sourceTurnId?: string } {
  return actor.kind === "lead" && actor.onBehalfOf ? { onBehalfOf: "user", sourceTurnId: actor.onBehalfOf.sourceTurnId } : {};
}

export interface InterventionQuery {
  itemId?: number;
  state?: KernelInterventionRef["state"];
  ids?: string[];
}

export interface RequestApprovalInput {
  itemId: number;
  runId: number;
  requestedBy: "child" | "lead";
  tool: string;
  action: string;
  payload?: unknown;
  ttlMs?: number;
  checkpoint: { title: string; summary: string; keyFacts?: CheckpointFact[]; nextStep: string };
}

export interface RequestDecisionInput {
  itemId: number;
  // Lead 在会话里发起的决定（render_ui 的 ChoiceGroup，origin=lead）没有 Run。
  runId: number | null;
  origin?: "agent" | "lead";
  kind: DecisionRequestKind;
  audience: DecisionRequestAudience;
  blocking?: boolean;
  allowCustom?: boolean;
  prompt: string;
  options?: Array<{ id: string; label: string; description?: string | null }>;
  expiresAt?: string | null;
  checkpoint: { title: string; summary: string; nextStep?: string | null };
}

export type ResolveDecisionInput = {
  requestId: number;
  actor: InterventionActor;
} & (
  | { decision: "select"; optionId: string }
  | { decision: "respond"; resolution: string }
  | { decision: "dismiss"; reason?: string }
);

export interface InterventionDomainService {
  requestApproval(input: RequestApprovalInput):
    | {
        status: "pending";
        approvalId: number;
        sessionExempt: false;
        checkpoint: ReturnType<typeof insertCheckpointWithResult>["checkpoint"];
      }
    | {
        status: "approved";
        approvalId: null;
        sessionExempt: true;
        checkpoint: ReturnType<typeof insertCheckpointWithResult>["checkpoint"];
      };
  resolveApproval(input: {
    approvalId: number;
    decision: "approve" | "reject" | "approve_session";
    actor: InterventionActor;
    reason?: string;
  }): { status: "resolved" | "idempotent"; approval: Approval };
  requestDecision(input: RequestDecisionInput): {
    requestId: number;
    checkpoint: ReturnType<typeof insertCheckpointWithResult>["checkpoint"];
  };
  resolveDecision(input: ResolveDecisionInput): {
    status: "resolved" | "idempotent";
    request: DecisionRequest;
  };
  expireInterventions(now: Date): { approvalIds: number[]; decisionIds: number[] };
  listInterventionRefs(query?: InterventionQuery): KernelInterventionRef[];
  listInterventions(query: InterventionQuery | undefined, actor: { kind: "lead" | "user" }): KernelIntervention[];
  repairLegacyInterventions(): { approvals: number; decisions: number };
}

function touchItem(db: Db, itemId: number, now: Date): void {
  const result = db.prepare(
    "UPDATE items SET last_activity_at=?, updated_at=? WHERE id=?",
  ).run(now.toISOString(), now.toISOString(), itemId);
  if (result.changes !== 1) throw new Error(`item ${itemId} not found`);
}

function authorityPayload(type: "approval" | "decision_request", id: number) {
  return { authorityType: type, authorityId: id };
}

function matchingInboxIds(
  db: Db,
  itemId: number,
  type: "approval" | "decision_request",
  id: number,
  includeConsumed = false,
): number[] {
  const rows = db.prepare(
    `SELECT id, payload FROM inbox WHERE item_id=?
     ${includeConsumed ? "" : "AND state IN ('pending','delivered')"}
     ORDER BY id`,
  ).all(itemId) as Array<{ id: number; payload: string }>;
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return payload.authorityType === type && payload.authorityId === id;
    } catch {
      return false;
    }
  }).map((row) => row.id);
}

function wakeLeadWithDecision(
  db: Db,
  request: DecisionRequest,
  input: ResolveDecisionInput,
  at: Date,
): void {
  const choice = input.decision === "select"
    ? request.options.find((option) => option.id === input.optionId)
    : undefined;
  const said = input.decision === "select"
    ? `选了「${choice?.label ?? input.optionId}」`
    : input.decision === "respond"
      ? `回答：「${input.resolution}」`
      : "忽略了这个决定";
  addInbox(db, {
    itemId: request.itemId,
    severity: "attention",
    source: "structural",
    summary: `用户在工单 #${request.itemId} 的决定「${request.prompt}」里${said}（决策 #${request.id}）。请执行。`,
    payload: {
      kind: "lead_decision_resolved",
      decisionRequestId: request.id,
      decision: input.decision,
      ...(input.decision === "select" ? { choiceId: input.optionId } : {}),
      wakeLead: true,
      needsUser: false,
    },
    lossless: true,
  });
}

function ensureAuthorityInbox(
  db: Db,
  input: {
    itemId: number;
    type: "approval" | "decision_request";
    id: number;
    severity: "blocker" | "attention";
    summary: string;
    now: Date;
    // 额外的 payload 标签（例如 Lead 自己发起的决定：要用户，但不叫醒 Lead）。
    labels?: Record<string, unknown>;
  },
): boolean {
  if (matchingInboxIds(db, input.itemId, input.type, input.id, true).length) return false;
  db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO inbox
        (item_id, dedup_scope, severity, source, summary, payload, created_at)
       VALUES (?, ?, ?, 'semantic', ?, ?, ?)`,
    ).run(
      input.itemId,
      `item:${input.itemId}`, // 去抖分组键（spec §5.5）；挂事项的行恒为 'item:' || item_id
      input.severity,
      input.summary,
      JSON.stringify({ ...authorityPayload(input.type, input.id), ...input.labels }),
      input.now.toISOString(),
    );
    // 双写（Lead 事件主干，工单 01）：这一行不经过 addInbox，在同一个事务里补记它的事件。
    recordInboxEvent(db, Number(inserted.lastInsertRowid));
  })();
  return true;
}

function consumeAuthorityInbox(
  db: Db,
  itemId: number,
  type: "approval" | "decision_request",
  id: number,
  now: Date,
): void {
  const ids = matchingInboxIds(db, itemId, type, id);
  if (!ids.length) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE inbox SET state='consumed', delivered_at=COALESCE(delivered_at, ?)
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(now.toISOString(), ...ids);
    // 审批或决定已经有了结果（多半是用户自己在界面上做的）：这几行的事件在别处处理掉了。
    for (const inboxId of ids) {
      disposeCorrelatedEvents(db, `inbox:${inboxId}`, "resolved_elsewhere", { reason: `${type} #${id} resolved` }, { at: now });
    }
  })();
}

function ensureAuthorityCard(
  db: Db,
  input: {
    itemId: number;
    checkpointId: number;
    actionType: "approval" | "decision_request";
    actionId: number;
    now: Date;
  },
): void {
  const key = `intervention:${input.actionType}:${input.actionId}`;
  if (getConversationCardByKey(db, key)) return;
  ensureInterventionCard(db, input);
}

// KernelInterventionRef / KernelIntervention 是线上 DTO：字段名由 protocol 冻结，
// 内部的 itemId/runId 在这里翻译成 ticketId/attemptId。见 src/wire-vocabulary.ts 的说明。
function approvalRef(approval: Approval): KernelInterventionRef | null {
  if (approval.item_id === null) return null;
  return {
    id: `approval:${approval.id}`,
    ticketId: approval.item_id,
    kind: "approval",
    state: approval.status,
    requiresAction: approval.status === "pending",
  };
}

function decisionRef(request: DecisionRequest): KernelInterventionRef {
  return {
    id: `decision:${request.id}`,
    ticketId: request.itemId,
    kind: request.kind,
    state: request.state,
    requiresAction: request.state === "pending",
  };
}

// 用户 2026-10-28：「lead agent 能自己审批吗，不要啥都让我审批」。问用户的决定 Lead 也能自己答（问 Lead 的仍然只有 Lead 答：
// 那是 child 问 Lead 的事）。外部的一轮里 Lead 不能替用户答（ui-actions 的 decision.resolve 的 externalTurnFloor）。
function audienceAllows(audience: DecisionRequestAudience, actor: "lead" | "user"): boolean {
  return audience === `${actor}` || audience === "lead_or_user" || (audience === "user" && actor === "lead");
}

function assertExplicitUserChannel(resolvedBy: string): void {
  const match = /^user via (.+)$/.exec(resolvedBy);
  const channel = match?.[1]?.trim();
  if (!channel || channel.toLowerCase() === "lead") {
    throw new Error("user resolution requires explicit user channel attribution");
  }
}

function matchesQuery(ref: KernelInterventionRef, query?: InterventionQuery): boolean {
  if (query?.itemId !== undefined && ref.ticketId !== query.itemId) return false;
  if (query?.state !== undefined && ref.state !== query.state) return false;
  if (query?.ids !== undefined && !query.ids.includes(ref.id)) return false;
  return true;
}

function allApprovalRows(db: Db): Approval[] {
  return db.prepare("SELECT * FROM approvals WHERE item_id IS NOT NULL ORDER BY id").all() as Approval[];
}

function allDecisionRows(db: Db): DecisionRequest[] {
  const ids = db.prepare("SELECT id FROM decision_requests ORDER BY id").all() as Array<{ id: number }>;
  return ids.map((row) => getDecisionRequest(db, row.id)!);
}

// approvals 的时刻是 SQLite 的 datetime('now')：UTC，没有时区。线上 DTO 一律交带 Z 的 ISO，网页才不会按本地时间读。
function utcIso<T extends string | null>(value: T): T {
  return (value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}.000Z` : value) as T;
}

function fullApproval(approval: Approval, actor: "lead" | "user"): KernelIntervention {
  const pendingActions = actor === "user" && approval.status === "pending"
    ? ["approve", "reject", "approve_session"] as const
    : [];
  const resolution = approval.status === "approved"
    ? {
        decision: approval.session_exempt ? "approve_session" as const : "approve" as const,
        sessionExempt: Boolean(approval.session_exempt),
      }
    : approval.status === "rejected"
      ? { decision: "reject" as const, sessionExempt: false }
      : null;
  return {
    id: `approval:${approval.id}`,
    kind: "approval",
    authorityId: approval.id,
    ticketId: approval.item_id!,
    attemptId: approval.run_id,
    audience: "user",
    state: approval.status,
    title: `Approval required: ${approval.tool}`,
    detail: approval.action,
    actions: [...pendingActions],
    resolution,
    createdAt: utcIso(approval.created_at),
    resolvedBy: approval.resolved_by,
    resolvedAt: utcIso(approval.resolved_at),
  };
}

function fullDecision(request: DecisionRequest, actor: "lead" | "user"): KernelIntervention {
  const eligible = request.state === "pending" && audienceAllows(request.audience, actor);
  const actions: Array<
    | { kind: "select"; optionId: string; label: string }
    | { kind: "respond"; label: string }
    | { kind: "dismiss"; label: string }
  > = eligible
    ? [
        ...request.options.map((option) => ({
          kind: "select" as const,
          optionId: option.id,
          label: option.label,
        })),
        ...((request.options.length === 0 || request.allowCustom)
          ? [{ kind: "respond" as const, label: "Respond" }]
          : []),
        { kind: "dismiss" as const, label: "Dismiss" },
      ]
    : [];
  const resolution = request.state === "resolved" && request.resolutionKind === "option"
    ? { kind: "option" as const, optionId: request.selectedOptionId, text: null }
    : request.state === "resolved" && request.resolutionKind === "text"
      ? { kind: "text" as const, optionId: null, text: request.resolutionText }
      : request.state === "dismissed"
        ? { kind: "dismissed" as const, optionId: null, text: null }
        : null;
  return {
    id: `decision:${request.id}`,
    kind: request.kind,
    authorityId: request.id,
    ticketId: request.itemId,
    attemptId: request.runId,
    audience: request.audience,
    blocking: request.blocking,
    allowCustom: request.allowCustom,
    state: request.state,
    title: request.kind === "question" ? "Question requires a response" : "Decision required",
    detail: request.prompt,
    options: request.options,
    actions,
    resolution,
    createdAt: request.createdAt,
    resolvedBy: request.resolvedBy,
    resolvedAt: request.resolvedAt,
  };
}

export function createInterventionDomainService(args: {
  db: Db;
  checkpoints: CheckpointDomainService;
  now?: () => Date;
}): InterventionDomainService {
  const { db, checkpoints } = args;
  const now = args.now ?? (() => new Date());

  const requestApproval: InterventionDomainService["requestApproval"] = (input) =>
    db.transaction(() => {
      const at = now();
      if (isSessionExempt(db, input.itemId, input.tool)) {
        const checkpoint = checkpoints.submitCheckpoint({
          itemId: input.itemId,
          runId: input.runId,
          kind: "progress",
          title: "已使用现有 Session 授权",
          summary: input.checkpoint.summary,
          keyFacts: input.checkpoint.keyFacts,
          nextStep: input.checkpoint.nextStep,
        });
        return {
          status: "approved" as const,
          approvalId: null,
          sessionExempt: true as const,
          checkpoint: checkpoint.checkpoint,
        };
      }
      const approvalId = createApproval(db, {
        itemId: input.itemId,
        runId: input.runId,
        requestedBy: input.requestedBy,
        tool: input.tool,
        action: input.action,
        payload: input.payload,
        ttlMs: input.ttlMs,
        now: at,
      });
      ensureAuthorityInbox(db, {
        itemId: input.itemId,
        type: "approval",
        id: approvalId,
        severity: "blocker",
        summary: `Approval #${approvalId} required: ${input.action}`,
        now: at,
      });
      const checkpoint = insertCheckpointWithResult(db, {
        itemId: input.itemId,
        runId: input.runId,
        source: "agent_reported",
        kind: "blocked",
        title: input.checkpoint.title,
        summary: input.checkpoint.summary,
        keyFacts: input.checkpoint.keyFacts,
        nextStep: input.checkpoint.nextStep,
        actionRef: { type: "approval", id: approvalId },
        idempotencyKey: `approval-created:${approvalId}`,
      }, { now: at });
      ensureInterventionCard(db, {
        itemId: input.itemId,
        checkpointId: checkpoint.checkpoint.id,
        actionType: "approval",
        actionId: approvalId,
        now: at,
      });
      addActivity(db, {
        itemId: input.itemId,
        runId: input.runId,
        actor: "child",
        kind: "notification",
        payload: { checkpointId: checkpoint.checkpoint.id, approvalId, action: input.action },
      });
      touchItem(db, input.itemId, at);
      publishGatewayEvents(db, [
        {
          type: "approval.required",
          requiredScope: "approvals:respond",
          itemId: input.itemId,
          // payload 键是线上契约，见 store/gateway-events.ts 的边界注释。
          payload: { approvalId, ticketId: input.itemId, snapshotRequired: true },
          now: at,
        },
        itemUpdatedEvent(input.itemId, at),
      ]);
      return {
        status: "pending" as const,
        approvalId,
        sessionExempt: false as const,
        checkpoint: checkpoint.checkpoint,
      };
    }).immediate();

  const resolveApproval: InterventionDomainService["resolveApproval"] = (input) =>
    db.transaction(() => {
      // 审批：用户本人，或者 Lead（用户 2026-10-28：「lead agent 能自己审批吗」）。Lead 在用户本人这一轮里做的记成代用户做
      // （操作层核对过那一轮）。外部的一轮里 Lead 做不了（ui-actions 的 approval.resolve 的 externalTurnFloor）。
      if (input.actor.kind === "user") assertExplicitUserChannel(input.actor.resolvedBy);
      assertOnBehalfTurn(db, input.actor, "approval");
      const approval = getApproval(db, input.approvalId);
      if (!approval) throw new Error(`approval ${input.approvalId} not found`);
      // Lead 提议的常设指令修改（工单 10）只能由用户在确认卡或设置页决定（网关的 /v1/standing-order-proposals 路由）。
      // 这条路径还接审批卡和 Slack 按钮，所以这里一律不接。Lead 的 perform_action 经过操作层，那里把它算成 user_direct。
      if (isStandingOrderProposal(approval)) {
        throw new InterventionConflictError(
          `approval #${approval.id} 是 Lead 提议的常设指令修改：只有用户能在确认卡或设置 → 常设指令里决定`,
        );
      }
      if (approval.item_id === null) throw new Error("itemless approvals cannot create checkpoint projections");
      const at = now();
      const status = input.decision === "reject" ? "rejected" : "approved";
      const authority = resolveApprovalAuthority(db, input.approvalId, {
        status,
        resolvedBy: input.actor.resolvedBy,
        sessionExempt: input.decision === "approve_session",
        now: at,
      });
      if (authority === "conflict") {
        const current = getApproval(db, input.approvalId)!;
        throw new InterventionConflictError(
          `approval resolution conflict: approval #${input.approvalId} 已是 ${current.status}`,
        );
      }
      if (authority === "idempotent") {
        return { status: "idempotent" as const, approval: getApproval(db, input.approvalId)! };
      }
      consumeAuthorityInbox(db, approval.item_id, "approval", approval.id, at);
      const approved = status === "approved";
      const checkpoint = insertCheckpointWithResult(db, {
        itemId: approval.item_id,
        runId: approval.run_id,
        source: "system_derived",
        kind: approved ? "progress" : "decision",
        title: approved ? "Authorization approved, execution resumed" : "Authorization rejected",
        summary: approved
          ? `${input.actor.resolvedBy} approved approval #${approval.id}. Execution may continue.`
          : `${input.actor.resolvedBy} rejected approval #${approval.id}. Execution remains blocked.`,
        actionRef: { type: "approval", id: approval.id },
        idempotencyKey: `approval-resolved:${approval.id}:${status}`,
      }, { now: at });
      ensureAuthorityCard(db, {
        itemId: approval.item_id,
        checkpointId: checkpoint.checkpoint.id,
        actionType: "approval",
        actionId: approval.id,
        now: at,
      });
      ensureCheckpointCard(db, {
        itemId: approval.item_id,
        checkpointId: checkpoint.checkpoint.id,
        now: at,
      });
      addActivity(db, {
        itemId: approval.item_id,
        runId: approval.run_id ?? undefined,
        actor: input.actor.kind,
        kind: "decision",
        payload: {
          approvalId: approval.id,
          decision: input.decision,
          reason: input.reason ?? "",
          resolvedBy: input.actor.resolvedBy,
          ...behalfPayload(input.actor),
        },
      });
      touchItem(db, approval.item_id, at);
      publishGatewayEvents(db, [
        {
          type: "approval.resolved",
          requiredScope: "approvals:respond",
          itemId: approval.item_id,
          payload: {
            approvalId: approval.id,
            status,
            sessionExempt: input.decision === "approve_session",
            snapshotRequired: true,
          },
          now: at,
        },
        itemUpdatedEvent(approval.item_id, at),
      ]);
      return { status: "resolved" as const, approval: getApproval(db, input.approvalId)! };
    }).immediate();

  const requestDecision: InterventionDomainService["requestDecision"] = (input) =>
    db.transaction(() => {
      const at = now();
      const lead = input.origin === "lead";
      const request = insertDecisionRequest(db, {
        itemId: input.itemId,
        runId: input.runId,
        origin: input.origin ?? "agent",
        kind: input.kind,
        audience: input.audience,
        blocking: input.blocking,
        allowCustom: input.allowCustom,
        prompt: input.prompt,
        options: input.options,
        expiresAt: input.expiresAt,
        now: at,
      });
      ensureAuthorityInbox(db, {
        itemId: input.itemId,
        type: "decision_request",
        id: request.id,
        severity: request.blocking ? "blocker" : "attention",
        summary: `Decision #${request.id} required: ${request.prompt}`,
        now: at,
        // Lead 自己发起的：要用户决定，但不叫醒 Lead 自己（2026-10-15 generative UI）。
        ...(lead ? { labels: { needsUser: true, wakeLead: false } } : {}),
      });
      const checkpoint = insertCheckpointWithResult(db, {
        itemId: input.itemId,
        runId: input.runId,
        source: lead ? "system_derived" : "agent_reported",
        kind: request.blocking || request.kind === "blocker" ? "blocked" : "decision",
        title: input.checkpoint.title,
        summary: input.checkpoint.summary,
        nextStep: input.checkpoint.nextStep ?? null,
        actionRef: { type: "decision_request", id: request.id },
        idempotencyKey: `decision-created:${request.id}`,
      }, { now: at });
      ensureInterventionCard(db, {
        itemId: input.itemId,
        checkpointId: checkpoint.checkpoint.id,
        actionType: "decision_request",
        actionId: request.id,
        now: at,
      });
      addActivity(db, {
        itemId: input.itemId,
        ...(input.runId === null ? {} : { runId: input.runId }),
        actor: lead ? "lead" : "child",
        kind: "decision",
        payload: { checkpointId: checkpoint.checkpoint.id, decisionRequestId: request.id },
      });
      touchItem(db, input.itemId, at);
      publishGatewayEvents(db, [itemUpdatedEvent(input.itemId, at)]);
      return { requestId: request.id, checkpoint: checkpoint.checkpoint };
    }).immediate();

  const resolveDecision: InterventionDomainService["resolveDecision"] = (input) =>
    db.transaction(() => {
      const request = getDecisionRequest(db, input.requestId);
      if (!request) throw new Error(`decision request ${input.requestId} not found`);
      if (!audienceAllows(request.audience, audienceActor(input.actor))) {
        throw new Error(`decision audience '${request.audience}' does not allow ${input.actor.kind}`);
      }
      if (input.actor.kind === "user") assertExplicitUserChannel(input.actor.resolvedBy);
      assertOnBehalfTurn(db, input.actor, "decision request");
      const at = now();
      const result = resolveDecisionRequest(db, request.id, input.decision === "select"
        ? { kind: "option", optionId: input.optionId, resolvedBy: input.actor.resolvedBy, now: at }
        : input.decision === "respond"
          ? { kind: "text", text: input.resolution, resolvedBy: input.actor.resolvedBy, now: at }
          : { kind: "dismissed", reason: input.reason, resolvedBy: input.actor.resolvedBy, now: at });
      if (result === "conflict") throw new InterventionConflictError("decision resolution conflict");
      if (result === "idempotent") {
        return { status: "idempotent" as const, request: getDecisionRequest(db, request.id)! };
      }
      consumeAuthorityInbox(db, request.itemId, "decision_request", request.id, at);
      const checkpoint = insertCheckpointWithResult(db, {
        itemId: request.itemId,
        runId: request.runId,
        source: "system_derived",
        kind: "decision",
        title: input.decision === "dismiss" ? "Decision request dismissed" : "Decision recorded",
        summary: input.decision === "select"
          ? `${input.actor.resolvedBy} selected '${input.optionId}' for decision #${request.id}.`
          : input.decision === "respond"
            ? `${input.actor.resolvedBy} responded to decision #${request.id}.`
            : `${input.actor.resolvedBy} dismissed decision #${request.id}.`,
        actionRef: { type: "decision_request", id: request.id },
        idempotencyKey: `decision-resolved:${request.id}`,
      }, { now: at });
      ensureAuthorityCard(db, {
        itemId: request.itemId,
        checkpointId: checkpoint.checkpoint.id,
        actionType: "decision_request",
        actionId: request.id,
        now: at,
      });
      // Lead 发起的决定（render_ui 的 ChoiceGroup）：决定卡自己显示「你选了…」，不再另画一张记录卡片。
      // 记录（checkpoint）照常写，工单的经过和审计都读它。
      if (request.origin !== "lead") {
        ensureCheckpointCard(db, {
          itemId: request.itemId,
          checkpointId: checkpoint.checkpoint.id,
          now: at,
        });
      }
      addActivity(db, {
        itemId: request.itemId,
        runId: request.runId ?? undefined,
        actor: input.actor.kind,
        kind: "decision",
        payload: {
          decisionRequestId: request.id, decision: input.decision, resolvedBy: input.actor.resolvedBy,
          ...behalfPayload(input.actor),
        },
      });
      // Lead 自己发起的决定：用户选完叫醒 Lead，由它去执行（2026-10-15 generative UI）。
      if (request.origin === "lead") wakeLeadWithDecision(db, request, input, at);
      touchItem(db, request.itemId, at);
      publishGatewayEvents(db, [itemUpdatedEvent(request.itemId, at)]);
      return { status: "resolved" as const, request: getDecisionRequest(db, request.id)! };
    }).immediate();

  const listInterventionRefs = (query?: InterventionQuery): KernelInterventionRef[] => [
    ...allApprovalRows(db).map(approvalRef).filter((ref): ref is KernelInterventionRef => ref !== null),
    ...allDecisionRows(db).map(decisionRef),
  ].filter((ref) => matchesQuery(ref, query));

  return {
    requestApproval,
    resolveApproval,
    requestDecision,
    resolveDecision,

    expireInterventions(at): { approvalIds: number[]; decisionIds: number[] } {
      return db.transaction(() => {
        const approvalIds = expireStale(db, at);
        for (const id of approvalIds) {
          const approval = getApproval(db, id)!;
          // Lead 提议的常设指令修改过期了：不生效，告诉 Lead（工单 10）。
          noteExpiredStandingOrderProposal(db, approval);
          if (approval.item_id === null) continue;
          consumeAuthorityInbox(db, approval.item_id, "approval", id, at);
          const checkpoint = insertCheckpointWithResult(db, {
            itemId: approval.item_id,
            runId: approval.run_id,
            source: "system_derived",
            kind: "decision",
            title: "Authorization expired",
            summary: `Approval #${id} expired before a user response.`,
            actionRef: { type: "approval", id },
            idempotencyKey: `approval-resolved:${id}:expired`,
          }, { now: at });
          ensureAuthorityCard(db, {
            itemId: approval.item_id,
            checkpointId: checkpoint.checkpoint.id,
            actionType: "approval",
            actionId: id,
            now: at,
          });
          ensureCheckpointCard(db, {
            itemId: approval.item_id, checkpointId: checkpoint.checkpoint.id, now: at,
          });
          touchItem(db, approval.item_id, at);
          publishGatewayEvents(db, [
            {
              type: "approval.resolved",
              requiredScope: "approvals:respond",
              itemId: approval.item_id,
              payload: { approvalId: id, status: "expired", snapshotRequired: true },
              now: at,
            },
            itemUpdatedEvent(approval.item_id, at),
          ]);
        }

        const decisionIds = expireDecisionRequests(db, at);
        for (const id of decisionIds) {
          const request = getDecisionRequest(db, id)!;
          consumeAuthorityInbox(db, request.itemId, "decision_request", id, at);
          const checkpoint = insertCheckpointWithResult(db, {
            itemId: request.itemId,
            runId: request.runId,
            source: "system_derived",
            kind: "decision",
            title: "Decision request expired",
            summary: `Decision request #${id} expired without a response.`,
            actionRef: { type: "decision_request", id },
            idempotencyKey: `decision-resolved:${id}`,
          }, { now: at });
          ensureAuthorityCard(db, {
            itemId: request.itemId,
            checkpointId: checkpoint.checkpoint.id,
            actionType: "decision_request",
            actionId: id,
            now: at,
          });
          ensureCheckpointCard(db, {
            itemId: request.itemId, checkpointId: checkpoint.checkpoint.id, now: at,
          });
          touchItem(db, request.itemId, at);
          // 过期也是这个请求的状态变化（2026-10-19）：在等它（或者它的工单）的 Lead 由等待叫醒（store 的 lead-waits.ts）。
          recordUserRequestExpired(db, {
            entityKey: `decision:${id}`, requestKind: "decision", requestId: String(id), itemId: request.itemId,
            summary: `决定请求 #${id} 过期了，没有人回答：${request.prompt}`, at: new Date(at),
          });
          publishGatewayEvents(db, [itemUpdatedEvent(request.itemId, at)]);
        }
        return { approvalIds, decisionIds };
      }).immediate();
    },

    listInterventionRefs,

    listInterventions(query, actor): KernelIntervention[] {
      return [
        ...allApprovalRows(db).filter((approval) => {
          const ref = approvalRef(approval);
          return ref !== null && matchesQuery(ref, query);
        }).map((approval) => fullApproval(approval, actor.kind)),
        ...allDecisionRows(db).filter((request) => matchesQuery(decisionRef(request), query))
          .map((request) => fullDecision(request, actor.kind)),
      ];
    },

    repairLegacyInterventions(): { approvals: number; decisions: number } {
      return db.transaction(() => {
        const at = now();
        let approvals = 0;
        let decisions = 0;
        const approvalGaps = new Map(
          findPendingApprovalProjectionGaps(db).map((gap) => [gap.authority.id, gap]),
        );
        const pendingApprovalRows = db.prepare(
          "SELECT * FROM approvals WHERE status='pending' AND item_id IS NOT NULL ORDER BY id",
        ).all() as Approval[];
        for (const authority of pendingApprovalRows) {
          if (authority.item_id === null) continue;
          const gap = approvalGaps.get(authority.id) ?? {
            authority,
            checkpointId: db.prepare(
              `SELECT id FROM checkpoints
               WHERE item_id=? AND action_type='approval' AND action_id=?
               ORDER BY id DESC LIMIT 1`,
            ).get(authority.item_id, authority.id) as { id: number } | undefined,
            cardId: db.prepare(
              `SELECT id FROM conversation_cards
               WHERE item_id=? AND action_type='approval' AND action_id=?
               ORDER BY id DESC LIMIT 1`,
            ).get(authority.item_id, authority.id) as { id: number } | undefined,
          };
          let changed = false;
          let checkpointId = typeof gap.checkpointId === "number"
            ? gap.checkpointId
            : gap.checkpointId?.id ?? null;
          if (checkpointId === null) {
            const checkpoint = insertCheckpointWithResult(db, {
              itemId: authority.item_id,
              runId: authority.run_id,
              source: "system_derived",
              kind: "blocked",
              title: "Pending legacy approval",
              summary: `Approval #${authority.id} is waiting for '${authority.tool}': ${authority.action}`,
              actionRef: { type: "approval", id: authority.id },
              idempotencyKey: `legacy-approval:${authority.id}`,
            }, { now: at });
            checkpointId = checkpoint.checkpoint.id;
            changed = !checkpoint.deduplicated;
          }
          if (checkpointId === null) throw new Error(`legacy approval ${authority.id} has no checkpoint`);
          const cardId = typeof gap.cardId === "number" ? gap.cardId : gap.cardId?.id ?? null;
          if (cardId === null) {
            ensureInterventionCard(db, {
              itemId: authority.item_id,
              checkpointId,
              actionType: "approval",
              actionId: authority.id,
              now: at,
            });
            changed = true;
          }
          changed = ensureAuthorityInbox(db, {
            itemId: authority.item_id,
            type: "approval",
            id: authority.id,
            severity: "blocker",
            summary: `Approval #${authority.id} requires a user response`,
            now: at,
          }) || changed;
          if (!changed) continue;
          approvals++;
          touchItem(db, authority.item_id, at);
          publishGatewayEvents(db, [itemUpdatedEvent(authority.item_id, at)]);
        }
        const decisionGaps = new Map(
          findPendingDecisionProjectionGaps(db).map((gap) => [gap.authority.id, gap]),
        );
        for (const authority of allDecisionRows(db).filter((request) => request.state === "pending")) {
          const gap = decisionGaps.get(authority.id) ?? {
            authority,
            checkpointId: db.prepare(
              `SELECT id FROM checkpoints
               WHERE item_id=? AND action_type='decision_request' AND action_id=?
               ORDER BY id DESC LIMIT 1`,
            ).get(authority.itemId, authority.id) as { id: number } | undefined,
            cardId: db.prepare(
              `SELECT id FROM conversation_cards
               WHERE item_id=? AND action_type='decision_request' AND action_id=?
               ORDER BY id DESC LIMIT 1`,
            ).get(authority.itemId, authority.id) as { id: number } | undefined,
          };
          let changed = false;
          let checkpointId = typeof gap.checkpointId === "number"
            ? gap.checkpointId
            : gap.checkpointId?.id ?? null;
          if (checkpointId === null) {
            const checkpoint = insertCheckpointWithResult(db, {
              itemId: authority.itemId,
              runId: authority.runId,
              source: "system_derived",
              kind: authority.blocking ? "blocked" : "decision",
              title: "Pending legacy decision",
              summary: `Decision request #${authority.id} is waiting for a response: ${authority.prompt}`,
              actionRef: { type: "decision_request", id: authority.id },
              idempotencyKey: `legacy-decision:${authority.id}`,
            }, { now: at });
            checkpointId = checkpoint.checkpoint.id;
            changed = !checkpoint.deduplicated;
          }
          if (checkpointId === null) throw new Error(`legacy decision ${authority.id} has no checkpoint`);
          const cardId = typeof gap.cardId === "number" ? gap.cardId : gap.cardId?.id ?? null;
          if (cardId === null) {
            ensureInterventionCard(db, {
              itemId: authority.itemId,
              checkpointId,
              actionType: "decision_request",
              actionId: authority.id,
              now: at,
            });
            changed = true;
          }
          changed = ensureAuthorityInbox(db, {
            itemId: authority.itemId,
            type: "decision_request",
            id: authority.id,
            severity: authority.blocking ? "blocker" : "attention",
            summary: `Decision request #${authority.id} requires a response`,
            now: at,
          }) || changed;
          if (!changed) continue;
          decisions++;
          touchItem(db, authority.itemId, at);
          publishGatewayEvents(db, [itemUpdatedEvent(authority.itemId, at)]);
        }
        return { approvals, decisions };
      }).immediate();
    },
  };
}
