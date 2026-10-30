// 统一的消息事件（unified-message-events spec D1、D2、D6，工单 03）：外部通道共用的入站层。
// 别人在外部通道发给用户的消息通过入站层（身份和去重、Jev 判定、外部标记、权限上限）以后，产生一条消息事件
// （message.received）：Lead 收到的就是它，带正文，正文是外部的。工单 05 以后它就是交给 Lead 的请求，不再另记 channel.lead.requested。
// 编辑：Lead 处理以前并进排着的那条消息事件，不产生新的 Lead 输入，也不再问一次 Jev；Lead 处理以后按新消息再走一遍入站判断。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack、假的 SmartModel、假的派单器。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_INTENT_GRANT_BOUNDS, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, editMergeOf, inboundConclusions, messageCeiling, type ChannelHubOptions,
  type SmartModel,
} from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let dispatcher: FakeAgentTaskDispatcher;
// Lead 已经拿走（交给了它的一轮）的消息事件。
let taken: Set<number>;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-inbound-"), "plc.db"));
  clock = new Date("2026-10-26T02:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0LILEI: { name: "李雷" } } });
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
  taken = new Set();
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 原话里问「上线」的是问进度（要干活）。
const jev = () => scriptedSmartModel({
  answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("上线") ? "progress" : "other"), target_repo: "acme/orders" },
});

