// plc chat 从网关事件里渲染回答：只渲染发给本 binding 的轮次，以及所有人都该看到的审批请求。
// 打的每一行先写进发件箱文件，再发出去：断线、发送失败、重启都丢不了。
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneClientError, type ConnectionHandlers, type ControlPlaneClient, type OutboxEntry, type OutboxStorage,
  type SendChatCommandInput,
} from "@pi-lead-child/client";
import { tempDir } from "@pi-lead-child/core/testing";
import type { GatewayEvent, HelloV2 } from "@pi-lead-child/protocol";
import { chatOutboxPath } from "../src/chat-outbox-file.js";
import { ChatInput, ChatRenderer, runChat } from "../src/chat.js";
import { explainClientError } from "../src/gateway-client.js";

// 用户实际遇到的失败：代理返回 503 auth_unavailable，里面包着上游的 403 forbidden "Request not allowed"。
const LIVE_AUTH = '503: {"message":"auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5; '
  + 'last upstream error: {\\n  \\"error\\": {\\n    \\"type\\": \\"forbidden\\",\\n    '
  + '\\"message\\": \\"Request not allowed\\"}}","type":"server_error"}';

let seq = 0;
function event(type: GatewayEvent["type"], payload: Record<string, unknown>, audienceBindingId: number | null = 9): GatewayEvent {
  seq += 1;
  return {
    protocolVersion: 2, eventId: `e${seq}`, seq, type, occurredAt: "2026-10-13T04:00:00.000Z",
    requiredScope: "chat", audienceBindingId, turnId: "turn_1", ticketId: null, payload,
  };
}

function renderer() {
  const output: string[] = [];
  let prompts = 0;
  const chat = new ChatRenderer(9, { write: (text) => output.push(text), prompt: () => { prompts += 1; } });
  return { chat, text: () => output.join(""), prompts: () => prompts };
}

