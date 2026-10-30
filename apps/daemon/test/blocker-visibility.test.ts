// 每一条 blocker 都要在会话里看得见，并且不会被一轮不说话的内部回合吞掉。
// 发布评审 2340cac 的发现 A：
//   · 有些 blocker 只有一行 inbox（派发重试用完 dispatch.ts、reviewer 重试用完 orchestrator.ts 等），没有通知也没有卡片；
//   · 2340cac 去掉了 daemon 的「🔴」那一行，整理笔记从不发消息，可 runTurn 照样把 inbox 灌进这一轮、成功后记为 consumed；
//     Lead 正忙时来的 blocker 也被 followUp 进当前这一轮。整理笔记正在跑时来一条这样的 blocker，Lead 的回答被丢掉，
//     这一行被消费，blockerCount 回到 0，用户什么都看不到。
//   · Lead 的模型连不上时，这类 blocker 只剩一句泛泛的"这次没能处理新的 blocker；系统会自动再试"。
// 复审 e18958f 的遗留：那一行只在轮询还看到 pending 时才写。别的 Lead 回合（播报通知、用户的一轮、心跳巡检）
// 一开始就把所有 inbox 行记为 delivered；同一个 tick 里播报通知又排在 blocker 扫描前面，这一行就没了。
// followUp 进一轮正在跑的回合时，SDK 在排进队列时就返回，那一行当场记为 consumed，那一轮后来失败也一样。
// 2026-10-15 用户决定（Jarvis 模式）：事件都先交给 Lead，由 Lead 决定怎样告诉用户；daemon 不再自己在会话里写
// blocker 行。Lead 不能工作时，daemon 发一条兜底汇总（system:fallback-notice）。这里留下的是仍然成立的规则：
// 没处理完的事不被消费、照样算「需要你」，整理笔记不消费 inbox，NO_REPLY 不留痕迹。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ticketNeedsUser } from "@pi-lead-child/protocol";
import {
  addInbox, createItem, createPairing, listInbox, openDb, raiseBlocker, redeemPairing, transition, type Db,
} from "@pi-lead-child/store";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { situationIn } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-blocker-visible-");
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

type Mode = "healthy" | "down";

// 不调用模型的 Lead。整理笔记那一轮挂起，直到 releaseNotes()。contextFull：每一轮之后都会安排整理笔记。
// hold：符合条件的那一轮挂起，直到 releaseHeld()；放开以后那一轮失败（模型返回 503），heldSucceeds 时成功。
function stubLead(
  mode: Mode,
  options: {
    contextFull?: boolean; onPrompt?: (message: string) => void; reply?: string;
    hold?: (message: string) => boolean; heldSucceeds?: boolean;
  } = {},
) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const followUps: string[] = [];
  let releaseNotes: (() => void) | null = null;
  let releaseHeld: (() => void) | null = null;
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async () => ({
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
        options.onPrompt?.(message);
        if (message.includes("沉淀检查")) await new Promise<void>((resolve) => { releaseNotes = resolve; });
        const held = options.hold?.(message) ?? false;
        if (held) await new Promise<void>((resolve) => { releaseHeld = resolve; });
        if (mode === "down" || (held && !options.heldSucceeds)) {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503: auth_unavailable", content: [] } });
          return;
        }
        const text = message.includes("沉淀检查") ? "NO_REPLY" : options.reply ?? "我看过了，这就处理。";
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
      },
      async steer() {},
      async followUp(message: string) { followUps.push(message); },
      dispose() {},
    },
  });
  return {
    factory, prompts, followUps,
    releaseNotes: () => releaseNotes?.(),
    releaseHeld: () => releaseHeld?.(),
    held: () => releaseHeld !== null,
  };
}

// 一个有人在看的 companion（v2 协议、chat scope、presence 为 attended）。
async function viewer() {
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"],
  }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === "presence")).toBe(true));
}

let currentLead: ReturnType<typeof stubLead> | null = null;

async function start(lead: ReturnType<typeof stubLead>) {
  currentLead = lead;
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {} });
}

// 派发重试用完时 dispatch.ts 写下的那种 blocker：只有一行 inbox，没有通知，也没有卡片。
function bareBlocker(): number {
  const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "dispatch exhausted" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural",
    summary: `工单 #${itemId} 执行重试已耗尽（执行失败 2/2），已停止派发。`,
  });
  return itemId;
}

// orchestrator.ts 在 reviewer 重试用完时写下的那种 blocker：只有一行 inbox，工单的 stage 不变（还是 active）。
// 它不在 blocked，「需要你」只能靠这一行没被消费。
function reviewerExhausted(): number {
  const itemId = createItem(db, { title: "核查迁移", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural",
    summary: `工单 #${itemId} reviewer 重试已耗尽（1/1）`,
  });
  return itemId;
}

// Run 第二次崩溃时 raiseBlocker 写下的 blocker：inbox 一行，外加一条立即播报的通知。
function crashBlocker(): number {
  const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "run crashed" });
  raiseBlocker(db, {
    itemId, code: "run_crashed", title: "Run crashed", summary: "reviewer 进程第二次退出", source: "structural",
  });
  return itemId;
}

