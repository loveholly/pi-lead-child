// 用户控制面（spec §6.4 / §8）：确认、开跑、停下、验收、返工、取消、恢复，以及
// Run 的暂停/恢复/停止。这些边 lead 一条都没有——它们只在这里。
//
// 最重要的一条是 pause：**暂停必须真的把子进程停掉**。只翻一个 DB 列而进程还在跑，
// 那是撒谎——用户看到"已暂停"，token 却还在烧。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import { insertOutcomeSnapshot, normalizeOutcomePayload } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { liveChildren } from "@pi-lead-child/engine";
import { createUserActionService } from "@pi-lead-child/gateway";
import {
  resumeItemChild, routeTicketMessageToAgentRun, spawnItemChild, runningChildren, type LeadDeps,
} from "@pi-lead-child/lead";
import { ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;
let dir: string;
let deps: LeadDeps;

beforeEach(() => {
  dir = tempDir("plc-user-actions-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
  };
});

afterEach(() => {
  liveChildren().clear();
  runningChildren().clear();
  delete process.env.FAKE_SCENARIO;
});

function actions() {
  return createUserActionService({ db });
}

// hold=true 才停在 draft（缺省是建完即跑）；本组测的正是"停下来等用户确认"的那条路。
function draftTask(): number {
  return createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
}

describe("user item actions", () => {
  // 诉求 3 的另一半：用户确认得了。lead 那一半（没有任何工具能做这件事）在 lead-tools 里。
  it("confirms a draft as the user and makes it runnable", () => {
    const id = draftTask();
    expect(getItem(db, id)!.stage).toBe("draft");
    actions().confirmItem(id);
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  it("records the confirmation as the user, not as the lead", () => {
    const id = draftTask();
    actions().confirmItem(id);
    const row = db.prepare(
      "SELECT actor FROM activities WHERE item_id=? AND kind='transition' ORDER BY id DESC LIMIT 1",
    ).get(id) as { actor: string };
    expect(row.actor).toBe("user");
  });

  it("unconfirms back to draft", () => {
    const id = draftTask();
    actions().confirmItem(id);
    actions().unconfirmItem(id);
    expect(getItem(db, id)!.stage).toBe("draft");
  });

  it("refuses to confirm anything that is not a draft", () => {
    const id = draftTask();
    actions().confirmItem(id);
    expect(() => actions().confirmItem(id)).toThrow(/illegal transition ready -> ready/);
  });

  it("keeps the item runnable when the injected runner rejects startup preflight", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const service = createUserActionService({
      db,
      startRun: () => { throw new Error("runtime model is incompatible"); },
    });

    expect(() => service.startItem(id)).toThrow(/runtime model is incompatible/);
    expect(getItem(db, id)!.stage).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(id)).toEqual({ n: 0 });
  });

  it("completes and reworks a review as the user", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    actions().completeItem(id);
    expect(getItem(db, id)!.stage).toBe("done");
    actions().reworkItem(id);
    expect(getItem(db, id)!.stage).toBe("active");
  });

  it("restores a cancelled item to draft", () => {
    const id = draftTask();
    actions().cancelItem(id, "算了");
    expect(getItem(db, id)!.stage).toBe("cancelled");
    actions().restoreItem(id);
    expect(getItem(db, id)!.stage).toBe("draft");
  });

  it("stops an item back to ready and stops its runs", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    await actions().stopItem(id);
    expect(getItem(db, id)!.stage).toBe("ready");
    expect(getRun(db, runId)!.state).toBe("stopped");
  });
});

