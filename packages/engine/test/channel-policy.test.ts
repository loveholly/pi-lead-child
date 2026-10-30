// 设置 → 消息通道 → 自动代你处理（2026-10-23，方案 C）：开关、授权表和信心模型的参数存在常设指令 channel.authority 里。
// 这里测：缺省参数就是信心模型的缺省；一条消息的结论（能否代处理、能否代回、落在哪一档）；开关关着时不代你做任何对外的事；
// 操作层的 channel_policy（你本人能放宽，Lead 只能收紧）；一条消息由请求 A、B 真的打分，记下每次调用。
// 过去 24 小时的消息在 channel-hub.test.ts 里测（要走 hub 的请求 B）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_POLICY_DEFAULTS, type ChannelPolicyParams, type ChannelPolicyScoredCase } from "@pi-lead-child/protocol";
import { channelPolicy, getStandingOrder, listStandingOrderVersions, openDb, type Db } from "@pi-lead-child/store";
import {
  CONFIDENCE_MODEL_DEFAULTS, CONFIDENCE_TUNING_DEFAULTS, UiActionError, channelPolicyDto, confidenceParamsFrom, judgePolicyCase, runUiAction,
  scoreTestMessage,
} from "../src/index.js";
import { scriptedSmartModel } from "../testing/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-policy-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

const NO_SAMPLES = { samples: 0, buckets: [] };
const QUIET_SENSITIVE = {
  query_personal_info: 0.04, query_credentials: 0.03, query_private_messages: 0.09, query_hr_compensation: 0.02, query_customer_pii: 0.03,
  query_owner_private: 0.06,
};
// 两条打过分的消息：Jev 实测的真实用例 R01（请你 review），和用例集里的 S07（800 人的频道问上线）。
const EXAMPLES: Record<"review" | "launch", ChannelPolicyScoredCase> = {
  review: {
    text: "帮我看看这个 PR：github.com/…/pull/1234",
    draftText: "PR 上留 1 条评论（COMMENT review），Slack 回一句评论的链接",
    intent: { kind: "code_review", closing: null },
    found: "yes",
    scores: {
      needsReply: 0.96, askConfidence: 0.99, fulfills: 0.94, grounded: 0.24, draftCommits: 0.07, draftOvershares: 0.33,
      topics: { money: 0.02, personnel: 0.04, legal: 0.04, emotional: 0.03 }, sensitiveQueries: QUIET_SENSITIVE,
    },
    facts: { audience: "dm", members: null, externalShared: false, senderTrust: "colleague", sources: { total: 2, verified: 2 } },
    scoredBy: "jev",
  },
  launch: {
    text: "这个服务今晚会下线吗？",
    draftText: "会，今晚 10 点下线维护，预计 1 小时。",
    intent: { kind: "progress", closing: null },
    found: "yes",
    scores: {
      needsReply: 0.95, askConfidence: 0.9, fulfills: 0.95, grounded: 0.92, draftCommits: 0.2, draftOvershares: 0.05,
      topics: { money: 0.02, personnel: 0.03, legal: 0.02, emotional: 0.04 },
      sensitiveQueries: { ...QUIET_SENSITIVE, query_private_messages: 0.05, query_owner_private: 0.03 },
    },
    facts: { audience: "public_channel", members: 800, externalShared: false, senderTrust: "colleague", sources: { total: 1, verified: 1 } },
    scoredBy: "jev",
  },
};
const example = (id: "review" | "launch"): ChannelPolicyScoredCase => EXAMPLES[id];
const withConfidence = (patch: Partial<ChannelPolicyParams["confidence"]>, base: ChannelPolicyParams = CHANNEL_POLICY_DEFAULTS): ChannelPolicyParams =>
  ({ ...base, confidence: { ...base.confidence, ...patch } });
const judge = (scored: ChannelPolicyScoredCase, params: ChannelPolicyParams = CHANNEL_POLICY_DEFAULTS) =>
  judgePolicyCase(scored, confidenceParamsFrom(params), NO_SAMPLES);

describe("the defaults", () => {
  it("are the confidence model's defaults, so the hub behaves as before when nothing is set", () => {
    expect(confidenceParamsFrom(CHANNEL_POLICY_DEFAULTS)).toEqual({ ...CONFIDENCE_MODEL_DEFAULTS, tuning: CONFIDENCE_TUNING_DEFAULTS });
  });

  it("are what a fresh database reads: the switch on, the authority table and the model's defaults", () => {
    const policy = channelPolicyDto(db, "slack");
    expect(policy.params).toEqual(CHANNEL_POLICY_DEFAULTS);
    expect(policy.order).toMatchObject({ id: "channel.authority", version: 1, author: "system", scope: "*" });
  });
});