function noticesFor(itemId: number) {
  return notices().filter((row) => row.assistant_text.startsWith(`工单 #${itemId} `));
}

async function needsUser(itemId: number) {
  const ticket = (await readGatewayTickets(db)).find((candidate) => candidate.id === itemId)!;
  return { blockerCount: ticket.attention.blockerCount, reason: ticketNeedsUser(ticket) };
}

function fallbackSummaries(): string[] {
  return (db.prepare("SELECT assistant_text FROM channel_turns WHERE origin_kind='system:fallback-notice'").all() as
    Array<{ assistant_text: string }>).map((row) => row.assistant_text);
}

function notices() {
  return db.prepare("SELECT assistant_text FROM channel_turns WHERE origin_kind='system:blocker-notice'").all() as
    Array<{ assistant_text: string }>;
}

function inboxStates(itemId: number): string[] {
  return listInbox(db, {}).filter((row) => row.item_id === itemId).map((row) => row.state);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("a blocker with neither a notification nor a card", () => {
  it("goes to Lead, and the daemon writes no line of its own while Lead works", async () => {
    const lead = stubLead("healthy");
    await start(lead);
    const itemId = bareBlocker();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
    await settle();
    expect(notices()).toEqual([]);
    expect(inboxStates(itemId)).toEqual(["consumed"]);
  });

  it("stays counted while Lead's model is down, and reaches the user in the fallback summary", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "0");
    const lead = stubLead("down");
    await start(lead);
    const itemId = bareBlocker();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
    await vi.waitFor(() => expect(fallbackSummaries().some((text) => text.includes(`工单 #${itemId}「迁移脚本」：执行重试已耗尽`))).toBe(true));
    // Lead 没能处理它：这一行没有被消费，工单仍然算"需要你"。
    expect(inboxStates(itemId)).not.toContain("consumed");
    const ticket = (await readGatewayTickets(db)).find((candidate) => candidate.id === itemId)!;
    expect(ticket.attention.blockerCount).toBe(1);
    expect(ticketNeedsUser(ticket)).toBe("blocked");
  });
});

describe("a child's exhausted reviewer, recorded on its parent", () => {
  it("names both the parent and the child ticket", async () => {
    await start(stubLead("healthy"));
    const leadOf = () => currentLead!;
    const parent = createItem(db, { title: "迁移（父工单）", brief: "b", createdBy: "user" });
    const child = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user", parentItemId: parent } as never);
    // orchestrator.ts:92 的写法：行记在父工单上，摘要点名子工单。
    addInbox(db, { itemId: parent, severity: "blocker", source: "structural", summary: `工单 #${child} reviewer 重试已耗尽（1/1）` });

    // Lead 读到的那一件事写着它记在哪张工单上，也写着子工单。
    const lead = leadOf();
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("reviewer 重试已耗尽"))).toBe(true));
    const line = lead.prompts.find((prompt) => prompt.includes("reviewer 重试已耗尽"))!;
    expect(line).toContain(`记在工单 #${parent}`);
    expect(line).toContain(`工单 #${child} reviewer 重试已耗尽`);
  });
});

