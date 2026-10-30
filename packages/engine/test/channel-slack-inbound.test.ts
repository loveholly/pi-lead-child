// slack-takeover 工单 02（spec D11、D12 的入站部分）：Slack 插件新认的几件事，走真实的 hub 和 SQLite，Slack 是假的。
//   - 线程里已经有道的后续消息：不带 @ 也收（slack.thread.message），进同一张卡。
//   - 改消息、删消息：只对已有的道；这个对话有没结束的卡时更新卡，没有时只记录、不开新卡。
//   - 订阅频道（14 天内有过道）里的普通消息：只记录，不开卡、不开道、不问紧急程度。
//   - 事实字段 externalShared（conversations.info，带缓存）。
//   - 凭据：两个令牌换成凭据（auth.test、users.info），日志里没有令牌。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCard, getChannelLane, getEvent, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelAdapter, type SmartModel } from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-inbound-"), "plc.db"));
  clock = new Date("2026-10-20T10:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock, users: { U0EXT: { name: "外部的人", team: "T0OTHER" } }, channels: { C0SHARED: "partner", C0QUIET: "quiet" },
    sharedChannels: ["C0SHARED"],
  });
  logs = [];
});

afterEach(() => {
  db.close();
});

function setup(options: { smartModel?: () => SmartModel } = {}): { hub: ChannelHub; adapter: ChannelAdapter } {
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    log: (line) => logs.push(line), ...options,
  });
  return { hub, adapter };
}

