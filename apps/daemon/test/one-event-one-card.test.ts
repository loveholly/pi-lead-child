// 一件事在会话里只出现一次，说法也不打架。实例上 #66 的一次工单对话失败出现了四次：
//   · 工单消息的回执「处理失败」；
//   · 「系统更新 · 需要介入 · Run crashed」检查点卡片（旁边写着 Needs none）；
//   · 「系统通知 ⏰ 工单 #66 阻塞」（影响：无法继续；下一步：不改变工单执行状态）；
//   · Lead 自己的解释。
// 工单对话失败只是这一句话没答上：回执就是那一张卡片。它不是 blocker，不发通知，不写检查点，不叫醒 Lead。
// 真正的 blocker 也只说一次：Lead 的那一轮。daemon 不再另贴一条「🔴」，Lead 说过的通知不再兜底重贴一遍。
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ticketNeedsUser } from "@pi-lead-child/protocol";
import {
  createItem, createPairing, createRun, ensureCheckpointCard, insertCheckpointWithResult, listInbox, openDb, raiseBlocker,
  raiseBlockerFromCheckpoint, redeemPairing, updateRun, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-one-card-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_SCHEDULER_MS", "50");
  vi.stubEnv("PLC_NOTIFY_FALLBACK_MS", "200");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 不调用模型的 Lead：每次被叫醒都说一句话。failing 为真时模型一直不可用（实例上的 503）。
function stubLead(failing = false) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        if (failing) {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503: auth_unavailable", content: [] } });
          return;
        }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我看过了：Run 崩溃，我来处理。" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } });
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

async function start(options: { attended: boolean; leadFailing?: boolean }) {
  const lead = stubLead(options.leadFailing);
  const desktop: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {},
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    notifyDesktop: (text) => desktop.push(text),
  });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"],
  }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  if (options.attended) {
    socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === "presence")).toBe(true));
  }
  const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
    headers: { authorization: `Bearer ${issued.accessToken}` },
  })).json()) as T;
  // 发给工单 agent 的一条消息。
  const ticketMessage = (itemId: number, message: string) => socket.send(JSON.stringify({
    type: "chat.send", id: `ticket-${itemId}`, protocolVersion: 2, message, context: { ticketId: itemId },
  }));
  return { lead, desktop, get, ticketMessage };
}

type Turn = { id: string; originKind: string; ticketId: number | null; state: string; assistantText: string };

function notifications(itemId: number) {
  return db.prepare("SELECT state, delivered_via FROM notifications WHERE item_id=?").all(itemId) as
    Array<{ state: string; delivered_via: string | null }>;
}

// 等调度器和通知轮询都转过几圈（兜底窗口是 200ms），确认不会再冒出新东西。
const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 800));

describe("a failed ticket chat", () => {
  // 2026-10-15 起 Lead 也马上知道（异常先交给 Lead）：它可以换个模型重发。用户看到的仍然只是那条失败的回执，
  // 加上 Lead 处理以后说的一句话；没有卡片、没有通知、没有 blocker。
  it("shows up once as the failed receipt, and wakes Lead once", async () => {
    vi.stubEnv("FAKE_SCENARIO", "crash");
    const itemId = createItem(db, { title: "E2E final acceptance", brief: "verify", createdBy: "user" });
    const { lead, get, ticketMessage } = await start({ attended: true });

    ticketMessage(itemId, "现在还需要我做什么");
    await vi.waitFor(async () => {
      const turns = (await get<{ items: Turn[] }>("/v1/conversation/turns")).items;
      expect(turns.find((turn) => turn.ticketId === itemId)?.state).toBe("failed");
    }, { timeout: 15_000 });
    await settle();

    const turns = (await get<{ items: Turn[] }>("/v1/conversation/turns")).items;
    expect(turns.map((turn) => turn.originKind)).toEqual(["paired:companion:ticket-agent", "system:blocker"]);
    expect(lead.prompts.filter((prompt) => prompt.includes(`工单 #${itemId} 的对话 Run`))).toHaveLength(1);
    const cards = (await get<{ items: Array<{ kind: string; ticketId: number }> }>("/v1/kernel/conversation/cards")).items;
    expect(cards.filter((card) => card.ticketId === itemId)).toEqual([]);
    expect(notifications(itemId)).toEqual([]);
    expect(listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === itemId)).toEqual([]);
    // 工单本身没有受阻，也就不算"需要你"。
    const tickets = (await get<{ items: Parameters<typeof ticketNeedsUser>[0][] }>("/v1/tickets")).items;
    expect(ticketNeedsUser(tickets.find((ticket) => ticket.id === itemId)!)).toBeNull();
  }, 30_000);
});

