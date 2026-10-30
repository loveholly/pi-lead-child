// 隔离 worktree 和临时检出的清理（2026-10-19 用户决定）：
//   · 合并或放弃以后马上删；
//   · 定期扫描：结束了的工单的 worktree、过期的临时检出、<repo>.plc-workspaces 下没有登记的孤儿目录，按 TTL 清理；
//   · 有没合并改动的 worktree 不悄悄删，先问用户；
//   · 清理有记录，Lead 的当前局面里看得见（inbox）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  createItem, createWorkspace, getItem, getWorkspace, listActivities, listInbox, resolveWorkspace,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { AgentRuntime, RuntimeStartRequest } from "@pi-lead-child/runtime";
import {
  abandonIsolatedWorkspace, integrateIsolatedWorkspace, provisionWorkspace, sweepWorkspaces, workspaceRootFor,
} from "../src/coordinator/workspace.js";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
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
  return prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
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
  it("keeps a clean worktree until the TTL, then removes it and its branch and tells Lead", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    finish(itemId);

    expect(sweepWorkspaces(db, later(1))).toMatchObject({ cleaned: 0, awaitingDecision: 0 });
    expect(existsSync(worktree.path)).toBe(true);

    expect(sweepWorkspaces(db, later(8))).toMatchObject({ cleaned: 1, failed: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "abandoned" });
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
    // 工单的 workdir 改回用户的 checkout，不再指向删掉的目录。
    expect(getItem(db, itemId)?.workdir).toBe(repo);
    expect(inboxOf("workspace_cleaned")).toHaveLength(1);
    expect(JSON.parse(inboxOf("workspace_cleaned")[0]!.payload)).toMatchObject({ wakeLead: false, needsUser: false });
  });

  for (const change of ["commit", "dirty file"] as const) it(`never deletes a worktree with an unmerged ${change}; it asks the user once`, () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    if (change === "commit") commitIn(worktree.path, "feature.txt", "feature\n");
    else writeFileSync(join(worktree.path, "draft.txt"), "not committed\n");
    finish(itemId);

    expect(sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 0, awaitingDecision: 1, failed: [] });
    expect(sweepWorkspaces(db, later(30))).toMatchObject({ cleaned: 0, awaitingDecision: 1, failed: [] });
    expect(existsSync(worktree.path)).toBe(true);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "pending_integration", merge_status: "pending" });
    const asks = inboxOf("workspace_merge_decision");
    // 30 天后的那一次超过了 TTL，所以再问了一次；同一天的重复扫描不会再问。
    expect(asks).toHaveLength(2);
    expect(sweepWorkspaces(db, later(30))).toMatchObject({ awaitingDecision: 1 });
    expect(inboxOf("workspace_merge_decision")).toHaveLength(asks.length);
    expect(JSON.parse(asks[0]!.payload)).toMatchObject({ workspaceId: worktree.id, wakeLead: true, needsUser: true });
  });

  it("removes the worktree at once when the user merged the branch themselves", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    expect(sweepWorkspaces(db, later(0))).toMatchObject({ awaitingDecision: 1 });

    git(repo, "merge", "-q", "--no-edit", worktree.branch!);
    expect(sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0 });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(git(repo, "branch", "--list", worktree.branch!)).toBe("");
  });

  it("lets a ticket chat use a worktree that waits for a merge decision", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    sweepWorkspaces(db, later(0));
    expect(getWorkspace(db, worktree.id)?.state).toBe("pending_integration");

    const chat = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "conversation" }).workspace!;
    expect(chat).toMatchObject({ id: worktree.id, state: "idle" });
  });

  it("tidies up a worktree whose directory someone deleted, unless its branch has unmerged commits", () => {
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

    expect(sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 1, failed: [] });
    expect(getWorkspace(db, emptyWorktree.id)?.state).toBe("archived");
    expect(git(repo, "branch", "--list", emptyWorktree.branch!)).toBe("");
    expect(git(repo, "branch", "--list", committed.branch!)).toContain(committed.branch!);
    expect(inboxOf("workspace_merge_decision")).toHaveLength(1);

    // 用户决定合并：目录不在了，分支照样合并进用户的 checkout。
    integrateIsolatedWorkspace(db, committed.id, { actor: "lead", reason: "user said merge" });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(getWorkspace(db, committed.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(git(repo, "branch", "--list", committed.branch!)).toBe("");
  });

  it("removes a PR checkout that a crashed daemon left behind", () => {
    const itemId = codingTicket();
    const path = join(workspaceRootFor(realpathSync(repo)), "pr-7-item-1-dead");
    git(repo, "update-ref", "refs/plc/review/item-1-dead", "HEAD");
    git(repo, "worktree", "add", "-q", "--detach", path, "HEAD");
    const checkout = createWorkspace(db, {
      ownerItemId: itemId, mode: "isolated", kind: "experiment", repoRoot: realpathSync(repo), path,
      branch: "refs/plc/review/item-1-dead", baseRef: git(repo, "rev-parse", "HEAD"), gitWorktree: true, state: "active",
    });

    expect(sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, failed: [] });
    expect(existsSync(path)).toBe(false);
    expect(getWorkspace(db, checkout.id)?.state).toBe("archived");
    expect(git(repo, "for-each-ref", "refs/plc")).toBe("");
  });
});

