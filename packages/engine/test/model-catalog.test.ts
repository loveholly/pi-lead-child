// daemon 的模型目录（model-catalog.ts）：校验 Lead 的选择、换模型的候选、刷新失败时保留上一次的目录、重启后读 kv。
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { runtimeAdapter } from "@pi-lead-child/runtime";

import {
  alternativeModels,
  currentModelCatalog,
  describeModelCatalogChanges,
  formatModelCatalogForLead,
  ModelChoiceError,
  refreshModelCatalog,
  setModelCatalogForTesting,
  validateModelChoice,
  type ModelCatalog,
} from "../src/model-catalog.js";

const CATALOG: ModelCatalog = {
  refreshedAt: "2026-10-15T02:00:00.000Z",
  runtimes: [
    {
      runtime: "codex", state: "known", source: "codex debug models", account: "Codex 内置的订阅账号", freeformModelPattern: null,
      refreshedAt: "2026-10-15T02:00:00.000Z", error: null, cliDefaultModel: "gpt-6.1-sol", efforts: ["low", "medium", "high", "ultra"],
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "ultra"], defaultEffort: "medium", note: null },
        { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "low", note: null },
      ],
    },
    {
      runtime: "claude", state: "known", source: "claude --help", account: "Claude Code 内置的订阅账号",
      freeformModelPattern: "^claude-[a-z0-9][a-z0-9.-]*$", refreshedAt: "2026-10-15T02:00:00.000Z", error: null,
      cliDefaultModel: null, efforts: ["low", "high", "max"],
      models: [{ id: "opus", label: "opus", efforts: ["low", "high", "max"], defaultEffort: null, note: null }],
    },
    {
      runtime: "pi", state: "unknown", source: "pi --list-models", account: null, freeformModelPattern: null,
      refreshedAt: null, error: "pi executable not found", cliDefaultModel: null, efforts: [], models: [],
    },
  ],
};

afterEach(() => setModelCatalogForTesting(null));

describe("validating a model choice against the catalog", () => {
  it("accepts catalog models, provider prefixes the adapter strips, and the adapter's free-form names", () => {
    expect(validateModelChoice(CATALOG, { runtime: "codex", model: "openai/gpt-6.1-sol", effort: "ultra" }))
      .toEqual({ model: "openai/gpt-6.1-sol", effort: "ultra", note: null });
    expect(validateModelChoice(CATALOG, { runtime: "claude", model: "claude-opus-5-5", effort: "max" }).model).toBe("claude-opus-5-5");
  });

  it("refuses a model the account does not offer, and an effort the model does not take", () => {
    expect(() => validateModelChoice(CATALOG, { runtime: "codex", model: "gpt-5.5" })).toThrow(ModelChoiceError);
    expect(() => validateModelChoice(CATALOG, { runtime: "codex", model: "gpt-6-luna", effort: "high" }))
      .toThrow(/gpt-6-luna 不认 effort=high。可选：low、medium/);
  });

  it("checks an effort without a model against the CLI's default model", () => {
    expect(() => validateModelChoice(CATALOG, { runtime: "codex", effort: "max" })).toThrow(/gpt-6.1-sol 不认 effort=max/);
  });

  it("does not check choices for a runtime whose catalog is unknown", () => {
    expect(validateModelChoice(CATALOG, { runtime: "pi", model: "openai/whatever" }))
      .toEqual({ model: "openai/whatever", effort: null, note: "pi 的模型目录未知，这次选择没有核对。" });
  });
});

// 2026-10-29：pi 的目录里是 vibeproxy/claude-opus-5-5，Lead 写 claude-opus-5-5 被拒（「pi 的模型目录里没有 claude-opus-5-5」）。
// Lead 也会把 pi 的写法带到 Claude Code 上（vibeproxy/claude-…），Claude Code 不认 provider 前缀。
describe("a model name without its provider prefix, or with a prefix the runtime does not take", () => {
  const PI_KNOWN: ModelCatalog = {
    ...CATALOG,
    runtimes: CATALOG.runtimes.map((entry) => entry.runtime !== "pi" ? entry : {
      ...entry, state: "known", error: null, refreshedAt: "2026-10-29T02:00:00.000Z", efforts: ["low", "high"],
      models: ["vibeproxy/claude-opus-5-5", "vibeproxy/gemini-3-pro", "vibeproxy/gpt-6.1-sol", "openrouter/gpt-6.1-sol"]
        .map((id) => ({ id, label: id, efforts: ["low", "high"], defaultEffort: null, note: null })),
    }),
  };

  it("resolves a bare pi name to the one catalog model that carries it, and returns the full name", () => {
    expect(validateModelChoice(PI_KNOWN, { runtime: "pi", model: "claude-opus-5-5", effort: "high" }))
      .toMatchObject({ model: "vibeproxy/claude-opus-5-5", effort: "high" });
  });

  it("still refuses a bare pi name that several providers carry, and lists them", () => {
    expect(() => validateModelChoice(PI_KNOWN, { runtime: "pi", model: "gpt-6.1-sol" }))
      .toThrow(/vibeproxy\/gpt-6.1-sol、openrouter\/gpt-6.1-sol/);
  });

  it("does not swap the provider of a prefixed pi name", () => {
    expect(() => validateModelChoice(PI_KNOWN, { runtime: "pi", model: "anthropic/claude-opus-5-5" }))
      .toThrow(ModelChoiceError);
  });

  it("drops a proxy prefix that Claude Code does not take", () => {
    expect(validateModelChoice(PI_KNOWN, { runtime: "claude", model: "vibeproxy/claude-opus-5-5", effort: "max" }))
      .toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    expect(validateModelChoice(PI_KNOWN, { runtime: "claude", model: "vibeproxy/opus" }).model).toBe("opus");
  });
});

