// 通道接口的入口和出口（落地计划 A1，.scratch/confidence-model/landing.md）：Slack 适配器认出「回复的是哪一条」和每条消息
// 自己的引用，hub 把它们记进事件；取历史（只读）；改写一条已经发出去的消息；回表情。Slack 是假的，照真 Slack 的规则报错。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getEvent, getOpenChannelCard, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelAdapter, type ChannelAdapterContext } from "../src/index.js";
import { FakeSlack, FAKE_SLACK_USER_SCOPES } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-io-"), "plc.db"));
  clock = new Date("2026-10-22T03:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0ETHAN: { name: "王小明" } } });
});

afterEach(() => {
  db.close();
});

function setup(): { hub: ChannelHub; adapter: ChannelAdapter; context: ChannelAdapterContext } {
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    log: () => {},
  });
  return { hub, adapter, context: { credential: slack.credential, log: () => {} } };
}

const tsOf = (delivery: { body: string }) => (JSON.parse(delivery.body) as { event: { ts: string } }).event.ts;

describe("inbound: which message a reply answers", () => {
  // 2026-10-22：王小明昨天在私信里发了两个 PR 链接，今天在那条消息的 thread 里说「pr comment 改了，再帮忙看看」。
  // thread 的道里只有这一句，根消息在整段私信的道里：要让 hub 知道它回复的是哪一条。
  it("marks a reply in a DM thread with the root message and the conversation the root is in", async () => {
    const { hub } = setup();
    const root = slack.dm("U0ETHAN", "github.com/Acme/x/pull/101 github.com/Acme/x/pull/102 我大体上看了一下");
    const first = (await hub.receive("slack", root)).items[0]!;
    expect(first.objectKey).toBe("slack:D0ETHAN:main");
    expect(getEvent(db, first.seq!)!.payload).toMatchObject({ messageRef: { channel: "D0ETHAN", ts: tsOf(root) } });
    expect(getEvent(db, first.seq!)!.payload.replyTo).toBeUndefined();

    const reply = slack.dm("U0ETHAN", "pr comment 改了，再帮忙看看 :eyes:", { thread: tsOf(root) });
    const second = (await hub.receive("slack", reply)).items[0]!;
    expect(second.objectKey).toBe(`slack:D0ETHAN:${tsOf(root)}`);
    expect(getEvent(db, second.seq!)!.payload).toMatchObject({
      messageRef: { channel: "D0ETHAN", ts: tsOf(reply) },
      replyTo: { objectKey: "slack:D0ETHAN:main", ref: tsOf(root) },
    });
  });

  // 用户 2026-11-02：DM 里很多人直接在根上发消息。回复默认进 thread：挂在这条消息下面，没有 thread 就开一个。
  // 整段私信还是一个道（:main），只有回复的位置变了。
  it("answers a DM root message in a thread under it, and keeps the whole DM as one conversation", async () => {
    const { hub } = setup();
    const root = slack.dm("U0ETHAN", "Could you take a look at the deploy doc?");
    const item = (await hub.receive("slack", root)).items[0]!;
    expect(item.objectKey).toBe("slack:D0ETHAN:main");
    expect(getOpenChannelCard(db, item.objectKey)!.replyTarget).toEqual({ channel: "D0ETHAN", thread_ts: tsOf(root) });

    const reply = slack.dm("U0ETHAN", "the second section", { thread: tsOf(root) });
    const second = (await hub.receive("slack", reply)).items[0]!;
    expect(getOpenChannelCard(db, second.objectKey)!.replyTarget).toEqual({ channel: "D0ETHAN", thread_ts: tsOf(root) });
  });

  it("in a channel thread the root and the replies share one conversation", async () => {
    const { hub } = setup();
    const root = slack.mention("U0ETHAN", "这个接口的超时是多少？");
    const first = (await hub.receive("slack", root)).items[0]!;
    const reply = slack.mention("U0ETHAN", "补充：生产环境", { thread: tsOf(root) });
    const second = (await hub.receive("slack", reply)).items[0]!;
    expect(getEvent(db, second.seq!)!.payload).toMatchObject({ replyTo: { objectKey: first.objectKey, ref: tsOf(root) } });
  });
});

