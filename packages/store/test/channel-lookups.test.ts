// 代查的存取（Slack 代查与按信心代回 spec D1、D2、D7，工单 01）：一次代查的读写和乐观锁、没结束和超时的代查、配额，
// 以及按来源读 channel.lookup、channel.reply 两条常设指令（放开只算种子、用户写的、或者用户批准过的版本）。
// 校准样本 2026-10-22 起不在代查上（落地计划 D2，engine 的 channel-calibration 测试）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { LookupResult, StandingOrderDefinition } from "@pi-lead-child/protocol";
import {
  CHANNEL_LOOKUP_QUESTION_MAX, channelLookupPolicy, channelReplyPolicy, countLookupsSince, createChannelLookup, createItem, createRun,
  getActiveLookupForCard, getChannelLookup, getLatestLookupForCard, getLookupByItem, getStandingOrder, listActiveLookups,
  listOverdueLookups, openChannelCard, openDb, proposeStandingOrderChange,
  recordChannelLaneMessage, recordStandingOrderVersion, resolveStandingOrderProposal, updateChannelLookup,
  type ChannelLookupIntake, type Db, type NewChannelLookup,
} from "../src/index.js";

const T0 = new Date("2026-10-19T06:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const INTAKE: ChannelLookupIntake = {
  answered: true, askKind: "lookup", askConfidence: 0.8, targetRepo: "acme/orders",
  sensitive: { query_personal_info: 0.01 }, topics: { money: 0.02 },
  gate: { decision: "start", failed: [], checks: [{ condition: "trust", pass: true, detail: "colleague" }], order: { id: "channel.hook.lookup", version: 1 } },
  at: T0.toISOString(),
};

const RESULT: LookupResult = {
  found: "yes", answer: "只在支付成功以后触发。", replyDraft: "订单还在待支付，所以没有触发。",
  sources: [{ via: "local", repo: "acme/orders", path: "src/a.ts", startLine: 1, endLine: 2, quote: "if (!paid) return;", verified: true }],
  checked: ["acme/orders"], caveats: [],
};

let db: Db;
let objectCounter = 0;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-lookups-"), "plc.db"));
  objectCounter = 0;
});

function card(source = "hook"): { cardId: number; objectKey: string } {
  const objectKey = `${source}:t${++objectCounter}`;
  const lane = recordChannelLaneMessage(db, {
    source, objectKey, label: "对话", message: { at: T0.toISOString(), seq: null, role: "them", sender: "A", text: "hi" },
  });
  const opened = openChannelCard(db, {
    laneId: lane.id, source, objectKey, delivery: "card", seq: 1, sender: { id: "a", name: "A", trust: "colleague" },
    excerpt: "hi", replyTarget: {},
  });
  return { cardId: opened.id, objectKey };
}

function lookup(overrides: Partial<NewChannelLookup> = {}, source = "hook") {
  const { cardId, objectKey } = card(source);
  return createChannelLookup(db, {
    cardId, source, objectKey, forSeq: 1, playbook: "lookup", requester: { id: "U1", name: "张三", trust: "colleague" },
    question: "订单 123 的 webhook 为什么没触发？", intake: INTAKE, at: T0, ...overrides,
  });
}