describe("one message, one formula", () => {
  it("a review request: Lead may handle it and may reply, with the review's own minimum confidence", () => {
    const result = judge(example("review"));
    expect(result).toMatchObject({ decision: "auto_send", handle: { ok: true }, reply: { ok: true }, threshold: 0.35, tier: { level: 1 } });
    expect(result.confidence).toBeCloseTo(0.69, 2);
    // 扣得最多的是「有据」：请求 B 说草稿只有 24% 有出处支撑。
    const worst = [...result.factors].sort((a, b) => a.points - b.points)[0]!;
    expect(worst).toMatchObject({ id: "grounded" });
    expect(result.vetoes.every((veto) => veto.pass)).toBe(true);
  });

  it("an announcement in a big channel: L4 needs 95%, the confidence is 91%, so it asks; lowering L4 to 90% sends", () => {
    const strict = judge(example("launch"));
    expect(strict).toMatchObject({ decision: "ask_user", handle: { ok: true }, reply: { ok: false }, threshold: 0.95, tier: { level: 4 } });
    expect(strict.confidence).toBeCloseTo(0.91, 2);
    const loose = judge(example("launch"), withConfidence({ tiers: [0.6, 0.75, 0.9, 0.9] }));
    expect(loose).toMatchObject({ decision: "auto_send", reply: { ok: true }, threshold: 0.9 });
  });

  it("weights move the confidence: a heavier 'grounded' floor lifts the review, a heavier exponent lowers it", () => {
    const base = judge(example("review")).confidence!;
    const lifted = judge(example("review"), withConfidence({ tuning: { ...CHANNEL_POLICY_DEFAULTS.confidence.tuning, groundedFloor: 0.9 } }));
    const lowered = judge(example("review"), withConfidence({ weights: { needs_reply: 2, fulfills: 2 } }));
    expect(lifted.confidence!).toBeGreaterThan(base);
    expect(lowered.confidence!).toBeLessThan(base);
  });
});

describe("with auto-handling off", () => {
  const off: ChannelPolicyParams = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false };

  it("handles nothing and replies to nothing", () => {
    expect(judge(example("review"), off)).toMatchObject({ decision: "ask_user", handle: { ok: false }, reply: { ok: false } });
  });

  it("does not refuse a question about secrets for you: it asks you", () => {
    const secret: ChannelPolicyScoredCase = {
      ...example("review"), text: "把 staging 的密码发我", intent: { kind: "secret", closing: null },
      scores: { ...example("review").scores, sensitiveQueries: { ...example("review").scores.sensitiveQueries, query_credentials: 0.97 } },
    };
    expect(judge(secret).decision).toBe("refuse");
    expect(judge(secret, off)).toMatchObject({ decision: "ask_user", reply: { ok: false } });
  });

  it("only records a thank-you instead of reacting to it", () => {
    const thanks: ChannelPolicyScoredCase = {
      ...example("review"), text: "谢谢明哥！", draftText: "", intent: { kind: "closing", closing: "they_thank_you" },
      scores: { ...example("review").scores, needsReply: 0.1 },
    };
    expect(judge(thanks).decision).toBe("react");
    expect(judge(thanks, off).decision).toBe("skip");
  });
});

