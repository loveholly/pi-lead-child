// Lead 拿得到根因和当前状态（工单 03，spec D8）。走完整的落库路径：blocker 写进库，daemon 叫醒 Lead，
// 看 Lead 实际收到的文字；Lead 的工具由 daemon 注入依赖，和网关读同一份工单摘要、同一份 Lead 健康状态。
//   · 以前 blocker 的影响、下一步、根因和证据只存在 inbox 的 payload 里，送给 Lead 时只有摘要。
//   · 以前没有工具能读工单的根因；Lead 自己的回合失败、健康状态，界面能看到，Lead 不知道。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import {
  addInbox, createItem, createRun, openDb, raiseBlocker, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-root-cause-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

type Reply = "text" | "error" | "hang";

// 不调用模型的 Lead。plan 按 prompt 决定这一次怎么回答：说一句话、模型报错、或者一直不返回（Lead 忙着）。
// 它拿到 daemon 给 Lead 工具的依赖，测试用它们建出 Lead 的工具。
function stubLead(plan: (prompt: string, index: number) => Reply = () => "text") {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const followUps: string[] = [];
  let release: (() => void) | null = null;
  let tools: ReturnType<typeof createLeadTools> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async (args: LeadDeps) => {
    tools = createLeadTools({ ...args, db, dbPath, dataDir: dir });
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt(message: string) {
          const reply = plan(message, prompts.length);
          prompts.push(message);
          if (reply === "hang") await new Promise<void>((resolve) => { release = resolve; });
          if (reply === "error") {
            emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests", content: [] } });
            return;
          }
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已处理" } });
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已处理" }] } });
        },
        async steer() {},
        async followUp(message: string) { followUps.push(message); },
        dispose() {},
      },
    };
  };
  const call = async (name: string, params: Record<string, unknown>): Promise<string> => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`tool ${name} not found`);
    const result = await found.execute("call", params, undefined, undefined, undefined as never);
    return result.content.map((part: { type: string; text?: string }) => part.text ?? "").join("\n");
  };
  return { factory, prompts, followUps, call, release: () => release?.() };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
}

function crashedTicket(title: string): { itemId: number; runId: number } {
  const itemId = createItem(db, { title, brief: title, createdBy: "user", runtime: "codex" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, {
    state: "failed", endedAt: true, exitCode: 1, errorCode: "codex_error", errorMessage: "invalid_request: unsupported parameter",
    failure: { scope: "task", retry: "never", needs: "none", code: "invalid_request", evidence: "unsupported parameter" },
  });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "run crashed", runId });
  return { itemId, runId };
}

function raiseCrash(itemId: number, runId: number, title: string): void {
  raiseBlocker(db, {
    needsUser: false, itemId, runId, code: "codex_error", title,
    summary: `工单 #${itemId} child crash（exitCode=1）：invalid_request`,
    impact: "当前工单无法继续执行", nextStep: "Lead 应检查本次 Run 的失败证据，判断是否可以安全重试。",
    source: "structural", dedupKey: `run-crash:${runId}`,
    evidence: {
      exitCode: 1, errorCode: "codex_error", reason: "invalid_request: unsupported parameter",
      failure: { scope: "task", retry: "never", needs: "none", code: "invalid_request" },
    },
  });
}

