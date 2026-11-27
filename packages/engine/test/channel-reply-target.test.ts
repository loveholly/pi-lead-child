// 回复的落点核对（工单 #589）：同一个私信里主对话一张卡、thread 一张卡，回复回的是 thread 里的 PR，却发往主对话那张卡时，
// 发之前拦下，结果里写明该用哪张卡；发往对的那张时照常发；只有一张卡时不问 SmartModel；SmartModel 问不成时不拦。
// 重放 2026-11-27 的事故，人名、文字和编号都换成了假的：卡 B 先被回了 :eyes: 标成「已处理」，卡 A 还开着。
// 真的 SQLite、真的 hub 和 Slack 来源插件，Slack 和 SmartModel 是假的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { CHANNEL_REPLY_TARGET_PURPOSE, ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

const THREAD = "1760000000.000100";
const MAIN = "slack:D0NINA:main";
const IN_THREAD = `slack:D0NINA:${THREAD}`;
const by = "lead for user via turn:turn-1";

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-reply-target-"), "plc.db"));
  clock = new Date("2026-11-27T10:28:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0NINA: { name: "Nina Hu" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 假的 SmartModel：选原话里有 PR 的那条消息（回复说的是 PR 时），否则选原话里有方案的那条。
const optionWith = (state: string, words: string): string | null => {
  for (const block of state.split("\n\n")) {
    const match = /^(message_\d+) \(/.exec(block);
    if (match && block.includes(words)) return match[1]!;
  }
  return null;
};
function judge(options: { fail?: boolean } = {}): ScriptedSmartModel {
  return scriptedSmartModel({
    answers: {
      ask_kind: (state) => ((state.split("\n\n")[0] ?? "").includes("PR") ? "code_review" : "other"),
      answered_message: (state) => {
        const reply = state.split("The reply the assistant is about to send:\n")[1] ?? "";
        const picked = optionWith(state, reply.includes("approve") ? "PR" : "方案");
        return picked ? { [picked]: 0.9, none: 0.1 } : "none";
      },
    },
    ...(options.fail ? { failPurposes: [CHANNEL_REPLY_TARGET_PURPOSE] } : {}),
  });
}

function hub(model: ScriptedSmartModel): ChannelHub {
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000, smartModel: () => model,
    lead: { dispatcher, available: () => true },
    audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

async function receive(channels: ChannelHub, delivery: ReturnType<FakeSlack["dm"]>) {
  const item = (await channels.receive("slack", delivery)).items[0]!;
  await channels.idle();
  return { ...item, cardId: cardIdOf(db, item)! };
}

// 私信 thread 里一张卡（PR 改好了），主对话里一张卡（对方案的评论）。
async function twoCards(channels: ChannelHub) {
  const pr = await receive(channels, slack.dm("U0NINA", "PR 按照意见调整了，可以再看看 https://github.com/acme/x/pull/12", { thread: THREAD }));
  clock = new Date("2026-11-27T10:28:30.000Z");
  const remark = await receive(channels, slack.dm("U0NINA", "团队自己的事也交给公共的大 agent 做，这个方案感觉有点怪"));
  return { pr, remark };
}

const textsTo = (channel: string) => slack.sent(channel).filter((message) => message.text).map((message) => [message.text, message.thread_ts]);

describe("checking where a reply lands when one conversation has several unfinished cards", () => {
  it("refuses a reply about the PR that is aimed at the main-conversation card, and names the thread card to use", async () => {
    const model = judge();
    const channels = hub(model);
    const { pr, remark } = await twoCards(channels);
    expect([pr.objectKey, remark.objectKey]).toEqual([IN_THREAD, MAIN]);
    const before = textsTo("D0NINA");

    const refused = channels.sendMessage(MAIN, { text: "#12 approve 了，上线前确认下时区", words: "assistant", forUser: true, by });
    await expect(refused).rejects.toMatchObject({ code: "conflict" });
    const message = await refused.catch((error: Error) => error.message);
    expect(message).toContain(`这段话更像在回卡 #${pr.cardId}，不是你发往的卡 #${remark.cardId}`);
    expect(message).toContain(`卡 #${remark.cardId}：Nina Hu 2026-11-27T10:28:30.000Z 在主对话里的消息`);
    expect(message).toContain("回复挂在主对话里对方那条消息下面");
    expect(message).toContain(`卡 #${pr.cardId}：Nina Hu 2026-11-27T10:28:00.000Z 在 thread 里的消息`);
    expect(message).toContain("在 thread 里的消息（意图：代码 review）");
    expect(message).toContain("回复进这个 thread");
    const event = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((record) => record.payload.cardId === pr.cardId).at(-1)!.seq;
    expect(message).toContain(`reply_to_source（event=${event}，conversation=${IN_THREAD}）`);
    expect(message).toContain("confirm_target=true");
    // 工具结果不放对方的原话（发消息的工具不算外部内容）。
    expect(message).not.toContain("方案感觉有点怪");
    expect(message).not.toContain("按照意见调整了");
    // 什么都没发，两张卡都没动。
    expect(textsTo("D0NINA")).toEqual(before);
    expect(getChannelCard(db, remark.cardId)!.state).toBe("open");
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(1);
    // SmartModel 看到的是两条消息的原话和要发的话，按时间排。
    const state = model.calls.find((call) => call.purpose === CHANNEL_REPLY_TARGET_PURPOSE)!.state;
    expect(state).toMatch(/^message_1 \(Nina Hu, in a thread, at 2026-11-27T10:28:00\.000Z; untrusted text\):\nPR 按照意见调整了/);
    expect(state).toContain("message_2 (Nina Hu, in the main conversation");
  });

  it("sends the same words when they go to the thread card, into that thread", async () => {
    const model = judge();
    const channels = hub(model);
    const { pr } = await twoCards(channels);
    const sent = await channels.sendMessage(IN_THREAD, { text: "#12 approve 了，上线前确认下时区", words: "assistant", forUser: true, by });
    expect(sent).toMatchObject({ objectKey: IN_THREAD, outcome: "sent", card: { id: pr.cardId, state: "replied" } });
    expect(textsTo("D0NINA").at(-1)).toEqual([expect.stringContaining("#12 approve 了"), THREAD]);
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(1);
  });

  it("sends a reply about the remark to the main-conversation card", async () => {
    const model = judge();
    const channels = hub(model);
    const { remark } = await twoCards(channels);
    const sent = await channels.sendMessage(MAIN, { text: "这个方案我们下周一起聊聊", words: "assistant", forUser: true, by });
    expect(sent).toMatchObject({ objectKey: MAIN, card: { id: remark.cardId, state: "replied" } });
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(1);
  });

  // 2026-11-27 的现场：thread 那张卡先被回了 :eyes:、标成已处理，主对话那张还开着。对方还在等 PR 的回复，照样核对。
  it("still counts a card that was closed with only a reaction a moment ago", async () => {
    const model = judge();
    const channels = hub(model);
    const { pr, remark } = await twoCards(channels);
    await channels.act(pr.cardId, "handled", { by: "lead", emoji: "eyes", note: "回了表情 :eyes:" });
    expect(getChannelCard(db, pr.cardId)!.state).toBe("handled");
    await expect(channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: true, by })).rejects.toMatchObject({
      code: "conflict", message: expect.stringContaining(`更像在回卡 #${pr.cardId}`),
    });
    expect(getChannelCard(db, remark.cardId)!.state).toBe("open");
    // 过了两个小时，只回了表情的卡不再算没结束：只剩一张卡，不问。
    clock = new Date("2026-11-27T12:40:00.000Z");
    await channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: true, by });
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(1);
  });

  it("sends after the caller confirms the target, without asking again", async () => {
    const model = judge();
    const channels = hub(model);
    const { remark } = await twoCards(channels);
    const sent = await channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: true, by, targetChecked: true });
    expect(sent).toMatchObject({ objectKey: MAIN, card: { id: remark.cardId, state: "replied" } });
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(0);
  });

  it("does not ask when the conversation has only one card", async () => {
    const model = judge();
    const channels = hub(model);
    const remark = await receive(channels, slack.dm("U0NINA", "团队自己的事也交给公共的大 agent 做，这个方案感觉有点怪"));
    const sent = await channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: true, by });
    expect(sent).toMatchObject({ card: { id: remark.cardId, state: "replied" } });
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(0);
  });

  it("sends when the check cannot be answered", async () => {
    const model = judge({ fail: true });
    const channels = hub(model);
    const { remark } = await twoCards(channels);
    const sent = await channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: true, by });
    expect(sent).toMatchObject({ card: { id: remark.cardId, state: "replied" } });
    expect(model.count(CHANNEL_REPLY_TARGET_PURPOSE)).toBe(1);
  });

  // reply_to_source 带着消息事件发（主会话和 shadow 都用它）：事件和对话对得上，照样核对落点。
  it("checks a reply to a message event of the wrong card", async () => {
    const channels = hub(judge());
    const { pr, remark } = await twoCards(channels);
    const event = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((record) => record.payload.cardId === remark.cardId).at(-1)!.seq;
    await expect(channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: false, by: "lead", event }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining(`更像在回卡 #${pr.cardId}`) });
  });

  // Lead 自己的回复（不在用户这一轮里，主会话和 shadow 都走这里）同样核对。
  it("checks Lead's own reply outside the user's turn too", async () => {
    const channels = hub(judge());
    const { pr } = await twoCards(channels);
    await expect(channels.sendMessage(MAIN, { text: "#12 approve 了", words: "assistant", forUser: false, by: "lead" })).rejects.toMatchObject({
      code: "conflict", message: expect.stringContaining(`更像在回卡 #${pr.cardId}`),
    });
  });
});

