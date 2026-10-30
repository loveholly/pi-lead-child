// 工单的「这次交付」（2026-10-20）。用户看着 #102 验收不了：成果卡只有截断的摘要和点不开的路径，
// 看不到改了哪些行、改动在哪个分支，也没有合并或开 PR 的入口。这里用真的 git 仓库测交付视图、
// 文件预览的路径校验，以及验收并合并、开 PR、放弃三个操作的边界。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  createItem, createLoopbackBinding, createRun, createTurn, getItem, getWorkspace, insertOutcomeSnapshot, listActivities,
  normalizeOutcomePayload, transition, updateRun,
} from "@pi-lead-child/store";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { tempDir } from "@pi-lead-child/core/testing";
import { TicketDeliverySchema } from "@pi-lead-child/protocol";
import { Value } from "typebox/value";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import { integrateIsolatedWorkspace } from "../src/coordinator/workspace.js";
import {
  abandonDelivery, DeliveryError, mergeDelivery, normalizeDeliveryPath, openDeliveryPullRequest, ticketDelivery,
  ticketDeliveryFile, type PullRequestRunner,
} from "../src/coordinator/delivery.js";

let db: Db;
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-delivery-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "persona.md"), "# persona\n\nbase rule\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
});
afterEach(() => db.close());

// 另一个仓库里一张交付了的工单（同一个测试里要两张互不影响的工单时用）。
function deliveredTicketIn(path: string): number {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "test@example.test");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "readme\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
  const itemId = createItem(db, { title: "second", brief: "b", createdBy: "lead", workdir: path });
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  writeFileSync(join(workspace.path, "notes.md"), "notes\n");
  git(workspace.path, "add", "-A");
  git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "notes");
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return itemId;
}

// 一张写代码的工单：在隔离分支上新增一份文档、改一行 persona、顺手提交了一个 .env，并登记成果。
function deliveredTicket(): { itemId: number; worktree: string } {
  const itemId = createItem(db, { title: "优化 code review skill", brief: "b", createdBy: "lead", workdir: repo });
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  mkdirSync(join(workspace.path, "docs"));
  writeFileSync(join(workspace.path, "docs", "plan.md"), "# 方案\n\n第一行\n第二行\n");
  writeFileSync(join(workspace.path, "config", "persona.md"), "# persona\n\nbase rule\nnew fallback rule\n");
  writeFileSync(join(workspace.path, ".env"), "SECRET=do-not-show\n");
  git(workspace.path, "add", "-A");
  git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "docs(review): plan");
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "a".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "写了方案，加了兜底规则。",
      changes: [
        { kind: "file", ref: "config/persona.md", summary: "加一条兜底规则" },
        { kind: "file", ref: "docs/plan.md", summary: "新增方案文档" },
      ],
      deliverables: [
        { kind: "path", ref: "docs/plan.md", label: "排查分析与优化方案" },
        { kind: "path", ref: "config/persona.md", label: "persona 里的兜底规则" },
      ],
      validations: [{ command: "人工核对", outcome: "passed", exitCode: null, summary: "语法存在", evidenceRef: null }],
    }, { workdir: workspace.path }),
    now: new Date("2026-10-20T07:18:46.000Z"),
  });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return { itemId, worktree: workspace.path };
}

