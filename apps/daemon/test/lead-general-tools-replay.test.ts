// Lead 用通用工具处理外部消息，并且必须带草稿（统一消息事件 spec D6、D8、D9、D11，工单 05）：用 10-26 的真实情况回放。
// daemon、网关、store、通道 hub、Slack 来源插件、操作层、派单器、Lead 的工具都是真的；Slack、SmartModel（假 Jev）、
// Lead 的会话（假模型，按脚本调工具）、子 agent 的模型（faux）是替身。自动代回的用例关掉抽查（audit: { rate: 0 }）。
//   场景 1：Ethan「这个 pr 记得再帮我看看」没带链接：上下文包里有以前带链接的消息；Lead 派 review 子 agent，不推给用户。
//   场景 2：李雷问三个仓库上线没有，消息改了两次：只处理一次；Lead 派查进度的子 agent；交回以后 Lead 推给用户的草稿写查到的事实。
//   场景 4：李雷「那我更新一下修复情况」：Lead 判断不用回（record_disposition），卡结束，请求关掉。
//   场景 5（回归）：Ivy 让用户按映射给两个人发消息：Lead 在事件轮里发给两个人，再回复 Ivy，卡结束。
//   场景 6：Lucas「你那个应用可用吗」「fairy」：Lead 推给用户的草稿回应 Fairy 能不能用，两条消息一次处理完。
//   场景 7：Kent 连发三条：Lead 推给用户一份回应整段话的草稿。
//   场景 9：用户请 Ethan 帮忙，Ethan 回「ok」：Lead 回 heart，卡结束。
//   场景 10：Simon 要用户点 release-train 的 ticket：Lead 推给用户并带草稿；用户点「我自己回」，卡马上结束。
//   工单 06 的场景 3、4、14 和固定拒绝在最后一组。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIsolatedLookupSession, createLeadTools, type LookupSession, type LookupSessionFactory } from "@pi-lead-child/lead";
import { withCallObserver } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { MESSAGE_EVENT_KIND, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, getChannelCard, listEvents, openDb, recordDecisionModelCall, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sessions: LookupSession[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-general-tools-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  for (const session of sessions.splice(0)) {
    try {
      session.dispose();
    } catch {
      // 已经释放。
    }
  }
  db.close();
  vi.unstubAllEnvs();
});

// 子 agent 的会话：faux 模型按给的步骤回答。
function fauxFactory(steps: Step[]): LookupSessionFactory {
  const faux = fauxProvider({ provider: "plc-lead-general-tools", api: "plc-lead-general-tools-api" });
  faux.setResponses(steps);
  const workDir = tempDir("plc-lead-general-tools-session-");
  return async (request) => {
    const session = await createIsolatedLookupSession({
      workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: faux.getModel() as never, thinkingLevel: "off", retry: false,
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
    });
    sessions.push(session);
    return { session, model: "plc-lead-general-tools/faux" };
  };
}

