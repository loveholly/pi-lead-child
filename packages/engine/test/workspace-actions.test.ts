// 工作区的释放和清理只经过操作层（ui-actions/ 的 workspace 目标，ui-action-parity plan.md P04）。以前这里测的是
// createWorkspaceActionService().execute：它带着自己的一套规则，路由和 Lead 改走操作层以后没有调用方了，已经删掉。
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { OwnerActionSource } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createTurn, createWorkspace, getWorkspace, openDb, type Binding, type Db,
} from "@pi-lead-child/store";
import { provisionWorkspace, releaseWorkspace } from "../src/coordinator/workspace.js";
import { runUiAction, UiActionError, type UiActionCaller } from "../src/ui-actions/index.js";

let db: Db;
let dir: string;
let page: Binding;
const SOURCE: OwnerActionSource = { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true };

beforeEach(() => {
  dir = tempDir("plc-workspace-actions-");
  db = openDb(join(dir, "plc.db"));
  page = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
});

const user = (): UiActionCaller => ({ kind: "user", credential: page, source: SOURCE });
const lead = (turnId: string | null = null): UiActionCaller => ({ kind: "lead", turnId });

function itemId(terminal = true): number {
  const id = createItem(db, { title: "workspace action", brief: "b", createdBy: "user", workdir: "/tmp/action-workspace" });
  if (terminal) db.prepare("UPDATE items SET stage='done' WHERE id=?").run(id);
  return id;
}

function shared(terminal = true): number {
  return createWorkspace(db, { ownerItemId: itemId(terminal), mode: "shared", kind: "primary", path: "/tmp/action-workspace", state: "active" }).id;
}

// 一个真的隔离 worktree，放弃改动以后已经释放：清理会删掉它的目录。
let repos = 0;
function releasedWorktree(): { workspaceId: number; path: string } {
  const repo = join(dir, `repo-${++repos}`);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "plc@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "PLC Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const owner = createItem(db, { title: "coding", brief: "b", createdBy: "user", workflowKind: "coding", workdir: repo });
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(owner);
  provisionWorkspace(db, { itemId: owner, mode: "shared" });
  const isolated = provisionWorkspace(db, { itemId: owner, mode: "isolated" });
  releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
  return { workspaceId: isolated.id, path: isolated.path };
}

const run = (workspaceId: number, action: "release" | "cleanup", caller: UiActionCaller, input?: Record<string, unknown>) =>
  runUiAction(db, { target: { type: "workspace", id: workspaceId }, action, caller, reason: "测试", ...(input ? { input } : {}) });

async function refusal(promise: Promise<unknown>): Promise<UiActionError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(UiActionError);
  return error as UiActionError;
}

describe("workspace actions through the operation layer", () => {
  it("refuses release while the owner item is not terminal", async () => {
    const workspaceId = shared(false);
    expect((await refusal(run(workspaceId, "release", user()))).message).toMatch(/还没结束/);
    expect(getWorkspace(db, workspaceId)!.state).toBe("active");
  });

  it("requires release before cleanup and makes a repeated cleanup a no-op", async () => {
    const workspaceId = shared();
    expect((await refusal(run(workspaceId, "cleanup", user()))).message).toMatch(/要先释放/);
    await run(workspaceId, "release", lead());
    expect((await run(workspaceId, "cleanup", user())).result).toMatchObject({ status: "cleaned", workspace: { state: "archived" } });
    expect((await run(workspaceId, "cleanup", lead())).result).toMatchObject({ status: "already_cleaned" });
  });

  it("leaves releasing an isolated worktree to merge or abandon", async () => {
    const owner = itemId();
    const workspace = createWorkspace(db, {
      ownerItemId: owner, mode: "isolated", kind: "isolated_child", path: "/tmp/isolated-action",
      repoRoot: "/tmp/repo", branch: "plc/test", baseRef: "abc", gitWorktree: true, state: "active",
    });
    expect((await refusal(run(workspace.id, "release", user()))).message).toMatch(/合并.*放弃改动/);
  });

  // 审查 2026-10-26 第 2 条：清理隔离 worktree 不可逆，以前一次 POST 就删掉了，没有确认。
  it("cleans an isolated worktree only with an explicit confirmation, from the page and from Lead", async () => {
    const clicked = releasedWorktree();
    const notConfirmed = await refusal(run(clicked.workspaceId, "cleanup", user()));
    expect(notConfirmed.code).toBe("needs_confirmation");
    expect(notConfirmed.message).toContain(clicked.path);
    expect(notConfirmed.message).toContain("confirm: true");
    expect([getWorkspace(db, clicked.workspaceId)!.state, existsSync(clicked.path)]).toEqual(["released", true]);
    expect((await run(clicked.workspaceId, "cleanup", user(), { confirm: true })).result).toMatchObject({ status: "cleaned" });
    expect(existsSync(clicked.path)).toBe(false);

    const relayed = releasedWorktree();
    createTurn(db, { id: "turn-user", originBindingId: page.id, originKind: "paired:companion", userText: "删掉它", state: "streaming" });
    // Lead 在哪一轮都能清理（2026-10-27），但没带 confirm 时什么都不做。
    expect((await refusal(run(relayed.workspaceId, "cleanup", lead()))).code).toBe("needs_confirmation");
    expect((await refusal(run(relayed.workspaceId, "cleanup", lead("turn-user")))).code).toBe("needs_confirmation");
    expect(existsSync(relayed.path)).toBe(true);
    const outcome = await run(relayed.workspaceId, "cleanup", lead("turn-user"), { confirm: true });
    expect(outcome).toMatchObject({ authority: "on_behalf", result: { status: "cleaned" } });
    expect(existsSync(relayed.path)).toBe(false);
  });

  it("does not ask to confirm cleaning a shared workspace", async () => {
    const workspaceId = shared();
    await run(workspaceId, "release", user());
    expect((await run(workspaceId, "cleanup", lead())).result).toMatchObject({ status: "cleaned" });
  });
});
