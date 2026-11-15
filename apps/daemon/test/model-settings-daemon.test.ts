// 设置 → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）：走完整的路径。页面读 GET /v1/models/settings，
// 改动走通用的操作入口（POST /v1/actions/model_settings/models/<操作>），和 Lead 的 perform_action 是同一个函数。
// 换了大脑的主用：Lead 空闲时马上在会话里换，config.json 的 lead.models 是整条分工；页面收到 snapshot.required（model-settings）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { MODEL_SETTINGS_RESOURCE, ModelSettingsDtoSchema, serviceUrlHost } from "@pi-lead-child/protocol";
import { LegacyModelSettingsResponseSchema } from "@pi-lead-child/client/testing";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { fileKeySource, lazyVault } from "@pi-lead-child/connections";
import { loadLeadModelConfig, registerLeadProviders } from "@pi-lead-child/lead";
import { providerSecretName } from "../src/model-settings.js";
import { SealedSecrets } from "../src/sealed-secrets.js";
import { startDaemon } from "../src/server.js";
import { memoryHarness } from "./memory-fakes.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let vibeproxy: Server | null = null;
let vibeproxyUrl: string;
// 拉目录时带的 Authorization 头（没带时是 null）。
let catalogAuth: Array<string | null> = [];
const sockets: WebSocket[] = [];

async function startVibeproxy(): Promise<string> {
  vibeproxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname !== "/v1/models" || url.searchParams.has("client_version")) { res.statusCode = 404; res.end("{}"); return; }
    catalogAuth.push(req.headers.authorization ?? null);
    res.end(JSON.stringify({
      data: [
        { id: "claude-sonnet-5", owned_by: "anthropic", created: 1_780_000_000 },
        { id: "as4/claude-sonnet-5-5", owned_by: "anthropic", created: 1_790_553_600 },
        { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
      ],
    }));
  });
  await new Promise<void>((resolve) => vibeproxy!.listen(0, "127.0.0.1", resolve));
  const address = vibeproxy.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
}

beforeEach(async () => {
  dir = tempDir("plc-model-settings-daemon-");
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  catalogAuth = [];
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vibeproxyUrl = await startVibeproxy();
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { vibeproxy: { baseUrl: vibeproxyUrl, discover: true } },
      models: ["vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high"],
    },
  }));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  await new Promise<void>((resolve) => (vibeproxy ? vibeproxy.close(() => resolve()) : resolve()));
  vibeproxy = null;
  vi.unstubAllEnvs();
});

