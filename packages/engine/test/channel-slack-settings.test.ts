// Slack 插件的凭据设置（设置页「Slack 通道」，slack-settings 工单 S1）：声明的两个令牌、清单，和检查一组令牌。
// 检查走两条路：api 的替身（直接调用），和真实的 WebClient（createSlackWebApi）配假的 Slack 的 fetch：
// 权限要从 x-oauth-scopes 头里读（WebClient 放进 response_metadata.scopes）。Slack 一律是假的。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ChannelSecretsTestResultSchema, ChannelSecretSettingSchema } from "@pi-lead-child/protocol";
import {
  builtinChannelAdapters, ChannelRegistry, createSlackChannelAdapter, createSlackWebApi, SLACK_USER_SCOPES, slackAppManifest,
  validateChannelAdapter, type ChannelAdapter,
} from "../src/index.js";
import { FAKE_SLACK_APP_TOKEN, FAKE_SLACK_BOT_TOKEN, FAKE_SLACK_TOKEN, FakeSlack } from "../testing/index.js";

const APP = "PLC_SLACK_APP_TOKEN";
const USER = "PLC_SLACK_USER_TOKEN";

function settingsOf(adapter: ChannelAdapter) {
  if (!adapter.settings) throw new Error("the Slack adapter declares no settings");
  return adapter.settings;
}

async function run(slack: FakeSlack, secrets: Record<string, string>, via: "api" | "fetch" = "api") {
  const api = via === "api" ? slack.api : createSlackWebApi({ fetch: slack.fetch, retry: { retries: 0 } });
  const lines: string[] = [];
  const result = await settingsOf(createSlackChannelAdapter({ api })).test(secrets, { log: (line) => lines.push(line) });
  expect(Value.Check(ChannelSecretsTestResultSchema, result)).toBe(true);
  const text = JSON.stringify(result) + lines.join("\n");
  for (const token of [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FAKE_SLACK_BOT_TOKEN]) expect(text).not.toContain(token);
  return { result, lines, check: (id: string) => result.checks.find((item) => item.id === id)! };
}

