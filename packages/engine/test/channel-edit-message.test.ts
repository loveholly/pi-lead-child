// 改对话里的一条消息（2026-11-02，用户：要能改用户或者 Lead 发出去的消息）。
// Lead 用 read_channel_conversation 给的 ref 指定哪一条。只能改用户自己的账号发的消息。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub;

beforeEach(() => {
  db = openDb(join(tempDir("plc-edit-message-"), "plc.db"));
  slack = new FakeSlack({ users: { U0NINA: { name: "nina" } } });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential }, log: () => {},
  });
});

afterEach(async () => {
  await hub.idle();
  db.close();
});

const by = "lead for user via turn:turn-1";
const messageAt = (ts: string) => slack.messages.find((message) => message.ts === ts)!;

describe("editing a message in a conversation", () => {
  it("shows the ref of every message that Lead reads", async () => {
    await hub.receive("slack", slack.dm("U0NINA", "demo 在哪"));
    await hub.idle();
    await hub.sendMessage("slack:@U0NINA", { text: "晚点发你", words: "user", forUser: true, by });
    // 往对话（`:main`）发的消息落在主时间线，不进根消息下面的 thread（工单 #500）；回复消息事件才回到 thread（2026-11-02）。
    const read = await hub.readConversation("slack:@U0NINA", 10);
    expect(read.messages.map((message) => [message.role, message.ref])).toEqual([
      ["them", slack.messages[0]!.ts], ["assistant", slack.sent("D0NINA")[0]!.ts],
    ]);
    expect(read.messages.every((message) => !message.thread)).toBe(true);
  });

  it("rewrites a message that Lead sent, with the same kind of signature as a new message", async () => {
    await hub.sendMessage("slack:@U0NINA", { text: "地址是 demo.example.com", words: "assistant", forUser: false, by: "lead" });
    const sent = slack.sent("D0NINA")[0]!;
    const edited = await hub.editMessage("slack:@U0NINA", {
      ref: sent.ts, text: "地址是 demo2.example.com", words: "assistant", forUser: false, by: "lead",
    });
    expect(edited).toMatchObject({ conversation: "slack:@U0NINA", objectKey: "slack:D0NINA:main", ref: sent.ts });
    expect(messageAt(sent.ts).text).toContain("auto-reply");
    expect(messageAt(sent.ts).text.endsWith("地址是 demo2.example.com")).toBe(true);
    expect(messageAt(sent.ts).edits).toBe(1);
  });

  it("rewrites a message that the user typed in Slack, word for word when the words are the user's", async () => {
    await hub.receive("slack", slack.dm("U0NINA", "明天开会吗"));
    await hub.receive("slack", slack.selfReply("D0NINA", "明天下午三点"));
    await hub.idle();
    const mine = slack.messages.find((message) => message.text === "明天下午三点")!;
    await hub.editMessage("slack:@U0NINA", { ref: mine.ts, text: "明天下午四点", words: "user", forUser: true, by });
    expect(messageAt(mine.ts).text).toBe("明天下午四点");
    expect(messageAt(mine.ts).blocks).toBeUndefined();
  });

  it("refuses a message from someone else and a message it cannot find, without calling Slack", async () => {
    await hub.receive("slack", slack.dm("U0NINA", "这个表单要填部门吗"));
    await hub.idle();
    const theirs = slack.messages[0]!;
    await expect(hub.editMessage("slack:@U0NINA", { ref: theirs.ts, text: "x", words: "user", forUser: true, by }))
      .rejects.toMatchObject({ code: "invalid_action" });
    await expect(hub.editMessage("slack:@U0NINA", { ref: "1700000000.000100", text: "x", words: "user", forUser: true, by }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(hub.editMessage("slack:@U0NINA", { ref: theirs.ts, text: "   ", words: "user", forUser: true, by }))
      .rejects.toMatchObject({ code: "invalid_action" });
    expect(slack.calls.filter((call) => call.method === "chat.update")).toEqual([]);
    expect(messageAt(theirs.ts).text).toBe("这个表单要填部门吗");
  });

  it("says why when Slack does not let it change the message", async () => {
    await hub.sendMessage("slack:@U0NINA", { text: "第一版", words: "user", forUser: true, by });
    const sent = slack.sent("D0NINA")[0]!;
    slack.failNext("chat.update", "network down");
    await expect(hub.editMessage("slack:@U0NINA", { ref: sent.ts, text: "第二版", words: "user", forUser: true, by }))
      .rejects.toMatchObject({ code: "outbound_failed" });
  });
});
