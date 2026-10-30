import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, pauseRun, resumeRun, updateRun } from "@pi-lead-child/store";
import { getWorkspace } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren, runItem } from "../src/children/manager.js";
import { CodexRuntime } from "@pi-lead-child/runtime";

const FAKE_PI = resolve("node_modules/.bin/tsx");
const FAKE_PI_ARGS = [resolve("packages/runtime/testing/fake-pi.ts")];

let db: Db;
let dbPath: string;
// runItem 不给 dataDir 时用 sessionDir 的祖父目录。不设 TMPDIR（env -i）时 tempDir 在 /tmp 下，祖父目录就是 /。
let dataDir: string;
let itemId: number;
beforeEach(() => {
  process.env.PLC_CHILD_LINGER_MS = "0"; // 本组测试沿用"单 prompt 即收工"语义
  const dir = tempDir("plc-");
  dataDir = dir;
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "t", brief: "写一个 hello world", createdBy: "system" });
});

describe("runItem", () => {
  it("blocks a cleanly finished run that omitted terminal handoff", async () => {
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
    });
    expect(getRun(db, runId)!.state).toBe("finished");
    expect(getRun(db, runId)!.session_id).toBe("fake-session-1");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(getItem(db, itemId)!.total_tokens).toBe(150);
    const kinds = listActivities(db, itemId).map((a) => a.kind);
    expect(kinds).toContain("attempt_start");
    expect(kinds).toContain("attempt_end");
    expect(db.prepare(
      "SELECT title FROM checkpoints WHERE idempotency_key=?",
    ).get(`run-handoff-failed:${runId}`)).toEqual({ title: "运行结束，交接失败" });
    // 交接失败先交给 Lead（2026-10-15 起）：Lead 收到 blocker，用户不收通知。
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(JSON.parse((db.prepare("SELECT payload FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId) as { payload: string }).payload))
      .toMatchObject({ blockerCode: "terminal_handoff_failed", needsUser: false });
  });

  it("detects crash: run failed, item blocked", async () => {
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
      env: { FAKE_SCENARIO: "crash" },
    });
    expect(getRun(db, runId)!.state).toBe("failed");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
  });

  it("spawn failure (bad bin) degrades to failed, does not throw", async () => {
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir, piBin: "/nonexistent/pi-binary-xyz", piArgs: ["--mode", "rpc"],
      prompt: "x", sessionDir: tempDir("plc-sess-"),
    });
    expect(getRun(db, runId)!.state).toBe("failed");
    // 找不到可执行文件是 profile 的故障（工单 03）：它记在健康账本上，工单不进 blocked，
    // 而是等内核排的重试请求在 runtime 修好后再走。
    expect(getRun(db, runId)!.failure_code).toBe("executable_missing");
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(db.prepare("SELECT code FROM runtime_incidents").all()).toEqual([{ code: "executable_missing" }]);
    expect(db.prepare("SELECT trigger, state FROM dispatch_requests WHERE item_id=?").all(itemId))
      .toEqual([{ trigger: "runtime-health-retry", state: "pending" }]);
  });

  // 原来这里把工作区标成 failed。工单 03 之后，同一次启动失败会排一个内核重试（见上一个测试），
  // failed 的工作区让这个重试永远启动不了（工单 79）。工作区没有被用过，所以保持 requested。
  it("keeps a newly reserved workspace launchable when runtime startup fails", async () => {
    const workdir = join(tempDir("plc-ws-fail-"), "workdir");
    db.prepare("UPDATE items SET workdir = ? WHERE id = ?").run(workdir, itemId);
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir, piBin: "/nonexistent/pi-binary-workspace", piArgs: ["--mode", "rpc"],
      prompt: "x", sessionDir: tempDir("plc-sess-"),
    });
    const run = getRun(db, runId)!;
    expect(run.state).toBe("failed");
    const workspaceId = run.workspace_id!;
    expect(getWorkspace(db, workspaceId)!.state).toBe("requested");
  });

  it("releases an active workspace to idle when a started Run later fails", async () => {
    const workdir = join(tempDir("plc-ws-runtime-fail-"), "workdir");
    db.prepare("UPDATE items SET workdir = ? WHERE id = ?").run(workdir, itemId);
    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "crash", sessionDir: tempDir("plc-sess-"),
      env: { FAKE_SCENARIO: "crash" },
    });
    expect(getRun(db, runId)!.state).toBe("failed");
    expect(getWorkspace(db, getRun(db, runId)!.workspace_id!)!.state).toBe("idle");
  });

  it("rejects an incompatible runtime model before changing item state or creating a Run", async () => {
    await expect(runItem(db, itemId, {
      dbPath, dataDir,
      runtime: new CodexRuntime({ bin: "/nonexistent/codex" }),
      model: "anthropic/claude-opus",
      prompt: "x",
      sessionDir: tempDir("plc-sess-"),
    })).rejects.toThrow(/runtime 'codex' cannot use model/);

    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
  });

  it("creates a missing workdir before spawning", async () => {
    const workdir = join(tempDir("plc-wd-"), "workdir");
    db.prepare("UPDATE items SET workdir = ? WHERE id = ?").run(workdir, itemId);
    await runItem(db, itemId, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
    });
    expect(existsSync(workdir)).toBe(true);
  });

  it("captures the resolved workspace on the Run before launching", async () => {
    const workdir = join(tempDir("plc-ws-"), "workdir");
    db.prepare("UPDATE items SET workdir = ? WHERE id = ?").run(workdir, itemId);
    const result = await runItem(db, itemId, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
    });
    const run = getRun(db, result.runId)!;
    expect(run.workspace_id).not.toBeNull();
    expect(getWorkspace(db, run.workspace_id!)!.path).toBe(workdir);
  });

  it("does not fall back to process.cwd for a coding item without a workdir", async () => {
    const coding = createItem(db, { title: "coding", brief: "b", createdBy: "system", workflowKind: "coding" });
    await expect(runItem(db, coding, {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
    })).rejects.toThrow(/has no resolved workspace/);
    expect(getItem(db, coding)!.stage).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(coding))
      .toEqual({ n: 0 });
  });

  it("refuses items in terminal stages", async () => {
    const doneId = createItem(db, { title: "d", brief: "d", createdBy: "system" });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(doneId);
    await expect(
      runItem(db, doneId, { dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "x",
        sessionDir: tmpdir() }),
      // validateSpawn 已删除，"能不能开 Run" 现在只由 run-gate 一处回答（spec §6.5），
      // 所以拒绝的措辞变了；被测行为——终态工单开不出 Run——没变。
    ).rejects.toThrow(/executor run requires stage in \{ready, active, blocked\}/);
  });
});

