import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { createApproval, getApproval } from "@pi-lead-child/store";
import { getDecisionRequest, insertDecisionRequest } from "@pi-lead-child/store";
import { listEvents, listOpenLeadWaits, openDb, registerLeadWait, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-interventions-"), "plc.db"));
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function activeItem() {
  const coordinator = createCoordinator({
    db,
    now: () => new Date("2026-07-24T09:00:00.000Z"),
  });
  const itemId = coordinator.createRootItem({
    title: "intervention", brief: "authority", createdBy: "system",
  });
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  return { coordinator, itemId, runId };
}

describe("approval interventions", () => {
  // 2026-10-27：approvals.created_at 是 SQLite 的 datetime('now')（UTC，没有时区）。原样交出去，网页按本地时间读，
  // 东八区的会话卡写「等了 8 小时」。线上 DTO 的时刻一律是带 Z 的 ISO。
  it("hands out approval timestamps as UTC ISO strings", () => {
    const { coordinator, itemId, runId } = activeItem();
    const result = coordinator.requestApproval({
      itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin main",
      checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
    });
    if (result.status !== "pending") throw new Error("expected pending approval");
    const stored = (db.prepare("SELECT created_at FROM approvals WHERE id = ?").get(result.approvalId) as { created_at: string }).created_at;
    const [full] = coordinator.listInterventions({ ids: [`approval:${result.approvalId}`] }, { kind: "user" });
    expect(full!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(Date.parse(full!.createdAt)).toBe(Date.parse(`${stored.replace(" ", "T")}Z`));
  });

  it("creates authority, inbox, checkpoint, card, activity, and ordered outbox in one transaction", () => {
    const { coordinator, itemId, runId } = activeItem();
    const result = coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "paired_api",
      action: "Open approvals:respond",
      payload: { scope: "approvals:respond" },
      checkpoint: {
        title: "Waiting for authorization",
        summary: "Validation needs the privileged approval scope.",
        keyFacts: [
          { label: "stderr", value: "Operation not permitted: /Library/LaunchDaemons" },
        ],
        nextStep: "Continue the boundary audit after approval.",
      },
    });
    if (result.status !== "pending") throw new Error("expected pending approval");

    expect(result).toMatchObject({
      status: "pending",
      checkpoint: {
        actionRef: { type: "approval", id: result.approvalId },
        keyFacts: [
          { label: "stderr", value: "Operation not permitted: /Library/LaunchDaemons" },
        ],
      },
    });
    expect(getApproval(db, result.approvalId)).toMatchObject({
      item_id: itemId, run_id: runId, status: "pending",
    });
    expect(count("inbox")).toBe(1);
    expect(count("conversation_cards")).toBe(1);
    expect(count("activities")).toBe(1);
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([{ event_type: "approval.required" }, { event_type: "ticket.updated" }]);
  });

  it("rolls back the entire approval request if ordered outbox persistence fails", () => {
    const { coordinator, itemId, runId } = activeItem();
    db.exec(`
      CREATE TRIGGER fail_approval_outbox
      BEFORE INSERT ON gateway_events
      BEGIN
        SELECT RAISE(FAIL, 'outbox unavailable');
      END;
    `);
    expect(() => coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "delete",
      action: "Delete production data",
      checkpoint: {
        title: "Waiting for deletion approval",
        summary: "This destructive action needs user approval.",
        nextStep: "Delete only after explicit approval.",
      },
    })).toThrow(/outbox unavailable/i);

    for (const table of [
      "approvals", "inbox", "checkpoints", "conversation_cards", "activities", "gateway_events",
    ]) {
      expect(count(table), table).toBe(0);
    }
  });

  it("treats identical resolution retries as idempotent and contradictory retries as conflicts", () => {
    const { coordinator, itemId, runId } = activeItem();
    const request = coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "send_email",
      action: "Send the report",
      checkpoint: {
        title: "Waiting to send",
        summary: "The report is ready but sending is irreversible.",
        nextStep: "Send after approval.",
      },
    });
    if (request.status !== "pending") throw new Error("expected pending approval");
    const first = coordinator.resolveApproval({
      approvalId: request.approvalId,
      decision: "approve_session",
      actor: { kind: "user", resolvedBy: "user via cli" },
    });
    const retry = coordinator.resolveApproval({
      approvalId: request.approvalId,
      decision: "approve_session",
      actor: { kind: "user", resolvedBy: "user via slack" },
    });

    expect(first.status).toBe("resolved");
    expect(retry.status).toBe("idempotent");
    expect(() => coordinator.resolveApproval({
      approvalId: request.approvalId,
      decision: "reject",
      actor: { kind: "user", resolvedBy: "user via cli" },
    })).toThrow(/conflict/i);
    expect(getApproval(db, request.approvalId)).toMatchObject({
      status: "approved", session_exempt: 1, resolved_by: "user via cli",
    });
    expect(count("checkpoints")).toBe(2);
    expect(count("conversation_cards")).toBe(2);
    expect(count("activities")).toBe(2);
    expect(db.prepare("SELECT state FROM inbox").get()).toEqual({ state: "consumed" });
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([
        { event_type: "approval.required" },
        { event_type: "ticket.updated" },
        { event_type: "approval.resolved" },
        { event_type: "ticket.updated" },
      ]);
  });

  it("rejects approval resolution without a concrete user-channel attribution", () => {
    const { coordinator, itemId, runId } = activeItem();
    const request = coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "send_email",
      action: "Send the report",
      checkpoint: {
        title: "Waiting to send",
        summary: "The report is ready but sending is irreversible.",
        nextStep: "Send after approval.",
      },
    });
    if (request.status !== "pending") throw new Error("expected pending approval");

    expect(() => coordinator.resolveApproval({
      approvalId: request.approvalId,
      decision: "approve",
      actor: { kind: "user", resolvedBy: "user via lead" },
    })).toThrow(/user channel attribution/i);
    expect(getApproval(db, request.approvalId)?.status).toBe("pending");
  });
});

