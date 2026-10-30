import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { plcClient } from "./plc-client.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import {
  commitStagedArtifacts, repairArtifactStorage, stageArtifact,
} from "@pi-lead-child/store";
import { insertCheckpoint } from "@pi-lead-child/store";
import {
  createAgentToolHandlers, createDispatcher, effectiveRunPurpose, liveChildren, scheduleConversationWorkspaceCheck,
  setWorkspaceTreeHashForTesting,
} from "@pi-lead-child/engine";
import { addInbox, listInbox } from "@pi-lead-child/store";
import { appendAssistantDelta, completeTurn, createTurn } from "@pi-lead-child/store";
import { listNotifications } from "@pi-lead-child/store";
import { repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { createApproval, getApproval } from "@pi-lead-child/store";
import { insertDecisionRequest, getDecisionRequest } from "@pi-lead-child/store";
import {
  createPairing, getAishConnStatus, listBindings, loadLastAishOrigin, redeemPairing, saveAishConn,
} from "@pi-lead-child/store";
import {
  DaemonAlreadyRunningError,
  childRuntimeControlEvent,
  loopbackAutoPairEnabled,
  recoverOrphans,
  repairDaemonStartupState,
  startDaemon,
} from "../src/server.js";
import { attachJsonlReader, ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import { ReplayRuntime, expectNoTestProcesses, testProcesses } from "@pi-lead-child/runtime/testing";
import { runningChildren } from "@pi-lead-child/lead";
import { defaultWebRoot } from "@pi-lead-child/gateway";
import { startFakeAish, type FakeAish } from "@pi-lead-child/gateway/testing";
import { foldTurnToolCalls, type ConversationTurn } from "@pi-lead-child/protocol";

let dir: string;
let db: Db;
let dbPath: string;
beforeEach(() => {
  dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  delete process.env.PLC_ARTIFACT_ORPHAN_GRACE_MS;
  delete process.env.PLC_NOTICE_POLL_MS;
  delete process.env.PLC_GATEWAY_PORT;
  delete process.env.PLC_GATEWAY_HOST;
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

// daemon 正常停机时不停止正在执行的 child（工单 15），由重启后的 daemon 接管。测试里没有下一个 daemon，
// 所以删除数据目录：启动目录不在了，垫片停止 CLI 并退出。然后检查测试启动的进程都已经退出。
// 以前这里不删数据目录，孤儿恢复的用例每次运行都留下一个 fake pi 和它的垫片。
// 这个文件里的垫片都在数据目录的 launches 下启动。没有这个目录的用例没有启动垫片，不用扫描进程。
// 最坏情况：删除目录的重试约 5.5 秒（重试间隔线性增长），检查等 10 秒。
afterEach(async () => {
  const launched = existsSync(join(dir, "launches"));
  const leftovers = launched ? testProcesses([dir]) : [];
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (launched) await expectNoTestProcesses([dir], { tracked: leftovers });
}, 30_000);

describe("recoverOrphans", () => {
  it("reclaims dead-pid running runs: failed + blocked + blocker inbox", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", pid: 999_999_999 });
    const n = recoverOrphans(db);
    expect(n).toBe(1);
    expect(getRun(db, runId)!.state).toBe("failed");
    // daemon 重启打断的是这次尝试，不是任务本身（spec D1：attempt），不扣工单的重试额度。
    expect(getRun(db, runId)).toMatchObject({
      failure_scope: "attempt", failure_retry: "resume", failure_code: "run_interrupted",
    });
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(listInbox(db, { severity: "blocker" }).some((r) => r.summary.includes("daemon 重启"))).toBe(true);
  });

  it("kills still-alive orphan processes", async () => {
    const orphan = spawn("sleep", ["60"]);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", pid: orphan.pid });
    recoverOrphans(db);
    await vi.waitFor(() => {
      expect(() => process.kill(orphan.pid!, 0)).toThrow(); // 进程已死
    }, { timeout: 10_000 });
    expect(getRun(db, runId)!.state).toBe("failed");
  });

  it("首个孤儿自动重派：redispatch 回调收到 itemId，通知降级 attention，账本留 auto_redispatch 决策", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", pid: 999_999_999 });
    const redispatched: number[] = [];
    recoverOrphans(db, { redispatch: (id) => { redispatched.push(id); return true; } });
    expect(redispatched).toEqual([itemId]);
    expect(getRun(db, runId)!.state).toBe("failed"); // 诚实语义不变
    expect(listInbox(db, { severity: "blocker" }).length).toBe(0);
    expect(listInbox(db, { severity: "attention" }).some((r) => r.summary.includes("自动重派"))).toBe(true);
    const acts = listActivities(db, itemId, 1000);
    expect(acts.some((a) => a.kind === "decision" && a.payload.includes("auto_redispatch"))).toBe(true);
    expect(getItem(db, itemId)!.body).toContain("daemon 重启");
  });

  it("同工单第二次孤儿不再重派（防崩溃循环 spawn 风暴），回落 blocked+blocker", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const a1 = createRun(db, { itemId });
    updateRun(db, a1, { state: "running", pid: 999_999_999 });
    recoverOrphans(db, { redispatch: () => true });          // 第一次：重派
    // 模拟 redispatch 真实拉起（spawnItemChild 以 system 身份扭 blocked→active，见 manager.ts）
    transition(db, { itemId, to: "active", actor: "system", reason: "redispatch run" });
    const a2 = createRun(db, { itemId });
    updateRun(db, a2, { state: "running", pid: 999_999_999 });
    const redispatched: number[] = [];
    recoverOrphans(db, { redispatch: (id) => { redispatched.push(id); return true; } }); // 第二次
    expect(redispatched).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(listInbox(db, { severity: "blocker" }).length).toBeGreaterThan(0);
  });

  it("redispatch 返回 false（spawn 失败）时优雅降级到 blocked+blocker", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", pid: 999_999_999 });
    recoverOrphans(db, { redispatch: () => false });
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(listInbox(db, { severity: "blocker" }).length).toBeGreaterThan(0);
    // 诚实账本：spawn 失败时正文不得留"已自动重派"的假承诺（review 态孤儿会命中此路径）
    expect(getItem(db, itemId)!.body).not.toContain("已自动重派");
  });

  it("writes deterministic crash and recovery checkpoints once when redispatch returns a new run", () => {
    const itemId = createItem(db, { title: "recover", brief: "checkpoint", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const oldRunId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, oldRunId, { state: "running", pid: 999_999_999 });
    let newRunId = 0;

    recoverOrphans(db, {
      redispatch: () => {
        newRunId = createRun(db, { itemId, runtime: "codex" });
        updateRun(db, newRunId, { state: "starting" });
        return true;
      },
    });

    expect(db.prepare("SELECT idempotency_key FROM checkpoints ORDER BY id").all()).toEqual([
      { idempotency_key: `run-crash:${oldRunId}` },
      { idempotency_key: `run-recovered:${oldRunId}:${newRunId}` },
    ]);
    updateRun(db, newRunId, { state: "finished", endedAt: true });
    recoverOrphans(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 2 });
  });

  it("rolls back orphan recovery completely when durable lifecycle persistence fails", () => {
    const itemId = createItem(db, { title: "atomic recovery", brief: "retry", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", pid: 999_999_999 });
    db.exec(`
      CREATE TRIGGER fail_orphan_outbox
      BEFORE INSERT ON gateway_events
      BEGIN
        SELECT RAISE(FAIL, 'orphan outbox unavailable');
      END;
    `);

    expect(() => recoverOrphans(db)).toThrow(/orphan outbox unavailable/i);
    expect(getRun(db, runId)?.state).toBe("running");
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities WHERE run_id=?").get(runId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=?").get(runId)).toEqual({ n: 0 });

    db.exec("DROP TRIGGER fail_orphan_outbox");
    expect(recoverOrphans(db)).toBe(1);
    expect(getRun(db, runId)?.state).toBe("failed");
  });

  it("preserves dispatch orphan recovery linkage until the replacement run is claimed", () => {
    const itemId = createItem(db, { title: "dispatch recovery", brief: "requeue", createdBy: "system" });
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId,
      role: "executor",
      purpose: "execution",
      trigger: "test",
      idempotencyKey: `dispatch-recovery:${itemId}`,
    });
    const first = dispatcher.claimNext()!;
    updateRun(db, first.runId, { state: "running", pid: 999_999_999 });

    expect(recoverOrphans(db)).toBe(1);
    const replacement = dispatcher.claimNext()!;
    expect(replacement.runId).not.toBe(first.runId);
    expect(db.prepare(
      "SELECT idempotency_key FROM checkpoints WHERE run_id IN (?, ?) ORDER BY id",
    ).all(first.runId, replacement.runId)).toEqual([
      { idempotency_key: `run-crash:${first.runId}` },
      { idempotency_key: `run-recovered:${first.runId}:${replacement.runId}` },
    ]);
  });
});

describe("child runtime gateway projection", () => {
  it("leaves run lifecycle events to the manager transaction", () => {
    const base = { runId: 9, seq: 1, occurredAt: "2026-07-24T08:00:00.000Z" };
    expect(childRuntimeControlEvent(42, 9, {
      ...base, type: "run.started", runtime: "codex", model: null,
    })).toBeNull();
    expect(childRuntimeControlEvent(42, 9, {
      ...base, type: "run.completed", exitCode: 0,
    })).toBeNull();
    expect(childRuntimeControlEvent(42, 9, {
      ...base, type: "run.failed", exitCode: 1, errorCode: "boom", error: "boom",
      failure: { scope: "unknown", retry: "never", needs: "none", code: "unknown", evidence: "boom" },
    })).toBeNull();
  });
});

