import { describe, expect, it, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem } from "../src/items.js";
import { createRun, getRun } from "../src/runs.js";
import {
  attachWorkspaceToRun, createWorkspace, getOwnerWorkspace, getWorkspace, listWorkspaces,
  resolveWorkspace, transitionWorkspace,
} from "../src/workspaces.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-workspace-"), "plc.db"));
});

function task(options: { parentItemId?: number; rootItemId?: number; workflowKind?: "generic" | "coding" } = {}): number {
  return createItem(db, {
    title: "task", brief: "workspace test", createdBy: options.parentItemId ? "child" : "user",
    workdir: "/tmp/plc-workspace-project", workflowKind: options.workflowKind ?? "coding",
    ...options,
  });
}

describe("workspace schema and store", () => {
  it("creates the workspace table and nullable run binding", () => {
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
    ).get()).toEqual({ name: "workspaces" });
    const columns = (db.pragma("table_info(runs)") as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain("workspace_id");
    const item = getItem(db, task())!;
    expect(item.workflow_kind).toBe("coding");
  });

  it("rejects invalid workspace facts and accepts a non-git shared directory", () => {
    const itemId = task();
    expect(() => createWorkspace(db, {
      ownerItemId: itemId, mode: "isolated", kind: "primary", path: "relative/path",
    })).toThrow(/must be absolute/);
    expect(() => createWorkspace(db, {
      ownerItemId: itemId, mode: "isolated", kind: "primary", path: "/tmp/isolated", gitWorktree: true,
    })).toThrow(/requires repoRoot/);
    const workspace = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/shared",
    });
    expect(workspace).toMatchObject({
      owner_item_id: itemId, mode: "shared", kind: "primary", path: "/tmp/shared",
      git_worktree: 0, repo_root: null, state: "requested", merge_status: "n/a",
    });
  });

  it("is idempotent for the same owner/spec and rejects incompatible ownership", () => {
    const itemId = task();
    const first = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/shared",
    });
    const second = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/shared",
    });
    expect(second.id).toBe(first.id);
    expect(() => createWorkspace(db, {
      ownerItemId: itemId, mode: "isolated", kind: "primary", path: "/tmp/other",
    })).toThrow(/incompatible/);
    expect(() => createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/shared", sourceItemId: itemId + 1,
    })).toThrow(/incompatible/);
    expect(listWorkspaces(db, { ownerItemId: itemId })).toHaveLength(1);
  });

  it("resolves the nearest owner and inherits through a nested task tree", () => {
    const root = task();
    const child = task({ parentItemId: root, rootItemId: root });
    const grandchild = task({ parentItemId: child, rootItemId: root });
    const rootWorkspace = createWorkspace(db, {
      ownerItemId: root, mode: "shared", kind: "primary", path: "/tmp/root",
    });
    expect(resolveWorkspace(db, root)).toMatchObject({ ownerItemId: root, inherited: false });
    expect(resolveWorkspace(db, child)).toMatchObject({ workspace: { id: rootWorkspace.id }, ownerItemId: root, inherited: true });
    const childWorkspace = createWorkspace(db, {
      ownerItemId: child, mode: "isolated", kind: "isolated_child", path: "/tmp/child",
    });
    expect(resolveWorkspace(db, grandchild)).toMatchObject({
      workspace: { id: childWorkspace.id, mode: "isolated" }, ownerItemId: child, inherited: true,
    });
  });

  it("returns null for an item without an owner workspace and does not use workdir as authority", () => {
    const itemId = task();
    expect(resolveWorkspace(db, itemId)).toBeNull();
    createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/authoritative" });
    db.prepare("UPDATE items SET workdir=? WHERE id=?").run("/tmp/stale-cache", itemId);
    expect(resolveWorkspace(db, itemId)?.workspace.path).toBe("/tmp/authoritative");
  });

  it("attaches a run once and rejects reassignment or an unrelated workspace", () => {
    const itemId = task();
    const otherItemId = task();
    const runId = createRun(db, { itemId, runtime: "pi" });
    const first = createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/run" });
    const other = createWorkspace(db, { ownerItemId: otherItemId, mode: "shared", kind: "primary", path: "/tmp/other" });
    const second = createWorkspace(db, { ownerItemId: itemId, mode: "isolated", kind: "reviewer", path: "/tmp/reviewer" });
    expect(() => attachWorkspaceToRun(db, { runId, workspaceId: other.id })).toThrow(/resolved workspace/);
    expect(attachWorkspaceToRun(db, { runId, workspaceId: first.id }).id).toBe(first.id);
    expect(attachWorkspaceToRun(db, { runId, workspaceId: first.id }).id).toBe(first.id);
    expect(() => attachWorkspaceToRun(db, { runId, workspaceId: second.id })).toThrow(/already attached/);
    expect(getRun(db, runId)?.workspace_id).toBe(first.id);
  });

  it("enforces workspace state transitions", () => {
    const itemId = task();
    const workspace = createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/state" });
    expect(() => transitionWorkspace(db, workspace.id, "cleaned")).toThrow(/illegal workspace transition/);
    const active = transitionWorkspace(db, workspace.id, "provisioning");
    expect(active.state).toBe("provisioning");
    expect(transitionWorkspace(db, workspace.id, "active").state).toBe("active");
    expect(transitionWorkspace(db, workspace.id, "idle").state).toBe("idle");
    expect(transitionWorkspace(db, workspace.id, "released").released_at).not.toBeNull();
  });
});

