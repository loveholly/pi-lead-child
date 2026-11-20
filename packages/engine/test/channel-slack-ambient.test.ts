// 两种以前漏掉的 Slack 消息（2026-11-20，用户授权）。走真实的 hub 和 SQLite，Slack 是假的，人和消息都是编的。
//   - 全频道广播（@channel、@here、@everyone）：以前订阅频道里的只记录，没订阅的频道里的整个丢掉。现在不用用户处理也进摘要、
//     沉淀进记忆；不开卡、不代回。排除名单、外部共享的频道、机器人发的照旧。
//   - 用户本人起头的 thread：以前同事没 @ 用户的回复只记录。现在按结构判断回谁：回用户的走会话卡、请求 A 和授权表；
//     回别人的、说不清的、读不到 thread 的进摘要、沉淀进记忆，不开卡、不代回。
//   - 原有的保护不变：已经 @ 用户的、Lead 代发起头的 thread、用户自己回过、同一条消息重发。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  getChannelCard, getChannelLane, getEvent, listChannelCardsForObject, listEvents, listLeadActivityEvents, openDb, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackBroadcastOf, slackThreadAddressee, type ChannelAdapter, type SmartModel,
} from "../src/index.js";
import { FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-ambient-"), "plc.db"));
  clock = new Date("2026-11-20T02:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock,
    users: { U0NINA: { name: "Nina" }, U0LEO: { name: "Leo" }, U0EXT: { name: "Partner", team: "T0OTHER" } },
    channels: { C0QUIET: "quiet", C0SHARED: "partner", C0NOISE: "random" },
    sharedChannels: ["C0SHARED"],
  });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

function setup(options: { smartModel?: () => SmartModel; exclude?: string[] } = {}): { hub: ChannelHub; adapter: ChannelAdapter } {
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock, ...(options.exclude ? { memory: { exclude: options.exclude } } : {}) });
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    ...(options.smartModel ? { smartModel: options.smartModel, classifyTimeoutMs: 60_000, audit: { rate: 0 } } : {}),
  });
  hubs.push(hub);
  return { hub, adapter };
}

const tsOf = (delivery: { body: string }) => (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;
const event = (seq: number | null) => getEvent(db, seq!)!;

describe("slackBroadcastOf: Slack's own broadcast markup only", () => {
  it("knows @channel, @here and @everyone in the text or in rich text", () => {
    expect(slackBroadcastOf({ text: "<!channel> 周五发版冻结" })).toBe("channel");
    expect(slackBroadcastOf({ text: "提醒 <!here|here> 看一下" })).toBe("here");
    expect(slackBroadcastOf({ text: "<!everyone> 下午全员会" })).toBe("everyone");
    const blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "broadcast", range: "here" }, { type: "text", text: " 看下" }] }] }];
    expect(slackBroadcastOf({ text: "", blocks })).toBe("here");
  });

  it("does not take plain words, a user group or a person for a broadcast", () => {
    expect(slackBroadcastOf({ text: "别在这里用 @channel" })).toBeNull();
    expect(slackBroadcastOf({ text: "<!subteam^S0TEAM|@backend> 看下" })).toBeNull();
    expect(slackBroadcastOf({ text: "<@U0NINA> 看下" })).toBeNull();
  });
});

