// /v1/memory 和 /v1/decision-model 的路由（src/memory-routes.ts）：scope、请求体校验、错误的形状。
// 服务是假的；整条链路（daemon、网关、MemoryController）在 apps/daemon/test/memory-settings-daemon.test.ts。
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import { HttpErrorResponseSchema, type MemorySettingsDto, type Scope } from "@pi-lead-child/protocol";
import { handleMemoryRoute, type DecisionModelService, type MemoryService } from "../src/memory-routes.js";

const DTO = { pendingSwitch: null } as unknown as MemorySettingsDto;

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function call(
  method: string, path: string,
  options: { body?: Record<string, unknown>; memory?: Partial<MemoryService> | null; decision?: Partial<DecisionModelService> } = {},
) {
  const scopes: Scope[] = [];
  const calls: unknown[][] = [];
  let response: { status: number; body: any } | null = null;
  const memory = options.memory === null ? undefined : {
    get: () => DTO,
    update: async (request) => { calls.push(["update", request]); return DTO; },
    test: async () => ({ ok: true, message: "ok", latencyMs: 1 }),
    getSwitch: (id) => ({ id, summary: "s", reason: "r", needsConfirmation: true, state: "pending", createdAt: "2026-10-16T00:00:00.000Z" }),
    confirmSwitch: async (...args) => { calls.push(["confirm", ...args]); return { memory: DTO, switch: { id: args[0] } as never }; },
    ...options.memory,
  } as MemoryService;
  const decisionModel = {
    get: () => ({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKeySet: false, apiKeySource: null }),
    update: async (request) => {
      calls.push(["decision", request]);
      return { baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKeySet: true, apiKeySource: "settings" };
    },
    test: async () => ({ ok: true, message: "ok", latencyMs: 1 }),
    ...options.decision,
  } as DecisionModelService;
  const handled = await handleMemoryRoute({
    req: { method, headers: options.body ? {} : { "content-length": "0" } } as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://127.0.0.1${path}`),
    memory, decisionModel,
    json: (status, body) => { response = { status, body }; },
    readBody: async () => options.body ?? {},
    requireAuth: (scope) => { scopes.push(scope); return "web"; },
  });
  return { handled, scopes, calls, response: response as { status: number; body: any } | null };
}

describe("memory routes", () => {
  it("reads with tickets:view, writes with tickets:create, confirms with approvals:respond", async () => {
    expect((await call("GET", "/v1/memory")).scopes).toEqual(["tickets:view"]);
    expect((await call("GET", "/v1/decision-model")).scopes).toEqual(["tickets:view"]);
    const saved = await call("POST", "/v1/memory/settings", { body: { reranker: { mode: "none" } } });
    expect(saved.scopes.every((scope) => scope === "tickets:create")).toBe(true);
    expect(saved.response).toEqual({ status: 200, body: { memory: DTO } });
    const confirmed = await call("POST", "/v1/memory/switches/msw_abcdefgh12/confirm", { body: { approve: true } });
    expect(confirmed.scopes.every((scope) => scope === "approvals:respond")).toBe(true);
    expect(confirmed.calls).toEqual([["confirm", "msw_abcdefgh12", true, "user via web"]]);
    const one = await call("GET", "/v1/memory/switches/msw_abcdefgh12");
    expect(one.scopes).toEqual(["tickets:view", "tickets:view"]);
    expect(one.response).toMatchObject({ status: 200, body: { switch: { id: "msw_abcdefgh12", state: "pending" } } });
    expect((await call("GET", "/v1/notes")).handled).toBe(false);
    expect((await call("GET", "/v1/memory/switches/msw_abcdefgh12/extra")).handled).toBe(false);
  });

  it("rejects malformed bodies and switch ids with the strict error shape", async () => {
    const cases = [
      await call("POST", "/v1/memory/settings", { body: { embedding: { mode: "remote", baseUrl: "file:///etc/passwd", model: "m" } } }),
      await call("POST", "/v1/memory/settings", { body: { embedding: { mode: "local", model: "../../etc" } } }),
      await call("POST", "/v1/decision-model/settings", { body: { apiKey: "" } }),
      await call("POST", "/v1/memory/switches/msw_%E0%A4%A/confirm", { body: { approve: true } }),
      await call("GET", "/v1/memory/switches/msw_%E0%A4%A"),
      await call("POST", "/v1/memory/switches/not-a-switch/confirm", { body: { approve: true } }),
      await call("POST", "/v1/memory/switches/msw_abcdefgh12/confirm", { body: { approve: "yes" } }),
    ];
    for (const { response, calls } of cases) {
      expect(response?.status).toBe(400);
      expect(Value.Check(HttpErrorResponseSchema, response?.body)).toBe(true);
      expect(response?.body.error.details.reason).toBe("invalid_request");
      expect(calls).toEqual([]);
    }
  });

  it("maps controller errors to HTTP statuses and says when memory is not running", async () => {
    const notFound = await call("POST", "/v1/memory/switches/msw_abcdefgh12/confirm", {
      body: { approve: true }, memory: { confirmSwitch: async () => { throw coded("not_found", "没有这个待切换"); } },
    });
    expect(notFound.response).toMatchObject({ status: 404, body: { error: { code: "not_found", details: { reason: "not_found" } } } });
    const stale = await call("POST", "/v1/memory/switches/msw_abcdefgh12/confirm", {
      body: { approve: false }, memory: { confirmSwitch: async () => { throw coded("not_pending", "已经处理过了"); } },
    });
    expect(stale.response).toMatchObject({ status: 409, body: { error: { code: "conflict", details: { reason: "not_pending" } } } });
    expect(Value.Check(HttpErrorResponseSchema, stale.response?.body)).toBe(true);
    const off = await call("GET", "/v1/memory", { memory: null });
    expect(off.response).toMatchObject({ status: 503, body: { error: { details: { reason: "unavailable" } } } });
    // 不认识的错误不吞掉：交给网关的统一错误处理。
    await expect(call("POST", "/v1/memory/test", { memory: { test: async () => { throw new Error("boom"); } } })).rejects.toThrow("boom");
  });

  it("passes a new decision-model key through once and never echoes it", async () => {
    const saved = await call("POST", "/v1/decision-model/settings", { body: { apiKey: "dec-secret" } });
    expect(saved.calls).toEqual([["decision", { apiKey: "dec-secret" }]]);
    expect(JSON.stringify(saved.response)).not.toContain("dec-secret");
  });
});
