// 通道 hub 的行为（工单 11，spec D10、D14；落地计划 A5）：投递方式、卡上的动作和处置、授权表的结论（不打扰、回表情、
// 代你拒绝、提醒你）、自动回复和撤回窗口、没发成的回复用同一个幂等键再发、分道的上下文和 Lead 的一行摘要。
// 卡上的草稿只由 Lead 写（统一消息事件工单 06 删了起草器）：没有接 Lead 时卡上没有草稿，收尾的消息回表情。
// 用真的 SQLite、真的 Slack 来源插件和假的 Slack；请求 A 由假的 SmartModel 回答。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_CARD_OPEN_STATES, CHANNEL_EVENT_KINDS, CHANNEL_POLICY_DEFAULTS } from "@pi-lead-child/protocol";
import {
  CHANNEL_LANE_CONTEXT_LIMIT, appendEvent, getChannelCard, getChannelLane, getEvent, listChannelCardsForObject, listEvents, listLeadActivityEvents, openDb,
  getStandingOrder, proposeStandingOrderChange, updateChannelCard, type Db,
} from "@pi-lead-child/store";
import {
  CHANNEL_INTAKE_QUESTION_VERSION, ChannelActionError, ChannelHub, ChannelRegistry, createSlackChannelAdapter,
  type ChannelHubOptions, type SmartModel,
} from "../src/index.js";
import {
  agentTaskResult, cardIdOf, createFakeHookAdapter, FakeAgentTaskDispatcher, FakeHookService, FakeSlack, scriptedSmartModel,
} from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let pushes: Array<{ cardId: number; title: string; body: string }>;
let changed: number[][];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-hub-"), "plc.db"));
  clock = new Date("2026-10-17T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0VIP: { name: "老板" }, U0EXT: { name: "外部的人", team: "T0OTHER" } } });
  pushes = [];
  changed = [];
});

let hubs: ChannelHub[] = [];

afterEach(async () => {
  for (const instance of hubs.splice(0)) await instance.idle();
  db.close();
});

function hub(options: Partial<ChannelHubOptions> & { trusted?: string[] } = {}): ChannelHub {
  const { trusted, ...rest } = options;
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock, trust: { trusted: trusted ?? [] } })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: (notice) => pushes.push(notice), onCardsChanged: (ids) => changed.push(ids),
    // 抽查（落地计划 D2）是随机的：这里关掉，要测它的用例自己给。
    classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000, audit: { rate: 0 }, ...rest,
  });
  hubs.push(instance);
  return instance;
}

// 状态文本的第一段是对方的原话（intake.ts 的 channelIntakeState）。
const latest = (state: string) => state.split("\n\n")[0] ?? "";

const dispositionOf = (seq: number) => getEvent(db, seq)!.disposition;

// 紧急程度由内核问 SmartModel 定（channel-urgency.test.ts 测判断本身）。这个替身认为 urgentTexts 里的消息需要用户马上看到。
function modelSaying(urgentTexts: string[]): () => SmartModel {
  const model: SmartModel = {
    backend: "fake-jev",
    async decide(state, questions) {
      const probability = urgentTexts.some((text) => state.includes(text)) ? 0.95 : 0.05;
      const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability }]));
      return { answers: answers as never, backend: "fake-jev", model: null, latencyMs: 1, fallbackFrom: null };
    },
  };
  return () => model;
}

describe("delivery", () => {
  it("pushes only past the source's interrupt threshold, and keeps one card per conversation", async () => {
    const channels = hub({ trusted: ["U0VIP"], smartModel: modelSaying(["今晚的发布先停一下"]) });
    const urgent = await channels.receive("slack", slack.dm("U0VIP", "今晚的发布先停一下"));
    expect(urgent.items[0]).toMatchObject({ delivery: "push_card" });
    // 有快模型时先判断要不要用户回，再开卡、推送。
    await channels.idle();
    const urgentCard = cardIdOf(db, urgent.items[0]!);
    expect(pushes).toEqual([{ cardId: urgentCard, title: "Slack · 老板", body: "今晚的发布先停一下" }]);
    // 同一个对话又来一条普通的：同一张卡，投递方式只升不降，不再推送。
    const again = await channels.receive("slack", slack.dm("U0VIP", "好了，可以继续"));
    expect(again.items[0]).toMatchObject({ cardId: urgentCard, delivery: "card" });
    expect(getChannelCard(db, urgentCard!)).toMatchObject({ delivery: "push_card", messageCount: 2, excerpt: "好了，可以继续" });
    expect(pushes).toHaveLength(1);
    // 同事在频道里提到你：会话卡；外部的人提到你：摘要；和你无关的频道消息不记。
    const mention = await channels.receive("slack", slack.mention("U0ZHANG", "帮忙看下这个 PR"));
    expect(mention.items[0]).toMatchObject({ kind: "slack.mention.received", delivery: "card", objectKey: expect.stringMatching(/^slack:C0PROJ:/) });
    expect((await channels.receive("slack", slack.mention("U0EXT", "能给个报价吗"))).items[0]).toMatchObject({ delivery: "digest" });
    // 和你无关的频道（没有你的对话）里的消息不记。有你的对话的频道（订阅了，slack-takeover 工单 02）里的普通消息只记录：不开卡、不开道。
    expect(await channels.receive("slack", slack.chatter("U0LI", "午饭吃什么", "C0LUNCH"))).toEqual({ accepted: true, items: [] });
    const chatter = await channels.receive("slack", slack.chatter("U0LI", "午饭吃什么"));
    expect(chatter.items[0]).toMatchObject({ kind: "slack.channel.message", inserted: true, delivery: "record", cardId: null });
    expect(getChannelLane(db, chatter.items[0]!.objectKey)).toBeUndefined();
    // 推回来的回复、别的对话里用户自己说的话，没有道时不记。
    expect((await channels.receive("slack", slack.selfReply("D0NOBODY", "随便说说"))).items[0]).toMatchObject({ ignored: "no_lane" });
  });

  it("rejects replayed deliveries whose signature timestamp is too old", async () => {
    const channels = hub();
    const replay = await channels.receive("slack", slack.replayed(slack.dm("U0ZHANG", "旧的请求"), 10 * 60_000));
    expect(replay).toEqual({ accepted: false, rejection: "unauthenticated", items: [] });
    expect(listEvents(db, { kind: "slack.dm.received" })).toEqual([]);
  });
});