describe("telling Lead where each card's reply lands", () => {
  it("lists the other unfinished cards of the conversation on a message event, with where they are and the last words", async () => {
    const channels = hub(judge());
    const { pr, remark } = await twoCards(channels);
    const payloadOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((record) => record.payload.cardId === cardId).at(-1)!.payload;
    expect(payloadOf(pr.cardId)).toMatchObject({ thread: true });
    expect(payloadOf(pr.cardId).siblings).toBeUndefined();
    const prEvent = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((record) => record.payload.cardId === pr.cardId).at(-1)!.seq;
    expect(payloadOf(remark.cardId)).toMatchObject({
      thread: false,
      siblings: [{
        cardId: pr.cardId, conversation: IN_THREAD, thread: true, sender: "Nina Hu", at: "2026-11-27T10:28:00.000Z", messageEvent: prEvent,
        text: expect.stringContaining("PR 按照意见调整了"),
      }],
    });
  });

  it("says in the open cards where each reply lands and which conversation to use", async () => {
    const channels = hub(judge());
    const { pr, remark } = await twoCards(channels);
    expect(channels.openCards()).toEqual([
      expect.objectContaining({ id: pr.cardId, conversationKey: IN_THREAD, lands: "回复进这个 thread" }),
      expect.objectContaining({ id: remark.cardId, conversationKey: MAIN, lands: "回复挂在主对话里对方那条消息下面" }),
    ]);
  });
});