describe("daemon startup repair", () => {
  // 2026-10-15 起先交给 Lead：补发的 blocker 只给 Lead，用户不收通知；Lead 处理不了时 daemon 再升级给用户。
  it("restores Lead's blocker for a legacy blocked checkpoint, without a user notification", () => {
    const itemId = createItem(db, { title: "legacy blocked", brief: "repair", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "legacy blocker" });
    insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "blocked",
      title: "能力未部署",
      summary: "live daemon 尚未加载当前 schema。",
      nextStep: "先完成 daemon 重启，再重新验证。",
      idempotencyKey: "legacy-blocked-checkpoint",
    });

    expect(repairMissingBlockerAlerts(db, new Date("2026-08-14T06:00:00.000Z"))).toBe(1);
    expect(listInbox(db, { severity: "blocker" })).toHaveLength(1);
    expect(JSON.parse(listInbox(db, { severity: "blocker" })[0]!.payload).needsUser).toBe(false);
    expect(listNotifications(db, { itemId, urgency: "immediate" })).toHaveLength(0);
    expect(repairMissingBlockerAlerts(db)).toBe(0);
  });

  it("repairs legacy interventions and missing live-run start projections idempotently", () => {
    const itemId = createItem(db, { title: "startup", brief: "repair", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "running" });
    const approvalId = createApproval(db, {
      itemId,
      runId,
      requestedBy: "child",
      tool: "deploy",
      action: "Deploy after restart",
    });
    const decision = insertDecisionRequest(db, {
      itemId,
      runId,
      kind: "question",
      audience: "user",
      prompt: "Which region?",
      allowCustom: true,
    });

    expect(repairDaemonStartupState(db)).toEqual({
      approvals: 1,
      decisions: 1,
      runStarts: 1,
      reregistered: 0,
      reregistrationErrors: 0,
      outcomes: 0,
      handoffs: 0,
    });
    expect(repairDaemonStartupState(db)).toEqual({
      approvals: 0,
      decisions: 0,
      runStarts: 0,
      reregistered: 0,
      reregistrationErrors: 0,
      outcomes: 0,
      handoffs: 0,
    });
    expect(db.prepare("SELECT idempotency_key FROM checkpoints ORDER BY id").all()).toEqual([
      { idempotency_key: `legacy-approval:${approvalId}` },
      { idempotency_key: `legacy-decision:${decision.id}` },
      { idempotency_key: `run-start:${runId}` },
    ]);
  });

  it("repairs proof drift, downgrades corrupt and missing blobs, and garbage-collects only expired orphans", async () => {
    const workdir = join(dir, "artifact-workdir");
    mkdirSync(workdir);
    const itemId = createItem(db, {
      title: "startup artifacts", brief: "repair", createdBy: "system", workdir,
    });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const checkpointId = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "milestone",
      title: "Artifact proof",
      summary: "Artifact proof summary",
      proofItems: [{ id: "storage", label: "Storage integrity", state: "passed", evidence: "verified" }],
    }).id;
    writeFileSync(join(workdir, "corrupt.txt"), "expected-corrupt");
    writeFileSync(join(workdir, "missing.txt"), "expected-missing");
    const [corrupt, missing] = commitStagedArtifacts(db, checkpointId, [
      stageArtifact(db, {
        dataDir: dir, itemId, runId, ref: "repair/corrupt", name: "corrupt.txt",
        kind: "report", mediaType: "text/plain", description: null, relativePath: "corrupt.txt",
      }),
      stageArtifact(db, {
        dataDir: dir, itemId, runId, ref: "repair/missing", name: "missing.txt",
        kind: "report", mediaType: "text/plain", description: null, relativePath: "missing.txt",
      }),
    ]);
    const storageRows = db.prepare(
      "SELECT id, storage_key FROM artifacts WHERE id IN (?, ?) ORDER BY id",
    ).all(corrupt!.id, missing!.id) as Array<{ id: number; storage_key: string }>;
    unlinkSync(join(dir, storageRows[0]!.storage_key));
    writeFileSync(join(dir, storageRows[0]!.storage_key), "tampered-corrupt");
    unlinkSync(join(dir, storageRows[1]!.storage_key));
    db.prepare(
      "UPDATE item_proof_items SET label='drifted', state='failed', evidence='wrong' WHERE item_id=? AND proof_key='storage'",
    ).run(itemId);

    writeFileSync(join(workdir, "old-orphan.txt"), "old orphan");
    writeFileSync(join(workdir, "young-orphan.txt"), "young orphan");
    const oldOrphan = stageArtifact(db, {
      dataDir: dir, itemId, runId, ref: "orphan/old", name: "old.txt",
      kind: "report", mediaType: "text/plain", description: null, relativePath: "old-orphan.txt",
    });
    const youngOrphan = stageArtifact(db, {
      dataDir: dir, itemId, runId, ref: "orphan/young", name: "young.txt",
      kind: "report", mediaType: "text/plain", description: null, relativePath: "young-orphan.txt",
    });
    const oldTime = new Date(Date.now() - 2_000);
    utimesSync(join(dir, oldOrphan.storageKey!), oldTime, oldTime);
    const futureTime = new Date(Date.now() + 60_000);
    utimesSync(join(dir, youngOrphan.storageKey!), futureTime, futureTime);
    updateRun(db, runId, { state: "finished", endedAt: true });

    const reopenedWithoutDaemon = openDb(dbPath);
    expect(reopenedWithoutDaemon.prepare(
      "SELECT label, state FROM item_proof_items WHERE item_id=? AND proof_key='storage'",
    ).get(itemId)).toEqual({ label: "drifted", state: "failed" });
    expect(reopenedWithoutDaemon.prepare(
      "SELECT availability FROM artifacts WHERE id IN (?, ?) ORDER BY id",
    ).all(corrupt!.id, missing!.id)).toEqual([
      { availability: "available" }, { availability: "available" },
    ]);
    reopenedWithoutDaemon.close();

    process.env.PLC_ARTIFACT_ORPHAN_GRACE_MS = "1000";
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
    });
    const verified = openDb(dbPath);
    try {
      expect(verified.prepare(
        "SELECT label, state, evidence, checkpoint_id FROM item_proof_items WHERE item_id=?",
      ).all(itemId)).toEqual([{
        label: "Storage integrity", state: "passed", evidence: "verified", checkpoint_id: checkpointId,
      }]);
      expect(verified.prepare(
        "SELECT availability, storage_key FROM artifacts WHERE id IN (?, ?) ORDER BY id",
      ).all(corrupt!.id, missing!.id)).toEqual([
        { availability: "unavailable", storage_key: null },
        { availability: "unavailable", storage_key: null },
      ]);
      expect(existsSync(join(dir, oldOrphan.storageKey!))).toBe(false);
      expect(existsSync(join(dir, youngOrphan.storageKey!))).toBe(true);
    } finally {
      verified.close();
      await daemon.close();
    }
  });

  it("runs the live-socket guard before config validation or artifact/proof repair", async () => {
    const { factory } = stubSessionFactory();
    const first = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
    });
    const itemId = createItem(db, { title: "guard", brief: "repair order", createdBy: "system" });
    const checkpointId = insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "milestone",
      title: "Guard proof",
      summary: "Guard proof",
      proofItems: [{ id: "guard", label: "Guard", state: "pending", evidence: null }],
      idempotencyKey: `guard-proof:${itemId}`,
    }).id;
    db.prepare("DELETE FROM item_proof_items WHERE item_id=?").run(itemId);
    process.env.PLC_ARTIFACT_ORPHAN_GRACE_MS = "0";
    try {
      await expect(startDaemon({
        dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
      })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM item_proof_items WHERE item_id=? AND checkpoint_id=?",
      ).get(itemId, checkpointId)).toEqual({ n: 0 });
    } finally {
      delete process.env.PLC_ARTIFACT_ORPHAN_GRACE_MS;
      await first.close();
    }
  });

  it("rejects invalid orphan-grace configuration before creating sessions or repairing state", async () => {
    process.env.PLC_ARTIFACT_ORPHAN_GRACE_MS = "-1";
    const factory = vi.fn(stubSessionFactory().factory);
    await expect(startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
    })).rejects.toThrow(/PLC_ARTIFACT_ORPHAN_GRACE_MS.*positive integer/i);
    expect(factory).not.toHaveBeenCalled();
    expect(repairArtifactStorage).toBeTypeOf("function");
  });

  it("fails startup on transient artifact I/O and leaves available metadata unchanged", async () => {
    const workdir = join(dir, "transient-artifact-workdir");
    mkdirSync(workdir);
    const itemId = createItem(db, {
      title: "transient artifact", brief: "startup failure", createdBy: "system", workdir,
    });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const checkpointId = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "milestone",
      title: "Transient artifact",
      summary: "Transient artifact",
    }).id;
    writeFileSync(join(workdir, "transient.txt"), "transient bytes");
    const [artifact] = commitStagedArtifacts(db, checkpointId, [
      stageArtifact(db, {
        dataDir: dir,
        itemId,
        runId,
        ref: "startup/transient",
        name: "transient.txt",
        kind: "report",
        mediaType: "text/plain",
        description: null,
        relativePath: "transient.txt",
      }),
    ]);
    updateRun(db, runId, { state: "finished", endedAt: true });
    const transientError = Object.assign(new Error("transient EMFILE"), { code: "EMFILE" });
    const factory = vi.fn(stubSessionFactory().factory);
    let started: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let caught: unknown;
    try {
      started = await startDaemon({
        dataDir: dir,
        dbPath,
        sessionFactory: factory as any,
        log: () => {},
        gatewayPort: 0,
        artifactRepairOptions: {
          beforeVerifyArtifact(context) {
            if (context.artifactId === artifact!.id) throw transientError;
          },
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      await started?.close();
    }

    expect(caught).toBe(transientError);
    expect(factory).not.toHaveBeenCalled();
    expect(db.prepare(
      "SELECT availability, storage_key FROM artifacts WHERE id=?",
    ).get(artifact!.id)).toEqual({
      availability: "available",
      storage_key: expect.any(String),
    });
  });
});

// 免 LLM 的 stub lead session：prompt 时吐一个 delta，可人为挂起模拟 busy
function stubSessionFactory(options?: {
  toolItemId?: number;
  response?: "text" | "empty" | "error";
  errorMessage?: string;
  switchLeadModel?: { previous: string; selected: string };
}) {
  let release: (() => void) | null = null;
  const listeners: Array<(e: any) => void> = [];
  const steers: string[] = [];
  const prompts: string[] = [];
  const factory = async (args?: {
    announceLeadStatus?: (message: string) => void;
    scheduleLeadModelRestart?: (request: {
      previous: string; selected: string; reason: string;
    }) => void;
  }) => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(cb: (e: any) => void) { listeners.push(cb); return () => {}; },
      async prompt(msg: string) {
        prompts.push(msg);
        if (options?.switchLeadModel) {
          const { previous, selected } = options.switchLeadModel;
          args?.announceLeadStatus?.(
            `【系统】正在把 Lead 从 ${previous} 切换到 ${selected}。当前对话会短暂中断，起来后使用新模型。`,
          );
          args?.scheduleLeadModelRestart?.({
            previous, selected, reason: `switch Lead model to ${selected}`,
          });
          return;
        }
        if (options?.response === "error") {
          for (const l of listeners) {
            l({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: options.errorMessage ?? "model unavailable",
                content: [],
              },
            });
          }
        } else if (options?.response !== "empty") {
          for (const l of listeners) {
            l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `echo:${msg}` } });
          }
        }
        if (options?.toolItemId) {
          for (const l of listeners) {
            l({
              type: "tool_execution_start",
              toolCallId: "daemon-tool-call",
              toolName: "spawn_child",
              args: { ticket_id: options.toolItemId },
            });
            l({
              type: "tool_execution_end",
              toolCallId: "daemon-tool-call",
              toolName: "spawn_child",
              args: { ticket_id: options.toolItemId },
              result: { content: [{ type: "text", text: `child spawned for ticket #${options.toolItemId}` }] },
              isError: false,
            });
          }
        }
        if (msg.includes("HANG")) await new Promise<void>((r) => { release = r; });
      },
      async steer(msg: string) { steers.push(msg); },
      async followUp() {},
      dispose() {},
    },
  });
  // 回合挂起期间人为吐字：插话归属只有在"插话之后 lead 又说了话"时才看得出来。
  const emit = (event: unknown) => { for (const l of listeners) l(event); };
  return {
    factory,
    prompts,
    steers,
    releaseHang: () => release?.(),
    emitDelta: (delta: string) =>
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
    emitMessageEnd: (text: string) =>
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }),
  };
}

function sendCmd(sock: Socket, cmd: object) {
  sock.write(JSON.stringify(cmd) + "\n");
}

// 一个说自己有人在看的 v2 客户端（前台的 companion、运行中的 plc chat）。
async function openAttendedClient(pairedPort: number, name: string) {
  const pairing = createPairing(db, { name, kind: "companion", scopes: ["chat", "tickets:view"] });
  const issued = redeemPairing(db, pairing.code);
  const socket = new WebSocket(`ws://127.0.0.1:${pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`);
  const received: any[] = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(received.some((m) => m.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  await vi.waitFor(() => expect(received.some((m) => m.type === "command.result" && m.id === "presence")).toBe(true));
  return { close: () => socket.close() };
}

// 旧版（v1）paired 连接：没有轮次概念，收 daemon 的广播（delta / turn_end / notice）。
// 它不能说自己有没有人在看，所以不算"有人在听"。aish 和它共用同一条无轮次的聊天入口。
async function openLegacyChat(pairedPort: number, name: string) {
  const pairing = createPairing(db, { name, kind: "companion", scopes: ["chat", "tickets:view"] });
  const issued = redeemPairing(db, pairing.code);
  const socket = new WebSocket(`ws://127.0.0.1:${pairedPort}/v1/paired/events?token=${issued.accessToken}`);
  const received: any[] = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(received.some((m) => m.type === "hello")).toBe(true));
  let counter = 0;
  return {
    socket,
    received,
    send: (cmd: object) => socket.send(JSON.stringify(cmd)),
    chat: (message: string) => socket.send(JSON.stringify({ type: "chat", id: `legacy-${++counter}`, message })),
    close: () => socket.close(),
  };
}

describe("daemon protocol", () => {
  it("actively wakes an idle lead for immediate user notifications", async () => {
    const itemId = createItem(db, { title: "immediate notice", brief: "b", createdBy: "system" });
    db.prepare(
      `INSERT INTO notifications (item_id, kind, urgency, title, body, created_at)
       VALUES (?, 'terminal_handoff_failed', 'immediate', ?, ?, ?)`,
    ).run(
      itemId,
      `工单 #${itemId} 运行结束，但交接失败`,
      "必须马上告知用户",
      new Date().toISOString(),
    );
    process.env.PLC_NOTICE_POLL_MS = "20";
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: stub.factory as any,
      log: () => {},
    });
    // 有人在听时，lead 才被叫醒去播报：一个说自己有人在看的 v2 客户端。
    const listener = await openAttendedClient(daemon.pairedPort, "listener");
    try {
      await vi.waitFor(() => expect(stub.prompts.some((prompt) => (
        prompt.includes("必须马上告知用户")
      ))).toBe(true));
      await vi.waitFor(() => expect(db.prepare(
        "SELECT state, delivered_via FROM notifications WHERE item_id=?",
      ).get(itemId)).toEqual({ state: "delivered", delivered_via: "lead" }));
    } finally {
      listener.close();
      await daemon.close();
    }
  }, 20_000);

  it("actively wakes an idle lead to inspect a new blocker", async () => {
    const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "system" });
    addInbox(db, {
      itemId,
      severity: "blocker",
      source: "structural",
      summary: `工单 #${itemId} 的 Run #7 出现未捕获异常，需要 Lead 立即检查`,
      payload: { kind: "unhandled_run_exception", runId: 7, detail: "decoder exploded" },
      lossless: true,
    });
    process.env.PLC_NOTICE_POLL_MS = "20";
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: stub.factory as any,
      log: () => {},
    });
    try {
      await vi.waitFor(() => expect(stub.prompts.some((prompt) => (
        prompt.includes("出现未捕获异常")
        && prompt.includes("能自己处理的直接处理")
      ))).toBe(true));
      await vi.waitFor(() => expect(listInbox(db, { state: ["consumed"] })).toHaveLength(1));
    } finally {
      await daemon.close();
    }
  }, 20_000);

  // 工单 04（spec D6、D7）：不叫醒 Lead 的事（digest 级）写在这一轮开头的当前局面里（<system_event kind="situation">）。
  // 合并进同一行的每一条都在；这一轮成功以后才消化掉。
  it("renders merged inbox details and consumes them only after a successful lead turn", async () => {
    const itemId = createItem(db, { title: "notices", brief: "b", createdBy: "system" });
    addInbox(db, {
      itemId,
      severity: "attention",
      source: "structural",
      summary: "预算接近上限",
    });
    addInbox(db, {
      itemId,
      severity: "attention",
      source: "structural",
      summary: "child 已结束但未交接",
    });
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: stub.factory as any,
      log: () => {},
    });
    const client = await openLegacyChat(daemon.pairedPort, "notice-success");
    try {
      client.chat("检查通知");
      await vi.waitFor(() => expect(client.received.some((message) => message.type === "turn_end")).toBe(true));
      const situation = /<system_event kind="situation"[^>]*>[\s\S]*?<\/system_event>/u.exec(stub.prompts.at(-1)!)?.[0] ?? "";
      expect(situation).toContain("预算接近上限");
      expect(situation).toContain("child 已结束但未交接");
      expect(listInbox(db, { state: ["consumed"] })).toHaveLength(1);
    } finally {
      client.close();
      await daemon.close();
    }
  }, 20_000);

  it("keeps inbox notices delivered when the lead turn fails", async () => {
    const itemId = createItem(db, { title: "failed notice", brief: "b", createdBy: "system" });
    addInbox(db, {
      itemId,
      severity: "attention",
      source: "structural",
      summary: "必须重试的通知",
    });
    const stub = stubSessionFactory({ response: "error" });
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: stub.factory as any,
      log: () => {},
    });
    const client = await openLegacyChat(daemon.pairedPort, "notice-failure");
    try {
      client.chat("检查通知");
      await vi.waitFor(() => expect(client.received.some((message) => message.type === "turn_end")).toBe(true));
      expect(listInbox(db, { state: ["delivered"] })).toHaveLength(1);
      expect(listInbox(db, { state: ["consumed"] })).toHaveLength(0);
    } finally {
      client.close();
      await daemon.close();
    }
  }, 20_000);

  it("serves hello/status/chat on the legacy paired socket and steers when busy", async () => {
    const { factory, steers, releaseHang } = stubSessionFactory();
    const d = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {} });
    const client = await openLegacyChat(d.pairedPort, "legacy-client");
    const received = client.received;

    const waitFor = (pred: (m: any) => boolean, timeout = 3000) =>
      vi.waitFor(() => { expect(received.some(pred)).toBe(true); }, { timeout });

    await waitFor((m) => m.type === "hello" && m.model === "stub/model");

    client.send({ type: "status", id: "s1" });
    await waitFor((m) => m.type === "response" && m.id === "s1" && m.data.model === "stub/model");

    // 正常回合：delta + turn_end
    client.chat("你好");
    await waitFor((m) => m.type === "delta" && m.text.includes("你好"));
    await waitFor((m) => m.type === "turn_end");

    // busy 回合：第二条 chat 转 steer
    client.chat("please HANG");
    await waitFor((m) => m.type === "delta" && m.text.includes("HANG"));
    client.chat("插话内容");
    await waitFor((m) => m.type === "steered");
    // 旧版入口的插话也包成 <user_message>，写明入口（lead 包的 envelope.ts）。
    expect(steers.some((steer) => steer.startsWith("<user_message ") && steer.includes("\n插话内容\n</user_message>"))).toBe(true);
    releaseHang();
    await waitFor((m) => m.type === "turn_end");

    client.close();
    await d.close();
  }, 15000);
});

