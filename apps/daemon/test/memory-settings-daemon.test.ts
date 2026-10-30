// 记忆设置走完用户经过的每一跳：设置页调 /v1/memory，本地模型在后台下完后自动切换，
// 要确认的切换进 Lead 的收件箱，用户在卡片上按「切换」，网关推 snapshot.required 让界面重取。
// launchd、下载和网络是替身（memory-fakes.ts）；daemon、网关、MemoryController、ensureHindsightService 是真的。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  DecisionModelResponseSchema, MemoryHindsightResponseSchema, MemoryResponseSchema, MemorySwitchConfirmResponseSchema,
} from "@pi-lead-child/protocol";
import { createLoopbackBinding, listGatewayEvents, listInbox, openDb, recordMemoryInvalidation, saveNote, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { readServiceFile } from "@pi-lead-child/supervisor";
import { loadPlcConfig } from "@pi-lead-child/core";
import { startDaemon } from "../src/server.js";
import { memoryHarness, type MemoryHarness } from "./memory-fakes.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-memory-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

// Lead 工厂收到的参数（SmartModel 的 decisionModel 从这里进 Lead 会话）。
let factoryArgs: any = null;

function sessionFactory() {
  return async (args: unknown) => (factoryArgs = args, {
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

async function boot(harness: MemoryHarness) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory() as any, gatewayPort: 0, log: () => {},
    manageMemory: harness.hooks,
  });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const viewer = createLoopbackBinding(db, { name: "test-viewer", scopes: ["tickets:view", "tickets:create"] });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, owner, viewer };
}

const memoryRows = () => listInbox(db).map((row) => ({ ...row, payload: JSON.parse(row.payload || "{}") }))
  .filter((row) => row.payload.kind === "memory_switch");