describe("the Slack settings", () => {
  // 2026-10-22：清单里的应用名跟 Lead 的名字（设置 → 身份与风格），以前写死成 Fairy。改了名字以后清单跟着变；
  // config.json 写了 channels.assistantName 时以它为准。
  it("names the app after Lead's current name unless channels.assistantName is set", () => {
    let leadName = "Jarvis";
    const [adapter] = builtinChannelAdapters({ slack: { api: new FakeSlack().api } }, {}, { assistantName: () => leadName });
    const settings = settingsOf(adapter!);
    expect(settings.manifest).toContain('name: "Jarvis"');
    leadName = "Friday";
    expect(settings.manifest).toContain('name: "Friday"');
    const [configured] = builtinChannelAdapters({ slack: { api: new FakeSlack().api } }, { assistantName: "Nova" }, { assistantName: () => leadName });
    expect(settingsOf(configured!).manifest).toContain('name: "Nova"');
  });

  it("declares the two tokens of auth.secrets, the manifest from the setup guide and the setup page", () => {
    const adapter = createSlackChannelAdapter({ api: new FakeSlack().api, ownerName: "Leo" });
    const settings = settingsOf(adapter);
    expect(settings.secrets.map((secret) => secret.name)).toEqual(adapter.auth.secrets);
    expect(settings.secrets.map((secret) => secret.prefix)).toEqual(["xapp-", "xoxp-"]);
    for (const secret of settings.secrets) {
      expect(Value.Check(ChannelSecretSettingSchema, { ...secret, present: false, origin: null })).toBe(true);
    }
    expect(settings.setupUrl).toBe("https://api.slack.com/apps");
    // 应用名是助手名（Slack 在代发的消息下面写「Sent using @Paimon」），说明里写主人名。
    expect(settings.manifest).toContain('name: "Paimon"');
    expect(settings.manifest).toContain('description: "替 Leo 查资料'); 
    expect(settings.manifest).toContain("socket_mode_enabled: true");
    for (const scope of SLACK_USER_SCOPES) expect(settings.manifest).toContain(`      - ${scope}\n`);
    for (const event of ["message.channels", "message.groups", "message.im", "message.mpim"]) {
      expect(settings.manifest).toContain(`      - ${event}\n`);
    }
    // 用户写的名字弄不坏清单：控制字符去掉，引号转义。
    expect(slackAppManifest("Leo", 'a"b\nc')).toContain('name: "a\\"bc"');
    expect(slackAppManifest('a"b\nc')).toContain('description: "替 a\\"bc 查资料');
    expect(slackAppManifest(null)).toContain('name: "Paimon"');
    expect(slackAppManifest(null, "Nova")).toContain('name: "Nova"');
    expect(validateChannelAdapter(adapter)).toEqual([]);
  });

  it("refuses an adapter whose settings name a secret it does not declare", () => {
    const adapter = createSlackChannelAdapter({ api: new FakeSlack().api });
    const broken = { ...adapter, settings: { ...settingsOf(adapter), secrets: settingsOf(adapter).secrets.slice(0, 1) } };
    expect(validateChannelAdapter(broken)).toEqual([expect.stringContaining("settings.secrets")]);
    expect(() => new ChannelRegistry([broken])).toThrow(/settings\.secrets/);
  });

  it("passes the two right tokens, through the real WebClient, and names the user and the workspace", async () => {
    const slack = new FakeSlack({ self: { id: "U0SELF", name: "Leo" } });
    const { result } = await run(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: ` ${FAKE_SLACK_TOKEN}\n` }, "fetch");
    expect(result).toMatchObject({
      ok: true, missingScopes: [], account: { userId: "U0SELF", userName: "Leo", teamId: "T0HOME", teamName: "Home" },
    });
    expect(result.checks.map((item) => [item.id, item.pass])).toEqual([
      ["app_token_kind", true], ["user_token_kind", true], ["user_token_auth", true], ["scopes", true], ["socket_mode", true],
    ]);
    // 只问能不能开 Socket 连接，不建连接。
    expect(slack.socketClients).toEqual([]);
    expect(slack.requests.map((request) => request.method).sort()).toEqual(["apps.connections.open", "auth.test", "users.info"]);
  });

  it("refuses a bot token and says the user's own token is wanted", async () => {
    const slack = new FakeSlack();
    const { result, check } = await run(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_BOT_TOKEN });
    expect(result.ok).toBe(false);
    expect(check("user_token_kind")).toMatchObject({ pass: false, detail: expect.stringContaining("这是 bot token，要的是你本人的 user token") });
    // 格式不对就不拿它去问 Slack。
    expect(slack.calls.filter((call) => call.method === "auth.test")).toEqual([]);
    expect(check("user_token_auth").pass).toBe(false);
    expect(check("socket_mode").pass).toBe(true);
  });

  it("refuses a token that looks like a user token but auth.test says belongs to a bot", async () => {
    const disguised = "xoxp-fake-but-really-a-bot-0b7d22";
    const slack = new FakeSlack({ botToken: disguised });
    const { result, check } = await run(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: disguised });
    expect(result).toMatchObject({ ok: false, account: null });
    expect(check("user_token_kind").pass).toBe(true);
    expect(check("user_token_auth")).toMatchObject({ pass: false, detail: expect.stringContaining("bot token") });
    expect(JSON.stringify(result)).not.toContain(disguised);
  });

  it("lists the missing scopes read from the x-oauth-scopes header", async () => {
    const slack = new FakeSlack({ scopes: SLACK_USER_SCOPES.filter((scope) => scope !== "chat:write" && scope !== "im:history") });
    const { result, check } = await run(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN }, "fetch");
    expect(result).toMatchObject({ ok: false, missingScopes: ["im:history", "chat:write"] });
    expect(check("scopes")).toMatchObject({ pass: false, detail: expect.stringContaining("缺 im:history、chat:write") });
    // 说明里列出 Slack 报告的现有权限，并提醒要加在 User Token Scopes 里（用户照着改了还是不对时，能自己对照）。
    expect(check("scopes").detail).toContain("Slack 说这个令牌现在只有：");
    expect(check("scopes").detail).toContain("User Token Scopes 里（不是 Bot Token Scopes）");
    // 账号照样认出来了。
    expect(result.account).toMatchObject({ userId: "U0SELF" });
  });

  it("checks the token kinds, a revoked token, a swapped pair and a network failure without echoing a token", async () => {
    const slack = new FakeSlack();
    const missing = await run(slack, {});
    expect(missing.result.ok).toBe(false);
    expect(missing.check("app_token_kind").detail).toContain("缺 App-Level Token");
    expect(missing.check("user_token_kind").detail).toContain("缺 User OAuth Token");

    const swapped = await run(slack, { [APP]: FAKE_SLACK_TOKEN, [USER]: FAKE_SLACK_APP_TOKEN });
    expect(swapped.check("app_token_kind").detail).toContain("这是 user token");
    expect(swapped.check("user_token_kind").detail).toContain("这是 App-Level Token");

    const revoked = await run(slack, { [APP]: "xapp-1-revoked-0000", [USER]: "xoxp-revoked-0000" });
    expect(revoked.check("user_token_auth").detail).toContain("Slack 不认这个 User Token（invalid_auth）");
    expect(revoked.check("socket_mode").detail).toContain("Slack 不认这个 App-Level Token（invalid_auth）");

    slack.failNext("auth.test", `socket hang up for ${FAKE_SLACK_TOKEN}`);
    const offline = await run(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN });
    expect(offline.check("user_token_auth")).toMatchObject({ pass: false, detail: expect.stringContaining("连不上 Slack") });
    expect(offline.lines.join("\n")).toContain("auth.test failed");
  });
});