describe("daemon user control plane", () => {
  // 10-12 的实测：plc item complete 78/79/81 与 cancel 80 改了工单，gateway_events 却一行没写，
  // 开着的 companion 一直把它们留在"待验收"，直到手动刷新。当时 plc 走 unix socket 入口，它没发事件。
  // 现在 plc 和 companion 走同一个网关入口。这里走 plc 的整条路：plc.sock 换凭证，再调网关。
  it("tells a paired companion about item and run actions sent by plc", async () => {
    const { factory } = stubSessionFactory();
    const reviewed = createItem(db, { title: "awaiting acceptance", brief: "b", createdBy: "system" });
    transition(db, { itemId: reviewed, to: "active", actor: "system", reason: "test" });
    transition(db, { itemId: reviewed, to: "review", actor: "system", reason: "test" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
    });
    // 启动之后再建在跑的 Run：启动时没有进程的 running Run 会被当成孤儿回收。
    const running = createItem(db, { title: "running", brief: "b", createdBy: "system" });
    transition(db, { itemId: running, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId: running });
    updateRun(db, runId, { state: "running", sessionId: "sess-socket" });
    const pairing = createPairing(db, { name: "companion", kind: "companion", scopes: ["tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const companion = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const events: any[] = [];
    companion.on("message", (raw) => events.push(JSON.parse(String(raw))));
    const plc = await plcClient(daemon);
    try {
      await vi.waitFor(() => expect(events.some((e) => e.type === "hello.v2")).toBe(true));
      const before = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM gateway_events").get() as { seq: number }).seq;
      const live = (type: string, ticketId: number) =>
        events.filter((e) => e.type === type && e.ticketId === ticketId && e.seq > before);

      // plc item complete <id> 调的正是这个方法（apps/cli/src/commands.ts）。
      await plc.performTicketAction(reviewed, "complete");
      expect(getItem(db, reviewed)!.stage).toBe("done");
      await vi.waitFor(() => expect(live("ticket.updated", reviewed)).toHaveLength(1));
      expect(live("ticket.updated", reviewed)[0].payload).toEqual({ ticketId: reviewed, snapshotRequired: true });

      await plc.performAttemptAction(runId, "pause");
      expect(getRun(db, runId)!.state).toBe("paused");
      await vi.waitFor(() => expect(live("attempt.updated", running)).toHaveLength(1));
      expect(live("attempt.updated", running)[0].payload)
        .toEqual({ attemptId: runId, ticketId: running, snapshotRequired: true });
    } finally {
      companion.close();
      await daemon.close();
    }
  }, 20_000);

  it("rejects unbound agent tools on the daemon control socket", async () => {
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {} });
    const itemId = createItem(db, { title: "agent tool", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running" });
    const received: any[] = [];
    const socket = connect(daemon.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    attachJsonlReader(socket, (line) => { if (line.trim()) received.push(JSON.parse(line)); });
    try {
      sendCmd(socket, {
        type: "agent_tool",
        id: "agent-checkpoint",
        item_id: itemId,
        run_id: runId,
        name: "submit_checkpoint",
        arguments: {
          kind: "milestone",
          title: "Socket checkpoint",
          summary: "Written by daemon-owned handler.",
          next_step: "Continue testing.",
        },
      });
      await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
        type: "response", id: "agent-checkpoint", success: false,
        error: "unknown command: agent_tool",
      })));
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE item_id=? AND run_id=?",
      ).get(itemId, runId)).toEqual({ n: 0 });
    } finally {
      socket.end();
      await daemon.close();
    }
  }, 20_000);
});

// 等 socket 上第一条满足条件的消息，收到就结束，最多等 10 秒。超时的错误列出已经收到的消息类型。
// messages 由调用方的 message 监听写入，这个监听要先挂上。
// 以前用 vi.waitFor 的缺省 1 秒，全量测试的负载下网关的回复晚于它。
function nextMessage(socket: WebSocket, messages: any[], what: string, match: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(match);
      if (!found) return;
      clearTimeout(timer);
      socket.off("message", check);
      resolve(found);
    };
    const timer = setTimeout(() => {
      socket.off("message", check);
      reject(new Error(`no ${what} within 10 s; received: ${messages.map((message) => message.type).join(", ") || "nothing"}`));
    }, 10_000);
    socket.on("message", check);
    check();
  });
}

describe("daemon ticket direct messages", () => {
  it("routes paired ticket messages to a conversation run without starting an execution retry", async () => {
    const itemId = createItem(db, { title: "direct ticket message", brief: "delegate", createdBy: "system" });
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: factory as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      log: () => {},
      gatewayPort: 0,
    });
    const pairing = createPairing(db, { name: "tool-card-client", kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await nextMessage(socket, messages, "hello.v2", (message) => message.type === "hello.v2");
      socket.send(JSON.stringify({
        type: "chat.send",
        id: "tool-card-command",
        protocolVersion: 2,
        message: "run the tool",
        // context 是线上 payload：键名保持 ticketId（packages/protocol WsCommand 冻结）。
        context: { ticketId: itemId },
      }));
      expect(await nextMessage(socket, messages, "command.result tool-card-command",
        (message) => message.type === "command.result" && message.id === "tool-card-command")).toMatchObject({ success: true });
      await vi.waitFor(() => expect(db.prepare(
        "SELECT purpose FROM runs WHERE item_id=?",
      ).get(itemId)).toEqual({ purpose: "conversation" }));
      // fake pi 是经 tsx 启动的真实子进程，负载下回答要好几秒，以前只等 vi.waitFor 的缺省 1 秒。
      // 先等这一轮结束，再看它的内容：这一轮失败时，断言马上报出它的 error，不等到超时。
      const turn = () => db.prepare(
        "SELECT origin_kind, state, assistant_text, error FROM channel_turns WHERE item_id=? ORDER BY created_at DESC LIMIT 1",
      ).get(itemId) as { state: string } | undefined;
      await vi.waitFor(() => expect(turn()?.state).toMatch(/^(completed|failed|steered)$/), { timeout: 15_000 });
      expect(turn()).toMatchObject({
        origin_kind: "paired:companion:ticket-agent",
        state: "completed",
        assistant_text: expect.stringContaining("done:"),
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-system'",
      ).get(itemId)).toEqual({ n: 0 });
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND kind='comment' AND payload LIKE '%ticket_agent%'",
      ).get(itemId) as { n: number }).n).toBeGreaterThan(0);
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM conversation_cards WHERE item_id=? AND kind='ticket_execution'",
      ).get(itemId)).toEqual({ n: 0 });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?",
      ).get(itemId)).toEqual({ n: 0 });
    } finally {
      socket.close();
      await daemon.close();
    }
  }, 30_000);
});