describe("identity without a delivery id (spec D2)", () => {
  it("keeps both events and marks the second as a possible duplicate by its structured fields", async () => {
    const service = new FakeHookService();
    const adapter = createFakeHookAdapter(service);
    const anonymous = { ...adapter, parse: async (delivery: Parameters<typeof adapter.parse>[0], context: Parameters<typeof adapter.parse>[1]) =>
      (await adapter.parse(delivery, context)).map((item) => ({ ...item, deliveryId: null, occurredAt: "2026-10-17T09:59:00.000Z" })) };
    const channels = new ChannelHub({
      db, registry: new ChannelRegistry([anonymous]), credentials: { credential: async () => service.credential }, now: () => clock,
    });
    const first = (await channels.receive("hook", service.message("t1", "同一时刻"))).items[0]!;
    const second = (await channels.receive("hook", service.message("t1", "同一时刻"))).items[0]!;
    expect([first.inserted, second.inserted]).toEqual([true, true]);
    expect(getEvent(db, first.seq!)!.payload.maybeDuplicateOf).toBeUndefined();
    expect(getEvent(db, second.seq!)!.payload.maybeDuplicateOf).toBe(first.seq);
  });
});

describe("actions on a card", () => {
  it("snooze reminds again later; dismiss ends the card with no_action", async () => {
    const channels = hub();
    const { cardId, seq } = (await channels.receive("slack", slack.dm("U0ZHANG", "明天的会议改到几点？"))).items[0]!;
    const snoozed = await channels.act(cardId!, "snooze", { by: "user via test" });
    expect(snoozed).toMatchObject({ state: "snoozed", snoozedUntil: "2026-10-17T11:00:00.000Z" });
    expect(dispositionOf(seq!)).toBe("deferred");
    await channels.tick();
    expect(getChannelCard(db, cardId!)!.state).toBe("snoozed");
    clock = new Date("2026-10-17T11:00:01.000Z");
    await channels.tick();
    expect(getChannelCard(db, cardId!)!.state).toBe("open");
    expect(pushes.map((push) => push.title)).toEqual(["Slack · 张三（稍后提醒）"]);
    await channels.act(cardId!, "dismiss", { by: "user via test" });
    expect(getChannelCard(db, cardId!)).toMatchObject({ state: "dismissed" });
    expect(dispositionOf(seq!)).toBe("no_action");
    expect(listEvents(db, { kind: "channel.card.action" }).map((event) => event.payload.action)).toEqual(["snooze", "dismiss"]);
    // 结束了的卡不能再操作。
    await expect(channels.act(cardId!, "snooze", { by: "user via test" })).rejects.toMatchObject({ code: "invalid_action" });
  });

  // 统一消息事件 spec D11：点了「我自己回」，卡马上结束，不再推送，也不等你在来源里回复。
  it("'I will reply myself' ends the card at once: it is not open, and not in Lead's open cards", async () => {
    const model = scriptedSmartModel({ answers: { answers_request: 0.9 } });
    const channels = hub({ smartModel: () => model });
    const asked = (await channels.receive("slack", slack.dm("U0ZHANG", "预算表你看了吗"))).items[0]!;
    await channels.idle();
    const { seq } = asked;
    const cardId = cardIdOf(db, asked)!;
    expect(channels.openCards().map((card) => card.id)).toEqual([cardId]);
    const ended = await channels.act(cardId, "reply_myself", { by: "user via test" });
    expect(CHANNEL_CARD_OPEN_STATES).not.toContain(ended.state);
    expect(channels.openCards()).toEqual([]);
    expect(ended).toMatchObject({ state: "left_to_user", resolvedAt: clock.toISOString(), resolution: { by: "user via test", action: "reply_myself" } });
    expect(channels.cardDto(ended).actions).toEqual([]);
    expect(dispositionOf(seq!)).toBe("handled");
    expect(listEvents(db, { kind: "channel.card.action" }).map((event) => event.payload.summary)).toEqual(["你说会自己回复张三"]);
    expect(getChannelLane(db, "slack:D0ZHANG:main")!.summary).toContain("用户说会自己回复，卡已结束");
    // 以后不再推送：过了很久，一拍也不提醒。
    const pushed = pushes.length;
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    await channels.tick();
    expect(pushes).toHaveLength(pushed);
  });

  // 没点按钮、直接在来源里回复：照旧由 SmartModel 判断回答了没有（工单 04），回答了卡自动结束。
  it("the user's own reply in the source still ends an open card when it answers", async () => {
    const model = scriptedSmartModel({ answers: { answers_request: (state) => (state.includes("看了") ? 0.9 : 0.1) } });
    const channels = hub({ smartModel: () => model });
    const asked = (await channels.receive("slack", slack.dm("U0ZHANG", "预算表你看了吗"))).items[0]!;
    await channels.idle();
    const cardId = cardIdOf(db, asked);
    await channels.receive("slack", slack.selfReply("D0ZHANG", "看了，下午聊"));
    await channels.idle();
    expect(getChannelCard(db, cardId!)!.state).toBe("resolved_elsewhere");
    expect(dispositionOf(asked.seq!)).toBe("resolved_elsewhere");
    expect(model.count("channel_self_reply")).toBe(1);
  });

  it("ends the old cards left in replying_self after 'I will reply myself' once at start-up, and leaves the source-reply ones open", async () => {
    const channels = hub();
    const card = async (user: string, text: string) => (await channels.receive("slack", slack.dm(user, text))).items[0]!;
    const legacy = await card("U0ZHANG", "预算表你看了吗");
    const clicked = await card("U0LI", "周报写了吗？");
    const sourceOnly = await card("U0WANG", "接口文档在哪？");
    // 旧代码：「我自己回」只改状态；你在来源里回过一句、没回答对方时，也停在 replying_self，带 replied_in_source。
    const repliedInSource = { by: "user", action: "replied_in_source", at: clock.toISOString(), detail: { answered: false } };
    db.transaction(() => {
      updateChannelCard(db, legacy.cardId!, { state: "replying_self" });
      updateChannelCard(db, clicked.cardId!, { state: "replying_self", resolution: repliedInSource });
      updateChannelCard(db, sourceOnly.cardId!, { state: "replying_self", resolution: repliedInSource });
      appendEvent(db, {
        source: "system", kind: CHANNEL_EVENT_KINDS.cardAction, entityKey: clicked.objectKey, correlationId: `channel:${clicked.objectKey}`,
        level: "record", payload: { channel: "slack", cardId: clicked.cardId, action: "reply_myself", by: "user via test", summary: "你说会自己回复李四" },
      });
    })();
    await channels.idle();
    clock = new Date(clock.getTime() + 60_000);
    hub();
    for (const item of [legacy, clicked]) {
      expect(getChannelCard(db, item.cardId!)).toMatchObject({
        state: "left_to_user", resolvedAt: clock.toISOString(), resolution: { by: "system", action: "reply_myself" },
      });
      expect(dispositionOf(item.seq!)).toBe("handled");
    }
    expect(getChannelCard(db, sourceOnly.cardId!)).toMatchObject({ state: "replying_self", resolvedAt: null });
    // 幂等：再启动一次什么也不改。
    const versions = [legacy, clicked, sourceOnly].map((item) => getChannelCard(db, item.cardId!)!.version);
    hub();
    expect([legacy, clicked, sourceOnly].map((item) => getChannelCard(db, item.cardId!)!.version)).toEqual(versions);
  });

  it("keeps the card when the user's own reply only acknowledges, or when the model cannot judge it", async () => {
    const model = scriptedSmartModel({ answers: { answers_request: 0.1 } });
    const channels = hub({ smartModel: () => model });
    const asked = (await channels.receive("slack", slack.dm("U0ZHANG", "接口文档在哪？"))).items[0]!;
    await channels.idle();
    const cardId = cardIdOf(db, asked);
    await channels.act(cardId!, "snooze", { by: "user via test" });
    await channels.receive("slack", slack.selfReply("D0ZHANG", "我看一下"));
    await channels.idle();
    // 卡留着，标成「你在来源里回复过」：不再提醒（稍后到点也不推送）。
    expect(getChannelCard(db, cardId!)).toMatchObject({ state: "replying_self", resolution: { action: "replied_in_source", detail: { answered: false } } });
    expect(getChannelLane(db, "slack:D0ZHANG:main")!.summary).toContain("用户在来源里回复过");
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    await channels.tick();
    expect(pushes).toEqual([]);
    // 没有 SmartModel：同样留着卡。
    const blind = hub();
    const other = (await blind.receive("slack", slack.dm("U0LI", "周报写了吗？"))).items[0]!;
    await blind.receive("slack", slack.selfReply("D0LI", "写完了，发你了"));
    await blind.idle();
    expect(getChannelCard(db, other.cardId!)).toMatchObject({ state: "replying_self", resolution: { detail: { answered: null } } });
  });

  // 「改一下再发」发用户自己的文字，不加披露前缀（spec D8）；没有代查的卡没有「重新查」「停止代查」「发到 PR 并回复」
  // （review 剧本在 channel-lookup-hub.test.ts）。没有人写草稿的卡没有「用草稿回复」（工单 06：不放占位草稿）。
  it("sends the user's edited text without a prefix, and refuses the lookup actions a card does not offer", async () => {
    const channels = hub();
    const { cardId } = (await channels.receive("slack", slack.dm("U0ZHANG", "订单的 webhook 为什么没触发？"))).items[0]!;
    const before = getChannelCard(db, cardId!)!;
    expect(channels.cardDto(before)).toMatchObject({
      lookup: null, draft: null, actions: ["send_edited", "reply_myself", "snooze", "dismiss", "handled"],
    });
    for (const action of ["cancel_lookup", "send_draft"] as const) {
      await expect(channels.act(cardId!, action, { by: "user via test" })).rejects.toMatchObject({ code: "invalid_action" });
    }
    expect(slack.sent()).toEqual([]);
    const sent = await channels.act(cardId!, "send_edited", { by: "user via test", text: "  还在查，下午告诉你  " });
    expect(sent).toMatchObject({ state: "replied", sent: { status: "sent", fromDraft: false, text: "还在查，下午告诉你" } });
    expect(slack.sent().map((message) => message.text)).toEqual(["还在查，下午告诉你"]);
    expect(listEvents(db, { kind: "channel.card.action" }).map((event) => event.payload.action)).toEqual(["send_edited"]);
  });

  it("refuses an action on a card that changed since the user saw it", async () => {
    const channels = hub();
    const { cardId } = (await channels.receive("slack", slack.dm("U0ZHANG", "第一条"))).items[0]!;
    const seen = getChannelCard(db, cardId!)!.version;
    await channels.receive("slack", slack.dm("U0ZHANG", "第二条"));
    await expect(channels.act(cardId!, "dismiss", { by: "user via test", expectedVersion: seen })).rejects.toBeInstanceOf(ChannelActionError);
    expect(getChannelCard(db, cardId!)!.state).toBe("open");
  });

  it("retries a reply that did not go out with the same idempotency key, and sends it once", async () => {
    const channels = hub();
    const { cardId, seq } = (await channels.receive("slack", slack.dm("U0ZHANG", "收到请回"))).items[0]!;
    slack.failNext("chat.postMessage", "ECONNRESET");
    await expect(channels.act(cardId!, "send_edited", { by: "user via test", text: "收到，马上看" })).rejects.toMatchObject({ code: "outbound_failed" });
    expect(getChannelCard(db, cardId!)).toMatchObject({ state: "open", sent: { status: "pending", failures: 1 } });
    await channels.tick();
    expect(slack.sent()).toEqual([]);
    clock = new Date(clock.getTime() + 1_500);
    await channels.tick();
    expect(getChannelCard(db, cardId!)).toMatchObject({ state: "replied", sent: { status: "sent", by: "user", fromDraft: false } });
    expect(slack.sent().map((message) => message.text)).toEqual(["收到，马上看"]);
    expect(dispositionOf(seq!)).toBe("handled");
    expect(listEvents(db, { kind: "channel.outbound.failed" })).toHaveLength(1);
    expect(listEvents(db, { kind: "channel.outbound.completed" })).toHaveLength(1);
  });
});

