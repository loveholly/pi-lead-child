// 隔离 worktree 和临时检出的清理（2026-10-19 用户决定）：
//   · 合并或放弃以后马上删；
//   · 定期扫描：结束了的工单的 worktree、过期的临时检出、<repo>.plc-workspaces 下没有登记的孤儿目录，按 TTL 清理；
//   · 有没合并改动的 worktree 不悄悄删，先问用户；
//   · 清理有记录，Lead 的当前局面里看得见（inbox）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runningHostJobs } from "@pi-lead-child/core";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  createItem, createWorkspace, getItem, getWorkspace, listActivities, listInbox, resolveWorkspace,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { AgentRuntime, RuntimeStartRequest } from "@pi-lead-child/runtime";
import {
  abandonIsolatedWorkspace, cleanupWorkspace, integrateIsolatedWorkspace, provisionWorkspace, releaseWorkspace, sweepWorkspaces,
  workspaceCleanupChecks, workspaceRootFor, WORKTREE_REMOVE_TIMEOUT_MS, WORKTREE_TRASH_DIR, worktreeDeletionsSettled,
} from "../src/coordinator/workspace.js";
import { performWorkspaceAction } from "../src/coordinator/workspace-actions.js";
import { prepareRunWorkspaceNowForTesting } from "../src/coordinator/workspace-policy.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { runItem } from "../src/children/manager.js";

let db: Db;
let dir: string;
let repo: string;
const DAY = 24 * 60 * 60_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-workspace-cleanup-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "source.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
});
afterEach(() => db.close());

function codingTicket(): number {
  return createItem(db, { title: "change", brief: "b", createdBy: "lead", workdir: repo });
}

function isolatedFor(itemId: number) {
  return prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
}

function commitIn(path: string, file: string, content: string): void {
  writeFileSync(join(path, file), content);
  git(path, "add", file);
  git(path, "commit", "-qm", `change ${file}`);
}

function finish(itemId: number, stage: "done" | "cancelled" = "done"): void {
  db.prepare("UPDATE items SET stage=? WHERE id=?").run(stage, itemId);
}

function decisionsOf(itemId: number, decision: string) {
  return listActivities(db, itemId)
    .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
    .filter((payload) => payload.decision === decision);
}

function inboxOf(kind: string) {
  return listInbox(db, {}).filter((row) => JSON.parse(row.payload).inboxKind === kind);
}

