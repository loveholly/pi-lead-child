// 固定订阅（用户 2026-11-25）：用户维护的频道名单（频道编号或频道名），名单里的频道没有近期的道也算订阅，消息只记录；
// 排除名单优先；不在名单里的频道和以前一样，只看 14 天内有没有道。走真实的 hub 和 SQLite，Slack 是假的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, builtinChannelAdapters, createSlackChannelAdapter, slackChannelList } from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-pinned-"), "plc.db"));
  clock = new Date("2026-11-20T10:00:00.000Z");
  slack = new FakeSlack({
    now: () => clock,
    channels: { C0RELEASE: "release-train", C0DESIGN: "design-review", C0OPS: "ops", C0HR: "hr-private", C0QUIET: "quiet" },
  });
});

afterEach(() => {
  db.close();
});

function hubWith(options: { pinned?: readonly string[] | (() => readonly string[]); exclude?: string[] }): ChannelHub {
  const adapter = createSlackChannelAdapter({
    api: slack.api, now: () => clock,
    ...(options.pinned ? { pinned: options.pinned } : {}),
    ...(options.exclude ? { memory: { exclude: options.exclude } } : {}),
  });
  return new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    log: () => undefined,
  });
}

const infoCalls = () => slack.requests.filter((request) => request.method === "conversations.info").length;

describe("pinned Slack channels", () => {
  it("subscribes to a pinned channel by id or by name without any recent lane, and only records its messages", async () => {
    const hub = hubWith({ pinned: ["C0RELEASE", "#Design-Review"] });
    const byId = (await hub.receive("slack", slack.chatter("U0LI", "周五冻结代码", "C0RELEASE"))).items;
    expect(byId[0]).toMatchObject({ kind: "slack.channel.message", delivery: "record", cardId: null });
    const byName = (await hub.receive("slack", slack.chatter("U0LI", "新的配色稿", "C0DESIGN"))).items;
    expect(byName[0]).toMatchObject({ kind: "slack.channel.message", delivery: "record", cardId: null });
    // 没有道、也没有固定的频道：和以前一样不收。
    expect((await hub.receive("slack", slack.chatter("U0LI", "无关", "C0QUIET"))).items).toEqual([]);
    expect(listEvents(db, { kind: "slack.channel.message" })).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_cards").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_lanes").get()).toEqual({ n: 0 });
  });

  it("keeps a pinned channel subscribed long after its last lane, and reads the live list on each message", async () => {
    let pinned: string[] = [];
    const hub = hubWith({ pinned: () => pinned });
    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下发布计划", { channel: "C0RELEASE" }));
    await hub.idle();
    clock = new Date(clock.getTime() + 20 * 86_400_000);
    // 20 天没有道：没有固定时掉了订阅（和以前一样）。
    expect((await hub.receive("slack", slack.chatter("U0LI", "发布推迟", "C0RELEASE"))).items).toEqual([]);
    // 用户刚固定了它：下一条消息就收，不用重启。
    pinned = ["#release-train"];
    expect((await hub.receive("slack", slack.chatter("U0LI", "发布改到下周", "C0RELEASE"))).items[0])
      .toMatchObject({ kind: "slack.channel.message", delivery: "record" });
    // 取消固定：又掉了。
    pinned = [];
    expect((await hub.receive("slack", slack.chatter("U0LI", "发布完成", "C0RELEASE"))).items).toEqual([]);
  });

  it("does not subscribe to a pinned channel that is also excluded, by id or by name", async () => {
    const hub = hubWith({ pinned: ["C0OPS", "#hr-private", "C0RELEASE"], exclude: ["#ops", "C0HR"] });
    expect((await hub.receive("slack", slack.chatter("U0LI", "值班交接", "C0OPS"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.chatter("U0LI", "假期安排", "C0HR"))).items).toEqual([]);
    expect((await hub.receive("slack", slack.chatter("U0LI", "周五冻结代码", "C0RELEASE"))).items[0])
      .toMatchObject({ kind: "slack.channel.message" });
  });

  it("leaves channels outside the list as before: a recent lane subscribes, exclusion still wins, no extra lookups", async () => {
    const hub = hubWith({ pinned: ["C0RELEASE"], exclude: ["#quiet"] });
    // C0PROJ 有近期的道：订阅（只记录）。
    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下"));
    await hub.idle();
    expect((await hub.receive("slack", slack.chatter("U0LI", "周五发布"))).items[0]).toMatchObject({ kind: "slack.channel.message" });
    // C0QUIET 有近期的道，但在排除名单里：不订阅。
    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下", { channel: "C0QUIET" }));
    await hub.idle();
    expect((await hub.receive("slack", slack.chatter("U0LI", "闲聊", "C0QUIET"))).items).toEqual([]);
    // C0DESIGN 没有道，固定名单里只有频道编号：不订阅，也不为它多问一次 conversations.info。
    const before = infoCalls();
    const fresh = slack.chatter("U0LI", "新的配色稿", "C0DESIGN");
    expect((await hub.receive("slack", fresh)).items).toEqual([]);
    expect(infoCalls()).toBe(before);
  });

  it("matches ids exactly and names without the leading # and case", () => {
    const list = slackChannelList(["C0RELEASE", "#Design-Review", "", 7]);
    expect(list.hasId("C0RELEASE")).toBe(true);
    expect(list.hasId("c0release")).toBe(false);
    expect(list.hasName("design-review")).toBe(true);
    expect(list.hasName(null)).toBe(false);
    expect(slackChannelList(["C0RELEASE"]).hasNames).toBe(false);
    expect(list.hasNames).toBe(true);
  });

  it("reads the list from the stored connection settings through builtinChannelAdapters", () => {
    const stored = { mode: null, writes: false, pinned: ["#release-train"] };
    const [adapter] = builtinChannelAdapters({ slack: { api: slack.api, now: () => clock } }, undefined, { connectionSettings: () => stored });
    expect(adapter!.subscriptions?.excluded()).toEqual([]);
    expect(adapter!.subscriptions?.entryHint).toMatch(/频道编号/);
  });
});
