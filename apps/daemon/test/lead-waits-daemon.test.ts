// Lead 在等用户的下一步（2026-10-19，store 的 lead-waits.ts）：完整的持久化流程，经过真实的 daemon、事件日志和 Lead 的工具。
//   · 工单 #98：Lead 要等用户重新授权 GitHub。17:05 授权完成，没有任何事件叫醒 Lead，直到用户问「授权完了，你没收到事件吗」。
//   · 工单 #85（10-18）：Lead 等用户点确认卡，用户改点「验收」「委托给 Lead」。主人操作对 Lead 一律跳过，Lead 没醒。
//   · 15:12 Lead 请求的重启完成以后，新 daemon 第一轮写着「用户此刻不在」，Lead 回了 NO_REPLY，用户之后问了两次。
// 用户的意见：没有人在等的主人操作只记日志；Lead 在等的操作必须叫醒它；Lead 请求的维护完成后不允许静默。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadToolset, type LeadDeps } from "@pi-lead-child/lead";
import { SUPERVISOR_FEATURE_DEPLOY_GATE, type OwnerActionId } from "@pi-lead-child/protocol";
import {
  addInbox, createCliBinding, createItem, insertConnection, listOpenLeadWaits, openDb, recordOwnerAction, registerLeadWait,
  updateConnection, type Db,
} from "@pi-lead-child/store";
import { recordConnectionAttention } from "../src/connection-attention.js";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-waits-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_DRAIN_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

type Tools = ReturnType<typeof createLeadToolset>;

// Lead 的会话是替身，工具是真的（createLeadToolset：和 session.ts 注册的同一组，外面包着自动登记等待）。
// script：Lead 收到的输入里有某段文字时，在这一轮里调哪个工具。quiet：只回 NO_REPLY。
// hold：Lead 收到的输入里有某段文字时，这一轮停在那里，直到 until 兑现（这一轮还没结束，交给它的事件还没有处置）。
function stubLead(options: {
  script?: Array<{ when: string; tool: string; params: Record<string, unknown> }>;
  quiet?: boolean;
  supervisor?: LeadDeps["supervisor"];
  hold?: { when: string; until: Promise<void> };
} = {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  // 每次工具调用的结局：工具报错时（例如 render_ui 退回卡片）记下错误，这一轮照常结束。
  const outcomes: Array<{ tool: string; error: string | null }> = [];
  let tools: Tools = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async (args: LeadDeps) => {
    tools = createLeadToolset({ ...args, ...(options.supervisor ? { supervisor: options.supervisor } : {}) });
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt(message: string) {
          prompts.push(message);
          if (options.hold && message.includes(options.hold.when)) await options.hold.until;
          for (const step of options.script ?? []) {
            if (!message.includes(step.when)) continue;
            const tool = tools.find((candidate) => candidate.name === step.tool)!;
            const id = `call-${prompts.length}`;
            emit({ type: "tool_execution_start", toolCallId: id, toolName: step.tool, args: step.params });
            try {
              const result = await tool.execute(id, step.params as never, undefined, undefined, undefined as never);
              outcomes.push({ tool: step.tool, error: null });
              emit({ type: "tool_execution_end", toolCallId: id, toolName: step.tool, args: step.params, result, isError: false });
            } catch (error) {
              outcomes.push({ tool: step.tool, error: error instanceof Error ? error.message : String(error) });
              emit({ type: "tool_execution_end", toolCallId: id, toolName: step.tool, args: step.params,
                result: { content: [{ type: "text", text: String(error) }] }, isError: true });
            }
          }
          const reply = options.quiet ? "NO_REPLY" : "好的。";
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] } });
        },
        async steer() {}, async followUp() {}, dispose() {},
      },
    };
  };
  return { factory, prompts, outcomes };
}

async function start(lead: ReturnType<typeof stubLead>) {
  const logs: string[] = [];
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: (line) => logs.push(line) });
  return { logs };
}

// 叫醒 Lead 的一件事（一条要 Lead 处理的说明）：Lead 在这一轮里按 script 调工具。
function wakeLeadWith(summary: string) {
  addInbox(db, { dedupScope: `test:${summary}`, severity: "attention", source: "structural", lossless: true, summary, payload: { wakeLead: true } });
}

