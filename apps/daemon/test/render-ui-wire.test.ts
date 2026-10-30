// generative UI（2026-10-15 用户决定，.scratch/generative-ui/spec.md）：Lead 用 render_ui 画的卡片怎样到客户端。
// 事件类型表是冻结的（kernel-protocol-contract），所以 surface 跟在 render_ui 的 lead.tool.updated 里，
// 只发给连接时声明了 include=ui_surfaces 的客户端。刷新时 GET /v1/conversation/turns?include=surfaces 带上它。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { completeTurn, createItem, createPairing, createTurn, EMPTY_ASSISTANT_REPLY_ERROR, failTurn, getDecisionRequest, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-render-ui-wire-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Lead 的会话是替身，工具是真的：替身在回答时调一次 render_ui，把真实的结果发成工具事件。
function leadThatRenders(args: (ticketId: number) => Record<string, unknown>, ticketId: number, reply = "#66 的核查不通过，需要你决定。") {
  const listeners: Array<(event: any) => void> = [];
  let tools: ReturnType<typeof createLeadTools> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async (deps: LeadDeps) => {
    tools = createLeadTools(deps);
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt() {
          if (reply) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
          const render = tools.find((tool) => tool.name === "render_ui")!;
          const params = args(ticketId) as { nodes: unknown[] };
          // 流式：模型边写参数，pi-ai 边解析（toolcall_delta 的 partial）。先到 root 和工单头，再到其余节点。
          const streaming = (nodes: unknown[]) => ({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_delta", contentIndex: 1, delta: "…",
              partial: { role: "assistant", content: [
                { type: "text", text: reply },
                { type: "toolCall", id: "call-1", name: "render_ui", arguments: { ...params, nodes } },
              ] },
            },
          });
          emit(streaming(params.nodes.slice(0, 2)));
          emit(streaming(params.nodes));
          emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "render_ui", args: params });
          const result = await render.execute("call-1", params as never, undefined, undefined, undefined as never);
          emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "render_ui", args: params, result, isError: false });
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: reply ? [{ type: "text", text: reply }] : [] } });
        },
        async steer() {},
        async followUp() {},
        dispose() {},
      },
    };
  };
  return factory;
}

const card = (ticketId: number) => ({
  surface_id: "decide",
  root: "card",
  fallback_text: "#66 核查不通过，需要你在并入 #72、取消里选一个。",
  nodes: [
    { id: "card", type: "Stack", props: {}, children: ["head", "choice"] },
    { id: "head", type: "TicketRef", props: { ticket: ticketId } },
    { id: "choice", type: "ChoiceGroup", props: { ticket: ticketId, choices: [{ id: "merge", label: "并入 #72" }, { id: "cancel", label: "取消 #66" }] } },
  ],
});

