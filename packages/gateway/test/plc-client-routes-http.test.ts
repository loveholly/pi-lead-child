// plc 不再直接打开账本，它需要的动作都要在网关上有路由：管理路由（admin scope，缺省不授予）、
// runtime 重检、按视图列工单，以及只收新事件的事件流。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer, type PairedBridge } from "../src/paired-server.js";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  createCliBinding, createItem, createPairing, getAishAuthFailure, loadAishConn, markAishAuthFailed,
  publishGatewayEvent, redeemPairing, saveAishConn,
  type LeadGrant, type LeadGrantChannel,
} from "@pi-lead-child/store";

let db: Db;
let server: Awaited<ReturnType<typeof startPairedServer>> & { base: string };

beforeEach(() => {
  db = openDb(join(tempDir("plc-client-routes-"), "plc.db"));
});

afterEach(async () => {
  await server?.close();
  db.close();
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start(extra: Partial<PairedBridge> = {}) {
  const started = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
    ...extra,
  }, { port: 0 });
  server = { ...started, base: `http://127.0.0.1:${started.port}` };
  return server;
}

function defaultToken(): string {
  const { code } = createPairing(db, { name: "phone", kind: "companion" });
  return redeemPairing(db, code).accessToken;
}

// plc.sock 上换来的临时 admin token：只在网关的内存里，只开管理路由。
function adminToken(ttlMs?: number): string {
  return server.issueAdminToken(ttlMs).accessToken;
}

// plc 存在数据目录里的凭证：kind=cli，缺省 scope，不带 admin。
function cliToken(): string {
  return createCliBinding(db, { name: "plc" }).accessToken;
}

function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${server.base}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("the temporary admin token", () => {
  it("opens the admin routes, and nothing else", async () => {
    await start();
    const token = adminToken();
    expect((await call("/v1/admin/bindings", token)).status).toBe(200);
    expect((await call("/v1/overview", token)).status).toBe(403);
    expect((await call("/v1/chat/send", token, { method: "POST", body: { id: "c", message: "hi" } })).status).toBe(403);
    expect((await call("/v1/paired/ws-ticket", token, { method: "POST" })).status).toBe(403);
    expect((await call("/v1/paired/me", token)).status).toBe(403);
  });

  it("expires", async () => {
    await start();
    const token = adminToken(30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await call("/v1/admin/bindings", token)).status).toBe(401);
  });

  it("is not stored in the ledger", async () => {
    await start();
    const before = db.prepare("SELECT COUNT(*) AS n FROM bindings").get();
    const token = adminToken();
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual(before);
    expect(JSON.stringify(db.prepare("SELECT * FROM bindings").all())).not.toContain(token);
  });

  it("is not granted to the stored plc credential", async () => {
    await start();
    expect((await call("/v1/admin/bindings", cliToken())).status).toBe(403);
  });
});

describe("GET /v1/paired/me", () => {
  it("tells a credential which binding it is", async () => {
    await start();
    const { binding, accessToken } = createCliBinding(db, { name: "plc" });
    const response = await call("/v1/paired/me", accessToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      // 没有 approvals:respond：plc 的凭证做不了用户的决定（.scratch/child-self-approve/options.md）。
      binding: { id: binding.id, kind: "cli", name: "plc", scopes: ["chat", "tickets:view", "tickets:create", "notices"] },
    });
    expect((await call("/v1/paired/me", "not-a-token")).status).toBe(401);
  });
});