describe("daemon ticket conversation turns", () => {
  // 工单 #66 第二轮：用户问"你跑吧，顺便告诉我我该怎么验收呢"。agent 先说一句"我去跑门"，
  // 跑了工具，最后才给出结果和验收步骤。旧代码在第一条助手消息就把这一轮收口，回答丢了。
  it("keeps the final answer of a tool-using conversation run in the same turn", async () => {
    process.env.FAKE_SCENARIO = "narrate_then_answer";
    const itemId = createItem(db, { title: "how do I accept this", brief: "explain acceptance", createdBy: "system" });
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: factory as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      log: () => {},
      gatewayPort: 0,
    });
    const pairing = createPairing(db, { name: "conversation-client", kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      socket.send(JSON.stringify({
        type: "chat.send",
        id: "conversation-command",
        protocolVersion: 2,
        message: "你跑吧，顺便告诉我我该怎么验收呢",
        context: { ticketId: itemId },
      }));
      await vi.waitFor(() => expect(db.prepare(
        "SELECT state FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent'",
      ).get(itemId)).toEqual({ state: "completed" }), { timeout: 15_000 });
      const turn = db.prepare(
        "SELECT assistant_text FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent'",
      ).get(itemId) as { assistant_text: string };
      // fake pi 的最后一条消息以 "done: " 开头。两条助手消息都在，中间空一行。
      expect(turn.assistant_text).toMatch(/^我先去跑一遍验收门。\n\ndone: /);
    } finally {
      delete process.env.FAKE_SCENARIO;
      socket.close();
      await daemon.close();
    }
  }, 30_000);

  // 工单对话里 agent 调的工具（Bash、Read 等）属于它正在回答的那一轮：实时事件带这一轮的 turnId，
  // 刷新以后快照里这一轮的 toolCalls 和实时折叠出来的一样。工具之前的话是叙述，之后的话是回答。
  it("lists the agent's tools inside the ticket turn, the same live and after a reload", async () => {
    process.env.FAKE_SCENARIO = "narrate_then_answer";
    const itemId = createItem(db, { title: "show the tools", brief: "run the gate", createdBy: "system" });
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      log: () => {}, gatewayPort: 0,
    });
    const pairing = createPairing(db, { name: "conversation-client", kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      socket.send(JSON.stringify({
        type: "chat.send", id: "ticket-tools", protocolVersion: 2, message: "你跑吧", context: { ticketId: itemId },
      }));
      await vi.waitFor(() => expect(db.prepare(
        "SELECT state FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent'",
      ).get(itemId)).toEqual({ state: "completed" }), { timeout: 15_000 });

      const turnId = (db.prepare(
        "SELECT id FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent'",
      ).get(itemId) as { id: string }).id;
      const narration = "我先去跑一遍验收门。";
      await vi.waitFor(() => expect(messages.some((message) => message.type === "child.tool.completed")).toBe(true));
      const live = messages.filter((message) => message.eventId && message.turnId === turnId);
      expect(live.find((event) => event.type === "child.tool.started")).toMatchObject({
        ticketId: itemId,
        payload: { toolName: "bash", textOffset: narration.length },
      });

      const response = await fetch(
        `http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?ticket_id=${itemId}&include=tool_calls`,
        { headers: { authorization: `Bearer ${issued.accessToken}` } },
      );
      const turn = ((await response.json()) as { items: ConversationTurn[] }).items.find((item) => item.id === turnId)!;
      expect(turn.toolCalls).toEqual(foldTurnToolCalls(live));
      expect(turn.toolCalls).toEqual([expect.objectContaining({
        name: "bash", state: "completed", textOffset: narration.length,
        args: expect.objectContaining({ preview: '{"command":"vitest run"}' }),
      })]);
      expect(turn.assistantText.slice(0, narration.length)).toBe(narration);
      expect(turn.assistantText.slice(narration.length).trim()).toMatch(/^done: /);

      // executor 的工具事件要 tickets:view。只有 chat 的 binding 在快照里也看不到，和实时事件流一样。
      const chatOnly = redeemPairing(db, createPairing(db, { name: "chat-only", kind: "companion", scopes: ["chat"] }).code);
      const narrow = await fetch(
        `http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?ticket_id=${itemId}&include=tool_calls`,
        { headers: { authorization: `Bearer ${chatOnly.accessToken}` } },
      );
      const narrowTurn = ((await narrow.json()) as { items: ConversationTurn[] }).items.find((item) => item.id === turnId)!;
      expect(narrowTurn.toolCalls).toEqual([]);
    } finally {
      delete process.env.FAKE_SCENARIO;
      socket.close();
      await daemon.close();
    }
  }, 30_000);

  async function startTicketChatDaemon() {
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: factory as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      log: () => {},
      gatewayPort: 0,
    });
    const pairing = createPairing(db, { name: "conversation-client", kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await nextMessage(socket, messages, "hello.v2", (message) => message.type === "hello.v2");
    const send = async (itemId: number, id: string, message: string) => {
      socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, context: { ticketId: itemId } }));
      // 网关拒绝时，这里马上报出它的错误，不等到超时。
      expect(await nextMessage(socket, messages, `command.result ${id}`,
        (entry) => entry.type === "command.result" && entry.id === id)).toMatchObject({ success: true });
    };
    const turns = (itemId: number) => db.prepare(
      `SELECT user_text, state, assistant_text, error FROM channel_turns
       WHERE item_id=? AND origin_kind LIKE '%:ticket-agent' ORDER BY created_at, rowid`,
    ).all(itemId) as { user_text: string; state: string; assistant_text: string; error: string | null }[];
    return {
      daemon, send, turns,
      close: async () => { socket.close(); await daemon.close(); },
    };
  }

  // release review 2a：工单对话 Run 还在回答第一句时，用户又发了一句。轮次表按 runId 记，
  // 第二句的轮次覆盖了第一句的，第一句就永远停在 streaming（companion 一直显示"处理中"）。
  it("closes the first turn when a second message arrives while the conversation run is still answering", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "two questions", brief: "answer both", createdBy: "system" });
    const chat = await startTicketChatDaemon();
    try {
      await chat.send(itemId, "first-question", "这个单子在干什么");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });

      await chat.send(itemId, "second-question", "顺便看下测试");
      await vi.waitFor(() => expect(chat.turns(itemId).map((turn) => turn.state)).toEqual(["completed", "completed"]),
        { timeout: 15_000 });
      const [first, second] = chat.turns(itemId);
      // 第一句的轮次保住自己已经说的话；回答第二句的消息长在第二句下面。
      expect(first).toMatchObject({ user_text: "这个单子在干什么", assistant_text: "我先去查一下。" });
      expect(second).toMatchObject({ user_text: "顺便看下测试", assistant_text: expect.stringContaining("answered: ") });
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 1 });
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 40_000);

  // 暂停的执行 Run 和它的 pi session 文件（pi 1.1.0 的格式：第一行是 session 头）。
  // 在 daemon 启动之后建，避开启动修复。
  function pausedExecutionRun(itemId: number, sessionId: string): { runId: number; sessionFile: string } {
    const sessions = join(dir, "sessions", `item-${itemId}`);
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, `2026-10-13T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir })}\n`);
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", sessionId, externalSessionId: sessionId });
    db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(runId);
    return { runId, sessionFile };
  }

  const ticketRuns = (itemId: number) => db.prepare(
    "SELECT id, role, purpose, state, resumed_from_run_id, external_session_id FROM runs WHERE item_id=? ORDER BY id",
  ).all(itemId) as Array<{
    id: number; role: string; purpose: string; state: string;
    resumed_from_run_id: number | null; external_session_id: string | null;
  }>;

  // 用户的决定：工单消息不改变暂停的 Run 的生命周期。以前 routeTicketMessageToAgentRun 把暂停的执行 Run
  // 当成对话续接：这一回合结束时 Run 就 finished 了，工作没有做完，成果修复和自动核查都跳过了，库里还写着 execution。
  // 现在另起一个 conversation Run 回答，它在暂停的 Run 的 session 的副本上跑。暂停的 Run 由恢复控制按执行续接。
  it("answers a ticket message from a separate conversation run and leaves the paused execution run to the resume control", async () => {
    process.env.FAKE_SCENARIO = "narrate_then_answer";
    // 恢复的执行 Run 要走到 runItem 的收尾（成果修复在那里请求），不能停留 5 分钟等下一条 prompt。
    process.env.PLC_CHILD_LINGER_MS = "0";
    const capture = join(dir, "fake-pi-capture.json");
    process.env.FAKE_PI_CAPTURE = capture;
    const itemId = createItem(db, { title: "paused execution", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    const paused = pausedExecutionRun(itemId, "paused-exec");
    try {
      await chat.send(itemId, "paused-question", "你现在做到哪了");
      // 这个对话 Run 只为回答这一句话而起，整段回答都属于这一轮，在 Run 结束时收口。
      await vi.waitFor(() => expect(chat.turns(itemId)).toEqual([
        expect.objectContaining({ state: "completed", assistant_text: expect.stringMatching(/^我先去跑一遍验收门。\n\ndone: /) }),
      ]), { timeout: 15_000 });
      await vi.waitFor(() => expect(ticketRuns(itemId)).toEqual([
        {
          id: paused.runId, role: "executor", purpose: "execution", state: "paused",
          resumed_from_run_id: null, external_session_id: "paused-exec",
        },
        {
          id: expect.any(Number), role: "executor", purpose: "conversation", state: "finished",
          resumed_from_run_id: paused.runId, external_session_id: expect.stringMatching(/^paused-exec-fork-/),
        },
      ]), { timeout: 15_000 });
      // pi 用 --fork 在 session 的副本上开始；--session 会把对话写进暂停的 Run 的 session。
      const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
      expect(args[args.indexOf("--fork") + 1]).toBe(paused.sessionFile);
      expect(args).not.toContain("--session");

      // 恢复控制按执行续接暂停的 Run：同一行、它自己的 session，结束时走执行 Run 的收尾。
      // 对话 Run 在库里已是 finished 时，它的进程可能还在退出。这时恢复会被拒绝，所以等它离开 live 表。
      // 用户的恢复走网关（plc 和 companion 都是这样发的）。
      await vi.waitFor(() => expect(liveChildren().has(itemId)).toBe(false), { timeout: 15_000 });
      const plc = await plcClient(chat.daemon);
      await plc.performAttemptAction(paused.runId, "resume");
      await vi.waitFor(() => expect(getRun(db, paused.runId)?.state).toBe("finished"), { timeout: 15_000 });
      expect(getRun(db, paused.runId)).toMatchObject({ purpose: "execution", external_session_id: "paused-exec" });
      expect(db.prepare("SELECT next_step FROM checkpoints WHERE idempotency_key=?").get(`run-start:${paused.runId}`))
        .toEqual({ next_step: "Continue the assigned execution phase." });
      // fake pi 不调交接工具。执行 Run 的收尾为它排一个成果修复回合；对话 Run 的收尾不会排。
      await vi.waitFor(() => expect(db.prepare(
        "SELECT resume_from_run_id FROM dispatch_requests WHERE item_id=? AND purpose='outcome_repair'",
      ).all(itemId)).toEqual([{ resume_from_run_id: paused.runId }]), { timeout: 15_000 });
    } finally {
      delete process.env.FAKE_SCENARIO;
      delete process.env.PLC_CHILD_LINGER_MS;
      delete process.env.FAKE_PI_CAPTURE;
      await chat.close();
    }
  }, 60_000);

  // 暂停的执行 Run 旁边的对话 Run 还在回答时，用户又发了一句。第二句插进这个对话 Run：
  // 它按 conversation 跑，整段回答都属于第二句的轮次，在 Run 结束时收口。暂停的 Run 一直不动。
  it("seals the steered turn at run end when a second message steers into the conversation beside a paused run", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "paused then steered", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    const paused = pausedExecutionRun(itemId, "paused-steer");
    try {
      await chat.send(itemId, "paused-question", "你现在做到哪了");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });

      await chat.send(itemId, "steer-question", "顺便看下测试");
      await vi.waitFor(() => expect(chat.turns(itemId).map((turn) => turn.state)).toEqual(["completed", "completed"]),
        { timeout: 15_000 });
      expect(chat.turns(itemId)[1]?.assistant_text).toMatch(/^收到，我再看一眼。\n\nanswered: /);
      const runs = ticketRuns(itemId);
      expect(runs.map((run) => [run.purpose, run.state])).toEqual([
        ["execution", "paused"],
        ["conversation", "finished"],
      ]);
      expect(getRun(db, paused.runId)?.external_session_id).toBe("paused-steer");
      // 两个 Run 都按库里的用途跑，所以没有 run_started_as 记录。daemon 重启后接管（adoptRunChild）读到的也是它。
      expect(runs.map((run) => effectiveRunPurpose(db, getRun(db, run.id)!))).toEqual(["execution", "conversation"]);
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='run_started_as'",
      ).get(itemId)).toEqual({ n: 0 });
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 40_000);

  // 暂停的执行 Run 旁边，对话 Run 还在回答。这时恢复会让同一张工单上有两个 Run：网关拒绝，原因交给用户，
  // 暂停的 Run 不动。对话 agent 请求开工（activate_ticket_run）时也不排派发：工作要由恢复控制续接。
  it("refuses a resume through the gateway and queues no work while the chat beside a paused run is live", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "busy chat", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    const paused = pausedExecutionRun(itemId, "paused-busy");
    try {
      await chat.send(itemId, "busy-question", "继续做吧");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const chatRunId = ticketRuns(itemId)[1]!.id;

      const plc = await plcClient(chat.daemon);
      await expect(plc.performAttemptAction(paused.runId, "resume"))
        .rejects.toThrow(new RegExp(`cannot resume run ${paused.runId}: run ${chatRunId} of item ${itemId} is still in progress`));
      expect(getRun(db, paused.runId)!.state).toBe("paused");

      // 对话 Run 里的 agent 用路由写下的那条工单消息作授权，请求开工。
      const result = await createAgentToolHandlers({ db, itemId, runId: chatRunId }).call("activate_ticket_run", {
        mode: "execution", instruction: "继续完成剩余工作", reason: "用户要求继续",
      }) as { status: string; paused_run_id: number };
      expect(result).toMatchObject({ status: "paused", paused_run_id: paused.runId });

      await chat.send(itemId, "busy-steer", "好的");
      await vi.waitFor(() => expect(getRun(db, chatRunId)!.state).toBe("finished"), { timeout: 15_000 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
      expect(ticketRuns(itemId).map((run) => [run.purpose, run.state])).toEqual([
        ["execution", "paused"],
        ["conversation", "finished"],
      ]);
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 60_000);

  // 恢复控制续接 Run 本身，按它原来的用途跑。以前一律按执行 Run 跑：一个暂停的工单对话恢复后拿到整份任务提示，
  // 按 execution 跑，于是暂停的执行 Run 旁边多出第二条工作线。
  it("resumes a paused ticket conversation through the gateway as a conversation, beside a paused execution run", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "paused chat", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    const paused = pausedExecutionRun(itemId, "paused-chat");
    try {
      await chat.send(itemId, "paused-question", "你现在做到哪了");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const chatRunId = ticketRuns(itemId)[1]!.id;
      const plc = await plcClient(chat.daemon);
      await plc.performAttemptAction(chatRunId, "pause");
      // 暂停刚杀掉进程，上一段 runItem 还在收尾。等它结束再恢复。
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });

      process.env.FAKE_SCENARIO = "narrate_then_answer";
      const capture = join(dir, "resume-capture.json");
      process.env.FAKE_PI_CAPTURE = capture;
      await plc.performAttemptAction(chatRunId, "resume");
      await vi.waitFor(() => expect(getRun(db, chatRunId)?.state).toBe("finished"), { timeout: 15_000 });

      const prompt: string = JSON.parse(readFileSync(capture, "utf8")).prompt;
      expect(prompt).toContain("## Resumed ticket conversation");
      expect(prompt).not.toContain("keep going");
      expect(ticketRuns(itemId).map((run) => [run.purpose, run.state])).toEqual([
        ["execution", "paused"],
        ["conversation", "finished"],
      ]);
      expect(effectiveRunPurpose(db, getRun(db, chatRunId)!)).toBe("conversation");
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='run_started_as'",
      ).get(itemId)).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    } finally {
      delete process.env.FAKE_SCENARIO;
      delete process.env.FAKE_PI_CAPTURE;
      await chat.close();
    }
  }, 60_000);

  // 发布评审 run-resume F4：恢复的对话 Run 接着回答，可回答没有对应的聊天轮次。暂停时那一轮被记成失败、从内存里拿掉，
  // 恢复只拉起进程，回答的文字没有地方落，用户在工单对话里什么都看不到。现在恢复把暂停时的那一轮接回来，回答写进它。
  it("puts the answer of a resumed ticket conversation into the turn the pause interrupted", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "paused chat", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    pausedExecutionRun(itemId, "paused-chat");
    try {
      await chat.send(itemId, "paused-question", "你现在做到哪了");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const chatRunId = ticketRuns(itemId)[1]!.id;
      const plc = await plcClient(chat.daemon);
      await plc.performAttemptAction(chatRunId, "pause");
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });
      expect(chat.turns(itemId)[0]).toMatchObject({ state: "failed", error: "Run 已暂停，这一轮回答没有完成。" });

      process.env.FAKE_SCENARIO = "narrate_then_answer";
      await plc.performAttemptAction(chatRunId, "resume");
      await vi.waitFor(() => expect(getRun(db, chatRunId)?.state).toBe("finished"), { timeout: 15_000 });
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.state).toBe("completed"), { timeout: 15_000 });

      const [turn] = chat.turns(itemId);
      expect(chat.turns(itemId)).toHaveLength(1);
      expect(turn).toMatchObject({ user_text: "你现在做到哪了", error: null });
      expect(turn!.assistant_text).toContain("我先去跑一遍验收门。");
      expect(turn!.assistant_text).toContain("done:");
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 60_000);

  // 发布评审（reliability-backlog 5756aba 第 2 处）：恢复时按「这张工单上最新一条因暂停失败的轮次」接回，会接错。
  // channel_turns 不记 Run：同一张工单上有两个暂停的对话 Run 时，恢复旧的那个，回答落进了新 Run 的那一轮。
  // 现在暂停时记下这个 Run 被打断的是哪一轮，恢复时只接回那一轮。
  it("puts a resumed answer into the turn of the run that was resumed, not into another paused run's turn", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "two paused chats", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    pausedExecutionRun(itemId, "paused-exec");
    try {
      const plc = await plcClient(chat.daemon);
      await chat.send(itemId, "first-question", "第一个问题");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const firstRun = ticketRuns(itemId)[1]!.id;
      await plc.performAttemptAction(firstRun, "pause");
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });

      await chat.send(itemId, "second-question", "第二个问题");
      await vi.waitFor(() => expect(chat.turns(itemId)[1]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const secondRun = ticketRuns(itemId)[2]!.id;
      await plc.performAttemptAction(secondRun, "pause");
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });

      process.env.FAKE_SCENARIO = "narrate_then_answer";
      await plc.performAttemptAction(firstRun, "resume");
      await vi.waitFor(() => expect(getRun(db, firstRun)?.state).toBe("finished"), { timeout: 15_000 });
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.state).toBe("completed"), { timeout: 15_000 });

      const [first, second] = chat.turns(itemId);
      expect(first).toMatchObject({ user_text: "第一个问题", error: null });
      expect(first!.assistant_text).toContain("done:");
      expect(second).toMatchObject({ user_text: "第二个问题", state: "failed", error: "Run 已暂停，这一轮回答没有完成。" });
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 60_000);

  // Lead 发起的对话 Run 本来就没有聊天轮次。恢复它不能接走别的 Run 因暂停失败的那一轮。
  it("does not give a resumed run without a chat turn another run's paused turn", async () => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: "lead chat", brief: "keep going", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const chat = await startTicketChatDaemon();
    pausedExecutionRun(itemId, "paused-exec-2");
    try {
      const plc = await plcClient(chat.daemon);
      await chat.send(itemId, "user-question", "用户的问题");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const userRun = ticketRuns(itemId)[1]!.id;
      await plc.performAttemptAction(userRun, "pause");
      await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });
      // Lead 自己发起、没有聊天轮次的对话 Run，也停在暂停。
      const leadRun = createRun(db, { itemId, purpose: "conversation" });
      updateRun(db, leadRun, { state: "running" });
      db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(leadRun);

      process.env.FAKE_SCENARIO = "narrate_then_answer";
      await plc.performAttemptAction(leadRun, "resume");
      await vi.waitFor(() => expect(getRun(db, leadRun)?.state).toBe("finished"), { timeout: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(chat.turns(itemId)).toEqual([
        expect.objectContaining({ user_text: "用户的问题", state: "failed", error: "Run 已暂停，这一轮回答没有完成。" }),
      ]);
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 60_000);

  // 暂停的 reviewer Run 以 reviewer 恢复。以前按 executor 恢复：闸门在 review 里拒绝，Run 被记成失败。
  it("resumes a paused reviewer run through the gateway as a review", async () => {
    process.env.FAKE_SCENARIO = "narrate_then_answer";
    const itemId = createItem(db, { title: "paused review", brief: "check it", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const chat = await startTicketChatDaemon();
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    updateRun(db, runId, { state: "running", sessionId: "paused-review", externalSessionId: "paused-review" });
    db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(runId);
    try {
      const plc = await plcClient(chat.daemon);
      await plc.performAttemptAction(runId, "resume");
      await vi.waitFor(() => expect(getRun(db, runId)?.state).not.toMatch(/^(paused|starting|running)$/), { timeout: 15_000 });
      expect(getRun(db, runId)).toMatchObject({ state: "finished", role: "reviewer", purpose: "review" });
      expect(getItem(db, itemId)!.stage).toBe("review");
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 40_000);

  // 2026-10-20：任何 runtime 都能当核查员。以前 Claude Code 的核查 Run 在这里被网关拒绝恢复，一直暂停着。
  // 现在它通过网关照常恢复，按原来的 role 和 purpose 续接。
  it("resumes through the gateway a paused reviewer run on Claude Code", async () => {
    const itemId = createItem(db, { title: "claude review", brief: "check it", createdBy: "system", runtime: "claude" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const runtime = new ReplayRuntime({
      runtime: "claude", events: [{ type: "run.started", runtime: "claude", model: null }, { type: "run.completed", exitCode: 0 }],
    });
    const start = vi.spyOn(runtime, "start");
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, runtimeRegistry: new RuntimeRegistry([runtime]),
      log: () => {}, gatewayPort: 0,
    });
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude" });
    updateRun(db, runId, { state: "running", sessionId: "claude-review", externalSessionId: "claude-review" });
    db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(runId);
    try {
      const plc = await plcClient(daemon);
      await plc.performAttemptAction(runId, "resume");
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(start.mock.calls[0]![0]).toMatchObject({ runId, role: "reviewer", purpose: "review" });
      await vi.waitFor(() => expect(getRun(db, runId)!.state).toBe("finished"), { timeout: 10_000 });
    } finally {
      await daemon.close();
    }
  }, 40_000);

  // release review 2c：用户暂停或停止了还在回答的工单对话 Run。manager 不为它补 run.failed，
  // 但 pi 适配器在进程被杀时自己发了一条（"Pi process exited before agent_end (143)"），
  // 轮次就带着这句像崩溃的话失败了。轮次上要写用户做了什么。
  it.each([
    ["pause", "Run 已暂停，这一轮回答没有完成。"],
    ["stop", "Run 已停止，这一轮回答没有完成。"],
  ])("closes the open turn when the user %ss the conversation run", async (action, error) => {
    process.env.FAKE_SCENARIO = "answer_steer";
    const itemId = createItem(db, { title: `${action} mid answer`, brief: "answer", createdBy: "system" });
    const chat = await startTicketChatDaemon();
    try {
      await chat.send(itemId, `${action}-question`, "这个单子在干什么");
      await vi.waitFor(() => expect(chat.turns(itemId)[0]?.assistant_text).toBe("我先去查一下。"), { timeout: 15_000 });
      const runId = (db.prepare("SELECT id FROM runs WHERE item_id=?").get(itemId) as { id: number }).id;

      // 用户的暂停和停止走网关（plc 和 companion 都是这样发的）。
      const plc = await plcClient(chat.daemon);
      await plc.performAttemptAction(runId, action as "pause" | "stop");
      // fake pi 8 秒后才会自己回答；轮次必须在这之前、因为 Run 结束而收口。
      await vi.waitFor(() => expect(chat.turns(itemId)).toEqual([
        expect.objectContaining({ state: "failed", assistant_text: "我先去查一下。", error }),
      ]), { timeout: 5_000 });
    } finally {
      delete process.env.FAKE_SCENARIO;
      await chat.close();
    }
  }, 40_000);
});

// 工单 #66 的 Run #71（2026-10-13）：用户在工单里问"现在还需要我做什么"。内核 resume 工单 agent
// 在 2026-08-21 的 Claude 会话，但 Claude Code 已经按保留期删了它的记录，CLI 立即失败。
// 旧代码把它归为 unknown，给 lead 发「Run crashed」，卡片是一个空的 agent 气泡加一条红色错误。
// 这里从用户的那一跳断言：同一条消息得到一次正常的回答，下一条消息 resume 新会话。
describe("daemon ticket chat when the stored runtime session has expired", () => {
  const EXPIRED = "20fd5938-01a7-42ce-b4b4-bb1a98831c80";

  // 一个用 fake Claude 的 daemon。fake Claude 的会话存档是空的：工单上任何 Run 记下的会话都已经过期。
  async function expiredSessionChat(options: { tool?: boolean } = {}) {
    const workdir = tempDir("plc-expired-work-");
    const sessions = join(dir, "claude-sessions");
    mkdirSync(sessions);
    const log = join(dir, "claude-starts.jsonl");
    const claude = new ClaudeRuntime({
      bin: resolve("node_modules/.bin/tsx"),
      prefixArgs: [resolve("packages/runtime/testing/fake-claude.ts")],
      env: {
        FAKE_CLAUDE_SCENARIO: "sessions", FAKE_CLAUDE_SESSION_DIR: sessions, FAKE_CLAUDE_LOG: log,
        ...(options.tool ? { FAKE_CLAUDE_SESSION_TOOL: "1" } : {}),
      },
    });
    const starts = () => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
        resume: string | null; fork: boolean; session: string | null; prompt: string;
      })
      : [];
    const itemId = createItem(db, {
      title: "skills sync", brief: "Install the shared skills", createdBy: "user", runtime: "claude", workdir,
    });
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, runtimeRegistry: new RuntimeRegistry([claude]),
      log: () => {}, gatewayPort: 0,
    });
    const pairing = createPairing(db, { name: "expired-session-client", kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await nextMessage(socket, messages, "hello.v2", (message) => message.type === "hello.v2");
    const send = async (id: string, message: string) => {
      socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, context: { ticketId: itemId } }));
      expect(await nextMessage(socket, messages, `command.result ${id}`,
        (entry) => entry.type === "command.result" && entry.id === id)).toMatchObject({ success: true });
    };
    // 测试自己放进去的轮次（except）不算：只看这次发的消息。
    const except = new Set<string>();
    const turns = () => (db.prepare(
      `SELECT id, user_text, state, assistant_text, error FROM channel_turns
       WHERE item_id=? AND origin_kind LIKE '%:ticket-agent' ORDER BY created_at, rowid`,
    ).all(itemId) as Array<{ id: string; user_text: string; state: string; assistant_text: string; error: string | null }>)
      .filter((turn) => !except.has(turn.id))
      .map(({ id: _id, ...turn }) => turn);
    const expiredDecisions = (runId: number) => db.prepare(
      `SELECT json_extract(payload, '$.expiredSessionId') AS expired FROM activities
       WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='runtime_session_expired'`,
    ).all(runId);
    // 能自己恢复的失败：没有「Run crashed」，lead 没有收到 blocker。
    const expectNoCrash = () => {
      expect(db.prepare("SELECT title FROM checkpoints WHERE item_id=? AND kind='blocked'").all(itemId)).toEqual([]);
      expect(listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === itemId)).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND kind IN ('notification','crash')")
        .get(itemId)).toEqual({ n: 0 });
    };
    const close = async () => {
      socket.close();
      await daemon.close();
      rmSync(workdir, { recursive: true, force: true });
    };
    const snapshot = async () => ((await (await fetch(
      `http://127.0.0.1:${daemon.pairedPort}/v1/conversation/turns?ticket_id=${itemId}&include=tool_calls`,
      { headers: { authorization: `Bearer ${issued.accessToken}` } },
    )).json()) as { items: ConversationTurn[] }).items;
    return { itemId, starts, send, turns, except, expiredDecisions, expectNoCrash, close, messages, snapshot };
  }

  // 会话过期以后，同一个 Run 里换一个新进程重答（c0a4c57）。新进程调的工具仍属于这一轮：
  // turnId 和 textOffset 来自 daemon 记的轮次，不依赖 runtime 事件的编号，所以实时和快照都一样。
  it("keeps the fresh session's tool calls in the same ticket turn", async () => {
    const chat = await expiredSessionChat({ tool: true });
    const delivery = createRun(db, { itemId: chat.itemId, runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, sessionId: EXPIRED, externalSessionId: EXPIRED });
    try {
      await chat.send("expired-tool-question", "你先看看再回答");
      await vi.waitFor(() => expect(chat.turns()[0]?.state).toBe("completed"), { timeout: 20_000 });
      const [, fresh] = chat.starts();
      expect(fresh).toMatchObject({ resume: null, session: expect.stringMatching(/^claude-session-/) });

      const [turn] = (await chat.snapshot()).filter((item) => item.originKind.endsWith(":ticket-agent"));
      expect(turn!.assistantText).toBe(`我先看一下。\n\nanswer in ${fresh!.session}`);
      const live = chat.messages.filter((message) => message.eventId && message.turnId === turn!.id);
      expect(live.filter((event) => event.type === "child.tool.started")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ toolName: "Read", textOffset: "我先看一下。".length }) }),
      ]);
      expect(turn!.toolCalls).toEqual(foldTurnToolCalls(live));
      expect(turn!.toolCalls).toEqual([expect.objectContaining({ name: "Read", state: "completed", textOffset: "我先看一下。".length })]);
    } finally {
      await chat.close();
    }
  }, 40_000);

  it("answers the message in a fresh session with the ticket context and resumes that session next time", async () => {
    const chat = await expiredSessionChat();
    const { itemId, starts, turns } = chat;
    // 工单上一轮对话（在会话过期之前）。新会话要从工单的上下文里看到它。
    const earlier = createTurn(db, {
      originKind: "paired:companion:ticket-agent", itemId, userText: "装好了吗", now: new Date("2026-08-21T09:00:00Z"),
    });
    appendAssistantDelta(db, earlier.id, "装好了，三个技能都在。", new Date("2026-08-21T09:00:05Z"));
    completeTurn(db, earlier.id, new Date("2026-08-21T09:00:05Z"));
    chat.except.add(earlier.id);
    // 启动之后再建这次交付的 Run，避开启动修复。它的会话记录已经不在 fake Claude 的存档里。
    const delivery = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, sessionId: EXPIRED, externalSessionId: EXPIRED });
    try {
      await chat.send("expired-question", "现在还需要我做什么");
      await vi.waitFor(() => expect(turns()[0]?.state).toMatch(/^(completed|failed)$/), { timeout: 20_000 });

      // 同一条消息得到一次正常的回答，没有错误。
      const [resumed, fresh] = starts();
      expect(resumed).toMatchObject({ resume: EXPIRED, fork: false, session: null });
      expect(fresh).toMatchObject({ resume: null, fork: false, session: expect.stringMatching(/^claude-session-/) });
      expect(turns()).toEqual([{
        user_text: "现在还需要我做什么", state: "completed", assistant_text: `answer in ${fresh!.session}`, error: null,
      }]);
      // 新会话拿到工单的上下文：brief、之前的对话，以及这一次的消息。
      expect(fresh!.prompt).toContain("Install the shared skills");
      expect(fresh!.prompt).toContain("装好了吗");
      expect(fresh!.prompt).toContain("装好了，三个技能都在。");
      expect(fresh!.prompt).toContain("现在还需要我做什么");

      // 记下原来的会话过期了、开了新会话。
      const conversationRun = (db.prepare(
        "SELECT id FROM runs WHERE item_id=? AND purpose='conversation'",
      ).get(itemId) as { id: number }).id;
      expect(chat.expiredDecisions(conversationRun)).toEqual([{ expired: EXPIRED }]);
      chat.expectNoCrash();
      expect(getRun(db, conversationRun)).toMatchObject({ state: "finished", external_session_id: fresh!.session });

      // 下一条消息 resume 新会话，不再碰过期的那个。
      await chat.send("next-question", "那我怎么验收");
      await vi.waitFor(() => expect(turns()[1]?.state).toMatch(/^(completed|failed)$/), { timeout: 20_000 });
      expect(starts().slice(2)).toEqual([expect.objectContaining({ resume: fresh!.session, session: fresh!.session })]);
      expect(turns()[1]).toMatchObject({ state: "completed", assistant_text: `answer in ${fresh!.session}`, error: null });
    } finally {
      await chat.close();
    }
  }, 60_000);

  // 工单旁边有一个暂停的执行 Run 时，对话 Run 在它的会话的副本上回答（fork）。fork 一个已经不存在的会话，
  // Claude 报的是同一句话。这时同样开一个新会话回答。暂停的 Run 和它记下的会话都不动，留给恢复控制。
  it("answers beside a paused run in a fresh session when the paused session can no longer be forked", async () => {
    const chat = await expiredSessionChat();
    const { itemId, starts, turns } = chat;
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const paused = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, paused, { state: "running", sessionId: EXPIRED, externalSessionId: EXPIRED });
    db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(paused);
    try {
      await chat.send("paused-question", "你现在做到哪了");
      await vi.waitFor(() => expect(turns()[0]?.state).toMatch(/^(completed|failed)$/), { timeout: 20_000 });

      const [forked, fresh] = starts();
      expect(forked).toMatchObject({ resume: EXPIRED, fork: true, session: null });
      expect(fresh).toMatchObject({ resume: null, fork: false, session: expect.stringMatching(/^claude-session-/) });
      expect(starts()).toHaveLength(2);
      expect(turns()).toEqual([{
        user_text: "你现在做到哪了", state: "completed", assistant_text: `answer in ${fresh!.session}`, error: null,
      }]);
      // 新会话也知道旁边有一个暂停的 Run。
      expect(fresh!.prompt).toContain(`Run #${paused} of this ticket is paused by the user`);

      const conversationRun = (db.prepare(
        "SELECT id FROM runs WHERE item_id=? AND purpose='conversation'",
      ).get(itemId) as { id: number }).id;
      expect(getRun(db, conversationRun)).toMatchObject({
        state: "finished", resumed_from_run_id: paused, external_session_id: fresh!.session,
      });
      expect(chat.expiredDecisions(conversationRun)).toEqual([{ expired: EXPIRED }]);
      // 暂停的 Run 没有被碰：还是 paused，还记着原来的会话。恢复它时，同样的恢复在那时生效。
      expect(getRun(db, paused)).toMatchObject({ state: "paused", external_session_id: EXPIRED });
      chat.expectNoCrash();
    } finally {
      await chat.close();
    }
  }, 60_000);
});

