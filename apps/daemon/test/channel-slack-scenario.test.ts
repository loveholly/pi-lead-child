// 场景 9（Lead 事件主干 spec 的 Testing Decisions，工单 11）：Slack 私信走完通道框架的每一跳。
// daemon、网关、store、影子分诊管线、通道 hub 和 Slack 来源插件都是真的；Slack 是假的（engine/testing 的 FakeSlack），
// Jev（SmartModel）和 Lead 的会话是替身。断言外部行为：Lead 收到的输入、落库的事件和处置、网关上用户看到的卡、
// 假 Slack 里留下的消息。
//   1. Slack 的私信先分诊（外部来源 slack，按 source.slack 定级别），不管什么级别都不插进 Lead 正在进行的回合；
//   2. 请求 A 认出意图，授权表判断（落地计划 A5）：要你回的请求按常设指令投递成会话卡，交给 Lead；卡上没有占位草稿
//      （统一消息事件工单 06：草稿只由 Lead 写），卡写明在排队等 Lead，Slack 里什么也不发；
//   3. 用户在 Slack 里自己回复以后，卡自动结束（resolved_elsewhere），不再提醒；
//   4. 对方道谢：Lead 在他的消息上回表情；问薪资：Lead 用固定的话代你拒绝（回复到来源的固定拒绝，统一消息事件工单 06），
//      留撤回窗口、进摘要、处置带授权表的名字，用户可以在窗口里撤回；外部客户的消息什么都不代你发。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createLoopbackBinding, getChannelCard, getEvent, listEvents, openDb, writeLeadProfile, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { SmartAnswer, SmartModel, SmartQuestionSet } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack } from "@pi-lead-child/engine/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-channel-scenario-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的 Jev（请求 A 第 4 版）：对方原话里有「谢谢」是对方道谢的收尾（回 :pray:）；问薪资的是涉密；别的不属于这几类，要你回。
// 收件判断第 7 版（2026-10-30）：问的是交接说明里的一句（situation）。道谢是「道谢或者告别」；问薪资由敏感查询（薪酬）认出。
// 状态文本的第一段是对方的原话（intake.ts 的 channelIntakeState）。影子分诊固定的问题按中间的选项回答。
function fakeJev(): SmartModel & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    backend: "fake-jev",
    asked,
    async decide(state: string, questions: SmartQuestionSet) {
      asked.push(Object.keys(questions));
      const said = state.split("\n\n")[0] ?? "";
      const thanks = said.includes("谢谢");
      const secret = said.includes("薪资");
      const answers: Record<string, SmartAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        if (question.type === "choice") {
          const choice = name === "situation" ? (thanks ? "closing" : "other")
            : name === "closing_kind" ? "they_thank_you" : name === "reaction_emoji" ? "pray"
            : name === "importance" ? "digest" : question.options.at(-1)!;
          const rest = 0.04 / (question.options.length - 1);
          answers[name] = {
            type: "choice", choice, confidence: 0.95,
            probabilities: Object.fromEntries(question.options.map((option) => [option, option === choice ? 0.96 : rest])),
          };
        } else if (question.type === "score") {
          const level = 1;
          answers[name] = {
            type: "score", level, label: question.levels[level]!, score: level, confidence: 0.9,
            probabilities: question.levels.map((_label, index) => (index === level ? 1 : 0)),
          };
        } else {
          // 用户自己在 Slack 里的话回答了对方（工单 04：由 SmartModel 判断「别处已处理」）。
          // 这些私信都要用户回（请求 A 的 needs_reply）：开卡。
          answers[name] = {
            type: "yes_no",
            probability: name === "query_hr_compensation" && secret ? 0.95
              : name.startsWith("topic_") || name.startsWith("query_") ? 0.02
              : name === "answers_request" || name === "needs_reply" ? 0.9 : 0.3,
          };
        }
      }
      return { answers: answers as never, backend: "fake-jev", model: "jev-test", latencyMs: 1, fallbackFrom: null };
    },
  };
}

