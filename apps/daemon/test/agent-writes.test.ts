// 子 agent 经连接中心的写操作记进动作层（landing.md C3，src/agent-writes.ts）。真实的 ConnectionHub、假 GitHub、真实 SQLite：
//   - 每一次写操作在工单上记一条活动（Lead 派的子 agent 代你，凭哪一条规则）；
//   - 别人看得到的（提交了的 review）另记一条主人操作 connection.agent_write，推给你：Lead 代你的那一种（「撤销」，不作废凭证）；
//     没提交的 pending review 和加进去的行内评论只记活动；
// 「撤销」的结果（撤不回，给链接，不作废凭证）在网关的 run-grant-undo.test.ts。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ConnectionHub, Vault } from "@pi-lead-child/connections";
import { FAKE_GH_TOKEN, FakeGithub } from "@pi-lead-child/connections/testing";
import {
  computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND,
} from "@pi-lead-child/protocol";
import {
  createItem, createRun, insertRunGrant, listActivities, listEvents, listNotifications, listRunWrites, openDb, type Db,
} from "@pi-lead-child/store";
import { recordAgentWrite } from "../src/agent-writes.js";

const PR = { owner: "Acme", repo: "x", number: 101 };
const DIFF = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", " const a = 1;", "+const b = 2;"].join("\n");
const prArgs = { owner: PR.owner, repo: PR.repo, pullNumber: PR.number };

let db: Db;
let gh: FakeGithub;

beforeEach(() => {
  db = openDb(join(tempDir("plc-agent-writes-"), "plc.db"));
  gh = new FakeGithub();
  gh.addPullRequest({ ...PR, title: "t", body: "b", headSha: "a".repeat(40), diff: DIFF });
});

async function hub(): Promise<ConnectionHub> {
  const h = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:1/cb",
    fetch: gh.fetch, gh: { token: async () => FAKE_GH_TOKEN }, ghInstalled: () => true,
    onAgentWrite: (write) => recordAgentWrite(db, write),
  });
  await h.start("github");
  return h;
}

function reviewRun(): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "slack 代码 review：王小明 的请求", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  const { grant } = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo: () => null });
  insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
  return { itemId, runId };
}

async function postReview(h: ConnectionHub, runId: number): Promise<void> {
  const options = { role: "executor" as const, runId };
  await h.callTool("github", "pull_request_review_write", { ...prArgs, method: "create" }, options);
  await h.callTool("github", "add_comment_to_pending_review", { ...prArgs, path: "a.ts", line: 2, side: "RIGHT", subjectType: "LINE", body: "b 没用到" }, options);
  await h.callTool("github", "pull_request_review_write", { ...prArgs, method: "submit_pending", event: "COMMENT", body: "看过了" }, options);
}

describe("recording a sub-agent's writes in the action layer", () => {
  it("records every write on the ticket, and the visible one as an owner action pushed to the user", async () => {
    const h = await hub();
    const { itemId, runId } = reviewRun();
    await postReview(h, runId);

    const activities = listActivities(db, itemId).map((row) => ({ actor: row.actor, payload: JSON.parse(String(row.payload)) }))
      .filter((row) => row.payload.decision === "agent_write");
    expect(activities.map((row) => [row.actor, row.payload.summary, row.payload.visible])).toEqual([
      ["lead", "在 Acme/x#101 上建了一个没提交的 review", false],
      ["lead", "在 Acme/x#101 的 review 里加了一条行内评论（a.ts:2）", false],
      ["lead", "在 Acme/x#101 上提交了 review（COMMENT）", true],
    ]);
    expect(activities[2]!.payload).toMatchObject({ by: "sub_agent", onBehalfOf: "user", authority: "grant", ruleId: "review:acme/x#101:comment" });
    expect(listRunWrites(db, runId).map((call) => call.visible)).toEqual([false, false, true]);

    const performed = listEvents(db, { kind: "owner_action.performed" });
    expect(performed).toHaveLength(1);
    expect(performed[0]!).toMatchObject({
      entityKey: `run:${runId}`,
      payload: {
        action: "connection.agent_write",
        summary: "Paimon 派的子 agent 代你在 Acme/x#101 上提交了 review（COMMENT）",
        credential: { bindingId: 0, kind: "agent" },
        source: { client: "agent" },
        delivery: "push",
        detail: { url: "https://github.com/Acme/x/pull/101", ruleId: "review:acme/x#101:comment" },
        undo: { kind: "connection_write", runId, url: "https://github.com/Acme/x/pull/101" },
      },
    });
    const [notification] = listNotifications(db, { state: ["pending"] });
    expect(notification).toMatchObject({ kind: OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND, urgency: "immediate" });
    expect(notification!.body).toContain("Paimon 派的子 agent 按工单");
    expect(notification!.body).toContain("链接：https://github.com/Acme/x/pull/101");
  });
});
