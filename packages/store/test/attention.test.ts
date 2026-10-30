import { describe, expect, it } from "vitest";
import {
  isHostOutcomeRegistrationDefect,
  isLeadInternalNextStep,
  presentUserFacingCheckpoint,
  stripDiagnosticStack,
  USER_SAFE_BLOCKED_NEXT_STEP,
} from "../src/attention.js";

describe("user-facing attention", () => {
  it("treats an illegal outcome envelope as a host registration defect", () => {
    expect(isHostOutcomeRegistrationDefect({
      errorCode: "unhandled_run_exception",
      errorMessage: "Error: outcome.validations[3].outcome is invalid\n    at normalizeValidations",
    })).toBe(true);
    expect(isHostOutcomeRegistrationDefect({
      blockerCode: "invalid_outcome_envelope",
    })).toBe(true);
    expect(isHostOutcomeRegistrationDefect({
      errorCode: "unhandled_run_exception",
      errorMessage: "event stream decoder exploded",
    })).toBe(false);
  });

  it("strips stacks and Lead-internal next steps from blocked cards", () => {
    expect(stripDiagnosticStack([
      "Error: outcome.validations[3].outcome is invalid",
      "    at normalizeValidations (src/store/outcomes.ts:211:48)",
      "    at normalizeOutcomePayload (src/store/outcomes.ts:249:24)",
    ].join("\n"))).toBe("Error: outcome.validations[3].outcome is invalid");
    expect(isLeadInternalNextStep("Lead 应检查本次 Run 的运行日志")).toBe(true);
    expect(isLeadInternalNextStep("请确认是否先修成果登记")).toBe(false);

    const presented = presentUserFacingCheckpoint({
      kind: "blocked",
      title: "Agent Run 未捕获异常",
      summary: "Run #54 crashed: Error: outcome.validations[3].outcome is invalid\n    at normalizeValidations",
      nextStep: "Lead 应检查本次 Run 的运行日志与失败证据，判断是否可安全重试。",
    });
    expect(presented).toEqual({
      title: "Agent Run 未捕获异常",
      summary: "Run #54 crashed: Error: outcome.validations[3].outcome is invalid",
      nextStep: USER_SAFE_BLOCKED_NEXT_STEP,
    });
  });
});