describe("decision interventions", () => {
  it("enforces Lead/user audiences and exposes safe versus full projections", () => {
    const { coordinator, itemId, runId } = activeItem();
    const request = coordinator.requestDecision({
      itemId,
      runId,
      kind: "decision",
      audience: "lead_or_user",
      blocking: true,
      allowCustom: false,
      prompt: "Choose the compatibility mode",
      options: [
        { id: "strict", label: "Strict v2" },
        { id: "additive", label: "Additive kernel" },
      ],
      checkpoint: {
        title: "Compatibility decision needed",
        summary: "Implementation is blocked on the compatibility policy.",
        nextStep: "Continue with the selected mode.",
      },
    });

    expect(coordinator.listInterventionRefs({ itemId })).toEqual([{
      id: `decision:${request.requestId}`,
      // KernelInterventionRef 是线上 DTO，键名仍是 ticketId。
      ticketId: itemId,
      kind: "decision",
      state: "pending",
      requiresAction: true,
    }]);
    const full = coordinator.listInterventions({ itemId }, { kind: "lead" });
    expect(full).toEqual([expect.objectContaining({
      id: `decision:${request.requestId}`,
      detail: "Choose the compatibility mode",
      actions: [
        { kind: "select", optionId: "strict", label: "Strict v2" },
        { kind: "select", optionId: "additive", label: "Additive kernel" },
        { kind: "dismiss", label: "Dismiss" },
      ],
    })]);
    expect(JSON.stringify(coordinator.listInterventionRefs({ itemId }))).not.toContain("prompt");

    const resolved = coordinator.resolveDecision({
      requestId: request.requestId,
      decision: "select",
      optionId: "strict",
      actor: { kind: "lead", resolvedBy: "lead" },
    });
    expect(resolved.status).toBe("resolved");
    expect(coordinator.resolveDecision({
      requestId: request.requestId,
      decision: "select",
      optionId: "strict",
      actor: { kind: "lead", resolvedBy: "lead" },
    }).status).toBe("idempotent");
    expect(getDecisionRequest(db, request.requestId)).toMatchObject({
      state: "resolved", selectedOptionId: "strict", resolvedBy: "lead",
    });

    const userOnly = coordinator.requestDecision({
      itemId,
      runId,
      kind: "question",
      audience: "user",
      prompt: "Provide the release label",
      options: [],
      allowCustom: true,
      checkpoint: {
        title: "Release label needed",
        summary: "The release cannot be named without user input.",
      },
    });
    // 用户的决定要写明渠道，不能冒充。
    expect(() => coordinator.resolveDecision({
      requestId: userOnly.requestId,
      decision: "respond",
      resolution: "v2.0",
      actor: { kind: "user", resolvedBy: "user via lead" },
    })).toThrow(/user channel attribution/i);
    // 2026-10-28（用户：「不要啥都让我审批」）：问用户的决定 Lead 也能自己答，记成 Lead 做的。
    expect(coordinator.listInterventions({ ids: [`decision:${userOnly.requestId}`] }, { kind: "lead" })[0]!.actions)
      .not.toEqual([]);
    coordinator.resolveDecision({
      requestId: userOnly.requestId,
      decision: "respond",
      resolution: "v2.0",
      actor: { kind: "lead", resolvedBy: "lead" },
    });
    expect(getDecisionRequest(db, userOnly.requestId)).toMatchObject({ state: "resolved", resolvedBy: "lead" });
  });

  it("expires approval and decision authorities with follow-up checkpoints and frozen-v2 events", () => {
    const { coordinator, itemId, runId } = activeItem();
    const approval = coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "send",
      action: "Send after expiry",
      ttlMs: -1,
      checkpoint: { title: "Approval expires", summary: "Wait for user", nextStep: "Wait" },
    });
    if (approval.status !== "pending") throw new Error("expected pending approval");
    const decision = coordinator.requestDecision({
      itemId,
      runId,
      kind: "question",
      audience: "user",
      prompt: "Choose before expiry",
      allowCustom: true,
      options: [],
      expiresAt: "2026-07-24T08:59:59.000Z",
      checkpoint: { title: "Decision expires", summary: "Wait for user" },
    });

    expect(coordinator.expireInterventions(new Date("2026-07-24T09:00:00.000Z"))).toEqual({
      approvalIds: [approval.approvalId],
      decisionIds: [decision.requestId],
    });
    expect(getApproval(db, approval.approvalId)?.status).toBe("expired");
    expect(getDecisionRequest(db, decision.requestId)?.state).toBe("expired");
    // 过期也是这个请求的状态变化（2026-10-19）：记一条 user_request.expired，挂着工单，在等的 Lead 由等待叫醒。
    expect(listEvents(db, { kind: "user_request.expired" })).toMatchObject([{
      entityKey: `decision:${decision.requestId}`, level: "record",
      payload: { requestKind: "decision", requestId: String(decision.requestId), itemId },
    }]);
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all()).toEqual([
      { event_type: "approval.required" },
      { event_type: "ticket.updated" },
      { event_type: "ticket.updated" },
      { event_type: "approval.resolved" },
      { event_type: "ticket.updated" },
      { event_type: "ticket.updated" },
    ]);
  });
});

