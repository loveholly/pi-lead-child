// PR 评审工单的模板（2026-10-19，.scratch/lead-credibility/spec.md D5）。以前 brief 由 Lead 自己写：用户的关注点被改写，
// 交付方式每次不同，「PR 审查直接发行内评论」只在 Lead 的笔记里。模板固定这几样，派发出去的 brief 里原样有用户的原话。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { buildChildPrompt } from "@pi-lead-child/core";
import { createProject, getItem, getRunGrant, linkProjectRepository, openDb, type Db } from "@pi-lead-child/store";
import { checkGrantCall } from "@pi-lead-child/protocol";
import { runItem } from "@pi-lead-child/engine";
import type { AgentRuntime, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { findPullRequestRef, parsePullRequestRef, PR_REVIEW_GUARDRAILS, prReviewGuardrails } from "../src/templates/pr-review.js";

const FOCUS = "重点看鉴权：长任务里 token 过期会不会被误报成「未连接」";
const ACCEPTANCE = "每个 Blocking 问题都有行内评论，指到具体行";

function setup() {
  const dir = tempDir("plc-pr-review-");
  const db = openDb(join(dir, "plc.db"));
  const repo = tempDir("plc-pr-review-repo-");
  const project = createProject(db, { name: "aishx", createdBy: "user" });
  linkProjectRepository(db, project, { repoRoot: repo, repoName: "agent-app", remoteUrl: "github.com/acme/agent-app" });
  const deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
  const createTask = createLeadTools(deps).find((tool: any) => tool.name === "create_task") as any;
  return { db, repo, createTask };
}

describe("parsePullRequestRef", () => {
  it("reads owner/repo#N and a PR link", () => {
    expect(parsePullRequestRef("Acme/agent-app#101")).toMatchObject({ owner: "Acme", repo: "agent-app", number: 101 });
    expect(parsePullRequestRef("https://github.com/Acme/agent-app/pull/101/files").number).toBe(101);
    expect(() => parsePullRequestRef("PR 101")).toThrow(/owner\/repo#123/);
  });
});

// slack-takeover 工单 06（spec D13）：Slack 原文里认 PR，只认链接和 owner/repo#n 两种明确的语法。
describe("findPullRequestRef", () => {
  it("finds a PR link or owner/repo#N inside a message, including Slack's <link|label> form", () => {
    expect(findPullRequestRef("帮忙 review 一下 <https://github.com/acme/widgets/pull/12>，主要看重试")).toEqual({
      owner: "acme", repo: "widgets", number: 12, url: "https://github.com/acme/widgets/pull/12",
    });
    expect(findPullRequestRef("看下 <https://github.com/acme/widgets/pull/12/files|这个 PR> 吧")?.number).toBe(12);
    expect(findPullRequestRef("acme/widgets#7 改了重试")).toMatchObject({ owner: "acme", repo: "widgets", number: 7 });
    expect(findPullRequestRef("（Acme/agent-app#101）")).toMatchObject({ repo: "agent-app", number: 101 });
    // 找到几个时取第一个。
    expect(findPullRequestRef("先看 acme/a#1，再看 https://github.com/acme/b/pull/2")).toMatchObject({ repo: "a", number: 1 });
  });

  it("does not read a PR out of words, other sites or paths", () => {
    for (const text of [
      "有空帮忙 review 一下重试那个改动吗", "PR 12 有问题", "#12", "https://gitlab.com/acme/widgets/pull/12",
      "https://example.com/acme/widgets#12", "src/foo/pull/3", "path/to/acme/widgets#12", "acme/widgets#12345678",
    ]) {
      expect(findPullRequestRef(text), text).toBeNull();
    }
  });
});

describe("create_task with template=pr_review", () => {
  it("writes the user's words verbatim, the delivery and the fixed guardrails, and finds the local repository", async () => {
    const { db, repo, createTask } = setup();
    const result = await createTask.execute("c", {
      title: "评审 PR #101 的鉴权", brief: "上次 #98 的结论供参考。", template: "pr_review",
      pr_review: { pr: "Acme/agent-app#101", focus: FOCUS, acceptance: ACCEPTANCE },
    });
    const id = Number(/#(\d+)/.exec(result.content[0].text)![1]);
    const item = getItem(db, id)!;
    expect(item.workdir).toBe(repo);
    expect(item.brief).toContain(`## 用户的关注点（原话）\n${FOCUS}`);
    expect(item.brief).toContain(`## 验收标准（原话）\n${ACCEPTANCE}`);
    expect(item.brief).toContain("## Lead 的补充\n上次 #98 的结论供参考。");
    for (const rule of PR_REVIEW_GUARDRAILS) expect(item.brief).toContain(rule);
    for (const rule of prReviewGuardrails("post", "Acme/agent-app#101")) expect(item.brief).toContain(rule);
    // 缺省 deliver=post（lead-self-routing spec A，用户的笔记 #47）：评审 agent 自己发到这个 PR，交回一句话和链接。
    // 以前（2026-10-28 的 D4）写死「不要自己往 GitHub 发评审……由 Lead 发」，Lead 只好把评审全文和 PR 的文件读进自己的上下文。
    expect(item.brief).not.toContain("不要自己往 GitHub 发评审");
    expect(item.brief).toContain("add_comment_to_pending_review");
    expect(item.brief).toContain("submit_pending");
    expect(item.brief).toContain("评审的链接");
    expect(item.brief).not.toContain("gh api");
    expect(item.brief).toContain("PLC_RUN_RUNTIME、PLC_RUN_MODEL");
    // child 拿到的第一条提示就是这份 brief。
    expect(buildChildPrompt(item)).toContain(FOCUS);
    const record = db.prepare("SELECT payload FROM activities WHERE item_id=? AND json_extract(payload,'$.decision')='ticket_template'").get(id) as { payload: string };
    expect(JSON.parse(record.payload)).toEqual({
      decision: "ticket_template", template: "pr_review", pr: "Acme/agent-app#101",
      url: "https://github.com/Acme/agent-app/pull/101", focus: FOCUS, acceptance: ACCEPTANCE,
      deliver: "post", reviewEvents: ["COMMENT", "REQUEST_CHANGES"],
    });
  });

  it("hands the review back without posting when Lead asks for deliver=return", async () => {
    const { db, createTask } = setup();
    const result = await createTask.execute("c", {
      title: "评审 PR #101", brief: "", template: "pr_review", deliver: "return",
      pr_review: { pr: "Acme/agent-app#101", focus: FOCUS, acceptance: ACCEPTANCE },
    });
    const item = getItem(db, Number(/#(\d+)/.exec(result.content[0].text)![1]))!;
    for (const rule of prReviewGuardrails("return", "Acme/agent-app#101")) expect(item.brief).toContain(rule);
    expect(item.brief).toContain("不要自己往 GitHub 发评审");
    expect(item.brief).toContain("「path:line — 评论正文」");
    expect(item.brief).not.toContain("add_comment_to_pending_review");
  });

  it("refuses the template without the PR and the user's words", async () => {
    const { createTask } = setup();
    await expect(createTask.execute("c", { title: "t", brief: "", template: "pr_review" })).rejects.toThrow(/needs pr_review/);
  });
});

describe("the run's runtime and model in the child environment", () => {
  it("are given to every child, so a review comment can say which model wrote it", async () => {
    const { db } = setup();
    const dir = tempDir("plc-pr-review-run-");
    const itemId = Number(db.prepare("INSERT INTO items (title, brief, created_by, stage) VALUES ('t','b','user','ready')").run().lastInsertRowid);
    let captured: RuntimeStartRequest | null = null;
    const runtime: AgentRuntime = {
      id: "codex",
      capabilities: { streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: true },
      async start(request): Promise<RuntimeHandle> {
        captured = request;
        return {
          pid: null, events: (async function* () {})(), interrupt: async () => {},
          wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
        };
      },
    };
    await runItem(db, itemId, { dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "s"), prompt: "p", runtime, model: "gpt-5.5", lingerMs: 0 });
    expect(captured!.env).toMatchObject({ PLC_RUN_RUNTIME: "codex", PLC_RUN_MODEL: "gpt-5.5", PLC_TICKET_ID: String(itemId) });
  });
});

// 评审 agent 自己发评审时，写入只限这个 PR（lead-self-routing spec B，用户 2026-10-28 选 1a）：PR 里别人写的文字
// 没法让它往别的 PR、别的仓库、别的系统写。连接中心按 Run 的权限清单检查每一次调用（store 的 run_grants）。
describe("the run of a review that posts itself", () => {
  async function reviewRun(params: Record<string, unknown>): Promise<{ db: Db; runId: number }> {
    const { db, createTask } = setup();
    const dir = tempDir("plc-pr-review-grant-");
    const result = await createTask.execute("c", {
      title: "评审 PR #101", brief: "", template: "pr_review",
      pr_review: { pr: "Acme/agent-app#101", focus: FOCUS, acceptance: ACCEPTANCE }, ...params,
    });
    const itemId = Number(/#(\d+)/.exec(result.content[0].text)![1]);
    const runtime: AgentRuntime = {
      id: "claude",
      capabilities: { streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: true },
      async start(): Promise<RuntimeHandle> {
        return {
          pid: null, events: (async function* () {})(), interrupt: async () => {},
          wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
        };
      },
    };
    await runItem(db, itemId, { dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "s"), prompt: "p", runtime, lingerMs: 0 });
    const run = db.prepare("SELECT id FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(itemId) as { id: number };
    return { db, runId: run.id };
  }
  const target = { owner: "Acme", repo: "agent-app", pullNumber: 101 };
  const write = (tool: string, facts: Record<string, unknown>) => ({ connection: "github", tool, readOnly: false, facts });

  it("writes reviews and inline comments on this PR only, with COMMENT or REQUEST_CHANGES", async () => {
    const { db, runId } = await reviewRun({});
    const grant = getRunGrant(db, runId)!.grant;
    expect(checkGrantCall(grant, write("add_comment_to_pending_review", target)).ok).toBe(true);
    expect(checkGrantCall(grant, write("pull_request_review_write", { ...target, method: "create" })).ok).toBe(true);
    expect(checkGrantCall(grant, write("pull_request_review_write", { ...target, method: "submit_pending", event: "REQUEST_CHANGES" })).ok).toBe(true);
    // PR 里的文字让它去别处写：都被拒绝。
    expect(checkGrantCall(grant, write("pull_request_review_write", { ...target, method: "submit_pending", event: "APPROVE" })).ok).toBe(false);
    expect(checkGrantCall(grant, write("add_comment_to_pending_review", { ...target, pullNumber: 200 })).ok).toBe(false);
    expect(checkGrantCall(grant, write("issue_write", { owner: "Acme", repo: "infra" })).ok).toBe(false);
    expect(checkGrantCall(grant, write("merge_pull_request", target)).ok).toBe(false);
    expect(checkGrantCall(grant, { connection: "notion", tool: "notion-create-pages", readOnly: false, facts: {} }).ok).toBe(false);
  });

  it("can approve only when Lead asked for it, and writes nothing when the review is handed back", async () => {
    const approving = await reviewRun({ review_events: ["COMMENT", "APPROVE"] });
    const grant = getRunGrant(approving.db, approving.runId)!.grant;
    expect(checkGrantCall(grant, write("pull_request_review_write", { ...target, method: "submit_pending", event: "APPROVE" })).ok).toBe(true);
    // deliver=return：只交回，不发。清单只有读这个仓库，任何写入都被拒绝。
    const handedBack = await reviewRun({ deliver: "return" });
    const readOnly = getRunGrant(handedBack.db, handedBack.runId)!.grant;
    expect(checkGrantCall(readOnly, write("add_comment_to_pending_review", target)).ok).toBe(false);
    expect(checkGrantCall(readOnly, { connection: "github", tool: "pull_request_read", readOnly: true, facts: target }).ok).toBe(true);
  });
});
