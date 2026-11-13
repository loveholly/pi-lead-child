// The local header proxy for the Hindsight decision-model reranker (src/rerank-header-proxy.ts).
// hindsight-api only sends `Authorization: Bearer <key>`; the proxy moves the key into the model's custom header and
// sends it only to the one target the key is bound to.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hindsightEnvironment, type HindsightServiceFile } from "@pi-lead-child/supervisor";
import { RERANK_PROXY_PATH, startRerankHeaderProxy, type RerankHeaderProxy } from "../src/rerank-header-proxy.js";

const KEY = "gw-key-0123456789abcdef";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    seen.push({
      url: String(input), method: init?.method ?? "GET", headers,
      body: Buffer.from(init?.body as Uint8Array).toString("utf8"), redirect: init?.redirect,
    });
    return answer();
  }) as typeof fetch;
  return { seen, impl };
}

let proxies: RerankHeaderProxy[] = [];
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(proxies.map((proxy) => proxy.close()));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  proxies = [];
  servers = [];
});

async function start(options: Partial<Parameters<typeof startRerankHeaderProxy>[0]> = {}) {
  const proxy = await startRerankHeaderProxy({ target: "https://llm-gateway.example.com/gw", authHeader: "x-gateway-key", apiKey: KEY, ...options });
  proxies.push(proxy);
  return proxy;
}

