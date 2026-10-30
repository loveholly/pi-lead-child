// 外观偏好的纯函数（2026-10-22）：对比度、同色系推导、请求整理和校验。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_PREFERENCES, applyDesignPreferencesRequest, contrastRatio, darkenToContrast, designPreferencesFields,
  designPreferencesProblem, normalizeDesignPreferencesRequest, sameDesignPreferences, shiftLike,
} from "../src/design-preferences.ts";

describe("contrast", () => {
  it("matches WCAG for black, white and the default accent", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
    // tokens.ts 里说明过：#2F6AFF 在白底上刚过 4.5:1。
    expect(contrastRatio("#2F6AFF", "#FFFFFF")).toBeGreaterThan(4.5);
    expect(contrastRatio("#F79009", "#FFFFFF")).toBeLessThan(3);
  });

  it("darkens a light color until it reads on white", () => {
    const dark = darkenToContrast("#9DB8FF", 4.5);
    expect(contrastRatio(dark, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(darkenToContrast("#1E51D6", 4.5)).toBe("#1E51D6");
  });
});

describe("shiftLike", () => {
  it("keeps a light variant light and a dark variant dark on a new base", () => {
    const soft = shiftLike("#2F6AFF", "#EAF0FF", "#12B76A");
    const strong = shiftLike("#2F6AFF", "#1E51D6", "#12B76A");
    expect(contrastRatio(soft, "#FFFFFF")).toBeLessThan(1.3);
    expect(contrastRatio(strong, "#FFFFFF")).toBeGreaterThan(contrastRatio("#12B76A", "#FFFFFF"));
  });

  it("returns the default variant for the default base", () => {
    expect(shiftLike("#2F6AFF", "#EAF0FF", "#2F6AFF")).toBe("#EAF0FF");
  });
});

describe("requests", () => {
  it("normalizes colors and notes and keeps only the given keys", () => {
    expect(normalizeDesignPreferencesRequest({ colors: { accent: " #1e51d6 " }, density: { ticket: "standard" }, notes: "  a\r\nb " }))
      .toEqual({ colors: { accent: "#1E51D6" }, density: { ticket: "standard" }, notes: "a\nb" });
  });

  it("merges a partial request onto the current values", () => {
    const current = designPreferencesFields(DEFAULT_DESIGN_PREFERENCES);
    const next = applyDesignPreferencesRequest(current, { density: { conversation: "comfortable" }, colors: { danger: "#B42318" } });
    expect(next.density).toEqual({ ...current.density, conversation: "comfortable" });
    expect(next.colors).toEqual({ ...current.colors, danger: "#B42318" });
    expect(sameDesignPreferences(current, next)).toBe(false);
    expect(sameDesignPreferences(current, applyDesignPreferencesRequest(current, {}))).toBe(true);
  });

  it("explains what is wrong in one sentence", () => {
    expect(designPreferencesProblem({})).toBe("没有要改的内容");
    expect(designPreferencesProblem({ colors: { accent: "#9DB8FF" } })).toContain("主色太浅");
    expect(designPreferencesProblem({ colors: { success: "#C8F5DC" } })).toContain("成功色太浅");
    expect(designPreferencesProblem({ colors: { info: "#06AED4" } })).toBeNull();
    expect(designPreferencesProblem({ notes: "x".repeat(1_201) })).toContain("最多");
  });
});
