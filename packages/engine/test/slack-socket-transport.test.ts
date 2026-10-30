// slack-takeover 工单 02（spec D11）：Socket Mode 传输里我们自己的逻辑。连接、心跳、Slack 的 disconnect 消息由 SDK 的
// SocketModeClient 处理，这里不重测；这里用假的客户端（FakeSlack.createSocketClient）测：
//   - 每个 envelope 先 ack，再交给 hub 的进程内入口（不校验签名；同样的内容走推来的入口要验签名）；
//   - 断了就重连；重新连上以后补拉还有没结束的卡的道，不重复记；第一次连上也补拉；
//   - 连不上时退避再试；SDK 的日志和报错里没有令牌；
//   - 停下时断开连接，已经 ack 的投递交完；
//   - 连接的状态报给 host.status（设置页）；停了以后能再开（设置页改了凭据以后热重连），上一代没连完的连接不留下。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelAdapter, type ChannelTransportStatus } from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let logs: string[];
let adapter: ChannelAdapter;
let hub: ChannelHub;

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-socket-"), "plc.db"));
  slack = new FakeSlack();
  logs = [];
  statuses = [];
  adapter = createSlackChannelAdapter({ api: slack.api, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40 } });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: (line) => logs.push(line),
  });
});

afterEach(async () => {
  await adapter.transport?.stop();
  db.close();
});

let statuses: ChannelTransportStatus[] = [];

function start(): void {
  adapter.transport!.start({ ...hub.transportContext("slack"), status: (update) => statuses.push(update) }, async (delivery) => {
    slack.timeline.push(`deliver:${JSON.parse(delivery.body).event.ts}`);
    return hub.receiveFromTransport("slack", delivery);
  });
}

const connected = () => vi.waitFor(() => expect(slack.socket()).toBeDefined());
const kinds = () => listEvents(db, {}).filter((event) => event.source === "slack").map((event) => event.kind);

