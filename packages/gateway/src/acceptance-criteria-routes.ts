// 工单的结构化验收标准和你的确认（工单详情与验收 spec 4.3、5.1、D5，工单 05）：
// GET /v1/tickets/:id/acceptance-criteria?delivery=<第几次交付>，用 tickets:view。只读：编辑和确认是工单操作
// （POST /v1/tickets/:id/actions/edit_acceptance_criteria、confirm_criterion、unconfirm_criterion）。
// 形状在 protocol 的 acceptance-criteria.ts，读取在 engine 的 coordinator/acceptance-criteria.ts，Lead 的 get_ticket 读的是同一份。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope, TicketAcceptanceCriteriaResponse } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { recordedDeliverySnapshot, ticketAcceptanceCriteria } from "@pi-lead-child/engine";

export interface AcceptanceCriteriaRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
}

const CRITERIA_PATH = /^\/v1\/tickets\/(\d+)\/acceptance-criteria$/;
const SEQUENCE = /^[1-9]\d{0,8}$/;

// 处理了返回 true；不是这条路由返回 false。
export async function handleAcceptanceCriteriaRoute(ctx: AcceptanceCriteriaRouteContext): Promise<boolean> {
  const match = ctx.url.pathname.match(CRITERIA_PATH);
  if (!match || ctx.req.method !== "GET") return false;
  ctx.requireAuth("tickets:view");
  const ticketId = Number(match[1]);
  const item = getItem(ctx.db, ticketId);
  if (!item) {
    ctx.json(404, { error: { code: "not_found", message: `工单 #${ticketId} 不存在` } });
    return true;
  }
  const delivery = ctx.url.searchParams.get("delivery");
  if (delivery !== null && !SEQUENCE.test(delivery)) {
    ctx.json(400, { error: { code: "invalid_request", message: "delivery 是第几次交付，一个正整数" } });
    return true;
  }
  // 和交付视图一样，先补存还没存的交付快照（04）：确认对着的交付要和页面上看到的一致。
  await recordedDeliverySnapshot(ctx.db, item);
  const view = ticketAcceptanceCriteria(ctx.db, ticketId, delivery === null ? {} : { delivery: Number(delivery) });
  if (!view) {
    ctx.json(404, { error: { code: "not_found", message: `工单 #${ticketId} 没有第 ${delivery} 次交付` } });
    return true;
  }
  const body: TicketAcceptanceCriteriaResponse = { acceptanceCriteria: view };
  ctx.json(200, body);
  return true;
}
