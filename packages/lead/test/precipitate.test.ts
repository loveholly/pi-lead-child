import { describe, it, expect } from "vitest";
import { contextUsageRatio, PRECIPITATE_PROMPT } from "../src/precipitate.js";
import { createLeadTools } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadSkillText } from "./lead-skill-text.js";
import { setModelCatalogForTesting } from "@pi-lead-child/engine";

describe("contextUsageRatio", () => {
  it("computes from last assistant usage vs context window", () => {
    const session = {
      model: { contextWindow: 100_000 },
      agent: { state: { messages: [
        { role: "user", content: "q" },
        { role: "assistant", usage: { input: 60_000, output: 5_000, cacheRead: 5_000 } },
        { role: "toolResult" },
      ] } },
    };
    expect(contextUsageRatio(session)).toBeCloseTo(0.7);
  });

  it("returns null when model/messages unavailable (stub sessions)", () => {
    expect(contextUsageRatio({})).toBeNull();
    expect(contextUsageRatio({ model: { contextWindow: 1000 }, agent: { state: { messages: [] } } })).toBeNull();
  });

  it("prompt instructs save_note and excludes ticket facts", () => {
    expect(PRECIPITATE_PROMPT).toContain("save_note");
    expect(PRECIPITATE_PROMPT).toContain("账本是事实源");
  });

  it("沉淀提示词包含画像/偏好检查项与 kind 指引", () => {
    expect(PRECIPITATE_PROMPT).toContain("profile");
    expect(PRECIPITATE_PROMPT).toContain("preference");
    expect(PRECIPITATE_PROMPT).toContain("画像");
    // 别人说的关于用户的话不进画像和偏好（用户 2026-10-27）。
    expect(PRECIPITATE_PROMPT).toContain("别人（例如 Slack 里的同事）说的关于用户的话，记成 kind='fact'，并写明是谁说的");
  });

  it("纪律 10 锚点：召回纪律与 kind 分类指引未被静默回归", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("search_notes 再回答");
    expect(LEAD_SYSTEM_PROMPT).toContain("工作沉淀结论=note");
    // 选型的做法 2026-10-28 拆进 skill ticket-planning。
    expect(leadSkillText("ticket-planning")).toContain("不会默认落到 Pi");
  });
});

describe("model selection menu", () => {
  // 2026-10-15：菜单不再写死模型（写死的 gpt-5.5 账号已经不支持，工单 #66）。菜单是本机模型目录的摘要。
  it("spawn_child description carries the discovered model catalog, not a hardcoded menu", () => {
    setModelCatalogForTesting({
      refreshedAt: "2026-10-15T02:00:00.000Z",
      runtimes: [{
        runtime: "codex", state: "known", source: "codex debug models", account: "Codex 内置的订阅账号",
        freeformModelPattern: null, refreshedAt: "2026-10-15T02:00:00.000Z", error: null, cliDefaultModel: "gpt-6.1-sol",
        efforts: ["low", "high"], models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "high"], defaultEffort: null, note: null }],
      }],
    });
    const tools = createLeadTools({ db: {} as any, dbPath: "", dataDir: "" });
    const spawn = tools.find((t: any) => t.name === "spawn_child") as any;
    setModelCatalogForTesting(null);
    expect(spawn.description).toContain("gpt-6.1-sol（CLI 默认，effort low/high）");
    expect(spawn.description).not.toContain("gpt-5.4-mini");
    expect(spawn.description).not.toContain("gpt-5.5（缺省）");
    expect(spawn.description).toContain("get_model_catalog");
    expect(spawn.description).toContain("本机 child runtime 目录");
    expect(spawn.description).toContain("不会默认落到 Pi");
  });
});