describe("admin routes", () => {
  it("refuse every binding that was paired with the default scopes", async () => {
    await start();
    const token = defaultToken();
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/v1/admin/pairings", { name: "x", kind: "companion" }],
      ["GET", "/v1/admin/bindings"],
      ["POST", "/v1/admin/bindings/1/revoke", {}],
      ["GET", "/v1/admin/aish"],
      ["POST", "/v1/admin/aish/forget", {}],
    ];
    for (const [method, path, body] of routes) {
      const response = await call(path, token, { method, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "forbidden", message: "missing scope: admin" } });
    }
  });

  it("create a pairing code that redeems to the default scopes only", async () => {
    await start();
    const response = await call("/v1/admin/pairings", adminToken(), {
      method: "POST", body: { name: "phone", kind: "companion" },
    });
    expect(response.status).toBe(201);
    const pairing = await response.json() as { pairingId: number; code: string; expiresAt: string; uri: string | null };
    expect(pairing.code).toMatch(/^PLC-[A-Z0-9]{4}$/);
    expect(pairing.uri).toBeNull();
    const redeemed = await fetch(`${server.base}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: pairing.code }),
    });
    const { binding } = await redeemed.json() as { binding: { kind: string; scopes: string[] } };
    expect(binding).toMatchObject({ kind: "companion" });
    expect(binding.scopes).not.toContain("admin");
  });

  it("create a socket pairing invitation when an endpoint is given", async () => {
    await start();
    const response = await call("/v1/admin/pairings", adminToken(), {
      method: "POST", body: { name: "phone", kind: "companion", endpoint: "ws://192.168.1.10:47130" },
    });
    expect(response.status).toBe(201);
    const pairing = await response.json() as { uri: string | null };
    expect(pairing.uri).toMatch(/^plc-pair:\/\//);
  });

  it("refuse a pairing that asks for scopes", async () => {
    await start();
    const response = await call("/v1/admin/pairings", adminToken(), {
      method: "POST", body: { name: "phone", kind: "cli", scopes: ["admin"] },
    });
    expect(response.status).toBe(400);
  });

  it("list bindings without any token or secret, and revoke one", async () => {
    await start();
    const token = adminToken();
    const victim = defaultToken();
    saveAishConn(db, "wss://aish.example/ws/agent", "aish_secret");
    const listed = await call("/v1/admin/bindings", token);
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).not.toContain("aish_secret");
    expect(body).not.toContain("token_hash");
    const { items } = JSON.parse(body) as { items: Array<{ id: number; kind: string; status: string; scopes: string[] }> };
    const phone = items.find((item) => item.kind === "companion")!;
    expect(phone).toMatchObject({ status: "active" });
    expect(Object.keys(phone).sort()).toEqual(["createdAt", "id", "kind", "lastSeenAt", "name", "scopes", "status"]);

    const revoked = await call(`/v1/admin/bindings/${phone.id}/revoke`, token, { method: "POST", body: {} });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as { binding: { status: string } }).binding.status).toBe("revoked");
    expect((await call("/v1/overview", victim)).status).toBe(401);
    expect((await call("/v1/admin/bindings/999/revoke", token, { method: "POST", body: {} })).status).toBe(404);
    // 路由转调操作层（device 的 revoke，user_direct）：账本记你本人、发出请求的凭证。Lead 调同一个操作总是被拒。
    const rows = db.prepare("SELECT source, entity_key, payload FROM events WHERE kind='ui_action.performed'").all() as Array<{
      source: string; entity_key: string; payload: string;
    }>;
    expect(rows.map((row) => ({ source: row.source, key: row.entity_key, ...JSON.parse(row.payload) }))).toMatchObject([{
      source: "user", key: `device:${phone.id}`, action: "revoke", actor: "user", authority: "user",
      detail: { bindingId: phone.id, wasStatus: "active" },
    }]);
  });

  it("report the aish credential and the daemon's PLC_AISH_TOKEN without the token", async () => {
    let envToken: string | undefined;
    await start({ aishEnvToken: () => envToken });
    const token = adminToken();
    const empty = await call("/v1/admin/aish", token);
    expect(await empty.json()).toEqual({ stored: false, url: null, failure: null, envToken: "unset" });

    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked_secret");
    markAishAuthFailed(db, "bf_revoked_secret", "AUTH_FAILED: Invalid token");
    const cases: Array<[string | undefined, string]> = [
      ["bf_revoked_secret", "marked_failed"],
      ["bf_new_secret", "different_from_stored"],
      [undefined, "unset"],
    ];
    for (const [value, expected] of cases) {
      envToken = value;
      const response = await call("/v1/admin/aish", token);
      const text = await response.text();
      expect(text).not.toContain("secret");
      expect(JSON.parse(text)).toMatchObject({
        stored: true, url: "wss://aish.example/ws/agent", envToken: expected,
        failure: { reason: "AUTH_FAILED: Invalid token" },
      });
    }
  });

  it("forget the stored aish credential and its failure mark", async () => {
    await start({ aishEnvToken: () => "still_in_env" });
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked_secret");
    markAishAuthFailed(db, "bf_revoked_secret", "AUTH_FAILED: Invalid token");
    const token = adminToken();
    const first = await call("/v1/admin/aish/forget", token, { method: "POST", body: {} });
    expect(await first.json()).toEqual({ removed: true, envTokenSet: true });
    expect(loadAishConn(db)).toBeNull();
    expect(getAishAuthFailure(db, "bf_revoked_secret")).toBeNull();
    const second = await call("/v1/admin/aish/forget", token, { method: "POST", body: {} });
    expect(await second.json()).toEqual({ removed: false, envTokenSet: true });
  });
});

describe("POST /v1/runtimes/recheck", () => {
  it("rechecks the named runtime through the daemon", async () => {
    const calls: unknown[] = [];
    await start({
      recheckRuntimes: async (runtimeId) => {
        calls.push(runtimeId);
        return [{ incidentId: 4, runtime: "codex", outcome: "canary_armed", summary: "Codex 认证失败（故障 #4）：重检通过" }];
      },
    });
    const token = adminToken();
    const named = await call("/v1/runtimes/recheck", token, { method: "POST", body: { runtime: "codex" } });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({
      results: [{ incidentId: 4, runtime: "codex", outcome: "canary_armed", summary: "Codex 认证失败（故障 #4）：重检通过" }],
    });
    await call("/v1/runtimes/recheck", token, { method: "POST", body: {} });
    expect(calls).toEqual(["codex", undefined]);
  });

  it("refuses an unknown runtime, and every binding without the admin scope", async () => {
    await start({ recheckRuntimes: async () => [] });
    const unknown = await call("/v1/runtimes/recheck", adminToken(), { method: "POST", body: { runtime: "gemini" } });
    expect(unknown.status).toBe(400);
    expect((await call("/v1/runtimes/recheck", defaultToken(), { method: "POST", body: {} })).status).toBe(403);
    expect((await call("/v1/runtimes/recheck", cliToken(), { method: "POST", body: {} })).status).toBe(403);
  });
});

describe("GET /v1/tickets?view=…", () => {
  it("serves the store's list views", async () => {
    await start();
    const token = defaultToken();
    const ready = createItem(db, { title: "ready task", brief: "b", createdBy: "user" });
    const draft = createItem(db, { title: "draft task", brief: "b", createdBy: "lead", hold: true });
    const reminder = createItem(db, {
      title: "reminder", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const ids = async (view: string) => {
      const response = await call(`/v1/tickets?view=${view}`, token);
      expect(response.status).toBe(200);
      return (await response.json() as { items: Array<{ id: number }> }).items.map((item) => item.id);
    };
    expect(await ids("tasks")).toEqual([ready]);
    expect(await ids("drafts")).toEqual([draft]);
    expect(await ids("reminders")).toEqual([reminder]);
    expect((await ids("all")).sort()).toEqual([ready, draft, reminder].sort());
    expect((await call("/v1/tickets?view=everything", token)).status).toBe(400);
  });
});

describe("lead trust and delegation record the channel of the binding", () => {
  it("records cli for a kind=cli binding and control-plane for a paired companion", async () => {
    const channels: LeadGrantChannel[] = [];
    let id = 0;
    await start({
      leadTrust: {
        grant: (capability, via) => {
          channels.push(via);
          return {
            id: ++id, capability, granted_at: "2026-10-13 04:00:00", granted_via: via,
            revoked_at: null, revoked_via: null, note: null,
          } satisfies LeadGrant;
        },
        revoke: () => 0,
        status: () => null,
      },
    });
    await call("/v1/lead/trust", cliToken(), { method: "POST", body: { granted: true } });
    await call("/v1/lead/trust", defaultToken(), { method: "POST", body: { granted: true } });
    expect(channels).toEqual(["cli", "control-plane"]);
  });
});

describe("the event stream", () => {
  it("starts from now when the client asks for after_seq=-1", async () => {
    await start();
    publishGatewayEvent(db, { type: "ticket.created", requiredScope: "tickets:view", itemId: 1, payload: { ticketId: 1 } });
    const token = defaultToken();
    const ticket = await (await call("/v1/paired/ws-ticket", token, { method: "POST" })).json() as { ws_ticket: string };
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/events?ticket=${ticket.ws_ticket}&protocol=2&after_seq=-1`);
    const received: Array<{ type: string; seq?: number }> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; seq?: number };
        received.push(message);
        if (message.type === "hello.v2") {
          server.publish({ type: "ticket.created", requiredScope: "tickets:view", itemId: 2, payload: { ticketId: 2 } });
        }
        if (message.type === "ticket.created") resolve();
      });
      ws.on("error", reject);
    });
    ws.close();
    expect(received.map((message) => message.type)).toEqual(["hello.v2", "ticket.created"]);
    expect(received[1]!.seq).toBe(2);
  });
});
