import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, redeemPairing } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createLeadTools, runningChildren, spawnItemChild, type LeadDeps } from "@pi-lead-child/lead";
import { ConversationTurnSchema, foldTurnToolCalls, type ConversationTurn } from "@pi-lead-child/protocol";
import { Value } from "typebox/value";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(dbPath);
});

function eventfulSessionFactory() {
  const listeners: Array<(event: any) => void> = [];
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        const emit = (event: any) => listeners.forEach((listener) => listener(event));
        emit({ type: "agent_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "正在核对" } });
        emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a", token: "secret-token" } });
        emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" }, partialResult: { content: [{ type: "text", text: "partial" }] } });
        emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "done" }], details: { apiKey: "secret-key", accessToken: "secret-access", bytes: Buffer.alloc(32, 7) } }, isError: false });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "正在核对" }] } });
        emit({ type: "turn_end", message: {}, toolResults: [] });
        emit({ type: "agent_end", messages: [] });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

// lead 先说一句，调两次工具，再给出回答。这是 pi 的真实顺序：带工具调用的那条助手消息先结束，再跑工具。
function narratedToolSessionFactory() {
  const listeners: Array<(event: any) => void> = [];
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-narrated-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        const emit = (event: any) => listeners.forEach((listener) => listener(event));
        emit({ type: "agent_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我先去查一下。" } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "我先去查一下。" }] } });
        for (const [callId, stage] of [["call-review", "review"], ["call-active", "active"]] as const) {
          emit({ type: "tool_execution_start", toolCallId: callId, toolName: "query_tickets", args: { stage } });
          emit({ type: "tool_execution_end", toolCallId: callId, toolName: "query_tickets", result: { content: [{ type: "text", text: "[]" }] }, isError: false });
        }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "两种状态下都没有工单。" } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "两种状态下都没有工单。" }] } });
        emit({ type: "turn_end", message: {}, toolResults: [] });
        emit({ type: "agent_end", messages: [] });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

// 发布评审给的密钥样本（值是假的）：命令行、请求头、URL、工具输出。
const SECRET_COMMANDS = [
  "curl -H 'Authorization: token ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234' https://api.github.com/user",
  "curl -u admin:hunter2 https://x",
  "git clone https://oauth2:glpat-FAKEabcdefghij0123@gitlab.com/g/r.git",
  "DATABASE_URL=postgres://app:p4ssw0rd@db psql",
  "curl -H 'Cookie: session=abc123def456' https://x",
  "mysql -uroot -pS3cret appdb",
  // 第二轮评审
  "kubectl create secret generic db --from-literal=password=kubepass1",
  "docker run --env=MYSQL_ROOT_PASSWORD=dockerpass1 mysql:8",
  "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "http --auth admin:httppass1 https://x",
];
const SECRET_OUTPUT = [
  "gho_FAKE9999zzzzYYYYxxxxWWWWvvvvUUUU0000",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----",
  "sk-ant-api03-FAKEabcdefghijklmnopqrstuvwxyz AKIAIOSFODNN7EXAMPLE",
  '{"data":{"password":"jsonpass1"},"items":[{"token":"jsontoken1"}]}',
  "{'password': 'pythonpass1'}",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.FAKEsignature_abc-123",
].join("\n");
const SECRET_VALUES = [
  "ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234", "hunter2", "glpat-FAKEabcdefghij0123", "p4ssw0rd", "abc123def456",
  "S3cret", "gho_FAKE9999zzzzYYYYxxxxWWWWvvvvUUUU0000", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  "sk-ant-api03-FAKEabcdefghij", "AKIAIOSFODNN7EXAMPLE",
  "kubepass1", "dockerpass1", "wJalrXUtnFEMI", "httppass1", "jsonpass1", "jsontoken1", "pythonpass1",
  "eyJzdWIiOiIxMjM0In0",
];

function secretToolSessionFactory() {
  const listeners: Array<(event: any) => void> = [];
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-secret-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        const emit = (event: any) => listeners.forEach((listener) => listener(event));
        emit({ type: "agent_start" });
        SECRET_COMMANDS.forEach((command, index) => {
          emit({ type: "tool_execution_start", toolCallId: `secret-${index}`, toolName: "bash", args: { command } });
          emit({
            type: "tool_execution_end", toolCallId: `secret-${index}`, toolName: "bash",
            result: { content: [{ type: "text", text: SECRET_OUTPUT }] }, isError: false,
          });
        });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "做完了。" } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "做完了。" }] } });
        emit({ type: "turn_end", message: {}, toolResults: [] });
        emit({ type: "agent_end", messages: [] });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

