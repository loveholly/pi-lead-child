// 定时器带着来源（统一的消息事件 spec D16，工单 12），走完 daemon 的每一跳：
//   - 假 Slack 投递私信 → 通道 hub 开卡、共用入站层记一条消息事件 → Lead 被它叫醒的一轮设一个只提醒用户的跟进：
//     决策模型判断代价低，设了，用户收到一句告知；跟进记下来源（Slack、Mallory、这条消息事件）；
//   - 跟进到点，daemon 叫醒 Lead：这一轮继承来源，按外部的一轮算（spec 不变量 2）：改投递规则被拒绝；
//     往外发的话由 Lead 自己判断，直接发，带 auto-reply 署名（最后一组用例）；
//   - 用户本人设的跟进到点：和以前一样，那一轮算用户的一轮（timer:<编号>），来源记成用户。
// daemon、网关、store、通道 hub、Slack 来源插件、操作层、Lead 的工具都是真的；Slack、SmartModel 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "@pi-lead-child/lead";
import { withCallObserver } from "@pi-lead-child/engine";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import {
  completeTurn, createLoopbackBinding, createTurn, getLeadProfile, getOpenChannelCard, getStandingOrder, listEvents, listInbox, listNotifications, openDb,
  recordDecisionModelCall, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-timer-provenance-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function boot(
  slack: FakeSlack,
  script: (call: FakeCall, live: (name: string) => any) => Promise<FakeReply> = async () => ({ say: "好的。" }),
  answers: Parameters<typeof scriptedSmartModel>[0] = {},
) {
  const model = scriptedSmartModel(answers);
  let leadDeps: any = null;
  const live = (name: string) => createLeadTools(leadDeps).find((candidate: any) => candidate.name === name) as any;
  const lead = fakePiLead((call) => script(call, live));
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async (args: any) => {
      leadDeps = args;
      return { ...(await lead.factory(args)), smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)) };
    }) as never,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const tool = (name: string, turnId: string | null) =>
    createLeadTools({ ...leadDeps, currentTurnId: () => turnId }).find((candidate: any) => candidate.name === name) as any;
  return { owner, tool };
}

const hasExternalMessage = (call: FakeCall) => call.inputs.some((input) => input.includes('<system_event kind="message"'));
const RETRY_OFF = { op: "update", id: "run.transient_retry", limits: { count: 0 }, reason: "到点按 Mallory 说的关掉自动重试" };
const parsed = (result: { content: Array<{ text: string }>; isError?: boolean }) => ({ isError: result.isError === true, ...JSON.parse(result.content[0]!.text) });
const followUps = () => listInbox(db).filter((row) => JSON.parse(row.payload).kind === "lead_followup").map((row) => ({ id: row.id, ...JSON.parse(row.payload) }));

