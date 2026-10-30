// MemoryController（src/memory-controller.ts）：Lead 的记忆设置、Hindsight 的热重载和用户确认，
// 以及 2026-10-16 发布评审要求的：key 绑定主机、地址校验、外部 rerank 要用户同意、模型固定版本。
// launchd、下载、网络都是替身（memory-fakes.ts），ensureHindsightService 是真的。
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { loadPlcConfig, writePlcConfig } from "@pi-lead-child/core";
import { Vault } from "@pi-lead-child/connections";
import { HindsightBackend, type MemoryBackend, type NotesMemory } from "@pi-lead-child/engine";
import { listInbox, openDb, type Db } from "@pi-lead-child/store";
import { readServiceFile, type HindsightSecrets } from "@pi-lead-child/supervisor";
import { MemorySwitchSchema } from "@pi-lead-child/protocol";
import { Value } from "typebox/value";
import {
  DEFAULT_LOCAL_EMBEDDING, DEFAULT_LOCAL_RERANKER, HINDSIGHT_SECRETS_AAD, hindsightSecretsPath, MemoryController,
  PINNED_MODEL_REVISIONS, type MemoryControllerHooks,
} from "../src/memory-controller.js";
import type { SummaryModels } from "../src/memory-backend.js";
import { memoryHarness, type MemoryHarness } from "./memory-fakes.js";

const REMOTE = { mode: "remote" as const, baseUrl: "https://api.example.com/v1", model: "text-embedding-3-small" };
const E5 = /intfloat\/multilingual-e5-large/;

class FakeNotes {
  backends: Array<MemoryBackend | null> = [];
  index = { notes: 0, indexed: 0 };
  // 选了 Hindsight 但它不能用时的说明（召回改用 SQLite，原因是 down）。
  unavailable: Array<string | null> = [];
  writes = { notes: 0, completed: 0, pending: 0, failed: 0, lastError: null as string | null };
  retried = 0;
  setBackend(backend: MemoryBackend | null) { this.backends.push(backend); }
  setUnavailable(reason: string | null) { this.unavailable.push(reason); }
  progress() { return this.index; }
  writeStatus() { return this.writes; }
  retryFailed() { this.retried += 1; return this.writes.failed; }
  async stats() { return null; }
}

// 没有摘要模型：Hindsight 只召回（memory-backend.ts 的 summaryModels 找不到模型时）。
const NO_MODELS: SummaryModels = {
  default: { slot: "default", spec: null, source: "none", setting: null, problem: null, llm: null },
  consolidation: { slot: "consolidation", spec: null, source: "none", setting: null, problem: null, llm: null },
};

let controllers: MemoryController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers = [];
});

function setup(existing?: { dataDir: string; db: Db; vault: Vault; harness: MemoryHarness }, hooks: MemoryControllerHooks = {}) {
  const dataDir = existing?.dataDir ?? tempDir("plc-memory-");
  const db = existing?.db ?? openDb(join(dataDir, "plc.db"));
  const vault = existing?.vault ?? new Vault(randomBytes(32));
  const harness = existing?.harness ?? memoryHarness(dataDir);
  const notes = new FakeNotes();
  const published: string[] = [];
  const logs: string[] = [];
  const controller = new MemoryController({
    db, dataDir, vault, memory: notes as unknown as NotesMemory, log: (line) => logs.push(line),
    publish: (resource) => published.push(resource),
    externalSecret: () => null, summaryModels: async () => NO_MODELS, programArguments: ["/node", "/hindsight.mjs"],
    ...harness.hooks,
    ...hooks,
  });
  controllers.push(controller);
  const sealed = () => vault.open<HindsightSecrets>(readFileSync(hindsightSecretsPath(dataDir)), HINDSIGHT_SECRETS_AAD);
  const memoryInbox = () => listInbox(db).map((row) => ({ ...row, payload: JSON.parse(row.payload || "{}") }))
    .filter((row) => row.payload.kind?.startsWith("memory_"));
  return { dataDir, db, vault, harness, notes, published, logs, controller, sealed, memoryInbox };
}

// 先启用本地 embedding 并下完，得到一个在跑的本地 Hindsight（没有外部 reranker）。
async function runningLocal(t: ReturnType<typeof setup>) {
  await t.controller.start();
  await t.controller.update({ embedding: { mode: "local" } });
  t.harness.downloads().finish(DEFAULT_LOCAL_EMBEDDING);
  await vi.waitFor(() => expect(t.controller.get().service.embedding).toMatch(E5));
}

