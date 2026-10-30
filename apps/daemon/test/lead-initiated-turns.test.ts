// lead 是常驻的个人助理：它自己会被叫醒（blocker、即时通知、心跳、整理笔记）并开口说话。
// 这些回合以前只经过 plc.sock 的广播，plc chat 看得到，companion 看不到。plc 改走网关之后，
// 两个客户端都看不到了，开着的 plc 也不再算"有人在听"，lead 不播报，桌面通知反而变多。
// 这里固定新的行为：lead 自己发起的回合也是会话流里的一轮（originKind 以 system: 开头），
// 发给所有带 chat scope 的客户端；带 chat scope 的网关客户端算"有人在听"。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  addInbox, createItem, createPairing, listInbox, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { shortenDigestWait } from "./digest-wait.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-turns-");
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

type StubResponse = "text" | "empty" | "tools-only" | "error" | "hang" | "speak-then-error";

// 不调用模型的 lead：每次 prompt 按 response 说一句话、什么都不说，或者只调一个工具。
// plan 按 prompt 的内容逐次决定怎么回答，缺省总是 response。
function stubLead(
  fixed: StubResponse = "text",
  options: { steerRejects?: boolean; plan?: (prompt: string) => StubResponse; steerWaits?: boolean } = {},
) {
  let release: (() => void) | null = null;
  // steerWaits：steer 等到 releaseSteer() 才返回（插话被受理得晚）。
  let releaseSteerGate: (() => void) | null = null;
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const followUps: string[] = [];
  // 每次 prompt 时 lead 工具看到的两个轮次 id。
  const turnKeys: Array<{ prompt: string; current: string | null; budget: string | null | undefined }> = [];
  let deps: { currentTurnId?: () => string | null; cancelBudgetTurnId?: () => string | null } = {};
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async (args: typeof deps) => {
    deps = args;
    return {
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        const response = options.plan?.(message) ?? fixed;
        prompts.push(message);
        turnKeys.push({ prompt: message, current: deps.currentTurnId?.() ?? null, budget: deps.cancelBudgetTurnId?.() });
        if (response === "text") {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我看过了，" } });
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已经处理。" } });
        }
        if (response === "speak-then-error") {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我先看看" } });
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized", content: [] } });
        }
        if (response === "error") {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized", content: [] } });
        }
        if (response === "hang") await new Promise<void>((resolve) => { release = resolve; });
        if (response === "tools-only") {
          emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "list_tickets", args: {} });
          emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "list_tickets", args: {}, result: { content: [] }, isError: false });
        }
      },
      async steer() {
        if (options.steerWaits) await new Promise<void>((resolve) => { releaseSteerGate = resolve; });
        if (options.steerRejects) throw new Error("steer rejected");
      },
      async followUp(message: string) { followUps.push(message); },
      dispose() {},
    },
  };
  };
  return {
    factory, prompts, followUps, turnKeys, emit, release: () => release?.(), releaseSteer: () => releaseSteerGate?.(),
    budget: () => deps.cancelBudgetTurnId?.(),
  };
}

let currentLead: ReturnType<typeof stubLead> | null = null;

async function start(lead = stubLead()) {
  currentLead = lead;
  const desktop: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {},
    notifyDesktop: (text) => desktop.push(text),
  });
  return { desktop, lead };
}

