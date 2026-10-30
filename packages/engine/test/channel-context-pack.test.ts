// 外部消息的上下文包（unified-message-events spec D5，工单 04）：外部消息事件交给 Lead 以前，由代码拼好上下文包，
// Lead 不用先读卡、再读对话。用 10-26 的真实情况回放：
//   1. Ethan 只说「这个 pr 记得再帮我看看」，链接在三天前（10-23）的消息里 → 上下文包里有那个链接，PR 附一行现在的状态；
//   2. 李雷问三个仓库有没有上线，用户 30 分钟内在和 Ivy 的私信里问过同一个仓库 → 上下文包里有这条；
//      两个小时以前、和这件事无关的话不在里面。
// 另外：对话超过上限时，更早的消息换成整理器写的对话摘要；拼的时间到了上限先交给 Lead，标明缺了哪几项；
// 每个上下文包记一条事件，写明多少条、多少字。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel、假的派单器、假的状态查询和便宜模型。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelLane, listEvents, openDb, saveNote, type Db, type EventRecord } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelHubOptions, type SmartModel } from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

const CONTEXT_EVENT = "message.context_packed";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: Db;
let slack: FakeSlack;
let clock: Date;
let dispatcher: FakeAgentTaskDispatcher;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-context-"), "plc.db"));
  clock = new Date("2026-10-23T06:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock,
    users: {
      U0ETHAN: { name: "Ethan" }, U0LILEI: { name: "李雷" }, U0IVY: { name: "Ivy" }, U0ZHANG: { name: "张三" }, U0LUCAS: { name: "Lucas Chen" },
    },
  });
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 时间往后走：hub 的时钟和 Slack 消息的时间戳一起走。
function pass(ms: number): void {
  clock = new Date(clock.getTime() + ms);
  slack.later(ms);
}

// 原话里提到 review、pr 的是要 review，问「上线」的是问进度。
const jev = () => scriptedSmartModel({
  answers: {
    ask_kind: (state) => {
      const words = state.split("\n\n")[0]!.toLowerCase();
      return words.includes("review") || words.includes("pr") ? "code_review" : words.includes("上线") ? "progress" : "other";
    },
    target_repo: "acme/orders",
  },
});

// 假的状态查询：PR 附一行现在的状态，仓库附一行已知的情况。
const statuses: Record<string, string> = {
  "pull_request:acme/orders#112": "开着，等你 review（10-25 更新过）",
  "repo:acme/orders": "本地有 checkout（/work/orders）",
};
const objectStatus = async (object: { kind: string; ref: string }) => statuses[`${object.kind}:${object.ref}`] ?? null;

function hub(options: Partial<ChannelHubOptions> & { contextPack?: Record<string, unknown> } = {}, model: SmartModel = jev()): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000, smartModel: () => model,
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    pullRequestOf: (text) => {
      const match = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/u.exec(text);
      return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null;
    },
    lead: { dispatcher, available: () => true },
    audit: { rate: 0 },
    ...options,
    contextPack: { objectStatus, ...options.contextPack },
  } as ChannelHubOptions);
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const latestMessageEvent = (): EventRecord => messageEvents().at(-1)!;
const contextOf = (event: EventRecord) => event.payload.context as Record<string, any> | null;
const packedEvents = () => listEvents(db, { kind: CONTEXT_EVENT });

async function deliver(channels: ChannelHub, delivery: Parameters<ChannelHub["receive"]>[1]): Promise<void> {
  await channels.receive("slack", delivery);
  await channels.idle();
}

const PR = "https://github.com/acme/orders/pull/112";

