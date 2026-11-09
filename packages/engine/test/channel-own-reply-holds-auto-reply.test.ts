// 回归：用户本人在同一个对话里亲手回过以后，助手又自动回复了一条，内容和用户说的重复。
// 以前只有 SmartModel 判断「回答了」时卡才结束；判断失败（例如决策模型返回 403）、判断为「只是收到」，或者判断时对方又说了
// 一句（「好的」），卡都还开着，排着的自动回复照常发出去。现在发之前只看事件日志里的事实：这条自动回复排上以后用户亲手说过话，
// 就不发，结果只放到卡上。SmartModel 只决定卡是「别处已处理」还是留着。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel、假的派单器。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type SmartModel } from "../src/index.js";
import { agentTaskResult, cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let dispatcher: FakeAgentTaskDispatcher;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-own-reply-"), "plc.db"));
  clock = new Date("2026-11-09T02:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ETHAN: { name: "王小明" } } });
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 用户自己那句话的判断：问不成（决策模型 403）、只是收到、已回答。
type Judge = "fails" | "acknowledges" | "answers";
const JUDGES: Judge[] = ["fails", "acknowledges", "answers"];

const messageOf = (state: string) => state.split("\n\n")[0] ?? "";

// 判断用户那句话的那一问先拦住，release 以后才回答：模拟判断还没回来时对方又说了一句。
function gatedModel(judge: Judge): { model: SmartModel; release: () => void } {
  const scripted = scriptedSmartModel({
    answers: {
      ask_kind: (state) => (messageOf(state).includes("review") ? "code_review" : "other"), handling_verb: "reviewing",
      target_repo: "acme/orders", answers_request: judge === "answers" ? 0.95 : 0.1,
    },
    failPurposes: judge === "fails" ? ["channel_self_reply"] : [],
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release: () => release(),
    model: {
      backend: scripted.backend,
      async decide(state, questions, options) {
        if (options?.purpose === "channel_self_reply") await gate;
        return scripted.decide(state, questions, options);
      },
    },
  };
}

function hub(smart: SmartModel): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock, trust: { trusted: [] } })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => smart,
    pullRequestOf: (text) => (text.includes("acme/orders#12") ? { owner: "acme", repo: "orders", number: 12 } : null),
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

const eventOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
// 助手代你发的话：带「auto-reply for」署名的消息（「正在处理」的状态消息被改写成回复时也算）。
const autoReplies = () => slack.sent("D0ETHAN").filter((message) => message.text.includes("auto-reply for"));
const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };

// 派一张子 agent 工单去 review，结果有把握，按信心可以代你回。
async function dispatchReview(channels: ChannelHub) {
  const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
  const dispatched = await channels.leadDispatch(eventOf(item.cardId), { summary: "review 订单服务的重试改动" });
  await channels.idle();
  return { item, finish: () => dispatcher.finish(dispatched.runId, {
    result: agentTaskResult({ answer: "看过了，留了 1 条评论。", sources: [], replyDraft: "已在 PR 留了 1 条评论。" }),
    actions: [{
      connection: "github", tool: "pull_request_review_write", summary: "在 acme/orders#12 提交了 COMMENT review（1 条评论）",
      target: "acme/orders#12", url: "https://github.com/acme/orders/pull/12#pullrequestreview-1", visible: true, at: clock.toISOString(),
    }],
  }) };
}

// Fairy 自己的回复（reply_to_source）：Lead 不在用户这一轮里，回复带「auto-reply for」署名代用户发。
const leadReplies = (channels: ChannelHub, cardId: number, text: string, event: number, seenBefore: number) =>
  channels.sendMessage(getChannelCard(db, cardId)!.objectKey, { text, words: "assistant", by: "lead", forUser: false, event, seenBefore });