describe("slackThreadAddressee: whom a reply in the user's own thread is for", () => {
  const root = { user: "U0SELF", ts: "1763600000.000100", text: "退款接口谁来负责？" };
  const judge = (sender: string, text: string, earlier: Array<Record<string, string>>) =>
    slackThreadAddressee({ self: "U0SELF", sender, text, earlier });

  it("is the user when the reply follows the user's words", () => {
    expect(judge("U0NINA", "我来负责", [root])).toEqual({ addressee: "owner", basis: "follows_owner" });
    // 同一个人连着说两句：还是接着用户的话。
    expect(judge("U0NINA", "下周一给方案", [root, { user: "U0NINA", ts: "1763600001.000100", text: "我来负责" }]))
      .toEqual({ addressee: "owner", basis: "follows_owner" });
  });

  it("is someone else when the reply mentions another person or a group", () => {
    expect(judge("U0LEO", "<@U0NINA> 你那边来吧", [root])).toEqual({ addressee: "other", basis: "mentions_other" });
    expect(judge("U0LEO", "<!subteam^S0TEAM|@backend> 谁有空", [root])).toEqual({ addressee: "other", basis: "mentions_other" });
  });

  it("is unclear when the reply follows another colleague, and when the thread could not be read", () => {
    const nina = { user: "U0NINA", ts: "1763600001.000100", text: "我觉得 Leo 更熟" };
    expect(judge("U0LEO", "好，我接", [root, nina])).toEqual({ addressee: "unclear", basis: "follows_other" });
    expect(judge("U0LEO", "好，我接", [])).toEqual({ addressee: "unclear", basis: "unavailable" });
  });

  it("follows a link to a message, or a quote that only one message holds", () => {
    const nina = { user: "U0NINA", ts: "1763600001.000100", text: "我觉得 Leo 更熟" };
    const link = "<https://acme.slack.com/archives/C0QUIET/p1763600000000100|这条>";
    expect(judge("U0LEO", `回 ${link}：我接`, [root, nina])).toEqual({ addressee: "owner", basis: "points_to_owner" });
    expect(judge("U0LEO", "&gt; 我觉得 Leo 更熟\n是的", [root, nina])).toEqual({ addressee: "other", basis: "points_to_other" });
  });
});

