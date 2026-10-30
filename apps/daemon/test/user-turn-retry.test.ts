// 用户的一轮因为断网或临时故障失败：网络或模型恢复后自动再试一次（2026-10-16）。
// 等待期间这一轮不算失败：状态是 queued，error 写着为什么在等；notice.created 带 retry=waiting，
// 客户端显示「在等」，不显示失败卡片。再试也失败，才是普通的失败（客户端给「重发」）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { addInbox, createItem, createPairing, createTurn, openDb, redeemPairing, waitTurnForRetry, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

const PROXY_DNS = '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}';

beforeEach(() => {
  dir = tempDir("plc-user-turn-retry-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
  vi.stubEnv("PLC_USER_TURN_RETRY_MS", "80");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

function network() {
  let down: string | null = null;
  return {
    probe: async () => down,
    down: () => { down = "getaddrinfo ENOTFOUND api.anthropic.com"; },
    up: () => { down = null; },
  };
}

// failures 里排着的错误按顺序用掉；用完以后回答「收到。」。
function lead(failures: string[], onFailure: () => void = () => {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        const failure = failures.shift();
        if (failure) onFailure();
        for (const listener of listeners) {
          if (failure) {
            listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: failure, content: [] } });
          } else {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
          }
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

async function start(stub: ReturnType<typeof lead>, net: ReturnType<typeof network>) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {}, networkProbe: net.probe,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const send = async (message: string) => {
    socket.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result")).toBe(true));
    return events.find((event) => event.type === "command.result").data.turnId as string;
  };
  return { events, send };
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a user turn that failed because the network was down", () => {
  it("waits instead of failing, and is retried once the network is back", async () => {
    const net = network();
    const stub = lead([PROXY_DNS], () => net.down());
    const { events, send } = await start(stub, net);

    const turnId = await send("合盖前最后一条");
    await vi.waitFor(() => expect(turn(turnId).state).toBe("queued"));
    expect(turn(turnId).error).toContain("no such host");
    const notice = events.find((event) => event.type === "notice.created" && event.turnId === turnId);
    expect(notice.payload).toMatchObject({ severity: "error", retry: "waiting", waitingFor: "network" });
    await pause(150);
    expect(turn(turnId).state).toBe("queued");
    expect(stub.prompts.filter((prompt) => prompt.includes("合盖前最后一条"))).toHaveLength(1);

    net.up();
    await vi.waitFor(() => expect(turn(turnId)).toMatchObject({ state: "completed", error: null, assistant_text: "收到。" }));
    expect(stub.prompts.filter((prompt) => prompt.includes("合盖前最后一条"))).toHaveLength(2);
  });

  it("fails normally when the one retry also fails", async () => {
    const net = network();
    const stub = lead([PROXY_DNS, PROXY_DNS], () => net.down());
    const { events, send } = await start(stub, net);

    const turnId = await send("在吗");
    await vi.waitFor(() => expect(turn(turnId).state).toBe("queued"));
    net.up();
    await vi.waitFor(() => expect(turn(turnId).state).toBe("failed"));
    const notices = events.filter((event) => event.type === "notice.created" && event.turnId === turnId);
    expect(notices.at(-1)!.payload).not.toHaveProperty("retry");
    await pause(200);
    expect(stub.prompts.filter((prompt) => prompt.includes("在吗"))).toHaveLength(2);
  });
});

describe("a user turn that failed because the model service was briefly down", () => {
  it("is retried once after a short wait", async () => {
    const net = network();
    const stub = lead(["503 Service Unavailable"]);
    const { events, send } = await start(stub, net);

    const turnId = await send("现在能做什么？");
    await vi.waitFor(() => expect(events.some((event) => event.type === "notice.created" && event.turnId === turnId)).toBe(true));
    expect(events.find((event) => event.type === "notice.created" && event.turnId === turnId).payload)
      .toMatchObject({ retry: "waiting", waitingFor: "model" });
    await vi.waitFor(() => expect(turn(turnId)).toMatchObject({ state: "completed", assistant_text: "收到。" }));
  });

  it("is not retried when the failure needs the user (auth)", async () => {
    const net = network();
    const stub = lead(["401 Unauthorized"]);
    const { send } = await start(stub, net);

    const turnId = await send("在吗");
    await vi.waitFor(() => expect(turn(turnId).state).toBe("failed"));
    await pause(200);
    expect(turn(turnId).state).toBe("failed");
    expect(stub.prompts).toHaveLength(1);
  });
});

describe("a user turn that was waiting when the daemon restarted", () => {
  it("is retried once after the restart", async () => {
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
    const waiting = createTurn(db, { originBindingId: issued.binding.id, originKind: "paired:companion", userText: "重启前没答上的", state: "streaming" });
    waitTurnForRetry(db, waiting.id, PROXY_DNS);

    const stub = lead([]);
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {}, networkProbe: network().probe });
    await vi.waitFor(() => expect(turn(waiting.id)).toMatchObject({ state: "completed", assistant_text: "收到。" }));
    const prompt = stub.prompts.find((candidate) => candidate.includes("重启前没答上的"))!;
    expect(prompt).toContain('<user_message from="user" via="app" channel="paired:companion">');
  });
});

