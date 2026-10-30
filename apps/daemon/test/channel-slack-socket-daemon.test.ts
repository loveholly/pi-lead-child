// slack-takeover 工单 02（spec D11）：生产入口的接法走完 daemon 的每一跳。daemon、store、通道 hub、Slack 插件、
// 真实的 SlackWebApi（Slack 官方的 WebClient）都是真的；Slack 是假的（FakeSlack 的 fetch 和假的 SocketModeClient），
// Lead 的会话是替身。channels.live 和 main.ts 给的一样，只是注入了假的 fetch 和 Socket 客户端。
//   1. 两个令牌缺一个：daemon 照常启动，Slack 登记了但不连（等用户在设置页存令牌，slack-settings 工单 S1），
//      日志说缺哪个名字（不写值），不调 Slack。
//   2. 两个令牌都有：凭据由 auth.test、users.info 换来，不要 connections 表的连接行；Socket 送来的私信先 ack 再开卡；
//      线程里不带 @ 的后续消息进同一张卡；订阅频道的普通消息只记录；断线重连以后补拉，不重复；令牌不进日志、事件和卡。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "@pi-lead-child/engine/testing";
import { listConnections, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-slack-socket-daemon-");
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

async function boot(slack: FakeSlack): Promise<string[]> {
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: fakePiLead(async () => ({ say: "好的。" })).factory as never, log: (line) => logs.push(line),
    triageShadow: false,
    channels: { live: { fetch: slack.fetch, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 50 } } },
  });
  return logs;
}

const stored = () => JSON.stringify([
  db.prepare("SELECT * FROM events").all(), db.prepare("SELECT * FROM channel_lanes").all(), db.prepare("SELECT * FROM channel_cards").all(),
]);

describe("Slack over Socket Mode in the daemon", () => {
  it("starts without connecting Slack when one of the two tokens is missing, naming only the missing name", async () => {
    const slack = new FakeSlack();
    vi.stubEnv("PLC_SLACK_APP_TOKEN", FAKE_SLACK_APP_TOKEN);
    vi.stubEnv("PLC_SLACK_USER_TOKEN", "");
    const logs = await boot(slack);
    // 登记了（设置页存了令牌就能马上连上），但传输没有启动。
    expect(daemon!.channels!.registry.list().map((adapter) => adapter.id)).toEqual(["slack"]);
    expect(logs.join("\n")).toContain("[channels] slack is not configured: missing PLC_SLACK_USER_TOKEN");
    expect(logs.filter((line) => line.includes("socket:"))).toEqual([]);
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_APP_TOKEN);
    expect(slack.socketClients).toEqual([]);
    expect(slack.requests).toEqual([]);
    // daemon 专用的密钥不留在 daemon 的环境里（child 继承 daemon 的环境）。
    expect(process.env.PLC_SLACK_APP_TOKEN).toBeUndefined();
  });

  it("takes Slack in over Socket Mode and the real Web API, catches up after a reconnect, and never stores a token", async () => {
    const slack = new FakeSlack({ channels: { C0PROJ: "proj-x" } });
    vi.stubEnv("PLC_SLACK_APP_TOKEN", FAKE_SLACK_APP_TOKEN);
    vi.stubEnv("PLC_SLACK_USER_TOKEN", FAKE_SLACK_TOKEN);
    const logs = await boot(slack);
    expect(daemon!.channels).not.toBeNull();
    await vi.waitFor(() => expect(slack.socket()).toBeDefined());
    expect(process.env.PLC_SLACK_USER_TOKEN).toBeUndefined();
    // 凭据：auth.test 和 users.info 走真实的 WebClient（令牌在 Authorization 头里，参数是表单）；不要连接行。
    expect(slack.requests.filter((request) => request.method === "auth.test")).toEqual([
      { method: "auth.test", contentType: "application/x-www-form-urlencoded", bearer: true },
    ]);
    expect(listConnections(db)).toEqual([]);

    // 张三的私信从 Socket 进来：先 ack，再开卡。
    const dm = slack.dm("U0ZHANG", "周五评审的材料收到了吗？");
    const envelope = slack.push(dm);
    await vi.waitFor(() => expect(daemon!.channels!.listCards()).toHaveLength(1));
    expect(slack.acks).toEqual([envelope]);
    expect(daemon!.channels!.listCards()[0]).toMatchObject({
      source: "slack", laneLabel: "张三的私信", sender: { name: "张三", trust: "colleague" }, state: "open", messageCount: 1,
    });

    // 频道里提到你，再在线程里补充一句（不带 @）：同一张卡。订阅频道里别人的普通消息：只记录。
    const mention = slack.mention("U0LI", "这个接口的超时是多少？");
    slack.push(mention);
    slack.push(slack.chatter("U0LI", "是生产环境的", "C0PROJ", { thread: slack.messageOf(mention).ts }));
    slack.push(slack.chatter("U0ZHANG", "今天谁值班？"));
    await vi.waitFor(() => expect(listEvents(db, { kind: "slack.channel.message" })).toHaveLength(1));
    const threadCard = daemon!.channels!.listCards().find((card) => card.laneLabel === "#proj-x 里的讨论")!;
    expect(threadCard).toMatchObject({ messageCount: 2, excerpt: "是生产环境的" });
    expect(listEvents(db, { kind: "slack.channel.message" })[0]).toMatchObject({ level: "record" });
    expect(daemon!.channels!.listCards()).toHaveLength(2);

    // 断线期间张三又发了一条：重连以后补上，只记一次（Slack 后来又送一次也不重复）。
    slack.dropConnection();
    const missed = slack.dm("U0ZHANG", "断线时发的");
    await vi.waitFor(() => expect(listEvents(db, { kind: "slack.dm.received" })).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(slack.socket()).toBeDefined());
    slack.push(missed);
    await vi.waitFor(() => expect(slack.acks).toHaveLength(5));
    await daemon!.close();
    daemon = null;
    expect(listEvents(db, { kind: "slack.dm.received" }).map((event) => event.payload.text)).toEqual(["周五评审的材料收到了吗？", "断线时发的"]);
    expect(slack.socket()).toBeUndefined();

    for (const token of [FAKE_SLACK_TOKEN, FAKE_SLACK_APP_TOKEN]) {
      expect(stored()).not.toContain(token);
      expect(logs.join("\n")).not.toContain(token);
    }
  }, 30_000);
});
