// /v1/channels/handbook 的路由（设置 → 消息通道 → 自动代你处理，交接说明，方案 B，issue 07）。
// 改、预演都是操作层的 channel_handbook（engine 的 ui-actions/handbook.ts，仓库 AGENTS.md「UI Actions」）：
// Lead 走 perform_action，调同一个函数。这里只认证、校验请求体，再以你本人的名义交给 perform。
//   - GET  /v1/channels/handbook           tickets:view    现在生效的、最新版本里写的、缺省的。
//   - PUT  /v1/channels/handbook           tickets:create  改（update，含放宽）。请求体是改完以后的一整份。
//   - POST /v1/channels/handbook/rehearse  tickets:view    预演一条消息（只读；收件判断真的选一句）。
//   - POST /v1/channels/handbook/propose   tickets:create  把一句随口的话整理成交接说明里的一句（只读，不保存；要调一次模型）。
//   - GET  /v1/channels/handbook/suggestions          tickets:view    页边批注：建议和底线的次数（只读；一天最多归类一次）。
//   - POST /v1/channels/handbook/suggestions/accept   tickets:create  接受一条建议 { key }：改交接说明，回改完的和剩下的建议。
//   - POST /v1/channels/handbook/suggestions/dismiss  tickets:create  不用一条建议 { key }：以后不再出现，回剩下的建议。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  CHANNEL_HANDBOOK_RESOURCE, ChannelHandbookSchema, channelHandbookProblems, HandbookProposalRequestSchema, HandbookRehearsalRequestSchema,
  HandbookSuggestionKeySchema, type Scope,
} from "@pi-lead-child/protocol";
import { channelHandbookDto, type Db } from "@pi-lead-child/store";

export interface HandbookRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做一个 channel_handbook 操作，返回操作的结果。出错时抛 HttpError（网关按错误码映射）。
  perform(
    action: "update" | "rehearse" | "propose" | "suggestions" | "accept_suggestion" | "dismiss_suggestion", input: unknown, scope: Scope,
  ): Promise<unknown>;
  // 改了以后告诉别的设备重新读。
  publish(resource: string): void;
}

const PATH = /^\/v1\/channels\/handbook(\/rehearse|\/propose|\/suggestions|\/suggestions\/accept|\/suggestions\/dismiss)?$/;

const invalid = (ctx: HandbookRouteContext, message: string) => ctx.json(400, { error: { code: "invalid_request", message } });

/** 处理交接说明的路由。不是这些路径时返回 false。 */
export async function handleHandbookRoute(ctx: HandbookRouteContext): Promise<boolean> {
  const match = PATH.exec(ctx.url.pathname);
  if (!match) return false;
  const sub = match[1] ?? "";
  const method = ctx.req.method;
  if (sub === "" && method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { handbook: channelHandbookDto(ctx.db) });
    return true;
  }
  if (sub === "" && method === "PUT") {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(ChannelHandbookSchema, body)) {
      invalid(ctx, "body must be the whole handbook after the change: { autoReply, situations, caps }");
      return true;
    }
    const problems = channelHandbookProblems(body);
    if (problems.length) {
      invalid(ctx, problems.join("；"));
      return true;
    }
    await ctx.perform("update", body, "tickets:create");
    ctx.publish(CHANNEL_HANDBOOK_RESOURCE);
    ctx.json(200, { handbook: channelHandbookDto(ctx.db) });
    return true;
  }
  if (sub === "/rehearse" && method === "POST") {
    ctx.requireAuth("tickets:view");
    const body = await ctx.readBody();
    if (!Value.Check(HandbookRehearsalRequestSchema, body)) {
      invalid(ctx, "body must be { text, sender: colleague|external|customer|unknown, handbook? }");
      return true;
    }
    const result = await ctx.perform("rehearse", body, "tickets:view");
    ctx.json(200, { result });
    return true;
  }
  if (sub === "/propose" && method === "POST") {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(HandbookProposalRequestSchema, body)) {
      invalid(ctx, "body must be { text } (1 to 500 characters)");
      return true;
    }
    const result = await ctx.perform("propose", body, "tickets:create");
    ctx.json(200, { result });
    return true;
  }
  if (sub === "/suggestions" && method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { suggestions: await ctx.perform("suggestions", {}, "tickets:view") });
    return true;
  }
  if ((sub === "/suggestions/accept" || sub === "/suggestions/dismiss") && method === "POST") {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(HandbookSuggestionKeySchema, body)) {
      invalid(ctx, "body must be { key }");
      return true;
    }
    const accept = sub === "/suggestions/accept";
    await ctx.perform(accept ? "accept_suggestion" : "dismiss_suggestion", body, "tickets:create");
    const suggestions = await ctx.perform("suggestions", {}, "tickets:view");
    if (accept) {
      ctx.publish(CHANNEL_HANDBOOK_RESOURCE);
      ctx.json(200, { handbook: channelHandbookDto(ctx.db), suggestions });
    } else {
      ctx.json(200, { suggestions });
    }
    return true;
  }
  return false;
}
