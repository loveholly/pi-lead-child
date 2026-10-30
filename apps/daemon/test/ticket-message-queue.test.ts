// 2026-10-15 live（#66）：核查 Run（Codex）正在跑时，用户在工单线程里问「现在是什么进展」，两次都失败：
// 「当前 run 不支持执行中 steering」。Codex 和 Claude Code 的 adapter 都不能在 Run 中途接收消息，
// 所以这条路径必然失败；界面还让用户「重发」，Lead 也不知道这件事。
// 现在：Run 不能插话时消息排队（轮次停在 queued），Run 结束后转交给 agent（开一个对话 Run）回答。
// 转交失败时写一条叫醒 Lead 的 inbox，由 Lead 接手。
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import { createCoordinator } from "@pi-lead-child/engine";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { createPairing, listInbox, listRuns, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { startDaemon } from "../src/server.js";

// 像 Codex 一样不能插话的 runtime。执行 Run 一直跑到测试放行；对话 Run 马上回答收到的消息。
class NoSteeringRuntime implements AgentRuntime {
  readonly id: RuntimeId = "codex";
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };
  readonly prompts: string[] = [];
  private releaseExecutor: (() => void) | null = null;
  private onExecutorStarted: () => void = () => {};
  readonly executorStarted = new Promise<void>((resolve) => { this.onExecutorStarted = resolve; });

  release(): void { this.releaseExecutor?.(); }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const conversation = request.purpose === "conversation";
    if (conversation) this.prompts.push(request.prompt);
    const gate = conversation ? Promise.resolve() : new Promise<void>((resolve) => { this.releaseExecutor = resolve; });
    if (!conversation) this.onExecutorStarted();
    const events = async function* (): AsyncGenerator<RuntimeEvent> {
      const now = () => new Date().toISOString();
      yield { type: "run.started", runId: request.runId, seq: 1, occurredAt: now(), runtime: "codex", model: null };
      await gate;
      if (conversation) {
        yield { type: "message.completed", runId: request.runId, seq: 2, occurredAt: now(), messageId: "m1", text: "正在跑 core-invariants。" } as RuntimeEvent;
      }
      yield { type: "run.completed", runId: request.runId, seq: 3, occurredAt: now(), exitCode: 0 };
    };
    return {
      pid: null,
      events: events(),
      interrupt: async () => { this.release(); },
      wait: async () => { await gate; return { ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }; },
    };
  }
}

// Lead 会话是替身，但工具是真的：测试用 Lead 的 spawn_child 在工单上起一个执行 Run。
function leadSessionFactory(capture: { tools: ReturnType<typeof createLeadTools> }) {
  return async (args: LeadDeps) => {
    capture.tools = createLeadTools(args);
    return {
      modelName: "stub/lead",
      session: {
        sessionId: "lead-queue", subscribe: () => () => {},
        prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {},
      },
    };
  };
}