// What hindsight-api's TypeSafe reranker sends: POST <base>/v1/systemone with a Bearer key and JSON.
function rerankCall(proxy: { url: string }, token: string, extra: Record<string, string> = {}, path = RERANK_PROXY_PATH, method = "POST") {
  return fetch(`${proxy.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    ...(method === "POST" ? { body: JSON.stringify({ state: "Question: q", model: "decision-1", questions: [] }) } : {}),
  });
}

describe("rerank header proxy", () => {
  it("forwards the reranker call with the key in the custom header only, and passes the answer back", async () => {
    const upstream = fakeFetch(() => new Response(JSON.stringify({ answers: [1] }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "a=b" } }));
    const proxy = await start({ fetch: upstream.impl });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.token).not.toContain(KEY);

    const response = await rerankCall(proxy, proxy.token, { "x-hindsight-bank-id": "bank-1", cookie: "c=d" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answers: [1] });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(upstream.seen).toHaveLength(1);
    const [call] = upstream.seen;
    expect(call).toMatchObject({ url: "https://llm-gateway.example.com/gw/v1/systemone", method: "POST", redirect: "manual" });
    expect(call!.headers["x-gateway-key"]).toBe(KEY);
    expect(call!.headers.authorization).toBeUndefined();
    expect(call!.headers.cookie).toBeUndefined();
    expect(call!.headers.host).toBeUndefined();
    expect(call!.headers["x-hindsight-bank-id"]).toBe("bank-1");
    expect(JSON.parse(call!.body)).toEqual({ state: "Question: q", model: "decision-1", questions: [] });
    expect(JSON.stringify(call!.headers)).not.toContain(proxy.token);
  });

  it("passes an upstream error status back so Hindsight sees the failure", async () => {
    const upstream = fakeFetch(() => new Response("{\"error\":\"denied\"}", { status: 401, headers: { "content-type": "application/json" } }));
    const logs: string[] = [];
    const proxy = await start({ fetch: upstream.impl, log: (line) => logs.push(line) });
    const response = await rerankCall(proxy, proxy.token);
    expect(response.status).toBe(401);
    expect(logs.join("\n")).toContain("llm-gateway.example.com answered 401");
  });

  it("refuses callers without the local token, other paths and other methods, and never calls the target", async () => {
    const upstream = fakeFetch(() => new Response("{}"));
    const proxy = await start({ fetch: upstream.impl });
    expect((await rerankCall(proxy, "wrong-token")).status).toBe(401);
    expect((await rerankCall(proxy, KEY)).status).toBe(401);
    expect((await fetch(`${proxy.url}${RERANK_PROXY_PATH}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await rerankCall(proxy, proxy.token, {}, "/v1/other")).status).toBe(404);
    expect((await rerankCall(proxy, proxy.token, {}, `${RERANK_PROXY_PATH}?to=elsewhere`)).status).toBe(404);
    expect((await rerankCall(proxy, proxy.token, {}, "/v1/systemone/../../x")).status).toBe(404);
    expect((await rerankCall(proxy, proxy.token, {}, RERANK_PROXY_PATH, "GET")).status).toBe(405);
    expect(upstream.seen).toEqual([]);
  });

  it("builds the target from the fixed base URL, even for a request path that names another host", async () => {
    const upstream = fakeFetch(() => new Response("{}"));
    const proxy = await start({ fetch: upstream.impl });
    const raw = await new Promise<number>((resolve, reject) => {
      // fetch normalizes the path; send the raw request line by hand.
      import("node:net").then(({ connect }) => {
        const { port } = new URL(proxy.url);
        const socket = connect(Number(port), "127.0.0.1", () => {
          socket.write(`POST //attacker.example.com${RERANK_PROXY_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${proxy.token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
        });
        let data = "";
        socket.on("data", (chunk) => { data += chunk.toString(); });
        socket.on("end", () => resolve(Number(data.split(" ")[1])));
        socket.on("error", reject);
      }, reject);
    });
    expect(raw).toBe(404);
    expect(upstream.seen).toEqual([]);
  });

  it("does not follow a redirect from the target, so the key cannot reach another host", async () => {
    const upstream = fakeFetch(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/v1/systemone" } }));
    const proxy = await start({ fetch: upstream.impl });
    const response = await rerankCall(proxy, proxy.token);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("redirect");
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.redirect).toBe("manual");
  });

  it("keeps the key and the token out of error answers and logs", async () => {
    const logs: string[] = [];
    let token = "";
    const upstream = fakeFetch(() => { throw new Error(`connect refused for ${KEY} with Bearer ${token}`); });
    const proxy = await start({ fetch: upstream.impl, log: (line) => logs.push(line) });
    token = proxy.token;
    const response = await rerankCall(proxy, proxy.token);
    expect(response.status).toBe(502);
    const text = await response.text();
    for (const output of [text, logs.join("\n")]) {
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(proxy.token);
      expect(output).toContain("llm-gateway.example.com");
    }
  });

  it("refuses an oversized body", async () => {
    const upstream = fakeFetch(() => new Response("{}"));
    const proxy = await start({ fetch: upstream.impl, maxBodyBytes: 16 });
    const response = await fetch(`${proxy.url}${RERANK_PROXY_PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${proxy.token}` }, body: "x".repeat(64),
    });
    expect(response.status).toBe(413);
    expect(upstream.seen).toEqual([]);
  });

  it("does not start for a default header, a reserved header, a bad target or an empty key", async () => {
    for (const authHeader of ["Authorization", "authorization", "", "host", "content-type", "bad header"]) {
      await expect(start({ authHeader })).rejects.toThrow(/header/);
    }
    await expect(start({ target: "ftp://llm-gateway.example.com" })).rejects.toThrow(/target URL/);
    await expect(start({ target: "https://user:pw@llm-gateway.example.com" })).rejects.toThrow(/target URL/);
    await expect(start({ apiKey: "" })).rejects.toThrow(/key/);
  });

  it("frees its port on close, and close can be called twice", async () => {
    const proxy = await start({ fetch: fakeFetch(() => new Response("{}")).impl });
    await proxy.close();
    await proxy.close();
    await expect(rerankCall(proxy, proxy.token)).rejects.toThrow();
  });
});

// The full path in hindsight-main: service.json with a custom-header reranker and the sealed key → the proxy →
// hindsightEnvironment → the request hindsight-api makes → the gateway.
describe("rerank header proxy with the Hindsight environment", () => {
  async function gateway() {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on("end", () => {
        res.writeHead(req.headers["x-gateway-key"] === KEY ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/gw` };
  }

  const service = (baseUrl: string, authHeader?: string): HindsightServiceFile => ({
    version: "1.0.0", resolvedBefore: "2026-10-16T09:00:00Z", port: 47188, database: { kind: "pg0" },
    databaseUrl: "pg0://plc-hindsight-abc:47189", embedding: { provider: "local", model: "m", revision: "r", path: "/m" },
    reranker: { provider: "typesafe", baseUrl, model: "decision-1", maxCandidates: 50, ...(authHeader ? { authHeader } : {}) },
    llm: null, secretsVersion: 1, tuning: { logLevel: null, logFormat: null }, uvx: "/uvx",
  });
  const secrets = { apiKey: "hindsight-api-key", databasePassword: "db-password-123", decisionApiKey: KEY };

  it("gives Hindsight the proxy URL and token, and the gateway gets the key in its header", async () => {
    const { seen, base } = await gateway();
    const file = service(base, "x-gateway-key");
    if (file.reranker.provider !== "typesafe") throw new Error("unreachable");
    const proxy = await start({ target: file.reranker.baseUrl, authHeader: file.reranker.authHeader!, apiKey: secrets.decisionApiKey });
    const { env, notes } = hindsightEnvironment({ service: file, secrets, env: { NO_PROXY: "corp.example.com" }, rerankProxy: proxy });
    expect(env).toMatchObject({
      HINDSIGHT_API_RERANKER_PROVIDER: "typesafe", HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL: proxy.url,
      HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY: proxy.token, NO_PROXY: "corp.example.com,127.0.0.1", no_proxy: "127.0.0.1",
    });
    // The real key never reaches the hindsight-api process.
    expect(Object.values(env).join("\n")).not.toContain(KEY);
    expect(notes.join("\n")).toContain("x-gateway-key");

    const response = await rerankCall({ url: env.HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL! }, env.HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/gw/v1/systemone" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["x-gateway-key"]).toBe(KEY);
    expect(seen[0]!.authorization).toBeUndefined();

    // After hindsight-main closes the proxy, the listener is gone.
    await proxy.close();
    await expect(rerankCall({ url: proxy.url }, proxy.token)).rejects.toThrow();
  });

  it("falls back to rrf when the proxy is not running, and keeps the direct Bearer setup without a custom header", async () => {
    const custom = hindsightEnvironment({ service: service("https://llm-gateway.example.com/gw", "x-gateway-key"), secrets, env: {} });
    expect(custom.env.HINDSIGHT_API_RERANKER_PROVIDER).toBe("rrf");
    expect(custom.env.HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY).toBeUndefined();
    expect(custom.notes.join("\n")).toContain("using rrf");

    const bearer = hindsightEnvironment({ service: service("https://llm-gateway.example.com/gw"), secrets, env: { NO_PROXY: "corp.example.com" } });
    expect(bearer.env).toMatchObject({
      HINDSIGHT_API_RERANKER_PROVIDER: "typesafe", HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL: "https://llm-gateway.example.com/gw",
      HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY: KEY,
    });
    // Without the proxy the proxy variables stay as they were.
    expect(bearer.env.NO_PROXY).toBe("corp.example.com");
    expect(bearer.env.no_proxy).toBeUndefined();
  });
});