describe("the sweep and an isolated worktree of a finished ticket", () => {
  it("keeps a clean worktree until the TTL, then removes it and its branch and tells Lead", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    finish(itemId);

    expect(await sweepWorkspaces(db, later(1))).toMatchObject({ cleaned: 0, awaitingDecision: 0 });
    expect(existsSync(worktree.path)).toBe(true);

    expect(await sweepWorkspaces(db, later(8))).toMatchObject({ cleaned: 1, failed: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "abandoned" });
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
    // 工单的 workdir 改回用户的 checkout，不再指向删掉的目录。
    expect(getItem(db, itemId)?.workdir).toBe(repo);
    expect(inboxOf("workspace_cleaned")).toHaveLength(1);
    expect(JSON.parse(inboxOf("workspace_cleaned")[0]!.payload)).toMatchObject({ wakeLead: false, needsUser: false });
  });

  for (const change of ["commit", "dirty file"] as const) it(`never deletes a worktree with an unmerged ${change}; it asks the user once`, async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    if (change === "commit") commitIn(worktree.path, "feature.txt", "feature\n");
    else writeFileSync(join(worktree.path, "draft.txt"), "not committed\n");
    finish(itemId);

    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 0, awaitingDecision: 1, failed: [] });
    expect(await sweepWorkspaces(db, later(30))).toMatchObject({ cleaned: 0, awaitingDecision: 1, failed: [] });
    expect(existsSync(worktree.path)).toBe(true);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "pending_integration", merge_status: "pending" });
    const asks = inboxOf("workspace_merge_decision");
    // 30 天后的那一次超过了 TTL，所以再问了一次；同一天的重复扫描不会再问。
    expect(asks).toHaveLength(2);
    expect(await sweepWorkspaces(db, later(30))).toMatchObject({ awaitingDecision: 1 });
    expect(inboxOf("workspace_merge_decision")).toHaveLength(asks.length);
    expect(JSON.parse(asks[0]!.payload)).toMatchObject({ workspaceId: worktree.id, wakeLead: true, needsUser: true });
  });

  it("removes the worktree at once when the user merged the branch themselves", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ awaitingDecision: 1 });

    git(repo, "merge", "-q", "--no-edit", worktree.branch!);
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0 });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
  });

  it("lets a ticket chat use a worktree that waits for a merge decision", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    await sweepWorkspaces(db, later(0));
    expect(getWorkspace(db, worktree.id)?.state).toBe("pending_integration");

    const chat = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "conversation" }).workspace!;
    expect(chat).toMatchObject({ id: worktree.id, state: "idle" });
  });

  it("tidies up a worktree whose directory someone deleted, unless its branch has unmerged commits", async () => {
    const empty = codingTicket();
    const emptyWorktree = isolatedFor(empty);
    const withCommit = codingTicket();
    const committed = isolatedFor(withCommit);
    commitIn(committed.path, "feature.txt", "feature\n");
    for (const path of [emptyWorktree.path, committed.path]) rmSync(path, { recursive: true, force: true });
    finish(empty);
    finish(withCommit);
    // daemon 重启时把目录不在的工作区标成 failed（reconcileWorkspaces）。
    db.prepare("UPDATE workspaces SET state='failed' WHERE id=?").run(committed.id);

    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 1, failed: [] });
    expect(getWorkspace(db, emptyWorktree.id)?.state).toBe("archived");
    expect(git(repo, "branch", "--list", emptyWorktree.branch!)).toBe("");
    expect(git(repo, "branch", "--list", committed.branch!)).toContain(committed.branch!);
    expect(inboxOf("workspace_merge_decision")).toHaveLength(1);

    // 用户决定合并：目录不在了，分支照样合并进用户的 checkout。
    await integrateIsolatedWorkspace(db, committed.id, { actor: "lead", reason: "user said merge" });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(getWorkspace(db, committed.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(git(repo, "branch", "--list", committed.branch!)).toBe("");
  });

  it("removes a PR checkout that a crashed daemon left behind", async () => {
    const itemId = codingTicket();
    const path = join(workspaceRootFor(realpathSync(repo)), "pr-7-item-1-dead");
    git(repo, "update-ref", "refs/plc/review/item-1-dead", "HEAD");
    git(repo, "worktree", "add", "-q", "--detach", path, "HEAD");
    const checkout = createWorkspace(db, {
      ownerItemId: itemId, mode: "isolated", kind: "experiment", repoRoot: realpathSync(repo), path,
      branch: "refs/plc/review/item-1-dead", baseRef: git(repo, "rev-parse", "HEAD"), gitWorktree: true, state: "active",
    });

    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, failed: [] });
    expect(existsSync(path)).toBe(false);
    expect(getWorkspace(db, checkout.id)?.state).toBe("archived");
    expect(git(repo, "for-each-ref", "refs/plc")).toBe("");
  });
});

// 审查 2026-10-19 第 2 条：合并冲突把 worktree 改成 blocked，以前扫描不看 blocked，再也没有提醒。
describe("a worktree whose merge conflicted", () => {
  async function conflicted() {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    writeFileSync(join(worktree.path, "source.txt"), "child\n");
    git(worktree.path, "commit", "-qam", "child");
    writeFileSync(join(repo, "source.txt"), "user\n");
    git(repo, "commit", "-qam", "user");
    finish(itemId);
    await sweepWorkspaces(db, later(0));
    await expect(integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "user ok" })).rejects.toThrow(/conflict/);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "blocked", merge_status: "conflict" });
    return { itemId, worktree };
  }

  it("is asked about again after the TTL, as a conflict, and is never deleted", async () => {
    const { worktree } = await conflicted();
    const before = inboxOf("workspace_merge_decision").length;
    expect(await sweepWorkspaces(db, later(30))).toMatchObject({ awaitingDecision: 1, cleaned: 0, failed: [] });
    const asks = inboxOf("workspace_merge_decision");
    expect(asks).toHaveLength(before + 1);
    expect(JSON.parse(asks.at(-1)!.payload)).toMatchObject({ workspaceId: worktree.id, conflict: true, needsUser: true });
    expect(asks.at(-1)!.summary).toContain("合并时冲突");
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("is cleaned up once the user merged the branch and resolved the conflict", async () => {
    const { worktree } = await conflicted();
    try { git(repo, "merge", "-q", "--no-edit", worktree.branch!); } catch { /* 冲突 */ }
    writeFileSync(join(repo, "source.txt"), "resolved\n");
    git(repo, "commit", "-qam", "resolve");
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("can be abandoned with the user's words", async () => {
    const { worktree } = await conflicted();
    const result = await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "conflict", userConfirmation: "放弃吧" });
    expect(result).toMatchObject({ branchDeleted: false, workspace: { state: "archived", merge_status: "abandoned" } });
  });
});

