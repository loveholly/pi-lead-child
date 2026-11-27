// 断线、daemon 重启期间的 Slack 消息（2026-11-03 的故障：断了 14 分钟，没有开着卡的会话里的消息永远收不到）。
// 重连以后的补拉以前只看有没结束的卡的道；现在还补「断线这段时间里别人发给用户的私信、提到用户的消息」：
//   - 水位（到这个时刻为止都收到了）记在库里，daemon 重启以后还在；连着时每分钟往前推，断了就不推；
//   - 从来没记过水位（第一次启动）时不补：以前的消息不能一下子开出一堆卡；
//   - 补到的消息照常经 hub 的进程内入口，按投递编号去重；频道里只要提到用户的；
//   - 有上限（时间窗、条数），超过时记日志，并且告诉 Lead 可能没补全；
//   - Slack 应用方式（Socket Mode）和浏览器会话方式都这样（会话方式的用例在 channel-slack-session.test.ts）。
// 2026-11-06（#85）：
//   - 不完整事件写真实的断开、重连时刻和断了几秒，不把补拉读的区间（水位往回留了两分钟余量）说成断线的时段；
//   - 缺 search:read 这类配置问题只提醒一次，补拉真有缺口时照常提醒；
//   - 列出私信以后先探哪些有新消息，有新消息的都读（以前只读前 50 个，后面的漏了）；探的调用限速。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCatchUpMark, getChannelLane, listEvents, openDb, setChannelCatchUpMark, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackCatchUpWindow, type ChannelAdapter, type SlackWebApi } from "../src/index.js";
import { FAKE_SLACK_USER_SCOPES, FakeSlack } from "../testing/index.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 假的 Slack 的消息 ts 从 1760000001 起按秒往后排，和时钟无关：时钟也从这里起。
const START = new Date(1_760_000_000_000);

let dir: string;
let db: Db;
let slack: FakeSlack;
let logs: string[];
let clock: Date;
let adapter: ChannelAdapter;
let hub: ChannelHub;

type Limits = { windowMs?: number; messages?: number; probeSpacingMs?: number };

function setup(limits?: Limits, api: SlackWebApi = slack.api): void {
  adapter = createSlackChannelAdapter({
    api, now: () => clock, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40, catchUpSpacingMs: 0 },
    ...(limits ? { catchUp: limits } : {}),
  });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: (line) => logs.push(line),
  });
}

function start(): void {
  adapter.transport!.start(hub.transportContext("slack"), (delivery) => hub.receiveFromTransport("slack", delivery));
}

// daemon 重启：停下传输，关掉库，再用同一个库文件建新的 hub 和适配器。
async function restart(limits?: Limits): Promise<void> {
  await adapter.transport!.stop();
  await hub.idle();
  db.close();
  db = openDb(join(dir, "plc.db"));
  setup(limits);
}

const slackEvents = () => listEvents(db, {}).filter((event) => event.source === "slack");
const texts = (kind: string) => listEvents(db, { kind }).map((event) => event.payload.text);
const marked = () => vi.waitFor(() => expect(getChannelCatchUpMark(db, "slack")).not.toBeNull());
const incomplete = () => listEvents(db, { kind: "channel.catch_up.incomplete" });

beforeEach(() => {
  dir = tempDir("plc-slack-gap-");
  db = openDb(join(dir, "plc.db"));
  clock = START;
  slack = new FakeSlack({ scopes: [...FAKE_SLACK_USER_SCOPES, "search:read"], now: () => clock });
  logs = [];
  setup();
});

afterEach(async () => {
  await adapter.transport?.stop();
  await hub.idle();
  db.close();
});

