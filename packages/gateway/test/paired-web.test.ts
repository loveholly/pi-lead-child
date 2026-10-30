// The paired gateway serves the exported companion web UI (dist/web) next to its /v1 API,
// so the user opens one stable URL instead of a dev server.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, listBindings } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { gatewayBaseUrl, resolveWebFile } from "../src/web-static.js";

let db: Db;
let root: string;
let webRoot: string;

const INDEX_HTML = "<!DOCTYPE html><html><body>companion index</body></html>";
const BUNDLE_JS = "console.log('companion bundle');";
const SECRET = "secret-outside-web-root";

beforeEach(() => {
  root = tempDir("plc-web-");
  db = openDb(join(root, "plc.db"));
  // The same shape as an Expo Router static export.
  webRoot = join(root, "web");
  mkdirSync(join(webRoot, "_expo", "static", "js", "web"), { recursive: true });
  mkdirSync(join(webRoot, "ticket"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
  writeFileSync(join(webRoot, "pair.html"), "<html>pair</html>");
  writeFileSync(join(webRoot, "ticket", "[id].html"), "<html>ticket detail</html>");
  writeFileSync(join(webRoot, "+not-found.html"), "<html>not found</html>");
  writeFileSync(join(webRoot, "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(webRoot, "_expo", "static", "js", "web", "entry-abc123.js"), BUNDLE_JS);
  writeFileSync(join(root, "secret.txt"), SECRET);
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start(opts: {
  webRoot?: string;
  allowLoopbackAutoPair?: boolean;
  loopbackAutoPairOrigins?: string[];
  host?: string;
} = {}) {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: () => runtime(),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0, ...opts });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

// fetch() normalizes "/../" before it sends the request. A raw request keeps the path as written.
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

describe("paired gateway web UI", () => {
  it("serves index.html at / and a bundle asset with its content type", async () => {
    const server = await start({ webRoot });
    try {
      const index = await fetch(`${server.base}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(index.headers.get("cache-control")).toBe("no-cache");
      expect(await index.text()).toBe(INDEX_HTML);

      const asset = await fetch(`${server.base}/_expo/static/js/web/entry-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await asset.text()).toBe(BUNDLE_JS);

      const icon = await fetch(`${server.base}/favicon.ico`);
      expect(icon.headers.get("content-type")).toBe("image/x-icon");

      const head = await fetch(`${server.base}/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(INDEX_HTML)));
    } finally {
      await server.close();
    }
  });

  it("serves the route's HTML for static and dynamic routes, and the not-found page otherwise", async () => {
    const server = await start({ webRoot });
    try {
      const pair = await fetch(`${server.base}/pair`);
      expect(pair.status).toBe(200);
      expect(await pair.text()).toBe("<html>pair</html>");

      const ticket = await fetch(`${server.base}/ticket/42`);
      expect(ticket.status).toBe(200);
      expect(await ticket.text()).toBe("<html>ticket detail</html>");

      const unknown = await fetch(`${server.base}/no/such/page`);
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await unknown.text()).toBe("<html>not found</html>");
    } finally {
      await server.close();
    }
  });

  it("never serves a file outside the web root", async () => {
    const server = await start({ webRoot });
    try {
      for (const path of [
        "/../secret.txt",
        "/..%2fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/ticket/..%2f..%2fsecret.txt",
        "/%2e%2e/secret.txt",
        "/..%5csecret.txt",
        "/index.html%00.js",
      ]) {
        const response = await rawGet(server.port, path);
        expect(response.body, path).not.toContain(SECRET);
        expect([400, 404], path).toContain(response.status);
      }
      const encoded = await rawGet(server.port, "/..%2fsecret.txt");
      expect(encoded.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("keeps every /v1 route as an authenticated API route", async () => {
    const server = await start({ webRoot });
    try {
      const health = await fetch(`${server.base}/v1/health`);
      expect(await health.json()).toEqual({ ok: true, protocolVersion: 2 });

      const tickets = await fetch(`${server.base}/v1/tickets`);
      expect(tickets.status).toBe(401);
      expect(tickets.headers.get("content-type")).toBe("application/json; charset=utf-8");

      const unknownApi = await fetch(`${server.base}/v1/no-such-route`);
      expect(unknownApi.status).toBe(404);
      expect(await unknownApi.json()).toEqual({ error: { code: "not_found", message: "not found" } });

      const postRoot = await fetch(`${server.base}/`, { method: "POST" });
      expect(postRoot.status).toBe(404);
      expect(postRoot.headers.get("content-type")).toBe("application/json; charset=utf-8");
    } finally {
      await server.close();
    }
  });

  it("says how to build the web UI when the export is missing", async () => {
    const server = await start({ webRoot: join(root, "missing-web") });
    try {
      const response = await fetch(`${server.base}/`);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("npm run build:web");
    } finally {
      await server.close();
    }
  });
});

describe("loopback auto-pair from the gateway's own web UI", () => {
  it("accepts the gateway's own loopback origins without an allowlist entry", async () => {
    const server = await start({ webRoot, allowLoopbackAutoPair: true });
    try {
      for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]) {
        const response = await fetch(`${server.base}/v1/paired/loopback`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ name: "gateway-web" }),
        });
        expect(response.status, origin).toBe(201);
        const { access_token } = await response.json() as { access_token: string };
        const overview = await fetch(`${server.base}/v1/overview`, {
          headers: { authorization: `Bearer ${access_token}` },
        });
        expect(overview.status, origin).toBe(200);
      }
      expect(listBindings(db).filter((binding) => binding.display_name === "gateway-web")).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("still refuses other origins, and refuses everything while auto-pair is disabled", async () => {
    const enabled = await start({ webRoot, allowLoopbackAutoPair: true });
    try {
      for (const origin of [
        `http://127.0.0.1:${enabled.port + 1}`,
        "http://localhost:8081",
        `https://127.0.0.1:${enabled.port}`,
        `http://evil.example:${enabled.port}`,
      ]) {
        const response = await fetch(`${enabled.base}/v1/paired/loopback`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ name: "gateway-web" }),
        });
        expect(response.status, origin).toBe(403);
      }
    } finally {
      await enabled.close();
    }

    const disabled = await start({ webRoot, allowLoopbackAutoPair: false });
    try {
      const response = await fetch(`${disabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${disabled.port}` },
        body: JSON.stringify({ name: "gateway-web" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await disabled.close();
    }
    expect(listBindings(db)).toHaveLength(0);
  });

  it("does not trust its own origin when it serves no web UI", async () => {
    const server = await start({ allowLoopbackAutoPair: true });
    try {
      const response = await fetch(`${server.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
        body: JSON.stringify({ name: "gateway-web" }),
      });
      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  const lan = lanAddress();
  it.skipIf(!lan)("refuses a non-loopback caller that sends the gateway's own origin", async () => {
    const server = await start({ webRoot, allowLoopbackAutoPair: true, host: "0.0.0.0" });
    try {
      const response = await fetch(`http://${lan}:${server.port}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
        body: JSON.stringify({ name: "gateway-web" }),
      });
      expect(response.status).toBe(403);
      // A LAN browser can still load the UI; it pairs with a code instead.
      const index = await fetch(`http://${lan}:${server.port}/`);
      expect(index.status).toBe(200);
    } finally {
      await server.close();
    }
    expect(listBindings(db)).toHaveLength(0);
  });

  it("keeps pairing-code redemption working next to the web UI", async () => {
    const server = await start({ webRoot });
    try {
      const { code } = createPairing(db, { name: "phone", kind: "companion" });
      const response = await fetch(`${server.base}/v1/paired/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairing_code: code }),
      });
      expect(response.status).toBe(201);
    } finally {
      await server.close();
    }
  });
});

describe("resolveWebFile", () => {
  it("maps request paths to files inside the web root only", () => {
    expect(resolveWebFile(webRoot, "/")).toEqual({ kind: "file", path: join(webRoot, "index.html"), status: 200 });
    expect(resolveWebFile(webRoot, "/pair")).toEqual({ kind: "file", path: join(webRoot, "pair.html"), status: 200 });
    expect(resolveWebFile(webRoot, "/ticket/7")).toEqual({
      kind: "file", path: join(webRoot, "ticket", "[id].html"), status: 200,
    });
    expect(resolveWebFile(webRoot, "/nope")).toEqual({
      kind: "file", path: join(webRoot, "+not-found.html"), status: 404,
    });
    expect(resolveWebFile(webRoot, "/..%2fsecret.txt")).toEqual({ kind: "invalid" });
    expect(resolveWebFile(webRoot, "/%E0%A4%A")).toEqual({ kind: "invalid" });
    expect(resolveWebFile(webRoot, "/.hidden")).toEqual({ kind: "invalid" });
    expect(resolveWebFile(join(root, "missing-web"), "/")).toEqual({ kind: "missing" });
  });
});

describe("gatewayBaseUrl", () => {
  it("points at the loopback gateway unless the gateway binds one specific host", () => {
    expect(gatewayBaseUrl(undefined, 47130)).toBe("http://127.0.0.1:47130");
    expect(gatewayBaseUrl("0.0.0.0", 47130)).toBe("http://127.0.0.1:47130");
    expect(gatewayBaseUrl("::", 47130)).toBe("http://127.0.0.1:47130");
    expect(gatewayBaseUrl("192.168.1.5", 47130)).toBe("http://192.168.1.5:47130");
    expect(gatewayBaseUrl("fd00::5", 47130)).toBe("http://[fd00::5]:47130");
  });
});

// 实机检查（2026-10-15，左栏改版阶段 3）：日程里「改期」在浏览器里报 Failed to fetch。客户端发 PATCH，
// 网关的 CORS 只放行 GET 和 POST，浏览器的预检就挡住了。客户端发的每一种 HTTP 方法都要能过预检。
describe("the browser preflight", () => {
  it("allows every HTTP method the companion client sends", async () => {
    const clientSource = readFileSync(new URL("../../client/src/controlPlaneClient.ts", import.meta.url), "utf8");
    const methods = [...new Set([...clientSource.matchAll(/method: '([A-Z]+)'/g)].map((match) => match[1]!))];
    expect(methods).toContain("POST");
    const server = await start();
    try {
      for (const method of methods) {
        const response = await fetch(`${server.base}/v1/milestones/1`, {
          method: "OPTIONS",
          headers: { origin: "http://127.0.0.1:8081", "access-control-request-method": method },
        });
        expect(response.headers.get("access-control-allow-methods")?.split(","), method).toContain(method);
      }
    } finally {
      await server.close();
    }
  });
});