// 审查 2026-10-19 第 7 条：git worktree add 中途失败、目录还在时，行停在 failed，工单卡住。
describe("a worktree whose creation failed half way", () => {
  function failedWorktree(prepare: (path: string) => void) {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    prepare(worktree.path);
    db.prepare("UPDATE workspaces SET state='failed' WHERE id=?").run(worktree.id);
    return { itemId, worktree };
  }

  it("is replaced when it is a clean worktree still at its base", () => {
    const { itemId, worktree } = failedWorktree(() => {});
    const next = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    expect(next.id).not.toBe(worktree.id);
    expect(next.state).toBe("active");
    expect(getWorkspace(db, worktree.id)?.state).toBe("archived");
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("is replaced when only git's .git file was written", () => {
    const { itemId, worktree } = failedWorktree((path) => {
      git(repo, "worktree", "remove", "--force", path);
      mkdirSync(path);
      writeFileSync(join(path, ".git"), "gitdir: nowhere\n");
    });
    const next = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    expect(next.id).not.toBe(worktree.id);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("is kept when it holds work", () => {
    const { itemId, worktree } = failedWorktree((path) => commitIn(path, "work.txt", "work\n"));
    const next = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    expect(next.id).toBe(worktree.id);
    expect(readFileSync(join(worktree.path, "work.txt"), "utf8")).toBe("work\n");
  });
});

describe("merge and abandon decisions", () => {
  it("merges the branch into the user's checkout and removes the worktree", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);

    const result = await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "user said merge it" });
    expect(result).toMatchObject({ branchDeleted: true, workspace: { state: "archived", merge_status: "merged" } });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(existsSync(worktree.path)).toBe(false);
    expect(decisionsOf(itemId, "workspace_integrated")).toEqual([
      expect.objectContaining({ workspaceId: worktree.id, target: "main", reason: "user said merge it" }),
    ]);
  });

  it("does not merge into a checkout with the user's uncommitted changes, or from a dirty worktree", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    writeFileSync(join(repo, "source.txt"), "the user's edit\n");
    await expect(integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r" })).rejects.toThrow(/uncommitted changes/);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("the user's edit\n");
    git(repo, "checkout", "--", "source.txt");
    writeFileSync(join(worktree.path, "draft.txt"), "x\n");
    await expect(integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r" })).rejects.toThrow(/worktree #\d+ has uncommitted/);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("does not abandon unmerged work without the user's words, and keeps it on the branch when it does", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    writeFileSync(join(worktree.path, "draft.txt"), "draft\n");
    finish(itemId, "cancelled");

    await expect(abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "ticket cancelled" }))
      .rejects.toThrow(/user's consent/);
    expect(existsSync(worktree.path)).toBe(true);

    const result = await abandonIsolatedWorkspace(db, worktree.id, {
      actor: "lead", reason: "ticket cancelled", userConfirmation: "不要了，删掉吧",
    });
    expect(result).toMatchObject({ branchDeleted: false, workspace: { state: "archived", merge_status: "abandoned" } });
    expect(existsSync(worktree.path)).toBe(false);
    // 没提交的文件也提交到了分支上：改动在用户的仓库里还能找回。
    expect(git(repo, "show", `${worktree.branch}:draft.txt`)).toBe("draft");
    expect(git(repo, "show", `${worktree.branch}:feature.txt`)).toBe("feature");
    expect(decisionsOf(itemId, "workspace_abandoned")).toEqual([
      expect.objectContaining({ userConfirmation: "不要了，删掉吧", branchKept: true }),
    ]);
  });
});