describe("the Socket Mode transport", () => {
  it("acks every envelope before handing it to the hub, through the in-process entry only", async () => {
    start();
    await connected();
    expect(slack.socketClients[0]!.appToken).toBe(FAKE_SLACK_APP_TOKEN);
    expect(slack.socketClients[0]!.options).toMatchObject({ autoReconnectEnabled: false });
    const dm = slack.dm("U0ZHANG", "周五评审的材料收到了吗？");
    const envelope = slack.push(dm);
    await vi.waitFor(() => expect(kinds()).toEqual(["slack.dm.received"]));
    const ts = slack.messageOf(dm).ts;
    expect(slack.timeline).toEqual([`ack:${envelope}`, `deliver:${ts}`]);
    // Socket 送来的投递没有签名头。同样的内容从推来的入口进：要验签名，拒收。
    const unsigned = { headers: {}, body: dm.body };
    expect(await hub.receive("slack", unsigned)).toEqual({ accepted: false, rejection: "unauthenticated", items: [] });
    // 声称自己是 Socket 送来的也不行：推来的入口一律验签名。
    expect(await hub.receive("slack", { ...unsigned, transport: "socket" })).toMatchObject({ accepted: false, rejection: "unauthenticated" });
    // Slack 重发同一个 envelope（例如 ack 没送到）：同一条消息只记一次。
    slack.push(dm);
    await vi.waitFor(() => expect(slack.acks).toHaveLength(2));
    await adapter.transport!.stop();
    expect(kinds()).toEqual(["slack.dm.received"]);
  });

  it("hands deliveries over one at a time, so a follow-up in a new thread waits for the message that opened it", async () => {
    start();
    await connected();
    const mention = slack.mention("U0ZHANG", "这个接口的超时是多少？");
    slack.push(mention);
    slack.push(slack.chatter("U0ZHANG", "补充：生产环境", "C0PROJ", { thread: slack.messageOf(mention).ts }));
    await vi.waitFor(() => expect(kinds()).toEqual(["slack.mention.received", "slack.thread.message"]));
  });

  it("catches up the open lanes on every connection, without duplicates", async () => {
    start();
    await connected();
    const first = slack.dm("U0ZHANG", "第一条");
    slack.push(first);
    await vi.waitFor(() => expect(kinds()).toHaveLength(1));
    // 第一次连上时还没有开着卡的道：补拉什么也不用读（没有调 conversations.history）。
    expect(slack.calls.filter((call) => call.method === "conversations.history")).toEqual([]);

    // 断线期间对方又发了两条：Slack 没送来。
    slack.dropConnection();
    const missedOne = slack.dm("U0ZHANG", "断线时的第二条");
    const missedTwo = slack.dm("U0ZHANG", "断线时的第三条");
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    await vi.waitFor(() => expect(kinds()).toHaveLength(3));
    const texts = listEvents(db, { kind: "slack.dm.received" }).map((event) => event.payload.text);
    expect(texts).toEqual(["第一条", "断线时的第二条", "断线时的第三条"]);
    const { id } = db.prepare("SELECT id FROM channel_cards").get() as { id: number };
    expect(getChannelCard(db, id)).toMatchObject({ state: "open", messageCount: 3, excerpt: "断线时的第三条" });
    expect(logs.join("\n")).toContain("caught up 2 message(s) in slack:D0ZHANG:main");

    // Slack 后来又把断线时的消息送来了；再断一次、再补一次：都不重复记。
    slack.push(missedOne);
    slack.push(missedTwo);
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "conversations.history")).toHaveLength(2));
    await adapter.transport!.stop();
    expect(kinds()).toHaveLength(3);
  });

  it("retries with a backoff when it cannot connect, and keeps the tokens out of the log", async () => {
    slack.failNextSocketStart("invalid_auth");
    start();
    await connected();
    expect(slack.socketClients).toHaveLength(1);
    expect(logs.join("\n")).toContain("could not connect: An API error occurred: invalid_auth; will retry");
    // SDK 写日志时带上了令牌（例如一次失败的请求）：我们的日志里去掉了。
    slack.socketClients[0]!.logger!.warn(`apps.connections.open failed for ${FAKE_SLACK_APP_TOKEN}`);
    slack.socketClients[0]!.logger!.error(new Error(`token ${FAKE_SLACK_TOKEN} was rejected`));
    const text = logs.join("\n");
    expect(text).toContain("socket mode warn: apps.connections.open failed for");
    for (const token of [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN]) expect(text).not.toContain(token);
  });

  it("disconnects a connection that comes up after it was told to stop", async () => {
    const release = slack.holdSocketStart();
    start();
    await vi.waitFor(() => expect(slack.socketClients).toHaveLength(1));
    const stopped = adapter.transport!.stop();
    release();
    await stopped;
    await vi.waitFor(() => expect(slack.connections).toBe(1));
    await vi.waitFor(() => expect(slack.socket()).toBeUndefined());
  });

  it("waits for usable credentials, and stops by disconnecting and finishing the acked deliveries", async () => {
    let credential: typeof slack.credential | null = null;
    hub = new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => credential }, log: (line) => logs.push(line),
    });
    start();
    await vi.waitFor(() => expect(logs.join("\n")).toContain("no usable credential"));
    expect(slack.socketClients).toEqual([]);
    credential = slack.credential;
    await connected();
    slack.push(slack.dm("U0ZHANG", "停下之前到的"));
    await adapter.transport!.stop();
    expect(kinds()).toEqual(["slack.dm.received"]);
    expect(slack.socket()).toBeUndefined();
  });

  it("reports connecting, connected and a reconnect, and keeps showing an error while it retries", async () => {
    start();
    await connected();
    expect(statuses).toEqual([{ state: "connecting" }, { state: "connected" }]);
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    expect(statuses.slice(2)).toEqual([{ state: "connecting" }, { state: "connected" }]);
    await adapter.transport!.stop();

    // 连不上两次：报一次错误；再试的时候不报「正在连」，直到连上。
    statuses = [];
    slack.failNextSocketStart("ratelimited");
    slack.failNextSocketStart("ratelimited");
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    expect(statuses).toEqual([
      { state: "connecting" }, { state: "error", error: "连不上 Slack：An API error occurred: ratelimited" }, { state: "connected" },
    ]);
    await adapter.transport!.stop();

    // 令牌被拒：说是令牌的问题。
    statuses = [];
    slack.failNextSocketStart("invalid_auth");
    start();
    await vi.waitFor(() => expect(statuses.map((status) => status.state)).toEqual(["connecting", "error", "connected"]));
    expect(statuses[1]).toEqual({ state: "error", error: expect.stringContaining("Slack 拒绝了连接（invalid_auth）") });
  });

  it("starts again after a stop with a new client", async () => {
    start();
    await connected();
    await adapter.transport!.stop();
    expect(slack.socket()).toBeUndefined();
    statuses = [];
    start();
    await connected();
    expect(slack.socketClients).toHaveLength(2);
    expect(statuses).toEqual([{ state: "connecting" }, { state: "connected" }]);
    slack.push(slack.dm("U0ZHANG", "重连以后到的"));
    await vi.waitFor(() => expect(kinds()).toEqual(["slack.dm.received"]));
  });

  it("drops a connection of the previous start that comes up after a restart, and connects once more", async () => {
    const release = slack.holdSocketStart();
    start();
    await vi.waitFor(() => expect(slack.socketClients).toHaveLength(1));
    await adapter.transport!.stop();
    start();
    release();
    await vi.waitFor(() => expect(slack.socketClients).toHaveLength(2));
    await vi.waitFor(() => expect(slack.socket()).toBe(slack.socketClients[1]));
    expect(slack.socketClients[0]!.connected).toBe(false);
    expect(slack.socketClients.filter((client) => client.connected)).toHaveLength(1);
  });
});
