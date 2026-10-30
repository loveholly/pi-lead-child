// 工单操作层（工单详情 spec 5.11，实现工单 03）。页面上每个会改后端的操作只有一份实现，页面和 Lead 两个入口。
// 这里测这一层自己的规则：
//   - Lead 代你做只属于你的操作，要凭你这一轮（当前已认证的配对用户轮次）；账本写 actor=lead、onBehalfOf=user 和那一轮，
//     主人操作记在那一轮来自的凭证名下，能「不是我」。
//   - 对外、不可逆的操作，托管下也要你这一轮明确要求。
//   - 清单上的「能不能做」和执行前的检查是同一个函数：清单说能做的，执行时不会以「不能做」被拒；说不能做的，执行时被拒。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  checkGrantCall, computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, TICKET_ACTION_IDS, type TicketActionId,
} from "@pi-lead-child/protocol";
import {
  completeTurn, createItem, createLoopbackBinding, createRun, createTurn, getItem, getRun, getRunGrant, grantDelegationPolicy,
  insertOutcomeSnapshot, insertRunGrant, linkTickets, listActivities, listEvents, listRunGrantChanges, normalizeOutcomePayload, openDb,
  revokeBinding, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { liveChildren } from "../src/children/manager.js";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import {
  listLeadTicketActions, listTicketActions, runTicketAction, TICKET_ACTIONS, ticketActionCatalogText, TicketActionError,
  type TicketActionCaller,
} from "../src/ticket-actions/index.js";

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-ticket-actions-");
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
});
afterEach(() => db.close());

const USER: TicketActionCaller = { kind: "user" };
const host = { resumeRun: () => {} };

function lead(turnId: string | null): TicketActionCaller {
  return { kind: "lead", turnId };
}

function userTurn(bindingId: number, id = "turn-user") {
  return createTurn(db, { id, originBindingId: bindingId, originKind: "paired:companion", userText: "…", state: "streaming" });
}

async function refusal(promise: Promise<unknown>): Promise<TicketActionError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TicketActionError);
  return error as TicketActionError;
}

function draft(): number {
  return createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
}

function ready(): number {
  return createItem(db, { title: "待开始", brief: "b", createdBy: "lead" });
}

function running(): { itemId: number; runId: number } {
  const itemId = ready();
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running", sessionId: "s" });
  return { itemId, runId };
}

