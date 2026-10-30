// /v1/memory 和 /v1/decision-model 的路由（设置页「Lead → 记忆 / 模型」）。网关只做认证、校验请求体，
// 再交给 daemon 的 MemoryController（经 PairedBridge.memory / decisionModel）。
// 用户在设置页填的 API key 一次性地穿过请求体：这里不记日志，也不回显。
//
// 读用 tickets:view，改用 tickets:create（和 /v1/connections 一样，tickets:create 表示「这台设备是主人」）。
// 确认待切换用 approvals:respond（和审批同一个 scope）。Lead 的工具走不到这里，所以确认只能来自用户。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerActionInput } from "./owner-actions.js";
import { Value } from "typebox/value";
import {
  DecisionModelSettingsRequestSchema,
  MemorySettingsRequestSchema,
  MemorySwitchConfirmRequestSchema,
  type DecisionModelDto,
  type DecisionModelSettingsRequest,
  type MemorySettingsDto,
  type MemorySettingsRequest,
  type MemorySwitch,
  type MemorySwitchConfirmResponse,
  type MemoryTestResponse,
  type Scope,
} from "@pi-lead-child/protocol";

export interface MemoryService {
  get(): MemorySettingsDto;
  update(request: MemorySettingsRequest): Promise<MemorySettingsDto>;
  // 用已存的远程 embedding 配置发一次请求。
  test(): Promise<MemoryTestResponse>;
  // 读一个切换（包括已经处理过的）。不认识的 id 抛 code=not_found。
  getSwitch(id: string): MemorySwitch;
  confirmSwitch(id: string, approve: boolean, resolvedBy: string): Promise<MemorySwitchConfirmResponse>;
}

export interface DecisionModelService {
  get(): DecisionModelDto;
  update(request: DecisionModelSettingsRequest): Promise<DecisionModelDto>;
  test(): Promise<MemoryTestResponse>;
}

// MemoryController 抛的错误带一个 code。按它选 HTTP 状态，在 error.details.reason 里原样带回。
const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  // 地址不合法（规则见 protocol 的 service-url.ts），message 是给人看的那一句。
  invalid_url: 400,
  // 存的 key 绑定在另一个主机上：/test 不会把它发给现在的地址。
  key_host_mismatch: 400,
  not_found: 404,
  not_pending: 409,
  unavailable: 503,
};

const HTTP_CODE: Record<number, string> = { 400: "invalid_request", 404: "not_found", 409: "conflict", 503: "internal_error" };

function memoryError(error: unknown): { status: number; reason: string; message: string } | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in ERROR_STATUS)) return null;
  return { status: ERROR_STATUS[code]!, reason: code, message: error.message };
}

export interface MemoryRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  memory: MemoryService | undefined;
  decisionModel: DecisionModelService | undefined;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  // 返回调用方 binding 的显示名，写进切换的 resolvedBy。
  requireAuth(scope: Scope): string;
  // 切换确认成功以后，记一次主人操作（工单 15）。凭证是上一次 requireAuth 的调用方。
  ownerAction?(input: OwnerActionInput): void;
}

const SWITCH_ID = /^msw_[A-Za-z0-9_-]{8,40}$/;

