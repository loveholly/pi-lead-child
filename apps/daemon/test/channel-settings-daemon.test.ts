// 设置页「消息通道」走完用户经过的每一跳（slack-settings 工单 S1）：本机网页调 /v1/channels/settings，网关校验，
// daemon 检查令牌、加密存进保险库、热重连 Slack 的 Socket 连接，状态回到设置页。daemon、store、网关、通道 hub、
// Slack 插件、真实的 WebClient 都是真的；Slack 是假的（FakeSlack 的 fetch 和假的 SocketModeClient），Lead 的会话是替身。
//   1. PUT 有效的令牌：不重启就连上，状态 connected，账号正确；bot token 被拒并说明原因；缺权限时列出来，不保存。
//      DELETE：断开，状态 not_configured。
//   2. 「不是我」：删掉保险库里这个来源的令牌并断开。
//   3. 保险库优先于 Keychain；只换一个令牌时另一个用 Keychain 的补上，补来的不写进保险库；删掉以后退回 Keychain。
// 令牌不出现在任何响应、日志、事件里，库里只有密文。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  FAKE_SLACK_APP_TOKEN, FAKE_SLACK_BOT_TOKEN, FAKE_SLACK_TOKEN, FAKE_SLACK_USER_SCOPES, FakeSlack,
} from "@pi-lead-child/engine/testing";
import { ChannelSettingsResponseSchema, ChannelSourceSettingsResponseSchema, HttpErrorResponseSchema } from "@pi-lead-child/protocol";
import { createCliBinding, createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

const LOCAL_PAGE = "http://localhost:8081";
const APP = "PLC_SLACK_APP_TOKEN";
const USER = "PLC_SLACK_USER_TOKEN";
const STALE_USER_TOKEN = "xoxp-keychain-stale-sentinel-6a1f";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let logs: string[];

beforeEach(() => {
  dir = tempDir("plc-channel-settings-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  logs = [];
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_ALLOW_LOOPBACK_AUTO_PAIR", "1");
  vi.stubEnv("PLC_LOOPBACK_AUTO_PAIR_ORIGINS", LOCAL_PAGE);
  vi.stubEnv("PLC_SLACK_APP_TOKEN", "");
  vi.stubEnv("PLC_SLACK_USER_TOKEN", "");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function boot(slack: FakeSlack, keychain?: Record<string, string>) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, gatewayPort: 0, log: (line) => logs.push(line), triageShadow: false,
    sessionFactory: fakePiLead(async () => ({ say: "好的。" })).factory as never,
    channels: {
      live: { fetch: slack.fetch, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 50 } },
      ...(keychain ? { keychain: (name: string) => keychain[name] ?? null } : {}),
    },
  });
  const owner = createLoopbackBinding(db, { name: "本机网页" });
  const responses: string[] = [];
  const call = async (method: "GET" | "PUT" | "DELETE" | "POST", path: string, body?: unknown, token = owner.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, origin: LOCAL_PAGE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: JSON.parse(text) as any };
  };
  const slackSettings = async () => {
    const listed = await call("GET", "/v1/channels/settings");
    expect(listed.status).toBe(200);
    expect(Value.Check(ChannelSettingsResponseSchema, listed.body)).toBe(true);
    return listed.body.sources.find((source: any) => source.source === "slack");
  };
  return { call, owner, slackSettings, responses };
}

const vaultRows = () => (db.prepare("SELECT key FROM kv WHERE key LIKE 'secret.channel.%' ORDER BY key").all() as Array<{ key: string }>)
  .map((row) => row.key);
const snapshots = () => (db.prepare(
  "SELECT COUNT(*) AS n FROM gateway_events WHERE event_type='snapshot.required' AND json_extract(payload, '$.resource')='channel-settings'",
).get() as { n: number }).n;

function expectNoToken(responses: string[], tokens: string[]): void {
  const everything = [
    ...responses, ...logs, JSON.stringify(db.prepare("SELECT * FROM events").all()), JSON.stringify(db.prepare("SELECT * FROM kv").all()),
    JSON.stringify(db.prepare("SELECT * FROM gateway_events").all()), JSON.stringify(db.prepare("SELECT * FROM notifications").all()),
  ].join("\n");
  for (const token of tokens) expect(everything).not.toContain(token);
}