describe("a decision request that expires while Lead waits for it", () => {
  it("ends the wait on its ticket and hands Lead what happened", () => {
    const { coordinator, itemId, runId } = activeItem();
    const decision = coordinator.requestDecision({
      itemId, runId, kind: "question", audience: "user", prompt: "选哪个方案", allowCustom: true, options: [],
      expiresAt: "2026-07-24T08:59:59.000Z", checkpoint: { title: "Decision expires", summary: "Wait for user" },
    });
    registerLeadWait(db, { entityKey: `ticket:${itemId}`, note: "等用户选方案", origin: "lead" });
    coordinator.expireInterventions(new Date("2026-07-24T09:00:00.000Z"));
    expect(listOpenLeadWaits(db)).toEqual([]);
    expect(listEvents(db, { kind: "lead.wait_satisfied" })).toMatchObject([{
      level: "tell", payload: { note: "等用户选方案", trigger: { kind: "user_request.expired", entityKey: `decision:${decision.requestId}` } },
    }]);
  });
});

describe("legacy intervention repair", () => {
  it("repairs pending approval and decision projections exactly once", () => {
    const coordinator = createCoordinator({ db });
    const itemId = createItem(db, { title: "legacy", brief: "repair", createdBy: "system" });
    const approvalId = createApproval(db, {
      itemId, requestedBy: "child", tool: "sudo", action: "Install service",
    });
    const decision = insertDecisionRequest(db, {
      itemId,
      kind: "question",
      audience: "user",
      prompt: "Which region?",
      options: [],
      allowCustom: true,
    });

    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 1, decisions: 1 });
    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 0, decisions: 0 });
    expect(db.prepare("SELECT idempotency_key FROM checkpoints ORDER BY id").all()).toEqual([
      { idempotency_key: `legacy-approval:${approvalId}` },
      { idempotency_key: `legacy-decision:${decision.id}` },
    ]);
    expect(count("conversation_cards")).toBe(2);
    expect(count("inbox")).toBe(2);
    expect(count("gateway_events")).toBe(2);

    db.prepare("UPDATE inbox SET state='consumed'").run();
    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 0, decisions: 0 });
    expect(count("inbox")).toBe(2);

    db.prepare("DELETE FROM inbox WHERE payload LIKE '%decision_request%'").run();
    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 0, decisions: 1 });
    expect(count("checkpoints")).toBe(2);
    expect(count("conversation_cards")).toBe(2);
  });
});

