// 回归（2026-10-14/15，工单 #66 的核查 Run #73–#78）：#66 的工作区是共享工作区，路径就是用户的主 checkout，
// 不是 git worktree。核查前后的完整性检查于是同步遍历整棵树，连 node_modules 一起读，而且跑在 daemon 的
// 主线程上：每次核查启动，daemon 停摆约 1 小时 45 分钟，/v1/health 不回答。
// 现在核查前后的指纹异步算、有时限，git 仓库按 git 的视角算，被忽略的文件不读也不比较。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { createItem, createRun, getItem, getRun, getWorkspace, openDb, pauseRun, resumeRun, transition, type Db } from "@pi-lead-child/store";

import { runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { provisionWorkspace } from "../src/coordinator/workspace.js";
import {
  beginReviewWorkspaceCheck,
  compareReviewFingerprints,
  completeReviewWorkspaceCheck,
  reviewWorkspaceFingerprint,
} from "../src/coordinator/workspace-integrity.js";

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args]);
}

// 一个像主 checkout 的仓库：一个跟踪的源文件，和一棵被 .gitignore 忽略的依赖目录。
function checkout(prefix: string): { dir: string; repo: string; dbPath: string; db: Db } {
  const dir = tempDir(prefix);
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.email", "test@example.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "source.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const pkg = join(repo, "node_modules", "pkg");
  mkdirSync(pkg, { recursive: true });
  for (let index = 0; index < 200; index += 1) writeFileSync(join(pkg, `file-${index}.js`), `module.exports = ${index};\n`);
  const dbPath = join(dir, "plc.db");
  return { dir, repo, dbPath, db: openDb(dbPath) };
}

function sharedReviewTicket(db: Db, repo: string): { itemId: number; workspaceId: number } {
  const itemId = createItem(db, { title: "code", brief: "code", createdBy: "user", workflowKind: "coding", workdir: repo });
  const workspace = provisionWorkspace(db, { itemId, mode: "shared" });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return { itemId, workspaceId: workspace.id };
}

function completedReview(): RecordedEvent[] {
  return [
    { type: "session.updated", externalSessionId: "review-session", runtimeVersion: "test" },
    { type: "run.started", runtime: "claude", model: null },
    { type: "message.completed", messageId: "m-last", role: "assistant", text: "核查完成。", stopReason: "stop" },
    { type: "run.completed", exitCode: 0 },
  ];
}

// reviewer 在运行中途交结论，并对工作区做 change() 里的事（例如跑测试写了缓存）。
async function review(
  db: Db,
  input: { itemId: number; dir: string; dbPath: string; change: () => void },
): Promise<{ id: number; error_code: string | null }> {
  const reviewer = new ReplayRuntime({ runtime: "claude", events: completedReview() });
  const start = reviewer.start.bind(reviewer);
  reviewer.start = async (request) => {
    input.change();
    createDispatcher(db).submitReviewVerdict({ runId: request.runId, verdict: "pass", evidence: "独立复跑全部测试" });
    return start(request);
  };
  await runItem(db, input.itemId, {
    dbPath: input.dbPath, dataDir: input.dir, sessionDir: join(input.dir, "sessions"), prompt: "review", role: "reviewer",
    lingerMs: 0, runtime: reviewer,
  });
  return db.prepare("SELECT id, error_code FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(input.itemId) as {
    id: number; error_code: string | null;
  };
}

