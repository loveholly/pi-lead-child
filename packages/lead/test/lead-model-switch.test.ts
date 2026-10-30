import { describe, expect, it } from "vitest";
import {
  isLeadModelSwitchStatus,
  leadModelSwitchStatusMessage,
  shouldFailEmptyLeadTurn,
} from "../src/model-switch.js";

describe("lead model switch settlement", () => {
  it("does not treat an empty turn as failure when a model switch is pending", () => {
    expect(shouldFailEmptyLeadTurn({ assistantText: "", pendingModelSwitch: true })).toBe(false);
    expect(shouldFailEmptyLeadTurn({ assistantText: "   ", pendingModelSwitch: true })).toBe(false);
  });

  it("still fails a genuinely empty Lead turn", () => {
    expect(shouldFailEmptyLeadTurn({ assistantText: "", pendingModelSwitch: false })).toBe(true);
  });

  // generative UI：只画了卡片、没写字的一轮也回答了用户（2026-10-15 预览发现）。
  it("keeps a turn that drew a card off the empty-failure path", () => {
    expect(shouldFailEmptyLeadTurn({ assistantText: "", pendingModelSwitch: false, drewSurface: true })).toBe(false);
  });

  it("keeps a spoken turn off the empty-failure path", () => {
    expect(shouldFailEmptyLeadTurn({
      assistantText: "好，切到 Sonnet 5。",
      pendingModelSwitch: true,
    })).toBe(false);
  });

  it("marks the host status as a system switching notice", () => {
    const text = leadModelSwitchStatusMessage(
      "vibeproxy/gemini-3.7-flash-high",
      "vibeproxy/claude-sonnet-5",
    );
    expect(isLeadModelSwitchStatus(text)).toBe(true);
    expect(text).toContain("vibeproxy/claude-sonnet-5");
    expect(isLeadModelSwitchStatus("Lead 未生成回复，请重试。")).toBe(false);
  });
});
