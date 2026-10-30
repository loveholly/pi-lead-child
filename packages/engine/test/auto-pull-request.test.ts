// 改代码的工单交付以后自动开草稿 PR，返工以后更新同一个 PR（用户 2026-10-26）。
// 以前 open_pr 只认用户这一轮，又只能开一次：Lead 在交付时被事件叫醒，开不了 PR；返工后没有操作能更新 PR，
// 于是 Lead 建了 #104（给 #102 开 PR）和 #116（把 #102 的返工同步到 PR #107）两张单。用户：「做完了就直接开草稿 PR 发给我」。
// 用真的 git 仓库（远程是本地的裸仓库）和假的 gh 测：什么时候开、什么时候更新、什么时候不动。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createItem, createRun, insertOutcomeSnapshot, listActivities, listInbox, normalizeOutcomePayload, openDb, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import type { PullRequestRunner } from "../src/coordinator/delivery.js";
import {
  AUTO_PULL_REQUEST_SINCE_KEY, autoPullRequestPlan, markAutoPullRequestRollout, setAutoPullRequest, syncAutoPullRequests,
} from "../src/coordinator/auto-pull-request.js";
import { parseRepositorySpec, recordTicketRepository } from "../src/coordinator/repository-checkout.js";

let db: Db;
let dir: string;
let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-auto-pr-");
  repo = join(dir, "repo");
  remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  db = openDb(join(dir, "plc.db"));
  markAutoPullRequestRollout(db, new Date("2026-10-26T00:00:00.000Z"));
});
afterEach(() => db.close());

function commitIn(worktree: string, file: string, text: string): void {
  writeFileSync(join(worktree, file), text);
  git(worktree, "add", "-A");
  git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", `add ${file}`);
}

// 一次交付：执行 Run 结束，登记成果，工单转到 review。
function deliver(itemId: number, deliveredAt: string): number {
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: runId, sourceOutputSha256: "a".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: `第 ${runId} 次交付`, changes: [], deliverables: [], validations: [],
    }, { workdir: repo }),
    now: new Date(deliveredAt),
  });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return runId;
}

function codingTicket(options: { verification?: "lead_static" | "independent_reviewer" | "user"; deliveredAt?: string } = {}) {
  const itemId = createItem(db, { title: "优化 code review skill", brief: "b", createdBy: "lead", workdir: repo });
  db.prepare("UPDATE items SET verification_policy=? WHERE id=?").run(options.verification ?? "lead_static", itemId);
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  commitIn(workspace.path, "plan.md", "# 方案\n");
  const runId = deliver(itemId, options.deliveredAt ?? "2026-10-26T08:00:00.000Z");
  return { itemId, worktree: workspace.path, branch: workspace.branch!, runId };
}