describe("orphan directories under <repo>.plc-workspaces", () => {
  function age(path: string, days: number): void {
    const at = new Date(Date.now() - days * DAY);
    utimesSync(path, at, at);
  }

  // 审查 2026-10-19 第 8 条：扫描以前跟随符号链接，会删掉容器外面用户自己的干净 worktree。
  it("does not follow a symbolic link to a worktree outside the container", async () => {
    const itemId = codingTicket();
    isolatedFor(itemId);
    const outside = join(dir, "users-own-worktree");
    git(repo, "worktree", "add", "-q", "--detach", outside, "HEAD");
    const link = join(workspaceRootFor(realpathSync(repo)), "link-to-outside");
    symlinkSync(outside, link);
    age(outside, 10);
    expect(await sweepWorkspaces(db, new Date())).toMatchObject({ cleaned: 0, failed: [] });
    expect(existsSync(join(outside, "source.txt"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(realpathSync(outside));
  });

  it("removes old clean worktrees and empty directories, asks about the rest, and leaves fresh ones", async () => {
    // 让扫描知道这个仓库：登记一个工作区。
    const itemId = codingTicket();
    isolatedFor(itemId);
    const container = workspaceRootFor(realpathSync(repo));
    const clean = join(container, "orphan-clean");
    git(repo, "worktree", "add", "-q", "-b", "plc/orphan-clean", clean, "HEAD");
    const unmerged = join(container, "orphan-unmerged");
    git(repo, "worktree", "add", "-q", "-b", "plc/orphan-unmerged", unmerged, "HEAD");
    commitIn(unmerged, "lost.txt", "work\n");
    const empty = join(container, "orphan-empty");
    mkdirSync(empty);
    const stranger = join(container, "not-a-worktree");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "file.txt"), "someone's files\n");
    const fresh = join(container, "orphan-fresh");
    git(repo, "worktree", "add", "-q", "--detach", fresh, "HEAD");
    for (const path of [clean, unmerged, empty, stranger]) age(path, 10);

    const result = await sweepWorkspaces(db, new Date());
    expect(result).toMatchObject({ cleaned: 2, awaitingDecision: 2, failed: [] });
    expect(existsSync(clean)).toBe(false);
    expect(git(repo, "branch", "--list", "plc/orphan-clean")).toBe("");
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(unmerged)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(inboxOf("workspace_orphan_decision")).toHaveLength(2);
    // 下一次扫描不再重复问。
    await sweepWorkspaces(db, new Date());
    expect(inboxOf("workspace_orphan_decision")).toHaveLength(2);
  });
});

// 完整的持久化流程：派发 → child 在 worktree 里提交 → 工单完成 → 扫描问合并 → 合并 → 清理，中间重开数据库。
describe("the full persisted flow of a coding ticket", () => {
  function committingRuntime(seen: RuntimeStartRequest[]): AgentRuntime {
    return {
      id: "codex",
      capabilities: { streaming: true, steering: false, resume: false, interrupt: true,
        approvals: false, mcp: false, executableReadOnlyReview: true },
      async start(request) {
        seen.push(request);
        return {
          pid: null,
          events: (async function*() {
            yield { runId: request.runId, seq: 1, occurredAt: new Date().toISOString(),
              type: "run.started" as const, runtime: "codex" as const, model: null };
            commitIn(request.workdir, "feature.txt", "from the child\n");
            yield { runId: request.runId, seq: 2, occurredAt: new Date().toISOString(),
              type: "run.completed" as const, exitCode: 0 };
          })(),
          async interrupt() {},
          async wait() { return { ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }; },
        };
      },
    };
  }

  it("keeps the user's checkout untouched until the merge, then cleans up", async () => {
    const itemId = codingTicket();
    const dispatcher = createDispatcher(db);
    dispatcher.request({ itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "flow" });
    const claim = dispatcher.claimNext()!;
    const seen: RuntimeStartRequest[] = [];
    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, prompt: "do it", sessionDir: join(dir, "sessions"),
      runId: claim.runId, runtime: committingRuntime(seen),
    });
    const worktree = resolveWorkspace(db, itemId)!.workspace;
    expect(seen[0]!.workdir).toBe(worktree.path);
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);

    finish(itemId);
    db.close();
    db = openDb(join(dir, "plc.db"));
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ awaitingDecision: 1 });
    db.close();
    db = openDb(join(dir, "plc.db"));
    expect(getWorkspace(db, worktree.id)?.state).toBe("pending_integration");

    await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "accepted" });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("from the child\n");
    expect(existsSync(worktree.path)).toBe(false);
    expect(getItem(db, itemId)?.stage).toBe("done");
    expect(await sweepWorkspaces(db, later(30))).toMatchObject({ cleaned: 0, awaitingDecision: 0, failed: [] });
  });
});