describe("channel broadcasts go to the digest and to memory", () => {
  async function subscribe(hub: ChannelHub, channel: string) {
    await hub.receive("slack", slack.mention("U0LEO", "请看一下", { channel }));
  }

  it("takes a broadcast in a channel the user has no conversation in, without a card or a lane (regression: it was dropped)", async () => {
    const model = scriptedSmartModel();
    const { hub, adapter } = setup({ smartModel: () => model });
    const delivery = slack.chatter("U0NINA", "<!channel> 周五 18:00 起发版冻结，紧急修复走值班", "C0QUIET");
    const item = (await hub.receive("slack", delivery)).items[0]!;
    await hub.idle();
    expect(item).toMatchObject({ kind: "slack.broadcast.message", role: "message", inserted: true, delivery: "digest", cardId: null });
    expect(event(item.seq)).toMatchObject({
      level: "digest",
      payload: { broadcast: "channel", channelDelivery: "digest", ambient: true, text: "@channel 周五 18:00 起发版冻结，紧急修复走值班" },
    });
    // 不开道、不开卡，也不因此订阅这个频道；不问紧急程度，不问请求 A，什么也不发。
    expect(getChannelLane(db, item.objectKey)).toBeUndefined();
    expect(listChannelCardsForObject(db, item.objectKey)).toEqual([]);
    expect(event(item.seq).payload.urgency).toMatchObject({ by: "not_asked", reason: "ambient" });
    expect(model.calls).toEqual([]);
    expect(slack.sent()).toEqual([]);
    // 进「Lead 动态」和 Lead 的摘要（digest 级），沉淀进记忆。
    expect(listLeadActivityEvents(db, { afterSeq: 0, limit: 10 }).map((entry) => entry.seq)).toContain(item.seq);
    expect(adapter.memory!.kinds["slack.broadcast.message"]).toBe("message");
    expect(adapter.memory!.accepts(event(item.seq).payload)).toBe(true);
    // 这个频道里的普通消息照旧不收。
    expect(await hub.receive("slack", slack.chatter("U0NINA", "午饭吃什么", "C0QUIET"))).toEqual({ accepted: true, items: [] });
  });

  it("puts a broadcast of a subscribed channel into the digest, and leaves plain chatter recorded only (regression: it was recorded only)", async () => {
    const { hub } = setup();
    await subscribe(hub, "C0PROJ");
    const broadcast = (await hub.receive("slack", slack.chatter("U0NINA", "<!here> 发布清单已更新", "C0PROJ"))).items[0]!;
    expect(broadcast).toMatchObject({ kind: "slack.broadcast.message", delivery: "digest", cardId: null });
    expect(event(broadcast.seq).level).toBe("digest");
    const chatter = (await hub.receive("slack", slack.chatter("U0NINA", "发布清单已更新", "C0PROJ"))).items[0]!;
    expect(chatter).toMatchObject({ kind: "slack.channel.message", delivery: "record" });
    expect(event(chatter.seq).level).toBe("record");
    // 订阅频道里外部的人发的广播也只进摘要。
    const external = (await hub.receive("slack", slack.chatter("U0EXT", "<!channel> 我们的接口今晚维护", "C0PROJ"))).items[0]!;
    expect(external).toMatchObject({ kind: "slack.broadcast.message", delivery: "digest", cardId: null });
  });

  it("knows a broadcast written only in rich text, and a broadcast sent as a thread reply", async () => {
    const { hub } = setup();
    const blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "broadcast", range: "everyone" }] }] }];
    const rich = (await hub.receive("slack", slack.chatter("U0NINA", "下午三点全员会", "C0QUIET", { blocks }))).items[0]!;
    expect(rich).toMatchObject({ kind: "slack.broadcast.message", delivery: "digest" });
    const reply = (await hub.receive("slack", slack.chatter("U0NINA", "<!channel> 改到四点", "C0QUIET", { thread: tsOf(slack.chatter("U0LEO", "会议", "C0QUIET")) }))).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.broadcast.message", delivery: "digest", cardId: null });
  });

  it("keeps the old boundaries: excluded channels, shared channels it has no conversation in, unknown channels, bots", async () => {
    const { hub } = setup({ exclude: ["#random"] });
    expect(await hub.receive("slack", slack.chatter("U0NINA", "<!channel> 抽奖", "C0NOISE"))).toEqual({ accepted: true, items: [] });
    expect(await hub.receive("slack", slack.chatter("U0EXT", "<!channel> 我们周末停机", "C0SHARED"))).toEqual({ accepted: true, items: [] });
    // conversations.info 问不到的频道按外部共享对待。
    expect(await hub.receive("slack", slack.chatter("U0NINA", "<!channel> 没有名字的频道", "C0GONE"))).toEqual({ accepted: true, items: [] });
    // 机器人发的广播：只记录（沉淀进记忆），不进摘要。
    const bot = (await hub.receive("slack", slack.chatter("U0LEO", "<!channel> 有一个新的 PR 等 review", "C0QUIET", { bot: true }))).items[0]!;
    expect(bot).toMatchObject({ kind: "slack.broadcast.message", delivery: "record", cardId: null });
    expect(event(bot.seq).level).toBe("record");
  });

  it("records a broadcast once when Slack sends it again, and learns when it is deleted", async () => {
    const { hub } = setup();
    const delivery = slack.chatter("U0NINA", "<!channel> 周五发版冻结", "C0QUIET");
    const first = (await hub.receive("slack", delivery)).items[0]!;
    const again = (await hub.receive("slack", slack.redeliver(delivery))).items[0]!;
    expect(again).toMatchObject({ seq: first.seq, inserted: false, cardId: null });
    expect(listEvents(db, { kind: "slack.broadcast.message" })).toHaveLength(1);
    // 删掉了：记下来，记忆里不能留删掉的话。
    const removed = (await hub.receive("slack", slack.remove(delivery))).items[0]!;
    expect(removed).toMatchObject({ kind: "slack.message.deleted", delivery: "record", objectKey: first.objectKey });
  });

  it("still opens a card for a broadcast that also mentions the user", async () => {
    const { hub } = setup();
    const mention = (await hub.receive("slack", slack.mention("U0NINA", "<!channel> 尤其你看一下", { channel: "C0QUIET" }))).items[0]!;
    expect(mention).toMatchObject({ kind: "slack.mention.received", delivery: "card" });
    expect(mention.cardId).not.toBeNull();
  });
});

