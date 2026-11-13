// 交给 Lead（落地计划 B，用户 2026-10-22）：要干活、要打扰你的外部消息先交给 Lead 决定（B1），Lead 派子 agent 工单、
// 自己答、推送或者已经告诉你（B2）；子 agent 答完以后信心模型说问你、交给你的，再交回 Lead（B4）。系统的兜底（B3）在
// 统一消息事件工单 06 删了：没有期限，Lead 不能工作时只推送（channel-no-fallback.test.ts）。真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel、
// 假的派单器（C 的接口）。断言外部行为：给 Lead 的事件、派单的请求、假 Slack 里留下的消息、推送。
// 统一的消息事件（工单 03）以后，intake 这一步 Lead 收到的是消息事件（带原话，外部标记）。工单 05 以后它就是请求，不再另记
// channel.lead.requested；交回 Lead 的子 agent 结果是 channel.task.finished（handedBack）。Lead 用通用工具：派活（leadDispatch）、
// 回复（sendMessage 的出站扩展）、回表情（react）、告诉用户（leadNotify）、记下已处理（leadDisposed），都按消息事件找卡。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, getStandingOrder, listEvents, openDb, proposeStandingOrderChange, type Db } from "@pi-lead-child/store";
import { AUTHORITY_REFUSAL_TEXT, ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelHubOptions } from "../src/index.js";
import { agentTaskResult, cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let pushes: Array<{ cardId: number; title: string; body: string }>;
let dispatcher: FakeAgentTaskDispatcher;
let leadUp: boolean;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-lead-"), "plc.db"));
  clock = new Date("2026-10-22T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ETHAN: { name: "王小明" }, U0VIP: { name: "老板" } } });
  pushes = [];
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
  leadUp = true;
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 状态文本的第一段是对方的原话（intake.ts 的 channelIntakeState）。
const messageOf = (state: string) => state.split("\n\n")[0] ?? "";
// 原话里有 review 是请你 review；带问号的是一个问题（别的，要你回）；带「紧急」的要你马上看到（你信任的人发的推送）。
const jev = (answers: Record<string, string | number | ((state: string) => string | number)> = {}) => scriptedSmartModel({
  answers: {
    ask_kind: (state) => (messageOf(state).includes("review") ? "code_review" : "other"), handling_verb: "reviewing",
    needs_user_now: (state) => (state.includes("紧急") ? 0.95 : 0.05),
    target_repo: "acme/orders", ...answers,
  },
});
const pullRequestOf = (text: string) => (text.includes("acme/orders#12") ? { owner: "acme", repo: "orders", number: 12 } : null);

function hub(model: ScriptedSmartModel, options: Partial<ChannelHubOptions> = {}): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock, trust: { trusted: ["U0VIP"] } })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: (notice) => pushes.push(notice), classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model, pullRequestOf,
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    lead: { dispatcher, available: () => leadUp },
    // 抽查（落地计划 D2）是随机的：这里关掉，要测它的用例自己给。
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

// 交给 Lead 的消息事件（统一消息事件 spec D1，工单 03）：intake 这一步 Lead 收到的是它，它就是请求（工单 05）。
const messages = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
// 这张卡最新的消息事件：Lead 的通用工具按它找卡。
const eventOf = (cardId: number) => messages().filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
// 交回 Lead 的子 agent 结果（B4）。
const handedBack = () => listEvents(db, { kind: "channel.task.finished" }).filter((event) => event.payload.handedBack === true);
// Lead 在事件轮里回复这张卡（reply_to_source）：过出站扩展的信心检验。
const leadReply = (channels: ChannelHub, cardId: number, text: string) => channels.sendMessage(getChannelCard(db, cardId)!.objectKey, {
  text, words: "assistant", by: "lead", forUser: false, event: eventOf(cardId),
});
const decisions = () => listEvents(db, { kind: "channel.lead.decided" });
const replies = (channel?: string) => slack.sent(channel).filter((message) => !message.text.startsWith(":robot_face: Paimon (Assistant) is "));

