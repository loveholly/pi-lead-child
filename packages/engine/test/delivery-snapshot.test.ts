// 交付快照（工单 04，spec 5.5、D8）：交付的那一刻由系统跑 git diff 存进工单。用真的 git 仓库和真的 ticket_update 工具测：
// 返工后的第 2 次交付、交付以后对话改了工作区、不是隔离分支的工单、补存，以及 lock 文件和生成的文件的路径规则。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createItem, createRun, getItem, insertOutcomeSnapshot, listActivities, listDeliverySnapshotHeaders, normalizeOutcomePayload, openDb,
  transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { ticketDeliveries, ticketDelivery, ticketDeliveryFile, ticketDeliverySnapshot } from "../src/coordinator/delivery.js";
import {
  deliveryGeneratedKind, deliverySnapshotsSettled, HANDOFF_PIN_BUDGET_MS, orderDeliveryFiles, refreshDeliveryAfterRun,
  setDeliveryDiffForTesting,
} from "../src/coordinator/delivery-snapshot.js";
import { diffEntries, GitCommandError } from "../src/coordinator/delivery-source.js";
import { HOST_AGENT_TOOL_TIMEOUT_MS } from "../src/agent-tools/tool-timeouts.js";

let db: Db;
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commitIn(worktree: string, message: string): string {
  git(worktree, "add", "-A");
  git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", message);
  return git(worktree, "rev-parse", "HEAD");
}

beforeEach(() => {
  dir = tempDir("plc-delivery-snapshot-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
});
afterEach(async () => {
  setDeliveryDiffForTesting();
  await deliverySnapshotsSettled();
  db.close();
});

interface Outcome {
  summary: string;
  changes?: Array<{ kind: string; ref: string; summary: string | null }>;
  deliverables?: Array<{ kind: string; ref: string; label: string }>;
}

// 执行 agent 交付：调 ticket_update(status='review')，和 runtime 经工具桥调的是同一个处理函数。
async function deliver(itemId: number, runId: number, outcome: Outcome): Promise<void> {
  await createAgentToolHandlers({ db, itemId, runId }).call("ticket_update", {
    status: "review", reason: "实现完成",
    checkpoint: {
      kind: "completed", stage: "implementation", title: "实现完成", summary: outcome.summary,
      key_facts: [], artifact_refs: [], related_ticket_ids: [], next_step: "等核查",
      outcome: { changes: [], deliverables: [], validations: [], ...outcome },
    },
  });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
}

function codingTicket(): { itemId: number; worktree: string; workspaceId: number } {
  const itemId = createItem(db, { title: "写方案", brief: "b", createdBy: "lead", workdir: repo });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  return { itemId, worktree: workspace.path, workspaceId: workspace.id };
}

function executorRun(itemId: number, workspaceId: number): number {
  const runId = createRun(db, { itemId, runtime: "claude", workspaceId });
  updateRun(db, runId, { state: "running" });
  return runId;
}

describe("a delivery snapshot taken when the agent delivers", () => {
  it("stores the diff, the commits and the agent's notes, with noted files first and lock files last", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    mkdirSync(join(worktree, "docs"));
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    writeFileSync(join(worktree, "a.txt"), "a\n");
    writeFileSync(join(worktree, "docs", "plan.md"), "# 方案\n\n第一行\n");
    const head = commitIn(worktree, "docs: plan");
    const runId = executorRun(itemId, workspaceId);
    await deliver(itemId, runId, {
      summary: "写了方案。",
      changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增方案文档" }],
    });

    const [summary] = await ticketDeliveries(db, itemId);
    expect(summary).toMatchObject({
      sequence: 1, attemptId: runId, revisions: 1, reason: "delivered", source: "git", backfilled: false, head,
      commitCount: 1, totals: { files: 3, additions: 5, deletions: 0 },
    });
    const snapshot = await ticketDeliverySnapshot(db, itemId, 1);
    expect(snapshot.commits).toEqual([{ sha: head, subject: "docs: plan" }]);
    expect(snapshot.uncommittedFiles).toBe(0);
    expect(snapshot.files.map((file) => [file.path, file.status, file.note, file.generated])).toEqual([
      ["docs/plan.md", "added", "新增方案文档", null],
      ["a.txt", "added", null, null],
      ["package-lock.json", "added", null, "lock"],
    ]);
    // 交付视图用同一份快照，顺序一样。
    expect((await ticketDelivery(db, itemId)).files.map((file) => file.path)).toEqual(["docs/plan.md", "a.txt", "package-lock.json"]);
  });

  it("keeps both deliveries after rework, and the delivery view shows the latest", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "first.md"), "first\n");
    const firstHead = commitIn(worktree, "first");
    const first = executorRun(itemId, workspaceId);
    await deliver(itemId, first, { summary: "第一版。", changes: [{ kind: "file", ref: "first.md", summary: "第一版" }] });

    // 打回返工：第二个执行 Run 在同一个分支上接着做，再交付一次。
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    writeFileSync(join(worktree, "second.md"), "second\n");
    const secondHead = commitIn(worktree, "second");
    const second = executorRun(itemId, workspaceId);
    await deliver(itemId, second, { summary: "第二版。", changes: [{ kind: "file", ref: "second.md", summary: "第二版" }] });

    expect((await ticketDeliveries(db, itemId)).map((delivery) => [delivery.sequence, delivery.attemptId, delivery.head])).toEqual([
      [1, first, firstHead],
      [2, second, secondHead],
    ]);
    const one = await ticketDeliverySnapshot(db, itemId, 1);
    expect(one.files.map((file) => [file.path, file.note])).toEqual([["first.md", "第一版"]]);
    const two = await ticketDeliverySnapshot(db, itemId, 2);
    expect(two.files.map((file) => [file.path, file.note])).toEqual([["second.md", "第二版"], ["first.md", null]]);
    const view = await ticketDelivery(db, itemId);
    expect(view.attemptId).toBe(second);
    expect(view.files.map((file) => file.path)).toEqual(["second.md", "first.md"]);
    await expect(ticketDeliverySnapshot(db, itemId, 3)).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not attach the rework in progress to the previous delivery", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "first.md"), "first\n");
    commitIn(worktree, "first");
    const first = executorRun(itemId, workspaceId);
    await deliver(itemId, first, { summary: "第一版。" });
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    writeFileSync(join(worktree, "wip.md"), "wip\n");
    commitIn(worktree, "wip");

    // 返工中：显示上一次交付，不因为分支变了就给它再存一份。
    const view = await ticketDelivery(db, itemId);
    expect(view.files.map((file) => file.path)).toEqual(["first.md"]);
    expect(listDeliverySnapshotHeaders(db, itemId)).toHaveLength(1);
  });
});