// 一个用 v2 协议连着的客户端（companion 和 plc 都是这样连的）。缺省说自己有人在看（presence.set），
// 和前台的 companion、运行中的 plc chat 一样。
async function v2Client(
  name: string,
  scopes: string[] = ["chat", "tickets:view", "notices"],
  options: { attended?: boolean; autoPong?: boolean } = {},
) {
  const pairing = createPairing(db, { name, kind: "companion", scopes });
  const issued = redeemPairing(db, pairing.code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`,
    { autoPong: options.autoPong ?? true },
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  if (options.attended ?? true) {
    socket.send(JSON.stringify({ type: "presence.set", id: `presence-${name}`, protocolVersion: 2, attended: true }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === `presence-${name}`)).toBe(true));
  }
  const chat = (message: string) => socket.send(JSON.stringify({ type: "chat.send", id: `cmd-${name}`, protocolVersion: 2, message }));
  const presence = (attended: boolean) =>
    socket.send(JSON.stringify({ type: "presence.set", id: `presence-${name}-${attended}-${Date.now()}`, protocolVersion: 2, attended }));
  return { bindingId: issued.binding.id, events, chat, socket, presence };
}

function legacyToken(): string {
  const pairing = createPairing(db, { name: "legacy", kind: "companion", scopes: ["chat"] });
  return redeemPairing(db, pairing.code).accessToken;
}

function turnsWithOrigin(events: any[], originKind: string): string[] {
  return events
    .filter((event) => event.type === "lead.turn.started" && event.payload.originKind === originKind)
    .map((event) => event.turnId as string);
}

function text(events: any[], turnId: string): string {
  return events
    .filter((event) => event.type === "lead.message.delta" && event.turnId === turnId)
    .map((event) => event.payload.delta).join("");
}

function newImmediateNotification(title: string, createdAt = new Date()): number {
  const itemId = createItem(db, { title: `notice ${title}`, brief: "b", createdBy: "system" });
  db.prepare(
    `INSERT INTO notifications (item_id, kind, urgency, title, body, created_at)
     VALUES (?, 'terminal_handoff_failed', 'immediate', ?, '', ?)`,
  ).run(itemId, title, createdAt.toISOString());
  return itemId;
}

function notificationState(itemId: number) {
  return db.prepare("SELECT state, delivered_via FROM notifications WHERE item_id=?").get(itemId);
}

function newBlocker(summary: string): number {
  const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "system" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural", summary,
    payload: { kind: "unhandled_run_exception", runId: 7, detail: "decoder exploded" }, lossless: true,
  });
  return itemId;
}

describe("a blocker wake-up", () => {
  it("reaches every v2 chat client as a Lead turn, and no desktop notification fires", async () => {
    const { desktop, lead } = await start();
    const plc = await v2Client("plc");
    const companion = await v2Client("phone");
    newBlocker("工单 #1 的 Run #7 出现未捕获异常");

    for (const client of [plc, companion]) {
      await vi.waitFor(() => expect(turnsWithOrigin(client.events, SYSTEM_TURN_ORIGINS.blocker)).toHaveLength(1));
      const [turnId] = turnsWithOrigin(client.events, SYSTEM_TURN_ORIGINS.blocker);
      await vi.waitFor(() => expect(client.events.some((event) => (
        event.type === "lead.message.completed" && event.turnId === turnId
      ))).toBe(true));
      expect(text(client.events, turnId!)).toBe("我看过了，已经处理。");
      // 2026-10-15 起（Jarvis 模式）daemon 不再自己在会话里写 blocker 行：由 Lead 这一轮告诉用户。
      expect(turnsWithOrigin(client.events, SYSTEM_TURN_ORIGINS.blockerNotice)).toEqual([]);
      for (const event of client.events.filter((event) => event.turnId === turnId)) {
        expect(event.audienceBindingId).toBeNull();
      }
    }
    expect(lead.prompts.some((prompt) => prompt.includes("出现未捕获异常"))).toBe(true);
    expect(desktop).toEqual([]);
    expect(db.prepare(
      "SELECT origin_binding_id, user_text, state FROM channel_turns WHERE origin_kind=?",
    ).all(SYSTEM_TURN_ORIGINS.blocker)).toEqual([{ origin_binding_id: null, user_text: "", state: "completed" }]);
    await vi.waitFor(() => expect(listInbox(db, { state: ["consumed"] })).toHaveLength(1));
  });

  // 2026-10-15 起（Jarvis 模式）系统自己不弹桌面通知：Lead 知道用户不在，由它决定要不要推。
  it("tells Lead the user is away when no connected client has the chat scope, and pushes nothing itself", async () => {
    const { desktop, lead } = await start();
    await v2Client("viewer", ["tickets:view"]);
    newBlocker("没人在聊天时的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("没人在聊天时的 blocker"))).toBe(true));
    expect(lead.prompts.find((prompt) => prompt.includes("没人在聊天时的 blocker"))).toContain("用户此刻不在");
    expect(desktop).toEqual([]);
  });

  it("leaves no empty turn behind when the lead says nothing", async () => {
    const { lead } = await start(stubLead("empty"));
    const plc = await v2Client("plc");
    newBlocker("lead 没开口");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("lead 没开口"))).toBe(true));
    await vi.waitFor(() => expect(listInbox(db, { state: ["consumed"] })).toHaveLength(1));
    expect(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.blocker)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind=?").get(SYSTEM_TURN_ORIGINS.blocker))
      .toEqual({ n: 0 });
    expect(plc.events.some((event) => event.type === "notice.created")).toBe(false);
  });

  it("completes a turn that only called tools, instead of failing it as an empty reply", async () => {
    await start(stubLead("tools-only"));
    const plc = await v2Client("plc");
    newBlocker("lead 只查了一下");
    await vi.waitFor(() => expect(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.blocker)).toHaveLength(1));
    const [turnId] = turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.blocker);
    await vi.waitFor(() => expect(db.prepare("SELECT state, error FROM channel_turns WHERE id=?").get(turnId))
      .toEqual({ state: "completed", error: null }));
    expect(plc.events.some((event) => event.type === "lead.tool.started" && event.turnId === turnId)).toBe(true);
    expect(plc.events.some((event) => event.type === "notice.created")).toBe(false);
  });

  it("shows a failed Lead turn when the model call fails", async () => {
    await start(stubLead("error"));
    const plc = await v2Client("plc");
    newBlocker("模型连不上时的 blocker");
    await vi.waitFor(() => expect(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.blocker)).toHaveLength(1));
    const [turnId] = turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.blocker);
    await vi.waitFor(() => expect(plc.events.find((event) => event.type === "notice.created" && event.turnId === turnId))
      .toMatchObject({ audienceBindingId: null, payload: { message: "401 Unauthorized" } }));
    expect(db.prepare("SELECT state FROM channel_turns WHERE id=?").get(turnId)).toEqual({ state: "failed" });
  });
});

describe("a user who steers into a turn the lead started itself", () => {
  it("gets the lead's tool calls and reply in their own turn, and no system turn is left behind", async () => {
    const lead = stubLead("hang");
    await start(lead);
    const plc = await v2Client("plc");
    const companion = await v2Client("phone");
    newBlocker("插话之前的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("系统检测到新的异常"))).toBe(true));
    plc.chat("先别管它，告诉我 #3 怎么样了");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.turn.started" && event.payload.mode === "steered"))
      .toBe(true));
    const steeredTurn = plc.events.find((event) => event.type === "lead.turn.started" && event.payload.mode === "steered")!.turnId;

    lead.emit({ type: "tool_execution_start", toolCallId: "call-steer", toolName: "get_ticket", args: { ticket_id: 3 } });
    lead.emit({ type: "tool_execution_end", toolCallId: "call-steer", toolName: "get_ticket", args: { ticket_id: 3 }, result: { content: [] }, isError: false });
    lead.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "#3 在跑。" } });
    lead.release();

    await vi.waitFor(() => expect(db.prepare("SELECT state, assistant_text FROM channel_turns WHERE id=?").get(steeredTurn))
      .toEqual({ state: "completed", assistant_text: "#3 在跑。" }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind=?").get(SYSTEM_TURN_ORIGINS.blocker))
      .toEqual({ n: 0 });
    expect(plc.events.some((event) => event.type === "lead.tool.started" && event.turnId === steeredTurn)).toBe(true);
    // 插话那一轮的工具和回答只发给插话的人。
    const leaked = companion.events.filter((event) => event.type.startsWith("lead.") && event.turnId === steeredTurn);
    expect(leaked).toEqual([]);
  });
});

describe("what counts as voiced", () => {
  // 用户在看时 Lead 一言不发：不算送达，退避后再请 Lead 说（2026-10-15 起不再按计时器兜底推送）。
  it("not a silent turn: the notification stays pending and Lead is asked again", async () => {
    vi.stubEnv("PLC_NOTIFY_RETRY_BASE_MS", "50");
    const { lead } = await start(stubLead("empty"));
    await v2Client("plc");
    const itemId = newImmediateNotification("lead 没出声的通知");
    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("lead 没出声的通知")).length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(notificationState(itemId)).toEqual({ state: "pending", delivered_via: null });
  });

  it("not a follow-up queued into a busy turn: the notification waits for the lead to be free", async () => {
    const lead = stubLead("hang");
    await start(lead);
    const plc = await v2Client("plc");
    plc.chat("帮我看看 #3");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("帮我看看 #3"))).toBe(true));
    const itemId = newImmediateNotification("lead 忙时来的通知");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lead.followUps).toEqual([]);
    expect(notificationState(itemId)).toEqual({ state: "pending", delivered_via: null });
    lead.release();
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("lead 忙时来的通知"))).toBe(true));
  });

  // Lead 说了、可是没人在看：用户回来时会话里就有 Lead 的话，记为 lead 已送达，不再说第二遍。
  it("voiced while nobody was looking: delivered by Lead when someone comes back, not voiced again", async () => {
    const lead = stubLead("hang");
    const { desktop } = await start(lead);
    const plc = await v2Client("plc");
    const itemId = newImmediateNotification("没人看时播报的通知");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("没人看时播报的通知"))).toBe(true));
    // 播报到一半，用户把标签页切到后台。
    plc.presence(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    lead.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "有一条通知：交接失败。" } });
    lead.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notificationState(itemId)).toEqual({ state: "pending", delivered_via: null });
    // 用户回来了：不再播报第二遍。
    plc.presence(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lead.prompts.filter((prompt) => prompt.includes("没人看时播报的通知"))).toHaveLength(1);
    await vi.waitFor(() => expect(notificationState(itemId)).toEqual({ state: "delivered", delivered_via: "lead" }), { timeout: 3_000 });
    expect(desktop).toEqual([]);
  });
});

describe("who counts as listening", () => {
  // 后台标签页不算在看：Lead 收到的是「用户不在」，由它决定要不要推（2026-10-15 起系统自己不弹桌面）。
  it("not a hidden tab: Lead is told the user is away and decides about the notification", async () => {
    const { desktop, lead } = await start();
    await v2Client("background-tab", undefined, { attended: false });
    newBlocker("后台标签页时的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("后台标签页时的 blocker"))).toBe(true));
    expect(lead.prompts.find((prompt) => prompt.includes("后台标签页时的 blocker"))).toContain("用户此刻不在");
    const itemId = createItem(db, { title: "hidden", brief: "b", createdBy: "system" });
    db.prepare(
      `INSERT INTO notifications (item_id, kind, urgency, title, body, created_at)
       VALUES (?, 'terminal_handoff_failed', 'immediate', ?, '', ?)`,
    ).run(itemId, "没人在看时的通知", new Date().toISOString());
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("没人在看时的通知"))).toBe(true));
    expect(lead.prompts.find((prompt) => prompt.includes("没人在看时的通知"))).toContain("他现在不在会话里");
    // 没人在看就不算 lead 已送达：用户回来时才算。
    expect(db.prepare("SELECT state FROM notifications WHERE item_id=?").get(itemId)).toEqual({ state: "pending" });
    expect(desktop).toEqual([]);
  });

  it("not a half-open socket that stopped answering pings", async () => {
    vi.stubEnv("PLC_GATEWAY_HEARTBEAT_MS", "50");
    const { desktop } = await start();
    const stale = await v2Client("stale-phone", undefined, { autoPong: false });
    expect((await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/health`)).json())).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(sockets.find((socket) => socket.readyState === WebSocket.CLOSED)).toBeDefined(), { timeout: 2_000 });
    expect(stale.events.some((event) => event.type === "hello.v2")).toBe(true);
    newBlocker("半开连接时的 blocker");
    // 半开的连接不算在看：Lead 收到的是「用户不在」。
    const lead = currentLead!;
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("半开连接时的 blocker"))).toBe(true));
    expect(lead.prompts.find((prompt) => prompt.includes("半开连接时的 blocker"))).toContain("用户此刻不在");
    expect(desktop).toEqual([]);
  });
});