describe("reviewer workspace check on a shared checkout", () => {
  it("lets the event loop run while it fingerprints the workspace", async () => {
    const { db, repo } = checkout("plc-review-check-loop-");
    const { itemId, workspaceId } = sharedReviewTicket(db, repo);
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", workspaceId });
    let otherWorkRan = false;
    setImmediate(() => { otherWorkRan = true; });

    // 旧代码同步算完才返回：这期间 daemon 的其他工作（网关、Lead、派发）一件也跑不了。
    const preHash = await beginReviewWorkspaceCheck(db, runId, getWorkspace(db, workspaceId)!);

    expect(otherWorkRan).toBe(true);
    expect(preHash).toMatch(/^tree:[0-9a-f]{64}$/);
  });

  it("accepts the verdict when only ignored files change during the review", async () => {
    const { db, dir, repo, dbPath } = checkout("plc-review-check-ignored-");
    const { itemId } = sharedReviewTicket(db, repo);

    const run = await review(db, {
      itemId, dir, dbPath,
      change: () => writeFileSync(join(repo, "node_modules", "pkg", "file-0.js"), "module.exports = 'rebuilt';\n"),
    });

    expect(run.error_code).toBeNull();
    const verdict = db.prepare("SELECT verdict, pre_hash, post_hash FROM review_verdicts WHERE run_id=?").get(run.id) as {
      verdict: string; pre_hash: string; post_hash: string;
    } | undefined;
    expect(verdict).toMatchObject({ verdict: "pass" });
    expect(verdict!.pre_hash).toMatch(/^tree:/);
    expect(compareReviewFingerprints(verdict!.pre_hash, verdict!.post_hash)).toBe("matching");
  });

  it("still rejects the verdict when the reviewer changes a tracked file", async () => {
    const { db, dir, repo, dbPath } = checkout("plc-review-check-tracked-");
    const { itemId } = sharedReviewTicket(db, repo);

    const run = await review(db, { itemId, dir, dbPath, change: () => writeFileSync(join(repo, "source.txt"), "reviewer edit\n") });

    expect(run.error_code).toBe("review_workspace_drift");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_verdicts WHERE run_id=?").get(run.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM review_workspace_checks WHERE run_id=?").get(run.id)).toEqual({ state: "drifted" });
  });
});

// 发布评审 run-resume F3：恢复暂停的核查 Run 会再开始一次工作区检查。以前它重记核查前的指纹、清掉已经交的结论：
// 暂停期间被改过的工作区就成了新的基准，核查查不出这些改动。现在同一个 Run 的检查只在第一次开始时记指纹。
describe("a paused review that resumes", () => {
  it("keeps the pre-review fingerprint and the verdict already given, so a change made while paused is caught", async () => {
    const { db, dir, repo, dbPath } = checkout("plc-review-check-resume-");
    void dir; void dbPath;
    const { itemId, workspaceId } = sharedReviewTicket(db, repo);
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", workspaceId });
    const before = await beginReviewWorkspaceCheck(db, runId, getWorkspace(db, workspaceId)!);
    createDispatcher(db).submitReviewVerdict({ runId, verdict: "pass", evidence: "暂停前已复跑测试" });

    // 暂停期间有人改了被核查的文件，然后恢复。
    writeFileSync(join(repo, "source.txt"), "changed while paused\n");
    const resumed = await beginReviewWorkspaceCheck(db, runId, getWorkspace(db, workspaceId)!);

    expect(resumed).toBe(before);
    expect(db.prepare("SELECT verdict, evidence FROM review_workspace_checks WHERE run_id=?").get(runId))
      .toEqual({ verdict: "pass", evidence: "暂停前已复跑测试" });
    const result = completeReviewWorkspaceCheck(db, runId, {
      verdict: "pass", evidence: "暂停前已复跑测试", postHash: await reviewWorkspaceFingerprint(repo),
    });
    expect(result.accepted).toBe(false);
  });

  // 发布评审 reliability-backlog：交了结论以后被暂停的核查 Run，第一段收尾时已经登记了结论。恢复后第二段收尾
  // 又插一次（review_verdicts 的主键是 run_id），登记失败，升起一个「登记待处理」的 blocker，托管验收也再走一遍。
  it("does not register the verdict a second time when the resumed review ends", async () => {
    const { db, dir, repo, dbPath } = checkout("plc-review-check-resume-twice-");
    const { itemId, workspaceId } = sharedReviewTicket(db, repo);
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", workspaceId });
    const segment = async (events: RecordedEvent[], onStarted: () => void) => {
      await runItem(db, itemId, {
        dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "review", role: "reviewer", purpose: "review",
        runId, lingerMs: 0, runtime: new ReplayRuntime({ runtime: "claude", events }),
        onEvent: (event) => { if (event.type === "run.started") onStarted(); },
      });
    };

    // 第一段：交结论，然后用户暂停，进程被杀掉。
    await segment([
      { type: "session.updated", externalSessionId: "review-session", runtimeVersion: "test" },
      { type: "run.started", runtime: "claude", model: null },
      { type: "run.failed", exitCode: 143, errorCode: "runtime_exit", error: "killed by pause" },
    ], () => {
      createDispatcher(db).submitReviewVerdict({ runId, verdict: "pass", evidence: "暂停前已复跑测试" });
      pauseRun(db, runId);
    });
    const registered = db.prepare("SELECT verdict, evidence, pre_hash, post_hash FROM review_verdicts WHERE run_id=?").get(runId);
    expect(registered).toMatchObject({ verdict: "pass", evidence: "暂停前已复跑测试" });
    expect(getRun(db, runId)?.state).toBe("paused");

    // 第二段：恢复，正常结束。
    resumeRun(db, runId);
    await segment(completedReview(), () => {});

    expect(db.prepare("SELECT verdict, evidence, pre_hash, post_hash FROM review_verdicts WHERE run_id=?").all(runId))
      .toEqual([registered]);
    expect(db.prepare(
      "SELECT summary FROM inbox WHERE item_id=? AND severity='blocker'",
    ).all(itemId)).toEqual([]);
    expect(getRun(db, runId)).toMatchObject({ state: "finished", error_code: null });
  });
});