describe("a delivery snapshot after the ticket chat changes the workspace", () => {
  async function delivered() {
    const ticket = codingTicket();
    writeFileSync(join(ticket.worktree, "plan.md"), "v1\n");
    commitIn(ticket.worktree, "plan");
    const runId = executorRun(ticket.itemId, ticket.workspaceId);
    await deliver(ticket.itemId, runId, { summary: "写了方案。", changes: [{ kind: "file", ref: "plan.md", summary: "方案" }] });
    return { ...ticket, runId };
  }

  function chatRun(itemId: number, workspaceId: number): number {
    const chat = createRun(db, { itemId, runtime: "claude", workspaceId, purpose: "conversation" });
    updateRun(db, chat, { state: "running" });
    return chat;
  }

  it("stores another snapshot of the same delivery when a chat commits a change", async () => {
    const { itemId, worktree, workspaceId, runId } = await delivered();
    const chat = chatRun(itemId, workspaceId);
    writeFileSync(join(worktree, "plan.md"), "v1\nv2\n");
    writeFileSync(join(worktree, "extra.md"), "extra\n");
    const head = commitIn(worktree, "chat: follow-up");
    updateRun(db, chat, { state: "finished", endedAt: true, exitCode: 0 });
    await refreshDeliveryAfterRun(db, { itemId, runId: chat });

    const [summary] = await ticketDeliveries(db, itemId);
    expect(summary).toMatchObject({ sequence: 1, attemptId: runId, revisions: 2, reason: "workspace_changed", head });
    const latest = await ticketDeliverySnapshot(db, itemId, 1);
    expect(latest).toMatchObject({ revision: 2, revisions: 2, reason: "workspace_changed", triggerAttemptId: chat, commitCount: 2 });
    // 执行 agent 写的说明跟着这次交付走。
    expect(latest.files.map((file) => [file.path, file.additions, file.note])).toEqual([["plan.md", 2, "方案"], ["extra.md", 1, null]]);
    // 交付时的那一份还在。
    const original = await ticketDeliverySnapshot(db, itemId, 1, 1);
    expect(original.files.map((file) => [file.path, file.additions])).toEqual([["plan.md", 1]]);
  });

  it("stores nothing when the chat only read the workspace", async () => {
    const { itemId, workspaceId } = await delivered();
    const chat = chatRun(itemId, workspaceId);
    updateRun(db, chat, { state: "finished", endedAt: true, exitCode: 0 });
    await refreshDeliveryAfterRun(db, { itemId, runId: chat });
    await ticketDelivery(db, itemId);
    expect(listDeliverySnapshotHeaders(db, itemId).map((header) => header.reason)).toEqual(["delivered"]);
  });

  it("notices an uncommitted change, and a change made while nobody was watching the next time the delivery is opened", async () => {
    const { itemId, worktree, workspaceId } = await delivered();
    const chat = chatRun(itemId, workspaceId);
    writeFileSync(join(worktree, "notes.md"), "not committed\n");
    updateRun(db, chat, { state: "finished", endedAt: true, exitCode: 0 });
    await refreshDeliveryAfterRun(db, { itemId, runId: chat });
    expect((await ticketDeliverySnapshot(db, itemId, 1)).uncommittedFiles).toBe(1);

    // 有人直接在 worktree 里提交了（不经过对话 Run）：打开交付视图时发现，存一份，然后视图和合并看到的是同一个提交。
    const head = commitIn(worktree, "manual");
    const view = await ticketDelivery(db, itemId);
    expect(view.workspace?.head).toBe(head);
    expect(view.files.map((file) => file.path)).toEqual(["plan.md", "notes.md"]);
    expect(listDeliverySnapshotHeaders(db, itemId).map((header) => [header.revision, header.triggerRunId, header.headSha]))
      .toEqual([[1, null, expect.any(String)], [2, chat, expect.any(String)], [3, null, head]]);
    // 再打开一次：没有变化，不再存。
    await ticketDelivery(db, itemId);
    expect(listDeliverySnapshotHeaders(db, itemId)).toHaveLength(3);
  });
});

