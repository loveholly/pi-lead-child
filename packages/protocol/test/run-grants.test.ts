import { describe, expect, it } from "vitest";
import {
  checkGrantCall, computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, GrantError, isRunGrant, USER_PR_REVIEW_BOUND, widenRunGrant,
  withoutGrantRules, type GrantLocalRepo, type RunGrant,
} from "../src/index.ts";

const LOCAL: Record<string, GrantLocalRepo> = {
  "pi-lead-child": { name: "pi-lead-child", root: "/repos/pi-lead-child", github: "loveholly/pi-lead-child" },
  x: { name: "x", root: "/repos/x", github: "Acme/x" },
};
const resolveLocalRepo = (name: string) => LOCAL[name] ?? null;
const PR = { owner: "Acme", repo: "x", number: 101 };

const githubCall = (tool: string, facts: Record<string, unknown>, readOnly = false) =>
  ({ connection: "github", tool, readOnly, facts });

describe("computeRunGrant: the upper bound by intent ∩ the scope Lead picked", () => {
  it("gives a code review read access to the PR's repo and COMMENT on that PR only", () => {
    const { grant, dropped } = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo });
    expect(isRunGrant(grant)).toBe(true);
    expect(dropped).toEqual([]);
    expect(grant.rules.map((rule) => rule.label)).toEqual([
      "只读 Acme/x",
      "只在 Acme/x#101 上发 COMMENT",
      "在 Acme/x#101 的 review 里加行内评论",
    ]);
  });

  it("drops what Lead asks beyond the bound and says what it dropped", () => {
    const { grant, dropped } = computeRunGrant({
      intent: "code_review",
      scope: { pullRequest: PR, repos: ["Acme/x", "Acme/secrets"], reviewEvents: ["COMMENT", "APPROVE"], connections: ["cdp"], localRepos: ["pi-lead-child", "x"] },
      resolveLocalRepo,
    });
    expect(dropped).toEqual([
      "只能读 PR 所在的仓库，丢掉了 Acme/secrets",
      "只能读 PR 所在的仓库，丢掉了本地仓库 pi-lead-child",
      "这个意图不能发 APPROVE",
      "这个意图不能用 cdp",
    ]);
    expect(grant.localRepos).toEqual([LOCAL.x]);
    expect(grant.rules.some((rule) => rule.label.includes("APPROVE"))).toBe(false);
  });

  it("lets Lead narrow an approve request down to COMMENT", () => {
    const wide = computeRunGrant({ intent: "approve", scope: { pullRequest: PR }, resolveLocalRepo }).grant;
    expect(wide.rules.map((rule) => rule.label)).toContain("只在 Acme/x#101 上发 COMMENT，可以 APPROVE");
    const narrow = computeRunGrant({ intent: "approve", scope: { pullRequest: PR, reviewEvents: ["COMMENT"] }, resolveLocalRepo }).grant;
    expect(narrow.rules.map((rule) => rule.label)).toContain("只在 Acme/x#101 上发 COMMENT");
  });

  it("requires a PR for the review intents", () => {
    expect(() => computeRunGrant({ intent: "approve", scope: {}, resolveLocalRepo })).toThrow(GrantError);
  });

  it("gives a knowledge question the repos Lead picked, CDP read, and nothing to write", () => {
    const { grant, dropped } = computeRunGrant({
      intent: "knowledge",
      scope: { repos: ["Acme/a", "Acme/b"], localRepos: ["pi-lead-child", "nope"], pullRequest: PR },
      resolveLocalRepo,
    });
    expect(dropped).toEqual([
      "这个意图不针对 PR，没有给 Acme/x#101 写权限",
      "找不到本地仓库 nope",
    ]);
    expect(grant.rules.map((rule) => rule.label)).toEqual([
      "只读 Acme/a", "只读 Acme/b", "只读 Acme/x", "只读本地仓库 pi-lead-child", "只读 cdp",
    ]);
  });

  it("caps the number of repos", () => {
    const { dropped } = computeRunGrant({
      intent: "progress", scope: { repos: ["o/a", "o/b", "o/c", "o/d", "o/e"] }, resolveLocalRepo,
    });
    expect(dropped).toEqual(["最多读 4 个 GitHub 仓库，丢掉了 o/e"]);
  });

  it("uses a bound the channel passes instead of the default table", () => {
    const { grant } = computeRunGrant({
      intent: "approve", scope: { pullRequest: PR },
      bound: { ...DEFAULT_INTENT_GRANT_BOUNDS.approve, reviewEvents: ["COMMENT"] },
      resolveLocalRepo,
    });
    expect(grant.rules.some((rule) => rule.label.includes("APPROVE"))).toBe(false);
  });
});

