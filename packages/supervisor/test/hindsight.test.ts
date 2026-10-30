import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  embeddingFingerprint, ensureHindsightService, HINDSIGHT_MISSIONS, hindsightSecretValues, hindsightTuning, maskSecrets, pg0Url, pg0UrlWithPassword, findPostgres, hindsightEnvironment, preparePostgresDatabase, readServiceFile,
  HINDSIGHT_LABEL, HINDSIGHT_RESOLVED_BEFORE, HINDSIGHT_VERSION,
  type CommandRunner, type EnsureHindsightOptions, type HindsightEmbedding, type HindsightServiceFile,
} from "../src/deploy/hindsight.js";
import { DOWNLOAD_SCRIPT, ModelDownloads, type ModelDownloadState } from "../src/deploy/hindsight-models.js";

// Hindsight 记忆服务的托管（src/deploy/hindsight.ts）和本地模型的下载（src/deploy/hindsight-models.ts）。
// 测试不碰真实的 launchd、~/Library/LaunchAgents 和 Hugging Face。

function runner(answers: Record<string, { ok: boolean; out: string }>, calls: string[] = []): CommandRunner {
  return async (bin, args) => {
    const key = `${bin.split("/").pop()} ${args.join(" ")}`;
    calls.push(key);
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return match ? match[1] : { ok: true, out: "" };
  };
}

describe("findPostgres: reuse an installed Postgres instead of installing another", () => {
  const usable = {
    "pg_config --version": { ok: true, out: "PostgreSQL 16.4 (Homebrew)" },
    "pg_config --sharedir": { ok: true, out: "/pg/share" },
    "pg_isready": { ok: true, out: "accepting connections" },
  };

  it("finds a usable server", async () => {
    const found = await findPostgres({ env: {}, binDirs: ["/pg/bin"], exists: (p) => p === "/pg/share/extension/vector.control", run: runner(usable) });
    expect(found.found).toEqual({ binDir: "/pg/bin", port: "5432" });
  });

  it("explains why an installed Postgres cannot be used", async () => {
    const old = await findPostgres({ env: {}, binDirs: ["/pg/bin"], exists: () => true,
      run: runner({ ...usable, "pg_config --version": { ok: true, out: "PostgreSQL 14.9" } }) });
    const noVector = await findPostgres({ env: {}, binDirs: ["/pg/bin"], exists: () => false, run: runner(usable) });
    const stopped = await findPostgres({ env: {}, binDirs: ["/pg/bin"], exists: () => true,
      run: runner({ ...usable, "pg_isready": { ok: false, out: "no response" } }) });
    expect([old, noVector, stopped].map((d) => d.found)).toEqual([null, null, null]);
    expect(old.reasons[0]).toMatch(/older than 15/);
    expect(noVector.reasons[0]).toMatch(/brew install pgvector/);
    expect(stopped.reasons[0]).toMatch(/no server/);
  });

  it("creates the database and the vector extension once", async () => {
    const calls: string[] = [];
    const url = await preparePostgresDatabase({ binDir: "/pg/bin", port: "5432" }, "plc_hindsight_ab12cd34", runner({}, calls));
    expect(url).toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/plc_hindsight_ab12cd34$/);
    expect(calls).toContain("createdb -h 127.0.0.1 -p 5432 plc_hindsight_ab12cd34");
    const again: string[] = [];
    await preparePostgresDatabase({ binDir: "/pg/bin", port: "5432" }, "plc_hindsight_ab12cd34",
      runner({ "psql -h 127.0.0.1 -p 5432 -d postgres": { ok: true, out: "1" } }, again));
    expect(again.some((call) => call.startsWith("createdb"))).toBe(false);
    await expect(preparePostgresDatabase({ binDir: "/pg/bin", port: "5432" }, "x; drop", runner({}))).rejects.toThrow(/safe database name/);
  });
});

const E5_REVISION = "3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3";
const LOCAL: HindsightEmbedding = {
  provider: "local", model: "intfloat/multilingual-e5-large", revision: E5_REVISION,
  path: `/hf/hub/models--intfloat--multilingual-e5-large/snapshots/${E5_REVISION}`,
};
const LLM = { provider: "vibeproxy", baseUrl: "http://127.0.0.1:8317/v1", model: "claude-haiku-5-5" };
const SECRETS = { apiKey: "uuid-key", databasePassword: "pg-password-123" };
const REMOTE: HindsightEmbedding = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: null };