describe("user run actions", () => {
  it("pauses a run without moving the item stage", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    await actions().pauseRun(runId);
    expect(getRun(db, runId)!.state).toBe("paused");
    // Item 与 Run 是两条独立生命周期（spec §3.2）：暂停的是 Run，事项仍在推进中。
    expect(getItem(db, id)!.stage).toBe("active");
    expect(getRun(db, runId)!.pid).toBeNull();
  });

  it("accumulates paused_ms across a pause/resume cycle", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    const svc = createUserActionService({ db, resumeRun: () => {} });
    await svc.pauseRun(runId, new Date("2026-07-27T10:00:00.000Z"));
    expect(getRun(db, runId)!.paused_at).toBe("2026-07-27T10:00:00.000Z");
    await svc.resumeRun(runId, new Date("2026-07-27T10:00:30.000Z"));
    expect(getRun(db, runId)!.state).toBe("running");
    expect(getRun(db, runId)!.paused_at).toBeNull();
    expect(getRun(db, runId)!.paused_ms).toBe(30_000);
  });

  it("refuses to pause a run that is not running", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId: id });
    await expect(actions().pauseRun(runId)).rejects.toThrow(/cannot pause/);
  });

  it("resumes through the injected runner using the retained session id", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running", sessionId: "sess-keepme" });
    const resumeRun = vi.fn();
    const svc = createUserActionService({ db, resumeRun });
    await svc.pauseRun(runId);
    // 暂停不清 session_id：恢复要复用同一行、同一 session、新 pid（spec §3.2）。
    expect(getRun(db, runId)!.session_id).toBe("sess-keepme");
    await svc.resumeRun(runId);
    expect(resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: id, runId, sessionId: "sess-keepme" }),
    );
  });

  // 工单消息不续接暂停的 Run，而是另起一个对话 Run 回答。对话 Run 还在跑时恢复，同一张工单上就有两个 Run：
  // runItem 拒绝第二个时，兜底边界把恢复的 Run 记成失败，还会中断正在回答的对话。所以先拒绝，状态不动。
  // 恢复按 Run 原来的 role 和 purpose 续接（resumeItemChild）。它不能按原样启动时，恢复被拒绝：
  // Run 保持暂停，原因交给用户。以前恢复先翻成 running，启动失败后 Run 停在 running 或被记成失败。
  // 2026-10-20 起任何 runtime 都能当核查员，Claude Code 的核查 Run 照常恢复（下一条用例）；这里只剩工单离开 review 的情况。
  it.each([
    ["the ticket has left the review stage", "done", /reviewer run requires stage 'review'/],
  ] as const)("keeps a paused reviewer run paused when %s", async (_case, stage, error) => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system", runtime: "claude" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    const runId = createRun(db, { itemId: id, role: "reviewer", purpose: "review", runtime: "claude" });
    updateRun(db, runId, { state: "running", sessionId: "sess-review" });
    const runtime = new ReplayRuntime({
      runtime: "claude", events: [{ type: "run.started", runtime: "claude", model: null }, { type: "run.completed", exitCode: 0 }],
    });
    const start = vi.spyOn(runtime, "start");
    const resumeDeps: LeadDeps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]) };
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(resumeDeps, args); } });
    await svc.pauseRun(runId);
    if (stage === "done") svc.completeItem(id);

    await expect(svc.resumeRun(runId)).rejects.toThrow(error);
    expect(getRun(db, runId)).toMatchObject({ state: "paused", role: "reviewer", purpose: "review" });
    expect(start).not.toHaveBeenCalled();
    expect(runningChildren().has(id)).toBe(false);
  });

  // 2026-10-20：以前 Claude Code 的核查 Run 恢复时被拒（cannot enforce executable read-only review），Run 一直暂停。
  // 现在任何 runtime 都能当核查员：它按原来的 role 和 purpose 续接。2026-10-28 起 Claude Code 的核查员在沙箱里能跑命令
  // （lead-tools-and-routing spec D15），提示里不再说「不能运行命令」。
  it("resumes a paused reviewer run on Claude Code, which can run commands in its sandbox", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system", runtime: "claude" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    const runId = createRun(db, { itemId: id, role: "reviewer", purpose: "review", runtime: "claude" });
    updateRun(db, runId, { state: "running", sessionId: "sess-review" });
    const runtime = new ReplayRuntime({
      runtime: "claude", events: [{ type: "run.started", runtime: "claude", model: null }, { type: "run.completed", exitCode: 0 }],
    });
    const start = vi.spyOn(runtime, "start");
    const resumeDeps: LeadDeps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([runtime]) };
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(resumeDeps, args); } });
    await svc.pauseRun(runId);

    await svc.resumeRun(runId);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toMatchObject({ runId, role: "reviewer", purpose: "review" });
    expect(start.mock.calls[0]![0].prompt).not.toContain("这次核查不能运行命令");
    await vi.waitFor(() => expect(runningChildren().has(id)).toBe(false));
  });

  // 发布评审 run-resume F2：暂停的核查 Run 之后又有了新的交付（返工），再恢复它，核查的就是一份已经不存在的成果。
  // 它的 PASS 在委托验收下会把工单直接推到 done。工单最新的交付比这个核查 Run 新时，拒绝恢复，Run 保持暂停。
  it("refuses to resume a paused reviewer run once a newer delivery exists", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const firstDelivery = createRun(db, { itemId: id });
    updateRun(db, firstDelivery, { state: "finished", endedAt: true });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    const reviewerRunId = createRun(db, { itemId: id, role: "reviewer", purpose: "review" });
    updateRun(db, reviewerRunId, { state: "running", sessionId: "sess-review" });
    const resumeRun = vi.fn();
    const svc = createUserActionService({ db, resumeRun });
    await svc.pauseRun(reviewerRunId);
    // 用户要求返工，新的交付回到 review。
    transition(db, { itemId: id, to: "active", actor: "user", reason: "rework" });
    const newerDelivery = createRun(db, { itemId: id });
    updateRun(db, newerDelivery, { state: "finished", endedAt: true });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });

    await expect(svc.resumeRun(reviewerRunId)).rejects.toThrow(`delivery run ${newerDelivery}`);
    expect(getRun(db, reviewerRunId)).toMatchObject({ state: "paused", role: "reviewer" });
    expect(resumeRun).not.toHaveBeenCalled();
  });

  // 发布评审 run-resume F6：修复回合只补交来源 Run 的成果。暂停以后又跑了一次新的执行，来源 Run 就不再是最新的执行；
  // 恢复它会把成果补交到一份已经被取代的交付上。派发路径会核对来源 Run，恢复路径以前不核对。
  it("refuses to resume a paused outcome repair once its source run is no longer the latest execution", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const source = createRun(db, { itemId: id });
    updateRun(db, source, { state: "finished", endedAt: true });
    const repair = createRun(db, { itemId: id, purpose: "outcome_repair", resumedFromRunId: source });
    updateRun(db, repair, { state: "running", sessionId: "sess-repair" });
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(deps, args); } });
    await svc.pauseRun(repair);
    const newer = createRun(db, { itemId: id });
    updateRun(db, newer, { state: "finished", endedAt: true });

    await expect(svc.resumeRun(repair)).rejects.toThrow(`source run #${source} is not the latest execution run #${newer}`);
    expect(getRun(db, repair)).toMatchObject({ state: "paused", purpose: "outcome_repair" });
    expect(runningChildren().has(id)).toBe(false);
  });

  it("refuses to resume while another run of the ticket is in progress", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running", sessionId: "sess-paused" });
    const resumeRun = vi.fn();
    const svc = createUserActionService({ db, resumeRun });
    await svc.pauseRun(runId);
    const chatRunId = createRun(db, { itemId: id, purpose: "conversation" });

    await expect(svc.resumeRun(runId)).rejects.toThrow(`run ${chatRunId} of item ${id} is still in progress`);
    expect(getRun(db, runId)).toMatchObject({ state: "paused", paused_ms: 0 });
    expect(resumeRun).not.toHaveBeenCalled();

    // 收尾阶段：库里已是 finished，进程还在退出，live 表里还有它。
    updateRun(db, chatRunId, { state: "finished", endedAt: true });
    liveChildren().set(id, { runId: chatRunId, streaming: false });
    await expect(svc.resumeRun(runId)).rejects.toThrow(`run ${chatRunId} of item ${id} is still in progress`);
    expect(resumeRun).not.toHaveBeenCalled();

    liveChildren().delete(id);
    await svc.resumeRun(runId);
    expect(getRun(db, runId)!.state).toBe("running");
    expect(resumeRun).toHaveBeenCalledWith(expect.objectContaining({ itemId: id, runId, sessionId: "sess-paused" }));
  });

  // 对话 Run 离开 live 表以后还有收尾（关工具桥、记 attempt_end、settleChild）。这段时间里恢复，
  // 以前会成功：恢复的 Run 开始跑，对话的 settleChild 再把它在 running 里的条目删掉。现在恢复被拒绝，
  // 暂停的 Run 不动；收尾结束后，恢复照常成功。
  it("refuses a resume while the chat beside the paused run is still finishing, and resumes once it has", async () => {
    const recording = (runtime: "codex") => new ReplayRuntime({
      runtime, events: [{ type: "run.started", runtime, model: null }, { type: "run.completed", exitCode: 0 }],
    });
    const chatDeps: LeadDeps = { ...deps, childPi: undefined, runtimeRegistry: new RuntimeRegistry([recording("codex")]) };
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system", runtime: "codex" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const pausedRunId = createRun(db, { itemId: id, runtime: "codex" });
    updateRun(db, pausedRunId, { state: "running", sessionId: "sess-paused" });
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(chatDeps, args); } });
    await svc.pauseRun(pausedRunId);

    // 对话 Run 一离开 live 表，就立刻恢复暂停的 Run。
    const live = liveChildren();
    const removeLive = live.delete.bind(live);
    let refused: Promise<unknown> | undefined;
    live.delete = (key: number) => {
      const removed = removeLive(key);
      if (key === id && !refused) refused = svc.resumeRun(pausedRunId).then(() => null, (error: unknown) => error);
      return removed;
    };
    try {
      routeTicketMessageToAgentRun(chatDeps, { itemId: id, message: "在吗" });
      await vi.waitFor(() => expect(runningChildren().has(id)).toBe(false), { timeout: 15_000 });
    } finally {
      live.delete = removeLive;
    }
    expect(String(await refused)).toMatch(new RegExp(`cannot resume run ${pausedRunId}: item #${id} still has a run finishing`));
    expect(getRun(db, pausedRunId)!.state).toBe("paused");

    await svc.resumeRun(pausedRunId);
    await vi.waitFor(() => expect(getRun(db, pausedRunId)!.state).toBe("finished"), { timeout: 15_000 });
    await vi.waitFor(() => expect(runningChildren().has(id)).toBe(false));
  });

  // 诉求 4 的硬性部分：**暂停必须真的把进程杀掉**，不是只翻一个 DB 列。
  it("actually terminates the child process on pause", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    deps.env = { FAKE_SCENARIO: "slow" };
    spawnItemChild(deps, id, {});
    // 等 child 真的起来并进入 streaming
    await vi.waitFor(() => {
      const child = liveChildren().get(id);
      expect(child?.proc?.pid).toBeGreaterThan(0);
    }, { timeout: 8000 });
    const child = liveChildren().get(id)!;
    const proc = child.proc!;
    const runId = child.runId;
    updateRun(db, runId, { state: "running" });

    await actions().pauseRun(runId);

    // 进程真的没了——这条断言是整个诉求 4 的分界线。
    await vi.waitFor(() => {
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    }, { timeout: 8000 });
    expect(getRun(db, runId)!.state).toBe("paused");
    expect(getRun(db, runId)!.pid).toBeNull();
    // 暂停不是崩溃：进程被我们杀掉后，ingest 的退出通路不得把它改写成 failed。
    await new Promise((r) => setTimeout(r, 300));
    expect(getRun(db, runId)!.state).toBe("paused");
    expect(getItem(db, id)!.stage).toBe("active");
  }, 20_000);
});