describe("memory settings through the daemon", () => {
  it("downloads a local model, switches on, then waits for the user's confirm before sending notes to a remote host", async () => {
    const harness = memoryHarness(dir);
    const { call, owner, viewer } = await boot(harness);

    const first = await call("GET", "/v1/memory");
    expect(first.status).toBe(200);
    expect(Value.Check(MemoryResponseSchema, first.body)).toBe(true);
    expect(first.body.memory.service.state).toBe("off");
    expect((await call("GET", "/v1/memory", undefined, null)).status).toBe(401);

    const local = await call("POST", "/v1/memory/settings", { embedding: { mode: "local" } });
    expect(local.status).toBe(200);
    expect(local.body.memory.embedding.local.download.state).toBe("downloading");
    harness.downloads().finish("intfloat/multilingual-e5-large");
    await vi.waitFor(async () => expect((await call("GET", "/v1/memory")).body.memory.service.embedding).toMatch(/multilingual-e5-large/));
    expect(memoryRows()).toMatchObject([{ payload: { state: "applied", wakeLead: false } }]);

    const remote = await call("POST", "/v1/memory/settings", {
      embedding: { mode: "remote", baseUrl: "https://api.example.com/v1", model: "text-embedding-3-small", apiKey: "sk-test-123" },
    });
    expect(remote.status).toBe(200);
    expect(Value.Check(MemoryResponseSchema, remote.body)).toBe(true);
    expect(JSON.stringify(remote.body)).not.toContain("sk-test-123");
    const pending = remote.body.memory.pendingSwitch;
    expect(pending).toMatchObject({ state: "pending", needsConfirmation: true });
    expect(pending.reason).toContain("api.example.com");
    // Lead 收到的是一条要它发卡片的收件箱行；它自己确认不了。
    expect(memoryRows().find((row) => row.payload.state === "pending")).toMatchObject({
      payload: { switch: pending.id, wakeLead: true, needsUser: false },
    });

    // 没有 approvals:respond 的设备按不了。
    const denied = await call("POST", `/v1/memory/switches/${pending.id}/confirm`, { approve: true }, viewer.accessToken);
    expect(denied.status).toBe(403);
    expect((await call("GET", "/v1/memory")).body.memory.service.embedding).toMatch(/multilingual-e5-large/);

    expect(await call("GET", `/v1/memory/switches/${pending.id}`)).toMatchObject({ status: 200, body: { switch: { id: pending.id, state: "pending" } } });
    const confirmed = await call("POST", `/v1/memory/switches/${pending.id}/confirm`, { approve: true });
    expect(confirmed.status).toBe(200);
    expect(Value.Check(MemorySwitchConfirmResponseSchema, confirmed.body)).toBe(true);
    expect(confirmed.body.switch).toMatchObject({ id: pending.id, state: "applied" });
    expect(confirmed.body.memory.pendingSwitch).toBeNull();
    expect(confirmed.body.memory.service.embedding).toContain("api.example.com");
    expect(memoryRows().find((row) => row.payload.switch === pending.id && row.payload.state === "applied")?.summary)
      .toContain("user via test-web");
    const again = await call("POST", `/v1/memory/switches/${pending.id}/confirm`, { approve: true });
    expect(again).toMatchObject({ status: 409, body: { error: { details: { reason: "not_pending" } } } });

    // 每次变化都让界面重取 /v1/memory。
    const events = listGatewayEvents(db, { afterSeq: -1, bindingId: owner.binding.id, scopes: ["tickets:view"], limit: 1000 })
      .filter((event) => event.type === "snapshot.required" && (event.payload as { resource?: string }).resource === "memory");
    expect(events.length).toBeGreaterThan(2);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("sk-test-123");
  });

  // 2026-10-16 发布评审：Keychain 里有 TYPESAFE key 时，开记忆不能悄悄开外部 rerank。设置页和 Lead 的卡片都拿到同样的事实。
  it("asks before recall goes to the decision model, over HTTP and through Lead's inbox", async () => {
    const harness = memoryHarness(dir);
    harness.setExternalSecret("TYPESAFE_API_KEY", "ts-keychain");
    const { call } = await boot(harness);
    await call("POST", "/v1/memory/settings", { embedding: { mode: "local" } });
    harness.downloads().finish("intfloat/multilingual-e5-large");
    await vi.waitFor(async () => expect((await call("GET", "/v1/memory")).body.memory.pendingSwitch).not.toBeNull());
    const { memory } = (await call("GET", "/v1/memory")).body;
    expect(Value.Check(MemoryResponseSchema, { memory })).toBe(true);
    expect(memory.service.embedding).toBe("本地 intfloat/multilingual-e5-large");
    expect(memory.reranker).toMatchObject({ effective: "none", external: { host: "api.typesafe.ai", maxCandidates: 50 } });
    expect(memory.pendingSwitch.dataFlows).toEqual([{ kind: "rerank", host: "api.typesafe.ai", maxCandidates: 50 }]);
    expect(memoryRows().find((row) => row.payload.state === "pending")).toMatchObject({
      payload: { switch: memory.pendingSwitch.id, wakeLead: true }, summary: expect.stringMatching(/最多 50 条记忆片段发给 api\.typesafe\.ai/),
    });
    const confirmed = await call("POST", `/v1/memory/switches/${memory.pendingSwitch.id}/confirm`, { approve: true });
    expect(confirmed.body.memory.reranker.effective).toBe("decision");
  });

  it("refuses a bad URL with the strict error shape", async () => {
    const harness = memoryHarness(dir);
    const { call } = await boot(harness);
    const refused = await call("POST", "/v1/decision-model/settings", { baseUrl: "https://user:pass@decide.example.com" });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "invalid_request", details: { reason: "invalid_url" } } } });
    expect(refused.body.error.message).toMatch(/用户名或密码/);
  });

  it("keeps the decision-model key write-only, and hands the Lead's SmartModel the current key", async () => {
    const harness = memoryHarness(dir);
    const { call } = await boot(harness);
    // Lead 拿到的是直觉的整条分工（设置 → 模型，2026-10-29）。旧路由改的是分工里的主用那一条。
    expect(factoryArgs.decisionModel()).toEqual([]);
    harness.setExternalSecret("TYPESAFE_API_KEY", "from-keychain");
    expect(factoryArgs.decisionModel()).toEqual([{ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "from-keychain", keyHost: "api.typesafe.ai" }]);
    expect((await call("GET", "/v1/decision-model")).body.decisionModel).toMatchObject({ apiKeySet: true, apiKeySource: "external" });
    const saved = await call("POST", "/v1/decision-model/settings", { model: "decision-1", apiKey: "dec-secret" });
    expect(saved).toMatchObject({ status: 200, body: { decisionModel: { baseUrl: "https://api.typesafe.ai", model: "decision-1", apiKeySet: true, apiKeySource: "settings" } } });
    expect(Value.Check(DecisionModelResponseSchema, saved.body)).toBe(true);
    expect(JSON.stringify((await call("GET", "/v1/decision-model")).body)).not.toContain("dec-secret");
    // 设置页存的 key 优先于 Keychain，不用重建 Lead 会话。
    expect(factoryArgs.decisionModel()).toEqual([{ baseUrl: "https://api.typesafe.ai", model: "decision-1", apiKey: "dec-secret", keyHost: "api.typesafe.ai" }]);
    expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
    // 删掉设置页存的 key 以后，退回 Keychain 里的那一个；Keychain 里也没有时才没有 key。
    expect((await call("POST", "/v1/decision-model/settings", { apiKey: null })).body.decisionModel)
      .toMatchObject({ apiKeySet: true, apiKeySource: "external" });
    expect(factoryArgs.decisionModel()?.[0]?.apiKey).toBe("from-keychain");
    harness.setExternalSecret("TYPESAFE_API_KEY", null);
    expect((await call("GET", "/v1/decision-model")).body.decisionModel).toMatchObject({ apiKeySet: false, apiKeySource: null });
    expect(factoryArgs.decisionModel()).toEqual([]);
  });

  // 设置 → 记忆的摘要模型（spec D16）：页面读 /v1/memory/hindsight，改动走通用的操作入口，和 Lead 的 perform_action 是同一个函数。
  // 改了以后 config.json、service.json、secrets.sealed 都变，记忆服务重启；key 只在 secrets.sealed 里。
  it("reads the summary models and changes one through the action route, restarting the memory service", async () => {
    const harness = memoryHarness(dir);
    const { call, viewer } = await boot(harness);
    await call("POST", "/v1/memory/settings", { embedding: { mode: "local" } });
    harness.downloads().finish("intfloat/multilingual-e5-large");
    await vi.waitFor(async () => expect((await call("GET", "/v1/memory")).body.memory.service.embedding).toMatch(/multilingual-e5-large/));

    const read = await call("GET", "/v1/memory/hindsight");
    expect(read.status).toBe(200);
    expect(Value.Check(MemoryHindsightResponseSchema, read.body)).toBe(true);
    expect(read.body.hindsight.summaryModels).toEqual([
      { slot: "default", model: "vibeproxy/claude-haiku-5-5", source: "auto", setting: null, problem: null },
      { slot: "consolidation", model: "vibeproxy/claude-haiku-5-5", source: "inherit", setting: null, problem: null },
    ]);
    expect(read.body.hindsight.writes).toMatchObject({ failed: 0 });
    // 现在失效着的事实（2026-10-29）：最近失效的在前，恢复了的不列。
    expect(read.body.hindsight.invalidated).toEqual([]);
    const noteId = saveNote(db, { title: "住址", content: "用户住在杭州", tags: [], kind: "fact" });
    const fact = { bankIndex: "hindsight.x", documentId: `note-${noteId}`, reason: "搬到上海了", actor: "lead", origin: "user" } as const;
    recordMemoryInvalidation(db, { ...fact, memoryId: "m-1", action: "invalidated", text: "用户住在杭州" });
    recordMemoryInvalidation(db, { ...fact, memoryId: "m-2", action: "invalidated", text: "用户在杭州上班", actor: "user", reason: "换工作了" });
    recordMemoryInvalidation(db, { ...fact, memoryId: "m-1", action: "restored", text: "用户住在杭州" });
    const listed = await call("GET", "/v1/memory/hindsight");
    expect(Value.Check(MemoryHindsightResponseSchema, listed.body)).toBe(true);
    expect(listed.body.hindsight.invalidated).toEqual([{
      memoryId: "m-2", text: "用户在杭州上班", note: { id: noteId, title: "住址" }, external: false, reason: "换工作了", actor: "user",
      at: expect.stringMatching(/Z$/),
    }]);

    const before = harness.launchctl.length;
    const changed = await call("POST", "/v1/actions/memory_settings/memory/set_summary_model", {
      input: { slot: "consolidation", model: "anthropic/claude-sonnet-5-5" },
    });
    expect(changed.status).toBe(200);
    expect(harness.launchctl.slice(before)).toContain("bootstrap");
    expect(loadPlcConfig(dir).memory?.llm).toEqual({ consolidation: "anthropic/claude-sonnet-5-5" });
    expect(readServiceFile(dir)?.consolidationLlm).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("anthropic-key");
    expect((await call("GET", "/v1/memory/hindsight")).body.hindsight.summaryModels[1]).toMatchObject({ source: "settings", model: "anthropic/claude-sonnet-5-5" });
    // 没有 tickets:create 的设备看得到，改不了。
    const readOnly = createLoopbackBinding(db, { name: "read-only", scopes: ["tickets:view"] });
    expect((await call("GET", "/v1/memory/hindsight", undefined, readOnly.accessToken)).status).toBe(200);
    expect((await call("POST", "/v1/actions/memory_settings/memory/set_summary_model", { input: { slot: "default", model: null } }, readOnly.accessToken)).status).toBe(403);
    expect(viewer.accessToken).toBeTruthy();
  });
});
