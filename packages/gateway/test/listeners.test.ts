// "有人在听"决定 lead 是否播报即时通知、桌面通知是否不弹、通知是否记为 lead 已送达。
// 所以只算真的有人在看的连接：
// - 连接是活的：网关定时 ping，收不到 pong 的半开连接被断开；
// - 客户端说自己有人在看（presence.set attended=true）：companion 按页面或应用是否在前台上报，
//   plc chat 运行时上报；什么都不报的连接不算；
// - binding 现在仍然有效、带 chat scope：每次计数时重新读账本。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createPairing, openDb, redeemPairing, revokeBinding, type Db } from "@pi-lead-child/store";

let db: Db;
let server: Awaited<ReturnType<typeof startPairedServer>>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  db = openDb(join(tempDir("plc-listeners-"), "plc.db"));
  const runtime = () => ({ model: "stub/model", sessionId: "s", busy: false, runningItemIds: [], aish: null });
  server = await startPairedServer({
    db, controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
  }, { port: 0, heartbeatMs: 50 });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server.close().catch(() => {});
  db.close();
});

async function connect(options: { scopes?: string[]; autoPong?: boolean } = {}) {
  const { code } = createPairing(db, { name: "client", kind: "companion", scopes: options.scopes ?? ["chat", "tickets:view"] });
  const { accessToken, binding } = redeemPairing(db, code);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${accessToken}&protocol=2&after_seq=-1`,
    { autoPong: options.autoPong ?? true });
  sockets.push(socket);
  const messages: any[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  let counter = 0;
  const presence = async (attended: boolean) => {
    const id = `presence-${++counter}`;
    socket.send(JSON.stringify({ type: "presence.set", id, protocolVersion: 2, attended }));
    await vi.waitFor(() => expect(messages.find((message) => message.type === "command.result" && message.id === id)?.success).toBe(true));
  };
  return { socket, bindingId: binding.id, presence };
}

describe("chat listeners", () => {
  it("count a client only while it says someone is looking", async () => {
    const client = await connect();
    expect(server.chatListenerCount()).toBe(0);
    await client.presence(true);
    expect(server.chatListenerCount()).toBe(1);
    // 标签页切到后台。
    await client.presence(false);
    expect(server.chatListenerCount()).toBe(0);
  });

  it("do not count a client without the chat scope", async () => {
    const viewer = await connect({ scopes: ["tickets:view"] });
    await viewer.presence(true);
    expect(server.chatListenerCount()).toBe(0);
  });

  it("drop a half-open socket that no longer answers pings", async () => {
    const stale = await connect({ autoPong: false });
    await stale.presence(true);
    expect(server.chatListenerCount()).toBe(1);
    await vi.waitFor(() => expect(server.chatListenerCount()).toBe(0), { timeout: 2_000 });
    await vi.waitFor(() => expect(stale.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 2_000 });
  });

  it("keep a live socket that answers pings", async () => {
    const live = await connect();
    await live.presence(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.chatListenerCount()).toBe(1);
  });

  it("stop counting a revoked binding at once", async () => {
    const client = await connect();
    await client.presence(true);
    revokeBinding(db, client.bindingId);
    expect(server.chatListenerCount()).toBe(0);
  });
});

// 对外地址的监听（listenAlso）接进来的连接也是网关的连接。关掉时不能等它们自己断开：
// daemon 停机时会卡住（重启、升级、lead use 都要停机）。
describe("the extra listener", () => {
  const within = <T>(promise: Promise<T>, ms: number) => Promise.race([
    promise.then(() => "done" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);

  async function connectVia(port: number) {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes: ["chat"] });
    const { accessToken } = redeemPairing(db, code);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/paired/events?token=${accessToken}&protocol=2&after_seq=-1`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on("message", (raw) => { if (JSON.parse(String(raw)).type === "hello.v2") resolve(); });
      socket.once("error", reject);
    });
    return socket;
  }

  it("closes promptly while a client is connected through it", async () => {
    const extra = await server.listenAlso("127.0.0.1", 0);
    const client = await connectVia(extra.port);
    expect(await within(extra.close(), 1_000)).toBe("done");
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.CLOSED));
  });

  it("does not hold up closing the whole gateway", async () => {
    const extra = await server.listenAlso("127.0.0.1", 0);
    await connectVia(extra.port);
    expect(await within(server.close(), 1_000)).toBe("done");
    expect(await within(extra.close(), 1_000)).toBe("done");
  });
});