describe("merging what the user saw", () => {
  // 分支在交付以后变了，新的快照没存成（这里让 git diff 读不到交付前的提交）：文件列表还是旧的，合并不能合进没看过的改动。
  it("does not offer a merge while the file list is behind the branch", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "plan.md"), "v1\n");
    commitIn(worktree, "plan");
    const runId = executorRun(itemId, workspaceId);
    await deliver(itemId, runId, { summary: "写了方案。" });
    expect((await ticketDelivery(db, itemId)).actions.merge.available).toBe(true);

    writeFileSync(join(worktree, "later.md"), "later\n");
    commitIn(worktree, "later");
    db.prepare("UPDATE workspaces SET base_ref=? WHERE id=?").run("0".repeat(40), workspaceId);
    const view = await ticketDelivery(db, itemId);
    expect(view.files.map((file) => file.path)).toEqual(["plan.md"]);
    expect(view.actions.merge).toMatchObject({ available: false, reason: expect.stringContaining("现在合并会合进你没看过的改动") });
    expect(view.actions.merge.reason).toContain("git 算文件列表时出错了。");
    expect(view.actions.openPullRequest.reason).not.toContain("文件列表");
    expect(listDeliverySnapshotHeaders(db, itemId)).toHaveLength(1);
    // 每次打开都会再试；同样的失败只记一条活动，报错里没有服务器上的路径。
    await ticketDelivery(db, itemId);
    const failures = listActivities(db, itemId).map((row) => JSON.parse(row.payload))
      .filter((payload) => payload.decision === "delivery_snapshot_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: "workspace_changed" });
    expect(JSON.stringify(failures[0])).not.toContain(dir);
  });
});