describe("the delivery view of an isolated ticket", () => {
  it("lists the changed files with the agent's labels first, line counts and the branch to merge", async () => {
    const { itemId } = deliveredTicket();
    const delivery = await ticketDelivery(db, itemId);

    expect(delivery.source).toBe("isolated");
    expect(delivery.files.map((file) => [file.path, file.label, file.status, file.additions, file.deletions])).toEqual([
      ["docs/plan.md", "排查分析与优化方案", "added", 4, 0],
      ["config/persona.md", "persona 里的兜底规则", "modified", 1, 0],
      [".env", null, "added", 1, 0],
    ]);
    expect(delivery.files[0]).toMatchObject({ note: "新增方案文档", views: ["full", "diff"], hiddenReason: null });
    expect(delivery.totals).toEqual({ files: 3, additions: 6, deletions: 0 });
    expect(delivery.workspace).toMatchObject({ target: "main", commits: 1, uncommittedFiles: 0, integration: "unmerged", pullRequestUrl: null });
    expect(delivery.workspace?.branch).toMatch(/^plc\/item-/);
    // 工单还在 review：合并会先验收。没有 origin，开不了 PR；工单没结束，不能放弃。
    expect(delivery.actions.merge).toEqual({ available: true, reason: null, acceptsTicket: true });
    expect(delivery.actions.openPullRequest.available).toBe(false);
    expect(delivery.actions.openPullRequest.reason).toContain("origin");
    expect(delivery.actions.abandon).toEqual({ available: false, reason: "工单还没结束。不要这些改动时，取消工单。" });
  });

  // 回归（2026-10-21 审查 L1）：协议规定 files 最多 2000 个，服务端以前不截断。一次超过 2000 个文件的交付
  // （锁文件、生成的代码）让客户端的严格校验失败，整个交付页加载不出来。现在截到 2000 个，标明截断，合计照样算全部。
  it("lists at most 2000 files and says the list is cut, while the totals count every file", async () => {
    const { itemId, worktree } = deliveredTicket();
    mkdirSync(join(worktree, "gen"));
    for (let index = 0; index < 2001; index++) writeFileSync(join(worktree, "gen", `f${index}.txt`), `${index}\n`);
    git(worktree, "add", "-A");
    git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "generated");

    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.files).toHaveLength(2000);
    expect(delivery.truncated).toBe(true);
    expect(delivery.totals?.files).toBe(2004);
    // 成果里列的文件排在前面，截断不会截掉它们。
    expect(delivery.files.slice(0, 2).map((file) => file.path)).toEqual(["docs/plan.md", "config/persona.md"]);
    expect(Value.Check(TicketDeliverySchema, delivery)).toBe(true);
  }, 120_000);

  it("lists a possible secrets file without letting anyone open it", async () => {
    const { itemId } = deliveredTicket();
    const env = (await ticketDelivery(db, itemId)).files.find((file) => file.path === ".env")!;
    expect(env).toMatchObject({ views: [], hiddenReason: "这个文件可能含密钥，不在这里显示。" });
    await expect(ticketDeliveryFile(db, itemId, ".env", "full")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("shows a file's full text and its diff from the branch", async () => {
    const { itemId } = deliveredTicket();
    const full = await ticketDeliveryFile(db, itemId, "docs/plan.md", "full");
    expect(full).toMatchObject({ path: "docs/plan.md", view: "full", language: "markdown", truncated: false });
    expect(full.text).toBe("# 方案\n\n第一行\n第二行\n");
    const diff = await ticketDeliveryFile(db, itemId, "config/persona.md", "diff");
    expect(diff.language).toBe("diff");
    expect(diff.text).toContain("+new fallback rule");
  });
});

describe("which paths the file preview accepts", () => {
  it("rejects paths that leave the repository or are not plain relative paths", () => {
    for (const bad of ["../plc.db", "/etc/passwd", "docs/../../x", "docs//plan.md", "C:\\x", "a\\b", "", "docs/./plan.md", 7]) {
      expect(normalizeDeliveryPath(bad)).toBeNull();
    }
    expect(normalizeDeliveryPath("./docs/plan.md")).toBe("docs/plan.md");
  });

  // 回归（2026-10-21 审查 M6）：.git/config 不在隐藏名单里，remote 地址里可能带 token。macOS 的文件系统不分大小写，
  // .GIT/config 也是同一个文件。
  it("rejects any path inside a .git directory", () => {
    for (const bad of [".git/config", ".GIT/config", "sub/.git/config", ".git"]) {
      expect(normalizeDeliveryPath(bad), bad).toBeNull();
    }
    expect(normalizeDeliveryPath("docs/.gitignore")).toBe("docs/.gitignore");
  });

  it("only reads files that are part of the delivery", async () => {
    const { itemId } = deliveredTicket();
    await expect(ticketDeliveryFile(db, itemId, "../plc.db", "full")).rejects.toMatchObject({ code: "invalid_request" });
    // README.md 在仓库里，但不在这次交付里。
    await expect(ticketDeliveryFile(db, itemId, "README.md", "full")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("accept and merge", () => {
  it("accepts the ticket, merges the branch into the user's current branch and keeps the files viewable", async () => {
    const { itemId } = deliveredTicket();
    let accepted = 0;
    const delivery = await mergeDelivery(db, itemId, {
      accept: () => { accepted++; db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId); },
      reason: "用户在工单详情里点了「验收并合并」",
    });

    expect(accepted).toBe(1);
    expect(git(repo, "show", "HEAD:docs/plan.md")).toContain("# 方案");
    expect(delivery.workspace).toMatchObject({ integration: "merged", mergedInto: "main", commits: 0 });
    expect(delivery.actions.merge).toMatchObject({ available: false, reason: "改动已经合并。" });
    // 合并以后 worktree 删了，文件和改动还能从合并时记下的提交里看。
    expect(delivery.files.map((file) => file.path)).toEqual(["docs/plan.md", "config/persona.md", ".env"]);
    expect((await ticketDeliveryFile(db, itemId, "docs/plan.md", "diff")).text).toContain("+第一行");
  });

  it("does not accept the ticket when the user's checkout has uncommitted changes", async () => {
    const { itemId } = deliveredTicket();
    writeFileSync(join(repo, "README.md"), "edited by the user\n");
    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.actions.merge.available).toBe(false);
    expect(delivery.actions.merge.reason).toBe("你的仓库在 main 上有没提交的改动。先提交或暂存，再合并。");

    let accepted = 0;
    await expect(mergeDelivery(db, itemId, { accept: () => { accepted++; }, reason: "r" }))
      .rejects.toBeInstanceOf(DeliveryError);
    expect(accepted).toBe(0);
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("does not accept the ticket when the branch conflicts with the target", async () => {
    const { itemId } = deliveredTicket();
    writeFileSync(join(repo, "config", "persona.md"), "# persona\n\nbase rule\nthe user's own rule\n");
    git(repo, "commit", "-qam", "user edit");
    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.actions.merge.reason).toContain("有冲突");
    let accepted = 0;
    await expect(mergeDelivery(db, itemId, { accept: () => { accepted++; }, reason: "r" })).rejects.toMatchObject({ code: "unavailable" });
    expect(accepted).toBe(0);
  });

  // 回归（2026-10-21 审查 M2）：双击「验收并合并」。第二次请求在第一次合并之前读交付，检查照样通过，然后去读已经删掉的分支，
  // 报「工单已经验收，但合并没有成功」。实际上合并已经成功。现在同一张工单的合并、开 PR、放弃一次只做一个。
  it("merges once when the user clicks twice, and tells the second click that it is already merged", async () => {
    const { itemId } = deliveredTicket();
    let accepted = 0;
    const accept = () => { accepted++; db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId); };
    const [first, second] = await Promise.allSettled([
      mergeDelivery(db, itemId, { accept, reason: "r" }),
      mergeDelivery(db, itemId, { accept, reason: "r" }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "unavailable", message: "改动已经合并。" } });
    expect(accepted).toBe(1);
  });

  // 回归（2026-10-21 审查 M2）：读交付要等 git。这段时间里 Lead 的 integrate_workspace（同步）可能已经合并了它，
  // 或者返工开始了。await 之后再同步查一次，不在过时的检查上验收。
  it("checks again after waiting for git, so it does not accept a ticket that Lead merged meanwhile", async () => {
    // 用户验收过的工单：用户点「合并」，同时 Lead 按用户在对话里说的合并了它。
    const { itemId } = deliveredTicket();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    const workspaceId = (await ticketDelivery(db, itemId)).workspace!.workspaceId;
    let accepted = 0;
    const pending = mergeDelivery(db, itemId, { accept: () => { accepted++; }, reason: "r" });
    integrateIsolatedWorkspace(db, workspaceId, { actor: "lead", reason: "用户在对话里说合并" });
    await expect(pending).rejects.toMatchObject({ code: "unavailable", message: "改动已经合并。" });

    const reworked = deliveredTicketIn(join(dir, "repo2"));
    const rework = mergeDelivery(db, reworked, { accept: () => { accepted++; }, reason: "r" });
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(reworked);
    await expect(rework).rejects.toMatchObject({ code: "unavailable", message: "交付以后才能合并。" });
    expect(accepted).toBe(0);
  });

  // 回归（2026-10-21 审查 M2）：界面显示「合并到 main」。用户点之前在自己的仓库里切到了 feature-y，或者分支上多了新提交。
  // 服务端以前照样合并进 feature-y，或者合并用户没看过的提交。请求带上用户看到的 head 和 target，对不上时拒绝。
  it("refuses when the branch or the user's current branch changed since the user looked", async () => {
    const { itemId, worktree } = deliveredTicket();
    let accepted = 0;
    const accept = () => { accepted++; db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId); };
    const seen = (await ticketDelivery(db, itemId)).workspace!;
    expect(seen.head).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(worktree, "docs", "later.md"), "later\n");
    git(worktree, "add", "-A");
    git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "later");
    await expect(mergeDelivery(db, itemId, { accept, reason: "r", expected: { head: seen.head, target: seen.target } }))
      .rejects.toMatchObject({ code: "stale" });

    const later = (await ticketDelivery(db, itemId)).workspace!;
    git(repo, "checkout", "-qb", "feature-y");
    await expect(mergeDelivery(db, itemId, { accept, reason: "r", expected: { head: later.head, target: later.target } }))
      .rejects.toMatchObject({ code: "stale", message: expect.stringContaining("feature-y") });
    expect(accepted).toBe(0);
    expect(git(repo, "log", "--format=%s")).not.toContain("docs(review): plan");

    const current = (await ticketDelivery(db, itemId)).workspace!;
    await mergeDelivery(db, itemId, { accept, reason: "r", expected: { head: current.head, target: current.target } });
    expect(accepted).toBe(1);
    expect(git(repo, "log", "--format=%s", "feature-y")).toContain("later");
  });

  // 回归（2026-10-21 审查 M2）：工单本来就是 done，合并失败时消息仍然写「工单已经验收」。只在这次真的验收了才这样写。
  it("says the ticket was accepted only when this call accepted it", async () => {
    const { itemId } = deliveredTicket();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    // 用户的分支往前走了一步（不冲突），合并要建合并提交；用户仓库的 pre-merge-commit 钩子拒绝它。
    writeFileSync(join(repo, "README.md"), "readme\nmore\n");
    git(repo, "commit", "-qam", "user readme");
    writeFileSync(join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    let accepted = 0;
    const failure = await mergeDelivery(db, itemId, { accept: () => { accepted++; }, reason: "r" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "failed" });
    expect((failure as Error).message).toMatch(/^合并没有成功：/);
    expect(accepted).toBe(0);
    // 回归（2026-10-21 审查 L2）：报错以前带着 git -C <仓库路径>，经接口给了客户端。协议说不下发服务器路径。
    expect((failure as Error).message).not.toContain(dir);
    expect((failure as Error).message).not.toContain("git -C");
    expect((failure as Error).message).toContain("仓库的钩子");
  });
});

describe("open a pull request", () => {
  function withRemote(): string {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    return remote;
  }

  it("pushes the branch, opens a draft PR against the user's branch and records the address", async () => {
    const remote = withRemote();
    const { itemId } = deliveredTicket();
    const calls: string[][] = [];
    const runner: PullRequestRunner = {
      async gh(args) {
        calls.push(args);
        return { ok: true, stdout: "Creating draft pull request\nhttps://github.com/acme/repo/pull/12\n", stderr: "" };
      },
    };
    const result = await openDeliveryPullRequest(db, itemId, { actor: "user", reason: "用户点了开 PR", runner });

    const branch = result.workspace!.branch!;
    expect(git(remote, "branch", "--list", branch)).toContain(branch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 7)).toEqual(["pr", "create", "--draft", "--head", branch, "--base", "main"]);
    expect(calls[0]![calls[0]!.indexOf("--body") + 1]).toContain("写了方案，加了兜底规则。");
    expect(result.pullRequestUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(result.workspace?.pullRequestUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(result.actions.openPullRequest).toEqual({ available: false, reason: "已经开过 PR。" });
    const opened = listActivities(db, itemId).map((row) => JSON.parse(row.payload)).find((payload) => payload.decision === "workspace_pr_opened");
    expect(opened).toMatchObject({ branch, base: "main", url: "https://github.com/acme/repo/pull/12" });
  });

  // 2026-10-21 审查 M3 曾要求 Lead 只能在用户这一轮里开 PR。用户 2026-10-28「工单操作让 Lead 自己判断」，2026-10-29 Lead 在
  // 交付叫醒的一轮里开不了 PR，只能请用户去点按钮。系统交付后本来就自动开草稿 PR，推的是同一条分支。
  // 现在 Lead 哪一轮都能开；在用户本人这一轮里开的，记成代用户做。
  it("lets Lead open a PR in a turn it was woken in, and records the user's turn when it is one", async () => {
    const remote = withRemote();
    const { itemId } = deliveredTicket();
    const calls: string[][] = [];
    const runner: PullRequestRunner = {
      async gh(args) {
        calls.push(args);
        return { ok: true, stdout: "https://github.com/acme/repo/pull/13\n", stderr: "" };
      },
    };
    const branch = (await ticketDelivery(db, itemId)).workspace!.branch!;
    const heartbeat = createTurn(db, { id: "heartbeat", originKind: "system:heartbeat", userText: "", state: "streaming" });
    const result = await openDeliveryPullRequest(db, itemId, { actor: "lead", reason: "交付了，开草稿 PR", sourceTurnId: heartbeat.id, runner });
    expect(result.pullRequestUrl).toBe("https://github.com/acme/repo/pull/13");
    expect(git(remote, "branch", "--list", branch)).toContain(branch);
    const opened = listActivities(db, itemId).find((row) => JSON.parse(row.payload).decision === "workspace_pr_opened")!;
    expect(opened.actor).toBe("lead");
    expect(JSON.parse(opened.payload).onBehalfOf).toBeUndefined();

    const second = deliveredTicketIn(join(dir, "other"));
    execFileSync("git", ["init", "-q", "--bare", join(dir, "other.git")]);
    git(join(dir, "other"), "remote", "add", "origin", join(dir, "other.git"));
    const turn = createTurn(db, {
      id: "pr-turn", originBindingId: createLoopbackBinding(db, { name: "Mac 网页" }).binding.id, originKind: "paired:companion", userText: "开个 PR", state: "streaming",
    });
    await openDeliveryPullRequest(db, second, { actor: "lead", reason: "用户说开 PR", sourceTurnId: turn.id, runner });
    const onBehalf = listActivities(db, second).find((row) => JSON.parse(row.payload).decision === "workspace_pr_opened")!;
    expect(JSON.parse(onBehalf.payload)).toMatchObject({ onBehalfOf: "user", sourceTurnId: "pr-turn" });
  });

  // 回归（2026-10-29）：#158 切 worktree 时，用户的 checkout 正停在不相干的功能分支 aishx/task-model-routing 上。
  // worktree 从那里切，草稿 PR 的 base 也成了它。现在从 origin 的默认分支切，PR 也开到默认分支。
  it("cuts the worktree from origin's default branch and opens the PR there, whatever branch the user's checkout is on", async () => {
    const remote = withRemote();
    git(repo, "checkout", "-q", "-b", "feature/unrelated");
    writeFileSync(join(repo, "unrelated.md"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "unrelated");
    git(repo, "push", "-q", "origin", "feature/unrelated");
    const { itemId, worktree } = deliveredTicket();
    expect(existsSync(join(worktree, "unrelated.md"))).toBe(false);
    const calls: string[][] = [];
    const runner: PullRequestRunner = {
      async gh(args) {
        calls.push(args);
        return { ok: true, stdout: "https://github.com/acme/repo/pull/14\n", stderr: "" };
      },
    };
    await openDeliveryPullRequest(db, itemId, { actor: "user", reason: "用户点了开 PR", runner });
    const branch = (await ticketDelivery(db, itemId)).workspace!.branch!;
    expect(git(remote, "branch", "--list", branch)).toContain(branch);
    expect(calls[0]!.slice(0, 7)).toEqual(["pr", "create", "--draft", "--head", branch, "--base", "main"]);
  });

  // 回归（2026-10-21 审查 L3）：PR 的标题和正文用的是 agent 写的摘要和验证结果，直接发到 GitHub。先脱敏。
  it("removes secrets from the title and the body before they go to GitHub", async () => {
    withRemote();
    const { itemId } = deliveredTicket();
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    db.prepare("UPDATE items SET title=? WHERE id=?").run(`fix login, token ${token}`, itemId);
    db.prepare("UPDATE outcome_snapshots SET summary=? WHERE item_id=?").run(`用 ${token} 调了接口。`, itemId);
    const calls: string[][] = [];
    const runner: PullRequestRunner = {
      async gh(args) {
        calls.push(args);
        return { ok: true, stdout: "https://github.com/acme/repo/pull/14\n", stderr: "" };
      },
    };
    await openDeliveryPullRequest(db, itemId, { actor: "user", reason: "r", runner });
    const title = calls[0]![calls[0]!.indexOf("--title") + 1]!;
    const body = calls[0]![calls[0]!.indexOf("--body") + 1]!;
    expect(title).toContain("fix login");
    expect(`${title}\n${body}`).not.toContain(token);
  });

  it("says plainly when gh is missing, after the branch is already pushed", async () => {
    const remote = withRemote();
    const { itemId } = deliveredTicket();
    const runner: PullRequestRunner = { async gh() { return { ok: false, stdout: "", stderr: "ENOENT" }; } };
    await expect(openDeliveryPullRequest(db, itemId, { actor: "user", reason: "r", runner }))
      .rejects.toThrow("这台电脑没有装 GitHub CLI（gh）。分支已经推上去了，可以在 GitHub 上手动开 PR。");
    const branch = (await ticketDelivery(db, itemId)).workspace!.branch!;
    expect(git(remote, "branch", "--list", branch)).toContain(branch);
  });
});

describe("abandon the changes", () => {
  it("is only offered once the ticket is finished, and keeps the branch in the user's repository", async () => {
    const { itemId } = deliveredTicket();
    await expect(abandonDelivery(db, itemId, { reason: "r" })).rejects.toMatchObject({ code: "unavailable" });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    const before = await ticketDelivery(db, itemId);
    expect(before.actions.abandon).toEqual({ available: true, reason: null });

    const after = await abandonDelivery(db, itemId, { reason: "用户在工单详情里点了「放弃改动」" });
    expect(after.workspace).toMatchObject({ integration: "abandoned" });
    expect(getWorkspace(db, before.workspace!.workspaceId)?.state).toBe("archived");
    expect(git(repo, "branch", "--list", before.workspace!.branch!)).toContain(before.workspace!.branch!);
    expect(git(repo, "show", "HEAD:README.md")).toBe("readme");
  });
});

describe("a ticket that changed the user's directory directly", () => {
  it("shows the delivered files' full text and refuses a link that points outside the directory", async () => {
    const shared = join(dir, "shared");
    mkdirSync(join(shared, "docs"), { recursive: true });
    writeFileSync(join(shared, "docs", "notes.md"), "# notes\n");
    writeFileSync(join(dir, "outside.txt"), "outside\n");
    symlinkSync(join(dir, "outside.txt"), join(shared, "docs", "link.md"));
    const itemId = createItem(db, { title: "notes", brief: "b", createdBy: "lead", workdir: shared });
    const runId = createRun(db, { itemId, runtime: "claude" });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "b".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "写了笔记。", changes: [],
        deliverables: [{ kind: "path", ref: "docs/notes.md", label: "笔记" }, { kind: "path", ref: "docs/link.md", label: "链接" }],
        validations: [],
      }, { workdir: shared }),
      now: new Date(),
    });
    // 交付以后才有交付视图（spec 4.5）。
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);

    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.source).toBe("shared");
    expect(delivery.workspace).toBeNull();
    expect(delivery.files.map((file) => [file.path, file.views])).toEqual([["docs/notes.md", ["full"]], ["docs/link.md", []]]);
    expect((await ticketDeliveryFile(db, itemId, "docs/notes.md", "full")).text).toBe("# notes\n");
    await expect(ticketDeliveryFile(db, itemId, "docs/link.md", "full")).rejects.toMatchObject({ code: "unavailable" });
  });

  // 回归（2026-10-21 审查 M6）：检查只看请求路径的文件名。工作目录里一个 notes.md -> .env 的符号链接能通过 realpath 的
  // 包含检查，界面会显示 .env 的内容。现在按链接指向的文件名再查一次。
  it("hides a delivered link that points at a secrets file inside the directory", async () => {
    const shared = join(dir, "shared-link");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, ".env"), "SECRET=do-not-show\n");
    symlinkSync(join(shared, ".env"), join(shared, "notes.md"));
    const itemId = createItem(db, { title: "notes", brief: "b", createdBy: "lead", workdir: shared });
    const runId = createRun(db, { itemId, runtime: "claude" });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "c".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "写了笔记。", changes: [], deliverables: [{ kind: "path", ref: "notes.md", label: "笔记" }], validations: [],
      }, { workdir: shared }),
      now: new Date(),
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);

    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.files).toMatchObject([{ path: "notes.md", views: [], hiddenReason: "这个文件可能含密钥，不在这里显示。" }]);
    const failure = await ticketDeliveryFile(db, itemId, "notes.md", "full").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(String((failure as Error).message)).not.toContain("SECRET");
  });
});

