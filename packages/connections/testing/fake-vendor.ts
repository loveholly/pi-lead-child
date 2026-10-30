// 测试用的假厂商：一个授权服务器加一个远程 MCP 服务器，都挂在注入的 fetch 上，不走网络。
// 行为照着调研到的真实规则做：DCR、PKCE S256、resource 参数、刷新令牌轮换（复用旧的刷新令牌吊销整个授权）。
import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "../src/oauth.js";

export interface FakeVendorOptions {
  mcpUrl?: string;
  issuer?: string;
  accessTtlSec?: number;
  supportsDcr?: boolean;
  sse?: boolean;
  // MCP 服务器的工具（tools/list 原样返回）和调用的结果。不给时是缺省的 search_pages、update_page、get_self。
  tools?: Array<Record<string, unknown>>;
  callResult?: (name: string, args: Record<string, unknown>) => string;
}

const DEFAULT_TOOLS: Array<Record<string, unknown>> = [
  { name: "search_pages", description: "Search pages", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "update_page", description: "Update a page", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "get_self", description: "Who am I", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

interface Grant {
  id: string;
  clientId: string;
  revoked: boolean;
}

export class FakeVendor {
  readonly mcpUrl: string;
  readonly issuer: string;
  accessTtlSec: number;
  supportsDcr: boolean;
  sse: boolean;
  readonly clients = new Map<string, { redirectUris: string[]; secret: string | null }>();
  readonly codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string; grant: Grant }>();
  readonly access = new Map<string, { expiresAt: number; grant: Grant }>();
  readonly refresh = new Map<string, { used: boolean; grant: Grant }>();
  readonly calls: Array<{ method: string; tool?: string }> = [];
  readonly tools: Array<Record<string, unknown>>;
  readonly callResult: ((name: string, args: Record<string, unknown>) => string) | null;
  refreshCount = 0;
  registrations = 0;
  revoked: string[] = [];
  // 下一次刷新时的故障：network（fetch 抛错）、server（500）、invalid_grant。
  failNextRefresh: Array<"network" | "server" | "invalid_grant"> = [];
  // 刷新请求到达时先跑的钩子（模拟另一条路径在这时换了令牌）。
  onRefresh: (() => void) | null = null;
  now: () => number;

  constructor(now: () => number, options: FakeVendorOptions = {}) {
    this.now = now;
    this.mcpUrl = options.mcpUrl ?? "https://mcp.fake.test/mcp";
    this.issuer = options.issuer ?? "https://auth.fake.test";
    this.accessTtlSec = options.accessTtlSec ?? 3600;
    this.supportsDcr = options.supportsDcr ?? true;
    this.sse = options.sse ?? false;
    this.tools = options.tools ?? DEFAULT_TOOLS;
    this.callResult = options.callResult ?? null;
  }

  // 让浏览器那一步通过：解析授权地址，签发一个授权码，返回回调参数。
  approve(authorizeUrl: string): { state: string; code: string; iss: string } {
    const url = new URL(authorizeUrl);
    const clientId = url.searchParams.get("client_id")!;
    if (!this.clients.has(clientId) && !clientId.startsWith("pre-")) throw new Error(`unknown client ${clientId}`);
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    const code = `code_${randomBytes(8).toString("hex")}`;
    this.codes.set(code, {
      clientId,
      challenge: url.searchParams.get("code_challenge")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
      resource: url.searchParams.get("resource")!,
      grant: { id: randomBytes(4).toString("hex"), clientId, revoked: false },
    });
    return { state: url.searchParams.get("state")!, code, iss: this.issuer };
  }

  // 所有授权都作废（用户在厂商那边撤销了授权）。
  revokeAll(): void {
    for (const entry of this.refresh.values()) entry.grant.revoked = true;
  }

  // 让现有的访问令牌全部过期（服务器回 401）。
  expireAccessTokens(): void {
    for (const entry of this.access.values()) entry.expiresAt = 0;
  }

  #issue(grant: Grant): Record<string, unknown> {
    const access = `at_${randomBytes(12).toString("hex")}`;
    const refresh = `rt_${randomBytes(12).toString("hex")}`;
    this.access.set(access, { expiresAt: this.now() + this.accessTtlSec * 1000, grant });
    this.refresh.set(refresh, { used: false, grant });
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: this.accessTtlSec, scope: "read write" };
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

    if (`${url.origin}${url.pathname}` === this.mcpUrl && method === "POST") return this.#mcp(init, body);
    if (method === "DELETE" && `${url.origin}${url.pathname}` === this.mcpUrl) return new Response(null, { status: 204 });
    const mcp = new URL(this.mcpUrl);
    if (url.origin === mcp.origin && url.pathname === `/.well-known/oauth-protected-resource${mcp.pathname}`) {
      return json(200, { resource: this.mcpUrl, authorization_servers: [this.issuer], scopes_supported: ["read", "write"] });
    }
    const issuer = new URL(this.issuer);
    // RFC 8414：issuer 带路径时，元数据在 /.well-known/oauth-authorization-server<路径>（Atlassian 的 issuer 就带路径）。
    const issuerPath = issuer.pathname.replace(/\/+$/, "");
    if (url.origin === issuer.origin && url.pathname === `/.well-known/oauth-authorization-server${issuerPath}`) {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        ...(this.supportsDcr ? { registration_endpoint: `${this.issuer}/register` } : {}),
        revocation_endpoint: `${this.issuer}/revoke`,
        scopes_supported: ["read", "write", "offline_access"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    const at = (path: string) => url.origin === issuer.origin && url.pathname === `${issuerPath}${path}`;
    if (at("/register") && method === "POST") {
      this.registrations += 1;
      const request = JSON.parse(body) as { redirect_uris: string[]; application_type?: string; token_endpoint_auth_method?: string };
      if (request.application_type !== "native" || request.token_endpoint_auth_method !== "none") return json(400, { error: "invalid_client_metadata" });
      const clientId = `client_${randomBytes(6).toString("hex")}`;
      this.clients.set(clientId, { redirectUris: request.redirect_uris, secret: null });
      return json(201, { client_id: clientId });
    }
    if (at("/token") && method === "POST") return this.#token(new URLSearchParams(body), json);
    if (at("/revoke") && method === "POST") {
      this.revoked.push(new URLSearchParams(body).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    return json(404, { error: "not_found" });
  };

  #token(form: URLSearchParams, json: (status: number, value: unknown) => Response): Response {
    if (form.get("grant_type") === "authorization_code") {
      const entry = this.codes.get(form.get("code") ?? "");
      if (!entry) return json(400, { error: "invalid_grant" });
      this.codes.delete(form.get("code")!);
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
      if (form.get("resource") !== entry.resource || form.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant" });
      if (form.get("client_id") !== entry.clientId) return json(401, { error: "invalid_client" });
      return json(200, this.#issue(entry.grant));
    }
    if (form.get("grant_type") === "refresh_token") {
      this.onRefresh?.();
      const failure = this.failNextRefresh.shift();
      if (failure === "network") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND auth.fake.test");
      if (failure === "server") return json(503, { error: "temporarily_unavailable" });
      if (failure === "invalid_grant") return json(400, { error: "invalid_grant" });
      this.refreshCount += 1;
      const entry = this.refresh.get(form.get("refresh_token") ?? "");
      if (!entry || entry.grant.revoked) return json(400, { error: "invalid_grant" });
      if (entry.used) {
        // 复用旧的刷新令牌：吊销整个授权（Notion 的规则）。
        entry.grant.revoked = true;
        return json(400, { error: "invalid_grant", error_description: "refresh token reused" });
      }
      if (!form.get("resource")) return json(400, { error: "invalid_request" });
      entry.used = true;
      return json(200, this.#issue(entry.grant));
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  #mcp(init: RequestInit, body: string): Response {
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const entry = this.access.get(token);
    if (!entry || entry.expiresAt <= this.now() || entry.grant.revoked) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${new URL(this.mcpUrl).origin}/.well-known/oauth-protected-resource${new URL(this.mcpUrl).pathname}", scope="read write"` },
      });
    }
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    this.calls.push({ method: message.method, ...(message.params?.name ? { tool: message.params.name } : {}) });
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: this.tools };
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const text = name === "get_self" ? JSON.stringify({ user: { name: "You", email: "you@acme.test" } })
        : this.callResult ? this.callResult(name ?? "", args) : `called ${name} with ${JSON.stringify(args)}`;
      result = { content: [{ type: "text", text }], isError: false };
    } else {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    const extra: Record<string, string> = message.method === "initialize" ? { "mcp-session-id": "session-1" } : {};
    if (this.sse) {
      const stream = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${reply}\n\n`;
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...extra } });
    }
    return new Response(reply, { status: 200, headers: { "content-type": "application/json", ...extra } });
  }
}

// 把几个假厂商合在一个 fetch 上：按地址分发。
export function combinedFetch(...handlers: Array<{ owns: (url: URL) => boolean; fetch: FetchLike }>): FetchLike {
  return (input, init) => {
    const url = new URL(input);
    const handler = handlers.find((entry) => entry.owns(url));
    if (!handler) return Promise.resolve(new Response(JSON.stringify({ error: "no route" }), { status: 404 }));
    return handler.fetch(input, init);
  };
}

export function owns(vendor: FakeVendor): (url: URL) => boolean {
  const hosts = new Set([new URL(vendor.mcpUrl).host, new URL(vendor.issuer).host]);
  return (url) => hosts.has(url.host);
}
