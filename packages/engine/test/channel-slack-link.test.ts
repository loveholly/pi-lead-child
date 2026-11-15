// 在 Slack 里打开（2026-11-03）：会话卡上的「在 Slack 中打开」、交给 Lead 的消息事件、Lead 翻的对话列表，都带一个 https 地址，
// 点了去 Slack 里这条消息所在的地方（thread 里的回复打开那个 thread，私信打开那条私信）。
// 地址由 Slack 插件按 chat.getPermalink 的格式拼（不调接口）；工作区的网址来自 auth.test 的 url（会话方式来自会话的 apiBase，没有时按 domain 拼），
// 记进事件，daemon 重启、Slack 没连上时照样拼得出。hub 只认 https 的地址，插件给了别的协议、出了错时当作没有。
// 真的 SQLite、真的 Slack 来源插件、假的 Slack。编号都是编的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLACK_APP_TOKEN_ENV, SLACK_SESSION_COOKIE_ENV, SLACK_USER_TOKEN_ENV } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, getEvent, listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackMessageLink, slackWorkspaceUrl, type ChannelAdapter, type ChannelCredential,
} from "../src/index.js";
import {
  cardIdOf, FAKE_SLACK_APP_TOKEN, FAKE_SLACK_SESSION_COOKIE, FAKE_SLACK_TOKEN, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel,
} from "../testing/index.js";

describe("slackMessageLink: the permalink format of chat.getPermalink, built without a call", () => {
  const base = { workspaceUrl: "https://acme.slack.com", team: "T0000" };

  it("links a top-level channel message without thread_ts, with the dot removed from ts", () => {
    expect(slackMessageLink({ ...base, channel: "C0000", ts: "1700000000.000100", threadTs: null }))
      .toBe("https://acme.slack.com/archives/C0000/p1700000000000100");
    // 根消息自己带的 thread_ts 等于它的 ts：它不是回复。
    expect(slackMessageLink({ ...base, channel: "C0000", ts: "1700000000.000100", threadTs: "1700000000.000100" }))
      .toBe("https://acme.slack.com/archives/C0000/p1700000000000100");
  });

  it("links a thread reply with thread_ts of the parent and cid", () => {
    expect(slackMessageLink({ ...base, channel: "C0000", ts: "1700000005.000200", threadTs: "1700000000.000100" }))
      .toBe("https://acme.slack.com/archives/C0000/p1700000005000200?thread_ts=1700000000.000100&cid=C0000");
  });

  it("links a direct message and a group DM the same way, by the conversation ID", () => {
    expect(slackMessageLink({ ...base, channel: "D0000", ts: "1700000000.000100", threadTs: null }))
      .toBe("https://acme.slack.com/archives/D0000/p1700000000000100");
    expect(slackMessageLink({ ...base, channel: "G0000", ts: "1700000005.000200", threadTs: "1700000000.000100" }))
      .toBe("https://acme.slack.com/archives/G0000/p1700000005000200?thread_ts=1700000000.000100&cid=G0000");
  });

  it("falls back to app_redirect for the conversation when the workspace URL is not known, or there is no message", () => {
    expect(slackMessageLink({ workspaceUrl: null, team: "T0000", channel: "C0000", ts: "1700000000.000100", threadTs: null }))
      .toBe("https://slack.com/app_redirect?team=T0000&channel=C0000");
    expect(slackMessageLink({ ...base, channel: "D0000", ts: null, threadTs: null }))
      .toBe("https://slack.com/app_redirect?team=T0000&channel=D0000");
    expect(slackMessageLink({ workspaceUrl: null, team: null, channel: "C0000", ts: "1700000000.000100", threadTs: null }))
      .toBe("https://slack.com/app_redirect?channel=C0000");
  });

  it("puts nothing it did not check into the address", () => {
    expect(slackMessageLink({ ...base, channel: "C0000/../x", ts: "1700000000.000100", threadTs: null })).toBeNull();
    expect(slackMessageLink({ ...base, channel: undefined, ts: "1700000000.000100", threadTs: null })).toBeNull();
    // ts 不是「秒.六位微秒」：拼不出 p…，只打开对话。
    expect(slackMessageLink({ ...base, channel: "C0000", ts: "1700000000.1", threadTs: null }))
      .toBe("https://slack.com/app_redirect?team=T0000&channel=C0000");
    expect(slackMessageLink({ ...base, channel: "C0000", ts: "1700000005.000200", threadTs: "x&cid=C9" }))
      .toBe("https://acme.slack.com/archives/C0000/p1700000005000200");
    expect(slackMessageLink({ ...base, team: "T0000&x=1", channel: "C0000", ts: null, threadTs: null }))
      .toBe("https://slack.com/app_redirect?channel=C0000");
  });

  it("takes only an https workspace URL on slack.com, without credentials", () => {
    expect(slackWorkspaceUrl("https://acme.slack.com/")).toBe("https://acme.slack.com");
    expect(slackWorkspaceUrl("https://acme.enterprise.slack.com/")).toBe("https://acme.enterprise.slack.com");
    for (const bad of ["http://acme.slack.com/", "https://acme.slack.com.example.com/", "https://user:pw@acme.slack.com/",
      "javascript:alert(1)", "https://acme.slack.com:8443/", "", null, 42]) {
      expect(slackWorkspaceUrl(bad)).toBeNull();
    }
  });
});

