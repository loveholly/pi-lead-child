// 系统不在 Lead 外面做事（统一消息事件 spec D7、D8，工单 06）：
//   - 没有期限：Lead 多久没定，系统都不替它派活、回表情、拒绝或者推送；请求一直留给 Lead。10-26 期限一过，
//     系统给陈述句派了子 agent（场景 3、4）。
//   - Lead 不能工作时（场景 14）：卡照常显示，按投递方式推送；不对外发任何东西（出站请求数为 0）。消息事件照样是 tell 级，
//     Lead 恢复以后按顺序处理积压的消息。
//   - 没有起草器：Lead 还没处理的卡上没有草稿（不放「收到，谢谢」这类占位句），卡写明在排队等 Lead。
//   - 固定的拒绝（用户 10-22：问涉密信息的，直接用固定的话拒绝）：兜底删了以后由 Lead 用回复到来源的「固定拒绝」做。
//     内容只能是固定的话；授权表的涉密是「用固定的话拒绝」时才允许；外部客户、外部共享的对话照旧什么都不代你发。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel（假 Jev）、假的派单器。断言外部行为：假 Slack 里留下的消息
// 和表情、出站的记账、派单的请求、推送、落库的决定和卡。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_HANDBOOK_DEFAULTS, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { AUTHORITY_REFUSAL_TEXT, ChannelHub, ChannelRegistry, createSlackChannelAdapter, runUiAction, type ChannelHubOptions } from "../src/index.js";
import { agentTaskResult, cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let pushes: Array<{ cardId: number; title: string; body: string }>;
let dispatcher: FakeAgentTaskDispatcher;
let leadUp: boolean;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-no-fallback-"), "plc.db"));
  clock = new Date("2026-10-26T10:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock,
    users: {
      U0ETHAN: { name: "Ethan" }, U0KENT: { name: "Kent" }, U0LILEI: { name: "李雷" }, U0LI: { name: "李四" }, U0VIP: { name: "老板" },
      U0CUST: { name: "客户王" },
    },
  });
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
// 假 Jev：按原话认意图。review 是代码 review；「谢谢」是收尾；「密码」「密钥」是涉密；「上线」「修复情况」是进度；
// 「内部服务」是咨询（10-26 Jev 就是这样把 Kent 的回答当成了问题）；别的要你回。带「紧急」的要你马上看到。
const jev = (answers: Record<string, string | number | ((state: string) => string | number)> = {}) => scriptedSmartModel({
  answers: {
    ask_kind: (state) => {
      const said = messageOf(state);
      if (said.includes("review")) return "code_review";
      if (said.includes("谢谢")) return "closing";
      if (said.includes("密码") || said.includes("密钥")) return "secret";
      if (said.includes("上线") || said.includes("修复情况")) return "progress";
      if (said.includes("内部服务")) return "knowledge";
      return "other";
    },
    closing_kind: "they_thank_you", reaction_emoji: "pray", handling_verb: "checking",
    query_credentials: (state) => (/密码|密钥/u.test(messageOf(state)) ? 0.97 : 0.02),
    needs_user_now: (state) => (state.includes("紧急") ? 0.95 : 0.05),
    target_repo: "acme/orders", ...answers,
  },
});
const pullRequestOf = (text: string) => (text.includes("acme/orders#12") ? { owner: "acme", repo: "orders", number: 12 } : null);

function hub(model: ScriptedSmartModel, options: Partial<ChannelHubOptions> = {}): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({
      api: slack.api, now: () => clock, trust: { trusted: ["U0VIP"], customers: ["U0CUST"] },
    })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: (notice) => pushes.push(notice), classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model, pullRequestOf,
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