const threadOf = (delivery: { body: string }) => (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;

describe("text for people and models (user 2026-10-23)", () => {
  it("shows names instead of Slack markup, and still knows the message mentions the user", async () => {
    const { hub } = setup();
    const delivery = slack.mention("U0ZHANG", "<@U0LI> 看下 <#C0QUIET> 和 <https://example.test/a|这个>，&lt;很急&gt;");
    const [item] = (await hub.receive("slack", delivery)).items;
    await hub.idle();
    expect(item).toMatchObject({ kind: "slack.mention.received", role: "message" });
    const event = getEvent(db, item!.seq!)!;
    expect(event.payload.text).toBe("@我 @李四 看下 #quiet 和 这个（https://example.test/a），<很急>");
    // 这条道的上下文（Lead、请求 A、请求 B 读的）也是换过的字。
    expect(getChannelLane(db, item!.objectKey)!.context.at(-1)!.text).toBe(event.payload.text);
  });
});

describe("thread follow-ups", () => {
  it("takes a follow-up without a mention only in a thread that already has a lane", async () => {
    const { hub } = setup();
    const mention = slack.mention("U0ZHANG", "这个接口的超时是多少？");
    const first = (await hub.receive("slack", mention)).items[0]!;
    const thread = threadOf(mention);
    const followUp = await hub.receive("slack", slack.chatter("U0ZHANG", "补充一下：是生产环境", "C0PROJ", { thread }));
    expect(followUp.items[0]).toMatchObject({
      kind: "slack.thread.message", role: "message", objectKey: first.objectKey, cardId: first.cardId, delivery: "card",
    });
    expect(getChannelCard(db, first.cardId!)).toMatchObject({ messageCount: 2, excerpt: "补充一下：是生产环境" });
    expect(getChannelLane(db, first.objectKey)!.context.map((message) => message.text)).toContain("补充一下：是生产环境");
    // 别的、没有道的线程（这个频道已经订阅了）：只记录。没有道的频道里的线程：不收。
    const other = await hub.receive("slack", slack.chatter("U0LI", "别的讨论", "C0PROJ", { thread: "1760000000.000001" }));
    expect(other.items[0]).toMatchObject({ kind: "slack.channel.message", delivery: "record", cardId: null });
    expect(await hub.receive("slack", slack.chatter("U0LI", "无关的线程", "C0QUIET", { thread: "1760000000.000002" })))
      .toEqual({ accepted: true, items: [] });
  });
});

// 用户 2026-10-21：照 Slack 自己的关注规则（发起、回复过的 thread 会关注），把这些 thread 里的讨论默默沉淀下来。
// 只记录、沉淀进记忆：不开卡、不开道、不问模型，也不进 Lead 的上下文。被 @ 时照常开卡，之后按道收，不会记两次。
describe("threads the user follows, by Slack's own rules", () => {
  const level = (seq: number | null) => getEvent(db, seq!)!.level;

  it("follows a thread the user replied to, records the replies there quietly, and turns into a lane on a mention", async () => {
    const { hub, adapter } = setup();
    const root = slack.chatter("U0LI", "有人知道这周的发布窗口吗", "C0QUIET");
    // 没订阅的频道、用户还没说过话：不收。
    expect(await hub.receive("slack", root)).toEqual({ accepted: true, items: [] });
    const thread = threadOf(root);
    const objectKey = `slack:C0QUIET:${thread}`;
    const mine = (await hub.receive("slack", slack.selfReply("C0QUIET", "周四下午", { thread }))).items[0]!;
    expect(mine).toMatchObject({ kind: "slack.self.reply", role: "self_reply", inserted: true, delivery: "record", cardId: null, objectKey });
    expect(getEvent(db, mine.seq!)!.payload).toMatchObject({ channelDelivery: "record" });
    expect(level(mine.seq)).toBe("record");
    expect(getChannelLane(db, objectKey)).toBeUndefined();

    const reply = (await hub.receive("slack", slack.chatter("U0LI", "好的，那我周四发", "C0QUIET", { thread }))).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.followed.message", role: "message", delivery: "record", cardId: null, objectKey });
    expect(level(reply.seq)).toBe("record");
    expect(getChannelLane(db, objectKey)).toBeUndefined();
    // 再说一次话：只是又记一条用户的话，没有别的「订阅」要记，也不会因此多收一份。
    await hub.receive("slack", slack.selfReply("C0QUIET", "记得先打 tag", { thread }));
    const again = (await hub.receive("slack", slack.chatter("U0LI", "收到", "C0QUIET", { thread }))).items[0]!;
    expect(again).toMatchObject({ kind: "slack.followed.message", delivery: "record" });
    expect(listEvents(db, { kind: "slack.followed.message" })).toHaveLength(2);

    // 后来有人在这个 thread 里 @ 用户：照常开卡、开道。之后的消息按道收，不再按「关注」记一遍。
    const mention = (await hub.receive("slack", slack.mention("U0LI", "你确认一下回滚方案？", { channel: "C0QUIET", thread }))).items[0]!;
    expect(mention).toMatchObject({ kind: "slack.mention.received", delivery: "card", objectKey });
    expect(getChannelLane(db, objectKey)).toBeDefined();
    const after = (await hub.receive("slack", slack.chatter("U0LI", "补充：回滚要 5 分钟", "C0QUIET", { thread }))).items[0]!;
    expect(after).toMatchObject({ kind: "slack.thread.message", cardId: mention.cardId });
    expect(listEvents(db, { kind: "slack.followed.message" })).toHaveLength(2);
    expect(getChannelCard(db, mention.cardId!)).toMatchObject({ messageCount: 2 });
    // 关注的 thread 里的讨论会沉淀进记忆。
    expect(adapter.memory!.kinds["slack.followed.message"]).toBe("message");
  });

  it("follows a thread the user started", async () => {
    const { hub } = setup();
    const started = slack.selfReply("C0QUIET", "大家看下这个提案");
    const mine = (await hub.receive("slack", started)).items[0]!;
    expect(mine).toMatchObject({ role: "self_reply", delivery: "record" });
    const reply = (await hub.receive("slack", slack.chatter("U0ZHANG", "我觉得可以", "C0QUIET", { thread: threadOf(started) }))).items[0]!;
    expect(reply).toMatchObject({ kind: "slack.followed.message", delivery: "record", objectKey: mine.objectKey });
  });

  it("does not follow threads in excluded channels, nor anything in direct messages", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock, memory: { exclude: ["#quiet"] } });
    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    });
    const root = slack.chatter("U0LI", "排除的频道", "C0QUIET");
    const thread = threadOf(root);
    expect((await hub.receive("slack", slack.selfReply("C0QUIET", "我回一句", { thread }))).items[0]).toMatchObject({ ignored: "no_lane" });
    expect(await hub.receive("slack", slack.chatter("U0LI", "接着说", "C0QUIET", { thread }))).toEqual({ accepted: true, items: [] });
    expect((await hub.receive("slack", slack.selfReply("D0NOBODY", "私信里自己说的话"))).items[0]).toMatchObject({ ignored: "no_lane" });
  });
});

