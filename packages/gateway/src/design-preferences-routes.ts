// /v1/design/preferences 的路由（设置页「外观」，2026-10-22）：密度、圆角、行高、字号、颜色、设计说明。
// 网关只做认证和错误映射，修改在 engine 的 design-preferences.ts（Lead 的 update_design_preferences 工具调同一个函数）。
//   - GET  /v1/design/preferences  tickets:view
//   - POST /v1/design/preferences  tickets:create，请求体只带要改的字段。每次修改记一次主人操作（ui.design）。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerActionSource, Scope } from "@pi-lead-child/protocol";
import { getDesignPreferences, type Binding, type Db } from "@pi-lead-child/store";
import { DesignPreferencesError, updateDesignPreferences } from "@pi-lead-child/engine";

export interface DesignPreferencesRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): Binding;
  requestSource(binding: Binding): OwnerActionSource;
  publish(resource: string): void;
  log(line: string): void;
}

const PATH = "/v1/design/preferences";

export async function handleDesignPreferencesRoute(ctx: DesignPreferencesRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (url.pathname !== PATH) return false;
  if (req.method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { designPreferences: getDesignPreferences(ctx.db) });
    return true;
  }
  if (req.method !== "POST") return false;
  const binding = ctx.requireAuth("tickets:create");
  const request = req.headers["content-length"] === "0" ? {} : await ctx.readBody();
  try {
    const outcome = updateDesignPreferences(ctx.db, {
      request: (request ?? {}) as never,
      caller: { kind: "user", credential: binding, source: ctx.requestSource(binding) },
      publish: (resource) => ctx.publish(resource),
      log: ctx.log,
    });
    ctx.json(200, { designPreferences: outcome.preferences });
  } catch (error) {
    if (error instanceof DesignPreferencesError) {
      ctx.json(400, { error: { code: "invalid_request", message: error.message, details: { reason: error.code } } });
      return true;
    }
    throw error;
  }
  return true;
}