// 同一张工单上的两次启动撞在一起：live 表里已有一个 Run，第二次启动在开始之前就被拒绝。
// 以前兜底边界把 live 表里那个别人的条目删掉并中断它，还把被拒绝的 Run 记成未捕获异常（失败 + blocker）。
describe("a start refused before it began", () => {
  function runOpts(runId: number, purpose: "execution" | "conversation" | "review", role: "executor" | "reviewer" = "executor") {
    return {
      dbPath, dataDir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "x", runId, role, purpose,
      sessionDir: tempDir("plc-sess-"),
    };
  }

  function crashCheckpoints(runId: number): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=? AND kind='blocked'").get(runId) as { n: number }).n;
  }

  it("leaves the live run alone, stops a new run, and puts a resumed run back to paused", async () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const liveRunId = createRun(db, { itemId, purpose: "conversation" });
    updateRun(db, liveRunId, { state: "running" });
    const interrupt = vi.fn(async () => {});
    liveChildren().set(itemId, { runId: liveRunId, streaming: true, handle: { interrupt } as never });
    try {
      const chatRunId = createRun(db, { itemId, purpose: "conversation" });
      await expect(runItem(db, itemId, runOpts(chatRunId, "conversation"))).rejects.toThrow(/already has a live runtime/);
      expect(getRun(db, chatRunId)).toMatchObject({ state: "stopped", error_code: "run_start_refused" });
      expect(crashCheckpoints(chatRunId)).toBe(0);

      const pausedRunId = createRun(db, { itemId });
      updateRun(db, pausedRunId, { state: "running" });
      pauseRun(db, pausedRunId);
      resumeRun(db, pausedRunId);
      await expect(runItem(db, itemId, runOpts(pausedRunId, "execution"))).rejects.toThrow(/already has a live runtime/);
      expect(getRun(db, pausedRunId)).toMatchObject({ state: "paused", error_code: null });
      expect(crashCheckpoints(pausedRunId)).toBe(0);

      expect(liveChildren().get(itemId)?.runId).toBe(liveRunId);
      expect(interrupt).not.toHaveBeenCalled();
      expect(getRun(db, liveRunId)!.state).toBe("running");
    } finally {
      liveChildren().delete(itemId);
    }
  });

  it("stops a run that the run gate refuses at start, instead of recording a crash", async () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const reviewRunId = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    // 核查 Run 建好以后、启动之前，用户验收了工单。
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);

    await expect(runItem(db, itemId, runOpts(reviewRunId, "review", "reviewer")))
      .rejects.toThrow(/reviewer run requires stage 'review'/);
    expect(getRun(db, reviewRunId)).toMatchObject({ state: "stopped", error_code: "run_start_refused" });
    expect(crashCheckpoints(reviewRunId)).toBe(0);
  });
});
