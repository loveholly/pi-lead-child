// 工单 04 的 Seam 3 和手动重检：真实的 daemon、真实的网关。手动重检走 plc 的那条路：
// plc.sock 换一个临时 admin token，再调网关的 POST /v1/runtimes/recheck（要 admin）。plc 怎样打印结果见 apps/cli/test。
// 在基线（提交 3342495）里，daemon 从不探针，一次故障会一直挂起之后的派发；
// plc 也没有 recheck 命令。
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createDispatcher } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { recordRuntimeHealthFailure } from "@pi-lead-child/store";
import { RuntimeRegistry, defaultRuntimeProfile } from "@pi-lead-child/runtime";
import { typedFailure, type FailureCode } from "@pi-lead-child/runtime";
import type { RuntimeProbeResult } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { readGatewayNotifications } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";
import { plcAdminClient } from "./plc-client.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-health-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_RUNTIME_RECOVERY_MS", "50");
  vi.stubEnv("PLC_ORCHESTRATOR_MS", "50");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

// 不花钱的 adapter：探针结果由测试给出，start 回放一个正常结束的 Run。
class ProbingRuntime extends ReplayRuntime {
  readonly probes: number[] = [];

  constructor(runtime: RuntimeId, private readonly result: RuntimeProbeResult) {
    super({
      runtime,
      events: [
        { type: "run.started", runtime, model: null },
        { type: "run.completed", exitCode: 0 },
      ],
    });
  }

  async probe(): Promise<RuntimeProbeResult> {
    this.probes.push(Date.now());
    return this.result;
  }
}

const PASS: RuntimeProbeResult = { ok: true, checks: [] };
const loggedOut = (runtime: string): RuntimeProbeResult => ({
  ok: false, checks: [],
  failure: typedFailure("auth_required", { errorCode: "probe_failed", message: `${runtime} login status：退出码 1` }),
});

// 不调用模型的 lead session。
const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

function start(runtimes: ProbingRuntime[]) {
  return startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory as never,
    runtimeRegistry: new RuntimeRegistry(runtimes), log: () => {},
  });
}

// 一次开着的故障。它记在默认 profile 上：ProbingRuntime 没有声明 profile，执行和派发 gate 也用默认 profile。
function openIncident(runtime: RuntimeId, code: FailureCode, title: string): { itemId: number; runId: number; incidentId: number } {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
  const runId = createRun(db, { itemId, runtime, model: "gpt-5.5" });
  updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "replayed", errorMessage: code });
  const opened = recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile(runtime), model: "gpt-5.5",
    failure: typedFailure(code, { errorCode: "replayed", message: code }), itemId, runId,
  });
  return { itemId, runId, incidentId: opened!.incident.id };
}

