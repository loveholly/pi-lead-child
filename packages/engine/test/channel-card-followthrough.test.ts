// 卡跟着做完的事结束（用户 2026-10-26）：你用自然语言让 Lead 去做卡上的事以后，卡不应该还等着你点。
//   - 「正在处理」是对对方的一句承诺：回复改写它；工作没有回复就结束了（工单交给你、卡结束），就删掉它。每一拍补收最近 24 小时漏下的。
//   - Lead 代你在一个对话里发了消息：这个对话里在等你的卡由代码结束（已回复），「正在处理」改写成这条消息。
//   - Lead 按你的话在别处做完了卡上的事（handled，或者发消息时带 cardId）：卡结束，在对方的消息上回 ✅，告诉对方收到并照做了。
//   - Lead 代你回表情（react）：缺省回对方最后一条消息。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel、假的派单器。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, getEvent, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "../src/index.js";
import { agentTaskResult, cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let dispatcher: FakeAgentTaskDispatcher;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-card-followthrough-"), "plc.db"));
  clock = new Date("2026-10-26T08:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock,
    users: { U0ETHAN: { name: "王小明" }, U0IVY: { name: "Ivy Lin" }, U0NINA: { name: "Nina Hu" } },
  });
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const messageOf = (state: string) => state.split("\n\n")[0] ?? "";
const jev = (answers: Record<string, string | number | ((state: string) => string | number)> = {}) => scriptedSmartModel({
  answers: {
    ask_kind: (state) => (messageOf(state).includes("review") ? "code_review" : "other"), handling_verb: "checking",
    needs_user_now: 0.05, target_repo: "acme/orders", ...answers,
  },
});

function hub(model: ScriptedSmartModel = jev()): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model,
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
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

const NOTICE = ":robot_face: Paimon (Assistant) is checking…";
const by = "lead for user via turn:turn-1";
const texts = (channel: string) => slack.sent(channel).map((message) => message.text);
// 这张卡最新的消息事件：Lead 的通用工具按它找卡（统一消息事件工单 05）。
const eventOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;

// 一张派了工单、挂着「正在处理」的卡。
async function dispatchedCard(channels: ChannelHub, from = "U0ETHAN", text = "订单重试的上限是多少？") {
  const item = await receive(channels, slack.dm(from, text));
  const dispatched = await channels.leadDispatch(eventOf(item.cardId), { summary: "查订单重试的上限", intent: "knowledge" });
  await channels.idle();
  expect(texts(`D0${from.slice(2)}`)).toEqual([NOTICE]);
  return { ...item, runId: dispatched.runId };
}

describe("the status notice ends with the work", () => {
  it("is deleted when the sub-agent hands the request to you without a reply", async () => {
    const channels = hub();
    const card = await dispatchedCard(channels);
    await dispatcher.finish(card.runId, { status: "failed", result: null, error: "工单没跑完" });
    await channels.idle();
    expect(texts("D0ETHAN")).toEqual([]);
    expect(getChannelCard(db, card.cardId)).toMatchObject({ state: "open" });
  });

  it("stays while a draft waits for you, and is deleted when you dismiss the card", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const card = await dispatchedCard(channels);
    await dispatcher.finish(card.runId, { result: agentTaskResult({ replyDraft: "上限是 5 次。" }) });
    await channels.idle();
    expect(getChannelCard(db, card.cardId)).toMatchObject({ state: "open", draft: { text: "上限是 5 次。" } });
    expect(texts("D0ETHAN")).toEqual([NOTICE]);
    await channels.act(card.cardId, "dismiss", { by: "user" });
    await channels.idle();
    expect(texts("D0ETHAN")).toEqual([]);
  });

  it("is deleted when you answer in Slack yourself", async () => {
    const channels = hub(jev({ fulfills_request: 0.1, answers_request: 0.95 }));
    const card = await dispatchedCard(channels);
    await dispatcher.finish(card.runId, { result: agentTaskResult({ replyDraft: "上限是 5 次。" }) });
    await channels.idle();
    await channels.receive("slack", slack.selfReply("D0ETHAN", "5 次，配置在 retry.ts"));
    await channels.idle();
    expect(getChannelCard(db, card.cardId)).toMatchObject({ state: "resolved_elsewhere" });
    expect(texts("D0ETHAN")).toEqual([]);
  });

  it("is cleaned up on the tick when deleting failed before, but only for notices from the last 24 hours", async () => {
    const channels = hub();
    const old = await dispatchedCard(channels);
    slack.failNext("chat.delete", "network down");
    await channels.act(old.cardId, "dismiss", { by: "user" });
    await channels.idle();
    expect(texts("D0ETHAN")).toEqual([NOTICE]);

    clock = new Date(clock.getTime() + 25 * 60 * 60_000);
    const recent = await dispatchedCard(channels, "U0IVY", "这个接口的超时是多少？");
    slack.failNext("chat.delete", "network down");
    await channels.act(recent.cardId, "dismiss", { by: "user" });
    await channels.idle();
    expect(texts("D0IVY")).toEqual([NOTICE]);

    await channels.tick();
    await channels.idle();
    expect(texts("D0IVY")).toEqual([]);
    // 一天以前的不再碰（有界）。
    expect(texts("D0ETHAN")).toEqual([NOTICE]);
    // 再来一拍什么也不做（幂等）。
    const deletes = slack.calls.filter((call) => call.method === "chat.delete").length;
    await channels.tick();
    await channels.idle();
    expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(deletes);
  });
});

