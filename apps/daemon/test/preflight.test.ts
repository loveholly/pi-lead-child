// 工单 05 的测试：preflight（spec D2）。派发 claim 时、创建 Run 之前，内核用 RuntimeProfile 检查目标。
// 检查不通过时，不创建 Run，不创建工作区，请求挂起，结果写进健康账本。
// 这些测试走 Seam 1：编排器 tick、dispatcher claim、runItem，真实 SQLite。
// adapter 用真实的类，可执行文件换成 fake CLI（Seam 2 的进程边界）。通知从 gateway 的 HTTP 接口读。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningChildren, spawnItemChild } from "@pi-lead-child/lead";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import { runItem } from "@pi-lead-child/engine";
import { createOrchestrator } from "@pi-lead-child/engine";
import { createRuntimePreflight } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, listInbox } from "@pi-lead-child/store";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { PiRuntime } from "@pi-lead-child/runtime";
import { packageSource } from "@pi-lead-child/core";
import { createWorkspace, transitionWorkspace } from "@pi-lead-child/store";
import { runtimeProfileHash } from "@pi-lead-child/runtime";
import { typedFailure } from "@pi-lead-child/runtime";
import { createHealthRecovery } from "@pi-lead-child/engine";
import { recordProbeResult } from "@pi-lead-child/store";
import type { AgentRuntime } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { readGatewayNotifications } from "@pi-lead-child/gateway/testing";

// 2026-10-15 起配置类故障先交给 Lead（异常先交给 Lead，需要用户介入时才强提醒）：用户不收通知，
// Lead 收到一条故障说明。每次故障仍然只有一条。
function leadIncidentNotes(db: Db): string[] {
  return listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "runtime_incident").map((row) => row.summary);
}
import { tempDir } from "@pi-lead-child/core/testing";

const dbs: Db[] = [];

// 这些测试数 claim 和 Run，看的是 preflight。fake CLI 正常结束时不调用 ticket_update，
// 工单 09 会为这样的 Run 排一个修复回合，它会多占一次 claim、多建一个 Run。所以本文件关闭修复回合。
beforeEach(() => { vi.stubEnv("PLC_OUTCOME_REPAIR_LIMIT", "0"); });

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.unstubAllEnvs();
});

const FAKE_CODEX = ["--import", "tsx", resolve("packages/runtime/testing/fake-codex.ts")];
const TSX = resolve("node_modules/.bin/tsx");
// Claude 的 child 以工单的工作目录为 cwd。用 tsx 启动 fake CLI，"--import tsx" 在那里解析不到。
const FAKE_CLAUDE = [resolve("packages/runtime/testing/fake-claude.ts")];

function codexAdapter(env: Record<string, string> = {}): CodexRuntime {
  return new CodexRuntime({ bin: process.execPath, prefixArgs: FAKE_CODEX, env });
}

// 一个脚本形式的 pi：入口文件用 `#!/usr/bin/env node`，所属包声明 engines。
// adapter 的 PATH 上第一个 node 是一个只会报版本的假 node。
// 工单 10 之后，pi 由 daemon 自己的 Node 运行，preflight 检查的是 daemon 的 Node，PATH 上的 node 不起作用。
function scriptPi(childNodeVersion: string, engines = ">=22.19.0"): { adapter: PiRuntime; childNode: string } {
  const root = tempDir("plc-pf-pi-");
  const pkg = join(root, "pi-coding-agent");
  const bin = join(root, "bin");
  mkdirSync(pkg);
  mkdirSync(bin);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "pi-coding-agent", version: "1.1.0", engines: { node: engines },
  }));
  const cli = join(pkg, "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('1.1.0');\n");
  chmodSync(cli, 0o755);
  const childNode = join(bin, "node");
  writeFileSync(childNode, `#!/bin/sh\necho ${childNodeVersion}\n`);
  chmodSync(childNode, 0o755);
  return { adapter: new PiRuntime({ bin: cli, env: { PATH: `${bin}:/usr/bin:/bin` } }), childNode };
}

