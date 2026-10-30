// 通道设置（apps/daemon/src/channel-settings.ts，slack-settings 工单 S1）的决策边界。来源是一个假的适配器，
// 保险库是真的（随机密钥）。完整的一跳（网关、Slack、热重连）在 channel-settings-daemon.test.ts。
//   - 取密钥：保险库 → daemon 专用的环境变量 → Keychain；保险库里解不开的当作没有，只记一次日志，不写值；
//   - 状态：出错的原因去掉现在的密钥；重连时留着上一次的错误；连上时清掉；同一个人时留着检查认出的账号；
//   - 检查：请求里没给的用现在的补上；来源插件回的文字里带了密钥也去掉；有一项没过 ok 就是 false；等太久算没过；
//   - 保存：只写请求里给的（去掉首尾空白）；检查没过不写；删除只删保险库里的。
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { Vault } from "@pi-lead-child/connections";
import type { ChannelAdapter, ChannelSettingsSpec } from "@pi-lead-child/engine";
import type { ChannelSecretsTestResult } from "@pi-lead-child/protocol";
import { openDb, type Db } from "@pi-lead-child/store";
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

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-settings-"), "plc.db"));
  logs = [];
  env = {};
  keychain = {};
  publishes = 0;
  reloads = [];
  tested = [];
  answer = async () => ({ ok: true, checks: [{ id: "one", label: "一", pass: true, detail: "好" }], account: null, missingScopes: [] });
});

afterEach(() => {
  db.close();
});

function adapter(): ChannelAdapter {
  const settings: ChannelSettingsSpec = {
    secrets: [
      { name: ONE, label: "第一个", prefix: "fake-", hint: "" },
      { name: TWO, label: "第二个", prefix: "fake-", hint: "" },
    ],
    manifest: null,
    setupUrl: null,
    test: async (secrets) => {
      tested.push({ ...secrets });
      return answer(secrets);
    },
  };
  return { id: "fake", label: "Fake", auth: { connectionProvider: "fake", secrets: [ONE, TWO] }, settings } as unknown as ChannelAdapter;
}

function setup(options: { vault?: Vault; testTimeoutMs?: number } = {}) {
  const settings = new ChannelSettings({
    db, vault: options.vault ?? new Vault(randomBytes(32)), log: (line) => logs.push(line),
    env: (name) => env[name] ?? null, keychain: (name) => keychain[name] ?? null,
    publish: () => { publishes += 1; },
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const fake = adapter();
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
    expect(result).toMatchObject({ ok: false, checks: [{ pass: false, detail: expect.stringContaining("没有在") }] });
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