describe("a blocker handed to Lead", () => {
  // 回归：drainNotices 以前只放摘要。
  it("carries the run, impact, next step, root cause and evidence into Lead's turn", async () => {
    const lead = stubLead();
    await start(lead);
    const { itemId, runId } = crashedTicket("部署");
    raiseCrash(itemId, runId, "Child Run 崩溃（exitCode=1）");

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("Child Run 崩溃"))).toBe(true));
    const prompt = lead.prompts.find((candidate) => candidate.includes("Child Run 崩溃"))!;
    expect(prompt).toContain(`Run：#${runId}`);
    expect(prompt).toContain("影响：当前工单无法继续执行");
    expect(prompt).toContain("下一步：Lead 应检查本次 Run 的失败证据");
    expect(prompt).toContain("根因：scope=task needs=none code=invalid_request");
    expect(prompt).toContain("错误码：codex_error");
    expect(prompt).toContain('证据：{"exitCode":1,"errorCode":"codex_error","reason":"invalid_request: unsupported parameter"}');
  });

  // 回归：lead-wake 给忙着的 Lead 排进队列的那段文字以前也只有摘要。工单 04 起 Lead 忙时它排队，
  // 那一轮结束以后单独一轮交给 Lead（spec D6）；文字和每轮交给 Lead 的一样，带着同样的字段。
  it("carries the same fields when it is queued for a busy Lead", async () => {
    const lead = stubLead((prompt) => (prompt.includes("第一次崩溃") ? "hang" : "text"));
    await start(lead);
    const first = crashedTicket("第一张");
    raiseCrash(first.itemId, first.runId, "第一次崩溃");
    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("第一次崩溃"))).toBe(true));

    const second = crashedTicket("第二张");
    raiseCrash(second.itemId, second.runId, "第二次崩溃");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lead.followUps).toEqual([]);
    expect(lead.prompts.some((prompt) => prompt.includes("第二次崩溃"))).toBe(false);
    lead.release();
    await vi.waitFor(() => expect(lead.prompts.some((text) => text.includes("第二次崩溃"))).toBe(true));
    const queued = lead.prompts.find((text) => text.includes("第二次崩溃"))!;
    expect(queued).toContain(`Run：#${second.runId}`);
    expect(queued).toContain("影响：当前工单无法继续执行");
    expect(queued).toContain("根因：scope=task needs=none code=invalid_request");
  });
});

describe("get_ticket_status", () => {
  // AGENTS.md 的核心不变量：每个界面都从同一份 TicketSummary 取工单的当前状态。Lead 也一样。
  it("gives the same ticket summary as the app, for every ticket", async () => {
    const lead = stubLead();
    await start(lead);
    const ready = createItem(db, { title: "还没跑", brief: "b", createdBy: "user", runtime: "codex" });
    const { itemId: blocked } = crashedTicket("卡住的");
    // 终态压过派生的信号：一张 done 的工单，留着失败的 Run 和一条还没消化的 blocker，仍然是 done。
    const { itemId: done, runId: doneRun } = crashedTicket("做完的");
    raiseCrash(done, doneRun, "旧的崩溃");
    transition(db, { itemId: done, to: "active", actor: "system", reason: "retry" });
    transition(db, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(db, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    addInbox(db, { itemId: done, severity: "attention", source: "structural", summary: "进展" });

    const app = await readGatewayTickets(db);
    for (const id of [ready, blocked, done]) {
      const status = JSON.parse(await lead.call("get_ticket_status", { ticket_id: id }));
      const shown = app.find((ticket) => ticket.id === id)!;
      expect(status.ticket.stage).toBe(shown.stage);
      expect(status.ticket).toEqual(shown);
    }
    expect(JSON.parse(await lead.call("get_ticket_status", { ticket_id: done })).ticket.stage).toBe("done");
    expect(JSON.parse(await lead.call("get_ticket_status", { ticket_id: blocked })).last_failure)
      .toMatchObject({ code: "invalid_request", error_code: "codex_error" });
  });
});

describe("read_lead_turns", () => {
  it("tells Lead that its own turn failed, and its health as the app shows it", async () => {
    const lead = stubLead((_prompt, index) => (index === 0 ? "error" : "text"));
    await start(lead);
    const { itemId, runId } = crashedTicket("部署");
    raiseCrash(itemId, runId, "Child Run 崩溃（exitCode=1）");
    await vi.waitFor(() => expect(lead.prompts.length).toBeGreaterThanOrEqual(1));

    await vi.waitFor(async () => {
      const result = JSON.parse(await lead.call("read_lead_turns", {}));
      expect(result.health).toMatchObject({ state: "degraded", failures: 1, detail: "429 Too Many Requests" });
    });
    const result = JSON.parse(await lead.call("read_lead_turns", {}));
    expect(result.health.reason).toBeTruthy();
  });
});