// generative UI（2026-10-15）：Lead 在会话里用 render_ui 的 ChoiceGroup 请用户做决定。这样的决定没有 Run：
// 它算「等你决定」，但不叫醒 Lead（是 Lead 自己发起的）。用户选完以后叫醒 Lead，由它去执行。
describe("a decision Lead asks for itself", () => {
  it("waits for the user without waking Lead, then wakes Lead with the choice", async () => {
    const { listInbox, inboxWakesLead, inboxNeedsUser } = await import("@pi-lead-child/store");
    const coordinator = createCoordinator({ db, now: () => new Date("2026-10-15T10:15:00.000Z") });
    const itemId = coordinator.createRootItem({ title: "outcome", brief: "b", createdBy: "lead" });
    const request = coordinator.requestDecision({
      itemId,
      runId: null,
      origin: "lead",
      kind: "decision",
      audience: "user",
      prompt: "#66 接下来怎么办？",
      options: [
        { id: "merge", label: "并入 #72", description: "#66 关闭" },
        { id: "cancel", label: "取消 #66" },
      ],
      checkpoint: { title: "核查不通过，返工次数已用完", summary: "F1、F2 都已复现。" },
    });
    expect(getDecisionRequest(db, request.requestId)).toMatchObject({ origin: "lead", runId: null, blocking: true });
    const [asked] = listInbox(db, {});
    expect(inboxNeedsUser(asked!)).toBe(true);
    expect(inboxWakesLead(asked!, db)).toBe(false);

    coordinator.resolveDecision({
      requestId: request.requestId,
      decision: "select",
      optionId: "merge",
      actor: { kind: "user", resolvedBy: "user via paired binding:7" },
    });
    const woke = listInbox(db, {}).filter((row) => inboxWakesLead(row, db));
    expect(woke).toHaveLength(1);
    expect(JSON.parse(woke[0]!.payload)).toMatchObject({ kind: "lead_decision_resolved", decisionRequestId: request.requestId, choiceId: "merge" });
    expect(woke[0]!.summary).toContain("并入 #72");
  });

  // 2026-10-15 预览发现：选完以后会话里多出一张英文的「Decision recorded」卡片，和决定卡上的「你选了…」重复。
  // 记录照常写（审计、工单的经过），Lead 发起的决定不再把它投影成会话卡片。agent 发起的决定不变。
  it("records the choice without a second card in the conversation", () => {
    const coordinator = createCoordinator({ db, now: () => new Date("2026-10-15T10:15:00.000Z") });
    const itemId = coordinator.createRootItem({ title: "outcome", brief: "b", createdBy: "lead" });
    const ask = (origin: "lead" | "agent") => coordinator.requestDecision({
      itemId,
      runId: origin === "lead" ? null : createRun(db, { itemId, runtime: "codex" }),
      origin, kind: "decision", audience: "user", prompt: `${origin} 怎么办？`,
      options: [{ id: "merge", label: "并入 #72" }],
      checkpoint: { title: "要你决定", summary: "s" },
    }).requestId;
    const resolutionCard = (requestId: number) => db.prepare(
      `SELECT COUNT(*) AS n FROM conversation_cards c JOIN checkpoints k ON k.id = c.checkpoint_id
       WHERE c.kind = 'checkpoint' AND k.idempotency_key = ?`,
    ).get(`decision-resolved:${requestId}`);
    const recorded = (requestId: number) => db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key = ?")
      .get(`decision-resolved:${requestId}`);
    for (const origin of ["lead", "agent"] as const) {
      const requestId = ask(origin);
      coordinator.resolveDecision({
        requestId, decision: "select", optionId: "merge",
        actor: { kind: "user", resolvedBy: "user via paired binding:7" },
      });
      expect(recorded(requestId)).toEqual({ n: 1 });
      expect(resolutionCard(requestId)).toEqual({ n: origin === "lead" ? 0 : 1 });
    }
  });
});