// release review 7：恢复的 Run 结束、工单停在 review 时，manager 请求自动核查。reviewer runtime
// 要和其他启动路径（spawn、认领、工单对话、orchestrator）一致；以前恢复路径不传，就落到了默认值。
describe("a resumed delivery that ends in review", () => {
  it("asks for the automatic review with the same reviewer runtime as the other start paths", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system", verificationPolicy: "independent_reviewer" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running", sessionId: "sess-resume" });
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(deps, args); } });
    await svc.pauseRun(runId);
    // fake pi 不调交接工具：恢复的 Run 一开始，替它登记成果并把工单交进 review。
    deps.onChildEvent = (itemId, _runId, event) => {
      if (event.type !== "run.started") return;
      insertOutcomeSnapshot(db, {
        itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "a".repeat(64),
        outcome: normalizeOutcomePayload({
          summary: "resumed and finished",
          changes: [{ kind: "file", ref: "src/a.ts", summary: "done" }],
          deliverables: [{ kind: "path", ref: "src/a.ts", label: "a" }],
          validations: [{ command: "npm test", outcome: "passed", exitCode: 0, summary: "green", evidenceRef: null }],
        }, { workdir: dir }),
      });
      transition(db, { itemId, to: "review", actor: "child", reason: "done", runId });
    };

    await svc.resumeRun(runId);
    await vi.waitFor(() => expect(runningChildren().size).toBe(0), { timeout: 15_000 });

    expect(getRun(db, runId)!.state).toBe("finished");
    expect(db.prepare("SELECT runtime, trigger FROM dispatch_requests WHERE item_id=? AND role='reviewer'").all(id))
      .toEqual([{ runtime: "pi", trigger: "automatic-review" }]);
  }, 20_000);
});