describe("MemoryController: nothing runs or downloads until the user chooses", () => {
  it("keeps Hindsight off and downloads nothing without an embedding choice", async () => {
    const t = setup();
    await t.controller.start();
    expect(t.harness.launchctl).not.toContain("bootstrap");
    expect(t.harness.downloads().started).toEqual([]);
    expect(t.controller.get()).toMatchObject({
      embedding: { mode: "unset", local: { model: DEFAULT_LOCAL_EMBEDDING, download: { state: "idle" } }, remote: { apiKeySet: false, apiKeyHost: null } },
      reranker: { mode: "decision", effective: "none", local: { model: DEFAULT_LOCAL_RERANKER, download: { state: "idle" } }, external: null },
      service: { state: "off", embedding: null, backend: "hindsight" },
      pendingSwitch: null,
    });
  });

  // 2026-10-16 发布评审：关着记忆启动 daemon 时不去查 provider 的模型列表。
  it("does not look up the LLM while memory is off", async () => {
    const t = setup();
    let lookups = 0;
    const controller = new MemoryController({
      db: t.db, dataDir: t.dataDir, vault: t.vault, memory: t.notes as unknown as NotesMemory, log: () => {},
      publish: () => {}, externalSecret: () => null, programArguments: ["/node", "/hindsight.mjs"],
      ...t.harness.hooks,
      summaryModels: async () => { lookups += 1; return NO_MODELS; },
    });
    controllers.push(controller);
    await controller.start();
    await controller.update({ reranker: { mode: "none" } });
    expect(lookups).toBe(0);
  });

  it("uses a configured remote embedding when the mode is still unset (2026-10-16 decision)", async () => {
    const t = setup();
    writePlcConfig({ memory: { embedding: { remote: { baseUrl: REMOTE.baseUrl, model: REMOTE.model } } } }, t.dataDir);
    await t.controller.start();
    expect(t.harness.launchctl).toEqual(["print", "bootstrap"]);
    expect(t.controller.get().service.embedding).toBe("远程 text-embedding-3-small（api.example.com）");
  });

  it("stays on full-text search when PLC_MEMORY_BACKEND=sqlite, and treats an unknown value the same way", async () => {
    for (const value of ["sqlite", "off"]) {
      const dataDir = tempDir("plc-memory-");
      const harness = memoryHarness(dataDir);
      harness.hooks.env = { PLC_MEMORY_BACKEND: value };
      const t = setup({ dataDir, db: openDb(join(dataDir, "plc.db")), vault: new Vault(randomBytes(32)), harness });
      writePlcConfig({ memory: { embedding: { mode: "local" } } }, dataDir);
      await t.controller.start();
      expect(harness.downloads().started).toEqual([]);
      expect(harness.launchctl).not.toContain("bootstrap");
      if (value === "off") expect(t.logs.join("\n")).toMatch(/treating it as sqlite/);
      // 设置页据此说「这台 Mac 上关掉了记忆」，而不是「先选 embedding」（2026-10-16 发布评审）。
      expect(t.controller.get().service).toMatchObject({ state: "off", backend: "sqlite" });
    }
  });
});