// 回归（工单 04，spec 5.5）：交付视图以前每次打开都跑 git diff。worktree 和分支清掉以后，文件列表就没了，
// 用户回头看一张已经结束的工单，看不到它交付了什么。现在执行 agent 交付的那一刻，系统把 diff 存进工单。
describe("the delivered file list after the workspace is gone", () => {
  it("still lists what the agent delivered after the worktree and its branch are removed", async () => {
    const itemId = createItem(db, { title: "写方案", brief: "b", createdBy: "lead", workdir: repo });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    mkdirSync(join(workspace.path, "docs"));
    writeFileSync(join(workspace.path, "docs", "plan.md"), "# 方案\n\n第一行\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "docs: plan");
    const runId = createRun(db, { itemId, runtime: "claude", workspaceId: workspace.id });
    updateRun(db, runId, { state: "running" });
    await createAgentToolHandlers({ db, itemId, runId }).call("ticket_update", {
      status: "review", reason: "实现完成",
      checkpoint: {
        kind: "completed", stage: "implementation", title: "实现完成", summary: "写了方案。",
        key_facts: [], artifact_refs: [], related_ticket_ids: [], next_step: "等核查",
        outcome: {
          summary: "写了方案。",
          changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增方案文档" }],
          deliverables: [], validations: [],
        },
      },
    });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });

    // 工作区清理：worktree 删掉，分支也删掉（用户或清理扫描删的）。
    git(repo, "worktree", "remove", "--force", workspace.path);
    git(repo, "branch", "-D", workspace.branch!);
    db.prepare("UPDATE workspaces SET state='archived' WHERE id=?").run(workspace.id);

    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.files.map((file) => [file.path, file.status, file.additions, file.note])).toEqual([
      ["docs/plan.md", "added", 3, "新增方案文档"],
    ]);
    expect(delivery.totals).toEqual({ files: 1, additions: 3, deletions: 0 });
    expect(delivery.attemptId).toBe(runId);
    expect(Value.Check(TicketDeliverySchema, delivery)).toBe(true);
  });
});

