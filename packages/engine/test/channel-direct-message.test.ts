// 往外部来源的一个对话里直接发消息，不经过卡片（用户 2026-10-23：「我需要 lead 具备直接发 slack 的消息能力，而不是依赖于通道卡片」）。
// 真的 hub、真的 Slack 来源插件，Slack 是假的：按人名、频道名找对话；私信某个人（已有的私信、要新开的私信）、频道、thread；
// 用户的原话原样发，Lead 组织的话带 confirmed by 署名；对话编号不对、开不了私信时说明原因。
// 只在用户本人这一轮里能发（操作层）在 ui-actions.test.ts，经过 daemon 的整条路在 apps/daemon/test/channel-reply-for-user-daemon.test.ts。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub;

beforeEach(() => {
  db = openDb(join(tempDir("plc-direct-message-"), "plc.db"));
  slack = new FakeSlack({
    users: { U0OLIVER: { name: "oliver.z", realName: "Oliver Zhou" }, U0OLIVIA: { name: "olivia", realName: "Olivia Wu" } },
    channels: { C0PROJ: "proj-x", C0OPS: "ops" },
    noDirect: ["U0OLIVIA"],
  });
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

describe("finding a conversation", () => {
  it("finds people by real or display name and the user's channels by name, never the user", async () => {
    expect(await hub.findConversations("slack", "oli")).toEqual([
      { id: "slack:@U0OLIVER", kind: "person", label: "Oliver Zhou", detail: null },
      { id: "slack:@U0OLIVIA", kind: "person", label: "Olivia Wu", detail: null },
    ]);
    expect(await hub.findConversations("slack", "PROJ")).toEqual([{ id: "slack:C0PROJ:main", kind: "channel", label: "#proj-x", detail: null }]);
    expect(await hub.findConversations("slack", "我")).toEqual([]);
    expect(await hub.findConversations("slack", "  ")).toEqual([]);
    await expect(hub.findConversations("jira", "oli")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("sending a message without a card", () => {
  it("sends the user's own words as they are, to a person, a channel and a thread", async () => {
    const dm = await hub.sendMessage("slack:@U0OLIVER", { text: "就是之前给你演示的 demo", words: "user", forUser: true, by });
    expect(dm).toEqual({
      conversation: "slack:@U0OLIVER", label: "oliver.z的私信", objectKey: "slack:D0OLIVER:main", text: "就是之前给你演示的 demo", card: null,
      outcome: "sent",
    });
    expect(slack.sent("D0OLIVER").map((message) => [message.text, message.thread_ts])).toEqual([["就是之前给你演示的 demo", undefined]]);

    await hub.sendMessage("slack:C0PROJ:main", { text: "下午三点发版", words: "user", forUser: true, by });
    await hub.sendMessage("slack:C0PROJ:1760000123.000100", { text: "收到", words: "user", forUser: true, by });
    expect(slack.sent("C0PROJ").map((message) => [message.text, message.thread_ts])).toEqual([
      ["下午三点发版", undefined], ["收到", "1760000123.000100"],
    ]);
    // 出站的账本记了这三条，不挂在任何卡上。
    expect(listEvents(db, { kind: "channel.outbound.completed" }).map((event) => event.payload.cardId)).toEqual([null, null, null]);
  });

  it("puts the confirmed-by byline on words Lead wrote, and masks emails in them", async () => {
    await hub.sendMessage("slack:@U0OLIVER", { text: "demo 的地址发你邮箱了：leo@example.com", words: "assistant", forUser: true, by });
    const [message] = slack.sent("D0OLIVER");
    expect(message!.text.split("\n")[0]).toBe(":robot_face: Paimon (Assistant) · confirmed by 我");
    expect(message!.text).not.toContain("leo@example.com");
  });

  it("opens a direct message only with im:write, and says why it cannot otherwise", async () => {
    await expect(hub.sendMessage("slack:@U0OLIVIA", { text: "在吗", words: "user", forUser: true, by })).rejects.toMatchObject({
      code: "not_found", message: expect.stringContaining("im:write"),
    });
    expect(slack.sent()).toEqual([]);
    slack.scopes.push("im:write");
    await hub.sendMessage("slack:@U0OLIVIA", { text: "在吗", words: "user", forUser: true, by });
    expect(slack.sent("D0OLIVIA").map((message) => message.text)).toEqual(["在吗"]);
  });

  it("refuses a conversation id it does not understand", async () => {
    await expect(hub.sendMessage("slack:oliver", { text: "hi", words: "user", forUser: true, by })).rejects.toMatchObject({
      code: "not_found", message: expect.stringContaining("对话编号不对"),
    });
    await expect(hub.sendMessage("jira:PROJ-1", { text: "hi", words: "user", forUser: true, by })).rejects.toMatchObject({ code: "unavailable" });
    expect(hub.canSendMessage("slack")).toBe(true);
    expect(hub.canSendMessage("jira")).toBe(false);
  });
});

// 用户 2026-10-26：Lead 要能读 Slack 里一个对话的消息，确认上下文。只读：不开卡、不发任何东西。
describe("reading a conversation", () => {
  it("reads the latest messages of a person's direct message, oldest first, with the event number of messages it received", async () => {
    const delivery = slack.dm("U0OLIVER", "demo 的地址是哪个？");
    const received = (await hub.receive("slack", delivery)).items[0]!;
    await hub.idle();
    await hub.sendMessage("slack:@U0OLIVER", { text: "晚点发你", words: "user", forUser: true, by });
    const read = await hub.readConversation("slack:@U0OLIVER", 10);
    expect(read).toMatchObject({ conversation: "slack:@U0OLIVER", label: "oliver.z的私信", objectKey: "slack:D0OLIVER:main" });
    expect(read.messages.map((message) => [message.role, message.text, message.seq])).toEqual([
      ["them", "demo 的地址是哪个？", received.seq], ["assistant", "晚点发你", null],
    ]);
    expect(hub.recentConversations("slack")).toMatchObject([{ id: "slack:D0OLIVER:main", label: "oliver.z的私信" }]);
    expect(hub.recentConversations("jira")).toEqual([]);
    // 读不发东西。
    expect(slack.sent("D0OLIVER")).toHaveLength(1);
  });

  it("says why it cannot read a conversation", async () => {
    await expect(hub.readConversation("slack:oliver", 10)).rejects.toMatchObject({ code: "not_found" });
    await expect(hub.readConversation("jira:PROJ-1", 10)).rejects.toMatchObject({ code: "unavailable" });
  });
});
