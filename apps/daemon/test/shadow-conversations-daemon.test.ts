// shadow 按对话复用会话（工单 #588），走整条持久化的流程：daemon、网关、store、通道 hub、Slack 来源插件、Lead 的输入都是真的；
// Slack 和 SmartModel 是替身（FakeSlack、scriptedSmartModel），主会话是替身（fake-pi-session.ts），shadow 是真的隔离 pi 会话
// （存成文件），模型是 pi-ai 的假模型（faux）。人和原文都是编造的。
//
// 以前（11-27 的事）：同事在私信里先连发两张截图，再发一句话。这三条被拆成两批交给 shadow，每批开一个新的内存会话，批与批之间不交接：
// 第二批没读图，回了错话。现在：同一段对话的消息等一会儿合成一批，进同一个存成文件的会话；会话闲置卸载、daemon 重启以后，
// 下一批打开同一个文件接着做。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createIsolatedLookupSession, leadShadowParts, shadowOpeningMessages, type ShadowSessionFactory } from "@pi-lead-child/lead";
import { LEAD_SHADOW_RUN_KIND, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import {
  appendShadowWork, createLoopbackBinding, getChannelCard, getShadowConversation, listEvents, listShadowWork, openDb, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-shadow-conversations-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const MARK = /这一批要你给结论的编号：([^。]*)。/u;
type Step = ReturnType<typeof fauxAssistantMessage>;
type Plan = (ids: number[], text: string) => Step[];

interface Opened { file: string | null; created: string | null }

// shadow 的假模型：每一批（带「这一批要你给结论的编号」的那条消息）按 plan 回答。会话按 request.persist 存成文件。
// opened：每次建会话时要打开的文件（null 是新建）和建好的文件。contexts：每一批开始时模型看到的消息条数。
function fauxShadow(plan: Plan) {
  const batches: number[][] = [];
  const texts: string[] = [];
  const opened: Opened[] = [];
  const contexts: number[] = [];
  const workDir = tempDir("plc-shadow-conversation-session-");
  const factory: ShadowSessionFactory = async (request) => {
    const faux = fauxProvider({ provider: "plc-shadow-test", api: "plc-shadow-test-api" });
    let steps: Step[] = [];
    let current: string | null = null;
    faux.setResponses(Array.from({ length: 60 }, () => (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const textOf = (message: { content: unknown }) => (typeof message.content === "string" ? message.content
        : ((message.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      const last = [...context.messages].reverse().find((message) => message.role === "user" && MARK.test(textOf(message)));
      const text = last ? textOf(last) : "";
      if (text && text !== current) {
        current = text;
        texts.push(text);
        contexts.push(context.messages.length);
        const ids = [...(MARK.exec(text)?.[1] ?? "").matchAll(/#(\d+)/gu)].map((match) => Number(match[1]));
        batches.push(ids);
        steps = plan(ids, text);
      }
      return steps.shift() ?? fauxAssistantMessage("完");
    }) as never);
    const model = faux.getModel() as { api: string; provider: string; id: string };
    const session = await createIsolatedLookupSession({
      workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: model as never,
      thinkingLevel: "off", retry: false, seedMessages: shadowOpeningMessages(model),
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
      ...(request.persist ? { persist: request.persist } : {}),
    });
    opened.push({ file: request.persist?.file ?? null, created: session.sessionFile?.() ?? null });
    return { session, model: "plc-shadow-test/faux", note: null };
  };
  return { factory, batches, texts, opened, contexts };
}

const settle = (note: string): Plan => (ids) => [
  fauxAssistantMessage([
    fauxToolCall("record_disposition", { event_ids: ids, disposition: "no_action", reason: note }),
    fauxToolCall("finish_shadow", { done: [{ ids, line: note }], escalate: [] }),
  ], { stopReason: "toolUse" }),
  fauxAssistantMessage("完"),
];

async function boot(slack: FakeSlack, shadow: ReturnType<typeof fauxShadow>) {
  const logs: string[] = [];
  const lead = fakePiLead(() => ({ say: "NO_REPLY" }), { smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async (args: any) => ({
      ...(await (lead.factory as (input: unknown) => Promise<Record<string, unknown>>)(args)),
      // 真的工具定义和依赖（通道的卡、操作层），和 daemon 交给主会话的同一份。
      shadow: leadShadowParts({ ...args }),
    })) as never,
    shadowSessionFactory: shadow.factory,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const response = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/actions/lead_shadow/lead/set`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ input: { mode: "on", shares: { channel: 100 } } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const receive = async (delivery: ReturnType<FakeSlack["dm"]>) => {
    await daemon!.channels!.receive("slack", delivery);
    await daemon!.channels!.idle();
  };
  return { lead, logs, receive };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const shadowRuns = () => listEvents(db, { kind: LEAD_SHADOW_RUN_KIND });
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));

describe("shadow conversations (ticket #588)", () => {
  // 11-27 那种情况（人和原文是编造的）：两张截图加一句话，连着发。以前第一条马上交给 shadow，后两条进了第二批（第二批的新会话里没有第一张图）。
  it("waits briefly and hands two screenshots and a sentence from one DM to the shadow as one batch", async () => {
    vi.stubEnv("PLC_SHADOW_MESSAGE_QUIET_MS", "1500");
    const slack = new FakeSlack({ users: { U0LEILEI: { name: "李雷" } } });
    const shadow = fauxShadow(settle("看过两张截图：账号被风控拦了，已经在处理"));
    const { lead, receive } = await boot(slack, shadow);
    const first = slack.addFile("blocked-1.png", "image/png", new Uint8Array([1, 2, 3]));
    const second = slack.addFile("blocked-2.png", "image/png", new Uint8Array([4, 5, 6]));
    await receive(slack.dm("U0LEILEI", "", { files: [first] }));
    await pause(150);
    await receive(slack.dm("U0LEILEI", "", { files: [second] }));
    await pause(150);
    await receive(slack.dm("U0LEILEI", "我被加入黑名单了"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(1), { timeout: 10_000 });
    await pause(300);
    // 一批，进一个会话：两张图的文件编号和那句话都在这一批里。
    expect(shadow.batches).toHaveLength(1);
    expect(shadow.opened).toHaveLength(1);
    expect(shadow.texts[0]).toContain(first.id);
    expect(shadow.texts[0]).toContain(second.id);
    expect(shadow.texts[0]).toContain("我被加入黑名单了");
    // 这一批的每条消息都有了处置；主会话没有被叫醒。
    expect(messageEvents().every((event) => event.disposition !== null)).toBe(true);
    expect(lead.calls.filter((call) => has(call, "我被加入黑名单了"))).toEqual([]);
  }, 30_000);

  it("reuses one session file for one DM: the next batch, after unloading when idle, and after a daemon restart", async () => {
    vi.stubEnv("PLC_SHADOW_IDLE_MS", "400");
    const slack = new FakeSlack({ users: { U0HANMM: { name: "韩梅梅" } } });
    const shadow = fauxShadow(settle("闲聊，不用回"));
    const { receive, logs } = await boot(slack, shadow);

    await receive(slack.dm("U0HANMM", "早上好"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(1), { timeout: 10_000 });
    expect(shadow.opened).toEqual([{ file: null, created: expect.any(String) }]);
    const file = shadow.opened[0]!.created!;
    expect(existsSync(file)).toBe(true);
    expect(getShadowConversation(db, "slack:D0HANMM")).toMatchObject({ sessionFile: file, lastMessageAt: expect.any(String) });

    // 马上又来一条：会话还在内存里，接着用，没有再建会话；模型看得到上一批。
    await receive(slack.dm("U0HANMM", "今天天气不错"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(2), { timeout: 10_000 });
    expect(shadow.opened).toHaveLength(1);
    expect(shadow.contexts[1]!).toBeGreaterThan(shadow.contexts[0]!);
    expect(shadow.texts[1]).toContain("这一批的消息各自来自哪里");

    // 闲置以后卸载（文件留着）：下一条打开同一个文件接着做。
    await vi.waitFor(() => expect(logs.some((line) => line.includes("unloaded slack:D0HANMM"))).toBe(true), { timeout: 5_000 });
    await receive(slack.dm("U0HANMM", "中午吃什么"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(3), { timeout: 10_000 });
    expect(shadow.opened[1]).toEqual({ file, created: file });
    expect(shadow.contexts[2]!).toBeGreaterThan(shadow.contexts[1]!);

    // daemon 重启以后：同一个对话的消息还是打开这个文件。
    await daemon!.close();
    daemon = null;
    const again = fauxShadow(settle("闲聊，不用回"));
    const rebooted = await boot(slack, again);
    await rebooted.receive(slack.dm("U0HANMM", "下午开会吗"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(4), { timeout: 10_000 });
    expect(again.opened).toEqual([{ file, created: file }]);
    expect(again.contexts[0]!).toBeGreaterThan(shadow.contexts[2]!);
  }, 40_000);

  it("starts a new session from the work record when the shadow's configuration changes", async () => {
    const slack = new FakeSlack({ users: { U0HANMM: { name: "韩梅梅" } } });
    const shadow = fauxShadow(settle("闲聊，不用回"));
    const { receive } = await boot(slack, shadow);
    await receive(slack.dm("U0HANMM", "早上好"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(1), { timeout: 10_000 });
    appendShadowWork(db, "slack:D0HANMM", [{ kind: "attachment", ref: "slack:F0000001", text: "截图里写着：账号已被冻结" }]);
    // 改了常设指令（系统提示词变了）：配置版本不一样，下一批新开会话，带着工作记录。
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('lead.profile', '{"name":"小助手"}', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    await receive(slack.dm("U0HANMM", "图里写的什么"));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(2), { timeout: 10_000 });
    expect(shadow.opened).toHaveLength(2);
    expect(shadow.opened[1]!.file).toBeNull();
    expect(shadow.opened[1]!.created).not.toBe(shadow.opened[0]!.created);
    expect(shadow.texts[1]).toContain("截图里写着：账号已被冻结");
  }, 30_000);

  // 同一个会话里私信主对话和私信 thread 交替来消息：回复、处置、草稿各自落到自己那条消息的卡和回复位置。
  it("lands each reply, disposition and draft on the card and reply place of its own message in a DM and its thread", async () => {
    vi.stubEnv("PLC_SHADOW_MESSAGE_QUIET_MS", "800");
    const slack = new FakeSlack({ users: { U0LEILEI: { name: "李雷" } } });
    const origins = (text: string) => new Map([...text.matchAll(/- #(\d+)：[^\n]*?（conversation=([^，）]+)/gu)]
      .map((match) => [Number(match[1]), match[2]!] as const));
    let round = 0;
    const shadow = fauxShadow((ids, text) => {
      round += 1;
      const where = origins(text);
      if (round === 1) {
        // 第一批：主对话的一条直接回；thread 里的一条带草稿记 told_user。
        const [main, thread] = ids;
        return [
          fauxAssistantMessage([
            fauxToolCall("reply_to_source", { event: main!, conversation: where.get(main!)!, text: "收到，周五前给你。" }),
            fauxToolCall("record_disposition", { event_ids: [thread!], disposition: "told_user", reason: "要用户自己定", draft: "这个我确认一下再回你。" }),
            fauxToolCall("finish_shadow", { done: [{ ids: [main!], line: "回了排期" }, { ids: [thread!], line: "草稿留给用户" }], escalate: [] }),
          ], { stopReason: "toolUse" }),
          fauxAssistantMessage("完"),
        ];
      }
      return [
        fauxAssistantMessage([
          ...ids.map((id) => fauxToolCall("reply_to_source", { event: id, conversation: where.get(id)!, text: `回 #${id}` })),
          fauxToolCall("finish_shadow", { done: [{ ids, line: "都回了" }], escalate: [] }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("完"),
      ];
    });
    const { receive } = await boot(slack, shadow);
    const root = slack.dm("U0LEILEI", "排期定了吗");
    const rootTs = slack.messageOf(root).ts;
    await receive(root);
    await pause(100);
    await receive(slack.dm("U0LEILEI", "另外这个接口要不要加字段", { thread: "1700000000.000100" }));
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(1), { timeout: 10_000 });
    const [mainEvent, threadEvent] = messageEvents();
    expect(shadow.batches[0]).toEqual([mainEvent!.seq, threadEvent!.seq]);
    expect(mainEvent!.payload.session).toEqual({ key: "slack:D0LEILEI" });
    expect(threadEvent!.payload.session).toEqual({ key: "slack:D0LEILEI", thread: "1700000000.000100" });
    // 主对话那条的回复回在它下面的 thread（回复都进 thread），卡结束；thread 那条的卡留着草稿等用户。
    const sentAfterFirst = slack.sent("D0LEILEI").filter((message) => message.text.includes("收到，周五前给你。"));
    expect(sentAfterFirst.map((message) => message.thread_ts)).toEqual([rootTs]);
    const mainCard = getChannelCard(db, mainEvent!.payload.cardId as number)!;
    const threadCard = getChannelCard(db, threadEvent!.payload.cardId as number)!;
    expect(mainCard.id).not.toBe(threadCard.id);
    expect(mainCard.state).toBe("auto_replied");
    expect(threadCard.state).toBe("open");
    expect(threadCard.draft?.text ?? JSON.stringify(threadCard.draft)).toContain("这个我确认一下再回你。");

    // 第二批：两边又各来一条（thread 先来），同一个会话里各自回到自己的位置。
    await receive(slack.dm("U0LEILEI", "字段叫 region 可以吗", { thread: "1700000000.000100" }));
    await pause(100);
    const later = slack.dm("U0LEILEI", "还有，周五几点");
    const laterTs = slack.messageOf(later).ts;
    await receive(later);
    await vi.waitFor(() => expect(shadowRuns()).toHaveLength(2), { timeout: 10_000 });
    expect(shadow.opened).toHaveLength(1);
    const [, , threadLater, mainLater] = messageEvents();
    const sent = (seq: number) => slack.sent("D0LEILEI").filter((message) => message.text.endsWith(`回 #${seq}`)).map((message) => message.thread_ts);
    expect(sent(threadLater!.seq)).toEqual(["1700000000.000100"]);
    expect(sent(mainLater!.seq)).toEqual([laterTs]);
    expect(threadLater!.payload.cardId).toBe(threadCard.id);
    expect(mainLater!.payload.cardId).not.toBe(threadCard.id);
    // 回复和处置自动记进了这段对话的工作记录。
    const record = listShadowWork(db, "slack:D0LEILEI").map((entry) => entry.text).join("\n");
    expect(record).toContain("收到，周五前给你。");
    expect(record).toContain(`消息事件 #${threadEvent!.seq} 记成 told_user`);
  }, 40_000);

  it("records a message as handled by the user when the user replied in Slack before the shadow took it", async () => {
    vi.stubEnv("PLC_SHADOW_MESSAGE_QUIET_MS", "1500");
    const slack = new FakeSlack({ users: { U0LEILEI: { name: "李雷" } } });
    const shadow = fauxShadow(settle("不该走到这里"));
    const { lead, receive } = await boot(slack, shadow);
    const asked = slack.dm("U0LEILEI", "明天的会还开吗");
    await receive(asked);
    await vi.waitFor(() => expect(messageEvents()).toHaveLength(1), { timeout: 5_000 });
    // 用户自己在 Slack 里回了（在这条消息的 thread 里，主对话的卡在另一个对话里，hub 自己不会关它）。
    await receive(slack.selfReply("D0LEILEI", "开，十点", { thread: slack.messageOf(asked).ts }));
    await vi.waitFor(() => expect(messageEvents()[0]!.disposition).toBe("resolved_elsewhere"), { timeout: 5_000 });
    await pause(2_000);
    expect(shadow.batches).toEqual([]);
    expect(lead.calls.filter((call) => has(call, "明天的会还开吗"))).toEqual([]);
  }, 30_000);

  it("brings the channel's earlier root messages into a new session for a channel thread", async () => {
    const slack = new FakeSlack({ users: { U0LEILEI: { name: "李雷" }, U0HANMM: { name: "韩梅梅" } } });
    const shadow = fauxShadow(settle("看过了"));
    const { receive } = await boot(slack, shadow);
    // 主时间线上先有几条消息（订阅频道的普通消息不交给 shadow），其中一条下面有别的 thread 的回复。
    const earlier = slack.chatter("U0HANMM", "部署窗口改到周四了", "C0PROJ");
    await daemon!.channels!.receive("slack", earlier);
    await daemon!.channels!.receive("slack", slack.chatter("U0LEILEI", "收到", "C0PROJ", { thread: slack.messageOf(earlier).ts }));
    await daemon!.channels!.receive("slack", slack.chatter("U0HANMM", "回滚预案在 wiki 上", "C0PROJ"));
    await daemon!.channels!.idle();
    const root = slack.mention("U0LEILEI", "这个改动周四能上吗", { channel: "C0PROJ" });
    await receive(root);
    await receive(slack.mention("U0LEILEI", "补充一下，是支付那块", { channel: "C0PROJ", thread: slack.messageOf(root).ts }));
    await vi.waitFor(() => expect(shadow.texts.some((text) => text.includes("补充一下"))).toBe(true), { timeout: 10_000 });
    const threadText = shadow.texts.find((text) => text.includes("补充一下"))!;
    expect(threadText).toContain("这个 thread 开始之前，主时间线上的");
    expect(threadText).toContain("部署窗口改到周四了（下面有 1 条回复）");
    expect(threadText).toContain("回滚预案在 wiki 上");
    // 别的 thread 的回复不带全文。
    expect(threadText).not.toContain("：收到");
  }, 30_000);
});
