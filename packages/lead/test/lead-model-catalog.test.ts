// Lead 的模型目录（2026-10-26，会话输入框的模型选择）：vibeproxy（CLIProxyAPI）的普通目录给 id 和上游，
// 详细目录（?client_version=pi）给显示名、能不能看图和推理强度。账号前缀是 id 里第一个斜杠前的部分。
// 推理强度写在 id 后面的括号里（vibeproxy/as4/claude-sonnet-5(high)）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import {
  assertConfiguredLeadModel, knownContextWindow, LEAD_CONTEXT_WINDOW_LIMIT, leadModelCatalog, normalizeLeadModelConfig,
  registerLeadProviders, saveLeadProviderInConfig, setLeadModelInConfig, splitLeadModelEffort,
} from "../src/model-config.js";
import { DEFAULT_LEAD_CONTEXT_WINDOW } from "@pi-lead-child/protocol";
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
    expect(models.map((model) => [model.id, model.group, model.source])).toEqual([
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

  // 回归：分工里在用的服务商目录拉不到（key 错，401）时以前抛错，daemon 起不来，被反复重启。
  // 现在照样注册分工里的模型，原因交给调用方；分工里没用的服务商照旧跳过。
  it("still registers the chosen model when its provider's catalog fails, and reports why without the key", async () => {
    const registered: Array<{ name: string; models: string[] }> = [];
    const runtime = {
      registerProvider(name: string, input: { models?: Array<{ id: string }> }) {
        registered.push({ name, models: (input.models ?? []).map((model) => model.id) });
      },
    } as never;
    const denied = async () => new Response("{}", { status: 401, statusText: "Unauthorized" });
    const twoProviders = normalizeLeadModelConfig({
      providers: {
        vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1", apiKey: { value: "sk-test-wrong-0123" }, discover: true },
        spare: { baseUrl: "http://127.0.0.1:8318/v1", apiKey: { value: "sk-test-spare-0123" }, discover: true },
      },
      models: ["vibeproxy/claude-sonnet-5"],
    });
    const result = await registerLeadProviders(runtime, twoProviders, {}, denied as typeof fetch);
    expect(registered).toEqual([{ name: "vibeproxy", models: ["claude-sonnet-5"] }]);
    expect(result.unavailable).toEqual([{ provider: "vibeproxy", reason: expect.stringMatching(/^vibeproxy: model catalog failed .*401 Unauthorized/) }]);
    expect(result.notes).toContainEqual(expect.stringMatching(/^spare: skipped/));
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  // 第二轮审阅：只重拉还缺目录的服务商。拉得到目录的不再拉、也不重新注册，一次抖动不会把它换成缺省的（128K、只看文字）。
  it("re-registers only the providers it is asked to, leaving the others alone", async () => {
    const registered: string[] = [];
    const fetched: string[] = [];
    const runtime = { registerProvider(name: string) { registered.push(name); } } as never;
    const twoProviders = normalizeLeadModelConfig({
      providers: {
        vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1", apiKey: { value: "test" }, discover: true },
        spare: { baseUrl: "http://127.0.0.1:8318/v1", apiKey: { value: "test" }, discover: true },
      },
      models: ["vibeproxy/claude-sonnet-5", "spare/claude-sonnet-5"],
    });
    const failing = async (input: string | URL | Request) => {
      fetched.push(new URL(String(input)).port);
      throw new Error("fetch failed");
    };
    const result = await registerLeadProviders(runtime, twoProviders, {}, failing as typeof fetch, { only: new Set(["spare"]) });
    expect(registered).toEqual(["spare"]);
    expect(fetched.every((port) => port === "8318")).toBe(true);
    expect(result.unavailable.map((entry) => entry.provider)).toEqual(["spare"]);
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
    // 目录没说的用已知的窗口（pi 内置目录：claude-sonnet-5 是 1M，按 500K 注册）；config.json 写了的以它为准。
    expect(window("as1/claude-sonnet-5")).toMatchObject({ contextWindow: LEAD_CONTEXT_WINDOW_LIMIT, maxTokens: 16_384 });
    expect(window("claude-sonnet-5")).toMatchObject({ contextWindow: 300_000 });

    const lead = window("as4/claude-sonnet-5(high)")!;
    // 当时压缩后固定的上下文（122480）加 pi 的安全余量（4096）以后，还能写完整的回答。
    expect(lead.contextWindow - 122_480 - 4_096).toBeGreaterThan(lead.maxTokens);
    // pi 在约 484K 时自动压缩；沉淀检查（70%）在压缩之前。
    expect(shouldCompact(480_000, lead.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(shouldCompact(490_000, lead.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(PRECIPITATE_RATIO * lead.contextWindow).toBeLessThan(lead.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  });

  // Regression (prompt cache, 2026-11-12): a gateway lists DeepSeek without a window, Lead assumed 128K and compacted
  // about every 20K tokens. A known model now gets its real window; an unknown one still gets 128K.
  it("registers the known window of a model the catalog lists without one, and 128K for an unknown model", async () => {
    const registered: Array<{ id: string; contextWindow: number }> = [];
    await registerLeadProviders(
      { registerProvider(_name: string, input: { models?: typeof registered }) { registered.push(...(input.models ?? [])); } } as never,
      normalizeLeadModelConfig({
        providers: {
          gateway: {
            baseUrl: "http://127.0.0.1:9/v1", apiKey: { value: "k" }, discover: false,
            models: ["auto/deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash(high)", "my-private-model"],
          },
        },
        models: ["gateway/auto/deepseek-flash"],
      }),
      {},
    );
    const window = (id: string) => registered.find((model) => model.id === id)?.contextWindow;
    expect(window("auto/deepseek-flash")).toBe(LEAD_CONTEXT_WINDOW_LIMIT);
    expect(window("deepseek-v4-pro")).toBe(LEAD_CONTEXT_WINDOW_LIMIT);
    expect(window("deepseek-v4-flash(high)")).toBe(LEAD_CONTEXT_WINDOW_LIMIT);
    expect(window("my-private-model")).toBe(DEFAULT_LEAD_CONTEXT_WINDOW);
    expect(knownContextWindow("as4/deepseek-flash")).toBe(1_000_000);
    expect(knownContextWindow("my-private-model")).toBeNull();
  });

  // pi-ai 1.5.2 lists deepseek-v4.1-flash only in aggregator and reseller catalogs (1,000,000 and 1,048,576), not in
  // DeepSeek's own. A model no first-party catalog lists gets the smallest window the other built-in catalogs give.
  it("falls back to the smallest window of the other built-in catalogs when no first-party catalog lists the model", async () => {
    for (const id of [
      "deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "auto/DeepSeek-V4.1-Flash", "gateway/auto/deepseek-v4.1-flash",
      "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-v4.1-flash(high)", "as4/DeepSeek-V4.1-Flash(max)",
    ]) {
      expect(knownContextWindow(id), id).toBe(1_000_000);
    }
    // First-party catalogs still come first.
    expect(knownContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(knownContextWindow("auto/DeepSeek-V4-Pro")).toBe(1_000_000);
    expect(knownContextWindow("deepseek-v4-flash")).toBe(1_000_000);
    expect(knownContextWindow("my-private-model")).toBeNull();
    expect(knownContextWindow("auto/my-private-model(high)")).toBeNull();

    // Lead still registers it at most at LEAD_CONTEXT_WINDOW_LIMIT.
    const registered: Array<{ id: string; contextWindow: number }> = [];
    await registerLeadProviders(
      { registerProvider(_name: string, input: { models?: typeof registered }) { registered.push(...(input.models ?? [])); } } as never,
      normalizeLeadModelConfig({
        providers: {
          gateway: {
            baseUrl: "http://127.0.0.1:9/v1", apiKey: { value: "k" }, discover: false, models: ["auto/DeepSeek-V4.1-Flash"],
          },
        },
        models: ["gateway/auto/DeepSeek-V4.1-Flash"],
      }),
      {},
    );
    expect(LEAD_CONTEXT_WINDOW_LIMIT).toBe(500_000);
    expect(registered.find((model) => model.id === "auto/DeepSeek-V4.1-Flash")?.contextWindow).toBe(LEAD_CONTEXT_WINDOW_LIMIT);
  });

  it("shows the window the settings page can trust: config.json's, the catalog's, the known one, or none", async () => {
    const { models } = await leadModelCatalog(normalizeLeadModelConfig({
      providers: {
        gateway: {
          baseUrl: "http://127.0.0.1:9/v1", apiKey: { value: "k" }, discover: false,
          models: [{ id: "deepseek-v4-pro" }, { id: "my-private-model" }, { id: "set-by-hand", contextWindow: 64_000 }],
        },
      },
      models: [],
    }), {});
    const window = (id: string) => models.find((model) => model.id === id)?.contextWindow;
    expect(window("deepseek-v4-pro")).toBe(1_000_000);
    expect(window("set-by-hand")).toBe(64_000);
    expect(window("my-private-model")).toBeNull();
  });

  // 2026-11-02：子 agent 在一次调用里写整份评审，写满 16384 就被截断（Run #222、#223）。子 agent 的会话另起一个 ModelRuntime，
  // 按目录给的上限注册，只是不超过它要的值；Lead 的会话照旧 16384。
  it("registers a larger output limit when asked, still capped by the catalog", async () => {
    const registered: Array<{ id: string; maxTokens: number }> = [];
    await registerLeadProviders(
      { registerProvider(_name: string, input: { models?: typeof registered }) { registered.push(...(input.models ?? [])); } } as never,
      config(["vibeproxy/as4/claude-sonnet-5(high)"]),
      {},
      vibeproxy as typeof fetch,
      { maxOutputTokens: 32_000 },
    );
    const limit = (id: string) => registered.find((model) => model.id === id)?.maxTokens;
    expect(limit("as4/claude-sonnet-5(high)")).toBe(32_000);
    expect(limit("gemini-3.8-flash-high")).toBe(8_192);
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

// Lead 模型分组（用户 2026-11-05，原型 docs/prototypes/model-grouping）：账号（group）只在 accountPrefix 生效时才取；
// 能不能看图按 config → capabilities 声明 → 自动识别的顺序判断。
describe("account groups and image input", () => {
  // magpie 风格的服务：没有详细目录，?client_version=pi 也只回普通目录；能力写在 data[] 的每一项里。
  const magpieList = {
    data: [
      {
        id: "auto/deepseek-flash", owned_by: "deepseek", display_name: "DeepSeek Flash", modalities: { input: ["text", "image"] },
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], context_window: 1_048_576, max_output_tokens: 393_216,
      },
      { id: "deepseek/deepseek-flash", owned_by: "deepseek", modalities: { input: ["text"] } },
      { id: "bailian/qwen-max", owned_by: "bailian-token-plan" },
    ],
  };
  const magpie = async () => new Response(JSON.stringify(magpieList));
  const magpieConfig = (extra: Record<string, unknown> = {}) => normalizeLeadModelConfig({
    providers: { magpie: { baseUrl: "https://magpie.example.com/v1", apiKey: { value: "k" }, ...extra } },
    models: [],
  });

  it("groups vibeproxy by account without any config change, because it returns the detailed catalog", async () => {
    const { models, providers } = await leadModelCatalog(config(), {}, vibeproxy as typeof fetch);
    expect(providers.vibeproxy).toEqual({ detailed: true, accountPrefix: true, capabilities: "detailed" });
    expect(models.filter((model) => model.group).map((model) => [model.group, model.id])).toEqual([
      ["as1", "as1/claude-sonnet-5"],
      ["as4", "as4/claude-sonnet-5"],
    ]);
  });

  it("does not read the auto/ and deepseek/ prefixes of a plain catalog as accounts, until accountPrefix is true", async () => {
    const plainRun = await leadModelCatalog(magpieConfig(), {}, magpie as typeof fetch);
    expect(plainRun.providers.magpie).toEqual({ detailed: false, accountPrefix: false, capabilities: "plain" });
    expect(plainRun.models.map((model) => model.group)).toEqual([null, null, null]);

    const declared = await leadModelCatalog(magpieConfig({ accountPrefix: true }), {}, magpie as typeof fetch);
    expect(declared.models.map((model) => [model.id, model.group])).toEqual([
      ["auto/deepseek-flash", "auto"],
      ["deepseek/deepseek-flash", "deepseek"],
      ["bailian/qwen-max", "bailian"],
    ]);
    // vibeproxy 也能关掉：config 写了 false 就不按账号分。
    const off = await leadModelCatalog(config([], { accountPrefix: false }), {}, vibeproxy as typeof fetch);
    expect(off.models.every((model) => model.group === null)).toBe(true);
  });

  it("reads image input, the name and the windows from a plain catalog, but no effort levels", async () => {
    const { models } = await leadModelCatalog(magpieConfig(), {}, magpie as typeof fetch);
    expect(models.find((model) => model.id === "auto/deepseek-flash")).toMatchObject({
      name: "DeepSeek Flash", input: ["text", "image"], efforts: [], contextWindow: 1_048_576, maxTokens: 393_216,
    });
    expect(models.find((model) => model.id === "deepseek/deepseek-flash")?.input).toEqual(["text"]);
    expect(models.find((model) => model.id === "bailian/qwen-max")?.input).toEqual(["text"]);
  });

  it("puts the input written in config.json first, then the declared capabilities source, then auto detection", async () => {
    // config 写的 input 优先：目录说能看图，config 说不能。
    const configFirst = await leadModelCatalog(
      magpieConfig({ models: [{ id: "auto/deepseek-flash", input: ["text"] }], discover: true }), {}, magpie as typeof fetch,
    );
    expect(configFirst.models.find((model) => model.id === "auto/deepseek-flash")?.input).toEqual(["text"]);

    // capabilities: config：不读目录的能力，只认 config 写的。
    const configOnly = await leadModelCatalog(
      magpieConfig({ capabilities: "config", models: [{ id: "bailian/qwen-max", input: ["text", "image"] }], discover: true }),
      {}, magpie as typeof fetch,
    );
    expect(configOnly.providers.magpie?.capabilities).toBe("config");
    expect(configOnly.models.find((model) => model.id === "auto/deepseek-flash")?.input).toEqual(["text"]);
    expect(configOnly.models.find((model) => model.id === "bailian/qwen-max")?.input).toEqual(["text", "image"]);

    // capabilities: detailed：这家没有详细目录，普通目录说的也不算。
    const detailedOnly = await leadModelCatalog(magpieConfig({ capabilities: "detailed" }), {}, magpie as typeof fetch);
    expect(detailedOnly.models.find((model) => model.id === "auto/deepseek-flash")?.input).toEqual(["text"]);

    // capabilities: plain：vibeproxy 的详细目录不算，只看普通目录（它没写能力）。
    const plainOnly = await leadModelCatalog(config([], { capabilities: "plain" }), {}, vibeproxy as typeof fetch);
    expect(plainOnly.models.find((model) => model.id === "as4/claude-sonnet-5")?.input).toEqual(["text"]);
    // accountPrefix 没写：读到了详细目录，照样按账号分。
    expect(plainOnly.models.find((model) => model.id === "as4/claude-sonnet-5")?.group).toBe("as4");
  });

  it("rejects an unknown capabilities source and a non-boolean accountPrefix", () => {
    expect(() => magpieConfig({ capabilities: "guess" })).toThrow(/capabilities/);
    expect(() => magpieConfig({ accountPrefix: "yes" })).toThrow(/accountPrefix/);
  });

  it("writes accountPrefix and capabilities into config.json, and removes them to go back to the default", () => {
    const hostOf = (url: string) => new URL(url).host;
    saveLeadProviderInConfig("magpie", { baseUrl: "https://magpie.example.com/v1", api: "openai-completions" }, hostOf, dir);
    saveLeadProviderInConfig("magpie", {
      baseUrl: "https://magpie.example.com/v1", api: "openai-completions", accountPrefix: true, capabilities: "plain",
    }, hostOf, dir);
    const read = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.providers.magpie;
    expect(read()).toMatchObject({ discover: true, accountPrefix: true, capabilities: "plain" });
    // 不给时不变。
    saveLeadProviderInConfig("magpie", { baseUrl: "https://magpie.example.com/v1", api: "openai-completions" }, hostOf, dir);
    expect(read()).toMatchObject({ accountPrefix: true, capabilities: "plain" });
    // null 和 auto：回到缺省。
    saveLeadProviderInConfig("magpie", {
      baseUrl: "https://magpie.example.com/v1", api: "openai-completions", accountPrefix: null, capabilities: "auto",
    }, hostOf, dir);
    expect(read().accountPrefix).toBeUndefined();
    expect(read().capabilities).toBeUndefined();
    saveLeadProviderInConfig("magpie", { baseUrl: "https://magpie.example.com/v1", api: "openai-completions", accountPrefix: false }, hostOf, dir);
    expect(read().accountPrefix).toBe(false);
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
    // 分组和看图的新规则不影响 Anthropic 原生接口：没有账号，能力和以前一样（目录没写，按只能读文字）。
    expect(models.map((model) => [model.group, model.input])).toEqual([[null, ["text"]], [null, ["text"]]]);
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
