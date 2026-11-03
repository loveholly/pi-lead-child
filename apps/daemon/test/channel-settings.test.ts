// 通道设置（apps/daemon/src/channel-settings.ts，slack-settings 工单 S1）的决策边界。来源是一个假的适配器，
// 保险库是真的（随机密钥）。完整的一跳（网关、Slack、热重连）在 channel-settings-daemon.test.ts。
//   - 取密钥：保险库 → daemon 专用的环境变量 → Keychain；保险库里解不开的当作没有，只记一次日志，不写值；
//   - 状态：出错的原因去掉现在的密钥；重连时留着上一次的错误；连上时清掉；同一个人时留着检查认出的账号；
//   - 检查：请求里没给的用现在的补上；来源插件回的文字里带了密钥也去掉；有一项没过 ok 就是 false；等太久算没过；
//   - 保存：只写请求里给的（去掉首尾空白）；检查没过不写；删除只删保险库里的；
//   - 收不到事件：存了令牌以后第一次连上起满 30 分钟、这次连接至少 2 分钟、还没收到事件才提醒（假时钟）；断线、出错不从头算；
//     收到过一次以后不再提醒（重启以后也不）；不是设置页存的令牌不提醒；重新保存、换回不用登录的方式从头等；停机清掉定时器；
//   - 建应用的链接超过契约的长度时不给。
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { Vault } from "@pi-lead-child/connections";
import type { ChannelAdapter, ChannelSettingsSpec } from "@pi-lead-child/engine";
import { CHANNEL_SETUP_URL_MAX, type ChannelSecretsTestResult } from "@pi-lead-child/protocol";
import { openDb, type Db } from "@pi-lead-child/store";
import { updateDesignPreferences } from "@pi-lead-child/engine";
import { ChannelSettings } from "../src/channel-settings.js";

const ONE = "PLC_FAKE_ONE";
const TWO = "PLC_FAKE_TWO";
const SAVED = "fake-one-saved-sentinel-1a2b";

let db: Db;
let logs: string[];
let env: Record<string, string>;
let keychain: Record<string, string>;
let publishes: number;
let reloads: string[];
let tested: Array<Record<string, string>>;
let answer: (secrets: Readonly<Record<string, string>>) => Promise<ChannelSecretsTestResult>;
let setupUrl: string | null;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-settings-"), "plc.db"));
  logs = [];
  env = {};
  keychain = {};
  publishes = 0;
  reloads = [];
  tested = [];
  setupUrl = null;
  answer = async () => ({ ok: true, checks: [{ id: "one", label: "一", pass: true, detail: "好" }], account: null, missingScopes: [] });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function adapter(connection?: ChannelAdapter["connection"]): ChannelAdapter {
  const settings: ChannelSettingsSpec = {
    secrets: [
      { name: ONE, label: "第一个", prefix: "fake-", hint: (locale) => (locale === "zh" ? "在这里生成" : "Generate it here") },
      { name: TWO, label: "第二个", prefix: "fake-", hint: () => "" },
    ],
    manifest: null,
    get setupUrl() { return setupUrl; },
    setupNote: (locale) => (locale === "zh" ? "权限加在用户令牌上" : "Add the scopes to the user token"),
    noEventsWarning: (locale) => (locale === "zh" ? "去查事件订阅" : "Check the event subscriptions"),
    test: async (secrets) => {
      tested.push({ ...secrets });
      return answer(secrets);
    },
  };
  return { id: "fake", label: "Fake", auth: { connectionProvider: "fake", secrets: [ONE, TWO] }, settings, connection } as unknown as ChannelAdapter;
}

