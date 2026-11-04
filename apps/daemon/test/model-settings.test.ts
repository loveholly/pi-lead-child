// 设置 → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）：daemon 的 ModelSettings。
// 大脑的分工和服务商（目录按发布时间排、首见时间、key 进保险库并绑定主机），直觉的多条和分工（旧配置照旧能读）。
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { envConfigPath, loadPlcConfig, writePlcConfig } from "@pi-lead-child/core";
import { Vault } from "@pi-lead-child/connections";
import { loadLeadModelConfig, registerLeadProviders, resolveLeadApiKey, setLeadProviderKeySource } from "@pi-lead-child/lead";
import { UiActionError, updateDesignPreferences } from "@pi-lead-child/engine";
import { ModelSettingsDtoSchema } from "@pi-lead-child/protocol";
import { openDb } from "@pi-lead-child/store";
import { Value } from "typebox/value";
import { loadDecisionModels } from "../src/decision-models.js";
import { connectLeadProviderKeys, ModelSettings, providerSecretName, storedProviderKey } from "../src/model-settings.js";
import { SealedSecrets } from "../src/sealed-secrets.js";

const DAY = 86_400;
let instances: ModelSettings[] = [];
afterEach(() => {
  for (const instance of instances) instance.stop();
  instances = [];
  setLeadProviderKeySource(null);
});

// vibeproxy 的普通目录：Anthropic 的模型带 created（秒），antigravity 的没有。没有详细目录。
function catalogFetch(models: () => Array<{ id: string; created?: number; owned_by?: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.search) return new Response("not found", { status: 404 });
    if (url.hostname === "broken.example.com") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ data: models().map((model) => ({ object: "model", ...model })) }), { status: 200 });
  }) as typeof fetch;
}

