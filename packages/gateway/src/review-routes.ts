// 一次交付的核查（工单详情与验收 spec 4.5、5.7、D8，工单 10）：
// GET /v1/tickets/:id/reviews?delivery=<第几次交付>，用 tickets:view。每一次核查员看到了什么（核查包和摘要）、给了什么结论。
// 只读：派核查、换核查员是工单操作。形状在 protocol 的 reviews.ts，读取在 engine 的 coordinator/review-verdict.ts。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope, TicketReviewsResponse } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { recordedDeliverySnapshot, ticketReviews } from "@pi-lead-child/engine";

export interface ReviewRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
}

const REVIEWS_PATH = /^\/v1\/tickets\/(\d+)\/reviews$/;
const SEQUENCE = /^[1-9]\d{0,8}$/;

// 处理了返回 true；不是这条路由返回 false。
export async function handleReviewRoute(ctx: ReviewRouteContext): Promise<boolean> {
  const match = ctx.url.pathname.match(REVIEWS_PATH);
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
  // 和验收标准一样，先补存还没存的交付快照（04）：最新一次交付要和页面上看到的一致。
  await recordedDeliverySnapshot(ctx.db, item);
  const view = ticketReviews(ctx.db, ticketId, delivery === null ? {} : { delivery: Number(delivery) });
  if (!view) {
    ctx.json(404, { error: { code: "not_found", message: `工单 #${ticketId} 没有第 ${delivery} 次交付` } });
    return true;
  }
  const body: TicketReviewsResponse = { reviews: view };
  ctx.json(200, body);
  return true;
}