describe("ensureHindsightService: a launchd job of its own, restarted only when its desired state changes", () => {
  function setup() {
    const dataDir = tempDir("plc-hindsight-");
    const plistPath = join(dataDir, "LaunchAgents", `${HINDSIGHT_LABEL}.plist`);
    const calls: string[][] = [];
    let loaded = false;
    const launchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") return { ok: loaded, out: "" };
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return { ok: true, out: "" };
    };
    const base: EnsureHindsightOptions = {
      dataDir, plistPath, launchctl, env: {}, log: () => {}, uvx: "/Users/u/.local/bin/uvx",
      programArguments: ["/usr/local/bin/node", "/repo/apps/daemon/dist/hindsight.mjs"],
      embedding: LOCAL, reranker: { provider: "none" }, llm: LLM, secretsVersion: 1,
      findPostgres: async () => ({ found: null, reasons: [] }),
    };
    return { dataDir, plistPath, calls, base, setLoaded: (value: boolean) => { loaded = value; } };
  }

  it("installs once, then leaves a running service alone on every daemon start", async () => {
    const { plistPath, calls, base } = setup();
    expect(await ensureHindsightService(base)).toMatchObject({ url: "http://127.0.0.1:47188", restarted: true });
    expect(calls.map((args) => args[0])).toEqual(["print", "bootstrap"]);
    calls.length = 0;
    expect(await ensureHindsightService(base)).toMatchObject({ restarted: false });
    expect(calls.map((args) => args[0])).toEqual(["print"]);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toMatch(/api[_-]?key/i);
  });

  it("hot-reloads on a reranker, LLM or secrets change, and keeps the index when the embedding is the same", async () => {
    const { calls, base } = setup();
    const first = await ensureHindsightService(base);
    for (const change of [
      { reranker: { provider: "typesafe" as const, baseUrl: "https://api.typesafe.ai", model: "jev-latest", maxCandidates: 50 } },
      { llm: { ...LLM, model: "claude-haiku-6" } },
      { secretsVersion: 2 },
      // 日志调优项经 service.json 带给 hindsight-main：改了就重启。
      { env: { HINDSIGHT_API_LOG_LEVEL: "debug" } },
    ]) {
      calls.length = 0;
      const next = await ensureHindsightService({ ...base, ...change });
      // bootout 之后先用 print 确认任务卸载完了，再 bootstrap。
      expect(calls.map((args) => args[0])).toEqual(["print", "bootout", "print", "bootstrap"]);
      expect(next?.index).toBe(first?.index);
    }
  });

  // 2026-10-26：launchctl bootout 发出停止信号就返回，Hindsight（uvx、Python、Postgres）要几秒才卸载完。
  // 卸载完之前 bootstrap 会失败（Bootstrap failed: 5: Input/output error），确认切换时设置页收到 500，服务也没有再起来。
  it("waits until bootout has unloaded the job before bootstrapping it again", async () => {
    const { calls, base } = setup();
    await ensureHindsightService(base);
    // 任务在跑；bootout 之后还要被 print 看到三次才卸载完，卸载完之前 bootstrap 失败。
    let loaded = true;
    let unloading = 0;
    const waits: number[] = [];
    const launchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") {
        if (unloading > 0 && --unloading === 0) loaded = false;
        return { ok: loaded, out: "" };
      }
      if (args[0] === "bootout") { unloading = 3; return { ok: true, out: "" }; }
      if (args[0] === "bootstrap") {
        if (loaded) return { ok: false, out: "Bootstrap failed: 5: Input/output error" };
        loaded = true;
      }
      return { ok: true, out: "" };
    };
    calls.length = 0;
    const next = await ensureHindsightService({ ...base, secretsVersion: 2, launchctl, sleep: async (ms) => { waits.push(ms); } });
    expect(next).toMatchObject({ restarted: true });
    expect(calls.map((args) => args[0])).toEqual(["print", "bootout", "print", "print", "print", "bootstrap"]);
    expect(waits.length).toBeGreaterThan(0);
  });

  it("retries a bootstrap that fails although the job is gone, and says why when it never comes up", async () => {
    const { calls, base } = setup();
    let failures = 2;
    const flaky = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") return { ok: false, out: "" };
      if (args[0] === "bootstrap" && failures > 0) { failures -= 1; return { ok: false, out: "Bootstrap failed: 5: Input/output error" }; }
      return { ok: true, out: "" };
    };
    expect(await ensureHindsightService({ ...base, launchctl: flaky, sleep: async () => {} })).toMatchObject({ restarted: true });
    expect(calls.filter((args) => args[0] === "bootstrap")).toHaveLength(3);

    const broken = async (args: string[]) => (args[0] === "bootstrap"
      ? { ok: false, out: "Bootstrap failed: 5: Input/output error" } : { ok: args[0] !== "print", out: "" });
    await expect(ensureHindsightService({ ...base, secretsVersion: 3, launchctl: broken, sleep: async () => {} }))
      .rejects.toThrow(/launchctl bootstrap com\.pi-lead-child\.hindsight failed after \d+ attempts: Bootstrap failed: 5: Input\/output error/);
  });

  it("pins the embedded Postgres to 127.0.0.1 on its own port", () => {
    expect(pg0Url("ab12cd34")).toBe("pg0://plc-hindsight-ab12cd34:47189?listen_addresses=127.0.0.1");
  });

  // 换 embedding 就换一个新库，索引身份跟着变，notes 从头同步一遍。数据库的种类选定之后不变。
  it("moves to a new database when the embedding changes, and keeps the database kind", async () => {
    const { dataDir, base } = setup();
    const first = await ensureHindsightService(base);
    expect(readServiceFile(dataDir)).toMatchObject<Partial<HindsightServiceFile>>({
      database: { kind: "pg0" }, databaseUrl: pg0Url(embeddingFingerprint(LOCAL)), version: HINDSIGHT_VERSION,
      resolvedBefore: HINDSIGHT_RESOLVED_BEFORE,
    });
    const later = await ensureHindsightService({
      ...base, findPostgres: async () => ({ found: { binDir: "/pg/bin", port: "5432" }, reasons: [] }),
    });
    expect(readServiceFile(dataDir)?.database).toEqual({ kind: "pg0" });
    expect(later?.index).toBe(first?.index);
    const remote = await ensureHindsightService({ ...base, embedding: REMOTE });
    expect(readServiceFile(dataDir)?.databaseUrl).toBe(pg0Url(embeddingFingerprint(REMOTE)));
    expect(remote?.index).not.toBe(first?.index);
  });

  it("creates its database inside an existing Postgres", async () => {
    const { dataDir, base } = setup();
    const prepared: string[] = [];
    await ensureHindsightService({
      ...base,
      findPostgres: async () => ({ found: { binDir: "/pg/bin", port: "5432" }, reasons: [] }),
      preparePostgres: async (_server, name) => { prepared.push(name); return `postgresql://u@127.0.0.1:5432/${name}`; },
    });
    expect(prepared).toEqual([`plc_hindsight_${embeddingFingerprint(LOCAL)}`]);
    expect(readServiceFile(dataDir)?.database).toEqual({ kind: "postgres", binDir: "/pg/bin", port: "5432" });
  });

  it("needs uv to host Hindsight", async () => {
    const { calls, plistPath, base } = setup();
    const lines: string[] = [];
    expect(await ensureHindsightService({ ...base, uvx: null, log: (line) => lines.push(line) })).toBeNull();
    expect(lines[0]).toMatch(/install uv/);
    expect(calls).toEqual([]);
    expect(existsSync(plistPath)).toBe(false);
  });
});