// 插话（steering）的归属：用户在 lead 还在跑的时候发的那句话，回答必须长在**它下面**。
// 真实事故：08:09 那条回合一路涨到 641 字，末尾那句答的是 08:15 才发出的「赶紧终止掉所有
// 的任务和派发」——而 08:15 那条自己是空的、还被滚到了上方，用户于是以为 lead 死了。
describe("daemon 插话回答的归属", () => {
  const readTurn = (id: string) => db.prepare(
    "SELECT state, user_text, assistant_text, origin_kind FROM channel_turns WHERE id=?",
  ).get(id) as { state: string; user_text: string; assistant_text: string; origin_kind: string };

  async function openPairedChat(pairedPort: number | undefined, name: string) {
    const pairing = createPairing(db, { name, kind: "companion", scopes: ["chat", "tickets:view"] });
    const issued = redeemPairing(db, pairing.code);
    const socket = new WebSocket(
      `ws://127.0.0.1:${pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await nextMessage(socket, messages, "hello.v2", (m) => m.type === "hello.v2");
    let counter = 0;
    const chat = async (message: string) => {
      const id = `cmd-${++counter}`;
      socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
      const result = await nextMessage(socket, messages, `command.result ${id}`,
        (m) => m.type === "command.result" && m.id === id);
      expect(result).toMatchObject({ success: true });
      return result.data as { mode: "started" | "steered"; turnId: string };
    };
    return { socket, messages, chat };
  }

  it("模型错误消息不能被当成空白完成轮次", async () => {
    const stub = stubSessionFactory({ response: "error", errorMessage: "401 status code (no body)" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "error-turn-client");
    try {
      const result = await client.chat("恢复18");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("failed"));
      expect(readTurn(result.turnId).assistant_text).toBe("");
      // 存模型的原文：每个客户端用同一套分类自己说（认证失败不叫你重试），「技术详情」里也有原文。
      expect(db.prepare("SELECT error FROM channel_turns WHERE id=?").get(result.turnId))
        .toEqual({ error: "401 status code (no body)" });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM gateway_events WHERE turn_id=? AND event_type='lead.message.completed'",
      ).get(result.turnId)).toEqual({ n: 0 });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM gateway_events WHERE turn_id=? AND event_type='notice.created'",
      ).get(result.turnId)).toEqual({ n: 1 });
    } finally {
      client.socket.close();
      await daemon.close();
    }
  });

  it("存下模型错误的原文时遮住里面的密钥", async () => {
    const token = "ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234";
    const stub = stubSessionFactory({ response: "error", errorMessage: `403 forbidden: Request not allowed (token ${token})` });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "redacted-error-client");
    try {
      const result = await client.chat("现在有什么要我处理");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("failed"));
      const { error } = db.prepare("SELECT error FROM channel_turns WHERE id=?").get(result.turnId) as { error: string };
      expect(error).toContain("403 forbidden: Request not allowed");
      expect(error).not.toContain(token);
      expect(error).not.toContain("请重试");
      const notice = db.prepare(
        "SELECT payload FROM gateway_events WHERE turn_id=? AND event_type='notice.created'",
      ).get(result.turnId) as { payload: string };
      expect(notice.payload).not.toContain(token);
    } finally {
      client.socket.close();
      await daemon.close();
    }
  });

  it("切换 Lead 模型时用系统状态收口，不把空回复当失败", async () => {
    const stub = stubSessionFactory({
      switchLeadModel: {
        previous: "vibeproxy/gemini-3.7-flash-high",
        selected: "vibeproxy/claude-sonnet-5",
      },
    });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "switch-model-client");
    try {
      const result = await client.chat("切到 sonnet 5");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("completed"));
      expect(readTurn(result.turnId).assistant_text).toContain("【系统】");
      expect(readTurn(result.turnId).assistant_text).toContain("vibeproxy/claude-sonnet-5");
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM gateway_events WHERE turn_id=? AND event_type='notice.created'",
      ).get(result.turnId)).toEqual({ n: 0 });
    } finally {
      client.socket.close();
      await daemon.close();
    }
  });

  // 部署闸门（2026-10-19）在 supervisor 的维护入口里，换模型后的重启也经过它。被拒绝时新模型不会生效：要告诉 Lead。
  it("换模型后的重启被部署闸门拒绝时，告诉 Lead 新模型还没生效", async () => {
    const supervisor = createServer((socket) => {
      socket.on("data", (chunk) => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const command = JSON.parse(line) as { type: string; id?: string };
          socket.write(`${JSON.stringify(command.type === "request_maintenance"
            ? { type: "response", id: command.id, success: false, code: "deploy_refused",
                error: "deploy refused:\n- 主 checkout 有没提交的改动：packages/x.ts。" }
            : { type: "response", id: command.id, success: true, data: {} })}\n`);
        }
      });
    });
    await new Promise<void>((done) => supervisor.listen(join(dir, "supervisor.sock"), done));
    const stub = stubSessionFactory({
      switchLeadModel: { previous: "vibeproxy/gemini-3.7-flash-high", selected: "vibeproxy/claude-sonnet-5" },
    });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "switch-model-refused");
    try {
      const result = await client.chat("切到 sonnet 5");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("completed"));
      await vi.waitFor(() => {
        const notice = listInbox(db, {}).find((row) => JSON.parse(row.payload).inboxKind === "lead_model_restart_refused");
        expect(notice?.summary).toContain("packages/x.ts");
        expect(JSON.parse(notice!.payload)).toMatchObject({ wakeLead: true, needsUser: true });
      }, { timeout: 5_000 });
    } finally {
      client.socket.close();
      await daemon.close();
      await new Promise<void>((done) => supervisor.close(() => done()));
    }
  });

  it("换模型后的重启被拒绝的回答在停机以后才到时，不往关掉的库里写", async () => {
    // 回归：部署闸门的回答晚于 daemon 停机时，回调往已经关掉的库里写 inbox，变成没人接的 Promise 拒绝。
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    let release: (() => void) | null = null;
    const supervisor = createServer((socket) => {
      socket.on("data", (chunk) => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const command = JSON.parse(line) as { type: string; id?: string };
          const answer = () => socket.write(`${JSON.stringify(command.type === "request_maintenance"
            ? { type: "response", id: command.id, success: false, code: "deploy_refused", error: "deploy refused: 主 checkout 有没提交的改动" }
            : { type: "response", id: command.id, success: true, data: {} })}\n`);
          if (command.type === "request_maintenance") release = answer;
          else answer();
        }
      });
    });
    await new Promise<void>((done) => supervisor.listen(join(dir, "supervisor.sock"), done));
    const stub = stubSessionFactory({
      switchLeadModel: { previous: "vibeproxy/gemini-3.7-flash-high", selected: "vibeproxy/claude-sonnet-5" },
    });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "switch-model-refused-late");
    try {
      const result = await client.chat("切到 sonnet 5");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("completed"));
      await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5_000 });
      client.socket.close();
      await daemon.close();
      release!();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      await new Promise<void>((done) => supervisor.close(() => done()));
    }
  });

  it("没有错误事件但仍零输出时也按失败结算", async () => {
    const stub = stubSessionFactory({ response: "empty" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "empty-turn-client");
    try {
      const result = await client.chat("你好");
      await vi.waitFor(() => expect(readTurn(result.turnId).state).toBe("failed"));
      expect(db.prepare("SELECT error FROM channel_turns WHERE id=?").get(result.turnId))
        .toEqual({ error: "Lead 未生成回复，请重试。" });
    } finally {
      client.socket.close();
      await daemon.close();
    }
  });

  it("插话之后的文本记到插话那一轮，之前的留在被打断的那一轮", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "steer-client");
    try {
      const first = await client.chat("please HANG");
      expect(first.mode).toBe("started");
      await vi.waitFor(() => expect(readTurn(first.turnId).assistant_text).toContain("HANG"));
      const beforeSteer = readTurn(first.turnId).assistant_text;

      const steered = await client.chat("赶紧终止掉所有的任务和派发");
      expect(steered.mode).toBe("steered");
      expect(steered.turnId).not.toBe(first.turnId);
      await vi.waitFor(() => expect(stub.steers.some((s) => s.includes("赶紧终止"))).toBe(true));

      stub.emitDelta("已立即终止并取消所有未结束的任务与派发");

      // 回答落在插话那一轮：它在会话流里就排在用户那句话下面。
      await vi.waitFor(() => expect(readTurn(steered.turnId).assistant_text)
        .toBe("已立即终止并取消所有未结束的任务与派发"));
      // 被打断的那一轮到此为止，且当场收口（气泡不再生长）。
      expect(readTurn(first.turnId).assistant_text).toBe(beforeSteer);
      expect(readTurn(first.turnId).state).toBe("completed");
      // 线上事件跟着改指向：delta 的 messageId 是插话那一轮的。
      const deltaTurnIds = (db.prepare(
        "SELECT turn_id, payload FROM gateway_events WHERE event_type='lead.message.delta' ORDER BY seq",
      ).all() as Array<{ turn_id: string; payload: string }>);
      expect(deltaTurnIds.at(-1)!.turn_id).toBe(steered.turnId);
      expect(JSON.parse(deltaTurnIds.at(-1)!.payload).messageId).toBe(`msg_${steered.turnId}`);

      stub.releaseHang();
      await vi.waitFor(() => expect(readTurn(steered.turnId).state).toBe("completed"));
      expect(readTurn(steered.turnId).assistant_text).toBe("已立即终止并取消所有未结束的任务与派发");
    } finally {
      client.socket.close();
      await daemon.close();
    }
  }, 20000);

  it("插话之后 lead 没再开口时不制造空气泡：原轮次保住文本，插话停在 steered", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "silent-steer-client");
    try {
      const first = await client.chat("please HANG");
      await vi.waitFor(() => expect(readTurn(first.turnId).assistant_text).toContain("HANG"));
      const beforeSteer = readTurn(first.turnId).assistant_text;

      const steered = await client.chat("顺便看一眼 #2");
      await vi.waitFor(() => expect(readTurn(steered.turnId).state).toBe("steered"));

      stub.releaseHang();
      await vi.waitFor(() => expect(readTurn(first.turnId).state).toBe("completed"));
      expect(readTurn(first.turnId).assistant_text).toBe(beforeSteer);
      expect(readTurn(steered.turnId).assistant_text).toBe("");
      expect(readTurn(steered.turnId).state).toBe("steered");
    } finally {
      client.socket.close();
      await daemon.close();
    }
  }, 20000);

  it("连续两次插话共用后面那一个气泡：最后说的那句才是回答的落点", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "double-steer-client");
    try {
      const first = await client.chat("please HANG");
      await vi.waitFor(() => expect(readTurn(first.turnId).assistant_text).toContain("HANG"));

      const steerA = await client.chat("先停一下");
      await vi.waitFor(() => expect(stub.steers.some((s) => s.includes("先停一下"))).toBe(true));
      const steerB = await client.chat("你怎么一直没回复我了");
      await vi.waitFor(() => expect(stub.steers.some((s) => s.includes("没回复"))).toBe(true));

      stub.emitDelta("都停了，刚才在跑工具");
      await vi.waitFor(() => expect(readTurn(steerB.turnId).assistant_text).toBe("都停了，刚才在跑工具"));
      // 中间那次没等到自己的回答——一段话不能同时归两个人问的问题，落点取最后那句。
      expect(readTurn(steerA.turnId).assistant_text).toBe("");
      expect(readTurn(steerA.turnId).state).toBe("steered");

      stub.releaseHang();
      await vi.waitFor(() => expect(readTurn(steerB.turnId).state).toBe("completed"));
    } finally {
      client.socket.close();
      await daemon.close();
    }
  }, 20000);

  it("message_end 补尾按本条消息比对：多消息回合补得上，插话之后的尾巴归插话那一轮", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "reconcile-client");
    try {
      const first = await client.chat("please HANG");
      await vi.waitFor(() => expect(readTurn(first.turnId).assistant_text).toContain("HANG"));
      const streamed = readTurn(first.turnId).assistant_text;

      // 第一条消息收尾：全文与已流过的一致，不该重复追加。
      stub.emitMessageEnd(streamed);
      expect(readTurn(first.turnId).assistant_text).toBe(streamed);

      // 同一回合的第二条消息：只流出一半，补尾补的是这条消息缺的那截（旧实现拿整轮文本
      // 比，第二条起 startsWith 永远不成立，尾巴会被静默丢掉）。
      stub.emitDelta("第二条消息开头");
      stub.emitMessageEnd("第二条消息开头，还有没流出来的尾巴");
      expect(readTurn(first.turnId).assistant_text)
        .toBe(`${streamed}第二条消息开头，还有没流出来的尾巴`);
      const beforeSteer = readTurn(first.turnId).assistant_text;

      // 插话之后一个 delta 都没来，回答整条从 message_end 补出来——它仍属插话那一轮。
      const steered = await client.chat("那先取消掉");
      await vi.waitFor(() => expect(stub.steers.some((s) => s.includes("那先取消掉"))).toBe(true));
      stub.emitMessageEnd("已取消");
      expect(readTurn(steered.turnId).assistant_text).toBe("已取消");
      expect(readTurn(first.turnId).assistant_text).toBe(beforeSteer);

      stub.releaseHang();
      await vi.waitFor(() => expect(readTurn(steered.turnId).state).toBe("completed"));
    } finally {
      client.socket.close();
      await daemon.close();
    }
  }, 20000);

  // 没有轮次概念的入口（旧版 paired 连接、aish）插进别人的回合时，现开一条锚。
  it("无轮次入口插进 paired 回合时也现开一条锚，回答不再挂到别人的气泡上", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const client = await openPairedChat(daemon.pairedPort, "cli-steer-client");
    const legacy = await openLegacyChat(daemon.pairedPort, "legacy-steer");
    const cliMessages = legacy.received;
    try {

      const first = await client.chat("please HANG");
      await vi.waitFor(() => expect(readTurn(first.turnId).assistant_text).toContain("HANG"));
      const beforeSteer = readTurn(first.turnId).assistant_text;

      legacy.chat("CLI 插一句");
      await vi.waitFor(() => expect(cliMessages.some((m) => m.type === "steered")).toBe(true));

      stub.emitDelta("回 CLI 的话");
      const anchor = await vi.waitFor(() => {
        const row = db.prepare(
          "SELECT id FROM channel_turns WHERE origin_kind='paired:companion:legacy-steer' AND user_text=?",
        ).get("CLI 插一句") as { id: string } | undefined;
        expect(row).toBeDefined();
        return row!.id;
      });
      expect(readTurn(anchor).assistant_text).toBe("回 CLI 的话");
      expect(readTurn(first.turnId).assistant_text).toBe(beforeSteer);
      expect(readTurn(first.turnId).state).toBe("completed");

      stub.releaseHang();
      await vi.waitFor(() => expect(readTurn(anchor).state).toBe("completed"));
    } finally {
      legacy.close();
      client.socket.close();
      await daemon.close();
    }
  }, 20000);

  it("没有可见回合可改接时，无轮次入口的插话不凭空造轮次", async () => {
    const stub = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stub.factory as any, log: () => {}, gatewayPort: 0,
    });
    const legacy = await openLegacyChat(daemon.pairedPort, "legacy-only");
    const cliMessages = legacy.received;
    try {
      legacy.chat("please HANG");
      await vi.waitFor(() => expect(cliMessages.some((m) => m.type === "delta")).toBe(true));
      legacy.chat("CLI 插一句");
      await vi.waitFor(() => expect(cliMessages.some((m) => m.type === "steered")).toBe(true));
      expect(stub.steers.some((steer) => steer.includes("\nCLI 插一句\n</user_message>"))).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM channel_turns").get()).toEqual({ n: 0 });
      stub.releaseHang();
      await vi.waitFor(() => expect(cliMessages.some((m) => m.type === "turn_end")).toBe(true));
    } finally {
      legacy.close();
      await daemon.close();
    }
  }, 20000);
});

// 第四轮 release review：对话结束后的工作区检查在后台算（review-currency.ts）。daemon 停机时要等它
// 算完再关库，否则这次对话的改动就丢了，卡片一直挂着过期的 PASS。
describe("daemon shutdown", () => {
  it("waits for a pending conversation workspace check before it closes", async () => {
    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {} });
    const itemId = createItem(db, { title: "reviewed", brief: "b", createdBy: "system", verificationPolicy: "independent_reviewer" });
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "pass", evidence: "green" });
    const chat = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
    let release: () => void = () => {};
    setWorkspaceTreeHashForTesting(async () => {
      await new Promise<void>((done) => { release = done; });
      return "after the chat";
    });
    try {
      scheduleConversationWorkspaceCheck(db, { itemId, runId: chat, reviewerRunId: reviewer, path: dir, before: "before the chat" });
      let closed = false;
      const closing = daemon.close().then(() => { closed = true; });
      await new Promise((done) => setTimeout(done, 300));
      expect(closed).toBe(false);

      release();
      await closing;
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='workspace_changed_after_review'",
      ).get(itemId)).toEqual({ n: 1 });
    } finally {
      release();
      setWorkspaceTreeHashForTesting();
    }
  }, 20_000);
});

describe("daemon single-instance guard", () => {
  it("refuses to start a second daemon on a live socket (no zombie)", async () => {
    const { factory } = stubSessionFactory();
    const d1 = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0 });
    await expect(
      startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0 }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    // 第一个仍然可达（没被第二次启动删 sock 搞成僵尸）
    const sock = connect(d1.sockPath);
    await new Promise<void>((r, rej) => { sock.once("connect", () => r()); sock.once("error", rej); });
    sock.destroy();
    await d1.close();
  }, 15000);
});

describe("daemon dev companion gateway", () => {
  it("parses an explicit loopback auto-pair flag instead of treating its presence as disabled", () => {
    expect(loopbackAutoPairEnabled({ PLC_DEV: "1", PLC_ALLOW_LOOPBACK_AUTO_PAIR: "true" })).toBe(true);
    expect(loopbackAutoPairEnabled({ PLC_DEV: "1", PLC_ALLOW_LOOPBACK_AUTO_PAIR: "0" })).toBe(false);
    expect(loopbackAutoPairEnabled({ PLC_DEV: "1" })).toBe(true);
    expect(loopbackAutoPairEnabled({ PLC_DEV: "0" })).toBe(false);
  });

  it("allows the local web UI to loopback-pair from localhost and 127.0.0.1 origins in dev", async () => {
    const previousDev = process.env.PLC_DEV;
    const previousAllow = process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR;
    const previousOrigins = process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS;
    process.env.PLC_DEV = "1";
    delete process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR;
    process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS = "http://localhost:8081";

    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8081" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(response.status).toBe(201);
    } finally {
      await daemon.close();
      if (previousDev === undefined) delete process.env.PLC_DEV;
      else process.env.PLC_DEV = previousDev;
      if (previousAllow === undefined) delete process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR;
      else process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR = previousAllow;
      if (previousOrigins === undefined) delete process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS;
      else process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS = previousOrigins;
    }
  }, 15000);
});

describe("daemon serves the companion web UI", () => {
  it("defaults the web root to dist/web in the project root", () => {
    expect(defaultWebRoot()).toBe(fileURLToPath(new URL("../dist/web", import.meta.url)));
  });

  it("serves the web UI and auto-pairs it from its own origin without an origin allowlist", async () => {
    const previousDev = process.env.PLC_DEV;
    const previousAllow = process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR;
    const previousOrigins = process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS;
    delete process.env.PLC_DEV;
    delete process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS;
    process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR = "1";
    const webRoot = join(dir, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<html>companion</html>");

    const { factory } = stubSessionFactory();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0, webRoot,
    });
    try {
      const base = `http://127.0.0.1:${daemon.pairedPort}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<html>companion</html>");

      const paired = await fetch(`${base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ name: "gateway-web" }),
      });
      expect(paired.status).toBe(201);
      const { access_token } = await paired.json() as { access_token: string };
      const overview = await fetch(`${base}/v1/overview`, {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(overview.status).toBe(200);

      const foreign = await fetch(`${base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8081" },
        body: JSON.stringify({ name: "dev-server" }),
      });
      expect(foreign.status).toBe(403);
    } finally {
      await daemon.close();
      if (previousDev === undefined) delete process.env.PLC_DEV;
      else process.env.PLC_DEV = previousDev;
      if (previousAllow === undefined) delete process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR;
      else process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR = previousAllow;
      if (previousOrigins === undefined) delete process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS;
      else process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS = previousOrigins;
    }
    const reopened = openDb(dbPath);
    expect(listBindings(reopened).map((binding) => binding.display_name)).toEqual(["gateway-web"]);
    reopened.close();
  }, 15000);
});