function claudeAdapter(env: Record<string, string> = {}): ClaudeRuntime {
  return new ClaudeRuntime({ bin: TSX, prefixArgs: FAKE_CLAUDE, env: { FAKE_CLAUDE_SCENARIO: "happy", ...env } });
}

// 一个真实的派发环境。adapters 是这个 daemon 里执行各 runtime 的 adapter。
function harness(
  adapters: Partial<Record<RuntimeId, AgentRuntime>>,
  options: { now?: () => Date; ttlMs?: number } = {},
) {
  const dir = tempDir("plc-preflight-");
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  dbs.push(db);
  const adapterOf = (id: RuntimeId): AgentRuntime => {
    const adapter = adapters[id];
    if (!adapter) throw new Error(`test has no ${id} adapter`);
    return adapter;
  };
  const preflight = createRuntimePreflight(db, {
    runtime: adapterOf, runtimes: Object.keys(adapters) as RuntimeId[], now: options.now, ttlMs: options.ttlMs,
  });
  const claims: number[] = [];
  const orchestrator = createOrchestrator(db, {
    dataDir: dir,
    preflight,
    onDispatch: async (claim) => {
      claims.push(claim.runId);
      await runItem(db, claim.itemId, {
        dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`),
        prompt: "work", role: claim.role, purpose: claim.purpose, runId: claim.runId,
        runtime: adapterOf(claim.runtime), runtimeId: claim.runtime,
        model: claim.model ?? undefined, lingerMs: 0,
      });
    },
  });
  const dispatch = async (input: { itemId: number; runtime: RuntimeId; model?: string; key: string }) => {
    const requestId = orchestrator.dispatcher.request({
      itemId: input.itemId, role: "executor", purpose: "execution",
      runtime: input.runtime, model: input.model, trigger: "test", idempotencyKey: input.key,
    });
    await orchestrator.tick();
    await orchestrator.tick();
    return requestId;
  };
  return { db, dir, orchestrator, preflight, dispatch, claims };
}

const runsOf = (db: Db, itemId: number) =>
  db.prepare("SELECT id, state, runtime, model FROM runs WHERE item_id=? ORDER BY id").all(itemId);
const workspacesOf = (db: Db, itemId: number) =>
  db.prepare("SELECT id FROM workspaces WHERE owner_item_id=?").all(itemId);
const requestOf = (db: Db, id: number) => db.prepare(
  "SELECT state, suspended_reason, suspended_incident_id FROM dispatch_requests WHERE id=?",
).get(id) as { state: string; suspended_reason: string | null; suspended_incident_id: number | null };

describe("a model that does not belong to the runtime", () => {
  // 回归测试：run 63 把 openai/gpt-5.4-mini 交给了 Claude。旧代码照样创建并启动 Run。
  it("creates no Run when Claude receives openai/gpt-5.4-mini, and suspends the request", async () => {
    const { db, dispatch, claims } = harness({ claude: claudeAdapter() });
    const itemId = createItem(db, {
      title: "historical item 77", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });

    const requestId = await dispatch({ itemId, runtime: "claude", model: "openai/gpt-5.4-mini", key: "replay:63" });

    expect(claims).toEqual([]);
    expect(runsOf(db, itemId)).toEqual([]);
    expect(workspacesOf(db, itemId)).toEqual([]);
    const request = requestOf(db, requestId);
    expect(request.state).toBe("pending");
    expect(request.suspended_reason).toContain("Claude Code 不支持该模型（openai/gpt-5.4-mini）");
    // 模型级故障：只挂起这个模型。Lead 收到一条说明，用户不收通知。
    expect(db.prepare("SELECT level, model, code, opened_run_id FROM runtime_incidents").all()).toEqual([
      { level: "model", model: "openai/gpt-5.4-mini", code: "model_unsupported", opened_run_id: null },
    ]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(leadIncidentNotes(db)).toEqual([expect.stringMatching(/^Claude Code 不支持该模型（openai\/gpt-5\.4-mini）：派发已挂起/)]);
  });
});

// 每个检查项没通过时：没有 Run 行，没有工作区行，请求挂起，结果写进账本，用户收到一条通知。
describe("each preflight check that fails", () => {
  const workdir = () => tempDir("plc-pf-wd-");

  async function refusedBy(runtime: RuntimeId, adapter: AgentRuntime, model?: string) {
    const { db, dispatch, claims } = harness({ [runtime]: adapter });
    const itemId = createItem(db, { title: "preflight", brief: "b", createdBy: "user", workdir: workdir() });
    const requestId = await dispatch({ itemId, runtime, model, key: `preflight:${runtime}` });
    expect(claims).toEqual([]);
    expect(runsOf(db, itemId)).toEqual([]);
    expect(workspacesOf(db, itemId)).toEqual([]);
    const request = requestOf(db, requestId);
    expect(request.state).toBe("pending");
    expect(request.suspended_incident_id).not.toBeNull();
    const incidents = db.prepare(
      "SELECT level, scope, needs, code, evidence, opened_run_id FROM runtime_incidents",
    ).all() as Array<{ level: string; scope: string; needs: string; code: string; evidence: string; opened_run_id: null }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ level: "profile", scope: "runtime", needs: "config", opened_run_id: null });
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(leadIncidentNotes(db)).toHaveLength(1);
    return { db, itemId, request, incident: incidents[0]! };
  }

  it("refuses a missing executable", async () => {
    const codex = new CodexRuntime({ bin: join(tmpdir(), "plc-no-such-dir", "codex") });
    const { incident, request } = await refusedBy("codex", codex);
    expect(incident.code).toBe("executable_missing");
    expect(request.suspended_reason).toContain("Codex 启动失败");
  });

  it("refuses an executable whose version command fails", async () => {
    const { incident } = await refusedBy("codex", new CodexRuntime({ bin: "/usr/bin/false" }));
    expect(incident.code).toBe("runtime_start_failed");
  });

  it("refuses a missing extension file", async () => {
    const pi = new PiRuntime({
      bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")],
      ticketToolsExtension: packageSource("engine", "extension", "missing-tools.ts"),
    });
    const { incident, request } = await refusedBy("pi", pi, "openai/gpt-5.5");
    expect(incident.code).toBe("extension_missing");
    expect(incident.evidence).toContain("missing-tools.ts");
    expect(request.suspended_reason).toContain("扩展文件不存在");
  });

  // 工单 10：pi 由 daemon 的 Node 运行，preflight 检查的就是它。PATH 上的 node 满足要求也没有用。
  // 这里让 pi 要求一个 daemon 的 Node 达不到的版本，PATH 上的假 node 报的版本却满足要求。
  it("refuses a pi that the daemon's Node is too old for, whatever node comes first on PATH", async () => {
    const { adapter } = scriptPi("v99.0.0", ">=99.0.0");
    expect(adapter.profile.interpreter).toEqual({ command: "node", path: process.execPath, engines: ">=99.0.0" });
    const { incident, request } = await refusedBy("pi", adapter, "openai/gpt-5.5");
    expect(incident.code).toBe("interpreter_mismatch");
    expect(incident.evidence).toContain(`${process.execPath} 是 ${process.version}`);
    expect(incident.evidence).toContain(">=99.0.0");
    expect(request.suspended_reason).toContain("Node 版本");
  });

  it("refuses an item whose workspace cannot launch, without touching the ledger", async () => {
    const { db, dispatch, claims } = harness({ codex: codexAdapter() });
    const coding = createItem(db, { title: "coding", brief: "b", createdBy: "user", workflowKind: "coding" });
    const broken = createItem(db, { title: "broken workspace", brief: "b", createdBy: "user", workdir: workdir() });
    const workspace = createWorkspace(db, {
      ownerItemId: broken, mode: "shared", kind: "primary", path: workdir(), projectId: null, state: "requested",
    });
    transitionWorkspace(db, workspace.id, "failed");

    const codingRequest = await dispatch({ itemId: coding, runtime: "codex", model: "gpt-5.5", key: "coding" });
    const brokenRequest = await dispatch({ itemId: broken, runtime: "codex", model: "gpt-5.5", key: "broken" });

    expect(claims).toEqual([]);
    expect(runsOf(db, coding)).toEqual([]);
    expect(runsOf(db, broken)).toEqual([]);
    expect(workspacesOf(db, coding)).toEqual([]);
    expect(requestOf(db, codingRequest)).toMatchObject({ state: "pending", suspended_incident_id: null });
    expect(requestOf(db, codingRequest).suspended_reason).toContain("没有可用的工作区");
    expect(requestOf(db, brokenRequest).suspended_reason).toContain(`工作区 #${workspace.id} 处于 failed 状态`);
    // 工作区是工单自己的事：不开故障，同一个 profile 上的其他工单照常派发。每条请求一条 blocker，先交给 Lead。
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 0 });
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload))
      .map((payload) => `${payload.blockerCode}:${payload.needsUser}`)).toEqual([
      "dispatch_preflight_workspace:false", "dispatch_preflight_workspace:false",
    ]);
  });
});