describe("hindsightEnvironment: what hindsight-main gives hindsight-api", () => {
  const service: HindsightServiceFile = {
    version: HINDSIGHT_VERSION, resolvedBefore: HINDSIGHT_RESOLVED_BEFORE, port: 47188, database: { kind: "pg0" },
    databaseUrl: pg0Url("ab12cd34"), embedding: LOCAL, reranker: { provider: "none" }, llm: LLM,
    secretsVersion: 1, tuning: { logLevel: null, logFormat: null }, uvx: "/u/uvx",
  };

  it("binds to loopback with the key, runs the pinned local model offline, and uses the Lead provider for the LLM", () => {
    const { env } = hindsightEnvironment({ service, secrets: { ...SECRETS, llmApiKey: "vibe-key" }, env: {} });
    expect(env).toMatchObject({
      HINDSIGHT_API_HOST: "127.0.0.1", HINDSIGHT_API_PORT: "47188",
      HINDSIGHT_API_TENANT_API_KEY: "uuid-key", HF_HUB_OFFLINE: "1",
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: "local", HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: LOCAL.provider === "local" ? LOCAL.path : "",
      HINDSIGHT_API_RERANKER_PROVIDER: "rrf",
      HINDSIGHT_API_LLM_PROVIDER: "openai", HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:8317/v1",
      HINDSIGHT_API_LLM_MODEL: "claude-haiku-5-5", HINDSIGHT_API_LLM_API_KEY: "vibe-key",
      // 2026-10-16 发布评审：MCP 有自己的 token，observation 要额外的 LLM 调用。
      HINDSIGHT_API_MCP_ENABLED: "false", HINDSIGHT_API_ENABLE_OBSERVATIONS: "false",
    });
    // 本地或者不用 reranker 时不限候选数：候选不离开本机。
    expect(env.HINDSIGHT_API_RERANKER_MAX_CANDIDATES).toBeUndefined();
  });

  // 2026-10-29（spec D13、D16，用户选打开观察整理、缺省加整理观察两个槽）：有 LLM 时打开观察整理；整理观察单独选了模型时
  // 用 Hindsight 的按操作配置（HINDSIGHT_API_CONSOLIDATION_LLM_*），key 是那个服务商的；Python 不攒输出。
  it("turns observations on with an LLM, gives consolidation its own model and key, and keeps Python output unbuffered", () => {
    const sonnet = { provider: "anthropic", baseUrl: "https://api.anthropic.example/v1", model: "claude-sonnet-5-5" };
    const { env, notes } = hindsightEnvironment({
      service: { ...service, observations: true, consolidationLlm: sonnet },
      secrets: { ...SECRETS, llmApiKey: "vibe-key", consolidationLlmApiKey: "anthropic-key" }, env: {},
    });
    expect(env).toMatchObject({
      HINDSIGHT_API_ENABLE_OBSERVATIONS: "true", PYTHONUNBUFFERED: "1",
      HINDSIGHT_API_LLM_MODEL: "claude-haiku-5-5", HINDSIGHT_API_LLM_API_KEY: "vibe-key",
      HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER: "openai", HINDSIGHT_API_CONSOLIDATION_LLM_BASE_URL: sonnet.baseUrl,
      HINDSIGHT_API_CONSOLIDATION_LLM_MODEL: "claude-sonnet-5-5", HINDSIGHT_API_CONSOLIDATION_LLM_API_KEY: "anthropic-key",
    });
    expect(notes).toContain("consolidation LLM anthropic/claude-sonnet-5-5");
    // 整理观察跟缺省一样：不设按操作的变量，Hindsight 用缺省。
    const inherit = hindsightEnvironment({ service: { ...service, observations: true }, secrets: SECRETS, env: {} }).env;
    expect(Object.keys(inherit).filter((name) => name.startsWith("HINDSIGHT_API_CONSOLIDATION_LLM_"))).toEqual([]);
    expect(inherit.HINDSIGHT_API_ENABLE_OBSERVATIONS).toBe("true");
    // 没有 LLM 时整理只会失败：不打开。用户环境里的按操作变量照旧不传。
    const recallOnly = hindsightEnvironment({
      service: { ...service, llm: null, observations: true, consolidationLlm: sonnet }, secrets: SECRETS,
      env: { HINDSIGHT_API_CONSOLIDATION_LLM_MODEL: "gpt-4o" },
    }).env;
    expect(recallOnly).toMatchObject({ HINDSIGHT_API_ENABLE_OBSERVATIONS: "false", HINDSIGHT_API_LLM_PROVIDER: "none" });
    expect(recallOnly.HINDSIGHT_API_CONSOLIDATION_LLM_MODEL).toBeUndefined();
    expect(hindsightSecretValues({ ...SECRETS, consolidationLlmApiKey: "anthropic-key" })).toContain("anthropic-key");
  });

  // 2026-10-29 用户：「我们不是只针对代码任务的」。整理目标改成个人助理的场景；外部来源的范围（origin:external）单独一条规则，
  // 记的是别人说的话。没有 LLM 时不设（不提取、不整理）。
  it("steers extraction and consolidation for a personal assistant, with its own rule for the outside-conversation scope", () => {
    const { env } = hindsightEnvironment({ service: { ...service, observations: true, missions: HINDSIGHT_MISSIONS }, secrets: SECRETS, env: {} });
    expect(env.HINDSIGHT_API_RETAIN_MISSION).toBe(HINDSIGHT_MISSIONS.retain);
    expect(env.HINDSIGHT_API_RETAIN_MISSION).toMatch(/not only coding/);
    expect(env.HINDSIGHT_API_OBSERVATIONS_MISSION).toMatch(/what is true now and what it replaced/);
    expect(JSON.parse(env.HINDSIGHT_API_CONSOLIDATION_STRATEGIES!)).toEqual([
      { scopes: [{ tags: ["origin:external"], tags_match: "exact" }], observations_mission: HINDSIGHT_MISSIONS.external },
    ]);
    const factsOnly = hindsightEnvironment({ service: { ...service, observations: false, missions: HINDSIGHT_MISSIONS }, secrets: SECRETS, env: {} }).env;
    expect(factsOnly.HINDSIGHT_API_RETAIN_MISSION).toBe(HINDSIGHT_MISSIONS.retain);
    expect(factsOnly.HINDSIGHT_API_OBSERVATIONS_MISSION).toBeUndefined();
    const old = hindsightEnvironment({ service, secrets: SECRETS, env: { HINDSIGHT_API_RETAIN_MISSION: "coding only" } }).env;
    expect(old.HINDSIGHT_API_RETAIN_MISSION).toBeUndefined();
  });

  // 2026-10-16 发布评审：pg0 缺省的 hindsight/hindsight 人人都知道。密码只在 secrets.sealed 和子进程的环境里。
  it("gives pg0 a password from the sealed secrets, and keeps it out of service.json", () => {
    const { env } = hindsightEnvironment({ service, secrets: SECRETS, env: {} });
    expect(env.HINDSIGHT_API_DATABASE_URL).toBe("pg0://plc:pg-password-123@plc-hindsight-ab12cd34:47189?listen_addresses=127.0.0.1");
    expect(service.databaseUrl).not.toContain("pg-password-123");
    expect(pg0UrlWithPassword("pg0://x:1", "a/b@c")).toBe("pg0://plc:a%2Fb%40c@x:1");
    expect(pg0UrlWithPassword("postgresql://u@127.0.0.1:5432/db", "p")).toBe("postgresql://u@127.0.0.1:5432/db");
  });

  // 2026-10-16 发布评审：Hindsight 在 info 级别打印带密码的 pg0 地址（hindsight_api/pg0.py "PostgreSQL started: {uri}"）。
  it("logs at warning unless the daemon's tuning says otherwise", () => {
    expect(hindsightEnvironment({ service, secrets: SECRETS, env: {} }).env.HINDSIGHT_API_LOG_LEVEL).toBe("warning");
    const tuned = hindsightEnvironment({ service: { ...service, tuning: { logLevel: "debug", logFormat: "json" } }, secrets: SECRETS, env: {} }).env;
    expect(tuned).toMatchObject({ HINDSIGHT_API_LOG_LEVEL: "debug", HINDSIGHT_API_LOG_FORMAT: "json" });
    const lines: string[] = [];
    expect(hindsightTuning({ HINDSIGHT_API_LOG_LEVEL: " INFO ", HINDSIGHT_API_LOG_FORMAT: "xml" }, (line) => lines.push(line)))
      .toEqual({ logLevel: "info", logFormat: null });
    expect(hindsightTuning({ HINDSIGHT_API_LOG_LEVEL: "verbose" }, (line) => lines.push(line))).toEqual({ logLevel: null, logFormat: null });
    expect(lines).toHaveLength(2);
  });

  it("masks every sealed secret in the output lines, including the password in the pg0 URI", () => {
    const secrets = { ...SECRETS, databasePassword: "p/w+secret=1", embeddingApiKey: "emb-secret-123", llmApiKey: "llm-secret-456", decisionApiKey: "short" };
    const values = hindsightSecretValues(secrets);
    const { env } = hindsightEnvironment({ service, secrets, env: {} });
    const line = `INFO hindsight_api.pg0: PostgreSQL started: ${env.HINDSIGHT_API_DATABASE_URL!.replace("pg0://", "postgresql://")}`;
    const masked = maskSecrets(line, values);
    expect(masked).not.toContain("p/w+secret=1");
    expect(masked).not.toContain(encodeURIComponent("p/w+secret=1"));
    expect(masked).toContain("[REDACTED]");
    expect(maskSecrets("key uuid-key, emb-secret-123 and llm-secret-456", values)).toBe("key [REDACTED], [REDACTED] and [REDACTED]");
    // 太短的值不算，免得误伤普通文字。
    expect(values).not.toContain("short");
  });

  it("uses an OpenAI-compatible remote embedding and the decision model as reranker", () => {
    const { env } = hindsightEnvironment({
      service: { ...service, embedding: { ...REMOTE, dimensions: 1024 }, reranker: { provider: "typesafe", baseUrl: "https://decide.local", model: "decision-1", maxCandidates: 20 } },
      secrets: { ...SECRETS, embeddingApiKey: "emb-key", decisionApiKey: "dec-key" }, env: {},
    });
    expect(env).toMatchObject({
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai", HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: "https://api.openai.com/v1",
      HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: "emb-key", HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: "1024",
      HINDSIGHT_API_RERANKER_PROVIDER: "typesafe", HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL: "https://decide.local",
      HINDSIGHT_API_RERANKER_TYPESAFE_MODEL: "decision-1", HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY: "dec-key",
      // 外部 reranker 每次召回最多收到这么多条候选（2026-10-16 发布评审）。
      HINDSIGHT_API_RERANKER_MAX_CANDIDATES: "20",
    });
  });

  // 2026-10-16 发布评审：白名单，不是黑名单。Hindsight 是第三方的 Python 进程。
  it("passes only allow-listed variables: no daemon secrets, no config env, no HINDSIGHT_API_* outside the tuning keys", () => {
    const { env, notes } = hindsightEnvironment({
      service: { ...service, reranker: { provider: "typesafe", baseUrl: "https://api.typesafe.ai", model: "jev-latest", maxCandidates: 50 } },
      secrets: SECRETS,
      env: {
        PATH: "/usr/bin", HOME: "/Users/u", HTTPS_PROXY: "http://proxy:3128", HF_HOME: "/hf",
        AM_API_KEY: "am-secret", TAVILY_API_KEY: "tv-secret", TYPESAFE_API_KEY: "ts-secret", OPENAI_API_KEY: "oa-secret",
        HINDSIGHT_API_HOST: "0.0.0.0", HINDSIGHT_API_TENANT_EXTENSION: "", HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: "x/y",
        HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: "stale", HINDSIGHT_API_LOG_LEVEL: "debug",
        HINDSIGHT_API_MCP_AUTH_TOKEN: "bypass", HINDSIGHT_API_MCP_ENABLED: "true",
        HINDSIGHT_API_RETAIN_LLM_BASE_URL: "https://elsewhere.example", HINDSIGHT_API_REFLECT_LLM_PROVIDER: "openai",
        HINDSIGHT_API_READ_DATABASE_URL: "postgresql://evil", HINDSIGHT_API_WEBHOOK_URL: "https://hook.example",
        HINDSIGHT_API_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
      },
    });
    expect(env.HINDSIGHT_API_RERANKER_PROVIDER).toBe("rrf");
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/u", HTTPS_PROXY: "http://proxy:3128", HF_HOME: "/hf" });
    // launchd 环境里的 HINDSIGHT_API_LOG_LEVEL 也不用：日志调优项只从 service.json 来，缺省 warning。
    expect(env).toMatchObject({ HINDSIGHT_API_HOST: "127.0.0.1", HINDSIGHT_API_MCP_ENABLED: "false", HINDSIGHT_API_LOG_LEVEL: "warning" });
    expect(env.HINDSIGHT_API_TENANT_EXTENSION).toMatch(/ApiKeyTenantExtension$/);
    expect(env.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL).toBe(LOCAL.provider === "local" ? LOCAL.path : "");
    for (const name of [
      "AM_API_KEY", "TAVILY_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
      "HINDSIGHT_API_MCP_AUTH_TOKEN", "HINDSIGHT_API_RETAIN_LLM_BASE_URL", "HINDSIGHT_API_REFLECT_LLM_PROVIDER",
      "HINDSIGHT_API_READ_DATABASE_URL", "HINDSIGHT_API_WEBHOOK_URL", "HINDSIGHT_API_OTEL_EXPORTER_OTLP_ENDPOINT",
    ]) expect(env[name], name).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/am-secret|tv-secret|ts-secret|oa-secret|bypass|evil/);
    // 只报名字，不报值。
    expect(notes[0]).toMatch(/^ignored 12 HINDSIGHT_API_\* variable\(s\): HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, /);
    expect(notes.join("\n")).not.toContain("bypass");
  });
});