// 路径里的切换 id。坏的百分号转义和格式不对一样，返回 null（路由回 400）。
function switchId(pathname: string): string | null {
  const raw = /^\/v1\/memory\/switches\/([^/]+)/.exec(pathname)?.[1];
  if (!raw) return null;
  try {
    const id = decodeURIComponent(raw);
    return SWITCH_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// 处理了返回 true。不是这两组路由返回 false。
export async function handleMemoryRoute(ctx: MemoryRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  const isMemory = url.pathname === "/v1/memory" || url.pathname.startsWith("/v1/memory/");
  const isDecision = url.pathname === "/v1/decision-model" || url.pathname.startsWith("/v1/decision-model/");
  if (!isMemory && !isDecision) return false;
  const fail = (status: number, reason: string, message: string) =>
    // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
    ctx.json(status, { error: { code: HTTP_CODE[status] ?? "internal_error", message, details: { reason } } });
  const run = async <S>(scope: Scope, service: S | undefined, action: (svc: S) => Promise<unknown> | unknown) => {
    ctx.requireAuth(scope);
    if (!service) {
      fail(503, "unavailable", "记忆设置还没有启动");
      return true;
    }
    try {
      ctx.json(200, await action(service));
    } catch (error) {
      const mapped = memoryError(error);
      if (!mapped) throw error;
      fail(mapped.status, mapped.reason, mapped.message);
    }
    return true;
  };
  const body = async (scope: Scope) => {
    ctx.requireAuth(scope);
    return req.headers["content-length"] === "0" ? {} : await ctx.readBody();
  };

  if (isDecision) {
    if (req.method === "GET" && url.pathname === "/v1/decision-model") {
      return run("tickets:view", ctx.decisionModel, (svc) => ({ decisionModel: svc.get() }));
    }
    if (req.method !== "POST") return false;
    if (url.pathname === "/v1/decision-model/settings") {
      const request = await body("tickets:create");
      if (!Value.Check(DecisionModelSettingsRequestSchema, request)) {
        fail(400, "invalid_request", "baseUrl, model or apiKey is invalid");
        return true;
      }
      return run("tickets:create", ctx.decisionModel, async (svc) => ({
        decisionModel: await svc.update(request as DecisionModelSettingsRequest),
      }));
    }
    if (url.pathname === "/v1/decision-model/test") return run("tickets:create", ctx.decisionModel, (svc) => svc.test());
    return false;
  }

  if (req.method === "GET" && url.pathname === "/v1/memory") {
    return run("tickets:view", ctx.memory, (svc) => ({ memory: svc.get() }));
  }
  if (req.method === "GET" && /^\/v1\/memory\/switches\/[^/]+$/.test(url.pathname)) {
    ctx.requireAuth("tickets:view");
    const id = switchId(url.pathname);
    if (!id) {
      fail(400, "invalid_request", "switch id is malformed");
      return true;
    }
    return run("tickets:view", ctx.memory, (svc) => ({ switch: svc.getSwitch(id) }));
  }
  if (req.method !== "POST") return false;
  if (url.pathname === "/v1/memory/settings") {
    const request = await body("tickets:create");
    if (!Value.Check(MemorySettingsRequestSchema, request)) {
      fail(400, "invalid_request", "the embedding or reranker settings are invalid");
      return true;
    }
    return run("tickets:create", ctx.memory, async (svc) => ({ memory: await svc.update(request as MemorySettingsRequest) }));
  }
  if (url.pathname === "/v1/memory/test") return run("tickets:create", ctx.memory, (svc) => svc.test());
  const switchPath = /^\/v1\/memory\/switches\/([^/]+)(\/confirm)?$/.exec(url.pathname);
  if (!switchPath) return false;
  const confirm = switchPath[2] !== undefined;
  if (!confirm) return false;
  const by = ctx.requireAuth("approvals:respond");
  const id = switchId(url.pathname);
  if (!id) {
    fail(400, "invalid_request", "switch id is malformed");
    return true;
  }
  const request = await body("approvals:respond");
  if (!Value.Check(MemorySwitchConfirmRequestSchema, request)) {
    fail(400, "invalid_request", "approve must be a boolean");
    return true;
  }
  return run("approvals:respond", ctx.memory, async (svc) => {
    const approve = (request as { approve: boolean }).approve;
    const result = await svc.confirmSwitch(id, approve, `user via ${by}`);
    ctx.ownerAction?.({
      action: "memory.switch_confirm",
      target: { key: `memory_switch:${id}`, label: "记忆切换", ticketId: null },
      summary: `${approve ? "同意" : "不同意"}记忆切换：${result.switch.summary}`,
      detail: { approve, state: result.switch.state },
      undo: { kind: "memory_switch", switchId: id, approve },
    });
    return result;
  });
}
