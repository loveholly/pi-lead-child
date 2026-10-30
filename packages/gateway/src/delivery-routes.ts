// 工单「这次交付」的路由（2026-10-20）。读交付和文件用 tickets:view；合并、开 PR、放弃用 tickets:create，
// 而且只有用户本人能点（请求体不能自称 lead）。读交付的逻辑在 engine 的 delivery.ts；合并、开 PR、放弃转调工单操作层
// （engine 的 ticket-actions/，spec 5.11），和 POST /v1/tickets/:id/actions/(merge|open_pr|abandon) 同一份实现。
// 这里只做认证、校验和错误映射。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { DeliveryError, ticketDelivery, ticketDeliveryFile } from "@pi-lead-child/engine";

export interface DeliveryRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  requireAuth(scope: Scope): void;
  // 请求体里自称 actor 的检查（只能是用户）。
  assertUserActor(body: unknown): void;
  // 以你的名义执行工单操作层的 merge、open_pr、abandon：同样的检查，验收走同一个 completeItem，记主人操作，发线上事件。
  perform(itemId: number, action: "merge" | "open_pr" | "abandon", input: Record<string, unknown>): Promise<unknown>;
  // 不是 DeliveryError 的错误（例如操作层的「现在不能做」、验收被拒）交给网关现有的映射。
  mapError(error: unknown): never;
}

const ITEM_PATH = /^\/v1\/tickets\/(\d+)\/delivery$/;
const FILE_PATH = /^\/v1\/tickets\/(\d+)\/delivery\/file$/;
const ACTION_PATH = /^\/v1\/tickets\/(\d+)\/delivery\/(merge|open-pr|abandon)$/;

const STATUS: Record<DeliveryError["code"], [number, string]> = {
  not_found: [404, "not_found"],
  invalid_request: [400, "invalid_request"],
  unavailable: [409, "conflict"],
  failed: [409, "conflict"],
  stale: [409, "conflict"],
};

// 用户看到的交付（GET delivery 的 workspace.head、workspace.target，2026-10-21 审查 M2）。只拿来和现在的比较，
// 不进任何命令。不给时不比。
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BRANCH_NAME = 255;

function deliveryExpectation(body: Record<string, unknown>): Record<string, unknown> {
  const { expectedHead, expectedTarget } = body;
  if (expectedHead !== undefined && expectedHead !== null
    && (typeof expectedHead !== "string" || !COMMIT_SHA.test(expectedHead))) {
    throw new DeliveryError("invalid_request", "expectedHead 要是一个完整的提交 SHA。");
  }
  if (expectedTarget !== undefined && expectedTarget !== null
    && (typeof expectedTarget !== "string" || expectedTarget.length === 0 || expectedTarget.length > MAX_BRANCH_NAME)) {
    throw new DeliveryError("invalid_request", `expectedTarget 要是一个 1 到 ${MAX_BRANCH_NAME} 个字符的分支名。`);
  }
  return {
    ...(expectedHead !== undefined ? { expectedHead } : {}),
    ...(expectedTarget !== undefined ? { expectedTarget } : {}),
  };
}

// 处理了返回 true；不是这几条路由返回 false。
export async function handleDeliveryRoute(ctx: DeliveryRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  const itemMatch = url.pathname.match(ITEM_PATH);
  const fileMatch = url.pathname.match(FILE_PATH);
  const actionMatch = url.pathname.match(ACTION_PATH);
  if (!itemMatch && !fileMatch && !actionMatch) return false;
  // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应。
  const fail = (error: DeliveryError) => {
    const [status, code] = STATUS[error.code];
    ctx.json(status, { error: { code, message: error.message, details: { reason: error.code } } });
  };
  const ticketId = Number((itemMatch ?? fileMatch ?? actionMatch)![1]);
  try {
    if (req.method === "GET" && itemMatch) {
      ctx.requireAuth("tickets:view");
      ctx.json(200, { delivery: await ticketDelivery(ctx.db, ticketId) });
      return true;
    }
    if (req.method === "GET" && fileMatch) {
      ctx.requireAuth("tickets:view");
      const view = url.searchParams.get("view") ?? "full";
      if (view !== "full" && view !== "diff") throw new DeliveryError("invalid_request", "view 只能是 full 或 diff。");
      ctx.json(200, { file: await ticketDeliveryFile(ctx.db, ticketId, url.searchParams.get("path"), view) });
      return true;
    }
    if (req.method !== "POST" || !actionMatch) return false;
    ctx.requireAuth("tickets:create");
    const body = req.headers["content-length"] === "0" ? {} : await ctx.readBody();
    ctx.assertUserActor(body);
    const input = deliveryExpectation(body);
    if (!getItem(ctx.db, ticketId)) throw new DeliveryError("not_found", `工单 #${ticketId} 不存在`);
    const action = actionMatch[2] as "merge" | "open-pr" | "abandon";
    const result = await ctx.perform(ticketId, action === "open-pr" ? "open_pr" : action, input) as {
      delivery: unknown; pullRequestUrl?: string;
    };
    ctx.json(200, { action, delivery: result.delivery, ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}) });
    return true;
  } catch (error) {
    if (error instanceof DeliveryError) {
      fail(error);
      return true;
    }
    ctx.mapError(error);
  }
}
