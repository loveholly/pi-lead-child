// slack-takeover 工单 02：通道的凭据按适配器声明的密钥名通用地取（apps/daemon/src/channels.ts 的 channelCredentials）。
// 决策边界：缺一个密钥就没有凭据；换好的凭据缓存；重新换不成、密钥又没变时接着用上一次的（已经收下的投递不能因为网络
// 一时不通被拒）；密钥变了就重新换，换不成就没有；适配器写的日志去掉密钥；没有声明密钥的来源照旧按 connections 表取。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { ChannelAdapter, ChannelCredential } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import { channelCredentials } from "../src/channels.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-credentials-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

function adapterResolving(results: Array<ChannelCredential | null | Error>, calls: Array<Record<string, string>>): ChannelAdapter {
  return {
    id: "fake", auth: { connectionProvider: "fake", secrets: ["PLC_FAKE_ONE", "PLC_FAKE_TWO"] },
    async resolveCredential(secrets: Readonly<Record<string, string>>, log: (line: string) => void) {
      calls.push({ ...secrets });
      log(`resolving with ${secrets.PLC_FAKE_ONE}`);
      const next = results.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as ChannelAdapter;
}

describe("channel credentials from declared secrets", () => {
  it("needs every secret, caches, keeps the last good credential while the same secrets fail, and drops it when they change", async () => {
    const good: ChannelCredential = { token: "token-one-value", account: "U1" };
    const calls: Array<Record<string, string>> = [];
    const secrets: Record<string, string | null> = { PLC_FAKE_ONE: "secret-one-value", PLC_FAKE_TWO: null };
    const logs: string[] = [];
    let clock = 0;
    const source = channelCredentials({
      db, adapters: [adapterResolving([good, null, new Error("network down for secret-one-value"), null], calls)],
      accessToken: async () => null, secret: (name) => secrets[name] ?? null, log: (line) => logs.push(line), now: () => clock,
    });
    // 缺一个：没有凭据，也不去换。
    expect(await source.credential("fake")).toBeNull();
    expect(calls).toEqual([]);
    secrets.PLC_FAKE_TWO = "secret-two-value";
    // 同时来的几次只换一次；之后在缓存里。
    const [a, b] = await Promise.all([source.credential("fake"), source.credential("fake")]);
    expect([a, b]).toEqual([good, good]);
    expect(await source.credential("fake")).toEqual(good);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ PLC_FAKE_ONE: "secret-one-value", PLC_FAKE_TWO: "secret-two-value" });
    // 过了刷新的时间，重新换不成（返回 null、抛错）：密钥没变，接着用上一次的。
    clock += 31 * 60_000;
    expect(await source.credential("fake")).toEqual(good);
    clock += 31 * 60_000;
    expect(await source.credential("fake")).toEqual(good);
    expect(calls).toHaveLength(3);
    // 密钥变了，换不成：没有凭据。
    secrets.PLC_FAKE_ONE = "secret-one-rotated";
    expect(await source.credential("fake")).toBeNull();
    expect(calls).toHaveLength(4);
    // 日志里没有密钥。
    expect(logs.join("\n")).toContain("could not resolve the credential");
    for (const value of ["secret-one-value", "secret-two-value", "secret-one-rotated"]) expect(logs.join("\n")).not.toContain(value);
  });

  // slack-settings 工单 S1：设置页改了凭据以后热重连，先清掉缓存。换不成的结果（缓存一分钟）和上一次换好的都不再用。
  it("forgets a cached credential, so the next call resolves again at once", async () => {
    const good: ChannelCredential = { token: "token-one-value", account: "U1" };
    const calls: Array<Record<string, string>> = [];
    const source = channelCredentials({
      db, adapters: [adapterResolving([null, good, null], calls)],
      accessToken: async () => null, secret: (name) => `${name}-value`, log: () => {}, now: () => 0,
    });
    expect(await source.credential("fake")).toBeNull();
    // 一分钟内不再换。
    expect(await source.credential("fake")).toBeNull();
    expect(calls).toHaveLength(1);
    source.forget("fake");
    expect(await source.credential("fake")).toEqual(good);
    expect(calls).toHaveLength(2);
    // 清掉以后不留上一次换好的：这次换不成就没有。
    source.forget("fake");
    expect(await source.credential("fake")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("uses the connections table for a source that declares no secrets", async () => {
    const adapter = { id: "plain", auth: { connectionProvider: "plain" } } as unknown as ChannelAdapter;
    const source = channelCredentials({
      db, adapters: [adapter], accessToken: async () => "token", secret: () => "signing", log: () => {},
    });
    // 没有这个 provider 的连接行：没有凭据。
    expect(await source.credential("plain")).toBeNull();
  });
});
