// 通道接口的入口和出口（落地计划 A1，.scratch/confidence-model/landing.md）：Slack 适配器认出「回复的是哪一条」和每条消息
// 自己的引用，hub 把它们记进事件；取历史（只读）；改写一条已经发出去的消息；回表情。Slack 是假的，照真 Slack 的规则报错。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getEvent, openDb, type Db } from "@pi-lead-child/store";
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
