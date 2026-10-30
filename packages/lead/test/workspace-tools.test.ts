// Lead 的工作区工具（2026-10-19）：合并和放弃隔离 worktree，建 PR 评审单。
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, createLoopbackBinding, createTurn, getWorkspace, listActivities } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { prepareRunWorkspace, pullRequestReviewTarget } from "@pi-lead-child/engine";
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
  const worktree = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
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
    prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" });
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
    const worktree = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
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
    expect(pullRequestReviewTarget(db, itemId)).toEqual({ number: 7, remote: "origin" });
  });

  it("refuses a pull request review whose workdir is not a git repository", async () => {
    const plain = tempDir("plc-plain-");
    await expect(tool("create_task").execute("call", {
      title: "review PR 8", brief: "review it", workdir: plain, review_pull_request: 8, runtime: "codex",
    })).rejects.toThrow(/not a git repository/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='review PR 8'").get()).toEqual({ n: 0 });
  });
});