describe("history (read only)", () => {
  it("reads a thread oldest first, with the root, and tells the other person, the user and the assistant apart", async () => {
    const { adapter, context } = setup();
    const root = slack.dm("U0ETHAN", "两个 PR 帮忙看看");
    const thread = tsOf(root);
    clock = new Date("2026-10-22T03:01:00.000Z");
    await adapter.send({ action: "reply", objectKey: "slack:D0ETHAN:main", target: { channel: "D0ETHAN", thread_ts: thread }, text: "已在 PR 留了 1 条评论" },
      { idempotencyKey: "reply:1" }, context);
    clock = new Date("2026-10-22T03:02:00.000Z");
    slack.selfReply("D0ETHAN", "我再看一下 #102", { thread });
    clock = new Date("2026-10-22T03:03:00.000Z");
    slack.dm("U0ETHAN", "pr comment 改了，再帮忙看看", { thread });

    const messages = await adapter.history!({ objectKey: "slack:D0ETHAN:main", ref: thread, limit: 10 }, context);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["them", "两个 PR 帮忙看看"],
      ["assistant", "已在 PR 留了 1 条评论"],
      ["me", "我再看一下 #102"],
      ["them", "pr comment 改了，再帮忙看看"],
    ]);
    expect(messages[0]).toMatchObject({ ref: thread, sender: { id: "U0ETHAN", name: "王小明" } });
    // 道就是 thread 时不用给 ref；条数不够时留根消息和最近的回复。
    const recent = await adapter.history!({ objectKey: `slack:D0ETHAN:${thread}`, limit: 2 }, context);
    expect(recent.map((message) => message.text)).toEqual(["两个 PR 帮忙看看", "pr comment 改了，再帮忙看看"]);
  });

  it("reads the recent messages of a whole conversation and refuses another source's key", async () => {
    const { adapter, context } = setup();
    slack.dm("U0ETHAN", "第一条");
    slack.dm("U0ETHAN", "第二条");
    expect((await adapter.history!({ objectKey: "slack:D0ETHAN:main", limit: 5 }, context)).map((message) => message.text))
      .toEqual(["第一条", "第二条"]);
    await expect(adapter.history!({ objectKey: "jira:ABC-1:main", limit: 5 }, context)).rejects.toThrow("not a Slack conversation");
  });
});

// 用户 2026-11-02：Lead 按 Markdown 写给别人的话，以前原样当 mrkdwn 发，对方看到 **粗体** 两边的星号。
// 带署名的话（Lead 写的）发到 Slack 时换成 mrkdwn；用户的原话不带署名，原样发。
describe("outbound: Lead writes Markdown", () => {
  const markdown = "**Done.** See [the doc](https://example.com/doc)\n- step one";

  it("sends Lead's Markdown to someone else as mrkdwn, in the text and in the blocks", async () => {
    const { hub } = setup();
    await hub.sendMessage("slack:D0ETHAN:main", { text: markdown, words: "assistant", by: "lead", forUser: false });
    const message = slack.sent("D0ETHAN").at(-1)!;
    expect(message.text).toContain("*Done.* See <https://example.com/doc|the doc>\n• step one");
    expect(message.text).not.toContain("**");
    expect(JSON.stringify(message.blocks)).toContain("*Done.* See <https://example.com/doc|the doc>");
  });

  // 2026-11-20：Lead 代用户写「@Nina Wang 麻烦…」，发出去还是纯文字，Slack 不通知对方。只出现在别人消息里的人，
  // 模型看到的是「@名字」（slackDisplayText），没有编号。发送时按工作区的名单把「@名字」换回提及。
  it("turns @names in Lead's words into Slack mentions, so the person gets notified", async () => {
    slack.users.set("U0NINA", { name: "Nina Wang (ENG - SRE)", realName: "Nina Wang" });
    const { hub } = setup();
    await hub.sendMessage("slack:D0ETHAN:main", {
      text: "@Nina Wang 麻烦把表里的数改一下，谢谢。", words: "assistant", by: "lead", forUser: false,
    });
    const message = slack.sent("D0ETHAN").at(-1)!;
    expect(message.text).toContain("<@U0NINA> 麻烦把表里的数改一下");
    expect(JSON.stringify(message.blocks)).toContain("<@U0NINA> 麻烦");
  });

  it("sends the user's own words as they are", async () => {
    const { hub } = setup();
    await hub.sendMessage("slack:D0ETHAN:main", { text: "*bold* in Slack syntax", words: "user", by: "user", forUser: true });
    expect(slack.sent("D0ETHAN").at(-1)!.text).toBe("*bold* in Slack syntax");
  });
});

