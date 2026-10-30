// 远程 MCP 的 Streamable HTTP 客户端：JSON-RPC 2.0 over POST，响应是一个 JSON 对象或者一段 SSE。
// 只实现 daemon 要的几件事：initialize、tools/list（翻页）、tools/call。服务器发来的请求（sampling、
// elicitation）不支持，读到时跳过。会话 id（Mcp-Session-Id）由服务器给，之后每个请求带上；会话过期（404）时
// 重新 initialize 一次再重试。
//
// 不用官方 SDK：它把 express、hono、cors 这些服务端依赖一起带进 daemon，而授权、续期和存库本来就要自己做。
import type { FetchLike } from "./oauth.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]);

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
  structuredContent?: unknown;
}

// 服务器拒绝了令牌（401），或者令牌的权限不够（403 insufficient_scope）。hub 收到后续期一次再重试。
export class McpAuthError extends Error {
  constructor(readonly status: 401 | 403, readonly challenge: string | null) {
    super(status === 401 ? "the MCP server rejected the access token" : "the access token does not have the required scope");
  }
}

// 网络、超时、5xx：暂时的。
export class McpTransportError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

// 服务器回了 JSON-RPC 的 error。
export class McpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export interface McpClientOptions {
  url: string;
  fetch?: FetchLike;
  // 每次请求前取访问令牌。null 表示不带令牌。
  token: () => Promise<string | null>;
  clientName?: string;
  requestTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class McpHttpClient {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #token: () => Promise<string | null>;
  readonly #clientName: string;
  readonly #requestTimeoutMs: number;
  readonly #toolCallTimeoutMs: number;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #initializing: Promise<void> | null = null;
  #nextId = 1;
  serverInfo: { name?: string; version?: string } | null = null;

  constructor(options: McpClientOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#token = options.token;
    this.#clientName = options.clientName ?? "pi-lead-child";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.#toolCallTimeoutMs = options.toolCallTimeoutMs ?? 120_000;
  }

  async initialize(): Promise<void> {
    if (this.#protocolVersion) return;
    this.#initializing ??= this.#doInitialize().finally(() => { this.#initializing = null; });
    return this.#initializing;
  }

  async #doInitialize(): Promise<void> {
    this.#sessionId = null;
    const result = await this.#rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.#clientName, version: "1" },
    }, this.#requestTimeoutMs, false) as { protocolVersion?: unknown; serverInfo?: { name?: string; version?: string } };
    const version = typeof result?.protocolVersion === "string" ? result.protocolVersion : null;
    if (!version || !SUPPORTED_VERSIONS.has(version)) {
      throw new McpRpcError(-32602, `the MCP server speaks protocol version ${String(version)}, which this client does not support`);
    }
    this.#protocolVersion = version;
    this.serverInfo = result.serverInfo ?? null;
    await this.#notify("notifications/initialized");
  }

  async listTools(maxPages = 20): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.#call("tools/list", cursor ? { cursor } : {}, this.#requestTimeoutMs) as { tools?: unknown; nextCursor?: unknown };
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        if (tool && typeof tool === "object" && typeof (tool as McpTool).name === "string") tools.push(tool as McpTool);
      }
      if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.initialize();
    const result = await this.#call("tools/call", { name, arguments: args }, this.#toolCallTimeoutMs, signal) as {
      content?: unknown; isError?: unknown; structuredContent?: unknown;
    };
    return {
      content: Array.isArray(result?.content) ? result.content as McpContent[] : [],
      isError: result?.isError === true,
      ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  // 结束会话。尽力而为。
  async close(): Promise<void> {
    if (!this.#sessionId) return;
    try {
      const headers = await this.#headers();
      await this.#fetch(this.#url, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) });
    } catch {
      // 服务器会自己让会话过期。
    }
    this.#sessionId = null;
    this.#protocolVersion = null;
  }

  // 会话过期（404）时重新 initialize 一次再试。
  async #call(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#rpc(method, params, timeoutMs, true, signal);
    } catch (error) {
      if (error instanceof McpTransportError && error.status === 404 && this.#sessionId) {
        this.#protocolVersion = null;
        await this.initialize();
        return this.#rpc(method, params, timeoutMs, true, signal);
      }
      throw error;
    }
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#token();
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
      ...(this.#protocolVersion ? { "mcp-protocol-version": this.#protocolVersion } : {}),
    };
  }

  async #post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const headers = await this.#headers();
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.#fetch(this.#url, {
        method: "POST", headers, body: JSON.stringify(body), redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new McpTransportError(`request to ${new URL(this.#url).host} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #notify(method: string): Promise<void> {
    const response = await this.#post({ jsonrpc: "2.0", method }, this.#requestTimeoutMs);
    await response.body?.cancel().catch(() => {});
  }

  async #rpc(method: string, params: unknown, timeoutMs: number, initialized: boolean, signal?: AbortSignal): Promise<unknown> {
    if (initialized && !this.#protocolVersion) await this.initialize();
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers.get("www-authenticate");
      await response.body?.cancel().catch(() => {});
      throw new McpAuthError(response.status, challenge);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new McpTransportError(`the MCP server returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`, response.status);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId && method === "initialize") this.#sessionId = sessionId;
    const type = response.headers.get("content-type") ?? "";
    const message = type.includes("text/event-stream")
      ? await readSseResponse(response, id)
      : await response.json().catch(() => null) as RpcResponse | RpcResponse[] | null;
    const reply = Array.isArray(message) ? message.find((entry) => entry.id === id) : message;
    if (!reply || reply.id !== id) throw new McpTransportError(`the MCP server sent no reply to ${method}`);
    if (reply.error) throw new McpRpcError(reply.error.code, reply.error.message, reply.error.data);
    return reply.result;
  }
}

// 读一段 SSE，直到读到回复这个 id 的那条消息。通知和服务器发来的请求跳过。
async function readSseResponse(response: Response, id: number): Promise<RpcResponse | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const take = (): RpcResponse | null => {
    if (!data.length) return null;
    const payload = data.join("\n");
    data = [];
    try {
      const parsed = JSON.parse(payload) as RpcResponse | RpcResponse[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.find((entry) => entry.id === id && entry.method === undefined) ?? null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
        if (line === "") {
          const reply = take();
          if (reply) return reply;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // event:、id:、retry: 和注释行不影响结果。
      }
      if (done) return take();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// 工具结果的文本部分，给 Lead 和 child 看。非文本内容只写一行说明。
export function contentText(result: McpCallResult, maxChars = 60_000): { text: string; truncated: boolean } {
  const parts = result.content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "resource" && part.resource && typeof (part.resource as { text?: unknown }).text === "string") {
      return (part.resource as { text: string }).text;
    }
    return `[${part.type} content omitted]`;
  });
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n\n");
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}