describe("B1: a request that needs work or needs you goes to Lead first", () => {
  it("hands a review request to Lead as a message event with the words, the PR and the grant ceiling, and pushes nothing", async () => {
    const channels = hub(jev());
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12，主要看重试"));
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
    expect(pushes).toEqual([]);
    expect(dispatcher.requests).toEqual([]);
    // 消息事件就是请求（工单 05）：原话带外部标记，权限上限是授权表给的，带 forSeq 和代码认出的 PR（统一消息事件 spec D1、D5）。
    expect(messages()).toMatchObject([{
      level: "tell",
      payload: {
        entry: "external", cardId: item.cardId, messages: [item.seq], text: "帮忙 review 一下 acme/orders#12，主要看重试", external: true,
        sender: { name: "王小明", trust: "colleague" }, inbound: { intent: "code_review" },
        ceiling: { authority: "work", bound: { repos: "pull_request", pullRequest: true, reviewEvents: ["COMMENT"] } },
        forSeq: item.seq,
        objects: [{ kind: "pull_request", owner: "acme", repo: "orders", number: 12 }],
        summary: expect.stringContaining("dispatch_agent_task"),
      },
    }]);
    expect(messages()[0]!.payload.summary).toContain(`通道卡 #${item.cardId}`);
    expect(messages()[0]!.payload.summary).not.toContain("主要看重试");
    expect(channels.cardForLead(item.cardId)).toMatchObject({
      request: { stage: "intake", intent: "code_review", objects: [{ number: 12 }] }, tasks: [],
    });
  });

  it("finds the PR in the message the reply answers (the thread's root)", async () => {
    const channels = hub(jev());
    const root = slack.dm("U0ETHAN", "acme/orders#12 帮忙看看");
    const thread = (JSON.parse(root.body) as { event: { ts: string } }).event.ts;
    await receive(channels, root);
    await receive(channels, slack.dm("U0ETHAN", "pr comment 改了，再帮忙 review 一下", { thread }));
    expect(messages().at(-1)).toMatchObject({ payload: { inbound: { intent: "code_review" }, objects: [{ owner: "acme", repo: "orders", number: 12 }] } });
  });

  it("hands a question to Lead as well, with no draft until Lead writes one, and a thanks too: the system does not react by itself", async () => {
    const channels = hub(jev({ ask_kind: (state) => (messageOf(state).includes("谢谢") ? "closing" : "other"), closing_kind: "they_thank_you" }));
    const question = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    expect(messages()).toMatchObject([{ payload: { cardId: question.cardId, inbound: { intent: "other" }, ceiling: { authority: "ask", bound: null } } }]);
    expect(getChannelCard(db, question.cardId)!.draft).toBeNull();
    const thanks = slack.dm("U0LI", "好的谢谢");
    const item = await receive(channels, thanks);
    // 用户 2026-10-26：能代你回的都先交给 Lead。请求 A 选的表情（假模型缺省选 smile）只是建议。
    expect(slack.messageOf(thanks).reactions ?? []).toEqual([]);
    expect(messages().at(-1)).toMatchObject({
      level: "tell", payload: { cardId: item.cardId, ceiling: { authority: "react" }, summary: expect.stringContaining(":smile:") },
    });
  });
});

// 用户 2026-10-26：「如果这个消息 lead 能代回，务必都交给 lead 处理」（Jarvis 模式，2026-10-15）。回表情、代你拒绝、收尾说一句
// 都先交给 Lead：Lead 看了上下文再定，权限上限还是授权表给的。系统不替 Lead 定（工单 06）。
describe("B5: whatever could be answered for you goes to Lead first", () => {
  const closing = (answers: Record<string, string | number> = {}) =>
    jev({ ask_kind: "closing", closing_kind: "remark", reaction_emoji: "ok_hand", ...answers });

  it("lets Lead pick the reaction from the context: a card opens without a push, nothing is sent until Lead decides", async () => {
    const channels = hub(closing());
    const ok = slack.dm("U0ETHAN", "ok");
    const item = await receive(channels, ok);
    expect(slack.messageOf(ok).reactions ?? []).toEqual([]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", delivery: "card" });
    expect(pushes).toEqual([]);
    expect(messages()).toMatchObject([{
      level: "tell", payload: { cardId: item.cardId, forSeq: item.seq, ceiling: { authority: "react" }, summary: expect.stringContaining("react_channel_message") },
    }]);
    // Lead 看到用户刚请对方帮忙：回 ❤️，不回 :ok_hand:（通用的回表情，统一消息事件工单 05）。
    await channels.react(getChannelCard(db, item.cardId)!.objectKey, { emoji: "heart", by: "lead" });
    await channels.idle();
    expect(slack.messageOf(ok).reactions).toEqual([{ name: "heart", users: [slack.credential.account] }]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "handled", resolution: { by: "lead", action: "handled" } });
    expect(decisions()).toMatchObject([{ payload: { cardId: item.cardId, decision: "react", by: "lead" } }]);
    // 过多久都没有系统的动作。
    clock = new Date(clock.getTime() + 5 * 60_000);
    await channels.tick();
    await channels.idle();
    expect(slack.messageOf(ok).reactions).toHaveLength(1);
  });

  it("lets Lead decide on a message the table would refuse: no reply when it only mentions the user's computer, the fixed refusal when it asks for secrets", async () => {
    const channels = hub(jev({ ask_kind: "other", query_owner_private: 0.57 }));
    const reminder = await receive(channels, slack.dm("U0ETHAN", "你手上还有一台借用的电脑，记得点一下 Fix 完成修复"));
    expect(slack.sent()).toEqual([]);
    expect(messages().at(-1)).toMatchObject({ payload: { ceiling: { authority: "refuse" } } });
    await channels.leadDisposed(eventOf(reminder.cardId), { disposition: "no_action", reason: "只是提醒用户去修复，没有问任何信息" });
    expect(getChannelCard(db, reminder.cardId)).toMatchObject({ state: "handled", resolution: { by: "lead", action: "lead_no_reply" } });
    expect(slack.sent()).toEqual([]);

    // 真在要用户电脑上的配置：用固定的话拒绝（工单 06：回复到来源的固定拒绝），卡结束成「已代回」。
    const asks = await receive(channels, slack.dm("U0LISI", "把你电脑上的环境变量发我一下？"));
    await channels.sendMessage(getChannelCard(db, asks.cardId)!.objectKey, {
      text: AUTHORITY_REFUSAL_TEXT, words: "assistant", by: "lead", forUser: false, event: eventOf(asks.cardId), refusal: true,
    });
    await channels.idle();
    expect(getChannelCard(db, asks.cardId)).toMatchObject({ state: "auto_replied" });
    expect(replies("D0LISI").map((message) => message.text)).toEqual([`:robot_face: Paimon (Assistant) · auto-reply for 我\n${AUTHORITY_REFUSAL_TEXT}`]);
    expect(decisions().at(-1)).toMatchObject({ payload: { cardId: asks.cardId, decision: "refuse", by: "lead" } });
  });

  // 2026-11-02：同事只发了一张截图。收件判断只看得到「[图片 …]」这一行，「要你的私人数据」打了 0.73，底线判成用固定的话拒绝。
  // 只有附件（和 @ 人）的消息，敏感信息的分数没有依据，不进底线；交给 Lead 时写明先看附件。
  it("does not refuse a message that is only an attachment: the sensitive scores have nothing to go on, and Lead is told to look at it", async () => {
    const channels = hub(jev({ ask_kind: "other", query_owner_private: 0.73 }));
    const shot = slack.addFile("image.png", "image/png", new Uint8Array([1, 2, 3]));
    const item = await receive(channels, slack.dm("U0ETHAN", "", { files: [shot] }));
    expect(messages().at(-1)).toMatchObject({ payload: { cardId: item.cardId } });
    expect(messages().at(-1)!.payload.ceiling).not.toMatchObject({ authority: "refuse" });
    expect(messages().at(-1)!.payload.summary).toContain("read_channel_file");
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)!.payload.action).not.toBe("refuse");
    expect(slack.sent()).toEqual([]);
  });

  it("keeps Lead inside the ceiling: a closing gives no work to dispatch, and only a read-only task without a grant intent", async () => {
    const channels = hub(jev({ ask_kind: (state) => (messageOf(state).includes("review") ? "code_review" : "closing") }));
    const ok = await receive(channels, slack.dm("U0ETHAN", "ok"));
    await expect(channels.leadDispatch(eventOf(ok.cardId), { summary: "试试" })).rejects.toMatchObject({ code: "invalid_action" });
    await expect(channels.leadDispatch(eventOf(ok.cardId), { summary: "试试", intent: "code_review" })).rejects.toMatchObject({ code: "invalid_action" });
    await expect(channels.leadDisposed(eventOf(ok.cardId), { disposition: "deferred", reason: "等等" })).rejects.toMatchObject({ code: "invalid_action" });
    expect(dispatcher.requests).toEqual([]);
  });
});