// 审查 2026-10-19 第 2 条：合并冲突把 worktree 改成 blocked，以前扫描不看 blocked，再也没有提醒。
describe("a worktree whose merge conflicted", () => {
  function conflicted() {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    writeFileSync(join(worktree.path, "source.txt"), "child\n");
    git(worktree.path, "commit", "-qam", "child");
    writeFileSync(join(repo, "source.txt"), "user\n");
    git(repo, "commit", "-qam", "user");
    finish(itemId);
    sweepWorkspaces(db, later(0));
    expect(() => integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "user ok" })).toThrow(/conflict/);
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "blocked", merge_status: "conflict" });
    return { itemId, worktree };
  }

  it("is asked about again after the TTL, as a conflict, and is never deleted", () => {
    const { worktree } = conflicted();
    const before = inboxOf("workspace_merge_decision").length;
    expect(sweepWorkspaces(db, later(30))).toMatchObject({ awaitingDecision: 1, cleaned: 0, failed: [] });
    const asks = inboxOf("workspace_merge_decision");
    expect(asks).toHaveLength(before + 1);
    expect(JSON.parse(asks.at(-1)!.payload)).toMatchObject({ workspaceId: worktree.id, conflict: true, needsUser: true });
    expect(asks.at(-1)!.summary).toContain("合并时冲突");
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("is cleaned up once the user merged the branch and resolved the conflict", () => {
    const { worktree } = conflicted();
    try { git(repo, "merge", "-q", "--no-edit", worktree.branch!); } catch { /* 冲突 */ }
    writeFileSync(join(repo, "source.txt"), "resolved\n");
    git(repo, "commit", "-qam", "resolve");
    expect(sweepWorkspaces(db, later(0))).toMatchObject({ cleaned: 1, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, worktree.id)).toMatchObject({ state: "archived", merge_status: "merged" });
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("can be abandoned with the user's words", () => {
    const { worktree } = conflicted();
    const result = abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "conflict", userConfirmation: "放弃吧" });
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
    const next = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
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
    const next = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    expect(next.id).not.toBe(worktree.id);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("is kept when it holds work", () => {
    const { itemId, worktree } = failedWorktree((path) => commitIn(path, "work.txt", "work\n"));
    const next = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    expect(next.id).toBe(worktree.id);
    expect(readFileSync(join(worktree.path, "work.txt"), "utf8")).toBe("work\n");
  });
});

describe("merge and abandon decisions", () => {
  it("merges the branch into the user's checkout and removes the worktree", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);

    const result = integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "user said merge it" });
    expect(result).toMatchObject({ branchDeleted: true, workspace: { state: "archived", merge_status: "merged" } });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    expect(existsSync(worktree.path)).toBe(false);
    expect(decisionsOf(itemId, "workspace_integrated")).toEqual([
      expect.objectContaining({ workspaceId: worktree.id, target: "main", reason: "user said merge it" }),
    ]);
  });

  it("does not merge into a checkout with the user's uncommitted changes, or from a dirty worktree", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    finish(itemId);
    writeFileSync(join(repo, "source.txt"), "the user's edit\n");
    expect(() => integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r" })).toThrow(/uncommitted changes/);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("the user's edit\n");
    git(repo, "checkout", "--", "source.txt");
    writeFileSync(join(worktree.path, "draft.txt"), "x\n");
    expect(() => integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "r" })).toThrow(/worktree #\d+ has uncommitted/);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("does not abandon unmerged work without the user's words, and keeps it on the branch when it does", () => {
    const itemId = codingTicket();
    const worktree = isolatedFor(itemId);
    commitIn(worktree.path, "feature.txt", "feature\n");
    writeFileSync(join(worktree.path, "draft.txt"), "draft\n");
    finish(itemId, "cancelled");

    expect(() => abandonIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "ticket cancelled" }))
      .toThrow(/user's consent/);
    expect(existsSync(worktree.path)).toBe(true);

    const result = abandonIsolatedWorkspace(db, worktree.id, {
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
  it("does not follow a symbolic link to a worktree outside the container", () => {
    const itemId = codingTicket();
    isolatedFor(itemId);
    const outside = join(dir, "users-own-worktree");
    git(repo, "worktree", "add", "-q", "--detach", outside, "HEAD");
    const link = join(workspaceRootFor(realpathSync(repo)), "link-to-outside");
    symlinkSync(outside, link);
    age(outside, 10);
    expect(sweepWorkspaces(db, new Date())).toMatchObject({ cleaned: 0, failed: [] });
    expect(existsSync(join(outside, "source.txt"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(realpathSync(outside));
  });

  it("removes old clean worktrees and empty directories, asks about the rest, and leaves fresh ones", () => {
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

    const result = sweepWorkspaces(db, new Date());
    expect(result).toMatchObject({ cleaned: 2, awaitingDecision: 2, failed: [] });
    expect(existsSync(clean)).toBe(false);
    expect(git(repo, "branch", "--list", "plc/orphan-clean")).toBe("");
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(unmerged)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(inboxOf("workspace_orphan_decision")).toHaveLength(2);
    // 下一次扫描不再重复问。
    sweepWorkspaces(db, new Date());
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
    expect(sweepWorkspaces(db, later(0))).toMatchObject({ awaitingDecision: 1 });
    db.close();
    db = openDb(join(dir, "plc.db"));
    expect(getWorkspace(db, worktree.id)?.state).toBe("pending_integration");

    integrateIsolatedWorkspace(db, worktree.id, { actor: "lead", reason: "accepted" });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("from the child\n");
    expect(existsSync(worktree.path)).toBe(false);
    expect(getItem(db, itemId)?.stage).toBe("done");
    expect(sweepWorkspaces(db, later(30))).toMatchObject({ cleaned: 0, awaitingDecision: 0, failed: [] });
  });
});