describe("workspace migration", () => {
  it("does not recreate an active workspace after the historical workspace was archived", () => {
    const dir = tempDir("plc-workspace-archive-reopen-");
    const path = join(dir, "plc.db");
    const first = openDb(path);
    const itemId = createItem(first, { title: "archived", brief: "b", createdBy: "user", workdir: "/tmp/archived-workspace" });
    createWorkspace(first, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/archived-workspace", state: "archived",
    });
    first.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT id, state FROM workspaces WHERE owner_item_id=? ORDER BY id").all(itemId))
      .toEqual([{ id: 1, state: "archived" }]);
    reopened.close();
  });

  it("repairs a previously recorded v23 migration when legacy backfill is missing", () => {
    const dir = tempDir("plc-workspace-repair-");
    const path = join(dir, "plc.db");
    const first = openDb(path);
    const itemId = createItem(first, { title: "legacy", brief: "b", createdBy: "user", workdir: "/tmp/repair-workspace" });
    first.pragma("foreign_keys = OFF");
    first.exec("DELETE FROM workspaces");
    // Keep schema_migrations v23: this reproduces a daemon that recorded the version before
    // the backfill body was present. Reopen must repair the missing derived workspace row.
    expect(first.prepare("SELECT 1 FROM schema_migrations WHERE version=23").get()).toBeTruthy();
    first.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT owner_item_id, path, mode, kind FROM workspaces WHERE owner_item_id=?").get(itemId))
      .toEqual({ owner_item_id: itemId, path: "/tmp/repair-workspace", mode: "shared", kind: "primary" });
    reopened.close();
  });

  it("backfills explicit legacy workdirs once and preserves item/run facts on reopen", () => {
    const dir = tempDir("plc-workspace-migration-");
    const path = join(dir, "plc.db");
    const first = openDb(path);
    const withWorkdir = createItem(first, { title: "legacy", brief: "b", createdBy: "user", workdir: "/tmp/legacy" });
    const withoutWorkdir = createItem(first, { title: "no workspace", brief: "b", createdBy: "user" });
    const runId = createRun(first, { itemId: withWorkdir });
    first.prepare("UPDATE items SET stage='blocked', plan_state='failed', retry_limit=7, closed_at=? WHERE id=?")
      .run("2026-09-04T00:00:00.000Z", withWorkdir);
    first.prepare("INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'user', 'comment', '{}')")
      .run(withWorkdir);
    const before = first.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(withWorkdir);
    const beforeActivity = first.prepare("SELECT COUNT(*) AS n FROM activities WHERE item_id=?").get(withWorkdir);
    first.pragma("foreign_keys = OFF");
    first.exec("DROP TABLE workspaces");
    first.prepare("DELETE FROM schema_migrations WHERE version=23").run();
    first.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT owner_item_id, path, mode, kind, git_worktree FROM workspaces ORDER BY id").all())
      .toEqual([{ owner_item_id: withWorkdir, path: "/tmp/legacy", mode: "shared", kind: "primary", git_worktree: 0 }]);
    expect(reopened.prepare("SELECT workspace_id FROM runs WHERE id=?").get(runId)).toEqual({ workspace_id: null });
    expect(reopened.prepare("SELECT stage, plan_state, retry_limit, closed_at FROM items WHERE id=?").get(withWorkdir))
      .toEqual(before);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM activities WHERE item_id=?").get(withWorkdir))
      .toEqual(beforeActivity);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE owner_item_id=?").get(withoutWorkdir))
      .toEqual({ n: 0 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=23").get())
      .toEqual({ n: 1 });
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    const count = (reopened.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;
    reopened.close();
    const twice = openDb(path);
    expect((twice.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n).toBe(count);
    twice.close();
  });
});
