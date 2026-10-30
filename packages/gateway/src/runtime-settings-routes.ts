// /v1/runtimes/settings 的路由（设置页「执行器」，2026-10-19）。网关只做认证、校验请求体，再转调操作层
// （engine 的 ui-actions/ 的 runtime 的 disable、enable，经 perform），操作层调 daemon 的 RuntimeSettings.update
// （经 PairedBridge.runtimeSettings）。读用 tickets:view，改用 tickets:create（和 /v1/decision-model 一样）。
// 这条路由总是以你本人的名义拨；Lead 的 perform_action 经过同一个操作层（2026-10-22，AGENTS.md「UI Actions」），规则在那里。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import type { RuntimeSwitchService } from "@pi-lead-child/engine";
import {
  RuntimeSettingsRequestSchema,
  type RuntimeSettingsDto,
  type RuntimeSettingsRequest,
  type Scope,
} from "@pi-lead-child/protocol";

// daemon 的执行器开关。操作层也用它（UiActionServices.runtimeSettings），是同一个对象。
export type RuntimeSettingsService = RuntimeSwitchService;

export interface RuntimeSettingsRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  service: RuntimeSettingsService | undefined;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  requireAuth(scope: Scope): void;
  // 以你的名义拨一个开关：转调操作层，返回拨完以后的设置。
  perform(request: RuntimeSettingsRequest): Promise<RuntimeSettingsDto>;
}

const PATH = "/v1/runtimes/settings";

// 处理了返回 true。不是这条路由返回 false。
export async function handleRuntimeSettingsRoute(ctx: RuntimeSettingsRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (url.pathname !== PATH) return false;
  // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
  const fail = (status: number, code: string, reason: string, message: string) =>
    ctx.json(status, { error: { code, message, details: { reason } } });
  if (req.method === "GET") {
    ctx.requireAuth("tickets:view");
    if (!ctx.service) {
      fail(503, "internal_error", "unavailable", "执行器设置还没有启动");
      return true;
    }
    ctx.json(200, { runtimeSettings: ctx.service.get() });
    return true;
  }
  if (req.method !== "POST") return false;
  ctx.requireAuth("tickets:create");
  const request = req.headers["content-length"] === "0" ? {} : await ctx.readBody();
  if (!Value.Check(RuntimeSettingsRequestSchema, request)) {
    fail(400, "invalid_request", "invalid_request", "runtime must be pi, codex or claude, and enabled must be a boolean");
    return true;
  }
  if (!ctx.service) {
    fail(503, "internal_error", "unavailable", "执行器设置还没有启动");
    return true;
  }
  ctx.json(200, { runtimeSettings: await ctx.perform(request as RuntimeSettingsRequest) });
  return true;
}
