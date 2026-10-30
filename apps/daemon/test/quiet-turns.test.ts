// Lead 自己发起的内部回合，没有要告诉用户的事就不在会话里发消息。
// 实例上「Lead 主动 · 整理笔记」发了一句"这轮…没有新增笔记"：那是 Lead 的内部整理，用户不需要看。
// 现在：整理笔记和心跳巡检没有要说的就回 NO_REPLY，会话里不留一轮；巡检只更新顶栏的「最近巡检」时间。
// 整理笔记回合里说了别的话（例如回答了用户还没得到回答的问题），这段话进会话（2026-10-17，spec D9）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { shortenDigestWait } from "./digest-wait.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-quiet-turns-");
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

// 不调用模型的 Lead。answer 按 prompt 决定说什么；tool 为真时先调一次工具。
// contextFull 为真时，上下文水位一直在 90%，每一轮之后 daemon 都会安排一次整理笔记。
function stubLead(
  // tool：调一次工具（true 是 save_note，字符串是工具名）。error：这一轮的模型调用以这个错误结束。
  answer: (prompt: string) => { text: string; tool?: boolean | string; before?: string; error?: string },
  options: { contextFull?: boolean } = {},
) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  // 工具执行的那一刻 Lead 的工具看到的当前轮次（建工单、派发时据此记卡片）。
  const toolTurnIds: Array<string | null> = [];
  let deps: { currentTurnId?: () => string | null } = {};
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async (args: typeof deps) => {
    deps = args;
    return {
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      ...(options.contextFull ? {
        model: { contextWindow: 100 },
        agent: { state: { messages: [{ role: "assistant", usage: { input: 90, output: 0, cacheRead: 0 } }] } },
      } : {}),
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        const { text, tool, before, error } = answer(message);
        if (before) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: before } });
        if (tool) {
          const toolName = tool === true ? "save_note" : tool;
          emit({ type: "tool_execution_start", toolCallId: `call-${prompts.length}`, toolName, args: {} });
          toolTurnIds.push(deps.currentTurnId?.() ?? null);
          emit({ type: "tool_execution_end", toolCallId: `call-${prompts.length}`, toolName, args: {}, result: { content: [] }, isError: false });
        }
        if (error) {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } });
          return;
        }
        if (text) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
    };
  };
  return { factory, prompts, toolTurnIds };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {} });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"],
  }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1&include=lead_health`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, {
    headers: { authorization: `Bearer ${issued.accessToken}` },
  })).json()) as { lead?: { lastPatrolAt?: string | null } };
  const chat = (id: string, message: string) =>
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
  return { events, overview, chat };
}

function systemTurns(origin: string) {
  return db.prepare("SELECT assistant_text, state FROM channel_turns WHERE origin_kind=?").all(origin) as
    Array<{ assistant_text: string; state: string }>;
}

function attentionItem() {
  const itemId = createItem(db, { title: "milestone", brief: "b", createdBy: "system" });
  addInbox(db, { itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} 完成了一个里程碑` });
}

describe("note keeping", () => {
  it("posts nothing when Lead only saves notes and replies NO_REPLY", async () => {
    const lead = stubLead((prompt) => prompt.includes("沉淀检查")
      ? { text: "NO_REPLY", tool: true }
      : { text: "好的。" }, { contextFull: true });
    const { events, chat } = await start(lead);

    chat("cmd-1", "现在有哪些任务需要我介入");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("沉淀检查"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(systemTurns("system:precipitate")).toEqual([]);
    expect(events.filter((event) => event.payload?.originKind === "system:precipitate")).toEqual([]);
    expect(lead.prompts.find((prompt) => prompt.includes("沉淀检查"))).toContain("NO_REPLY");
  });

  // 2026-10-16：用户 19:02 的那一轮调了工具以后失败了；20:16 的整理笔记回合里 Lead 答完了这个问题，
  // 可是整理笔记从不落成一轮，用户在会话里什么也没收到。Lead 在整理笔记回合里说的话（不是 NO_REPLY）要进会话。
  it("posts the answer Lead gives in a note-keeping turn after the user's turn failed", async () => {
    const answer = "trace PR 已经合并到 main，#77 已经 done。";
    const lead = stubLead((prompt) => prompt.includes("沉淀检查")
      ? { text: answer, tool: true }
      : { text: "", tool: "get_ticket", error: "503 Service Unavailable" }, { contextFull: true });
    const { events, chat } = await start(lead);

    chat("cmd-1", "trace 的 PR 合了吗");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("沉淀检查"))).toBe(true));
    const userTurn = db.prepare("SELECT state FROM channel_turns WHERE origin_kind LIKE 'paired:%'").get() as { state: string };
    expect(userTurn.state).toBe("failed");

    await vi.waitFor(() => expect(systemTurns("system:precipitate")).toEqual([{ assistant_text: answer, state: "completed" }]));
    const { id } = db.prepare("SELECT id FROM channel_turns WHERE origin_kind='system:precipitate'").get() as { id: string };
    await vi.waitFor(() => expect(events.find((event) => event.type === "lead.message.completed" && event.turnId === id)?.payload)
      .toMatchObject({ text: answer }));
    expect(events.some((event) => event.type === "lead.turn.started" && event.turnId === id)).toBe(true);
  });

  // 用户的问题还没有回答（这一轮在等那一次自动重试）时不整理笔记：先回答用户，整理笔记排在后面。
  it("waits for a user turn that is waiting for its retry before keeping notes", async () => {
    vi.stubEnv("PLC_USER_TURN_RETRY_MS", "300");
    let failures = 1;
    const lead = stubLead((prompt) => {
      if (prompt.includes("沉淀检查")) return { text: "NO_REPLY" };
      if (failures > 0) {
        failures -= 1;
        return { text: "", error: "503 Service Unavailable" };
      }
      return { text: "两张工单都在等你验收。" };
    }, { contextFull: true });
    const { chat } = await start(lead);

    chat("cmd-1", "现在有哪些任务需要我介入");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("沉淀检查"))).toBe(true), { timeout: 3_000 });

    const kinds = lead.prompts.map((prompt) => prompt.includes("沉淀检查") ? "notes" : "user");
    expect(kinds.slice(0, 3)).toEqual(["user", "user", "notes"]);
    const userTurn = db.prepare("SELECT state, assistant_text FROM channel_turns WHERE origin_kind LIKE 'paired:%'").get();
    expect(userTurn).toEqual({ state: "completed", assistant_text: "两张工单都在等你验收。" });
  });
});