async function connect(port: number, db: Db): Promise<{ socket: WebSocket; messages: any[] }> {
  const pairing = createPairing(db, { name: "queue-client", kind: "companion", scopes: ["chat", "tickets:view"] });
  const issued = redeemPairing(db, pairing.code);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  const messages: any[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  return { socket, messages };
}

async function setup() {
  const dataDir = tempDir("plc-ticket-queue-");
  const dbPath = join(dataDir, "plc.db");
  const db = openDb(dbPath);
  const coordinator = createCoordinator({ db });
  const itemId = coordinator.createRootItem({ title: "核查", brief: "review", createdBy: "lead", project: "queue", runtime: "codex" });
  const runtime = new NoSteeringRuntime();
  const capture = { tools: [] as ReturnType<typeof createLeadTools> };
  const daemon = await startDaemon({
    dataDir, dbPath, runtimeRegistry: new RuntimeRegistry([runtime]),
    sessionFactory: leadSessionFactory(capture) as any, gatewayPort: 0, log: () => {},
  });
  const spawn = capture.tools.find((tool) => tool.name === "spawn_child")!;
  await spawn.execute("spawn", { ticket_id: itemId, runtime: "codex", reason: "用户说开始做" }, undefined, undefined, undefined as never);
  return { dataDir, db, itemId, runtime, daemon };
}

function ticketTurns(db: Db, itemId: number) {
  return db.prepare(
    "SELECT state, user_text, assistant_text, error FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent' ORDER BY created_at",
  ).all(itemId) as Array<{ state: string; user_text: string; assistant_text: string; error: string | null }>;
}

describe("a ticket message to a run that cannot take messages mid-run", () => {
  it("waits in a queue and goes to the agent when the run ends", async () => {
    const { db, itemId, runtime, daemon } = await setup();
    const { socket, messages } = await connect(daemon.pairedPort, db);
    try {
      await runtime.executorStarted;
      socket.send(JSON.stringify({ type: "chat.send", id: "ask", protocolVersion: 2, message: "现在是什么进展", context: { ticketId: itemId } }));
      await vi.waitFor(() => expect(messages.find((message) => message.type === "command.result" && message.id === "ask"))
        .toMatchObject({ success: true }));
      await vi.waitFor(() => expect(ticketTurns(db, itemId)).toEqual([
        expect.objectContaining({ state: "queued", user_text: "现在是什么进展", error: null }),
      ]));

      runtime.release();
      await vi.waitFor(() => expect(ticketTurns(db, itemId)).toEqual([
        expect.objectContaining({ state: "completed", assistant_text: "正在跑 core-invariants。" }),
      ]), { timeout: 10_000 });
      expect(runtime.prompts.some((prompt) => prompt.includes("现在是什么进展"))).toBe(true);
      expect(listRuns(db, itemId).some((run) => run.purpose === "conversation")).toBe(true);
    } finally {
      runtime.release();
      socket.close();
      await daemon.close();
      db.close();
    }
  }, 30_000);

  it("hands the message to Lead when it still cannot be delivered", async () => {
    const { dataDir, db, itemId, runtime, daemon } = await setup();
    const { socket, messages } = await connect(daemon.pairedPort, db);
    try {
      await runtime.executorStarted;
      socket.send(JSON.stringify({ type: "chat.send", id: "ask", protocolVersion: 2, message: "现在是什么进展", context: { ticketId: itemId } }));
      await vi.waitFor(() => expect(messages.find((message) => message.type === "command.result" && message.id === "ask"))
        .toMatchObject({ success: true }));
      await vi.waitFor(() => expect(ticketTurns(db, itemId)[0]?.state).toBe("queued"));
      // 工单的工作目录落进了 PLC 的数据目录：对话 Run 拒绝在这里启动，转交必然失败。
      db.prepare("UPDATE items SET workdir=? WHERE id=?").run(dataDir, itemId);

      runtime.release();
      await vi.waitFor(() => expect(ticketTurns(db, itemId)[0]?.state).toBe("failed"), { timeout: 10_000 });
      const handover = listInbox(db, {}).find((row) => JSON.parse(row.payload).kind === "ticket_message_undelivered");
      expect(handover).toBeDefined();
      expect(handover!.item_id).toBe(itemId);
      expect(JSON.parse(handover!.payload)).toMatchObject({ wakeLead: true, needsUser: false });
      expect(handover!.summary).toContain("现在是什么进展");
    } finally {
      runtime.release();
      socket.close();
      await daemon.close();
      db.close();
    }
  }, 30_000);
});

// 2026-10-20 live（#102）：没有在跑的 Run，工单消息要开一个对话 Run，可是开不了（核查员的 runtime 被停用）。
// 错误抛给了网关，客户端收到 internal_error，发件箱当临时错误重发了 177 次，后面发给 Lead 的消息一直发不出去。
describe("a ticket message that cannot start a conversation run", () => {
  it("fails its turn with the reason and hands the message to Lead, so the sender stops retrying", async () => {
    const dataDir = tempDir("plc-ticket-unroutable-");
    const dbPath = join(dataDir, "plc.db");
    const db = openDb(dbPath);
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({ title: "核查", brief: "review", createdBy: "lead", project: "queue", runtime: "codex" });
    // 工单的工作目录落进了 PLC 的数据目录：对话 Run 拒绝在这里启动，转交必然失败。
    db.prepare("UPDATE items SET workdir=? WHERE id=?").run(dataDir, itemId);
    const daemon = await startDaemon({
      dataDir, dbPath, runtimeRegistry: new RuntimeRegistry([new NoSteeringRuntime()]),
      sessionFactory: leadSessionFactory({ tools: [] }) as any, gatewayPort: 0, log: () => {},
    });
    const { socket, messages } = await connect(daemon.pairedPort, db);
    const send = (id: string) => socket.send(JSON.stringify({
      type: "chat.send", id, protocolVersion: 2, message: "你提个 PR", context: { ticketId: itemId }, clientMessageId: "msg_pr",
    }));
    const result = (id: string) => messages.find((message) => message.type === "command.result" && message.id === id);
    try {
      send("first");
      await vi.waitFor(() => expect(result("first")).toBeDefined());
      expect(result("first")).toMatchObject({ success: true, data: { mode: "started" } });
      expect(ticketTurns(db, itemId)).toEqual([
        expect.objectContaining({ state: "failed", user_text: "你提个 PR", error: expect.stringContaining("PLC data directory") }),
      ]);
      const handover = listInbox(db, {}).find((row) => JSON.parse(row.payload).kind === "ticket_message_undelivered");
      expect(handover?.item_id).toBe(itemId);
      expect(handover!.summary).toContain("你提个 PR");
      expect(listRuns(db, itemId)).toEqual([]);

      // 发件箱重发同一条（同一个 clientMessageId）：拿回同一轮，不再开一轮、不再交给 Lead 一次。
      send("again");
      await vi.waitFor(() => expect(result("again")).toBeDefined());
      expect(result("again")).toMatchObject({ success: true, data: { duplicate: true, turnId: result("first").data.turnId } });
      expect(ticketTurns(db, itemId)).toHaveLength(1);
      expect(listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "ticket_message_undelivered")).toHaveLength(1);
    } finally {
      socket.close();
      await daemon.close();
      db.close();
    }
  }, 30_000);
});