describe("review workspace fingerprints", () => {
  it("records a workspace it cannot measure in time instead of hanging or failing", async () => {
    const { repo } = checkout("plc-review-check-timeout-");
    expect(await reviewWorkspaceFingerprint(repo, { timeoutMs: 0 })).toMatch(/^unmeasured:/);
  });

  it("marks a missing workspace as measured, so deleting it still counts as a change", async () => {
    const { dir, repo } = checkout("plc-review-check-missing-");
    const before = await reviewWorkspaceFingerprint(repo);
    expect(await reviewWorkspaceFingerprint(join(dir, "gone"))).toBe("tree:missing");
    expect(compareReviewFingerprints(before, "tree:missing")).toBe("drifted");
  });

  it("can only say matching or drifted when both sides were measured the same way", () => {
    const tree = `tree:${"a".repeat(64)}`;
    const legacy = "b".repeat(64);
    expect(compareReviewFingerprints(tree, tree)).toBe("matching");
    expect(compareReviewFingerprints(tree, `tree:${"c".repeat(64)}`)).toBe("drifted");
    expect(compareReviewFingerprints(tree, "unmeasured:timed out")).toBe("unknown");
    // 部署前开始的核查，核查前的指纹是旧的同步算法：和新指纹比不出结果。
    expect(compareReviewFingerprints(legacy, tree)).toBe("unknown");
    expect(compareReviewFingerprints(legacy, legacy)).toBe("matching");
    expect(compareReviewFingerprints(null, tree)).toBe("unknown");
  });
});

// 审查 2026-10-22 第 6 条（工单 11）：有工作区的核查，结论先暂存，Run 结束、比过指纹才落定。核查在跑的时候工单被验收了
// （例如「不等核查，直接验收」），落定时以前不看工单的 stage：暂存的结论照样写进 review_verdicts，再走托管自动化，
// 给已经完成的工单发「核查不通过，等你决定」。终态不能被派生的状态改写（AGENTS.md 的 Core Invariants）。
describe("a workspace review whose ticket left review before the run ended", () => {
  it("does not settle the staged verdict or tell the user to decide on a done ticket", async () => {
    const { db, dir, repo, dbPath } = checkout("plc-review-check-late-");
    const { itemId } = sharedReviewTicket(db, repo);
    const reviewer = new ReplayRuntime({ runtime: "claude", events: completedReview() });
    const start = reviewer.start.bind(reviewer);
    reviewer.start = async (request) => {
      createDispatcher(db).submitReviewVerdict({ runId: request.runId, verdict: "fail", evidence: "测试失败" });
      // 结论只是暂存着；这时用户不等核查，直接验收了。
      transition(db, { itemId, to: "done", actor: "user", reason: "不等核查，直接验收" });
      return start(request);
    };
    await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "review", role: "reviewer", lingerMs: 0, runtime: reviewer,
    });

    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(db.prepare("SELECT COUNT(*) FROM review_verdicts WHERE item_id=?").pluck().get(itemId)).toBe(0);
    expect(db.prepare("SELECT kind FROM notifications WHERE item_id=?").pluck().all(itemId)).not.toContain("review_failed");
    expect(db.prepare(
      "SELECT COUNT(*) FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='review_verdict_waiting_user'",
    ).pluck().get(itemId)).toBe(0);
  });
});