// 发布评审 f796c1c 的 B2：一条用户消息不能送到 Lead 两次，也不能停在没有回答的状态。
// pi 的插话（steer）排在 pi 自己的队列里，下一次 prompt 时一起交给模型。以前：
//   · 系统回合先把 daemon 标成忙、再探网络（最多 3 秒）：这时来的消息被当成插话排进 pi 的队列；探测不通，
//     这一轮停下等重试，pi 的队列却还留着它，下一次 prompt 把它和重试各送一次；
//   · 插话在那一轮失败以后才被受理：它把等重试的那一轮改成 steered、清掉错误，重试找不到它，它就一直没有回答。
// 这里的替身模拟 pi 的队列：插话进队列，下一次 prompt 时连同队列里的一起送给模型（delivered），clearQueue 清空队列。
function queueLead(options: { hold?: (message: string) => boolean; lateSteer?: boolean; heldFailure?: string; onHeldFailure?: () => void } = {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const delivered: string[] = [];
  let queue: string[] = [];
  let release: (() => void) | null = null;
  const steerGates: Array<() => void> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        delivered.push(message, ...queue);
        queue = [];
        if (options.hold?.(message)) {
          await new Promise<void>((resolve) => { release = resolve; });
          release = null;
          options.onHeldFailure?.();
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: options.heldFailure ?? PROXY_DNS, content: [] } });
          return;
        }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
      },
      async steer(message: string) {
        if (options.lateSteer) await new Promise<void>((resolve) => { steerGates.push(resolve); });
        queue.push(message);
      },
      async followUp(message: string) { queue.push(message); },
      clearQueue() { const steering = queue; queue = []; return { steering, followUp: [] }; },
      dispose() {},
    },
  });
  return {
    factory, prompts, delivered,
    held: () => release !== null,
    releaseHeld: () => release?.(),
    releaseSteer: () => steerGates.shift()?.(),
    steersWaiting: () => steerGates.length,
  };
}

