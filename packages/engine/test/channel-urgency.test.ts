// 别人发来的消息紧不紧急，由通道内核问 SmartModel 定（用户 2026-10-19：自然语言永远不用正则匹配）。
// 来源插件只交出结构化的事实，不给结论；内核对所有来源用同一个问题，结果和依据写进事件 payload 的 urgent、urgency，
// 投递指令的条件（payload.urgent）不变。SmartModel 不可用、超时、出错时按不紧急处理：照常入库、开卡，不推送。
// 用真的 SQLite、真的 Slack 来源插件和假的 Slack；SmartModel 是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCard, getChannelLane, getEvent, listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  CHANNEL_URGENCY_PURPOSE, CHANNEL_URGENCY_QUESTION_VERSION, CHANNEL_URGENCY_TEXT_MAX, CHANNEL_URGENCY_THRESHOLD,
  ChannelHub, ChannelRegistry, channelUrgencyQuestions, createSlackChannelAdapter, parseLlmReply,
  type ChannelHubOptions, type SmartDecideOptions, type SmartModel, type SmartQuestionSet,
} from "../src/index.js";
import { cardIdOf, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let pushes: Array<{ cardId: number; title: string; body: string }>;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-urgency-"), "plc.db"));
  slack = new FakeSlack({ users: { U0VIP: { name: "老板" }, U0OPS: { name: "值班的人" } } });
  pushes = [];
  logs = [];
});

afterEach(() => {
  db.close();
});

interface StubCall { state: string; questions: SmartQuestionSet; opts: SmartDecideOptions | undefined }

// SmartModel 的替身：每个问题都按 yes_no 回答，「是」的概率由 reply 定。reply 可以抛错，也可以一直不回答。
function stubModel(reply: (state: string) => number | Promise<number>, backend = "fake-jev") {
  const calls: StubCall[] = [];
  const model: SmartModel = {
    backend,
    async decide(state, questions, opts) {
      // 请求 A、判断用户自己的话（工单 04）也问 SmartModel：这里只看紧急程度，别的用途按不可用处理。
      if (opts?.purpose !== CHANNEL_URGENCY_PURPOSE) throw new Error(`${backend}: not asked in this test`);
      calls.push({ state, questions, opts });
      const probability = await reply(state);
      const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability }]));
      return { answers: answers as never, backend, model: "jev-test", latencyMs: 1, fallbackFrom: null };
    },
  };
  return { model, calls };
}

function hub(options: Partial<ChannelHubOptions> = {}): ChannelHub {
  return new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, trust: { trusted: ["U0VIP", "U0OPS"] } })]),
    credentials: { credential: async () => slack.credential },
    push: (notice) => pushes.push(notice),
    log: (line) => logs.push(line),
    ...options,
  });
}

const payloadOf = (seq: number | null) => getEvent(db, seq!)!.payload;

describe("regression: urgency comes from the model, not from keywords in the text", () => {
  it("does not push '这个不急，不用 asap' from a trusted sender when the model says it can wait", async () => {
    const { model } = stubModel(() => 0.05);
    const channels = hub({ smartModel: () => model });
    const item = (await channels.receive("slack", slack.dm("U0VIP", "这个不急，不用 asap"))).items[0]!;
    expect(item).toMatchObject({ inserted: true, delivery: "card" });
    expect(pushes).toEqual([]);
    expect(payloadOf(item.seq)).toMatchObject({ urgent: false, channelDelivery: "card" });
  });

  it("pushes '服务挂了，客户在等你' from a trusted sender when the model says the user must see it now", async () => {
    const { model } = stubModel(() => 0.95);
    const channels = hub({ smartModel: () => model });
    const item = (await channels.receive("slack", slack.dm("U0OPS", "服务挂了，客户在等你"))).items[0]!;
    expect(item).toMatchObject({ inserted: true, delivery: "push_card" });
    // 先判断要不要用户回，再开卡、推送。
    await channels.idle();
    expect(pushes).toEqual([{ cardId: cardIdOf(db, item), title: "Slack · 值班的人", body: "服务挂了，客户在等你" }]);
    expect(payloadOf(item.seq)).toMatchObject({ urgent: true, channelDelivery: "push_card" });
  });

  it("the Slack adapter itself gives no urgency verdict", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api });
    const parsed = await adapter.parse(slack.dm("U0VIP", "紧急！ASAP"), { credential: slack.credential, log: () => {} });
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]!.fields)).not.toContain("urgent");
  });
});