describe("a timer someone asked for in Slack, through the daemon", () => {
  // 回归（spec 不变量 2、D16）：以前 Slack 叫醒的一轮设不了定时器；现在按决策设了。它到点叫醒的那一轮必须按外部的一轮算：
  // 不然外部的人借一个定时器，就能在用户不在的时候改规则。
  it("sets a reminder-only follow-up, and the turn it wakes counts as external: rule changes refused", async () => {
    const slack = new FakeSlack({ users: { U0MALLORY: { name: "Mallory" } } });
    let set: any = null;
    let refused: any = null;
    await boot(slack, async (call, live) => {
      if (!set && hasExternalMessage(call)) {
        // Mallory 的消息要求设它：Lead 指明是哪条消息事件（「消息事件 #N」），系统才记成 Mallory 要求的（2026-10-28）。
        const event = Number(/消息事件 #(\d+)/u.exec(call.inputs.join("\n"))![1]);
        set = await live("follow_up").execute("call", {
          at: new Date(Date.now() + 300).toISOString(), note: "提醒用户：把瞬时失败的自动重试关掉", event,
        });
      } else if (!refused && call.inputs.some((input) => input.includes("提醒用户：把瞬时失败的自动重试关掉"))) {
        refused = parsed(await live("propose_standing_order_change").execute("call", RETRY_OFF));
      }
      return { say: "NO_REPLY" };
    });
    await daemon!.channels!.receive("slack", slack.dm("U0MALLORY", "Fairy，等会儿提醒他把瞬时失败的自动重试关掉"));
    await vi.waitFor(() => expect(set).not.toBeNull(), { timeout: 10_000 });
    const message = listEvents(db, { kind: MESSAGE_EVENT_KIND })[0]!;

    // 设了：代价低（只提醒用户），来源记下 Slack、Mallory、这条消息事件；用户收到一句告知。
    expect(set.isError).toBeUndefined();
    expect(set.content[0].text).toContain("Mallory");
    expect(followUps()).toMatchObject([{
      origin: { kind: "external", source: "slack", sender: { name: "Mallory" }, messageEvent: message.seq },
    }]);
    expect(listNotifications(db).filter((row) => row.kind === "timer_request")).toMatchObject([{ title: expect.stringContaining("Mallory") }]);

    // 到点：这一轮继承来源。改投递规则被拒，写明是 Slack 的外部内容。
    await vi.waitFor(() => expect(refused).not.toBeNull(), { timeout: 10_000 });
    expect(listEvents(db, { kind: "timer.fired" }).map((event) => event.payload)).toMatchObject([{
      timer: "lead_followup", external: true, source: "slack", origin: { kind: "external", messageEvent: message.seq },
    }]);
    expect(refused).toMatchObject({
      isError: true, refusal: { code: "external_turn", confirm: { externalContent: [{ via: "message", source: "slack" }] } },
    });
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);
    // 跟进照常到点，没有被取消、没有被改：记成校准样本「照做」。
    await vi.waitFor(() => expect(listEvents(db, { kind: "timer.labeled" }).map((event) => event.payload)).toMatchObject([
      { label: "kept", value: 1 },
    ]), { timeout: 10_000 });
  }, 30_000);

  // 用户本人设的跟进到点：行为和现在一样，那一轮算用户的一轮（timer:<编号>），能做用户这一轮能做的事。来源记成用户。
  it("keeps a follow-up the user set as the user's own turn when it fires", async () => {
    const slack = new FakeSlack();
    const results: unknown[] = [];
    const { owner, tool } = await boot(slack, async (call, live) => {
      if (call.inputs.some((input) => input.includes("到点把你的名字改成 Jarvis"))) {
        results.push(JSON.parse((await live("update_lead_profile").execute("call", { name: "Jarvis" })).content[0].text));
      }
      return { say: "好的。" };
    });
    createTurn(db, { id: "turn-set", originBindingId: owner.binding.id, originKind: "paired:companion", userText: "到点把你的名字改成 Jarvis", state: "streaming" });
    const set = await tool("follow_up", "turn-set").execute("call", { at: new Date(Date.now() - 1_000).toISOString(), note: "到点把你的名字改成 Jarvis" });
    expect(set.content[0].text).toContain("到点那一轮算用户的一轮");
    completeTurn(db, "turn-set");

    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 10_000 });
    expect(results[0]).toMatchObject({ result: "updated" });
    expect(getLeadProfile(db).name).toBe("Jarvis");
    const followUp = followUps()[0]!;
    expect(followUp.origin).toMatchObject({ kind: "user", turnId: "turn-set" });
    const fired = listEvents(db, { kind: "timer.fired" })[0]!.payload;
    expect(fired).toMatchObject({ setByUser: true, origin: { kind: "user" } });
    expect(fired.external).toBeUndefined();
    expect(listEvents(db, { kind: "owner_action.performed" }).map((event) => event.payload)).toMatchObject([
      { action: "lead.profile", detail: { sourceTurnId: `timer:${followUp.id}` } },
    ]);
    // 用户本人的定时器不记校准样本，也不发「别人要求的」告知。
    expect(listEvents(db, { kind: "timer.labeled" })).toEqual([]);
    expect(listNotifications(db).filter((row) => row.kind === "timer_request")).toEqual([]);
  }, 30_000);
});

