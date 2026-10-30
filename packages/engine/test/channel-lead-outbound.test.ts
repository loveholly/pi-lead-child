// 外部通道的出站扩展（统一消息事件 spec D8、D9、D11，工单 05）的决策边界：
//   - Lead 在事件轮里回复来源（不是用户本人的一轮）：Lead 自己判断，直接代发，带 auto-reply 署名，留撤回窗口，卡结束。
//     不问请求 B，不打分，不变成卡上的草稿（用户 2026-10-29：「我期望它就能自己做判断」）。
//   - 用户本人这一轮明确要发的：带 confirmed by 署名，卡结束。
//   - Lead 用哪个工具发都一样：卡上的「改一下再发」在事件轮里也直接发。
//   - Lead 在事件轮里发给别人的话（不是回复来源）：不冒充用户确认过，署名写 auto-reply。
//   - 状态消息「正在处理」只在 Lead 派活时发；系统不派活（工单 06 删了兜底）。
//   - Lead 用通用工具关掉的请求（判断不用回），以后也没有系统的动作。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel（假 Jev）、假的派单器。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelHubOptions } from "../src/index.js";
import { agentTaskResult, cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let pushes: Array<{ cardId: number; title: string; body: string }>;
let dispatcher: FakeAgentTaskDispatcher;
let leadUp: boolean;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-lead-outbound-"), "plc.db"));
  clock = new Date("2026-10-26T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0IVYLIN: { name: "Ivy Lin" }, U0NINA: { name: "Nina Hu" }, U0ETHAN: { name: "Ethan" } } });
  pushes = [];
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
  leadUp = true;
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const messageOf = (state: string) => state.split("\n\n")[0] ?? "";
const jev = (answers: Record<string, string | number | ((state: string) => string | number)> = {}) => scriptedSmartModel({
  answers: { ask_kind: (state) => (messageOf(state).includes("上线") ? "progress" : "other"), target_repo: "acme/orders", ...answers },
});

function hub(model: ScriptedSmartModel, options: Partial<ChannelHubOptions> = {}): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: (notice) => pushes.push(notice), classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model,
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    lead: { dispatcher, available: () => leadUp },
    audit: { rate: 0 },
    ...options,
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

const messageEventOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
const decisionsOf = (cardId: number) => listEvents(db, { kind: "channel.lead.decided" })
  .filter((event) => event.payload.cardId === cardId).map((event) => event.payload);
const sentTexts = (channel: string) => slack.sent(channel).map((message) => message.text);
const AUTO = ":robot_face: Paimon (Assistant) · auto-reply for ";
const CONFIRMED = ":robot_face: Paimon (Assistant) · confirmed by ";

describe("the external channel's outbound extension for Lead's replies", () => {
  it("sends Lead's reply from an event turn at once, with the auto-reply byline and a revoke window, without the reply check", async () => {
    const model = jev();
    const channels = hub(model);
    const ivy = await receive(channels, slack.dm("U0IVYLIN", "按照下面映射关系，发相应的 slack 消息"));
    const before = model.count("channel_reply_check");
    const sent = await channels.sendMessage(getChannelCard(db, ivy.cardId)!.objectKey, {
      text: "已经分别发给 Nina 和 Lucas 了。", words: "assistant", by: "lead", forUser: false,
    });
    expect(sent).toMatchObject({ outcome: "auto_sent", card: { id: ivy.cardId, state: "auto_replied" } });
    expect(sentTexts("D0IVYLIN")).toEqual([expect.stringMatching(/^:robot_face: Paimon \(Assistant\) · auto-reply for .+\n已经分别发给 Nina 和 Lucas 了。$/u)]);
    expect(getChannelCard(db, ivy.cardId)!.revokeUntil).not.toBeNull();
    // Lead 自己判断：不问请求 B，不打分。
    expect(model.count("channel_reply_check")).toBe(before);
    expect(listEvents(db, { kind: "channel.reply.scored" })).toEqual([]);
    expect(decisionsOf(ivy.cardId)).toMatchObject([{ decision: "answer", by: "lead" }]);
  });

  // 回归（用户 2026-10-29）：请求 B 说草稿没做到对方要的，以前 Lead 的回复变成卡上的草稿，什么也不发，要用户点。
  it("still sends Lead's reply when the reply check would have scored it low: no draft is left for the user", async () => {
    const channels = hub(jev({ fulfills_request: 0.1, draft_commits: 0.8 }));
    const ivy = await receive(channels, slack.dm("U0IVYLIN", "按照下面映射关系，发相应的 slack 消息"));
    const sent = await channels.sendMessage(getChannelCard(db, ivy.cardId)!.objectKey, {
      text: "已经分别发给 Nina 和 Lucas 了。", words: "assistant", by: "lead", forUser: false,
    });
    expect(sent).toMatchObject({ outcome: "auto_sent", card: { id: ivy.cardId, state: "auto_replied" } });
    expect(sentTexts("D0IVYLIN")).toEqual([expect.stringMatching(/\n已经分别发给 Nina 和 Lucas 了。$/u)]);
    expect(pushes).toEqual([]);
  });

  it("sends what the user asked for in the user's own turn without the confidence check, with the confirmed-by byline", async () => {
    const model = jev({ fulfills_request: 0.1 });
    const channels = hub(model);
    const ivy = await receive(channels, slack.dm("U0IVYLIN", "按照下面映射关系，发相应的 slack 消息"));
    const before = model.count("channel_reply_check");
    const sent = await channels.sendMessage(getChannelCard(db, ivy.cardId)!.objectKey, {
      text: "好的，我这就发。", words: "assistant", by: "lead for user via turn:t1", forUser: true,
    });
    expect(sent).toMatchObject({ outcome: "sent", card: { id: ivy.cardId, state: "replied" } });
    expect(sentTexts("D0IVYLIN")).toEqual([expect.stringMatching(/^:robot_face: Paimon \(Assistant\) · confirmed by .+\n好的，我这就发。$/u)]);
    expect(model.count("channel_reply_check")).toBe(before);
  });

  it("sends the card's 「改一下再发」 the same way when Lead uses it in an event turn: the tool does not matter", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const ivy = await receive(channels, slack.dm("U0IVYLIN", "按照下面映射关系，发相应的 slack 消息"));
    const card = await channels.act(ivy.cardId, "send_edited", { by: "lead", forUser: false, text: "发了。" });
    expect(card).toMatchObject({ state: "auto_replied" });
    expect(sentTexts("D0IVYLIN")).toEqual([expect.stringMatching(/^:robot_face: Paimon \(Assistant\) · auto-reply for .+\n发了。$/u)]);
  });

  it("signs what Lead sends to someone else in an event turn as an auto-reply, not as confirmed by the user", async () => {
    const channels = hub(jev());
    slack.scopes.push("im:write");
    const sent = await channels.sendMessage("slack:@U0NINA", { text: "PROJ-34469 麻烦改成已修复。", words: "assistant", by: "lead", forUser: false });
    expect(sent).toMatchObject({ outcome: "sent" });
    const [text] = sentTexts("D0NINA");
    expect(text!.startsWith(AUTO)).toBe(true);
    expect(text).not.toContain(CONFIRMED);
  });
});

describe("the status notice and the request follow Lead's own actions", () => {
  it("posts 「正在处理」 when Lead dispatches, and the system never dispatches or says it when Lead cannot work", async () => {
    const channels = hub(jev());
    const yi = await receive(channels, slack.dm("U0ETHAN", "orders 今天上线了吗？"));
    await channels.leadDispatch(messageEventOf(yi.cardId), { summary: "查 orders 今天有没有上线", intent: "progress" });
    await channels.idle();
    expect(sentTexts("D0ETHAN").join("\n")).toMatch(/ is (checking|looking into this|investigating|working on this)…/u);
    expect(decisionsOf(yi.cardId)).toMatchObject([{ decision: "dispatch", by: "lead" }]);

    // Lead 不能工作：系统不派工单，也不在来源里说「正在处理」（工单 06）。
    leadUp = false;
    const before = sentTexts("D0NINA").length;
    const other = await receive(channels, slack.dm("U0NINA", "billing 今天上线了吗？"));
    await channels.tick();
    await channels.idle();
    expect(decisionsOf(other.cardId)).toEqual([]);
    expect(sentTexts("D0NINA")).toHaveLength(before);
  });

  it("ends the card and closes the request when Lead judges no reply is needed, and nothing happens later", async () => {
    const channels = hub(jev());
    const yi = await receive(channels, slack.dm("U0ETHAN", "那我更新一下修复情况"));
    const card = await channels.leadDisposed(messageEventOf(yi.cardId), { disposition: "no_action", reason: "只是说一声" });
    expect(card).toMatchObject({ cardId: yi.cardId, state: "handled" });
    clock = new Date(clock.getTime() + 10 * 60_000);
    await channels.tick();
    await channels.idle();
    expect(decisionsOf(yi.cardId)).toMatchObject([{ decision: "no_reply", by: "lead" }]);
    expect(pushes).toEqual([]);
    expect(slack.sent()).toEqual([]);
  });
});

// 工单 11 用真实 Lead 模型回放发现（场景 1、2，派了活的 3 次全部出现）：Lead 派完活接着 record_disposition(handled)，卡马上结束、
// 对方的消息上回了 ✅；子 agent 交回以后 notify_user 被拒（卡已经结束），用户收不到推送和草稿。
// 卡在子 agent 交回以前一直开着：Lead 自己的处置只记下来，不结束卡、不回表情；交回以后照常走出站检验。
describe("a card with a dispatched sub-agent waits for its result", () => {
  async function dispatched(channels: ChannelHub, text = "orders 今天上线了吗？") {
    const item = await receive(channels, slack.dm("U0ETHAN", text));
    const event = messageEventOf(item.cardId);
    const task = await channels.leadDispatch(event, { summary: "查 orders 今天有没有上线", intent: "progress" });
    await channels.idle();
    return { ...item, event, runId: task.runId };
  }
  const reactions = () => slack.calls.filter((call) => call.method === "reactions.add");

  it("only records Lead's handled or no-reply after the dispatch: the card stays open, nothing is reacted to", async () => {
    const channels = hub(jev());
    const item = await dispatched(channels);
    const handled = await channels.leadDisposed(item.event, { disposition: "handled", reason: "已经派了子 agent 去查" });
    expect(handled).toMatchObject({ cardId: item.cardId, state: "open", note: expect.stringContaining("派了活") });
    const quiet = await channels.leadDisposed(item.event, { disposition: "no_action", reason: "等结果" });
    expect(quiet).toMatchObject({ cardId: item.cardId, state: "open", note: expect.stringContaining("派了活") });
    await channels.idle();
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
    expect(reactions()).toEqual([]);
    // Lead 的处置记在消息事件上。
    expect(listEvents(db, { kind: MESSAGE_EVENT_KIND }).find((event) => event.seq === item.event)).toMatchObject({ disposition: "no_action" });
  });

  it("keeps Lead's own reply and reaction from ending the card before the result is back", async () => {
    const channels = hub(jev());
    const item = await dispatched(channels);
    const objectKey = getChannelCard(db, item.cardId)!.objectKey;
    await expect(channels.sendMessage(objectKey, { text: "在查了。", words: "assistant", by: "lead", forUser: false, event: item.event }))
      .rejects.toMatchObject({ code: "conflict" });
    const reacted = await channels.react(objectKey, { emoji: "eyes", by: "lead" });
    expect(reacted.card).toMatchObject({ id: item.cardId, state: "open", note: expect.stringContaining("派了活") });
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
  });

  it("goes through the outbound check when the result comes back: a weak result is handed back and Lead's draft is pushed", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const item = await dispatched(channels);
    await channels.leadDisposed(item.event, { disposition: "handled", reason: "已经派了子 agent 去查" });
    await dispatcher.finish(item.runId, { result: agentTaskResult({ replyDraft: "orders 今天已经上线了。" }) });
    await channels.idle();
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
    expect(listEvents(db, { kind: "channel.task.finished" })).toMatchObject([{ level: "tell", payload: { handedBack: true, messageEvent: item.event } }]);
    channels.leadNotify(item.event, { note: "李雷问 orders 上线没有：查到已经上线", draft: "orders 今天已经上线了，有问题再找我。" });
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: { drafter: "lead", text: "orders 今天已经上线了，有问题再找我。" } });
    expect(pushes.map((push) => push.cardId)).toEqual([item.cardId]);
    expect(reactions()).toEqual([]);
  });

  it("lets the card end with Lead's handled once the result is back", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const item = await dispatched(channels);
    await dispatcher.finish(item.runId, { result: agentTaskResult({ replyDraft: "orders 今天已经上线了。" }) });
    await channels.idle();
    const done = await channels.leadDisposed(item.event, { disposition: "handled", reason: "在会话里告诉用户了，他说自己回" });
    expect(done).toMatchObject({ cardId: item.cardId, state: "handled" });
  });
});