function ownerAction(action: OwnerActionId, target: { key: string; label: string; ticketId: number | null }) {
  const { binding } = createCliBinding(db, { name: "plc" });
  recordOwnerAction(db, {
    action, target, summary: `${action}：${target.label}`, credential: binding,
    source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const fallbackNotices = () => (db.prepare(
  "SELECT assistant_text FROM channel_turns WHERE origin_kind = 'system:fallback-notice' ORDER BY created_at",
).all() as Array<{ assistant_text: string }>).map((row) => row.assistant_text);

describe("ticket #98: Lead waits for the user to re-authorize a connection", () => {
  it("registers the wait from the connection tool's result, and is woken with its note when the user finishes the authorization", async () => {
    const connection = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
    updateConnection(db, connection.id, { status: "needs_reauth", failure_detail: "invalid_grant" });
    // Lead 调 GitHub 的工具，结果是「要用户重新授权」（hub 的 needs_reauth）：系统按结果里的 user_action 自动登记等待。
    const lead = stubLead({
      script: [{
        when: "发 PR #101 的行内评论", tool: "call_connection_tool",
        params: { connection: "github", tool: "create_review_comment", arguments: {}, summary: "发 PR #101 的行内评论" },
      }, {
        // 授权完成后叫醒的那一轮：Lead 只告诉用户授权好了。用户已经做完了这件事，卡片不用再放授权按钮（审查）。
        when: "你在等的事有了下一步", tool: "render_ui",
        params: {
          root: "card", fallback_text: "GitHub 授权好了，我接着发 PR #101 的评论。",
          nodes: [{ id: "card", type: "Text", props: { text: "GitHub 授权好了，我接着发 PR #101 的评论。" } }],
        },
      }],
    });
    await start(lead);
    wakeLeadWith("发 PR #101 的行内评论");
    await vi.waitFor(() => expect(listOpenLeadWaits(db)).toMatchObject([{
      entityKey: "connection:github", origin: "tool:call_connection_tool",
      userAction: { kind: "reauthorize", target: "connection:github" },
    }]));
    await settle();
    const before = lead.prompts.length;

    // 17:05：用户在设置页完成授权（hub 的 #saveConnected 走 updateConnection）。
    updateConnection(db, connection.id, { status: "connected" });

    await vi.waitFor(() => expect(lead.prompts.slice(before).some((prompt) => prompt.includes("你在等的事有了下一步"))).toBe(true));
    const prompt = lead.prompts.slice(before).find((candidate) => candidate.includes("你在等的事有了下一步"))!;
    expect(prompt).toContain("等用户重新授权");
    expect(prompt).toContain("connection.status_changed");
    expect(prompt).toContain("已连接");
    expect(listOpenLeadWaits(db)).toEqual([]);
    await vi.waitFor(() => expect(lead.outcomes.filter((outcome) => outcome.tool === "render_ui")).toEqual([{ tool: "render_ui", error: null }]));
  });
});

// 2026-10-20：hub 发现授权失效（server.ts 的 onAttention），daemon 先写一条说明再登记等待（connection-attention.ts）。
// 两次写入落在同一毫秒时，Lead 还在处理那条说明、用户就重新授权了，以前等待的了结只记一笔：
// Lead 这一轮只知道「授权失效了」，没有一轮告诉它「授权好了」。
describe("a grant that comes back while Lead is still on the note about it", () => {
  it("wakes Lead again with the end of the wait", async () => {
    const connection = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
    updateConnection(db, connection.id, { status: "needs_reauth", failure_detail: "invalid_grant" });
    let release!: () => void;
    const lead = stubLead({ hold: { when: "GitHub 的授权失效了", until: new Promise<void>((resolve) => { release = resolve; }) } });
    await start(lead);
    await settle();

    // 只在这一次同步调用里固定时钟，让说明和等待落在同一毫秒。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    recordConnectionAttention(db, { kind: "needs_reauth", key: "github", label: "GitHub", message: "GitHub 的授权失效了" }, () => {});
    vi.useRealTimers();
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("GitHub 的授权失效了"))).toBe(true), { timeout: 10_000 });
    const before = lead.prompts.length;

    // Lead 这一轮还没结束，用户已经在设置页重新授权。
    updateConnection(db, connection.id, { status: "connected" });
    expect(listOpenLeadWaits(db)).toEqual([]);
    release();

    await vi.waitFor(() => expect(lead.prompts.slice(before).some((prompt) => prompt.includes("你在等的事有了下一步"))).toBe(true), { timeout: 10_000 });
    const prompt = lead.prompts.slice(before).find((candidate) => candidate.includes("你在等的事有了下一步"))!;
    expect(prompt).toContain("等用户重新授权");
    expect(prompt).toContain("connection.status_changed");
    expect(prompt).toContain("已连接");
  });
});