async function boot(options: { lead: ReturnType<typeof fakePiLead>; slack: FakeSlack; jev: SmartModel; customers?: string[] }) {
  const pushes: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: (text) => pushes.push(text),
    // 通道的请求 A（意图、要不要回）和「用户自己的话回答了没有」问 Lead 会话的 SmartModel：这里也是假的 Jev。
    sessionFactory: (async (args: any) => ({ ...(await options.lead.factory(args)), smartModel: options.jev })) as never,
    triageShadow: { smartModel: options.jev, retryBaseMs: 0, idleIntervalMs: 0, timeoutMs: 2_000 },
    channels: {
      sources: { slack: { api: options.slack.api, trust: { customers: options.customers ?? [] } } },
      credentials: { credential: async (provider) => (provider === "slack" ? options.slack.credential : null) },
      // 抽查（落地计划 D2）是随机的：这里关掉。
      audit: { rate: 0 },
    },
  });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const cards = async () => (await call("GET", "/v1/channels/cards")).body.items as any[];
  // 用户的消息从网关进来（和 companion 一样）。
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${owner.accessToken}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
  };
  return { call, cards, send, pushes, events };
}

describe("scenario 9: a Slack DM through the channel framework", () => {
  it("triages it, never steers it into Lead's turn, delivers a card queued for Lead, and ends the card when the user replies in Slack", async () => {
    const slack = new FakeSlack({ users: { U0EXT: { name: "外部的人", team: "T0OTHER" } } });
    const jev = fakeJev();
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      if (call.inputs.join("\n").includes("问题 A")) {
        await holdA.promise;
        return { say: "A 的回答。" };
      }
      return { say: "好的。" };
    });
    const { call, cards, send, events: gatewayEvents } = await boot({ lead, slack, jev });

    // Lead 正忙：用户问了 A，这一轮卡着。
    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));

    // 张三的 Slack 私信进来：外部来源 slack，按常设指令 source.slack 分诊（进摘要）。
    const dm = slack.dm("U0ZHANG", "周五评审的材料你看了吗？");
    const received = await daemon!.channels!.receive("slack", dm);
    expect(received).toMatchObject({ accepted: true, items: [{ inserted: true, kind: "slack.dm.received", delivery: "card" }] });
    const { seq } = received.items[0]!;
    // 先判断要不要用户回，再开卡（用户 2026-10-21）：等卡开出来。
    await vi.waitFor(() => expect(cardIdOf(db, received.items[0]!)).not.toBeNull(), { timeout: 5_000 });
    const cardId = cardIdOf(db, received.items[0]!);
    expect(getEvent(db, seq!)).toMatchObject({
      source: "slack", entityKey: "slack:D0ZHANG:main", level: "digest", triage: { order: { id: "source.slack" } },
    });
    // Slack 重发同一次投递：只记一次。
    expect((await daemon!.channels!.receive("slack", slack.redeliver(dm))).items[0]!.inserted).toBe(false);
    expect(listEvents(db, { kind: "slack.dm.received" })).toHaveLength(1);
    // 投递方式写在事件上。会话卡投递的消息有自己的卡：06 的「Lead 动态」不再放一张，也不进 interrupt 横幅（Slack 最高 tell）。
    // 外部的人在频道里提到你：摘要投递，它就是「Lead 动态」里的一张卡。
    expect(getEvent(db, seq!)!.payload.channelDelivery).toBe("card");
    const mention = await daemon!.channels!.receive("slack", slack.mention("U0EXT", "能给个报价吗？"));
    expect(mention.items[0]).toMatchObject({ delivery: "digest" });
    const activity = (await call("GET", "/v1/lead/activity?include=events")).body;
    expect(activity.cards.map((entry: any) => entry.entityKey)).toContain(mention.items[0]!.objectKey);
    expect(activity.cards.map((entry: any) => entry.entityKey)).not.toContain("slack:D0ZHANG:main");
    expect(activity.interrupts).toEqual([]);
    expect((await cards()).find((candidate) => candidate.objectKey === mention.items[0]!.objectKey)).toMatchObject({ delivery: "digest" });

    // 任何级别都不插进 Lead 的回合：另一条私信被定成 interrupt（外部来源的分诊本来到不了这一级），这条升到 tell。
    const urgent = await daemon!.channels!.receive("slack", slack.dm("U0LI", "紧急：线上服务挂了吗？"));
    db.prepare("UPDATE events SET level = 'interrupt' WHERE seq = ?").run(urgent.items[0]!.seq);
    db.prepare("UPDATE events SET level = 'tell' WHERE seq = ?").run(seq);
    await pause(400);
    expect(lead.queued().steering).toEqual([]);
    expect(lead.calls).toHaveLength(1);
    expect(lead.calls[0]!.inputs.join("\n")).not.toContain("线上服务挂了");

    // 请求 A 问了意图和收尾的种类；授权表判断：不是收尾、会议、涉密，也不用干活 → 开卡问你，交给 Lead；Lead 写草稿以前卡上没有草稿。
    expect(jev.asked.some((names) => names.includes("situation") && names.includes("closing_kind"))).toBe(true);
    expect(listEvents(db, { kind: "channel.authority.decided" }).find((event) => event.payload.cardId === cardId)).toMatchObject({
      level: "record", payload: { forSeq: seq, intent: "other", action: "ask" },
    });
    await vi.waitFor(() => expect(listEvents(db, { kind: "message.received" }).some((event) => event.payload.cardId === cardId)).toBe(true), { timeout: 5_000 });
    // 用户看到的那一跳：网关的 /v1/channels/cards。卡上有发信人、原文摘录、在排队等 Lead，和能做的动作。
    await vi.waitFor(() => expect(gatewayEvents.some((event) => event.type === "snapshot.required"
      && event.payload?.resource === "channel-cards")).toBe(true));
    const card = (await cards()).find((candidate) => candidate.id === cardId);
    expect(card).toMatchObject({
      source: "slack", sourceLabel: "Slack", laneLabel: "张三的私信", sender: { name: "张三", trust: "colleague" },
      delivery: "card", state: "open", draft: null, handling: { lead: { stage: "intake", decision: null } },
      gate: null, actions: ["send_edited", "reply_myself", "snooze", "dismiss", "handled"],
    });
    expect(card.handling.lead).not.toHaveProperty("deadlineAt");
    expect(card.excerpt).toContain("周五评审的材料");
    // 问你：Slack 里没有替用户发任何东西。
    expect(slack.sent()).toEqual([]);

    // Lead 答完 A。两条私信都排在这一轮后面：interrupt 和 tell 级的各自单独一轮，不是插话。
    holdA.resolve();
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    const later = lead.calls.slice(1).map((call) => call.inputs.join("\n")).join("\n");
    await vi.waitFor(() => expect(lead.calls.slice(1).map((call) => call.inputs.join("\n")).join("\n")).toContain("线上服务挂了"), { timeout: 5_000 });
    expect(later.length).toBeGreaterThan(0);
    // 当前局面里每条道一行。
    const situations = lead.calls.slice(1).map((call) => call.situation ?? "").join("\n");
    expect(situations).toContain("Slack · 张三的私信");

    // 用户在 Slack 里自己回复了（SmartModel 判断它回答了对方）：卡自动结束（别处已处理），这张卡的事件处置是 resolved_elsewhere。
    const self = await daemon!.channels!.receive("slack", slack.selfReply("D0ZHANG", "收到了，周五见"));
    expect(self.items[0]).toMatchObject({ role: "self_reply", cardId });
    await daemon!.channels!.idle();
    expect(getChannelCard(db, cardId!)!.state).toBe("resolved_elsewhere");
    expect(getEvent(db, seq!)!.disposition).toBe("resolved_elsewhere");
    expect(getEvent(db, self.items[0]!.seq!)!.level).toBe("record");
    // 不再提醒：之后的几十拍里，这张卡没有推送，也没有可做的动作。
    const after = (await cards()).find((candidate) => candidate.id === cardId);
    expect(after).toMatchObject({ state: "resolved_elsewhere", actions: [] });
    const lines = (await cards()).length;
    await pause(300);
    expect((await cards()).find((candidate) => candidate.id === cardId)).toMatchObject({ state: "resolved_elsewhere" });
    expect((await cards()).length).toBe(lines);
  }, 30_000);

  it("reacts to thanks, refuses a question about salaries inside a revoke window, and never acts for a customer", async () => {
    const slack = new FakeSlack({ users: { U0CUST: { name: "客户王", team: "T0ACME" } } });
    const jev = fakeJev();
    const lead = fakePiLead(async () => ({ say: "好的。" }));
    const { call, cards } = await boot({ lead, slack, jev, customers: ["T0ACME"] });

    // 李四道谢（用户 2026-10-26：能代你回的都先交给 Lead）：系统不自己回表情，开一张不推送的卡，用消息事件叫醒 Lead
    // （统一消息事件工单 05：消息事件就是请求）；Lead 看了上下文回 :pray:（通用的回表情，这里直接调 hub 的 react），卡结束。
    const thanks = slack.dm("U0LISI", "已经合并了，谢谢");
    const thanked = (await daemon!.channels!.receive("slack", thanks)).items[0]!;
    await vi.waitFor(() => expect(cardIdOf(db, thanked)).not.toBeNull(), { timeout: 5_000 });
    const thanksCard = cardIdOf(db, thanked)!;
    await vi.waitFor(() => expect(listEvents(db, { kind: "message.received" }).at(-1)).toMatchObject({
      level: "tell", payload: { cardId: thanksCard, text: "已经合并了，谢谢", external: true, ceiling: { authority: "react" } },
    }), { timeout: 5_000 });
    expect(listEvents(db, { kind: "channel.lead.requested" })).toEqual([]);
    expect(slack.messageOf(thanks).reactions ?? []).toEqual([]);
    await daemon!.channels!.react(getChannelCard(db, thanksCard)!.objectKey, { emoji: "pray", by: "lead" });
    expect(slack.messageOf(thanks).reactions).toEqual([{ name: "pray", users: [slack.credential.account] }]);
    expect(getChannelCard(db, thanksCard)).toMatchObject({ state: "handled", resolution: { by: "lead", action: "handled" } });
    expect(getEvent(db, thanked.seq!)!.disposition).toBe("handled");
    const activity = (await call("GET", "/v1/lead/activity?include=events")).body;
    expect(activity.cards.map((entry: any) => entry.entityKey)).toContain(thanked.objectKey);
    expect(slack.sent()).toEqual([]);

    // 张三问薪资：用固定的话代你拒绝，带披露署名，留撤回窗口；进摘要，处置带授权表的名字。
    // 2026-10-22：署名里的助手名跟 Lead 的名字（设置 → 身份与风格）。运行中改了名字，下一条代发的消息就用新名字。
    writeLeadProfile(db, { name: "Jarvis", persona: "", interactionStyle: "" }, { by: "user", at: new Date() });
    const asked = (await daemon!.channels!.receive("slack", slack.dm("U0ZHANG", "你们组小王的薪资大概多少？"))).items[0]!;
    await vi.waitFor(() => expect(cardIdOf(db, asked)).not.toBeNull(), { timeout: 5_000 });
    const refused = cardIdOf(db, asked)!;
    // 授权表要拒绝：先交给 Lead，系统自己什么也不发（没有期限和兜底，工单 06）。Lead 在 Slack 叫醒的一轮里用回复到来源的
    // 固定拒绝（这里直接调 hub 的 sendMessage，和操作层一样）。
    const refusalEvent = await vi.waitFor(() => {
      const event = listEvents(db, { kind: "message.received" }).at(-1);
      expect(event).toMatchObject({ payload: { cardId: refused, ceiling: { authority: "refuse" } } });
      return event!.seq;
    }, { timeout: 5_000 });
    await pause(300);
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(getChannelCard(db, refused)!.state).toBe("open");
    await daemon!.channels!.sendMessage(getChannelCard(db, refused)!.objectKey, {
      text: "抱歉，这涉及个人或公司的敏感信息，我这边不方便提供。", words: "assistant", by: "lead", forUser: false, event: refusalEvent, refusal: true,
    });
    expect(getChannelCard(db, refused)!.state).toBe("auto_replied");
    const refusal = getChannelCard(db, refused)!;
    expect(Date.parse(refusal.revokeUntil!) - Date.parse(refusal.sent!.at)).toBeGreaterThanOrEqual(10 * 60_000 - 1_000);
    const replies = slack.sent("D0ZHANG");
    expect(replies.map((message) => message.text))
      .toEqual([":robot_face: Jarvis (Assistant) · auto-reply for 我\n抱歉，这涉及个人或公司的敏感信息，我这边不方便提供。"]);
    expect(listEvents(db, { kind: "channel.reply.auto_sent" }).at(-1)).toMatchObject({
      level: "auto", disposition: "auto_handled", dispositionDetail: { standingOrder: { id: "channel.authority", version: 1 } },
      payload: { category: "refusal" },
    });
    expect(getEvent(db, asked.seq!)!.disposition).toBe("auto_handled");
    // Slack 把这条回复推回来：认出是系统发的，不算用户自己回复。
    const echo = await daemon!.channels!.receive("slack", slack.echoOf(replies[0]!));
    expect(echo.items[0]).toMatchObject({ role: "echo", inserted: true });
    expect(getChannelCard(db, refused)!.state).toBe("auto_replied");

    // 撤回窗口里撤回：Slack 里那条删掉了，卡回到等用户处理。
    expect((await cards()).find((candidate) => candidate.id === refused)).toMatchObject({ state: "auto_replied", actions: ["undo_auto_reply"], gate: null });
    const undone = await call("POST", `/v1/channels/cards/${refused}/actions`, { action: "undo_auto_reply" });
    expect(undone.status).toBe(200);
    expect(undone.body.card).toMatchObject({ state: "open" });
    expect(slack.sent("D0ZHANG")).toEqual([]);
    expect(listEvents(db, { kind: "channel.reply.retracted" })).toHaveLength(1);

    // 外部客户（底线）：道谢也不回表情；问薪资也只开卡问你，什么都不代你发。
    const customerThanks = slack.dm("U0CUST", "合同我签好了，谢谢");
    const fromCustomer = (await daemon!.channels!.receive("slack", customerThanks)).items[0]!;
    await vi.waitFor(() => expect(listEvents(db, { kind: "channel.authority.decided" })
      .find((event) => event.payload.forSeq === fromCustomer.seq)).toMatchObject({ payload: { action: "skip" } }), { timeout: 5_000 });
    expect(slack.messageOf(customerThanks).reactions ?? []).toEqual([]);
    const customerAsk = (await daemon!.channels!.receive("slack", slack.dm("U0CUST", "你们的薪资结构是怎样的？"))).items[0]!;
    await vi.waitFor(() => expect(cardIdOf(db, customerAsk)).not.toBeNull(), { timeout: 5_000 });
    expect(getChannelCard(db, cardIdOf(db, customerAsk)!)!.state).toBe("open");
    // 第 7 版：意图由选中的一句推出（兜底的一句 → other）；涉密由敏感查询认出，结论照旧是问你。
    expect(listEvents(db, { kind: "channel.authority.decided" }).at(-1)).toMatchObject({ payload: { intent: "other", action: "ask" } });
    expect(slack.sent()).toEqual([]);
  }, 30_000);
});