describe("a digest round", () => {
  // 摘要按常设指令 events.digest_batch 叫醒 Lead（工单 05）：测试里把等待时间改短。
  beforeEach(() => shortenDigestWait(db, 1));

  it("posts nothing when Lead has nothing for the user, and moves the patrol time", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => ({ text: "NO_REPLY", tool: true }));
    const { events, overview } = await start(lead);
    const started = Date.now();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes('kind="digest"'))).toBe(true));
    await vi.waitFor(async () => expect(Date.parse((await overview()).lead?.lastPatrolAt ?? "")).toBeGreaterThanOrEqual(started));

    expect(systemTurns("system:digest")).toEqual([]);
    expect(events.filter((event) => event.payload?.originKind === "system:digest")).toEqual([]);
    expect(events.some((event) => event.type === "daemon.status.changed" && event.payload.lead?.lastPatrolAt)).toBe(true);
    expect(lead.prompts.find((prompt) => prompt.includes('kind="digest"'))).toContain("NO_REPLY");
  });

  it("still posts what Lead has to tell the user", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => ({ text: "#66 卡在核查未派发，需要你决定派不派核查。", tool: true }));
    await start(lead);

    await vi.waitFor(() => expect(systemTurns("system:digest")).toEqual([
      { assistant_text: "#66 卡在核查未派发，需要你决定派不派核查。", state: "completed" },
    ]));
  });

  it("keeps where each tool call happened in the text when the turn is posted at the end", async () => {
    // 任务卡按 textOffset 把工具之间的话放进卡片、最后的话作为回复。攒着的工具调用落成一轮时，
    // 位置要是它当时的位置，不是落成那一刻（那时这一轮还一个字都没写）。
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => ({ before: "先看一下。", tool: true, text: "#66 需要你决定派不派核查。" }));
    await start(lead);

    await vi.waitFor(() => expect(systemTurns("system:digest")).toHaveLength(1));
    const offsets = (db.prepare(
      `SELECT e.payload FROM gateway_events e JOIN channel_turns t ON t.id = e.turn_id
       WHERE t.origin_kind = 'system:digest' AND e.event_type LIKE 'lead.tool.%'`,
    ).all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload).textOffset);
    expect(offsets).toEqual(["先看一下。".length, "先看一下。".length]);
  });

  it("never posts the literal NO_REPLY, even when Lead adds it after real news", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => ({ text: "#66 需要你决定派不派核查。\nNO_REPLY" }));
    await start(lead);

    await vi.waitFor(() => expect(systemTurns("system:digest")).toEqual([
      { assistant_text: "#66 需要你决定派不派核查。", state: "completed" },
    ]));
  });

  it("keeps a quiet digest round's turn when Lead creates or dispatches a ticket in it", async () => {
    // 巡检里建了工单或派了工：这一轮要留着它的工具调用（任务卡和记录），哪怕 Lead 最后回 NO_REPLY。
    // 工具执行时这一轮已经落成，建卡片的工具拿得到轮次 id。
    vi.stubEnv("PLC_HEARTBEAT_MS", "150");
    attentionItem();
    const lead = stubLead(() => ({ tool: "create_task", text: "NO_REPLY" }));
    await start(lead);

    await vi.waitFor(() => expect(systemTurns("system:digest")).toHaveLength(1));
    const [turn] = db.prepare("SELECT id, assistant_text FROM channel_turns WHERE origin_kind='system:digest'").all() as
      Array<{ id: string; assistant_text: string }>;
    expect(turn!.assistant_text).toBe("");
    expect(lead.toolTurnIds).toEqual([turn!.id]);
    const toolEvents = db.prepare(
      "SELECT event_type FROM gateway_events WHERE turn_id = ? AND event_type LIKE 'lead.tool.%' ORDER BY seq",
    ).all(turn!.id) as Array<{ event_type: string }>;
    expect(toolEvents.map((row) => row.event_type)).toEqual(["lead.tool.started", "lead.tool.completed"]);
  });

  it("counts a tick with nothing to digest as a patrol, without waking Lead", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "100");
    const lead = stubLead(() => ({ text: "不该被叫醒" }));
    const { overview } = await start(lead);
    const started = Date.now();

    await vi.waitFor(async () => expect(Date.parse((await overview()).lead?.lastPatrolAt ?? "")).toBeGreaterThanOrEqual(started));
    expect(lead.prompts).toEqual([]);
  });
});