// 假的 gh：pr list 按 existing 回答（没有就是空），pr create 开 #12，pr edit 成功。记下每次调用。
function fakeGh(existing: string | null = null): PullRequestRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async gh(args) {
      calls.push(args);
      if (args[1] === "list") return { ok: true, stdout: existing ? `${existing}\n` : "", stderr: "" };
      if (args[1] === "create") return { ok: true, stdout: "https://github.com/acme/repo/pull/12\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  };
}

function decisions(itemId: number, name: string): Array<Record<string, unknown> & { actor: string }> {
  return listActivities(db, itemId)
    .map((row) => ({ ...JSON.parse(row.payload), actor: row.actor }))
    .filter((payload) => payload.decision === name);
}

describe("when the system opens a draft PR on its own", () => {
  it("opens one when a coding ticket is delivered and the repository has origin", async () => {
    const { itemId } = codingTicket();
    expect(await autoPullRequestPlan(db, itemId)).toEqual({ action: "open" });
  });

  // 回归（2026-10-29）：#161 要改 Acme/returns-skills，工作区在 aish 仓库，系统把 out/ 目录推成了 aish 仓库的 PR #126。
  it("does not open one when the ticket names another repository than the workspace's", async () => {
    const { itemId } = codingTicket();
    recordTicketRepository(db, itemId, parseRepositorySpec("Acme/returns-skills")!, { path: "/elsewhere", cloned: false });
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip", reason: expect.stringContaining("github.com/acme/returns-skills") });
  });

  it("waits for the independent reviewer's PASS on the latest delivery", async () => {
    const { itemId, runId } = codingTicket({ verification: "independent_reviewer" });
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip" });
    const reviewer = createRun(db, { itemId, runtime: "codex", role: "reviewer" });
    expect(reviewer).toBeGreaterThan(runId);
    db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'fail', 'tests fail')").run(reviewer, itemId);
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip" });
    db.prepare("UPDATE review_verdicts SET verdict='pass' WHERE run_id=?").run(reviewer);
    expect(await autoPullRequestPlan(db, itemId)).toEqual({ action: "open" });
  });

  it("leaves deliveries from before the rollout alone, so old tickets do not all get PRs at once", async () => {
    const { itemId } = codingTicket({ deliveredAt: "2026-10-20T08:00:00.000Z" });
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip" });
  });

  it("does nothing for a ticket where the user said not to open a PR", async () => {
    const { itemId } = codingTicket();
    setAutoPullRequest(db, itemId, false, { actor: "lead", reason: "用户说先别提 PR" });
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip" });
    setAutoPullRequest(db, itemId, true, { actor: "lead", reason: "用户说可以开 PR 了" });
    expect(await autoPullRequestPlan(db, itemId)).toEqual({ action: "open" });
  });

  it("does nothing while the ticket is being reworked", async () => {
    const { itemId } = codingTicket();
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    expect(await autoPullRequestPlan(db, itemId)).toMatchObject({ action: "skip" });
  });

  it("keeps the rollout time it recorded first", () => {
    expect(markAutoPullRequestRollout(db, new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-10-26T00:00:00.000Z");
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(AUTO_PULL_REQUEST_SINCE_KEY) as { value: string };
    expect(row.value).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("the draft PR follows the ticket from delivery through rework", () => {
  it("opens the PR once, then pushes the rework to the same PR and refreshes its description", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId], updated: [], failed: [] });
    expect(git(remote, "rev-parse", branch)).toBe(git(worktree, "rev-parse", "HEAD"));
    const create = gh.calls.find((args) => args[1] === "create")!;
    expect(create.slice(0, 3)).toEqual(["pr", "create", "--draft"]);
    const [opened] = decisions(itemId, "workspace_pr_opened");
    expect(opened).toMatchObject({ actor: "system", url: "https://github.com/acme/repo/pull/12", head: git(worktree, "rev-parse", "HEAD") });
    // Lead 收到一条要告诉用户的事，带着 PR 的地址。
    expect(listInbox(db).some((row) => row.item_id === itemId && row.summary.includes("https://github.com/acme/repo/pull/12"))).toBe(true);

    // 同一个提交不再动。
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], updated: [], failed: [] });
    expect(gh.calls).toEqual([]);

    // 返工：同一条分支上多了一个提交，又交付了一次。
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    commitIn(worktree, "fix.md", "fix\n");
    deliver(itemId, "2026-10-26T09:00:00.000Z");
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], updated: [itemId], failed: [] });
    expect(git(remote, "rev-parse", branch)).toBe(git(worktree, "rev-parse", "HEAD"));
    const edit = gh.calls.find((args) => args[1] === "edit")!;
    expect(edit.slice(0, 3)).toEqual(["pr", "edit", "https://github.com/acme/repo/pull/12"]);
    expect(edit[edit.indexOf("--body") + 1]).toContain("交付");
    expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
    expect(decisions(itemId, "workspace_pr_updated")[0]).toMatchObject({ actor: "system", head: git(worktree, "rev-parse", "HEAD") });
  });

  it("adopts a PR that already exists for the branch instead of opening a second one", async () => {
    const { itemId, worktree, branch } = codingTicket();
    git(worktree, "push", "-q", "origin", `${branch}:${branch}`);
    const gh = fakeGh("https://github.com/acme/repo/pull/107");

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
    expect(decisions(itemId, "workspace_pr_opened")[0]).toMatchObject({ url: "https://github.com/acme/repo/pull/107", adopted: true });
  });

  it("does not force-push: a rejected push is told to Lead once and not retried for the same commit", async () => {
    const { itemId, branch } = codingTicket();
    // 远程的分支上有一个本地没有的提交：推送不是快进。
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    git(other, "checkout", "-qb", branch);
    commitIn(other, "theirs.md", "theirs\n");
    git(other, "push", "-q", "origin", branch);
    const remoteHead = git(remote, "rev-parse", branch);
    const gh = fakeGh();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], failed: [itemId] });
    expect(git(remote, "rev-parse", branch)).toBe(remoteHead);
    expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
    expect(listInbox(db).some((row) => row.item_id === itemId && row.summary.includes("没能开草稿 PR"))).toBe(true);

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], updated: [], failed: [] });
    expect(decisions(itemId, "workspace_pr_auto_failed")).toHaveLength(1);
  });
});
