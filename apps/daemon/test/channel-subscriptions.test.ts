// 固定订阅（用户 2026-11-25）：通道设置（channel-settings.ts）经过操作层（channel_subscriptions）加、删固定订阅的频道。
// 来源是真的 Slack 插件，Slack 是假的，库是真的。
//   - 设置页和 Lead 调同一个操作；Lead 在自己的一轮里可以加、删；
//   - 这是改规则：外部消息叫醒、读过外部内容的一轮被拒绝，名单不变；
//   - 名单存进 store，适配器下一条消息就按它判断订阅；排除名单只读地列出来。
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { Vault } from "@pi-lead-child/connections";
import { builtinChannelAdapters, ChannelHub, ChannelRegistry, runUiAction, type ChannelAdapter } from "@pi-lead-child/engine";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import { ChannelSubscriptionsDtoSchema } from "@pi-lead-child/protocol";
import { getChannelConnection, openDb, setChannelPinned, type Db } from "@pi-lead-child/store";
import { Value } from "typebox/value";
import { ChannelSettings } from "../src/channel-settings.js";

let db: Db;
let slack: FakeSlack;
let adapter: ChannelAdapter;
let settings: ChannelSettings;
let published: number;

const target = { type: "channel_subscriptions", id: "slack" } as const;
const user = { kind: "user" } as const;
const lead = { kind: "lead", turnId: null } as const;
const external = [{ via: "message", source: "slack" }, { via: "tool", tool: "read_channel_conversation" }] as const;
const leadInExternalTurn = { kind: "lead", turnId: null, externalContent: external } as const;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-subscriptions-"), "plc.db"));
  slack = new FakeSlack({ channels: { C0RELEASE: "release-train", C0OPS: "ops" } });
  published = 0;
  [adapter] = builtinChannelAdapters({ slack: { api: slack.api } }, { slack: { memory: { exclude: ["#ops"] } } }, {
    connectionSettings: (source) => getChannelConnection(db, source),
  }) as [ChannelAdapter];
  settings = new ChannelSettings({
    db, vault: new Vault(randomBytes(32)), log: () => undefined, env: () => null, keychain: () => null, publish: () => { published += 1; },
  });
  settings.attach({ adapters: () => [adapter], reload: async () => undefined });
});

afterEach(() => {
  db.close();
});

const act = (action: string, caller: typeof user | typeof lead | typeof leadInExternalTurn, entry: string) =>
  runUiAction(db, { target, action, input: { entry }, reason: "测试", caller, services: { channelSubscriptions: settings } });

describe("pinned channel subscriptions", () => {
  it("lists the pinned and excluded channels in the shape the settings page reads", () => {
    const dto = settings.subscriptionsView("slack")!;
    expect(Value.Check(ChannelSubscriptionsDtoSchema, dto)).toBe(true);
    expect(dto).toEqual({ source: "slack", pinned: [], excluded: ["#ops"] });
    expect(settings.subscriptionsView("missing")).toBeNull();
  });

  it("lets Lead pin and unpin a channel in its own turn, stores it, and the adapter follows the list", async () => {
    const pinned = await act("pin", lead, "  #release-train ");
    expect(pinned.result).toMatchObject({ pinned: ["#release-train"], excluded: ["#ops"] });
    expect(getChannelConnection(db, "slack").pinned).toEqual(["#release-train"]);
    // 同一个频道（不分大小写、带不带 #）不加第二次。
    await act("pin", user, "Release-Train");
    expect(getChannelConnection(db, "slack").pinned).toEqual(["#release-train"]);
    expect(published).toBe(1);

    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: () => undefined,
    });
    expect((await hub.receive("slack", slack.chatter("U0LI", "周五冻结代码", "C0RELEASE"))).items[0])
      .toMatchObject({ kind: "slack.channel.message", delivery: "record" });

    const removed = await act("unpin", lead, "release-train");
    expect(removed.result).toMatchObject({ pinned: [] });
    expect((await hub.receive("slack", slack.chatter("U0LI", "发布完成", "C0RELEASE"))).items).toEqual([]);
    // 名单空了：删不了。
    await expect(act("unpin", user, "release-train")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses a pin or an unpin in a turn that read external content, and changes nothing", async () => {
    await expect(act("pin", leadInExternalTurn, "#release-train")).rejects.toMatchObject({ code: "external_turn" });
    expect(getChannelConnection(db, "slack").pinned).toEqual([]);
    setChannelPinned(db, "slack", ["#release-train"]);
    await expect(act("unpin", leadInExternalTurn, "#release-train")).rejects.toMatchObject({ code: "external_turn" });
    expect(getChannelConnection(db, "slack").pinned).toEqual(["#release-train"]);
  });

  it("rejects an entry that is blank or unknown, and keeps the stored list clean", async () => {
    await expect(act("pin", user, "   ")).rejects.toMatchObject({ code: "invalid_input" });
    setChannelPinned(db, "slack", ["#release-train"]);
    await expect(act("unpin", user, "#design-review")).rejects.toMatchObject({ code: "invalid_input" });
    db.prepare("UPDATE kv SET value = ? WHERE key = ?")
      .run(JSON.stringify({ mode: null, writes: false, pinned: ["C0RELEASE", "", 7, "c0release", "x".repeat(101)] }), "channel.connection.slack");
    expect(getChannelConnection(db, "slack").pinned).toEqual(["C0RELEASE"]);
  });
});