// 审查（2026-10-21）后的修复。每条在旧代码上失败。
describe("the delivery snapshot after review", () => {
  // M1：交付时等快照的上限曾经是 30 秒，正好等于 agent 调宿主工具的时限。git 一慢，agent 先超时，报交付失败。
  // 现在只等钉住分支头的几秒，diff 按钉住的提交在后台跑。
  it("returns from ticket_update while the diff still runs, and stores the commit it pinned", async () => {
    expect(HANDOFF_PIN_BUDGET_MS * 2).toBeLessThan(HOST_AGENT_TOOL_TIMEOUT_MS);
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "plan.md"), "v1\n");
    const delivered = commitIn(worktree, "plan");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setDeliveryDiffForTesting(async (...args) => { await gate; return diffEntries(...args); });
    const runId = executorRun(itemId, workspaceId);

    await deliver(itemId, runId, { summary: "写了方案。" });
    expect(listDeliverySnapshotHeaders(db, itemId)).toEqual([]);
    // agent 交付以后又提交了一次：交付的快照仍然是交付时的那个提交。
    writeFileSync(join(worktree, "after.md"), "after\n");
    commitIn(worktree, "after the handoff");
    release();
    await deliverySnapshotsSettled();
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.reason, row.headSha])).toEqual([["delivered", delivered]]);
    expect((await ticketDeliverySnapshot(db, itemId, 1, 1)).files.map((file) => file.path)).toEqual(["plan.md"]);
  });

  // M2（P8）和 M4：快照一直存不成时，文件列表是空的，「验收并合并」以前照样能点。现在合并不可用，写明原因；
  // 同一个分支头不再重跑 diff，分支头变了才再算。
  it("does not offer a merge when the delivery has no file list, says why, and does not rerun the diff for the same head", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "plan.md"), "v1\n");
    commitIn(worktree, "plan");
    let calls = 0;
    setDeliveryDiffForTesting(async () => { calls++; throw new GitCommandError("stdout maxBuffer length exceeded", "too_large"); });
    const runId = executorRun(itemId, workspaceId);
    await deliver(itemId, runId, { summary: "写了方案。" });
    await deliverySnapshotsSettled();

    const view = await ticketDelivery(db, itemId);
    expect(view.files).toEqual([]);
    expect(view.actions.merge.available).toBe(false);
    expect(view.actions.merge.reason).toBe(
      "改动太大，系统算不出文件列表。合并之前要先看到改了什么：可以开 PR 在 GitHub 上看改动，或者打回返工。",
    );
    await ticketDelivery(db, itemId);
    await ticketDeliveries(db, itemId);
    await refreshDeliveryAfterRun(db, { itemId, runId });
    expect(calls).toBe(1);

    setDeliveryDiffForTesting();
    writeFileSync(join(worktree, "smaller.md"), "smaller\n");
    commitIn(worktree, "a new head");
    const later = await ticketDelivery(db, itemId);
    expect(later.files.map((file) => file.path)).toEqual(["plan.md", "smaller.md"]);
    expect(later.actions.merge.available).toBe(true);
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.reason, row.backfilled])).toEqual([["delivered", true]]);
  });

  // M2（P2）：第一次交付以前就取消、分支上有提交的工单，文件列表是空的，「放弃」以前照样能点。现在现读分支上的改动。
  it("shows the branch's changes on a ticket cancelled before its first delivery, before the user abandons them", async () => {
    const { itemId, worktree } = codingTicket();
    writeFileSync(join(worktree, "draft.md"), "draft\n");
    commitIn(worktree, "draft");
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "not needed" });

    const view = await ticketDelivery(db, itemId);
    expect(view.attemptId).toBeNull();
    expect(view.files.map((file) => [file.path, file.status, file.additions])).toEqual([["draft.md", "added", 1]]);
    expect(view.totals).toEqual({ files: 1, additions: 1, deletions: 0 });
    expect(view.actions.abandon).toEqual({ available: true, reason: null });
    expect((await ticketDeliveryFile(db, itemId, "draft.md", "full")).text).toBe("draft\n");
    expect(listDeliverySnapshotHeaders(db, itemId)).toEqual([]);

    // 算不出改动时不让放弃：用户看不到放弃的是什么。
    setDeliveryDiffForTesting(async () => { throw new GitCommandError("timed out", "timeout"); });
    expect((await ticketDelivery(db, itemId)).actions.abandon).toMatchObject({
      available: false, reason: expect.stringContaining("算不出这个分支上有哪些改动"),
    });
  });

  // M3：v52 以前交付的工单，被对话 Run 结束时补存，以前存成 delivered、backfilled=0，分支头却已经包含对话的改动。
  it("marks a snapshot stored when another run ends as stored later, and names that run", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "old.md"), "old\n");
    commitIn(worktree, "old");
    const runId = executorRun(itemId, workspaceId);
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "f".repeat(64),
      outcome: normalizeOutcomePayload({ summary: "v51 时的交付。", changes: [], deliverables: [], validations: [] }, { workdir: worktree }),
      now: new Date(),
    });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    const chat = createRun(db, { itemId, runtime: "claude", workspaceId, purpose: "conversation" });
    writeFileSync(join(worktree, "chat.md"), "chat\n");
    commitIn(worktree, "chat change");
    updateRun(db, chat, { state: "finished", endedAt: true, exitCode: 0 });

    await refreshDeliveryAfterRun(db, { itemId, runId: chat });
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.reason, row.backfilled, row.triggerRunId, row.triggerKind]))
      .toEqual([["delivered", true, chat, "conversation"]]);
  });

  // L3：返工中取消的工单，返工的提交以前记成「对话 Run」。现在按 Run 的用途记：这是一次没有交付的执行。
  it("records the rework run that was cancelled as an execution, not a chat", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "first.md"), "first\n");
    commitIn(worktree, "first");
    const first = executorRun(itemId, workspaceId);
    await deliver(itemId, first, { summary: "第一版。" });
    await deliverySnapshotsSettled();
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const rework = executorRun(itemId, workspaceId);
    writeFileSync(join(worktree, "wip.md"), "wip\n");
    commitIn(worktree, "wip");
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "stop" });
    updateRun(db, rework, { state: "stopped", endedAt: true, exitCode: 1 });

    await refreshDeliveryAfterRun(db, { itemId, runId: rework });
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.revision, row.reason, row.triggerRunId, row.triggerKind]))
      .toEqual([[1, "delivered", null, null], [2, "workspace_changed", rework, "execution"]]);
    expect((await ticketDeliverySnapshot(db, itemId, 1)).triggerKind).toBe("execution");
  });

  // L6：agent 写的文件名字和说明以前原样存进快照，提交说明却脱敏了。
  it("removes secrets from the agent's file notes before storing them", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "client.ts"), "export {};\n");
    commitIn(worktree, "client");
    // 成果的规范化已经拒收 ghp_ 这类写法；这个假的 AWS key id 只有 redactSecretText 认得出。
    const token = `AKIA${"TEST".repeat(4)}`;
    const runId = executorRun(itemId, workspaceId);
    await deliver(itemId, runId, {
      summary: "接了客户端。",
      changes: [{ kind: "file", ref: "client.ts", summary: `用 ${token} 调通了接口` }],
      deliverables: [{ kind: "path", ref: "client.ts", label: `客户端 ${token}` }],
    });
    await deliverySnapshotsSettled();
    const [file] = (await ticketDeliverySnapshot(db, itemId, 1)).files;
    expect(file!.note).toContain("调通了接口");
    expect(`${file!.label} ${file!.note}`).not.toContain(token);
  });

  // L9：git status 失败时，没提交的文件数以前当成 0，和快照里的数一比就多存一份。现在是 null，不拿它比较。
  it("does not store another snapshot when git status fails", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "plan.md"), "v1\n");
    commitIn(worktree, "plan");
    writeFileSync(join(worktree, "notes.md"), "not committed\n");
    const runId = executorRun(itemId, workspaceId);
    await deliver(itemId, runId, { summary: "写了方案。" });
    await deliverySnapshotsSettled();
    expect((await ticketDeliverySnapshot(db, itemId, 1)).uncommittedFiles).toBe(1);

    // 坏掉的 index：rev-parse 照样能读分支头，git status 失败。
    writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index"), "not an index");
    await ticketDelivery(db, itemId);
    await refreshDeliveryAfterRun(db, { itemId, runId });
    expect(listDeliverySnapshotHeaders(db, itemId)).toHaveLength(1);
  });

  // L1：读交付视图时写快照出错（例如库忙），以前整个请求失败。现在退回读最新的一份；同一张工单一次只抓一份。
  it("still answers when storing the snapshot fails, and runs one capture at a time per ticket", async () => {
    const { itemId, worktree, workspaceId } = codingTicket();
    writeFileSync(join(worktree, "plan.md"), "v1\n");
    commitIn(worktree, "plan");
    const runId = executorRun(itemId, workspaceId);
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "9".repeat(64),
      outcome: normalizeOutcomePayload({ summary: "交付。", changes: [], deliverables: [], validations: [] }, { workdir: worktree }),
      now: new Date(),
    });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    db.exec("CREATE TRIGGER busy BEFORE INSERT ON delivery_snapshots BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    const view = await ticketDelivery(db, itemId);
    expect(view.files).toEqual([]);
    expect(view.actions.merge.available).toBe(false);

    db.exec("DROP TRIGGER busy");
    let calls = 0;
    setDeliveryDiffForTesting(async (...args) => { calls++; return diffEntries(...args); });
    const views = await Promise.all([ticketDelivery(db, itemId), ticketDelivery(db, itemId), ticketDeliveries(db, itemId)]);
    expect(calls).toBe(1);
    expect(views[0].files.map((file) => file.path)).toEqual(["plan.md"]);
    expect(listDeliverySnapshotHeaders(db, itemId)).toHaveLength(1);
  });
});