describe("Lead's message in a conversation ends the card that waits there", () => {
  it("closes the card as replied for you and turns the status notice into the message", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const card = await dispatchedCard(channels);
    await dispatcher.finish(card.runId, { result: agentTaskResult({ replyDraft: "上限是 5 次。" }) });
    await channels.idle();
    const sent = await channels.sendMessage("slack:@U0ETHAN", {
      text: "上限 5 次，下周改成可配置", words: "user", forUser: true, by, seenBefore: clock.getTime() + 1,
    });
    expect(sent.card).toEqual({ id: card.cardId, state: "replied" });
    expect(slack.sent("D0ETHAN").map((message) => [message.text, message.edits])).toEqual([["上限 5 次，下周改成可配置", 1]]);
    expect(getChannelCard(db, card.cardId)).toMatchObject({
      state: "replied", sent: { status: "sent", text: "上限 5 次，下周改成可配置" }, resolution: { by, action: "send_message" },
    });
    // 卡的事件跟着处理掉：收件箱和 Lead 的局面里不再等你。
    expect(getEvent(db, card.seq!)).toMatchObject({ disposition: "handled" });
  });

  it("closes a card without a status notice too, and sends a new message", async () => {
    const channels = hub();
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    const sent = await channels.sendMessage("slack:@U0ETHAN", { text: "能来", words: "user", forUser: true, by, seenBefore: clock.getTime() + 1 });
    expect(sent.card).toEqual({ id: item.cardId, state: "replied" });
    expect(texts("D0ETHAN")).toEqual(["能来"]);
    expect(channels.cardDto(getChannelCard(db, item.cardId)!).handling?.lead).toMatchObject({ decision: "closed", by: "lead" });
  });

  it("leaves the card open when its newest message came after your turn started", async () => {
    const channels = hub();
    const turnStarted = clock.getTime();
    clock = new Date(clock.getTime() + 60_000);
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    const sent = await channels.sendMessage("slack:@U0ETHAN", { text: "能来", words: "user", forUser: true, by, seenBefore: turnStarted });
    expect(sent.card).toMatchObject({ id: item.cardId, state: "open", note: expect.stringContaining("之后") });
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
  });
});

describe("handled: Lead did what the card asked somewhere else", () => {
  it("closes the card, puts ✅ on the sender's message, and deletes the status notice", async () => {
    const channels = hub();
    const delivery = slack.dm("U0IVY", "PROJ-34469 让 Nina 改状态");
    const card = await receive(channels, delivery);
    await channels.leadDispatch(eventOf(card.cardId), { summary: "找 PROJ-34469 的负责人", intent: "knowledge" });
    await channels.idle();
    await channels.sendMessage("slack:@U0NINA", { text: "麻烦更新一下 PROJ-34469 的状态", words: "assistant", forUser: true, by });
    await channels.act(card.cardId, "handled", { by, note: "私信 Nina 更新 PROJ-34469" });
    await channels.idle();
    expect(getChannelCard(db, card.cardId)).toMatchObject({
      state: "handled",
      resolution: { by, action: "handled", detail: { note: "私信 Nina 更新 PROJ-34469", reaction: "white_check_mark" } },
    });
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "white_check_mark", users: [slack.credential.account] }]);
    expect(texts("D0IVY")).toEqual([]);
    expect(getEvent(db, card.seq!)).toMatchObject({ disposition: "handled" });
  });

  it("does not react when told not to", async () => {
    const channels = hub();
    const delivery = slack.dm("U0IVY", "PROJ-34469 让 Nina 改状态");
    const card = await receive(channels, delivery);
    await channels.act(card.cardId, "handled", { by, note: "已经在会上说了", react: false });
    expect(getChannelCard(db, card.cardId)).toMatchObject({ state: "handled" });
    expect(slack.messageOf(delivery).reactions ?? []).toEqual([]);
    // 卡结束了，卡上不再写「等 Lead 决定」。
    expect(channels.cardDto(getChannelCard(db, card.cardId)!).handling?.lead).toMatchObject({ decision: "closed", by: "lead" });
  });

  it("closes the card the same way when a message to someone else is sent for it", async () => {
    const channels = hub();
    const delivery = slack.dm("U0IVY", "PROJ-34469 让 Nina 改状态");
    const card = await receive(channels, delivery);
    const sent = await channels.sendMessage("slack:@U0NINA", {
      text: "麻烦更新一下 PROJ-34469 的状态", words: "assistant", forUser: true, by, cardId: card.cardId, seenBefore: clock.getTime() + 1,
    });
    expect(sent.card).toEqual({ id: card.cardId, state: "handled" });
    expect(getChannelCard(db, card.cardId)).toMatchObject({
      state: "handled", resolution: { action: "handled", detail: { note: expect.stringContaining("Nina Hu") } },
    });
    expect(slack.messageOf(delivery).reactions).toEqual([{ name: "white_check_mark", users: [slack.credential.account] }]);
    // 第二条也带着同一张卡：卡已经结束了，照常发，不再回表情。
    const again = await channels.sendMessage("slack:@U0NINA", {
      text: "链接在这里", words: "user", forUser: true, by, cardId: card.cardId, seenBefore: clock.getTime() + 1,
    });
    expect(again.card).toEqual({ id: card.cardId, state: "handled" });
    expect(slack.calls.filter((call) => call.method === "reactions.add")).toHaveLength(1);
  });
});