// 授权表（落地计划 A5）：请求 A 认出意图以后，通道直接做三种事：不打扰、回表情、代你拒绝。会议提醒推送给你；
// 要干活、问你、代你说一句的开卡。模板代回闸门和影子模式退役了：新卡上没有闸门的结论。
describe("the authority table decides what the channel does", () => {
  // 有快模型时，要开新卡的消息先等请求 A：判断出来以前没有卡；判断丢了（例如 daemon 重启）时，过了 pendingCardGraceMs
  // 由每一拍开卡（宁可多问用户）。
  it("waits for request A before it opens the card, and opens it anyway when the answer is lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = scriptedSmartModel();
    const slow: SmartModel = {
      backend: "slow-jev",
      async decide(state, questions, opts) {
        if (opts?.purpose === "channel_intake") await gate;
        return inner.decide(state, questions, opts);
      },
    };
    const channels = hub({ smartModel: () => slow, intakeTimeoutMs: 60_000, pendingCardGraceMs: 30_000 });
    const item = (await channels.receive("slack", slack.dm("U0ZHANG", "资料我看了，有个地方要你确认一下"))).items[0]!;
    expect(item).toMatchObject({ cardId: null, delivery: "card" });
    await channels.tick();
    expect(cardIdOf(db, item)).toBeNull();
    release();
    await channels.idle();
    await channels.tick();
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ state: "open", gate: null });
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{
      level: "record", payload: { forSeq: item.seq, cardId: cardIdOf(db, item), intent: "other", action: "ask" },
    }]);

    // 判断丢了：这一次请求 A 一直不回答。过了宽限期，每一拍照样开卡；请求 A 后来回答了，并进这张卡，不再开第二张。
    let releaseLost!: () => void;
    const lost = new Promise<void>((resolve) => { releaseLost = resolve; });
    const stuck: SmartModel = {
      backend: "stuck-jev",
      async decide(state, questions, opts) {
        if (opts?.purpose === "channel_intake") await lost;
        return inner.decide(state, questions, opts);
      },
    };
    const later = hub({ smartModel: () => stuck, intakeTimeoutMs: 60_000, pendingCardGraceMs: 30_000 });
    const waiting = (await later.receive("slack", slack.dm("U0LI", "周报写好了吗？"))).items[0]!;
    await later.tick();
    expect(cardIdOf(db, waiting)).toBeNull();
    clock = new Date(clock.getTime() + 31_000);
    await later.tick();
    const opened = cardIdOf(db, waiting)!;
    expect(getChannelCard(db, opened)).toMatchObject({ state: "open", firstSeq: waiting.seq, delivery: "card" });
    releaseLost();
    await later.idle();
    expect(listEvents(db, { kind: "channel.intake.decided" }).at(-1)).toMatchObject({ payload: { forSeq: waiting.seq, cardId: null, questionVersion: CHANNEL_INTAKE_QUESTION_VERSION } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_cards WHERE object_key = 'slack:D0LI:main'").get()).toEqual({ n: 1 });
  });

  // 用户 2026-10-22：对方表达了感谢的，直接 emoji 回在他的会话上即可。
  it("reacts on their message when they thank you, opens no card, and notes it in Lead's activity", async () => {
    const model = scriptedSmartModel({
      answers: {
        ask_kind: (state) => (latest(state).includes("谢谢") ? "closing" : "other"),
        closing_kind: "they_thank_you", reaction_emoji: "pray", needs_reply: 0.1,
      },
    });
    const channels = hub({ smartModel: () => model });
    const delivery = slack.dm("U0ZHANG", "诶 我看到验收反馈已经有结论啦～ 谢谢明哥！");
    const thanks = (await channels.receive("slack", delivery)).items[0]!;
    await channels.idle();
    await channels.tick();
    expect(listChannelCardsForObject(db, thanks.objectKey)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "pray", users: [slack.credential.account] }]);
    expect(dispositionOf(thanks.seq!)).toBe("auto_handled");
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{
      level: "digest",
      payload: {
        forSeq: thanks.seq, cardId: null, intent: "closing", action: "react", emoji: "pray", order: { id: "channel.handbook", version: 1 },
        situation: "closing", final: "auto",
        summary: expect.stringContaining(":pray:"),
      },
    }]);
    expect(listLeadActivityEvents(db, { afterSeq: 0, limit: 20 }).map((event) => event.kind)).toContain("channel.authority.decided");
    // Lead 的一行摘要说明最新一条回了表情，不带原文。
    const line = channels.laneLines([thanks.objectKey]).get(thanks.objectKey)!;
    // 回的是哪个表情也写上（2026-10-26：Lead 说不出回了哪个表情）。
    expect(line).toContain("最新一条系统回了表情 :pray:");
    expect(line).not.toContain("验收反馈");
    // 回表情记进出站的账：再走一拍也不会回第二次。
    await channels.tick();
    await channels.idle();
    expect(slack.calls.filter((call) => call.method === "reactions.add")).toHaveLength(1);
  });

  // 用户 2026-10-22：查我权限范围内的公司涉密信息，例如薪资、职级，直接拒绝。
  it("refuses a question about secrets with the fixed words, as an auto-reply you can undo", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "knowledge", query_hr_compensation: 0.92 } });
    const channels = hub({ smartModel: () => model });
    const asked = (await channels.receive("slack", slack.dm("U0ZHANG", "明哥，你们组小王现在什么职级？薪资大概多少？"))).items[0]!;
    await channels.idle();
    const card = getChannelCard(db, cardIdOf(db, asked)!)!;
    expect(card).toMatchObject({
      state: "auto_replied", delivery: "card", gate: null, revokeUntil: "2026-10-17T10:10:00.000Z", sent: { by: "auto", status: "sent" },
    });
    expect(slack.sent("D0ZHANG").map((message) => message.text))
      .toEqual([":robot_face: Paimon (Assistant) · auto-reply for 我\n抱歉，这涉及个人或公司的敏感信息，我这边不方便提供。"]);
    expect(pushes).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{ level: "record", payload: { action: "refuse", intent: "knowledge" } }]);
    expect(listEvents(db, { kind: "channel.reply.auto_sent" })).toMatchObject([{
      payload: { category: "refusal", order: { id: "channel.authority", version: 1 }, summary: expect.stringContaining("按授权表代你拒绝了张三") },
    }]);
    // 没有起草：拒绝的话是固定的。
    expect(card.draft).toBeNull();
    expect(channels.cardDto(card).actions).toEqual(["undo_auto_reply"]);
    await channels.act(card.id, "undo_auto_reply", { by: "user via test" });
    expect(slack.sent("D0ZHANG")).toEqual([]);
  });

  // 交接说明是常设指令（issue 03）：Lead 收紧了（「只是通知我一声的」改成交给你），hub 照新的一版做。
  it("follows the handbook in the standing order", async () => {
    const handbook = getStandingOrder(db, "channel.handbook")!;
    const params = (handbook.action as any).params;
    const narrowed = proposeStandingOrderChange(db, {
      op: "update", id: "channel.handbook", reason: "测试：通知也交给我",
      patch: { action: { ...handbook.action, params: {
        ...params, situations: params.situations.map((item: any) => (item.id === "notice" ? { ...item, mode: "hand" } : item)),
      } } as never },
    });
    expect(narrowed.outcome).toBe("applied");
    const model = scriptedSmartModel({ answers: { ask_kind: "meeting", needs_reply: 0.9 } });
    const channels = hub({ smartModel: () => model });
    const invite = (await channels.receive("slack", slack.dm("U0ZHANG", "明哥，三点的评审会开始了"))).items[0]!;
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, invite)!)).toMatchObject({ state: "open", delivery: "card" });
    expect(pushes).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{
      payload: { action: "ask", situation: "notice", final: "hand", order: { id: "channel.handbook", version: 2 } },
    }]);
  });

  // 设置 → 消息通道 → 自动代你处理：关着时通道不代你做任何对外的事，一律问你；只记录的照旧只记录。
  // 2026-10-30 起开关在交接说明里（channel.handbook 的 autoReply），关掉是收紧，Lead 能直接改。
  it("does nothing outward for you when auto-handling is off: no reaction, no refusal, a card instead", async () => {
    const handbook = getStandingOrder(db, "channel.handbook")!;
    const off = proposeStandingOrderChange(db, {
      op: "update", id: "channel.handbook", reason: "测试：先别自动回了",
      patch: { action: { ...handbook.action, params: { ...(handbook.action as any).params, autoReply: false } } as never },
    });
    expect(off.outcome).toBe("applied");
    const model = scriptedSmartModel({
      answers: {
        ask_kind: (state) => (latest(state).includes("谢谢") ? "closing" : "knowledge"),
        closing_kind: "they_thank_you", reaction_emoji: "pray",
        needs_reply: (state) => (latest(state).includes("谢谢") ? 0.1 : 0.9),
        query_hr_compensation: (state) => (latest(state).includes("薪资") ? 0.92 : 0.02),
      },
    });
    const channels = hub({ smartModel: () => model });
    const thanksDelivery = slack.dm("U0ZHANG", "诶 我看到验收反馈已经有结论啦～ 谢谢明哥！");
    const thanks = (await channels.receive("slack", thanksDelivery)).items[0]!;
    await channels.idle();
    expect(slack.messageOf(thanksDelivery).reactions ?? []).toEqual([]);
    expect(listChannelCardsForObject(db, thanks.objectKey)).toEqual([]);

    const asked = (await channels.receive("slack", slack.dm("U0LI", "你们组小王现在薪资大概多少？"))).items[0]!;
    await channels.idle();
    expect(slack.sent("D0LI")).toEqual([]);
    expect(getChannelCard(db, cardIdOf(db, asked)!)).toMatchObject({ state: "open" });
    expect(listEvents(db, { kind: "channel.authority.decided" }).map((event) => event.payload)).toMatchObject([
      // 开关还在设置页的 channel.authority 里；依据记交接说明（issue 03）。
      { action: "skip", reason: expect.stringContaining("自动代你处理关着"), order: { id: "channel.handbook", version: 2 }, by: "switch" },
      { action: "ask", reason: expect.stringContaining("自动代你处理关着") },
    ]);
  });

  it("pushes a meeting reminder to you and does not reply to it", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "meeting", needs_reply: 0.2 } });
    const channels = hub({ smartModel: () => model });
    const invite = (await channels.receive("slack", slack.dm("U0ZHANG", "明哥，三点的评审会开始了，在 3 楼会议室"))).items[0]!;
    await channels.idle();
    const id = cardIdOf(db, invite)!;
    expect(getChannelCard(db, id)).toMatchObject({ state: "open", delivery: "push_card" });
    expect(pushes.map((notice) => notice.cardId)).toEqual([id]);
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{ payload: { action: "remind", cardId: id } }]);
  });

  // 收尾时代你说一句（落地计划 A6）：没有接 Lead 时没有人写这句话（统一消息事件工单 06 删了起草器），回个表情，不开卡。
  it("reacts to a goodbye without Lead instead of drafting a line, and opens no card", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "closing", closing_kind: "farewell", needs_reply: 0.3 } });
    const channels = hub({ smartModel: () => model });
    const delivery = slack.dm("U0ZHANG", "好的，那我先下了，明天见");
    const bye = (await channels.receive("slack", delivery)).items[0]!;
    await channels.idle();
    expect(listChannelCardsForObject(db, bye.objectKey)).toEqual([]);
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "smile", users: [slack.credential.account] }]);
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(model.count("channel_reply_check")).toBe(0);
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{
      level: "digest", payload: { action: "react", emoji: "smile", reason: expect.stringContaining("回个表情") },
    }]);
  });

  // 设置 → 消息通道 → 过去 24 小时的消息（2026-10-24 用户）：请求 A 用当时的结果；草稿记下了分数的直接用，没记下的现在调
  // 请求 B，调过的不再调。只读。打过分的草稿是子 agent 交回的（Lead 自己的回复 2026-10-29 起不打分，由 Lead 判断）。
  it("evaluates the past 24 hours: request A from the record, request B only for a draft without recorded scores", async () => {
    const model = scriptedSmartModel({
      answers: {
        ask_kind: (state) => (latest(state).includes("明天见") ? "closing" : "code_review"), handling_verb: "reviewing", target_repo: "acme/orders",
        closing_kind: "farewell", needs_reply: (state) => (latest(state).includes("明天见") ? 0.3 : 0.9),
      },
    });
    const dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
    const channels = hub({
      smartModel: () => model, lead: { dispatcher, available: () => true },
      lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    });
    dispatcher.hub = channels;
    await channels.receive("slack", slack.dm("U0ZHANG", "好的，那我先下了，明天见"));
    await channels.idle();
    // 只给 review 请求派了子 agent，它在 PR 上留了评论（核实过的动作），交回草稿：告别那张卡没有草稿。
    const ask = (await channels.receive("slack", slack.dm("U0LI", "帮忙 review 一下 acme/orders#12"))).items[0]!;
    await channels.idle();
    const event = listEvents(db, { kind: "message.received" }).find((entry) => entry.payload.cardId === cardIdOf(db, ask))!.seq;
    const task = await channels.leadDispatch(event, { summary: "review 这个 PR", pullRequest: { owner: "acme", repo: "orders", number: 12 } });
    await dispatcher.finish(task.runId, {
      result: agentTaskResult({ answer: "看过了，留了 1 条评论。", sources: [], replyDraft: "看过了，没问题。" }),
      actions: [{
        connection: "github", tool: "pull_request_review_write", summary: "在 acme/orders#12 提交了 COMMENT review（1 条评论）",
        target: "acme/orders#12", url: "https://github.com/acme/orders/pull/12#pullrequestreview-1", visible: true, at: clock.toISOString(),
      }],
    });
    await channels.idle();
    const intakes = model.count("channel_intake");
    const checks = model.count("channel_reply_check");

    const off = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false };
    const first = await channels.replayPolicy("slack", CHANNEL_POLICY_DEFAULTS, off);
    expect(first).toMatchObject({ total: 2, calls: 0, failed: 0, after: { handle: 0, reply: 0 } });
    expect(first.items.map((item) => [item.text, item.scoring])).toEqual([
      ["帮忙 review 一下 acme/orders#12", "recorded"],
      ["好的，那我先下了，明天见", "no_draft"],
    ]);
    expect(first.items[0]).toMatchObject({ draft: "看过了，没问题。", before: { reply: true }, after: { reply: false } });
    expect([model.count("channel_intake"), model.count("channel_reply_check")]).toEqual([intakes, checks]);

    // 2026-10-23 以前的打分没记下模型的输入：现在调一次请求 B，第二次用调过的。
    db.prepare("UPDATE events SET payload = json_remove(payload, '$.input') WHERE kind = ?").run(CHANNEL_EVENT_KINDS.replyScored);
    const second = await channels.replayPolicy("slack", CHANNEL_POLICY_DEFAULTS, CHANNEL_POLICY_DEFAULTS);
    expect(second).toMatchObject({ calls: 1, failed: 0 });
    expect(second.items[0]).toMatchObject({ scoring: "called" });
    const third = await channels.replayPolicy("slack", CHANNEL_POLICY_DEFAULTS, CHANNEL_POLICY_DEFAULTS);
    expect(third).toMatchObject({ calls: 0 });
    expect(third.items[0]).toMatchObject({ scoring: "cached" });
    expect([model.count("channel_intake"), model.count("channel_reply_check")]).toEqual([intakes, checks + 1]);
    // 24 小时以前的不算。
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    expect((await channels.replayPolicy("slack", CHANNEL_POLICY_DEFAULTS, CHANNEL_POLICY_DEFAULTS)).total).toBe(0);
  });

  // 落地计划 A7：回到原来的 thread 里。私信里 thread 的回复回在那个 thread，不发到私信的主对话。
  it("replies in the thread the message came from", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "closing", closing_kind: "farewell" } });
    const channels = hub({ smartModel: () => model, lead: { dispatcher: new FakeAgentTaskDispatcher(db, {}), available: () => true } });
    const root = slack.dm("U0ZHANG", "周会的结论我发你了");
    const thread = (JSON.parse(root.body) as { event: { ts: string } }).event.ts;
    const bye = (await channels.receive("slack", slack.dm("U0ZHANG", "好的，那我先下了", { thread }))).items[0]!;
    await channels.idle();
    const event = listEvents(db, { kind: "message.received" }).find((entry) => entry.payload.cardId === cardIdOf(db, bye))!.seq;
    await channels.sendMessage(bye.objectKey, { text: "好的，回头见", words: "assistant", by: "lead", forUser: false, event });
    await channels.idle();
    expect(slack.sent("D0ZHANG").map((message) => [message.text, message.thread_ts])).toEqual([
      [":robot_face: Paimon (Assistant) · auto-reply for 我\n好的，回头见", thread],
    ]);
  });

  // 用户 2026-10-21：千篇一律的「收到，谢谢」不要。没有接 Lead 时你该道谢的收尾也只回个表情，不开卡。
  it("reacts to a thanks you owe without Lead, and opens no card", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "closing", closing_kind: "you_thank_them", reaction_emoji: "pray" } });
    const channels = hub({ smartModel: () => model });
    const delivery = slack.dm("U0ZHANG", "那个问题我帮你修好了，你再试试");
    const fixed = (await channels.receive("slack", delivery)).items[0]!;
    await channels.idle();
    expect(listChannelCardsForObject(db, fixed.objectKey)).toEqual([]);
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "pray", users: [slack.credential.account] }]);
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(model.count("channel_reply_check")).toBe(0);
    expect(listEvents(db, { kind: "channel.authority.decided" })).toMatchObject([{
      level: "digest", payload: { action: "react", reason: expect.stringContaining("回个表情") },
    }]);
  });

  it("leaves a message that joins an open card to that card: no reaction, no refusal", async () => {
    const model = scriptedSmartModel({
      answers: {
        ask_kind: (state) => (latest(state).includes("谢谢") ? "closing" : "other"),
        closing_kind: "they_thank_you", reaction_emoji: "pray",
      },
    });
    const channels = hub({ smartModel: () => model });
    const question = (await channels.receive("slack", slack.dm("U0ZHANG", "这个接口的超时是多少？"))).items[0]!;
    await channels.idle();
    const id = cardIdOf(db, question)!;
    const thanks = (await channels.receive("slack", slack.dm("U0ZHANG", "先谢谢啦"))).items[0]!;
    await channels.idle();
    expect(thanks.cardId).toBe(id);
    expect(getChannelCard(db, id)).toMatchObject({ state: "open", messageCount: 2 });
    expect(slack.calls.filter((call) => call.method === "reactions.add")).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)).toMatchObject({
      payload: { forSeq: thanks.seq, cardId: id, intent: "closing", action: "ask", reason: expect.stringContaining("已经有一张卡在等你") },
    });
  });
});