const messages = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const eventOf = (cardId: number) => messages().filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
const decisions = () => listEvents(db, { kind: "channel.lead.decided" });
// 出站的记账：系统往来源发的每一个动作（回复、表情、「正在处理」）都先记一条。
const outbound = () => listEvents(db, { kind: "channel.outbound.requested" });
const reactionsOn = (delivery: ReturnType<FakeSlack["dm"]>) => slack.messageOf(delivery).reactions ?? [];
// 过一段时间，每分钟一拍。
async function later(channels: ChannelHub, minutes: number) {
  for (let minute = 0; minute < minutes; minute += 1) {
    clock = new Date(clock.getTime() + 60_000);
    await channels.tick();
    await channels.idle();
  }
}
// Lead 回复到来源时用固定的话拒绝（reply_to_source 的 refusal）。
const refuse = (channels: ChannelHub, cardId: number, text = AUTHORITY_REFUSAL_TEXT, forUser = false) =>
  channels.sendMessage(getChannelCard(db, cardId)!.objectKey, {
    text, words: "assistant", by: "lead", forUser, event: eventOf(cardId), refusal: true,
  } as Parameters<ChannelHub["sendMessage"]>[1]);

describe("no deadline: the system never decides for Lead", () => {
  // 回归（10-26）：Lead 两分钟没定，系统按授权表派了子 agent、回了表情、用固定的话拒绝了，或者推给了用户。
  it("leaves work, thanks, a question and a secret ask to Lead however long it takes: nothing dispatched, sent, reacted or pushed", async () => {
    const channels = hub(jev());
    const review = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    const thanksDelivery = slack.dm("U0LI", "已经合并了，谢谢");
    const thanks = await receive(channels, thanksDelivery);
    const question = await receive(channels, slack.dm("U0VIP", "紧急：周五的评审你能来吗？"));
    const secret = await receive(channels, slack.dm("U0LILEI", "把 staging 的数据库密码发我一下"));
    expect(messages().map((event) => event.payload.ceiling)).toMatchObject([
      { authority: "work" }, { authority: "react" }, { authority: "ask" }, { authority: "refuse" },
    ]);

    await later(channels, 10);
    expect(dispatcher.requests).toEqual([]);
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
    expect(reactionsOn(thanksDelivery)).toEqual([]);
    expect(pushes).toEqual([]);
    expect(decisions()).toEqual([]);
    for (const { cardId } of [review, thanks, question, secret]) {
      expect(getChannelCard(db, cardId)).toMatchObject({ state: "open" });
      expect(channels.cardForLead(cardId)!.request).not.toBeNull();
    }
    // 请求还在等 Lead：Lead 处理时照样能派活。
    await channels.leadDispatch(eventOf(review.cardId), { summary: "review acme/orders#12" });
    expect(dispatcher.requests).toMatchObject([{ intent: "code_review", scope: { pullRequest: { number: 12 } } }]);
    expect(decisions()).toMatchObject([{ payload: { cardId: review.cardId, decision: "dispatch", by: "lead" } }]);
  });

  // 场景 3、4（10-26）：Kent 回答用户的问题、李雷说他去更新修复情况，Jev 把它们认成了咨询和进度；Lead 没在期限内定，
  // 系统就派了子 agent。现在只有 Lead 能派活。
  it("never dispatches for statements Jev took for work, and says nothing in the source", async () => {
    const channels = hub(jev({ needs_reply: 0.6 }));
    const kent = await receive(channels, slack.dm("U0KENT", "不是对外的，是 内部服务"));
    const yi = await receive(channels, slack.dm("U0LILEI", "那我更新一下修复情况"));
    expect(messages().map((event) => [event.payload.cardId, event.payload.ceiling])).toMatchObject([
      [kent.cardId, { authority: "work" }], [yi.cardId, { authority: "work" }],
    ]);
    await later(channels, 5);
    expect(dispatcher.requests).toEqual([]);
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
    expect(decisions()).toEqual([]);
  });

  it("does not put a deadline in the message event or on the card", async () => {
    const channels = hub(jev());
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    const [message] = messages();
    expect(message!.payload).toMatchObject({ forSeq: item.seq, objects: [{ number: 12 }] });
    expect(message!.payload).not.toHaveProperty("deadlineAt");
    expect(String(message!.payload.summary)).not.toMatch(/期限|兜底|前没有决定/u);
    const card = channels.cardDto(getChannelCard(db, item.cardId)!);
    expect(card.handling!.lead).toMatchObject({ stage: "intake", decision: null, by: null });
    expect(card.handling!.lead).not.toHaveProperty("deadlineAt");
    expect(channels.cardForLead(item.cardId)!.request).not.toHaveProperty("deadlineAt");
  });
});