describe("edits and deletes", () => {
  it("update the open card of the conversation, and are ignored outside a lane", async () => {
    const { hub } = setup();
    const dm = slack.dm("U0ZHANG", "周五能评审吗？");
    const first = (await hub.receive("slack", dm)).items[0]!;
    const edited = await hub.receive("slack", slack.edit(dm, "周六能评审吗？"));
    expect(edited.items[0]).toMatchObject({ kind: "slack.message.edited", role: "message", cardId: first.cardId, inserted: true });
    const card = getChannelCard(db, first.cardId!)!;
    expect(card).toMatchObject({ excerpt: "周六能评审吗？", lastSeq: edited.items[0]!.seq, gate: null });
    expect(getEvent(db, edited.items[0]!.seq!)).toMatchObject({ level: "record", payload: { ts: slack.messageOf(dm).ts, text: "周六能评审吗？" } });
    // 只改了附件预览、文字没变：不算。
    expect((await hub.receive("slack", slack.edit(dm, "周六能评审吗？"))).items).toEqual([]);
    // 删掉：卡上看得到，不带原文。
    const removed = await hub.receive("slack", slack.remove(dm));
    expect(removed.items[0]).toMatchObject({ kind: "slack.message.deleted", cardId: first.cardId });
    expect(getChannelCard(db, first.cardId!)!.excerpt).toBe("（删除了一条消息）");
    expect(JSON.stringify(getEvent(db, removed.items[0]!.seq!)!.payload)).not.toContain("周六能评审吗");

    // 卡结束以后再改：只记录，不开新卡。
    await hub.act(first.cardId!, "dismiss", { by: "user via test" });
    const later = slack.dm("U0ZHANG", "另一件事");
    const second = (await hub.receive("slack", later)).items[0]!;
    await hub.act(second.cardId!, "dismiss", { by: "user via test" });
    const cards = db.prepare("SELECT COUNT(*) AS n FROM channel_cards").get() as { n: number };
    const quiet = await hub.receive("slack", slack.edit(later, "另一件事（改）"));
    expect(quiet.items[0]).toMatchObject({ kind: "slack.message.edited", inserted: true, delivery: "record", cardId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_cards").get()).toEqual(cards);

    // 用户自己的消息被改、没有道的对话里的消息被改或删：不收。
    const own = slack.selfReply("D0ZHANG", "我说的话");
    await hub.receive("slack", own);
    expect((await hub.receive("slack", slack.edit(own, "我改了我说的话"))).items).toEqual([]);
    const elsewhere = slack.dm("U0LI", "没有收过的私信");
    expect((await hub.receive("slack", slack.edit(elsewhere, "改了"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.remove(elsewhere))).items).toEqual([]);
  });
});

describe("subscribed channels (spec D12)", () => {
  it("records plain messages in a channel with a recent lane, without a card, a lane or an urgency question", async () => {
    let asked = 0;
    let intakes = 0;
    const model: SmartModel = {
      backend: "fake-jev",
      async decide(_state, questions, opts) {
        // 借权限的一问（issue 05）和请求 A 同时发：不计数，也不回答。
        if (opts?.purpose === "channel_access") throw new Error("fake-jev: access not answered in this test");
        // 请求 A（工单 04）另外计数：订阅频道的消息也不问它。
        if (opts?.purpose === "channel_intake") {
          intakes += 1;
          throw new Error("fake-jev: intake not answered in this test");
        }
        asked += 1;
        const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability: 0.99 }]));
        return { answers: answers as never, backend: "fake-jev", model: null, latencyMs: 1, fallbackFrom: null };
      },
    };
    const { hub } = setup({ smartModel: () => model });
    // 没有道的频道：不收。
    expect((await hub.receive("slack", slack.chatter("U0LI", "大家好"))).items).toEqual([]);
    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下"));
    expect(asked).toBe(1);
    const plain = await hub.receive("slack", slack.chatter("U0LI", "线上又挂了，大家看看"));
    expect(plain.items[0]).toMatchObject({ kind: "slack.channel.message", inserted: true, delivery: "record", cardId: null });
    const event = getEvent(db, plain.items[0]!.seq!)!;
    expect(event).toMatchObject({ level: "record", payload: { urgent: false, urgency: { by: "not_asked", reason: "record_only" } } });
    expect(asked).toBe(1);
    expect(getChannelLane(db, plain.items[0]!.objectKey)).toBeUndefined();
    await hub.idle();
    expect(intakes).toBe(1);
    // 14 天里没有新的对话：退订，不再收。
    clock = new Date(clock.getTime() + 15 * 24 * 60 * 60_000);
    expect((await hub.receive("slack", slack.chatter("U0LI", "两周以后"))).items).toEqual([]);
    expect(listEvents(db, { kind: "slack.channel.message" })).toHaveLength(1);
  });
});