// #188：放弃或合并时存的快照带上了整个仓库的历史（git bundle … HEAD）。历史超过 25 MB 的仓库存不下快照，
// 状态停在一半：merge_status 已经写成 abandoned，state 没到 released；合并成功的被记成 conflict。
describe("a repository whose history is larger than the artifact limit", () => {
  function bigHistory(): void {
    // 随机内容压不小：bundle 就是这么大。
    writeFileSync(join(repo, "blob.bin"), randomBytes(26 * 1024 * 1024));
    git(repo, "add", "blob.bin");
    git(repo, "commit", "-qm", "large file");
  }

  function snapshotArtifactBytes(workspaceId: number): number | null {
    const row = db.prepare(
      `SELECT a.byte_length FROM workspace_cleanup_snapshots s JOIN artifacts a ON a.id=s.artifact_id WHERE s.workspace_id=?`,
    ).get(workspaceId) as { byte_length: number } | undefined;
    return row?.byte_length ?? null;
  }

  // 存快照要写进数据目录的 artifacts/。那里是一个普通文件时，快照存不成。
  function breakArtifactStore(): () => void {
    const path = join(dir, "artifacts");
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, "not a directory\n");
    return () => rmSync(path, { force: true });
  }

  it("abandons the worktree, keeps the branch, and snapshots only the branch's own commits", async () => {
    bigHistory();
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId, "cancelled");

    const result = await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r", userConfirmation: "不要了" });
    expect(result).toMatchObject({ branchDeleted: false, workspace: { state: "archived", merge_status: "abandoned" } });
    expect(git(repo, "show", `${worktree.branch}:feature.txt`)).toBe("feature");
    expect(snapshotArtifactBytes(worktree.id)).toBeLessThan(100_000);
    expect(decisionsOf(itemId, "workspace_abandoned")).toHaveLength(1);
  });

  it("records a merge as merged, not as a conflict", async () => {
    bigHistory();
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);

    const result = await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "merge it" });
    expect(result).toMatchObject({ workspace: { state: "archived", merge_status: "merged" } });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
  });

  it("snapshots a worktree without new commits with no bundle", async () => {
    bigHistory();
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    finish(itemId, "cancelled");

    expect((await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r" })).workspace.state).toBe("archived");
    expect(snapshotArtifactBytes(worktree.id)).toBeLessThan(10_000);
  });

  it("changes neither merge_status nor state when the snapshot cannot be stored, and can be abandoned again", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId, "cancelled");
    const before = getWorkspace(db, worktree.id)!;
    const repair = breakArtifactStore();

    await expect(abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r", userConfirmation: "不要了" })).rejects.toThrow();
    const after = getWorkspace(db, worktree.id)!;
    expect({ state: after.state, merge_status: after.merge_status }).toEqual({ state: before.state, merge_status: before.merge_status });
    expect(db.prepare("SELECT 1 FROM workspace_cleanup_snapshots WHERE workspace_id=?").get(worktree.id)).toBeUndefined();

    repair();
    const retried = await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r", userConfirmation: "不要了" });
    expect(retried.workspace).toMatchObject({ state: "archived", merge_status: "abandoned" });
  });

  it("reports a merge whose release failed as merged, and the sweep finishes the cleanup", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    db.prepare("UPDATE workspaces SET merge_status='pending' WHERE id=?").run(worktree.id);
    db.prepare("UPDATE workspaces SET state='pending_integration' WHERE id=?").run(worktree.id);
    const repair = breakArtifactStore();

    await expect(integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "merge it" })).rejects.toThrow(/merged into main/);
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "pending_integration", merge_status: "merged" });

    repair();
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, failed: [] });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
  });
});