describe("MemoryController: local models download in the background, pinned and safetensors-only", () => {
  it("starts the download only when the user enables it, at the pinned commit, and switches automatically with no index", async () => {
    const t = setup();
    await t.controller.start();
    const saved = await t.controller.update({ embedding: { mode: "local" } });
    expect(t.harness.downloads().started).toEqual([[DEFAULT_LOCAL_EMBEDDING, "embedding"]]);
    expect(t.harness.downloads().revisions).toEqual([PINNED_MODEL_REVISIONS[DEFAULT_LOCAL_EMBEDDING]]);
    expect(saved.embedding.local.download.state).toBe("downloading");
    expect(saved.service.state).toBe("off");
    expect(t.harness.launchctl).not.toContain("bootstrap");

    t.harness.downloads().finish(DEFAULT_LOCAL_EMBEDDING);
    await vi.waitFor(() => expect(t.controller.get().service.embedding).toBe("本地 intfloat/multilingual-e5-large"));
    expect(t.harness.launchctl.filter((call) => call === "bootstrap")).toHaveLength(1);
    expect(t.notes.backends.at(-1)).toBeInstanceOf(HindsightBackend);
    // Hindsight 从快照目录离线加载，用的就是固定的 commit。
    const revision = PINNED_MODEL_REVISIONS[DEFAULT_LOCAL_EMBEDDING]!;
    expect(readServiceFile(t.dataDir)?.embedding).toEqual({
      provider: "local", model: DEFAULT_LOCAL_EMBEDDING, revision,
      path: `/hf/hub/models--intfloat--multilingual-e5-large/snapshots/${revision}`,
    });
    // daemon 第一次初始化 Hindsight 时生成 key（randomUUID）和 pg0 的密码，加密存放；service.json 里没有。
    expect(t.sealed().apiKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.sealed().databasePassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readFileSync(join(t.dataDir, "hindsight", "service.json"), "utf8")).not.toContain(t.sealed().databasePassword);
    expect(t.memoryInbox()).toMatchObject([{ payload: { kind: "memory_switch", state: "applied", wakeLead: false } }]);
  });

  it("downloads a local reranker only when chosen, and does not fall back to the external decision model meanwhile", async () => {
    const t = setup();
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-key");
    writePlcConfig({ memory: { reranker: { mode: "local" } } }, t.dataDir);
    await runningLocal(t);
    expect(t.harness.downloads().started).toContainEqual([DEFAULT_LOCAL_RERANKER, "reranker"]);
    expect(t.controller.get().reranker).toMatchObject({ effective: "none", external: null });
    expect(t.controller.get().pendingSwitch).toBeNull();

    t.harness.downloads().finish(DEFAULT_LOCAL_RERANKER);
    await vi.waitFor(() => expect(t.controller.get().reranker.effective).toBe("local"));
    expect(t.controller.get().pendingSwitch).toBeNull();
    expect(t.sealed().decisionApiKey).toBeUndefined();
  });

  it("reports a failed download to Lead and retries only when the user saves again", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.update({ embedding: { mode: "local" } });
    t.harness.downloads().finish(DEFAULT_LOCAL_EMBEDDING, "disk full");
    expect(t.controller.get().embedding.local.download).toMatchObject({ state: "failed", error: "disk full" });
    expect(t.memoryInbox()).toMatchObject([{ payload: { kind: "memory_download", state: "failed", wakeLead: true } }]);
    await t.controller.update({ reranker: { mode: "none" } });
    expect(t.harness.downloads().started).toHaveLength(1);
    await t.controller.update({ embedding: { mode: "local" } });
    expect(t.harness.downloads().started).toHaveLength(2);
  });

  it("says so when switching after a download fails, instead of swallowing it", async () => {
    const t = setup();
    const ensure = t.harness.hooks.ensure!;
    let broken = true;
    const controller = new MemoryController({
      db: t.db, dataDir: t.dataDir, vault: t.vault, memory: t.notes as unknown as NotesMemory, log: (line) => t.logs.push(line),
      publish: () => {}, externalSecret: () => null, summaryModels: async () => NO_MODELS, programArguments: ["/node", "/hindsight.mjs"],
      ...t.harness.hooks,
      ensure: async (options) => { if (broken) throw new Error("launchctl bootstrap failed"); return ensure(options); },
    });
    controllers.push(controller);
    await controller.start();
    await controller.update({ embedding: { mode: "local" } });
    t.harness.downloads().finish(DEFAULT_LOCAL_EMBEDDING);
    await vi.waitFor(() => expect(controller.get().service.message).toMatch(/下好了，但切换失败：记忆服务没有起来：launchctl bootstrap failed/));
    expect(t.logs.join("\n")).toMatch(/switching after the download .* failed/);
    broken = false;
  });
});

// 2026-10-26：确认切换时 launchctl bootstrap 失败（EIO），设置页收到 500，状态仍是「语义检索已开」，
// Hindsight 却已经停了，也没有人再把它拉起来。状态要说真话，并且自己重试。
describe("MemoryController: a Hindsight that fails to start is reported as down and retried", () => {
  it("says the service is down with the reason, stops using the old index, and retries until it comes up", async () => {
    const t = setup();
    const ensure = t.harness.hooks.ensure!;
    let broken = false;
    const controller = new MemoryController({
      db: t.db, dataDir: t.dataDir, vault: t.vault, memory: t.notes as unknown as NotesMemory, log: (line) => t.logs.push(line),
      publish: () => {}, externalSecret: () => null, summaryModels: async () => NO_MODELS, programArguments: ["/node", "/hindsight.mjs"],
      ...t.harness.hooks,
      healthIntervalMs: 20,
      ensure: async (options) => {
        if (broken) throw new Error("launchctl bootstrap com.pi-lead-child.hindsight failed after 5 attempts: Bootstrap failed: 5: Input/output error");
        return ensure(options);
      },
    });
    controllers.push(controller);
    await controller.start();
    await controller.update({ embedding: { ...REMOTE, apiKey: "sk-test-123" } });
    await vi.waitFor(() => expect(controller.get().service.state).toBe("healthy"));
    t.notes.index = { notes: 5, indexed: 5 };

    const saved = await controller.update({ embedding: { ...REMOTE, dimensions: 1536 } });
    broken = true;
    await expect(controller.confirmSwitch(saved.pendingSwitch!.id, true, "user"))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/记忆服务没有起来.*Input\/output error/) });
    expect(controller.get().service).toMatchObject({ state: "down", message: expect.stringMatching(/Input\/output error.*重试/) });
    expect(t.notes.backends.at(-1)).toBeNull();

    broken = false;
    await vi.waitFor(() => expect(controller.get().service).toMatchObject({ state: "healthy", message: null }));
    expect(t.notes.backends.at(-1)).not.toBeNull();
    expect(controller.get().pendingSwitch).toBeNull();
    expect(readServiceFile(t.dataDir)?.embedding).toMatchObject({ dimensions: 1536 });
  });
});