describe("the urgency decision", () => {
  it("pushes and opens a card above the threshold, and records the basis on the event", async () => {
    const { model, calls } = stubModel(() => 0.93);
    const channels = hub({ smartModel: () => model, urgencyTimeoutMs: 1_234 });
    const item = (await channels.receive("slack", slack.dm("U0VIP", "数据库主库连不上了，订单全卡住"))).items[0]!;
    expect(item.delivery).toBe("push_card");
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ delivery: "push_card", state: "open" });
    expect(pushes).toHaveLength(1);
    expect(payloadOf(item.seq)).toMatchObject({
      urgent: true,
      urgency: {
        by: "smart_model", reason: null, backend: "fake-jev", model: "jev-test", probability: 0.93,
        threshold: CHANNEL_URGENCY_THRESHOLD, fallbackFrom: null, error: null, questionVersion: CHANNEL_URGENCY_QUESTION_VERSION,
      },
    });
    // 一个 yes_no 问题，带用途和短的超时。
    expect(calls).toHaveLength(1);
    expect(Object.values(calls[0]!.questions).map((question) => question.type)).toEqual(["yes_no"]);
    expect(calls[0]!.opts).toMatchObject({ purpose: CHANNEL_URGENCY_PURPOSE, timeoutMs: 1_234 });
    expect(calls[0]!.opts!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.state).toContain("数据库主库连不上了，订单全卡住");
  });

  it("only opens a card below the threshold, even for a trusted sender in a direct message", async () => {
    const { model } = stubModel(() => CHANNEL_URGENCY_THRESHOLD - 0.01);
    const channels = hub({ smartModel: () => model });
    const item = (await channels.receive("slack", slack.dm("U0VIP", "下周的周报模板改一下"))).items[0]!;
    expect(item.delivery).toBe("card");
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, item)!)!.delivery).toBe("card");
    expect(pushes).toEqual([]);
    expect(payloadOf(item.seq)).toMatchObject({ urgent: false, urgency: { by: "smart_model", probability: CHANNEL_URGENCY_THRESHOLD - 0.01 } });
  });

  it("treats a failing model as not urgent: the card still opens, nothing is pushed, and the event says it was a fallback", async () => {
    const { model, calls } = stubModel(() => { throw new Error("jev: 503 upstream unavailable"); });
    const channels = hub({ smartModel: () => model });
    const item = (await channels.receive("slack", slack.dm("U0VIP", "服务挂了，客户在等你"))).items[0]!;
    expect(calls).toHaveLength(1);
    expect(item).toMatchObject({ inserted: true, delivery: "card" });
    await channels.idle();
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ delivery: "card", state: "open" });
    expect(pushes).toEqual([]);
    expect(payloadOf(item.seq)).toMatchObject({
      urgent: false, urgency: { by: "fallback", reason: "error", probability: null, backend: "fake-jev", error: expect.stringContaining("503") },
    });
    expect(logs.filter((line) => line.includes("not urgent"))).toHaveLength(1);
  });

  it("treats a model that does not answer in time as not urgent, without holding the message back", async () => {
    const { model } = stubModel(() => new Promise<number>(() => {}));
    const channels = hub({ smartModel: () => model, urgencyTimeoutMs: 30 });
    const started = Date.now();
    const item = (await channels.receive("slack", slack.dm("U0VIP", "服务挂了，客户在等你"))).items[0]!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(item).toMatchObject({ inserted: true, delivery: "card" });
    expect(pushes).toEqual([]);
    expect(payloadOf(item.seq)).toMatchObject({ urgent: false, urgency: { by: "fallback", reason: "timeout", probability: null } });
    expect(logs.some((line) => line.includes("timeout") && line.includes("not urgent"))).toBe(true);
  });

  it("treats a missing model, or one with no backend, as not urgent", async () => {
    for (const smartModel of [undefined, () => null, () => ({ backend: "none", decide: async () => { throw new Error("no backend"); } }) as SmartModel]) {
      const channels = hub(smartModel ? { smartModel } : {});
      const item = (await channels.receive("slack", slack.dm("U0VIP", "服务挂了，客户在等你"))).items[0]!;
      expect(item.delivery).toBe("card");
      expect(payloadOf(item.seq)).toMatchObject({ urgent: false, urgency: { by: "fallback", reason: "unavailable", backend: null } });
    }
    expect(pushes).toEqual([]);
  });

  it("redacts secrets and caps the text before the model sees it", async () => {
    const { model, calls } = stubModel(() => 0.1);
    const channels = hub({ smartModel: () => model });
    const token = `ghp_${"Z9".repeat(20)}`;
    const text = `线上挂了，先用这个顶一下：${token} ${"后面很长的说明。".repeat(1_000)}`;
    await channels.receive("slack", slack.dm("U0VIP", text));
    expect(calls).toHaveLength(1);
    const state = calls[0]!.state;
    expect(state).not.toContain(token);
    expect(state).toContain("[REDACTED]");
    expect(state).toContain("线上挂了");
    expect(state.length).toBeLessThan(CHANNEL_URGENCY_TEXT_MAX + 200);
  });

  it("does not ask about the user's own replies, echoes of system replies, or messages from bots", async () => {
    const { model, calls } = stubModel(() => 0.99);
    const channels = hub({ smartModel: () => model });
    await channels.receive("slack", slack.dm("U0VIP", "在吗"));
    expect(calls).toHaveLength(1);
    await channels.idle();
    const self = (await channels.receive("slack", slack.selfReply("D0VIP", "在，怎么了"))).items[0]!;
    const second = (await channels.receive("slack", slack.dm("U0VIP", "收到"))).items[0]!;
    await channels.idle();
    await channels.act(cardIdOf(db, second)!, "send_edited", { by: "user via test", text: "好的" });
    const echo = (await channels.receive("slack", slack.echoOf(slack.sent("D0VIP")[0]!))).items[0]!;
    const bot = (await channels.receive("slack", slack.dm("U0BOT", "构建 #812 失败了", { bot: true }))).items[0]!;
    expect(calls).toHaveLength(2);
    expect(payloadOf(self.seq)).toMatchObject({ role: "self_reply", urgent: false });
    expect(payloadOf(self.seq).urgency).toBeUndefined();
    expect(payloadOf(echo.seq)).toMatchObject({ role: "echo", urgent: false });
    expect(payloadOf(echo.seq).urgency).toBeUndefined();
    // 机器人发的消息只记录（投递指令的种子修订 4，用户 2026-10-21），所以连问都不问。
    expect(payloadOf(bot.seq)).toMatchObject({
      role: "message", sender: { bot: true }, urgent: false, channelDelivery: "record",
      urgency: { by: "not_asked", reason: "record_only", probability: null },
    });
  });

  it("a plain yes from the uncalibrated LLM fallback still reaches the threshold; a plain no does not", () => {
    const questions = channelUrgencyQuestions();
    const [name] = Object.keys(questions);
    const yes = parseLlmReply(questions, JSON.stringify({ [name!]: { yes: true } }));
    const no = parseLlmReply(questions, JSON.stringify({ [name!]: { yes: false } }));
    expect((yes as Record<string, { probability: number }>)[name!]!.probability).toBeGreaterThanOrEqual(CHANNEL_URGENCY_THRESHOLD);
    expect((no as Record<string, { probability: number }>)[name!]!.probability).toBeLessThan(CHANNEL_URGENCY_THRESHOLD);
  });
});

