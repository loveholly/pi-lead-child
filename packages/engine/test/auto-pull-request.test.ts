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
import { prepareRunWorkspaceNowForTesting } from "../src/coordinator/workspace-policy.js";
import { openDeliveryPullRequest, type PullRequestRunner } from "../src/coordinator/delivery.js";
import { checkPushAgainstOrigin, MAX_UNPUBLISHED_COMMITS } from "../src/coordinator/push-guard.js";
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
  const workspace = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  commitIn(workspace.path, "plan.md", "# 方案\n");
  const runId = deliver(itemId, options.deliveredAt ?? "2026-10-26T08:00:00.000Z");
  return { itemId, worktree: workspace.path, branch: workspace.branch!, runId };
}

// 假的 gh：pr list 按 existing 回答（没有就是空），pr create 开 #12，pr edit 成功。记下每次调用。
// 它像 GitHub 一样记着 PR 的描述：create 和 edit 写进去，view 读出来；测试改 body 就是维护者在网页上手改了描述。
function fakeGh(existing: string | null = null): PullRequestRunner & { calls: string[][]; body: string } {
  const calls: string[][] = [];
  const fake = {
    calls,
    body: "",
    async gh(args: string[]) {
      calls.push(args);
      if (args[1] === "list") return { ok: true, stdout: existing ? `${existing}\n` : "", stderr: "" };
      if (args[1] === "view") return { ok: true, stdout: `${fake.body}\n`, stderr: "" };
      const body = args.indexOf("--body");
      if (body >= 0) fake.body = args[body + 1]!;
      if (args[1] === "create") return { ok: true, stdout: "https://github.com/acme/repo/pull/12\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  };
  return fake;
}

function bodyOf(args: string[]): string {
  return args[args.indexOf("--body") + 1]!;
}

// 返工：同一条分支上多了一个提交，又交付了一次。
function rework(itemId: number, worktree: string, file: string, deliveredAt: string): void {
  db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
  commitIn(worktree, file, `${file}\n`);
  deliver(itemId, deliveredAt);
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

  // 回归（2026-11-24）：PR 描述开头是「来自 pi-lead-child 工单 #N：标题」，公开仓库里不能有内部工单号。
  // 维护者在 PR #62 上手动删掉这一行，下一次返工自动更新又把整段描述换掉，这一行又回来了。
  it("writes no internal ticket number into the description, on open or on update", async () => {
    const { itemId, worktree } = codingTicket();
    const gh = fakeGh();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    const opened = bodyOf(gh.calls.find((args) => args[1] === "create")!);
    expect(opened).not.toContain(`#${itemId}`);
    expect(opened).not.toContain("工单");
    expect(opened).not.toContain("pi-lead-child");
    expect(opened).toContain("## 做了什么");

    rework(itemId, worktree, "fix.md", "2026-10-26T09:00:00.000Z");
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId] });
    const updated = bodyOf(gh.calls.find((args) => args[1] === "edit")!);
    expect(updated).not.toContain(`#${itemId}`);
    expect(updated).not.toContain("工单");
    expect(updated).toContain("## 做了什么");
  });

  it("keeps a description the maintainer edited by hand, and still pushes the rework", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });

    // 维护者在网页上改了描述（GitHub 网页存的是 CRLF）。
    const edited = "Adds the review plan.\r\n\r\nTested by hand with Nina's sample repo.";
    gh.body = edited;
    rework(itemId, worktree, "fix.md", "2026-10-26T09:00:00.000Z");
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId], failed: [] });
    expect(git(remote, "rev-parse", branch)).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
    expect(gh.body).toBe(edited);
    expect(decisions(itemId, "workspace_pr_updated")[0]).toMatchObject({ bodyKept: true, head: git(worktree, "rev-parse", "HEAD") });
    const told = listInbox(db).filter((row) => row.item_id === itemId).at(-1)!;
    expect(told.summary).toContain("没有覆盖");

    // 再返工一次：描述还是维护者改的那份。
    rework(itemId, worktree, "fix2.md", "2026-10-26T10:00:00.000Z");
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId] });
    expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
    expect(gh.body).toBe(edited);
  });

  it("refreshes a description nobody touched, even when GitHub hands it back with CRLF line ends", async () => {
    const { itemId, worktree } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    gh.body = gh.body.replace(/\n/g, "\r\n");

    rework(itemId, worktree, "fix.md", "2026-10-26T09:00:00.000Z");
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId] });
    expect(gh.calls.some((args) => args[1] === "edit")).toBe(true);
    expect(decisions(itemId, "workspace_pr_updated")[0]).not.toHaveProperty("bodyKept");
  });

  // 这次修复以前开的 PR，账本里没有记下系统写的描述。描述开头还是系统那一行：没人改过，换成不带工单号的新描述；
  // 开头那一行被删了：维护者改过，不动。
  it("for a PR opened before this fix, replaces only a description that still starts with the old ticket line", async () => {
    const { itemId, worktree } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    // 去掉账本里的描述指纹，像这次修复以前记下的那样。
    db.prepare(
      "UPDATE activities SET payload=json_remove(payload, '$.bodySha256') WHERE item_id=? AND json_extract(payload, '$.decision')='workspace_pr_opened'",
    ).run(itemId);

    gh.body = `来自 pi-lead-child 工单 #${itemId}：优化 code review skill\n\n## 做了什么\n\n旧的描述\n`;
    rework(itemId, worktree, "fix.md", "2026-10-26T09:00:00.000Z");
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId] });
    expect(gh.calls.some((args) => args[1] === "edit")).toBe(true);
    expect(gh.body).not.toContain(`#${itemId}`);

    // 维护者删掉了那一行（PR #62 的情形）以后，这份描述不再被换掉。
    db.prepare(
      "UPDATE activities SET payload=json_remove(payload, '$.bodySha256') WHERE item_id=? AND json_extract(payload, '$.decision') IN ('workspace_pr_opened','workspace_pr_updated')",
    ).run(itemId);
    gh.body = "## 做了什么\n\n旧的描述\n";
    rework(itemId, worktree, "fix2.md", "2026-10-26T10:00:00.000Z");
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId] });
    expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
    expect(gh.body).toBe("## 做了什么\n\n旧的描述\n");
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