describe("a delivery snapshot of a ticket that changed the user's directory directly", () => {
  it("records only the files the agent reported, and says they come from the agent", async () => {
    const shared = join(dir, "shared");
    mkdirSync(join(shared, "docs"), { recursive: true });
    writeFileSync(join(shared, "docs", "notes.md"), "# notes\n");
    const itemId = createItem(db, { title: "notes", brief: "b", createdBy: "lead", workdir: shared });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "running" });
    await deliver(itemId, runId, {
      summary: "写了笔记。",
      changes: [{ kind: "file", ref: "docs/notes.md", summary: "新增笔记" }, { kind: "commit", ref: "abc1234", summary: null }],
    });

    const snapshot = await ticketDeliverySnapshot(db, itemId, 1);
    expect(snapshot).toMatchObject({ source: "agent", base: null, head: null, commits: [], totals: null, uncommittedFiles: null });
    expect(snapshot.files).toEqual([{
      path: "docs/notes.md", previousPath: null, status: null, additions: null, deletions: null, binary: false,
      label: null, note: "新增笔记", generated: null, hiddenReason: null,
    }]);
    const view = await ticketDelivery(db, itemId);
    expect(view.source).toBe("shared");
    expect(view.files.map((file) => [file.path, file.views])).toEqual([["docs/notes.md", ["full"]]]);
  });
});

