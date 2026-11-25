// 外来消息卡上每条消息的 Slack 链接（工单 #529）：卡上点时间打开这条消息，thread 里的回复定位到 thread 里。
// 链接用 auth.test 给的工作区网址拼（和 chat.getPermalink 给的一样）；不知道网址时没有链接，卡上不显示，不出现坏链接。
// 卡上的图片按文件编号取（hub.readFile、fileOrigin）；存进事件的正文、卡上和 Lead 读到的文字标记都不变。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getEvent, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackMessageLink, slackWorkspaceUrl, type ChannelAdapter,
} from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FAKE_SLACK_USER_SCOPES, FAKE_SLACK_WORKSPACE_URL, FakeSlack } from "../testing/index.js";

const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64",
));

describe("the workspace address from auth.test", () => {
  it("keeps only https addresses on Slack's own hosts", () => {
    expect(slackWorkspaceUrl("https://acme.slack.com/")).toBe("https://acme.slack.com/");
    expect(slackWorkspaceUrl("https://acme.enterprise.slack.com")).toBe("https://acme.enterprise.slack.com/");
    expect(slackWorkspaceUrl("https://acme.slack-gov.com/")).toBe("https://acme.slack-gov.com/");
    for (const value of [
      "http://acme.slack.com/", "https://acme.slack.com.example.com/", "https://slack.com.example.com/", "https://example.com/",
      "javascript:alert(1)", "acme.slack.com", "", null, undefined, 42,
    ]) {
      expect(slackWorkspaceUrl(value), String(value)).toBeNull();
    }
  });
});

describe("a message's permalink", () => {
  const workspace = "https://acme.slack.com/";

  it("points at the message in a direct message or a channel", () => {
    expect(slackMessageLink(workspace, "slack:D0NINA:main", "1700000000.000100")).toBe("https://acme.slack.com/archives/D0NINA/p1700000000000100");
    // 频道里一条消息自己是 thread 的根：不带 thread_ts。
    expect(slackMessageLink(workspace, "slack:C0PROJ:1700000000.000100", "1700000000.000100")).toBe("https://acme.slack.com/archives/C0PROJ/p1700000000000100");
  });

  it("points at the reply inside its thread", () => {
    expect(slackMessageLink(workspace, "slack:C0PROJ:1700000000.000100", "1700000500.000200"))
      .toBe("https://acme.slack.com/archives/C0PROJ/p1700000500000200?thread_ts=1700000000.000100&cid=C0PROJ");
    expect(slackMessageLink(workspace, "slack:D0NINA:1700000000.000100", "1700000500.000200"))
      .toBe("https://acme.slack.com/archives/D0NINA/p1700000500000200?thread_ts=1700000000.000100&cid=D0NINA");
  });

  it("is null without the workspace address or with ids it does not know", () => {
    expect(slackMessageLink(null, "slack:D0NINA:main", "1700000000.000100")).toBeNull();
    for (const [objectKey, ref] of [
      ["hook:t1", "1700000000.000100"], ["slack:d0nina:main", "1700000000.000100"], ["slack:D0NINA:main", "abc"],
      ["slack:D0NINA:main", "../x"], ["slack:D0NINA:main/x", "1700000000.000100"],
    ] as const) {
      expect(slackMessageLink(workspace, objectKey, ref), `${objectKey} ${ref}`).toBeNull();
    }
  });
});

