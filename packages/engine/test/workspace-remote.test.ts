// 仓库的远端（2026-10-29）：沙箱里的 child 没有 git 的凭证，daemon 在沙箱外替它 fetch；新 worktree 从 origin 的默认分支切。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, getWorkspace, openDb } from "@pi-lead-child/store";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import {
  chooseWorktreeBase, fetchOrigin, originDefaultBranch, refreshFreshWorktree, resetFetchThrottleForTests,
} from "../src/coordinator/workspace-remote.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", file);
  return git(repo, "rev-parse", "HEAD");
}

// 一个 bare 的 origin，用户的 checkout（clone）和同事的 clone（往 origin 推新提交）。
function repos(): { origin: string; user: string; colleague: string } {
  const dir = tempDir("plc-remote-");
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "master", seed]);
  commit(seed, "a.txt");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "master");
  const user = join(dir, "user");
  const colleague = join(dir, "colleague");
  execFileSync("git", ["clone", "-q", origin, user]);
  execFileSync("git", ["clone", "-q", origin, colleague]);
  return { origin, user, colleague };
}

beforeEach(() => resetFetchThrottleForTests());

describe("fetchOrigin", () => {
  // #159 返工要 rebase 到最新的 master，本地的 origin/master 还是几天前的，沙箱里又 fetch 不了。
  it("brings origin's new commits into the user's repository, at most once a minute", async () => {
    const { user, colleague } = repos();
    const latest = commit(colleague, "b.txt");
    git(colleague, "push", "-q", "origin", "master");
    expect(git(user, "rev-parse", "origin/master")).not.toBe(latest);
    expect(await fetchOrigin(user, { now: 1_000_000 })).toMatchObject({ fetched: true });
    expect(git(user, "rev-parse", "origin/master")).toBe(latest);
    expect(await fetchOrigin(user, { now: 1_030_000 })).toMatchObject({ fetched: false, reason: "刚 fetch 过" });
  });

  it("does nothing, and says why, without a repository or an origin", async () => {
    expect(await fetchOrigin(null)).toMatchObject({ fetched: false });
    expect(await fetchOrigin(tempDir("plc-remote-none-"))).toMatchObject({ fetched: false, reason: "不是 git 仓库" });
    const local = tempDir("plc-remote-local-");
    execFileSync("git", ["init", "-q", local]);
    expect(await fetchOrigin(local)).toMatchObject({ fetched: false, reason: "没有 origin" });
  });
});

describe("chooseWorktreeBase", () => {
  // #158、#159：用户的 checkout 停在不相干的功能分支上，worktree 以前从那里切。
  it("uses origin's default branch, not the branch the user's checkout is on", () => {
    const { user } = repos();
    const master = git(user, "rev-parse", "origin/master");
    git(user, "checkout", "-q", "-b", "feature/unrelated");
    commit(user, "unrelated.txt");
    expect(originDefaultBranch(user)).toBe("master");
    expect(chooseWorktreeBase(user, user)).toEqual({ ref: master, branch: "master" });
  });

  it("uses the local default branch when it has commits origin does not, and origin's when local is behind", async () => {
    const { user, colleague } = repos();
    const ahead = commit(user, "local.txt");
    expect(chooseWorktreeBase(user, user)).toEqual({ ref: ahead, branch: "master" });
    git(user, "reset", "-q", "--hard", "HEAD~1");
    const latest = commit(colleague, "b.txt");
    git(colleague, "push", "-q", "origin", "master");
    await fetchOrigin(user, { force: true });
    expect(chooseWorktreeBase(user, user)).toEqual({ ref: latest, branch: "master" });
  });

  it("uses the checkout's HEAD in a repository without origin", () => {
    const local = tempDir("plc-remote-local-");
    execFileSync("git", ["init", "-q", "-b", "main", local]);
    git(local, "checkout", "-q", "-b", "work");
    const head = commit(local, "x.txt");
    expect(chooseWorktreeBase(local, local)).toEqual({ ref: head, branch: null });
  });
});

// worktree 在建 Run 时同步切（用上一次 fetch 的 origin），fetch 在建 Run 之后（daemon 重启接管孤儿时不能先 await）。
// 新切的、还没有提交的 worktree 在 fetch 以后快进到最新的 origin，基线跟着改。
describe("refreshFreshWorktree", () => {
  function worktree() {
    const { user, colleague } = repos();
    const db = openDb(join(tempDir("plc-remote-db-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", workdir: user });
    const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    const latest = commit(colleague, "b.txt");
    git(colleague, "push", "-q", "origin", "master");
    return { db, user, workspace, latest };
  }

  it("moves a fresh worktree and its base to origin's new head after the fetch", async () => {
    const { db, user, workspace, latest } = worktree();
    await fetchOrigin(user, { force: true });
    expect(refreshFreshWorktree(db, workspace)).toMatchObject({ base_ref: latest });
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(latest);
    expect(getWorkspace(db, workspace.id)!.base_ref).toBe(latest);
  });

  it("leaves a worktree with its own commit alone", async () => {
    const { db, user, workspace } = worktree();
    commit(workspace.path, "mine.txt");
    await fetchOrigin(user, { force: true });
    expect(refreshFreshWorktree(db, workspace)).toBeNull();
    expect(getWorkspace(db, workspace.id)!.base_ref).toBe(workspace.base_ref);
  });
});