// #191: git worktree remove of a 1.4 GB worktree ran past git's 10 s timeout and was killed half way.
// The row stayed failed, and every cleanup after that refused the half-deleted tree as unrecorded changes.
describe("a worktree whose removal stopped half way", () => {
  // A git on PATH whose next `worktree remove` deletes these files and fails, like a git killed by the timeout.
  function interruptNextRemoval(files: string[]): () => void {
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(dir, "bin");
    const marker = join(dir, "interrupt-next-removal");
    mkdirSync(bin, { recursive: true });
    writeFileSync(marker, "");
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      `if [ "$3" = worktree ] && [ "$4" = remove ] && [ -f '${marker}' ]; then`,
      `  rm -f '${marker}'; for last; do :; done`,
      ...files.map((file) => `  rm -f "$last/${file}"`),
      "  echo 'spawnSync git ETIMEDOUT' >&2; exit 1",
      "fi",
      `exec '${realGit}' "$@"`,
    ].join("\n"));
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    return () => { process.env.PATH = path; };
  }

  // The row an older daemon left behind for #130: abandoned and snapshotted, the removal killed after
  // it deleted some tracked files, the state failed.
  async function abandonedHalfWay() {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId, "cancelled");
    await releaseWorkspace(db, worktree.id, { mergeStatus: "abandoned" });
    rmSync(join(worktree.path, "source.txt"));
    db.prepare("UPDATE workspaces SET state='failed' WHERE id=?").run(worktree.id);
    return worktree;
  }

  // 回归 2026-11-03：放弃、合并、清理时同步跑 git worktree remove。删一个大 worktree 要很久，这期间 daemon 的主线程停着，
  // 网页的心跳答不上，页面显示离线。
  it("keeps the event loop running while git removes the worktree", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId, "cancelled");
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(dir, "slow-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      `if [ "$3" = worktree ] && [ "$4" = remove ]; then sleep 1; fi`,
      `exec '${realGit}' "$@"`,
    ].join("\n"));
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 50);
    try {
      const result = await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r", userConfirmation: "不要了" });
      expect(result.workspace.state).toBe("archived");
    } finally {
      clearInterval(timer);
      process.env.PATH = path;
    }
    // git 睡了 1 秒：主线程没被占住时，50 毫秒一次的定时器这期间跑了十几次。同步跑 git 时一次都跑不了。
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it("gives the removal far more than git's default 10 s", () => {
    expect(WORKTREE_REMOVE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  for (const [label, files] of [["tracked files", ["source.txt"]], ["the .git file", [".git", "source.txt"]]] as const) {
    it(`finishes an abandon in the same call when git is killed after it deleted ${label}`, async () => {
      const itemId = codingTicket();
      const worktree = isolatedFor(itemId);
      commitIn(worktree.path, "feature.txt", "feature\n");
      finish(itemId, "cancelled");
      const restore = interruptNextRemoval([...files]);
      let result;
      try {
        result = await abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r", userConfirmation: "不要了" });
      } finally {
        restore();
      }
      expect(result.workspace).toMatchObject({ state: "archived", merge_status: "abandoned" });
      expect(existsSync(worktree.path)).toBe(false);
      expect(git(repo, "worktree", "list")).not.toContain(worktree.path);
      // 放弃保留分支：改动还能找回。
      expect(git(repo, "show", `${worktree.branch}:feature.txt`)).toBe("feature");
    });
  }

  it("cleans up on retry a failed abandoned row whose tree is half deleted", async () => {
    const worktree = await abandonedHalfWay();
    expect((await workspaceCleanupChecks(db, worktree.id)).contentMatchesSnapshot).toBe(true);

    const result = await performWorkspaceAction(db, { action: "cleanup", workspaceId: worktree.id });
    expect(result).toMatchObject({ status: "cleaned", workspace: { state: "archived", merge_status: "abandoned" } });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(worktree.path);
    expect(git(repo, "show", `${worktree.branch}:feature.txt`)).toBe("feature");
  });

  it("cleans up a failed abandoned row whose directory someone deleted by hand, and the sweep does not ask to merge it", async () => {
    const first = await abandonedHalfWay();
    git(repo, "worktree", "remove", "--force", first.path);
    expect((await workspaceCleanupChecks(db, first.id)).contentMatchesSnapshot).toBe(true);
    expect((await performWorkspaceAction(db, { action: "cleanup", workspaceId: first.id })).workspace.state).toBe("archived");

    const second = await abandonedHalfWay();
    rmSync(second.path, { recursive: true, force: true });
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, second.id)).toMatchObject({ state: "archived", merge_status: "abandoned" });
    expect(git(repo, "branch", "--list", second.branch!)).toContain(second.branch!);
    expect(inboxOf("workspace_merge_decision")).toHaveLength(0);
  });

  it("lets the sweep resume a half-deleted failed row", async () => {
    const worktree = await abandonedHalfWay();
    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "abandoned" });
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("finishes a merge in the same call when git is killed half way", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    const restore = interruptNextRemoval(["source.txt"]);
    let result;
    try {
      result = await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "merge it" });
    } finally {
      restore();
    }
    expect(result.workspace).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
  });

  it("still refuses a released worktree that gained a file nobody recorded", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    finish(itemId);
    db.prepare("UPDATE workspaces SET merge_status='merged' WHERE id=?").run(worktree.id);
    await releaseWorkspace(db, worktree.id, { mergeStatus: "merged" });
    rmSync(join(worktree.path, "source.txt"));
    writeFileSync(join(worktree.path, "late.txt"), "written after the snapshot\n");

    expect((await workspaceCleanupChecks(db, worktree.id)).contentMatchesSnapshot).toBe(false);
    await expect(cleanupWorkspace(db, worktree.id)).rejects.toThrow(/unrecorded changes/);
    expect(existsSync(join(worktree.path, "late.txt"))).toBe(true);
    // 扫描也不删它。
    expect(await sweepWorkspaces(db, later(30))).toMatchObject({ cleaned: 0 });
    expect(existsSync(join(worktree.path, "late.txt"))).toBe(true);
  });
});

