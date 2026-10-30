// 每一次交付的快照（工单 04，spec 5.5、D8）：交付切换用。和交付视图（delivery-routes.ts）分开放：
// 路由只读、用 tickets:view，逻辑在 engine 的 delivery.ts（ticketDeliveries、ticketDeliverySnapshot），这里只做认证、校验和错误映射。
import type { IncomingMessage } from "node:http";
import type { Scope } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { DeliveryError, ticketDeliveries, ticketDeliverySnapshot } from "@pi-lead-child/engine";

export interface DeliverySnapshotRouteContext {
  req: IncomingMessage;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
}

const LIST_PATH = /^\/v1\/tickets\/(\d+)\/deliveries$/;
const ONE_PATH = /^\/v1\/tickets\/(\d+)\/deliveries\/(\d+)$/;
const POSITIVE_INTEGER = /^[1-9]\d{0,8}$/;

const STATUS: Record<DeliveryError["code"], [number, string]> = {
  not_found: [404, "not_found"],
  invalid_request: [400, "invalid_request"],
  unavailable: [409, "conflict"],
  failed: [409, "conflict"],
  stale: [409, "conflict"],
};

function positive(raw: string, name: string): number {
  if (!POSITIVE_INTEGER.test(raw)) throw new DeliveryError("invalid_request", `${name} 要是一个正整数。`);
  return Number(raw);
}

// 处理了返回 true；不是这两条路由返回 false。
export async function handleDeliverySnapshotRoute(ctx: DeliverySnapshotRouteContext): Promise<boolean> {
  if (ctx.req.method !== "GET") return false;
  const list = ctx.url.pathname.match(LIST_PATH);
  const one = ctx.url.pathname.match(ONE_PATH);
  if (!list && !one) return false;
  ctx.requireAuth("tickets:view");
  try {
    if (list) {
      ctx.json(200, { deliveries: await ticketDeliveries(ctx.db, positive(list[1]!, "工单号")) });
      return true;
    }
    const revision = ctx.url.searchParams.get("revision");
    ctx.json(200, {
      delivery: await ticketDeliverySnapshot(
        ctx.db, positive(one![1]!, "工单号"), positive(one![2]!, "交付序号"),
        revision === null ? undefined : positive(revision, "revision"),
      ),
    });
    return true;
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应。
    const [status, code] = STATUS[error.code];
    ctx.json(status, { error: { code, message: error.message, details: { reason: error.code } } });
    return true;
  }
}