function hub(model: SmartModel, options: Partial<ChannelHubOptions> = {}): ChannelHub {
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, classifyTimeoutMs: 60_000, smartModel: () => model,
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    lead: { dispatcher, available: () => true, taken: (seq) => taken.has(seq) },
    audit: { rate: 0 },
    ...options,
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const queued = () => messageEvents().filter((event) => event.disposition !== "superseded");
const requests = () => listEvents(db, { kind: "channel.lead.requested" });
// 问过几次 Jev（请求 A）：一条消息一次。
const intakes = () => listEvents(db, { kind: "channel.intake.decided" }).length;
const tsOf = (delivery: { body: string }) => (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;

const V1 = "明哥，orders 和 billing 都上线了吗？";
const V2 = "明哥，orders、billing 和 ledger 都上线了吗？";
const V3 = "明哥，orders、billing 和 ledger 三个仓库今天都上线了吗？";

describe("a message from an external channel becomes one message event (spec D1)", () => {
  it("carries every field, with the body marked external, and is itself the request: no separate channel request", async () => {
    const channels = hub(jev());
    const dm = slack.dm("U0LILEI", V1);
    const item = (await channels.receive("slack", dm)).items[0]!;
    await channels.idle();
    const cardId = cardIdOf(db, item)!;
    expect(messageEvents()).toHaveLength(1);
    expect(messageEvents()[0]).toMatchObject({
      source: "system", level: "tell", entityKey: item.objectKey,
      payload: {
        version: 1, entry: "external", source: "slack", sourceLabel: "Slack",
        conversation: { key: item.objectKey, label: "李雷的私信" },
        sender: { id: "U0LILEI", name: "李雷", trust: "colleague" },
        text: V1, external: true,
        // 改规则的判断（工单 08）：问进度不是要求改规则。
        inbound: { intent: "progress", needsReply: 0.9, urgent: false, ruleChange: expect.closeTo(0.04, 5), ruleChangeKinds: [] },
        ceiling: { authority: "work", bound: DEFAULT_INTENT_GRANT_BOUNDS.progress },
        // 上下文包（工单 04，channel-context-pack.test.ts 测内容）：带外部标记，写明来源和发信人。
        context: expect.objectContaining({ version: 1, external: true, source: "slack", sender: { id: "U0LILEI", name: "李雷" } }),
        replyTo: { conversation: item.objectKey, message: tsOf(dm) },
        messages: [item.seq], edits: 0, cardId,
      },
    });
    // 摘要只有结构化的事实（当前局面里用它），原文只在 text 里。
    expect(messageEvents()[0]!.payload.summary).toContain(`通道卡 #${cardId}`);
    expect(messageEvents()[0]!.payload.summary).not.toContain("billing");
    // 消息事件就是请求（工单 05）：带 forSeq 和认出的对象，不再另记通道请求；没有期限（工单 06）。
    expect(messageEvents()[0]!.payload).toMatchObject({ forSeq: item.seq, objects: [] });
    expect(messageEvents()[0]!.payload).not.toHaveProperty("deadlineAt");
    expect(requests()).toEqual([]);
  });

  it("gives no message event to a message the inbound layer does not pass (only recorded)", async () => {
    const channels = hub(scriptedSmartModel({ answers: { needs_reply: 0.05 } }));
    await channels.receive("slack", slack.dm("U0LILEI", "哈哈"));
    await channels.idle();
    expect(listEvents(db, { kind: "channel.reply.not_needed" })).toHaveLength(1);
    expect(messageEvents()).toEqual([]);
  });
});

describe("edits (spec D6)", () => {
  it("merge into the message while it still waits for its intake: one intake, one message event with the last words", async () => {
    const model = jev();
    // 请求 A 停住，等两次编辑都到了再回答。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: SmartModel = {
      ...model,
      decide: async (state, questions, opts) => {
        if (opts?.purpose === "channel_intake") await gate;
        return model.decide(state, questions, opts);
      },
    };
    const channels = hub(held);
    const dm = slack.dm("U0LILEI", V1);
    const item = (await channels.receive("slack", dm)).items[0]!;
    await channels.receive("slack", slack.edit(dm, V2));
    await channels.receive("slack", slack.edit(dm, V3));
    release();
    await channels.idle();
    expect(intakes()).toBe(1);
    expect(queued()).toMatchObject([{ payload: { text: V3, messages: [item.seq, expect.any(Number), expect.any(Number)], edits: 2 } }]);
    // 不另记通道请求（工单 05）：排着的那一条消息事件就是请求。
    expect(requests()).toEqual([]);
    expect(getChannelCard(db, cardIdOf(db, item)!)).toMatchObject({ state: "open", excerpt: V3 });
  });

  it("merge into the queued message event Lead has not taken: no new request, no new intake", async () => {
    const model = jev();
    const channels = hub(model);
    const dm = slack.dm("U0LILEI", V1);
    const item = (await channels.receive("slack", dm)).items[0]!;
    await channels.idle();
    await channels.receive("slack", slack.edit(dm, V2));
    await channels.idle();
    await channels.receive("slack", slack.edit(dm, V3));
    await channels.idle();
    expect(intakes()).toBe(1);
    // 不另记通道请求（工单 05）：排着的那一条消息事件就是请求。
    expect(requests()).toEqual([]);
    // 前两个版本被并掉（superseded，Lead 不再收到），排着的只有最后一个。
    expect(messageEvents().map((event) => [event.payload.text, event.disposition])).toEqual([
      [V1, "superseded"], [V2, "superseded"], [V3, null],
    ]);
    expect(queued()[0]).toMatchObject({ level: "tell", payload: { messages: [item.seq, expect.any(Number), expect.any(Number)], edits: 2 } });
  });

  it("goes through the inbound judgement again as a new message after Lead took the message", async () => {
    const model = jev();
    const channels = hub(model);
    const dm = slack.dm("U0LILEI", V1);
    await channels.receive("slack", dm);
    await channels.idle();
    taken.add(messageEvents()[0]!.seq);
    const edit = (await channels.receive("slack", slack.edit(dm, V2))).items[0]!;
    await channels.idle();
    expect(intakes()).toBe(2);
    expect(messageEvents().map((event) => [event.payload.text, event.disposition])).toEqual([[V1, null], [V2, null]]);
    expect(messageEvents()[1]).toMatchObject({ payload: { messages: [edit.seq], edits: 0 } });
  });

  it("merge a second edit into the first one while that edit is judged again after Lead took the message", async () => {
    const model = jev();
    let release: (() => void) | null = null;
    let held = false;
    const gated: SmartModel = {
      ...model,
      decide: async (state, questions, opts) => {
        if (held && opts?.purpose === "channel_intake") await new Promise<void>((resolve) => { release = resolve; });
        return model.decide(state, questions, opts);
      },
    };
    const channels = hub(gated);
    const dm = slack.dm("U0LILEI", V1);
    await channels.receive("slack", dm);
    await channels.idle();
    taken.add(messageEvents()[0]!.seq);
    // 第一次编辑按新消息再判断，请求 A 停住；这时又来了第二次编辑。
    held = true;
    const edit = (await channels.receive("slack", slack.edit(dm, V2))).items[0]!;
    await expect.poll(() => release !== null).toBe(true);
    held = false;
    const again = (await channels.receive("slack", slack.edit(dm, V3))).items[0]!;
    release!();
    await channels.idle();
    expect(intakes()).toBe(2);
    expect(messageEvents().map((event) => [event.payload.text, event.disposition])).toEqual([[V1, null], [V3, null]]);
    expect(messageEvents()[1]).toMatchObject({ payload: { messages: [edit.seq, again.seq], edits: 1 } });
  });
});

// 工单 10：排着的消息事件跟着它的卡。卡结束了（你自己回、不回、在来源里回了），排着的那条也结束，Lead 不再处理它；
// 稍后再提醒不算结束，照旧排着。
describe("a card that ends takes its queued message event with it (ticket 10)", () => {
  it("ends the queued message event with the card, and keeps it queued while the card is only snoozed", async () => {
    const channels = hub(jev());
    const item = (await channels.receive("slack", slack.dm("U0LILEI", V1))).items[0]!;
    await channels.idle();
    const cardId = cardIdOf(db, item)!;
    await channels.act(cardId, "snooze", { by: "user via test" });
    expect(messageEvents().map((event) => event.disposition)).toEqual([null]);
    await channels.act(cardId, "reply_myself", { by: "user via test" });
    expect(messageEvents()).toMatchObject([{ disposition: "handled", dispositionDetail: { action: "reply_myself", cardId } }]);
  });

  it("does not rewrite a message event Lead has already handled when the card ends later", async () => {
    const channels = hub(jev());
    const item = (await channels.receive("slack", slack.dm("U0LILEI", V1))).items[0]!;
    await channels.idle();
    const [event] = messageEvents();
    db.prepare("UPDATE events SET disposition = 'seen' WHERE seq = ?").run(event!.seq);
    await channels.act(cardIdOf(db, item)!, "dismiss", { by: "user via test" });
    expect(messageEvents().map((row) => row.disposition)).toEqual(["seen"]);
  });
});

describe("how an edit merges (inbound.ts, the decision boundary)", () => {
  it.each([
    // 还在判断：并进那次判断（原来的消息，或者 Lead 拿走以后按新消息再判断的那次编辑）。
    [{ judged: false, latest: null }, "merge_pending"],
    [{ judged: false, latest: { queued: false } }, "merge_pending"],
    // 判断完了：消息事件还排着就并进去，Lead 拿走了（或者没交给 Lead）就按新消息再判断。
    [{ judged: true, latest: { queued: true } }, "merge_queued"],
    [{ judged: true, latest: { queued: false } }, "rejudge"],
    [{ judged: true, latest: null }, "rejudge"],
  ] as const)("%o → %s", (facts, kind) => {
    expect(editMergeOf(facts)).toBe(kind);
  });

  it("gives a ceiling only from the authority's conclusion and the intent", () => {
    expect(messageCeiling("work", "progress")).toEqual({ authority: "work", bound: DEFAULT_INTENT_GRANT_BOUNDS.progress });
    // 对方在接着回答你：只告诉你，不能派活。
    expect(messageCeiling("tell", "knowledge")).toEqual({ authority: "tell", bound: null });
    expect(messageCeiling("ask", "other")).toEqual({ authority: "ask", bound: null });
  });

  // 工单 08：Jev 判断对方是不是在要求改规则，结论写进前置处理的结论（D1）。只是让用户看得到：权限上限照旧只看授权表。
  it("carries Jev's rule-change judgement into the conclusions", () => {
    const intake = {
      status: "answered", askKind: "approve", needsReply: 0.9, sensitive: { query_credentials: 0.01 },
      ruleChange: 0.95, ruleChangeKinds: ["permissions", "auto_reply", "made_up"],
    };
    expect(inboundConclusions(intake, "approve", false)).toEqual({
      intent: "approve", needsReply: 0.9, urgent: false, sensitive: { query_credentials: 0.01 },
      ruleChange: 0.95, ruleChangeKinds: ["permissions", "auto_reply"],
    });
    // 第 6 版以前的回答、Jev 没有回答：看不出。
    expect(inboundConclusions({ status: "answered", askKind: "other", needsReply: 0.9 }, "other", null))
      .toMatchObject({ ruleChange: null, ruleChangeKinds: [] });
    expect(inboundConclusions(null, null, null)).toMatchObject({ ruleChange: null, ruleChangeKinds: [] });
  });
});