// 用户本人要的 PR 评审（lead-self-routing spec B，2026-10-28）：评审 agent 自己发，结论可以是要求改动（用户的笔记 #47）。
// 外部的人请用户 review 时照旧不能代用户要求改动（DEFAULT_INTENT_GRANT_BOUNDS）。
describe("a review the user asked for", () => {
  const requestChanges = githubCall("pull_request_review_write", {
    owner: "Acme", repo: "x", pullNumber: 101, method: "submit_pending", event: "REQUEST_CHANGES",
  });

  it("may request changes on that PR; a review someone outside asked for still may not", () => {
    const own = computeRunGrant({
      intent: "code_review", scope: { pullRequest: PR, reviewEvents: ["COMMENT", "REQUEST_CHANGES"] }, bound: USER_PR_REVIEW_BOUND, resolveLocalRepo,
    });
    expect(own.dropped).toEqual([]);
    expect(checkGrantCall(own.grant, requestChanges).ok).toBe(true);
    expect(checkGrantCall(own.grant, { ...requestChanges, facts: { ...requestChanges.facts, pullNumber: 102 } }).ok).toBe(false);
    const outside = computeRunGrant({
      intent: "code_review", scope: { pullRequest: PR, reviewEvents: ["COMMENT", "REQUEST_CHANGES"] }, resolveLocalRepo,
    });
    expect(outside.dropped).toContain("这个意图不能发 REQUEST_CHANGES");
    expect(checkGrantCall(outside.grant, requestChanges).ok).toBe(false);
    expect(DEFAULT_INTENT_GRANT_BOUNDS.code_review.reviewEvents).not.toContain("REQUEST_CHANGES");
    expect(DEFAULT_INTENT_GRANT_BOUNDS.approve.reviewEvents).not.toContain("REQUEST_CHANGES");
  });
});