describe("a system turn that fails while a user's steer waits", () => {
  it("does not leave a failed system turn behind", async () => {
    const lead = stubLead("hang");
    await start(lead);
    const plc = await v2Client("plc");
    newBlocker("插话之后失败的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("系统检测到新的异常"))).toBe(true));
    plc.chat("先别管它");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.turn.started" && event.payload.mode === "steered"))
      .toBe(true));
    lead.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized", content: [] } });
    lead.release();
    await vi.waitFor(() => expect(lead.prompts.length).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind=?").get(SYSTEM_TURN_ORIGINS.blocker))
      .toEqual({ n: 0 });
  });

  // 失败不落成系统回合，所以要落在插话那一轮上：插话的人看得到错误，那一轮也不会一直停在 steered。
  // 用一个不会自动重试的错误：断网和模型服务暂时连不上时，用户的插话会等一次自动重试（user-turn-retry.test.ts）。
  it("fails the steer with the error, and tells the client that steered", async () => {
    const lead = stubLead("hang");
    await start(lead);
    const plc = await v2Client("plc");
    const other = await v2Client("other");
    newBlocker("插话之后失败的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("系统检测到新的异常"))).toBe(true));
    plc.chat("先别管它");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.turn.started" && event.payload.mode === "steered"))
      .toBe(true));
    const steerId = plc.events.find((event) => event.type === "lead.turn.started" && event.payload.mode === "steered").turnId;
    lead.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model rejected the request: prompt is too long", content: [] } });
    lead.release();
    await vi.waitFor(() => expect(db.prepare("SELECT state, error FROM channel_turns WHERE id=?").get(steerId))
      .toEqual({ state: "failed", error: expect.stringContaining("prompt is too long") }));
    await vi.waitFor(() => expect(plc.events.filter((event) => event.type === "notice.created" && event.turnId === steerId))
      .toEqual([expect.objectContaining({ audienceBindingId: plc.bindingId, payload: expect.objectContaining({ severity: "error" }) })]));
    expect(other.events.filter((event) => event.type === "notice.created" && event.turnId === steerId)).toEqual([]);
  });

  // steer 晚于失败返回时，不能把已经失败的插话改回 steered。
  it("keeps the steer failed when the lead accepts the steer only after the turn failed", async () => {
    const lead = stubLead("hang", { steerWaits: true });
    await start(lead);
    const plc = await v2Client("plc");
    newBlocker("插话之后失败的 blocker");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("系统检测到新的异常"))).toBe(true));
    plc.chat("先别管它");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.turn.started" && event.payload.mode === "steered"))
      .toBe(true));
    const steerId = plc.events.find((event) => event.type === "lead.turn.started" && event.payload.mode === "steered").turnId;
    lead.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model rejected the request: prompt is too long", content: [] } });
    lead.release();
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE id=?").get(steerId)).toEqual({ state: "failed" }));
    lead.releaseSteer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.prepare("SELECT state FROM channel_turns WHERE id=?").get(steerId)).toEqual({ state: "failed" });
  });
});