// 回归测试：账本只用工单 03 的写法开启故障，不碰工单 04 的列。
// 基线上 daemon 从不探针，这个请求永远挂起。
describe("a profile that became unavailable", () => {
  it("recovers without any user action once the probe passes", async () => {
    vi.stubEnv("PLC_RUNTIME_PROBE_BASE_MS", "200");
    const first = openIncident("codex", "auth_required", "historical item 66");
    const retry = createDispatcher(db).request({
      itemId: first.itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      trigger: "runtime-health-retry", idempotencyKey: `runtime-health-retry:${first.runId}`,
    });
    const codex = new ProbingRuntime("codex", PASS);
    const daemon = await start([codex]);
    try {
      // 探针通过就关闭故障（2026-10-20 去掉了金丝雀），挂起的请求随后派出、跑完。
      await vi.waitFor(() => {
        expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(retry)).toEqual({ state: "completed" });
        expect(db.prepare("SELECT closed_at IS NOT NULL AS closed FROM runtime_incidents WHERE id=?").get(first.incidentId))
          .toEqual({ closed: 1 });
      }, { timeout: 8_000, interval: 50 });
    } finally {
      await daemon.close();
    }
  }, 30_000);

  // 2026-10-20 以前的版本留下的状态：探针已经通过、在等金丝雀（canary_armed_at），或者金丝雀已经派出（canary_run_id），
  // 故障还开着。没有代码会再推进它们，所以新 daemon 的恢复循环直接关闭它们，挂起的请求随后放行，不需要用户操作。
  it("closes incidents an older daemon left waiting for a canary, and releases what they held", async () => {
    const armed = openIncident("codex", "auth_required", "historical item 66");
    const running = openIncident("claude", "auth_required", "historical item 67");
    db.prepare("UPDATE runtime_incidents SET canary_armed_at=?, next_probe_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString(), armed.incidentId);
    db.prepare("UPDATE runtime_incidents SET canary_armed_at=?, canary_run_id=?, next_probe_at=? WHERE id=?")
      .run(new Date().toISOString(), running.runId, new Date(Date.now() + 3_600_000).toISOString(), running.incidentId);
    const held = createDispatcher(db).request({
      itemId: armed.itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      trigger: "runtime-health-retry", idempotencyKey: `runtime-health-retry:${armed.runId}`,
    });
    const codex = new ProbingRuntime("codex", PASS);

    const daemon = await start([codex, new ProbingRuntime("claude", PASS)]);
    try {
      await vi.waitFor(() => {
        expect(db.prepare("SELECT id, close_reason FROM runtime_incidents ORDER BY id").all()).toEqual([
          { id: armed.incidentId, close_reason: "探针已通过" },
          { id: running.incidentId, close_reason: "探针已通过" },
        ]);
        expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(held)).toEqual({ state: "completed" });
      }, { timeout: 8_000, interval: 50 });
      // 没有再跑探针：它们的探针早就通过了。
      expect(codex.probes).toEqual([]);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});

describe("recovery across a daemon restart", () => {
  it("waits only for the persisted probe deadline, then releases every suspended request", async () => {
    const first = openIncident("codex", "out_of_credits", "historical item 49");
    const second = createItem(db, { title: "historical item 51", brief: "b", createdBy: "user" });
    const dispatcher = createDispatcher(db);
    const retry = dispatcher.request({
      itemId: first.itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      resumeFromRunId: first.runId, retryOfRunId: first.runId,
      trigger: "runtime-health-retry", idempotencyKey: `runtime-health-retry:${first.runId}`,
    });
    const waiting = dispatcher.request({
      itemId: second, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      trigger: "test", idempotencyKey: "second",
    });
    // 上一个 daemon 写下的截止时间：还剩 1.5 秒。故障已经连续失败 6 次，从头算的退避是一小时。
    const deadline = Date.now() + 1_500;
    db.prepare("UPDATE runtime_incidents SET next_probe_at=?, probe_failures=6 WHERE id=?")
      .run(new Date(deadline).toISOString(), first.incidentId);
    const codex = new ProbingRuntime("codex", PASS);

    const before = await start([codex]);
    await delay(300);
    await before.close();
    expect(codex.probes).toEqual([]);

    const after = await start([codex]);
    try {
      await vi.waitFor(() => expect(codex.probes).toHaveLength(1), { timeout: 10_000, interval: 50 });
      expect(codex.probes[0]).toBeGreaterThanOrEqual(deadline);
      expect(codex.probes[0]).toBeLessThan(deadline + 5_000);

      await vi.waitFor(() => {
        expect(db.prepare("SELECT state FROM dispatch_requests WHERE id IN (?, ?) ORDER BY id").all(retry, waiting))
          .toEqual([{ state: "completed" }, { state: "completed" }]);
      }, { timeout: 10_000, interval: 50 });
    } finally {
      await after.close();
    }
    // 探针通过就关闭故障，两张工单的 Run 都在关闭之后才创建。
    const incident = db.prepare("SELECT closed_at, close_reason FROM runtime_incidents WHERE id=?")
      .get(first.incidentId) as { closed_at: string; close_reason: string };
    expect(incident.close_reason).toBe("探针通过");
    const released = db.prepare(
      "SELECT item_id, started_at, state FROM runs WHERE item_id IN (?, ?) AND id <> ? ORDER BY id",
    ).all(first.itemId, second, first.runId) as Array<{ item_id: number; started_at: string; state: string }>;
    expect(released.map((run) => [run.item_id, run.state])).toEqual([[first.itemId, "finished"], [second, "finished"]]);
    // started_at 是建行时的 datetime('now')，精确到秒。
    for (const run of released) {
      expect(Date.parse(`${run.started_at.replace(" ", "T")}Z`)).toBeGreaterThanOrEqual(
        Math.floor(Date.parse(incident.closed_at) / 1_000) * 1_000,
      );
    }
    expect((await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident")).toHaveLength(1);
  }, 30_000);
});

describe("manual recheck through the gateway", () => {
  it("probes the named runtime without waiting for the backoff", async () => {
    const { incidentId } = openIncident("codex", "auth_required", "logged out");
    db.prepare("UPDATE runtime_incidents SET next_probe_at=? WHERE id=?")
      .run(new Date(Date.now() + 3_600_000).toISOString(), incidentId);
    const codex = new ProbingRuntime("codex", PASS);
    const daemon = await start([codex]);
    try {
      const results = await (await plcAdminClient(daemon)).recheckRuntimes("codex");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ outcome: "recovered" });
      expect(results[0]!.summary).toContain(`Codex 认证失败（故障 #${incidentId}）：重检通过，故障已关闭`);
      expect(codex.probes).toHaveLength(1);
      expect(db.prepare("SELECT close_reason FROM runtime_incidents WHERE id=?").get(incidentId))
        .toEqual({ close_reason: "重检通过" });
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("rechecks every runtime when none is named, and reports a probe that still fails", async () => {
    const codexIncident = openIncident("codex", "auth_required", "codex ticket").incidentId;
    const claudeIncident = openIncident("claude", "auth_required", "claude ticket").incidentId;
    db.prepare("UPDATE runtime_incidents SET next_probe_at=?").run(new Date(Date.now() + 3_600_000).toISOString());
    const codex = new ProbingRuntime("codex", loggedOut("codex"));
    const claude = new ProbingRuntime("claude", PASS);
    const daemon = await start([codex, claude]);
    try {
      const summaries = (await (await plcAdminClient(daemon)).recheckRuntimes()).map((result) => result.summary).join("\n");
      expect(summaries).toContain(`Codex 认证失败（故障 #${codexIncident}）：重检没有通过`);
      expect(summaries).toContain("派发保持挂起");
      expect(summaries).toContain(`Claude Code 认证失败（故障 #${claudeIncident}）：重检通过`);
      // 手动重检没通过时，不推迟自动探针。
      expect(db.prepare("SELECT probe_failures, closed_at FROM runtime_incidents WHERE id=?").get(codexIncident))
        .toEqual({ probe_failures: 0, closed_at: null });
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("returns no results when nothing is open", async () => {
    const daemon = await start([new ProbingRuntime("codex", PASS)]);
    try {
      expect(await (await plcAdminClient(daemon)).recheckRuntimes("pi")).toEqual([]);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
