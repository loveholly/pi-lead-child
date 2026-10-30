// 工单的执行计划（工单详情与验收 spec 4.4、5.2，工单 06）：GET /v1/tickets/:id/plan，用 tickets:view。只读：
// 计划只由执行 agent 用 update_ticket_plan 改。形状在 protocol 的 execution-plan.ts，读取在 engine 的 execution-plan.ts，
// Lead 的 get_ticket 读的是同一份。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope, TicketExecutionPlanResponse } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { ticketExecutionPlan } from "@pi-lead-child/engine";

export interface ExecutionPlanRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
}

const PLAN_PATH = /^\/v1\/tickets\/(\d+)\/plan$/;

// 处理了返回 true；不是这条路由返回 false。
export function handleExecutionPlanRoute(ctx: ExecutionPlanRouteContext): boolean {
  const match = ctx.url.pathname.match(PLAN_PATH);
  if (!match || ctx.req.method !== "GET") return false;
  ctx.requireAuth("tickets:view");
  const ticketId = Number(match[1]);
  if (!getItem(ctx.db, ticketId)) {
    ctx.json(404, { error: { code: "not_found", message: `工单 #${ticketId} 不存在` } });
    return true;
  }
  const body: TicketExecutionPlanResponse = { plan: ticketExecutionPlan(ctx.db, ticketId) };
  ctx.json(200, body);
  return true;
}
