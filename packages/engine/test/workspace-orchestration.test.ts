import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  cleanupWorkspace, integrateWorkspace, provisionWorkspace, reconcileWorkspaces, releaseWorkspace,
  sweepWorkspaces, workspaceCleanupChecks,
} from "../src/coordinator/workspace.js";
import { workspaceContentHash } from "../src/coordinator/workspace-integrity.js";
import { getWorkspace, listWorkspaces } from "@pi-lead-child/store";
import { listArtifacts, openArtifactContent } from "@pi-lead-child/store";

let db: Db;
let dir: string;
let repoDir: string;

beforeEach(() => {
  dir = tempDir("plc-worktree-");
  db = openDb(join(dir, "plc.db"));
  repoDir = join(dir, "repo");
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "plc@example.test"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "PLC Test"]);
  writeFileSync(join(repoDir, "README.md"), "base\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"]);
  execFileSync("git", ["-C", repoDir, "commit", "-qm", "base"]);
});

function item(): number {
  const itemId = createItem(db, {
    title: "coding", brief: "worktree", createdBy: "user", workflowKind: "coding", workdir: repoDir,
  });
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
  return itemId;
}

describe("coordinator workspace provisioning", () => {
  it("creates an isolated git worktree from a recorded shared workspace", () => {
    const itemId = item();
    const primary = provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    expect(primary).toMatchObject({ mode: "shared", kind: "primary", path: repoDir, state: "active" });
    expect(isolated).toMatchObject({ mode: "isolated", kind: "isolated_child", state: "active", git_worktree: 1 });
    expect(isolated.repo_root).toBe(realpathSync(repoDir));
    expect(isolated.base_ref).toMatch(/^[0-9a-f]{40}$/);
    expect(isolated.branch).toMatch(/^plc\/item-/);
    expect(existsSync(join(isolated.path, "README.md"))).toBe(true);
    expect(readFileSync(join(isolated.path, "README.md"), "utf8")).toBe("base\n");
    const again = provisionWorkspace(db, { itemId, mode: "isolated" });
    expect(again.id).toBe(isolated.id);
    expect(listWorkspaces(db, { ownerItemId: itemId })).toHaveLength(2);
  });

  it("requires an explicit merge decision before releasing isolated work", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    const held = releaseWorkspace(db, isolated.id);
    expect(held.state).toBe("pending_integration");
    expect(held.merge_status).toBe("pending");
    const released = releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
    expect(released.state).toBe("released");
    expect(released.merge_status).toBe("abandoned");
  });

  it("does not delete a shared user directory during cleanup", () => {
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    releaseWorkspace(db, shared.id);
    const archived = cleanupWorkspace(db, shared.id);
    expect(archived.state).toBe("archived");
    expect(existsSync(repoDir)).toBe(true);
  });

  it("refuses cleanup of a dirty isolated worktree and records failed cleanup", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
    writeFileSync(join(isolated.path, "dirty.txt"), "do not delete\n");
    expect(() => cleanupWorkspace(db, isolated.id)).toThrow(/unrecorded changes/);
    expect(getWorkspace(db, isolated.id)?.state).toBe("failed");
    expect(existsSync(isolated.path)).toBe(true);
  });

  it("reconciles missing active workspaces without silently recreating them", () => {
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    rmSync(shared.path, { recursive: true, force: true });
    expect(reconcileWorkspaces(db)).toEqual({ checked: 1, recovered: 0, failed: 1 });
    expect(getWorkspace(db, shared.id)?.state).toBe("failed");
  });

  it("records an isolated merge conflict and blocks integration", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    writeFileSync(join(isolated.path, "README.md"), "child change\n");
    execFileSync("git", ["-C", isolated.path, "add", "README.md"]);
    execFileSync("git", ["-C", isolated.path, "commit", "-qm", "child change"]);
    writeFileSync(join(repoDir, "README.md"), "parent change\n");
    execFileSync("git", ["-C", repoDir, "add", "README.md"]);
    execFileSync("git", ["-C", repoDir, "commit", "-qm", "parent change"]);
    releaseWorkspace(db, isolated.id);

    expect(() => integrateWorkspace(db, isolated.id)).toThrow(/integration conflict/);
    expect(getWorkspace(db, isolated.id)).toMatchObject({ state: "blocked", merge_status: "conflict" });
    expect(execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("rejects a different target branch without merging into the current checkout", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    releaseWorkspace(db, isolated.id);
    expect(() => integrateWorkspace(db, isolated.id, "not-the-current-branch")).toThrow(/not the current branch/);
    expect(getWorkspace(db, isolated.id)).toMatchObject({ state: "pending_integration", merge_status: "pending" });
  });

  it("persists a checkpoint-backed snapshot and preserves isolated commits across cleanup and reopen", async () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    writeFileSync(join(isolated.path, "result.txt"), "retain this output\n");
    execFileSync("git", ["-C", isolated.path, "add", "result.txt"]);
    execFileSync("git", ["-C", isolated.path, "commit", "-qm", "result"]);
    const head = execFileSync("git", ["-C", isolated.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
    const artifacts = listArtifacts(db, itemId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "workspace_snapshot", availability: "available" });
    expect(workspaceCleanupChecks(db, isolated.id)).toMatchObject({ snapshotPersisted: true, commitsCovered: true });
    cleanupWorkspace(db, isolated.id);
    db.close();
    db = openDb(join(dir, "plc.db"));
    const content = openArtifactContent(db, dir, itemId, artifacts[0]!.id);
    const chunks: Buffer[] = [];
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
    const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(snapshot).toMatchObject({ version: 1, workspaceId: isolated.id, head });
    const bundlePath = join(dir, "recovered.bundle");
    writeFileSync(bundlePath, Buffer.from(snapshot.bundle, "base64"));
    const restored = join(dir, "restored");
    execFileSync("git", ["clone", "-q", bundlePath, restored]);
    expect(readFileSync(join(restored, "result.txt"), "utf8")).toBe("retain this output\n");
    expect(db.prepare("SELECT stage FROM items WHERE id=?").get(itemId)).toEqual({ stage: "done" });
  });

  it("refuses cleanup when the snapshot artifact has disappeared", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
    const blob = db.prepare("SELECT storage_key FROM artifacts WHERE item_id=?").get(itemId) as { storage_key: string } | undefined;
    expect(blob).toBeDefined();
    rmSync(join(dir, blob!.storage_key));
    expect(workspaceCleanupChecks(db, isolated.id).snapshotPersisted).toBe(false);
    expect(() => cleanupWorkspace(db, isolated.id)).toThrow(/preconditions/);
    expect(existsSync(isolated.path)).toBe(true);
  });

  it("requires merge evidence and snapshots a successful integration before release", () => {
    const itemId = item();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    writeFileSync(join(isolated.path, "result.txt"), "integrated\n");
    execFileSync("git", ["-C", isolated.path, "add", "result.txt"]);
    execFileSync("git", ["-C", isolated.path, "commit", "-qm", "result"]);
    expect(() => releaseWorkspace(db, isolated.id, { mergeStatus: "merged" })).toThrow(/not merged/);
    releaseWorkspace(db, isolated.id);
    expect(integrateWorkspace(db, isolated.id)).toMatchObject({ state: "released", merge_status: "merged" });
    expect(listArtifacts(db, itemId)).toHaveLength(1);
    expect(workspaceCleanupChecks(db, isolated.id)).toMatchObject({ snapshotPersisted: true, commitsCovered: true });
    expect(cleanupWorkspace(db, isolated.id).state).toBe("archived");
    expect(readFileSync(join(repoDir, "result.txt"), "utf8")).toBe("integrated\n");
  });
});