// 用户 2026-10-21：「各种连招好多…弄不动了」这种收尾的话也开了卡，草稿是「收到，谢谢！」；Google Calendar 的提醒也开了卡。
// 现在先判断要不要用户回（请求 A 的 needs_reply），再开卡；机器人发的只记录。
describe("deciding whether you need to reply before a card opens", () => {
  it("opens no card for a message that needs no reply, and notes it in Lead's activity", async () => {
    const model = scriptedSmartModel({
      answers: {
        needs_reply: (state) => (latest(state).includes("弄不动了") ? 0.05 : 0.9),
      },
    });
    const channels = hub({ smartModel: () => model });
    const sigh = (await channels.receive("slack", slack.dm("U0FOAM", "各种连招好多。我等客户端它们优化好了。弄不动了 :facepalm:"))).items[0]!;
    expect(sigh).toMatchObject({ inserted: true, delivery: "card", cardId: null });
    await channels.idle();
    await channels.tick();
    // 没有卡，没有草稿，没有推送；消息在道里（Lead 的一行摘要和对话的上下文都在），处置是 no_action。
    expect(listChannelCardsForObject(db, sigh.objectKey)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(getChannelLane(db, sigh.objectKey)!.context.map((message) => message.text)).toEqual(["各种连招好多。我等客户端它们优化好了。弄不动了 :facepalm:"]);
    expect(dispositionOf(sigh.seq!)).toBe("no_action");
    const noted = listEvents(db, { kind: "channel.reply.not_needed" });
    expect(noted).toMatchObject([{
      level: "digest", payload: { forSeq: sigh.seq, needsReply: 0.05, askKind: "other", summary: expect.stringContaining("助手判断不用你回") },
    }]);
    expect(listLeadActivityEvents(db, { afterSeq: 0, limit: 20 }).map((event) => event.kind)).toContain("channel.reply.not_needed");
    // Lead 的一行摘要说明最新一条判断过不用回，不带原文。
    const line = channels.laneLines([sigh.objectKey]).get(sigh.objectKey)!;
    expect(line).toContain("最新一条助手判断不用你回");
    expect(line).not.toContain("弄不动了");
    // 同一个对话里接着问了一个问题：要回，开卡。
    const ask = (await channels.receive("slack", slack.dm("U0FOAM", "对了，接口文档在哪？"))).items[0]!;
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, ask)!)).toMatchObject({ state: "open", firstSeq: ask.seq, messageCount: 1 });
  });

  it("opens the card when the model is unsure or cannot answer", async () => {
    const unsure = scriptedSmartModel({ answers: { needs_reply: 0.45 } });
    const channels = hub({ smartModel: () => unsure });
    const item = (await channels.receive("slack", slack.dm("U0ZHANG", "嗯"))).items[0]!;
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ state: "open" });
    const broken = scriptedSmartModel({ failPurposes: ["channel_intake"] });
    const other = hub({ smartModel: () => broken });
    const lost = (await other.receive("slack", slack.dm("U0LI", "在吗"))).items[0]!;
    await other.idle();
    expect(getChannelCard(db, cardIdOf(db, lost)!)).toMatchObject({ state: "open" });
    expect(listEvents(db, { kind: "channel.reply.not_needed" })).toEqual([]);
  });

  it("only records a bot's reminder, without asking anything, and reads its text from the attachments", async () => {
    const model = scriptedSmartModel();
    const channels = hub({ smartModel: () => model });
    const reminder = (await channels.receive("slack", slack.dm("U0GCAL", "", {
      bot: true, attachments: [{ title: "周会", text: "10:00 开始，会议室 A", fields: [{ title: "参会人", value: "你、张三" }] }],
    }))).items[0]!;
    await channels.idle();
    expect(reminder).toMatchObject({ inserted: true, delivery: "record", cardId: null });
    // 级别也只记录（种子 slack.record_only）：不进 Lead 的当前局面，提醒的原文不进 Lead 的上下文。
    expect(getEvent(db, reminder.seq!)!.level).toBe("record");
    expect(getEvent(db, reminder.seq!)!.payload).toMatchObject({ text: "周会\n10:00 开始，会议室 A\n参会人: 你、张三", sender: { bot: true } });
    expect(listChannelCardsForObject(db, reminder.objectKey)).toEqual([]);
    expect(model.count("channel_intake")).toBe(0);
    expect(model.count("channel_urgency")).toBe(0);
  });

  it("judges the user's own reply that came before the card opened", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = scriptedSmartModel({ answers: { answers_request: 0.9 } });
    const slow: SmartModel = {
      backend: "slow-jev",
      async decide(state, questions, opts) {
        if (opts?.purpose === "channel_intake") await gate;
        return inner.decide(state, questions, opts);
      },
    };
    const channels = hub({ smartModel: () => slow, intakeTimeoutMs: 60_000 });
    const item = (await channels.receive("slack", slack.dm("U0ZHANG", "预算表你看了吗？"))).items[0]!;
    // 还在判断要不要用户回，用户已经在 Slack 里回答了。
    await channels.receive("slack", slack.selfReply("D0ZHANG", "看了，下午聊"));
    release();
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ state: "resolved_elsewhere" });
  });
});

