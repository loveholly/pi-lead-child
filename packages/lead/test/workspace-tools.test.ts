// Lead 的工作区工具（2026-10-19）：合并和放弃隔离 worktree，建 PR 评审单。
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, createLoopbackBinding, createTurn, getWorkspace, listActivities } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { prepareRunWorkspaceNowForTesting, pullRequestReviewTarget } from "@pi-lead-child/engine";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;
let repo: string;
let deps: LeadDeps;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
}

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  dir = tempDir("plc-workspace-tools-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "source.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: join(dir, "data") };
});

function finishedTicketWithCommit(stage: "done" | "cancelled" = "done") {
  const itemId = createItem(db, { title: "change", brief: "b", createdBy: "lead", workdir: repo });
  const worktree = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  writeFileSync(join(worktree.path, "feature.txt"), "feature\n");
  git(worktree.path, "add", "feature.txt");
  git(worktree.path, "commit", "-qm", "feature");
  db.prepare("UPDATE items SET stage=? WHERE id=?").run(stage, itemId);
  return { itemId, worktree };
}

describe("integrate_workspace", () => {
  it("merges a finished ticket's worktree into the user's checkout and removes it", async () => {
    const { itemId, worktree } = finishedTicketWithCommit();
    const result = JSON.parse((await tool("integrate_workspace").execute("call", { item_id: itemId, reason: "用户说合并" })).content[0].text);
    expect(result).toMatchObject({ workspaceId: worktree.id, state: "archived", branchDeleted: true });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("refuses an active ticket: the merge waits until the ticket is done", async () => {
    const itemId = createItem(db, { title: "change", brief: "b", createdBy: "lead", workdir: repo });
    prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" });
    await expect(tool("integrate_workspace").execute("call", { item_id: itemId, reason: "r" })).rejects.toThrow(/done or cancelled/);
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
  });
});

// 审查 M1：放弃隔离 worktree 是不可逆的操作。release_workspace 转调 ticket_action 的 abandon，用同一条授权规则。
// 2026-10-28 起由 Lead 判断；读过外部内容的一轮里做不了。在用户这一轮里做的记成代用户做。
describe("release_workspace on an isolated worktree", () => {
  it("abandons as Lead on the user's behalf in the user's turn, and not in a turn that read outside content", async () => {
    const { itemId, worktree } = finishedTicketWithCommit("cancelled");
    deps.currentTurnId = () => null;
    deps.turnOrigin = () => ({ external: true, timer: null });
    await expect(tool("release_workspace").execute("call", {
      item_id: itemId, merge_status: "abandoned", reason: "cancelled", user_confirmation: "可以删",
    })).rejects.toThrow(/这一轮读过外部内容/);
    expect(existsSync(worktree.path)).toBe(true);
    deps.turnOrigin = () => ({ external: false, timer: null });
    await expect(tool("release_workspace").execute("call", { item_id: itemId, reason: "cancelled" }))
      .rejects.toThrow(/integrate_workspace/);

    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "abandon-turn", originBindingId: binding.id, originKind: "paired:companion", userText: "删掉吧", state: "streaming" });
    deps.currentTurnId = () => turn.id;
    const result = JSON.parse((await tool("release_workspace").execute("call", {
      item_id: itemId, merge_status: "abandoned", reason: "用户说这些改动不要了",
    })).content[0].text);
    expect(result).toMatchObject({ workspaceId: worktree.id, authority: "on_behalf", integration: "abandoned" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(getWorkspace(db, worktree.id)?.merge_status).toBe("abandoned");
    const abandoned = listActivities(db, itemId).find((activity) => JSON.parse(activity.payload).decision === "workspace_abandoned")!;
    expect(abandoned.actor).toBe("lead");
    expect(JSON.parse(abandoned.payload)).toMatchObject({ onBehalfOf: "user", sourceTurnId: turn.id });
  });

  it("refuses to abandon the worktree of a ticket that has not ended, even in the user's turn", async () => {
    const itemId = createItem(db, { title: "change", brief: "b", createdBy: "lead", workdir: repo });
    const worktree = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "early-turn", originBindingId: binding.id, originKind: "paired:companion", userText: "删掉吧", state: "streaming" });
    deps.currentTurnId = () => turn.id;
    await expect(tool("release_workspace").execute("call", { item_id: itemId, merge_status: "abandoned", reason: "用户说删掉" }))
      .rejects.toThrow();
    expect(existsSync(worktree.path)).toBe(true);
  });
});

