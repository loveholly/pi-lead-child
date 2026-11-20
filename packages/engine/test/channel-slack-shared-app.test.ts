// 别人也装了用户的 Slack 应用（用户 2026-11-02）：Slack 按应用投递用户事件，装了这个应用的人能看到的消息都会推过来，
// 包括同事和别人的私信。一个事件只发一次，authorizations 里只写一个能看到它的人。只收用户本人能看到的事件：
//   - authorizations 里是用户本人：照常收，不多问 Slack；
//   - 写的是别人：用 event_context 调 apps.event.authorizations.list 查完整名单，名单里有用户本人才收；
//   - 名单里没有用户本人，或者查不到（例如 App-Level Token 缺 authorizations:read）：丢掉，日志里说原因。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelAdapter } from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-shared-app-"), "plc.db"));
  slack = new FakeSlack({ appScopes: ["connections:write", "authorizations:read"] });
  logs = [];
});

afterEach(() => {
  db.close();
});

function setup(options: { socket?: boolean } = {}): { hub: ChannelHub; adapter: ChannelAdapter } {
  const adapter = createSlackChannelAdapter({
    api: slack.api, ...(options.socket ? { socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40, catchUpSpacingMs: 0 } } : {}),
  });
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: (line) => logs.push(line),
  });
  return { hub, adapter };
}

const slackEvents = () => listEvents(db, {}).filter((event) => event.source === "slack");
const lookups = () => slack.calls.filter((call) => call.method === "apps.event.authorizations.list");

describe("a Slack app that other people installed too", () => {
  it("drops a direct message between two colleagues that only one of them can see", async () => {
    const { hub } = setup();
    const theirs = slack.seenBy(slack.dm("U0LI", "周末的排班换一下？", { channel: "D0ZHANGLI" }), ["U0ZHANG"]);
    expect(await hub.receive("slack", theirs)).toEqual({ accepted: true, items: [] });
    await hub.idle();
    expect(slackEvents()).toEqual([]);
    expect(lookups()).toHaveLength(1);
    expect(logs.join("\n")).toContain("not visible to the user");
    expect(logs.join("\n")).not.toContain("周末的排班");
  });

  it("keeps a message the user can see when Slack names a colleague in the event", async () => {
    const { hub } = setup();
    const shared = slack.seenBy(slack.mention("U0LI", "发布窗口定了吗？"), ["U0ZHANG", slack.self.id]);
    const [item] = (await hub.receive("slack", shared)).items;
    expect(item).toMatchObject({ kind: "slack.mention.received", role: "message", delivery: "card" });
  });

  it("reads every page of the list before it decides", async () => {
    const { hub } = setup();
    const others = Array.from({ length: 150 }, (_, index) => `U0OTHER${index}`);
    const shared = slack.seenBy(slack.mention("U0LI", "大家都在的频道"), [...others, slack.self.id]);
    expect((await hub.receive("slack", shared)).items[0]).toMatchObject({ kind: "slack.mention.received" });
    expect(lookups().length).toBeGreaterThan(1);
  });

  it("does not ask Slack when the event already names the user", async () => {
    const { hub } = setup();
    expect((await hub.receive("slack", slack.dm("U0ZHANG", "材料收到了吗？"))).items[0]).toMatchObject({ kind: "slack.dm.received" });
    expect(lookups()).toEqual([]);
  });

  it("drops the event and names the missing scope when the full list cannot be read", async () => {
    slack.appScopes = ["connections:write"];
    const { hub } = setup();
    const shared = slack.seenBy(slack.mention("U0LI", "发布窗口定了吗？"), ["U0ZHANG", slack.self.id]);
    expect(await hub.receive("slack", shared)).toEqual({ accepted: true, items: [] });
    await hub.idle();
    expect(slackEvents()).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain("authorizations:read");
    expect(text).not.toContain(FAKE_SLACK_APP_TOKEN);
    expect(text).not.toContain(FAKE_SLACK_TOKEN);
  });

  it("acks a colleague's event on the socket and records nothing", async () => {
    const { hub, adapter } = setup({ socket: true });
    adapter.transport!.start(hub.transportContext("slack"), (delivery) => hub.receiveFromTransport("slack", delivery));
    try {
      await vi.waitFor(() => expect(slack.socket()).toBeDefined());
      slack.push(slack.seenBy(slack.dm("U0LI", "周末的排班换一下？", { channel: "D0ZHANGLI" }), ["U0ZHANG"]));
      slack.push(slack.dm("U0ZHANG", "材料收到了吗？"));
      await vi.waitFor(() => expect(slackEvents().map((event) => event.kind)).toEqual(["slack.dm.received"]));
      expect(slack.acks).toHaveLength(2);
      expect(slackEvents()[0]!.payload.text).toBe("材料收到了吗？");
    } finally {
      await adapter.transport!.stop();
    }
  });
});