describe("alternatives for a model switch", () => {
  it("lists the other catalog models of the same runtime in catalog order", () => {
    expect(alternativeModels(CATALOG, "codex", new Set(["gpt-6.1-sol"])).map((model) => model.id)).toEqual(["gpt-6-luna"]);
    expect(alternativeModels(CATALOG, "pi", new Set())).toEqual([]);
  });
});

describe("the catalog summary for Lead", () => {
  it("names the source, the account and the CLI default, and says when a catalog is unknown", () => {
    const text = formatModelCatalogForLead(CATALOG);
    expect(text).toContain("- codex（codex debug models，Codex 内置的订阅账号）：gpt-6.1-sol（CLI 默认，effort low/medium/high/ultra，默认 medium）");
    expect(text).toContain("- pi（目录未知）：pi executable not found。不要替它选模型。");
  });
});

describe("refreshing the catalog", () => {
  it("keeps the last good catalog of a runtime whose discovery fails, and survives a restart through kv", async () => {
    const db = openDb(join(tempDir("plc-model-catalog-"), "plc.db"));
    // 测试不去问真实的 CLI：三个 adapter 的发现都换成桩。codex 这次失败，claude 成功，pi 没有 adapter 可问。
    const adapters = (["codex", "claude", "pi"] as const).map((id) => runtimeAdapter(id) as { discoverModels?: unknown });
    const originals = adapters.map((adapter) => adapter.discoverModels);
    try {
      setModelCatalogForTesting(CATALOG);
      adapters[0]!.discoverModels = async () => ({ ok: false, error: "timed out", source: "codex debug models" });
      adapters[1]!.discoverModels = async () => ({
        ok: true, source: "claude --help", account: "Claude Code 内置的订阅账号", freeformModelPattern: null,
        cliDefaultModel: null, efforts: ["high"], models: [{ id: "sonnet", label: "sonnet", efforts: ["high"], defaultEffort: null, note: null }],
      });
      adapters[2]!.discoverModels = undefined;
      const refreshed = await refreshModelCatalog({ db, cwd: process.cwd() });
      const codexEntry = refreshed.runtimes.find((candidate) => candidate.runtime === "codex")!;
      expect(codexEntry).toMatchObject({ state: "known", error: "codex debug models: timed out" });
      expect(codexEntry.models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
      expect(refreshed.runtimes.find((candidate) => candidate.runtime === "claude")?.models.map((model) => model.id)).toEqual(["sonnet"]);

      // daemon 重启：内存清空，从 kv 读回上一次的目录。
      setModelCatalogForTesting(null);
      expect(currentModelCatalog(db).runtimes.find((candidate) => candidate.runtime === "codex")?.models).toHaveLength(2);
    } finally {
      adapters.forEach((adapter, index) => { adapter.discoverModels = originals[index]; });
      db.close();
    }
  });
});

// 目录自动刷新以后，Lead 要知道变了什么：它的工具描述里的目录摘要是会话开始时的。
describe("what changed between two catalogs", () => {
  it("names added and removed models, a new CLI default, and runtimes that became known or unknown", () => {
    const codex = CATALOG.runtimes[0]!;
    const after: ModelCatalog = {
      refreshedAt: "2026-10-15T03:00:00.000Z",
      runtimes: [
        {
          ...codex, cliDefaultModel: "gpt-6.2-sol",
          models: [{ ...codex.models[0]!, id: "gpt-6.2-sol" }, codex.models[0]!],
        },
        { ...CATALOG.runtimes[1]!, error: "claude --help: timed out" },
        { ...CATALOG.runtimes[2]!, state: "known", error: null, models: [{ id: "vibeproxy/claude-sonnet-5-5", label: "s", efforts: [], defaultEffort: null, note: null }] },
      ],
    };
    expect(describeModelCatalogChanges(CATALOG, after)).toEqual([
      "codex：新增 gpt-6.2-sol；移除 gpt-6-luna；CLI 默认 gpt-6.1-sol → gpt-6.2-sol",
      "claude：这次发现失败，沿用上一次的目录（claude --help: timed out）",
      "pi：目录可用了（1 个模型）",
    ]);
    expect(describeModelCatalogChanges(CATALOG, CATALOG)).toEqual([]);
  });
});