function stubLead() {
  const switched: string[] = [];
  let refreshes = 0;
  const factory = async () => ({
    modelName: "vibeproxy/claude-sonnet-5",
    models: ["vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high"],
    switchModel: async (spec: string) => { switched.push(spec); },
    refreshProviders: async (): Promise<string[] | void> => { refreshes += 1; },
    smartModelLlm: "vibeproxy/gemini-3.8-flash-high",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {},
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, switched, refreshes: () => refreshes };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { events, http };
}

const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const act = (action: string, input: unknown) => ["POST", `/v1/actions/model_settings/models/${action}`, { input }] as const;

describe("settings → models through the gateway", () => {
  it("reads both chains and the catalog, sets a new brain chain, and Lead switches at once", async () => {
    const lead = stubLead();
    const { http, events } = await start(lead);
    const read = await http("GET", "/v1/models/settings");
    expect(read.status).toBe(200);
    expect(Value.Check(ModelSettingsDtoSchema, read.body.modelSettings)).toBe(true);
    expect(read.body.modelSettings.brain.providers[0].models.map((model: any) => model.id))
      .toEqual(["as4/claude-sonnet-5-5", "claude-sonnet-5", "gemini-3.8-flash-high"]);
    expect(read.body.modelSettings.fast).toMatchObject({ chain: ["jev"], effectiveLlm: "vibeproxy/gemini-3.8-flash-high" });

    const set = await http(...act("set_brain_chain", { models: [
      { model: "vibeproxy/as4/claude-sonnet-5-5", effort: null },
      { model: "vibeproxy/claude-sonnet-5", effort: null },
    ] }));
    expect(set.status).toBe(200);
    expect(set.body.result).toMatchObject({ applied: "now" });
    expect(lead.switched).toEqual(["vibeproxy/as4/claude-sonnet-5-5"]);
    expect(config().lead.models).toEqual(["vibeproxy/as4/claude-sonnet-5-5", "vibeproxy/claude-sonnet-5"]);
    await vi.waitFor(() => expect(events.some((event) => event.type === "snapshot.required" && event.payload?.resource === MODEL_SETTINGS_RESOURCE)).toBe(true));
    const after = await http("GET", "/v1/models/settings");
    expect(after.body.modelSettings.brain.current).toEqual({ model: "vibeproxy/as4/claude-sonnet-5-5", effort: null });
  });

  it("refuses a chain with four backups at the gateway, before anything changes", async () => {
    const lead = stubLead();
    const { http } = await start(lead);
    const five = ["a", "b", "c", "d", "e"].map((id) => ({ model: `vibeproxy/${id}`, effort: null }));
    const refused = await http(...act("set_brain_chain", { models: five }));
    expect(refused.status).toBe(400);
    expect(lead.switched).toEqual([]);
    expect(config().lead.models).toEqual(["vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high"]);
  });

  it("saves a provider with its key sealed, re-registers Lead's providers, and keeps the key out of config.json and the ledger", async () => {
    const lead = stubLead();
    const { http } = await start(lead);
    const saved = await http(...act("save_provider", { name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-secret-0123456789" }));
    expect(saved.status).toBe(200);
    expect(config().lead.providers.openai).toEqual({ discover: true, baseUrl: "https://api.openai.com/v1", api: "openai-completions" });
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("sk-secret");
    const ledger = db.prepare("SELECT payload FROM events WHERE kind = 'ui_action.performed'").all() as Array<{ payload: string }>;
    expect(ledger.map((row) => row.payload).join("\n")).not.toContain("sk-secret");
    expect(lead.refreshes()).toBe(1);
  });

  // 工单 #181：设置页存的 key 只在保险库里，config.json 没写 apiKey。daemon 启动时 Lead 第一次注册服务商、拉目录就要带上它，
  // 不能等设置页再存一次（providersChanged → refreshProviders）。假的会话工厂像真的 createLeadSession 一样在被调用时注册服务商。
  it("registers a provider with the key stored on the settings page the first time Lead starts", async () => {
    // 测试 daemon 的保险库密钥在数据目录的 connections.key：先用同一个文件存好 key，再启动。
    new SealedSecrets<string>(db, lazyVault(fileKeySource(join(dir, "connections.key"))))
      .set(providerSecretName("vibeproxy"), { value: "sk-vault-0123456789", host: serviceUrlHost(vibeproxyUrl) });
    expect(config().lead.providers.vibeproxy.apiKey).toBeUndefined();
    const lead = stubLead();
    const registered: Record<string, string | undefined> = {};
    const runtime = { registerProvider: (name: string, input: { apiKey?: string }) => { registered[name] = input.apiKey; } };
    const factory = async () => {
      await registerLeadProviders(runtime as never, loadLeadModelConfig(dir), {});
      return lead.factory();
    };
    await start({ ...lead, factory });
    expect(registered).toEqual({ vibeproxy: "sk-vault-0123456789" });
    expect(catalogAuth[0]).toBe("Bearer sk-vault-0123456789");
    expect(lead.refreshes()).toBe(0);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("sk-vault");
  });

  // 回归：分工里在用的服务商启动时拉不到目录（key 错），以前 daemon 起不来、被反复重启，网页和 Slack 都连不上。
  // 现在 daemon 照常起来，Lead 一开始就是降级，顶栏写着要检查账号，技术详情里有服务商的名字。
  it("starts with Lead degraded when the chosen provider's catalog failed, naming the provider", async () => {
    const lead = stubLead();
    const factory = lead.factory;
    lead.factory = async () => ({
      ...(await factory()),
      modelUnavailable: "vibeproxy: model catalog failed (Error: GET http://127.0.0.1:9/v1/models failed: 401 Unauthorized)",
    });
    const { http } = await start(lead);
    const overview = await http("GET", "/v1/overview?include=lead");
    expect(overview.body.lead).toMatchObject({ state: "degraded", failures: 1, detail: expect.stringContaining("vibeproxy") });
  });

  // 回归：启动时服务商拉不到目录（例如本机代理还没起来）以后，以前整个 daemon 运行期间都不再拉，
  // 那个服务商的模型一直按缺省（128K、只看文字）注册。现在按退避再拉，拉到为止，拉到以后正在用的模型再挂一次。
  it("retries a chosen provider whose catalog failed at start until it comes back, then rebinds the model", async () => {
    vi.stubEnv("PLC_LEAD_PROVIDER_RETRY_MS", "30");
    const lead = stubLead();
    const factory = lead.factory;
    let refreshes = 0;
    lead.factory = async () => ({
      ...(await factory()),
      providersUnavailable: ["vibeproxy"],
      refreshProviders: async () => {
        refreshes += 1;
        return refreshes < 3 ? ["vibeproxy"] : [];
      },
    });
    await start(lead);
    await vi.waitFor(() => expect(lead.switched).toEqual(["vibeproxy/claude-sonnet-5"]), { timeout: 10_000 });
    expect(refreshes).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refreshes).toBe(3);
  });

  // 审阅：重拉本身抛错（例如 config.json 正被手改、读不出来）以后，以前不再排下一次，那个服务商一直按缺省注册。
  it("keeps retrying a missing catalog after a refresh that threw", async () => {
    vi.stubEnv("PLC_LEAD_PROVIDER_RETRY_MS", "30");
    const lead = stubLead();
    const factory = lead.factory;
    let refreshes = 0;
    lead.factory = async () => ({
      ...(await factory()),
      providersUnavailable: ["vibeproxy"],
      refreshProviders: async () => {
        refreshes += 1;
        if (refreshes === 1) throw new Error("config.json is not valid JSON");
        return [];
      },
    });
    await start(lead);
    await vi.waitFor(() => expect(lead.switched).toEqual(["vibeproxy/claude-sonnet-5"]), { timeout: 10_000 });
    expect(refreshes).toBe(2);
  });

  // 第二轮审阅：重拉时只拉还缺目录的服务商（拉得到目录的不再拉，一次抖动不会把它换成缺省的注册）；
  // 正在用的模型的服务商拉到了就再挂，不等一直坏着的备用服务商。
  it("re-registers only the providers still missing a catalog, and rebinds once the one in use is back", async () => {
    vi.stubEnv("PLC_LEAD_PROVIDER_RETRY_MS", "30");
    const lead = stubLead();
    const factory = lead.factory;
    const asked: Array<readonly string[] | undefined> = [];
    lead.factory = async () => ({
      ...(await factory()),
      providersUnavailable: ["vibeproxy", "spare"],
      refreshProviders: async (only?: readonly string[]) => {
        asked.push(only);
        // 正在用的 vibeproxy 第二次重拉时回来了，备用的 spare 一直拉不到。
        return asked.length < 2 ? ["vibeproxy", "spare"] : ["spare"];
      },
    });
    await start(lead);
    await vi.waitFor(() => expect(lead.switched).toEqual(["vibeproxy/claude-sonnet-5"]), { timeout: 10_000 });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    expect(asked.slice(0, 3)).toEqual([["vibeproxy", "spare"], ["vibeproxy", "spare"], ["spare"]]);
    expect(lead.switched).toEqual(["vibeproxy/claude-sonnet-5"]);
  });

  it("adds a second decision model and sets the fast chain, mirrored into the old decision fields", async () => {
    const { http } = await start(stubLead());
    const added = await http(...act("save_fast_model", { name: "decision-1", baseUrl: "https://jev.example.com", model: "jev-latest", apiKey: "tsk-1" }));
    expect(added.body.result).toMatchObject({ id: "decision-1" });
    const set = await http(...act("set_fast_chain", { chain: ["decision-1", "jev"] }));
    expect(set.status).toBe(200);
    expect(config().decision).toMatchObject({ baseUrl: "https://jev.example.com", chain: ["decision-1", "jev"] });
    const read = await http("GET", "/v1/models/settings");
    expect(read.body.modelSettings.fast.models.map((model: any) => [model.id, model.apiKeySet])).toEqual([["jev", false], ["decision-1", true]]);
  });

  // 2026-11-06：公司的 LLM 网关只有 http，要 x-gateway-key 头，值是 key 原文。页面存了以后，「测试」按这个头发，不带 Authorization。
  it("saves a decision model behind an http gateway with a custom auth header, and tests it with that header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
    const gateway = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        res.writeHead(req.headers["x-gateway-key"] === "gw-key-0123456789" ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers: { ok: { type: "noul", noul: 0.9 } } }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    try {
      const logs: string[] = [];
      // 「测试直觉」由记忆服务（MemoryController）发请求；daemon 不托管记忆服务时回 409 unavailable。真的 daemon（main.ts）
      // 总是托管它。这里用 memory-fakes 的替身（launchd、Hindsight 的 /health），发往网关的请求走真的 fetch，到上面的假网关。
      const harness = memoryHarness(dir);
      const fakeFetch = harness.hooks.fetch!;
      const routedFetch = ((input: string | URL | Request, init?: RequestInit) =>
        (String(input).startsWith(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/`) ? fetch(input, init) : fakeFetch(input, init))) as typeof fetch;
      daemon = await startDaemon({
        dataDir: dir, dbPath, sessionFactory: stubLead().factory as never, log: (line) => logs.push(line), notifyDesktop: () => {},
        manageMemory: { ...harness.hooks, fetch: routedFetch },
      });
      const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"] }).code);
      const http = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
          method,
          headers: { authorization: `Bearer ${issued.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() as any };
      };
      const baseUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/gw`;
      const added = await http(...act("save_fast_model", { name: "decision-1", baseUrl, model: "decision-1", apiKey: "gw-key-0123456789", authHeader: "x-gateway-key" }));
      expect(added.status).toBe(200);
      const id = added.body.result.id;
      expect(config().decision.models.find((entry: any) => entry.id === id)).toMatchObject({ authHeader: "x-gateway-key" });

      const tested = await http(...act("test_fast_model", { id }));
      expect(tested.status).toBe(200);
      expect(tested.body.result).toMatchObject({ ok: true });
      expect(seen.at(-1)!.url).toBe("/gw/v1/systemone");
      expect(seen.at(-1)!.headers["x-gateway-key"]).toBe("gw-key-0123456789");
      expect(seen.at(-1)!.headers.authorization).toBeUndefined();

      // 新的页面带 grouping=1，拿到鉴权头；旧版 Companion 不带，收到原来的形状。
      const read = await http("GET", "/v1/models/settings?grouping=1");
      expect(Value.Check(ModelSettingsDtoSchema, read.body.modelSettings)).toBe(true);
      expect(read.body.modelSettings.fast.models.find((model: any) => model.id === id).authHeader).toBe("x-gateway-key");
      const legacy = await http("GET", "/v1/models/settings");
      expect(Value.Check(LegacyModelSettingsResponseSchema, legacy.body)).toBe(true);

      expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("gw-key-0123456789");
      expect(JSON.stringify(added.body) + JSON.stringify(tested.body) + JSON.stringify(read.body)).not.toContain("gw-key-0123456789");
      expect(logs.join("\n")).not.toContain("gw-key-0123456789");
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });

  // Lead 模型分组（2026-11-05）：这台假的 vibeproxy 没有详细目录（client_version 回 404），所以 as4/ 先不算账号。
  // 「高级」里把 accountPrefix 打开、保存以后，下一次读设置就按账号分组（目录缓存清掉了）。
  it("sends the grouping fields only on request, and regroups at once after the advanced settings are saved", async () => {
    const { http } = await start(stubLead());
    // 旧版 Companion 不带 grouping=1：收到原来的形状，它的严格 schema 照样接受。
    const legacy = await http("GET", "/v1/models/settings");
    expect(Value.Check(LegacyModelSettingsResponseSchema, legacy.body)).toBe(true);
    expect(legacy.body.modelSettings.brain.providers[0].models[0]).not.toHaveProperty("group");

    const read = await http("GET", "/v1/models/settings?grouping=1");
    expect(Value.Check(ModelSettingsDtoSchema, read.body.modelSettings)).toBe(true);
    expect(Value.Check(LegacyModelSettingsResponseSchema, read.body)).toBe(false);
    const provider = () => read.body.modelSettings.brain.providers[0];
    expect(provider()).toMatchObject({ accountPrefix: null, accountPrefixActive: false, capabilities: "auto", catalog: "plain" });
    expect(provider().models.map((model: any) => [model.id, model.group, model.source])).toEqual([
      ["as4/claude-sonnet-5-5", null, "anthropic"],
      ["claude-sonnet-5", null, "anthropic"],
      ["gemini-3.8-flash-high", null, "antigravity"],
    ]);

    const saved = await http(...act("save_provider", {
      name: "vibeproxy", baseUrl: vibeproxyUrl, api: "openai-completions", accountPrefix: true, capabilities: "plain",
    }));
    expect(saved.status).toBe(200);
    expect(config().lead.providers.vibeproxy).toMatchObject({ accountPrefix: true, capabilities: "plain" });
    const after = await http("GET", "/v1/models/settings?grouping=1");
    expect(after.body.modelSettings.brain.providers[0]).toMatchObject({ accountPrefix: true, accountPrefixActive: true, capabilities: "plain" });
    expect(after.body.modelSettings.brain.providers[0].models.find((model: any) => model.id === "as4/claude-sonnet-5-5").group).toBe("as4");

    // 恢复缺省：从 config 里删掉。
    await http(...act("save_provider", { name: "vibeproxy", baseUrl: vibeproxyUrl, api: "openai-completions", accountPrefix: null, capabilities: "auto" }));
    expect(config().lead.providers.vibeproxy.accountPrefix).toBeUndefined();
    expect(config().lead.providers.vibeproxy.capabilities).toBeUndefined();
  });
});