describe("create_task for a pull request review", () => {
  it("records the pull request so every run checks out its head", async () => {
    await tool("create_task").execute("call", {
      title: "review PR 7", brief: "review it", workdir: repo, review_pull_request: 7, runtime: "codex",
    });
    const itemId = (db.prepare("SELECT id FROM items WHERE title='review PR 7'").get() as { id: number }).id;
    // 没指定远端时不记 origin：检出时按 PR 所在仓库的地址找远端（工单 #212）。
    expect(pullRequestReviewTarget(db, itemId)).toEqual({ number: 7 });
  });

  it("keeps the remote that Lead names", async () => {
    await tool("create_task").execute("call", {
      title: "review PR 9", brief: "review it", workdir: repo, review_pull_request: 9, pull_request_remote: "public", runtime: "codex",
    });
    const itemId = (db.prepare("SELECT id FROM items WHERE title='review PR 9'").get() as { id: number }).id;
    expect(pullRequestReviewTarget(db, itemId)).toEqual({ number: 9, remote: "public" });
  });

  // 工单 #17：template=pr_review 只写了模板记录，没有 PR 目标，评审 Run 落在 master 的 worktree 上，没有检出 PR head。
  describe("with template=pr_review", () => {
    const prReview = { pr: "Acme/agent-app#101", focus: "看鉴权", acceptance: "每个问题指到行" };
    const itemIdOf = (result: any) => Number(/#(\d+)/.exec(result.content[0].text)![1]);

    it("records the pull request from the template, so the run checks out its head", async () => {
      const result = await tool("create_task").execute("call", {
        title: "review via template", brief: "", workdir: repo, template: "pr_review", pr_review: prReview, runtime: "codex",
      });
      expect(pullRequestReviewTarget(db, itemIdOf(result))).toEqual({ number: 101, repository: "github.com/acme/agent-app" });
      expect(result.content[0].text).toContain("评审 Run 在 PR #101 head 的临时检出里跑");
    });

    it("keeps the remote Lead names next to the template's own number", async () => {
      const result = await tool("create_task").execute("call", {
        title: "review via template, explicit", brief: "", workdir: repo, template: "pr_review", pr_review: prReview,
        review_pull_request: 101, pull_request_remote: "upstream", runtime: "codex",
      });
      expect(pullRequestReviewTarget(db, itemIdOf(result))).toEqual({ number: 101, remote: "upstream", repository: "github.com/acme/agent-app" });
    });

    // brief 和发布权限清单都只认模板里的 PR：检出另一个号码时，评审看的是那个 PR 的代码，发到的却是这个 PR。
    it("refuses a review_pull_request that is not the template's PR, and creates nothing", async () => {
      await expect(tool("create_task").execute("call", {
        title: "review via template, mismatch", brief: "", workdir: repo, template: "pr_review", pr_review: prReview,
        review_pull_request: 55, runtime: "codex",
      })).rejects.toThrow(/review_pull_request=55.*#101/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='review via template, mismatch'").get()).toEqual({ n: 0 });
    });

    it("still creates the ticket, without a target, when the workdir is not a git repository", async () => {
      const result = await tool("create_task").execute("call", {
        title: "review via template, no repo", brief: "", workdir: tempDir("plc-plain-"), template: "pr_review", pr_review: prReview,
        runtime: "codex",
      });
      expect(pullRequestReviewTarget(db, itemIdOf(result))).toBeNull();
      // 回执要说出来：Lead 只看得到这句话，不说就以为评审会在 PR head 上做（工单 #17 就是这样没人发现）。
      expect(result.content[0].text).toContain("没有登记 PR 目标");
    });
  });

  it("refuses a pull request review whose workdir is not a git repository", async () => {
    const plain = tempDir("plc-plain-");
    await expect(tool("create_task").execute("call", {
      title: "review PR 8", brief: "review it", workdir: plain, review_pull_request: 8, runtime: "codex",
    })).rejects.toThrow(/not a git repository/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='review PR 8'").get()).toEqual({ n: 0 });
  });
});
