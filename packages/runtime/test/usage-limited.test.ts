// 用量额度用完、在等重置（2026-10-19）。Run #111（pi 经 vibeproxy 调 claude-opus-4-6-thinking）的 429 以前被分成 unknown：
// 健康账本不知道这个模型在冷却，suggest_route 也就不会排除它。现在它是 usage_limited：只记在这个模型上，不通知用户充值，
// 报错里的重置时间决定下一次重检。
import { describe, expect, it } from "vitest";
import {
  classifyClaudeFailure, classifyPiFailure, failureCategory, healthIncidentNextStep, healthLevel, runtimeFailureTitle,
  sameTargetRetry, typedFailure, usageResetAt, usageResetUnknown,
} from "../src/index.js";

// Run #111 的 error_message 开头（plc.db，2026-10-19），转义照原样。
const RUN_111 = '429: {"code":"model_cooldown","last_upstream_error":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    '
  + '\\"message\\": \\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 162h16m36s.\\",\\n    '
  + '\\"status\\": \\"RESOURCE_EXHAUSTED\\"';

describe("usage_limited", () => {
  it("classifies Run #111's quota error as a model-level usage limit that does not ask the user to pay", () => {
    const failure = classifyPiFailure({ errorCode: "llm_error", message: RUN_111 });
    expect(failure).toMatchObject({ code: "usage_limited", scope: "account", needs: "none" });
    expect(healthLevel(failure)).toBe("model");
    // 自己的类别（2026-10-19 发布评审）：和充值共用 account_quota 时，App 写的是「账号余额不足」。
    expect(failureCategory(failure)).toBe("usage_limit");
    expect(runtimeFailureTitle("pi", failure)).toContain("额度用完");
    expect(healthIncidentNextStep("pi", failure)).not.toContain("需要给");
  });

  it("classifies Claude Code's usage-limit messages", () => {
    for (const message of ["You've hit your limit · resets 3pm (Asia/Shanghai)", "Claude AI usage limit reached|1792414800"]) {
      expect(classifyClaudeFailure({ errorCode: "claude_error_during_execution", message }).code).toBe("usage_limited");
    }
  });

  it("reads the reset time from the evidence", () => {
    const at = new Date("2026-10-19T05:00:00.000Z");
    expect(usageResetAt(RUN_111, at)?.toISOString()).toBe("2026-10-25T23:16:36.000Z");
    expect(usageResetAt('{\\"resetsAt\\":1792414800}', new Date("2026-10-19T00:00:00Z"))?.toISOString())
      .toBe(new Date(1792414800 * 1000).toISOString());
    expect(usageResetAt("Usage limit reached", at)).toBeNull();
    // 已经过去的、或者远得不像真的（多半读错了）的时间不认。
    expect(usageResetAt('"resets_at":"2026-10-18T00:00:00Z"', at)).toBeNull();
    expect(usageResetAt("resets in 900h", at)).toBeNull();
  });
});

// 工单 #117 的 Run 151–155（2026-10-29）：Claude Code 的周额度用完，报错只写了「resets Oct 26 at 4pm」，系统认不出这个时间。
// 内核在同一个用完的模型上排了重试；看不到额度的探针 60 秒后就通过，重试被放出去，又失败，连着五次。
const RUN_151 = "You've hit your weekly limit · resets Oct 26 at 4pm";

describe("the kernel retry on the same model after a ledger failure", () => {
  const at = new Date("2026-10-19T05:00:00.000Z");

  it("is not queued for a usage limit whose evidence names no reset time", () => {
    const failure = classifyClaudeFailure({ errorCode: "claude_result_error", message: RUN_151 });
    expect(failure.code).toBe("usage_limited");
    expect(sameTargetRetry(failure, at)).toEqual({ queue: false });
  });

  it("waits until the reset time when the evidence names one", () => {
    const failure = typedFailure("usage_limited", { errorCode: "llm_error", message: "Usage limit reached. Resets in 2h" });
    expect(sameTargetRetry(failure, at)).toEqual({ queue: true, notBefore: new Date("2026-10-19T07:00:00.000Z") });
  });

  it.each(["out_of_credits", "auth_required", "model_unsupported", "executable_missing"] as const)(
    "is queued as before for %s, which waits for the incident to close",
    (code) => {
      expect(sameTargetRetry(typedFailure(code, { errorCode: code, message: code }), at)).toEqual({ queue: true, notBefore: null });
    },
  );
});

describe("a usage limit that a probe cannot judge", () => {
  const at = new Date("2026-10-19T05:00:00.000Z");

  it("is a usage limit without a reset time", () => {
    expect(usageResetUnknown(classifyClaudeFailure({ errorCode: "claude_result_error", message: RUN_151 }), at)).toBe(true);
    expect(usageResetUnknown(typedFailure("usage_limited", { errorCode: "x", message: RUN_111 }), at)).toBe(false);
    expect(usageResetUnknown(typedFailure("out_of_credits", { errorCode: "x", message: "out of credits" }), at)).toBe(false);
  });
});
