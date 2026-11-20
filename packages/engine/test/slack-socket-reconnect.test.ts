// Socket Mode 在网络不稳时反复断开（2026-11-05：SDK 缺省 5 秒收不到 pong 就断开，每 20 秒左右断一次、重连、补拉一轮）：
//   - 等 pong 最多 20 秒，不用 SDK 的 5 秒；
//   - 断开时日志和状态里写明原因（Slack 的 disconnect 消息、SDK 的警告、WebSocket 的 close code），拿不到时写明不知道；
//   - 很快又重连时合并补拉：在跑的补拉跑完以后只再补一次，断线期间的消息都补到；上一次补完不久时等一会儿再补；
//   - 连续很快又断时重连退避，第一次断开立刻重连。
// 2026-11-06（#85）：
//   - 补拉拿到真实的断线时段：合并的几次断开从第一次断开算到最后一次连上，记下断了几次；
//   - 心跳超时断开时，原因里带上 daemon 事件循环最近的延迟（分得清网络的问题和 daemon 自己卡住）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, createSlackSocketTransport, type ChannelAdapter, type ChannelOutage, type ChannelTransport,
  type ChannelTransportStatus, type SlackSocketOptions,
} from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let logs: string[];
let statuses: ChannelTransportStatus[];
let adapter: ChannelAdapter;
let hub: ChannelHub;

function setup(socket: Partial<SlackSocketOptions> = {}): void {
  adapter = createSlackChannelAdapter({
    api: slack.api, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40, catchUpSpacingMs: 0, ...socket },
  });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: (line) => logs.push(line),
  });
}

function start(): void {
  adapter.transport!.start({ ...hub.transportContext("slack"), status: (update) => statuses.push(update) }, (delivery) => hub.receiveFromTransport("slack", delivery));
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-reconnect-"), "plc.db"));
  slack = new FakeSlack();
  logs = [];
  statuses = [];
});

let bare: ChannelTransport | null = null;