describe("the plugin's link for an event payload, in both connection modes", () => {
  const payload = { channelId: "C0PROJ", ts: "1700000005.000200", threadTs: "1700000000.000100" };

  it("knows the workspace from auth.test with the app tokens, and from the session's domain with the browser session", async () => {
    const slack = new FakeSlack();
    const app = createSlackChannelAdapter({ api: slack.api });
    // 还没换过凭据：只能打开对话。
    expect(app.link!(payload)).toBe("https://slack.com/app_redirect?channel=C0PROJ");
    await app.resolveCredential!({ [SLACK_APP_TOKEN_ENV]: FAKE_SLACK_APP_TOKEN, [SLACK_USER_TOKEN_ENV]: FAKE_SLACK_TOKEN }, () => {});
    expect(app.link!(payload)).toBe("https://home.slack.com/archives/C0PROJ/p1700000005000200?thread_ts=1700000000.000100&cid=C0PROJ");

    const session = createSlackChannelAdapter({
      api: slack.api, connection: "session",
      session: { network: { fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket, maxHttpRetries: 0 } },
    });
    await session.resolveCredential!({ [SLACK_SESSION_COOKIE_ENV]: FAKE_SLACK_SESSION_COOKIE }, () => {});
    expect(session.link!(payload)).toBe("https://home.slack.com/archives/C0PROJ/p1700000005000200?thread_ts=1700000000.000100&cid=C0PROJ");
    await session.transport?.stop();
  });

  // Enterprise Grid（评审，2026-11-03）：工作区网址的主机不一定是 <domain>.slack.com。会话带着完整的网址，用它。
  it("uses the session's workspace URL, not one built from its domain", async () => {
    const slack = new FakeSlack();
    slack.sessionDomain = "acme-grid";
    const session = createSlackChannelAdapter({
      api: slack.api, connection: "session",
      session: { network: { fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket, maxHttpRetries: 0 } },
    });
    await session.resolveCredential!({ [SLACK_SESSION_COOKIE_ENV]: FAKE_SLACK_SESSION_COOKIE }, () => {});
    expect(session.link!(payload)).toBe("https://home.slack.com/archives/C0PROJ/p1700000005000200?thread_ts=1700000000.000100&cid=C0PROJ");
    await session.transport?.stop();
  });

  it("opens the thread's parent for a deleted reply, and the conversation for a deleted message outside a thread", () => {
    const adapter = createSlackChannelAdapter({ api: new FakeSlack().api });
    const at = { workspaceUrl: "https://acme.slack.com" };
    expect(adapter.link!({ ...payload, ...at, amends: "deleted" })).toBe("https://acme.slack.com/archives/C0PROJ/p1700000000000100");
    expect(adapter.link!({ ...payload, ...at, threadTs: null, amends: "deleted" })).toBe("https://slack.com/app_redirect?channel=C0PROJ");
  });
});