describe("Ethan on 10-26: the PR link is three days back (spec D5 item 1, replay 1)", () => {
  it("puts the 10-23 message with the PR link in the context pack, with one line on the PR's status", async () => {
    const channels = hub();
    const first = (await channels.receive("slack", slack.dm("U0ETHAN", `明哥，帮我 review 一下这个 PR：${PR}`))).items[0]!;
    await channels.idle();
    // 10-23 那张卡用户点了「我自己回」（卡结束），又在 Slack 里回了一句。
    const oldCard = cardIdOf(db, first)!;
    await channels.act(oldCard, "reply_myself", { by: "user" });
    await deliver(channels, slack.selfReply("D0ETHAN", "好的，我晚点看"));
    pass(3 * DAY - 4 * HOUR);
    await deliver(channels, slack.dm("U0ETHAN", "明哥，这个 pr 记得再帮我看看"));

    const event = latestMessageEvent();
    expect(event.payload.text).toBe("明哥，这个 pr 记得再帮我看看");
    const context = contextOf(event);
    expect(context).toMatchObject({
      version: 1, external: true, source: "slack", sourceLabel: "Slack",
      sender: { id: "U0ETHAN", name: "Ethan" },
      conversation: {
        key: event.entityKey, label: "Ethan的私信", omitted: 0, summary: null,
        messages: [
          { role: "them", sender: "Ethan", text: `明哥，帮我 review 一下这个 PR：${PR}` },
          { role: "me", text: "好的，我晚点看" },
        ],
      },
      objects: [{ kind: "pull_request", ref: "acme/orders#112", status: "开着，等你 review（10-25 更新过）" }],
      missing: [],
    });
    // 这条消息本身不在自己的上下文包里（它是消息事件的正文）。
    expect(JSON.stringify(context!.conversation.messages)).not.toContain("记得再帮我看看");
    // 这个对话以前的卡（10-23 那张）也在：卡号、发信人、它开头的那条消息、结局。
    expect(context!.history).toEqual([
      expect.objectContaining({ cardId: oldCard, state: "left_to_user", sender: "Ethan", excerpt: expect.stringContaining(PR) }),
    ]);

    // 记一条事件：多少条、多少字，给 token 成本统计用。
    const packed = packedEvents().at(-1)!;
    expect(packed).toMatchObject({
      source: "system", level: "record", entityKey: event.entityKey,
      payload: { messageEvent: event.seq, items: context!.size.items, chars: context!.size.chars, missing: [] },
    });
    expect(context!.size.items).toBeGreaterThanOrEqual(4);
    expect(context!.size.chars).toBeGreaterThan(PR.length);
  });
});

describe("李雷 on 10-26: the answer is in the user's DM with Ivy (spec D5 item 2, replay 2)", () => {
  it("puts the user's message to Ivy from the last 30 minutes about the same repo in the context pack", async () => {
    clock = new Date("2026-10-26T01:00:00.000Z");
    const channels = hub();
    // 两个小时以前，用户在和张三的私信里说了一句和这件事无关的话。
    await deliver(channels, slack.dm("U0ZHANG", "周报发你了"));
    await deliver(channels, slack.selfReply("D0ZHANG", "收到，周会再说"));
    pass(2 * HOUR);
    // Ivy 找用户；用户在和 Ivy 的私信里问 orders 上线了没有。
    await deliver(channels, slack.dm("U0IVY", "今天下午的发布我这边准备好了"));
    const asked = (await channels.receive("slack", slack.selfReply("D0IVY", "orders 今天上线了吗？李雷那边在等"))).items[0]!;
    await channels.idle();
    pass(10 * MINUTE);
    await deliver(channels, slack.dm("U0LILEI", "明哥，orders、billing 和 ledger 三个仓库今天都上线了吗？"));

    const event = latestMessageEvent();
    expect(event.payload.sender).toMatchObject({ name: "李雷" });
    const context = contextOf(event)!;
    expect(context.related).toEqual([
      expect.objectContaining({
        conversation: { key: asked.objectKey, label: "Ivy的私信" }, role: "me", text: "orders 今天上线了吗？李雷那边在等",
        why: expect.arrayContaining(["user_recent", "same_object"]),
      }),
    ]);
    // 两个小时以前、和这件事无关的话不在里面；Ivy 自己的话也不在（不是同一个人，没提到同一个对象）。
    expect(JSON.stringify(context.related)).not.toContain("周会再说");
    expect(JSON.stringify(context.related)).not.toContain("发布我这边准备好了");
    // 提到的仓库附一行状态；没查到的写「没查到」（status 是 null），不阻塞。
    expect(context.objects).toEqual([{ kind: "repo", ref: "acme/orders", status: "本地有 checkout（/work/orders）" }]);
    expect(context.missing).toEqual([]);
  });

  it("finds the user's words from the last 30 minutes in a conversation that has no lane (a channel thread the user replied in)", async () => {
    clock = new Date("2026-10-26T01:00:00.000Z");
    const channels = hub();
    // 张三在频道里发了一条没提到用户的消息（不是订阅频道：不记），用户在它的 thread 里回了一句。
    const root = slack.chatter("U0ZHANG", "今天的发布顺序谁定一下？");
    await deliver(channels, root);
    const reply = (await channels.receive("slack", slack.selfReply("C0PROJ", "orders 今天下午发，ledger 还在等 review", { thread: slack.messageOf(root).ts }))).items[0]!;
    await channels.idle();
    // 用户的话只进了事件日志：这个对话没有道。
    expect(reply).toMatchObject({ inserted: true, delivery: "record" });
    expect(getChannelLane(db, reply.objectKey)).toBeUndefined();
    pass(10 * MINUTE);
    await deliver(channels, slack.dm("U0LILEI", "明哥，orders 今天上线了吗？"));

    const context = contextOf(latestMessageEvent())!;
    expect(context.related).toEqual([
      expect.objectContaining({
        conversation: expect.objectContaining({ key: reply.objectKey }), role: "me", text: "orders 今天下午发，ledger 还在等 review",
        why: expect.arrayContaining(["user_recent"]),
      }),
    ]);
  });
});