// 子 agent 交一个结果就结束。
const submitting = (result: Record<string, unknown>): Step[] => [
  fauxAssistantMessage([fauxToolCall("submit_result", { checked: [], caveats: [], sources: [], ...result } as never)], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
];

type Live = (name: string) => any;

// 起一个接了假 Slack 的 daemon。script：Lead 每次调模型时的回答，live(name) 是 daemon 交给会话的那一份工具（这一轮由 daemon 给）。
// trust：Slack 来源插件的信任配置（你信任的人、外部客户）。networkProbe：网络通不通（模拟 Lead 的模型连不上）。
async function boot(slack: FakeSlack, options: {
  answers?: NonNullable<Parameters<typeof scriptedSmartModel>[0]>["answers"];
  script?: (call: FakeCall, live: Live) => Promise<FakeReply> | FakeReply;
  subAgent?: Step[];
  trust?: { trusted?: string[]; customers?: string[] };
  networkProbe?: () => Promise<string | null>;
} = {}) {
  const model = scriptedSmartModel({ answers: options.answers ?? {} });
  let leadDeps: any = null;
  const live: Live = (name) => createLeadTools(leadDeps).find((candidate: any) => candidate.name === name) as any;
  const lead = fakePiLead((call) => (options.script ? options.script(call, live) : { say: "NO_REPLY" }));
  const desktop: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: (text) => desktop.push(text), triageShadow: false,
    sessionFactory: (async (args: any) => {
      leadDeps = args;
      return { ...(await lead.factory(args)), smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)) };
    }) as never,
    ...(options.networkProbe ? { networkProbe: options.networkProbe } : {}),
    channels: {
      sources: { slack: { api: slack.api, ...(options.trust ? { trust: options.trust } : {}) } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
    ...(options.subAgent ? { agentTasks: { sessionFactory: fauxFactory(options.subAgent) } } : {}),
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  // Lead 的工具：和真的会话一样用 daemon 交来的依赖。turnId 为 null 是被事件叫醒的一轮（不是用户的一轮）。
  const result = async (name: string, params: Record<string, unknown>, turnId: string | null = null) => {
    const tool = createLeadTools({ ...leadDeps, currentTurnId: () => turnId }).find((candidate: any) => candidate.name === name) as any;
    if (!tool) throw new Error(`Lead 没有工具 ${name}`);
    const output = await tool.execute("call", params);
    const text = output.content[0].text as string;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const received = async (delivery: ReturnType<FakeSlack["dm"]>) => {
    const item = (await daemon!.channels!.receive("slack", delivery)).items[0]!;
    await daemon!.channels!.idle();
    await vi.waitFor(() => expect(cardIdOf(db, item)).not.toBeNull(), { timeout: 10_000 });
    return { ...item, cardId: cardIdOf(db, item)! };
  };
  // 用户在网关上和 Lead 说一句话（Companion 的入口）。
  const say = async (text: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${owner.accessToken}&protocol=2&after_seq=-1`);
    sockets.push(socket);
    const events: Array<{ type?: string }> = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    socket.send(JSON.stringify({ type: "chat.send", id: `cmd-${text.length}`, protocolVersion: 2, message: text }));
  };
  return { lead, model, desktop, result, received, say, live };
}

// 这张卡的消息事件（交给 Lead 的输入），按先后。
const messageEventsOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId);
const latestEventOf = (cardId: number) => messageEventsOf(cardId).at(-1)!.seq;
// 这张卡上 Lead（或者系统兜底）的决定。
const decisionsOf = (cardId: number) => listEvents(db, { kind: "channel.lead.decided" })
  .filter((event) => event.payload.cardId === cardId).map((event) => event.payload);
const inputsOf = (lead: ReturnType<typeof fakePiLead>) => lead.calls.flatMap((call) => call.inputs).join("\n");
const eventSeqIn = (text: string) => Number(/消息事件 #(\d+)/u.exec(text)?.[1] ?? NaN);
// 系统替用户发出去的话（不算「正在处理」那一句）。
const replies = (slack: FakeSlack, channel: string) =>
  slack.sent(channel).map((message) => message.text).filter((text) => !/ is (checking|reviewing|looking into this|investigating|working on this)…$/u.test(text));
const AUTO = ":robot_face: Paimon (Assistant) · auto-reply for 我\n";

describe("Lead handles external messages with the general tools (unified-message-events 05)", () => {
  // 回归（10-26 Ivy）：以前事件轮里 Lead 只能回「你说『发』，我就代你发」；发给别人的话还带着「confirmed by 用户」的署名，
  // 用户其实没有确认过。现在 Lead 在事件轮里照做，回复 Ivy 过出站的信心检验，代发时带 auto-reply 的署名，卡结束。
  it("scenario 5: in the turn Ivy's message woke, Lead messages the two people and replies to Ivy; the card ends", async () => {
    const slack = new FakeSlack({ users: { U0IVYLIN: { name: "Ivy Lin" }, U0NINA: { name: "Nina Hu" }, U0LUCAS: { name: "Lucas" } } });
    slack.scopes.push("im:write");
    const results: unknown[] = [];
    await boot(slack, {
      script: async (call, live) => {
        const input = call.inputs.join("\n");
        if (input.includes('<system_event kind="message"') && input.includes("Ivy Lin")) {
          const event = eventSeqIn(input);
          const send = async (conversation: string, text: string) => JSON.parse((await live("send_channel_message").execute("call", {
            conversation, text, words: "assistant", reason: "Ivy 让用户按映射关系通知两个人",
          })).content[0].text);
          results.push(await send("slack:@U0NINA", "Nina，PROJ-34469 麻烦改成已修复。"));
          results.push(await send("slack:@U0LUCAS", "Lucas，PROJ-34470 麻烦确认一下。"));
          results.push(JSON.parse((await live("reply_to_source").execute("call", { event, text: "已经分别发给 Nina 和 Lucas 了。" })).content[0].text));
          return { say: "Ivy 让我按映射通知两个人，已经发了，也回复了 Ivy。" };
        }
        return { say: "NO_REPLY" };
      },
    });
    const ivyDelivery = slack.dm("U0IVYLIN", "按照下面映射关系，发相应的 slack 消息：PROJ-34469 → Nina，PROJ-34470 → Lucas");
    const ivy = (await daemon!.channels!.receive("slack", ivyDelivery)).items[0]!;

    await vi.waitFor(() => expect(results).toHaveLength(3), { timeout: 15_000 });
    const cardId = cardIdOf(db, ivy)!;
    // 发给两个人的话是 Lead 自己在事件轮里发的：带 auto-reply 的署名，不写「confirmed by」。
    expect(replies(slack, "D0NINA")).toEqual([`${AUTO}Nina，PROJ-34469 麻烦改成已修复。`]);
    expect(replies(slack, "D0LUCAS")).toEqual([`${AUTO}Lucas，PROJ-34470 麻烦确认一下。`]);
    // 回复 Ivy 过了信心检验，代发，卡结束（自动回复，留撤回窗口）。
    expect(replies(slack, "D0IVYLIN")).toEqual([`${AUTO}已经分别发给 Nina 和 Lucas 了。`]);
    expect(getChannelCard(db, cardId)).toMatchObject({ state: "auto_replied" });
    expect(getChannelCard(db, cardId)!.revokeUntil).not.toBeNull();
    // 请求由 Lead 关掉，没有通道请求，也没有系统兜底。
    expect(listEvents(db, { kind: "channel.lead.requested" })).toEqual([]);
    expect(decisionsOf(cardId).length).toBeGreaterThan(0);
    expect(decisionsOf(cardId).every((decision) => decision.by === "lead")).toBe(true);
    // 账本：三次都是 Lead 自己做的（不是代用户做）。
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND }).map((event) => event.payload)).toMatchObject([
      { action: "send_message", actor: "lead", authority: "lead" },
      { action: "send_message", actor: "lead", authority: "lead" },
      { action: "send_message", actor: "lead", authority: "lead" },
    ]);
  }, 30_000);

  // 回归（10-26：6 次超时里有 5 次，Lead 已经有了判断，但用了通用的 record_disposition，它对通道请求什么也不做）。
  it("scenario 4: Lead judges 「那我更新一下修复情况」 needs no reply with record_disposition; the card ends and the request closes", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    const { result, received } = await boot(slack);
    const yi = await received(slack.dm("U0LILEI", "那我更新一下修复情况"));
    await vi.waitFor(() => expect(messageEventsOf(yi.cardId)).toHaveLength(1), { timeout: 10_000 });
    const event = latestEventOf(yi.cardId);

    const recorded = await result("record_disposition", {
      event_ids: [event], disposition: "no_action", reason: "李雷只是说一声他去更新修复情况，不用回",
    });
    expect(String(recorded)).not.toContain("已记下 0 件事");
    expect(getChannelCard(db, yi.cardId)).toMatchObject({ state: "handled" });
    expect(decisionsOf(yi.cardId)).toMatchObject([{ decision: "no_reply", by: "lead" }]);
    expect(slack.sent("D0LILEI")).toEqual([]);
    // 期限到了也不兜底：请求已经关了。
    await daemon!.channels!.tick();
    expect(decisionsOf(yi.cardId)).toHaveLength(1);
  }, 30_000);

  it("scenario 9: the user asked Ethan for help and Ethan says ok: Lead reacts with heart, and the card ends", async () => {
    const slack = new FakeSlack({ users: { U0ETHAN: { name: "Ethan" } } });
    const { result, received } = await boot(slack, {
      answers: {
        ask_kind: (state) => (state.split("\n\n")[0] === "ok" ? "closing" : "other"), closing_kind: "they_agree", reaction_emoji: "heart",
      },
    });
    const okDelivery = slack.dm("U0ETHAN", "ok");
    const ok = await received(okDelivery);
    await vi.waitFor(() => expect(messageEventsOf(ok.cardId)).toHaveLength(1), { timeout: 10_000 });

    const reacted = await result("react_channel_message", {
      event: latestEventOf(ok.cardId), emoji: "heart", reason: "用户刚请 Ethan 帮忙，他答应了：回表示感谢的表情",
    });
    expect(reacted).toMatchObject({ authority: "lead", result: { reacted: { emoji: "heart", card: { id: ok.cardId, state: "handled" } } } });
    expect(slack.messageOf(okDelivery).reactions).toEqual([{ name: "heart", users: [slack.credential.account] }]);
    expect(getChannelCard(db, ok.cardId)).toMatchObject({ state: "handled" });
    expect(decisionsOf(ok.cardId).every((decision) => decision.by === "lead")).toBe(true);
    expect(decisionsOf(ok.cardId).length).toBeGreaterThan(0);
  }, 30_000);

  it("scenario 10: Lead pushes Simon's request to the user with its own draft; 我自己回 ends the card at once", async () => {
    const slack = new FakeSlack({ users: { U0SIMON: { name: "Simon" } } });
    const { result, received, desktop } = await boot(slack);
    const simon = await received(slack.dm("U0SIMON", "release-train 的 ticket RT-88 需要你在 Jira 上点一下 approve"));
    await vi.waitFor(() => expect(messageEventsOf(simon.cardId)).toHaveLength(1), { timeout: 10_000 });
    const before = desktop.length;

    // 推给用户时必须带草稿。
    const missing = await result("notify_user", { event: latestEventOf(simon.cardId), title: "Simon 请你点 release-train 的 RT-88" })
      .catch((error: Error) => error.message);
    expect(String(missing)).toContain("草稿");
    await result("notify_user", {
      event: latestEventOf(simon.cardId), title: "Simon 请你点 release-train 的 RT-88",
      draft: "好的，我这就去 Jira 上点 RT-88。",
    });
    expect(getChannelCard(db, simon.cardId)).toMatchObject({ state: "open", draft: { text: "好的，我这就去 Jira 上点 RT-88。", drafter: "lead" } });
    expect(desktop.slice(before).filter((line) => line.includes("Simon"))).toHaveLength(1);
    expect(decisionsOf(simon.cardId)).toMatchObject([{ decision: "push", by: "lead" }]);

    // 用户点「我自己回」：卡马上结束，不等用户在 Slack 里回。
    await daemon!.channels!.act(simon.cardId, "reply_myself", { by: "user" });
    expect(getChannelCard(db, simon.cardId)).toMatchObject({ state: "left_to_user" });
    await daemon!.channels!.tick();
    expect(desktop.slice(before).filter((line) => line.includes("Simon"))).toHaveLength(1);
  }, 30_000);

  it("scenario 6: Lucas's two messages are handled once, with Lead's draft about whether Fairy works", async () => {
    const slack = new FakeSlack({ users: { U0LUCAS: { name: "Lucas" } } });
    const { result, received, desktop } = await boot(slack);
    const first = await received(slack.dm("U0LUCAS", "你那个应用可用吗"));
    const second = await received(slack.dm("U0LUCAS", "fairy"));
    expect(second.cardId).toBe(first.cardId);
    await vi.waitFor(() => expect(messageEventsOf(first.cardId)).toHaveLength(2), { timeout: 10_000 });
    const before = desktop.length;

    await result("notify_user", {
      event: latestEventOf(first.cardId), title: "Lucas 问 Fairy 现在能不能用",
      draft: "Fairy 现在能用了，不过还在内测，我把安装方式发你。",
    });
    expect(getChannelCard(db, first.cardId)).toMatchObject({
      state: "open", draft: { text: "Fairy 现在能用了，不过还在内测，我把安装方式发你。", drafter: "lead" },
    });
    expect(desktop.slice(before).filter((line) => line.includes("Lucas"))).toHaveLength(1);
    // 两条消息的请求都关了：前一条并进后一条，后一条由 Lead 推送。
    expect(decisionsOf(first.cardId).map((decision) => [decision.decision, decision.by])).toEqual([["superseded", "system"], ["push", "lead"]]);
    await daemon!.channels!.tick();
    expect(decisionsOf(first.cardId)).toHaveLength(2);
  }, 30_000);

  it("scenario 7: Kent's three messages get one draft that answers the whole of it, pushed to the user", async () => {
    const slack = new FakeSlack({ users: { U0KENT: { name: "Kent" } } });
    const { result, received, desktop } = await boot(slack);
    const card = (await received(slack.dm("U0KENT", "你这项目啥时候给我玩"))).cardId;
    await received(slack.dm("U0KENT", "那个机器人 不好用"));
    await received(slack.dm("U0KENT", "hermes 也差点感觉"));
    await vi.waitFor(() => expect(messageEventsOf(card)).toHaveLength(3), { timeout: 10_000 });
    const before = desktop.length;

    const draft = "快了，下周给你开个账号。那个机器人 和 hermes 的问题我也记下了，Fairy 这边正好在补这块。";
    await result("notify_user", { event: latestEventOf(card), title: "Kent 想试用 Fairy，顺带吐槽了 那个机器人 和 hermes", draft });
    expect(getChannelCard(db, card)).toMatchObject({ state: "open", draft: { text: draft, drafter: "lead" } });
    expect(desktop.slice(before).filter((line) => line.includes("Kent"))).toHaveLength(1);
    expect(decisionsOf(card).filter((decision) => decision.by === "lead")).toMatchObject([{ decision: "push" }]);
    expect(decisionsOf(card).filter((decision) => decision.by === "system").map((decision) => decision.decision)).toEqual(["superseded", "superseded"]);
  }, 30_000);

  it("scenario 1: Ethan's 「这个 pr 记得再帮我看看」 without a link: the context pack has the old link; Lead dispatches a review and does not push", async () => {
    const slack = new FakeSlack({ users: { U0ETHAN: { name: "Ethan" } } });
    const { result, received, desktop } = await boot(slack, {
      answers: { ask_kind: (state) => (/review|看看/u.test(state.split("\n\n")[0]!) ? "code_review" : "other"), handling_verb: "reviewing" },
      subAgent: submitting({ found: "no", answer: "没有读到 PR", replyDraft: "" }),
    });
    // 10-23：Ethan 带着链接请用户 review，用户处理过了。
    const old = await received(slack.dm("U0ETHAN", "明哥 帮忙 review 一下 https://github.com/acme/widgets/pull/12"));
    await daemon!.channels!.act(old.cardId, "dismiss", { by: "user" });
    slack.later(3 * 24 * 60 * 60_000);
    // 10-26：没带链接。
    const ethan = await received(slack.dm("U0ETHAN", "明哥，这个 pr 记得再帮我看看"));
    await vi.waitFor(() => expect(messageEventsOf(ethan.cardId)).toHaveLength(1), { timeout: 10_000 });
    const [message] = messageEventsOf(ethan.cardId);
    const context = message!.payload.context as { conversation: { messages: Array<{ text: string }> } };
    expect(context.conversation.messages.map((entry) => entry.text).join("\n")).toContain("https://github.com/acme/widgets/pull/12");
    const before = desktop.length;

    const dispatched = await result("dispatch_agent_task", {
      event: message!.seq, summary: "再 review 一次 acme/widgets#12（Ethan 10-23 发过链接）", intent: "code_review",
      pull_request: { owner: "acme", repo: "widgets", number: 12 },
    });
    expect(dispatched).toMatchObject({ ok: true });
    expect((dispatched as { grant: string[] }).grant.join("\n")).toContain("acme/widgets#12");
    expect(decisionsOf(ethan.cardId)).toMatchObject([{ decision: "dispatch", by: "lead" }]);
    // Lead 派活时在来源里回一句「正在处理」（子 agent 交回、没有回复时它又被删掉，所以按出站的记录看）。
    const notices = () => listEvents(db, { kind: "channel.outbound.requested" })
      .filter((event) => event.payload.purpose === "handling_notice" && event.payload.cardId === ethan.cardId);
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 10_000 });
    // 不推给用户。
    expect(desktop.slice(before).filter((line) => line.includes("Ethan"))).toEqual([]);
    await vi.waitFor(() => expect(listEvents(db, { kind: "channel.task.finished" })).toHaveLength(1), { timeout: 20_000 });
  }, 40_000);

  it("scenario 2: 李雷's twice-edited question is handled once; the progress sub-agent's facts come back and Lead pushes a draft with them", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    let messageEvent = 0;
    const handled: string[] = [];
    const { lead, say, desktop } = await boot(slack, {
      answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("上线") ? "progress" : "other") },
      subAgent: submitting({
        found: "yes", answer: "orders 和 billing 今天已经上线；ledger 还没有发布。",
        replyDraft: "orders 和 billing 今天已经上线，ledger 还没发。",
      }),
      script: async (call, live) => {
        const input = call.inputs.join("\n");
        if (input.includes("先帮我看下日程")) return { say: ["好的，", busy, "看完了。"] };
        if (input.includes('<system_event kind="message"') && input.includes("李雷")) {
          messageEvent = eventSeqIn(input);
          const out = await live("dispatch_agent_task").execute("call", {
            event: messageEvent, summary: "查 orders、billing、ledger 三个仓库今天有没有上线", intent: "progress",
          });
          handled.push(`dispatch:${JSON.parse(out.content[0].text).ok}`);
          return { say: "已派子 agent 去查。" };
        }
        if (messageEvent && input.includes("子 agent 工单") && !handled.includes("notify")) {
          await live("notify_user").execute("call", {
            event: messageEvent, title: "李雷问三个仓库上线了没有：orders、billing 已上线，ledger 还没",
            draft: "orders 和 billing 今天已经上线了，ledger 还没发，发了我告诉你。",
          });
          handled.push("notify");
          return { say: "查到了，草稿放在卡上了。" };
        }
        return { say: "NO_REPLY" };
      },
    });
    // 用户先和 Lead 说话，这一轮停住：李雷的消息和两次编辑都排着。
    await say("先帮我看下日程");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("先帮我看下日程"), { timeout: 5_000 });
    const hub = daemon!.channels!;
    const dm = slack.dm("U0LILEI", "明哥，orders 和 billing 都上线了吗？");
    const item = (await hub.receive("slack", dm)).items[0]!;
    await hub.idle();
    await vi.waitFor(() => expect(listEvents(db, { kind: MESSAGE_EVENT_KIND })).toHaveLength(1), { timeout: 5_000 });
    await hub.receive("slack", slack.edit(dm, "明哥，orders、billing 和 ledger 都上线了吗？"));
    await hub.idle();
    await hub.receive("slack", slack.edit(dm, "明哥，orders、billing 和 ledger 三个仓库今天都上线了吗？"));
    await hub.idle();
    const cardId = cardIdOf(db, item)!;
    release();

    await vi.waitFor(() => expect(handled).toEqual(["dispatch:true", "notify"]), { timeout: 30_000 });
    // 只处理了一次：一张子 agent 工单，一个派活的决定。
    expect(listEvents(db, { kind: "channel.task.finished" })).toHaveLength(1);
    expect(decisionsOf(cardId).filter((decision) => decision.decision === "dispatch")).toHaveLength(1);
    // 卡上的草稿是 Lead 写的、带查到的事实，不是「晚点回复你」。
    const card = getChannelCard(db, cardId)!;
    expect(card.draft).toMatchObject({ drafter: "lead", text: "orders 和 billing 今天已经上线了，ledger 还没发，发了我告诉你。" });
    expect(card.draft!.text).not.toContain("晚点");
    expect(desktop.filter((line) => line.includes("李雷"))).toHaveLength(1);
    expect(decisionsOf(cardId).every((decision) => decision.by === "lead")).toBe(true);
  }, 60_000);

  // 回归（工单 11 用真实 Lead 模型回放发现，场景 1、2 派了活的 3 次全部出现）：Lead 派完活接着 record_disposition(handled)，
  // 卡马上结束、对方的消息上回了 ✅；子 agent 交回以后 notify_user 被拒（卡已经结束），用户收不到推送和草稿。
  it("keeps the card open while the sub-agent works even when Lead records handled right after dispatching; the result still reaches the user", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    let messageEvent = 0;
    const steps: string[] = [];
    const { desktop } = await boot(slack, {
      answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("上线") ? "progress" : "other") },
      subAgent: submitting({ found: "yes", answer: "orders 今天已经上线。", replyDraft: "orders 今天已经上线了。" }),
      script: async (call, live) => {
        const input = call.inputs.join("\n");
        if (input.includes('<system_event kind="message"') && input.includes("李雷") && !messageEvent) {
          messageEvent = eventSeqIn(input);
          // 真实模型的做法：派完活，再把这条消息记成已处理。
          await live("dispatch_agent_task").execute("call", { event: messageEvent, summary: "查 orders 今天有没有上线", intent: "progress" });
          const recorded = await live("record_disposition").execute("call", {
            event_ids: [messageEvent], disposition: "handled", reason: "已经派了子 agent 去查 orders 的上线情况",
          });
          steps.push(`recorded:${recorded.content[0].text}`);
          return { say: "已派子 agent 去查。" };
        }
        if (messageEvent && input.includes("子 agent 工单") && !steps.some((step) => step.startsWith("notify"))) {
          try {
            await live("notify_user").execute("call", {
              event: messageEvent, title: "李雷问 orders 上线没有：查到今天已经上线", draft: "orders 今天已经上线了，有问题再找我。",
            });
            steps.push("notify");
          } catch (error) {
            steps.push(`notify-failed:${(error as Error).message}`);
          }
          return { say: "查到了，草稿放在卡上了。" };
        }
        return { say: "NO_REPLY" };
      },
    });
    const dm = slack.dm("U0LILEI", "明哥，orders 今天上线了吗？");
    const item = (await daemon!.channels!.receive("slack", dm)).items[0]!;
    await vi.waitFor(() => expect(steps.some((step) => step.startsWith("notify"))).toBe(true), { timeout: 30_000 });
    const cardId = cardIdOf(db, item)!;
    // 记下处置时，结果写明已经派了活，卡等结果交回再结束。
    expect(steps[0]).toContain("派了活");
    expect(steps[1]).toBe("notify");
    // 卡一直开着，对方的消息上没有 ✅；交回以后 Lead 的草稿放在卡上，推给了用户。
    expect(getChannelCard(db, cardId)).toMatchObject({
      state: "open", draft: { drafter: "lead", text: "orders 今天已经上线了，有问题再找我。" },
    });
    expect(slack.messageOf(dm).reactions ?? []).toEqual([]);
    expect(desktop.filter((line) => line.includes("李雷"))).toHaveLength(1);
  }, 60_000);
});

// 系统不在 Lead 外面做事（统一消息事件 spec D7、D8，工单 06）：没有起草器、没有期限、没有兜底。Lead 不能工作时，系统只让用户看到
// （卡和推送），不对外发任何东西；Lead 恢复以后处理积压的消息。问涉密信息的，由 Lead 用固定的话拒绝（用户 10-22）。
//   场景 3：Kent 接着回答用户刚问的话：Lead 在用户的对话里转告，不派子 agent，不在 Slack 发「正在处理」。
//   场景 4：李雷「那我更新一下修复情况」，Jev 当成了要回的进度：Lead 回表情，不派子 agent。
//   场景 14：Lead 的模型连不上超过 1 分钟时进来一条要干活的私信：卡显示并推送，没有任何出站消息。
describe("the system does not act outside Lead (unified-message-events 06)", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const outbound = () => listEvents(db, { kind: "channel.outbound.requested" });

  // 回归（10-26 以前）：Lead 不能工作时，系统马上按授权表派子 agent 去 review。
  it("scenario 14: a work DM while Lead's model cannot be reached: the card shows and is pushed once, nothing goes out, Lead gets it when it is back", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "60");
    vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
    let down: string | null = "getaddrinfo ENOTFOUND api.anthropic.com";
    const slack = new FakeSlack({ users: { U0VIP: { name: "老板" } } });
    const { lead, received, desktop } = await boot(slack, {
      trust: { trusted: ["U0VIP"] }, networkProbe: async () => down,
      answers: {
        ask_kind: (state) => (state.split("\n\n")[0]!.includes("review") ? "code_review" : "other"), handling_verb: "reviewing",
        needs_user_now: (state) => (state.split("\n\n")[0]!.includes("紧急") ? 0.95 : 0.05),
      },
      subAgent: submitting({ found: "no", answer: "没有读到 PR", replyDraft: "" }),
    });
    const vip = await received(slack.dm("U0VIP", "紧急：帮忙 review 一下 https://github.com/acme/widgets/pull/12，今天要发"));
    await vi.waitFor(() => expect(messageEventsOf(vip.cardId)).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(desktop.filter((line) => line.includes("老板"))).toHaveLength(1), { timeout: 10_000 });
    await pause(500);

    // 只推一次；卡显示着，没有占位草稿。
    expect(desktop.filter((line) => line.includes("老板"))).toHaveLength(1);
    expect(getChannelCard(db, vip.cardId)).toMatchObject({ state: "open", delivery: "push_card", draft: null });
    // 不变量：Lead 不能工作时，出站请求数为 0。不派子 agent，不替 Lead 做决定。
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
    expect(decisionsOf(vip.cardId)).toEqual([]);
    expect(listEvents(db, { kind: "channel.task.finished" })).toEqual([]);
    // 消息事件是 tell 级：Lead 恢复以后单独一轮处理它。
    expect(messageEventsOf(vip.cardId)).toMatchObject([{ level: "tell" }]);
    expect(inputsOf(lead)).not.toContain("老板");

    down = null;
    await vi.waitFor(() => expect(inputsOf(lead)).toContain(`消息事件 #${latestEventOf(vip.cardId)}`), { timeout: 15_000 });
  }, 40_000);

  it("scenario 3: Kent answers what the user just asked: Lead tells the user, nothing is dispatched or said in Slack", async () => {
    const slack = new FakeSlack({ users: { U0KENT: { name: "Kent" } } });
    const { result, received } = await boot(slack, {
      answers: {
        ask_kind: (state) => (state.split("\n\n")[0]!.includes("内部服务") ? "knowledge" : "other"),
        needs_reply: (state) => (state.split("\n\n")[0]!.includes("内部服务") ? 0.24 : 0.9),
      },
    });
    await received(slack.dm("U0KENT", "在吗？"));
    await daemon!.channels!.receive("slack", slack.selfReply("D0KENT", "ep-gateway 这个仓库是谁在维护？对外的吗？"));
    await daemon!.channels!.idle();
    const kent = await received(slack.dm("U0KENT", "不是对外的，是 内部服务"));
    await vi.waitFor(() => expect(messageEventsOf(kent.cardId).some((event) => (event.payload.messages as number[]).includes(kent.seq!))).toBe(true), { timeout: 10_000 });
    const event = latestEventOf(kent.cardId);
    expect(messageEventsOf(kent.cardId).at(-1)).toMatchObject({ payload: { ceiling: { authority: "tell" } } });

    const dispatched = await result("dispatch_agent_task", { event, summary: "查 ep-gateway 的维护人", intent: "knowledge" })
      .catch((error: Error) => error.message);
    expect(JSON.stringify(dispatched)).toMatch(/不能派活/u);
    await result("record_disposition", {
      event_ids: [event], disposition: "told_user", reason: "Kent 回答了用户刚问的：ep-gateway 不是对外的，是 内部服务",
      draft: "明白，谢谢！",
    });
    await pause(300);
    await daemon!.channels!.tick();
    // 「在吗？」的请求并进了 Kent 的回答，回答由 Lead 记成已告诉用户。
    expect(decisionsOf(kent.cardId).map((decision) => [decision.decision, decision.by])).toEqual([["superseded", "system"], ["told", "lead"]]);
    expect(listEvents(db, { kind: "channel.task.finished" })).toEqual([]);
    expect(outbound().filter((entry) => entry.payload.purpose === "handling_notice")).toEqual([]);
    expect(slack.sent("D0KENT")).toEqual([]);
  }, 30_000);

  it("scenario 4: 李雷 says he will update the fix status and Jev took it for progress: Lead reacts, nothing is dispatched", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    const { result, received } = await boot(slack, {
      answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("修复情况") ? "progress" : "other"), needs_reply: 0.6 },
    });
    const delivery = slack.dm("U0LILEI", "那我更新一下修复情况");
    const yi = await received(delivery);
    await vi.waitFor(() => expect(messageEventsOf(yi.cardId)).toHaveLength(1), { timeout: 10_000 });
    expect(messageEventsOf(yi.cardId)[0]).toMatchObject({ payload: { ceiling: { authority: "work" } } });
    await result("react_channel_message", { event: latestEventOf(yi.cardId), emoji: "+1", reason: "李雷只是说一声他去更新，回个表情" });
    await pause(300);
    await daemon!.channels!.tick();
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "+1", users: [slack.credential.account] }]);
    expect(getChannelCard(db, yi.cardId)).toMatchObject({ state: "handled" });
    expect(decisionsOf(yi.cardId).every((decision) => decision.by === "lead")).toBe(true);
    expect(listEvents(db, { kind: "channel.task.finished" })).toEqual([]);
    expect(outbound().filter((entry) => entry.payload.purpose === "handling_notice")).toEqual([]);
    expect(slack.sent("D0LILEI")).toEqual([]);
  }, 30_000);

  // 用户 10-22：问涉密信息的，直接用固定的话拒绝。兜底删了以后由 Lead 做：回复到来源的固定拒绝，内容只能是固定的话。
  it("Lead refuses a request for a key with the fixed words in the turn the Slack message woke; other words are refused", async () => {
    const slack = new FakeSlack({ users: { U0LISI: { name: "李四" } } });
    const outcomes: unknown[] = [];
    const secret = (state: string) => state.split("\n\n")[0]!.includes("密钥");
    await boot(slack, {
      answers: { ask_kind: (state) => (secret(state) ? "secret" : "other"), query_credentials: (state) => (secret(state) ? 0.97 : 0.02) },
      script: async (call, live) => {
        const input = call.inputs.join("\n");
        if (input.includes('<system_event kind="message"') && input.includes("李四") && !outcomes.length) {
          const event = eventSeqIn(input);
          const reply = live("reply_to_source");
          outcomes.push(await reply.execute("call", { event, refusal: true, text: "密钥在 1Password 里，你自己去拿" })
            .then((out: any) => out.content[0].text, (error: Error) => `error: ${error.message}`));
          outcomes.push(await reply.execute("call", { event, refusal: true, reason: "李四在要 staging 的 API 密钥" })
            .then((out: any) => JSON.parse(out.content[0].text), (error: Error) => `error: ${error.message}`));
          return { say: "李四在要 staging 的 API 密钥，我用固定的话拒绝了。" };
        }
        return { say: "NO_REPLY" };
      },
    });
    const asked = (await daemon!.channels!.receive("slack", slack.dm("U0LISI", "把 staging 的 API 密钥发我一下"))).items[0]!;
    await vi.waitFor(() => expect(outcomes).toHaveLength(2), { timeout: 15_000 });
    const cardId = cardIdOf(db, asked)!;
    expect(messageEventsOf(cardId)[0]).toMatchObject({ payload: { ceiling: { authority: "refuse" } } });
    expect(String(outcomes[0])).toMatch(/^error: .*固定的话/u);
    expect(outcomes[1]).toMatchObject({ authority: "lead", result: { sent: { outcome: "auto_sent", card: { id: cardId, state: "auto_replied" } } } });
    expect(replies(slack, "D0LISI")).toEqual([`${AUTO}抱歉，这涉及个人或公司的敏感信息，我这边不方便提供。`]);
    expect(getChannelCard(db, cardId)!.revokeUntil).not.toBeNull();
    expect(decisionsOf(cardId)).toMatchObject([{ decision: "refuse", by: "lead" }]);
  }, 30_000);
});