describe("asking before recording keeps identity and order", () => {
  it("asks once and records once when the source delivers the same message again while the model is thinking", async () => {
    let answer!: (probability: number) => void;
    const { model, calls } = stubModel(() => new Promise<number>((resolve) => { answer = resolve; }));
    const channels = hub({ smartModel: () => model, urgencyTimeoutMs: 5_000 });
    const delivery = slack.dm("U0VIP", "服务挂了，客户在等你");
    const first = channels.receive("slack", delivery);
    const again = channels.receive("slack", slack.redeliver(delivery));
    await expect.poll(() => calls.length).toBe(1);
    answer(0.95);
    const [one, two] = await Promise.all([first, again]);
    expect([one.items[0]!.inserted, two.items[0]!.inserted].sort()).toEqual([false, true]);
    expect(one.items[0]!.seq).toBe(two.items[0]!.seq);
    expect(listEvents(db, { kind: "slack.dm.received" })).toHaveLength(1);
    // 推送在收件判断以后（后台）：等 hub 做完再看。
    await channels.idle();
    expect(pushes).toHaveLength(1);
    // 已经记过的投递再来一次：不再问。
    const late = await channels.receive("slack", slack.redeliver(delivery));
    expect(late.items[0]!.inserted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it("records messages in the order they arrived, even when the model answers the later one first", async () => {
    let answerFirst!: (probability: number) => void;
    const { model } = stubModel((state) => state.includes("第一条")
      ? new Promise<number>((resolve) => { answerFirst = resolve; })
      : 0.1);
    const channels = hub({ smartModel: () => model, urgencyTimeoutMs: 5_000 });
    const first = channels.receive("slack", slack.dm("U0VIP", "第一条：先停一下发布"));
    const second = channels.receive("slack", slack.dm("U0VIP", "第二条：好了，可以继续"));
    // 第二条的回答先到，但它要排在第一条后面入库。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listEvents(db, { kind: "slack.dm.received" })).toEqual([]);
    answerFirst(0.95);
    const [one, two] = await Promise.all([first, second]);
    expect(one.items[0]!.seq!).toBeLessThan(two.items[0]!.seq!);
    // 两条都先判断要不要用户回，再开卡：判断谁先完都一样，并成一张卡，从第一条算起，推送一次。
    await channels.idle();
    expect(cardIdOf(db, two.items[0]!)).toBe(cardIdOf(db, one.items[0]!));
    expect(getChannelCard(db, cardIdOf(db, one.items[0]!)!)).toMatchObject({
      delivery: "push_card", messageCount: 2, excerpt: "第二条：好了，可以继续", firstSeq: one.items[0]!.seq, lastSeq: two.items[0]!.seq,
    });
    expect(pushes).toHaveLength(1);
    expect(getChannelLane(db, "slack:D0VIP:main")!.context.map((message) => message.text)).toEqual([
      "第一条：先停一下发布", "第二条：好了，可以继续",
    ]);
  });

  it("idle() waits for messages that are still being judged", async () => {
    let answer!: (probability: number) => void;
    const { model, calls } = stubModel(() => new Promise<number>((resolve) => { answer = resolve; }));
    const channels = hub({ smartModel: () => model, urgencyTimeoutMs: 5_000 });
    const pending = channels.receive("slack", slack.dm("U0VIP", "在吗"));
    await expect.poll(() => calls.length).toBe(1);
    let idle = false;
    const waiting = channels.idle().then(() => { idle = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    answer(0.2);
    await waiting;
    expect(listEvents(db, { kind: "slack.dm.received" })).toHaveLength(1);
    await pending;
  });
});
