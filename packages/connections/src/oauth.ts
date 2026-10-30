// OAuth 2.1 客户端，按 MCP 授权规范（2026-07-28）：
// - 发现：先不带令牌请求 MCP 服务器，从 401 的 WWW-Authenticate 拿资源元数据（RFC 9728），没有时退回到
//   well-known 地址；再读授权服务器元数据（RFC 8414，退回到 OpenID 的发现地址）。
// - 客户端：预注册的 client ID 优先，否则用 DCR（RFC 7591）。CIMD 要一个静态 HTTPS 地址，现在没有。
// - PKCE 只用 S256；元数据里没有 S256 时停下。授权请求和换令牌请求都带 resource（RFC 8707）。
// - 授权响应里有 iss 时必须等于 issuer（RFC 9207）。
// 这里只发请求、解析响应，不存任何东西：存库、加密、续期的排队都在 hub.ts。
import { createHash, randomBytes } from "node:crypto";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface Discovery {
  // null：服务器不要授权（不带令牌也能 initialize）。
  resource: ProtectedResourceMetadata | null;
  server: AuthorizationServerMetadata | null;
  // WWW-Authenticate 里的 scope，优先于资源元数据里的 scopes_supported。
  challengeScope: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  // 秒。服务器不说时为 null。
  expiresIn: number | null;
  scope: string | null;
}

