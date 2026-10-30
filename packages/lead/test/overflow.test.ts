// 超预算转派（lead-tools-and-routing spec D7）：阈值和提醒的文字。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERFLOW_MS, DEFAULT_OVERFLOW_TOOL_CALLS, LEAD_OVERFLOW_MS_ENV, LEAD_OVERFLOW_TOOL_CALLS_ENV,
  overflowLimits, overflowReached, overflowReminder,
} from "../src/overflow.js";

describe("overflow limits", () => {
  it("defaults to 10 tool calls or 3 minutes, and reads positive overrides only", () => {
    expect(overflowLimits({})).toEqual({ toolCalls: DEFAULT_OVERFLOW_TOOL_CALLS, ms: DEFAULT_OVERFLOW_MS });
    expect(DEFAULT_OVERFLOW_TOOL_CALLS).toBe(10);
    expect(DEFAULT_OVERFLOW_MS).toBe(180_000);
    expect(overflowLimits({ [LEAD_OVERFLOW_TOOL_CALLS_ENV]: "4", [LEAD_OVERFLOW_MS_ENV]: "60000" })).toEqual({ toolCalls: 4, ms: 60_000 });
    expect(overflowLimits({ [LEAD_OVERFLOW_TOOL_CALLS_ENV]: "0", [LEAD_OVERFLOW_MS_ENV]: "abc" }))
      .toEqual({ toolCalls: DEFAULT_OVERFLOW_TOOL_CALLS, ms: DEFAULT_OVERFLOW_MS });
  });

  it("is reached by tool calls or by time, whichever comes first", () => {
    const limits = { toolCalls: 3, ms: 1_000 };
    expect(overflowReached({ toolCalls: 2, startedAt: 0 }, 500, limits)).toBeNull();
    expect(overflowReached({ toolCalls: 3, startedAt: 0 }, 500, limits)).toBe("tool_calls");
    expect(overflowReached({ toolCalls: 1, startedAt: 0 }, 1_000, limits)).toBe("duration");
  });

  it("asks Lead to hand the rest to a light sub-agent, without forcing a stop", () => {
    const text = overflowReminder({ toolCalls: 12, startedAt: 0 }, 60_000, "tool_calls");
    expect(text).toContain('kind="overflow"');
    expect(text).toContain("已经调用了 12 次工具");
    expect(text).toContain("light=true");
    expect(text).toContain("可以做完");
  });
});