describe("ChatRenderer", () => {
  it("streams the lead's answer to this binding and prompts again when it completes", () => {
    const r = renderer();
    r.chat.event(event("lead.turn.started", { mode: "started" }));
    r.chat.event(event("lead.message.delta", { delta: "你好，" }));
    r.chat.event(event("lead.tool.started", { toolName: "list_tickets", args: { view: "tasks" } }));
    r.chat.event(event("lead.message.delta", { delta: "有 2 张工单。" }));
    r.chat.event(event("lead.message.completed", { text: "你好，有 2 张工单。" }));
    expect(r.text()).toContain("你好，");
    expect(r.text()).toContain('· list_tickets({"view":"tasks"})');
    expect(r.text()).toContain("有 2 张工单。");
    expect(r.prompts()).toBe(1);
  });

  // generative UI spec D8：命令行画不了卡片，打印 Lead 写的 fallback_text，不打印节点表。
  it("prints a card's fallback text instead of its node list", () => {
    const r = renderer();
    r.chat.event(event("lead.tool.started", {
      toolName: "render_ui",
      args: { root: "card", nodes: [{ id: "card", type: "Stack", props: {} }], fallback_text: "#66 核查不通过，需要你在并入 #72、取消里选一个。" },
    }));
    expect(r.text()).toContain("[卡片] #66 核查不通过，需要你在并入 #72、取消里选一个。");
    expect(r.text()).not.toContain("nodes");
  });

  it("says when a message was steered into a running turn", () => {
    const r = renderer();
    r.chat.event(event("lead.turn.started", { mode: "steered" }));
    expect(r.text()).toContain("已插话");
  });

  it("shows a turn the lead started itself, with its label", () => {
    const r = renderer();
    r.chat.event(event("lead.turn.started", { originKind: "system:blocker", mode: "started", commandId: null }, null));
    r.chat.event(event("lead.message.delta", { delta: "工单 #12 卡住了，我先重试一次。" }, null));
    r.chat.event(event("lead.message.completed", { text: "工单 #12 卡住了，我先重试一次。" }, null));
    // 2026-10-15 用户决定（方案 A）：Lead 发起的一轮只标「Lead」，不写「Lead 主动」这类标签。
    expect(r.text()).toContain("[Paimon]");
    expect(r.text()).not.toContain("主动");
    expect(r.text()).toContain("工单 #12 卡住了，我先重试一次。");
    expect(r.prompts()).toBe(1);
  });

  it("shows a system notice from the daemon", () => {
    const r = renderer();
    r.chat.event(event("lead.turn.started", { originKind: "system:blocker-notice", mode: "started", commandId: null }, null));
    r.chat.event(event("lead.message.delta", { delta: "🔴 工单 #12 的 Run #7 出现未捕获异常" }, null));
    r.chat.event(event("lead.message.completed", { text: "🔴 工单 #12 的 Run #7 出现未捕获异常" }, null));
    expect(r.text()).toContain("[系统通知 · blocker]");
    expect(r.text()).toContain("🔴 工单 #12 的 Run #7 出现未捕获异常");
  });

  it("shows a failed system turn in one plain sentence, without a retry promise for an auth failure", () => {
    const r = renderer();
    r.chat.event(event("lead.turn.started", { originKind: "system:heartbeat", mode: "started", commandId: null }, null));
    r.chat.event(event("notice.created", { severity: "error", message: LIVE_AUTH }, null));
    expect(r.text()).toContain("[error] Paimon 的模型账号认证失败；系统没法自己恢复，请检查 Paimon 的模型账号。");
    expect(r.text()).toContain("技术详情：503:");
    expect(r.text()).not.toMatch(/请重试|自动再试/);
  });

  it("says an unreachable model is retried only on turns the system retries", () => {
    const r = renderer();
    r.chat.event(event("notice.created", { severity: "error", message: "503 Service Unavailable" }, null));
    r.chat.event(event("notice.created", { severity: "error", message: "503 Service Unavailable" }));
    expect(r.text()).toContain("[error] Paimon 的模型服务暂时连不上；系统会自动再试，你不需要操作。");
    expect(r.text()).toContain("[error] Paimon 的模型服务暂时连不上，这条消息没有得到回答；系统不会自动重发，你可以再发一次。");
  });

  it("says a turn is waiting for its one automatic retry, not that it failed", () => {
    const r = renderer();
    r.chat.event(event("notice.created", {
      severity: "error", message: "getaddrinfo ENOTFOUND api.anthropic.com", retry: "waiting", waitingFor: "network",
    }));
    expect(r.text()).toContain("网络不可用，这条消息还没有得到回答。网络恢复后会自动再试一次。");
    expect(r.text()).not.toContain("[error]");
  });

  it("prints an error it cannot classify as it is", () => {
    const r = renderer();
    r.chat.event(event("notice.created", { severity: "error", message: "Lead 未生成回复，请重试。" }));
    expect(r.text()).toContain("[error] Lead 未生成回复，请重试。");
    expect(r.text()).not.toContain("技术详情");
  });

  it("ignores turns that belong to another client", () => {
    const r = renderer();
    r.chat.event(event("lead.message.delta", { delta: "companion 的回答" }, 3));
    r.chat.event(event("lead.message.completed", { text: "companion 的回答" }, 3));
    expect(r.text()).toBe("");
    expect(r.prompts()).toBe(0);
  });

  it("shows a failed turn", () => {
    const r = renderer();
    // 旧版 daemon 写的那句也按认证失败说，不再叫你重试。
    r.chat.event(event("notice.created", { severity: "error", message: "Lead 模型连接认证失败，请重试。" }));
    expect(r.text()).toContain("[error] Paimon 的模型账号认证失败，这条消息没有得到回答；请先检查 Paimon 的模型账号，再发一次。");
    expect(r.text()).not.toContain("请重试");
    expect(r.prompts()).toBe(1);
  });

  it("greets with the daemon model and the gateway address", () => {
    const r = renderer();
    r.chat.hello({
      type: "hello.v2", protocolVersion: 2, serverTime: "", timezone: "Asia/Shanghai", latestSeq: 0, capabilities: [],
      binding: { id: 9, kind: "cli", name: "plc", scopes: ["chat"] },
      daemon: { model: "stub/model", sessionId: "s1", busy: true },
    }, "http://127.0.0.1:47130");
    expect(r.text()).toContain("Paimon ready (model=stub/model, session=s1，正在处理其他请求)");
    expect(r.text()).toContain("网关: http://127.0.0.1:47130");
  });
});

function memoryOutbox(): OutboxStorage {
  let saved: OutboxEntry[] = [];
  return { load: async () => saved, save: async (entries) => { saved = entries; } };
}