// 共享工作区就是用户自己的目录，常常是带 node_modules 的主 checkout。以前释放和清理都同步遍历、
// 读完整棵树，跑在 daemon 的主线程上：用户的主 checkout 能让 daemon 停摆，/v1/health 不应答。
// 读不了的目录让这一点在测试里看得见：只要释放或清理去读这棵树，就会以 EACCES 失败。
describe("workspace TTL sweep", () => {
  const afterRetention = () => new Date(Date.now() + 15 * 24 * 60 * 60_000);

  function lockedDirectory(root: string): string {
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "large.bin"), "content the sweep must not read\n");
    chmodSync(locked, 0o000);
    return locked;
  }

  it("releases a stale shared checkout without reading its files", () => {
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    const locked = lockedDirectory(repoDir);
    try {
      expect(sweepWorkspaces(db, afterRetention())).toEqual({ checked: 1, released: 1, cleaned: 0, awaitingDecision: 0, failed: [] });
      expect(getWorkspace(db, shared.id)?.state).toBe("released");
      expect(workspaceCleanupChecks(db, shared.id)).toMatchObject({ snapshotPersisted: true, contentMatchesSnapshot: true });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("hashes only git worktrees that plc created", () => {
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
    expect(() => workspaceContentHash(shared)).toThrow(/not a plc git worktree/);
    expect(workspaceContentHash(isolated)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("releases a stale shared workspace whose directory is gone", () => {
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    rmSync(repoDir, { recursive: true, force: true });
    expect(sweepWorkspaces(db, afterRetention())).toEqual({ checked: 1, released: 1, cleaned: 0, awaitingDecision: 0, failed: [] });
    expect(getWorkspace(db, shared.id)?.state).toBe("released");
  });

  it("keeps sweeping when one workspace cannot be released, and reports it", () => {
    // 路径是一个普通文件：释放这个工作区一定失败。
    const notADirectory = join(dir, "not-a-directory");
    writeFileSync(notADirectory, "x\n");
    const brokenItem = createItem(db, {
      title: "broken", brief: "path is a file", createdBy: "user", workflowKind: "coding", workdir: notADirectory,
    });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(brokenItem);
    const broken = provisionWorkspace(db, { itemId: brokenItem, mode: "shared" });
    const healthy = provisionWorkspace(db, { itemId: item(), mode: "shared" });

    const result = sweepWorkspaces(db, afterRetention());

    expect(result).toMatchObject({ checked: 2, released: 1 });
    expect(result.failed).toEqual([{ workspaceId: broken.id, error: expect.stringMatching(/ENOTDIR/) }]);
    expect(getWorkspace(db, broken.id)?.state).toBe("active");
    expect(getWorkspace(db, healthy.id)?.state).toBe("released");
  });

  it("cleans up a released shared checkout without comparing its content", () => {
    // cleanup 不删除共享目录里的任何文件，所以内容比较保护不了什么。用户在主 checkout 里继续工作，
    // 内容就会变；以前这会让 cleanup 失败，并且每次都同步读整棵树。
    const itemId = item();
    const shared = provisionWorkspace(db, { itemId, mode: "shared" });
    releaseWorkspace(db, shared.id);
    writeFileSync(join(repoDir, "user-edit.txt"), "the user keeps working here\n");
    const locked = lockedDirectory(repoDir);
    try {
      expect(cleanupWorkspace(db, shared.id).state).toBe("archived");
      expect(readFileSync(join(repoDir, "user-edit.txt"), "utf8")).toBe("the user keeps working here\n");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