describe("immediate notifications", () => {
  it("are voiced by the lead when only a v2 chat client is listening", async () => {
    const { desktop } = await start();
    const plc = await v2Client("plc");
    const itemId = createItem(db, { title: "immediate notice", brief: "b", createdBy: "system" });
    db.prepare(
      `INSERT INTO notifications (item_id, kind, urgency, title, body, created_at)
       VALUES (?, 'terminal_handoff_failed', 'immediate', ?, ?, ?)`,
    ).run(itemId, `工单 #${itemId} 运行结束，但交接失败`, "必须马上告知用户", new Date().toISOString());
    await vi.waitFor(() => expect(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.notification)).toHaveLength(1));
    await vi.waitFor(() => expect(db.prepare("SELECT state, delivered_via FROM notifications WHERE item_id=?").get(itemId))
      .toEqual({ state: "delivered", delivered_via: "lead" }));
    expect(desktop).toEqual([]);
  });

  it("keep one turn per notification even when the lead speaks before failing, and back off", async () => {
    vi.stubEnv("PLC_NOTIFY_RETRY_BASE_MS", "200");
    const { lead } = await start(stubLead("speak-then-error"));
    const plc = await v2Client("plc");
    const legacy = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${legacyToken()}`);
    sockets.push(legacy);
    const legacyNotices: string[] = [];
    legacy.on("message", (raw) => { const message = JSON.parse(String(raw)); if (message.type === "notice") legacyNotices.push(message.text); });
    const itemId = newImmediateNotification("模型故障期间的通知");
    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("模型故障期间的通知")).length)
      .toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const attempts = lead.prompts.filter((prompt) => prompt.includes("模型故障期间的通知")).length;
    // 轮询每 20 毫秒一次；不退避的话这段时间里会重试几十次。
    expect(attempts).toBeLessThanOrEqual(4);
    const rows = db.prepare("SELECT id, state FROM channel_turns WHERE origin_kind=?").all(SYSTEM_TURN_ORIGINS.notification) as Array<{ id: string; state: string }>;
    expect(rows).toEqual([{ id: expect.any(String), state: "failed" }]);
    expect(new Set(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.notification))).toEqual(new Set([rows[0]!.id]));
    expect(notificationState(itemId)).toEqual({ state: "pending", delivered_via: null });
    // 旧版 v1 连接收到的 [error] 广播限流：同一句话不反复推。
    expect(legacyNotices.filter((text) => text.startsWith("[error]")).length).toBeLessThanOrEqual(1);
  });

  // 重试复用同一轮时，这一轮是现在开始的：排到会话流的末尾，不留在第一次失败的位置。
  it("move a retried notification turn to the end of the conversation", async () => {
    vi.stubEnv("PLC_NOTIFY_RETRY_BASE_MS", "300");
    await start(stubLead("speak-then-error"));
    await v2Client("plc");
    newImmediateNotification("要重试的通知");
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE origin_kind=?")
      .get(SYSTEM_TURN_ORIGINS.notification)).toEqual({ state: "failed" }));
    const first = db.prepare("SELECT id, created_at FROM channel_turns WHERE origin_kind=?")
      .get(SYSTEM_TURN_ORIGINS.notification) as { id: string; created_at: string };
    await vi.waitFor(() => expect((db.prepare("SELECT created_at FROM channel_turns WHERE id=?").get(first.id) as { created_at: string })
      .created_at > first.created_at).toBe(true), { timeout: 5_000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind=?").get(SYSTEM_TURN_ORIGINS.notification))
      .toEqual({ n: 1 });
  });

  // 一条通知从第一次播报起就固定在一轮里：重试时只和同一轮的通知一起播，新通知另开一轮。
  // 否则"旧通知（已有一轮）+ 新通知"会合成新的一轮，旧通知就有了两轮失败。
  it("keep each notification in one turn when a new notification arrives during the backoff", async () => {
    vi.stubEnv("PLC_NOTIFY_RETRY_BASE_MS", "150");
    const lead = stubLead("speak-then-error", { plan: (prompt) => (prompt.includes("先聊点别的") ? "hang" : "speak-then-error") });
    await start(lead);
    const plc = await v2Client("plc");
    newImmediateNotification("旧通知");
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE origin_kind=?")
      .get(SYSTEM_TURN_ORIGINS.notification)).toEqual({ state: "failed" }));
    // lead 忙着回答用户时，旧通知的重试时间到了，新通知也来了：两条同时等着。
    plc.chat("先聊点别的");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("先聊点别的"))).toBe(true));
    newImmediateNotification("新通知");
    await new Promise((resolve) => setTimeout(resolve, 300));
    lead.release();
    // 只看通知本身那一行（[#编号] 标题）：每一轮开头的当前局面会列出通知所在的工单，标题也在里面（工单 04）。
    const listed = (prompt: string, title: string) => new RegExp(`\\[#\\d+\\] ${title}`, "u").test(prompt);
    await vi.waitFor(() => {
      const notificationPrompts = lead.prompts.filter((prompt) => prompt.includes("必须立即告知用户"));
      expect(notificationPrompts.some((prompt) => listed(prompt, "新通知"))).toBe(true);
      expect(notificationPrompts.filter((prompt) => listed(prompt, "旧通知")).length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5_000 });
    // 每次播报的 prompt 和它落成的那一轮按顺序一一对应（lead 每次都先开口）。
    const notificationPrompts = lead.prompts.filter((prompt) => prompt.includes("必须立即告知用户"));
    const turnIds = turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.notification).slice(0, notificationPrompts.length);
    const turnsOf = (title: string) => new Set(notificationPrompts.flatMap((prompt, index) => (listed(prompt, title) ? [turnIds[index]] : [])));
    expect(turnsOf("旧通知").size).toBe(1);
    expect(turnsOf("新通知").size).toBe(1);
    expect([...turnsOf("旧通知")][0]).not.toBe([...turnsOf("新通知")][0]);
  });

  // 2026-10-15 起不再按计时器兜底：只有 Lead 不能工作时，daemon 把积压的事汇总成一条发给聊天客户端。
  it("reach chat clients in the fallback summary when Lead cannot work", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "0");
    const itemId = createItem(db, { title: "late notice", brief: "b", createdBy: "system" });
    db.prepare(
      `INSERT INTO notifications (item_id, kind, urgency, title, body, created_at)
       VALUES (?, 'terminal_handoff_failed', 'immediate', ?, '', ?)`,
    ).run(itemId, "没人播报的通知", new Date(Date.now() - 60_000).toISOString());
    const { desktop } = await start(stubLead("error"));
    await vi.waitFor(() => expect(desktop.some((text) => text.startsWith("Paimon 离线 "))).toBe(true));
    const [summary] = db.prepare("SELECT assistant_text, state, origin_binding_id FROM channel_turns WHERE origin_kind=?")
      .all(SYSTEM_TURN_ORIGINS.fallbackNotice) as Array<{ assistant_text: string; state: string; origin_binding_id: string | null }>;
    expect(summary).toMatchObject({ state: "completed", origin_binding_id: null });
    expect(summary!.assistant_text).toContain("没人播报的通知");
  });
});

