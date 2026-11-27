// 登记已有的 PR（工单 #497）。#493 的 PR 是 Lead 把分支推到 fork、再手动开的：openDeliveryPullRequest 不会写
// workspace_pr_opened，工单面板和详情就看不到这个 PR。link_pr 补上这一条记录。
// 用真的 git 仓库和假的 gh 测：登记、格式校验、替换、列表卡片读到的地址，以及系统不去更新人工登记的 PR。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createItem, createRun, insertOutcomeSnapshot, listActivities, normalizeOutcomePayload, openDb, updateRun, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { parseGithubPullRequestUrl } from "@pi-lead-child/protocol";
import { prepareRunWorkspaceNowForTesting } from "../src/coordinator/workspace-policy.js";
import { DeliveryError, ticketDelivery, updateDeliveryPullRequest, type PullRequestRunner } from "../src/coordinator/delivery.js";
import { autoPullRequestPlan, markAutoPullRequestRollout, syncAutoPullRequests } from "../src/coordinator/auto-pull-request.js";
import { createWorkspaceActionService } from "../src/coordinator/workspace-actions.js";
import { listTicketActions, runTicketAction, TicketActionError } from "../src/ticket-actions/index.js";

let db: Db;
let dir: string;
let repo: string;
let remote: string;

const PR_85 = "https://github.com/acme/widgets/pull/85";
const PR_90 = "https://github.com/acme/widgets/pull/90";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-link-pr-");
  repo = join(dir, "repo");
  remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  db = openDb(join(dir, "plc.db"));
  markAutoPullRequestRollout(db, new Date("2026-10-26T00:00:00.000Z"));
});
afterEach(() => db.close());

function commitIn(worktree: string, file: string): void {
  writeFileSync(join(worktree, file), `${file}\n`);
  git(worktree, "add", "-A");
  git(worktree, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", `add ${file}`);
}

function deliver(itemId: number, deliveredAt: string): void {
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: runId, sourceOutputSha256: "a".repeat(64),
    outcome: normalizeOutcomePayload({ summary: `第 ${runId} 次交付`, changes: [], deliverables: [], validations: [] }, { workdir: repo }),
    now: new Date(deliveredAt),
  });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
}

