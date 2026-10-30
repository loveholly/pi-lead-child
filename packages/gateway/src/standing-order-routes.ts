// /v1/standing-orders 和 /v1/standing-order-proposals 的路由（设置 → 常设指令，会话里的 StandingOrderChangeConfirm 卡；
// Lead 事件主干 spec D4，工单 10）。契约见 protocol 的 standing-orders-wire.ts。
//
// 权限照现有的 scope 规则：
//   - 读：tickets:view。
//   - 用户回滚：tickets:create（「这台设备是主人」，和设置页的其他修改一样）。用户自己就是批准人，所以直接生效。
//   - 批准或拒绝 Lead 的提议：approvals:respond（和审批同一个 scope）。
// Lead 的工具走不到这些路由，所以「更放开」的修改只能由用户批准。请求体只有 version 或 approve，
// 没有「代谁决定」的参数：resolvedBy 由这里按调用方的 binding 写成「user via <设备>」。
// 网关直接读写 store（和 control-plane 一样）：这些都是数据库里的事，不经过 daemon 的进程状态。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerActionInput } from "./owner-actions.js";
import { Value } from "typebox/value";
import {
  isTriageLevel, STANDING_ORDER_ID_PATTERN, StandingOrderProposalDecisionRequestSchema, StandingOrderRollbackRequestSchema,
  type Scope, type StandingOrder, type StandingOrderDetailResponse, type StandingOrderDto, type StandingOrderExecutionDto,
  type StandingOrderListResponse, type StandingOrderProposalDto, type StandingOrderProposalResponse,
} from "@pi-lead-child/protocol";
import {
  getStandingOrder, getStandingOrderProposal, listStandingOrderProposals, listStandingOrders, listStandingOrderVersions,
  recentStandingOrderExecutions, resolveStandingOrderProposal, rollbackStandingOrderByUser, StandingOrderChangeError,
  type Db, type StandingOrderExecution, type StandingOrderProposal,
  leadDisplayName,
} from "@pi-lead-child/store";

export interface StandingOrderRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  // 检查 scope，返回调用方是谁（写进 resolvedBy 和 approvedBy）。
  requireAuth(scope: Scope): string;
  // 批准或拒绝以后发一条 approval.resolved，客户端重取审批。
  publishApprovalResolved?(approvalId: number, status: string): void;
  // 回滚、批准或拒绝成功以后，记一次主人操作（工单 15）。凭证是上一次 requireAuth 的调用方。
  ownerAction?(input: OwnerActionInput): void;
  now?: () => Date;
}

// 最近的执行记录取多少条。
export const STANDING_ORDER_EXECUTIONS_LIMIT = 20;

const ERROR_STATUS: Record<StandingOrderChangeError["code"], number> = {
  invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409,
};

function actionField(order: StandingOrder): { level: StandingOrderDto["level"]; rule: string | null } {
  const action = order.action as unknown as Record<string, unknown> | null;
  if (!action || typeof action !== "object") return { level: null, rule: null };
  const level = isTriageLevel(action.level) ? action.level : null;
  return { level, rule: action.type === "rule" && typeof action.rule === "string" ? action.rule : null };
}

export function standingOrderDto(order: StandingOrder): StandingOrderDto {
  return {
    id: order.id,
    version: order.version,
    title: order.title,
    priority: order.priority,
    status: order.status,
    author: order.author,
    approvedBy: order.approvedBy,
    reason: order.reason,
    createdAt: order.createdAt,
    seedRevision: order.seedRevision,
    condition: order.condition ?? null,
    action: order.action ?? null,
    limits: order.limits ?? null,
    escalateTo: isTriageLevel(order.escalateTo) ? order.escalateTo : null,
    ...actionField(order),
  };
}

