// 事件日志的不变量走到 daemon 这一跳（Lead 事件主干 spec D5，工单 01）：用户的消息、Lead 的回合、交给 Lead 的事，
// 经过真实的 daemon（Lead 用不调模型的替身）以后，每个级别不是 record 的事件都有处置。
// engine 那一侧的流程（派发、Run 失败、提醒到点）在 packages/engine/test/event-log-invariants.test.ts。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  addInbox, createItem, createPairing, listEvents, listInbox, listUndisposedEvents, openDb, redeemPairing,
  UNDISPOSED_EVENT_DEADLINE_MS, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

const PROXY_DNS = '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}';

beforeEach(() => {
  dir = tempDir("plc-event-log-daemon-");
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

// 不调模型的 Lead：按顺序取 failures 里的错误，取完以后每一轮都回「收到。」。
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
  let commands = 0;
  const send = async (message: string) => {
    const id = `cmd-${++commands}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id).data.turnId as string;
  };
  return { send };
}

const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id=?").get(id) as { state: string }).state;
const afterDeadline = () => new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS);

describe("events through the daemon", () => {
  it("settles a user's message when Lead answers it", async () => {
    const net = network();
    const { send } = await start(lead([]), net);
    const turnId = await send("周报写好了吗？");
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"));

    expect(listEvents(db, { kind: "user.message" })).toEqual([expect.objectContaining({
      entityKey: "chat:main", level: "conversation", disposition: "handled", dispositionDetail: { outcome: "done", turnId },
    })]);
    expect(listEvents(db, { kind: "lead.turn_completed" }).map((event) => event.payload.turnId)).toContain(turnId);
    expect(listUndisposedEvents(db, { olderThan: afterDeadline() })).toEqual([]);
  });

  it("records each failed attempt of a Lead turn with its root cause, and leaves the message unanswered", async () => {
    const net = network();
    const { send } = await start(lead([PROXY_DNS, PROXY_DNS], () => net.down()), net);
    const turnId = await send("在吗");
    await vi.waitFor(() => expect(turnState(turnId)).toBe("queued"));
    net.up();
    await vi.waitFor(() => expect(turnState(turnId)).toBe("failed"));

    expect(listEvents(db, { kind: "lead.turn_failed" }).map((event) => [event.payload.willRetry, event.rootCause?.code]))
      .toEqual([[true, "lead_model_network"], [false, "lead_model_network"]]);
    expect(listEvents(db, { kind: "user.message" })[0]).toMatchObject({
      disposition: "no_action", dispositionDetail: { outcome: "unanswered" },
    });
    expect(listUndisposedEvents(db, { olderThan: afterDeadline() })).toEqual([]);
  });

  it("marks a blocker's event as seen once the Lead turn it woke up succeeds", async () => {
    const net = network();
    const stub = lead([]);
    await start(stub, net);
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    addInbox(db, {
      itemId, severity: "blocker", source: "structural", summary: "交接失败",
      payload: { blockerCode: "handoff_failed", needsUser: false },
    });
    expect(listUndisposedEvents(db, { olderThan: afterDeadline() }).map((event) => event.kind)).toEqual(["inbox.blocker"]);

    await vi.waitFor(() => expect(listInbox(db).map((row) => row.state)).toEqual(["consumed"]));
    expect(stub.prompts.some((prompt) => prompt.includes("交接失败"))).toBe(true);
    expect(listEvents(db, { kind: "inbox.blocker" })[0]).toMatchObject({ disposition: "seen", rootCause: { code: "handoff_failed" } });
    expect(listUndisposedEvents(db, { olderThan: afterDeadline() })).toEqual([]);
  });
});
