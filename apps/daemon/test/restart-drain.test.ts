// 部署时 daemon 停机，Lead 正在回答用户（2026-10-16 07:57 的提醒 #83）。以前 close() 直接 dispose 会话：
// pi 的 dispose 中断模型调用，同时丢掉全部监听，daemon 记下的中断说明没有机会写，这一轮落成通用的
// 「Lead 未生成回复，请重试。」。没有人告诉 Lead 它的回复被打断了；「重发」会再建一个提醒。
// 现在 daemon 停机前先排空 Lead：不再开新的回合，等这一轮最多一段时间，再正式中断（abort 之后才 dispose）。
// 下一个 daemon 接着处理：没调工具的一轮再答一次；调过工具的不再发一次用户的话，而是用一条系统事件叫醒 Lead，
// 事件里列出做完的工具和结果。
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createItem, createPairing, openDb, redeemPairing, EMPTY_ASSISTANT_REPLY_ERROR, type Db } from "@pi-lead-child/store";
import { LEAD_RESTART_INTERRUPTED_ERROR } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

// 假工具像真的 create_reminder 一样建一条提醒，返回同样格式的结果。
// 提醒时间必须在将来：以前写死成 2026-10-19T01:00Z，过了这个时间，提醒在 daemon 启动时就到点，
// 下一个 Lead 的第一轮变成提醒，不是这里要测的那一轮。
let reminderId = 0;
const REMIND_AT = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
const reminderResult = () => `created reminder #${reminderId}，将于 ${REMIND_AT} 提醒`;

beforeEach(() => {
  dir = tempDir("plc-restart-drain-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_DRAIN_MS", "150");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// stuck：这一轮连 abort 也停不下来（例如一个工具不理中断信号），dispose 也不行。
type Script = "tool-then-block" | "block" | "answer" | "stuck";

// 假的 Lead 会话，按 pi 的行为写：
//   · abort()：中断这一轮，发出 stopReason=aborted 的 message_end，等这一轮结束才返回；
//   · dispose()：先丢掉全部监听，再中断。中断的事件没人收得到（pi 的 agent-session dispose）。
function lead(scripts: Script[]) {
  let listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  let release: ((how: "abort" | "dispose") => void) | null = null;
  let running: Promise<void> | null = null;
  let stuck = false;
  const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };
  const answer = (text: string) => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
  };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      prompt(message: string) {
        prompts.push(message);
        const script = scripts.shift() ?? "answer";
        running = (async () => {
          if (script === "stuck") {
            stuck = true;
            await new Promise<void>(() => {});
          }
          if (script === "answer") {
            answer(message.includes('kind="inbox"') ? "提醒已经建好，下周一 09:00 提醒你。" : "收到。");
            return;
          }
          if (script === "tool-then-block") {
            emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "create_reminder", args: { title: "关注 aish PR86" } });
            reminderId = createItem(db, {
              kind: "reminder", title: "关注 aish PR86", brief: "", createdBy: "lead", remindAt: REMIND_AT,
            });
            emit({
              type: "tool_execution_end", toolCallId: "call-1", toolName: "create_reminder",
              result: { content: [{ type: "text", text: reminderResult() }] }, isError: false,
            });
          }
          const how = await new Promise<"abort" | "dispose">((resolve) => { release = resolve; });
          release = null;
          if (how === "abort") {
            emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
          }
        })();
        return running;
      },
      async abort() {
        release?.("abort");
        await running;
      },
      async steer() {},
      async followUp() {},
      clearQueue() { return { steering: [], followUp: [] }; },
      dispose() {
        listeners = [];
        release?.("dispose");
      },
    },
  });
  return { factory, prompts, blocked: () => release !== null || stuck };
}

async function start(stub: ReturnType<typeof lead>, log: (line: string) => void = () => {}) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: stub.factory as never, log });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id).data.turnId as string;
  };
  return { events, send };
}

