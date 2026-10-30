// token 的粗略估算：中日韩文字每个字 1 个 token，其他字符每 4 个 1 个 token，向上取整。按码位计数。
import { describe, expect, it } from "vitest";
import { alignToCodePoint, estimateTokens, isCjkCodePoint, tokenSliceEnd } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("counts four other characters as one token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(12_000))).toBe(3_000);
  });

  it("counts each Chinese, Japanese or Korean character, and full-width punctuation, as one token", () => {
    expect(estimateTokens("连接工具的结果")).toBe(7);
    expect(estimateTokens("，。、「」：！")).toBe(7);           // 全角标点
    expect(estimateTokens("ひらがなカタカナ")).toBe(8);         // 平假名、片假名
    expect(estimateTokens("ｶﾀｶﾅ")).toBe(4);                    // 半角片假名
    expect(estimateTokens("한국어")).toBe(3);                    // 韩文音节
    expect(estimateTokens("㐀豈")).toBe(2);                      // 扩展 A、兼容表意文字
  });

  it("adds the two kinds for mixed text", () => {
    // 4 个汉字 + "GitHub issue #66"（16 个其他字符，4 个 token）
    expect(estimateTokens("修复了GitHub issue #66。")).toBe(4 + 4);
    expect(estimateTokens("a中b")).toBe(1 + 1);
  });

  it("counts a surrogate pair as one character", () => {
    // emoji 是其他字符：4 个 emoji 是 8 个 UTF-16 单元，算 1 个 token。
    expect("😀😀😀😀".length).toBe(8);
    expect(estimateTokens("😀😀😀😀")).toBe(1);
    expect(estimateTokens("😀😀😀😀😀")).toBe(2);
    // 扩展 B 的汉字也是代理对，算 1 个 token，不是 2 个。
    expect("𠀀𪚥".length).toBe(4);
    expect(estimateTokens("𠀀𪚥")).toBe(2);
    expect(isCjkCodePoint("𠀀".codePointAt(0)!)).toBe(true);
    expect(isCjkCodePoint("😀".codePointAt(0)!)).toBe(false);
  });
});

describe("tokenSliceEnd", () => {
  it("ends English text after four characters per token and Chinese text after one", () => {
    const english = "x".repeat(10_000);
    const chinese = "汉".repeat(10_000);
    expect(tokenSliceEnd(english, 0, 1_000)).toBe(4_000);
    expect(tokenSliceEnd(chinese, 0, 1_000)).toBe(1_000);
    expect(tokenSliceEnd(english, 4_000, 1_000)).toBe(8_000);
    expect(tokenSliceEnd(chinese, 9_500, 1_000)).toBe(10_000);
  });

  it("takes the longest piece within the budget for mixed text", () => {
    const text = "中文abc".repeat(1_000);
    for (const budget of [1, 7, 100, 333]) {
      const end = tokenSliceEnd(text, 0, budget);
      expect(estimateTokens(text.slice(0, end))).toBeLessThanOrEqual(budget);
      expect(estimateTokens(text.slice(0, end + 1))).toBeGreaterThan(budget);
    }
  });

  it("never ends inside a surrogate pair", () => {
    const emoji = "😀".repeat(100);
    for (const budget of [1, 2, 3, 10]) {
      const end = tokenSliceEnd(emoji, 0, budget);
      expect(end % 2).toBe(0);
      expect(end).toBe(budget * 8);
    }
    const han = "𠀀".repeat(100);
    expect(tokenSliceEnd(han, 0, 3)).toBe(6);
    // 起点落在代理对的后半个上时，从这个字的开头算。
    expect(tokenSliceEnd(han, 1, 3)).toBe(6);
  });

  it("moves an index inside a surrogate pair to the start of the pair", () => {
    expect(alignToCodePoint("a😀b", 2)).toBe(1);
    expect(alignToCodePoint("a😀b", 1)).toBe(1);
    expect(alignToCodePoint("a😀b", 3)).toBe(3);
    expect(alignToCodePoint("a😀b", 99)).toBe(4);
  });
});