function setup(options: { vault?: Vault; testTimeoutMs?: number; connection?: ChannelAdapter["connection"] } = {}) {
  const settings = new ChannelSettings({
    db, vault: options.vault ?? new Vault(randomBytes(32)), log: (line) => logs.push(line),
    env: (name) => env[name] ?? null, keychain: (name) => keychain[name] ?? null,
    publish: () => { publishes += 1; },
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const fake = adapter(options.connection);
  settings.attach({ adapters: () => [fake], reload: async (source) => { reloads.push(source); } });
  return settings;
}

describe("where a channel secret comes from", () => {
  it("takes the vault, then the daemon's environment, then the Keychain", async () => {
    const settings = setup();
    keychain[ONE] = "fake-one-keychain-value";
    expect(settings.resolve(ONE)).toEqual({ value: "fake-one-keychain-value", origin: "keychain" });
    env[ONE] = "fake-one-env-value";
    expect(settings.resolve(ONE)).toEqual({ value: "fake-one-env-value", origin: "env" });
    expect((await settings.save("fake", { [ONE]: `  ${SAVED}\n` })).ok).toBe(true);
    expect(settings.resolve(ONE)).toEqual({ value: SAVED, origin: "vault" });
    expect(settings.resolve(TWO)).toBeNull();
    expect(settings.list()[0]!.secrets.map((secret) => [secret.name, secret.present, secret.origin])).toEqual([
      [ONE, true, "vault"], [TWO, false, null],
    ]);
  });

  it("ignores a vault row it cannot open, and says so once without the value", async () => {
    const first = setup();
    expect((await first.save("fake", { [ONE]: SAVED })).ok).toBe(true);
    keychain[ONE] = "fake-one-keychain-value";
    // 保险库的密钥换了：旧的密文解不开。
    const second = setup({ vault: new Vault(randomBytes(32)) });
    expect(second.resolve(ONE)).toEqual({ value: "fake-one-keychain-value", origin: "keychain" });
    expect(second.resolve(ONE)?.origin).toBe("keychain");
    expect(logs.filter((line) => line.includes("cannot be opened"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(SAVED);
  });
});

describe("the status of a source", () => {
  it("scrubs the current secrets from an error, keeps it while reconnecting, and clears it once connected", () => {
    const settings = setup();
    env[ONE] = "fake-one-env-value";
    settings.sourceStatus("fake", { state: "connecting" });
    settings.sourceStatus("fake", { state: "error", error: "rejected fake-one-env-value (xoxp-1234567890-abcdefghij)" });
    const failed = settings.list()[0]!;
    expect(failed).toMatchObject({ status: "error", account: null });
    expect(failed.lastError).not.toContain("fake-one-env-value");
    expect(failed.lastError).not.toContain("xoxp-1234567890-abcdefghij");
    settings.sourceStatus("fake", { state: "connecting" });
    expect(settings.list()[0]).toMatchObject({ status: "connecting", lastError: failed.lastError });
    const account = { userId: "U1", userName: "我", teamId: "T1", teamName: "Home" };
    settings.sourceStatus("fake", { state: "connected", account });
    expect(settings.list()[0]).toMatchObject({ status: "connected", lastError: null, account, lastConnectedAt: expect.any(String) });
    settings.sourceStatus("fake", { state: "not_configured" });
    expect(settings.list()[0]).toMatchObject({ status: "not_configured", account: null });
    const before = publishes;
    settings.sourceStatus("fake", { state: "not_configured" });
    expect(publishes).toBe(before);
  });

  // 一个来源的长链接不能让整个列表过不了客户端的 schema 校验：超过契约的长度时不给。
  // 令牌的说明和建应用的要点按界面语言（2026-11-02）：来源插件给两种语言，daemon 按用户现在选的取。
  it("writes the secret hints and the setup note in the language the user chose", () => {
    const settings = setup();
    expect(settings.list()[0]).toMatchObject({ setupNote: "Add the scopes to the user token", secrets: [{ hint: "Generate it here" }, { hint: "" }] });
    updateDesignPreferences(db, { request: { locale: "zh" }, caller: { kind: "user" } });
    expect(settings.list()[0]).toMatchObject({ setupNote: "权限加在用户令牌上", secrets: [{ hint: "在这里生成" }, { hint: "" }] });
  });

  it("gives no setup link that is longer than the contract allows", () => {
    const settings = setup();
    setupUrl = `https://chat.example/apps?manifest=${"x".repeat(CHANNEL_SETUP_URL_MAX)}`;
    expect(settings.list()[0]!.setupUrl).toBeNull();
    setupUrl = "https://chat.example/apps?manifest=short";
    expect(settings.list()[0]!.setupUrl).toBe("https://chat.example/apps?manifest=short");
  });

  it("keeps the account the check found while the same user connects", async () => {
    const settings = setup();
    const found = { userId: "U1", userName: "显示名", teamId: "T1", teamName: "Home" };
    answer = async () => ({ ok: true, checks: [{ id: "one", label: "一", pass: true, detail: "" }], account: found, missingScopes: [] });
    await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" });
    settings.sourceStatus("fake", { state: "connected", account: { userId: "U1", userName: "U1", teamId: "", teamName: "" } });
    expect(settings.list()[0]!.account).toEqual(found);
    settings.sourceStatus("fake", { state: "connected", account: { userId: "U2", userName: "别人", teamId: "T1", teamName: "Home" } });
    expect(settings.list()[0]!.account).toMatchObject({ userId: "U2" });
  });
});

describe("checking and saving", () => {
  it("fills in what the request left out, scrubs what the plugin echoes, and fails the result when a check fails", async () => {
    const settings = setup();
    keychain[TWO] = "fake-two-keychain-value";
    answer = async (secrets) => ({
      ok: true, account: null, missingScopes: [],
      checks: [{ id: "one", label: "一", pass: false, detail: `bad ${secrets[ONE]} and ${secrets[TWO]}` }],
    });
    const result = await settings.test("fake", { [ONE]: SAVED });
    expect(tested).toEqual([{ [ONE]: SAVED, [TWO]: "fake-two-keychain-value" }]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SAVED);
    expect(JSON.stringify(result)).not.toContain("fake-two-keychain-value");
    await expect(settings.test("fake", { PLC_NOT_DECLARED: "x" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(settings.test("other", {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("gives up on a check that takes too long", async () => {
    const settings = setup({ testTimeoutMs: 20 });
    answer = () => new Promise(() => {});
    const result = await settings.test("fake", { [ONE]: SAVED });
    expect(result).toMatchObject({
      ok: false, checks: [{ label: "Check", pass: false, detail: "Fake did not answer in 0 seconds. The check is not complete." }],
    });
    await expect(settings.test("other", {})).rejects.toMatchObject({ code: "not_found", message: "There is no such channel." });
  });

  it("writes the check result and the errors in the language the user chose", async () => {
    updateDesignPreferences(db, { request: { locale: "zh" }, caller: { kind: "user" } });
    const settings = setup({ testTimeoutMs: 20 });
    answer = () => new Promise(() => {});
    const result = await settings.test("fake", { [ONE]: SAVED });
    expect(result).toMatchObject({ ok: false, checks: [{ label: "检查", pass: false, detail: "Fake 没有在 0 秒内回答，没有检查完。" }] });
    await expect(settings.test("other", {})).rejects.toMatchObject({ code: "not_found", message: "没有这个通道" });
    await expect(settings.test("fake", { PLC_NOT_DECLARED: "x" }))
      .rejects.toMatchObject({ code: "invalid_request", message: "请求里有这个通道没有声明的密钥名" });
  });

  it("saves only what the request gave when the checks pass, never when they fail, and removes only the vault's", async () => {
    const settings = setup();
    env[TWO] = "fake-two-env-value";
    answer = async () => ({ ok: false, checks: [{ id: "one", label: "一", pass: false, detail: "不对" }], account: null, missingScopes: ["x"] });
    const refused = await settings.save("fake", { [ONE]: SAVED });
    expect(refused).toMatchObject({ ok: false, result: { missingScopes: ["x"] } });
    expect(settings.resolve(ONE)).toBeNull();
    expect(reloads).toEqual([]);

    answer = async () => ({ ok: true, checks: [{ id: "one", label: "一", pass: true, detail: "" }], account: null, missingScopes: [] });
    const saved = await settings.save("fake", { [ONE]: SAVED });
    if (!saved.ok) throw new Error("expected the save to pass");
    expect(saved.saved.names).toEqual([ONE]);
    expect(saved.saved.source.secrets.map((secret) => secret.origin)).toEqual(["vault", "env"]);
    expect(reloads).toEqual(["fake"]);
    const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'secret.channel.%'").all() as Array<{ key: string; value: string }>;
    expect(rows.map((row) => row.key)).toEqual([`secret.channel.${ONE}`]);
    expect(JSON.stringify(rows)).not.toContain(SAVED);

    // 「不是我」：版本对得上才删。
    expect((await settings.revertSave("fake", "not-this-one")).status).toBe("changed");
    expect(settings.resolve(ONE)?.origin).toBe("vault");
    const removed = await settings.remove("fake");
    expect(removed.removed).toEqual([ONE]);
    expect(removed.source.secrets.map((secret) => secret.origin)).toEqual([null, "env"]);
    expect(reloads).toEqual(["fake", "fake"]);
    expect(logs.join("\n")).not.toContain(SAVED);
  });
});

// 2026-11-02：手建的应用没有订阅用户事件，Socket 连上了 1.5 小时一个事件都没收到，哪里都没说。
describe("a source that connects but receives no events", () => {
  const MINUTE = 60_000;
  const connect = (settings: ChannelSettings) => settings.sourceStatus("fake", { state: "connected", account: null });

  it("warns 30 minutes after the first connection since the tokens were saved, until the first event comes in", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const settings = setup();
    expect((await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" })).ok).toBe(true);
    connect(settings);
    expect(settings.list()[0]).toMatchObject({ status: "connected", noEventsWarning: null });
    // 一次重连不从头算。
    settings.sourceStatus("fake", { state: "connecting" });
    vi.advanceTimersByTime(10 * MINUTE);
    connect(settings);
    vi.advanceTimersByTime(19 * MINUTE);
    expect(settings.list()[0]!.noEventsWarning).toBeNull();
    // 到点时通知客户端重新读，不用等别的状态变。
    const before = publishes;
    vi.advanceTimersByTime(1 * MINUTE);
    expect(publishes).toBe(before + 1);
    expect(settings.list()[0]!.noEventsWarning).toBe("Check the event subscriptions");
    updateDesignPreferences(db, { request: { locale: "zh" }, caller: { kind: "user" } });
    expect(settings.list()[0]!.noEventsWarning).toBe("去查事件订阅");

    settings.sourceStatus("fake", { state: "received" });
    expect(settings.list()[0]!.noEventsWarning).toBeNull();
    expect(db.prepare("SELECT value FROM kv WHERE key = 'channel.fake.events'").get())
      .toEqual({ value: JSON.stringify({ savedAt: "2026-11-02T08:00:00.000Z", firstEventAt: "2026-11-02T08:30:00.000Z" }) });
    // 收到过以后一直没人发消息：不提醒，重启以后也不。
    vi.advanceTimersByTime(5 * 60 * MINUTE);
    connect(settings);
    expect(settings.list()[0]!.noEventsWarning).toBeNull();
    const restarted = setup();
    connect(restarted);
    vi.advanceTimersByTime(2 * 60 * MINUTE);
    expect(restarted.list()[0]!.noEventsWarning).toBeNull();

    // 重新保存了令牌：从头等第一个事件。
    expect((await restarted.save("fake", { [TWO]: "fake-two-new-value" })).ok).toBe(true);
    connect(restarted);
    vi.advanceTimersByTime(30 * MINUTE);
    expect(restarted.list()[0]!.noEventsWarning).toBe("去查事件订阅");
    // 现在没连着不提醒；删掉密钥以后也不再等。
    restarted.sourceStatus("fake", { state: "error", error: "down" });
    expect(restarted.list()[0]!.noEventsWarning).toBeNull();
    await restarted.remove("fake");
    connect(restarted);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(restarted.list()[0]!.noEventsWarning).toBeNull();
  });

  // 浏览器会话方式（要登录的方式）不走 Socket Mode，不报 received：存过应用令牌再换过去，也不该说没订阅事件。
  it("does not warn while the source uses a connection that needs a sign-in", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    let mode = "app";
    const connection = {
      modes: ["app", "session"], mode: () => mode, needsSignIn: (name: string) => name === "session", writesSwitch: () => false,
    } as unknown as ChannelAdapter["connection"];
    const settings = setup({ connection });
    expect((await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" })).ok).toBe(true);
    mode = "session";
    connect(settings);
    vi.advanceTimersByTime(3 * 60 * MINUTE);
    expect(settings.list()[0]).toMatchObject({ status: "connected", noEventsWarning: null });
    mode = "app";
    expect(settings.list()[0]!.noEventsWarning).toBe("Check the event subscriptions");
  });

  // 用浏览器会话连了几个小时再换回应用：那几个小时应用的令牌没在用，从换回以后第一次连上重新算 30 分钟。
  it("starts counting again after the user switches back to a connection without a sign-in", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    let mode = "session";
    const connection = {
      modes: ["app", "session"], mode: () => mode, needsSignIn: (name: string) => name === "session", writesSwitch: () => false,
    } as unknown as ChannelAdapter["connection"];
    const settings = setup({ connection });
    expect((await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" })).ok).toBe(true);
    connect(settings);
    vi.advanceTimersByTime(3 * 60 * MINUTE);
    await settings.useMode("fake", "app");
    mode = "app";
    connect(settings);
    vi.advanceTimersByTime(29 * MINUTE);
    expect(settings.list()[0]!.noEventsWarning).toBeNull();
    vi.advanceTimersByTime(1 * MINUTE);
    expect(settings.list()[0]!.noEventsWarning).toBe("Check the event subscriptions");
  });

  it("does not warn for tokens that the settings page did not save", () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    env[ONE] = "fake-one-env-value";
    env[TWO] = "fake-two-env-value";
    const settings = setup();
    connect(settings);
    vi.advanceTimersByTime(3 * 60 * MINUTE);
    expect(settings.list()[0]).toMatchObject({ status: "connected", noEventsWarning: null });
  });

  // 网络抖：出错、断线都不从头算，否则一直抖的连接永远等不到提醒。断线很久以后刚连上，这次连接连满 2 分钟才提醒。
  it("keeps counting through errors, and waits 2 minutes into a new connection before it warns", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const settings = setup();
    expect((await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" })).ok).toBe(true);
    connect(settings);
    vi.advanceTimersByTime(20 * MINUTE);
    settings.sourceStatus("fake", { state: "error", error: "down" });
    vi.advanceTimersByTime(60 * MINUTE);
    expect(settings.list()[0]).toMatchObject({ status: "error", noEventsWarning: null });
    connect(settings);
    vi.advanceTimersByTime(1 * MINUTE);
    expect(settings.list()[0]!.noEventsWarning).toBeNull();
    const before = publishes;
    vi.advanceTimersByTime(1 * MINUTE);
    expect(publishes).toBe(before + 1);
    expect(settings.list()[0]!.noEventsWarning).toBe("Check the event subscriptions");
  });

  it("clears the warning timer on stop", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const settings = setup();
    expect((await settings.save("fake", { [ONE]: SAVED, [TWO]: "fake-two-value" })).ok).toBe(true);
    connect(settings);
    expect(vi.getTimerCount()).toBe(1);
    settings.stop();
    expect(vi.getTimerCount()).toBe(0);
    const before = publishes;
    connect(settings);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(vi.getTimerCount()).toBe(0);
    expect(publishes).toBe(before);
  });

});