function blockerTicket(summary: string) {
  const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
  addInbox(db, { itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} ${summary}` });
}

const deliveries = (stub: { delivered: string[] }, text: string) => stub.delivered.filter((entry) => entry.includes(text)).length;

describe("a message that arrives around a failing system turn", () => {
  it("is not steered into an idle Lead while the daemon probes the network", async () => {
    let releaseProbe!: () => void;
    let first = true;
    let down: string | null = null;
    const probe = async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => { releaseProbe = resolve; });
        return "getaddrinfo ENOTFOUND api.anthropic.com";
      }
      return down;
    };
    const stub = queueLead();
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {}, networkProbe: probe });
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));

    // 一条 blocker 叫醒 Lead：系统回合在探网络（探测挂着）。
    blockerTicket("执行重试已耗尽");
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
    socket.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "探测窗口里发的" }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result")).toBe(true));
    const turnId = events.find((event) => event.type === "command.result").data.turnId as string;
    releaseProbe();

    await vi.waitFor(() => expect(turn(turnId).state).toBe("completed"), { timeout: 3_000 });
    await pause(300);
    expect(deliveries(stub, "探测窗口里发的")).toBe(1);
  });

  it("reaches Lead once when it was steered into a turn that then failed because the network was down", async () => {
    const net = network();
    const stub = queueLead({ hold: (message) => message.includes("系统检测到新的异常"), onHeldFailure: () => net.down() });
    const { send } = await start(stub as never, net);
    blockerTicket("执行重试已耗尽");
    await vi.waitFor(() => expect(stub.held()).toBe(true));

    const turnId = await send("插话的一条");
    await pause(100);
    stub.releaseHeld();
    await vi.waitFor(() => expect(turn(turnId).state).toBe("queued"));
    net.up();
    await vi.waitFor(() => expect(turn(turnId).state).toBe("completed"), { timeout: 3_000 });
    await pause(300);
    expect(deliveries(stub, "插话的一条")).toBe(1);
  });

  it("gets exactly one answer when Lead accepts the steer only after the turn failed", async () => {
    const net = network();
    const stub = queueLead({
      hold: (message) => message.includes("系统检测到新的异常"), lateSteer: true, onHeldFailure: () => net.down(),
    });
    const { send } = await start(stub as never, net);
    blockerTicket("执行重试已耗尽");
    await vi.waitFor(() => expect(stub.held()).toBe(true));

    const turnId = await send("晚到的插话");
    await vi.waitFor(() => expect(stub.steersWaiting()).toBe(1));
    stub.releaseHeld();
    await vi.waitFor(() => expect(turn(turnId).state).toBe("queued"));
    // 那一轮已经失败，插话这时才被受理。
    stub.releaseSteer();
    await pause(100);
    net.up();
    await vi.waitFor(() => expect(turn(turnId)).toMatchObject({ state: "completed", assistant_text: "收到。" }), { timeout: 3_000 });
    await pause(300);
    expect(deliveries(stub, "晚到的插话")).toBe(1);
  });
});

// 发布评审 f796c1c：第一次已经说了话或者调了工具（可能建了提醒、工单），再自动重试一次就可能做第二遍。
// 这时不自动重试：普通的失败卡片，给「重发」，由用户决定。
describe("a user turn that failed after Lead had started to act", () => {
  function actingLead(act: "text" | "tool", onFailure: () => void) {
    const listeners: Array<(event: any) => void> = [];
    const prompts: string[] = [];
    const factory = async () => ({
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt(message: string) {
          prompts.push(message);
          const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
          if (act === "text") {
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好，我先建一个提醒" } });
          } else {
            emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "create_reminder", args: { title: "交周报" } });
            emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "create_reminder", result: { content: [] }, isError: false });
          }
          onFailure();
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: PROXY_DNS, content: [] } });
        },
        async steer() {}, async followUp() {}, dispose() {},
      },
    });
    return { factory, prompts };
  }

  for (const act of ["text", "tool"] as const) {
    it(`is not retried automatically when it already ${act === "text" ? "said something" : "ran a tool"}`, async () => {
      const net = network();
      const stub = actingLead(act, () => net.down());
      const { events, send } = await start(stub as never, net);
      const turnId = await send("提醒我交周报");
      await vi.waitFor(() => expect(turn(turnId).state).toBe("failed"));
      const notice = events.filter((event) => event.type === "notice.created" && event.turnId === turnId).at(-1);
      expect(notice.payload).not.toHaveProperty("retry");
      net.up();
      await pause(300);
      expect(turn(turnId).state).toBe("failed");
      expect(stub.prompts).toHaveLength(1);
    });
  }
});
