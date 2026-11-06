// 工单 #286 的回放：代用户回复时，把另一个对话的内容发到了这个对话（串话，隐私问题）。人、话和编号都换成了替身。
//   - 17:00 张三（做安全的同事）在私信里问用户电脑安全扫描的事；17:05 用户在这个私信里回了一句，提到担心摄像头和麦克风（X）。
//   - 17:16 用户在和 Ethan 的私信里问一个库有没有发到公司仓库。这个私信以前没有道，用户的话不记（hub 只在道已经存在时记）。
//   - 17:17 Ethan 回「啥意思」。Lead 被这条消息叫醒，代用户回复。
// 以前：上下文包的「别的对话里的相关消息」放进了用户 30 分钟内在别的对话里说的所有话，这个对话又没有前文，
// Lead 把 X 当成了 Ethan 在问的事，代用户回了「刚刚和安全同事聊到电脑安全扫描……」。
// 这里：假 Slack、真的通道 hub、真的上下文包、真的交给 Lead 的文字、真的 reply_to_source，发送接到 hub 的出站层。
// 假 Lead 照这次出事的样子做：对方的话有歧义时，拿它在输入里看到的用户最近说的话去解释。断言 Ethan 收到的回复不提 X。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelMessageService } from "@pi-lead-child/engine";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db, type EventRecord } from "@pi-lead-child/store";
import { leadContextPackBlocks, leadMessageEventBlock } from "../src/envelope.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const MINUTE = 60_000;
// X：用户和张三聊的事。Ethan 的对话里不能出现。
const X = "摄像头和麦克风";
const SECURITY_CHAT = `跑完了。刚刚聊到电脑安全扫描，随口担心了一下${X}`;

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  const dir = tempDir("plc-cross-conversation-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  clock = new Date("2026-11-06T09:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ZHANG: { name: "张三" }, U0ETHAN: { name: "Ethan" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

function pass(ms: number): void {
  clock = new Date(clock.getTime() + ms);
  slack.later(ms);
}

function hub(): ChannelHub {
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000,
    smartModel: () => scriptedSmartModel({ answers: { ask_kind: "other", needs_reply: 0.9 } }),
    lead: { dispatcher, available: () => true }, audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

async function deliver(channels: ChannelHub, delivery: Parameters<ChannelHub["receive"]>[1]) {
  const item = (await channels.receive("slack", delivery)).items[0]!;
  await channels.idle();
  return item;
}

// 一张卡最新的消息事件。
function messageEventOf(cardId: number): EventRecord {
  return listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!;
}

// 交给 Lead 的文字：和 daemon 交给 Lead 的一样（lead-input.ts 的 leadMessageEventBlock）。
const leadInputFor = (event: EventRecord) => leadMessageEventBlock(event);

// Lead 的工具：reply_to_source 的发送接到真的 hub（出站层），其余照真的建。
function tools(channels: ChannelHub, sends: Array<{ conversation: string; text: string }>) {
  const channelMessages: ChannelMessageService = {
    canSend: () => true,
    send: async (conversation, input) => {
      sends.push({ conversation, text: input.text });
      return channels.sendMessage(conversation, input);
    },
    react: async () => { throw new Error("不该回表情"); },
    openCards: () => [],
  } as ChannelMessageService;
  const deps: LeadDeps = {
    db, dbPath: join(process.env.PLC_DATA_DIR!, "plc.db"), dataDir: process.env.PLC_DATA_DIR!, currentTurnId: () => null,
    uiActionServices: { channelMessages },
  } as LeadDeps;
  const all = createLeadTools(deps) as any[];
  return (name: string) => all.find((tool) => tool.name === name);
}

// 假 Lead，照这次出事的样子：对方的话很短、有歧义时，从输入里找用户本人最近说的一句当作对方在问的事，代用户解释它；
// 找不到时不猜，只问对方。reply_to_source 的 event 和 conversation 照消息事件上写的抄。
async function confusedLead(input: string, reply: any): Promise<string> {
  const event = Number(/消息事件 #(\d+)/u.exec(input)![1]);
  const conversation = new RegExp(`reply_to_source（event=${event}，conversation=([^）]+)）`, "u").exec(input)?.[1] ?? "";
  const ownWords = [...input.matchAll(/（用户本人[^）]*）：(.+)/gu)].map((match) => match[1]!.trim()).at(-1);
  const text = ownWords ? `哈哈没啥事，${ownWords.replace(/^跑完了。/u, "")}。` : "你是问我前面那条吗？我再说清楚一点。";
  await reply.execute("call", { event, conversation, text, reason: "对方问啥意思" });
  return text;
}

describe("#286: a reply for the user never carries another conversation's content", () => {
  async function replay() {
    const channels = hub();
    // 17:00 张三找用户；17:05 用户在张三的私信里聊了安全扫描（这个私信有道：张三先发的）。
    const zhang = await deliver(channels, slack.dm("U0ZHANG", "今天的电脑安全扫描你那边跑完了吗？"));
    pass(5 * MINUTE);
    await deliver(channels, slack.selfReply("D0ZHANG", SECURITY_CHAT));
    // 17:16 用户在 Ethan 的私信里问库的事：这个私信还没有道，这句话没有记下。
    pass(11 * MINUTE);
    const asked = await deliver(channels, slack.selfReply("D0ETHAN", "acme/map-lib 这个库发到公司仓库了吗？"));
    expect(asked).toMatchObject({ ignored: "no_lane" });
    // 17:17 Ethan 回「啥意思」。
    pass(MINUTE);
    const ethan = await deliver(channels, slack.dm("U0ETHAN", "啥意思"));
    const ethanCard = cardIdOf(db, ethan)!;
    return { channels, zhangCard: cardIdOf(db, zhang)!, ethanCard, ethanEvent: messageEventOf(ethanCard) };
  }

  it("keeps the user's words from another conversation out of what Lead reads for 「啥意思」, so the reply cannot quote them", async () => {
    const { channels, ethanCard, ethanEvent } = await replay();

    // 上下文包：用户和张三聊的话只是时间近，没提到同一个对象、也没提到 Ethan，不放进来。
    const context = ethanEvent.payload.context as Record<string, any>;
    expect(JSON.stringify(context.related)).not.toContain(X);
    const input = leadInputFor(ethanEvent);
    expect(input).not.toContain(X);
    // 这个对话没有前文：交给 Lead 的文字让它先读这个对话，看不出就不猜。
    expect(input).toContain("这个对话里没有记下前文");
    expect(input).toContain("read_channel_conversation");

    // 假 Lead 照出事的样子回复：Ethan 收到的回复不提 X。
    const sends: Array<{ conversation: string; text: string }> = [];
    const replied = await confusedLead(input, tools(channels, sends)("reply_to_source"));
    expect(replied).not.toContain(X);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).not.toContain(X);
    const card = getChannelCard(db, ethanCard)!;
    expect(JSON.stringify([card.sent, card.draft])).not.toContain(X);
    expect(slack.sent("D0ETHAN").map((message) => message.text).join("\n")).not.toContain(X);
  });

  it("still brings the user's recent words from another conversation when they name the sender, and marks them as another conversation", async () => {
    const channels = hub();
    await deliver(channels, slack.dm("U0ZHANG", "map-lib 的权限你那边开了吗？"));
    pass(MINUTE);
    await deliver(channels, slack.selfReply("D0ZHANG", "开了，Ethan 那边下午会用"));
    pass(MINUTE);
    const ethan = await deliver(channels, slack.dm("U0ETHAN", "啥意思"));
    const event = messageEventOf(cardIdOf(db, ethan)!);
    const context = event.payload.context as Record<string, any>;
    expect(context.related).toEqual([expect.objectContaining({ text: "开了，Ethan 那边下午会用", why: ["user_recent"] })]);

    // 交给 Lead 时写明这是别的对话，不能拿来回复这条消息。
    const input = [leadInputFor(event), ...leadContextPackBlocks(context)].join("\n");
    expect(input).toContain('scope="other_conversation"');
    expect(input).toContain("不是这条消息所在的对话");
    expect(input).toContain("不要在回复里提别的对话里的事");
  });

  it("refuses a reply whose event and conversation do not match: the words written for one conversation never reach the other", async () => {
    const { channels, zhangCard, ethanCard, ethanEvent } = await replay();
    // 同一轮里张三又问了一句：两条消息事件一起交给 Lead。
    pass(MINUTE);
    await deliver(channels, slack.dm("U0ZHANG", "那摄像头的事要不要我帮你查一下？"));
    const zhangEvent = messageEventOf(zhangCard);
    const zhangKey = (zhangEvent.payload.conversation as { key: string }).key;
    const ethanKey = (ethanEvent.payload.conversation as { key: string }).key;
    expect(zhangKey).not.toBe(ethanKey);
    expect(leadInputFor(ethanEvent)).toContain(`conversation=${ethanKey}`);

    const sends: Array<{ conversation: string; text: string }> = [];
    const reply = tools(channels, sends)("reply_to_source");
    // Lead 给张三写的话，填了 Ethan 那条消息的 event：对不上，不发。
    await expect(reply.execute("call", { event: ethanEvent.seq, conversation: zhangKey, text: `不用了，${X}的事我自己看。` }))
      .rejects.toThrow(/对不上/u);
    // 没填对话也不发。
    await expect(reply.execute("call", { event: ethanEvent.seq, text: `不用了，${X}的事我自己看。` })).rejects.toThrow(/对不上/u);
    expect(sends).toEqual([]);
    expect(slack.sent("D0ETHAN")).toEqual([]);

    // 出站层也核对：直接拿 Ethan 的对话和张三那条消息的 event 发，被拒绝。
    await expect(channels.sendMessage(ethanKey, {
      text: `不用了，${X}的事我自己看。`, words: "assistant", by: "lead", forUser: false, event: zhangEvent.seq,
    })).rejects.toThrow(/不在/u);
    expect(slack.sent("D0ETHAN")).toEqual([]);
    expect(JSON.stringify(getChannelCard(db, ethanCard))).not.toContain(X);

    // 对得上的照常发：给张三的话回到张三那里。
    await reply.execute("call", { event: zhangEvent.seq, conversation: zhangKey, text: `不用了，${X}的事我自己看。` });
    expect(sends).toEqual([{ conversation: zhangKey, text: `不用了，${X}的事我自己看。` }]);
  });
});