describe("B2: Lead decides", () => {
  it("dispatches within the ceiling, says it is reviewing, and sends the result for you when it is confident", async () => {
    const model = jev();
    const channels = hub(model);
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    // Lead 想多给 CDP：代码 review 的上限没有，丢掉并告诉 Lead。
    const dispatched = await channels.leadDispatch(eventOf(item.cardId), { summary: "review 订单服务的重试改动（上周也看过这个模块）", connections: ["cdp"] });
    expect(dispatched.dropped.join("；")).toContain("cdp");
    expect(dispatched.grant.length).toBeGreaterThan(0);
    const [sent] = dispatcher.requests;
    expect(sent).toMatchObject({
      intent: "code_review", scope: { pullRequest: { owner: "acme", repo: "orders", number: 12 }, connections: ["cdp"] },
      request: { source: "slack", requester: "王小明", summary: "review 订单服务的重试改动（上周也看过这个模块）", ref: `card:${item.cardId}` },
      callback: { kind: "channel", ref: `card:${item.cardId}:seq:${item.seq}` },
    });
    // 原话只进子 agent 的提示词。
    expect(sent!.untrusted.message).toContain("帮忙 review 一下");
    expect(decisions()).toMatchObject([{ payload: { decision: "dispatch", by: "lead", runId: dispatched.runId, itemId: dispatched.itemId } }]);
    await channels.idle();
    expect(slack.sent("D0ETHAN").map((message) => message.text)).toEqual([":robot_face: Paimon (Assistant) is reviewing…"]);
    // 同一个请求不能再派一次。
    await expect(channels.leadDispatch(eventOf(item.cardId), { summary: "再派一次" })).rejects.toMatchObject({ code: "invalid_action" });

    // 子 agent 在 PR 上发了评论，交回草稿：信心够，代你回，改写「正在处理」那一条。
    await dispatcher.finish(dispatched.runId, {
      result: agentTaskResult({ answer: "看过了，留了 1 条评论。", sources: [], replyDraft: "已在 PR 留了 1 条评论：https://github.com/acme/orders/pull/12#pullrequestreview-1" }),
      actions: [{
        connection: "github", tool: "pull_request_review_write", summary: "在 acme/orders#12 提交了 COMMENT review（1 条评论）",
        target: "acme/orders#12", url: "https://github.com/acme/orders/pull/12#pullrequestreview-1", visible: true, at: clock.toISOString(),
      }],
    });
    await channels.idle();
    expect(model.calls.find((call) => call.purpose === "channel_reply_check")!.state).toContain("Actions the assistant already finished");
    const card = getChannelCard(db, item.cardId)!;
    expect(card).toMatchObject({ state: "auto_replied", draft: { drafter: "agent" }, sent: { key: `task:card:${item.cardId}:run:${dispatched.runId}` } });
    expect(slack.sent("D0ETHAN").map((message) => [message.text, message.edits])).toEqual([[
      ":robot_face: Paimon (Assistant) · auto-reply for 我\n已在 PR 留了 1 条评论：https://github.com/acme/orders/pull/12#pullrequestreview-1", 1,
    ]]);
    expect(listEvents(db, { kind: "channel.task.finished" })).toMatchObject([{
      level: "record", payload: { runId: dispatched.runId, status: "finished", decision: "auto_send", actions: 1 },
    }]);
    expect(handedBack()).toEqual([]);
    expect(listEvents(db, { kind: "channel.reply.auto_sent" })).toMatchObject([{ payload: { category: "agent_task" } }]);
    expect(channels.cardForLead(item.cardId)!.tasks).toEqual([{ itemId: dispatched.itemId, runId: dispatched.runId, by: "lead", status: "finished", reply: "auto_send" }]);
  });

  it("hands a weak result back to Lead (B4), and Lead tells the user with its own draft", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    const event = eventOf(item.cardId);
    const dispatched = await channels.leadDispatch(event, { summary: "review 这个 PR" });
    await dispatcher.finish(dispatched.runId, { result: agentTaskResult({ replyDraft: "看过了，有两处要改。" }) });
    await channels.idle();
    expect(replies()).toEqual([]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: { text: "看过了，有两处要改。" } });
    // 交回 Lead 的就是这条 channel.task.finished：tell 级，写明消息事件和能用的通用工具。
    const [back] = handedBack();
    expect(back).toMatchObject({ level: "tell", payload: { decision: "ask_user", cardId: item.cardId, messageEvent: event } });
    expect(back!.payload).not.toHaveProperty("deadlineAt");
    expect(back!.payload.summary).toContain("notify_user");
    expect(back!.payload.summary).toContain(`消息事件 #${event}`);
    channels.leadNotify(event, { note: "王小明的 PR 看完了，有两处要改，草稿在卡上", draft: "看过了，重试上限和退避有两处要改，我在 PR 上写了。" });
    expect(pushes).toMatchObject([{ cardId: item.cardId, body: "王小明的 PR 看完了，有两处要改，草稿在卡上" }]);
    expect(getChannelCard(db, item.cardId)!.draft).toMatchObject({ drafter: "lead", text: "看过了，重试上限和退避有两处要改，我在 PR 上写了。" });
    expect(decisions().at(-1)).toMatchObject({ payload: { stage: "reply", decision: "push", by: "lead" } });
  });

  // 回归（用户 2026-10-29）：草稿替用户答应了评审，以前底线拦下 Lead 的回复，留在卡上等用户点。现在 Lead 自己判断，照发。
  it("lets Lead answer itself: its reply goes out even when the reply check would have stopped it", async () => {
    const channels = hub(jev({ draft_commits: 0.8 }));
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    const answered = await leadReply(channels, item.cardId, "周五下午可以，三点以后都行。");
    expect(answered).toMatchObject({ outcome: "auto_sent", card: { id: item.cardId, state: "auto_replied" } });
    expect(decisions()).toMatchObject([{ payload: { decision: "answer", by: "lead" } }]);
    expect(replies().map((message) => message.text)).toEqual([expect.stringMatching(/\n周五下午可以，三点以后都行。$/u)]);
  });

  it("records that Lead told the user, with its draft, so nothing is pushed later", async () => {
    const channels = hub(jev());
    const item = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    await expect(channels.leadDisposed(eventOf(item.cardId), { disposition: "told_user", reason: "在回复里问了用户" }))
      .rejects.toMatchObject({ code: "invalid_action" });
    await channels.leadDisposed(eventOf(item.cardId), { disposition: "told_user", reason: "在回复里问了用户周五能不能去", draft: "周五我看下日程再回你。" });
    clock = new Date(clock.getTime() + 5 * 60_000);
    await channels.tick();
    await channels.idle();
    expect(pushes).toEqual([]);
    expect(decisions()).toMatchObject([{ payload: { decision: "told", by: "lead" } }]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: { drafter: "lead", text: "周五我看下日程再回你。" } });
  });
});