describe("startDaemon 孤儿恢复集成（真实 spawnItemChild 闭包）", () => {
  it("boot 时把 active 孤儿标 crash 并经真实闭包重派出新 Run（含 blocked→active actor:system 扭转）", async () => {
    // 预置：active 工单 + running 孤儿 Run（假 pid，模拟上次 daemon 崩溃遗留）
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const orphanRun = createRun(db, { itemId });
    updateRun(db, orphanRun, { state: "running", pid: 999_999_999 });
    db.close(); // 交出连接，让 daemon 独占打开（同一 dbPath）

    const { factory } = stubSessionFactory();
    const d = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {}, gatewayPort: 0,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    });

    const vdb = openDb(dbPath); // 独立只读视角查断言
    try {
      // 旧孤儿如实标 crash
      expect(getRun(vdb, orphanRun)!.state).toBe("failed");
      // 真实闭包 spawnItemChild → runItem 同步 createRun：总 Run 数应为 2
      const count = (vdb.prepare("SELECT COUNT(*) AS c FROM runs WHERE item_id = ?")
        .get(itemId) as { c: number }).c;
      expect(count).toBe(2);
      // 重派路径 blocked→active（actor:system，manager.ts）成功后，工单在 active
      expect(getItem(vdb, itemId)!.stage).toBe("active");
      // 通知降级 attention（非 blocker）
      expect(listInbox(vdb, { severity: "attention" }).some((r) => r.summary.includes("自动重派"))).toBe(true);
      expect(listInbox(vdb, { severity: "blocker" }).length).toBe(0);
    } finally {
      vdb.close();
      await d.close();
    }
  }, 15000);
});