// 回归（2026-11-25，#552）：返工交付以后，PR 分支没有更新，三次都是 Lead 手动推的。
// 两个原因：要独立核查的工单返工后回到 review，系统要等核查员再给 PASS 才更新已经开着的 PR；
// 返工里 rebase 改写了历史，系统只做快进推送，推送被拒。PR 是草稿还是已经转正式，系统都不看。
// 每条测试要 clone 远程、rebase、推好几次，机器忙时超过缺省的 15 秒。
describe("rework reaches the PR that is already open", { timeout: 40_000 }, () => {
  // 改写历史：把分支 rebase 到 origin 上新的 main，像执行者返工时做的那样。
  function rebaseOntoNewMain(worktree: string): void {
    const other = join(dir, `main-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execFileSync("git", ["clone", "-q", "-b", "main", remote, other]);
    commitIn(other, `upstream-${Math.random().toString(36).slice(2)}.md`, "upstream\n");
    git(other, "push", "-q", "origin", "main");
    git(worktree, "fetch", "-q", "origin");
    git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "rebase", "-q", "origin/main");
  }

  function openWithPass(): { itemId: number; worktree: string; branch: string } {
    const ticket = codingTicket({ verification: "independent_reviewer" });
    const reviewer = createRun(db, { itemId: ticket.itemId, runtime: "codex", role: "reviewer" });
    db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'pass', 'ok')").run(reviewer, ticket.itemId);
    return ticket;
  }

  it("pushes rework of an independently reviewed ticket without waiting for the next PASS", async () => {
    const { itemId, worktree, branch } = openWithPass();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });

    rework(itemId, worktree, "fix.md", "2026-10-26T09:00:00.000Z");
    // 核查员已经开始核查这次返工：它不提交，也不挡推送。
    const reviewer = createRun(db, { itemId, runtime: "codex", role: "reviewer" });
    updateRun(db, reviewer, { state: "running" });
    expect(await autoPullRequestPlan(db, itemId)).toEqual({ action: "update", url: "https://github.com/acme/repo/pull/12" });
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId], failed: [] });
    expect(git(remote, "rev-parse", branch)).toBe(git(worktree, "rev-parse", "HEAD"));
  });

  it("pushes a rebased branch with --force-with-lease on the head it pushed last", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    const before = git(remote, "rev-parse", branch);

    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    rebaseOntoNewMain(worktree);
    commitIn(worktree, "fix.md", "fix\n");
    deliver(itemId, "2026-10-26T09:00:00.000Z");
    const head = git(worktree, "rev-parse", "HEAD");
    // 历史改写了：远程上的旧提交不在新的分支上，快进推送会被拒。
    expect(() => git(worktree, "merge-base", "--is-ancestor", before, head)).toThrow();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId], failed: [] });
    expect(git(remote, "rev-parse", branch)).toBe(head);
    expect(decisions(itemId, "workspace_pr_updated")[0]).toMatchObject({ head, previousHead: before, forced: true });
  });

  it("does not overwrite a branch someone else changed on origin, records it, and tells Lead", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });

    // 维护者在 PR 分支上加了一个提交。
    const other = join(dir, "maintainer");
    execFileSync("git", ["clone", "-q", "-b", branch, remote, other]);
    commitIn(other, "theirs.md", "theirs\n");
    git(other, "push", "-q", "origin", branch);
    const theirs = git(remote, "rev-parse", branch);

    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    rebaseOntoNewMain(worktree);
    deliver(itemId, "2026-10-26T09:00:00.000Z");
    gh.calls.length = 0;

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [], failed: [itemId] });
    expect(git(remote, "rev-parse", branch)).toBe(theirs);
    expect(gh.calls).toEqual([]);
    const [failed] = decisions(itemId, "workspace_pr_auto_failed");
    expect(failed).toMatchObject({ step: "update", head: git(worktree, "rev-parse", "HEAD") });
    expect(String(failed!.error)).toContain("被别人改过");
    const told = listInbox(db).filter((row) => row.item_id === itemId).at(-1)!;
    expect(told.summary).toContain("没能更新 PR");
    expect(told.summary).toContain("被别人改过");
    expect(JSON.parse(told.payload)).toMatchObject({ wakeLead: true });

    // 同一个提交不再试，也不再告诉 Lead。
    const count = listInbox(db).filter((row) => row.item_id === itemId).length;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [], failed: [] });
    expect(listInbox(db).filter((row) => row.item_id === itemId)).toHaveLength(count);
  });

  it("records the update when someone already pushed the new head by hand", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });

    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    rebaseOntoNewMain(worktree);
    deliver(itemId, "2026-10-26T09:00:00.000Z");
    git(worktree, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [itemId], failed: [] });
    expect(decisions(itemId, "workspace_pr_updated")[0]).toMatchObject({ head: git(worktree, "rev-parse", "HEAD") });
  });
});

// 回归（2026-11-06，#288）：用户给主 checkout 加了 origin（公开仓库）。一张工单的分支建在旧的、没公开过的本地历史上，
// 和 origin 的 master 没有共同历史。系统自动开 PR 时先推送成功，开 PR 才失败，整段本地历史被推到了公开仓库。
// 现在推送之前先查共同历史和 origin 上没有的提交数，不通过就不推、不开 PR，在工单上写原因，告诉 Lead。
describe("before any push, the branch must share history with origin's default branch", () => {
  // 把工单的分支换成一条和 origin 毫无关系的历史（像建在另一个仓库的历史上）。
  function rewriteOnUnrelatedHistory(worktree: string, branch: string): void {
    git(worktree, "checkout", "-q", "--orphan", "unrelated-history");
    git(worktree, "rm", "-rqf", ".");
    commitIn(worktree, "private.md", "old private history\n");
    commitIn(worktree, "plan.md", "# 方案\n");
    git(worktree, "checkout", "-qB", branch);
  }

  function remoteHasBranch(branch: string): boolean {
    return git(remote, "for-each-ref", `refs/heads/${branch}`) !== "";
  }

  it("does not push or open a PR on its own, records why on the ticket, and tells Lead once", async () => {
    const { itemId, worktree, branch } = codingTicket();
    rewriteOnUnrelatedHistory(worktree, branch);
    const gh = fakeGh();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], failed: [itemId] });
    expect(remoteHasBranch(branch)).toBe(false);
    expect(gh.calls).toEqual([]);
    const [refused] = decisions(itemId, "workspace_push_refused");
    expect(refused).toMatchObject({ actor: "system", branch, step: "open", requestedBy: "system", defaultBranch: "main" });
    expect(refused!.reason).toContain("和 origin/main 没有共同历史");
    expect(refused!.reason).toContain("rebase");
    const told = listInbox(db).filter((row) => row.item_id === itemId);
    expect(told).toHaveLength(1);
    expect(told[0]!.summary).toContain("没有共同历史");

    // 同一个提交不再试，也不再告诉 Lead。
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], updated: [], failed: [] });
    expect(remoteHasBranch(branch)).toBe(false);
    expect(listInbox(db).filter((row) => row.item_id === itemId)).toHaveLength(1);
  });

  it("refuses the manual open_pr the same way, and wakes Lead when the user clicked it", async () => {
    const { itemId, worktree, branch } = codingTicket();
    rewriteOnUnrelatedHistory(worktree, branch);
    const gh = fakeGh();

    await expect(openDeliveryPullRequest(db, itemId, { actor: "user", reason: "用户点了开 PR", runner: gh }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("没有共同历史") });
    expect(remoteHasBranch(branch)).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(decisions(itemId, "workspace_push_refused")[0]).toMatchObject({ requestedBy: "user", step: "open" });
    expect(listInbox(db).some((row) => row.item_id === itemId && row.summary.includes("没有共同历史"))).toBe(true);

    // Lead 自己调 open_pr：直接拿到报错，照样不推。
    await expect(openDeliveryPullRequest(db, itemId, { actor: "lead", sourceTurnId: null, reason: "Lead 判断要开 PR", runner: gh }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(remoteHasBranch(branch)).toBe(false);
    expect(decisions(itemId, "workspace_push_refused")).toHaveLength(2);
  });

  it("does not push rework onto an open PR when the branch was rewritten onto unrelated history", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [itemId] });
    const pushed = git(remote, "rev-parse", branch);

    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    rewriteOnUnrelatedHistory(worktree, branch);
    deliver(itemId, "2026-10-26T09:00:00.000Z");
    gh.calls.length = 0;
    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ updated: [], failed: [itemId] });
    expect(git(remote, "rev-parse", branch)).toBe(pushed);
    expect(gh.calls).toEqual([]);
    expect(decisions(itemId, "workspace_push_refused")[0]).toMatchObject({ step: "update" });
  });

  it(`refuses a branch that carries more than ${MAX_UNPUBLISHED_COMMITS} commits origin does not have`, async () => {
    const { itemId, worktree, branch } = codingTicket();
    for (let index = 0; index < MAX_UNPUBLISHED_COMMITS; index += 1) {
      git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-q", "--allow-empty", "-m", `local ${index}`);
    }
    const gh = fakeGh();

    expect(await syncAutoPullRequests(db, { runner: gh })).toMatchObject({ opened: [], failed: [itemId] });
    expect(remoteHasBranch(branch)).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(decisions(itemId, "workspace_push_refused")[0]).toMatchObject({ unpublished: MAX_UNPUBLISHED_COMMITS + 1 });
  });

  it("refuses when origin has no default branch to compare with", async () => {
    const { itemId } = codingTicket();
    const empty = join(dir, "empty.git");
    execFileSync("git", ["init", "-q", "--bare", empty]);
    git(repo, "remote", "set-url", "origin", empty);
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");

    await expect(openDeliveryPullRequest(db, itemId, { actor: "user", reason: "用户点了开 PR", runner: fakeGh() }))
      .rejects.toMatchObject({ message: expect.stringContaining("找不到 origin 的默认分支") });
    expect(git(empty, "for-each-ref")).toBe("");
    expect(decisions(itemId, "workspace_push_refused")).toHaveLength(1);
  });

  it("still pushes a normal branch and opens the PR, from the manual open_pr too", async () => {
    const { itemId, worktree, branch } = codingTicket();
    const gh = fakeGh();

    const result = await openDeliveryPullRequest(db, itemId, { actor: "user", reason: "用户点了开 PR", runner: gh });
    expect(result.pullRequestUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(git(remote, "rev-parse", branch)).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(decisions(itemId, "workspace_push_refused")).toEqual([]);
    expect(await checkPushAgainstOrigin(repo, branch)).toEqual({ ok: true, defaultBranch: "main", unpublished: 0 });
  });
});