function setup(options: { decision?: Record<string, unknown>; models?: string[] } = {}) {
  const dataDir = tempDir("plc-model-settings-");
  const db = openDb(join(dataDir, "plc.db"));
  const vault = new Vault(randomBytes(32));
  writePlcConfig({
    lead: {
      providers: { vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1", api: "openai-completions", discover: true } },
      models: options.models ?? ["vibeproxy/as4/claude-sonnet-5-5", "vibeproxy/as4/claude-haiku-5-5"],
    },
    ...(options.decision ? { decision: options.decision } : {}),
  }, dataDir);
  let catalog = [
    { id: "claude-sonnet-5", created: 1_780_000_000, owned_by: "anthropic" },
    { id: "as4/claude-sonnet-5-5", created: 1_790_553_600, owned_by: "anthropic" },
    { id: "as4/claude-haiku-5-5", created: 1_790_553_600 - DAY, owned_by: "anthropic" },
    { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
  ];
  const chains: string[][] = [];
  let providerRefreshes = 0;
  let now = new Date("2026-10-29T06:00:00.000Z");
  const published: number[] = [];
  const settings = new ModelSettings({
    db, dataDir, vault, log: () => {}, memory: null, externalSecret: () => null, smartModelLlm: () => "vibeproxy/as4/claude-haiku-5-5",
    publish: () => published.push(1),
    brain: {
      current: () => "vibeproxy/as4/claude-sonnet-5-5",
      blocked: () => [],
      applyChain: async (specs) => { chains.push(specs); return "now"; },
      providersChanged: async () => { providerRefreshes += 1; },
    },
    env: {},
    fetch: catalogFetch(() => catalog),
    now: () => now,
  });
  instances.push(settings);
  return {
    dataDir, db, vault, settings, chains, published,
    providerRefreshes: () => providerRefreshes,
    setCatalog: (next: typeof catalog) => { catalog = next; },
    setNow: (next: Date) => { now = next; },
    secrets: () => new SealedSecrets<string>(db, vault),
  };
}

async function expectRefused(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(UiActionError);
  expect((error as UiActionError).code).toBe(code);
  if (message) expect((error as UiActionError).message).toMatch(message);
}

describe("ModelSettings: the page's data", () => {
  it("lists each provider's catalog newest first, keeps unknown release dates last, and reads the old decision config as one entry", async () => {
    const t = setup({ decision: { baseUrl: "https://api.typesafe.ai", model: "jev-latest" } });
    const dto = await t.settings.get();
    expect(Value.Check(ModelSettingsDtoSchema, dto)).toBe(true);
    expect(dto.brain.chain).toEqual([
      { model: "vibeproxy/as4/claude-sonnet-5-5", effort: null },
      { model: "vibeproxy/as4/claude-haiku-5-5", effort: null },
    ]);
    const vibeproxy = dto.brain.providers[0]!;
    expect(vibeproxy).toMatchObject({ name: "vibeproxy", api: "openai-completions", keySet: false, keySource: null, problem: null });
    expect(vibeproxy.models.map((model) => model.id)).toEqual([
      "as4/claude-sonnet-5-5", "as4/claude-haiku-5-5", "claude-sonnet-5", "gemini-3.8-flash-high",
    ]);
    expect(vibeproxy.models[0]!.released).toEqual({ at: new Date(1_790_553_600_000).toISOString(), source: "provider" });
    // 服务商第一次拉目录时就有、目录又没给时间的：不知道什么时候出的。
    expect(vibeproxy.models[3]!.released).toBeNull();
    expect(dto.fast).toEqual({
      models: [{
        id: "jev", name: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest",
        apiKeySet: false, apiKeySource: null, apiKeyHost: null, problem: null,
      }],
      chain: ["jev"], llmFallback: null, effectiveLlm: "vibeproxy/as4/claude-haiku-5-5",
    });
    expect(dto.maxBackups).toBe(3);
  });

  it("dates a model that appears later by when the daemon first saw it, so a new release goes to the top", async () => {
    const t = setup();
    await t.settings.get();
    t.setCatalog([
      { id: "as4/claude-sonnet-5-5", created: 1_790_553_600, owned_by: "anthropic" },
      { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
      { id: "gemini-4-flash", owned_by: "antigravity" },
    ]);
    t.setNow(new Date("2026-11-02T08:00:00.000Z"));
    // 目录缓存 30 秒：保存服务商会清掉它。这里直接换一个实例读。
    const fresh = new ModelSettings({ ...(t.settings as any).options });
    instances.push(fresh);
    const models = (await fresh.get()).brain.providers[0]!.models;
    expect(models[0]).toMatchObject({ id: "gemini-4-flash", released: { at: "2026-11-02T08:00:00.000Z", source: "first_seen" } });
    expect(models.at(-1)).toMatchObject({ id: "gemini-3.8-flash-high", released: null });
  });
});

describe("ModelSettings: the brain", () => {
  it("checks the chain against the catalog before it changes anything", async () => {
    const t = setup();
    await expectRefused(t.settings.setBrainChain({ models: [
      { model: "vibeproxy/as4/claude-sonnet-5-5", effort: null }, { model: "vibeproxy/as4/claude-sonnet-5-5", effort: "high" },
    ] }), "invalid_input", /in the list two times/);
    await expectRefused(t.settings.setBrainChain({ models: [{ model: "vibeproxy/gpt-9", effort: null }] }), "invalid_input", /不在已配置/);
    expect(t.chains).toEqual([]);
    const change = await t.settings.setBrainChain({ models: [
      { model: "vibeproxy/as4/claude-haiku-5-5", effort: null },
      { model: "vibeproxy/gemini-3.8-flash-high", effort: null },
      { model: "vibeproxy/as4/claude-sonnet-5-5", effort: null },
    ] });
    expect(t.chains).toEqual([["vibeproxy/as4/claude-haiku-5-5", "vibeproxy/gemini-3.8-flash-high", "vibeproxy/as4/claude-sonnet-5-5"]]);
    expect(change).toMatchObject({ applied: "now", summary: "Brain: primary vibeproxy/as4/claude-haiku-5-5, backups vibeproxy/gemini-3.8-flash-high, vibeproxy/as4/claude-sonnet-5-5",
    });
  });

  it("uses at most one primary and three backups from a hand-edited lead.models", () => {
    const t = setup({ models: ["vibeproxy/a", "vibeproxy/b", "vibeproxy/c", "vibeproxy/d", "vibeproxy/e"] });
    expect(loadLeadModelConfig(t.dataDir).models).toEqual(["vibeproxy/a", "vibeproxy/b", "vibeproxy/c", "vibeproxy/d"]);
  });

  it("stores a provider's key sealed and bound to its host, never in config.json, and drops it when the host changes", async () => {
    const t = setup();
    await t.settings.saveProvider({ name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-test-0123456789" });
    expect(readFileSync(envConfigPath(t.dataDir), "utf8")).not.toContain("sk-test");
    expect(loadPlcConfig(t.dataDir).lead?.providers?.openai).toEqual({ discover: true, baseUrl: "https://api.openai.com/v1", api: "openai-completions" });
    expect(t.providerRefreshes()).toBe(1);
    // Lead 的会话取 key 时问的就是这里。
    const provider = loadLeadModelConfig(t.dataDir).providers.openai!;
    expect(resolveLeadApiKey(provider, {}, "openai")).toBe("sk-test-0123456789");
    const dto = await t.settings.get();
    expect(dto.brain.providers.find((entry) => entry.name === "openai")).toMatchObject({ keySet: true, keySource: "settings", keyHost: "api.openai.com" });

    const moved = await t.settings.saveProvider({ name: "openai", baseUrl: "https://gateway.example.com/v1", api: "openai-completions" });
    expect(moved.note).toBe("The address changed to gateway.example.com. The old key was only for api.openai.com, so the daemon deleted it.");
    expect(t.secrets().get("lead.provider.openai")).toBeNull();
    expect(resolveLeadApiKey(loadLeadModelConfig(t.dataDir).providers.openai!, {}, "openai")).toBeUndefined();
  });

  // 保险库里的 key 只给存 key 时的那个主机；解不开时不给，记一行不带内容的日志。
  it("gives a stored provider key only to the host it was saved for, without a ModelSettings", () => {
    const dataDir = tempDir("plc-model-settings-key-");
    const db = openDb(join(dataDir, "plc.db"));
    const vault = new Vault(randomBytes(32));
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    new SealedSecrets<string>(db, vault).set("lead.provider.openai", { value: "sk-test-boundary", host: "api.openai.com" });
    const secrets = new SealedSecrets<string>(db, vault);
    expect(storedProviderKey(secrets, log, "openai", { baseUrl: "https://api.openai.com/v1" })).toEqual({ value: "sk-test-boundary", host: "api.openai.com" });
    expect(storedProviderKey(secrets, log, "openai", { baseUrl: "https://gateway.example.com/v1" })).toBeNull();
    expect(storedProviderKey(secrets, log, "other", { baseUrl: "https://api.openai.com/v1" })).toBeNull();
    // 保险库的密钥换了：解不开，不给 key，记一行不带内容的日志。
    const otherVault = new SealedSecrets<string>(db, new Vault(randomBytes(32)));
    expect(storedProviderKey(otherVault, log, "openai", { baseUrl: "https://api.openai.com/v1" })).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[models\] provider key for openai cannot be opened: /);
    expect(logged[0]).not.toContain("sk-test");
    db.close();
  });

  it("drops a key written in config.json when the provider moves to another host", async () => {
    const t = setup();
    const file = loadPlcConfig(t.dataDir);
    writePlcConfig({ ...file, lead: { ...file.lead, providers: { ...file.lead!.providers, corp: { baseUrl: "https://llm.corp.example.com/v1", apiKey: "plain-key" } } } }, t.dataDir);
    const change = await t.settings.saveProvider({ name: "corp", baseUrl: "https://llm2.corp.example.com/v1", api: "openai-completions" });
    expect(change.note).toContain("the daemon deleted the old key in config.json");
    expect(loadPlcConfig(t.dataDir).lead?.providers?.corp).not.toHaveProperty("apiKey");
  });

  it("refuses to remove a provider whose model is in the chain, and removes its sealed key otherwise", async () => {
    const t = setup();
    await expectRefused(t.settings.removeProvider("vibeproxy"), "invalid_input", /still uses vibeproxy\/as4\/claude-sonnet-5-5/);
    await t.settings.saveProvider({ name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-test-1" });
    await t.settings.removeProvider("openai");
    expect(loadPlcConfig(t.dataDir).lead?.providers).not.toHaveProperty("openai");
    expect(t.secrets().get("lead.provider.openai")).toBeNull();
    await expectRefused(t.settings.removeProvider("openai"), "not_found");
  });

  it("refuses an address with credentials in it", async () => {
    const t = setup();
    await expectRefused(
      t.settings.saveProvider({ name: "corp", baseUrl: "https://user:hunter2@llm.corp.example.com/v1", api: "openai-completions" }),
      "invalid_input",
    );
    expect(loadPlcConfig(t.dataDir).lead?.providers).not.toHaveProperty("corp");
  });
});

// 工单 #181：daemon 在建 ModelSettings 之前就接上保险库（connectLeadProviderKeys），Lead 启动时第一次注册服务商、拉目录就带着 key。
describe("connectLeadProviderKeys: the settings-page key before ModelSettings exists", () => {
  it("gives the stored key to the first provider registration and catalog request, and only for the host it was stored for", async () => {
    const dataDir = tempDir("plc-model-settings-");
    const db = openDb(join(dataDir, "plc.db"));
    const vault = new Vault(randomBytes(32));
    writePlcConfig({ lead: { providers: { gateway: { baseUrl: "https://gateway.example.com/v1", api: "openai-completions", discover: true } }, models: ["gateway/m1"] } }, dataDir);
    new SealedSecrets<string>(db, vault).set(providerSecretName("gateway"), { value: "sk-vault-0123456789", host: "gateway.example.com" });
    const config = loadLeadModelConfig(dataDir);
    expect(config.providers.gateway!.apiKey).toBeUndefined();

    connectLeadProviderKeys(db, vault, () => {});
    const auth: Array<string | null> = [];
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      auth.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as typeof fetch;
    const registered: Record<string, string | undefined> = {};
    const runtime = { registerProvider: (name: string, input: { apiKey?: string }) => { registered[name] = input.apiKey; } };
    await registerLeadProviders(runtime as never, config, {}, fetchImpl);
    expect(registered).toEqual({ gateway: "sk-vault-0123456789" });
    expect([...new Set(auth)]).toEqual(["Bearer sk-vault-0123456789"]);
    // key 只发给存它时的主机。
    expect(resolveLeadApiKey({ ...config.providers.gateway!, baseUrl: "https://other.example.com/v1" }, {}, "gateway")).toBeUndefined();
    db.close();
  });
});

describe("ModelSettings: the fast models (decision models)", () => {
  it("adds a second decision model next to the old one, keeps the old key where it was, and mirrors the primary into the old fields", async () => {
    const t = setup({ decision: { baseUrl: "https://api.typesafe.ai", model: "jev-latest" } });
    t.secrets().set("decision.apiKey", { value: "ts-old", host: "api.typesafe.ai" });
    const added = await t.settings.saveFastModel({ name: "decision-1", baseUrl: "https://jev.example.com", model: "jev-latest", apiKey: "tsk-new" });
    expect(added.id).toBe("decision-1");
    expect(loadDecisionModels(t.dataDir)).toMatchObject({
      entries: [{ id: "jev", host: "api.typesafe.ai" }, { id: "decision-1", name: "decision-1", host: "jev.example.com" }],
      chain: ["jev"],
    });
    expect(t.secrets().get("decision.apiKey")).toEqual({ value: "ts-old", host: "api.typesafe.ai" });
    expect(t.secrets().get("decision.apiKey.decision-1")).toEqual({ value: "tsk-new", host: "jev.example.com" });
    expect(readFileSync(envConfigPath(t.dataDir), "utf8")).not.toContain("tsk-new");

    await t.settings.setFastChain({ chain: ["decision-1", "jev"], llmFallback: { model: "vibeproxy/as4/claude-haiku-5-5", effort: null } });
    expect(loadPlcConfig(t.dataDir).decision).toMatchObject({
      baseUrl: "https://jev.example.com", model: "jev-latest", chain: ["decision-1", "jev"], llmFallback: "vibeproxy/as4/claude-haiku-5-5",
    });
    const dto = await t.settings.get();
    expect(dto.fast.chain).toEqual(["decision-1", "jev"]);
    expect(dto.fast.effectiveLlm).toBe("vibeproxy/as4/claude-haiku-5-5");
    expect(dto.fast.models.map((model) => [model.id, model.apiKeySet, model.apiKeySource])).toEqual([
      ["jev", true, "settings"], ["decision-1", true, "settings"],
    ]);
  });

  it("checks the fast chain: known entries, no repeats, at most three backups, and a fallback the brain can use", async () => {
    const t = setup();
    for (const name of ["a", "b", "c", "d"]) await t.settings.saveFastModel({ name, baseUrl: `https://${name}.example.com`, model: "jev-latest" });
    await expectRefused(t.settings.setFastChain({ chain: ["jev", "a", "b", "c", "d"] }), "invalid_input", /at most 3 backups/);
    await expectRefused(t.settings.setFastChain({ chain: ["nope"] }), "not_found");
    await expectRefused(t.settings.setFastChain({ chain: ["a", "a"] }), "invalid_input", /two times/);
    await expectRefused(
      t.settings.setFastChain({ chain: ["a"], llmFallback: { model: "vibeproxy/gpt-9", effort: null } }), "invalid_input", /不在已配置/,
    );
    await t.settings.setFastChain({ chain: [] });
    expect(loadDecisionModels(t.dataDir).chain).toEqual([]);
  });

  it("makes the first decision model the primary when there is none yet", async () => {
    const t = setup({ decision: { models: [], chain: [] } });
    const added = await t.settings.saveFastModel({ name: "My Jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest" });
    expect(added.id).toBe("my-jev");
    expect(loadDecisionModels(t.dataDir).chain).toEqual(["my-jev"]);
  });

  it("refuses to remove a decision model in the chain, and drops its key when it goes", async () => {
    const t = setup();
    await t.settings.saveFastModel({ name: "decision-1", baseUrl: "https://jev.example.com", model: "jev-latest", apiKey: "tsk-1" });
    await expectRefused(t.settings.removeFastModel("jev"), "invalid_input", /still in the intuition assignment/);
    await t.settings.removeFastModel("decision-1");
    expect(loadDecisionModels(t.dataDir).entries.map((entry) => entry.id)).toEqual(["jev"]);
    expect(t.secrets().get("decision.apiKey.decision-1")).toBeNull();
  });

  it("drops a decision model's key when its address moves to another host", async () => {
    const t = setup();
    await t.settings.saveFastModel({ name: "decision-1", baseUrl: "https://jev.example.com", model: "jev-latest", apiKey: "tsk-1" });
    const moved = await t.settings.saveFastModel({ id: "decision-1", name: "decision-1", baseUrl: "https://jev2.example.com", model: "jev-latest" });
    expect(moved.note).toContain("The old key was only for jev.example.com");
    expect(t.secrets().get("decision.apiKey.decision-1")).toBeNull();
  });
});

describe("ModelSettings in Chinese", () => {
  it("writes the summaries, notes and errors in the language the user chose", async () => {
    const t = setup();
    updateDesignPreferences(t.db, { request: { locale: "zh" }, caller: { kind: "user" } });
    const change = await t.settings.setBrainChain({ models: [{ model: "vibeproxy/as4/claude-haiku-5-5", effort: null }] });
    expect(change.summary).toBe("大脑：主用 vibeproxy/as4/claude-haiku-5-5，没有备用");
    await expectRefused(t.settings.setBrainChain({ models: [] }), "invalid_input", /至少要有一个主用/);
    await t.settings.saveProvider({ name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-test-0123456789" });
    const moved = await t.settings.saveProvider({ name: "openai", baseUrl: "https://gateway.example.com/v1", api: "openai-completions" });
    expect(moved).toMatchObject({
      summary: "改了服务商 openai（gateway.example.com）",
      note: "地址换到了 gateway.example.com，原来的 key 只给 api.openai.com，已经删掉。",
    });
    await expectRefused(t.settings.removeFastModel("jev"), "invalid_input", /还在直觉的分工里/);
    await expectRefused(t.settings.saveFastModel({ name: "x", baseUrl: "https://user:pass@x.example.com", model: "m" }), "invalid_input", /用户名或密码/);
  });
});