function inReview(): number {
  const itemId = ready();
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return itemId;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// 一张交付了、停在 review 的写代码工单（真的 git 仓库和隔离 worktree）。
function deliveredCodeTicket(): number {
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
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

describe("the ticket action catalog", () => {
  it("defines every action exactly once, and the Lead tool text lists every one of them", () => {
    expect(Object.keys(TICKET_ACTIONS).sort()).toEqual([...TICKET_ACTION_IDS].sort());
    for (const [id, definition] of Object.entries(TICKET_ACTIONS)) expect(definition.id).toBe(id);
    const text = ticketActionCatalogText();
    for (const id of TICKET_ACTION_IDS) expect(text).toContain(`- ${id}（${TICKET_ACTIONS[id].label}）`);
  });

  it("marks opening a PR as external and abandoning changes as irreversible", () => {
    expect(TICKET_ACTIONS.open_pr).toMatchObject({ external: true, irreversible: false });
    expect(TICKET_ACTIONS.abandon).toMatchObject({ external: false, irreversible: true });
  });
});

describe("Lead acting for the user", () => {
  // 用户 2026-10-28：「工单操作让 Lead 自己判断」。不在用户这一轮里（心跳、blocker、本机 CLI 的回合、已经结束的轮次），
  // Lead 照样能做，账本写 Lead 自己做的。改预算仍然只认用户这一轮（token 底线）。
  it("lets Lead act on its own judgment without the user's turn, except the budget", async () => {
    const { itemId: runningItem } = running();
    const heartbeat = createTurn(db, { id: "heartbeat", originKind: "system:heartbeat", userText: "", state: "streaming" });
    const cli = createTurn(db, { id: "cli", originKind: "cli", userText: "开工", state: "streaming" });
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const ended = userTurn(binding.id, "ended");
    completeTurn(db, ended.id);
    for (const caller of [lead(null), lead(heartbeat.id), lead(cli.id), lead(ended.id)]) {
      const itemId = draft();
      const outcome = await runTicketAction(db, { itemId, action: "confirm", caller, reason: "工单说明里写了可以直接开工" });
      expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" } });
      expect(getItem(db, itemId)!.stage).toBe("ready");
      expect((await refusal(runTicketAction(db, {
        itemId: runningItem, action: "set_budget", input: { tokenBudget: 1_000_000 }, caller, reason: "加预算",
      }))).code).toBe("needs_user_turn");
    }
    expect(getItem(db, runningItem)!.token_budget).toBeNull();
  });

  it("refuses these decisions in a turn that read outside content", async () => {
    const itemId = draft();
    const error = await refusal(runTicketAction(db, {
      itemId, action: "confirm", caller: { kind: "lead", turnId: null, externalTurn: true }, reason: "Slack 里说可以开工",
    }));
    expect(error.code).toBe("needs_user_turn");
    expect(error.message).toContain("这一轮读过外部内容");
    expect(getItem(db, itemId)!.stage).toBe("draft");
    // Lead 本来就能做的（改优先级）不受影响。
    expect((await runTicketAction(db, {
      itemId, action: "set_priority", input: { priority: "high" }, caller: { kind: "lead", turnId: null, externalTurn: true }, reason: "急",
    })).authority).toBe("lead");
  });

  // 回归（2026-10-29）：用户在这一轮说「核查没问题就更新状态」，Lead 读过 GitHub 上用户自己的 PR，验收被拒，用户只好再说一遍。
  // 用户本人正在说话的那一轮，读过外部内容也照做（和改规则的例外同一条）。
  it("does these decisions in the user's own live turn even after reading outside content", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const itemId = draft();
    const outcome = await runTicketAction(db, {
      itemId, action: "confirm", caller: { kind: "lead", turnId: turn.id, externalTurn: true }, reason: "用户说开工",
    });
    expect(outcome).toMatchObject({ authority: "on_behalf" });
    expect(getItem(db, itemId)!.stage).toBe("ready");
  });

  // 审查 H1：凭证作废以后，它那一轮还在进行，也不能再授权 Lead 代做（包括对外和不可逆的操作）。
  it("refuses a turn whose credential was revoked while the turn was still running", async () => {
    const { binding } = createLoopbackBinding(db, { name: "被作废的网页" });
    const turn = userTurn(binding.id);
    revokeBinding(db, binding.id);
    const itemId = draft();
    const confirm = await refusal(runTicketAction(db, { itemId, action: "confirm", caller: lead(turn.id), reason: "用户说开工" }));
    expect(confirm.code).toBe("needs_user_turn");
    expect(confirm.message).toMatch(/no longer active/);
    expect(getItem(db, itemId)!.stage).toBe("draft");

    const code = deliveredCodeTicket();
    const pushes: string[][] = [];
    const pullRequestRunner = { gh: async (args: string[]) => { pushes.push(args); return { ok: true, stdout: "https://example.test/pr/1\n", stderr: "" }; } };
    expect((await refusal(runTicketAction(db, { itemId: code, action: "open_pr", caller: lead(turn.id), reason: "用户说开 PR", pullRequestRunner }))).code)
      .toBe("needs_user_turn");
    expect(pushes).toEqual([]);
  });

  it("acts in the user's turn as Lead on behalf of the user, and records the owner action under that turn's credential", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const itemId = draft();
    const outcome = await runTicketAction(db, { itemId, action: "confirm", caller: lead(turn.id), reason: "用户说先出方案" });

    expect(outcome).toMatchObject({ authority: "on_behalf", by: { actor: "lead", onBehalfOf: { sourceTurnId: turn.id } } });
    expect(getItem(db, itemId)!.stage).toBe("ready");
    const [transitionRow] = listActivities(db, itemId).filter((activity) => activity.kind === "transition");
    expect(transitionRow!.actor).toBe("lead");
    expect(JSON.parse(transitionRow!.payload)).toMatchObject({
      from: "draft", to: "ready", onBehalfOf: "user", sourceTurnId: turn.id,
    });
    const event = db.prepare("SELECT payload FROM events WHERE event_id=?").get(outcome.ownerActionEventId) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      action: "ticket.confirm",
      // 称呼 Lead 用它的名字（设置 → 身份与风格，缺省 Paimon）。
      summary: expect.stringMatching(/^Paimon 代你确认了工单/),
      credential: { bindingId: binding.id },
      source: { client: "lead" },
      delivery: "push",
      detail: { sourceTurnId: turn.id },
      undo: { kind: "item", itemId, from: "draft", to: "ready" },
    });
  });

  it("does Lead's own actions as Lead, without a turn and without pretending to be the user", async () => {
    const itemId = ready();
    const outcome = await runTicketAction(db, { itemId, action: "cancel", caller: lead(null), reason: "重复的工单" });
    expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" }, ownerActionEventId: null });
    const [row] = listActivities(db, itemId).filter((activity) => activity.kind === "transition");
    expect(row!.actor).toBe("lead");
    expect(JSON.parse(row!.payload)).not.toHaveProperty("onBehalfOf");
  });

  it("lets Lead cancel a delivered ticket on its own judgment", async () => {
    const itemId = inReview();
    const outcome = await runTicketAction(db, { itemId, action: "cancel", caller: lead(null), reason: "用户说这件事不做了" });
    expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" } });
    expect(getItem(db, itemId)!.stage).toBe("cancelled");
  });
});