describe("ticket #85: Lead waits for the user's next step on a ticket", () => {
  it("is woken when the user delegates the ticket, and an owner action nobody waits for stays a log line", async () => {
    const waited = createItem(db, { title: "确认方案", brief: "b", createdBy: "lead" });
    const other = createItem(db, { title: "别的工单", brief: "b", createdBy: "lead" });
    const lead = stubLead({
      script: [{ when: "请用户确认方案", tool: "wait_for_user_action", params: { entity: `ticket:${waited}`, note: "用户确认或委托以后开始执行" } }],
    });
    await start(lead);
    wakeLeadWith("请用户确认方案");
    await vi.waitFor(() => expect(listOpenLeadWaits(db)).toMatchObject([{ entityKey: `ticket:${waited}` }]));
    await settle();

    // 没有人在等的工单：用户验收它，只记日志，不叫醒 Lead。
    const quiet = lead.prompts.length;
    ownerAction("ticket.complete", { key: `ticket:${other}`, label: `工单 #${other}`, ticketId: other });
    await settle();
    expect(lead.prompts.length).toBe(quiet);

    // 用户没点确认卡，改点了「委托给 Lead」：Lead 在等这张工单，被叫醒。
    ownerAction("lead.delegation", { key: `ticket:${waited}`, label: `工单 #${waited}`, ticketId: waited });
    await vi.waitFor(() => expect(lead.prompts.slice(quiet).some((prompt) => prompt.includes("你在等的事有了下一步"))).toBe(true));
    const prompt = lead.prompts.slice(quiet).find((candidate) => candidate.includes("你在等的事有了下一步"))!;
    expect(prompt).toContain("用户确认或委托以后开始执行");
    expect(prompt).toContain("lead.delegation");
  });

  it("is woken when a wait times out", async () => {
    const ticket = createItem(db, { title: "等验收", brief: "b", createdBy: "lead" });
    registerLeadWait(db, {
      entityKey: `ticket:${ticket}`, note: "等用户验收", origin: "lead", timeoutMs: 5 * 60_000, now: new Date(Date.now() - 10 * 60_000),
    });
    const lead = stubLead();
    await start(lead);
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("到了超时") && prompt.includes("等用户验收"))).toBe(true));
    expect(listOpenLeadWaits(db)).toEqual([]);
  });
});

describe("a restart Lead asked for", () => {
  it("wakes the new daemon's Lead with a must-tell event, says the user's presence is unknown, and tells the user itself when Lead stays silent", async () => {
    const requests: string[] = [];
    const first = stubLead({
      script: [{ when: "装好了 SoL-Pi", tool: "request_runtime_maintenance", params: { action: "restart", reason: "让 SoL-Pi 生效" } }],
      supervisor: {
        // 部署闸门在 Supervisor 里（interesting-germain）：工具先核对 Supervisor 有这道闸门。
        status: async () => ({ features: [SUPERVISOR_FEATURE_DEPLOY_GATE] }) as never,
        request: async (input) => {
          requests.push(input.reason);
          return { id: "m1", action: input.action, reason: input.reason, state: "pending" } as never;
        },
      },
    });
    await start(first);
    wakeLeadWith("装好了 SoL-Pi");
    await vi.waitFor(() => expect(listOpenLeadWaits(db)).toMatchObject([{ entityKey: "daemon:main", mustTell: true }]));
    expect(requests).toEqual(["让 SoL-Pi 生效"]);
    await daemon!.close();
    daemon = null;

    // supervisor 拉起新的 daemon。这一个 Lead 只回 NO_REPLY（15:12 那次就是这样）。
    const second = stubLead({ quiet: true });
    await start(second);
    await vi.waitFor(() => expect(second.prompts.some((prompt) => prompt.includes("你在等的事有了下一步"))).toBe(true));
    const prompt = second.prompts.find((candidate) => candidate.includes("你在等的事有了下一步"))!;
    expect(prompt).toContain("让 SoL-Pi 生效");
    expect(prompt).toContain("必须告诉用户");
    expect(prompt).toContain("daemon.started");
    // 重启以后客户端还没连上：在不在是未知，不再说「用户此刻不在」。
    expect(prompt).toContain("用户此刻在不在：未知");
    expect(prompt).not.toContain("用户此刻不在");
    // Lead 回了 NO_REPLY：不允许静默，系统直接在会话里说。
    await vi.waitFor(() => expect(fallbackNotices().some((text) => text.includes("让 SoL-Pi 生效"))).toBe(true));
    expect(listOpenLeadWaits(db)).toEqual([]);
  });
});