// Lead 建了一条规则：真的调 create_cron_trigger。日程的刷新事件由工具自己发（以前 daemon 按工具名另发一份，
// ui-action-parity P04 去掉了它），这里核对它照样送到每个能看工单的凭证。
function scheduleEventSessionFactory() {
  const listeners: Array<(event: any) => void> = [];
  return async (opts: { db: Db; dbPath: string; dataDir: string }) => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-schedule-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        const emit = (event: any) => listeners.forEach((listener) => listener(event));
        emit({ type: "agent_start" });
        const args = { label: "日报", cron: "0 9 * * 1", kind: "reminder", title: "日报" };
        emit({
          type: "tool_execution_start",
          toolCallId: "schedule-call",
          toolName: "create_cron_trigger",
          args,
        });
        await createLeadTools({ db: opts.db, dbPath: opts.dbPath, dataDir: opts.dataDir })
          .find((tool: any) => tool.name === "create_cron_trigger")!
          .execute("schedule-call", args as never, undefined, undefined, undefined as never);
        emit({
          type: "tool_execution_end",
          toolCallId: "schedule-call",
          toolName: "create_cron_trigger",
          result: { content: [{ type: "text", text: "created cron trigger #1" }] },
          isError: false,
        });
        emit({ type: "message_end", message: { role: "assistant", content: [] } });
        emit({ type: "turn_end", message: {}, toolResults: [] });
        emit({ type: "agent_end", messages: [] });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

describe("daemon control-plane event bridge", () => {
  it("projects Lead messages and tool lifecycle into one binding-scoped turn", async () => {
    const { code } = createPairing(db, {
      name: "phone", kind: "companion", scopes: ["chat", "tickets:view"],
    });
    const paired = redeemPairing(db, code);
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: eventfulSessionFactory() as any,
      gatewayPort: 0, log: () => {},
    });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${paired.accessToken}&protocol=2`);
    const messages: any[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      ws.send(JSON.stringify({
        type: "chat.send", id: "cmd-1", protocolVersion: 2,
        message: "继续核对",
      }));
      await vi.waitFor(() => expect(messages.some((message) => message.type === "lead.message.completed")).toBe(true));

      const command = messages.find((message) => message.type === "command.result" && message.id === "cmd-1");
      const turnId = command.data.turnId;
      const events = messages.filter((message) => message.eventId);
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "lead.turn.started", "lead.message.delta", "lead.tool.started",
        "lead.tool.updated", "lead.tool.completed", "lead.message.completed",
      ]));
      const leadEvents = events.filter((event) => event.type.startsWith("lead."));
      expect(leadEvents.every((event) => event.turnId === turnId && event.ticketId === null)).toBe(true);
      expect(leadEvents.every((event) => event.audienceBindingId === paired.binding.id)).toBe(true);
      expect(events.filter((event) => event.type === "ticket.updated")).toEqual([]);
      expect(events.find((event) => event.type === "lead.tool.started").payload.args.token).toBe("[REDACTED]");
      expect(events.find((event) => event.type === "lead.tool.started").payload.operationState).toBe("started");
      expect(events.find((event) => event.type === "lead.tool.updated").payload.operationState).toBe("running");
      expect(events.find((event) => event.type === "lead.tool.completed").payload.operationState).toBe("completed");
      const completedPayload = JSON.stringify(events.find((event) => event.type === "lead.tool.completed").payload);
      expect(completedPayload).not.toContain("secret-key");
      expect(completedPayload).not.toContain("secret-access");
      expect(completedPayload).toContain("[BINARY 32 BYTES]");

      const turns = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns`, {
        headers: { authorization: `Bearer ${paired.accessToken}` },
      });
      expect(await turns.json()).toEqual({ items: [expect.objectContaining({
        id: turnId, ticketId: null, originBindingId: paired.binding.id,
        userText: "继续核对", assistantText: "正在核对", state: "completed",
      })] });
    } finally {
      ws.close();
      await daemon.close();
    }
  }, 15000);

  // 任务卡：工具之间的话进卡片，最后一个工具之后的话是回复。刷新以后要和实时看到的一样，
  // 所以快照里的 toolCalls 必须等于客户端在实时事件上折叠出来的结果。
  it("places tool calls between the narration and the reply, and a reload folds the same calls as live", async () => {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes: ["chat", "tickets:view"] });
    const paired = redeemPairing(db, code);
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: narratedToolSessionFactory() as any,
      gatewayPort: 0, log: () => {},
    });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${paired.accessToken}&protocol=2`);
    const messages: any[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      ws.send(JSON.stringify({ type: "chat.send", id: "cmd-narrated", protocolVersion: 2, message: "看看待验收的" }));
      await vi.waitFor(() => expect(messages.some((message) => message.type === "lead.message.completed")).toBe(true));

      const turnId = messages.find((message) => message.type === "command.result" && message.id === "cmd-narrated").data.turnId;
      const live = messages.filter((message) => message.eventId && message.turnId === turnId);
      const narration = "我先去查一下。";
      expect(live.filter((event) => event.type === "lead.tool.started").map((event) => event.payload.textOffset))
        .toEqual([narration.length, narration.length]);

      const response = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?include=tool_calls`, {
        headers: { authorization: `Bearer ${paired.accessToken}` },
      });
      const { items } = await response.json() as { items: ConversationTurn[] };
      expect(items.every((item) => Value.Check(ConversationTurnSchema, item))).toBe(true);
      const turn = items.find((item) => item.id === turnId)!;
      expect(turn.toolCalls).toEqual(foldTurnToolCalls(live));
      expect(turn.toolCalls!.map((call) => [call.name, call.state, call.args?.preview])).toEqual([
        ["query_tickets", "completed", '{"stage":"review"}'],
        ["query_tickets", "completed", '{"stage":"active"}'],
      ]);
      const offset = turn.toolCalls![1]!.textOffset;
      expect(turn.assistantText.slice(0, offset)).toBe(narration);
      expect(turn.assistantText.slice(offset).trim()).toBe("两种状态下都没有工单。");

      const plain = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns`, {
        headers: { authorization: `Bearer ${paired.accessToken}` },
      });
      expect(((await plain.json()) as { items: ConversationTurn[] }).items[0]).not.toHaveProperty("toolCalls");
    } finally {
      ws.close();
      await daemon.close();
    }
  }, 15000);

  // 发布评审 cb8a582：命令和输出里的密钥一路到了界面。现在网关推送之前就去掉，快照里也没有。
  it("keeps secrets in commands and output out of the live events and the snapshot", async () => {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes: ["chat", "tickets:view"] });
    const paired = redeemPairing(db, code);
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: secretToolSessionFactory() as any,
      gatewayPort: 0, log: () => {},
    });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${paired.accessToken}&protocol=2`);
    const messages: any[] = [];
    const raw: string[] = [];
    ws.on("message", (data) => { raw.push(String(data)); messages.push(JSON.parse(String(data))); });
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      ws.send(JSON.stringify({ type: "chat.send", id: "cmd-secret", protocolVersion: 2, message: "跑一下" }));
      await vi.waitFor(() => expect(messages.some((message) => message.type === "lead.message.completed")).toBe(true));

      const response = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?include=tool_calls`, {
        headers: { authorization: `Bearer ${paired.accessToken}` },
      });
      const body = await response.text();
      const turns = (JSON.parse(body) as { items: ConversationTurn[] }).items;
      expect(turns[0]!.toolCalls).toHaveLength(SECRET_COMMANDS.length);
      for (const secret of SECRET_VALUES) {
        expect.soft(body, `snapshot: ${secret}`).not.toContain(secret);
        expect.soft(raw.join("\n"), `live: ${secret}`).not.toContain(secret);
      }
      expect(turns[0]!.toolCalls![0]!.args!.preview).toContain("https://api.github.com/user");
    } finally {
      ws.close();
      await daemon.close();
    }
  }, 15000);

  it("forwards Child tool lifecycle with ticket and attempt identity", async () => {
    const itemId = createItem(db, { title: "child", brief: "b", createdBy: "system" });
    const events: Array<{ itemId: number; runId: number; event: any }> = [];
    const done = vi.fn();
    const deps: LeadDeps = {
      db, dbPath, dataDir: dir,
      env: { FAKE_SCENARIO: "tool" },
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      onChildDone: done,
      onChildEvent: (seenItemId, runId, event) => events.push({ itemId: seenItemId, runId, event }),
    };
    spawnItemChild(deps, itemId, {});
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(runningChildren().has(itemId)).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId, runId: 1, event: expect.objectContaining({ type: "tool.started", callId: "child-call", name: "read" }) }),
      expect.objectContaining({ itemId, runId: 1, event: expect.objectContaining({ type: "tool.completed", callId: "child-call", name: "read" }) }),
    ]));
  }, 10000);

  it("broadcasts schedule invalidation to every tickets:view binding", async () => {
    const firstPairing = createPairing(db, {
      name: "phone", kind: "companion", scopes: ["chat", "tickets:view"],
    });
    const first = redeemPairing(db, firstPairing.code);
    const secondPairing = createPairing(db, {
      name: "tablet", kind: "companion", scopes: ["chat", "tickets:view"],
    });
    const second = redeemPairing(db, secondPairing.code);
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: scheduleEventSessionFactory() as any,
      gatewayPort: 0, log: () => {},
    });
    const firstMessages: any[] = [];
    const secondMessages: any[] = [];
    const firstWs = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${first.accessToken}&protocol=2`,
    );
    const secondWs = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${second.accessToken}&protocol=2`,
    );
    firstWs.on("message", (raw) => firstMessages.push(JSON.parse(String(raw))));
    secondWs.on("message", (raw) => secondMessages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => {
        expect(firstMessages.some((message) => message.type === "hello.v2")).toBe(true);
        expect(secondMessages.some((message) => message.type === "hello.v2")).toBe(true);
      });
      firstWs.send(JSON.stringify({
        type: "chat.send", id: "schedule-command", protocolVersion: 2,
        message: "创建日报日程",
      }));

      await vi.waitFor(() => expect(secondMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ticket.updated",
          requiredScope: "tickets:view",
          audienceBindingId: null,
          ticketId: null,
          payload: { snapshotRequired: true },
        }),
      ])));
      expect(secondMessages.some((message) => message.type.startsWith?.("lead.tool."))).toBe(false);
    } finally {
      firstWs.close();
      secondWs.close();
      await daemon.close();
    }
  }, 15000);
});