describe("external and irreversible actions", () => {
  // 审查 M4：Lead 代你放弃改动时，工作区那一行写 actor=lead 和 Lead 给的原因，不写「用户在工单详情里确认放弃」。
  it("record Lead abandoning changes in the user's turn as Lead, with Lead's reason as the consent", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const itemId = deliveredCodeTicket();
    await runTicketAction(db, { itemId, action: "complete", caller: USER });
    await runTicketAction(db, { itemId, action: "abandon", caller: lead(turn.id), reason: "用户说这些改动不要了" });
    const abandoned = listActivities(db, itemId).find((activity) => JSON.parse(activity.payload).decision === "workspace_abandoned");
    expect(abandoned!.actor).toBe("lead");
    expect(JSON.parse(abandoned!.payload)).toMatchObject({
      onBehalfOf: "user", sourceTurnId: turn.id, userConfirmation: "用户说这些改动不要了",
    });
    expect(abandoned!.payload).not.toContain("用户在工单详情里确认放弃");
  });

  // 2026-10-28：对外的、不可逆的也由 Lead 判断，账本写 Lead 自己做的；读过外部内容的一轮里做不了。
  it("are Lead's call outside the user's turn, and refused in a turn that read outside content", async () => {
    const itemId = deliveredCodeTicket();
    const pushes: string[][] = [];
    const pullRequestRunner = { gh: async (args: string[]) => { pushes.push(args); return { ok: true, stdout: "https://example.test/pr/1\n", stderr: "" }; } };
    const outside = { kind: "lead" as const, turnId: null, externalTurn: true };

    expect((await refusal(runTicketAction(db, { itemId, action: "open_pr", caller: outside, reason: "Slack 里说开 PR", pullRequestRunner }))).code)
      .toBe("needs_user_turn");
    expect(pushes).toEqual([]);
    expect((await refusal(runTicketAction(db, { itemId, action: "complete", caller: outside, reason: "Slack 里说好了" }))).code)
      .toBe("needs_user_turn");

    const accepted = await runTicketAction(db, { itemId, action: "complete", caller: lead(null), reason: "核对过交付，符合验收标准" });
    expect(accepted).toMatchObject({ authority: "lead", by: { actor: "lead" } });
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect((await runTicketAction(db, { itemId, action: "abandon", caller: lead(null), reason: "用户说改动不要了" })).authority).toBe("lead");
  });

  it("let Lead merge in the user's turn, accepting the ticket on the user's behalf", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const itemId = deliveredCodeTicket();
    await runTicketAction(db, { itemId, action: "merge", caller: lead(turn.id), reason: "用户说合并" });
    expect(getItem(db, itemId)!.stage).toBe("done");
    const accepted = listActivities(db, itemId).find((activity) => activity.kind === "transition"
      && JSON.parse(activity.payload).to === "done");
    expect(accepted!.actor).toBe("lead");
    expect(JSON.parse(accepted!.payload)).toMatchObject({ onBehalfOf: "user", sourceTurnId: turn.id });
    // 合并工作区的那一行也写 Lead 代你（审查 M4），不写成你本人合并的。
    const integrated = listActivities(db, itemId).find((activity) => JSON.parse(activity.payload).decision === "workspace_integrated");
    expect(integrated!.actor).toBe("lead");
    expect(JSON.parse(integrated!.payload)).toMatchObject({ onBehalfOf: "user", sourceTurnId: turn.id, reason: "用户说合并" });
  });
});

