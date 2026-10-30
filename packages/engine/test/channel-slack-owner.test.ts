// 用户发给自己的 Slack 私信（用户 2026-10-30：「直接交给 Lead，并且只要确认是我本人，就跟 companion 的权限保持一致，
// 只是 reply 要遵循 slack 的语法规范」）。走真实的 hub 和 SQLite，Slack 是假的：
//   - 只有用户本人发在「对方是自己」的私信里的话交给 daemon（ChannelHubOptions.owner），不记成通道的事件；
//   - 发给别人的私信、推回来的回复照旧；
//   - daemon 不收时照用户本人的话处理；
//   - 回复按 Slack 的 mrkdwn 发回那条私信，推回来时认成 echo，不会再交给 Lead。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackMrkdwnFromMarkdown, type ChannelOwnerMessage,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-owner-"), "plc.db"));
  clock = new Date("2026-10-30T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  logs = [];
});

afterEach(() => {
  db.close();
});

function setup(owner?: (message: ChannelOwnerMessage) => boolean): ChannelHub {
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  return new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    log: (line) => logs.push(line), assistantName: () => "Fairy", ...(owner ? { owner } : {}),
  });
}

const SELF_DM = "D0SELF";

describe("the user's own Slack DM to themself", () => {
  it("hands the message to the daemon as the user's own words, and records no channel event", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return true;
    });
    const result = await hub.receive("slack", slack.selfReply(SELF_DM, "帮我看下 <#C0PROJ> 今天的发布"));
    expect(result.items).toEqual([expect.objectContaining({ role: "owner", handedTo: "owner", seq: null, objectKey: `slack:${SELF_DM}:main` })]);
    expect(handed).toEqual([expect.objectContaining({
      source: "slack", account: slack.self.id, accountName: slack.self.name, conversation: `slack:${SELF_DM}:main`,
      text: "帮我看下 #proj-x 今天的发布",
    })]);
    expect(handed[0]!.deliveryId).toMatch(/^D0SELF:/u);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'slack'").get()).toEqual({ n: 0 });
  });

  it("keeps the old handling for the user's words to someone else, and when the daemon does not take it", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return false;
    });
    // 发给张三的私信：用户本人的话，不是写给 Lead 的。
    const toZhang = await hub.receive("slack", slack.selfReply("D0ZHANG", "好的，我下午看"));
    expect(toZhang.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
    // daemon 不收（例如用户撤销了这个入口）：照用户本人的话处理，和以前一样。
    const refused = await hub.receive("slack", slack.selfReply(SELF_DM, "备忘：周五续费"));
    expect(refused.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
    expect(handed.map((message) => message.text)).toEqual(["备忘：周五续费"]);
    // 没有 daemon 的回调：也照旧。
    const plain = await setup().receive("slack", slack.selfReply(SELF_DM, "再记一条"));
    expect(plain.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
  });

  it("replies in Slack mrkdwn with Lead's name, once per key, and does not hand the echo back to Lead", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return true;
    });
    const sent = await hub.replyToOwner(`slack:${SELF_DM}:main`, "## 结论\n**今天不发布**，见 [日历](https://cal.test/x)。", "turn_1");
    expect(sent).toEqual({ objectKey: `slack:${SELF_DM}:main`, status: "sent" });
    const posted = slack.messages.filter((message) => message.channel === SELF_DM);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toBe(":robot_face: Fairy (Assistant)\n*结论*\n*今天不发布*，见 <https://cal.test/x|日历>。");
    // 同一个键再发一次（例如 daemon 重试）：不发第二条。
    expect(await hub.replyToOwner(`slack:${SELF_DM}:main`, "别的", "turn_1")).toMatchObject({ status: "already_sent" });
    expect(slack.messages.filter((message) => message.channel === SELF_DM)).toHaveLength(1);
    // Slack 把这条回复推回来：是系统发的，不是用户写给 Lead 的话。
    const echo = await hub.receive("slack", slack.echoOf(posted[0]!));
    expect(echo.items[0]).toMatchObject({ role: "echo" });
    expect(handed).toHaveLength(0);
  });
});

describe("Markdown to Slack mrkdwn", () => {
  it("converts headings, emphasis, links, lists and tables, and leaves code alone", () => {
    const markdown = [
      "# 标题",
      "**粗体** 和 *斜体* 和 ~~删掉~~，见 [文档](https://doc.test/a)",
      "- 第一项 **重点**",
      "* 第二项",
      "",
      "| 名字 | 状态 |",
      "|---|---|",
      "| A | ok |",
      "",
      "```ts",
      "const a = **b** * c;",
      "```",
      "行内 `**不动**` 的代码",
    ].join("\n");
    expect(slackMrkdwnFromMarkdown(markdown)).toBe([
      "*标题*",
      "*粗体* 和 _斜体_ 和 ~删掉~，见 <https://doc.test/a|文档>",
      "• 第一项 *重点*",
      "• 第二项",
      "",
      "```",
      "| 名字 | 状态 |",
      "|---|---|",
      "| A | ok |",
      "```",
      "",
      "```",
      "const a = **b** * c;",
      "```",
      "行内 `**不动**` 的代码",
    ].join("\n"));
  });
});
