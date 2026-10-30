// Lead 的 SmartModel：LLM 兜底用哪个模型（Haiku 优先），以及 suggest_route 工具走完整的账本路径：
// 健康账本里不可用的 runtime 不进候选，建议写进决策日志，日志里没有 brief 原文。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import {
  appendBody, createItem, createRun, openDb, recordDecisionModelCall, recordRuntimeHealthFailure, summarizeSystemUsage, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { typedFailure, type RuntimeCapabilities } from "@pi-lead-child/runtime";
import {
  createSmartModel,
  setModelCatalogForTesting,
  smartModelDecisionLogPath,
  type ModelCatalog,
  type RuntimeCatalog,
} from "@pi-lead-child/engine";
import { normalizeLeadModelConfig } from "../src/model-config.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";
import {
  configuredLeadModelSpecs,
  createLeadSmartModel,
  isValidSmartModelSpec,
  newestModelSpec,
  selectSmartModelSpec,
} from "../src/smart-model.js";
import { childRuntimeProfile, createLeadTools, type LeadDeps } from "../src/tools.js";

const CONFIG = normalizeLeadModelConfig({
  providers: {
    acme: { baseUrl: "http://127.0.0.1:1/v1", discover: false, models: ["gpt-5.5"] },
    vibeproxy: { baseUrl: "http://127.0.0.1:2/v1", discover: false, models: ["claude-sonnet-5", "claude-haiku-5-5"] },
  },
  models: ["acme/gpt-5.5"],
}, {});

describe("selectSmartModelSpec", () => {
  const configuredSpecs = configuredLeadModelSpecs(CONFIG);

  it("prefers a valid PLC_SMART_MODEL", () => {
    expect(selectSmartModelSpec({ env: { PLC_SMART_MODEL: "acme/gpt-5.4-mini" }, configuredSpecs, leadSpec: "acme/gpt-5.5" }))
      .toEqual({ spec: "acme/gpt-5.4-mini", source: "env", note: null });
  });

  it("ignores a malformed PLC_SMART_MODEL with a note and takes the first configured haiku", () => {
    expect(selectSmartModelSpec({ env: { PLC_SMART_MODEL: "haiku" }, configuredSpecs, leadSpec: "acme/gpt-5.5" }))
      .toEqual({ spec: "vibeproxy/claude-haiku-5-5", source: "config", note: expect.stringContaining("provider/model") });
  });

  it("falls back to the Lead's own model without a haiku", () => {
    expect(selectSmartModelSpec({ env: {}, configuredSpecs: ["acme/gpt-5.5"], leadSpec: "acme/gpt-5.5" }))
      .toEqual({ spec: "acme/gpt-5.5", source: "lead", note: null });
  });

  // 实测 vibeproxy discover 出来的顺序里，claude-haiku-4-5-20251001 排在 claude-haiku-5-5 前面，以前选到了旧的。
  it("picks the newest haiku, not the first one the provider lists", () => {
    const discovered = [
      "vibeproxy/claude-3-5-haiku-20241022", "vibeproxy/claude-haiku-4-5-20251001", "vibeproxy/claude-haiku-5-5",
      "vibeproxy/claude-haiku-5-5-20260901",
    ];
    expect(selectSmartModelSpec({ env: {}, configuredSpecs: discovered, leadSpec: "x/y" }).spec).toBe("vibeproxy/claude-haiku-5-5");
    expect(newestModelSpec([])).toBeNull();
  });

  it("matches haiku in the model id, not in the provider name", () => {
    expect(selectSmartModelSpec({ env: {}, configuredSpecs: ["haiku-proxy/gpt-5.5", "p/Claude-Haiku-4"], leadSpec: "x/y" }).spec)
      .toBe("p/Claude-Haiku-4");
  });

  it("validates the provider/model format", () => {
    for (const spec of ["vibeproxy/claude-haiku-5-5", "a/b/c"]) expect(isValidSmartModelSpec(spec)).toBe(true);
    for (const spec of ["haiku", "/haiku", "a/", "a b/c", "a/b c"]) expect(isValidSmartModelSpec(spec)).toBe(false);
  });

  it("lists discovered models after the configured ones", () => {
    expect(configuredLeadModelSpecs(CONFIG, (provider) => (provider === "acme" ? ["gpt-5.5", "claude-haiku-6"] : [])))
      .toEqual(["acme/gpt-5.5", "acme/claude-haiku-6", "vibeproxy/claude-sonnet-5", "vibeproxy/claude-haiku-5-5"]);
  });
});