describe("an agent task that finishes after the user replied by hand", () => {
  // 截图里的样子：对方问，派了活；用户亲手回了；对方说「好的」；结果交回 Fairy，Fairy 在新的一轮里又代用户回了一遍。
  it.each(JUDGES)("is not sent, and neither is Fairy's reply to the same message (the judgement %s)", async (judge) => {
    const smart = gatedModel(judge);
    const channels = hub(smart.model);
    const { item, finish } = await dispatchReview(channels);
    const asked = eventOf(item.cardId);
    later(60_000);
    await channels.receive("slack", slack.selfReply("D0ETHAN", "可以的，按这个来就好"));
    if (judge === "answers") {
      // 判断还没回来，对方又说了一句：用户那句话回答的是旧的内容，判断不动卡，卡还开着。
      later(10_000);
      await channels.receive("slack", slack.dm("U0ETHAN", "好的"));
    }
    smart.release();
    await channels.idle();
    expect(getChannelCard(db, item.cardId)!.state).toBe(judge === "answers" ? "open" : "replying_self");

    await finish();
    await channels.idle();
    expect(autoReplies()).toEqual([]);
    // 结果放在卡上，交回 Fairy。「正在处理」那一条已经不是真的了：删掉。
    expect(getChannelCard(db, item.cardId)).toMatchObject({ draft: { text: "已在 PR 留了 1 条评论。" }, sent: null });
    const [back] = listEvents(db, { kind: "channel.task.finished" });
    expect(back).toMatchObject({ payload: { handedBack: true, messageEvent: asked } });
    expect(slack.sent("D0ETHAN").filter((message) => message.text.includes("is reviewing"))).toEqual([]);

    // Fairy 在新的一轮里（用户说话以后才开始）回复派活的那条消息：不发，放到卡上。
    later(60_000);
    const reply = await leadReplies(channels, item.cardId, "可以，这个名字能用。", asked, clock.getTime() + 1);
    expect(reply).toMatchObject({ outcome: "drafted", card: { id: item.cardId, note: expect.stringContaining("亲手回过") } });
    await channels.idle();
    expect(autoReplies()).toEqual([]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ draft: { drafter: "lead", text: "可以，这个名字能用。" }, sent: null });
    expect(getChannelCard(db, item.cardId)!.state).not.toBe("auto_replied");
    expect(listEvents(db, { kind: "channel.reply.auto_sent" })).toEqual([]);
  });

  it("is sent for you as before when the user did not reply", async () => {
    const smart = gatedModel("fails");
    const channels = hub(smart.model);
    const { item, finish } = await dispatchReview(channels);
    await finish();
    await channels.idle();
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "auto_replied" });
    expect(autoReplies().map((message) => message.text)).toEqual([expect.stringMatching(/\n已在 PR 留了 1 条评论。$/u)]);
  });
});

describe("Fairy's own reply to a message the user then answered by hand", () => {
  it.each(JUDGES)("is not sent (the judgement %s)", async (judge) => {
    const smart = gatedModel(judge);
    smart.release();
    const channels = hub(smart.model);
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    // Fairy 这一轮开始，用户在这以后亲手回了。
    const turnStartedAt = clock.getTime() + 1;
    later(60_000);
    await channels.receive("slack", slack.selfReply("D0ETHAN", "可以，我三点以后都行"));
    await channels.idle();
    const reply = leadReplies(channels, item.cardId, "周五下午可以，三点以后都行。", eventOf(item.cardId), turnStartedAt);
    if (judge === "answers") {
      // 卡已经「别处已处理」：没有卡可以放，回复不发，告诉 Fairy 为什么、下一步做什么。
      await expect(reply).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("亲手回过") });
      expect(getChannelCard(db, item.cardId)!.state).toBe("resolved_elsewhere");
    } else {
      await expect(reply).resolves.toMatchObject({ outcome: "drafted", card: { id: item.cardId, state: "replying_self" } });
      expect(getChannelCard(db, item.cardId)).toMatchObject({ draft: { drafter: "lead", text: "周五下午可以，三点以后都行。" }, sent: null });
    }
    await channels.idle();
    expect(autoReplies()).toEqual([]);
  });

  it("goes out as before when the user did not reply, and for a new message after the user's reply", async () => {
    const smart = gatedModel("acknowledges");
    smart.release();
    const channels = hub(smart.model);
    const first = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    await expect(leadReplies(channels, first.cardId, "周五下午可以。", eventOf(first.cardId), clock.getTime() + 1))
      .resolves.toMatchObject({ outcome: "auto_sent", card: { state: "auto_replied" } });
    later(60_000);
    const second = await receive(channels, slack.dm("U0ETHAN", "那周六呢？"));
    later(60_000);
    await channels.receive("slack", slack.selfReply("D0ETHAN", "我看一下"));
    await channels.idle();
    // 对方在用户说话以后又问了一个新问题：Fairy 回复的是这条新消息，照常发。
    later(60_000);
    const third = await receive(channels, slack.dm("U0ETHAN", "周日也行吗？"));
    expect(third.cardId).toBe(second.cardId);
    await expect(leadReplies(channels, third.cardId, "周日可以。", eventOf(third.cardId), clock.getTime() + 1))
      .resolves.toMatchObject({ outcome: "auto_sent" });
    expect(autoReplies()).toHaveLength(2);
  });
});

describe("an auto-reply waiting to be sent again", () => {
  it.each(JUDGES)("is dropped once the user replied by hand (the judgement %s)", async (judge) => {
    const smart = gatedModel(judge);
    smart.release();
    const channels = hub(smart.model);
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    slack.failNext("chat.postMessage", "ECONNRESET");
    const first = await leadReplies(channels, item.cardId, "周五下午可以。", eventOf(item.cardId), clock.getTime() + 1);
    expect(first.reasons?.join("")).toContain("再试");
    expect(getChannelCard(db, item.cardId)!.sent).toMatchObject({ status: "pending" });
    later(30_000);
    await channels.receive("slack", slack.selfReply("D0ETHAN", "可以，周五下午"));
    await channels.idle();
    later(10 * 60_000);
    await channels.tick();
    await channels.idle();
    expect(autoReplies()).toEqual([]);
    // 已回答时卡「别处已处理」，本来就不再发；另外两种卡还开着，排着的那条撤掉，草稿留在卡上。
    if (judge !== "answers") expect(getChannelCard(db, item.cardId)).toMatchObject({ sent: null, draft: { text: "周五下午可以。" } });
  });
});
