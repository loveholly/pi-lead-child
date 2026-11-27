// shadow（用户 2026-11-19，lead 的 shadow/，daemon 的 shadow-routing.ts），走整条持久化的流程：daemon、网关、store、
// Lead 的输入都是真的；主会话是替身（fake-pi-session.ts），shadow 是真的隔离 pi 会话，模型是 pi-ai 的假模型（faux）。
//
// 以前：每件后台事件都叫醒主会话，每次读一遍它的整个上下文。现在：设置开着时，后台事件先交给 shadow；
// 它做完的不叫醒主会话，主会话下一次开口时在当前局面里看到一句；它交回的带着说明交给主会话。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { scriptedSmartModel } from "@pi-lead-child/engine/testing";
import {
  createIsolatedLookupSession, shadowOpeningMessages, leadShadowParts, type ShadowSessionFactory,
} from "@pi-lead-child/lead";
import { LEAD_SHADOW_HANDLED_KIND, LEAD_SHADOW_RUN_KIND } from "@pi-lead-child/protocol";
import { addInbox, appendEvent, createItem, createLoopbackBinding, getLeadShadow, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
// 测试可以让 shadow 会话晚一点建起来（一批还在跑的时候又来了事）。
let shadowGate: (() => Promise<void>) | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-shadow-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  shadowGate = null;
  db.close();
  vi.unstubAllEnvs();
});

const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));

type ShadowPlan = (ids: number[]) => ReturnType<typeof fauxAssistantMessage>[];