// 假的 ModelRuntime：只认 registered 里的模型，completeSimple 返回 reply。
function fakeRuntime(registered: string[], reply: { text?: string; stopReason?: string; errorMessage?: string }) {
  const calls: Array<{ model: string; prompt: string }> = [];
  const runtime = {
    getModels: (provider: string) => registered
      .filter((spec) => spec.startsWith(`${provider}/`))
      .map((spec) => ({ provider, id: spec.slice(provider.length + 1) })),
    getModel: (provider: string, id: string) =>
      registered.includes(`${provider}/${id}`) ? { provider, id } : undefined,
    completeSimple: async (model: { provider: string; id: string }, context: { messages: Array<{ content: string }> }) => {
      calls.push({ model: `${model.provider}/${model.id}`, prompt: context.messages[0]!.content });
      return {
        stopReason: reply.stopReason ?? "stop",
        errorMessage: reply.errorMessage,
        content: [{ type: "text", text: reply.text ?? "" }],
      };
    },
  };
  return { runtime: runtime as never, calls };
}

const YES_NO = { ok: { type: "yes_no", prompt: "Is it fine?" } } as const;

describe("createLeadSmartModel", () => {
  it("uses the configured haiku through the Lead's model runtime when no Jev key is set", async () => {
    const { runtime, calls } = fakeRuntime(["acme/gpt-5.5", "vibeproxy/claude-haiku-5-5"], { text: '{"ok": {"yes": true}}' });
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"), env: {},
    });
    expect(built.llmSpec).toBe("vibeproxy/claude-haiku-5-5");
    expect(built.smartModel?.backend).toBe("llm");
    const decision = await built.smartModel!.decide("state", YES_NO);
    expect(decision).toMatchObject({ backend: "llm", model: "vibeproxy/claude-haiku-5-5" });
    expect(calls.map((call) => call.model)).toEqual(["vibeproxy/claude-haiku-5-5"]);
  });

  it("puts the decision model in front when it has a key, and ignores TYPESAFE_API_KEY in the environment", () => {
    const { runtime } = fakeRuntime(["vibeproxy/claude-haiku-5-5"], {});
    const fromEnv = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"),
      env: { TYPESAFE_API_KEY: "tsk-test" },
    });
    expect(fromEnv.smartModel?.backend).toBe("llm");
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"),
      decisionModel: () => ({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "tsk-test", keyHost: "api.typesafe.ai" }),
    });
    expect(built.smartModel?.backend).toBe("jev→llm");
  });

  it("falls back to the Lead model when the chosen spec is not registered", () => {
    const { runtime } = fakeRuntime(["acme/gpt-5.5"], {});
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"),
      env: { PLC_SMART_MODEL: "vibeproxy/claude-haiku-9" },
    });
    expect(built.llmSpec).toBe("acme/gpt-5.5");
    expect(built.notes).toEqual([expect.stringContaining("vibeproxy/claude-haiku-9 is not registered")]);
  });

  // 2026-10-16 发布评审：决策模型不能用的说明，以前在 backend 那一行之后才进 notes，日志里看不到原因。
  // 不能用的配置是 key 绑定的主机和地址对不上。http 地址从 2026-10-26 起可以用（cbb14ce0，公司网关只有 http）。
  it("reports why the decision model is not used before the backend line, and later notes as they happen", () => {
    const { runtime } = fakeRuntime(["vibeproxy/claude-haiku-5-5"], {});
    let baseUrl = "https://decide.example.com";
    const lines: string[] = [];
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"), env: {},
      decisionModel: () => ({ baseUrl, model: "jev-latest", apiKey: "tsk-test", keyHost: "keys.example.com" }),
      onNote: (note) => lines.push(note),
    });
    // session.ts 建好以后打的那一行。
    lines.push(`smart model: ${built.smartModel?.backend ?? "none"}`);
    expect(lines).toEqual([expect.stringContaining("bound to another host than decide.example.com"), "smart model: llm"]);
    // 会话中途换成另一个对不上的地址：说明照样送到 onNote。
    baseUrl = "https://other.example.com";
    expect(built.smartModel?.backend).toBe("llm");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("bound to another host than other.example.com");
  });

  // slack-takeover 工单 07：同一个便宜模型的自由文本补全交出来（以前只在 SmartModel 里面用），每次调用按用途记用量。
  it("exposes the cheap model as a free-text completion that records each call under its purpose", async () => {
    const store = openDb(join(tempDir("plc-lead-smart-"), "plc.db"));
    let reply: { text?: string; stopReason?: string; errorMessage?: string } = { text: '{"topic": "发布", "facts": []}' };
    const calls: Array<{ model: string; prompt: string }> = [];
    const runtime = {
      ...(fakeRuntime(["vibeproxy/claude-haiku-5-5"], {}).runtime as object),
      completeSimple: async (model: { provider: string; id: string }, context: { messages: Array<{ content: string }> }) => {
        calls.push({ model: `${model.provider}/${model.id}`, prompt: context.messages[0]!.content });
        return { stopReason: reply.stopReason ?? "stop", errorMessage: reply.errorMessage, content: [{ type: "text", text: reply.text ?? "" }] };
      },
    };
    const built = createLeadSmartModel({
      modelRuntime: runtime as never, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"), env: {},
      onCall: (call) => recordDecisionModelCall(store, call),
    });
    expect(await built.complete!("整理这个线程", { purpose: "channel_memory" })).toBe('{"topic": "发布", "facts": []}');
    expect(calls).toEqual([{ model: "vibeproxy/claude-haiku-5-5", prompt: "整理这个线程" }]);
    reply = { stopReason: "error", errorMessage: "429 rate limited" };
    await expect(built.complete!("再整理一次", { purpose: "channel_memory" })).rejects.toThrow(/429 rate limited/);
    const usage = summarizeSystemUsage(store, { component: "decision_model" }).components[0]!;
    expect(usage.byPurpose).toEqual([{ name: "channel_memory", calls: 2, failures: 1 }]);
    expect(usage.byBackend).toEqual([{ name: "llm", calls: 2, failures: 1 }]);
    store.close();
  });

  it("has no free-text completion without an LLM backend", () => {
    const { runtime } = fakeRuntime([], {});
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"), env: {},
    });
    expect(built.llmSpec).toBeNull();
    expect(built.complete).toBeNull();
  });

  it("turns a model error into a backend failure", async () => {
    const { runtime } = fakeRuntime(["vibeproxy/claude-haiku-5-5"], { stopReason: "error", errorMessage: "429 rate limited" });
    const built = createLeadSmartModel({
      modelRuntime: runtime, config: CONFIG, leadSpec: "acme/gpt-5.5", dataDir: tempDir("plc-lead-smart-"), env: {},
    });
    await expect(built.smartModel!.decide("state", YES_NO)).rejects.toThrow(/429 rate limited/);
  });
});