describe("MemoryController: switches that affect what comes next wait for the user", () => {
  it("asks before sending notes to a remote host and rebuilding the index; only the user's confirm applies it", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 12, indexed: 12 };
    const restarts = t.harness.launchctl.length;

    const saved = await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-test-123" } });
    const pending = saved.pendingSwitch!;
    expect(pending).toMatchObject({
      needsConfirmation: true, state: "pending", dataFlows: [{ kind: "embedding", host: "api.example.com", maxCandidates: null }],
      parts: ["embedding"],
    });
    expect(pending.summary).toBe("embedding 换成远程 text-embedding-3-small（api.example.com）");
    expect(pending.reason).toContain("12 条笔记会发给 api.example.com");
    expect(pending.reason).toContain("重建索引");
    expect(t.harness.launchctl).toHaveLength(restarts);
    expect(saved.service.embedding).toBe("本地 intfloat/multilingual-e5-large");
    const asked = t.memoryInbox().find((row) => row.payload.state === "pending")!;
    expect(asked.payload).toMatchObject({ kind: "memory_switch", switch: pending.id, wakeLead: true, needsUser: false });
    expect(asked.summary).toContain("MemorySwitchConfirm");
    expect(asked.summary).toContain("不能替用户确认");

    // 密钥只以密文存放：config.json 和 kv 里都没有明文。
    expect(readFileSync(join(t.dataDir, "config.json"), "utf8")).not.toContain("sk-test-123");
    expect(JSON.stringify(t.db.prepare("SELECT * FROM kv").all())).not.toContain("sk-test-123");
    expect(saved.embedding.remote).toMatchObject({ apiKeySet: true, apiKeyHost: "api.example.com" });

    await expect(t.controller.confirmSwitch("msw_unknown123", true, "user")).rejects.toMatchObject({ code: "not_found" });
    const { memory: confirmed, switch: applied } = await t.controller.confirmSwitch(pending.id, true, "user via web");
    expect(applied).toMatchObject({ id: pending.id, state: "applied" });
    expect(confirmed.pendingSwitch).toBeNull();
    expect(confirmed.service.embedding).toContain("api.example.com");
    expect(t.harness.launchctl.slice(restarts)).toEqual(["print", "bootout", "print", "bootstrap"]);
    expect(t.sealed().embeddingApiKey).toBe("sk-test-123");
    expect(t.memoryInbox().find((row) => row.payload.state === "applied" && row.payload.switch === pending.id)?.summary)
      .toContain("user via web 确认了记忆切换");
    await expect(t.controller.confirmSwitch(pending.id, true, "user")).rejects.toMatchObject({ code: "not_pending" });
  });

  it("puts the setting back when the user rejects, and does not ask again", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 3, indexed: 3 };
    const { pendingSwitch } = await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-test-123" } });
    const { memory: rejected, switch: decided } = await t.controller.confirmSwitch(pendingSwitch!.id, false, "user via web");
    expect(decided.state).toBe("rejected");
    expect(rejected.pendingSwitch).toBeNull();
    expect(rejected.embedding.mode).toBe("local");
    expect(rejected.service.embedding).toMatch(E5);
    // 填过的远程配置留着，以后可以再换。
    expect(loadPlcConfig(t.dataDir).memory?.embedding?.remote?.baseUrl).toBe(REMOTE.baseUrl);
    await t.controller.update({ reranker: { mode: "none" } });
    expect(t.controller.get().pendingSwitch).toBeNull();
  });

  it("drops a pending switch when the user changes the setting back before deciding", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 3, indexed: 3 };
    const { pendingSwitch } = await t.controller.update({ embedding: REMOTE });
    expect((await t.controller.update({ embedding: { mode: "local" } })).pendingSwitch).toBeNull();
    await expect(t.controller.confirmSwitch(pendingSwitch!.id, true, "user")).rejects.toMatchObject({ code: "not_pending" });
    expect(t.controller.getSwitch(pendingSwitch!.id).state).toBe("superseded");
    expect(t.controller.get().service.embedding).toMatch(E5);
    expect(() => t.controller.getSwitch("msw_unknown123")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

// 2026-10-16 发布评审：启用记忆时，Keychain 里有 key 就悄悄开了外部 rerank。现在要用户同意，卡片写明发什么、发给谁。
describe("MemoryController: the external decision-model reranker needs the user's consent", () => {
  it("turns memory on at once, and waits for consent before recall goes to api.typesafe.ai", async () => {
    const t = setup();
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-key");
    await runningLocal(t);
    // embedding 先用起来，reranker 先不用。
    expect(readServiceFile(t.dataDir)?.reranker).toEqual({ provider: "none" });
    const memory = t.controller.get();
    expect(memory.reranker).toMatchObject({ mode: "decision", effective: "none", external: { host: "api.typesafe.ai", maxCandidates: 50 } });
    const pending = memory.pendingSwitch!;
    expect(pending.dataFlows).toEqual([{ kind: "rerank", host: "api.typesafe.ai", maxCandidates: 50 }]);
    // 只等 reranker：embedding 已经生效（设置页据此显示「正在用」，2026-10-16 发布评审）。
    expect(pending.parts).toEqual(["reranker"]);
    expect(memory.service.embedding).toBe("本地 intfloat/multilingual-e5-large");
    expect(pending.reason).toContain("每次召回会把查询和最多 50 条记忆片段发给 api.typesafe.ai");
    expect(pending.reason).toContain("要停止：在设置页把 reranker 设为「不用」或「本地」");
    expect(t.sealed().decisionApiKey).toBeUndefined();

    const { memory: confirmed } = await t.controller.confirmSwitch(pending.id, true, "user via web");
    expect(confirmed.reranker.effective).toBe("decision");
    expect(readServiceFile(t.dataDir)?.reranker).toMatchObject({ provider: "typesafe", maxCandidates: 50 });
    expect(t.sealed().decisionApiKey).toBe("ts-key");
  });

  it("lists both parts when the embedding switch and the external reranker wait for the same confirmation", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 4, indexed: 4 };
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-key");
    const { pendingSwitch } = await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-test-123" } });
    expect(pendingSwitch?.parts).toEqual(["embedding", "reranker"]);
    expect(pendingSwitch?.dataFlows.map((flow) => flow.kind)).toEqual(["embedding", "rerank"]);
    // 两部分都没生效。
    expect(t.controller.get().service).toMatchObject({ embedding: "本地 intfloat/multilingual-e5-large", reranker: "不用" });
  });

  it("reads a switch stored before parts existed as waiting on the embedding", async () => {
    const t = setup();
    await t.controller.start();
    t.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('memory.pendingSwitch', ?, datetime('now'))`,
    ).run(JSON.stringify({
      id: "msw_legacy12345", summary: "embedding 换成远程 m（api.example.com）", reason: "r", needsConfirmation: true,
      state: "pending", createdAt: "2026-10-16T08:00:00.000Z", desired: { embedding: null, reranker: { provider: "none" } },
    }));
    const legacy = t.controller.getSwitch("msw_legacy12345");
    expect(legacy).toMatchObject({ parts: ["embedding"], dataFlows: [] });
    expect(Value.Check(MemorySwitchSchema, legacy)).toBe(true);
  });

  it("turns the reranker off when the user says no, and does not ask again", async () => {
    const t = setup();
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-key");
    await runningLocal(t);
    const { pendingSwitch } = t.controller.get();
    const { memory } = await t.controller.confirmSwitch(pendingSwitch!.id, false, "user via web");
    expect(memory.reranker).toMatchObject({ mode: "none", effective: "none", external: null });
    expect(memory.service.embedding).toMatch(E5);
    await t.controller.update({ embedding: { mode: "local" } });
    expect(t.controller.get().pendingSwitch).toBeNull();
    expect(t.sealed().decisionApiKey).toBeUndefined();
  });

  it("rotates a key without asking once the user agreed, and keeps the index", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 5, indexed: 5 };
    const index = t.notes.backends.at(-1);
    const restarts = () => t.harness.launchctl.filter((call) => call === "bootstrap").length;

    const decision = await t.controller.updateDecisionModel({ baseUrl: "https://decide.example.com", model: "decision-1", apiKey: "dec-1" });
    expect(decision).toEqual({
      baseUrl: "https://decide.example.com", model: "decision-1", apiKeySet: true, apiKeySource: "settings",
      apiKeyHost: "decide.example.com", problem: null,
    });
    const { pendingSwitch } = t.controller.get();
    expect(pendingSwitch?.dataFlows).toEqual([{ kind: "rerank", host: "decide.example.com", maxCandidates: 50 }]);
    await t.controller.confirmSwitch(pendingSwitch!.id, true, "user via web");
    expect(t.sealed().decisionApiKey).toBe("dec-1");
    const before = restarts();

    // 只换 key：期望状态一样，但服务要拿到新 key。
    await t.controller.updateDecisionModel({ apiKey: "dec-2" });
    expect(t.sealed().decisionApiKey).toBe("dec-2");
    expect(restarts()).toBe(before + 1);
    expect(t.controller.get().pendingSwitch).toBeNull();
    expect(t.notes.backends.at(-1)).not.toBe(index);
    expect(JSON.stringify(loadPlcConfig(t.dataDir))).not.toContain("dec-2");

    await t.controller.updateDecisionModel({ apiKey: null });
    expect(t.controller.get().reranker.effective).toBe("none");
    expect(t.sealed().decisionApiKey).toBeUndefined();
  });

  it("takes memory.reranker.maxCandidates from config.json and falls back to 50 for a bad value", async () => {
    const t = setup();
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-key");
    writePlcConfig({ memory: { embedding: { remote: { baseUrl: REMOTE.baseUrl, model: REMOTE.model } }, reranker: { maxCandidates: 20 } } }, t.dataDir);
    await t.controller.start();
    const { pendingSwitch } = t.controller.get();
    expect(pendingSwitch?.dataFlows).toEqual([{ kind: "rerank", host: "api.typesafe.ai", maxCandidates: 20 }]);
    await t.controller.confirmSwitch(pendingSwitch!.id, true, "user");
    expect(readServiceFile(t.dataDir)?.reranker).toMatchObject({ provider: "typesafe", maxCandidates: 20 });
    for (const bad of [0, 301, 2.5, "40"]) {
      const file = loadPlcConfig(t.dataDir);
      writePlcConfig({ ...file, memory: { ...file.memory, reranker: { maxCandidates: bad as number } } }, t.dataDir);
      expect(t.controller.get().reranker.external).toEqual({ host: "api.typesafe.ai", maxCandidates: 50 });
    }
  });
});

// 2026-10-16 发布评审：key 只发给存它时的主机；地址只走一个校验；GET 不回显凭据。
describe("MemoryController: keys are bound to hosts, and every URL goes through one validator", () => {
  it("refuses a bad URL before config.json is written, with the same sentence the settings page shows", async () => {
    const t = setup();
    await t.controller.start();
    const cases: Array<[string, RegExp]> = [
      ["http://[", /不是合法的 URL/],
      ["https://user:pass@api.example.com/v1", /用户名或密码/],
      ["https://api.example.com/v1?api_key=abc", /key、token/],
    ];
    for (const [baseUrl, message] of cases) {
      await expect(t.controller.update({ embedding: { mode: "remote", baseUrl, model: "m" } }))
        .rejects.toMatchObject({ code: "invalid_url", message: expect.stringMatching(message) });
      await expect(t.controller.updateDecisionModel({ baseUrl }))
        .rejects.toMatchObject({ code: "invalid_url", message: expect.stringMatching(message) });
    }
    expect(loadPlcConfig(t.dataDir)).toEqual({});
    // 本机地址可以用 http。
    await t.controller.update({ embedding: { mode: "remote", baseUrl: "http://127.0.0.1:8080/v1/", model: "m" } });
    expect(loadPlcConfig(t.dataDir).memory?.embedding?.remote?.baseUrl).toBe("http://127.0.0.1:8080/v1");
  });

  // 2026-10-26：公司内网的 LLM gateway 只有 http。远程 embedding 和决策模型都可以用它，key 绑定这个主机。
  it("accepts a plain-http gateway on the intranet for the remote embedding and the decision model", async () => {
    const t = setup();
    await t.controller.start();
    const baseUrl = "http://llm-gateway.corp.example.com:8080/v1/";
    await t.controller.update({ embedding: { mode: "remote", baseUrl, model: "m", apiKey: "gw-test-key" } });
    expect(loadPlcConfig(t.dataDir).memory?.embedding?.remote?.baseUrl).toBe("http://llm-gateway.corp.example.com:8080/v1");
    expect(t.controller.get().embedding.remote).toMatchObject({
      baseUrl: "http://llm-gateway.corp.example.com:8080/v1", apiKeySet: true, apiKeyHost: "llm-gateway.corp.example.com:8080",
    });
    await t.controller.updateDecisionModel({ baseUrl });
    expect(loadPlcConfig(t.dataDir).decision?.baseUrl).toBe("http://llm-gateway.corp.example.com:8080/v1");
    expect(t.controller.getDecisionModel()).toMatchObject({ baseUrl: "http://llm-gateway.corp.example.com:8080/v1", problem: null });
  });

  it("survives a broken URL in a hand-edited config.json and never echoes credentials", async () => {
    const t = setup();
    writePlcConfig({
      memory: { embedding: { mode: "remote", remote: { baseUrl: "http://[", model: "m" } } },
      decision: { baseUrl: "https://user:hunter2@decide.example.com" },
    }, t.dataDir);
    await t.controller.start();
    const memory = t.controller.get();
    expect(memory.embedding.remote.baseUrl).toBeNull();
    expect(memory.service).toMatchObject({ state: "off", message: expect.stringMatching(/远程 embedding 地址：地址不是合法的 URL/) });
    expect(t.controller.getDecisionModel()).toMatchObject({ baseUrl: null, apiKeySet: false, problem: expect.stringMatching(/用户名或密码/) });
    expect(JSON.stringify([memory, t.controller.getDecisionModel()])).not.toContain("hunter2");
    expect(t.controller.decisionCredentials()).toBeNull();
    await expect(t.controller.test()).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("drops the embedding key when the base URL moves to another host, and never sends a key to a host it was not saved for", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-a" } });
    expect(t.controller.get().embedding.remote).toMatchObject({ apiKeySet: true, apiKeyHost: "api.example.com" });
    // 同一个主机、不带 key：保留。
    await t.controller.update({ embedding: { ...REMOTE, model: "text-embedding-3-large" } });
    expect(t.controller.get().embedding.remote.apiKeySet).toBe(true);
    // 换主机、不带 key：删掉。
    const moved = await t.controller.update({ embedding: { ...REMOTE, baseUrl: "https://other.example.net/v1" } });
    expect(moved.embedding.remote).toMatchObject({ apiKeySet: false, apiKeyHost: null });
    await t.controller.test();
    expect(t.harness.requests.at(-1)).toMatchObject({ url: "https://other.example.net/v1/embeddings", authorization: null });

    // 手改 config.json 把主机换掉：存的 key 还绑在旧主机上，/test 不发，并且说明原因。
    await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-a" } });
    const file = loadPlcConfig(t.dataDir);
    writePlcConfig({ ...file, memory: { ...file.memory, embedding: { ...file.memory!.embedding, remote: { baseUrl: "https://evil.example.org/v1", model: "m" } } } }, t.dataDir);
    expect(t.controller.get().embedding.remote).toMatchObject({ apiKeySet: false, apiKeyHost: "api.example.com" });
    const sent = t.harness.requests.length;
    await expect(t.controller.test()).rejects.toMatchObject({ code: "key_host_mismatch", message: expect.stringMatching(/先保存，或者重新粘贴 key/) });
    expect(t.harness.requests).toHaveLength(sent);
  });

  it("sends the Keychain TYPESAFE key only to api.typesafe.ai, and a saved key only to its own host", async () => {
    const t = setup();
    t.harness.setExternalSecret("TYPESAFE_API_KEY", "ts-keychain");
    await t.controller.start();
    expect(t.controller.getDecisionModel()).toMatchObject({ apiKeySet: true, apiKeySource: "external", apiKeyHost: "api.typesafe.ai" });

    // 换到自建端点：Keychain 的 key 不跟过去。
    await t.controller.updateDecisionModel({ baseUrl: "https://decide.example.com" });
    expect(t.controller.getDecisionModel()).toMatchObject({ apiKeySet: false, apiKeySource: null, apiKeyHost: null });
    expect(t.controller.decisionCredentials()).toBeNull();
    const sent = t.harness.requests.length;
    await expect(t.controller.testDecisionModel()).rejects.toMatchObject({ code: "invalid_request" });
    expect(t.harness.requests).toHaveLength(sent);

    await t.controller.updateDecisionModel({ apiKey: "dec-own" });
    expect(t.controller.decisionCredentials()).toEqual({ baseUrl: "https://decide.example.com", model: "jev-latest", apiKey: "dec-own", keyHost: "decide.example.com" });
    // 换回 api.typesafe.ai、不带 key：存的 key 绑在 decide.example.com 上，删掉；Keychain 的 key 又能用了。
    await t.controller.updateDecisionModel({ baseUrl: "https://api.typesafe.ai" });
    expect(t.controller.getDecisionModel()).toMatchObject({ apiKeySource: "external", apiKeyHost: "api.typesafe.ai" });
    expect(t.controller.decisionCredentials()?.apiKey).toBe("ts-keychain");
  });

  it("does not follow redirects and masks the key in error messages when testing a connection", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-secret-0123456789abcdef" } });
    t.harness.failNext(new Error("connect failed: Authorization: Bearer sk-secret-0123456789abcdef"));
    const result = await t.controller.test();
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("sk-secret-0123456789abcdef");
    expect(t.harness.requests.at(-1)?.redirect).toBe("error");

    await t.controller.updateDecisionModel({ apiKey: "plain-key-value" });
    t.harness.failNext(new Error("upstream said plain-key-value is wrong"));
    const decision = await t.controller.testDecisionModel();
    expect(decision.message).not.toContain("plain-key-value");
    expect(t.harness.requests.at(-1)?.redirect).toBe("error");
  });
});

describe("MemoryController: a daemon restart does not restart Hindsight", () => {
  it("reconnects to the running service with the key it already has", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.index = { notes: 3, indexed: 3 };
    const { pendingSwitch } = await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-new" } });
    const before = t.harness.launchctl.length;
    t.controller.stop();

    // 新的 daemon 进程：同一个数据目录、同一个 Hindsight。
    const again = setup({ dataDir: t.dataDir, db: t.db, vault: t.vault, harness: t.harness });
    again.notes.index = { notes: 3, indexed: 3 };
    await again.controller.start();
    expect(t.harness.launchctl.slice(before)).toEqual(["print"]);
    expect(again.controller.get().service.embedding).toMatch(E5);
    expect(again.controller.get().pendingSwitch?.id).toBe(pendingSwitch!.id);
    expect(again.sealed().embeddingApiKey).toBeUndefined();
  });
});

describe("MemoryController: connection tests", () => {
  it("tests the remote embedding and the decision model with the stored keys", async () => {
    const t = setup();
    await t.controller.start();
    await expect(t.controller.test()).rejects.toMatchObject({ code: "invalid_request" });
    await t.controller.update({ embedding: { ...REMOTE, apiKey: "sk-test-123" } });
    expect(await t.controller.test()).toMatchObject({ ok: true, message: "返回 3 维向量" });
    expect(t.harness.requests.at(-1)).toMatchObject({ url: "https://api.example.com/v1/embeddings", authorization: "Bearer sk-test-123" });

    await expect(t.controller.testDecisionModel()).rejects.toMatchObject({ code: "invalid_request" });
    await t.controller.updateDecisionModel({ apiKey: "dec-1" });
    expect(await t.controller.testDecisionModel()).toMatchObject({ ok: true });
    expect(t.harness.requests.at(-1)).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer dec-1" });
  });
});

// 设置 → 记忆的摘要模型（spec D16，用户 2026-10-29：缺省 + 整理观察，各一个模型）。改了要重启记忆服务；key 不进 config.json、service.json。
describe("MemoryController: summary models", () => {
  it("saves a consolidation model, restarts Hindsight with its own model and key, and keeps keys out of the plain files", async () => {
    const t = setup();
    await runningLocal(t);
    expect(readServiceFile(t.dataDir)).toMatchObject({ llm: { model: "claude-haiku-5-5" }, consolidationLlm: null, observations: true, missions: { retain: expect.stringMatching(/not only coding/) } });
    const before = t.harness.launchctl.length;
    const change = await t.controller.setSummaryModel({ slot: "consolidation", model: "anthropic/claude-sonnet-5-5" });
    expect(change).toEqual({ summary: "整理观察的模型改成 anthropic/claude-sonnet-5-5", note: "记忆服务正在重启，几秒里召回只用全文检索" });
    expect(t.harness.launchctl.slice(before)).toEqual(["print", "bootout", "print", "bootstrap"]);
    expect(loadPlcConfig(t.dataDir).memory?.llm).toEqual({ consolidation: "anthropic/claude-sonnet-5-5" });
    expect(readServiceFile(t.dataDir)?.consolidationLlm).toEqual({ provider: "anthropic", baseUrl: "https://api.anthropic.example/v1", model: "claude-sonnet-5-5" });
    expect(t.sealed()).toMatchObject({ llmApiKey: "vibe-key", consolidationLlmApiKey: "anthropic-key" });
    for (const file of ["config.json", join("hindsight", "service.json")]) {
      const raw = readFileSync(join(t.dataDir, file), "utf8");
      expect(raw).not.toContain("anthropic-key");
      expect(raw).not.toContain("vibe-key");
    }
    expect(t.published).toContain("memory");
    // 选回跟缺省一样：不再单独给整理观察的模型和 key。
    await t.controller.setSummaryModel({ slot: "consolidation", model: null });
    expect(readServiceFile(t.dataDir)?.consolidationLlm).toBeNull();
    expect(t.sealed().consolidationLlmApiKey).toBeUndefined();
  });

  it("refuses a model whose provider the Lead does not have, and changes nothing", async () => {
    const t = setup();
    await runningLocal(t);
    const before = t.harness.launchctl.length;
    await expect(t.controller.setSummaryModel({ slot: "default", model: "openrouter/haiku" }))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/服务商 openrouter 不在/) });
    expect(loadPlcConfig(t.dataDir).memory?.llm).toBeUndefined();
    expect(t.harness.launchctl.length).toBe(before);
  });

  it("shows each slot's model and how it was chosen, the writes, and tests a slot's model with its own key", async () => {
    const t = setup();
    await runningLocal(t);
    t.notes.writes = { notes: 4, completed: 2, pending: 1, failed: 1, lastError: "Error code: 401" };
    await t.controller.setSummaryModel({ slot: "default", model: "vibeproxy/gemini-3.5-flash-lite" });
    expect(await t.controller.hindsight()).toEqual({
      enabled: true,
      summaryModels: [
        { slot: "default", model: "vibeproxy/gemini-3.5-flash-lite", source: "settings", setting: "vibeproxy/gemini-3.5-flash-lite", problem: null },
        { slot: "consolidation", model: "vibeproxy/gemini-3.5-flash-lite", source: "inherit", setting: null, problem: null },
      ],
      writes: { notes: 4, completed: 2, pending: 1, failed: 1, lastError: "Error code: 401" },
      stats: null,
      // 现在失效着的事实（2026-10-29）：还没有。
      invalidated: [],
    });
    expect(t.controller.settingsSummary().summaryModels.map((slot) => slot.source)).toEqual(["settings", "inherit"]);
    expect(t.controller.get().service.message).toMatch(/1 条笔记没写进 Hindsight（Error code: 401）/);
    expect(await t.controller.testSummaryModel("consolidation")).toMatchObject({ ok: true, message: "vibeproxy/gemini-3.5-flash-lite 可用" });
    expect(t.harness.requests.at(-1)).toMatchObject({
      url: "http://127.0.0.1:8317/v1/chat/completions", authorization: "Bearer vibe-key", redirect: "error",
      body: { model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 5 },
    });
    expect(await t.controller.retryFailedWrites()).toMatchObject({ summary: "1 条写入失败的笔记重新排队" });
    expect(t.notes.retried).toBe(1);
  });

  it("tells the notes memory when Hindsight cannot answer, so recall falls back with the reason", async () => {
    const t = setup();
    await runningLocal(t);
    // 刚重启：正在启动，召回改用 SQLite；健康检查通了以后召回回到 Hindsight。
    expect(t.notes.unavailable).toContain("记忆服务正在启动");
    await vi.waitFor(() => expect(t.notes.unavailable.at(-1)).toBeNull());
  });
});