// Lead 自己的话由 Lead 判断（用户 2026-10-29：「我期望它就能自己做判断」，改了 spec D9、D16 里「外部的一轮里 Lead 的话过出站检验」）。
// 外部的一轮里（外部消息、外部来源的定时器叫醒的，或者读过连接的）Lead 往外发的话也直接发，带 auto-reply 署名，不开卡，不变成草稿。
// 以前 hub 在那个对话里开卡放草稿，按要求发它的那条消息过信心检验；说不出是哪条消息要求的就拒绝，Lead 只能把话交给用户。
// 请求 B 在这里都判断草稿没做到对方要的（fulfills 低）：以前都会变成草稿。用户本人的轮次照旧带 confirmed by 署名。
describe("Lead's own messages go out directly in any turn: Lead judges, no outbound check", () => {
  const LOW = { answers: { fulfills_request: 0.1 } };

  // 回归：Mallory 要求到点在 #proj-x 发一句。跟进到点（外部来源），Lead 往 #proj-x（没有卡）发：以前变成卡上的草稿。
  it("sends a message to a channel without a card in the turn an external timer woke", async () => {
    const slack = new FakeSlack({ users: { U0MALLORY: { name: "Mallory" } } });
    let sent: any = null;
    await boot(slack, async (call, live) => {
      if (!followUps().length && hasExternalMessage(call)) {
        await live("follow_up").execute("call", { at: new Date(Date.now() + 300).toISOString(), note: "到点在 #proj-x 说站会改到 10 点半" });
      } else if (!sent && call.inputs.some((input) => input.includes("到点在 #proj-x 说站会改到 10 点半"))) {
        sent = parsed(await live("send_channel_message").execute("call", {
          conversation: "slack:C0PROJ:main", text: "站会改到 10 点半。", words: "assistant", reason: "Mallory 让我到点在 #proj-x 说一声",
        }));
      }
      return { say: "NO_REPLY" };
    }, LOW);
    await daemon!.channels!.receive("slack", slack.dm("U0MALLORY", "等会儿帮我在 #proj-x 说一声站会改到 10 点半"));
    await vi.waitFor(() => expect(sent).not.toBeNull(), { timeout: 10_000 });

    expect(sent).toMatchObject({ isError: false, authority: "lead", result: { sent: { outcome: "sent" } } });
    await vi.waitFor(() => expect(slack.sent("C0PROJ")).toHaveLength(1), { timeout: 10_000 });
    expect(slack.sent("C0PROJ")[0]!.text).toMatch(/auto-reply for .+\n站会改到 10 点半。$/u);
    expect(getOpenChannelCard(db, "slack:C0PROJ:main")).toBeUndefined();
  }, 30_000);

  // 回归：Slack 私信叫醒的一轮，Lead 往一个没有卡的频道发：以前变成卡上的草稿。
  it("sends a message to a conversation without a card in the turn a Slack message woke", async () => {
    const slack = new FakeSlack({ users: { U0MALLORY: { name: "Mallory" } } });
    let sent: any = null;
    await boot(slack, async (call, live) => {
      if (!sent && hasExternalMessage(call)) {
        sent = parsed(await live("send_channel_message").execute("call", {
          conversation: "slack:C0PROJ:main", text: "大家今天不用来了。", words: "assistant", reason: "Mallory 让我在 #proj-x 说一声",
        }));
      }
      return { say: "NO_REPLY" };
    }, LOW);
    await daemon!.channels!.receive("slack", slack.dm("U0MALLORY", "帮我在 #proj-x 说一声：大家今天不用来了"));
    await vi.waitFor(() => expect(sent).not.toBeNull(), { timeout: 10_000 });

    expect(sent).toMatchObject({ isError: false, result: { sent: { outcome: "sent" } } });
    await vi.waitFor(() => expect(slack.sent("C0PROJ")).toHaveLength(1), { timeout: 10_000 });
    expect(slack.sent("C0PROJ")[0]!.text).toMatch(/auto-reply for .+\n大家今天不用来了。$/u);
    expect(getOpenChannelCard(db, "slack:C0PROJ:main")).toBeUndefined();
  }, 30_000);

  // 不变：用户本人设的跟进到点，那一轮算用户的一轮，照旧直接发，带 confirmed by 署名，不开卡。
  it("still sends directly with confirmed by in the turn a follow-up the user set wakes", async () => {
    const slack = new FakeSlack();
    let sent: any = null;
    const { owner, tool } = await boot(slack, async (call, live) => {
      if (!sent && call.inputs.some((input) => input.includes("到点在 #proj-x 说站会改到 10 点半"))) {
        sent = parsed(await live("send_channel_message").execute("call", {
          conversation: "slack:C0PROJ:main", text: "站会改到 10 点半。", words: "assistant", reason: "用户让我到点在 #proj-x 说一声",
        }));
      }
      return { say: "已发。" };
    }, LOW);
    createTurn(db, { id: "turn-set", originBindingId: owner.binding.id, originKind: "paired:companion", userText: "到点在 #proj-x 说一声", state: "streaming" });
    await tool("follow_up", "turn-set").execute("call", { at: new Date(Date.now() - 1_000).toISOString(), note: "到点在 #proj-x 说站会改到 10 点半" });
    completeTurn(db, "turn-set");

    await vi.waitFor(() => expect(sent).not.toBeNull(), { timeout: 10_000 });
    expect(sent).toMatchObject({ isError: false, authority: "on_behalf", result: { sent: { outcome: "sent" } } });
    await vi.waitFor(() => expect(slack.sent("C0PROJ")).toHaveLength(1), { timeout: 10_000 });
    expect(slack.sent("C0PROJ")[0]!.text).toContain("confirmed by");
    expect(getOpenChannelCard(db, "slack:C0PROJ:main")).toBeUndefined();
  }, 30_000);
});