// 2026-11-02：一条消息里有两个 PR，Lead 同时派两张，第二张被拒「卡正在派工单」；子 agent 失败交回以后，再派被拒「已经处理过了」，
// 两个拒绝都没说下一步，同事等了一个多小时。现在每个 PR 一张工单，交回以后能重派，拒绝写明下一步。
describe("dispatching again on the same message", () => {
  const twoPullRequests = (text: string) => {
    const match = /acme\/orders#(\d+)/g;
    const numbers = [...text.matchAll(match)].map((found) => Number(found[1]));
    return numbers.length ? { owner: "acme", repo: "orders", number: numbers[0]! } : null;
  };

  it("re-dispatches once the sub-agent's failed result comes back, and records it as Lead's decision on that result", async () => {
    const channels = hub(jev());
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    const first = await channels.leadDispatch(eventOf(item.cardId), { summary: "review 这个 PR" });
    await dispatcher.finish(first.runId, { status: "failed", result: null, error: "子 agent 没有用 submit_result 交结果" });
    await channels.idle();
    const [back] = handedBack();
    expect(back).toBeDefined();
    const again = await channels.leadDispatch(eventOf(item.cardId), { summary: "再评一次，这次拆小提交" });
    expect(again.runId).not.toBe(first.runId);
    expect(dispatcher.requests.at(-1)).toMatchObject({ scope: { pullRequest: { owner: "acme", repo: "orders", number: 12 } } });
    expect(decisions().map((event) => [event.payload.stage, event.payload.decision])).toEqual([["intake", "dispatch"], ["reply", "dispatch"]]);
    // 重派的结果交回以后，Lead 照常能处理它：它不会被上一次的决定算成已经定了。
    await dispatcher.finish(again.runId, { status: "failed", result: null, error: "又失败了" });
    await channels.idle();
    expect(channels.pendingLeadRequest(item.cardId)).toMatchObject({ stage: "reply" });
  });

  it("dispatches a second PR from the same message, one task per PR, even while the first is running", async () => {
    const channels = hub(jev(), { pullRequestOf: twoPullRequests });
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12 和 acme/orders#13"));
    const event = eventOf(item.cardId);
    const pr = (number: number) => ({ owner: "acme", repo: "orders", number });
    const [a, b] = await Promise.all([
      channels.leadDispatch(event, { summary: "review #12", pullRequest: pr(12) }),
      channels.leadDispatch(event, { summary: "review #13", pullRequest: pr(13) }),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(dispatcher.requests.map((request) => request.scope.pullRequest?.number).sort()).toEqual([12, 13]);
    expect(decisions().filter((decision) => decision.payload.decision === "dispatch")).toHaveLength(2);
    // 同一个 PR 再派一次，或者派一个这条消息里没有的 PR：拒绝，并说下一步。
    await expect(channels.leadDispatch(event, { summary: "再评 #12", pullRequest: pr(12) }))
      .rejects.toMatchObject({ code: "invalid_action", message: expect.stringContaining("create_task") });
    await expect(channels.leadDispatch(event, { summary: "评 #99", pullRequest: pr(99) }))
      .rejects.toMatchObject({ code: "invalid_action", message: expect.stringContaining("create_task") });
  });
});

describe("a conversation that keeps talking", () => {
  it("merges the older request into the new one: Lead decides once", async () => {
    const channels = hub(jev());
    const first = await receive(channels, slack.dm("U0VIP", "紧急：周五的评审你能来吗？"));
    clock = new Date(clock.getTime() + 90_000);
    const second = await receive(channels, slack.dm("U0VIP", "紧急：如果来不了，能派个人吗？"));
    expect(second.cardId).toBe(first.cardId);
    expect(decisions()).toMatchObject([{ payload: { decision: "superseded", forSeq: first.seq, by: "system" } }]);
    expect(channels.cardForLead(first.cardId)!.request).toMatchObject({ forSeq: second.seq });
  });
});

describe("without the lead option", () => {
  it("keeps pushing cards as before", async () => {
    const channels = hub(jev(), { lead: undefined });
    await receive(channels, slack.dm("U0LI", "紧急：周五的评审你能来吗？"));
    expect(messages()).toEqual([]);
  });
});

describe("D2: calibration from what you actually did", () => {
  const scores = () => listEvents(db, { kind: "channel.reply.scored" });
  const labels = () => listEvents(db, { kind: "channel.reply.labeled" });
  const by = { by: "user via 测试" };

  async function reviewed(channels: ChannelHub, from: string, text = "帮忙 review 一下 acme/orders#12") {
    const item = await receive(channels, slack.dm(from, text));
    const dispatched = await channels.leadDispatch(eventOf(item.cardId), { summary: "review 这个 PR" });
    // 子 agent 在 PR 上留了一条评论（核实过的动作），交回草稿。
    await dispatcher.finish(dispatched.runId, {
      result: agentTaskResult({ answer: "看过了，留了 1 条评论。", sources: [], replyDraft: "看过了，没问题。" }),
      actions: [{
        connection: "github", tool: "pull_request_review_write", summary: "在 acme/orders#12 提交了 COMMENT review（1 条评论）",
        target: "acme/orders#12", url: "https://github.com/acme/orders/pull/12#pullrequestreview-1", visible: true, at: clock.toISOString(),
      }],
    });
    await channels.idle();
    return item;
  }

  it("scores the sub-agent's draft, labels a retracted auto reply, and scores the next draft of that bucket lower", async () => {
    const channels = hub(jev());
    const first = await reviewed(channels, "U0ETHAN");
    expect(getChannelCard(db, first.cardId)).toMatchObject({ state: "auto_replied" });
    const [scored] = scores();
    expect(scored).toMatchObject({
      level: "record",
      payload: { cardId: first.cardId, draftKind: "task", intent: "code_review", decision: "auto_send", audit: false, calibration: { samples: 0 } },
    });
    // 卡上的分数面板就是这次打分。
    expect(channels.cardDto(getChannelCard(db, first.cardId)!).handling?.reply).toMatchObject({
      draftKind: "task", decision: "auto_send", audit: false, raw: scored!.payload.raw, confidence: scored!.payload.confidence,
    });

    // 你撤回了自动回复：这一次你不同意，顶 3 个样本。
    await channels.act(first.cardId, "undo_auto_reply", by);
    expect(labels()).toMatchObject([{ payload: { cardId: first.cardId, scoredSeq: scored!.seq, label: "retracted", value: 0, weight: 3 } }]);

    // 同样的草稿（同一个分数段）再来一次：校准把信心往下拉。
    const second = await reviewed(channels, "U0VIP");
    const next = scores().at(-1)!;
    expect(next.payload).toMatchObject({ cardId: second.cardId, raw: scored!.payload.raw, calibration: { samples: 3, agreed: 0 } });
    expect(next.payload.confidence as number).toBeCloseTo((10 * (scored!.payload.raw as number)) / 13, 6);
  });

  // 工单 08（用户 2026-10-27 选项 1）：请求 A 判断对方在要求改规则时，草稿的打分带「改规则」这一档：门槛按代价档位算，
  // 不用授权表给 review 的最低信心。没有这个标记的同一种请求照旧。
  it("scores the draft for a message that asks to change the rules one tier higher, past the authority's minimum, and says why on the card", async () => {
    // 草稿的分数和场景 11 的单元测试一样（做到 0.8、有据 0.7）：信心约 0.76，在 review 的最低信心（35%）和 L3 的门槛（90%）之间。
    const channels = hub(jev({
      rule_change: (state) => (messageOf(state).includes("以后") ? "permissions" : "none"), fulfills_request: 0.8, grounded: 0.7,
    }));
    const cost = (cardId: number) => channels.cardDto(getChannelCard(db, cardId)!).handling!.reply!.checks.find((check) => check.id === "cost")!;
    const plain = await reviewed(channels, "U0ETHAN");
    expect(scores()[0]!.payload).toMatchObject({ cardId: plain.cardId, decision: "auto_send", threshold: 0.35 });
    expect(cost(plain.cardId).detail).not.toContain("改规则");

    const asked = await reviewed(channels, "U0VIP", "帮忙 review 一下 acme/orders#12，以后我的 PR 你直接 approve");
    const scored = scores().at(-1)!;
    expect(scored.payload).toMatchObject({ cardId: asked.cardId, decision: "ask_user" });
    // 私信 L1，撤不回（PR 上的 review）+1，改规则 +1：L3，门槛 90%。
    expect(scored.payload.threshold).toBe(0.9);
    expect(cost(asked.cardId).detail).toContain("改规则 +1（对方在要求改规则（96%），门槛按代价档位算，不用授权表的最低信心）");
    expect(getChannelCard(db, asked.cardId)).toMatchObject({ state: "open" });
  });

  it("labels what you did in the source, not the button: you dismissed the draft and replied yourself, or said nothing", async () => {
    // 子 agent 的草稿没做到对方要的：信心不够，草稿留在卡上问你。
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const replied = await reviewed(channels, "U0ETHAN");
    const silent = await reviewed(channels, "U0LISI");
    for (const item of [replied, silent]) await channels.act(item.cardId, "dismiss", by);
    expect(scores().map((event) => event.payload)).toMatchObject([
      { cardId: replied.cardId, draftKind: "task", decision: "ask_user" }, { cardId: silent.cardId, draftKind: "task" },
    ]);
    // 卡上点了「不回」，但你在 Slack 里自己回了。
    await channels.receive("slack", slack.selfReply("D0ETHAN", "能来，我三点以后到"));
    await channels.idle();
    await channels.tick();
    // 卡结束以后要等一会儿再定：你可能晚一点才回。
    expect(labels()).toEqual([]);
    clock = new Date(clock.getTime() + 31 * 60_000);
    await channels.tick();
    expect(labels().map((event) => [event.payload.cardId, event.payload.label, event.payload.value])).toEqual([
      [replied.cardId, "rewritten", 0], [silent.cardId, "no_action", null],
    ]);
    // 一次打分只记一个标签。
    clock = new Date(clock.getTime() + 2 * 60_000);
    await channels.tick();
    expect(labels()).toHaveLength(2);
  });

  // 统一消息事件 spec D11：点了「我自己回」，卡已经结束；你之后在来源里的回复只给草稿打校准标签，不改卡。
  it("after 'I will reply myself', your reply in the source only labels the draft and leaves the ended card as it is", async () => {
    const model = jev({ answers_request: 0.9, fulfills_request: 0.1 });
    const channels = hub(model);
    const item = await reviewed(channels, "U0ETHAN");
    expect(scores()).toMatchObject([{ payload: { cardId: item.cardId, decision: "ask_user" } }]);
    const [scored] = scores();
    const ended = await channels.act(item.cardId, "reply_myself", by);
    expect(ended).toMatchObject({ state: "left_to_user" });
    expect(channels.openCards()).toEqual([]);
    expect(labels()).toEqual([]);

    await channels.receive("slack", slack.selfReply("D0ETHAN", "能来，我三点以后到"));
    await channels.idle();
    // 卡不变：状态、版本、结局都和点按钮时一样；也不再问 SmartModel 这句话回答了没有。
    expect(getChannelCard(db, item.cardId)).toMatchObject({
      state: "left_to_user", version: ended.version, resolvedAt: ended.resolvedAt, resolution: ended.resolution,
    });
    expect(model.count("channel_self_reply")).toBe(0);
    // 校准照常记一条：草稿你没用，自己写了别的。
    expect(labels()).toMatchObject([{ payload: { cardId: item.cardId, scoredSeq: scored!.seq, label: "rewritten", value: 0 } }]);
    // 一次打分只记一个标签：再回一句、过了等待时间的一拍都不再记。
    await channels.receive("slack", slack.selfReply("D0ETHAN", "到时候见"));
    await channels.idle();
    clock = new Date(clock.getTime() + 31 * 60_000);
    await channels.tick();
    expect(labels()).toHaveLength(1);
    expect(getChannelCard(db, item.cardId)!.version).toBe(ended.version);
  });

  it("audits a draft it would have sent: asks you instead, says it is an audit, and hands it back to Lead; sending it as is agrees", async () => {
    const channels = hub(jev(), { audit: { rate: 0.05, random: () => 0.01 } });
    const item = await reviewed(channels, "U0ETHAN");
    expect(replies()).toEqual([]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: { text: "看过了，没问题。" } });
    const [scored] = scores();
    expect(scored!.payload).toMatchObject({ decision: "ask_user", audit: true });
    expect((scored!.payload.reasons as string[])[0]).toContain("抽查");
    expect(channels.cardDto(getChannelCard(db, item.cardId)!).handling?.reply).toMatchObject({ decision: "ask_user", audit: true });
    expect(handedBack().at(-1)).toMatchObject({ level: "tell", payload: { decision: "ask_user", cardId: item.cardId } });

    await channels.act(item.cardId, "send_draft", by);
    expect(labels()).toMatchObject([{ payload: { cardId: item.cardId, label: "sent_as_is", value: 1, weight: 1 } }]);
  });
});

// spec D3（2026-10-27）：授权表先看要不要回，再看是不是要干活。2026-10-26 的两条消息：
// 李雷「那我更新一下修复情况」（进度，要回 16%）只记录；Kent「不是对外的，是 内部服务」（咨询，要回 24%）是在接着回答你刚问的，
// 交给 Lead 告诉你，权限上限里没有派活。
describe("reply first, then work", () => {
  const model = () => jev({
    ask_kind: (state) => (messageOf(state).includes("内部服务") ? "knowledge" : messageOf(state).includes("修复情况") ? "progress" : "other"),
    needs_reply: (state) => (messageOf(state).includes("内部服务") ? 0.24 : messageOf(state).includes("修复情况") ? 0.16 : 0.9),
  });

  it("only records a progress note that needs no reply: no card, nothing for Lead, no work", async () => {
    const channels = hub(model());
    const item = await receive(channels, slack.dm("U0LILEI", "那我更新一下修复情况"));
    expect(item.cardId).toBeNull();
    expect(messages()).toEqual([]);
    expect(dispatcher.requests).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)).toMatchObject({
      payload: { forSeq: item.seq, intent: "progress", action: "skip", reason: expect.stringContaining("多半不用回"), situation: "ask_progress" },
    });
  });

  // 2026-11-02：同一个群聊里，判成「多半不用回：只记录」的四次编辑都因为对话里开着卡，被改成「问你」交给 Lead，Lead 跑了四轮。
  // 开着卡时只记录的照旧只记录：并进卡，不交给 Lead。
  it("only records a no-reply message that joins an open card: the card takes it, Lead gets nothing", async () => {
    const channels = hub(model());
    const first = await receive(channels, slack.dm("U0LILEI", "这个接口的超时是多少？"));
    expect(messages().map((event) => event.payload.forSeq)).toEqual([first.seq]);
    const note = await receive(channels, slack.dm("U0LILEI", "那我更新一下修复情况"));
    expect(note.cardId).toBe(first.cardId);
    expect(getChannelCard(db, first.cardId)).toMatchObject({ state: "open", messageCount: 2 });
    expect(messages().map((event) => event.payload.forSeq)).toEqual([first.seq]);
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)).toMatchObject({
      payload: { forSeq: note.seq, action: "skip", reason: expect.stringContaining("多半不用回") },
    });
  });

  it("tells you, without work, when they answer what you just asked in the conversation", async () => {
    const channels = hub(model());
    await receive(channels, slack.dm("U0KENT", "在吗？"));
    // 你在 Slack 里自己问了 Kent（道已经在了，这句话记进事件）。
    await channels.receive("slack", slack.selfReply("D0KENT", "ep-gateway 这个仓库是谁在维护？对外的吗？"));
    await channels.idle();
    const answer = await receive(channels, slack.dm("U0KENT", "不是对外的，是 内部服务"));

    const request = messages().find((event) => event.payload.cardId === answer.cardId && (event.payload.messages as number[]).includes(answer.seq!));
    expect(request).toMatchObject({
      level: "tell", payload: { forSeq: answer.seq, inbound: { intent: "knowledge" }, ceiling: { authority: "tell", bound: null } },
    });
    expect(request!.payload.summary).toContain("接着回答你");
    expect(request!.payload.summary).toContain("不能派活");
    // 卡上看得懂：授权表的结论是「告诉你」，理由写明在接着回答你。
    expect(channels.cardDto(getChannelCard(db, answer.cardId)!).handling?.authority).toMatchObject({
      intent: "knowledge", action: "tell", reason: expect.stringContaining("不派活"),
    });
    // 权限上限里没有派活：Lead 想派也派不了，系统也不替它派。
    await expect(channels.leadDispatch(request!.seq, { intent: "knowledge", summary: "查 ep-gateway 的维护人" }))
      .rejects.toMatchObject({ code: "invalid_action" });
    expect(dispatcher.requests).toEqual([]);
  });
});