async function stop(): Promise<void> {
  await daemon?.close();
  daemon = null;
}

// plc.sock 上的一条命令（supervisor 停 daemon 时就这样先发 drain）。
function localCommand<T>(command: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.sockPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((candidate) => candidate.includes('"response"'));
      if (!line) return;
      socket.end();
      resolve(JSON.parse(line).data as T);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };

const USER_TEXT = "提醒我下周一早上关注 aish，再决定它的 PR86 是否要合并";

describe("a Lead turn that a daemon shutdown interrupts", () => {
  it("records the interruption, not the generic empty reply, after a tool already ran", async () => {
    const stub = lead(["tool-then-block"]);
    const { send } = await start(stub);
    const turnId = await send(USER_TEXT);
    await vi.waitFor(() => expect(stub.blocked()).toBe(true));

    await stop();

    expect(turn(turnId).error).not.toBe(EMPTY_ASSISTANT_REPLY_ERROR);
    expect(turn(turnId)).toMatchObject({ state: "failed", error: LEAD_RESTART_INTERRUPTED_ERROR });
  });

  it("queues a turn that ran no tool, and the next daemon answers it once", async () => {
    const first = lead(["block"]);
    const { send } = await start(first);
    const turnId = await send(USER_TEXT);
    await vi.waitFor(() => expect(first.blocked()).toBe(true));

    await stop();
    expect(turn(turnId)).toMatchObject({ state: "queued", error: LEAD_RESTART_INTERRUPTED_ERROR });

    const second = lead([]);
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: second.factory as never, log: () => {} });
    await vi.waitFor(() => expect(turn(turnId)).toMatchObject({ state: "completed", error: null, assistant_text: "收到。" }));
    expect(second.prompts.filter((prompt) => prompt.includes(USER_TEXT))).toHaveLength(1);
    expect(second.prompts.find((prompt) => prompt.includes(USER_TEXT))).toContain("<user_message");
  });

  it("wakes the next Lead with the completed tools instead of sending the user's message again", async () => {
    const first = lead(["tool-then-block"]);
    const { send } = await start(first);
    const turnId = await send(USER_TEXT);
    await vi.waitFor(() => expect(first.blocked()).toBe(true));

    await stop();
    expect(turn(turnId)).toMatchObject({ state: "failed", error: LEAD_RESTART_INTERRUPTED_ERROR });

    const second = lead([]);
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: second.factory as never, log: () => {} });
    await vi.waitFor(() => expect(second.prompts.length).toBeGreaterThan(0));
    const wake = second.prompts[0]!;
    expect(wake).toContain('<system_event kind="inbox"');
    expect(wake).toContain("create_reminder");
    expect(wake).toContain(reminderResult());
    // 用户的话不再作为一条用户消息发给 Lead：工具已经做过，再发一次可能再建一个提醒。
    expect(second.prompts.some((prompt) => prompt.includes("<user_message"))).toBe(false);
    // Lead 接着回复，回答落在它自己发起的一轮里；原来那一轮保持原样。
    await vi.waitFor(() => expect(db.prepare(
      "SELECT assistant_text FROM channel_turns WHERE origin_kind LIKE 'system:%' AND assistant_text <> ''",
    ).get()).toMatchObject({ assistant_text: "提醒已经建好，下周一 09:00 提醒你。" }));
    expect(turn(turnId)).toMatchObject({ state: "failed", error: LEAD_RESTART_INTERRUPTED_ERROR });
  });

  it("queues a message that arrives while the daemon drains, and the next daemon answers it", async () => {
    vi.stubEnv("PLC_LEAD_DRAIN_MS", "400");
    const first = lead(["block"]);
    const { send } = await start(first);
    const runningTurn = await send("第一句");
    await vi.waitFor(() => expect(first.blocked()).toBe(true));

    const closing = stop();
    const lateTurn = await send("停机时发来的");
    await closing;
    expect(turn(lateTurn)).toMatchObject({ state: "queued", error: LEAD_RESTART_INTERRUPTED_ERROR });
    expect(first.prompts.some((prompt) => prompt.includes("停机时发来的"))).toBe(false);

    const second = lead([]);
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: second.factory as never, log: () => {} });
    await vi.waitFor(() => {
      expect(turn(runningTurn)).toMatchObject({ state: "completed", assistant_text: "收到。" });
      expect(turn(lateTurn)).toMatchObject({ state: "completed", assistant_text: "收到。" });
    });
    // 按发来的先后答：先答被打断的那一轮。
    expect(second.prompts.findIndex((prompt) => prompt.includes("第一句")))
      .toBeLessThan(second.prompts.findIndex((prompt) => prompt.includes("停机时发来的")));
  });

  // 审查发现（909e217）：supervisor 先发 drain，daemon 等满、中断了这一轮，可这一轮还是没收尾；supervisor 接着发 shutdown，
  // close 又排空一遍，再等一整轮。最坏 36 秒，超过 supervisor 和 launchd 的 20 秒，最后被 SIGKILL。
  it("does not wait a second time when close() follows a drain that already interrupted the turn", async () => {
    vi.stubEnv("PLC_LEAD_DRAIN_MS", "600");
    vi.stubEnv("PLC_LEAD_ABORT_GRACE_MS", "600");
    const lines: string[] = [];
    const stub = lead(["stuck"]);
    const { send } = await start(stub, (line) => lines.push(line));
    await send(USER_TEXT);
    await vi.waitFor(() => expect(stub.blocked()).toBe(true));

    await expect(localCommand({ type: "drain", id: "d1" })).resolves.toEqual({ drained: false, interrupted: true });
    const startedAt = Date.now();
    await stop();
    // 一个排空时限（等 600 毫秒，中断后再等 600 毫秒）之内关完，不是两个。
    expect(Date.now() - startedAt).toBeLessThan(1_200);
    expect(lines.filter((line) => line.startsWith("drain: waiting"))).toHaveLength(1);
  });

  // 审查发现（909e217）：旧版 v1 入口在停机时发来的消息存成排队的轮次。设备名里带 ":ticket" 时，
  // 它的来源（paired:<kind>:<设备名>）被启动查询的 NOT LIKE '%:ticket%' 排除掉，重启后一直排着，没人回答。
  it("answers a message from a v1 client that arrived while the daemon drained, whatever the device is called", async () => {
    vi.stubEnv("PLC_LEAD_DRAIN_MS", "400");
    const first = lead(["block"]);
    const { send } = await start(first);
    await send("第一句");
    await vi.waitFor(() => expect(first.blocked()).toBe(true));
    const issued = redeemPairing(db, createPairing(db, { name: "ticket-desk", kind: "companion", scopes: ["chat"] }).code);
    const v1 = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}`);
    sockets.push(v1);
    const v1Events: any[] = [];
    v1.on("message", (raw) => v1Events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(v1Events.some((event) => event.type === "hello")).toBe(true));

    const closing = stop();
    v1.send(JSON.stringify({ type: "chat", id: "v1-1", message: "旧客户端停机时发来的" }));
    await vi.waitFor(() => expect(v1Events.some((event) => event.type === "response" && event.id === "v1-1")).toBe(true));
    await closing;
    const held = () => db.prepare("SELECT id, state, error, assistant_text FROM channel_turns WHERE user_text = ?")
      .get("旧客户端停机时发来的") as { id: string; state: string; error: string | null; assistant_text: string };
    expect(held()).toMatchObject({ state: "queued", error: LEAD_RESTART_INTERRUPTED_ERROR });

    const second = lead([]);
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: second.factory as never, log: () => {} });
    await vi.waitFor(() => expect(held()).toMatchObject({ state: "completed", assistant_text: "收到。" }));
    expect(second.prompts.some((prompt) => prompt.includes("旧客户端停机时发来的"))).toBe(true);
  });
});
