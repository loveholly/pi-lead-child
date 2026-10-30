// GitHub 的工具守卫（landing.md C2，src/github-guard.ts）：对所有调用方生效。APPROVE 以前代码查四条：
// 检查都通过、review 线程都 resolve、不是 draft、head 就是 review 过的那个提交。有一条不过就拒绝并给出原因。
// 带清单的 Run 按它的读取记录认「review 过的提交」；Lead 这类调用方要在 commitID 里写明。GitHub 是假的 MCP 服务器。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS } from "@pi-lead-child/protocol";
import { createItem, createRun, insertRunGrant, listRunToolCalls, openDb, type Db } from "@pi-lead-child/store";
import { ConnectionHub } from "../src/hub.js";
import { githubReviewShapeProblem, reviewThreadState } from "../src/github-guard.js";
import { Vault } from "../src/vault.js";
import { FAKE_GH_TOKEN, FakeGithub, type FakePullRequest } from "../testing/fake-github.js";

const HEAD = "a".repeat(40);
const PR = { owner: "Acme", repo: "x", number: 101 };
const DIFF = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", " const a = 1;", "+const b = 2;"].join("\n");
const prArgs = { owner: PR.owner, repo: PR.repo, pullNumber: PR.number };
const approve = { ...prArgs, method: "create", event: "APPROVE", body: "LGTM" };

let db: Db;
let gh: FakeGithub;
let pr: FakePullRequest;

beforeEach(() => {
  db = openDb(join(tempDir("plc-github-guard-"), "plc.db"));
  gh = new FakeGithub();
  pr = {
    ...PR, title: "t", body: "b", headSha: HEAD, diff: DIFF,
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "skipped" }],
    statuses: [{ context: "ci/legacy", state: "success" }],
  };
  gh.addPullRequest(pr);
});

async function hub(): Promise<ConnectionHub> {
  const h = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:1/cb",
    fetch: gh.fetch, gh: { token: async () => FAKE_GH_TOKEN }, ghInstalled: () => true,
  });
  await h.start("github");
  return h;
}

function approveRun(): number {
  const itemId = createItem(db, { title: "通道派的工单", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  const { grant } = computeRunGrant({ intent: "approve", scope: { pullRequest: PR }, resolveLocalRepo: () => null });
  insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.approve, scope: { pullRequest: PR } });
  return runId;
}

async function review(h: ConnectionHub, runId: number): Promise<void> {
  await h.callTool("github", "pull_request_read", { ...prArgs, method: "get" }, { role: "executor", runId });
  await h.callTool("github", "pull_request_read", { ...prArgs, method: "get_diff" }, { role: "executor", runId });
}

const asRun = (runId: number) => ({ role: "executor" as const, runId });
const approved = () => gh.submitted(PR.owner, PR.repo, PR.number).filter((entry) => entry.state === "APPROVED");

describe("approving a PR, for a run with a grant", () => {
  it("approves once the run has read the head and its diff, and every check passes", async () => {
    const h = await hub();
    const runId = approveRun();
    await review(h, runId);
    await h.callTool("github", "pull_request_review_write", approve, asRun(runId));
    expect(approved()).toHaveLength(1);
  });

  it("refuses without reading the diff of the current head", async () => {
    const h = await hub();
    const runId = approveRun();
    await expect(h.callTool("github", "pull_request_review_write", approve, asRun(runId)))
      .rejects.toMatchObject({ code: "grant_denied", message: expect.stringContaining("没有读过这个 PR") });
    await h.callTool("github", "pull_request_read", { ...prArgs, method: "get" }, asRun(runId));
    await expect(h.callTool("github", "pull_request_review_write", approve, asRun(runId)))
      .rejects.toMatchObject({ message: expect.stringContaining("还没读过 aaaaaaa 的 diff") });
    expect(approved()).toEqual([]);
    expect(listRunToolCalls(db, runId).filter((entry) => entry.decision === "refused").map((entry) => entry.reason)).toEqual([
      expect.stringContaining("没有读过这个 PR"), expect.stringContaining("diff"),
    ]);
  });

  it("refuses when the PR got a new commit after the review", async () => {
    const h = await hub();
    const runId = approveRun();
    await review(h, runId);
    pr.headSha = "b".repeat(40);
    await expect(h.callTool("github", "pull_request_review_write", approve, asRun(runId)))
      .rejects.toMatchObject({ message: expect.stringContaining("review 以后 PR 又有了新的提交（review 的是 aaaaaaa，现在是 bbbbbbb）") });
  });

  it("refuses a draft, a failing check, a pending check, and an unresolved thread, naming which", async () => {
    const h = await hub();
    const runId = approveRun();
    await review(h, runId);
    const attempt = () => h.callTool("github", "pull_request_review_write", approve, asRun(runId));

    pr.draft = true;
    await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining("PR 还是 draft") });
    pr.draft = false;

    pr.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining("检查没通过：test") });
    pr.checkRuns = [{ name: "test", status: "in_progress", conclusion: null }];
    await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining("检查还没跑完：test") });
    pr.checkRuns = [];
    pr.statuses = [{ context: "ci/legacy", state: "pending" }];
    await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining("检查还没跑完：ci/legacy") });
    pr.statuses = [];

    pr.threads = [{ id: "t1", isResolved: false, path: "a.ts", line: 2, body: "?" }, { id: "t2", isResolved: true }];
    await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining("还有 1 个 review 线程没 resolve") });
    pr.threads[0]!.isResolved = true;

    await attempt();
    expect(approved()).toHaveLength(1);
  });
});

