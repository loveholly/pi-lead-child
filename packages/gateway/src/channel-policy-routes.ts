// /v1/channels/policy 的路由（设置 → 消息通道 → 自动代你处理，2026-10-23）：开关、授权表和信心模型的参数。
// 改参数、测一条消息、评估过去 24 小时的消息都是操作层的 channel_policy（engine 的 ui-actions/，仓库 AGENTS.md「UI Actions」）：
// Lead 走 perform_action，调同一个函数。这里只认证、校验请求体，再以你本人的名义交给 perform。
//   - GET  /v1/channels/policy/:source         tickets:view    现在生效的、最新版本里写的、缺省。
//   - PUT  /v1/channels/policy/:source         tickets:create  改（update，含放宽）。请求体是改完以后的一整份。
//   - POST /v1/channels/policy/:source/test    tickets:view    测一条消息（只读；你写的句子会让请求 A、B 打分）。
//   - POST /v1/channels/policy/:source/replay  tickets:view    评估过去 24 小时的消息（只读）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  CHANNEL_POLICY_RESOURCE, ChannelPolicyParamsSchema, ChannelPolicyReplayRequestSchema, ChannelPolicyTestRequestSchema,
  type ChannelPolicyDto, type Scope,
} from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { channelPolicyDto } from "@pi-lead-child/engine";

export interface ChannelPolicyRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做一个 channel_policy 操作，返回操作的结果。出错时抛 HttpError（网关按错误码映射）。
  perform(source: string, action: "update" | "test" | "replay", input: unknown, scope: Scope): Promise<unknown>;
  // 改了以后告诉别的设备重新读。
  publish(resource: string): void;
}

const PATH = /^\/v1\/channels\/policy\/([a-z][a-z0-9_-]{0,39})(\/test|\/replay)?$/;

const invalid = (ctx: ChannelPolicyRouteContext, message: string) => ctx.json(400, { error: { code: "invalid_request", message } });

/** 处理自动代你处理的路由。不是这些路径时返回 false。 */
export async function handleChannelPolicyRoute(ctx: ChannelPolicyRouteContext): Promise<boolean> {
  const match = PATH.exec(ctx.url.pathname);
  if (!match) return false;
  const source = match[1]!;
  const sub = match[2] ?? "";
  const method = ctx.req.method;
  if (sub === "" && method === "GET") {
    ctx.requireAuth("tickets:view");
    const policy: ChannelPolicyDto = channelPolicyDto(ctx.db, source);
    ctx.json(200, { policy });
    return true;
  }
  if (sub === "" && method === "PUT") {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(ChannelPolicyParamsSchema, body)) {
      invalid(ctx, "body must be { autoReply, intents, confidence }: the whole policy after the change");
      return true;
    }
    await ctx.perform(source, "update", body, "tickets:create");
    ctx.publish(CHANNEL_POLICY_RESOURCE);
    ctx.json(200, { policy: channelPolicyDto(ctx.db, source) });
    return true;
  }
  if ((sub === "/test" || sub === "/replay") && method === "POST") {
    ctx.requireAuth("tickets:view");
    const body = await ctx.readBody();
    const schema = sub === "/test" ? ChannelPolicyTestRequestSchema : ChannelPolicyReplayRequestSchema;
    if (!Value.Check(schema, body)) {
      invalid(ctx, sub === "/test" ? "body must be { params?, case }" : "body must be { params }");
      return true;
    }
    const result = await ctx.perform(source, sub === "/test" ? "test" : "replay", body, "tickets:view");
    ctx.json(200, { result });
    return true;
  }
  return false;
}