// 工单 #66：Run 暂停期间，它的 Claude 会话被 CLI 按保留期删掉了。用户点「恢复」时，resume 立即失败。
// 恢复要在同一个 Run 里开新会话，按原来的任务接着做，提示里带上工单的上下文。
describe("resuming a paused run whose runtime session has expired", () => {
  const EXPIRED = "44ab8ee6-8638-45a4-a891-f0721aa9158a";

  // fake Claude 的会话存档是空的：Run 记下的会话已经过期。
  function expiredClaude() {
    const sessions = mkdtempSync(join(dir, "claude-sessions-"));
    const log = join(dir, "claude-starts.jsonl");
    const claude = new ClaudeRuntime({
      bin: resolve("node_modules/.bin/tsx"),
      prefixArgs: [resolve("packages/runtime/testing/fake-claude.ts")],
      env: { FAKE_CLAUDE_SCENARIO: "sessions", FAKE_CLAUDE_SESSION_DIR: sessions, FAKE_CLAUDE_LOG: log },
    });
    const claudeDeps: LeadDeps = { db, dbPath: deps.dbPath, dataDir: dir, runtimeRegistry: new RuntimeRegistry([claude]) };
    // 工作目录不能在数据目录里（assertExternalChildWorkdir）。
    const workdir = tempDir("plc-user-actions-work-");
    onTestFinished(() => rmSync(workdir, { recursive: true, force: true }));
    const starts = () => readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { resume: string | null; session: string | null; prompt: string });
    return { claudeDeps, workdir, starts };
  }

  async function pauseAndResume(claudeDeps: LeadDeps, runId: number) {
    updateRun(db, runId, { state: "running", sessionId: EXPIRED, externalSessionId: EXPIRED });
    const svc = createUserActionService({ db, resumeRun: (args) => { resumeItemChild(claudeDeps, args); } });
    await svc.pauseRun(runId);
    await svc.resumeRun(runId);
    await vi.waitFor(() => expect(runningChildren().size).toBe(0), { timeout: 20_000 });
  }

  const expiredDecisions = (runId: number) => db.prepare(
    `SELECT json_extract(payload, '$.expiredSessionId') AS expired FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='runtime_session_expired'`,
  ).all(runId);

  it("continues the run in a fresh session and records why", async () => {
    const { claudeDeps, workdir, starts } = expiredClaude();
    const id = createItem(db, {
      title: "paused delivery", brief: "Port the parser", createdBy: "system", runtime: "claude", workdir,
    });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id, runtime: "claude" });

    await pauseAndResume(claudeDeps, runId);

    expect(starts()).toEqual([
      expect.objectContaining({ resume: EXPIRED, session: null }),
      expect.objectContaining({ resume: null, session: expect.stringMatching(/^claude-session-/) }),
    ]);
    const fresh = starts()[1]!;
    expect(fresh.prompt).toContain("Port the parser");
    expect(fresh.prompt).toContain("原来的会话已经不存在");
    expect(getRun(db, runId)).toMatchObject({
      state: "finished", failure_code: null, external_session_id: fresh.session,
    });
    expect(expiredDecisions(runId)).toEqual([{ expired: EXPIRED }]);
  }, 30_000);

  // 恢复按这个 Run 原来的用途跑。暂停的对话 Run 要接着回答用户在它上面发的最后一条消息：
  // 新会话不记得那条消息，提示要把它原样带上。
  it("gives a resumed conversation run the user's last message in the fresh session", async () => {
    const { claudeDeps, workdir, starts } = expiredClaude();
    const id = createItem(db, {
      title: "paused chat", brief: "Port the parser", createdBy: "system", runtime: "claude", workdir,
    });
    const runId = createRun(db, { itemId: id, runtime: "claude", purpose: "conversation" });
    addActivity(db, {
      itemId: id, runId, actor: "user", kind: "comment",
      payload: { content: "解析器现在支持哪些语法", route: "ticket_agent_start", resumedFromRunId: null },
    });

    await pauseAndResume(claudeDeps, runId);

    const fresh = starts()[1]!;
    expect(fresh).toMatchObject({ resume: null, session: expect.stringMatching(/^claude-session-/) });
    expect(fresh.prompt).toContain("解析器现在支持哪些语法");
    expect(fresh.prompt).toContain("原来的会话已经不存在");
    expect(getRun(db, runId)).toMatchObject({ state: "finished", purpose: "conversation", failure_code: null });
    expect(expiredDecisions(runId)).toEqual([{ expired: EXPIRED }]);
  }, 30_000);
});

