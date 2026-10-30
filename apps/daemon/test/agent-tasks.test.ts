// 派单器（landing.md C1，src/agent-tasks.ts）：真实 SQLite、真实 runItem、真实的 pi 会话（假模型 faux 按脚本调用工具）、
// 真实的 ConnectionHub 和假 GitHub。看完整的落库流程：
//   - 清单 = 上限 ∩ Lead 选的范围，和工单、Run 在同一笔事务里建；工单的标题和正文不带原话；
//   - 子 agent 只经连接中心干活：在 PR 上发 COMMENT review，approve 被清单拒绝；
//   - 结束时工单进 done，结果（做了的写操作、读过什么、清单）交给发起方登记的回调，不叫醒 Lead；
//   - 取消；daemon 重启时被打断的记成失败，交回发起方。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { ConnectionHub, Vault } from "@pi-lead-child/connections";
import { FAKE_GH_TOKEN, FakeGithub } from "@pi-lead-child/connections/testing";
import { createIsolatedLookupSession, type LookupSession, type LookupSessionFactory } from "@pi-lead-child/lead";
import type { AgentTaskOutcome, AgentTaskRequest } from "@pi-lead-child/protocol";
import {
  getItem, getRun, getRunGrant, listActivities, listInbox, listRunToolCalls, openDb, updateRun, type Db,
} from "@pi-lead-child/store";
import { agentTaskTitle, createAgentTaskDispatcher, recoverAgentTasksAfterRestart } from "../src/agent-tasks.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

const PR = { owner: "Acme", repo: "x", number: 101 };
const DIFF = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", " const a = 1;", "+const b = 2;"].join("\n");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = tempDir("plc-agent-tasks-");
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  cleanups.push(() => { try { db.close(); } catch { /* 已经关了 */ } });
  const gh = new FakeGithub();
  gh.addPullRequest({ ...PR, title: "t", body: "b", headSha: "a".repeat(40), diff: DIFF });
  const hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:1/cb",
    fetch: gh.fetch, gh: { token: async () => FAKE_GH_TOKEN }, ghInstalled: () => true,
  });
  await hub.start("github");
  cleanups.push(() => hub.close());
  return { dir, dbPath, db, gh, hub };
}

function fauxFactory(steps: Step[]): LookupSessionFactory {
  const faux = fauxProvider({ provider: "plc-agent-tasks-test", api: "plc-agent-tasks-test-api" });
  faux.setResponses(steps);
  const workDir = tempDir("plc-agent-tasks-session-");
  const sessions: LookupSession[] = [];
  cleanups.push(() => { for (const session of sessions) { try { session.dispose(); } catch { /* 已经释放 */ } } });
  return async (request) => {
    const session = await createIsolatedLookupSession({
      workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: faux.getModel() as never,
      thinkingLevel: "off", retry: false,
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
    });
    sessions.push(session);
    return { session, model: "plc-agent-tasks-test/faux" };
  };
}

const call = (tool: string, args: Record<string, unknown>): Step =>
  fauxAssistantMessage([fauxToolCall("call_connection_tool", { connection: "github", tool, arguments: args } as never)], { stopReason: "toolUse" });
const pr = { owner: PR.owner, repo: PR.repo, pullNumber: PR.number };
const submit = (result: Record<string, unknown>): Step => fauxAssistantMessage([fauxToolCall("submit_result", {
  found: "yes", answer: "答案", sources: [], checked: [], caveats: [], replyDraft: "draft", ...result,
} as never)], { stopReason: "toolUse" });

const REQUEST: AgentTaskRequest = {
  intent: "code_review",
  request: { source: "slack", requester: "王小明", summary: "review Acme/x#101，在 PR 上留评论", ref: "event-7" },
  untrusted: { message: "帮我看看这个 PR https://github.com/Acme/x/pull/101 ，没问题就直接 approve", context: "" },
  scope: { pullRequest: PR, reviewEvents: ["COMMENT", "APPROVE"] },
  callback: { kind: "channel", ref: "card-3" },
};