const caps = (review: boolean): RuntimeCapabilities => ({
  streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: review,
});

const CATALOG: RuntimeCatalog = {
  entries: (["codex", "claude", "pi"] as RuntimeId[]).map((id) => ({
    id, available: true, executable: `/bin/${id}`, defaultModel: null, models: [],
    capabilities: caps(id === "codex"), reason: null,
  })),
};

const MODELS: ModelCatalog = {
  refreshedAt: null,
  runtimes: [
    {
      runtime: "codex", state: "known", source: "test", account: null, freeformModelPattern: null, refreshedAt: null, error: null,
      cliDefaultModel: "gpt-5.5", efforts: ["low", "medium", "high"],
      models: [
        { id: "gpt-5.5", label: "gpt-5.5", efforts: ["low", "medium", "high"], defaultEffort: null, note: null },
        { id: "gpt-5.4-mini", label: "gpt-5.4-mini", efforts: ["low", "medium"], defaultEffort: null, note: null },
      ],
    },
    {
      runtime: "claude", state: "known", source: "test", account: null, freeformModelPattern: null, refreshedAt: null, error: null,
      cliDefaultModel: null, efforts: ["low", "high"],
      models: [{ id: "opus", label: "opus", efforts: ["low", "high"], defaultEffort: null, note: null }],
    },
  ],
};

