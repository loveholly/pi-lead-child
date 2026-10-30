// 工单「这次交付」的 HTTP 面（2026-10-20）：用户在工单详情里看改动、点「验收并合并」，
// 走完整的持久化流程（真的 git 仓库、真的用户操作服务）。合并做不成时工单不被标成完成。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import {
  createItem, createPairing, createRun, getItem, insertOutcomeSnapshot, normalizeOutcomePayload, openDb, transition, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { createAgentToolHandlers, liveChildren, prepareRunWorkspace } from "@pi-lead-child/engine";
import {
  TicketDeliveriesResponseSchema, TicketDeliveryResponseSchema, TicketDeliverySnapshotResponseSchema,
} from "@pi-lead-child/protocol";
import { Value } from "typebox/value";

let db: Db;
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-delivery-http-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
});
afterEach(() => db.close());

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    userActions: createUserActionService({ db, resumeRun: () => {} }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "delivery-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

// 一张交付了、停在 review 的写代码工单（用户验收，不要求独立核查）。
function deliveredTicket(): number {
  const itemId = createItem(db, { title: "写方案", brief: "b", createdBy: "lead", workdir: repo });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  mkdirSync(join(workspace.path, "docs"));
  writeFileSync(join(workspace.path, "docs", "plan.md"), "# 方案\n");
  git(workspace.path, "add", "-A");
  git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "plan");
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "c".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "写了方案。", changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增" }],
      deliverables: [{ kind: "path", ref: "docs/plan.md", label: "方案" }], validations: [],
    }, { workdir: workspace.path }),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return itemId;
}

