// Lead 是常驻的助理（2026-10-15 用户决定，Jarvis 模式）：「凡是这些委派出去的事情中间出现的状况都应该先让 lead
// 知道吧？异常的，完成的，都先交由他知道吧？由 lead 决策要如何知会我」。
//   · 要决定的事（异常、审批、给用户的通知）马上叫醒 Lead，没人在看也一样；系统自己不推给用户。
//   · 由 Lead 决定怎样告诉用户：在会话里说、用 notify_user 推、或者等用户回来再说。
//   · Lead 那一轮失败了，系统按退避再叫醒它。
//   · 系统只在 Lead 不能工作时兜底（模型一直失败、一轮卡死），给用户一条汇总，不逐条发。
//   · 审批在过期前一定送到用户：没人转达时，到点系统自己推。
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addInbox, addLeadFollowUp, addNotification, createApproval, createItem, createPairing, listInbox, openDb, redeemPairing,
  transition, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-events-");
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

// 不调用模型的 Lead。healthy：回一句话（quiet 时只回 NO_REPLY）；down：每次都失败（503）；hold：调用挂起不返回，
// 也没有任何动静；busy：调用一直不返回，但每 30 毫秒输出一点文字（长任务）；flaky：第一次失败，以后都成功。
function stubLead(mode: "healthy" | "down" | "hold" | "busy" | "flaky", options: { quiet?: boolean } = {}) {
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
        if (mode === "hold") await new Promise(() => {});
        if (mode === "busy") {
          setInterval(() => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } }), 30).unref();
          await new Promise(() => {});
        }
        if (mode === "down" || (mode === "flaky" && prompts.length === 1)) {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503: auth_unavailable", content: [] } });
          return;
        }
        const reply = options.quiet ? "NO_REPLY" : "已处理";
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] } });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
  return { factory, prompts };
}

async function start(lead: ReturnType<typeof stubLead>) {
  const desktop: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: (text) => desktop.push(text),
  });
  return { desktop };
}

// 一个有人在看的 companion（v2 协议、chat scope、presence 为 attended）。
async function viewer() {
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"] }).code);
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

function blockedTicket(): number {
  const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "dispatch exhausted" });
  return itemId;
}

const fallbackNotices = () => db.prepare(
  "SELECT assistant_text FROM channel_turns WHERE origin_kind IN ('system:blocker-notice','system:fallback-notice')",
).all() as Array<{ assistant_text: string }>;
const notification = (id: number) => db.prepare("SELECT state, delivered_via FROM notifications WHERE id=?").get(id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("an event that needs a decision", () => {
  it("wakes Lead at once with nobody watching, tells it the user is away, and pushes nothing itself", async () => {
    const lead = stubLead("healthy");
    const { desktop } = await start(lead);
    const itemId = blockedTicket();
    // 重试额度用完：要用户决定的事，也先交给 Lead。
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} 执行重试已耗尽（执行失败 2/2）` });

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
    const prompt = lead.prompts.find((candidate) => candidate.includes("执行重试已耗尽"))!;
    // daemon 启动以后还没有客户端连上过：在不在是未知（2026-10-19，重启以后 Lead 据「不在」回了 NO_REPLY）。
    expect(prompt).toContain("用户此刻在不在：未知");
    expect(prompt).toMatch(/#\d+ /);
    await settle();
    expect(fallbackNotices()).toEqual([]);
    expect(desktop).toEqual([]);
    // 一轮成功以后，每件事都有去向。
    expect(JSON.parse(listInbox(db, {})[0]!.payload).disposition).toMatchObject({ kind: "seen" });
  });

  it("wakes Lead again after a failed turn", async () => {
    vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50");
    const lead = stubLead("flaky");
    await start(lead);
    const itemId = blockedTicket();
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false } });

    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("交接失败")).length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(listInbox(db, {}).map((row) => row.state)).toEqual(["consumed"]));
  });

  it("wakes Lead for its own follow-up only when it is due", async () => {
    const lead = stubLead("healthy");
    await start(lead);
    addLeadFollowUp(db, { at: new Date(Date.now() + 60 * 60_000), note: "以后再看的事" });
    addLeadFollowUp(db, { at: new Date(Date.now() - 1_000), note: "现在该看的事" });
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("现在该看的事"))).toBe(true));
    await settle();
    expect(lead.prompts.some((prompt) => prompt.includes("以后再看的事"))).toBe(false);
  });
});

describe("a notification for the user", () => {
  it("goes to Lead while the user is away; Lead may keep it for later, and tells the user once they are back", async () => {
    const lead = stubLead("healthy", { quiet: true });
    const { desktop } = await start(lead);
    const id = addNotification(db, { kind: "reminder", urgency: "immediate", title: "提醒：交周报", createdAt: new Date().toISOString() });

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes(`[#${id}] 提醒：交周报`))).toBe(true));
    await settle();
    // Lead 判断先不打扰：系统不推，也不再为它叫醒 Lead。
    expect(notification(id)).toEqual({ state: "pending", delivered_via: null });
    expect(desktop).toEqual([]);
    expect(lead.prompts.filter((prompt) => prompt.includes("提醒：交周报"))).toHaveLength(1);

    // 用户回来了：Lead 当面告诉他。
    await viewer();
    await vi.waitFor(() => expect(lead.prompts.filter((prompt) => prompt.includes("提醒：交周报"))).toHaveLength(2));
  });
});

describe("an approval", () => {
  it("is pushed by the system before it expires when nobody has passed it on", async () => {
    vi.stubEnv("PLC_APPROVAL_DEADLINE_MARGIN_MS", String(10 * 60_000));
    const { desktop } = await start(stubLead("healthy", { quiet: true }));
    const itemId = blockedTicket();
    createApproval(db, { itemId, requestedBy: "child", tool: "delete", action: "删除临时资源", ttlMs: 10 * 60_000 + 500 });

    await vi.waitFor(() => expect(desktop.filter((text) => text.includes("删除临时资源"))).toHaveLength(1), { timeout: 5_000 });
    await settle();
    expect(desktop.filter((text) => text.includes("删除临时资源"))).toHaveLength(1);
  });

  it("is not pushed again when Lead already passed it on", async () => {
    vi.stubEnv("PLC_APPROVAL_DEADLINE_MARGIN_MS", String(10 * 60_000));
    const { desktop } = await start(stubLead("healthy", { quiet: true }));
    const itemId = blockedTicket();
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "delete", action: "删除临时资源", ttlMs: 10 * 60_000 + 500 });
    addNotification(db, {
      kind: "lead_notice", urgency: "immediate", title: "#12 要你批准删除临时资源",
      dedupKey: `approval:${approvalId}:lead-notice`, createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(desktop).toEqual(["#12 要你批准删除临时资源"]));
    await settle();
    expect(desktop).toEqual(["#12 要你批准删除临时资源"]);
  });
});