describe("outbound: edit and react", () => {
  it("edits a message the user posted, keeps its ts, and replaces or clears the byline blocks", async () => {
    const { adapter, context } = setup();
    const notice = await adapter.send({
      action: "reply", objectKey: "slack:D0ETHAN:main", target: { channel: "D0ETHAN" }, text: "Fairy (Assistant) is reviewing…",
      parts: { byline: "Fairy (Assistant) is reviewing…", body: null },
    }, { idempotencyKey: "handling:1" }, context);
    const edited = await adapter.send({
      action: "edit", objectKey: "slack:D0ETHAN:main", target: notice.remoteRef, text: "Fairy (Assistant)\n已在 PR 留了 1 条评论",
      parts: { byline: "Fairy (Assistant)", body: "已在 PR 留了 1 条评论" },
    }, { idempotencyKey: "reply:1" }, context);
    expect(edited.remoteRef).toEqual(notice.remoteRef);
    const message = slack.sent("D0ETHAN").find((candidate) => candidate.ts === notice.remoteRef.ts)!;
    expect(message).toMatchObject({ text: "Fairy (Assistant)\n已在 PR 留了 1 条评论", edits: 1 });
    expect(JSON.stringify(message.blocks)).toContain("已在 PR 留了 1 条评论");
    // 只发文字时清掉原来的 blocks，免得 Slack 还显示旧的状态。
    await adapter.send({ action: "edit", objectKey: "slack:D0ETHAN:main", target: notice.remoteRef, text: "好的" }, { idempotencyKey: "reply:2" }, context);
    expect(slack.sent("D0ETHAN").find((candidate) => candidate.ts === notice.remoteRef.ts)!.blocks).toBeUndefined();
  });

  it("cannot edit someone else's message or a deleted one", async () => {
    const { adapter, context } = setup();
    const theirs = slack.dm("U0ETHAN", "别人的消息");
    await expect(adapter.send({ action: "edit", objectKey: "slack:D0ETHAN:main", target: { channel: "D0ETHAN", ts: tsOf(theirs) }, text: "x" },
      { idempotencyKey: "e:1" }, context)).rejects.toThrow("cant_update_message");
    await expect(adapter.send({ action: "edit", objectKey: "slack:D0ETHAN:main", target: { channel: "D0ETHAN", ts: "1.000001" }, text: "x" },
      { idempotencyKey: "e:2" }, context)).rejects.toThrow("message_not_found");
  });

  it("reacts once; a second time is a safe duplicate; a bad name and a missing scope fail", async () => {
    const { adapter, context } = setup();
    const thanks = slack.dm("U0ETHAN", "诶 我看到验收反馈已经有结论啦～ 谢谢明哥！");
    const target = { channel: "D0ETHAN", ts: tsOf(thanks) };
    expect(await adapter.send({ action: "react", objectKey: "slack:D0ETHAN:main", target, emoji: "pray" }, { idempotencyKey: "r:1" }, context))
      .toEqual({ remoteRef: { ...target, emoji: "pray" }, duplicate: false });
    expect(slack.messageOf(thanks).reactions).toEqual([{ name: "pray", users: [slack.credential.account] }]);
    expect((await adapter.send({ action: "react", objectKey: "slack:D0ETHAN:main", target, emoji: "pray" }, { idempotencyKey: "r:1" }, context)).duplicate)
      .toBe(true);
    await expect(adapter.send({ action: "react", objectKey: "slack:D0ETHAN:main", target, emoji: ":pray:" }, { idempotencyKey: "r:2" }, context))
      .rejects.toThrow("emoji name");

    // 旧的令牌没有 reactions:write：回不了表情，报 missing_scope（hub 当作这个来源不能回表情）。
    slack = new FakeSlack({ now: () => clock, scopes: FAKE_SLACK_USER_SCOPES.filter((scope) => scope !== "reactions:write") });
    const { adapter: old, context: oldContext } = setup();
    const message = slack.dm("U0ETHAN", "谢谢！");
    await expect(old.send({ action: "react", objectKey: "slack:D0ETHAN:main", target: { channel: "D0ETHAN", ts: tsOf(message) }, emoji: "pray" },
      { idempotencyKey: "r:3" }, oldContext)).rejects.toThrow("missing_scope");
  });

  it("declares what it can do", () => {
    expect(setup().adapter.capabilities).toEqual({ reply: true, retract: true, edit: true, react: true, history: true });
  });
});