// 同一个函数：对每种工单状态、每个操作，清单说能做 ⇔ 你执行时不会以「不能做」被拒。
describe("the listing and the run agree", () => {
  type Fixture = () => number;
  const fixtures: Record<string, Fixture> = {
    draft,
    ready,
    running: () => running().itemId,
    paused: () => {
      const { itemId, runId } = running();
      updateRun(db, runId, { state: "paused" });
      return itemId;
    },
    review: inReview,
    done: () => {
      const itemId = inReview();
      transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
      return itemId;
    },
    cancelled: () => {
      const itemId = ready();
      transition(db, { itemId, to: "cancelled", actor: "user", reason: "x" });
      return itemId;
    },
    reminder: () => {
      const itemId = createItem(db, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-10-17T01:00:00.000Z" });
      transition(db, { itemId, to: "fired", actor: "system", reason: "remind_at reached" });
      return itemId;
    },
  };

  function sampleInput(action: TicketActionId, itemId: number, other: number): Record<string, unknown> {
    switch (action) {
      case "set_priority": return { priority: "high" };
      case "set_project": return { project: "官网" };
      case "set_due": return { dueAt: "2026-11-01T09:00:00.000Z" };
      case "set_budget": return { tokenBudget: 500_000 };
      case "link": return { targetTicketId: other, relationType: "relates_to" };
      case "unlink": {
        const row = db.prepare("SELECT id FROM ticket_relations WHERE source_item_id=? OR target_item_id=?").get(itemId, itemId) as { id: number } | undefined;
        return { relationId: row?.id ?? 999_999 };
      }
      case "change_reviewer": return { runtime: "claude" };
      case "delegate": return { maxReworkCycles: 1 };
      case "widen_grant": return { scope: { repos: ["Acme/y"] } };
      case "set_run_profile": return { role: "reviewer", effort: "high" };
      case "change_executor_runtime": return { runtime: "codex" };
      case "set_auto_pr": return { enabled: false };
      case "open_delivery_file": return { path: "docs/plan.md" };
      case "edit_acceptance_criteria": return { add: ["空输入返回 400"] };
      case "confirm_criterion":
      case "unconfirm_criterion": return { criterionId: 999_999 };
      default: return {};
    }
  }

  for (const [state, fixture] of Object.entries(fixtures)) {
    it(`agrees for every action on a ${state} ticket`, async () => {
      for (const action of TICKET_ACTION_IDS) {
        const other = ready();
        const itemId = fixture();
        // 每张工单都关联到另一张，这样「解除关联」有东西可解（已取消的工单建不了关系）。
        if (getItem(db, itemId)!.kind === "task" && getItem(db, itemId)!.stage !== "cancelled") {
          linkTickets(db, { sourceTicketId: other, targetTicketId: itemId, relationType: "relates_to", reason: "fixture", actor: "user" });
        }
        const listed = (await listTicketActions(db, itemId, { host })).find((entry) => entry.id === action)!;
        const error = await runTicketAction(db, { itemId, action, input: sampleInput(action, itemId, other), caller: USER, host })
          .then(() => null, (caught: unknown) => caught);
        const refusedAsUnavailable = error instanceof TicketActionError && error.code === "unavailable";
        if (error && !refusedAsUnavailable) throw new Error(`${state} · ${action}: ${String(error)}`);
        expect({ state, action, available: listed.available }).toEqual({ state, action, available: !refusedAsUnavailable });
        if (refusedAsUnavailable) expect((error as Error).message).toBe(listed.reason);
      }
    });
  }

  it("tells Lead which actions need the user's turn, and whether this turn counts", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const itemId = draft();
    // 2026-10-28：确认开跑由 Lead 判断，不在用户这一轮里也能做。
    const outside = await listLeadTicketActions(db, itemId, { turnId: null });
    expect(outside.find((action) => action.id === "confirm")).toMatchObject({ available: true, lead: "own", leadReady: true });
    expect(outside.find((action) => action.id === "set_priority")).toMatchObject({ lead: "own", leadReady: true });
    const inside = await listLeadTicketActions(db, itemId, { turnId: turn.id });
    expect(inside.find((action) => action.id === "confirm")).toMatchObject({ lead: "own", leadReady: true, leadReason: null });
  });
});