describe("lanes", () => {
  it("keep each conversation's recent context, and give Lead one line per lane", async () => {
    const channels = hub();
    for (let index = 0; index < CHANNEL_LANE_CONTEXT_LIMIT + 5; index++) {
      await channels.receive("slack", slack.dm("U0ZHANG", `第 ${index} 条`));
    }
    await channels.receive("slack", slack.dm("U0LI", "李四的一条"));
    const lane = getChannelLane(db, "slack:D0ZHANG:main")!;
    expect(lane.context).toHaveLength(CHANNEL_LANE_CONTEXT_LIMIT);
    expect(lane.context.at(-1)).toMatchObject({ role: "them", sender: "张三", text: `第 ${CHANNEL_LANE_CONTEXT_LIMIT + 4} 条` });
    const lines = channels.laneLines(["slack:D0ZHANG:main", "ticket:7"]);
    expect([...lines.keys()].sort()).toEqual(["slack:D0LI:main", "slack:D0ZHANG:main"]);
    // 一行摘要只有结构化的事实，不带原文（spec D10）。
    expect(lines.get("slack:D0ZHANG:main")).toMatch(/^Slack · 张三的私信：25 条消息，卡 #\d+ 在会话卡里等用户处理，没有代查$/);
    expect([...lines.values()].join("\n")).not.toContain("第 24 条");
    // 用户在 Slack 里回了以后，那条道的摘要说明卡已结束；没结束的卡的道照样列出。
    const zhang = channels.listCards().find((card) => card.objectKey === "slack:D0ZHANG:main")!;
    await channels.act(zhang.id, "dismiss", { by: "user via test" });
    expect(channels.laneLines([]).get("slack:D0ZHANG:main")).toBeUndefined();
    expect(channels.laneLines(["slack:D0ZHANG:main"]).get("slack:D0ZHANG:main")).toContain("用户选了不回复");
  });

  it("asks request A only for messages from other people, once per message", async () => {
    const model = scriptedSmartModel();
    const channels = hub({ smartModel: () => model });
    const message = (await channels.receive("slack", slack.dm("U0ZHANG", "在吗"))).items[0]!;
    const second = slack.dm("U0ZHANG", "在吗？");
    const again = (await channels.receive("slack", second)).items[0]!;
    await channels.receive("slack", slack.redeliver(second));
    await channels.receive("slack", slack.selfReply("D0ZHANG", "在"));
    await channels.idle();
    const intakes = listEvents(db, { kind: "channel.intake.decided" });
    expect(intakes.map((event) => event.payload.forSeq).sort()).toEqual([message.seq, again.seq]);
    // 第 7 版：记下交接说明里选中的一句（没写回答的替身选兜底的一句），askKind 是它推出的旧意图。
    expect(intakes[0]).toMatchObject({ level: "record", payload: {
      status: "answered", situation: "other", askKind: "other", questionVersion: CHANNEL_INTAKE_QUESTION_VERSION, closing: "remark",
    } });
    expect(intakes[0]!.payload.summary).toContain("按「other」");
    expect(intakes[0]!.payload).not.toHaveProperty("delegation");
    expect(model.count("channel_intake")).toBe(2);
  });

  // 新装的机器和测试 daemon 没有候选仓库（2026-10-24）：以前 target_repo 只剩 none 一个选项，Jev 拒收，请求 A 一直没有回答。
  it("answers request A on a machine with no lookup candidates, and asks target_repo once there are some", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "knowledge", target_repo: "acme/orders" } });
    const bare = hub({ smartModel: () => model, lookupCandidates: () => [] });
    const first = (await bare.receive("slack", slack.dm("U0ZHANG", "订单的重试最多等多久？"))).items[0]!;
    await bare.idle();
    const withRepos = hub({
      smartModel: () => model,
      lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    });
    const second = (await withRepos.receive("slack", slack.dm("U0LI", "订单的重试最多等多久？"))).items[0]!;
    await withRepos.idle();
    const decided = (seq: number | null) => listEvents(db, { kind: "channel.intake.decided" }).find((event) => event.payload.forSeq === seq)!.payload;
    expect(decided(first.seq)).toMatchObject({ status: "answered", askKind: "knowledge", targetRepo: null, error: null });
    expect(decided(second.seq)).toMatchObject({ status: "answered", askKind: "knowledge", targetRepo: "acme/orders", error: null });
    const asked = model.calls.filter((call) => call.purpose === "channel_intake").map((call) => call.names.includes("target_repo"));
    expect(asked).toEqual([false, true]);
  });
});