export type OAuthErrorKind = "invalid_grant" | "invalid_client" | "transient" | "protocol";

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function request(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    // 读元数据（GET）可以跟随跳转。带凭据的 POST（换令牌、注册、吊销）不跟随，免得凭据被转到别处。
    const redirect = (init.method ?? "GET") === "GET" ? "follow" : "error";
    return await fetchImpl(url, { ...init, redirect, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // 网络错误、DNS、超时都是暂时的（2026-10-16 09:29 的失败就是 DarkWake 期间解析不了域名）。
    throw new OAuthError("transient", `request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 下面统一报错。
  }
  throw new OAuthError(response.status >= 500 ? "transient" : "protocol", `${what}: the response is not a JSON object`, response.status);
}

export function requireHttps(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError("protocol", `${what} is not a valid URL`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new OAuthError("protocol", `${what} must use HTTPS`);
  }
  if (parsed.username || parsed.password) throw new OAuthError("protocol", `${what} must not carry credentials`);
  return parsed;
}

// WWW-Authenticate: Bearer resource_metadata="...", scope="...", error="..."
export function parseBearerChallenge(header: string | null): { resourceMetadata: string | null; scope: string | null; error: string | null } {
  const out = { resourceMetadata: null as string | null, scope: null as string | null, error: null as string | null };
  if (!header || !/^\s*bearer\b/i.test(header)) return out;
  const params = header.replace(/^\s*bearer\s*/i, "");
  for (const match of params.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    const name = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
    if (name === "resource_metadata") out.resourceMetadata = value;
    else if (name === "scope") out.scope = value;
    else if (name === "error") out.error = value;
  }
  return out;
}

function wellKnownCandidates(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  const origin = base.origin;
  return path && path !== "/"
    ? [`${origin}/.well-known/${suffix}${path}`, `${origin}/.well-known/${suffix}`]
    : [`${origin}/.well-known/${suffix}`];
}

// 不带令牌请求一次 MCP 服务器（initialize），看它要不要授权、去哪里授权。
async function probe(fetchImpl: FetchLike, serverUrl: string): Promise<{ status: number; challenge: ReturnType<typeof parseBearerChallenge> }> {
  const response = await request(fetchImpl, serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pi-lead-child", version: "1" } },
    }),
  });
  await response.body?.cancel().catch(() => {});
  return { status: response.status, challenge: parseBearerChallenge(response.headers.get("www-authenticate")) };
}

async function fetchResourceMetadata(fetchImpl: FetchLike, serverUrl: string, hinted: string | null): Promise<ProtectedResourceMetadata> {
  const candidates = hinted ? [hinted] : wellKnownCandidates(new URL(serverUrl), "oauth-protected-resource");
  for (const url of candidates) {
    requireHttps(url, "the resource metadata URL");
    const response = await request(fetchImpl, url, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) throw new OAuthError(response.status >= 500 ? "transient" : "protocol", `resource metadata returned HTTP ${response.status}`, response.status);
    const body = await readJson(response, "resource metadata");
    const servers = body.authorization_servers;
    if (!Array.isArray(servers) || !servers.length || !servers.every((entry) => typeof entry === "string")) {
      throw new OAuthError("protocol", "resource metadata lists no authorization server");
    }
    if (typeof body.resource !== "string") throw new OAuthError("protocol", "resource metadata has no resource");
    // RFC 9728 §3.3：resource 必须是我们请求的那个地址，防止别的资源冒充。只比较到路径，忽略末尾的斜杠。
    if (normalizeResource(body.resource) !== normalizeResource(serverUrl)) {
      throw new OAuthError("protocol", `resource metadata is for ${body.resource}, not ${serverUrl}`);
    }
    return {
      resource: body.resource,
      authorization_servers: servers as string[],
      ...(Array.isArray(body.scopes_supported) ? { scopes_supported: body.scopes_supported.filter((s): s is string => typeof s === "string") } : {}),
    };
  }
  throw new OAuthError("protocol", "the MCP server publishes no resource metadata");
}

function normalizeResource(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
}

export async function fetchAuthorizationServerMetadata(fetchImpl: FetchLike, issuer: string): Promise<AuthorizationServerMetadata> {
  const base = requireHttps(issuer, "the authorization server");
  const path = base.pathname.replace(/\/+$/, "");
  const candidates = path && path !== "/"
    ? [
      `${base.origin}/.well-known/oauth-authorization-server${path}`,
      `${base.origin}/.well-known/openid-configuration${path}`,
      `${base.origin}${path}/.well-known/openid-configuration`,
    ]
    : [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`];
  for (const url of candidates) {
    const response = await request(fetchImpl, url, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) throw new OAuthError(response.status >= 500 ? "transient" : "protocol", `authorization server metadata returned HTTP ${response.status}`, response.status);
    const body = await readJson(response, "authorization server metadata");
    if (typeof body.issuer !== "string" || body.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
      throw new OAuthError("protocol", "authorization server metadata names a different issuer");
    }
    for (const field of ["authorization_endpoint", "token_endpoint"] as const) {
      if (typeof body[field] !== "string") throw new OAuthError("protocol", `authorization server metadata has no ${field}`);
      requireHttps(body[field] as string, field);
    }
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
    const metadata: AuthorizationServerMetadata = {
      issuer: body.issuer,
      authorization_endpoint: body.authorization_endpoint as string,
      token_endpoint: body.token_endpoint as string,
      ...(typeof body.registration_endpoint === "string" ? { registration_endpoint: body.registration_endpoint } : {}),
      ...(typeof body.revocation_endpoint === "string" ? { revocation_endpoint: body.revocation_endpoint } : {}),
      ...(strings(body.scopes_supported) ? { scopes_supported: strings(body.scopes_supported)! } : {}),
      ...(strings(body.code_challenge_methods_supported) ? { code_challenge_methods_supported: strings(body.code_challenge_methods_supported)! } : {}),
      ...(strings(body.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: strings(body.token_endpoint_auth_methods_supported)! } : {}),
      ...(body.authorization_response_iss_parameter_supported === true ? { authorization_response_iss_parameter_supported: true } : {}),
    };
    if (!metadata.code_challenge_methods_supported?.includes("S256")) {
      throw new OAuthError("protocol", "the authorization server does not support PKCE with S256");
    }
    return metadata;
  }
  throw new OAuthError("protocol", "the authorization server publishes no metadata");
}

export async function discover(fetchImpl: FetchLike, serverUrl: string): Promise<Discovery> {
  requireHttps(serverUrl, "the MCP server URL");
  const { status, challenge } = await probe(fetchImpl, serverUrl);
  if (status !== 401 && status !== 403) {
    // 只有 2xx 说明不要授权。404、405 这些说明地址不对，不能当成「不要授权」。
    if (status >= 200 && status < 300) return { resource: null, server: null, challengeScope: null };
    if (status >= 500 || status === 429) throw new OAuthError("transient", `the MCP server returned HTTP ${status}`, status);
    throw new OAuthError("protocol", `the MCP server returned HTTP ${status}; check the address`, status);
  }
  const resource = await fetchResourceMetadata(fetchImpl, serverUrl, challenge.resourceMetadata);
  const server = await fetchAuthorizationServerMetadata(fetchImpl, resource.authorization_servers[0]!);
  return { resource, server, challengeScope: challenge.scope };
}

// 授权请求要的 scope：WWW-Authenticate 里的优先，其次资源元数据。授权服务器支持 offline_access 时加上，
// 这样才拿得到刷新令牌（规范说 MAY）。都没有时不带 scope。
export function requestedScope(discovery: Discovery): string | null {
  const scopes = new Set<string>((discovery.challengeScope ?? "").split(/\s+/).filter(Boolean));
  if (!scopes.size) for (const scope of discovery.resource?.scopes_supported ?? []) scopes.add(scope);
  if (discovery.server?.scopes_supported?.includes("offline_access")) scopes.add("offline_access");
  return scopes.size ? [...scopes].join(" ") : null;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
}

export async function registerClient(
  fetchImpl: FetchLike,
  server: AuthorizationServerMetadata,
  input: { redirectUri: string; clientName: string; scope: string | null },
): Promise<RegisteredClient> {
  if (!server.registration_endpoint) {
    throw new OAuthError("protocol", "the authorization server does not support dynamic client registration");
  }
  requireHttps(server.registration_endpoint, "registration_endpoint");
  const response = await request(fetchImpl, server.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      ...(input.scope ? { scope: input.scope } : {}),
    }),
  });
  const body = await readJson(response, "client registration");
  if (!response.ok || typeof body.client_id !== "string") {
    throw new OAuthError(response.status >= 500 ? "transient" : "protocol", `client registration failed: ${errorText(body) ?? `HTTP ${response.status}`}`, response.status);
  }
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeUrl(server: AuthorizationServerMetadata, input: {
  clientId: string; redirectUri: string; state: string; challenge: string; scope: string | null; resource: string;
}): string {
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

function errorText(body: Record<string, unknown>): string | null {
  const code = typeof body.error === "string" ? body.error : null;
  const description = typeof body.error_description === "string" ? body.error_description : null;
  return code ? (description ? `${code}: ${description}` : code) : description;
}

function classifyTokenError(status: number, body: Record<string, unknown>): OAuthError {
  const code = typeof body.error === "string" ? body.error : null;
  const message = errorText(body) ?? `HTTP ${status}`;
  if (code === "invalid_grant") return new OAuthError("invalid_grant", message, status, code);
  if (code === "invalid_client" || code === "unauthorized_client") return new OAuthError("invalid_client", message, status, code);
  if (status >= 500 || status === 429 || code === "temporarily_unavailable" || code === "server_error") {
    return new OAuthError("transient", message, status, code);
  }
  return new OAuthError("protocol", message, status, code);
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
}

// 有 client secret 时按元数据选认证方式：支持 client_secret_post 就放在表单里（Slack 只支持这一种），
// 否则用 HTTP Basic。没有 secret 时是公共客户端，只放 client_id。
function clientAuth(server: Pick<AuthorizationServerMetadata, "token_endpoint_auth_methods_supported">, client: ClientCredentials, form: URLSearchParams): Record<string, string> {
  form.set("client_id", client.clientId);
  if (!client.clientSecret) return {};
  const methods = server.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (methods.includes("client_secret_post") || !methods.includes("client_secret_basic")) {
    form.set("client_secret", client.clientSecret);
    return {};
  }
  const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64");
  return { authorization: `Basic ${basic}` };
}

async function tokenRequest(
  fetchImpl: FetchLike,
  server: Pick<AuthorizationServerMetadata, "token_endpoint" | "token_endpoint_auth_methods_supported">,
  client: ClientCredentials,
  form: URLSearchParams,
): Promise<TokenSet> {
  requireHttps(server.token_endpoint, "token_endpoint");
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...clientAuth(server, client, form) };
  const response = await request(fetchImpl, server.token_endpoint, { method: "POST", headers, body: form.toString() });
  let body: Record<string, unknown>;
  try {
    body = await readJson(response, "token response");
  } catch (error) {
    if (error instanceof OAuthError && !response.ok) throw classifyTokenError(response.status, {});
    throw error;
  }
  if (!response.ok) throw classifyTokenError(response.status, body);
  if (typeof body.access_token !== "string" || !body.access_token) throw new OAuthError("protocol", "token response has no access_token");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in
    : typeof body.expires_in === "string" && /^\d+$/.test(body.expires_in) ? Number(body.expires_in) : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresIn,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

export function exchangeCode(
  fetchImpl: FetchLike,
  server: AuthorizationServerMetadata,
  client: ClientCredentials,
  input: { code: string; verifier: string; redirectUri: string; resource: string },
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: input.resource,
  });
  return tokenRequest(fetchImpl, server, client, form);
}

export function refreshTokens(
  fetchImpl: FetchLike,
  server: Pick<AuthorizationServerMetadata, "token_endpoint" | "token_endpoint_auth_methods_supported">,
  client: ClientCredentials,
  input: { refreshToken: string; resource: string },
): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource });
  return tokenRequest(fetchImpl, server, client, form);
}

// RFC 7009。尽力而为：断开连接时先吊销，失败也照样删本地的密文。
export async function revokeToken(
  fetchImpl: FetchLike,
  revocationEndpoint: string,
  client: ClientCredentials,
  token: string,
  hint: "access_token" | "refresh_token",
): Promise<boolean> {
  try {
    requireHttps(revocationEndpoint, "revocation_endpoint");
    const form = new URLSearchParams({ token, token_type_hint: hint });
    const headers = { "content-type": "application/x-www-form-urlencoded", ...clientAuth({}, client, form) };
    const response = await request(fetchImpl, revocationEndpoint, { method: "POST", headers, body: form.toString() });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}