export function standingOrderProposalDto(proposal: StandingOrderProposal): StandingOrderProposalDto {
  return {
    approvalId: proposal.approvalId,
    orderId: proposal.orderId,
    op: proposal.op,
    state: proposal.state,
    voidedReason: proposal.voidedReason,
    summary: proposal.summary,
    reason: proposal.reason,
    title: proposal.definition.title,
    baseVersion: proposal.baseVersion,
    appliedVersion: proposal.appliedVersion,
    rollbackTo: proposal.rollbackTo,
    proposedStatus: proposal.proposedStatus,
    definition: proposal.definition,
    findings: proposal.findings.map((item) => ({
      tier: item.tier, aspect: item.aspect, detail: item.detail, ...(item.hardRule ? { hardRule: item.hardRule } : {}),
    })),
    requestedAt: proposal.requestedAt,
    expiresAt: proposal.expiresAt,
    resolvedBy: proposal.resolvedBy,
    resolvedAt: proposal.resolvedAt,
  };
}

const positiveInt = (value: unknown): number | null => Number.isInteger(value) && (value as number) > 0 ? value as number : null;

// 线上用词：存储层的 run:<id> 写成 attempt:<id>，item 写成 ticket（见 protocol 的 standing-orders-wire.ts）。
export function standingOrderExecutionDto(execution: StandingOrderExecution): StandingOrderExecutionDto {
  const [prefix, rest] = [execution.entityKey.slice(0, execution.entityKey.indexOf(":")), execution.entityKey.slice(execution.entityKey.indexOf(":") + 1)];
  const keyId = /^\d+$/.test(rest) ? Number(rest) : null;
  const ticketId = prefix === "ticket" ? keyId : positiveInt(execution.payload.itemId);
  const attemptId = prefix === "run" ? keyId : positiveInt(execution.payload.runId);
  return {
    seq: execution.seq,
    kind: execution.kind,
    level: execution.level,
    subject: prefix === "run" ? `attempt:${rest}` : execution.entityKey,
    ticketId,
    attemptId,
    summary: execution.summary,
    receivedAt: execution.receivedAt,
    disposition: execution.disposition,
    version: execution.version,
    effect: execution.effect,
  };
}

function detail(db: Db, id: string, now: Date): StandingOrderDetailResponse | null {
  const order = getStandingOrder(db, id);
  if (!order) return null;
  return {
    order: standingOrderDto(order),
    versions: listStandingOrderVersions(db, id).map(standingOrderDto),
    executions: recentStandingOrderExecutions(db, id, { limit: STANDING_ORDER_EXECUTIONS_LIMIT }).map(standingOrderExecutionDto),
    proposals: listStandingOrderProposals(db, { orderId: id, limit: 10, now }).map(standingOrderProposalDto),
  };
}

function proposalResponse(db: Db, proposal: StandingOrderProposal): StandingOrderProposalResponse {
  const order = getStandingOrder(db, proposal.orderId);
  return { proposal: standingOrderProposalDto(proposal), order: order ? standingOrderDto(order) : null };
}