describe("threads the user started", () => {
  // 用户本人在频道里发了根消息（Slack 推回来的是用户自己的话）。
  async function ownThread(hub: ChannelHub, text = "退款接口这周谁来负责？", channel = "C0QUIET") {
    const root = slack.selfReply(channel, text);
    const mine = (await hub.receive("slack", root)).items[0]!;
    expect(mine).toMatchObject({ role: "self_reply", delivery: "record" });
    return { thread: tsOf(root), objectKey: mine.objectKey };
  }

  it("takes a colleague's reply to the user into the intake and the authority table, without a mention (regression: it was recorded only)", async () => {
    const model = scriptedSmartModel();
    const { hub } = setup({ smartModel: () => model });
    const { thread, objectKey } = await ownThread(hub);
    const reply = (await hub.receive("slack", slack.chatter("U0NINA", "我来负责，周一给方案可以吗？", "C0QUIET", { thread }))).items[0]!;
    await hub.idle();
    expect(reply).toMatchObject({ kind: "slack.thread.message", role: "message", objectKey });
    expect(event(reply.seq).payload).toMatchObject({ addressee: "owner", addresseeBasis: "follows_owner" });
    expect(event(reply.seq).payload.ambient).toBeUndefined();
    // 请求 A 问过了，授权表定了怎么办，开了这个对话的卡。
    expect(model.count("channel_intake")).toBeGreaterThan(0);
    expect(listEvents(db, { kind: "channel.authority.decided", entityKey: objectKey })).toHaveLength(1);
    expect(listChannelCardsForObject(db, objectKey)).toHaveLength(1);
  });

  it("puts a reply to another colleague and a turn to another colleague into the digest, without a card or a reply", async () => {
    const model = scriptedSmartModel();
    const { hub, adapter } = setup({ smartModel: () => model });
    const { thread, objectKey } = await ownThread(hub);
    const toLeo = (await hub.receive("slack", slack.chatter("U0NINA", "<@U0LEO> 你之前做过退款，你来看看？", "C0QUIET", { thread }))).items[0]!;
    // 话题转到 Leo：Leo 接着 Nina 说，没有 @ 谁，说不清回谁。
    const leo = (await hub.receive("slack", slack.chatter("U0LEO", "行，我今天看下代码", "C0QUIET", { thread }))).items[0]!;
    await hub.idle();
    expect(toLeo).toMatchObject({ kind: "slack.owner_thread.message", delivery: "digest", cardId: null, objectKey });
    expect(event(toLeo.seq)).toMatchObject({ level: "digest", payload: { addressee: "other", addresseeBasis: "mentions_other", ambient: true } });
    expect(leo).toMatchObject({ kind: "slack.owner_thread.message", delivery: "digest", cardId: null });
    expect(event(leo.seq)).toMatchObject({ level: "digest", payload: { addressee: "unclear", addresseeBasis: "follows_other" } });
    // 没有开道、开卡，没有问请求 A，没有替用户回。进摘要，沉淀进记忆。
    expect(getChannelLane(db, objectKey)).toBeUndefined();
    expect(listChannelCardsForObject(db, objectKey)).toEqual([]);
    expect(model.count("channel_intake")).toBe(0);
    expect(slack.sent()).toEqual([]);
    expect(listLeadActivityEvents(db, { afterSeq: 0, limit: 10 }).map((entry) => entry.seq)).toEqual(expect.arrayContaining([toLeo.seq, leo.seq]));
    expect(adapter.memory!.kinds["slack.owner_thread.message"]).toBe("message");
    expect(adapter.memory!.accepts(event(leo.seq).payload)).toBe(true);
  });

  it("keeps a reply in the digest when the thread cannot be read", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await ownThread(hub);
    slack.failNext("conversations.replies", "network down");
    const reply = (await hub.receive("slack", slack.chatter("U0NINA", "我来", "C0QUIET", { thread }))).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.owner_thread.message", delivery: "digest", cardId: null });
    expect(event(reply.seq).payload).toMatchObject({ addressee: "unclear", addresseeBasis: "unavailable" });
    expect(listChannelCardsForObject(db, objectKey)).toEqual([]);
  });

  it("keeps a reply to someone else out of an open card of the thread, but in its context", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await ownThread(hub);
    const toMe = (await hub.receive("slack", slack.chatter("U0NINA", "我来负责", "C0QUIET", { thread }))).items[0]!;
    expect(toMe).toMatchObject({ kind: "slack.thread.message", delivery: "card" });
    const toLeo = (await hub.receive("slack", slack.chatter("U0NINA", "<@U0LEO> 你帮我看下数据库那块", "C0QUIET", { thread }))).items[0]!;
    expect(toLeo).toMatchObject({ kind: "slack.owner_thread.message", delivery: "digest", cardId: null });
    expect(getChannelCard(db, toMe.cardId!)).toMatchObject({ messageCount: 1, lastSeq: toMe.seq });
    expect(getChannelLane(db, objectKey)!.context.map((message) => message.text)).toContain("@Leo 你帮我看下数据库那块");
  });

  it("does not treat a thread the user only replied in as the user's own", async () => {
    const { hub } = setup();
    const root = slack.chatter("U0LEO", "有人知道发布窗口吗", "C0QUIET");
    const thread = tsOf(root);
    await hub.receive("slack", slack.selfReply("C0QUIET", "周四下午", { thread }));
    const reply = (await hub.receive("slack", slack.chatter("U0LEO", "好的，那我周四发", "C0QUIET", { thread }))).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.followed.message", delivery: "record", cardId: null });
  });

  it("keeps the old protections: a mention, the user's own reply, a redelivery, and a thread Lead started", async () => {
    const { hub } = setup();
    const { thread, objectKey } = await ownThread(hub);
    // 回用户的话：同一条 Slack 重发，只记一次，不多开卡。
    const delivery = slack.chatter("U0NINA", "我来负责", "C0QUIET", { thread });
    const reply = (await hub.receive("slack", delivery)).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.thread.message", delivery: "card", objectKey });
    const again = (await hub.receive("slack", slack.redeliver(delivery))).items[0]!;
    expect(again).toMatchObject({ seq: reply.seq, inserted: false });
    expect(listEvents(db, { kind: "slack.thread.message", entityKey: objectKey })).toHaveLength(1);
    // 已经 @ 用户：照旧是提及（不管前面是谁说的），并进同一张卡。
    const mention = (await hub.receive("slack", slack.mention("U0LEO", "你确认一下？", { channel: "C0QUIET", thread }))).items[0]!;
    expect(mention).toMatchObject({ kind: "slack.mention.received", delivery: "card", cardId: reply.cardId });
    expect(listChannelCardsForObject(db, objectKey)).toHaveLength(1);
    expect(getChannelCard(db, reply.cardId!)).toMatchObject({ messageCount: 2 });
    // 用户自己在 Slack 里回了：卡不再等助手（别处已处理，或者用户在自己回）。
    await hub.receive("slack", slack.selfReply("C0QUIET", "好，Nina 负责", { thread }));
    await hub.idle();
    expect(getChannelCard(db, reply.cardId!)!.state).not.toBe("open");

    // Lead 代用户发的根消息起头的 thread：同事回别人的话也照旧进卡（Lead 代发起头的线程原有的行为）。
    await hub.receive("slack", slack.mention("U0LEO", "请看一下", { channel: "C0PROJ" }));
    await hub.sendMessage("slack:C0PROJ:main", { text: "<@U0NINA> 退货运费这周能定吗？", words: "assistant", forUser: true, by: "lead for user via turn:turn-1" });
    const posted = slack.sent("C0PROJ").at(-1)!;
    await hub.receive("slack", slack.echoOf(posted));
    const led = (await hub.receive("slack", slack.chatter("U0NINA", "<@U0LEO> 仓库地址你知道吗？", "C0PROJ", { thread: posted.ts }))).items[0]!;
    expect(led).toMatchObject({ kind: "slack.thread.message", delivery: "card" });
    expect(led.cardId).not.toBeNull();
  });
});