describe("the delivery routes", () => {
  it("lets the user read the change, then accept and merge it in one step", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const itemId = deliveredTicket();

      const view = await fetch(`${server.base}/v1/tickets/${itemId}/delivery`, { headers: auth });
      expect(view.status).toBe(200);
      const { delivery } = await view.json() as { delivery: { files: Array<{ path: string; label: string }>; actions: { merge: unknown } } };
      expect(delivery.files).toMatchObject([{ path: "docs/plan.md", label: "方案" }]);
      expect(delivery.actions.merge).toEqual({ available: true, reason: null, acceptsTicket: true });

      const file = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/file?path=docs%2Fplan.md&view=full`, { headers: auth });
      expect(await file.json()).toMatchObject({ file: { path: "docs/plan.md", language: "markdown", text: "# 方案\n" } });

      const merged = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
      });
      expect(merged.status).toBe(200);
      expect(await merged.json()).toMatchObject({ action: "merge", delivery: { workspace: { integration: "merged", mergedInto: "main" } } });
      expect(getItem(db, itemId)?.stage).toBe("done");
      expect(git(repo, "show", "HEAD:docs/plan.md")).toBe("# 方案");
    } finally {
      await server.close();
    }
  });

  it("keeps the ticket in review when the merge cannot happen, and explains why", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const itemId = deliveredTicket();
      writeFileSync(join(repo, "README.md"), "the user's unsaved work\n");

      const response = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "conflict", message: "你的仓库在 main 上有没提交的改动。先提交或暂存，再合并。", details: { reason: "unavailable" } },
      });
      expect(getItem(db, itemId)?.stage).toBe("review");
    } finally {
      await server.close();
    }
  });

  // 回归（工单 03 审查 M2）：合并在验收以后才失败（用户仓库拒绝合并提交）。回 409，可工单已经是 done：
  // 照样通知客户端刷新（ticket.updated），照样记一次主人操作（「不是我」要能撤销这次验收）。
  it("announces the acceptance and records the owner action when the merge fails after accepting", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const itemId = deliveredTicket();
      // main 上多一个不冲突的提交：合并要建一个合并提交，钩子拒绝它。
      writeFileSync(join(repo, "OTHER.md"), "other\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "other work");
      writeFileSync(join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const events = () => (db.prepare("SELECT COUNT(*) AS n FROM gateway_events WHERE item_id=? AND event_type='ticket.updated'")
        .get(itemId) as { n: number }).n;
      const before = events();

      const response = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "conflict", details: { reason: "failed" } } });
      expect(getItem(db, itemId)?.stage).toBe("done");
      expect(events()).toBeGreaterThan(before);
      const owner = db.prepare("SELECT payload FROM events WHERE kind='owner_action.performed'").all() as Array<{ payload: string }>;
      expect(owner.map((row) => JSON.parse(row.payload).action)).toEqual(["ticket.complete"]);
    } finally {
      await server.close();
    }
  });

  // 回归（2026-10-21 审查 M2）：请求带上用户看到的 head 和 target。对不上时 409（details.reason 是 stale），
  // 客户端刷新以后再让用户决定；格式不对时 400。
  it("refuses a merge of a delivery that changed since the user looked, and malformed expectations", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const headers = { ...auth, "content-type": "application/json" };
      const itemId = deliveredTicket();
      const { delivery } = await (await fetch(`${server.base}/v1/tickets/${itemId}/delivery`, { headers: auth })).json() as {
        delivery: { workspace: { head: string; target: string } };
      };
      expect(delivery.workspace).toMatchObject({ head: expect.stringMatching(/^[0-9a-f]{40}$/), target: "main" });
      const merge = (body: unknown) => fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers, body: JSON.stringify(body),
      });

      const stale = await merge({ expectedHead: "0".repeat(40), expectedTarget: "main" });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "conflict", details: { reason: "stale" } } });
      for (const body of [{ expectedHead: 42 }, { expectedTarget: "x".repeat(300) }, { expectedHead: "not a sha" }]) {
        expect((await merge(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(getItem(db, itemId)?.stage).toBe("review");

      const merged = await merge({ expectedHead: delivery.workspace.head, expectedTarget: delivery.workspace.target });
      expect(merged.status).toBe(200);
      expect(getItem(db, itemId)?.stage).toBe("done");
    } finally {
      await server.close();
    }
  });

  it("refuses paths outside the delivery, callers that claim to be Lead, and viewers without write access", async () => {
    const server = await start();
    try {
      const viewer = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const writer = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const itemId = deliveredTicket();

      const traversal = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/file?path=..%2Fplc.db`, { headers: viewer });
      expect(traversal.status).toBe(400);
      const outside = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/file?path=README.md`, { headers: viewer });
      expect(outside.status).toBe(404);

      const readOnly = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers: { ...viewer, "content-type": "application/json" }, body: "{}",
      });
      expect(readOnly.status).toBe(403);
      const asLead = await fetch(`${server.base}/v1/tickets/${itemId}/delivery/merge`, {
        method: "POST", headers: { ...writer, "content-type": "application/json" }, body: JSON.stringify({ actor: "lead" }),
      });
      expect(asLead.status).toBe(403);
      expect(getItem(db, itemId)?.stage).toBe("review");
    } finally {
      await server.close();
    }
  });
});

// 交付快照（工单 04，spec 5.5、D8）：执行 agent 交付的那一刻系统存下 diff。worktree 和分支清掉以后，交付视图和交付切换
// 照样能读到文件列表。走完整的持久化流程：真的 ticket_update 工具、真的 git、真的 HTTP 和严格的协议校验。
describe("the delivery snapshot routes", () => {
  async function deliverThroughTheTool(): Promise<{ itemId: number; runId: number; worktree: string; branch: string }> {
    const itemId = createItem(db, { title: "写方案", brief: "b", createdBy: "lead", workdir: repo });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
    mkdirSync(join(workspace.path, "docs"));
    writeFileSync(join(workspace.path, "docs", "plan.md"), "# 方案\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "plan");
    const runId = createRun(db, { itemId, runtime: "claude", workspaceId: workspace.id });
    updateRun(db, runId, { state: "running" });
    await createAgentToolHandlers({ db, itemId, runId }).call("ticket_update", {
      status: "review", reason: "实现完成",
      checkpoint: {
        kind: "completed", stage: "implementation", title: "实现完成", summary: "写了方案。",
        key_facts: [], artifact_refs: [], related_ticket_ids: [], next_step: "等核查",
        outcome: {
          summary: "写了方案。", changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增" }], deliverables: [], validations: [],
        },
      },
    });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    return { itemId, runId, worktree: workspace.path, branch: workspace.branch! };
  }

  it("still shows the delivered files after the worktree and the branch are removed", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const { itemId, runId, worktree, branch } = await deliverThroughTheTool();
      git(repo, "worktree", "remove", "--force", worktree);
      git(repo, "branch", "-D", branch);
      db.prepare("UPDATE workspaces SET state='archived' WHERE owner_item_id=?").run(itemId);

      const view = await (await fetch(`${server.base}/v1/tickets/${itemId}/delivery`, { headers: auth })).json();
      expect(Value.Check(TicketDeliveryResponseSchema, view)).toBe(true);
      expect((view as { delivery: { files: unknown[] } }).delivery.files).toMatchObject([{ path: "docs/plan.md", status: "added", note: "新增" }]);

      const list = await fetch(`${server.base}/v1/tickets/${itemId}/deliveries`, { headers: auth });
      expect(list.status).toBe(200);
      const deliveries = await list.json();
      expect(Value.Check(TicketDeliveriesResponseSchema, deliveries)).toBe(true);
      expect(deliveries).toMatchObject({ deliveries: [{ sequence: 1, attemptId: runId, revisions: 1, reason: "delivered", source: "git" }] });

      const one = await fetch(`${server.base}/v1/tickets/${itemId}/deliveries/1`, { headers: auth });
      expect(one.status).toBe(200);
      const snapshot = await one.json();
      expect(Value.Check(TicketDeliverySnapshotResponseSchema, snapshot)).toBe(true);
      expect(snapshot).toMatchObject({
        delivery: {
          ticketId: itemId, sequence: 1, revision: 1, attemptId: runId, commitCount: 1,
          files: [{ path: "docs/plan.md", status: "added", additions: 1, note: "新增", generated: null, hiddenReason: null }],
          totals: { files: 1, additions: 1, deletions: 0 },
        },
      });
      // 协议不下发服务器上的路径。
      expect(JSON.stringify(snapshot)).not.toContain(dir);
      const firstRevision = await fetch(`${server.base}/v1/tickets/${itemId}/deliveries/1?revision=1`, { headers: auth });
      expect(firstRevision.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("answers a delivery that does not exist, a malformed number and a caller without a token", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const { itemId } = await deliverThroughTheTool();
      const missing = await fetch(`${server.base}/v1/tickets/${itemId}/deliveries/2`, { headers: auth });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "not_found", details: { reason: "not_found" } } });
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/deliveries/1?revision=2`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${server.base}/v1/tickets/999/deliveries`, { headers: auth })).status).toBe(404);
      for (const path of [`deliveries/0`, `deliveries/1?revision=0`, `deliveries/1?revision=x`]) {
        expect((await fetch(`${server.base}/v1/tickets/${itemId}/${path}`, { headers: auth })).status, path).toBe(400);
      }
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/deliveries`)).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
