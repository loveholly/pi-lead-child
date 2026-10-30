// Lead 的模型目录（2026-10-26，会话输入框的模型选择）：vibeproxy（CLIProxyAPI）的普通目录给 id 和上游，
// 详细目录（?client_version=pi）给显示名、能不能看图和推理强度。账号前缀是 id 里第一个斜杠前的部分。
// 推理强度写在 id 后面的括号里（vibeproxy/as4/claude-sonnet-5(high)）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import {
  assertConfiguredLeadModel, LEAD_CONTEXT_WINDOW_LIMIT, leadModelCatalog, normalizeLeadModelConfig, registerLeadProviders,
  setLeadModelInConfig, splitLeadModelEffort,
} from "../src/model-config.js";
import { PRECIPITATE_RATIO } from "../src/precipitate.js";

let dir: string;
beforeEach(() => { dir = tempDir("plc-lead-catalog-"); });

const plain = {
  data: [
    { id: "claude-sonnet-5", owned_by: "anthropic" },
    { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
    { id: "as1/claude-sonnet-5", owned_by: "anthropic" },
    { id: "as4/claude-sonnet-5", owned_by: "anthropic" },
  ],
};
const rich = {
  models: [
    {
      slug: "claude-sonnet-5", display_name: "Claude Sonnet 5", input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high", visibility: "list",
      context_window: 1_000_000, max_tokens: 128_000,
    },
    {
      slug: "as4/claude-sonnet-5", display_name: "Claude Sonnet 5", input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }], visibility: "list",
      context_window: 1_000_000, max_tokens: 128_000,
    },
    {
      slug: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash", input_modalities: ["text"], supported_reasoning_levels: [],
      context_window: 200_000, max_tokens: 8_192,
    },
    { slug: "hidden-model", visibility: "hide" },
  ],
};

// 假的 vibeproxy：普通目录和详细目录。
const vibeproxy = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  return new Response(JSON.stringify(url.searchParams.get("client_version") === "pi" ? rich : plain));
};

