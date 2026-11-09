// 「Lead 忙时你发的消息」怎么放（用户 2026-11-09：「做到设置里面吧，由使用者决定，默认还是 follow up」，protocol 的 busy-placement.ts）。
// 走完整的落库路径：用户的消息经网关进来，daemon 交给假的 pi 会话（fake-pi-session.ts）。设置经通用的操作入口
// （POST /v1/actions/busy_placement/lead/set）改，存在 plc.db 的 kv。断言 chat.send 的结果、轮次的状态和 pi 队列里的样子。
//   · 消息没带 mode 时按设置放：缺省排队；设成插话以后插话。
//   · 消息带了 mode 时照 mode 放，不看设置。
//   · daemon 在 hello.v2 里宣布这个能力，客户端据此不再带 mode。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead } from "./fake-pi-session.js";

// 和 protocol 的 CHAT_PLACEMENT_PREFERENCE_CAPABILITY、BUSY_PLACEMENT_RESOURCE 一样：这里写原文，线上的名字一变测试就失败。
const CAPABILITY = "chat.placement-preference.v1";
const RESOURCE = "busy-placement";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-busy-placement-");
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

async function start(lead: ReturnType<typeof fakePiLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"],
  }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  let sent = 0;
  const send = async (message: string, mode?: "steer" | "followUp") => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...(mode ? { mode } : {}) }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const setPlacement = (placement: string) => http("POST", "/v1/actions/busy_placement/lead/set", { input: { placement } });
  return { events, send, http, setPlacement, hello: events.find((event) => event.type === "hello.v2") };
}

const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id=?").get(id) as { state: string }).state;

// Lead 答「问题 A」时停住，直到 hold 放行：这期间 Lead 是忙的。
function busyLead() {
  const hold = deferred();
  const lead = fakePiLead(async (call) => {
    const input = call.inputs.join("\n");
    if (input.includes("问题 A")) { await hold.promise; return { say: "A 的回答。", tools: ["query_tickets"] }; }
    return { say: "收到。" };
  });
  return { lead, hold };
}

describe("a message without a mode while Lead is busy", () => {
  it("is queued by default, and the daemon announces that it places such messages by the setting", async () => {
    const { lead, hold } = busyLead();
    const { send, http, hello } = await start(lead);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("补充 B");
    expect(b.mode).toBe("queued");
    expect(turnState(b.turnId)).toBe("queued");
    await vi.waitFor(() => expect(lead.queued().followUp).toHaveLength(1));
    expect(lead.queued().steering).toHaveLength(0);
    hold.resolve();
    await vi.waitFor(() => expect(turnState(b.turnId)).toBe("completed"));

    expect(hello.capabilities).toContain(CAPABILITY);
    expect(await http("GET", "/v1/lead/busy-placement")).toEqual({ status: 200, body: { busyPlacement: { placement: "followUp" } } });
  });

  it("steers into the running turn after the user sets the option to steer, and tells clients to reload", async () => {
    const { lead, hold } = busyLead();
    const { events, send, http, setPlacement } = await start(lead);

    const changed = await setPlacement("steer");
    expect(changed.status).toBe(200);
    expect(await http("GET", "/v1/lead/busy-placement")).toEqual({ status: 200, body: { busyPlacement: { placement: "steer" } } });
    await vi.waitFor(() => expect(events.some((event) => event.type === "snapshot.required" && event.payload?.resource === RESOURCE)).toBe(true));

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("补充 B");
    expect(b.mode).toBe("steered");
    await vi.waitFor(() => expect(lead.queued().steering).toHaveLength(1));
    expect(lead.queued().followUp).toHaveLength(0);
    hold.resolve();
    await vi.waitFor(() => expect(turnState(b.turnId)).toBe("completed"));
  });

  it("refuses a value that is not one of the two options and keeps the setting", async () => {
    const { lead } = busyLead();
    const { http, setPlacement } = await start(lead);
    expect((await setPlacement("interrupt")).status).toBe(400);
    expect((await http("GET", "/v1/lead/busy-placement")).body).toEqual({ busyPlacement: { placement: "followUp" } });
  });
});

describe("a message with a mode while Lead is busy", () => {
  it("follows the mode it carries, whatever the setting says", async () => {
    const { lead, hold } = busyLead();
    const { send, setPlacement } = await start(lead);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    // 设置是缺省的排队，消息带着 steer：插话。
    expect((await send("插话 B", "steer")).mode).toBe("steered");
    // 设置改成插话，消息带着 followUp：排队。
    expect((await setPlacement("steer")).status).toBe(200);
    expect((await send("排队 C", "followUp")).mode).toBe("queued");
    await vi.waitFor(() => expect(lead.queued().followUp).toHaveLength(1));
    hold.resolve();
  });
});
