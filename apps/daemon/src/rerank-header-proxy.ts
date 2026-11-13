// Local header proxy for the Hindsight decision-model reranker.
//
// hindsight-api 1.0.0's TypeSafe reranker can only send the key as `Authorization: Bearer <key>`. Some decision-model
// gateways want the key in another header (the model's `authHeader`, for example `x-gateway-key`). hindsight-main starts
// this proxy on 127.0.0.1 when the reranker has a custom header, and points Hindsight at it:
//
//   hindsight-api --POST /v1/systemone, Bearer <local token>--> proxy --POST <baseUrl>/v1/systemone, <authHeader>: <key>--> gateway
//
// Boundaries:
// - It listens only on 127.0.0.1, on a port the OS picks. Each start makes a new random token; a request without
//   `Authorization: Bearer <token>` gets 401, so another local process cannot use the proxy to reach the gateway with the key.
// - It forwards only `POST /v1/systemone`, and only to the one target the key is bound to. The target URL is built from the
//   fixed base URL, never from the request, and a redirect from the gateway is refused: the key never goes to another host.
// - The key goes in the custom header only. The local token and any Authorization header from the client are dropped.
// - Errors and log lines never contain the key or the token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeFastModelAuthHeader, normalizeServiceUrl, redactSecretText, serviceUrlProblem } from "@pi-lead-child/protocol";

export const RERANK_PROXY_PATH = "/v1/systemone";
// A TypeSafe request carries the query and at most 300 candidates; this is well above that.
export const RERANK_PROXY_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface RerankHeaderProxyOptions {
  // The reranker base URL from service.json. The key is bound to its host.
  target: string;
  // The header that carries the key at the target.
  authHeader: string;
  apiKey: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  maxBodyBytes?: number;
}

export interface RerankHeaderProxy {
  // http://127.0.0.1:<port>. Hindsight uses it as the TypeSafe base URL.
  url: string;
  // The Bearer token Hindsight sends to the proxy.
  token: string;
  close(): Promise<void>;
}

// Request headers that are not forwarded: hop-by-hop headers, headers that fetch sets itself, and anything that carries
// credentials from the client side.
const DROPPED_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "expect",
  "content-length", "authorization", "proxy-authorization", "cookie",
]);
// Response headers passed back to Hindsight. It reads the status and the JSON body.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"];

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

export async function startRerankHeaderProxy(options: RerankHeaderProxyOptions): Promise<RerankHeaderProxy> {
  const header = normalizeFastModelAuthHeader(options.authHeader);
  if (!header) throw new Error("the reranker header proxy needs a custom header name that is not Authorization");
  const problem = serviceUrlProblem(options.target);
  const base = problem ? null : normalizeServiceUrl(options.target);
  if (!base) throw new Error(`the reranker target URL is not valid (${problem ?? "invalid_url"})`);
  if (!options.apiKey) throw new Error("the reranker header proxy needs a key");
  const targetUrl = new URL(`${base.replace(/\/+$/, "")}${RERANK_PROXY_PATH}`);
  const targetHost = targetUrl.host;
  const token = randomBytes(32).toString("base64url");
  const expectedAuthorization = `Bearer ${token}`;
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const limit = options.maxBodyBytes ?? RERANK_PROXY_MAX_BODY_BYTES;
  const secrets = [options.apiKey, token];
  const clean = (text: string) => {
    let masked = text;
    for (const secret of secrets) masked = masked.split(secret).join("[REDACTED]");
    return redactSecretText(masked);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== RERANK_PROXY_PATH) return reply(res, 404, "not found");
    if (req.method !== "POST") return reply(res, 405, "method not allowed");
    if (!sameSecret(req.headers.authorization ?? "", expectedAuthorization)) return reply(res, 401, "unauthorized");
    let body: Buffer;
    try {
      body = await readBody(req, limit);
    } catch (error) {
      return reply(res, error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "request body too large" : "bad request");
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower) || lower === header.toLowerCase() || value === undefined) continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers[header] = options.apiKey;
    // Hindsight gives up after its own timeout and closes the connection: stop the upstream call then.
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.on("close", onClose);
    let upstream: Response;
    try {
      upstream = await doFetch(targetUrl, { method: "POST", headers, body: new Uint8Array(body), redirect: "manual", signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = clean(error instanceof Error ? error.message : String(error));
      log(`[rerank-proxy] request to ${targetHost} failed: ${message}`);
      return reply(res, 502, `upstream request to ${targetHost} failed: ${message}`);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      // A redirect would take the key to a place the user did not name.
      await upstream.body?.cancel().catch(() => {});
      log(`[rerank-proxy] ${targetHost} answered with a redirect (${upstream.status}); not followed`);
      return reply(res, 502, `upstream ${targetHost} answered with a redirect; not followed`);
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = clean(error instanceof Error ? error.message : String(error));
      log(`[rerank-proxy] reading the answer from ${targetHost} failed: ${message}`);
      return reply(res, 502, `reading the answer from ${targetHost} failed: ${message}`);
    }
    if (upstream.status >= 400) log(`[rerank-proxy] ${targetHost} answered ${upstream.status}`);
    const responseHeaders: Record<string, string> = { "content-length": String(payload.length) };
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(payload);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = clean(error instanceof Error ? error.message : String(error));
      log(`[rerank-proxy] ${message}`);
      reply(res, 500, "internal error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