// slack-takeover 工单 07（spec D12）：排除名单（config.json 的 channels.slack.memory.exclude）在订阅的判断里生效；
// 订阅频道里没有道的线程，改和删也只记录（记忆沉淀要知道哪条消息删了）。
describe("memory exclusions and subscribed-channel amendments", () => {
  function excluding(exclude: string[]): ChannelHub {
    const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock, memory: { exclude } });
    return new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
      log: (line) => logs.push(line),
    });
  }

  it("does not subscribe to an excluded channel, by id or by name, and treats a channel whose name it cannot learn as excluded", async () => {
    slack = new FakeSlack({ now: () => clock, channels: { C0OPS: "ops", C0HR: "hr-private" } });
    const hub = excluding(["C0OPS", "#HR-Private", "", 42 as unknown as string]);
    for (const channel of ["C0PROJ", "C0OPS", "C0HR", "C0GONE"]) {
      const mention = await hub.receive("slack", slack.mention("U0ZHANG", "请看一下", { channel }));
      // 被提到照样开卡：排除名单只管订阅和记忆沉淀。
      expect(mention.items[0]).toMatchObject({ kind: "slack.mention.received", delivery: "card" });
    }
    expect((await hub.receive("slack", slack.chatter("U0LI", "运维", "C0OPS"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.chatter("U0LI", "人事", "C0HR"))).items).toEqual([]);
    // C0GONE 问不到名字（conversations.info 回 channel_not_found）：名单不空，按排除处理。
    expect((await hub.receive("slack", slack.chatter("U0LI", "不知道叫什么", "C0GONE"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.chatter("U0LI", "项目"))).items[0]).toMatchObject({ kind: "slack.channel.message" });
    expect(getEvent(db, listEvents(db, { kind: "slack.channel.message" })[0]!.seq)!.payload).toMatchObject({ channelName: "proj-x" });

    // 没有排除名单时，问不到名字的频道照常订阅。
    const open = excluding([]);
    expect((await open.receive("slack", slack.chatter("U0LI", "不知道叫什么", "C0GONE"))).items[0]).toMatchObject({
      kind: "slack.channel.message", delivery: "record",
    });
  });

  it("records edits and deletes in a subscribed channel's thread without a lane, without a lane or a card", async () => {
    const { hub } = setup();
    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下"));
    const plain = slack.chatter("U0LI", "周五发布");
    const key = (await hub.receive("slack", plain)).items[0]!.objectKey;
    const cards = db.prepare("SELECT COUNT(*) AS n FROM channel_cards").get();
    const edited = await hub.receive("slack", slack.edit(plain, "周六发布"));
    expect(edited.items[0]).toMatchObject({ kind: "slack.message.edited", inserted: true, delivery: "record", cardId: null, objectKey: key });
    expect(getEvent(db, edited.items[0]!.seq!)).toMatchObject({ level: "record", payload: { text: "周六发布", ts: slack.messageOf(plain).ts } });
    const removed = await hub.receive("slack", slack.remove(plain));
    expect(removed.items[0]).toMatchObject({ kind: "slack.message.deleted", inserted: true, delivery: "record", cardId: null });
    expect(getChannelLane(db, key)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_cards").get()).toEqual(cards);

    // 没有订阅的频道里：改和删都不收。
    const quiet = slack.chatter("U0LI", "无关", "C0QUIET");
    expect((await hub.receive("slack", quiet)).items).toEqual([]);
    expect((await hub.receive("slack", slack.edit(quiet, "无关（改）"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.remove(quiet))).items).toEqual([]);
  });
});

describe("externally shared conversations", () => {
  it("marks each event with conversations.info, cached for a while", async () => {
    const { hub } = setup();
    const shared = (await hub.receive("slack", slack.mention("U0EXT", "能帮忙看下吗", { channel: "C0SHARED" }))).items[0]!;
    const home = (await hub.receive("slack", slack.mention("U0ZHANG", "能帮忙看下吗"))).items[0]!;
    const dm = (await hub.receive("slack", slack.dm("U0LI", "在吗"))).items[0]!;
    expect(getEvent(db, shared.seq!)!.payload.externalShared).toBe(true);
    expect(getEvent(db, home.seq!)!.payload.externalShared).toBe(false);
    expect(getEvent(db, dm.seq!)!.payload.externalShared).toBe(false);
    const infoCalls = () => slack.calls.filter((call) => call.method === "conversations.info" && call.args.channel === "C0SHARED").length;
    await hub.receive("slack", slack.mention("U0EXT", "再问一次", { channel: "C0SHARED" }));
    expect(infoCalls()).toBe(1);
    clock = new Date(clock.getTime() + 11 * 60_000);
    await hub.receive("slack", slack.mention("U0EXT", "过了一会儿", { channel: "C0SHARED" }));
    expect(infoCalls()).toBe(2);
    // 问不到时：用上一次的；从来没问到过时是 null（用的人按外部共享对待）。
    clock = new Date(clock.getTime() + 11 * 60_000);
    slack.failNext("conversations.info", "network down");
    const stale = (await hub.receive("slack", slack.mention("U0EXT", "网络断了", { channel: "C0SHARED" }))).items[0]!;
    expect(getEvent(db, stale.seq!)!.payload.externalShared).toBe(true);
    slack.failNext("conversations.info", "network down");
    const unknown = (await hub.receive("slack", slack.dm("U0ZHANG", "第一次私信"))).items[0]!;
    expect(getEvent(db, unknown.seq!)!.payload.externalShared).toBeNull();
  });
});

describe("credentials from the two tokens", () => {
  it("checks the token kinds, finds the user with auth.test and users.info, and keeps the tokens out of the log", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(adapter.auth.secrets).toEqual(["PLC_SLACK_APP_TOKEN", "PLC_SLACK_USER_TOKEN"]);
    const swapped = await adapter.resolveCredential!({ PLC_SLACK_APP_TOKEN: FAKE_SLACK_TOKEN, PLC_SLACK_USER_TOKEN: FAKE_SLACK_APP_TOKEN }, log);
    expect(swapped).toBeNull();
    expect(lines.join("\n")).toContain("PLC_SLACK_APP_TOKEN is not an app-level token");
    const credential = await adapter.resolveCredential!({ PLC_SLACK_APP_TOKEN: FAKE_SLACK_APP_TOKEN, PLC_SLACK_USER_TOKEN: FAKE_SLACK_TOKEN }, log);
    expect(credential).toEqual({
      token: FAKE_SLACK_TOKEN, account: "U0SELF", accountName: "我", team: { id: "T0HOME", name: "Home" },
      secrets: { PLC_SLACK_APP_TOKEN: FAKE_SLACK_APP_TOKEN },
    });
    expect(credential!.signingSecret).toBeUndefined();
    slack.failNext("auth.test", `401 for ${FAKE_SLACK_TOKEN}`);
    expect(await adapter.resolveCredential!({ PLC_SLACK_APP_TOKEN: FAKE_SLACK_APP_TOKEN, PLC_SLACK_USER_TOKEN: FAKE_SLACK_TOKEN }, log)).toBeNull();
    expect(lines.join("\n")).toContain("auth.test failed");
    for (const token of [FAKE_SLACK_TOKEN, FAKE_SLACK_APP_TOKEN]) expect(lines.join("\n")).not.toContain(token);
  });
});
