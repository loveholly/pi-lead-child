// Lead 会话的压缩参数（compaction-settings.ts）。
// 2026-10-17 和 2026-10-28：pi 缺省的 reserveTokens（16384）让摘要最多 13107 token。Lead 的摘要每次压缩都并进上一份，
// 从 7 月的 5 千字长到 10 月的 2.2 万–2.7 万字，写到上限就算压缩失败，上下文涨到模型答不出话。
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  applyLeadCompactionReserve, isSummaryTokenCapError, LEAD_COMPACTION_BUDGETS, LEAD_COMPACTION_RESERVE_TOKENS, leadCompactionInstructions,
} from "../src/compaction-settings.js";

describe("the Lead's compaction reserve", () => {
  it("lets the summary use the model's whole output budget when nobody set a reserve", () => {
    const settings = SettingsManager.inMemory({});
    expect(settings.getCompactionSettings().reserveTokens).toBe(16_384);
    expect(applyLeadCompactionReserve(settings, {})).toBe(LEAD_COMPACTION_RESERVE_TOKENS);
    expect(settings.getCompactionSettings().reserveTokens).toBe(20_480);
    // 摘要的上限是 min(0.8 × reserveTokens, 模型的 maxTokens)：正好是 Lead 模型的 maxTokens 缺省值（model-config.ts）。
    expect(Math.floor(0.8 * LEAD_COMPACTION_RESERVE_TOKENS)).toBe(16_384);
  });

  it("keeps a reserve the user wrote in pi's settings", () => {
    const settings = SettingsManager.inMemory({ compaction: { reserveTokens: 8_000 } });
    expect(applyLeadCompactionReserve(settings, {})).toBeNull();
    expect(settings.getCompactionSettings().reserveTokens).toBe(8_000);
  });

  it("reads PLC_LEAD_COMPACTION_RESERVE_TOKENS and ignores a value that is not a positive integer", () => {
    const settings = SettingsManager.inMemory({});
    expect(applyLeadCompactionReserve(settings, { PLC_LEAD_COMPACTION_RESERVE_TOKENS: "30000" })).toBe(30_000);
    expect(settings.getCompactionSettings().reserveTokens).toBe(30_000);
    expect(applyLeadCompactionReserve(SettingsManager.inMemory({}), { PLC_LEAD_COMPACTION_RESERVE_TOKENS: "lots" }))
      .toBe(LEAD_COMPACTION_RESERVE_TOKENS);
  });

  // daemon 在 Lead 空闲时重新加载扩展（session.reload），pi 那时重读设置文件，内存里的覆盖就没了。
  it("has to be applied again after pi reloads its settings", async () => {
    const settings = SettingsManager.inMemory({});
    applyLeadCompactionReserve(settings, {});
    await settings.reload();
    expect(settings.getCompactionSettings().reserveTokens).toBe(16_384);
    applyLeadCompactionReserve(settings, {});
    expect(settings.getCompactionSettings().reserveTokens).toBe(20_480);
  });
});

describe("the length budget of a compaction the daemon runs", () => {
  it("asks for a short summary, and a stricter one for the second try", () => {
    const normal = leadCompactionInstructions("normal");
    const strict = leadCompactionInstructions("strict");
    expect(normal).toContain(`${LEAD_COMPACTION_BUDGETS.normal} 字`);
    expect(strict).toContain(`${LEAD_COMPACTION_BUDGETS.strict} 字`);
    expect(strict).toContain("更严");
    expect(LEAD_COMPACTION_BUDGETS.strict).toBeLessThan(LEAD_COMPACTION_BUDGETS.normal);
    // 上一份摘要也要按这个标准删：摘要变长的原因就是每次都原样并进上一份。
    expect(normal).toContain("上一份摘要");
  });

  it("knows the error pi gives when the summary hits the token cap", () => {
    expect(isSummaryTokenCapError("Summarization failed: generation hit the token cap and the summary is incomplete")).toBe(true);
    expect(isSummaryTokenCapError("Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete"))
      .toBe(true);
    expect(isSummaryTokenCapError("Auto-compaction failed: 503 upstream connect error")).toBe(false);
  });
});