describe("when Lead cannot work", () => {
  it("sends the user one summary of the backlog when Lead's model keeps failing", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "0");
    const { desktop } = await start(stubLead("down"));
    const itemId = blockedTicket();
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false } });
    const reminder = addNotification(db, { kind: "reminder", urgency: "immediate", title: "提醒：交周报", createdAt: new Date().toISOString() });

    await vi.waitFor(() => expect(desktop.some((text) => text.startsWith("Paimon 离线 "))).toBe(true));
    await settle();
    expect(desktop.filter((text) => text.startsWith("Paimon 离线 "))).toHaveLength(1);
    const [summary] = fallbackNotices();
    expect(summary!.assistant_text).toContain("交接失败");
    expect(summary!.assistant_text).toContain("提醒：交周报");
    expect(notification(reminder)).toEqual({ state: "delivered", delivered_via: "fallback" });
    expect(JSON.parse(listInbox(db, {})[0]!.payload)).toMatchObject({ needsUser: true, escalationReason: expect.stringContaining("Paimon 的模型调用失败") });
  });

  // 2026-10-15 用户：「30 分钟也未必算卡死」。系统每隔 15 到 25 分钟（随机）查一次 Lead：
  // 这一轮在一整个检查间隔里没有任何动静，才算卡死。一直在干活的长任务不算。
  it("sends the summary when one turn shows no sign of life for a whole check interval", async () => {
    vi.stubEnv("PLC_LEAD_CHECK_MIN_MS", "100");
    vi.stubEnv("PLC_LEAD_CHECK_MAX_MS", "150");
    const { desktop } = await start(stubLead("hold"));
    const itemId = blockedTicket();
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false } });

    await vi.waitFor(() => expect(desktop.some((text) => text.startsWith("Paimon 离线 "))).toBe(true), { timeout: 3_000 });
    expect(fallbackNotices()[0]!.assistant_text.split("\n")[0]).toContain("（没有响应）");
  });

  it("does not call a long turn stuck while it keeps working", async () => {
    vi.stubEnv("PLC_LEAD_CHECK_MIN_MS", "100");
    vi.stubEnv("PLC_LEAD_CHECK_MAX_MS", "150");
    const lead = stubLead("busy");
    const { desktop } = await start(lead);
    const itemId = blockedTicket();
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false } });

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("交接失败"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(desktop).toEqual([]);
    expect(fallbackNotices()).toEqual([]);
  });
});