describe("the channel settings through the daemon", () => {
  it("connects on a PUT without a restart, refuses a bot token and missing scopes, and disconnects on DELETE", async () => {
    const slack = new FakeSlack({ self: { id: "U0SELF", name: "Leo" } });
    const { call, slackSettings, responses } = await boot(slack);
    expect(await slackSettings()).toMatchObject({
      label: "Slack", status: "not_configured", account: null, editable: true, setupUrl: "https://api.slack.com/apps",
      manifest: expect.stringContaining("socket_mode_enabled: true"),
      secrets: [{ name: APP, prefix: "xapp-", present: false, origin: null }, { name: USER, prefix: "xoxp-", present: false, origin: null }],
    });
    expect(slack.socketClients).toEqual([]);
    expect(slack.requests).toEqual([]);

    // bot token：400，说明要的是本人的 user token；什么都不存，也不连。
    const bot = await call("PUT", "/v1/channels/settings/slack", { secrets: { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_BOT_TOKEN } });
    expect(bot.status).toBe(400);
    expect(Value.Check(HttpErrorResponseSchema, bot.body)).toBe(true);
    expect(bot.body.error.details.checks.find((check: any) => check.id === "user_token_kind"))
      .toMatchObject({ pass: false, detail: expect.stringContaining("这是 bot token，要的是你本人的 user token") });
    // 缺权限：列出缺的，不保存。
    slack.scopes = FAKE_SLACK_USER_SCOPES.filter((scope) => scope !== "chat:write");
    const scoped = await call("PUT", "/v1/channels/settings/slack", { secrets: { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN } });
    expect(scoped.status).toBe(400);
    expect(scoped.body.error.details).toMatchObject({ ok: false, missingScopes: ["chat:write"] });
    // 「测试」没过：200，ok=false。
    const tested = await call("POST", "/v1/channels/settings/slack/test", { secrets: { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN } });
    expect(tested).toMatchObject({ status: 200, body: { ok: false, missingScopes: ["chat:write"] } });
    expect(vaultRows()).toEqual([]);
    expect(slack.socketClients).toEqual([]);
    expect(listEvents(db, { kind: "owner_action.performed" })).toEqual([]);

    // 补了权限：PUT 过了，不重启就连上。
    slack.scopes = [...FAKE_SLACK_USER_SCOPES];
    const saved = await call("PUT", "/v1/channels/settings/slack", { secrets: { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN } });
    expect(saved.status).toBe(200);
    expect(Value.Check(ChannelSourceSettingsResponseSchema, saved.body)).toBe(true);
    expect(vaultRows()).toEqual([`secret.channel.${APP}`, `secret.channel.${USER}`]);
    await vi.waitFor(() => expect(slack.socket()).toBeDefined());
    await vi.waitFor(async () => expect((await slackSettings()).status).toBe("connected"));
    expect(await slackSettings()).toMatchObject({
      status: "connected", lastError: null, lastConnectedAt: expect.any(String), missingScopes: [],
      account: { userId: "U0SELF", userName: "Leo", teamId: "T0HOME", teamName: "Home" },
      secrets: [{ present: true, origin: "vault" }, { present: true, origin: "vault" }],
    });
    expect(listEvents(db, { kind: "owner_action.performed" }).map((event) => event.payload.detail)).toEqual([
      { op: "save", source: "slack", names: [APP, USER] },
    ]);
    // 连上的 Socket 照常收消息。
    slack.push(slack.dm("U0ZHANG", "周五评审的材料收到了吗？"));
    await vi.waitFor(() => expect(daemon!.channels!.listCards()).toHaveLength(1));

    // DELETE：断开，没有配置。
    const removed = await call("DELETE", "/v1/channels/settings/slack");
    expect(removed.status).toBe(200);
    expect(removed.body.source).toMatchObject({ status: "not_configured", account: null, secrets: [{ present: false }, { present: false }] });
    expect(vaultRows()).toEqual([]);
    await vi.waitFor(() => expect(slack.socket()).toBeUndefined());
    expect((await slackSettings()).status).toBe("not_configured");
    expect(slack.socketClients).toHaveLength(1);
    expect(snapshots()).toBeGreaterThanOrEqual(3);

    await daemon!.close();
    daemon = null;
    expectNoToken(responses, [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, FAKE_SLACK_BOT_TOKEN]);
  }, 30_000);

  it("deletes the saved tokens and disconnects when the owner says 「不是我」", async () => {
    const slack = new FakeSlack();
    const { call, responses } = await boot(slack);
    // 一个 child 用 CLI 凭证、伪造本机网页的 Origin，把令牌存进来。
    const child = createCliBinding(db, { name: "plc" });
    const saved = await call("PUT", "/v1/channels/settings/slack", { secrets: { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: FAKE_SLACK_TOKEN } },
      child.accessToken);
    expect(saved.status).toBe(200);
    await vi.waitFor(() => expect(slack.socket()).toBeDefined());
    const performed = listEvents(db, { kind: "owner_action.performed" });
    expect(performed).toHaveLength(1);
    expect(performed[0]).toMatchObject({ level: "interrupt", payload: { action: "channel.credentials", delivery: "push" } });

    const disowned = await call("POST", `/v1/owner-actions/${performed[0]!.eventId}/disown`, {});
    expect(disowned.status).toBe(200);
    expect(disowned.body.ownerAction.disowned).toMatchObject({
      revert: { status: "reverted", message: expect.stringContaining("已经断开") }, credential: { bindingId: child.binding.id, revoked: true },
    });
    expect(vaultRows()).toEqual([]);
    await vi.waitFor(() => expect(slack.socket()).toBeUndefined());
    expect((await call("GET", "/v1/channels/settings")).body.sources[0]).toMatchObject({ status: "not_configured" });
    await daemon!.close();
    daemon = null;
    expectNoToken(responses, [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN]);
  }, 30_000);

  it("prefers the vault over the Keychain, saves only what the page sent, and falls back to the Keychain after a DELETE", async () => {
    const slack = new FakeSlack();
    // Keychain 里有 app-level token 和一个过期的用户令牌：启动时连不上，状态是错误。
    const { call, slackSettings, responses } = await boot(slack, { [APP]: FAKE_SLACK_APP_TOKEN, [USER]: STALE_USER_TOKEN });
    await vi.waitFor(async () => expect((await slackSettings()).status).toBe("error"));
    expect(await slackSettings()).toMatchObject({
      lastError: expect.stringContaining("凭据不可用"),
      secrets: [{ present: true, origin: "keychain" }, { present: true, origin: "keychain" }],
    });
    expect(slack.socketClients).toEqual([]);

    // 只换用户令牌：app-level token 用 Keychain 里的补上一起检查；只有用户令牌写进保险库。
    const saved = await call("PUT", "/v1/channels/settings/slack", { secrets: { [USER]: FAKE_SLACK_TOKEN } });
    expect(saved.status).toBe(200);
    expect(vaultRows()).toEqual([`secret.channel.${USER}`]);
    await vi.waitFor(async () => expect((await slackSettings()).status).toBe("connected"));
    expect((await slackSettings()).secrets).toMatchObject([
      { name: APP, present: true, origin: "keychain" }, { name: USER, present: true, origin: "vault" },
    ]);
    expect(slack.socket()!.appToken).toBe(FAKE_SLACK_APP_TOKEN);
    expect(listEvents(db, { kind: "owner_action.performed" }).map((event) => event.payload.detail)).toEqual([
      { op: "save", source: "slack", names: [USER] },
    ]);

    // 删掉保险库里的：退回 Keychain 里过期的那一个，又连不上了。
    const removed = await call("DELETE", "/v1/channels/settings/slack");
    expect(removed.status).toBe(200);
    expect(removed.body.source.secrets).toMatchObject([{ origin: "keychain" }, { origin: "keychain" }]);
    expect(vaultRows()).toEqual([]);
    await vi.waitFor(() => expect(slack.socket()).toBeUndefined());
    await vi.waitFor(async () => expect((await slackSettings()).status).toBe("error"));

    // 两个都没给，Keychain 里也没有的：说明缺哪个，不保存。
    await daemon!.close();
    daemon = null;
    const empty = await boot(new FakeSlack(), {});
    const missing = await empty.call("PUT", "/v1/channels/settings/slack", { secrets: { [USER]: FAKE_SLACK_TOKEN } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.checks.find((check: any) => check.id === "app_token_kind"))
      .toMatchObject({ pass: false, detail: expect.stringContaining("缺 App-Level Token") });
    expect(vaultRows()).toEqual([]);
    await daemon!.close();
    daemon = null;
    expectNoToken([...responses, ...empty.responses], [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_TOKEN, STALE_USER_TOKEN]);
  }, 30_000);
});