describe("DaemonAlreadyRunningError", () => {
  it("is a real Error subclass carrying the sock path in its message", () => {
    const err = new DaemonAlreadyRunningError("daemon already running at /tmp/plc.sock");
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("daemon already running at /tmp/plc.sock");
  });
});

describe("daemon × aish integration", () => {
  it("routes slack event through lead and streams reply back; steers when busy", async () => {
    const aish: FakeAish = await startFakeAish();
    const { factory, steers, releaseHang } = stubSessionFactory();
    const d = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: factory as any, log: () => {},
      aish: {
        url: aish.url, token: "bf_test",
        timeouts: { authMs: 1000, pingMs: 60_000, pongMs: 30_000, backoffBaseMs: 50, backoffMaxMs: 200, ackMs: 1000, flushChars: 8, flushMs: 20 },
      },
    });

    // 等适配器完成握手
    await vi.waitFor(() => {
      expect(aish.received.some((m) => m.type === "auth")).toBe(true);
    }, { timeout: 10_000 });

    // Slack 事件 → lead（stub 回显）→ 流式回帖。回帖内容在 append 里（stop 不带 text，防重复）
    aish.dispatchEvent("现在有哪些任务？");
    await vi.waitFor(() => {
      expect(aish.received.some((m) => m.type === "stream_stop")).toBe(true);
      const appended = aish.received.filter((m) => m.type === "stream_append").map((m) => m.text).join("");
      expect(appended).toContain("echo:");
      expect(appended).toContain("Slack"); // 来源前缀进了 lead 的输入
    }, { timeout: 5000 });
    // 接线核实（Task 6）：事件路由的同时把投递目标落盘，不是只停留在内存变量里
    // fake-aish dispatchEvent 的默认 channel/thread 见 test/fake-aish.ts:67
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "C123", threadTs: "1712.001" });

    // busy 场景：挂起一轮，再来一条 slack 消息 → steer + 插话确认回帖
    aish.dispatchEvent("please HANG");
    await vi.waitFor(() => {
      expect(aish.received.filter((m) => m.type === "stream_start").length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });
    aish.dispatchEvent("顺便查一下 #2");
    await vi.waitFor(() => expect(steers.some((s) => s.includes("#2"))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => {
      expect(aish.received.some((m) => m.type === "send_message" && m.text?.includes("已插话"))).toBe(true);
    }, { timeout: 10_000 });
    releaseHang();

    await d.close();
    await aish.close();
  }, 20000);

  it("survives daemon restart: persisted origin is recovered and used to push a pending approval", async () => {
    const aish: FakeAish = await startFakeAish();
    const aishOpts = {
      url: aish.url, token: "bf_test",
      timeouts: { authMs: 1000, pingMs: 60_000, pongMs: 30_000, backoffBaseMs: 50, backoffMaxMs: 200, ackMs: 1000, flushChars: 8, flushMs: 20 },
    };

    // 第一个 daemon：走一轮真实事件，把投递目标落盘
    const { factory: factory1 } = stubSessionFactory();
    const d1 = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory1 as any, log: () => {}, aish: aishOpts });
    await vi.waitFor(() => expect(aish.received.some((m) => m.type === "auth")).toBe(true), { timeout: 10_000 });
    aish.dispatchEvent("hi", "D09XXX", "1721.001");
    await vi.waitFor(() => {
      expect(loadLastAishOrigin(db)).toEqual({ channelId: "D09XXX", threadTs: "1721.001" });
    }, { timeout: 10_000 });
    await d1.close();

    // 重启前挂一个待批审批——第二个 daemon 起来后靠恢复的 origin 主动推送，不等新的 Slack 消息。
    // 2026-10-15 起审批由 Lead 转达，系统只在快过期时自己推：这里把余量设成审批的整个有效期，让系统马上推。
    const approvalId = createApproval(db, { requestedBy: "lead", tool: "test_tool", action: "重启后投递验证" });
    process.env.PLC_APPROVAL_DEADLINE_MARGIN_MS = String(365 * 24 * 60 * 60_000);

    // 第二个 daemon：同一 dbPath，模拟 daemon 重启
    const { factory: factory2 } = stubSessionFactory();
    const d2 = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory2 as any, log: () => {}, aish: aishOpts });
    await vi.waitFor(() => {
      expect(aish.received.filter((m) => m.type === "auth").length).toBeGreaterThanOrEqual(2);
    }, { timeout: 10_000 });

    // 恢复读取路径：重启后仍能读到重启前落盘的投递目标
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "D09XXX", threadTs: "1721.001" });

    // 端到端：daemon 用恢复的 origin（而非本轮新事件）主动把待批审批推给 aish（3s 轮询触发）
    await vi.waitFor(() => {
      expect(aish.received.some((m) =>
        m.type === "approval_request" && m.approval_id === String(approvalId) &&
        m.channel_id === "D09XXX" && m.thread_ts === "1721.001")).toBe(true);
    }, { timeout: 5000 });

    await d2.close();
    await aish.close();
    delete process.env.PLC_APPROVAL_DEADLINE_MARGIN_MS;
  }, 20000);

  it("routes AiSH approval results and expiry sweeps through Coordinator transactions", async () => {
    const aish: FakeAish = await startFakeAish();
    const itemId = createItem(db, { title: "authority", brief: "coordinator", createdBy: "system" });
    const approvalId = createApproval(db, {
      itemId,
      requestedBy: "child",
      tool: "deploy",
      action: "Deploy through AiSH",
    });
    const expiring = insertDecisionRequest(db, {
      itemId,
      kind: "question",
      audience: "user",
      prompt: "Expired decision",
      allowCustom: true,
      expiresAt: "2026-07-24T00:00:00.000Z",
    });
    const { factory } = stubSessionFactory();
    const d = await startDaemon({
      dataDir: dir,
      dbPath,
      sessionFactory: factory as any,
      log: () => {},
      aish: {
        url: aish.url,
        token: "bf_test",
        timeouts: {
          authMs: 1000,
          pingMs: 60_000,
          pongMs: 30_000,
          backoffBaseMs: 50,
          backoffMaxMs: 200,
          ackMs: 1000,
          flushChars: 8,
          flushMs: 20,
        },
      },
    });
    try {
      await vi.waitFor(() => expect(aish.received.some((message) => message.type === "auth")).toBe(true));
      aish.sendRaw({
        type: "approval_result",
        approval_id: String(approvalId),
        decision: "acceptForSession",
        user_id: "U_COORDINATOR",
      });
      await vi.waitFor(() => {
        expect(getApproval(db, approvalId)).toMatchObject({ status: "approved", session_exempt: 1 });
        expect(getDecisionRequest(db, expiring.id)?.state).toBe("expired");
      }, { timeout: 5000 });
      // Slack 按钮是用户本人点的：记成 user via slack，不经过 Lead 的操作层（2026-10-22 P02 以后照样能用）。
      expect(getApproval(db, approvalId)?.resolved_by).toBe("user via slack:U_COORDINATOR");
      // Slack 按钮是用户本人点的：记成 user via slack，不经过 Lead 的操作层（2026-10-22 P02 以后照样能用）。
      expect(getApproval(db, approvalId)?.resolved_by).toBe("user via slack:U_COORDINATOR");
      expect(db.prepare(
        "SELECT idempotency_key FROM checkpoints WHERE idempotency_key LIKE 'approval-resolved:%'",
      ).all()).toEqual([
        { idempotency_key: `approval-resolved:${approvalId}:approved` },
      ]);
      expect(db.prepare(
        "SELECT idempotency_key FROM checkpoints WHERE idempotency_key=?",
      ).get(`decision-resolved:${expiring.id}`)).toEqual({
        idempotency_key: `decision-resolved:${expiring.id}`,
      });
    } finally {
      await d.close();
      await aish.close();
    }
  }, 15_000);

  // 回归测试：持久化的 token 已经失效时，每次 daemon 重启都会重连一次、被 AUTH_FAILED 拒绝、
  // 再弹一次"aish 配对失效"的桌面通知。同一个 token 只该通知一次。
  it("notifies once for a stored token that failed auth, and skips it on the next start", async () => {
    vi.stubEnv("PLC_AISH_TOKEN", undefined);
    vi.stubEnv("PLC_AISH_URL", undefined);
    const aish: FakeAish = await startFakeAish({ token: "bf_fresh" });
    saveAishConn(db, aish.url, "bf_revoked");
    const notified: string[] = [];
    const logs: string[] = [];
    const start = () => startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubSessionFactory().factory as any,
      log: (line) => logs.push(line), notifyDesktop: (text) => notified.push(text),
    });
    try {
      const d1 = await start();
      await vi.waitFor(() => expect(notified).toHaveLength(1), { timeout: 10_000 });
      expect(notified[0]).toContain("AUTH_FAILED");
      await d1.close();

      // 同一个 token 再启动：不重连，不通知，只记一行日志。
      const d2 = await start();
      await new Promise((r) => setTimeout(r, 500));
      expect(aish.connections).toBe(1);
      expect(notified).toHaveLength(1);
      expect(logs.filter((line) => line.includes("[aish] skipped"))).toHaveLength(1);
      expect(logs.join("\n")).not.toContain("bf_revoked");
      await d2.close();

      // 从环境变量换一个新 token：标记失效，正常连上。
      vi.stubEnv("PLC_AISH_TOKEN", "bf_fresh");
      vi.stubEnv("PLC_AISH_URL", aish.url);
      const d3 = await start();
      await vi.waitFor(() => {
        expect(listBindings(db).some((b) => b.kind === "aish-slack" && b.external_subject === "bot_1")).toBe(true);
      }, { timeout: 10_000 });
      expect(aish.connections).toBe(2);
      expect(notified).toHaveLength(1);
      expect(getAishConnStatus(db)).toMatchObject({ stored: true, url: aish.url, failure: null });
      await d3.close();
    } finally {
      vi.unstubAllEnvs();
      await aish.close();
    }
  }, 30_000);

  // AUTH_TIMEOUT 只说明这次握手超时，不说明 token 无效：通知，但不记失败标记，下次启动照常重连。
  it("does not mark the token failed on AUTH_TIMEOUT", async () => {
    vi.stubEnv("PLC_AISH_TOKEN", undefined);
    vi.stubEnv("PLC_AISH_URL", undefined);
    const aish: FakeAish = await startFakeAish({ rejectAuth: true, authErrorCode: "AUTH_TIMEOUT" });
    saveAishConn(db, aish.url, "bf_slow");
    const notified: string[] = [];
    try {
      const d = await startDaemon({
        dataDir: dir, dbPath, sessionFactory: stubSessionFactory().factory as any,
        log: () => {}, notifyDesktop: (text) => notified.push(text),
      });
      await vi.waitFor(() => expect(notified).toHaveLength(1), { timeout: 10_000 });
      await d.close();
      expect(getAishConnStatus(db)).toMatchObject({ stored: true, failure: null });
    } finally {
      vi.unstubAllEnvs();
      await aish.close();
    }
  }, 20_000);
});
