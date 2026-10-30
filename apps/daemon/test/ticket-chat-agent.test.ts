// 工单对话里的消息一律交给这张工单的 agent（用户 2026-10-19 的决定，spec D13 改写，工单 08）。
//
// 以前 protocol 的 ticketChatRoute 用正则和关键词表猜消息的意图：进展词、问句交给 Lead，动手短语交给 agent，
// 拿不准的交给 Lead。用户说：「工单中的聊天，我就是期望工单对应的 agent 来回」，也说过自然语言不要用正则匹配。
// 现在不分流：有 Run 在跑时交给那个 Run（插话或排队），没有时开一个对话 Run，续接最近的会话。
// 两条路上 agent 的输入开头都是系统现在的 TicketSummary（2026-10-16 #77：续接的会话按旧记忆答「还在 review」）。
//
// 走完整的落库路径：消息经网关进来，daemon 交给 agent；Lead 是假的 pi 会话（fake-pi-session.ts），什么都不说。
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import { createCoordinator, liveChildren } from "@pi-lead-child/engine";
import type { ConversationTurn, TicketDetail, TicketSummary } from "@pi-lead-child/protocol";
import { ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";
import type { SmartDecideOptions, SmartDecision, SmartModel, SmartQuestionSet } from "@pi-lead-child/engine";
import {
  createPairing, createRun, listEvents, openDb, redeemPairing, updateRun, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";
import { plcClient } from "./plc-client.js";

// 工单的 agent：按顺序回答每一次启动（续接或新开的对话 Run）。记下每一次启动请求。
class ScriptedAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = "codex";
  readonly capabilities: RuntimeCapabilities = {
    ...new ClaudeRuntime().capabilities, resume: true, steering: false, executableReadOnlyReview: true,
  };
  readonly requests: RuntimeStartRequest[] = [];

  constructor(private readonly reply: (request: RuntimeStartRequest) => string = () => "收到。") {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    return new ReplayRuntime({
      runtime: "codex",
      events: [
        { type: "run.started", runtime: "codex", model: null },
        { type: "session.updated", externalSessionId: request.resumeSessionId ?? `fresh-session-${this.requests.length}` },
        { type: "message.completed", messageId: "m-1", role: "assistant", text: this.reply(request) },
        { type: "run.completed", exitCode: 0 },
      ],
    }).start(request);
  }
}

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-ticket-chat-agent-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// #77 的样子：执行 Run 交付了，核查通过，工单已经 done。reviewer 的会话还在，是最近一个有会话的 Run。
function doneTicket(): { itemId: number; reviewerRunId: number } {
  const coordinator = createCoordinator({ db });
  const itemId = coordinator.createRootItem({
    title: "统一工单对话的状态口径", brief: "review", createdBy: "user", project: "plc", runtime: "codex",
  });
  const executor = createRun(db, { itemId, role: "executor", runtime: "codex" });
  updateRun(db, executor, { state: "finished", externalSessionId: "executor-session-77", endedAt: true });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  const reviewerRunId = createRun(db, { itemId, role: "reviewer", runtime: "codex" });
  updateRun(db, reviewerRunId, { state: "finished", externalSessionId: "reviewer-session-77", endedAt: true });
  // reviewer 那次 Run 的用量：输入框据此估算续接的成本（GET /v1/tickets/:id 的 chatResume）。
  db.prepare(
    `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, 1, 'usage.updated', ?, ?)`,
  ).run(reviewerRunId, JSON.stringify({
    type: "usage.updated", runId: reviewerRunId, seq: 1, mode: "cumulative",
    inputTokens: 450_000, outputTokens: 6_000, totalTokens: 456_000, costUsd: null,
  }), new Date().toISOString());
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
  return { itemId, reviewerRunId };
}

// Lead 什么都不说：它不该回答工单对话里的任何一条消息。smartModel：Lead 会话的 SmartModel 的替身。
function silentLead(options: { smartModel?: SmartModel | null } = {}) {
  return fakePiLead(() => ({ say: "NO_REPLY" }), options.smartModel !== undefined ? { smartModel: options.smartModel } : {});
}

async function start(lead: ReturnType<typeof fakePiLead>, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never,
    gatewayPort: 0, log: () => {}, notifyDesktop: () => {}, ...extra,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const connect = (include?: string) => {
    const query = `token=${issued.accessToken}&protocol=2${include ? `&include=${include}` : ""}`;
    const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?${query}`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    return { socket, events };
  };
  const { socket, events } = connect();
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string, context: Record<string, unknown> = {}) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...(Object.keys(context).length ? { context } : {}) }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
    headers: { authorization: `Bearer ${issued.accessToken}` },
  })).json()) as T;
  return { events, send, get, connect };
}

const turnRow = (id: string) => db.prepare(
  "SELECT origin_kind, item_id, state, assistant_text, error FROM channel_turns WHERE id=?",
).get(id) as { origin_kind: string; item_id: number | null; state: string; assistant_text: string; error: string | null };

const settled = async (turnId: string, itemId: number) => {
  await vi.waitFor(() => expect(turnRow(turnId).state).toMatch(/^(completed|failed)$/), { timeout: 10_000 });
  // 对话 Run 离开 live 表以后，下一条消息才会开下一个对话 Run（不是排队到它结束）。
  await vi.waitFor(() => expect(liveChildren().has(itemId)).toBe(false), { timeout: 10_000 });
};

const currentState = (prompt: string): TicketSummary => {
  expect(prompt.startsWith("## Current ticket state (authoritative)\n")).toBe(true);
  return JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/u)![1]!) as TicketSummary;
};

describe("regression 2026-10-19: every ticket chat message goes to the ticket's agent", () => {
  // 旧代码按关键词分流：「加油」「进展如何」交给 Lead，「帮我看看这个工单」「运行时间太长了」交给 agent。
  it("hands chit-chat, a request, a progress question and a complaint all to the agent", async () => {
    const { itemId, reviewerRunId } = doneTicket();
    const runtime = new ScriptedAgentRuntime(() => `agent 收到第 ${runtime.requests.length} 条。`);
    const lead = silentLead();
    const { send, get } = await start(lead, { runtimeRegistry: new RuntimeRegistry([runtime]) });
    // 输入框据此写续接哪一个会话、预估成本（工单 08 留下的部分）。
    expect((await get<TicketDetail>(`/v1/tickets/${itemId}`)).chatResume)
      .toEqual({ attemptId: reviewerRunId, role: "reviewer", runtime: "codex", lastTokens: 456_000 });

    const messages = ["加油", "帮我看看这个工单", "进展如何", "运行时间太长了"];
    for (const [index, message] of messages.entries()) {
      const { turnId } = await send(message, { ticketId: itemId });
      await settled(turnId, itemId);
      expect(turnRow(turnId)).toMatchObject({
        origin_kind: "paired:companion:ticket-agent", item_id: itemId, state: "completed", error: null,
        assistant_text: `agent 收到第 ${index + 1} 条。`,
      });
    }

    // 每一条都开了一个对话 Run，续接最近的会话；输入的开头是系统现在的 TicketSummary，后面是这条消息。
    expect(runtime.requests).toHaveLength(messages.length);
    expect(runtime.requests[0]!.resumeSessionId).toBe("reviewer-session-77");
    for (const [index, request] of runtime.requests.entries()) {
      expect(currentState(request.prompt)).toMatchObject({ id: itemId, stage: "done" });
      expect(request.prompt).toContain(messages[index]!);
    }
    // Lead 没有收到其中任何一条。
    for (const message of messages) expect(lead.prompts.some((prompt) => prompt.includes(message))).toBe(false);
  }, 60_000);

  // chat.send 的 context.answerer 是已发布的线上字段（chat.ticket-answerer.v1）。daemon 不再宣布这个能力，
  // 旧客户端带了也不报错，但 daemon 不按它分流。
  it("accepts and ignores the answerer an old client still sends", async () => {
    const { itemId } = doneTicket();
    const runtime = new ScriptedAgentRuntime();
    const lead = silentLead();
    const { send, events } = await start(lead, { runtimeRegistry: new RuntimeRegistry([runtime]) });
    expect(events.find((event) => event.type === "hello.v2").capabilities).not.toContain("chat.ticket-answerer.v1");

    const { turnId } = await send("@lead 现在进展怎么样", { ticketId: itemId, answerer: "lead" });
    await settled(turnId, itemId);
    expect(turnRow(turnId)).toMatchObject({ origin_kind: "paired:companion:ticket-agent", state: "completed" });
    expect(runtime.requests).toHaveLength(1);
    expect(lead.prompts.some((prompt) => prompt.includes("现在进展怎么样"))).toBe(false);
  }, 30_000);
});

// 有 Run 在跑时，消息插进那个 Run。插进去的话开头也是系统现在的 TicketSummary：同一个 Run 里，
// 上一条消息之后工单可能已经变了（例如你在别处验收了）。
describe("a ticket message into a live run", () => {
  it("steers the running agent with the current TicketSummary before your words", async () => {
    vi.stubEnv("FAKE_SCENARIO", "answer_steer");
    const commandLog = join(dir, "fake-pi-commands.jsonl");
    vi.stubEnv("FAKE_PI_COMMAND_LOG", commandLog);
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({ title: "两句话", brief: "answer both", createdBy: "user", project: "plc" });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const lead = silentLead();
    const { send } = await start(lead, {
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    });

    const first = await send("这个单子在干什么", { ticketId: itemId });
    await vi.waitFor(() => expect(turnRow(first.turnId).assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
    const second = await send("顺便看下测试", { ticketId: itemId });
    await vi.waitFor(() => expect(turnRow(second.turnId).state).toBe("completed"), { timeout: 15_000 });
    expect(turnRow(second.turnId).origin_kind).toBe("paired:companion:ticket-agent");

    const steers = readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; message: string | null })
      .filter((command) => command.type === "steer");
    expect(steers).toHaveLength(1);
    const steered = steers[0]!.message!;
    expect(currentState(steered)).toMatchObject({ id: itemId, title: "两句话" });
    expect(steered.endsWith("顺便看下测试")).toBe(true);
    expect(lead.prompts.some((prompt) => prompt.includes("顺便看下测试"))).toBe(false);
  }, 60_000);
});

// 回复下面的动作按钮（2026-10-19）：agent 的一轮答完以后，daemon 用 Lead 会话的 SmartModel 判断回复在等你决定
// 要不要做哪几个动作，结果记进事件日志，客户端从会话的接口读回来（刷新、重连以后还在）。SmartModel 是替身。
describe("buttons under a ticket reply, judged by the fast model", () => {
  const TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

  function stubModel(answer: (state: string) => Partial<Record<string, number>> | Error) {
    const calls: Array<{ state: string; questions: string[]; opts: SmartDecideOptions }> = [];
    const model: SmartModel = {
      backend: "jev",
      async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
        calls.push({ state, questions: Object.keys(questions), opts });
        const probabilities = answer(state);
        if (probabilities instanceof Error) throw probabilities;
        const answers = Object.fromEntries(Object.keys(questions).map((name) => [
          name, { type: "yes_no", probability: probabilities[name] ?? 0.05 },
        ]));
        return { answers: answers as never, backend: "jev", model: "stub", latencyMs: 1, fallbackFrom: null };
      },
    };
    return { model, calls };
  }

  it("delivers the answer, then records what the reply asks about and serves it to the client", async () => {
    const { itemId } = doneTicket();
    const reply = `我用 ${TOKEN} 推送了分支。核查还没有跑。你要我现在就派发独立核查吗？`;
    const runtime = new ScriptedAgentRuntime(() => reply);
    const { model, calls } = stubModel(() => ({ request_review: 0.92, complete: 0.4 }));
    const lead = silentLead({ smartModel: model });
    const { send, get, connect } = await start(lead, { runtimeRegistry: new RuntimeRegistry([runtime]) });
    // 选收了 reply_actions 的连接收到「重取这张工单的对话」；没选收的旧连接收不到（它会当成全部重取）。
    const optedIn = connect("lead_health,ui_surfaces,lead_activity,reply_actions");
    const old = connect();
    await vi.waitFor(() => expect(optedIn.events.some((event) => event.type === "hello.v2")).toBe(true));
    await vi.waitFor(() => expect(old.events.some((event) => event.type === "hello.v2")).toBe(true));

    const { turnId } = await send("进展如何", { ticketId: itemId });
    await vi.waitFor(() => expect(turnRow(turnId).state).toBe("completed"), { timeout: 10_000 });
    // agent 的 Run 收到了这条消息，开头是系统现在的 TicketSummary。
    expect(runtime.requests).toHaveLength(1);
    expect(currentState(runtime.requests[0]!.prompt)).toMatchObject({ id: itemId, stage: "done" });
    expect(turnRow(turnId)).toMatchObject({ origin_kind: "paired:companion:ticket-agent", assistant_text: reply });

    // 回答结束后问了一次 SmartModel：七个动作的问题在同一次调用里，用途写明，文字已脱敏。
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    expect(calls[0]!.questions).toEqual(["request_review", "complete", "rework", "cancel", "stop", "start", "restore"]);
    expect(calls[0]!.opts.purpose).toBe("ticket_reply_actions");
    expect(calls[0]!.state).toContain("你要我现在就派发独立核查吗？");
    expect(calls[0]!.state).not.toContain(TOKEN);

    // 结果落进事件日志：record 级，写入时就有处置，不交给 Lead。
    await vi.waitFor(() => expect(listEvents(db, { kind: "ticket_agent.reply_actions" })).toHaveLength(1), { timeout: 10_000 });
    expect(listEvents(db, { kind: "ticket_agent.reply_actions" })[0]).toMatchObject({
      level: "record", disposition: "handled_by_rule",
      payload: { turnId, itemId, actions: ["request_review"], backend: "jev" },
    });
    await vi.waitFor(() => expect(optedIn.events.some((event) => event.type === "snapshot.required"
      && event.payload.resource === "ticket-reply-actions" && event.ticketId === itemId)).toBe(true));
    expect(old.events.some((event) => event.payload?.resource === "ticket-reply-actions")).toBe(false);

    // 客户端从会话的接口读回来：只在要 reply_actions 时才有这个字段（旧客户端严格校验每一轮）。
    const plain = await get<{ items: ConversationTurn[] }>(`/v1/conversation/turns?ticket_id=${itemId}&include=tool_calls,surfaces,placement`);
    expect(plain.items.find((turn) => turn.id === turnId)).not.toHaveProperty("replyActions");
    const client = await plcClient(daemon!);
    const turns = await client.getConversationTurns(itemId);
    expect(turns.find((turn) => turn.id === turnId)!.replyActions).toEqual(["request_review"]);
    // Lead 没有回答这条消息，也没有因为这个判断被叫醒。
    expect(lead.prompts.some((prompt) => prompt.includes("进展如何") || prompt.includes("reply_actions"))).toBe(false);
  }, 60_000);

  it("still delivers the answer and shows no buttons when the model fails", async () => {
    const { itemId } = doneTicket();
    const runtime = new ScriptedAgentRuntime(() => "要我派发独立核查吗？");
    const { model, calls } = stubModel(() => new Error("jev: 503 service unavailable"));
    const logs: string[] = [];
    const { send } = await start(silentLead({ smartModel: model }), {
      runtimeRegistry: new RuntimeRegistry([runtime]), log: (line) => logs.push(line),
    });

    const { turnId } = await send("进展如何", { ticketId: itemId });
    await vi.waitFor(() => expect(turnRow(turnId)).toMatchObject({ state: "completed", assistant_text: "要我派发独立核查吗？" }),
      { timeout: 10_000 });
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(logs.some((line) => line.includes("[reply-actions]") && line.includes("no reply buttons"))).toBe(true));
    expect(listEvents(db, { kind: "ticket_agent.reply_actions" })).toEqual([]);
    const client = await plcClient(daemon!);
    expect((await client.getConversationTurns(itemId)).find((turn) => turn.id === turnId)).not.toHaveProperty("replyActions");
  }, 60_000);
});