describe("a blocker", () => {
  function blocker(itemId: number) {
    return raiseBlocker(db, {
      itemId, runId: null, code: "process_exit", title: "Child Run 崩溃（exitCode=1）",
      summary: "工单 crash（exitCode=1）：TypeError", nextStep: "Lead 应检查本次 Run 的失败证据。", source: "structural",
    });
  }

  it("is told once by Lead while someone is watching: no daemon notice, no second announcement", async () => {
    const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "user" });
    await start({ attended: true });
    const raised = blocker(itemId);
    await vi.waitFor(() => expect(notifications(itemId)).toEqual([{ state: "delivered", delivered_via: "lead" }]));
    await settle();

    const turns = db.prepare("SELECT origin_kind FROM channel_turns ORDER BY created_at, rowid").all() as Array<{ origin_kind: string }>;
    expect(turns.filter((turn) => turn.origin_kind.startsWith("system:")).map((turn) => turn.origin_kind)).toHaveLength(1);
    expect(turns.map((turn) => turn.origin_kind)).not.toContain("system:blocker-notice");
    expect(turns.map((turn) => turn.origin_kind)).not.toContain("system:fallback-notice");
    expect(raised.created).toBe(true);
  }, 30_000);

  // 2026-10-15 起（Jarvis 模式）没人在看时由 Lead 决定要不要推：它在会话里说了，系统就不另推；
  // 用户回来时会话里就有 Lead 的这一轮。
  it("is told once by Lead while nobody watches, and the system pushes nothing itself", async () => {
    const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "user" });
    const { desktop, lead } = await start({ attended: false });
    blocker(itemId);
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("Child Run 崩溃"))).toBe(true));
    await settle();

    // Lead 一轮里就知道了这件事（blocker 和它的通知哪个先叫醒 Lead 都行）；daemon 不另写行。
    const turns = db.prepare("SELECT origin_kind FROM channel_turns ORDER BY created_at, rowid").all() as Array<{ origin_kind: string }>;
    expect(turns).toHaveLength(1);
    expect(["system:blocker", "system:notification"]).toContain(turns[0]!.origin_kind);
    expect(notifications(itemId)).toEqual([{ state: "pending", delivered_via: null }]);
    expect(desktop).toEqual([]);
  }, 30_000);
});

describe("a blocker whose card is already in the conversation", () => {
  // Lead 的模型连不上时，blocker 的通知没人播，到点兜底。以前兜底往会话里贴一条「⏰ 工单 #N 阻塞：Run crashed：…
  // 下一步：Inspect the runtime failure…」，和会话里那张检查点卡片说的是同一件事，还是原文。
  // 2026-10-15 起 agent 报告的阻塞先交给 Lead；Lead 的模型连不上时马上升级给用户（宽限设成 0）。
  it("falls back to the desktop only, while Lead cannot speak", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "0");
    const itemId = createItem(db, { title: "E2E acceptance", brief: "verify", createdBy: "user" });
    const { checkpoint } = insertCheckpointWithResult(db, {
      itemId, runId: null, source: "system_derived", kind: "blocked", title: "Run crashed",
      summary: "Run #3 crashed (process_exit): Codex exited with code 1",
      nextStep: "Inspect the runtime failure, adjust the execution path if needed, and retry.",
      keyFacts: [{ label: "Failure category", value: "unknown" }], idempotencyKey: "run-crash:3",
    });
    ensureCheckpointCard(db, { itemId, checkpointId: checkpoint.id });
    const { desktop } = await start({ attended: false, leadFailing: true });
    raiseBlockerFromCheckpoint(db, checkpoint);

    // Lead 不能工作：系统发兜底汇总。这件事在会话里已经有卡片，汇总不再往会话里贴，只推桌面。
    await vi.waitFor(() => expect(desktop.some((text) => text.startsWith("Paimon 离线 "))).toBe(true));
    await settle();
    const turns = db.prepare("SELECT origin_kind FROM channel_turns").all() as Array<{ origin_kind: string }>;
    expect(turns.map((turn) => turn.origin_kind)).not.toContain("system:fallback-notice");
    expect(db.prepare("SELECT kind, state, delivered_via FROM notifications").all())
      .toEqual([{ kind: "lead_unavailable", state: "delivered", delivered_via: "fallback" }]);
  }, 30_000);
});

describe("a ticket chat crash recorded before this fix", () => {
  // 实例上 #66 已经有一张对话 Run #71 的「Run crashed」卡片。它和失败的回执说的是同一件事，
  // 而且照着执行 Run 的样子说"Lead 会判断能不能重试"。读的时候不再列出它；执行 Run 的失败照常列出。
  function crashCard(itemId: number, purpose: "conversation" | "execution"): number {
    const runId = createRun(db, { itemId, role: "executor", purpose, runtime: "claude" });
    updateRun(db, runId, { state: "failed", endedAt: true, exitCode: 1 });
    const { checkpoint } = insertCheckpointWithResult(db, {
      itemId, runId, source: "system_derived", kind: "blocked", title: "Run crashed",
      summary: `Run #${runId} crashed (process_exit): No conversation found`,
      nextStep: "Inspect the runtime failure, adjust the execution path if needed, and retry.",
      keyFacts: [{ label: "Failure category", value: "unknown" }],
      idempotencyKey: `run-crash:${runId}`,
    });
    ensureCheckpointCard(db, { itemId, checkpointId: checkpoint.id });
    return checkpoint.id;
  }

  it("is no longer listed in the Lead conversation; an execution crash still is", async () => {
    const chat = createItem(db, { title: "E2E final acceptance", brief: "verify", createdBy: "user" });
    const work = createItem(db, { title: "implement", brief: "do it", createdBy: "user" });
    crashCard(chat, "conversation");
    const executionCheckpoint = crashCard(work, "execution");
    const { get } = await start({ attended: true });

    const page = await get<{ items: Array<{ ticketId: number; checkpointId?: number }> }>("/v1/kernel/conversation/cards");
    expect(page.items.map((card) => [card.ticketId, card.checkpointId])).toEqual([[work, executionCheckpoint]]);
  }, 30_000);
});