const config = (models: string[] = [], extra: Record<string, unknown> = {}) => normalizeLeadModelConfig({
  providers: { vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1", apiKey: { value: "vibeproxy" }, discover: true, ...extra } },
  models,
});

describe("the Lead model catalog", () => {
  it("reads the account prefix, the upstream, image input and the effort levels", async () => {
    const { models } = await leadModelCatalog(config(), {}, vibeproxy as typeof fetch);
    expect(models.map((model) => [model.id, model.prefix, model.source])).toEqual([
      ["claude-sonnet-5", null, "anthropic"],
      ["gemini-3.8-flash-high", null, "antigravity"],
      ["as1/claude-sonnet-5", "as1", "anthropic"],
      ["as4/claude-sonnet-5", "as4", "anthropic"],
    ]);
    const as4 = models.find((model) => model.id === "as4/claude-sonnet-5")!;
    expect(as4).toMatchObject({ name: "Claude Sonnet 5", input: ["text", "image"], efforts: ["low", "high", "max"] });
    expect(models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({ defaultEffort: "high" });
    expect(models.find((model) => model.id === "gemini-3.8-flash-high")).toMatchObject({ input: ["text"], efforts: [] });
    // 不在详细目录里的（as1 这一条）：只知道 id 和上游。
    expect(models.find((model) => model.id === "as1/claude-sonnet-5")).toMatchObject({ input: ["text"], efforts: [], name: null });
  });

  it("uses only the plain catalog when the provider is not CLIProxyAPI, and lets config.json override image input", async () => {
    const plainOnly = async () => new Response(JSON.stringify(plain));
    const { models } = await leadModelCatalog(
      config([], { models: [{ id: "gemini-3.8-flash-high", input: ["text", "image"] }] }), {}, plainOnly as typeof fetch,
    );
    expect(models.find((model) => model.id === "gemini-3.8-flash-high")?.input).toEqual(["text", "image"]);
    expect(models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({ input: ["text"], efforts: [] });
  });

  it("registers the chosen model with its effort suffix, with the image input of the model", async () => {
    const registered: Array<{ id: string; input: string[] }> = [];
    await registerLeadProviders(
      { registerProvider(_name: string, input: { models?: Array<{ id: string; input: string[] }> }) { registered.push(...(input.models ?? [])); } } as never,
      config(["vibeproxy/as4/claude-sonnet-5(high)"]),
      {},
      vibeproxy as typeof fetch,
    );
    expect(registered.find((model) => model.id === "as4/claude-sonnet-5(high)")?.input).toEqual(["text", "image"]);
    expect(registered.find((model) => model.id === "gemini-3.8-flash-high")?.input).toEqual(["text"]);
    expect(registered.some((model) => model.id === "hidden-model")).toBe(false);
  });

  // 2026-10-26：as4/claude-sonnet-5-5 按 128K 注册（目录说 1M）。压缩以后系统提示词、工具定义和摘要就有 122K，
  // pi 把回答的长度压到 1 个 token，回答以 stopReason length 结束，压缩也压不出空间。用户决定按 500K 算。
  it("registers the catalog's context window up to 500K, so Lead compacts near 500K and keeps room to answer", async () => {
    const registered: Array<{ id: string; contextWindow: number; maxTokens: number }> = [];
    await registerLeadProviders(
      { registerProvider(_name: string, input: { models?: typeof registered }) { registered.push(...(input.models ?? [])); } } as never,
      config(["vibeproxy/as4/claude-sonnet-5(high)"], { models: [{ id: "claude-sonnet-5", contextWindow: 300_000 }] }),
      {},
      vibeproxy as typeof fetch,
    );
    const window = (id: string) => registered.find((model) => model.id === id);
    // 目录说 1M：按 500K 注册。最大输出还是 16384。
    expect(window("as4/claude-sonnet-5(high)")).toMatchObject({ contextWindow: LEAD_CONTEXT_WINDOW_LIMIT, maxTokens: 16_384 });
    // 窗口比 500K 小的按它自己的；目录说的最大输出更小时用目录的。
    expect(window("gemini-3.8-flash-high")).toMatchObject({ contextWindow: 200_000, maxTokens: 8_192 });
    // 目录没说的按 128K；config.json 写了的以它为准。
    expect(window("as1/claude-sonnet-5")).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
    expect(window("claude-sonnet-5")).toMatchObject({ contextWindow: 300_000 });

    const lead = window("as4/claude-sonnet-5(high)")!;
    // 当时压缩后固定的上下文（122480）加 pi 的安全余量（4096）以后，还能写完整的回答。
    expect(lead.contextWindow - 122_480 - 4_096).toBeGreaterThan(lead.maxTokens);
    // pi 在约 484K 时自动压缩；沉淀检查（70%）在压缩之前。
    expect(shouldCompact(480_000, lead.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(shouldCompact(490_000, lead.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(PRECIPITATE_RATIO * lead.contextWindow).toBeLessThan(lead.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  });

  it("accepts an effort the model supports and refuses one it does not, naming the choices", async () => {
    await expect(assertConfiguredLeadModel("vibeproxy/as4/claude-sonnet-5(max)", config(), {}, vibeproxy as typeof fetch)).resolves.toBeUndefined();
    await expect(assertConfiguredLeadModel("vibeproxy/claude-sonnet-5(max)", config(), {}, vibeproxy as typeof fetch))
      .rejects.toThrow("不支持推理强度 max。可选：low、high");
    await expect(assertConfiguredLeadModel("vibeproxy/gemini-3.8-flash-high(high)", config(), {}, vibeproxy as typeof fetch))
      .rejects.toThrow("它不能选推理强度");
    await expect(assertConfiguredLeadModel("vibeproxy/as9/claude-sonnet-5", config(), {}, vibeproxy as typeof fetch))
      .rejects.toThrow("不在已配置的 Lead provider 目录中");
  });

  it("splits the effort suffix off a model id", () => {
    expect(splitLeadModelEffort("as4/claude-sonnet-5(high)")).toEqual({ base: "as4/claude-sonnet-5", effort: "high" });
    expect(splitLeadModelEffort("claude-sonnet-5")).toEqual({ base: "claude-sonnet-5", effort: null });
  });

  it("puts the chosen model first and drops the other efforts of the same model", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: { models: ["vibeproxy/as4/claude-sonnet-5(low)", "vibeproxy/gemini-3.8-flash-high", "vibeproxy/as4/claude-sonnet-5"] },
    }));
    setLeadModelInConfig("vibeproxy/as4/claude-sonnet-5(high)", dir);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models)
      .toEqual(["vibeproxy/as4/claude-sonnet-5(high)", "vibeproxy/gemini-3.8-flash-high"]);
  });
});

// 首次启动引导的 Anthropic 预设（2026-10-30，.scratch/onboarding）：Anthropic 原生接口的目录在 /v1/models，key 放在 x-api-key。
describe("the Anthropic catalog", () => {
  const anthropicList = {
    data: [
      { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z", type: "model" },
      { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-09-20T00:00:00Z", type: "model" },
    ],
    has_more: false,
  };

  it("asks /v1/models with x-api-key and anthropic-version, not a Bearer token", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify(anthropicList));
    };
    const anthropic = normalizeLeadModelConfig({
      providers: { anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: { value: "sk-ant-test" } } },
      models: [],
    });
    const { models } = await leadModelCatalog(anthropic, {}, fake as typeof fetch);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" });
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(models.map((model) => [model.id, model.name, model.created])).toEqual([
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", "2026-09-28T00:00:00.000Z"],
      ["claude-haiku-5-5", "Claude Haiku 5.5", "2026-09-20T00:00:00.000Z"],
    ]);
  });

  it("keeps the Bearer token for a proxy that speaks anthropic-messages", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify(anthropicList));
    };
    const proxy = normalizeLeadModelConfig({
      providers: { proxy: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:8317/v1", apiKey: { value: "local" } } },
      models: [],
    });
    await leadModelCatalog(proxy, {}, fake as typeof fetch);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8317/v1/models?limit=1000");
    expect(seen[0]!.headers.Authorization).toBe("Bearer local");
  });
});