describe("a delivery made before delivery snapshots existed", () => {
  it("is stored once, marked as stored later, the first time the delivery is opened", async () => {
    const { itemId, worktree } = codingTicket();
    writeFileSync(join(worktree, "old.md"), "old\n");
    commitIn(worktree, "old");
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "d".repeat(64),
      outcome: normalizeOutcomePayload({ summary: "旧的交付。", changes: [], deliverables: [], validations: [] }, { workdir: worktree }),
      now: new Date(),
    });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    expect(listDeliverySnapshotHeaders(db, itemId)).toEqual([]);

    expect((await ticketDelivery(db, itemId)).files.map((file) => file.path)).toEqual(["old.md"]);
    await ticketDelivery(db, itemId);
    expect(listDeliverySnapshotHeaders(db, itemId).map((header) => [header.sequence, header.backfilled])).toEqual([[1, true]]);
    expect(getItem(db, itemId)?.stage).toBe("review");
  });
});

describe("which files count as lock or generated files", () => {
  it("decides by path only", () => {
    for (const path of ["package-lock.json", "web/yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "ios/Podfile.lock"]) {
      expect(deliveryGeneratedKind(path), path).toBe("lock");
    }
    for (const path of ["dist/index.js", "apps/web/build/app.js", "src/__generated__/schema.ts", "app.min.js", "main.js.map",
      "test/__snapshots__/a.test.ts.snap", "api/user.pb.go", "schema.generated.ts", "node_modules/x/index.js"]) {
      expect(deliveryGeneratedKind(path), path).toBe("generated");
    }
    for (const path of ["src/build.ts", "docs/lock.md", "README.md", "distribution/notes.md", "src/generator.ts"]) {
      expect(deliveryGeneratedKind(path), path).toBeNull();
    }
  });

  it("puts the agent's files first in its order, then the rest, then lock and generated files", () => {
    const files = [
      { path: "yarn.lock", generated: "lock" as const },
      { path: "b.ts", generated: null },
      { path: "dist/b.js", generated: "generated" as const },
      { path: "a.ts", generated: null },
      { path: "c.ts", generated: null },
    ];
    expect(orderDeliveryFiles(files, ["c.ts", "yarn.lock"]).map((file) => file.path))
      .toEqual(["c.ts", "yarn.lock", "b.ts", "a.ts", "dist/b.js"]);
  });
});