// 2026-11-03: the startup sweep deleted the #190 and #191 worktrees (node_modules included) with a synchronous
// git worktree remove. The daemon thread was blocked for about 9 minutes: no plc.sock, no Lead, no gateway.
describe("deleting a worktree", () => {
  const trash = () => join(workspaceRootFor(repo), WORKTREE_TRASH_DIR);

  // node_modules is ignored, as in a real repository, so the worktree counts as clean.
  function addIgnoredDependencies(path: string): void {
    writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/\n");
    mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  }

  it("moves the worktree out of its place at once and deletes it in the background", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    addIgnoredDependencies(worktree.path);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);

    const result = await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "merge it" });

    expect(result.workspace).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(worktree.path);
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
    // The files went through the trash and were deleted in the background. The merge awaits more git after
    // the move (deleting the branch), so a small worktree may already be gone from the trash when it returns.
    expect(existsSync(trash())).toBe(true);
    await worktreeDeletionsSettled();
    expect(readdirSync(trash())).toHaveLength(0);
  });

  // 2026-11-09: the background delete ran fs.promises.rm inside the daemon. Every file's unlink went
  // through Node's I/O threadpool, and Lead's next model request, in the same process, waited 9–14 minutes
  // behind it. The delete now runs in a child process: the threadpool stays free while it runs.
  it("deletes the retired worktree in a child process, so the process's own file I/O does not wait for it", async () => {
    // vitest.setup.ts runs background deletes at utility priority: taskpolicy -b would make this one take about a minute.
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/\n");
    const files = 20_000;
    for (let pkg = 0; pkg < files / 500; pkg += 1) {
      const lib = join(worktree.path, "node_modules", `pkg${pkg}`, "lib");
      mkdirSync(lib, { recursive: true });
      for (let file = 0; file < 500; file += 1) writeFileSync(join(lib, `f${file}.js`), "module.exports = 1;\n");
    }
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);

    await integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "merge it" });
    const deleting = runningHostJobs().find((job) => job.kind === "worktree-delete");
    const started = performance.now();
    await stat(dir);
    const statMs = performance.now() - started;

    expect(statMs).toBeLessThan(1_000);
    expect(deleting?.pid).toEqual(expect.any(Number));
    await worktreeDeletionsSettled();
    expect(readdirSync(trash())).toHaveLength(0);
    expect(runningHostJobs()).toEqual([]);
  }, 120_000);

  it("deletes what a stopped daemon left in the trash, and never asks the user about the trash", async () => {
    isolatedFor(codingTicket());
    const left = join(trash(), "item-9-left-behind");
    mkdirSync(join(left, "node_modules"), { recursive: true });
    writeFileSync(join(left, "node_modules", "a.js"), "x\n");

    await sweepWorkspaces(db, later(30));

    expect(inboxOf("workspace_orphan_decision")).toHaveLength(0);
    await worktreeDeletionsSettled();
    expect(readdirSync(trash())).toHaveLength(0);
  });
});

// #191: old code recorded a branch that had fast-forwarded into the user's branch as conflict and left
// the row idle. The sweep waited for the idle TTL and never finished it.
describe("a worktree recorded as conflict whose branch is already in the user's branch", () => {
  it("is recorded as merged and removed by the next sweep", async () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    git(repo, "merge", "-q", "--ff-only", worktree.branch!);
    db.prepare("UPDATE workspaces SET merge_status='conflict', state='idle' WHERE id=?").run(worktree.id);
    finish(itemId);

    expect(await sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
  });
});
