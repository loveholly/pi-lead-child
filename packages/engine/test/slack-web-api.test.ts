// slack-takeover 工单 02（spec D11）：真实的 SlackWebApi 用 Slack 官方的 WebClient。这里用假的 Slack 的 fetch，测我们的那一层：
//   - 令牌放在 Authorization 头里，参数按表单编码，复杂的值（metadata、blocks）编码成 JSON；
//   - ok:false 不抛错，转回 Slack 的回答（适配器按 error 分情况处理，例如 message_not_found）；
//   - 限流（429）按 Retry-After 等了再试（WebClient 的重试配置）；
//   - 网络错误抛错，报错里没有令牌。
import { describe, expect, it } from "vitest";
import { createSlackWebApi, slackDisclosureBlocks } from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "../testing/index.js";

describe("the real Slack Web API client", () => {
  it("sends the token in the header and form-encoded arguments, and returns Slack's answer", async () => {
    const slack = new FakeSlack();
    const api = createSlackWebApi({ fetch: slack.fetch, retry: { retries: 0 } });
    const posted = await api.call("chat.postMessage", {
      channel: "D0ZHANG", text: "收到", metadata: { event_type: "plc_reply", event_payload: { idempotency_key: "k-1" } },
    }, FAKE_SLACK_TOKEN);
    expect(posted).toMatchObject({ ok: true, channel: "D0ZHANG" });
    expect(slack.requests.at(-1)).toEqual({ method: "chat.postMessage", contentType: "application/x-www-form-urlencoded", bearer: true });
    // metadata 编码成 JSON 送过去，Slack 存下的是对象：适配器靠它认出自己发过的消息。
    expect(slack.sent("D0ZHANG")[0]!.metadata).toEqual({ event_type: "plc_reply", event_payload: { idempotency_key: "k-1" } });
    expect(await api.call("auth.test", {}, FAKE_SLACK_TOKEN)).toMatchObject({ ok: true, user_id: "U0SELF", team_id: "T0HOME" });
    // app-level token 只能开 Socket 连接。
    expect(await api.call("apps.connections.open", {}, FAKE_SLACK_APP_TOKEN)).toMatchObject({ ok: true });
  });

  it("sends a disclosed message as Block Kit that Slack accepts, and Slack refuses a block over its limits", async () => {
    const slack = new FakeSlack();
    const api = createSlackWebApi({ fetch: slack.fetch, retry: { retries: 0 } });
    const blocks = slackDisclosureBlocks({ byline: "Fairy (Assistant) · confirmed by Leo", body: "查到了：见 src/retry.ts。" });
    const posted = await api.call("chat.postMessage", {
      channel: "D0ZHANG", text: "Fairy (Assistant) · confirmed by Leo\n查到了：见 src/retry.ts。", blocks,
      metadata: { event_type: "plc_reply", event_payload: { idempotency_key: "k-2" } },
    }, FAKE_SLACK_TOKEN);
    expect(posted).toMatchObject({ ok: true });
    // blocks 编码成 JSON 送过去，Slack 存下的就是这几个 block。
    expect(slack.sent("D0ZHANG")[0]!.blocks).toEqual(blocks);
    // 和真的 Slack 一样：一个文字对象超过 3000 个字就整条拒绝（invalid_blocks），什么也不发。
    const refused = await api.call("chat.postMessage", {
      channel: "D0ZHANG", text: "x", blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3_001) } }],
    }, FAKE_SLACK_TOKEN);
    expect(refused).toMatchObject({ ok: false, error: "invalid_blocks" });
    expect(slack.sent("D0ZHANG")).toHaveLength(1);
  });

  it("returns ok:false answers instead of throwing", async () => {
    const slack = new FakeSlack();
    const api = createSlackWebApi({ fetch: slack.fetch, retry: { retries: 0 } });
    expect(await api.call("chat.delete", { channel: "D0ZHANG", ts: "1.000001" }, FAKE_SLACK_TOKEN))
      .toMatchObject({ ok: false, error: "message_not_found" });
    expect(await api.call("users.info", { user: "U0ZHANG" }, FAKE_SLACK_APP_TOKEN)).toMatchObject({ ok: false, error: "not_allowed_token_type" });
  });

  it("waits out a rate limit and tries again", async () => {
    const slack = new FakeSlack();
    const api = createSlackWebApi({ fetch: slack.fetch, retry: { retries: 2, minTimeout: 1, maxTimeout: 5 } });
    slack.rateLimitNext("conversations.history", 0);
    const result = await api.call("conversations.history", { channel: "D0ZHANG" }, FAKE_SLACK_TOKEN);
    expect(result).toMatchObject({ ok: true, messages: [] });
    expect(slack.requests.filter((request) => request.method === "conversations.history")).toHaveLength(2);
  });

  it("throws on network errors without the token in the message", async () => {
    const slack = new FakeSlack();
    const logs: string[] = [];
    const api = createSlackWebApi({ fetch: slack.fetch, retry: { retries: 0 }, log: (line) => logs.push(line) });
    slack.failNext("users.info", `socket hang up while sending ${FAKE_SLACK_TOKEN}`);
    const error = await api.call("users.info", { user: "U0ZHANG" }, FAKE_SLACK_TOKEN).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^slack users\.info: /);
    expect((error as Error).message).not.toContain(FAKE_SLACK_TOKEN);
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_TOKEN);
  });
});
