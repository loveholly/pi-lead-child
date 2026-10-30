// /v1/channels/reply-style 的路由（设置 → 消息通道 → 代回复风格，2026-10-28，.scratch/channel-reply-style/spec.md）。
// 改和提炼都是操作层的 reply_style（engine 的 ui-actions/reply-style.ts，仓库 AGENTS.md「UI Actions」）：Lead 走 perform_action，
// 调同一个函数。这里只认证、校验请求体，再以你本人的名义交给 perform。
//   - GET  /v1/channels/reply-style          tickets:view    现在的代回复风格。
//   - POST /v1/channels/reply-style          tickets:create  改：{ mode: replace|append, text, label? }。每次修改记一次主人操作。
//   - POST /v1/channels/reply-style/extract  tickets:create  从最近 N 天你本人的消息提炼：{ days?, source? }。只读，要调一次模型。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  ReplyStyleExtractRequestSchema, ReplyStyleUpdateRequestSchema, type ReplyStyleExtractResult, type Scope,
} from "@pi-lead-child/protocol";
import { getReplyStyle, type Db } from "@pi-lead-child/store";

export interface ReplyStyleRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做一个 reply_style 操作，返回操作的结果。出错时抛 HttpError（网关按错误码映射）。
  perform(action: "update" | "extract", input: unknown, scope: Scope): Promise<unknown>;
}

const PATH = /^\/v1\/channels\/reply-style(\/extract)?$/;

const invalid = (ctx: ReplyStyleRouteContext, message: string) => ctx.json(400, { error: { code: "invalid_request", message } });

/** 处理代回复风格的路由。不是这些路径时返回 false。 */
export async function handleReplyStyleRoute(ctx: ReplyStyleRouteContext): Promise<boolean> {
  const match = PATH.exec(ctx.url.pathname);
  if (!match) return false;
  const extract = match[1] === "/extract";
  const method = ctx.req.method;
  if (!extract && method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { replyStyle: getReplyStyle(ctx.db) });
    return true;
  }
  if (method !== "POST") return false;
  ctx.requireAuth("tickets:create");
  const body = await ctx.readBody();
  if (!extract) {
    if (!Value.Check(ReplyStyleUpdateRequestSchema, body)) {
      invalid(ctx, "body must be { mode: replace | append, text, label? }");
      return true;
    }
    await ctx.perform("update", body, "tickets:create");
    ctx.json(200, { replyStyle: getReplyStyle(ctx.db) });
    return true;
  }
  if (!Value.Check(ReplyStyleExtractRequestSchema, body)) {
    invalid(ctx, "body must be { days?: 1-30, source? }");
    return true;
  }
  const result = await ctx.perform("extract", body, "tickets:create") as ReplyStyleExtractResult;
  ctx.json(200, { result });
  return true;
}