describe("one lookup", () => {
  it("is created queued at version 1 with its JSON fields parsed back, and the question clipped", () => {
    const created = lookup({ question: "问".repeat(CHANNEL_LOOKUP_QUESTION_MAX + 50) });
    expect(created).toMatchObject({
      state: "queued", playbook: "lookup", version: 1, forSeq: 1, itemId: null, runId: null, result: null, reads: [],
      verification: null, reply: null, scope: { local: [], github: [] }, finishedAt: null,
      requester: { id: "U1", name: "张三", trust: "colleague" }, intake: INTAKE,
      createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
    });
    expect(created.question.length).toBe(CHANNEL_LOOKUP_QUESTION_MAX + 1);
    expect(getChannelLookup(db, created.id)).toEqual(created);
    // 被拒的请求直接写成 denied，同时记下结束的时间。
    expect(lookup({ state: "denied" })).toMatchObject({ state: "denied", finishedAt: T0.toISOString() });
  });

  it("refuses an unknown playbook, an unknown state or a malformed scope", () => {
    expect(() => lookup({ playbook: "approve" as never })).toThrow(/playbook/);
    expect(() => lookup({ state: "paused" as never })).toThrow(/state/);
    expect(() => lookup({ scope: { local: [] } as never })).toThrow(/scope/);
  });

  it("is updated with an optimistic lock, like a card", () => {
    const created = lookup();
    const itemId = createItem(db, { title: "Slack 代查：张三 问 webhook", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    const scope = { local: [{ repo: "acme/orders", root: "/tmp/orders" }], github: [{ owner: "acme", repo: "orders" }] };
    const running = updateChannelLookup(db, created.id, { state: "running", itemId, runId, scope }, { expectedVersion: 1, at: at(1) })!;
    expect(running).toMatchObject({ state: "running", itemId, runId, scope, version: 2, updatedAt: at(1).toISOString(), finishedAt: null });
    // 版本对不上：不改，返回 null。
    expect(updateChannelLookup(db, created.id, { state: "cancelled" }, { expectedVersion: 1 })).toBeNull();
    expect(getChannelLookup(db, created.id)!.state).toBe("running");
    expect(updateChannelLookup(db, 9_999, { state: "cancelled" })).toBeNull();
    // 结束：finished_at 自动记成这一次的时间；之后再改（写代回的决定）不动它。
    const reads = [{ tool: "read_file", repo: "acme/orders", path: "src/a.ts", lines: [1, 40] as [number, number], bytes: 900, at: at(2).toISOString() }];
    const finished = updateChannelLookup(db, created.id, { state: "finished", result: RESULT, reads }, { expectedVersion: 2, at: at(3) })!;
    expect(finished).toMatchObject({ state: "finished", result: RESULT, reads, version: 3, finishedAt: at(3).toISOString() });
    const decided = updateChannelLookup(db, created.id, {
      state: "finished",
      reply: { decision: "ask_user", reasons: ["冷启动"], order: null, at: at(4).toISOString(), choice: null },
    }, { at: at(4) })!;
    expect(decided).toMatchObject({ version: 4, finishedAt: at(3).toISOString(), reply: { decision: "ask_user" } });
  });

  it("cannot go back to queued or running once it ended, and refuses malformed results and read records", () => {
    const created = lookup();
    updateChannelLookup(db, created.id, { state: "failed" });
    expect(() => updateChannelLookup(db, created.id, { state: "running" })).toThrow(/already ended/);
    expect(() => updateChannelLookup(db, created.id, { result: { ...RESULT, found: "maybe" } as never })).toThrow(/result/);
    expect(() => updateChannelLookup(db, created.id, { reads: [{ tool: "read_file" }] as never })).toThrow(/reads/);
    expect(() => updateChannelLookup(db, created.id, { scope: {} as never })).toThrow(/scope/);
    expect(() => updateChannelLookup(db, created.id, { nonsense: 1 } as never)).toThrow(/unknown field/);
    // 把 result 清空是可以的。
    expect(updateChannelLookup(db, created.id, { result: null })!.result).toBeNull();
  });

  it("reads back malformed stored JSON as empty, so a card DTO never carries bad data", () => {
    const created = lookup();
    db.prepare("UPDATE channel_lookups SET scope = '{\"local\":1}', result = '{\"found\":\"maybe\"}', reads = 'not json' WHERE id = ?")
      .run(created.id);
    expect(getChannelLookup(db, created.id)).toMatchObject({ scope: { local: [], github: [] }, result: null, reads: [] });
  });
});

describe("finding lookups", () => {
  it("by card (the active one and the latest), by item, active by source, and overdue", () => {
    const first = lookup();
    expect(getActiveLookupForCard(db, first.cardId)?.id).toBe(first.id);
    expect(getLatestLookupForCard(db, first.cardId)?.id).toBe(first.id);
    updateChannelLookup(db, first.id, { state: "cancelled" }, { at: at(1) });
    expect(getActiveLookupForCard(db, first.cardId)).toBeUndefined();
    // 重新查是同一张卡上的新一行。
    const again = createChannelLookup(db, { ...first, requester: first.requester, intake: first.intake, at: at(2) });
    expect(getLatestLookupForCard(db, first.cardId)?.id).toBe(again.id);
    expect(getActiveLookupForCard(db, first.cardId)?.id).toBe(again.id);
    expect(getLatestLookupForCard(db, 9_999)).toBeUndefined();

    const itemId = createItem(db, { title: "代查工单", brief: "b", createdBy: "system" });
    updateChannelLookup(db, again.id, { state: "running", itemId }, { at: at(3) });
    expect(getLookupByItem(db, itemId)?.id).toBe(again.id);
    expect(getLookupByItem(db, itemId + 1)).toBeUndefined();

    const other = lookup({ at: at(10) }, "other");
    expect(listActiveLookups(db).map((row) => row.id)).toEqual([again.id, other.id]);
    expect(listActiveLookups(db, { source: "hook" }).map((row) => row.id)).toEqual([again.id]);

    // 超时从开出来的时间算（排队也算）。again 在 T0+2 开，other 在 T0+10 开。
    expect(listOverdueLookups(db, at(16), 15 * 60_000).map((row) => row.id)).toEqual([]);
    expect(listOverdueLookups(db, at(17), 15 * 60_000).map((row) => row.id)).toEqual([again.id]);
    expect(listOverdueLookups(db, at(30), 15 * 60_000).map((row) => row.id)).toEqual([again.id, other.id]);
    expect(listOverdueLookups(db, at(30), 15 * 60_000, { source: "other" }).map((row) => row.id)).toEqual([other.id]);
    updateChannelLookup(db, again.id, { state: "failed" });
    expect(listOverdueLookups(db, at(30), 15 * 60_000).map((row) => row.id)).toEqual([other.id]);
  });
});

describe("quotas", () => {
  it("count lookups since a time, per requester or for the whole source; denied requests do not count", () => {
    lookup({ at: at(0) });
    lookup({ at: at(5), requester: { id: "U2", name: "李四", trust: "colleague" } });
    const failed = lookup({ at: at(6) });
    updateChannelLookup(db, failed.id, { state: "failed" });
    lookup({ at: at(7), state: "denied" });
    lookup({ at: at(8) }, "other");
    expect(countLookupsSince(db, { source: "hook", since: at(0) })).toBe(3);
    expect(countLookupsSince(db, { source: "hook", since: at(1) })).toBe(2);
    expect(countLookupsSince(db, { source: "hook", requesterId: "U1", since: at(0) })).toBe(2);
    expect(countLookupsSince(db, { source: "hook", requesterId: "U2", since: at(0) })).toBe(1);
    expect(countLookupsSince(db, { source: "hook", requesterId: "U3", since: at(0) })).toBe(0);
    expect(countLookupsSince(db, { source: "other", since: at(0) })).toBe(1);
  });
});

// ── 常设指令 ──────────────────────────────────────────────────────────────────────

const LOOKUP_ORDER: StandingOrderDefinition = {
  id: "channel.hook.lookup", title: "代查", priority: 100, condition: {},
  action: {
    type: "rule", rule: "channel.lookup",
    params: {
      source: "hook", playbooks: ["lookup"], allowedTrust: ["trusted", "colleague"], minAskConfidence: 0.5, maxSensitiveQuery: 0.5,
      perRequesterDaily: 10, dailyMax: 40, concurrent: 2, timeoutMs: 15 * 60_000, maxRepos: 2,
    },
  },
  limits: null, escalateTo: null, reason: "种子",
};

const REPLY_ORDER: StandingOrderDefinition = {
  id: "channel.hook.reply", title: "代回", priority: 100, condition: {},
  action: {
    type: "rule", rule: "channel.reply",
    params: {
      source: "hook", autoReply: { lookup: true, review: false }, threshold: 0.85, coldStartMin: 0.9, calibrationMinSamples: 20,
      calibrationMinAgreement: 0.9, maxSensitivity: 0.2, maxResultAgeMs: 30 * 60_000, revokeWindowMs: 10 * 60_000,
    },
  },
  limits: null, escalateTo: null, reason: "种子",
};

const withParams = (definition: StandingOrderDefinition, params: Record<string, unknown>): StandingOrderDefinition => ({
  ...definition, reason: "改参数",
  action: { ...definition.action, params: { ...(definition.action as { params: Record<string, unknown> }).params, ...params } } as never,
});
const write = (definition: StandingOrderDefinition, meta: Parameters<typeof recordStandingOrderVersion>[2]) =>
  db.transaction(() => recordStandingOrderVersion(db, definition, meta))();

describe("reading the lookup and reply standing orders", () => {
  it("are null when the source has no such order", () => {
    expect(channelLookupPolicy(db, "hook")).toBeNull();
    expect(channelReplyPolicy(db, "hook")).toBeNull();
  });

  it("read the seed's values, and drop customers from the senders even if a version names them", () => {
    write(LOOKUP_ORDER, { author: "system", seedRevision: 1 });
    write(REPLY_ORDER, { author: "system", seedRevision: 1 });
    expect(channelLookupPolicy(db, "hook")).toEqual({
      playbooks: ["lookup"], requestedPlaybooks: ["lookup"], allowedTrust: ["trusted", "colleague"], minAskConfidence: 0.5,
      maxSensitiveQuery: 0.5, perRequesterDaily: 10, dailyMax: 40, concurrent: 2, timeoutMs: 15 * 60_000, maxRepos: 2,
      order: { id: "channel.hook.lookup", version: 1 },
    });
    expect(channelReplyPolicy(db, "hook")).toEqual({
      autoReply: { lookup: true, review: false }, requestedAutoReply: { lookup: true, review: false }, threshold: 0.85,
      coldStartMin: 0.9, calibrationMinSamples: 20, calibrationMinAgreement: 0.9, maxSensitivity: 0.2, maxResultAgeMs: 30 * 60_000,
      revokeWindowMs: 10 * 60_000, order: { id: "channel.hook.reply", version: 1 },
    });
    expect(channelLookupPolicy(db, "other")).toBeNull();
    // 用户自己写进了 customer（硬性规则在 Lead 的提议里拒绝；这里是最后一道）。
    write(withParams(LOOKUP_ORDER, { allowedTrust: ["colleague", "customer"] }), { author: "user" });
    expect(channelLookupPolicy(db, "hook")!.allowedTrust).toEqual(["colleague"]);
  });

  it("open a playbook or an auto reply only when a seed, the user, or an approved version opened it", () => {
    write(LOOKUP_ORDER, { author: "system", seedRevision: 1 });
    write(REPLY_ORDER, { author: "system", seedRevision: 1 });
    // 没有经过批准写进库的版本（作者是 Lead）放开不了开关。
    write(withParams(LOOKUP_ORDER, { playbooks: ["lookup", "review"] }), { author: "lead" });
    write(withParams(REPLY_ORDER, { autoReply: { lookup: true, review: true } }), { author: "lead" });
    expect(channelLookupPolicy(db, "hook")).toMatchObject({ playbooks: ["lookup"], requestedPlaybooks: ["lookup", "review"] });
    expect(channelReplyPolicy(db, "hook")).toMatchObject({
      autoReply: { lookup: true, review: false }, requestedAutoReply: { lookup: true, review: true },
    });

    // 走工单 10 的流程：Lead 提议放开（review 也自动回，门槛降到 0.84），更放开，等批准；用户批准以后才算数。
    const current = getStandingOrder(db, "channel.hook.reply")!;
    const proposal = proposeStandingOrderChange(db, {
      op: "update", id: "channel.hook.reply", reason: "review 也自动回",
      patch: { action: { ...current.action, params: { ...(current.action as any).params, autoReply: { lookup: true, review: true }, threshold: 0.84 } } as never },
    });
    expect(proposal.outcome).toBe("pending_approval");
    expect(channelReplyPolicy(db, "hook")!.autoReply.review).toBe(false);
    const approvalId = proposal.outcome === "pending_approval" ? proposal.proposal.approvalId : 0;
    resolveStandingOrderProposal(db, approvalId, { approve: true, resolvedBy: "user via test" });
    expect(channelReplyPolicy(db, "hook")).toMatchObject({ autoReply: { lookup: true, review: true }, threshold: 0.84 });

    // Lead 收紧（更保守，直接生效）：关掉 lookup 的自动代回。
    const approved = getStandingOrder(db, "channel.hook.reply")!;
    const tightened = proposeStandingOrderChange(db, {
      op: "update", id: "channel.hook.reply", reason: "先不自动回",
      patch: { action: { ...approved.action, params: { ...(approved.action as any).params, autoReply: { lookup: false, review: true } } } as never },
    });
    expect(tightened.outcome).toBe("applied");
    expect(channelReplyPolicy(db, "hook")!.autoReply).toEqual({ lookup: false, review: true });

    // 用户自己写的版本直接算数。
    write(withParams(LOOKUP_ORDER, { playbooks: ["lookup", "review"] }), { author: "user" });
    expect(channelLookupPolicy(db, "hook")!.playbooks).toEqual(["lookup", "review"]);
  });
});