describe("ModelDownloads: download a local model only when asked, resume after a restart", () => {
  const REV = "a".repeat(40);
  const waitFor = (check: () => boolean) => new Promise<void>((resolve) => {
    const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve(); } }, 20);
  });

  // 假的下载脚本：按参数输出 start / progress / verified 或者 error，和 hindsight-download.py 的输出一样。
  // 第三个参数是 commit；没给时假装把 main 解析成 b…b。
  function fakeScript(dir: string): string {
    const path = join(dir, "fake-download.sh");
    writeFileSync(path, `#!/bin/sh
if [ "$1" = "bad/model" ]; then echo '{"event": "error", "message": "no such repo"}'; exit 1; fi
rev="\${3:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
if [ "$1" = "lying/model" ]; then rev="cccccccccccccccccccccccccccccccccccccccc"; fi
echo '{"event": "start", "total": 100, "files": 3, "revision": "'"$rev"'"}'
echo '{"event": "progress", "bytes": 40, "total": 100}'
echo '{"event": "progress", "bytes": 100, "total": 100}'
echo '{"event": "verified", "repo": "'"$1"'", "revision": "'"$rev"'", "path": "/hf/snapshots/'"$rev"'", "total": 100}'
`);
    chmodSync(path, 0o755);
    return path;
  }

  it("records progress, marks a verified model ready at its commit, and records a failure", async () => {
    const dataDir = tempDir("plc-hindsight-");
    const script = fakeScript(dataDir);
    const seen: Array<[string, ModelDownloadState["state"], number]> = [];
    const downloads = new ModelDownloads({
      dataDir, uvx: null, onChange: (repo, state) => seen.push([repo, state.state, state.bytes]),
      command: (repo, kind, revision) => ({ bin: script, args: [repo, kind, ...(revision ? [revision] : [])] }),
    });
    downloads.start("intfloat/multilingual-e5-large", "embedding", REV);
    downloads.start("intfloat/multilingual-e5-large", "embedding", REV);
    await waitFor(() => downloads.ready("intfloat/multilingual-e5-large"));
    expect(downloads.status("intfloat/multilingual-e5-large")).toMatchObject({ state: "ready", bytes: 100, total: 100, kind: "embedding" });
    expect(downloads.snapshot("intfloat/multilingual-e5-large", REV)).toEqual({ revision: REV, path: `/hf/snapshots/${REV}` });
    // 固定的 commit 变了：不算下好。
    expect(downloads.ready("intfloat/multilingual-e5-large", "d".repeat(40))).toBe(false);
    expect(seen.filter(([, state]) => state === "ready")).toHaveLength(1);

    // 用户自己填的 repo：下载时把 main 解析成一个 commit，记下来。
    downloads.start("someone/model", "reranker");
    await waitFor(() => downloads.ready("someone/model"));
    expect(downloads.snapshot("someone/model")?.revision).toBe("b".repeat(40));

    // 下载报出来的 commit 和要的不一样：不算下好。
    downloads.start("lying/model", "reranker", REV);
    await waitFor(() => downloads.status("lying/model")?.state === "failed");
    expect(downloads.status("lying/model")?.error).toMatch(/pinned commit/);

    downloads.start("bad/model", "reranker");
    await waitFor(() => downloads.status("bad/model")?.state === "failed");
    expect(downloads.status("bad/model")?.error).toBe("no such repo");

    // 状态落盘：daemon 重启后还知道哪些下好了。
    const reopened = new ModelDownloads({ dataDir, uvx: null, onChange: () => {}, command: () => ({ bin: script, args: [] }) });
    expect(reopened.ready("intfloat/multilingual-e5-large", REV)).toBe(true);
    expect(() => reopened.start("../etc", "embedding")).toThrow(/Hugging Face model id/);
    expect(() => reopened.start("a/b", "embedding", "main")).toThrow(/commit id/);
  });

  it("runs the download with the same pinned hindsight-api and dependency cutoff as the service, in isolated mode", async () => {
    const dataDir = tempDir("plc-hindsight-");
    const argsFile = join(dataDir, "args.txt");
    const uvx = join(dataDir, "uvx");
    writeFileSync(uvx, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"event": "verified", "revision": "${REV}", "path": "/hf/x", "total": 1}'\n`);
    chmodSync(uvx, 0o755);
    const downloads = new ModelDownloads({ dataDir, uvx, onChange: () => {} });
    downloads.start("intfloat/multilingual-e5-large", "embedding", REV);
    await waitFor(() => downloads.ready("intfloat/multilingual-e5-large"));
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args.slice(0, 6)).toEqual(["--exclude-newer", HINDSIGHT_RESOLVED_BEFORE, "--from", `hindsight-api@${HINDSIGHT_VERSION}`, "python", "-I"]);
    expect(args.slice(-3)).toEqual(["intfloat/multilingual-e5-large", "embedding", REV]);
  });

  it("says what is missing when uv is not installed", () => {
    const downloads = new ModelDownloads({ dataDir: tempDir("plc-hindsight-"), uvx: null, onChange: () => {} });
    downloads.start("BAAI/bge-m3", "embedding");
    expect(downloads.status("BAAI/bge-m3")).toMatchObject({ state: "failed", error: expect.stringMatching(/install uv/) });
  });
});

