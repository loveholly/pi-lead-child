// /v1/lead/host-bypass 的路由（设置 → Lead → 用户本人发话时免沙箱，docs/ticket-246-user-turn-bypass.md 5.1，实施单 A）。
// 开和关都是操作层的 host_bypass（engine 的 ui-actions/host-bypass.ts，仓库 AGENTS.md「UI Actions」）：Lead 走 perform_action，
// 调同一个函数。这里只认证、校验请求体，再以你本人的名义交给 perform。
//   - GET  /v1/lead/host-bypass          tickets:view    现在的开关：开没开、什么时候在哪台设备上打开的。
//   - POST /v1/lead/host-bypass/enable   tickets:create  打开：{}，不带时长，一直开着直到关掉。只有你本人能做（user_direct）。
//   - POST /v1/lead/host-bypass/disable  tickets:create  关掉：{}。Lead 也能关。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import { DisableHostBypassRequestSchema, EnableHostBypassRequestSchema, type Scope } from "@pi-lead-child/protocol";
import { getHostBypass, type Db } from "@pi-lead-child/store";

export interface HostBypassRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  now(): Date;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做一个 host_bypass 操作。出错时抛 HttpError（网关按错误码映射）。
  perform(action: "enable" | "disable", input: unknown, scope: Scope): Promise<unknown>;
}

const PATH = /^\/v1\/lead\/host-bypass(?:\/(enable|disable))?$/;

const invalid = (ctx: HostBypassRouteContext, message: string) => ctx.json(400, { error: { code: "invalid_request", message } });

/** 处理免沙箱开关的路由。不是这些路径时返回 false。 */
export async function handleHostBypassRoute(ctx: HostBypassRouteContext): Promise<boolean> {
  const match = PATH.exec(ctx.url.pathname);
  if (!match) return false;
  const action = match[1] as "enable" | "disable" | undefined;
  const method = ctx.req.method;
  if (!action) {
    if (method !== "GET") return false;
    ctx.requireAuth("tickets:view");
    ctx.json(200, { hostBypass: getHostBypass(ctx.db, ctx.now()) });
    return true;
  }
  if (method !== "POST") return false;
  ctx.requireAuth("tickets:create");
  const body = await ctx.readBody();
  if (action === "enable" && !Value.Check(EnableHostBypassRequestSchema, body)) {
    invalid(ctx, "body must be {}");
    return true;
  }
  if (action === "disable" && !Value.Check(DisableHostBypassRequestSchema, body)) {
    invalid(ctx, "body must be {}");
    return true;
  }
  await ctx.perform(action, body, "tickets:create");
  ctx.json(200, { hostBypass: getHostBypass(ctx.db, ctx.now()) });
  return true;
}
