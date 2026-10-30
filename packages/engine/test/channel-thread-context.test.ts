// 回复的上下文（落地计划 A2，.scratch/confidence-model/landing.md）：一条消息回复的是另一条时，被回复的那条和它之前的几条
// 放到这条道的最前面（起点），请求 A、起草、代查都看得到。先在自己的事件里找，找不到再取历史；补进来的只当上下文。
// 2026-10-22 的真实情况：王小明昨天在私信里发了两个 PR 链接，今天在那条消息的 thread 里说「pr comment 改了，再帮忙看看」，
// thread 的道里只有这一句，请求 A 认不出要查哪个 PR。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  CHANNEL_LANE_CONTEXT_LIMIT, getChannelLane, listEvents, openDb, recordChannelLaneMessage, setChannelLaneOrigin, type Db,
} from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelHubOptions } from "../src/index.js";
import { FakeSlack, scriptedSmartModel, type ScriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-thread-context-"), "plc.db"));
  clock = new Date("2026-10-22T03:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ETHAN: { name: "王小明" } } });
  logs = [];
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

function hub(model: ScriptedSmartModel, options: Partial<ChannelHubOptions> = {}): ChannelHub {
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, log: (line) => logs.push(line),
    classifyTimeoutMs: 60_000, smartModel: () => model, ...options,
  });
  hubs.push(instance);
  return instance;
}

const tsOf = (delivery: { body: string }) => (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;
const intakeStates = (model: ScriptedSmartModel) => model.calls.filter((call) => call.purpose === "channel_intake").map((call) => call.state);
const tick = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };

describe("the origin of a reply", () => {
  it("puts the root message of a DM thread, found in our own events, in front of the thread's lane", async () => {
    const model = scriptedSmartModel();
    const channels = hub(model);
    await channels.receive("slack", slack.dm("U0ETHAN", "周会改到四点"));
    tick(60);
    const root = slack.dm("U0ETHAN", "github.com/Acme/x/pull/101 github.com/Acme/x/pull/102 我大体上看了一下");
    await channels.receive("slack", root);
    await channels.idle();
    tick(86_400);
    const reply = slack.dm("U0ETHAN", "pr comment 改了，再帮忙看看 :eyes:", { thread: tsOf(root) });
    await channels.receive("slack", reply);
    await channels.idle();

    const lane = getChannelLane(db, `slack:D0ETHAN:${tsOf(root)}`)!;
    expect(lane.context.map((message) => [message.origin ?? false, message.text])).toEqual([
      [true, "周会改到四点"],
      [true, "github.com/Acme/x/pull/101 github.com/Acme/x/pull/102 我大体上看了一下"],
      [false, "pr comment 改了，再帮忙看看 :eyes:"],
    ]);
    // 请求 A 看得到根消息：不再「认不出要查哪个 PR」。
    const state = intakeStates(model).at(-1)!;
    expect(state).toContain("The message this conversation replies to");
    expect(state).toContain("github.com/Acme/x/pull/101");
    // 取历史不用调：根消息在自己的事件里。
    expect(slack.calls.filter((call) => call.method === "conversations.replies")).toEqual([]);
  });

  it("reads the history when the root message is not in our events, and keeps it as context only", async () => {
    const model = scriptedSmartModel();
    const channels = hub(model);
    // 根消息发在开始监听以前：假的 Slack 里有，库里没有。
    const root = slack.dm("U0ETHAN", "github.com/Acme/x/pull/101 帮忙看看");
    const thread = tsOf(root);
    tick(30);
    slack.selfReply("D0ETHAN", "看过了，留了一条评论", { thread });
    tick(86_400);
    const reply = slack.dm("U0ETHAN", "pr comment 改了，再帮忙看看", { thread });
    const before = listEvents(db, {}).length;
    await channels.receive("slack", reply);
    await channels.idle();

    const lane = getChannelLane(db, `slack:D0ETHAN:${thread}`)!;
    expect(lane.context.map((message) => [message.origin ?? false, message.role, message.text])).toEqual([
      [true, "them", "github.com/Acme/x/pull/101 帮忙看看"],
      [true, "me", "看过了，留了一条评论"],
      [false, "them", "pr comment 改了，再帮忙看看"],
    ]);
    expect(intakeStates(model).at(-1)!).toContain("github.com/Acme/x/pull/101");
    // 补进来的只当上下文：没有给它们记事件。
    const recorded = listEvents(db, {}).slice(before).filter((event) => event.source === "slack");
    expect(recorded.map((event) => event.payload.text)).toEqual(["pr comment 改了，再帮忙看看"]);
  });

  it("goes on without an origin when the history cannot be read in time", async () => {
    const model = scriptedSmartModel();
    const channels = hub(model, { historyTimeoutMs: 20 });
    const root = slack.dm("U0ETHAN", "github.com/Acme/x/pull/101");
    const release = slack.holdNext("conversations.replies");
    await channels.receive("slack", slack.dm("U0ETHAN", "再帮忙看看", { thread: tsOf(root) }));
    await channels.idle();
    release();
    expect(getChannelLane(db, `slack:D0ETHAN:${tsOf(root)}`)!.context.some((message) => message.origin)).toBe(false);
    expect(intakeStates(model)).toHaveLength(1);
    expect(logs.join("\n")).toContain("could not read the history");
  });

  it("marks the root of a channel thread as the origin in the same lane", async () => {
    const model = scriptedSmartModel();
    const channels = hub(model);
    const root = slack.mention("U0ETHAN", "这个接口的超时是多少？");
    const first = (await channels.receive("slack", root)).items[0]!;
    await channels.idle();
    await channels.receive("slack", slack.mention("U0ETHAN", "补充：生产环境", { thread: tsOf(root) }));
    await channels.idle();
    const lane = getChannelLane(db, first.objectKey)!;
    expect(lane.context[0]).toMatchObject({ origin: true, ref: tsOf(root) });
    expect(lane.context.filter((message) => message.text.includes("这个接口的超时是多少"))).toHaveLength(1);
  });
});

describe("lane context keeps its origin", () => {
  it("never trims the origin away, however long the thread gets", () => {
    recordChannelLaneMessage(db, {
      source: "slack", objectKey: "slack:D0X:1", label: "私信",
      message: { at: "2026-10-22T00:00:00.000Z", seq: 1, role: "them", sender: "王小明", text: "第一条回复" },
    });
    setChannelLaneOrigin(db, "slack:D0X:1", [{ at: "2026-10-21T00:00:00.000Z", seq: null, role: "them", sender: "王小明", text: "根消息", ref: "1.0" }]);
    for (let index = 2; index <= 40; index++) {
      recordChannelLaneMessage(db, {
        source: "slack", objectKey: "slack:D0X:1", label: "私信",
        message: { at: "2026-10-22T00:00:00.000Z", seq: index, role: "them", sender: "王小明", text: `第 ${index} 条` },
      });
    }
    const context = getChannelLane(db, "slack:D0X:1")!.context;
    expect(context).toHaveLength(CHANNEL_LANE_CONTEXT_LIMIT);
    expect(context[0]).toMatchObject({ origin: true, text: "根消息" });
    expect(context.at(-1)!.text).toBe("第 40 条");
  });
});