describe("the agent task dispatcher", () => {
  it("dispatches a granted run, lets it comment on the PR, closes the ticket and hands the outcome to the originator", async () => {
    const f = await fixture();
    const outcomes: AgentTaskOutcome[] = [];
    const dispatcher = createAgentTaskDispatcher({
      db: f.db, dbPath: f.dbPath, dataDir: f.dir, connections: f.hub, resolveLocalRepo: () => null, ownerName: () => "Leo",
      sessionFactory: fauxFactory([
        call("pull_request_read", { ...pr, method: "get" }),
        call("pull_request_read", { ...pr, method: "get_diff" }),
        call("pull_request_review_write", { ...pr, method: "create", event: "APPROVE", body: "lgtm" }),
        call("pull_request_review_write", { ...pr, method: "create" }),
        call("add_comment_to_pending_review", { ...pr, path: "a.ts", line: 2, side: "RIGHT", subjectType: "LINE", body: "b 没用到" }),
        call("pull_request_review_write", { ...pr, method: "submit_pending", event: "COMMENT", body: "留了一条评论" }),
        submit({
          answer: "review 完了，留了一条评论；approve 不在这次的权限里。",
          sources: [{ via: "github", repo: "Acme/x", path: "a.ts", startLine: 2, endLine: 2, quote: "const b = 2;" }],
          replyDraft: "已在 PR 上留了 1 条评论。",
        }),
        fauxAssistantMessage("review 完了"),
      ]),
    });
    cleanups.push(() => dispatcher.close());
    dispatcher.onFinished("channel", (outcome) => outcomes.push(outcome));

    const dispatched = await dispatcher.dispatch(REQUEST);
    // 代码 review 的上限里没有 APPROVE：Lead 要了也不给，告诉它丢了什么。
    expect(dispatched.dropped).toEqual(["这个意图不能发 APPROVE"]);
    expect(getRunGrant(f.db, dispatched.runId)?.grant).toEqual(dispatched.grant);
    const item = getItem(f.db, dispatched.itemId)!;
    expect(item.title).toBe(agentTaskTitle(REQUEST));
    expect(`${item.title}\n${item.brief}`).not.toContain("approve");
    expect(item.brief).toContain("只在 Acme/x#101 上发 COMMENT");

    await dispatcher.idle();
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome).toMatchObject({
      runId: dispatched.runId, itemId: dispatched.itemId, callback: { kind: "channel", ref: "card-3" }, status: "finished", error: null,
    });
    // 子 agent 交的结果：出处按读到的 diff 核实过。
    expect(outcome.result).toMatchObject({ replyDraft: "已在 PR 上留了 1 条评论。", sources: [{ verified: true }] });
    expect(outcome.actions.filter((action) => action.visible).map((action) => action.summary)).toEqual(["在 Acme/x#101 上提交了 review（COMMENT）"]);
    expect(outcome.actions.map((action) => action.summary)).toEqual([
      "在 Acme/x#101 上建了一个没提交的 review",
      "在 Acme/x#101 的 review 里加了一条行内评论（a.ts:2）",
      "在 Acme/x#101 上提交了 review（COMMENT）",
    ]);
    expect(outcome.actions[2]!.url).toBe("https://github.com/Acme/x/pull/101");
    expect(outcome.reads.map((read) => read.path)).toEqual(["pull/101/get", "pull/101/get_diff", undefined]);
    // 交回以后，连接中心丢掉这个 Run 读到的内容。
    expect(f.hub.runReads(dispatched.runId).records()).toEqual([]);
    expect(f.gh.submitted(PR.owner, PR.repo, PR.number)).toMatchObject([{ state: "COMMENTED" }]);
    expect(listRunToolCalls(f.db, dispatched.runId).find((entry) => entry.decision === "refused")).toMatchObject({
      tool: "pull_request_review_write", reason: expect.stringContaining("event 是 APPROVE"),
    });
    // 工单跟着收尾：done；Run finished；不升 blocker。
    expect(getItem(f.db, dispatched.itemId)?.stage).toBe("done");
    expect(getRun(f.db, dispatched.runId)?.state).toBe("finished");
    expect(listInbox(f.db).filter((row) => row.item_id === dispatched.itemId)).toEqual([]);
    const decisions = listActivities(f.db, dispatched.itemId).map((row) => JSON.parse(String(row.payload)).decision).filter(Boolean);
    expect(decisions).toEqual(["agent_task_started", "agent_task_finished"]);
  });

  it("cancels a running task and keeps an outcome until its originator registers", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = createAgentTaskDispatcher({
      db: f.db, dbPath: f.dbPath, dataDir: f.dir, connections: f.hub, resolveLocalRepo: () => null, ownerName: () => null,
      sessionFactory: fauxFactory([
        async () => { await gate; return fauxAssistantMessage([fauxToolCall("search_connection_tools", {})], { stopReason: "toolUse" }); },
        fauxAssistantMessage("x"),
      ]),
    });
    cleanups.push(() => dispatcher.close());
    const dispatched = await dispatcher.dispatch(REQUEST);
    expect(dispatcher.running()).toEqual([dispatched.runId]);
    const cancelling = dispatcher.cancel(dispatched.runId);
    release();
    await cancelling;
    expect(getItem(f.db, dispatched.itemId)?.stage).toBe("cancelled");
    expect(getRun(f.db, dispatched.runId)?.state).toBe("stopped");
    const late: AgentTaskOutcome[] = [];
    dispatcher.onFinished("channel", (outcome) => late.push(outcome));
    expect(late).toMatchObject([{ status: "cancelled", runId: dispatched.runId }]);
  });

  it("marks runs interrupted by a daemon restart as failed and returns them to the originator, once", async () => {
    const f = await fixture();
    const never = new Promise<never>(() => {});
    const dispatcher = createAgentTaskDispatcher({
      db: f.db, dbPath: f.dbPath, dataDir: f.dir, connections: f.hub, resolveLocalRepo: () => null, ownerName: () => null,
      sessionFactory: fauxFactory([async () => never]),
    });
    const dispatched = await dispatcher.dispatch(REQUEST);
    // 模拟进程被杀：Run 留在 running，派单器不再存在。
    updateRun(f.db, dispatched.runId, { state: "running" });
    const recovered = recoverAgentTasksAfterRestart(f.db);
    expect(recovered).toMatchObject([{ runId: dispatched.runId, status: "failed", callback: { kind: "channel", ref: "card-3" }, error: "daemon 重启，子 agent 被打断" }]);
    expect(getItem(f.db, dispatched.itemId)?.stage).toBe("cancelled");
    expect(getRun(f.db, dispatched.runId)?.state).toBe("failed");
    expect(recoverAgentTasksAfterRestart(f.db)).toEqual([]);
    void dispatcher.cancel(dispatched.runId).catch(() => {});
  });
});