describe("the link reaches the card, the message event for Lead and the conversation list", () => {
  let db: Db;
  let slack: FakeSlack;
  let clock: Date;
  const hubs: ChannelHub[] = [];

  beforeEach(() => {
    db = openDb(join(tempDir("plc-slack-link-"), "plc.db"));
    clock = new Date("2026-11-03T02:00:00.000Z");
    slack = new FakeSlack({ now: () => clock, users: { U0LILEI: { name: "李雷" } } });
  });

  afterEach(async () => {
    for (const hub of hubs.splice(0)) await hub.idle();
    db.close();
  });

  // 生产里 daemon 用插件的 resolveCredential 换凭据（auth.test 带 url）。
  async function connected(): Promise<{ adapter: ChannelAdapter; credential: ChannelCredential }> {
    const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
    const credential = await adapter.resolveCredential!({ [SLACK_APP_TOKEN_ENV]: FAKE_SLACK_APP_TOKEN, [SLACK_USER_TOKEN_ENV]: FAKE_SLACK_TOKEN }, () => {});
    // 测试的投递走推来的请求（要验签名），生产走 Socket 连接：补上签名密钥。
    return { adapter, credential: { ...credential!, signingSecret: slack.credential.signingSecret } };
  }

  function hubOf(adapter: ChannelAdapter, credential: ChannelCredential | null, withLead = false): ChannelHub {
    const dispatcher = new FakeAgentTaskDispatcher(db, {});
    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => credential }, now: () => clock,
      classifyTimeoutMs: 60_000, audit: { rate: 0 },
      ...(withLead ? {
        smartModel: () => scriptedSmartModel({ answers: { ask_kind: "progress" } }),
        lead: { dispatcher, available: () => true, taken: () => false },
      } : {}),
    });
    dispatcher.hub = hub;
    hubs.push(hub);
    return hub;
  }

  it("gives a direct message's card and its message event the permalink of the latest message", async () => {
    const { adapter, credential } = await connected();
    const hub = hubOf(adapter, credential, true);
    const delivery = slack.dm("U0LILEI", "明哥，订单服务上线了吗？");
    const item = (await hub.receive("slack", delivery)).items[0]!;
    await hub.idle();
    const ts = (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;
    const permalink = `https://home.slack.com/archives/D0LILEI/p${ts.replace(".", "")}`;
    const card = hub.cardDto(getChannelCard(db, cardIdOf(db, item)!)!);
    expect(card.link).toBe(permalink);
    const [event] = listEvents(db, { kind: MESSAGE_EVENT_KIND });
    expect(event!.payload.link).toBe(permalink);
    expect(hub.recentConversations("slack")).toEqual([expect.objectContaining({ id: item.objectKey, link: permalink })]);
  });

  it("links a reply in a channel thread to that thread", async () => {
    const { adapter, credential } = await connected();
    const hub = hubOf(adapter, credential);
    const root = "1760000000.000001";
    const delivery = slack.mention("U0LILEI", "回滚方案确认一下？", { channel: "C0PROJ", thread: root });
    const item = (await hub.receive("slack", delivery)).items[0]!;
    await hub.idle();
    const ts = (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;
    expect(hub.cardDto(getChannelCard(db, cardIdOf(db, item)!)!).link)
      .toBe(`https://home.slack.com/archives/C0PROJ/p${ts.replace(".", "")}?thread_ts=${root}&cid=C0PROJ`);
  });

  it("still links after a restart while Slack is not connected: the workspace URL is in the event", async () => {
    const { adapter, credential } = await connected();
    const first = hubOf(adapter, credential);
    const item = (await first.receive("slack", slack.dm("U0LILEI", "在吗"))).items[0]!;
    await first.idle();
    expect(getEvent(db, item.seq!)!.payload.workspaceUrl).toBe("https://home.slack.com");
    // 重启以后的新插件还没换过凭据（Slack 没连上）。
    const later = hubOf(createSlackChannelAdapter({ api: slack.api, now: () => clock }), null);
    expect(later.cardDto(getChannelCard(db, cardIdOf(db, item)!)!).link).toMatch(/^https:\/\/home\.slack\.com\/archives\/D0LILEI\/p\d+$/);
  });

  it("drops a link that is not https, and survives a plugin that throws", async () => {
    const { adapter, credential } = await connected();
    const hub = hubOf(adapter, credential);
    const item = (await hub.receive("slack", slack.dm("U0LILEI", "在吗"))).items[0]!;
    await hub.idle();
    const card = getChannelCard(db, cardIdOf(db, item)!)!;
    for (const link of [() => "javascript:alert(1)", () => "slack://channel?team=T0000&id=C0000", () => "https://x:y@acme.slack.com/", () => {
      throw new Error("boom");
    }]) {
      const odd = hubOf({ ...adapter, link }, credential);
      expect(odd.cardDto(card).link).toBeNull();
    }
  });
});