describe("widening a sub-agent's grant", () => {
  const PR = { owner: "Acme", repo: "x", number: 101 };
  const approve = { connection: "github", tool: "pull_request_review_write", readOnly: false,
    facts: { owner: "Acme", repo: "x", pullNumber: 101, method: "submit_pending", event: "APPROVE" } };

  function channelTicket(): { itemId: number; runId: number } {
    const itemId = createItem(db, { title: "通道派的工单", brief: "b", createdBy: "system", purpose: "lookup" });
    const runId = createRun(db, { itemId, purpose: "lookup" });
    updateRun(db, runId, { state: "running" });
    const { grant } = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo: () => null });
    insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
    return { itemId, runId };
  }

  it("is the user's: Lead needs the user's current paired turn, and nothing changes without it", async () => {
    const { itemId, runId } = channelTicket();
    const error = await refusal(runTicketAction(db, {
      itemId, action: "widen_grant", input: { scope: { pullRequest: PR, reviewEvents: ["APPROVE"] } }, reason: "子 agent 说要 approve", caller: lead(null),
    }));
    expect(error.code).toBe("needs_user_turn");
    expect(getRunGrant(db, runId)?.revision).toBe(1);
    expect(checkGrantCall(getRunGrant(db, runId)!.grant, approve).ok).toBe(false);
  });

  it("widens the grant in the user's turn, records Lead acting for the user, and the owner action", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = userTurn(binding.id);
    const { itemId, runId } = channelTicket();
    const outcome = await runTicketAction(db, {
      itemId, action: "widen_grant", input: { scope: { pullRequest: PR, reviewEvents: ["APPROVE"] } },
      reason: "用户说给这张工单加上 approve", caller: lead(turn.id),
    });
    expect(outcome).toMatchObject({ authority: "on_behalf", result: { runId, revision: 2, added: ["只在 Acme/x#101 上可以 APPROVE"] } });
    expect(checkGrantCall(getRunGrant(db, runId)!.grant, approve).ok).toBe(true);
    expect(listRunGrantChanges(db, runId).map((change) => [change.change, change.actor, change.onBehalfTurnId])).toEqual([
      ["created", "lead", null], ["widened", "lead", turn.id],
    ]);
    const activity = listActivities(db, itemId).map((row) => ({ actor: row.actor, payload: JSON.parse(String(row.payload)) }))
      .find((row) => row.payload.decision === "grant_widened");
    expect(activity).toMatchObject({
      actor: "lead", payload: { onBehalfOf: "user", sourceTurnId: turn.id, added: ["只在 Acme/x#101 上可以 APPROVE"] },
    });
    const performed = listEvents(db, { kind: "owner_action.performed" }).at(-1)!;
    expect(performed.payload).toMatchObject({
      action: "run.grant", summary: "Paimon 代你放宽了 Run #" + runId + " 的权限：只在 Acme/x#101 上可以 APPROVE",
      credential: { bindingId: binding.id }, undo: { kind: "run_grant", runId },
    });
  });

  it("resolves local repos through the host, and refuses what the grant already has", async () => {
    const { itemId, runId } = channelTicket();
    const resolveLocalRepo = (name: string) => name === "x" ? { name: "x", root: "/repos/x", github: "Acme/x" } : null;
    const outcome = await runTicketAction(db, {
      itemId, action: "widen_grant", input: { scope: { localRepos: ["x", "nope"] } }, caller: USER, host: { resolveLocalRepo },
    });
    expect(outcome.result).toMatchObject({ added: ["只读本地仓库 x"], unresolved: ["nope"] });
    expect(getRunGrant(db, runId)?.grant.localRepos).toEqual([{ name: "x", root: "/repos/x", github: "Acme/x" }]);
    const again = await refusal(runTicketAction(db, { itemId, action: "widen_grant", input: { scope: { repos: ["Acme/x"] } }, caller: USER }));
    expect(again.code).toBe("invalid_input");
  });

  it("is unavailable once the run has ended, and on tickets without a grant", async () => {
    const { itemId, runId } = channelTicket();
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    const listed = (await listTicketActions(db, itemId)).find((action) => action.id === "widen_grant");
    expect(listed).toMatchObject({ available: false, reason: `Run #${runId} 已经结束，放宽也用不上了。` });
    const plain = (await listTicketActions(db, ready())).find((action) => action.id === "widen_grant");
    expect(plain).toMatchObject({ available: false, reason: "这张工单没有带权限清单的 Run（只有通道派的工单有）。" });
  });
});