// #21（#18 的调查）：自动代你处理关着时，要回的概率低于门槛的消息以前也是 tell 级，每条单独叫醒 Lead（11-03 有 42 条）。
// 现在是 digest 级：交给 Lead，并进摘要，不单独开一轮，也不拼上下文包（省一次对话摘要的模型调用）。
describe("auto-handling off: a message that most likely needs no reply", () => {
  const CONTEXT_EVENT = "message.context_packed";
  const turnAutoReplyOff = () => {
    const handbook = getStandingOrder(db, "channel.handbook")!;
    const off = proposeStandingOrderChange(db, {
      op: "update", id: "channel.handbook", reason: "测试：先别自动回了",
      patch: { action: { ...handbook.action, params: { ...(handbook.action as any).params, autoReply: false } } as never },
    });
    expect(off.outcome).toBe("applied");
  };
  const model = () => jev({
    needs_reply: (state) => (messageOf(state).includes("顺便说一下") ? 0.12 : 0.9),
  });
  const levelsOf = () => messages().map((event) => [event.payload.forSeq, event.level]);

  it("goes to Lead at digest level with no context pack, and the card still opens", async () => {
    turnAutoReplyOff();
    const channels = hub(model());
    const item = await receive(channels, slack.dm("U0ETHAN", "顺便说一下，测试环境下午重启"));
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open" });
    expect(messages()).toMatchObject([{ level: "digest", payload: { cardId: item.cardId, forSeq: item.seq } }]);
    expect(listEvents(db, { kind: CONTEXT_EVENT })).toEqual([]);
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)).toMatchObject({
      payload: { forSeq: item.seq, action: "ask", reason: expect.stringContaining("并进摘要") },
    });
  });

  it("still wakes Lead for a message that needs a reply", async () => {
    turnAutoReplyOff();
    const channels = hub(model());
    const item = await receive(channels, slack.dm("U0ETHAN", "测试环境什么时候重启？"));
    expect(levelsOf()).toEqual([[item.seq, "tell"]]);
  });

  it("batches several such messages from one conversation, but not behind one that is waiting at tell level", async () => {
    turnAutoReplyOff();
    const channels = hub(model());
    const first = await receive(channels, slack.dm("U0ETHAN", "顺便说一下，测试环境下午重启"));
    const second = await receive(channels, slack.dm("U0ETHAN", "顺便说一下，重启大概十分钟"));
    expect(levelsOf()).toEqual([[first.seq, "digest"], [second.seq, "digest"]]);

    const question = await receive(channels, slack.dm("U0ETHAN", "测试环境什么时候重启？"));
    const third = await receive(channels, slack.dm("U0ETHAN", "顺便说一下，重启不影响生产"));
    expect(levelsOf().slice(2)).toEqual([[question.seq, "tell"], [third.seq, "tell"]]);
  });

  // 回归：上下文包按交接说明的 digest 跳过，消息事件却因为前面有 tell 级的请求在等而是 tell 级：Lead 单独看它，没有上下文包。
  it("packs the context for a message that stays at tell level behind a waiting request", async () => {
    turnAutoReplyOff();
    const channels = hub(model());
    await receive(channels, slack.dm("U0ETHAN", "测试环境什么时候重启？"));
    const third = await receive(channels, slack.dm("U0ETHAN", "顺便说一下，重启不影响生产"));
    const event = messages().at(-1)!;
    expect(event).toMatchObject({ level: "tell", payload: { forSeq: third.seq } });
    expect(listEvents(db, { kind: CONTEXT_EVENT }).map((packed) => packed.payload.messageEvent)).toContain(event.seq);
  });

  // 回归：收件时判断成紧急的（Lead 接着时系统不直接推送，由 Lead 决定告诉用户），要回的概率再低也不能等摘要。
  it("still wakes Lead, with a context pack, for an urgent message that needs no reply", async () => {
    turnAutoReplyOff();
    const channels = hub(model());
    const item = await receive(channels, slack.dm("U0ETHAN", "紧急：顺便说一下，生产库十分钟后切换"));
    const event = messages().at(-1)!;
    expect(event).toMatchObject({ level: "tell", payload: { forSeq: item.seq, inbound: { urgent: true } } });
    expect(pushes).toEqual([]);
    expect(listEvents(db, { kind: CONTEXT_EVENT }).map((packed) => packed.payload.messageEvent)).toEqual([event.seq]);
  });
});