// hindsight-download.py 选哪些文件（2026-10-16 发布评审：只接受 safetensors，不下 Python 文件）。
// 用本机的 python3 载入脚本，只调它的 wanted_files：huggingface_hub 只在 main 里导入，这里用不到。
describe("hindsight-download.py: safetensors only", () => {
  function pick(entries: Array<[string, number]>): { files: Record<string, number>; problem: string | null } {
    const program = [
      "import importlib.util, json, sys, types",
      `spec = importlib.util.spec_from_file_location("dl", ${JSON.stringify(DOWNLOAD_SCRIPT)})`,
      "dl = importlib.util.module_from_spec(spec); spec.loader.exec_module(dl)",
      "entries = [types.SimpleNamespace(path=p, size=s) for p, s in json.loads(sys.argv[1])]",
      "files, problem = dl.wanted_files(entries)",
      "print(json.dumps({'files': files, 'problem': problem}))",
    ].join("\n");
    const out = execFileSync("python3", ["-I", "-B", "-c", program, JSON.stringify(entries)], { encoding: "utf8" });
    return JSON.parse(out);
  }

  it("takes model.safetensors and the configs, and skips pickles, ONNX and Python files", () => {
    const { files, problem } = pick([
      ["config.json", 1], ["modules.json", 1], ["tokenizer.json", 1], ["sentencepiece.bpe.model", 1],
      ["model.safetensors", 100], ["pytorch_model.bin", 100], ["onnx/model.onnx", 100], ["custom_code.py", 1],
      ["1_Pooling/config.json", 1], ["README.md", 1],
    ]);
    expect(problem).toBeNull();
    expect(Object.keys(files).sort()).toEqual([
      "1_Pooling/config.json", "config.json", "model.safetensors", "modules.json", "sentencepiece.bpe.model", "tokenizer.json",
    ]);
  });

  it("takes sharded safetensors", () => {
    const { files } = pick([["config.json", 1], ["model-00001-of-00002.safetensors", 50], ["model-00002-of-00002.safetensors", 50], ["model.safetensors.index.json", 1]]);
    expect(Object.keys(files).sort()).toEqual(["config.json", "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors", "model.safetensors.index.json"]);
  });

  it("refuses a repo or a module whose weights exist only as pytorch_model.bin", () => {
    expect(pick([["config.json", 1], ["pytorch_model.bin", 100]]).problem).toMatch(/only pytorch_model.bin/);
    expect(pick([["config.json", 1], ["model.safetensors", 100], ["2_Dense/config.json", 1], ["2_Dense/pytorch_model.bin", 5]]).problem)
      .toMatch(/2_Dense\/ has only pytorch_model.bin/);
  });
});