afterEach(async () => {
  await bare?.stop();
  bare = null;
  await adapter?.transport?.stop();
  db.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const kinds = () => listEvents(db, {}).filter((event) => event.source === "slack").map((event) => event.kind);
// 一次补拉先读开着卡的道（conversations.history），再补断线这段时间（每次调一次 client.counts）。
const histories = () => slack.calls.filter((call) => call.method === "conversations.history").length;
const catchUps = () => slack.calls.filter((call) => call.method === "client.counts").length;
const disconnectLogs = () => logs.filter((line) => line.includes("socket: disconnected"));

describe("Socket Mode on a shaky network", () => {
  it("waits 20 seconds for a pong instead of the SDK's 5", async () => {
    setup();
    start();
    await vi.waitFor(() => expect(slack.socket()).toBeDefined());
    expect(slack.socketClients[0]!.appToken).toBe(FAKE_SLACK_APP_TOKEN);
    expect(slack.socketClients[0]!.options).toMatchObject({ clientPingTimeout: 20_000, autoReconnectEnabled: false });
  });

  it("logs and reports why the connection dropped, and says so when nobody told us", async () => {
    setup();
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));

    // Slack 要我们换连接：disconnect 消息带着 reason。
    slack.socket()!.emit("ws_message", JSON.stringify({ type: "disconnect", reason: "refresh_requested", debug_info: { host: "x" } }), false);
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    expect(disconnectLogs()[0]).toContain("Slack asked for a new connection (reason: refresh_requested)");
    expect(statuses).toContainEqual({ state: "connecting", disconnectReason: "Slack asked for a new connection (reason: refresh_requested)" });

    // 网络：SDK 等不到 pong，WebSocket 以 1006 关闭。SDK 的别的 debug 日志（有消息原文）不记。
    const client = slack.socket()!;
    client.logger!.debug("Received a message on the WebSocket: 只给用户看的原文");
    client.logger!.warn("A pong wasn't received from the server before the timeout of 20000ms!");
    client.logger!.debug("WebSocket close frame received (code: 1006, reason: )");
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    expect(disconnectLogs()[1]).toContain("SDK warning: A pong wasn't received from the server before the timeout of 20000ms!");
    expect(disconnectLogs()[1]).toContain("WebSocket closed with code 1006");
    expect(logs.join("\n")).not.toContain("只给用户看的原文");

    // 谁也没说原因：写明不知道。上一次连接的原因不带到这一次。
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(4));
    expect(disconnectLogs()[2]).toContain("reason unknown: neither Slack nor the SDK said why");
    expect(disconnectLogs()[2]).not.toContain("1006");
    expect(statuses.filter((status) => status.state === "connecting").at(-1)).toEqual({
      state: "connecting", disconnectReason: "reason unknown: neither Slack nor the SDK said why",
    });
  });

  it("adds the daemon's event loop delay to a heartbeat timeout, so a stuck daemon shows apart from the network", async () => {
    setup();
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));
    // daemon 自己卡了 300 毫秒（同步的忙等），然后 SDK 报等不到 pong。
    const until = Date.now() + 300;
    while (Date.now() < until) { /* 卡住事件循环 */ }
    await sleep(60);
    const client = slack.socket()!;
    client.logger!.warn("A pong wasn't received from the server before the timeout of 20000ms!");
    client.logger!.warn("something else went wrong");
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    const line = disconnectLogs()[0]!;
    const delay = /pong wasn't received[^;]*\(daemon event loop delay in the last \d+s: max (\d+) ms, p99 \d+ ms\)/.exec(line);
    expect(delay).not.toBeNull();
    expect(Number(delay![1])).toBeGreaterThanOrEqual(250);
    // 别的警告不带。
    expect(line).toContain("SDK warning: something else went wrong");
    expect(line.match(/event loop delay/g)).toHaveLength(1);
    expect(statuses.filter((status) => status.state === "connecting").at(-1)).toMatchObject({ disconnectReason: expect.stringContaining("event loop delay") });
  });

  it("hands each catch-up the real outage: from the first drop to the last reconnect, with the drops it merged", async () => {
    setup();
    const outages: Array<ChannelOutage | null> = [];
    let gate: Promise<void> = Promise.resolve();
    bare = createSlackSocketTransport({
      options: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40, catchUpSpacingMs: 0 },
      appToken: () => FAKE_SLACK_APP_TOKEN,
      afterReconnect: async ({ outage }) => {
        outages.push(outage);
        await gate;
      },
    });
    bare.start(hub.transportContext("slack"), async () => {});
    // 第一次连上：断开的是 daemon 自己，没有断线时段。
    await vi.waitFor(() => expect(outages).toEqual([null]));

    // 断一次：补拉拿到这一次，卡住不放。
    let release!: () => void;
    gate = new Promise((resolve) => { release = resolve; });
    const firstDrop = Date.now();
    slack.dropConnection();
    await vi.waitFor(() => expect(outages).toHaveLength(2));
    expect(outages[1]).toMatchObject({ drops: 1 });
    expect(outages[1]!.disconnectedAt.getTime()).toBeGreaterThanOrEqual(firstDrop);
    expect(outages[1]!.reconnectedAt.getTime()).toBeGreaterThanOrEqual(outages[1]!.disconnectedAt.getTime());

    // 补拉还在跑时又断了两次：跑完以后的那一次补拉盖住这两次，从其中第一次断开算起。
    await sleep(20);
    const secondDrop = Date.now();
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    await sleep(20);
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(4));
    gate = Promise.resolve();
    release();
    await vi.waitFor(() => expect(outages).toHaveLength(3));
    expect(outages[2]).toMatchObject({ drops: 2 });
    expect(outages[2]!.disconnectedAt.getTime()).toBeGreaterThanOrEqual(secondDrop);
    expect(outages[2]!.disconnectedAt.getTime()).toBeGreaterThan(outages[1]!.reconnectedAt.getTime());
    expect(outages[2]!.reconnectedAt.getTime() - outages[2]!.disconnectedAt.getTime()).toBeGreaterThanOrEqual(15);
  });

  it("catches up once more after the running catch-up, however many times it reconnected, and misses nothing", async () => {
    setup();
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));
    slack.push(slack.dm("U0ZHANG", "第一条"));
    await vi.waitFor(() => expect(kinds()).toHaveLength(1));

    // 第一次断线：A 没送来。重连以后的补拉卡在 Slack 里（很慢）。
    const release = slack.holdNext("conversations.history");
    slack.dropConnection();
    slack.dm("U0ZHANG", "断线时的 A");
    await vi.waitFor(() => expect(histories()).toBe(1));

    // 补拉还在跑的时候又断了两次：B、C 也没送来。
    slack.dropConnection();
    slack.dm("U0ZHANG", "断线时的 B");
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    slack.dropConnection();
    slack.dm("U0ZHANG", "断线时的 C");
    await vi.waitFor(() => expect(slack.connections).toBe(4));
    expect(logs.filter((line) => line.includes("one more catch-up after it covers this reconnect"))).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(kinds()).toHaveLength(4));
    const texts = listEvents(db, { kind: "slack.dm.received" }).map((event) => event.payload.text);
    expect(texts).toEqual(["第一条", "断线时的 A", "断线时的 B", "断线时的 C"]);
    await sleep(50);
    // 三次重连只补了两次：卡住的那次和它后面合并的一次（不合并时是三次）。
    expect(catchUps()).toBe(2);
  });

  it("waits until the last catch-up is far enough behind before catching up again", async () => {
    setup({ catchUpSpacingMs: 300 });
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));
    slack.push(slack.dm("U0ZHANG", "第一条"));
    await vi.waitFor(() => expect(kinds()).toHaveLength(1));
    // 第一次连上的补拉刚做完：重连以后等一会儿再补，但是会补，断线时的消息不漏。
    const before = catchUps();
    slack.dropConnection();
    slack.dm("U0ZHANG", "断线时的一条");
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    expect(logs.join("\n")).toMatch(/socket: catching up in \d+ ms/);
    expect(catchUps()).toBe(before);
    // 等着的时候又重连：不再排一次。
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    expect(logs.join("\n")).toContain("a catch-up is already waiting; it covers this reconnect too");
    await vi.waitFor(() => expect(kinds()).toHaveLength(2), { timeout: 2_000 });
    await sleep(50);
    expect(catchUps()).toBe(before + 1);
  });

  it("reconnects at once after the first drop and backs off when it keeps dropping quickly", async () => {
    setup({ retryBaseMs: 150, retryMaxMs: 10_000, stableMs: 60_000 });
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));

    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(2), { timeout: 100 });
    expect(disconnectLogs()[0]).toContain("reconnecting now");

    slack.dropConnection();
    expect(disconnectLogs()[1]).toContain("reconnecting in 150 ms (2 quick disconnects in a row)");
    await sleep(60);
    expect(slack.connections).toBe(2);
    await vi.waitFor(() => expect(slack.connections).toBe(3));

    slack.dropConnection();
    expect(disconnectLogs()[2]).toContain("reconnecting in 300 ms (3 quick disconnects in a row)");
    await sleep(180);
    expect(slack.connections).toBe(3);
    await vi.waitFor(() => expect(slack.connections).toBe(4));
  });

  it("reconnects at once again after a connection that stayed up", async () => {
    setup({ retryBaseMs: 150, retryMaxMs: 10_000, stableMs: 100 });
    start();
    await vi.waitFor(() => expect(slack.connections).toBe(1));
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(2));
    slack.dropConnection();
    expect(disconnectLogs()[1]).toContain("reconnecting in 150 ms");
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    // 这次连着超过 stableMs：断开算第一次，立刻重连。
    await sleep(150);
    slack.dropConnection();
    expect(disconnectLogs()[2]).toContain("reconnecting now");
    await vi.waitFor(() => expect(slack.connections).toBe(4), { timeout: 100 });
  });
});