describe("reacting to a message for you", () => {
  it("reacts to the latest message from the other person, or to the one given", async () => {
    const channels = hub();
    const first = slack.dm("U0ETHAN", "PR 改好了");
    const earlier = await receive(channels, first);
    clock = new Date(clock.getTime() + 60_000);
    const second = slack.dm("U0ETHAN", "那我更新一下修复情况");
    const latest = await receive(channels, second);
    const reacted = await channels.react("slack:@U0ETHAN", { emoji: "white_check_mark", by });
    expect(reacted).toMatchObject({ objectKey: "slack:D0ETHAN:main", seq: latest.seq, emoji: "white_check_mark" });
    expect(slack.messageOf(second).reactions).toEqual([{ name: "white_check_mark", users: [slack.credential.account] }]);
    // 回的是卡上最新的一条：卡跟着结束。
    expect(reacted.card).toEqual({ id: latest.cardId, state: "handled" });
    await channels.react("slack:D0ETHAN:main", { emoji: "+1", seq: earlier.seq!, by });
    expect(slack.messageOf(first).reactions).toEqual([{ name: "+1", users: [slack.credential.account] }]);
  });

  it("takes back a wrong reaction and puts the right one: :ok_hand: becomes ❤️", async () => {
    const channels = hub();
    const ok = slack.dm("U0ETHAN", "ok");
    await receive(channels, ok);
    await channels.react("slack:@U0ETHAN", { emoji: "ok_hand", by });
    expect(slack.messageOf(ok).reactions).toEqual([{ name: "ok_hand", users: [slack.credential.account] }]);
    const removed = await channels.react("slack:@U0ETHAN", { emoji: "ok_hand", remove: true, by });
    expect(removed.card).toBeNull();
    await channels.react("slack:@U0ETHAN", { emoji: "heart", by });
    expect(slack.messageOf(ok).reactions).toEqual([{ name: "heart", users: [slack.credential.account] }]);
    // 撤一个本来就没有的表情是安全的；撤掉以后还能再回同一个。
    await channels.react("slack:@U0ETHAN", { emoji: "ok_hand", remove: true, by });
    await channels.react("slack:@U0ETHAN", { emoji: "ok_hand", by });
    expect(slack.messageOf(ok).reactions?.map((reaction) => reaction.name)).toEqual(["heart", "ok_hand"]);
  });

  it("refuses a bad emoji name, a message from another conversation, and a conversation without messages", async () => {
    const channels = hub();
    const item = await receive(channels, slack.dm("U0ETHAN", "PR 改好了"));
    await expect(channels.react("slack:@U0ETHAN", { emoji: "✅", by })).rejects.toMatchObject({ code: "invalid_action" });
    await expect(channels.react("slack:@U0NINA", { emoji: "+1", seq: item.seq!, by })).rejects.toMatchObject({ code: "not_found" });
    await expect(channels.react("slack:@U0NINA", { emoji: "+1", by })).rejects.toMatchObject({ code: "not_found" });
    expect(slack.calls.filter((call) => call.method === "reactions.add")).toEqual([]);
  });
});

describe("open cards for Lead's self-check", () => {
  it("lists the cards that still wait for you, without the words", async () => {
    const channels = hub();
    const item = await receive(channels, slack.dm("U0IVY", "PROJ-34469 让 Nina 改状态"));
    expect(channels.openCards()).toEqual([{
      id: item.cardId, sender: "Ivy Lin", conversation: expect.any(String), state: "open", since: clock.toISOString(),
    }]);
  });
});