describe("limits and the conversation summary (spec D5 item 1)", () => {
  it("replaces the earliest messages with a summary written by the memory curator when the conversation passes 20 messages", async () => {
    const prompts: Array<{ prompt: string; purpose: string }> = [];
    const complete = async (prompt: string, opts: { purpose: string }) => {
      prompts.push({ prompt, purpose: opts.purpose });
      return JSON.stringify({ topic: "orders 的 review", facts: [`Ethan 请用户 review ${PR}`] });
    };
    const channels = hub({ contextPack: { complete: () => complete } });
    await deliver(channels, slack.dm("U0ETHAN", `明哥，帮我 review 一下这个 PR：${PR}`));
    for (let index = 1; index <= 22; index += 1) await deliver(channels, slack.selfReply("D0ETHAN", `第 ${index} 条进展`));
    await deliver(channels, slack.dm("U0ETHAN", "明哥，这个 pr 记得再帮我看看"));

    const context = contextOf(latestMessageEvent())!;
    // 前面一共 23 条：最近的 20 条原样放，最早的 3 条（含带链接的那条）换成对话摘要。
    expect(context.conversation.messages).toHaveLength(20);
    expect(context.conversation.messages[0]).toMatchObject({ role: "me", text: "第 3 条进展" });
    expect(context.conversation.omitted).toBe(3);
    expect(context.conversation.summary).toContain(PR);
    // 摘要用记忆沉淀的同一个整理器（同一个提示和解析），交给它的是被换掉的那 3 条。
    const asked = prompts.filter((entry) => entry.purpose === "message_context");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain("You turn a workplace chat thread into durable facts");
    expect(asked[0]!.prompt).toContain(PR);
    expect(asked[0]!.prompt).toContain("第 2 条进展");
    expect(asked[0]!.prompt).not.toContain("第 3 条进展");
  });

  it("hands the message to Lead when packing hits its time limit, naming the parts that are missing", async () => {
    const channels = hub({ contextPack: { timeoutMs: 50, objectStatus: () => new Promise<never>(() => {}) } });
    await deliver(channels, slack.dm("U0ETHAN", `明哥，帮我 review 一下这个 PR：${PR}`));

    expect(messageEvents()).toHaveLength(1);
    const context = contextOf(latestMessageEvent())!;
    expect(context.objects).toEqual([{ kind: "pull_request", ref: "acme/orders#112", status: null }]);
    expect(context.missing).toEqual(["objects"]);
    expect(packedEvents().at(-1)).toMatchObject({ payload: { messageEvent: latestMessageEvent().seq, missing: ["objects"] } });
  });

  it("still merges an edit that arrives while the pack is being built: one intake, one queued message event with the last words", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked = false;
    const channels = hub({
      contextPack: {
        objectStatus: async (object: { kind: string; ref: string }) => {
          asked = true;
          await held;
          return objectStatus(object);
        },
      },
    });
    const dm = slack.dm("U0ETHAN", `明哥，帮我 review 一下这个 PR：${PR}`);
    await channels.receive("slack", dm);
    await expect.poll(() => asked).toBe(true);
    await channels.receive("slack", slack.edit(dm, `明哥，帮我 review 一下这个 PR：${PR}，今天要合`));
    release();
    await channels.idle();

    expect(listEvents(db, { kind: "channel.intake.decided" })).toHaveLength(1);
    const queued = messageEvents().filter((event) => event.disposition !== "superseded");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.text).toBe(`明哥，帮我 review 一下这个 PR：${PR}，今天要合`);
    expect(contextOf(queued[0]!)).toMatchObject({ external: true });
  });
});