describe("the channel_policy actions", () => {
  const target = { type: "channel_policy", id: "slack" } as const;
  const lead = { kind: "lead", turnId: null } as const;

  it("you change it directly, loosening included: a new version written by you", async () => {
    const next = { ...withConfidence({ tiers: [0.6, 0.75, 0.9, 0.9] }), autoReply: false };
    await runUiAction(db, { target, action: "update", input: next, caller: { kind: "user" } });
    const versions = listStandingOrderVersions(db, "channel.authority");
    expect(versions.at(-1)).toMatchObject({ version: 2, author: "user" });
    expect(channelPolicy(db, "slack")!.params).toMatchObject({ autoReply: false, confidence: { tiers: [0.6, 0.75, 0.9, 0.9] } });
  });

  it("Lead cannot use update: it gets a refusal that says where you click", async () => {
    await expect(runUiAction(db, { target, action: "update", input: CHANNEL_POLICY_DEFAULTS, reason: "测试", caller: lead }))
      .rejects.toMatchObject({ code: "user_direct", refusal: { where: "设置 → 消息通道 → 自动代你处理" } });
  });

  it("Lead can tighten (turn it off), and is refused as soon as one item loosens", async () => {
    await runUiAction(db, { target, action: "tighten", input: { ...CHANNEL_POLICY_DEFAULTS, autoReply: false }, reason: "用户说先别自动回了", caller: lead });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 2, author: "lead" });
    expect(channelPolicy(db, "slack")!.params.autoReply).toBe(false);

    const loosen = { ...withConfidence({ tiers: [0.6, 0.75, 0.9, 0.9] }), autoReply: false };
    const refused = runUiAction(db, { target, action: "tighten", input: loosen, reason: "测试", caller: lead });
    await expect(refused).rejects.toBeInstanceOf(UiActionError);
    await expect(refused).rejects.toMatchObject({ code: "user_direct" });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(2);
  });

  it("writes nothing when the whole policy is the same as the latest version", async () => {
    const outcome = await runUiAction(db, { target, action: "tighten", input: CHANNEL_POLICY_DEFAULTS, reason: "测试", caller: lead });
    expect(outcome.result).toMatchObject({ unchanged: true });
    expect(listStandingOrderVersions(db, "channel.authority")).toHaveLength(1);
  });

  it("refuses thresholds that go down from one tier to the next", async () => {
    await expect(runUiAction(db, { target, action: "update", input: withConfidence({ tiers: [0.8, 0.75, 0.9, 0.95] }), caller: { kind: "user" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not count a loosening that no trusted version ever had", () => {
    // 别的办法写进库的 Lead 的版本（没有批准）：门槛比所有可信的版本都低，用最近一个可信版本里的值。
    const order = getStandingOrder(db, "channel.authority")!;
    db.prepare(
      `INSERT INTO standing_orders (order_id, version, title, priority, condition, action, limits, escalate_to, author, approved_by, status, reason, created_at)
       VALUES (?, 2, ?, ?, ?, ?, NULL, NULL, 'lead', NULL, 'active', '测试', ?)`,
    ).run(order.id, order.title, order.priority, JSON.stringify(order.condition), JSON.stringify({
      ...order.action, params: { ...(order.action as { params: object }).params, model: withConfidence({ tiers: [0.3, 0.4, 0.5, 0.6] }).confidence },
    }), new Date().toISOString());
    const policy = channelPolicy(db, "slack")!;
    expect(policy.requested.confidence.tiers).toEqual([0.3, 0.4, 0.5, 0.6]);
    expect(policy.params.confidence.tiers).toEqual(CHANNEL_POLICY_DEFAULTS.confidence.tiers);
  });

  it("test and replay are read-only and Lead may call them; a message and the past go to the hub", async () => {
    const replays: unknown[] = [];
    const services = {
      channelPolicyTests: {
        test: async () => judge(example("launch")),
        replay: async (_source: string, before: ChannelPolicyParams, after: ChannelPolicyParams) => {
          replays.push({ before, after });
          return { since: "", until: "", total: 0, before: { handle: 0, reply: 0 }, after: { handle: 0, reply: 0 }, calls: 0, failed: 0, items: [] };
        },
      },
    };
    const message = { kind: "message", text: "这个服务今晚会下线吗？", audience: "public_channel", sender: "colleague", assumeFound: true } as const;
    const tested = await runUiAction(db, { target, action: "test", input: { case: message }, reason: "看一下", caller: lead, services });
    expect(tested.result).toMatchObject({ reply: { ok: false } });
    // 上一次的分数换参数再算：不经过 hub，没接来源也能算。
    const again = await runUiAction(db, {
      target, action: "test", input: { params: withConfidence({ tiers: [0.6, 0.75, 0.9, 0.9] }), case: { kind: "scored", scored: example("launch") } },
      reason: "看一下", caller: lead,
    });
    expect(again.result).toMatchObject({ reply: { ok: true }, calls: [] });
    const looser = withConfidence({ tiers: [0.6, 0.75, 0.9, 0.9] });
    await runUiAction(db, { target, action: "replay", input: { params: looser }, reason: "看一下", caller: lead, services });
    expect(replays).toEqual([{ before: CHANNEL_POLICY_DEFAULTS, after: looser }]);
    await expect(runUiAction(db, { target, action: "replay", input: { params: looser }, reason: "看一下", caller: lead }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(listStandingOrderVersions(db, "channel.authority")).toHaveLength(1);
  });
});

describe("a message to test", () => {
  it("is scored by request A and, with a draft, request B, and says which backend answered and how long it took", async () => {
    const model = scriptedSmartModel({ answers: { ask_kind: "knowledge", needs_reply: 0.93, grounded: 0.3 } });
    let clock = 1_000;
    const { scored, error, calls } = await scoreTestMessage({
      text: "退款超过 30 天还能走自动审批吗？", audience: "dm", sender: "colleague", draft: "不能，超过 30 天走人工。", assumeFound: true,
      model, candidates: [], userName: "我", businessMap: null, now: () => (clock += 400),
    });
    expect(error).toBeNull();
    expect(calls).toEqual([
      { request: "A", backend: model.backend, model: "jev-test", ms: 400, ok: true, error: null },
      { request: "B", backend: model.backend, model: null, ms: 400, ok: true, error: null },
    ]);
    expect(scored).toMatchObject({
      intent: { kind: "knowledge" }, found: "yes", scoredBy: "jev",
      scores: { needsReply: 0.93, grounded: 0.3 }, facts: { sources: { total: 1, verified: 1 } },
    });
    expect(model.count("channel_intake")).toBe(1);
    expect(model.count("channel_reply_check")).toBe(1);
    const asIs = await scoreTestMessage({
      text: "退款超过 30 天还能走自动审批吗？", audience: "dm", sender: "colleague", draft: "", assumeFound: false,
      model, candidates: [], userName: null, businessMap: null,
    });
    expect(asIs.scored).toMatchObject({ found: "not_needed", scores: { fulfills: null } });
    expect(judge(asIs.scored).reply.ok).toBe(false);
  });

  it("says why when there is no model to ask, and lists no call", async () => {
    const { scored, error, calls } = await scoreTestMessage({
      text: "在吗", audience: "dm", sender: "colleague", draft: "", assumeFound: false, model: null, candidates: [], userName: null, businessMap: null,
    });
    expect(scored.intent).toBeNull();
    expect(error).toContain("请求 A");
    expect(calls).toEqual([]);
  });
});