describe("a blocker that another Lead turn takes first", () => {
  it("goes to Lead with the other blocker in the same tick, and Lead voices the notification", async () => {
    const lead = stubLead("healthy");
    await start(lead);
    await viewer();
    // 同一个 tick：Run 第二次崩溃的 blocker（有通知），和 reviewer 重试用完的 blocker（没有通知）。
    const crashed = crashBlocker();
    const exhausted = reviewerExhausted();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("reviewer 重试已耗尽"))).toBe(true));
    await settle();
    // daemon 不自己写行：两件事都交给 Lead，有通知的那条由 Lead 播报。
    expect(noticesFor(crashed)).toEqual([]);
    expect(noticesFor(exhausted)).toEqual([]);
    // 工单 04：两件事在同一轮交给 Lead（处理 blocker 的那一轮排在播报通知前面），Lead 在那一轮里说了，
    // 有人在看：崩溃的那条通知算 Lead 送到了，不再单独播一遍。
    const both = lead.prompts.find((prompt) => prompt.includes("reviewer 重试已耗尽"))!;
    expect(both).toContain("reviewer 进程第二次退出");
    expect(db.prepare("SELECT state, delivered_via FROM notifications WHERE item_id=?").all(crashed))
      .toEqual([{ state: "delivered", delivered_via: "lead" }]);
  });

  it("stays counted when that turn fails because the model is down", async () => {
    const lead = stubLead("down");
    await start(lead);
    await viewer();
    crashBlocker();
    const exhausted = reviewerExhausted();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("reviewer 重试已耗尽"))).toBe(true));
    await settle();
    expect(inboxStates(exhausted)).not.toContain("consumed");
    expect(await needsUser(exhausted)).toEqual({ blockerCount: 1, reason: "blocked" });
  });

  // 工单 04（spec D6）：Lead 正忙时来的 blocker（tell 级）不再 followUp 进正在跑的那一轮，而是排队，
  // 那一轮结束以后单独开一轮交给 Lead。下面两条守住的规则不变：没处理完的不被消费，照样算「需要你」。
  it("waits for a turn of its own while Lead is busy, and is not consumed when that turn fails", async () => {
    vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50");
    // 第一条 blocker 叫醒 Lead，那一轮挂起；第二条在它跑的时候到，排队；那一轮失败，之后带着两条再开的一轮也失败。
    const lead = stubLead("healthy", { hold: (message) => message.includes("系统检测到新的异常") });
    await start(lead);
    bareBlocker();
    await vi.waitFor(() => expect(lead.held()).toBe(true));
    const exhausted = reviewerExhausted();
    await settle();
    expect(lead.followUps).toEqual([]);
    expect(inboxStates(exhausted)).toEqual(["pending"]);

    lead.releaseHeld();
    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("reviewer 重试已耗尽"))).toHaveLength(1));
    await vi.waitFor(() => expect(lead.held()).toBe(true));
    lead.releaseHeld();
    await vi.waitFor(() => expect(
      db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind='system:blocker' AND state='failed'").get(),
    ).toEqual({ n: 2 }));
    await settle();
    expect(inboxStates(exhausted)).not.toContain("consumed");
    expect(await needsUser(exhausted)).toEqual({ blockerCount: 1, reason: "blocked" });
  });

  it("is handed to Lead in a turn of its own after the busy turn, and consumed when that turn succeeds", async () => {
    const lead = stubLead("healthy", {
      hold: (message) => message.includes("系统检测到新的异常"), heldSucceeds: true,
    });
    await start(lead);
    bareBlocker();
    await vi.waitFor(() => expect(lead.held()).toBe(true));
    const exhausted = reviewerExhausted();
    await settle();
    // 那一轮还没结束：第二条排着队，还没交给 Lead。
    expect(inboxStates(exhausted)).toEqual(["pending"]);
    expect(lead.prompts.some((prompt) => prompt.includes("reviewer 重试已耗尽"))).toBe(false);

    lead.releaseHeld();
    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("reviewer 重试已耗尽"))).toHaveLength(1));
    await vi.waitFor(() => expect(lead.held()).toBe(true));
    lead.releaseHeld();
    await vi.waitFor(() => expect(inboxStates(exhausted)).toEqual(["consumed"]));
  });
});

describe("a Lead turn that answers a blocker with NO_REPLY", () => {
  it("posts no turn, and the literal NO_REPLY appears nowhere", async () => {
    const lead = stubLead("healthy", { reply: "NO_REPLY" });
    await start(lead);
    const itemId = bareBlocker();

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
    await settle();
    const texts = (db.prepare("SELECT origin_kind, assistant_text FROM channel_turns").all() as
      Array<{ origin_kind: string; assistant_text: string }>);
    expect(texts.map((row) => row.origin_kind)).toEqual([]);
    expect(texts.some((row) => row.assistant_text.includes("NO_REPLY"))).toBe(false);
    expect(inboxStates(itemId)).toEqual(["consumed"]);
  });
});

describe("a note-keeping turn", () => {
  it("neither drains nor consumes the inbox, and gets no blocker follow-up", async () => {
    let attentionAdded = false;
    const lead = stubLead("healthy", {
      contextFull: true,
      // 第一轮（处理 blocker）正在跑时，又来了一条 attention：它在整理笔记开始时还没被消化。
      onPrompt: (message) => {
        if (attentionAdded || message.includes("沉淀检查")) return;
        attentionAdded = true;
        const milestone = createItem(db, { title: "周报", brief: "b", createdBy: "user" });
        addInbox(db, { itemId: milestone, severity: "attention", source: "structural", summary: "一条还没消化的 attention" });
      },
    });
    await start(lead);
    bareBlocker();
    // 这一轮之后上下文到了 90%，daemon 安排整理笔记，它挂起。
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("沉淀检查"))).toBe(true));
    const notesPrompt = lead.prompts.find((prompt) => prompt.includes("沉淀检查"))!;
    expect(notesPrompt).not.toContain("一条还没消化的 attention");

    // 整理笔记还在跑时，来了一条只有 inbox 的 blocker：不 followUp 进这一轮，也先不动它。
    const itemId = bareBlocker();
    await settle();
    expect(lead.followUps).toEqual([]);
    expect(inboxStates(itemId)).toEqual(["pending"]);

    lead.releaseNotes();
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes(`工单 #${itemId} 执行重试已耗尽`))).toBe(true));
    // 整理笔记没有消费那条 attention：它写在下一轮普通的 Lead 回合开头的当前局面里（工单 04：digest 级的事只在当前局面里）。
    const attention = listInbox(db, {}).find((row) => row.summary.includes("一条还没消化的 attention"))!;
    expect(lead.prompts.filter((prompt) => prompt.includes("一条还没消化的 attention"))).toHaveLength(1);
    const next = lead.prompts.find((prompt) => prompt.includes("一条还没消化的 attention"))!;
    expect(next).not.toContain("沉淀检查");
    expect(situationIn(next)).toContain("一条还没消化的 attention");
    expect(attention.state).not.toBe("pending");
  });
});