// 回归（2026-10-21 审查 M6）：隔离分支上的两种绕过。
describe("secrets on an isolated branch", () => {
  function commitIn(worktree: string, message: string): void {
    git(worktree, "add", "-A");
    git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", message);
  }

  // 改名时只检查新路径：.env 改名成 env.txt 以后能看到它的内容。
  it("hides a file whose old name was a secrets file", async () => {
    writeFileSync(join(repo, ".env"), "SECRET=do-not-show\n");
    git(repo, "add", "-f", ".env");
    git(repo, "commit", "-qm", "env");
    const { itemId, worktree } = deliveredTicket();
    git(worktree, "mv", ".env", "env.txt");
    commitIn(worktree, "rename");

    const delivery = await ticketDelivery(db, itemId);
    expect(delivery.files.find((file) => file.path === "env.txt")).toMatchObject({
      previousPath: ".env", views: [], hiddenReason: "这个文件可能含密钥，不在这里显示。",
    });
    for (const view of ["full", "diff"] as const) {
      await expect(ticketDeliveryFile(db, itemId, "env.txt", view)).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  // git 把 diff 的路径当成 pathspec。一个文件名就是 * 的交付文件，会让 git diff -- * 带出所有文件的改动，包括隐藏的 .env。
  it("reads a file named like a glob as that one file", async () => {
    const { itemId, worktree } = deliveredTicket();
    writeFileSync(join(worktree, "*"), "star\n");
    commitIn(worktree, "star");

    const diff = await ticketDeliveryFile(db, itemId, "*", "diff");
    expect(diff.text).toContain("+star");
    expect(diff.text).not.toContain("SECRET");
    expect(diff.text).not.toContain("docs/plan.md");
  });
});