function chatInput() {
  const sent: string[] = [];
  const input = new ChatInput(
    { sendChatCommand: async (command) => { sent.push(command.message); return { turnId: `turn_${sent.length}` }; } },
    memoryOutbox(),
    { write: () => {}, prompt: () => {} },
  );
  return { input, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("ChatInput", () => {
  it("holds lines typed before the gateway greets, then sends them in order", async () => {
    const { input, sent } = chatInput();
    input.line("第一句");
    input.line("  ");
    input.line("第二句");
    await settle();
    expect(sent).toEqual([]);
    input.ready();
    await vi.waitFor(() => expect(sent).toEqual(["第一句", "第二句"]));
    input.line("第三句");
    await vi.waitFor(() => expect(sent).toEqual(["第一句", "第二句", "第三句"]));
  });

  it("tells the caller to quit on /quit and /exit", () => {
    const { input } = chatInput();
    expect(input.line("/quit")).toBe("quit");
    expect(input.line("/exit")).toBe("quit");
    expect(input.line("你好")).toBe("queued");
    input.ready();
    expect(input.line("你好")).toBe("sent");
    expect(input.line("")).toBe("empty");
  });
});

describe("ChatInput while reconnecting", () => {
  // 重连期间事件流断着，这时发出的那一轮的回答收不到。先留着，重新打招呼之后再发。
  it("holds lines typed while the gateway is away, and sends them after the next greeting", async () => {
    const { input, sent } = chatInput();
    input.ready();
    input.line("第一句");
    await vi.waitFor(() => expect(sent).toEqual(["第一句"]));
    input.offline();
    expect(input.line("第二句")).toBe("queued");
    await settle();
    expect(sent).toEqual(["第一句"]);
    input.ready();
    await vi.waitFor(() => expect(sent).toEqual(["第一句", "第二句"]));
  });
});

const hello: HelloV2 = {
  type: "hello.v2", protocolVersion: 2, serverTime: "2026-10-13T04:00:00.000Z", timezone: "Asia/Shanghai",
  latestSeq: 0, capabilities: [], binding: { id: 9, kind: "cli", name: "plc", scopes: ["chat"] },
  daemon: { model: "stub/model", sessionId: "s", busy: false },
};

const GATEWAY_URL = "http://127.0.0.1:47130";
const outboxFile = () => chatOutboxPath(tempDir("plc-chat-"));
const storedOutbox = (path: string) => JSON.parse(readFileSync(path, "utf8")) as OutboxEntry[];

interface SentCommand extends SendChatCommandInput {
  // 发出这条命令时，它的 clientMessageId 已经在发件箱文件里。
  inFile: boolean;
}

// refuse：前几次 chat.send 被服务端拒收（forbidden）。hang：chat.send 一直没有结果，像 Mac 睡着时那样；
// 和真的客户端一样，disconnect() 让还没有结果的命令以 disconnected 失败。
function fakeChatClient(
  onConnect: (handlers: ConnectionHandlers) => void,
  options: { outboxPath?: string; refuse?: number; hang?: boolean } = {},
) {
  const sent: string[] = [];
  const commands: SentCommand[] = [];
  const hung: Array<(error: Error) => void> = [];
  let refusals = options.refuse ?? 0;
  let handlers: ConnectionHandlers = {};
  const client = {
    connect: async (next: ConnectionHandlers) => { handlers = next; onConnect(next); },
    disconnect: vi.fn(() => {
      for (const reject of hung.splice(0)) reject(new ControlPlaneClientError("connection closed", "disconnected"));
    }),
    setPresence: vi.fn(),
    sendChatCommand: async (command: SendChatCommandInput) => {
      const file = options.outboxPath && existsSync(options.outboxPath) ? readFileSync(options.outboxPath, "utf8") : "";
      commands.push({ ...command, inFile: !!command.clientMessageId && file.includes(command.clientMessageId) });
      if (options.hang) return new Promise<never>((_resolve, reject) => { hung.push(reject); });
      if (refusals > 0) {
        refusals -= 1;
        throw new ControlPlaneClientError("binding lacks the chat scope", "forbidden", 403);
      }
      sent.push(command.message);
      return { turnId: `turn_${commands.length}` };
    },
  };
  return { client: client as unknown as ControlPlaneClient, sent, commands, handlers: () => handlers };
}

const connectingOnly = (handlers: ConnectionHandlers) => handlers.onStateChange?.("connecting");
const greetedAtOnce = (handlers: ConnectionHandlers) => {
  handlers.onStateChange?.("connected");
  handlers.onHello?.(hello);
};

function chatIo() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
  return { io: { input, output }, text: () => text };
}

describe("runChat", () => {
  // 凭证被撤销或者账本重置过：重连不会好。plc chat 退出，并提示怎样重新签发凭证。
  it("exits with the auth hint when the gateway rejects the credential", async () => {
    const { client } = fakeChatClient((handlers) => {
      handlers.onStateChange?.("connecting");
      handlers.onCredentialRejected?.(new ControlPlaneClientError("invalid token", "unauthorized", 401));
      handlers.onStateChange?.("disconnected");
    });
    const { io } = chatIo();
    const error = await runChat(client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io, outboxPath: outboxFile() })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ControlPlaneClientError);
    expect(explainClientError(error)?.message).toContain("plc auth login");
  });

  // 打招呼之后、问到网关地址之前连接又断了：这时打的字要留到下一次打招呼，不能当作已连上发出去。
  it("does not treat a greeting as ready when the connection drops before the address arrives", async () => {
    let releaseFirstUrl: (url: string) => void = () => {};
    let urlCalls = 0;
    const gatewayUrl = () => {
      urlCalls += 1;
      return urlCalls === 1
        ? new Promise<string>((resolve) => { releaseFirstUrl = resolve; })
        : Promise.resolve(GATEWAY_URL);
    };
    const fake = fakeChatClient(greetedAtOnce);
    const { io, text } = chatIo();
    const done = runChat(fake.client, { bindingId: 9, gatewayUrl, io, outboxPath: outboxFile() });
    await vi.waitFor(() => expect(urlCalls).toBe(1));
    fake.handlers().onStateChange?.("reconnecting");
    releaseFirstUrl(GATEWAY_URL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    io.input.write("断线时打的字\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent).toEqual([]);
    fake.handlers().onStateChange?.("connected");
    fake.handlers().onHello?.(hello);
    await vi.waitFor(() => expect(fake.sent).toEqual(["断线时打的字"]));
    expect(text()).toContain("Paimon ready");
    io.input.write("/quit\n");
    await done;
  });

  it("sends a line typed during a reconnect only after the gateway greets again", async () => {
    const path = outboxFile();
    const fake = fakeChatClient(greetedAtOnce, { outboxPath: path });
    const { io, text } = chatIo();
    const done = runChat(fake.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io, outboxPath: path });
    await vi.waitFor(() => expect(text()).toContain("Paimon ready"));
    io.input.write("第一句\n");
    await vi.waitFor(() => expect(fake.sent).toEqual(["第一句"]));
    fake.handlers().onStateChange?.("reconnecting");
    io.input.write("第二句\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent).toEqual(["第一句"]);
    fake.handlers().onStateChange?.("connected");
    fake.handlers().onHello?.(hello);
    await vi.waitFor(() => expect(fake.sent).toEqual(["第一句", "第二句"]));
    // 连着时打的字也先进发件箱，再上网络。
    expect(fake.commands.map((command) => command.inFile)).toEqual([true, true]);
    io.input.write("/quit\n");
    await done;
  });
});

// 2026-10-16：Mac 睡眠时打的字只活在内存里，发送失败的那条也就没了。现在每一行先写进数据目录里的发件箱文件。
describe("runChat with the outbox", () => {
  it("saves a line typed while disconnected to the outbox file before any network call, and sends it once connected", async () => {
    const path = outboxFile();
    const fake = fakeChatClient(connectingOnly, { outboxPath: path });
    const { io, text } = chatIo();
    const done = runChat(fake.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io, outboxPath: path });
    io.input.write("断线时打的字\n");
    await vi.waitFor(() => expect(text()).toContain("（待发送：连接恢复后发送）"));
    const [stored] = storedOutbox(path);
    expect(stored).toMatchObject({ message: "断线时打的字", state: "pending", attempts: 0 });
    expect(fake.commands).toEqual([]);
    fake.handlers().onStateChange?.("connected");
    fake.handlers().onHello?.(hello);
    await vi.waitFor(() => expect(fake.sent).toEqual(["断线时打的字"]));
    expect(fake.commands).toMatchObject([{ id: stored.clientMessageId, clientMessageId: stored.clientMessageId, inFile: true }]);
    // 送达以后发件箱空了，文件也删掉。
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    io.input.write("/quit\n");
    await done;
  });

  it("restores unsent messages after a restart and resends them with the same clientMessageId", async () => {
    const path = outboxFile();
    const before = fakeChatClient(connectingOnly, { outboxPath: path });
    const first = chatIo();
    const firstRun = runChat(before.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io: first.io, outboxPath: path });
    first.io.input.write("重启前打的字\n");
    await vi.waitFor(() => expect(first.text()).toContain("待发送"));
    first.io.input.write("/quit\n");
    await firstRun;
    const [stored] = storedOutbox(path);

    const after = fakeChatClient(greetedAtOnce, { outboxPath: path });
    const second = chatIo();
    const secondRun = runChat(after.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io: second.io, outboxPath: path });
    await vi.waitFor(() => expect(after.sent).toEqual(["重启前打的字"]));
    expect(second.text()).toContain("（恢复了 1 条未发送的消息，连接后发送）");
    expect(second.text()).toContain("「重启前打的字」");
    expect(after.commands).toMatchObject([{ id: stored.clientMessageId, clientMessageId: stored.clientMessageId }]);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    second.io.input.write("/quit\n");
    await secondRun;
  });

  // 发出去了、还没等到结果时 plc chat 被关掉：不知道 daemon 收到没有，下次照原来的 id 重发，daemon 按它去重。
  it("resends a message that was still in flight when plc chat quit, with the same clientMessageId", async () => {
    const path = outboxFile();
    const before = fakeChatClient(greetedAtOnce, { outboxPath: path, hang: true });
    const first = chatIo();
    const firstRun = runChat(before.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io: first.io, outboxPath: path });
    await vi.waitFor(() => expect(first.text()).toContain("Paimon ready"));
    first.io.input.write("发到一半\n");
    await vi.waitFor(() => expect(before.commands).toHaveLength(1));
    first.io.input.write("/quit\n");
    await firstRun;
    // 断开时那条命令以 disconnected 失败：回到待发送，退出以后不再印提示。
    await vi.waitFor(() => expect(storedOutbox(path)).toMatchObject([{ message: "发到一半", state: "pending" }]));
    expect(first.text().trimEnd().endsWith("已断开（daemon 与 child 仍在后台常驻）")).toBe(true);

    const after = fakeChatClient(greetedAtOnce, { outboxPath: path });
    const second = chatIo();
    const secondRun = runChat(after.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io: second.io, outboxPath: path });
    await vi.waitFor(() => expect(after.sent).toEqual(["发到一半"]));
    expect(after.commands[0].clientMessageId).toBe(before.commands[0].clientMessageId);
    second.io.input.write("/quit\n");
    await secondRun;
  });

  it("shows a refused send, and /retry sends it again with the same clientMessageId", async () => {
    const path = outboxFile();
    const fake = fakeChatClient(greetedAtOnce, { outboxPath: path, refuse: 1 });
    const { io, text } = chatIo();
    const done = runChat(fake.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io, outboxPath: path });
    await vi.waitFor(() => expect(text()).toContain("Paimon ready"));
    io.input.write("你好\n");
    await vi.waitFor(() => expect(text()).toContain("（发送失败：binding lacks the chat scope；输入 /retry 重试，/drop 删除）"));
    expect(storedOutbox(path)).toMatchObject([{ message: "你好", state: "failed" }]);
    expect(fake.sent).toEqual([]);
    io.input.write("/retry\n");
    await vi.waitFor(() => expect(fake.sent).toEqual(["你好"]));
    expect(fake.commands).toHaveLength(2);
    expect(fake.commands[1].clientMessageId).toBe(fake.commands[0].clientMessageId);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    io.input.write("/quit\n");
    await done;
  });

  it("drops the latest refused message on /drop", async () => {
    const path = outboxFile();
    const fake = fakeChatClient(greetedAtOnce, { outboxPath: path, refuse: 1 });
    const { io, text } = chatIo();
    const done = runChat(fake.client, { bindingId: 9, gatewayUrl: async () => GATEWAY_URL, io, outboxPath: path });
    await vi.waitFor(() => expect(text()).toContain("Paimon ready"));
    io.input.write("你好\n");
    await vi.waitFor(() => expect(text()).toContain("发送失败"));
    io.input.write("/drop\n");
    await vi.waitFor(() => expect(text()).toContain("（已删除：「你好」）"));
    expect(existsSync(path)).toBe(false);
    io.input.write("/retry\n");
    await vi.waitFor(() => expect(text()).toContain("（没有发送失败的消息）"));
    expect(fake.commands).toHaveLength(1);
    io.input.write("/quit\n");
    await done;
  });
});

describe("ChatRenderer during a daemon restart", () => {
  it("says once that it is reconnecting, and does not repeat errors on every retry", () => {
    const r = renderer();
    r.chat.connection("connected");
    r.chat.connection("reconnecting");
    for (let i = 0; i < 5; i += 1) r.chat.protocolError(new Error("daemon 未运行。运行 plc daemon start。"));
    r.chat.connection("reconnecting");
    expect(r.text().match(/daemon 重启中，正在重连/g)).toHaveLength(1);
    expect(r.text()).not.toContain("plc daemon start");
  });

  it("shows a protocol error while connected", () => {
    const r = renderer();
    r.chat.connection("connected");
    r.chat.protocolError(new Error("unknown WebSocket message"));
    expect(r.text()).toContain("unknown WebSocket message");
  });
});
