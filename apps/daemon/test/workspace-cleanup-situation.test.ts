// 清理要有记录，并在 Lead 的当前局面里看得见（2026-10-19 用户决定）。这里从 Lead 看到的那一层断言：
// 清扫删掉的 worktree 进「上一轮以后的变化」，等合并决定的 worktree 一直列在「等用户决定的事」里，直到合并或放弃。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createItem, openDb } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { abandonIsolatedWorkspace, prepareRunWorkspace, sweepWorkspaces } from "@pi-lead-child/engine";
import { createLeadInput } from "../src/lead-input.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
}

describe("workspace cleanup in Lead's situation", () => {
  it("lists removed worktrees as changes and keeps a pending merge decision in view until it is made", () => {
    const dir = tempDir("plc-cleanup-situation-");
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "source.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const db = openDb(join(dir, "plc.db"));
    const input = createLeadInput({ db });

    const clean = createItem(db, { title: "nothing changed", brief: "b", createdBy: "lead", workdir: repo });
    const cleanWorktree = prepareRunWorkspace(db, clean, { role: "executor", purpose: "execution" }).workspace!;
    const changed = createItem(db, { title: "has a commit", brief: "b", createdBy: "lead", workdir: repo });
    const changedWorktree = prepareRunWorkspace(db, changed, { role: "executor", purpose: "execution" }).workspace!;
    writeFileSync(join(changedWorktree.path, "feature.txt"), "feature\n");
    git(changedWorktree.path, "add", "feature.txt");
    git(changedWorktree.path, "commit", "-qm", "feature");
    db.prepare("UPDATE items SET stage='done' WHERE id IN (?, ?)").run(clean, changed);

    sweepWorkspaces(db, new Date(Date.now() + 8 * 24 * 60 * 60_000));
    input.beginRun("digest");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain(`隔离 worktree #${cleanWorktree.id} 已清理`);
    expect(situation).toContain(`工单 #${changed} 的隔离 worktree #${changedWorktree.id}（分支 ${changedWorktree.branch}）有没合并的改动，等合并决定`);
    // 要用户决定的那一条叫醒 Lead：它作为一条消息交给 Lead，不只是摘要。
    expect(input.pendingMessages().some((event) => event.kind === "inbox.attention"
      && (event.payload.payload as Record<string, unknown>)?.inboxKind === "workspace_merge_decision")).toBe(true);

    abandonIsolatedWorkspace(db, changedWorktree.id, { actor: "lead", reason: "r", userConfirmation: "删吧" });
    expect(input.renderSituation({ queuedUserMessages: 0 })).not.toContain("等合并决定");
    db.close();
  });
});