// shadow 的假模型：按这一批的编号（「这一批要你给结论的编号：#N」）照 plan 回答。每批一个新会话，每个会话从 plan 的第一步开始。
function fauxShadow(plan: ShadowPlan): { factory: ShadowSessionFactory; batches: number[][]; texts: string[] } {
  const batches: number[][] = [];
  const texts: string[] = [];
  const workDir = tempDir("plc-lead-shadow-session-");
  return {
    batches, texts,
    factory: async (request) => {
      await shadowGate?.();
      const faux = fauxProvider({ provider: "plc-shadow-test", api: "plc-shadow-test-api" });
      let steps: ReturnType<typeof fauxAssistantMessage>[] | null = null;
      faux.setResponses(Array.from({ length: 8 }, () => (context: { messages: Array<{ role: string; content: unknown }> }) => {
        if (!steps) {
          const last = [...context.messages].reverse().find((message) => message.role === "user");
          const text = typeof last?.content === "string" ? last.content
            : ((last?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
          texts.push(text);
          const ids = [...(/这一批要你给结论的编号：([^。]*)。/.exec(text)?.[1] ?? "").matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
          batches.push(ids);
          steps = plan(ids);
        }
        return steps.shift() ?? fauxAssistantMessage("完");
      }) as never);
      const model = faux.getModel() as { api: string; provider: string; id: string };
      const session = await createIsolatedLookupSession({
        workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: model as never,
        thinkingLevel: "off", retry: false, seedMessages: shadowOpeningMessages(model),
        extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
      });
      return { session, model: "plc-shadow-test/faux", note: null };
    },
  };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function boot(plan: ShadowPlan) {
  const logs: string[] = [];
  const lead = fakePiLead(() => ({ say: "处理了。" }), {
    smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }),
    contextUsage: { window: 1_000, tokens: 100 },
  });
  const shadow = fauxShadow(plan);
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    // 替身会话加上 shadow 要的两样东西：真的工具定义（读写这个测试库）和系统提示词。
    sessionFactory: (async (args: any) => ({
      ...(await (lead.factory as (input: unknown) => Promise<Record<string, unknown>>)(args)),
      shadow: leadShadowParts({ db: args.db, dbPath: args.dbPath, dataDir: args.dataDir }),
    })) as never,
    shadowSessionFactory: shadow.factory,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const setShadow = async (input: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/actions/lead_shadow/lead/set`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  return { lead, shadow, logs, setShadow };
}

function blocker(title: string): number {
  return addInbox(db, {
    itemId: createItem(db, { title, brief: "b", createdBy: "system" }),
    severity: "blocker", source: "structural", summary: title, lossless: true,
  }).id!;
}

function reminderFires(title: string): void {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
  db.transaction(() => appendEvent(db, {
    source: "timer", kind: "timer.fired", entityKey: `reminder:${itemId}`, level: "interrupt",
    payload: { timer: "reminder", scheduledAt: new Date().toISOString(), itemId, title, wakeLead: true },
  }))();
}

const inboxState = (id: number) => (db.prepare("SELECT state FROM inbox WHERE id = ?").get(id) as { state: string }).state;
const shadowEvents = (kind: string) => db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY seq").all(kind)
  .map((row) => JSON.parse((row as { payload: string }).payload) as Record<string, any>);

describe("the background shadow", () => {
  it("is off by default: the main session handles background events as before", async () => {
    const { lead, shadow } = await boot(() => []);
    expect(getLeadShadow(db).mode).toBe("off");
    blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, "依赖升级卡住了"))).toBe(true), { timeout: 2_000 });
    expect(shadow.batches).toEqual([]);
  });

  it("handles an event without waking the main session, and the main session reads one line about it later", async () => {
    const { lead, shadow, setShadow } = await boot((ids) => [
      fauxAssistantMessage([
        fauxToolCall("record_disposition", { event_ids: ids, disposition: "no_action", reason: "旧的告警，工单已经在跑" }),
        fauxToolCall("finish_shadow", { done: [{ ids, line: "依赖升级的告警是旧的，工单已经在重跑，不用管" }], escalate: [] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    await setShadow({ mode: "on", shares: { ticket: 100 } });
    const id = blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(inboxState(id)).toBe("consumed"), { timeout: 3_000 });
    expect(shadow.batches).toEqual([[id]]);
    // 交给 shadow 的是同一份事件块（Lead 的排版），开头是时钟和用户在不在。
    expect(shadow.texts[0]).toContain(`通知 #${id}`);
    expect(shadow.texts[0]).toContain('kind="presence"');
    expect(lead.calls).toEqual([]);
    expect(shadowEvents(LEAD_SHADOW_HANDLED_KIND)).toEqual([expect.objectContaining({ ids: [id], line: "依赖升级的告警是旧的，工单已经在重跑，不用管" })]);
    expect(shadowEvents(LEAD_SHADOW_RUN_KIND)[0]).toMatchObject({ mode: "on", done: [{ ids: [id] }], escalated: [] });

    // 主会话下一次开口（一条到点的提醒，永远交给主会话）：当前局面里有 shadow 处理的那一句。
    reminderFires("下午三点开会");
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThanOrEqual(1), { timeout: 3_000 });
    expect(lead.calls[0]!.situation).toContain("shadow 处理了 1 件");
    expect(lead.calls[0]!.situation).toContain("依赖升级的告警是旧的");
    expect(shadow.batches).toHaveLength(1);
  });

  it("hands an event back with its findings, and the main session gets it with the note", async () => {
    const { lead, shadow, setShadow } = await boot((ids) => [
      call("finish_shadow", { done: [], escalate: [{ ids, why: "要用户之前的安排", findings: "工单 #1 卡在依赖升级", suggestion: "问用户要不要降级" }] }),
      fauxAssistantMessage("完"),
    ]);
    await setShadow({ mode: "on", shares: { ticket: 100 } });
    const id = blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, `通知 #${id}`))).toBe(true), { timeout: 3_000 });
    const handed = lead.calls.find((entry) => has(entry, `通知 #${id}`))!;
    expect(has(handed, "shadow 交给你：要用户之前的安排")).toBe(true);
    expect(has(handed, "问用户要不要降级")).toBe(true);
    // 交回的事不再交给 shadow。
    await vi.waitFor(() => expect(inboxState(id)).toBe("consumed"), { timeout: 3_000 });
    expect(shadow.batches).toEqual([[id]]);
  });

  it("hands everything back when the shadow fails, and when it says done without recording a disposition", async () => {
    const { lead, setShadow } = await boot((ids) => [
      call("finish_shadow", { done: [{ ids, line: "看过了" }], escalate: [] }),
      fauxAssistantMessage("完"),
    ]);
    await setShadow({ mode: "on", shares: { ticket: 100 } });
    const id = blocker("发布流水线红了");
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, `通知 #${id}`))).toBe(true), { timeout: 3_000 });
    expect(lead.calls.some((entry) => has(entry, "但没有记下处置"))).toBe(true);
  });

  it("never takes a reminder, and keeps events that the settings leave to the main session", async () => {
    const { lead, shadow, setShadow } = await boot(() => []);
    await setShadow({ mode: "on", shares: { channel: 100, ticket: 0, other: 0 } });
    blocker("依赖升级卡住了");
    reminderFires("下午三点开会");
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, "依赖升级卡住了"))).toBe(true), { timeout: 3_000 });
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, "下午三点开会"))).toBe(true), { timeout: 3_000 });
    expect(shadow.batches).toEqual([]);
  });

  // 2026-11-20 线上：分给 channel 50%、ticket 和 other 0 时，清理扫描问「这个目录要不要删」的 inbox（对象 workspace-orphan:…）
  // 被当成外部对话交给了 shadow；shadow 只能交回来。它是 other，按设置留给主会话。
  it("does not take an inbox row on an internal object as an external conversation", async () => {
    const { lead, shadow, setShadow } = await boot(() => []);
    await setShadow({ mode: "on", shares: { channel: 100, ticket: 0, other: 0 } });
    addInbox(db, {
      dedupScope: "workspace-orphan:0123456789abcdef", severity: "attention", source: "structural", lossless: true,
      summary: "~/work/x.plc-workspaces/item-1 不属于任何工单，里面还有文件；没有删，等用户决定",
      payload: { inboxKind: "workspace_orphan_decision", path: "~/work/x.plc-workspaces/item-1", wakeLead: true, needsUser: true },
    });
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, "等用户决定"))).toBe(true), { timeout: 3_000 });
    expect(shadow.batches).toEqual([]);
  });

  it("gathers events that arrive close together into one batch", async () => {
    vi.stubEnv("PLC_SHADOW_GATHER_MS", "400");
    const { shadow, setShadow } = await boot((ids) => [
      fauxAssistantMessage([
        fauxToolCall("record_disposition", { event_ids: ids, disposition: "no_action", reason: "r" }),
        fauxToolCall("finish_shadow", { done: [{ ids, line: "两件旧告警" }], escalate: [] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    await setShadow({ mode: "on", shares: { ticket: 100 } });
    const first = blocker("依赖升级卡住了");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = blocker("发布流水线红了");
    await vi.waitFor(() => expect(inboxState(second)).toBe("consumed"), { timeout: 3_000 });
    expect(shadow.batches).toEqual([[first, second]]);
  });

  // 工单 #584：同一个对象连着来的事，以前一到就各开一批、同时跑，后一批看不到前一批的结论。现在等前一批结束再交，
  // 而且后一批的开头有前一批的交接（结论、看过的文件）。
  it("holds a new event on an object until its running batch ends, then hands over that batch's conclusion", async () => {
    const { shadow, setShadow } = await boot((ids) => [
      fauxAssistantMessage([
        fauxToolCall("record_disposition", { event_ids: ids, disposition: "no_action", reason: "r" }),
        fauxToolCall("finish_shadow", { done: [{ ids, line: `第 ${shadow.batches.length} 批：发布流水线的告警看过了` }], escalate: [] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    let calls = 0;
    shadowGate = async () => {
      calls += 1;
      started.push(calls);
      if (calls === 1) await gate;
    };
    await setShadow({ mode: "on", shares: { ticket: 100 } });
    const itemId = createItem(db, { title: "发布流水线", brief: "b", createdBy: "system" });
    const raise = (summary: string) => addInbox(db, { itemId, severity: "blocker", source: "structural", summary, lossless: true }).id!;
    const first = raise("发布流水线红了");
    await vi.waitFor(() => expect(started).toEqual([1]), { timeout: 2_000 });
    const second = raise("发布流水线又红了");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 前一批还在跑：第二件等着，不另开一批。
    expect(started).toEqual([1]);
    release();
    await vi.waitFor(() => expect(inboxState(second)).toBe("consumed"), { timeout: 3_000 });
    expect(shadow.batches).toEqual([[first], [second]]);
    expect(shadow.texts[1]).toContain("前面几批 shadow 刚处理过");
    expect(shadow.texts[1]).toContain(`ticket:${itemId}`);
    expect(shadow.texts[1]).toContain("第 1 批：发布流水线的告警看过了");
    expect(shadowEvents(LEAD_SHADOW_RUN_KIND)[0]).toMatchObject({ objects: [`ticket:${itemId}`], filesRead: [] });
  });

  it("in trial mode runs the shadow on the same batch without acting, while the main session handles it", async () => {
    const { lead, shadow, setShadow } = await boot((ids) => [
      fauxAssistantMessage([
        fauxToolCall("record_disposition", { event_ids: ids, disposition: "no_action", reason: "r" }),
        fauxToolCall("finish_shadow", { done: [{ ids, line: "不用管" }], escalate: [] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    await setShadow({ mode: "trial", shares: { ticket: 100 } });
    const id = blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(lead.calls.some((entry) => has(entry, `通知 #${id}`))).toBe(true), { timeout: 3_000 });
    await vi.waitFor(() => expect(shadowEvents(LEAD_SHADOW_RUN_KIND)).toHaveLength(1), { timeout: 3_000 });
    expect(shadow.batches).toEqual([[id]]);
    const run = shadowEvents(LEAD_SHADOW_RUN_KIND)[0]!;
    expect(run).toMatchObject({ mode: "trial", dispositions: { [String(id)]: "no_action" } });
    expect(run.calls.find((entry: { name: string }) => entry.name === "record_disposition")).toMatchObject({ dry: true });
    // 试运行不写处置，也不记「shadow 处理了」。
    const row = db.prepare("SELECT payload FROM inbox WHERE id = ?").get(id) as { payload: string };
    expect(JSON.parse(row.payload).disposition?.disposition).not.toBe("no_action");
    expect(shadowEvents(LEAD_SHADOW_HANDLED_KIND)).toEqual([]);
  });
});
