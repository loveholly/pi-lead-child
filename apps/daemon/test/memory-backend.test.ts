import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { hindsightProgram, summaryModels } from "../src/memory-backend.js";

// Hindsight 的摘要模型（src/memory-backend.ts，spec D16）：缺省槽按 PLC_HINDSIGHT_LLM > 设置 > 最新的 haiku 选；整理观察槽按设置选，没选时跟缺省一样。

function configDir(): string {
  const dir = tempDir("plc-memory-backend-");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { vibeproxy: { api: "openai-completions", baseUrl: "http://127.0.0.1:8317/v1", discover: true, apiKey: { fromEnv: "VIBE_KEY" } } },
      models: ["vibeproxy/claude-sonnet-5-5"],
    },
  }));
  return dir;
}

// provider 的 /v1/models（OpenAI 兼容）。
const discovered = (ids: string[]): typeof fetch => (async () =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as typeof fetch;

const VIBE = { provider: "vibeproxy", baseUrl: "http://127.0.0.1:8317/v1" };

describe("summaryModels", () => {
  // 实测 vibeproxy discover 出来的顺序里，旧的 haiku 排在新的前面。
  it("picks the newest haiku model the Lead providers offer, discovered models included, and the consolidation slot follows it", async () => {
    const models = await summaryModels(configDir(), {}, {}, discovered([
      "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-3-5-haiku-20241022", "gpt-6-luna",
    ]));
    expect(models.default).toEqual({
      slot: "default", spec: "vibeproxy/claude-haiku-5-5", source: "auto", setting: null, problem: null,
      llm: { ...VIBE, model: "claude-haiku-5-5", apiKey: null },
    });
    expect(models.consolidation).toMatchObject({ source: "inherit", spec: "vibeproxy/claude-haiku-5-5", setting: null, llm: models.default.llm });
  });

  it("uses the settings, with the provider's key resolved in the daemon", async () => {
    // 地址和 key 在 daemon 里解析好（key 进 secrets.sealed），hindsight-main 不读 config.json 和 Keychain。
    const models = await summaryModels(configDir(), { default: "vibeproxy/gemini-3.5-flash-lite", consolidation: "vibeproxy/claude-sonnet-5-5" },
      { VIBE_KEY: "vibe-secret" }, discovered([]));
    expect(models.default).toMatchObject({ source: "settings", spec: "vibeproxy/gemini-3.5-flash-lite", llm: { ...VIBE, model: "gemini-3.5-flash-lite", apiKey: "vibe-secret" } });
    expect(models.consolidation).toMatchObject({ source: "settings", spec: "vibeproxy/claude-sonnet-5-5", llm: { model: "claude-sonnet-5-5", apiKey: "vibe-secret" } });
  });

  it("lets PLC_HINDSIGHT_LLM win over the settings and says so; a provider the Lead does not have falls through with the reason", async () => {
    const env = await summaryModels(configDir(), { default: "vibeproxy/claude-haiku-5-5" }, { PLC_HINDSIGHT_LLM: "vibeproxy/gemini-3.5-flash-lite" }, discovered([]));
    expect(env.default).toMatchObject({ source: "env", spec: "vibeproxy/gemini-3.5-flash-lite", setting: "vibeproxy/claude-haiku-5-5", problem: expect.stringMatching(/PLC_HINDSIGHT_LLM 盖住了/) });
    const broken = await summaryModels(configDir(), { consolidation: "openrouter/opus" }, { PLC_HINDSIGHT_LLM: "openrouter/haiku" }, discovered(["claude-haiku-5-5"]));
    expect(broken.default).toMatchObject({ source: "auto", spec: "vibeproxy/claude-haiku-5-5", problem: expect.stringMatching(/PLC_HINDSIGHT_LLM=openrouter\/haiku：服务商 openrouter 不在/) });
    expect(broken.consolidation).toMatchObject({ source: "inherit", setting: "openrouter/opus", problem: expect.stringMatching(/服务商 openrouter 不在/) });
  });

  it("has no model when no haiku model is available, so Hindsight runs recall-only", async () => {
    const models = await summaryModels(configDir(), {}, {}, discovered(["claude-sonnet-5-5"]));
    expect(models.default).toMatchObject({ source: "none", spec: null, llm: null });
    expect(models.consolidation).toMatchObject({ source: "none", llm: null });
  });
});

describe("hindsightProgram", () => {
  it("runs the source through tsx in PLC_DEV", () => {
    const args = hindsightProgram({ PLC_DEV: "1" });
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toMatch(/tsx\/dist\/cli\.mjs$/);
    expect(args[2]).toMatch(/apps\/daemon\/src\/hindsight-main\.ts$/);
  });
});