// companion 只在收到线上事件时重拉快照。用户动作的入口不止一个（paired HTTP、daemon socket
// 上的 plc CLI、委托返工），所以事件由服务本身发：每个成功的动作恰好一条，被拒的动作一条都没有。
describe("user action events", () => {
  function events(itemId: number) {
    return (db.prepare(
      "SELECT event_type, payload FROM gateway_events WHERE item_id=? ORDER BY seq",
    ).all(itemId) as Array<{ event_type: string; payload: string }>)
      .map((row) => ({ type: row.event_type, payload: JSON.parse(row.payload) }));
  }

  it("publishes one ticket.updated for each item action", async () => {
    const drafted = draftTask();
    const svc = actions();
    svc.confirmItem(drafted);
    svc.unconfirmItem(drafted);
    await svc.cancelItem(drafted, "不做了");
    await svc.restoreItem(drafted);
    expect(events(drafted)).toEqual(Array(4).fill({
      type: "ticket.updated", payload: { ticketId: drafted, snapshotRequired: true },
    }));

    const reviewed = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: reviewed, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: reviewed, to: "review", actor: "child", reason: "" });
    svc.completeItem(reviewed);
    svc.reworkItem(reviewed, "再看一遍");
    await svc.stopItem(reviewed);
    expect(events(reviewed)).toEqual(Array(3).fill({
      type: "ticket.updated", payload: { ticketId: reviewed, snapshotRequired: true },
    }));
  });

  it("publishes one attempt.updated for each run action", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    const runId = createRun(db, { itemId: id });
    updateRun(db, runId, { state: "running" });
    const svc = createUserActionService({ db, resumeRun: () => {} });
    await svc.pauseRun(runId);
    await svc.resumeRun(runId);
    await svc.stopRun(runId, "够了");
    expect(events(id)).toEqual(Array(3).fill({
      type: "attempt.updated", payload: { attemptId: runId, ticketId: id, snapshotRequired: true },
    }));
  });

  it("publishes nothing for a refused action", async () => {
    const id = draftTask();
    const svc = actions();
    svc.confirmItem(id);
    expect(() => svc.confirmItem(id)).toThrow(/illegal transition ready -> ready/);
    const runId = createRun(db, { itemId: id });
    await expect(svc.pauseRun(runId)).rejects.toThrow(/cannot pause/);
    expect(events(id)).toEqual([
      { type: "ticket.updated", payload: { ticketId: id, snapshotRequired: true } },
    ]);
  });
});
