// 校准（落地计划 D2，design.md 第 8 节）的判断边界：标签的权重、等卡结束以后按你在来源里的做法定标签、抽查。
// 纯函数；hub 里的整条链路（打分 → 你的做法 → 标签 → 下一次打分用上校准）在 channel-lead.test.ts。
import { describe, expect, it } from "vitest";
import {
  auditsReply, calibrationFromLabels, settledReplyLabel, CHANNEL_REPLY_LABEL_RULES, CONFIDENCE_MODEL_DEFAULTS, evaluateConfidenceModel,
  type ConfidenceModelInput, type ReplySampleFacts,
} from "../src/index.js";

const MINUTE = 60_000;

describe("labels", () => {
  it("weighs what you did: sent 1, kept an auto reply 0.5, wrote your own 1, retracted 3; doing nothing does not grade the draft", () => {
    expect(Object.fromEntries(Object.entries(CHANNEL_REPLY_LABEL_RULES).map(([label, rule]) => [label, [rule.value, rule.weight]]))).toEqual({
      sent_as_is: [1, 1], auto_kept: [1, 0.5], rewritten: [0, 1], retracted: [0, 3], no_action: [null, 1],
    });
  });

  it("adds the samples per score bucket across tasks, by weight", () => {
    const rule = (label: keyof typeof CHANNEL_REPLY_LABEL_RULES, bucket: number) => ({ bucket, ...CHANNEL_REPLY_LABEL_RULES[label] });
    const calibration = calibrationFromLabels([
      rule("sent_as_is", 0.7), rule("auto_kept", 0.79), rule("retracted", 0.7), rule("rewritten", 0.4),
      // 什么都没做：这条消息不用回，不校准草稿。
      rule("no_action", 0.7),
    ]);
    expect(calibration).toEqual({
      samples: 5.5,
      buckets: [{ bucket: 0.4, samples: 1, agreed: 0 }, { bucket: 0.7, samples: 4.5, agreed: 1.5 }],
    });
  });

  it("pulls the confidence of a bucket toward what you actually did", () => {
    const input: ConfidenceModelInput = {
      intent: { kind: "knowledge", closing: null }, draft: true, found: "yes",
      scores: {
        needsReply: 0.9, askConfidence: 0.95, fulfills: 0.9, grounded: 0.95, draftCommits: 0.02, draftOvershares: 0.02,
        topics: {}, sensitiveQueries: {},
      },
      facts: {
        audience: "dm", members: null, externalShared: false, senderTrust: "colleague", bot: false, scoredBy: "jev", retractable: true,
        canReply: true, sources: { total: 1, verified: 1 }, newerMessages: 0, resultAgeMs: 0, cardOpen: true, approval: null,
      },
      calibration: { samples: 0, buckets: [] },
    };
    const cold = evaluateConfidenceModel(input, CONFIDENCE_MODEL_DEFAULTS);
    expect(cold.confidence).toBe(cold.raw);
    // 同一段里你撤回过两次自动回复：这一段的信心往下拉。
    const retracted = calibrationFromLabels([0, 1].map(() => ({ bucket: cold.raw!, ...CHANNEL_REPLY_LABEL_RULES.retracted })));
    const warm = evaluateConfidenceModel({ ...input, calibration: retracted }, CONFIDENCE_MODEL_DEFAULTS);
    expect(warm.calibration).toMatchObject({ samples: 6, agreed: 0 });
    expect(warm.confidence).toBeCloseTo((10 * cold.raw!) / 16, 6);
  });
});

describe("a label once the card is over", () => {
  type Overrides = Partial<Omit<ReplySampleFacts, "card">> & { card?: Partial<ReplySampleFacts["card"]> };
  const facts = (overrides: Overrides = {}): ReplySampleFacts => ({
    decision: "ask_user", scoredAt: 0, selfReplies: 0, now: 0, settleMs: 30 * MINUTE,
    ...overrides,
    card: { open: false, autoReplied: false, revokeUntil: null, userSent: false, resolvedAt: 0, ...overrides.card },
  });

  it("keeps an auto reply once the revoke window passed, and waits while it is open", () => {
    const sent = { decision: "auto_send" as const, card: { autoReplied: true, revokeUntil: 10 * MINUTE } };
    expect(settledReplyLabel(facts({ ...sent, now: 9 * MINUTE }))).toBeNull();
    expect(settledReplyLabel(facts({ ...sent, now: 10 * MINUTE }))).toBe("auto_kept");
  });

  it("waits while the card is open", () => {
    expect(settledReplyLabel(facts({ card: { open: true }, now: 99 * MINUTE }))).toBeNull();
  });

  it("counts a reply you sent from the card that was not the scored draft as your own words", () => {
    expect(settledReplyLabel(facts({ card: { userSent: true } }))).toBe("rewritten");
  });

  it("looks at what you said in the source after the card closed: a reply is your own words, silence means no reply was needed", () => {
    const closed = { card: { resolvedAt: 5 * MINUTE } };
    // 卡结束以后还要等一会儿：你可能晚一点才在来源里回。
    expect(settledReplyLabel(facts({ ...closed, selfReplies: 1, now: 30 * MINUTE }))).toBeNull();
    expect(settledReplyLabel(facts({ ...closed, selfReplies: 1, now: 35 * MINUTE }))).toBe("rewritten");
    expect(settledReplyLabel(facts({ ...closed, selfReplies: 0, now: 35 * MINUTE }))).toBe("no_action");
  });
});

describe("the audit", () => {
  it("asks you for the given share of the drafts it would have sent, and never for the others", () => {
    expect(auditsReply("auto_send", 0.05, () => 0.049)).toBe(true);
    expect(auditsReply("auto_send", 0.05, () => 0.05)).toBe(false);
    expect(auditsReply("ask_user", 0.05, () => 0)).toBe(false);
    expect(auditsReply("auto_send", 0, () => 0)).toBe(false);
  });
});