describe("suggest_route tool", () => {
  let db: Db;
  let dir: string;

  beforeEach(() => {
    dir = tempDir("plc-suggest-route-");
    db = openDb(join(dir, "plc.db"));
    setModelCatalogForTesting(MODELS);
  });

  afterEach(() => {
    setModelCatalogForTesting(null);
    db.close();
  });

  function tool(deps: LeadDeps) {
    return createLeadTools(deps).find((candidate: any) => candidate.name === "suggest_route") as any;
  }

  // 2026-10-16 发布评审：发给决策模型（外部端点）之前，brief、工单标题和正文里像密钥的字符串要盖掉。
  it("redacts token-shaped strings in the brief and the ticket before they reach the decision model", async () => {
    const githubToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const openaiKey = "sk-" + "proj-abcdEFGH1234ijklMNOP5678";
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    const itemId = createItem(db, { title: `Rotate ${openaiKey}`, brief: `The old token was ${githubToken}`, createdBy: "user" });
    const sent: Array<{ url: string; body: string }> = [];
    deps.smartModel = createSmartModel({
      decisionModel: () => ({ baseUrl: "https://decide.example.com", model: "jev-latest", apiKey: "dec-key", keyHost: "decide.example.com" }),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), body: String(init?.body) });
        return new Response("{}", { status: 503 });
      }) as typeof fetch,
    });
    await tool(deps).execute("call", { brief: `Push with ${githubToken} after the review`, ticket_id: itemId });
    expect(sent.map((request) => request.url)).toEqual(["https://decide.example.com/v1/systemone"]);
    expect(sent[0]!.body).not.toContain(githubToken);
    expect(sent[0]!.body).not.toContain(openaiKey);
    expect(sent[0]!.body).toContain("Push with");
    expect(sent[0]!.body).toContain("Rotate");
  });

  // 2026-10-16 发布评审：正文摘录先截断再脱敏时，跨在 1,500 字处的 token 只剩前缀，脱敏规则认不出它。
  it("masks a token that straddles the ticket body cut before it reaches the decision model", async () => {
    const githubToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const body = `${"x".repeat(1_479)} ${githubToken} and the rest of the body`;
    expect(body.indexOf(githubToken)).toBe(1_480);
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    const itemId = createItem(db, { title: "Rotate the deploy token", brief: "b", createdBy: "user" });
    appendBody(db, itemId, body);
    const sent: string[] = [];
    deps.smartModel = createSmartModel({
      decisionModel: () => ({ baseUrl: "https://decide.example.com", model: "jev-latest", apiKey: "dec-key", keyHost: "decide.example.com" }),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push(String(init?.body));
        return new Response("{}", { status: 503 });
      }) as typeof fetch,
    });
    await tool(deps).execute("call", { brief: "Rotate it", ticket_id: itemId });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(githubToken.slice(4, 12));
    const excerpt = (JSON.parse(sent[0]!).state as string).split("\n").find((line) => line.startsWith("xxx"))!;
    expect(excerpt.length).toBeLessThanOrEqual(1_500);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("is read-only, quiet, and mentioned in the Lead prompt", () => {
    expect(LEAD_QUIET_TOOLS.has("suggest_route")).toBe(true);
    expect(LEAD_SYSTEM_PROMPT).toContain("suggest_route");
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    expect(Object.keys(tool(deps).parameters.properties)).toEqual(["brief", "role", "ticket_id"]);
  });

  it("drops an unhealthy runtime, asks the SmartModel among the rest, and logs the decision without the brief", async () => {
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    const itemId = createItem(db, { title: "Fix the flaky dispatcher test", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "claude", model: "opus" });
    updateRun(db, runId, { state: "finished", endedAt: true });
    recordRuntimeHealthFailure(db, {
      profile: childRuntimeProfile(deps, "pi"), model: null,
      failure: typedFailure("auth_required", { errorCode: null, message: "login expired" }), itemId, runId: null,
    });

    const prompts: string[] = [];
    deps.smartModel = createSmartModel({
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          effort: { level: 2 }, task_kind: { choice: "coding" }, route: { choice: "codex/gpt-5.5" }, independent_review: { yes: true },
        });
      },
      completeModel: "vibeproxy/claude-haiku-5-5",
      logPath: smartModelDecisionLogPath(dir),
    });

    const result = await tool(deps).execute("call", { brief: "BRIEF-MARKER refactor the dispatcher", ticket_id: itemId });
    const suggestion = JSON.parse(result.content[0].text);
    expect(suggestion).toMatchObject({
      role: "executor",
      runtime: { value: "codex" },
      model: { value: "gpt-5.5" },
      effort: { value: "high" },
      independentReview: { advisable: true },
      taskKind: { value: "coding" },
      backend: "llm",
      backendModel: "vibeproxy/claude-haiku-5-5",
      // 排除原因写具体的故障（2026-10-19）：以前只写 "unavailable in the runtime health ledger"，看不出是什么故障。
      excluded: [{ runtime: "pi", reason: expect.stringMatching(/^Pi agent 认证失败（故障 #\d+）。需要用户重新登录 Pi agent。/) }],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Fix the flaky dispatcher test");
    expect(prompts[0]).toContain('"codex/gpt-5.5"');
    expect(prompts[0]).not.toContain('"pi/');

    const log = readFileSync(smartModelDecisionLogPath(dir), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({ purpose: "route", backend: "llm", questions: expect.arrayContaining(["route", "effort"]) });
    expect(log[0]).not.toContain("BRIEF-MARKER");
    expect(log[0]).not.toContain("flaky dispatcher");
  });

  // 2026-10-20：任何 runtime 都能当核查员，能跑命令的 codex 排在最前面，其余不再排除。
  it("tells a reviewer route about the executor and offers every runtime, codex first", async () => {
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    const itemId = createItem(db, { title: "Ship the cache", brief: "b", createdBy: "user" });
    createRun(db, { itemId, runtime: "claude", model: "opus" });
    const prompts: string[] = [];
    deps.smartModel = createSmartModel({
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ effort: { level: 1 }, task_kind: { choice: "review" }, route: { choice: "codex/gpt-5.4-mini" } });
      },
    });
    const result = await tool(deps).execute("call", { brief: "verify it", role: "reviewer", ticket_id: itemId });
    const suggestion = JSON.parse(result.content[0].text);
    expect(suggestion).toMatchObject({
      role: "reviewer", runtime: { value: "codex" }, model: { value: "gpt-5.4-mini" },
      effort: { value: "medium" }, independentReview: null,
    });
    expect(suggestion.excluded).toEqual([]);
    expect(suggestion.candidates.map((item: { runtime: string }) => item.runtime)).toEqual(["codex", "claude", "pi"]);
    expect(prompts[0]).toContain("The executor ran on runtime claude, model opus.");
  });

  it("works without a SmartModel and changes no state", async () => {
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeCatalog: CATALOG };
    const before = db.prepare("SELECT (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM activities) + (SELECT COUNT(*) FROM runs) AS n").get();
    const result = await tool(deps).execute("call", { brief: "tidy the docs" });
    const suggestion = JSON.parse(result.content[0].text);
    expect(suggestion).toMatchObject({ runtime: { value: "codex" }, backend: null });
    expect(suggestion.notes[0]).toMatch(/not configured/);
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM activities) + (SELECT COUNT(*) FROM runs) AS n").get())
      .toEqual(before);
  });
});