describe("catching up the gap after a reconnect", () => {
  it("brings in direct messages and mentions from conversations without an open card", async () => {
    start();
    await marked();
    expect(slackEvents()).toEqual([]);

    // 断线期间：李四第一次私信用户（没有道），张三在频道的 thread 里接连提到用户两次（搜索只给一条），李四在频道里闲聊（没有提到用户）。
    slack.dropConnection();
    slack.dm("U0LI", "断线时李四发的私信");
    const root = slack.chatter("U0ZHANG", "发布计划讨论");
    const thread = slack.messageOf(root).ts;
    slack.mention("U0ZHANG", "这里需要你确认", { thread });
    slack.mention("U0ZHANG", "还有回滚步骤", { thread });
    slack.chatter("U0LI", "午饭吃什么");
    await vi.waitFor(() => expect(slack.connections).toBe(2));

    await vi.waitFor(() => expect(slackEvents()).toHaveLength(3));
    expect(texts("slack.dm.received")).toEqual(["断线时李四发的私信"]);
    expect(texts("slack.mention.received")).toEqual([expect.stringContaining("这里需要你确认"), expect.stringContaining("还有回滚步骤")]);
    // 频道里没有提到用户的消息不补。
    expect(slackEvents().map((event) => event.payload.text)).not.toContain("午饭吃什么");
    expect(slackEvents().map((event) => event.payload.text)).not.toContain("发布计划讨论");
    // 李四的私信开了道（和实时收到的一样）。
    expect(getChannelLane(db, "slack:D0LI:main")).toBeDefined();
    expect(logs.join("\n")).toContain("caught up 3 message(s) from the gap");
    expect(incomplete()).toEqual([]);

    // 再断一次、再补一次：都不重复记。
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "search.messages")).toHaveLength(2));
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toHaveLength(3);
  });

  it("picks up where it left off after the daemon restarts", async () => {
    start();
    await marked();
    // daemon 停着的时候来了一条私信，Slack 不会再送。
    await adapter.transport!.stop();
    slack.dm("U0LI", "重启期间的私信");
    clock = new Date(START.getTime() + 10 * MINUTE);
    await restart();
    start();
    await vi.waitFor(() => expect(texts("slack.dm.received")).toEqual(["重启期间的私信"]));

    // 再重启一次，中间没有新消息：不重复记。
    await vi.waitFor(() => expect(logs.join("\n")).toContain("caught up 1 message(s) from the gap"));
    await restart();
    start();
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "search.messages")).toHaveLength(2));
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toHaveLength(1);
  });

  it("does not pull old messages on the very first start", async () => {
    slack.dm("U0LI", "上线以前的私信");
    slack.mention("U0ZHANG", "上线以前提到你");
    start();
    await marked();
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toEqual([]);
    expect(slack.calls.map((call) => call.method)).not.toContain("search.messages");
    expect(logs.join("\n")).toContain("no catch-up mark yet");
  });

  it("keeps the mark still while disconnected, so a long outage is caught up from where it began", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      start();
      await marked();
      const before = getChannelCatchUpMark(db, "slack")!;
      // 连着时每分钟往前推（留两分钟的余量）。
      clock = new Date(START.getTime() + 5 * MINUTE);
      vi.advanceTimersByTime(MINUTE);
      const moved = getChannelCatchUpMark(db, "slack")!;
      expect(moved.getTime()).toBe(clock.getTime() - 2 * MINUTE);
      expect(moved.getTime()).toBeGreaterThan(before.getTime());
      // 断了以后不再推（重连停在半路）：断线期间的时间不能算「收到了」。
      const release = slack.holdSocketStart();
      slack.dropConnection();
      clock = new Date(START.getTime() + 30 * MINUTE);
      vi.advanceTimersByTime(5 * MINUTE);
      expect(getChannelCatchUpMark(db, "slack")).toEqual(moved);
      // 重新连上、补完以后才接着推。
      release();
      await vi.waitFor(() => expect(getChannelCatchUpMark(db, "slack")!.getTime()).toBe(clock.getTime() - 2 * MINUTE));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the limits of the catch-up", () => {
  it("catches up only the last window of a long outage and tells Lead the rest may be missing", async () => {
    start();
    await marked();
    await adapter.transport!.stop();
    // 停了五天（时间窗缺省三天）。
    setChannelCatchUpMark(db, "slack", new Date(START.getTime() - 5 * DAY));
    slack.dm("U0LI", "五天里的私信");
    await restart();
    start();
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    expect(texts("slack.dm.received")).toEqual(["五天里的私信"]);
    const [notice] = incomplete();
    expect(notice).toMatchObject({ source: "system", level: "tell" });
    expect(String(notice!.payload.summary)).toContain("3 天");
    expect(logs.join("\n")).toMatch(/catch-up of the gap .* is incomplete/);
    // daemon 停着的那段不是连接断开：没有断开的时刻，也不编一个。
    expect(notice!.payload).toMatchObject({ disconnectedAt: null, reconnectedAt: null, disconnectedSeconds: null });
    expect(String(notice!.payload.summary)).toContain("daemon 启动以后第一次连上");
  });

  it("writes when the connection really dropped and came back, not the catch-up range with its margin", async () => {
    await restart({ messages: 1 });
    start();
    await marked();
    // 断开一秒多才重新连上；这期间来了两条私信，只补一条（有缺口，要告诉 Lead）。
    const release = slack.holdSocketStart();
    slack.dropConnection();
    slack.dm("U0LI", "断线时的一");
    slack.dm("U0LI", "断线时的二");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    release();
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    const { payload } = incomplete()[0]!;
    const down = Date.parse(String(payload.reconnectedAt)) - Date.parse(String(payload.disconnectedAt));
    expect(down).toBeGreaterThanOrEqual(1_000);
    expect(payload.disconnectedSeconds).toBe(Math.round(down / 1000));
    expect(payload.drops).toBe(1);
    const summary = String(payload.summary);
    expect(summary).toContain(`断了 ${payload.disconnectedSeconds} 秒`);
    expect(summary).toContain(`${payload.disconnectedAt} 断开`);
    // 补拉读的区间照样写，但说明它不是断线的时段。
    expect(summary).toContain(`补拉读的是 ${payload.from} 到 ${payload.to}`);
    expect(summary).not.toContain("之间断过线");
  });

  it("delivers at most the cap and tells Lead that older messages were left out", async () => {
    await restart({ messages: 3 });
    start();
    await marked();
    slack.dropConnection();
    for (const text of ["一", "二", "三", "四", "五"]) slack.dm("U0LI", text);
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    // 留下最新的几条。
    expect(texts("slack.dm.received")).toEqual(["三", "四", "五"]);
    expect(String(incomplete()[0]!.payload.summary)).toContain("3 条");
  });

  it("still catches up direct messages without the search scope, and says mentions were not checked", async () => {
    slack.scopes = slack.scopes.filter((scope) => scope !== "search:read");
    start();
    await marked();
    slack.dropConnection();
    slack.dm("U0LI", "没有搜索权限时的私信");
    slack.mention("U0ZHANG", "没有搜索权限时提到你", { thread: slack.messageOf(slack.chatter("U0ZHANG", "根消息")).ts });
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    expect(texts("slack.dm.received")).toEqual(["没有搜索权限时的私信"]);
    expect(String(incomplete()[0]!.payload.summary)).toContain("search:read");
    expect(incomplete()[0]!.payload.setup).toEqual([expect.stringContaining("search:read")]);
  });

  it("tells Lead about a missing search scope once, and still tells about a real gap", async () => {
    slack.scopes = slack.scopes.filter((scope) => scope !== "search:read");
    start();
    await marked();
    // 第一次补拉：只有配置问题，提醒一次。
    slack.dropConnection();
    slack.dm("U0LI", "第一次断线");
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    expect(String(incomplete()[0]!.payload.summary)).toContain("只提醒一次");

    // 再断两次，都只有配置问题：私信照补，不再记事件，日志里写明已经说过。
    for (const [round, text] of [[2, "第二次断线"], [3, "第三次断线"]] as const) {
      slack.dropConnection();
      slack.dm("U0LI", text);
      await vi.waitFor(() => expect(texts("slack.dm.received")).toContain(text));
      await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "search.messages")).toHaveLength(round));
    }
    await vi.waitFor(() => expect(logs.filter((line) => line.includes("a setup problem Lead was already told about"))).toHaveLength(2));
    expect(incomplete()).toHaveLength(1);

    // 真有缺口（列不出私信对话）：照常提醒，原因里也带着配置问题。
    clock = new Date(START.getTime() + 10 * MINUTE);
    slack.failNext("users.conversations", "socket hang up");
    slack.dropConnection();
    await vi.waitFor(() => expect(incomplete()).toHaveLength(2));
    expect(incomplete()[1]!.payload.reasons).toEqual([expect.stringContaining("列不出私信对话"), expect.stringContaining("search:read")]);
  });

  it("reads every direct conversation with new messages, however many there are", async () => {
    // 82 个私信对话（以前只读排在前面的 50 个）；断线期间只有排在最后的三个人发来私信。
    const users = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`U0P${String(index).padStart(2, "0")}`, { name: `同事${index}` }]));
    slack = new FakeSlack({ scopes: [...FAKE_SLACK_USER_SCOPES, "search:read"], now: () => clock, users });
    setup({ probeSpacingMs: 0 });
    start();
    await marked();
    slack.dropConnection();
    for (const user of ["U0P77", "U0P78", "U0P79"]) slack.dm(user, `${user} 断线时的私信`);
    await vi.waitFor(() => expect(texts("slack.dm.received")).toHaveLength(3));
    expect(texts("slack.dm.received")).toEqual(["U0P77 断线时的私信", "U0P78 断线时的私信", "U0P79 断线时的私信"]);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("probed 82 direct conversation(s) for the gap; 79 had nothing new"));
    // 每个私信探一次（limit 1），有新消息的三个才整段读。
    const histories = slack.calls.filter((call) => call.method === "conversations.history");
    expect(histories.filter((call) => call.args.limit === 1)).toHaveLength(82);
    expect(histories.filter((call) => call.args.limit !== 1).map((call) => call.args.channel)).toEqual(["D0P77", "D0P78", "D0P79"]);
    expect(incomplete()).toEqual([]);
  });

  it("paces the probes of direct conversations after a first burst", async () => {
    const users = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`U0P${String(index).padStart(2, "0")}`, { name: `同事${index}` }]));
    slack = new FakeSlack({ scopes: [...FAKE_SLACK_USER_SCOPES, "search:read"], now: () => clock, users });
    const probedAt: number[] = [];
    setup({ probeSpacingMs: 40 }, {
      ...slack.api,
      call: (method, args, token) => {
        if (method === "conversations.history" && args.limit === 1) probedAt.push(Date.now());
        return slack.api.call(method, args, token);
      },
    });
    start();
    await marked();
    slack.dropConnection();
    slack.dm("U0P29", "最后一个人的私信");
    await vi.waitFor(() => expect(texts("slack.dm.received")).toEqual(["最后一个人的私信"]), { timeout: 3_000 });
    // 32 个私信：前 20 个连着探，后 12 个每隔约 40 毫秒探一个。
    expect(probedAt).toHaveLength(32);
    const paced = probedAt.slice(20);
    for (let index = 1; index < paced.length; index++) expect(paced[index]! - paced[index - 1]!).toBeGreaterThanOrEqual(30);
    expect(probedAt.at(-1)! - probedAt[0]!).toBeGreaterThanOrEqual(12 * 40 - 40);
  });
});

describe("the catch-up window", () => {
  it("starts at the mark, but no earlier than the window", () => {
    const now = new Date(START.getTime() + 10 * DAY);
    expect(slackCatchUpWindow(null, now, 3 * DAY)).toBeNull();
    expect(slackCatchUpWindow(new Date(now.getTime() - MINUTE), now, 3 * DAY)).toEqual({ from: new Date(now.getTime() - MINUTE), clipped: false });
    expect(slackCatchUpWindow(new Date(now.getTime() - 5 * DAY), now, 3 * DAY)).toEqual({ from: new Date(now.getTime() - 3 * DAY), clipped: true });
  });
});