// 工单 11 用真实 Lead 模型回放发现的两个问题（共享笔记 ume-11-replay-acceptance.md 的 B、C）。
describe("the pack follows the last words after an edit (replay finding B, scenario 2)", () => {
  const V1 = "明哥，orders 和 billing 都上线了吗？";
  const V2 = "明哥，orders、billing 和 ledger 都上线了吗？";
  const repos = () => [
    { repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } },
    { repo: "acme/ledger", root: "/work/ledger", github: { owner: "acme", repo: "ledger" } },
  ];
  // 李雷这条消息排着的消息事件（Ivy 的消息也有自己的消息事件，不算）。
  const queued = () => messageEvents()
    .filter((event) => event.disposition !== "superseded" && (event.payload.sender as { name?: string }).name === "李雷");

  it("rebuilds the objects and the related messages from the edit that merges into the queued message event", async () => {
    clock = new Date("2026-10-26T01:00:00.000Z");
    const channels = hub({ lookupCandidates: repos });
    // 两小时以前，用户在和 Ivy 的私信里提过 ledger：只按「提到同一个对象」才和这件事有关。
    await deliver(channels, slack.dm("U0IVY", "今天下午的发布我这边准备好了"));
    await deliver(channels, slack.selfReply("D0IVY", "ledger 要等周四再发"));
    pass(2 * HOUR);
    const dm = slack.dm("U0LILEI", V1);
    await deliver(channels, dm);
    expect(contextOf(queued()[0]!)!.objects.map((object: { ref: string }) => object.ref)).toEqual(["acme/orders"]);
    expect(contextOf(queued()[0]!)!.related).toEqual([]);

    // Lead 还没拿走，李雷补了第三个仓库：编辑并进排着的消息事件。
    await deliver(channels, slack.edit(dm, V2));
    expect(queued()).toHaveLength(1);
    expect(queued()[0]!.payload.text).toBe(V2);
    const context = contextOf(queued()[0]!)!;
    expect(context.objects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "repo", ref: "acme/ledger" })]));
    expect(context.related).toEqual([
      expect.objectContaining({ role: "me", text: "ledger 要等周四再发", why: ["same_object"] }),
    ]);
  });

  it("builds the pack from the edited words when the edit arrives while Jev is still judging the message", async () => {
    clock = new Date("2026-10-26T01:00:00.000Z");
    const model = jev();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: SmartModel = {
      ...model,
      decide: async (state, questions, opts) => {
        if (opts?.purpose === "channel_intake") await gate;
        return model.decide(state, questions, opts);
      },
    };
    const channels = hub({ lookupCandidates: repos }, held);
    const dm = slack.dm("U0LILEI", V1);
    await channels.receive("slack", dm);
    await channels.receive("slack", slack.edit(dm, V2));
    release();
    await channels.idle();

    expect(queued()).toHaveLength(1);
    expect(queued()[0]!.payload.text).toBe(V2);
    expect(contextOf(queued()[0]!)!.objects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "repo", ref: "acme/ledger" })]));
  });
});

describe("notes are recalled by topic and by sender separately (replay finding C, scenario 6)", () => {
  it("recalls a note about the topic that does not name the sender, and asks the semantic recall with the words alone", async () => {
    saveNote(db, { title: "Fairy 是用户的个人助理", content: "fairy 现在可以在 Slack 里用，私信 Fairy 就行", tags: [], kind: "note" });
    saveNote(db, { title: "周报", content: "周报每周五交", tags: [], kind: "note" });
    const queries: string[] = [];
    const channels = hub({ contextPack: { recallNotes: async (query: string) => { queries.push(query); return []; } } });
    await deliver(channels, slack.dm("U0LUCAS", "你那个应用可用吗"));
    await deliver(channels, slack.dm("U0LUCAS", "fairy"));

    const context = contextOf(latestMessageEvent())!;
    expect(context.memory).toEqual([expect.objectContaining({ title: "Fairy 是用户的个人助理" })]);
    // 语义召回（线上是 Hindsight）按话题问：只给原话，不带发信人的名字。
    expect(queries.at(-1)).toBe("fairy");
  });

  it("still finds a note that names the sender", async () => {
    saveNote(db, { title: "Lucas Chen", content: "Lucas Chen 是数据组的，常问 Fairy 的进展", tags: [], kind: "note" });
    const channels = hub();
    await deliver(channels, slack.dm("U0LUCAS", "你那个应用可用吗"));
    expect(contextOf(latestMessageEvent())!.memory).toEqual([expect.objectContaining({ title: "Lucas Chen" })]);
  });
});