// 同一个 binding 的两个连接：一个声明了 include=ui_surfaces，一个没有（旧客户端）。用户发起的回合的工具事件只发给发起的 binding。
async function connect(include: string, token?: string) {
  const accessToken = token ?? redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code).accessToken;
  const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${accessToken}&protocol=2&after_seq=-1${include}`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  return { socket, events, token: accessToken };
}

describe("a surface Lead renders", () => {
  it("reaches clients that asked for it, live and after a refresh, with the decision bound", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadThatRenders(card, ticketId) as never, log: () => {} });
    const asking = await connect("&include=ui_surfaces");
    const plain = await connect("", asking.token);

    asking.socket.send(JSON.stringify({ type: "chat.send", id: "c1", protocolVersion: 2, message: "#66 怎么样了" }));
    await vi.waitFor(() => expect(asking.events.some((event) => event.type === "lead.message.completed")).toBe(true));
    await vi.waitFor(() => expect(plain.events.some((event) => event.type === "lead.message.completed")).toBe(true));

    // 参数还在流的时候先到一张「生成中」的卡片：只有已经完整的节点（root 和工单头）。
    const streamed = asking.events.filter((event) => event.type === "lead.tool.updated" && event.payload.partial === true);
    expect(streamed.length).toBeGreaterThanOrEqual(1);
    expect(streamed[0].payload.surface.nodes.map((node: any) => node.id)).toEqual(["card", "head"]);
    const live = asking.events.find((event) => event.type === "lead.tool.updated" && event.payload.surface && !event.payload.partial);
    expect(live.payload).toMatchObject({ toolCallId: "call-1", toolName: "render_ui", surface: { id: "decide", root: "card" } });
    expect(live.payload.textOffset).toBe("#66 的核查不通过，需要你决定。".length);
    const decisionId = live.payload.surface.nodes.find((node: any) => node.id === "choice").props.decision;
    expect(getDecisionRequest(db, decisionId)).toMatchObject({ origin: "lead", state: "pending" });
    // 没声明 include=ui_surfaces 的旧客户端收不到这个事件，工具的开始和结束照常收到。
    expect(plain.events.some((event) => event.payload?.surface)).toBe(false);
    expect(plain.events.filter((event) => event.type?.startsWith("lead.tool.")).map((event) => event.type))
      .toEqual(["lead.tool.started", "lead.tool.completed"]);

    const refreshed = await (await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?include=tool_calls,surfaces`, {
      headers: { authorization: `Bearer ${asking.token}` },
    })).json() as { items: Array<{ surfaces?: Array<{ surface: { id: string } }> }> };
    expect(refreshed.items.at(-1)?.surfaces?.map((placement) => placement.surface.id)).toEqual(["decide"]);
  });
});

// 2026-10-24 线上（turn 9c2f684e）：第一次 render_ui 的 FactList 写了目录里没有的 status，校验失败；
// 它流式中途的「生成中」版本已经落库。Lead 用同一个 surface_id 重画成功。刷新以后用户看到两张卡，
// 第一张一直停在「正在生成…」。失败的调用不留卡片，同一个 id 的重画替换旧卡：这一轮只有一张定稿的卡。
function leadThatRedraws(ticketId: number) {
  const listeners: Array<(event: any) => void> = [];
  let tools: ReturnType<typeof createLeadTools> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const reply = "它不会自动跑。";
  const facts = (status: string) => ({
    surface_id: "benchmark_timing",
    root: "card",
    fallback_text: "benchmark 不会自动跑，只在手动验证时跑。",
    nodes: [
      { id: "card", type: "Stack", props: {}, children: ["head", "facts"] },
      { id: "head", type: "TicketRef", props: { ticket: ticketId } },
      { id: "facts", type: "FactList", props: { items: [{ label: "CI", text: "没有触发它的任务", status }] } },
    ],
  });
  const call = async (id: string, params: ReturnType<typeof facts>) => {
    const render = tools.find((tool) => tool.name === "render_ui")!;
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta", contentIndex: 1, delta: "…",
        partial: { role: "assistant", content: [
          { type: "text", text: reply },
          { type: "toolCall", id, name: "render_ui", arguments: { ...params, nodes: params.nodes.slice(0, 2) } },
        ] },
      },
    });
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "render_ui", args: params });
    try {
      const result = await render.execute(id, params as never, undefined, undefined, undefined as never);
      emit({ type: "tool_execution_end", toolCallId: id, toolName: "render_ui", args: params, result, isError: false });
    } catch (error) {
      const result = { content: [{ type: "text", text: (error as Error).message }], details: {} };
      emit({ type: "tool_execution_end", toolCallId: id, toolName: "render_ui", args: params, result, isError: true });
    }
  };
  return async (deps: LeadDeps) => {
    tools = createLeadTools(deps);
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt() {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
          await call("call-1", facts("warning"));
          await call("call-2", facts("info"));
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] } });
        },
        async steer() {},
        async followUp() {},
        dispose() {},
      },
    };
  };
}

