// 代价信号（.scratch/lead-self-routing/spec.md C）：Lead 判断就地做还是派轻子 agent 时看得到的数。都是信息，不拦任何调用。
// 2026-10-28：Lead 的上下文已经约 48 万 token，它不知道；它把 PR #119 的全部文件读进来核对行号，上下文超过了压缩线。
import { describe, expect, it } from "vitest";
import {
  contextUsageLine, costSignalsExtension, estimateTextTokens, formatTokenCount, leadContextUsage,
} from "../src/cost-signals.js";

describe("the numbers Lead reads", () => {
  it("writes token counts the way people read them", () => {
    expect(formatTokenCount(452_000)).toBe("45.2 万");
    expect(formatTokenCount(500_000)).toBe("50 万");
    expect(formatTokenCount(8_000)).toBe("8000");
  });

  it("counts a Chinese character as about one token and other text as about four characters a token", () => {
    expect(estimateTextTokens("x".repeat(4_000))).toBe(1_000);
    expect(estimateTextTokens("上下文".repeat(100))).toBe(300);
  });

  it("says how full the context is and where it compacts", () => {
    expect(contextUsageLine({ tokens: 452_000, window: 500_000, compactAt: 479_520 }))
      .toBe("你的上下文：约 45.2 万 / 50 万 token（90%），约 48 万时自动压缩。");
    expect(contextUsageLine({ tokens: 30_000, window: 500_000, compactAt: null })).toBe("你的上下文：约 3 万 / 50 万 token（6%）。");
  });

  it("reads the usage of the last answer from the session, like pi does", () => {
    const session = {
      model: { contextWindow: 500_000 },
      agent: { state: { messages: [
        { role: "assistant", usage: { input: 4, output: 100, cacheRead: 300_000, cacheWrite: 1_000 } },
        { role: "toolResult", content: [] },
      ] } },
    };
    expect(leadContextUsage(session, 20_480)).toEqual({ tokens: 301_104, window: 500_000, compactAt: 479_520 });
    expect(leadContextUsage({}, 20_480)).toBeNull();
  });
});

describe("a large tool result", () => {
  function handler(threshold = 8_000) {
    let registered: ((event: any, ctx: any) => unknown) | null = null;
    costSignalsExtension({ thresholdTokens: threshold, compactAt: (window) => window - 20_480 })({
      on(name: string, fn: any) { if (name === "tool_result") registered = fn; },
    } as never);
    return registered!;
  }
  const ctx = { getContextUsage: () => ({ tokens: 400_000, contextWindow: 500_000, percent: 80 }) };
  const result = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "tool_result", toolCallId: "t1", input: {}, content: [{ type: "text", text }], isError: false, ...extra,
  });

  it("gets a footnote with its size and how full the context will be", async () => {
    const changed = await handler()(result("x".repeat(40_000)), ctx) as { content: Array<{ type: string; text: string }> };
    expect(changed.content).toHaveLength(2);
    expect(changed.content[0]!.text).toBe("x".repeat(40_000));
    expect(changed.content[1]!.text).toBe("（这个结果约 1 万 token。你的上下文现在约 41 万 / 50 万 token（82%），约 48 万时自动压缩。）");
  });

  it("is left alone when it is small, when a codemode script made the call, or when the usage is unknown", async () => {
    expect(await handler()(result("x".repeat(4_000)), ctx)).toBeUndefined();
    expect(await handler()(result("x".repeat(40_000), { parentToolCallId: "p1" }), ctx)).toBeUndefined();
    const footnote = await handler()(result("x".repeat(40_000)), { getContextUsage: () => undefined }) as { content: Array<{ text: string }> };
    expect(footnote.content[1]!.text).toBe("（这个结果约 1 万 token。）");
  });
});