describe("checkGrantCall: every call is checked against the grant's arguments", () => {
  const review = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR, localRepos: ["x"] }, resolveLocalRepo }).grant;

  it("allows reads of the granted repo, case-insensitively", () => {
    expect(checkGrantCall(review, githubCall("get_file_contents", { owner: "acme", repo: "X", path: "a.ts" }, true)).ok).toBe(true);
  });

  it("refuses reads of another repo and reads without a repo", () => {
    expect(checkGrantCall(review, githubCall("get_file_contents", { owner: "Acme", repo: "y" }, true)))
      .toEqual({ ok: false, reason: "参数 repo 是 y，只能是 x（规则：只读 Acme/x）" });
    expect(checkGrantCall(review, githubCall("search_code", { query: "foo" }, true)).ok).toBe(false);
  });

  it("allows a COMMENT review on the PR and refuses APPROVE, another PR, and other methods", () => {
    const base = { owner: "Acme", repo: "x", pullNumber: 101 };
    expect(checkGrantCall(review, githubCall("pull_request_review_write", { ...base, method: "create" })).ok).toBe(true);
    expect(checkGrantCall(review, githubCall("pull_request_review_write", { ...base, method: "submit_pending", event: "COMMENT" })).ok).toBe(true);
    const approve = checkGrantCall(review, githubCall("pull_request_review_write", { ...base, method: "submit_pending", event: "APPROVE" }));
    expect(approve).toEqual({ ok: false, reason: "参数 event 是 APPROVE，只能是 COMMENT（规则：只在 Acme/x#101 上发 COMMENT）" });
    expect(checkGrantCall(review, githubCall("pull_request_review_write", { ...base, pullNumber: 102, method: "create" })).ok).toBe(false);
    expect(checkGrantCall(review, githubCall("pull_request_review_write", { ...base, method: "resolve_thread", threadId: "t" })).ok).toBe(false);
    expect(checkGrantCall(review, githubCall("add_comment_to_pending_review", { ...base, path: "a.ts", line: 3 })).ok).toBe(true);
  });

  it("refuses write tools the grant does not name", () => {
    expect(checkGrantCall(review, githubCall("merge_pull_request", { owner: "Acme", repo: "x", pullNumber: 101 })))
      .toEqual({ ok: false, reason: "merge_pull_request 会写入 github，清单里没有这个写操作" });
  });

  it("matches a connection by its alias", () => {
    const knowledge = computeRunGrant({ intent: "knowledge", scope: { connections: ["cdp"] }, resolveLocalRepo }).grant;
    expect(checkGrantCall(knowledge, { connection: "custom-3", aliases: ["cdp"], tool: "search_audiences", readOnly: true, facts: {} }).ok).toBe(true);
    expect(checkGrantCall(knowledge, { connection: "custom-3", tool: "search_audiences", readOnly: true, facts: {} }))
      .toEqual({ ok: false, reason: "清单里没有 custom-3 这个连接" });
  });

  it("checks local reads by repo name", () => {
    expect(checkGrantCall(review, { connection: "local", tool: "read_file", readOnly: true, facts: { repo: "x" } }).ok).toBe(true);
    expect(checkGrantCall(review, { connection: "local", tool: "read_file", readOnly: true, facts: { repo: "pi-lead-child" } }).ok).toBe(false);
  });
});

describe("widening by the user and undoing it", () => {
  const review = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo }).grant;

  it("adds APPROVE on the PR beyond the intent's bound, and only the rules that are new", () => {
    const widened = widenRunGrant(review, { pullRequest: PR, reviewEvents: ["COMMENT", "APPROVE"] }, resolveLocalRepo);
    expect(widened.added.map((rule) => rule.label)).toEqual(["只在 Acme/x#101 上发 COMMENT，可以 APPROVE"]);
    const call = githubCall("pull_request_review_write", { owner: "Acme", repo: "x", pullNumber: 101, method: "submit_pending", event: "APPROVE" });
    expect(checkGrantCall(widened.grant, call).ok).toBe(true);
    const undone = withoutGrantRules(widened.grant, widened.added.map((rule) => rule.id));
    expect(undone).toEqual(review);
    expect(checkGrantCall(undone, call).ok).toBe(false);
  });

  it("adds a local repo with its root and removes it on undo", () => {
    const widened = widenRunGrant(review, { localRepos: ["pi-lead-child", "nope"] }, resolveLocalRepo);
    expect(widened.unresolved).toEqual(["nope"]);
    expect(widened.grant.localRepos).toEqual([LOCAL["pi-lead-child"]]);
    const undone = withoutGrantRules(widened.grant, widened.added.map((rule) => rule.id), widened.addedLocalRepos.map((entry) => entry.name));
    expect(undone).toEqual(review);
  });

  it("refuses review events without a PR", () => {
    expect(() => widenRunGrant(review, { reviewEvents: ["APPROVE"] }, resolveLocalRepo)).toThrow(GrantError);
  });

  it("keeps the grant valid against the schema", () => {
    const grant: RunGrant = widenRunGrant(review, { connections: ["atlassian"], repos: ["o/r"] }, resolveLocalRepo).grant;
    expect(isRunGrant(grant)).toBe(true);
  });
});