// 每个 Run 记录它用的 profile hash（spec D2，用户故事 21）。
describe("the profile hash on each Run", () => {
  it("is recorded when the dispatcher claims a Run and when a Run is started directly", async () => {
    const codex = codexAdapter();
    const { db, dir, dispatch } = harness({ codex });
    const claimed = createItem(db, {
      title: "claimed", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    await dispatch({ itemId: claimed, runtime: "codex", model: "gpt-5.5", key: "claimed" });
    const direct = createItem(db, {
      title: "direct", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    await runItem(db, direct, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", "direct"),
      prompt: "work", runtime: codex, runtimeId: "codex", model: "gpt-5.5", lingerMs: 0,
    });

    const hashes = db.prepare("SELECT item_id, runtime_profile_hash FROM runs ORDER BY id").all();
    expect(hashes).toEqual([
      { item_id: claimed, runtime_profile_hash: runtimeProfileHash(codex.profile) },
      { item_id: direct, runtime_profile_hash: runtimeProfileHash(codex.profile) },
    ]);
    expect(runtimeProfileHash(codex.profile)).toMatch(/^[0-9a-f]{16}$/);
  });
});

// 安装检查按 profile hash 缓存，带有效期（spec D2）。有效期内派发不重复跑版本命令。
// 检查超时说明不了 Run 会失败，例如系统第一次扫描新的可执行文件。preflight 只挂起确定会失败的请求。
describe("an install check that times out", () => {
  it("does not block the claim or open an incident", async () => {
    const codex = codexAdapter();
    const slow: AgentRuntime = {
      id: "codex", capabilities: codex.capabilities, profile: codex.profile, start: (request) => codex.start(request),
      preflight: async () => ({
        ok: false, checks: ["codex --version"], timedOut: true,
        failure: typedFailure("runtime_start_failed", { errorCode: "probe_failed", message: "codex --version 超时" }),
      }),
    };
    const { db, dispatch, claims } = harness({ codex: slow });
    const itemId = createItem(db, {
      title: "slow", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    await dispatch({ itemId, runtime: "codex", model: "gpt-5.5", key: "slow" });
    expect(claims).toHaveLength(1);
    expect(runsOf(db, itemId)).toEqual([expect.objectContaining({ state: "finished" })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 0 });
  });
});

describe("the preflight cache", () => {
  it("runs the install checks once per profile within the time to live, then again after it", async () => {
    const dir = tempDir("plc-pf-cache-");
    const log = join(dir, "argv.jsonl");
    const versionRuns = () => (existsSync(log) ? readFileSync(log, "utf8") : "")
      .trim().split("\n").filter((line) => line === JSON.stringify(["--version"])).length;
    let clock = Date.parse("2026-10-10T00:00:00.000Z");
    const { db, dispatch, claims } = harness(
      { codex: codexAdapter({ FAKE_PROBE_LOG: log }) },
      { now: () => new Date(clock), ttlMs: 60_000 },
    );
    const item = () => createItem(db, {
      title: "cached", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });

    const first = item();
    await dispatch({ itemId: first, runtime: "codex", model: "gpt-5.5", key: "first" });
    const second = item();
    clock += 59_000;
    await dispatch({ itemId: second, runtime: "codex", model: "gpt-5.5", key: "second" });
    // 两个 Run 都创建了，版本命令只跑了一次。
    expect(claims).toHaveLength(2);
    expect(runsOf(db, first)).toEqual([expect.objectContaining({ state: "finished" })]);
    expect(runsOf(db, second)).toEqual([expect.objectContaining({ state: "finished" })]);
    expect(versionRuns()).toBe(1);

    clock += 2_000;
    await dispatch({ itemId: item(), runtime: "codex", model: "gpt-5.5", key: "third" });
    expect(claims).toHaveLength(3);
    expect(versionRuns()).toBe(2);
  });
});

// preflight 开启的故障和 Run 开启的故障一样恢复（工单 04）：探针通过就关闭故障，挂起的请求放行（2026-10-20 去掉了金丝雀）。
// 放行的请求要先过 preflight。它没过时，账本并回刚关闭的那次故障，用户和 Lead 不会收到第二条说明。
describe("preflight and health recovery", () => {
  const HOUR = 3_600_000;

  async function extensionOutage() {
    const extension = join(tempDir("plc-pf-ext-"), "ticket-tools.ts");
    const pi = new PiRuntime({ bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], ticketToolsExtension: extension });
    const env = harness({ pi });
    const first = createItem(env.db, {
      title: "historical item 38", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    const second = createItem(env.db, {
      title: "historical item 40", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    const firstRequest = await env.dispatch({ itemId: first, runtime: "pi", model: "openai/gpt-5.5", key: "replay:14" });
    const secondRequest = await env.dispatch({ itemId: second, runtime: "pi", model: "openai/gpt-5.5", key: "replay:15" });
    const incident = env.db.prepare("SELECT id FROM runtime_incidents").get() as { id: number };
    return { ...env, pi, extension, first, second, firstRequest, secondRequest, incidentId: incident.id };
  }

  const incidentState = (db: Db, id: number) => db.prepare(
    "SELECT closed_at IS NOT NULL AS closed, probe_failures FROM runtime_incidents WHERE id=?",
  ).get(id);

  it("suspends every request on the profile after one preflight failure, with one notification", async () => {
    const { db, claims, firstRequest, secondRequest, incidentId } = await extensionOutage();
    expect(claims).toEqual([]);
    expect(requestOf(db, firstRequest)).toMatchObject({ state: "pending", suspended_incident_id: incidentId });
    expect(requestOf(db, secondRequest)).toMatchObject({ state: "pending", suspended_incident_id: incidentId });
    expect(leadIncidentNotes(db)).toHaveLength(1);
  });

  it("reopens the incident without a second note when a released request still fails preflight", async () => {
    const { db, orchestrator, claims, incidentId } = await extensionOutage();
    // 探针通过（例如用户手动重检时扩展文件刚好在），故障关闭；但 claim 时扩展文件仍然缺失。
    recordProbeResult(db, incidentId, { ok: true, detail: null, at: new Date() });
    expect(incidentState(db, incidentId)).toEqual({ closed: 1, probe_failures: 0 });

    await orchestrator.tick();

    expect(claims).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(incidentState(db, incidentId)).toEqual({ closed: 0, probe_failures: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 1 });
    expect(leadIncidentNotes(db)).toHaveLength(1);
  });

  it("keeps a foreign model suspended: the recovery probe applies the same model rule", async () => {
    const claude = claudeAdapter();
    const { db, dispatch } = harness({ claude });
    const itemId = createItem(db, {
      title: "historical item 77", brief: "b", createdBy: "user", workdir: tempDir("plc-pf-wd-"),
    });
    await dispatch({ itemId, runtime: "claude", model: "openai/gpt-5.4-mini", key: "replay:63" });
    const incident = db.prepare("SELECT id FROM runtime_incidents").get() as { id: number };
    const recovery = createHealthRecovery(db, { runtime: () => claude, now: () => new Date(Date.now() + 2 * HOUR) });

    // Claude 的版本命令和登录状态都正常，但这个模型永远不属于 Claude：探针不通过，故障不关闭。
    expect(await recovery.tick()).toEqual({ closed: [] });
    expect(incidentState(db, incident.id)).toEqual({ closed: 0, probe_failures: 1 });
    expect((db.prepare("SELECT last_probe_error FROM runtime_incidents").get() as { last_probe_error: string })
      .last_probe_error).toContain("model_unsupported");
  });

  it("releases every suspended request once the probe passes after the fix", async () => {
    const { db, orchestrator, pi, extension, claims, first, second, incidentId } = await extensionOutage();
    writeFileSync(extension, "export default {};\n");
    const recovery = createHealthRecovery(db, { runtime: () => pi, now: () => new Date(Date.now() + 2 * HOUR) });

    expect(await recovery.tick()).toEqual({ closed: [incidentId] });
    expect(incidentState(db, incidentId)).toMatchObject({ closed: 1 });
    await orchestrator.tick();
    await orchestrator.tick();
    expect(claims).toHaveLength(2);
    expect(runsOf(db, first)).toEqual([expect.objectContaining({ state: "finished" })]);
    expect(runsOf(db, second)).toEqual([expect.objectContaining({ state: "finished" })]);
    // 故障只给 Lead 说过一次。fake pi 不调用 ticket_update，所以两个 Run 各有一条"交接失败"，那与本工单无关。
    expect(leadIncidentNotes(db)).toHaveLength(1);
  });
});

// lead 的 spawn_child、用户的"开始"、trigger 和孤儿重派直接启动 child，不经过派发队列（工单 03 的偏离）。
// preflight 已经知道会失败的目标，它们也不创建 Run，改为排一个派发请求，由 claim 挂起并通知。
describe("starting a child outside the dispatch queue", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("queues the request instead of creating a Run when the preflight already knows it fails", async () => {
    vi.stubEnv("PLC_CLAUDE_BIN", process.execPath);
    const claude = claudeAdapter();
    const { db, dir, orchestrator, preflight } = harness({ claude });
    const deps = {
      db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([claude]), preflight,
    };
    await preflight.refresh();
    const foreign = createItem(db, {
      title: "foreign model", brief: "b", createdBy: "user", runtime: "claude", model: "openai/gpt-5.4-mini",
      workdir: tempDir("plc-pf-wd-"),
    });
    const healthy = createItem(db, {
      title: "healthy", brief: "b", createdBy: "user", runtime: "claude", model: "claude-opus-5",
      workdir: tempDir("plc-pf-wd-"),
    });

    const message = spawnItemChild(deps, foreign, {});
    expect(message).toContain("没有 Run 在跑");
    expect(runsOf(db, foreign)).toEqual([]);
    await orchestrator.tick();
    expect(db.prepare(
      "SELECT trigger, state, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests WHERE item_id=?",
    ).all(foreign)).toEqual([{ trigger: "spawn-suspended", state: "pending", suspended: 1 }]);
    expect(runsOf(db, foreign)).toEqual([]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(leadIncidentNotes(db)).toEqual([expect.stringMatching(/^Claude Code 不支持该模型（openai\/gpt-5\.4-mini）：派发已挂起/)]);

    // 已经确认能启动的目标照旧直接启动。
    expect(spawnItemChild(deps, healthy, {})).toContain("child spawned");
    await Promise.allSettled([...runningChildren().values()]);
    expect(runsOf(db, healthy)).toEqual([expect.objectContaining({ state: "finished", model: "claude-opus-5" })]);
  });
});