// 路径里的指令编号。坏的百分号转义和格式不对一样，返回 null（路由回 400）。
function orderIdOf(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return id.length <= 120 && STANDING_ORDER_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

// 处理了返回 true。不是这两组路由返回 false。
export async function handleStandingOrderRoute(ctx: StandingOrderRouteContext): Promise<boolean> {
  const { req, url, db } = ctx;
  const path = url.pathname;
  const isOrders = path === "/v1/standing-orders" || path.startsWith("/v1/standing-orders/");
  const isProposals = path.startsWith("/v1/standing-order-proposals/");
  if (!isOrders && !isProposals) return false;
  const now = () => ctx.now?.() ?? new Date();
  const fail = (status: number, code: string, message: string) =>
    ctx.json(status, { error: { code, message, details: { reason: code } } });
  const run = (action: () => unknown): true => {
    try {
      ctx.json(200, action());
    } catch (error) {
      if (!(error instanceof StandingOrderChangeError)) throw error;
      fail(ERROR_STATUS[error.code], error.code, error.message);
    }
    return true;
  };
  const body = async () => req.headers["content-length"] === "0" ? {} : await ctx.readBody();

  if (isOrders) {
    if (req.method === "GET" && path === "/v1/standing-orders") {
      ctx.requireAuth("tickets:view");
      const response: StandingOrderListResponse = {
        items: listStandingOrders(db, { includeDisabled: true }).map(standingOrderDto),
        proposals: listStandingOrderProposals(db, { pendingOnly: true, now: now() }).map(standingOrderProposalDto),
      };
      ctx.json(200, response);
      return true;
    }
    const match = /^\/v1\/standing-orders\/([^/]+)(\/rollback)?$/.exec(path);
    if (!match) return false;
    if (match[2] === undefined && req.method === "GET") {
      ctx.requireAuth("tickets:view");
      const id = orderIdOf(match[1]!);
      if (!id) return run(() => { throw new StandingOrderChangeError("invalid_request", "standing order id is malformed"); });
      const found = detail(db, id, now());
      if (!found) return run(() => { throw new StandingOrderChangeError("not_found", `没有常设指令 ${id}`); });
      ctx.json(200, found);
      return true;
    }
    if (match[2] !== undefined && req.method === "POST") {
      const by = ctx.requireAuth("tickets:create");
      const id = orderIdOf(match[1]!);
      if (!id) return run(() => { throw new StandingOrderChangeError("invalid_request", "standing order id is malformed"); });
      const request = await body();
      if (!Value.Check(StandingOrderRollbackRequestSchema, request)) {
        return run(() => { throw new StandingOrderChangeError("invalid_request", "version must be a positive integer"); });
      }
      return run(() => {
        const toVersion = (request as { version: number }).version;
        const fromVersion = getStandingOrder(db, id)?.version ?? null;
        const written = rollbackStandingOrderByUser(db, { id, toVersion, resolvedBy: `user via ${by}`, now: now() });
        if (fromVersion !== null) {
          ctx.ownerAction?.({
            action: "standing_order.rollback",
            target: { key: `standing_order:${id}`, label: `常设指令「${written.order.title}」`, ticketId: null },
            summary: `把常设指令「${written.order.title}」回滚到 v${toVersion}（新版本 v${written.order.version}）`,
            detail: { fromVersion, toVersion, writtenVersion: written.order.version },
            undo: { kind: "standing_order_rollback", orderId: id, fromVersion, writtenVersion: written.order.version },
          });
        }
        return detail(db, id, now());
      });
    }
    return false;
  }

  const match = /^\/v1\/standing-order-proposals\/(\d{1,12})(\/decision)?$/.exec(path);
  if (!match) return false;
  const approvalId = Number(match[1]);
  if (match[2] === undefined && req.method === "GET") {
    ctx.requireAuth("tickets:view");
    return run(() => {
      const proposal = getStandingOrderProposal(db, approvalId, now());
      if (!proposal) throw new StandingOrderChangeError("not_found", `没有常设指令的提议 #${approvalId}`);
      return proposalResponse(db, proposal);
    });
  }
  if (match[2] !== undefined && req.method === "POST") {
    const by = ctx.requireAuth("approvals:respond");
    const request = await body();
    if (!Value.Check(StandingOrderProposalDecisionRequestSchema, request)) {
      return run(() => { throw new StandingOrderChangeError("invalid_request", "approve must be a boolean"); });
    }
    return run(() => {
      const approve = (request as { approve: boolean }).approve;
      const { proposal } = resolveStandingOrderProposal(db, approvalId, {
        approve, resolvedBy: `user via ${by}`, now: now(),
      });
      ctx.publishApprovalResolved?.(approvalId, proposal.state);
      ctx.ownerAction?.({
        action: "standing_order.proposal_decide",
        target: { key: `standing_order:${proposal.orderId}`, label: `常设指令「${proposal.definition.title}」`, ticketId: null },
        summary: `${approve ? "批准" : "拒绝"}了 ${leadDisplayName(db)} 对常设指令「${proposal.definition.title}」的修改提议 #${approvalId}：${proposal.summary}`,
        detail: { approvalId, approve, state: proposal.state },
        undo: {
          kind: "standing_order_proposal", approvalId, approve, orderId: proposal.orderId,
          baseVersion: proposal.baseVersion, appliedVersion: proposal.appliedVersion,
        },
      });
      return proposalResponse(db, proposal);
    });
  }
  return false;
}