describe("a surface Lead draws again after a failed call", () => {
  it("is one final card after a refresh, without the failed call's streaming version", async () => {
    const ticketId = createItem(db, { title: "benchmark", brief: "b", createdBy: "lead" });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadThatRedraws(ticketId) as never, log: () => {} });
    const asking = await connect("&include=ui_surfaces");
    asking.socket.send(JSON.stringify({ type: "chat.send", id: "c1", protocolVersion: 2, message: "benchmark 会自动跑吗" }));
    await vi.waitFor(() => expect(asking.events.some((event) => event.type === "lead.message.completed")).toBe(true));

    // 前提：失败的那次确实先流出过「生成中」的版本，然后失败了。
    expect(asking.events.some((event) => event.type === "lead.tool.updated" && event.payload.toolCallId === "call-1" && event.payload.partial === true)).toBe(true);
    expect(asking.events.some((event) => event.type === "lead.tool.failed" && event.payload.toolCallId === "call-1")).toBe(true);

    const refreshed = await (await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?include=surfaces`, {
      headers: { authorization: `Bearer ${asking.token}` },
    })).json() as { items: Array<{ surfaces?: Array<{ callId: string; partial?: true; surface: { id: string } }> }> };
    expect(refreshed.items.at(-1)?.surfaces).toEqual([
      expect.objectContaining({ callId: "call-2", surface: expect.objectContaining({ id: "benchmark_timing" }) }),
    ]);
    expect(refreshed.items.at(-1)?.surfaces?.[0]?.partial).toBeUndefined();
  });
});

// 2026-10-15 部署前的预览发现：Lead 只画了一张卡、没写字的一轮，运行时判成「Lead 未生成回复」，
// 每次启动的修复也会把它改成失败。卡片本身就是回答：这一轮保持完成，重启以后也一样。
describe("a turn answered only with a card", () => {
  it("stays completed, live and after the daemon restarts", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadThatRenders(card, ticketId, "") as never, log: () => {} });
    const asking = await connect("&include=ui_surfaces");
    asking.socket.send(JSON.stringify({ type: "chat.send", id: "c1", protocolVersion: 2, message: "#66 怎么样了" }));
    await vi.waitFor(() => expect(asking.events.some((event) => event.type === "lead.message.completed" || event.type === "notice.created")).toBe(true));
    const turns = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/conversation/turns?include=surfaces`, {
      headers: { authorization: `Bearer ${asking.token}` },
    })).json() as { items: Array<{ state: string; error: string | null; surfaces?: Array<{ surface: { id: string } }> }> }).items.at(-1);
    expect(asking.events.some((event) => event.type === "notice.created")).toBe(false);
    expect(await turns()).toMatchObject({ state: "completed", error: null, surfaces: [{ surface: { id: "decide" } }] });

    for (const socket of sockets.splice(0)) socket.close();
    await daemon.close();
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadThatRenders(card, ticketId, "") as never, log: () => {} });
    expect(await turns()).toMatchObject({ state: "completed", error: null, surfaces: [{ surface: { id: "decide" } }] });
  });
});

// 旧的启动修复把 Lead 自己发起、只调了工具的回合改成了「Lead 未生成回复」（线上 2026-10-15 13:56 改了 5 个）。
// 新的 daemon 启动时改回完成，也不再改新的。会话里它们不再显示成失败。
describe("quiet Lead-initiated turns at startup", () => {
  it("are completed again, and stay completed", async () => {
    createTurn(db, { id: "old-quiet", originKind: "system:heartbeat", userText: "" });
    failTurn(db, "old-quiet", EMPTY_ASSISTANT_REPLY_ERROR);
    createTurn(db, { id: "new-quiet", originKind: "system:blocker", userText: "" });
    completeTurn(db, "new-quiet");
    createTurn(db, { id: "model-error", originKind: "system:blocker", userText: "" });
    failTurn(db, "model-error", "503 auth_unavailable");
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadThatRenders(card, ticketId) as never, log: () => {} });
    const { token } = await connect("");
    const items = (await (await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns`, {
      headers: { authorization: `Bearer ${token}` },
    })).json() as { items: Array<{ id: string; state: string; error: string | null }> }).items;
    const byId = Object.fromEntries(items.map((turn) => [turn.id, turn]));
    expect(byId["old-quiet"]).toMatchObject({ state: "completed", error: null });
    expect(byId["new-quiet"]).toMatchObject({ state: "completed", error: null });
    expect(byId["model-error"]).toMatchObject({ state: "failed", error: "503 auth_unavailable" });
  });
});

