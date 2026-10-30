// 工单操作层的验收（工单详情 spec 5.11，实现工单 03）：页面上每个会改后端的操作只有一份实现、两个入口。
// 每个搬进来的操作在两份一模一样的库上各做一次：一次从页面入口（网关的 POST /v1/tickets/:id/actions/:action，你本人），
// 一次从 Lead 入口（ticket_action 工具，Lead 在你这一轮里）。两边账本里的效果一样，只是 actor 不同：
//   - 你：actor=user。
//   - Lead 代你做只属于你的操作：actor=lead，带 onBehalfOf=user 和那一轮的 id，不写成 actor=user。
//   - Lead 自己能做的操作：actor=lead，不带 onBehalfOf。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService, createUserActionService, startPairedServer } from "@pi-lead-child/gateway";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { liveChildren, prepareRunWorkspace, type PullRequestRunner } from "@pi-lead-child/engine";
import { computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, type TicketActionId } from "@pi-lead-child/protocol";
import {
  addAcceptanceCriteria, confirmCriterion, createItem, createLoopbackBinding, createPairing, createRun, createTurn, getItem,
  insertOutcomeSnapshot, insertRunGrant, linkTickets, normalizeOutcomePayload, openDb, recordDeliverySnapshot, redeemPairing, transition,
  updateRun, type Db,
} from "@pi-lead-child/store";