function codingTicket() {
  const itemId = createItem(db, { title: "给列表加 PR 链接", brief: "b", createdBy: "lead", workdir: repo });
  db.prepare("UPDATE items SET verification_policy='lead_static' WHERE id=?").run(itemId);
  const workspace = prepareRunWorkspaceNowForTesting(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  commitIn(workspace.path, "plan.md");
  deliver(itemId, "2026-10-26T08:00:00.000Z");
  return { itemId, worktree: workspace.path };
}

const link = (itemId: number, url: string) => runTicketAction(db, {
  itemId, action: "link_pr", input: { url }, caller: { kind: "user" },
});

function opened(itemId: number): Array<Record<string, unknown>> {
  return listActivities(db, itemId).map((row) => JSON.parse(row.payload)).filter((payload) => payload.decision === "workspace_pr_opened");
}

describe("parseGithubPullRequestUrl", () => {
  it("takes only https://github.com/<owner>/<repo>/pull/<n>", () => {
    expect(parseGithubPullRequestUrl(`  ${PR_85}  `)).toEqual({ owner: "acme", repo: "widgets", number: 85, url: PR_85 });
    for (const bad of [
      "http://github.com/acme/widgets/pull/85", "https://gitlab.com/acme/widgets/pull/85", "https://github.com.evil.test/acme/widgets/pull/85",
      "https://github.com/acme/widgets/pull/85/files", "https://github.com/acme/widgets/pull/85?x=1", "https://github.com/acme/widgets/pull/85#c",
      "https://github.com/acme/widgets/pull/85/", "https://github.com/acme/widgets/pull/abc", "https://github.com/acme/widgets/pull/0",
      "https://github.com/acme/widgets/issues/85", "https://github.com/acme/pull/85", "https://github.com/acme/../pull/85", "85", "",
    ]) expect(parseGithubPullRequestUrl(bad), bad).toBeNull();
  });
});

// 每个测试都建真的 git 仓库和 worktree，慢的机器上 15 秒不够。
describe("link_pr", { timeout: 90_000 }, () => {
  it("records an existing PR so the delivery view and the ticket list both show it", async () => {
    const { itemId } = codingTicket();
    expect(await ticketDelivery(db, itemId).then((view) => view.workspace?.pullRequestUrl)).toBeNull();

    const result = await link(itemId, PR_85) as { result: { pullRequestUrl: string; changed: boolean } };
    expect(result.result).toMatchObject({ pullRequestUrl: PR_85, changed: true });

    const [entry] = opened(itemId);
    expect(entry).toMatchObject({ url: PR_85, linked: true });
    expect(await ticketDelivery(db, itemId).then((view) => view.workspace?.pullRequestUrl)).toBe(PR_85);
    // 工单列表的卡片读的是 TicketSummary.workspace。
    expect(createWorkspaceActionService(db).controlForItem(itemId)?.pullRequestUrl).toBe(PR_85);
  });

  it("refuses an address that is not a GitHub pull request, and writes nothing", async () => {
    const { itemId } = codingTicket();
    for (const url of ["https://example.com/acme/widgets/pull/85", "https://github.com/acme/widgets/pull/85/files", "not a url"]) {
      const error = await link(itemId, url).then(() => null, (caught: unknown) => caught);
      expect(error, url).toBeInstanceOf(TicketActionError);
      expect((error as TicketActionError).code).toBe("invalid_input");
    }
    expect(opened(itemId)).toEqual([]);
  });

  it("replaces the PR the ticket already has, and keeps the old address in the record", async () => {
    const { itemId } = codingTicket();
    await link(itemId, PR_85);
    const second = await link(itemId, PR_90) as { result: { replaced: string | null } };
    expect(second.result.replaced).toBe(PR_85);
    expect(opened(itemId).at(-1)).toMatchObject({ url: PR_90, linked: true, replaces: PR_85 });
    expect(await ticketDelivery(db, itemId).then((view) => view.workspace?.pullRequestUrl)).toBe(PR_90);
  });

  it("does not write a second record for the address the ticket already has", async () => {
    const { itemId } = codingTicket();
    await link(itemId, PR_85);
    const again = await link(itemId, PR_85) as { result: { changed: boolean } };
    expect(again.result.changed).toBe(false);
    expect(opened(itemId)).toHaveLength(1);
  });

  it("lets Lead do it too, and records Lead as the one who did", async () => {
    const { itemId } = codingTicket();
    await runTicketAction(db, {
      itemId, action: "link_pr", input: { url: PR_85 }, caller: { kind: "lead", turnId: null }, reason: "PR 是推到 fork 后手动开的",
    });
    const row = listActivities(db, itemId).find((entry) => JSON.parse(entry.payload).decision === "workspace_pr_opened")!;
    expect(row.actor).toBe("lead");
    expect(JSON.parse(row.payload).reason).toBe("PR 是推到 fork 后手动开的");
  });

  it("is not offered on a ticket without its own branch", async () => {
    const itemId = createItem(db, { title: "没有分支", brief: "b", createdBy: "lead" });
    const listed = (await listTicketActions(db, itemId, { host: { resumeRun: () => {} } })).find((entry) => entry.id === "link_pr")!;
    expect(listed.available).toBe(false);
    const error = await link(itemId, PR_85).then(() => null, (caught: unknown) => caught);
    expect((error as TicketActionError).code).toBe("unavailable");
  });

  it("makes open_pr say the ticket already has a PR", async () => {
    const { itemId } = codingTicket();
    await link(itemId, PR_85);
    const view = await ticketDelivery(db, itemId);
    expect(view.actions.openPullRequest).toEqual({ available: false, reason: "已经开过 PR。" });
  });

  // 登记的 PR 多半在 fork 上：系统推不了 origin，也没有那个 PR 的描述，返工以后不去更新它，不然每次都报推送失败。
  it("leaves a linked PR alone when the branch gets a rework commit", async () => {
    const { itemId, worktree } = codingTicket();
    await link(itemId, PR_85);
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    commitIn(worktree, "fix.md");
    deliver(itemId, "2026-10-26T09:00:00.000Z");

    expect(await autoPullRequestPlan(db, itemId)).toEqual({ action: "skip", reason: "这个 PR 是人工登记的，系统不自动更新。" });
    const calls: string[][] = [];
    const runner: PullRequestRunner = { async gh(args) { calls.push(args); return { ok: true, stdout: "", stderr: "" }; } };
    expect(await syncAutoPullRequests(db, { runner })).toMatchObject({ opened: [], updated: [], failed: [] });
    expect(calls).toEqual([]);
    expect(git(remote, "branch", "--list")).not.toContain("plc/");
  });

  // 定时扫描先判断「该更新」，再排队拿锁；这两步之间用户登记了 PR，更新就会照旧推送、改 PR 描述。
  // 所以更新函数自己也要认「人工登记」，不能只靠判断那一步。
  it("refuses to update a linked PR even when the update was planned before the link", async () => {
    const { itemId, worktree } = codingTicket();
    await link(itemId, PR_85);
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    commitIn(worktree, "fix.md");
    deliver(itemId, "2026-10-26T09:00:00.000Z");

    const calls: string[][] = [];
    const runner: PullRequestRunner = { async gh(args) { calls.push(args); return { ok: true, stdout: "", stderr: "" }; } };
    const error = await updateDeliveryPullRequest(db, itemId, { reason: "返工交付以后更新 PR", runner }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).code).toBe("unavailable");
    expect(calls).toEqual([]);
    expect(git(remote, "branch", "--list")).not.toContain("plc/");
  });
});
