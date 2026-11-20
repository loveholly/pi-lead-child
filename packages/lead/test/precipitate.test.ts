import { createHash } from "node:crypto";
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

describe("dispatch tool definitions", () => {
  // 工单 #373：目录（模型、runtime 健康）不进工具定义。定义一变，整段请求的提示缓存作废（#371：14 次整段前缀没命中）。
  const catalogOf = (model: string) => ({
    refreshedAt: "2026-10-15T02:00:00.000Z",
    runtimes: [{
      runtime: "codex" as const, state: "known" as const, source: "codex debug models", account: "Codex 内置的订阅账号",
      freeformModelPattern: null, refreshedAt: "2026-10-15T02:00:00.000Z", error: null, cliDefaultModel: model,
      efforts: ["low", "high"], models: [{ id: model, label: model, efforts: ["low", "high"], defaultEffort: null, note: null }],
    }],
  });
  const hashOf = () => {
    const tools = createLeadTools({ db: {} as any, dbPath: "", dataDir: "" });
    const picked = ["create_task", "spawn_child", "recover_ticket_run"].map((name) => {
      const tool = tools.find((t: any) => t.name === name) as any;
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    });
    return { hash: createHash("sha256").update(JSON.stringify(picked)).digest("hex"), picked };
  };

  it("两次取到的 create_task / spawn_child / recover_ticket_run 定义完全相同，目录变了也一样", () => {
    setModelCatalogForTesting(catalogOf("gpt-6.1-sol"));
    const first = hashOf();
    setModelCatalogForTesting(catalogOf("gpt-7.0-other"));
    const second = hashOf();
    setModelCatalogForTesting(null);
    expect(second.hash).toBe(first.hash);
    const spawn = first.picked.find((t) => t.name === "spawn_child")!;
    expect(spawn.description).not.toContain("gpt-6.1-sol");
    expect(spawn.description).toContain("get_model_catalog");
    expect(spawn.description).toContain("get_runtime_health");
    expect(spawn.description).toContain("不会默认落到 Pi");
  });
});