describe("the digest round", () => {
  it("is a Lead turn that every chat client sees", async () => {
    vi.stubEnv("PLC_HEARTBEAT_MS", "100");
    shortenDigestWait(db, 1);
    await start();
    const plc = await v2Client("plc");
    addInbox(db, { dedupScope: "heartbeat-test", severity: "attention", source: "structural", summary: "积压的提醒" });
    await vi.waitFor(() => expect(turnsWithOrigin(plc.events, SYSTEM_TURN_ORIGINS.digest).length).toBeGreaterThan(0));
  });
});

describe("the cancel budget", () => {
  it("is not reset by a turn the lead started itself", async () => {
    const { lead } = await start();
    const plc = await v2Client("plc");
    plc.chat("把 #3 和 #4 取消掉");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.message.completed")).toBe(true));
    const userTurn = lead.turnKeys.find((key) => key.prompt.includes("把 #3 和 #4 取消掉"))!;
    expect(userTurn.budget).toBe(userTurn.current);
    newBlocker("无人值守时的 blocker");
    await vi.waitFor(() => expect(lead.turnKeys.some((key) => key.prompt.includes("系统检测到新的异常"))).toBe(true));
    const systemTurn = lead.turnKeys.find((key) => key.prompt.includes("系统检测到新的异常"))!;
    // 唤醒回合按最近一次用户发起的轮次计数，不新开预算。
    expect(systemTurn.budget).toBe(userTurn.current);
  });
});

describe("a steer that does not land", () => {
  it("does not reset the cancel budget", async () => {
    const lead = stubLead("hang", { steerRejects: true });
    await start(lead);
    const plc = await v2Client("plc");
    plc.chat("先取消 #3");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("先取消 #3"))).toBe(true));
    const before = lead.budget();
    expect(before).toBeTruthy();
    plc.socket.send(JSON.stringify({ type: "chat.send", id: "cmd-steer", protocolVersion: 2, message: "再取消 #4" }));
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE user_text=?").get("再取消 #4"))
      .toEqual({ state: "failed" }));
    expect(lead.budget()).toBe(before);
    lead.release();
  });
});

describe("user-originated turns", () => {
  it("stay with the binding that sent them", async () => {
    await start();
    const plc = await v2Client("plc");
    const companion = await v2Client("phone");
    plc.chat("你好");
    await vi.waitFor(() => expect(plc.events.some((event) => event.type === "lead.message.completed")).toBe(true));
    expect(companion.events.filter((event) => event.type.startsWith("lead."))).toEqual([]);
  });
});