describe("message links on the cards", () => {
  let db: Db;
  let slack: FakeSlack;
  let hubs: ChannelHub[];

  beforeEach(() => {
    db = openDb(join(tempDir("plc-slack-links-"), "plc.db"));
    slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } }, scopes: [...FAKE_SLACK_USER_SCOPES, "files:read"] });
    hubs = [];
  });

  afterEach(async () => {
    for (const hub of hubs) await hub.idle();
    db.close();
  });

  function hubWith(adapter: ChannelAdapter): ChannelHub {
    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: () => {},
    });
    hubs.push(hub);
    return hub;
  }

  it("has no link before the adapter knows the workspace address", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api });
    expect(adapter.messageLink?.("slack:D0NINA:main", "1700000000.000100")).toBeNull();
    const hub = hubWith(adapter);
    await hub.receive("slack", slack.dm("U0NINA", "在吗"));
    await hub.idle();
    const [card] = hub.listCards();
    expect(card!.recent).toEqual([{ at: expect.any(String), text: "在吗" }]);
  });

  it("links each message to Slack once auth.test gave the workspace address, and keeps the text as it was", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api });
    await adapter.resolveCredential!({ PLC_SLACK_APP_TOKEN: FAKE_SLACK_APP_TOKEN, PLC_SLACK_USER_TOKEN: FAKE_SLACK_TOKEN }, () => {});
    const hub = hubWith(adapter);
    const shot = slack.addFile("chart.png", "image/png", PNG);
    const first = (await hub.receive("slack", slack.dm("U0NINA", "发布了", { files: [shot] }))).items[0]!;
    const second = (await hub.receive("slack", slack.dm("U0NINA", "看下这个"))).items[0]!;
    await hub.idle();
    const marker = `[图片 chart.png，文件编号 slack:${shot.id}]`;
    // 存进事件的正文不变。
    expect(getEvent(db, first.seq!)!.payload.text).toBe(`发布了\n${marker}`);
    const [card] = hub.listCards();
    const ts = (seq: number) => String(getEvent(db, seq)!.payload.ts);
    expect(card!.recent).toEqual([
      { at: expect.any(String), text: `发布了\n${marker}`, url: `${FAKE_SLACK_WORKSPACE_URL}archives/D0NINA/p${ts(first.seq!).replace(".", "")}` },
      { at: expect.any(String), text: "看下这个", url: `${FAKE_SLACK_WORKSPACE_URL}archives/D0NINA/p${ts(second.seq!).replace(".", "")}` },
    ]);
    // Lead 读到的对话照旧是文字标记。
    const read = await hub.readConversation("slack:@U0NINA", 10);
    expect(read.messages.map((message) => message.text)).toEqual([`发布了\n${marker}`, "看下这个"]);
    // 卡上的图片按文件编号取：出现过的文件认得出来，取到的是原图。
    expect(hub.fileOrigin(`slack:${shot.id}`)).not.toBeNull();
    expect(hub.fileOrigin("slack:F0NEVERSEEN")).toBeNull();
    const file = await hub.readFile(`slack:${shot.id}`, 1_000_000);
    expect(Buffer.from(file.data).equals(Buffer.from(PNG))).toBe(true);
  });

  it("points a thread reply at the reply inside its thread", async () => {
    const adapter = createSlackChannelAdapter({ api: slack.api });
    await adapter.resolveCredential!({ PLC_SLACK_APP_TOKEN: FAKE_SLACK_APP_TOKEN, PLC_SLACK_USER_TOKEN: FAKE_SLACK_TOKEN }, () => {});
    const hub = hubWith(adapter);
    const root = (await hub.receive("slack", slack.mention("U0NINA", "发布了吗", { channel: "C0PROJ" }))).items[0]!;
    const rootTs = String(getEvent(db, root.seq!)!.payload.ts);
    const reply = (await hub.receive("slack", slack.mention("U0NINA", "前后端都发布了", { channel: "C0PROJ", thread: rootTs }))).items[0]!;
    await hub.idle();
    const replyTs = String(getEvent(db, reply.seq!)!.payload.ts);
    const card = hub.listCards().find((candidate) => candidate.objectKey === `slack:C0PROJ:${rootTs}`)!;
    expect(card.recent?.map((message) => message.url)).toEqual([
      `${FAKE_SLACK_WORKSPACE_URL}archives/C0PROJ/p${rootTs.replace(".", "")}`,
      `${FAKE_SLACK_WORKSPACE_URL}archives/C0PROJ/p${replyTs.replace(".", "")}?thread_ts=${rootTs}&cid=C0PROJ`,
    ]);
  });
});
