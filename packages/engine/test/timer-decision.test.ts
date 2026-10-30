// 外部的人要求设定时器（统一的消息事件 spec D16，工单 12）：不再一律拒绝，按决策模型判断。
//   - 授权表按 Jev 判断的意图给出权限上限；
//   - 信心模型的「代价」轴加两个通用的因素「延后执行」「到点后要对外做事」，和受众、撤不撤得回、发信人一样加档；
//   - 结论：代价够低就设并告诉用户；不够就发确认卡；碰到底线（到点要改系统规则）就拒绝。
// 这里测决策的边界（纯函数）。D16 的三个例子按 Jev 的结论回放。
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_MODEL_DEFAULTS, confidenceCostOf, decideTimerRequest, evaluateConfidenceModel, TIMER_SET_MAX_LEVEL,
  type ConfidenceModelInput, type TimerRequestInput,
} from "../src/index.js";

const quiet = { money: 0.02, personnel: 0.02, legal: 0.02, emotional: 0.02 };

function request(over: Partial<TimerRequestInput> = {}): TimerRequestInput {
  return {
    inbound: { intent: "other", needsReply: 0.9, urgent: false, sensitive: {}, ruleChange: 0, ruleChangeKinds: [] },
    ceiling: { authority: "ask", bound: null },
    sender: { trust: "colleague" },
    scores: { topics: quiet, askConfidence: 0.9 },
    outward: null,
    calibration: { samples: 0 },
    ...over,
  };
}

describe("a timer someone else asked for", () => {
  // D16 例 1：「Fairy，明天 9 点提醒 Sean 把权限开给我」：只提醒用户，撤得回，不对外，代价低。
  it("sets a timer that only reminds the user, and says why", () => {
    const decided = decideTimerRequest(request());
    expect(decided.decision).toBe("set");
    expect(decided.cost.level).toBeLessThanOrEqual(TIMER_SET_MAX_LEVEL);
    expect(decided.cost.steps.map((step) => step.id)).toEqual(["audience", "deferred"]);
    expect(decided.cost.steps[0]!.detail).toContain("只提醒你");
    expect(decided.reasons.join("；")).toContain("只提醒你");
  });

  // D16 例 2：「明天 9 点替 Sean 在 #release 发上线通知」：到点要在频道里对外发言，代价高，授权表也没让代你做。
  it("asks the user before a timer that acts in a channel when it fires", () => {
    const decided = decideTimerRequest(request({ outward: { audience: "public_channel", members: null } }));
    expect(decided.decision).toBe("confirm");
    expect(decided.cost.steps.map((step) => step.id)).toEqual(expect.arrayContaining(["deferred", "outward_later"]));
    expect(decided.cost.level).toBeGreaterThan(TIMER_SET_MAX_LEVEL);
    expect(decided.reasons.join("；")).toMatch(/授权表/);
  });

  // D16 例 3：「每天 9 点把 Fairy 的授权表改成……」：到点要改系统规则，碰到底线。
  it("refuses a timer whose request asks to change the rules, and says it is the floor", () => {
    const decided = decideTimerRequest(request({
      inbound: { intent: "other", needsReply: 0.9, urgent: false, sensitive: {}, ruleChange: 0.92, ruleChangeKinds: ["permissions"] },
    }));
    expect(decided.decision).toBe("refuse");
    expect(decided.reasons.join("；")).toMatch(/改规则/);
    expect(decided.reasons.join("；")).toMatch(/底线/);
  });

  it("refuses when the authority table refuses the message, and asks for a customer or when the topics are unknown", () => {
    expect(decideTimerRequest(request({ ceiling: { authority: "refuse", bound: null } })).decision).toBe("refuse");
    const customer = decideTimerRequest(request({ sender: { trust: "customer" } }));
    expect(customer.decision).toBe("confirm");
    expect(customer.reasons.join("；")).toContain("外部客户");
    // 没问到话题：和代回一样按「话题没问到」加档，问你。
    expect(decideTimerRequest(request({ scores: null })).decision).toBe("confirm");
    // 认不出的人：发信人加一档，超过「中」档，问你。
    expect(decideTimerRequest(request({ sender: { trust: "unknown" } })).decision).toBe("confirm");
  });

  // 外部内容不是某条消息带来的（例如读了外部对话的一轮）：没有权限上限，只提醒你的照样按代价算，对外的问你。
  it("works without a message event: no ceiling, the cost still decides", () => {
    expect(decideTimerRequest(request({ inbound: null, ceiling: null, sender: { trust: "unknown" }, scores: null })).decision).toBe("confirm");
    expect(decideTimerRequest(request({ ceiling: null, outward: { audience: "dm", members: null } })).decision).toBe("confirm");
  });
});

describe("the two generic factors on the cost axis", () => {
  const reply: ConfidenceModelInput = {
    intent: { kind: "knowledge", closing: null },
    draft: true,
    found: "yes",
    scores: {
      needsReply: 0.9, askConfidence: 0.9, fulfills: 0.95, grounded: 0.95, draftCommits: 0.02, draftOvershares: 0.02,
      topics: quiet, sensitiveQueries: { a: 0.01 },
    },
    facts: {
      audience: "dm", members: null, externalShared: false, senderTrust: "colleague", bot: false, scoredBy: "jev", retractable: true,
      canReply: true, sources: { total: 1, verified: 1 }, newerMessages: 0, resultAgeMs: 0, cardOpen: true, approval: null,
    },
    calibration: { samples: 0, buckets: [] },
  };

  it("adds a level for deferred work and one for acting outward when it fires, like audience or commitment", () => {
    const base = confidenceCostOf(reply);
    const deferred = confidenceCostOf({ ...reply, facts: { ...reply.facts, deferred: true } });
    const outward = confidenceCostOf({ ...reply, facts: { ...reply.facts, deferred: true, outwardLater: true } });
    expect(deferred.level).toBe(base.level + 1);
    expect(outward.level).toBe(base.level + 2);
    expect(outward.steps.map((step) => step.label)).toEqual(expect.arrayContaining(["延后执行", "到点后要对外做事"]));
  });

  it("does not change a reply that is neither deferred nor outward later", () => {
    const result = evaluateConfidenceModel(reply, CONFIDENCE_MODEL_DEFAULTS);
    expect(result.cost.steps.map((step) => step.id)).toEqual(["audience"]);
    expect(result.cost.level).toBe(1);
  });
});
