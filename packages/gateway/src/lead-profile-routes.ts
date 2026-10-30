// /v1/lead/profile 的路由（设置页「身份与风格」，2026-10-22）：Lead 的名字、人格和互动风格。
// 网关只做认证和错误映射，修改在 engine 的 lead-profile.ts（Lead 的 update_lead_profile 工具调同一个函数）。
//   - GET  /v1/lead/profile  tickets:view
//   - POST /v1/lead/profile  tickets:create，请求体 { name?, persona?, interactionStyle? }。每次修改记一次主人操作（lead.profile）。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerActionSource, Scope } from "@pi-lead-child/protocol";
import { getLeadProfile, type Binding, type Db } from "@pi-lead-child/store";
import { LeadProfileError, updateLeadProfile } from "@pi-lead-child/engine";

export interface LeadProfileRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): Binding;
  requestSource(binding: Binding): OwnerActionSource;
  // 改了以后发 snapshot.required（resource 是 lead-profile）。
  publish(resource: string): void;
  log(line: string): void;
}

const PATH = "/v1/lead/profile";

// 处理了返回 true。不是这条路由返回 false。
export async function handleLeadProfileRoute(ctx: LeadProfileRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (url.pathname !== PATH) return false;
  if (req.method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { leadProfile: getLeadProfile(ctx.db) });
    return true;
  }
  if (req.method !== "POST") return false;
  const binding = ctx.requireAuth("tickets:create");
  const request = req.headers["content-length"] === "0" ? {} : await ctx.readBody();
  try {
    const outcome = updateLeadProfile(ctx.db, {
      request: (request ?? {}) as never,
      caller: { kind: "user", credential: binding, source: ctx.requestSource(binding) },
      publish: (resource) => ctx.publish(resource),
      log: ctx.log,
    });
    ctx.json(200, { leadProfile: outcome.profile });
  } catch (error) {
    if (error instanceof LeadProfileError) {
      // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
      ctx.json(400, { error: { code: "invalid_request", message: error.message, details: { reason: error.code } } });
      return true;
    }
    throw error;
  }
  return true;
}