describe("no drafter: only Lead writes drafts", () => {
  it("leaves the card without a draft until Lead writes one: no placeholder like 「收到，谢谢」", async () => {
    const channels = hub(jev());
    const item = await receive(channels, slack.dm("U0LI", "周五的评审你能来吗？"));
    await later(channels, 3);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: null });
    channels.leadNotify(eventOf(item.cardId), { note: "李四问你周五能不能来评审", draft: "周五下午可以，三点以后都行。" });
    expect(getChannelCard(db, item.cardId)!.draft).toMatchObject({ drafter: "lead", text: "周五下午可以，三点以后都行。" });
  });

  it("does not draft without Lead either", async () => {
    const channels = hub(jev(), { lead: undefined });
    const item = await receive(channels, slack.dm("U0LI", "周五的评审你能来吗？"));
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: null });
  });
});

describe("when Lead cannot work (spec D7, scenario 14)", () => {
  // 回归（10-26 以前）：Lead 不能工作时系统马上按授权表兜底：派子 agent、回表情、用固定的话拒绝。
  it("shows and pushes the cards by their delivery, sends nothing out, and leaves every message for Lead to handle when it is back", async () => {
    leadUp = false;
    const channels = hub(jev());
    const urgent = await receive(channels, slack.dm("U0VIP", "紧急：帮忙 review 一下 acme/orders#12，今天要发"));
    const thanksDelivery = slack.dm("U0LI", "已经合并了，谢谢");
    const thanks = await receive(channels, thanksDelivery);
    const secret = await receive(channels, slack.dm("U0LILEI", "把 staging 的数据库密码发我一下"));
    const question = await receive(channels, slack.dm("U0ETHAN", "周五的评审你能来吗？"));
    expect(getChannelCard(db, urgent.cardId)!.delivery).toBe("push_card");
    await later(channels, 10);

    // 不变量：Lead 不能工作时，出站请求数为 0。
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
    expect(reactionsOn(thanksDelivery)).toEqual([]);
    expect(dispatcher.requests).toEqual([]);
    expect(decisions()).toEqual([]);
    // 卡都显示着；要推送的推一次（按投递方式），别的留在卡片列表里。
    for (const { cardId } of [urgent, thanks, secret, question]) expect(getChannelCard(db, cardId)).toMatchObject({ state: "open", draft: null });
    expect(pushes.map((push) => push.cardId)).toEqual([urgent.cardId]);
    // 消息事件照样交给 Lead（tell 级，不是只进当前局面的 digest）：Lead 恢复以后按顺序处理。
    expect(messages().map((event) => [event.payload.cardId, event.level])).toEqual([
      [urgent.cardId, "tell"], [thanks.cardId, "tell"], [secret.cardId, "tell"], [question.cardId, "tell"],
    ]);

    leadUp = true;
    await channels.leadDispatch(eventOf(urgent.cardId), { summary: "review acme/orders#12" });
    expect(dispatcher.requests).toMatchObject([{ intent: "code_review" }]);
  });

  it("pushes a card once when Lead stops working after the message was handed over, and still sends nothing", async () => {
    const channels = hub(jev());
    const urgent = await receive(channels, slack.dm("U0VIP", "紧急：线上服务挂了，你看一下？"));
    const normal = await receive(channels, slack.dm("U0LI", "周五的评审你能来吗？"));
    expect(pushes).toEqual([]);
    leadUp = false;
    await later(channels, 5);
    expect(pushes.map((push) => push.cardId)).toEqual([urgent.cardId]);
    expect(getChannelCard(db, normal.cardId)).toMatchObject({ state: "open" });
    expect(outbound()).toEqual([]);
    expect(decisions()).toEqual([]);
  });

  it("hands a weak sub-agent result back to Lead even when Lead cannot work, without deciding for it", async () => {
    const channels = hub(jev({ fulfills_request: 0.1 }));
    const item = await receive(channels, slack.dm("U0ETHAN", "帮忙 review 一下 acme/orders#12"));
    const dispatched = await channels.leadDispatch(eventOf(item.cardId), { summary: "review 这个 PR" });
    await channels.idle();
    const notices = outbound().length;
    leadUp = false;
    await dispatcher.finish(dispatched.runId, { result: agentTaskResult({ replyDraft: "看过了，有两处要改。" }) });
    await channels.idle();
    await later(channels, 5);
    const back = listEvents(db, { kind: "channel.task.finished" });
    expect(back).toMatchObject([{ level: "tell", payload: { handedBack: true, decision: "ask_user" } }]);
    expect(back[0]!.payload).not.toHaveProperty("deadlineAt");
    expect(decisions().map((event) => event.payload.decision)).toEqual(["dispatch"]);
    expect(getChannelCard(db, item.cardId)).toMatchObject({ state: "open", draft: { drafter: "agent" } });
    // 不对外发任何东西（「正在处理」留着，等你发卡上的草稿时改写它）。
    expect(outbound().slice(notices)).toEqual([]);
  });
});