interface Side { db: Db; dir: string; close(): Promise<void> }
const opened: Side[] = [];
afterEach(async () => {
  for (const side of opened.splice(0)) await side.close();
  liveChildren().clear();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const gh: PullRequestRunner = {
  async gh() { return { ok: true, stdout: "https://github.com/acme/repo/pull/7\n", stderr: "" }; },
};
const resumed: number[] = [];
// 打开文件用假的 opener（工单 07）：测试不真的调用 macOS 的 open。
const openedFiles: string[] = [];
// 开始执行（P03）：页面和 Lead 都调宿主的 startRun（daemon 里是 spawnItemChild）。这里只记下来，不真的拉起进程。
const started: number[] = [];
const host = {
  resumeRun: ({ runId }: { runId: number }) => { resumed.push(runId); },
  startRun: (itemId: number) => { started.push(itemId); },
  openFile: { supported: true, async open(path: string) { openedFiles.push(path); } },
};

// ── 夹具：两边各建一份，同样的顺序，所以编号也一样 ───────────────────────────────────────

function ready(db: Db): number {
  return createItem(db, { title: "待开始", brief: "b", createdBy: "lead" });
}

// 执行者是 Claude Code 上的 opus（工单 08）。
function claudeTicket(db: Db): number {
  const itemId = ready(db);
  db.prepare("UPDATE items SET requested_runtime='claude', requested_model='opus' WHERE id=?").run(itemId);
  return itemId;
}

function delivered(db: Db): { itemId: number; runId: number } {
  const itemId = ready(db);
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return { itemId, runId };
}

// 一张要求独立核查、交付了的工单（工单 11：托管只对它）。
function deliveredIndependent(db: Db): number {
  const itemId = createItem(db, { title: "要独立核查", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return itemId;
}

// 交付了，核查没做成：核查 Run 失败了，没有结论（工单 11）。
function reviewFailed(db: Db): number {
  const { itemId } = delivered(db);
  const reviewerRunId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude" });
  updateRun(db, reviewerRunId, { state: "failed", endedAt: true, errorCode: "runtime_exit", errorMessage: "timeout" });
  return itemId;
}

function runningRun(db: Db): { itemId: number; runId: number } {
  const itemId = ready(db);
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running", sessionId: "s" });
  return { itemId, runId };
}

// 一张交付了的写代码工单：真的 git 仓库、隔离 worktree，origin 是本机的裸仓库（开 PR 要推上去）。
function deliveredCode(db: Db, dir: string, stage: "review" | "done"): number {
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  execFileSync("git", ["init", "-q", "--bare", join(dir, "remote.git")]);
  git(repo, "remote", "add", "origin", join(dir, "remote.git"));
  git(repo, "push", "-q", "origin", "main");
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
  if (stage === "done") transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
  return itemId;
}

// 一张有验收标准、交付了、快照也存好了的工单（工单 05）。confirmed=true 时你已经在这次交付上确认了第一条。
function deliveredWithCriteria(db: Db, confirmed = false): { itemId: number; criterionId: number } {
  const itemId = ready(db);
  const [criterion] = addAcceptanceCriteria(db, { itemId, texts: ["空输入返回 400", "错误信息写明字段名"], by: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "f".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  const { snapshot } = recordDeliverySnapshot(db, {
    itemId, executorRunId: runId, reason: "delivered", source: "agent", baseSha: null, headSha: null,
    commits: [], commitCount: 0, files: [], totals: null, truncated: false, uncommittedFiles: null,
  });
  if (confirmed) {
    confirmCriterion(db, { itemId, criterionId: criterion!.id, executorRunId: runId, deliverySnapshotId: snapshot!.id, by: "user" });
  }
  return { itemId, criterionId: criterion!.id };
}

interface Case {
  action: TicketActionId;
  // 建好夹具，返回要操作的工单和这次的输入。
  fixture(db: Db, dir: string): { itemId: number; input?: Record<string, unknown> };
  // Lead 凭什么做：on_behalf（只属于你的、对外的、不可逆的）或 lead（Lead 自己的权限）。
  // user_direct（授权托管，工单 11）：只有你本人能做，Lead 调用总是被拒，什么都不写。
  authority: "on_behalf" | "lead" | "user_direct";
  // 你本人做时记一次主人操作（「不是我」）；Lead 代你做时也记，记在那一轮来自的凭证名下。Lead 自己做的不记。
  ownerAction?: string;
}

const CASES: Case[] = [
  { action: "confirm", authority: "on_behalf", ownerAction: "ticket.confirm",
    fixture: (db) => ({ itemId: createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true }) }) },
  // 生命周期的其余操作（ui-action-parity plan.md P03）。
  { action: "start", authority: "lead", fixture: (db) => ({ itemId: ready(db) }) },
  { action: "stop", authority: "lead", ownerAction: "ticket.stop", fixture: (db) => ({ itemId: runningRun(db).itemId }) },
  { action: "unconfirm", authority: "on_behalf", fixture: (db) => ({ itemId: ready(db) }) },
  { action: "restore", authority: "on_behalf", fixture: (db) => {
    const itemId = ready(db);
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "x" });
    return { itemId };
  } },
  // 取消已经交付的工单：2026-10-28 起 lead 也能走 review → cancelled（由 Lead 判断），所以是 Lead 自己做的。
  { action: "cancel", authority: "lead", ownerAction: "ticket.cancel", fixture: (db) => ({ itemId: delivered(db).itemId }) },
  { action: "set_priority", authority: "lead", fixture: (db) => ({ itemId: ready(db), input: { priority: "urgent" } }) },
  { action: "set_project", authority: "lead", fixture: (db) => ({ itemId: ready(db), input: { project: "官网改版" } }) },
  { action: "set_due", authority: "lead", fixture: (db) => ({ itemId: ready(db), input: { dueAt: "2026-11-01T09:00:00.000Z" } }) },
  { action: "set_budget", authority: "on_behalf",
    fixture: (db) => ({ itemId: ready(db), input: { tokenBudget: 2_000_000, costBudgetUsd: 5 } }) },
  { action: "link", authority: "lead", fixture: (db) => {
    const itemId = ready(db);
    return { itemId, input: { targetTicketId: ready(db), relationType: "depends_on" } };
  } },
  { action: "unlink", authority: "lead", fixture: (db) => {
    const itemId = ready(db);
    const { relation } = linkTickets(db, { sourceTicketId: itemId, targetTicketId: ready(db), relationType: "relates_to", reason: "x", actor: "user" });
    return { itemId, input: { relationId: relation.id } };
  } },
  { action: "pause_run", authority: "on_behalf", ownerAction: "run.pause", fixture: (db) => ({ itemId: runningRun(db).itemId }) },
  { action: "resume_run", authority: "on_behalf", fixture: (db) => {
    const { itemId, runId } = runningRun(db);
    updateRun(db, runId, { state: "paused" });
    return { itemId };
  } },
  { action: "stop_run", authority: "lead", ownerAction: "run.stop", fixture: (db) => ({ itemId: runningRun(db).itemId }) },
  { action: "request_review", authority: "lead", fixture: (db) => ({ itemId: delivered(db).itemId }) },
  { action: "change_reviewer", authority: "lead", fixture: (db) => ({ itemId: delivered(db).itemId, input: { runtime: "claude" } }) },
  // 核查没做成时（工单 11）。
  { action: "retry_review", authority: "lead", fixture: (db) => ({ itemId: reviewFailed(db) }) },
  { action: "accept_without_review", authority: "on_behalf", ownerAction: "ticket.complete", fixture: (db) => ({ itemId: reviewFailed(db) }) },
  { action: "delegate", authority: "user_direct", ownerAction: "lead.delegation",
    fixture: (db) => ({ itemId: deliveredIndependent(db), input: { acceptWithoutReview: true, maxReworkCycles: 1 } }) },
  { action: "widen_grant", authority: "on_behalf", ownerAction: "run.grant", fixture: (db) => {
    const itemId = createItem(db, { title: "通道派的工单", brief: "b", createdBy: "system", purpose: "lookup" });
    const runId = createRun(db, { itemId, purpose: "lookup" });
    updateRun(db, runId, { state: "running" });
    const pullRequest = { owner: "Acme", repo: "x", number: 101 };
    insertRunGrant(db, {
      itemId, runId, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest },
      ...computeRunGrant({ intent: "code_review", scope: { pullRequest }, resolveLocalRepo: () => null }),
    });
    return { itemId, input: { scope: { pullRequest, reviewEvents: ["APPROVE"] } } };
  } },
  // 换模型和推理强度、换执行 agent（工单 08）。
  { action: "set_run_profile", authority: "lead",
    fixture: (db) => ({ itemId: claudeTicket(db), input: { role: "executor", model: "sonnet", effort: "low" } }) },
  { action: "change_executor_runtime", authority: "lead", fixture: (db) => ({ itemId: claudeTicket(db), input: { runtime: "codex" } }) },
  { action: "complete", authority: "on_behalf", ownerAction: "ticket.complete", fixture: (db) => ({ itemId: delivered(db).itemId }) },
  { action: "rework", authority: "on_behalf", fixture: (db) => ({ itemId: delivered(db).itemId }) },
  { action: "merge", authority: "on_behalf", ownerAction: "ticket.complete",
    fixture: (db, dir) => ({ itemId: deliveredCode(db, dir, "review") }) },
  { action: "set_auto_pr", authority: "lead", fixture: (db) => ({ itemId: ready(db), input: { enabled: false } }) },
  { action: "open_pr", authority: "on_behalf", fixture: (db, dir) => ({ itemId: deliveredCode(db, dir, "done") }) },
  { action: "abandon", authority: "on_behalf", fixture: (db, dir) => ({ itemId: deliveredCode(db, dir, "done") }) },
  { action: "open_delivery_file", authority: "on_behalf",
    fixture: (db, dir) => ({ itemId: deliveredCode(db, dir, "review"), input: { path: "docs/plan.md" } }) },
  // 验收标准（工单 05）。
  { action: "edit_acceptance_criteria", authority: "lead", fixture: (db) => {
    const { itemId, criterionId } = deliveredWithCriteria(db, true);
    return { itemId, input: { update: [{ id: criterionId, text: "空输入返回 400 和错误码" }], add: ["文档里写明这个错误码"] } };
  } },
  { action: "confirm_criterion", authority: "on_behalf", fixture: (db) => {
    const { itemId, criterionId } = deliveredWithCriteria(db);
    return { itemId, input: { criterionId } };
  } },
  { action: "unconfirm_criterion", authority: "on_behalf", fixture: (db) => {
    const { itemId, criterionId } = deliveredWithCriteria(db, true);
    return { itemId, input: { criterionId } };
  } },
];

// ── 两个入口 ────────────────────────────────────────────────────────────────────

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function viaPage(test: Case): Promise<Side & { before: Mark }> {
  const dir = tempDir(`plc-parity-page-${test.action}-`);
  const db = openDb(join(dir, "plc.db"));
  const { itemId, input } = test.fixture(db, dir);
  const before = mark(db);
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    userActions: createUserActionService({ db, ...host }),
    pullRequestRunner: gh,
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  const side = { db, dir, before, close: async () => { await server.close(); db.close(); } };
  opened.push(side);
  const token = redeemPairing(db, createPairing(db, { name: "web", kind: "companion", scopes: ["tickets:view", "tickets:create"] }).code).accessToken;
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/tickets/${itemId}/actions/${test.action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...(input ? { input } : {}), reason: "我在页面上点的" }),
  });
  expect({ action: test.action, status: response.status, body: response.status === 200 ? "ok" : await response.json() })
    .toEqual({ action: test.action, status: 200, body: "ok" });
  return side;
}

