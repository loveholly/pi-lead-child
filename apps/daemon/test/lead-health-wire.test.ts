// 旧客户端不能因为 Lead 健康状态而坏掉（发布评审 2340cac 的发现 B）。
// 旧的 companion 和 plc 用严格的 schema（additionalProperties: false）校验 GET /v1/overview 和事件流：
// 2340cac 在 overview 里总是带 lead，在 daemon.status.changed 里也带 lead，旧的原生 companion 因此读不出快照，
// 旧的网页每次心跳巡检都报协议错误。现在 lead 只给要它的客户端：overview 带 ?include=lead，
// 事件流连接带 include=lead_health 才收到带 lead 的 daemon.status.changed。
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { GatewayEventTypeSchema } from "@pi-lead-child/protocol";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-health-wire-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const Strict = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties, { additionalProperties: false });
// 2340cac 之前的 OverviewSchema（packages/protocol）。
const OLD_OVERVIEW = Strict({
  model: Type.String(),
  sessionId: Type.String(),
  busy: Type.Boolean(),
  runningTicketIds: Type.Array(Type.Integer({ minimum: 1 })),
  counts: Strict({
    activeTickets: Type.Integer({ minimum: 0 }),
    reviewTickets: Type.Integer({ minimum: 0 }),
    blockedTickets: Type.Integer({ minimum: 0 }),
    pendingApprovals: Type.Integer({ minimum: 0 }),
    unreadNotices: Type.Integer({ minimum: 0 }),
  }),
  aish: Type.Union([Strict({ connected: Type.Boolean(), bot: Type.Union([Type.String(), Type.Null()]) }), Type.Null()]),
});
// 2340cac 之前 companion 校验 daemon.status.changed 用的 schema（protocolAdapter.ts）。
const OLD_DAEMON_STATUS = Strict({
  busy: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  runningTicketIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
});
// 旧客户端认得的事件类型（这张表没有变，kernel-protocol-contract 测试逐字节固定它）。
const OLD_EVENT_TYPES = new Set(
  (GatewayEventTypeSchema as unknown as { anyOf: Array<{ const: string }> }).anyOf.map((literal) => literal.const),
);

function failingLead() {
  const listeners: Array<(event: any) => void> = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) {
          listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503: auth_unavailable", content: [] } });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory };
}

async function connect(token: string, query: string) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${token}&protocol=2&after_seq=0${query}`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  return events;
}

describe("Lead health on the wire", () => {
  it("is sent only to clients that ask for it; the defaults still pass the old schemas", async () => {
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: failingLead().factory as never, log: () => {} });
    const token = redeemPairing(db, createPairing(db, {
      name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"],
    }).code).accessToken;
    const get = (path: string) => fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const oldClient = await connect(token, "");
    const newClient = await connect(token, "&include=lead_health");

    // 一条 blocker 叫醒 Lead，模型返回 503：Lead 健康变成降级。
    const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} 出现未捕获异常` });
    await vi.waitFor(() => expect(newClient.some((event) => event.type === "daemon.status.changed"
      && event.payload.lead?.state === "degraded")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const gatewayEvents = oldClient.filter((event) => event.type !== "hello.v2" && event.type !== "command.result");
    expect(gatewayEvents.length).toBeGreaterThan(0);
    for (const event of gatewayEvents) {
      expect(OLD_EVENT_TYPES.has(event.type), event.type).toBe(true);
      if (event.type === "daemon.status.changed") expect(Value.Check(OLD_DAEMON_STATUS, event.payload)).toBe(true);
    }

    const overview = await (await get("/v1/overview")).json();
    expect(Value.Check(OLD_OVERVIEW, overview), JSON.stringify([...Value.Errors(OLD_OVERVIEW, overview)].slice(0, 2))).toBe(true);
    const withLead = await (await get("/v1/overview?include=lead")).json() as { lead?: { state: string } };
    expect(withLead.lead?.state).toBe("degraded");
    expect((await get("/v1/overview?include=bogus")).status).toBe(400);
  });
});