describe("approving a PR, for Lead and other callers", () => {
  it("applies the same checks, and asks for the reviewed commit in commitID", async () => {
    const h = await hub();
    const lead = { role: "lead" as const, confirmed: true };
    await expect(h.callTool("github", "pull_request_review_write", approve, lead))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("commitID 要写 review 过的那个提交") });
    await expect(h.callTool("github", "pull_request_review_write", { ...approve, commitID: "c".repeat(40) }, lead))
      .rejects.toMatchObject({ message: expect.stringContaining("不是 PR 现在的 head") });
    pr.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    await expect(h.callTool("github", "pull_request_review_write", { ...approve, commitID: HEAD }, lead))
      .rejects.toMatchObject({ message: expect.stringContaining("检查没通过") });
    pr.checkRuns = [];
    await h.callTool("github", "pull_request_review_write", { ...approve, commitID: HEAD }, lead);
    expect(approved()).toHaveLength(1);
  });

  it("never reads a denied file from a repository, for anyone", async () => {
    const h = await hub();
    gh.addFile("Acme", "x", ".env", "TOKEN=x");
    gh.addFile("Acme", "x", "config/credentials.json", "{}");
    for (const path of [".env", "config/credentials.json", "./.env"]) {
      await expect(h.callTool("github", "get_file_contents", { owner: "Acme", repo: "x", path }, { role: "lead" }))
        .rejects.toMatchObject({ message: expect.stringContaining("禁止名单") });
    }
    const runId = approveRun();
    await expect(h.callTool("github", "get_file_contents", { owner: "Acme", repo: "x", path: ".env" }, asRun(runId)))
      .rejects.toMatchObject({ code: "grant_denied", message: expect.stringContaining("禁止名单") });
    expect(gh.calls.filter((call) => call.tool === "get_file_contents")).toEqual([]);
  });

  it("checks the shape of reviews and inline comments for everyone", async () => {
    const h = await hub();
    const lead = { role: "lead" as const, confirmed: true };
    await expect(h.callTool("github", "pull_request_review_write", { ...prArgs, method: "submit_pending" }, lead))
      .rejects.toMatchObject({ message: expect.stringContaining("提交 review 时要给 event") });
    await expect(h.callTool("github", "pull_request_review_write", { ...prArgs, method: "create", event: "MERGE" }, lead))
      .rejects.toMatchObject({ message: expect.stringContaining("不能是 MERGE") });
  });
});

describe("the guard's readers", () => {
  it("understands review threads in the shapes GitHub returns, and refuses what it cannot read", () => {
    expect(reviewThreadState(JSON.stringify({ reviewThreads: [] }))).toEqual({ total: 0, unresolved: 0 });
    expect(reviewThreadState(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } } } } })))
      .toEqual({ total: 2, unresolved: 1 });
    expect(reviewThreadState(JSON.stringify([{ is_resolved: true }]))).toEqual({ total: 1, unresolved: 0 });
    // 只有评论、没有线程的状态：看不出来。
    expect(reviewThreadState(JSON.stringify([{ path: "a.ts", body: "x" }]))).toBeNull();
    expect(reviewThreadState("not json")).toBeNull();
  });

  it("checks inline comment shapes", () => {
    expect(githubReviewShapeProblem("add_comment_to_pending_review", { path: "a", body: "b", line: 1, side: "RIGHT", subjectType: "LINE" })).toBeNull();
    expect(githubReviewShapeProblem("add_comment_to_pending_review", { path: "a", body: "b", subjectType: "FILE" })).toBeNull();
    expect(githubReviewShapeProblem("add_comment_to_pending_review", { path: "a", body: "b", line: 0 })).toMatch(/line/);
    expect(githubReviewShapeProblem("add_comment_to_pending_review", { body: "b", line: 1 })).toMatch(/path 和 body/);
  });
});