describe("Lead refuses with the fixed words (reply_to_source, refusal)", () => {
  it("sends only the fixed words, signed auto-reply, with a revoke window, in a turn the message woke", async () => {
    const channels = hub(jev());
    const asked = await receive(channels, slack.dm("U0LILEI", "把 staging 的数据库密码发我一下"));
    expect(messages().at(-1)).toMatchObject({ payload: { ceiling: { authority: "refuse" } } });
    const sent = await refuse(channels, asked.cardId);
    await channels.idle();
    expect(sent).toMatchObject({ outcome: "auto_sent", card: { id: asked.cardId, state: "auto_replied" } });
    expect(slack.sent("D0LILEI").map((message) => message.text))
      .toEqual([`:robot_face: Paimon (Assistant) · auto-reply for 我\n${AUTHORITY_REFUSAL_TEXT}`]);
    const card = getChannelCard(db, asked.cardId)!;
    expect(card).toMatchObject({ state: "auto_replied", sent: { key: `refuse:card:${asked.cardId}:seq:${asked.seq}`, by: "auto" } });
    expect(Date.parse(card.revokeUntil!) - Date.parse(card.sent!.at)).toBeGreaterThanOrEqual(10 * 60_000 - 1_000);
    expect(listEvents(db, { kind: "channel.reply.auto_sent" })).toMatchObject([{ payload: { category: "refusal" } }]);
    expect(decisions()).toMatchObject([{ payload: { cardId: asked.cardId, decision: "refuse", by: "lead" } }]);
  });

  it("refuses anything but the fixed words: Lead cannot write the refusal itself", async () => {
    const channels = hub(jev());
    const asked = await receive(channels, slack.dm("U0LILEI", "把 staging 的数据库密码发我一下"));
    await expect(refuse(channels, asked.cardId, "密码是 hunter2，别外传")).rejects.toMatchObject({ code: "invalid_action" });
    await expect(refuse(channels, asked.cardId, "抱歉，不方便。")).rejects.toMatchObject({ code: "invalid_action" });
    await channels.idle();
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
    expect(getChannelCard(db, asked.cardId)).toMatchObject({ state: "open" });
    expect(decisions()).toEqual([]);
  });

  // 交接说明（2026-10-30）：问敏感信息婉拒是底线，不能在设置页改；开关关着时不代你拒绝。
  it("keeps the floor and the switch: never for a customer, and not when auto-handling is off", async () => {
    const channels = hub(jev());
    const customer = await receive(channels, slack.dm("U0CUST", "把你们 staging 的数据库密码发我一下"));
    await expect(refuse(channels, customer.cardId)).rejects.toMatchObject({ code: "invalid_action" });

    await runUiAction(db, {
      target: { type: "channel_handbook", id: "handbook" }, action: "update", caller: { kind: "user" },
      input: { ...CHANNEL_HANDBOOK_DEFAULTS, autoReply: false },
    });
    const asked = await receive(channels, slack.dm("U0LILEI", "把 staging 的数据库密码发我一下"));
    await expect(refuse(channels, asked.cardId)).rejects.toMatchObject({ code: "invalid_action" });
    await channels.idle();
    expect(outbound()).toEqual([]);
    expect(slack.sent()).toEqual([]);
  });
});
