// 回复决定（落地计划 A6，reply-decision.ts）：信心模型的结论写成卡上显示的形状（信心、门槛、校准、检查、否决项）。
// 结论只有三种：代你发、问你、交给你。approve 也问你：批准是 GitHub 工具自己的动作，通道不批准。
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_MODEL_DEFAULTS, channelReplyDecision, evaluateConfidenceModel, type ConfidenceModelInput,
} from "../src/index.js";

type Overrides = {
  intent?: ConfidenceModelInput["intent"];
  found?: ConfidenceModelInput["found"];
  scores?: Partial<ConfidenceModelInput["scores"]>;
  facts?: Partial<ConfidenceModelInput["facts"]>;
};

// 同事私信问一个配置值，查到了，两处出处都核实通过。
function decide(overrides: Overrides = {}) {
  const input: ConfidenceModelInput = {
    intent: overrides.intent ?? { kind: "knowledge", closing: null },
    draft: true,
    found: overrides.found ?? "yes",
    scores: {
      needsReply: 0.97, askConfidence: 0.95, fulfills: 0.96, grounded: 0.97, draftCommits: 0.03, draftOvershares: 0.04,
      topics: { money: 0.02, personnel: 0.02, legal: 0.02, emotional: 0.03 }, sensitiveQueries: { query_hr_compensation: 0.02 },
      ...overrides.scores,
    },
    facts: {
      audience: "dm", members: null, externalShared: false, senderTrust: "colleague", bot: false, scoredBy: "jev",
      retractable: true, canReply: true, sources: { total: 2, verified: 2 }, newerMessages: 0, resultAgeMs: 60_000, cardOpen: true,
      approval: null, ...overrides.facts,
    },
    calibration: { samples: 0, buckets: [] },
  };
  return channelReplyDecision(evaluateConfidenceModel(input));
}

describe("the reply decision shown on the card", () => {
  it("sends a confident answer, with every factor, the cost tier and the calibration on the card", () => {
    const result = decide();
    expect(result).toMatchObject({ decision: "auto_send", model: "auto_send", threshold: 0.6, vetoes: [] });
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.checks.map((check) => check.id)).toEqual(["needs_reply", "fulfills", "verified", "grounded", "understood", "corroborated", "cost"]);
    expect(result.checks.find((check) => check.id === "verified")).toMatchObject({ status: "pass", value: null });
    expect(result.checks.find((check) => check.id === "cost")).toMatchObject({ status: "pass", detail: expect.stringContaining("门槛 60%") });
    expect(result.calibration).toMatchObject({ samples: 0, minSamples: CONFIDENCE_MODEL_DEFAULTS.coldStartSamples });
  });

  it("hands over when nothing was found or the lookup failed", () => {
    expect(decide({ found: "no" }).decision).toBe("hand_over");
    expect(decide({ found: "failed" }).decision).toBe("hand_over");
  });

  it("asks you with the LLM fallback, and shows what blocked it", () => {
    const result = decide({ facts: { scoredBy: "fallback" } });
    expect(result.decision).toBe("ask_user");
    expect(result.vetoes).toContain("没有 Jev，分数是兜底的固定值");
  });

  it("asks you for a customer, with the floor as a failed check", () => {
    const result = decide({ facts: { senderTrust: "customer" } });
    expect(result.decision).toBe("ask_user");
    expect(result.vetoes).toContain("外部客户");
    expect(result.checks.find((check) => check.id === "lock_customer")).toMatchObject({ status: "fail" });
  });

  it("does not let a reported review count as a promise, but stops a promise in an answer", () => {
    const review = { kind: "code_review", closing: null } as const;
    expect(decide({ intent: review, scores: { draftCommits: 0.7 } }).decision).toBe("auto_send");
    const answer = decide({ scores: { draftCommits: 0.7 } });
    expect(answer.decision).toBe("ask_user");
    expect(answer.vetoes).toContain("替你承诺");
  });

  it("asks you instead of approving: the GitHub tool approves under its own rules", () => {
    const facts = { approval: { checksPassed: true, threadsResolved: true, isDraft: false, headUnchanged: true, blockingFindings: 0 } };
    const result = decide({ intent: { kind: "approve", closing: null }, facts });
    expect(result).toMatchObject({ decision: "ask_user", model: "approve" });
    expect(result.reasons.at(-1)).toContain("通道不批准");
  });
});