async function viaLead(test: Case): Promise<Side & { turnId: string; before: Mark }> {
  const dir = tempDir(`plc-parity-lead-${test.action}-`);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const { itemId, input } = test.fixture(db, dir);
  const before = mark(db);
  // 你在对话里说了这件事：一个进行中的、已配对用户的轮次。它来自的凭证就是「不是我」要作废的那个。
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  const turn = createTurn(db, { id: `turn-${test.action}`, originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
  const deps: LeadDeps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    currentTurnId: () => turn.id,
    ticketActionHost: host,
    pullRequestRunner: gh,
  };
  const tool = createLeadTools(deps).find((candidate) => candidate.name === "ticket_action")!;
  const result = await tool.execute("call", {
    ticket_id: itemId, action: test.action, ...(input ? { input } : {}), reason: "用户在对话里说了",
  } as never, undefined, undefined, undefined as never);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject(test.authority === "user_direct"
    ? { action: test.action, refused: true, refusal: { permission: "user_direct", where: expect.any(String) } }
    : { action: test.action, authority: test.authority });
  const side = { db, dir, before, turnId: turn.id, close: async () => { db.close(); } };
  opened.push(side);
  return side;
}

// ── 比较 ─────────────────────────────────────────────────────────────────────────

// 名字里写着是谁做的决定和派发：review_requested_by_user / _by_lead，user-review / lead-review。
const sameWho = (value: unknown) => (typeof value === "string" ? value.replace(/(_by_|^)(user|lead)(-review)?/g, "$1who$3") : value);

interface Row { kind: string; actor: string; from: unknown; to: unknown; decision: unknown; onBehalfOf: unknown; sourceTurnId: unknown }

// 账本：活动，加上截止节点的修改记录（截止节点没有活动行，谁改的记在 item_milestone_changes）。after 之后的是这次操作写的。
function ledger(db: Db, after: Mark = { activity: 0, milestone: 0 }): Row[] {
  const activities = (db.prepare("SELECT kind, actor, payload FROM activities WHERE id > ? ORDER BY id").all(after.activity) as
    Array<{ kind: string; actor: string; payload: string }>)
    .map((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return {
        kind: row.kind, actor: row.actor, from: payload.from, to: payload.to, decision: sameWho(payload.decision),
        onBehalfOf: payload.onBehalfOf, sourceTurnId: payload.sourceTurnId,
      };
    });
  const milestones = (db.prepare("SELECT actor, change FROM item_milestone_changes WHERE id > ? ORDER BY id").all(after.milestone) as
    Array<{ actor: string; change: string }>)
    .map((row) => ({
      kind: "milestone_change", actor: row.actor, from: undefined, to: undefined, decision: row.change,
      onBehalfOf: undefined, sourceTurnId: undefined,
    }));
  return [...activities, ...milestones];
}

// 夹具写下的那部分账本。
function ledgerUpTo(db: Db, until: Mark): Row[] {
  const all = ledger(db);
  return all.slice(0, all.length - ledger(db, until).length);
}

interface Mark { activity: number; milestone: number }
function mark(db: Db): Mark {
  return {
    activity: (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM activities").get() as { n: number }).n,
    milestone: (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM item_milestone_changes").get() as { n: number }).n,
  };
}

// 账本以外的效果：工单、Run、派发、关系、截止节点。
function effects(db: Db) {
  return {
    items: db.prepare(
      `SELECT id, stage, priority, project, token_budget, cost_budget_usd, due_at, requested_runtime, requested_model FROM items ORDER BY id`,
    ).all(),
    runs: db.prepare("SELECT id, item_id, state FROM runs ORDER BY id").all(),
    dispatch: (db.prepare("SELECT item_id, role, purpose, trigger, runtime, state FROM dispatch_requests ORDER BY id").all() as Array<Record<string, unknown>>)
      .map((row) => ({ ...row, trigger: sameWho(row.trigger) })),
    relations: db.prepare("SELECT source_item_id, target_item_id, relation_type, revoked_at IS NULL AS active FROM ticket_relations ORDER BY id").all(),
    milestones: db.prepare("SELECT item_id, kind, at, state FROM item_milestones ORDER BY id").all(),
    workspaces: db.prepare("SELECT owner_item_id, state, merge_status FROM workspaces ORDER BY id").all(),
    grants: db.prepare("SELECT run_id, intent, grant_json, revision FROM run_grants ORDER BY run_id").all(),
    // 验收标准和确认（工单 05）：谁写的、谁改的、谁确认的两边不同（你和 Lead），不比。
    criteria: db.prepare(
      `SELECT id, item_id, position, text, revision, CASE WHEN created_by IN ('user','lead') THEN 'who' ELSE created_by END AS created_by,
         deleted_at IS NOT NULL AS deleted FROM item_acceptance_criteria ORDER BY id`,
    ).all(),
    confirmations: db.prepare(
      `SELECT criterion_id, criterion_revision, executor_run_id, delivery_snapshot_id, ended_at IS NULL AS active, end_reason
       FROM criterion_confirmations ORDER BY id`,
    ).all(),
  };
}

function ownerActions(db: Db): string[] {
  return (db.prepare("SELECT payload FROM events WHERE kind='owner_action.performed' ORDER BY seq").all() as Array<{ payload: string }>)
    .map((row) => (JSON.parse(row.payload) as { action: string }).action);
}

describe("every ticket action leaves the same ledger from the page and from Lead", () => {
  it("covers every action", async () => {
    const { TICKET_ACTION_IDS } = await import("@pi-lead-child/protocol");
    expect(CASES.map((test) => test.action).sort()).toEqual([...TICKET_ACTION_IDS].sort());
  });

  // 开始执行：两个入口都调宿主的 startRun（daemon 里是 spawnItemChild），一次一个，对的工单（审查 2026-10-26 第 10 条）。
  it("start: both entries call the host's startRun for the same ticket", async () => {
    const test = CASES.find((candidate) => candidate.action === "start")!;
    started.length = 0;
    await viaPage(test);
    const pageCalls = started.splice(0);
    await viaLead(test);
    const leadCalls = started.splice(0);
    expect(pageCalls).toHaveLength(1);
    expect(leadCalls).toEqual(pageCalls);
  });

  for (const test of CASES) {
    const who = test.authority === "on_behalf" ? "same effect, Lead on the user's behalf"
      : test.authority === "user_direct" ? "done from the page, Lead always refused" : "same effect, Lead on its own";
    it(`${test.action}: ${who}`, async () => {
      const page = await viaPage(test);
      const lead = await viaLead(test);
      if (test.authority === "user_direct") {
        // 页面上做成了；Lead 被拒，一行都没写，也没有记主人操作。
        expect(ledger(page.db, page.before).filter((row) => row.actor === "user").length).toBeGreaterThan(0);
        expect(ledger(lead.db, lead.before)).toEqual([]);
        expect(ownerActions(page.db)).toEqual([test.ownerAction]);
        expect(ownerActions(lead.db)).toEqual([]);
        return;
      }
      expect(effects(lead.db)).toEqual(effects(page.db));

      // 夹具写下的账本两边一样。
      expect(lead.before).toEqual(page.before);
      expect(ledgerUpTo(lead.db, lead.before)).toEqual(ledgerUpTo(page.db, page.before));

      // 这次操作写下的账本：你写的行是 actor=user；Lead 写的是同样的行，actor=lead，代你做时带上代谁、凭哪一轮。
      // 操作顺带由系统写的行（派发、节点到期……）两边一模一样。
      const pageRows = ledger(page.db, page.before);
      const leadRows = ledger(lead.db, lead.before);
      expect(pageRows.filter((row) => row.actor === "user").length, "the action wrote a row as the user").toBeGreaterThan(0);
      expect(leadRows).toHaveLength(pageRows.length);
      for (const [index, pageRow] of pageRows.entries()) {
        const leadRow = leadRows[index]!;
        if (pageRow.actor === "system") {
          expect(leadRow).toEqual(pageRow);
          continue;
        }
        expect(pageRow).toMatchObject({ actor: "user", onBehalfOf: undefined, sourceTurnId: undefined });
        const onBehalf = test.authority === "on_behalf";
        expect(leadRow).toEqual({
          ...pageRow,
          actor: "lead",
          onBehalfOf: onBehalf ? "user" : undefined,
          sourceTurnId: onBehalf ? lead.turnId : undefined,
        });
      }

      expect(ownerActions(page.db)).toEqual(test.ownerAction ? [test.ownerAction] : []);
      expect(ownerActions(lead.db)).toEqual(test.ownerAction && test.authority === "on_behalf" ? [test.ownerAction] : []);
    });
  }
});
