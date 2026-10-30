import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { GatewayEventSchema } from "@pi-lead-child/protocol";
import { createAgentToolHandlers } from "@pi-lead-child/engine";
import { createCoordinator } from "@pi-lead-child/engine";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  recoverOrphans,
  repairDaemonStartupState,
  startDaemon,
} from "../src/server.js";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { startPairedServer } from "@pi-lead-child/gateway";
import { createApproval, getApproval } from "@pi-lead-child/store";
import {
  createRun,
  getRun,
  updateRun,
} from "@pi-lead-child/store";
import { createCheckpointDomainService } from "@pi-lead-child/engine";
import { insertDecisionRequest } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  latestGatewaySeq,
  listGatewayEvents,
} from "@pi-lead-child/store";
import { createPairing, redeemPairingById } from "@pi-lead-child/store";
import { markItemExecutionStarted } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";

const CHECKPOINT_POLICY = {
  dedupeWindowMs: 60_000,
  progressMinIntervalMs: 120_000,
  silenceMs: 900_000,
  silenceToolEvents: 8,
  silenceDomainEvents: 3,
  reminderCooldownMs: 900_000,
};

function runtimeStatus() {
  return {
    model: "stub/e2e",
    sessionId: "checkpoint-control-plane-e2e",
    busy: false,
    runningItemIds: [],
    aish: null,
  };
}

function leadSessionFactory() {
  return async () => ({
    modelName: "stub/e2e",
    session: {
      sessionId: "checkpoint-control-plane-e2e",
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      dispose: () => {},
    },
  });
}

async function startPaired(db: Db, now: () => Date) {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime: runtimeStatus, now }),
    hello: runtimeStatus,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

// 配对码兑换的设备做不了用户的决定（approvals:respond）：child 用 plc.sock 的临时 admin token 也建得出配对码
// （.scratch/child-self-approve/options.md）。要做决定的客户端用扫码配对的手机：本机网页的邀请，被另一台设备兑换。
async function pair(
  db: Db,
  base: string,
  name: string,
  scopes: string[],
): Promise<{ accessToken: string; bindingId: number }> {
  if (scopes.includes("approvals:respond")) {
    const { pairingId } = createPairing(db, { name, kind: "companion", scopes, origin: "web_invitation" });
    const phone = redeemPairingById(db, pairingId, { peerIsThisMachine: false });
    const me = await fetch(`${base}/v1/paired/me`, { headers: { authorization: `Bearer ${phone.accessToken}` } });
    expect((await me.json() as { binding: { scopes: string[] } }).binding.scopes).toEqual(scopes);
    return { accessToken: phone.accessToken, bindingId: phone.binding.id };
  }
  const { code } = createPairing(db, { name, kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as {
    access_token: string;
    binding: { id: number; scopes: string[] };
  };
  expect(body.binding.scopes).toEqual(scopes);
  return { accessToken: body.access_token, bindingId: body.binding.id };
}

function auth(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function count(db: Db, table: string, where = "", values: unknown[] = []): number {
  return (db.prepare(
    `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
  ).get(...values) as { count: number }).count;
}

function eventTypesAfter(db: Db, seq: number): string[] {
  return (db.prepare(
    "SELECT event_type FROM gateway_events WHERE seq > ? ORDER BY seq",
  ).all(seq) as Array<{ event_type: string }>).map((row) => row.event_type);
}

function authorityCounts(db: Db) {
  return {
    approvals: count(db, "approvals"),
    decisions: count(db, "decision_requests"),
    checkpoints: count(db, "checkpoints"),
    cards: count(db, "conversation_cards"),
    inbox: count(db, "inbox"),
    events: count(db, "gateway_events"),
  };
}

describe("Checkpoint Control Plane Task 10 backend acceptance", () => {
  it("runs real paired scopes, nested DAG work, checkpoints, interventions, timing, cards, and retry semantics", async () => {
    const dataDir = tempDir("plc-checkpoint-control-plane-e2e-");
    const dbPath = join(dataDir, "plc.db");
    const db = openDb(dbPath);
    let now = new Date(Date.now() + 10 * 60_000);
    const server = await startPaired(db, () => now);

    try {
      expect((await fetch(`${server.base}/v1/kernel/work-items`)).status).toBe(401);
      const viewer = await pair(db, server.base, "viewer", ["tickets:view"]);
      const actionOnly = await pair(db, server.base, "action-only", ["approvals:respond"]);
      const full = await pair(db, server.base, "full", [
        "tickets:view",
        "tickets:create",
        "approvals:respond",
      ]);

      const created = await fetch(`${server.base}/v1/tickets`, {
        method: "POST",
        headers: auth(full.accessToken, true),
        body: JSON.stringify({
          title: "Checkpoint control plane acceptance",
          brief: "Exercise the real backend authority and projection boundaries",
          runtime: "codex",
          verificationPolicy: "lead_static",
        }),
      });
      expect(created.status).toBe(201);
      const root = await created.json() as { id: number };
      // 经 companion 建出来的 item 不 hold 就生于 ready（spec §6.6），派发前无须再确认。
      const dispatcher = createDispatcher(db, { now: () => now });
      dispatcher.request({
        itemId: root.id,
        role: "executor",
        purpose: "execution",
        runtime: "codex",
        trigger: "task-10-e2e",
        idempotencyKey: `task-10-root:${root.id}`,
      });
      const rootClaim = dispatcher.claimNext();
      expect(rootClaim).toMatchObject({ itemId: root.id, runtime: "codex" });
      dispatcher.markStarted(rootClaim!);
      updateRun(db, rootClaim!.runId, { state: "running", externalSessionId: "root-e2e" });
      // 认领 Run 时 dispatcher 已把 item 推到 active，这里不再重复扭一次。
      markItemExecutionStarted(db, root.id, new Date(now.getTime() - 15 * 60_000));

      const rootTools = createAgentToolHandlers({
        db,
        itemId: root.id,
        runId: rootClaim!.runId,
        now: () => now,
        checkpointPolicy: CHECKPOINT_POLICY,
      });
      await rootTools.call("begin_planning", {});
      const rootPlanInput = {
        items: [
          { key: "api", title: "API child", brief: "Implement the API", runtime: "codex" },
          { key: "store", title: "Store child", brief: "Implement persistence", runtime: "claude" },
          {
            key: "integrate",
            title: "Integration child",
            brief: "Integrate API and store",
            runtime: "pi",
            depends_on: ["api", "store"],
          },
        ],
      };
      const rootPlan = await rootTools.call("create_work_plan", rootPlanInput) as {
        by_key: Record<string, number>;
      };
      const planCounts = authorityCounts(db);
      expect(await rootTools.call("create_work_plan", rootPlanInput)).toEqual(rootPlan);
      expect(authorityCounts(db)).toEqual(planCounts);
      await rootTools.call("finish_planning", {});
      const sealedCounts = authorityCounts(db);
      await rootTools.call("finish_planning", {});
      expect(authorityCounts(db)).toEqual(sealedCounts);

      const firstLeaf = dispatcher.claimNext();
      const secondLeaf = dispatcher.claimNext();
      expect(new Set([firstLeaf?.itemId, secondLeaf?.itemId])).toEqual(new Set([
        rootPlan.by_key.api,
        rootPlan.by_key.store,
      ]));
      expect(dispatcher.claimNext()).toBeNull();
      for (const claim of [firstLeaf!, secondLeaf!]) {
        dispatcher.markStarted(claim);
        updateRun(db, claim.runId, { state: "running" });
        markItemExecutionStarted(db, claim.itemId, now);
      }

      const apiClaim = firstLeaf!.itemId === rootPlan.by_key.api ? firstLeaf! : secondLeaf!;
      const storeClaim = firstLeaf!.itemId === rootPlan.by_key.store ? firstLeaf! : secondLeaf!;
      const apiTools = createAgentToolHandlers({
        db,
        itemId: apiClaim.itemId,
        runId: apiClaim.runId,
        now: () => now,
        checkpointPolicy: CHECKPOINT_POLICY,
      });
      await apiTools.call("begin_planning", {});
      const nestedPlan = await apiTools.call("create_work_plan", {
        items: [
          { key: "contract", title: "Contract grandchild", brief: "Define contract", runtime: "pi" },
          {
            key: "handler",
            title: "Handler grandchild",
            brief: "Implement handler after contract",
            runtime: "codex",
            depends_on: ["contract"],
          },
        ],
      }) as { by_key: Record<string, number> };
      await apiTools.call("finish_planning", {});
      expect(getItem(db, nestedPlan.by_key.contract)).toMatchObject({
        parent_item_id: apiClaim.itemId,
        root_item_id: root.id,
      });
      expect(db.prepare(
        "SELECT depends_on_item_id FROM item_dependencies WHERE item_id=?",
      ).all(nestedPlan.by_key.handler)).toEqual([
        { depends_on_item_id: nestedPlan.by_key.contract },
      ]);

      const progressInput = {
        kind: "progress",
        stage: "acceptance",
        title: "Backend acceptance is running",
        summary: "Pairing, planning, and dispatch paths are active against the temporary database.",
        key_facts: [{ label: "database", value: "temporary SQLite" }],
        artifact_refs: ["artifact:task-10-log"],
        next_step: "Exercise intervention authorities.",
      };
      const progress = await rootTools.call("submit_checkpoint", progressInput) as {
        checkpoint_id: number; deduplicated: boolean;
      };
      expect(progress.deduplicated).toBe(false);
      expect(await rootTools.call("submit_checkpoint", progressInput)).toMatchObject({
        checkpoint_id: progress.checkpoint_id,
        deduplicated: true,
      });
      expect(await rootTools.call("submit_checkpoint", {
        kind: "delegation",
        stage: "dispatch",
        title: "Parallel implementation delegated",
        summary: "API and store children own independent work before integration.",
        related_ticket_ids: [rootPlan.by_key.api, rootPlan.by_key.store],
        next_step: "Wait for both children before integration.",
      })).toMatchObject({ deduplicated: false });
      await rootTools.call("ticket_update", {
        status: "blocked",
        reason: "exercise critical blocker checkpoint",
        checkpoint: {
          kind: "blocked",
          stage: "authorization",
          title: "Authorization boundary must be checked",
          summary: "The next phase intentionally pauses before privileged control-plane actions.",
          next_step: "Resume after recording the intervention boundary.",
        },
      });
      await rootTools.call("ticket_update", {
        status: "active",
        reason: "intervention boundary recorded",
      });

      const decisionSeq = latestGatewaySeq(db);
      const decision = await rootTools.call("request_decision", {
        kind: "decision",
        audience: "lead_or_user",
        blocking: false,
        allow_custom: false,
        prompt: "Choose the rollout mode",
        options: [
          { id: "canary", label: "Canary" },
          { id: "direct", label: "Direct" },
        ],
        checkpoint: {
          title: "Rollout decision required",
          summary: "The implementation path is complete enough to choose a rollout mode.",
          next_step: "Continue with the selected rollout mode.",
        },
      }) as { request_id: number; checkpoint_id: number };
      expect(eventTypesAfter(db, decisionSeq)).toEqual(["ticket.updated"]);

      const approvalSeq = latestGatewaySeq(db);
      const approvalPromise = rootTools.call("request_approval", {
        tool: "deploy_release",
        action: "Deploy the accepted release",
        payload: { target: "staging" },
        checkpoint: {
          title: "Deployment authorization required",
          summary: "The release is ready, but deployment requires explicit authorization.",
          next_step: "Deploy after the user approves this session.",
        },
      }) as Promise<{ approval_id: number; status: string; checkpoint_id: number }>;
      await vi.waitFor(() => {
        expect(count(db, "approvals", "status='pending'")).toBe(1);
      });
      const approvalId = (db.prepare(
        "SELECT id FROM approvals WHERE status='pending' ORDER BY id DESC LIMIT 1",
      ).get() as { id: number }).id;
      expect(eventTypesAfter(db, approvalSeq)).toEqual([
        "approval.required",
        "ticket.updated",
      ]);

      expect((await fetch(
        `${server.base}/v1/kernel/tickets/${root.id}/workbench`,
        { headers: auth(actionOnly.accessToken) },
      )).status).toBe(403);
      expect((await fetch(
        `${server.base}/v1/kernel/interventions`,
        { headers: auth(viewer.accessToken) },
      )).status).toBe(403);

      const workItemsResponse = await fetch(
        `${server.base}/v1/kernel/work-items?ticket_id=${root.id}`,
        { headers: auth(viewer.accessToken) },
      );
      expect(workItemsResponse.status).toBe(200);
      const workItems = await workItemsResponse.json() as { items: any[] };
      expect(workItems.items).toEqual([expect.objectContaining({
        ticketId: root.id,
        activeExecution: expect.objectContaining({
          attemptId: rootClaim!.runId,
          runtime: "codex",
          state: "running",
        }),
        pendingInterventionCount: 2,
        latestCheckpointId: expect.any(Number),
        timing: expect.objectContaining({
          firstStartedAt: expect.any(String),
          elapsedMs: expect.any(Number),
          activeExecutionMs: expect.any(Number),
        }),
      })]);
      expect(workItems.items[0].timing.elapsedMs).toBeGreaterThanOrEqual(15 * 60_000);

      const workbenchResponse = await fetch(
        `${server.base}/v1/kernel/tickets/${root.id}/workbench`,
        { headers: auth(viewer.accessToken) },
      );
      expect(workbenchResponse.status).toBe(200);
      const workbench = await workbenchResponse.json() as any;
      expect(workbench).toMatchObject({
        ticket: { id: root.id, status: "active" },
        children: expect.arrayContaining([
          expect.objectContaining({ id: rootPlan.by_key.api }),
          expect.objectContaining({ id: rootPlan.by_key.store }),
          expect.objectContaining({ id: rootPlan.by_key.integrate }),
        ]),
        activeAttempt: { id: rootClaim!.runId },
        interventionRefs: expect.arrayContaining([
          expect.objectContaining({ id: `decision:${decision.request_id}`, requiresAction: true }),
          expect.objectContaining({ id: `approval:${approvalId}`, requiresAction: true }),
        ]),
      });
      expect(JSON.stringify(workbench)).not.toContain("Choose the rollout mode");
      expect(JSON.stringify(workbench)).not.toContain("Deploy the accepted release");

      const fullInterventions = await fetch(
        `${server.base}/v1/kernel/interventions?ticket_id=${root.id}&state=pending`,
        { headers: auth(full.accessToken) },
      );
      expect(fullInterventions.status).toBe(200);
      expect(await fullInterventions.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: `decision:${decision.request_id}`, actions: expect.any(Array) }),
          expect.objectContaining({ id: `approval:${approvalId}`, actions: [
            "approve",
            "reject",
            "approve_session",
          ] }),
        ]),
      });

      const checkpointResponse = await fetch(
        `${server.base}/v1/kernel/tickets/${root.id}/checkpoints`,
        { headers: auth(viewer.accessToken) },
      );
      expect(checkpointResponse.status).toBe(200);
      const checkpointBody = await checkpointResponse.json() as { items: any[] };
      expect(checkpointBody.items.map((item) => item.id)).toEqual(
        [...checkpointBody.items.map((item) => item.id)].sort((left, right) => left - right),
      );
      expect(checkpointBody.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: progress.checkpoint_id, kind: "progress" }),
        expect.objectContaining({ kind: "delegation", relatedTicketIds: [
          rootPlan.by_key.api,
          rootPlan.by_key.store,
        ] }),
        expect.objectContaining({ kind: "blocked", nextStep: expect.any(String) }),
        expect.objectContaining({ id: decision.checkpoint_id, actionRef: {
          type: "decision_request",
          id: decision.request_id,
        } }),
        expect.objectContaining({ actionRef: { type: "approval", id: approvalId } }),
      ]));

      const decisionResolveSeq = latestGatewaySeq(db);
      const decisionResolution = {
        authority: "decision_request",
        decision: "select",
        optionId: "canary",
      };
      const resolvedDecision = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${decision.request_id}/resolve`,
        {
          method: "POST",
          headers: auth(full.accessToken, true),
          body: JSON.stringify(decisionResolution),
        },
      );
      expect(resolvedDecision.status).toBe(200);
      expect(eventTypesAfter(db, decisionResolveSeq)).toEqual(["ticket.updated"]);
      const decisionCounts = authorityCounts(db);
      const decisionRetry = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${decision.request_id}/resolve`,
        {
          method: "POST",
          headers: auth(full.accessToken, true),
          body: JSON.stringify(decisionResolution),
        },
      );
      expect(decisionRetry.status).toBe(200);
      expect(await decisionRetry.json()).toMatchObject({ status: "idempotent" });
      expect(authorityCounts(db)).toEqual(decisionCounts);

      const approvalResolveSeq = latestGatewaySeq(db);
      const approvalResolution = { authority: "approval", decision: "approve_session" };
      const resolvedApproval = await fetch(
        `${server.base}/v1/kernel/interventions/approval:${approvalId}/resolve`,
        {
          method: "POST",
          headers: auth(full.accessToken, true),
          body: JSON.stringify(approvalResolution),
        },
      );
      expect(resolvedApproval.status).toBe(200);
      expect(await approvalPromise).toMatchObject({
        approval_id: approvalId,
        status: "approved",
      });
      expect(eventTypesAfter(db, approvalResolveSeq)).toEqual([
        "approval.resolved",
        "ticket.updated",
      ]);
      expect(getApproval(db, approvalId)).toMatchObject({
        status: "approved",
        session_exempt: 1,
      });
      const approvalCounts = authorityCounts(db);
      const approvalRetry = await fetch(
        `${server.base}/v1/kernel/interventions/approval:${approvalId}/resolve`,
        {
          method: "POST",
          headers: auth(full.accessToken, true),
          body: JSON.stringify(approvalResolution),
        },
      );
      expect(approvalRetry.status).toBe(200);
      expect(await approvalRetry.json()).toMatchObject({ status: "idempotent" });
      expect(authorityCounts(db)).toEqual(approvalCounts);

      expect(db.prepare(
        `SELECT state FROM inbox
         WHERE json_extract(payload, '$.authorityType') IN ('approval','decision_request')
         ORDER BY id`,
      ).all()).toEqual([{ state: "consumed" }, { state: "consumed" }]);

      const exemptionSeq = latestGatewaySeq(db);
      const approvalCountBeforeExemption = count(db, "approvals");
      expect(await rootTools.call("request_approval", {
        tool: "deploy_release",
        action: "Deploy the accepted release again",
        payload: { target: "staging" },
        checkpoint: {
          title: "Reuse deployment authorization",
          summary: "The same deployment tool is covered by the approved session exemption.",
          next_step: "Continue without creating another pending approval.",
        },
      })).toMatchObject({
        status: "approved",
        session_exempt: true,
        checkpoint_id: expect.any(Number),
      });
      expect(count(db, "approvals")).toBe(approvalCountBeforeExemption);
      expect(eventTypesAfter(db, exemptionSeq)).toEqual(["ticket.updated"]);
      expect(db.prepare(
        "SELECT title, action_type FROM checkpoints ORDER BY id DESC LIMIT 1",
      ).get()).toEqual({
        title: "已使用现有 Session 授权",
        action_type: null,
      });

      const storeTools = createAgentToolHandlers({
        db,
        itemId: storeClaim.itemId,
        runId: storeClaim.runId,
        now: () => now,
        checkpointPolicy: CHECKPOINT_POLICY,
      });
      await storeTools.call("ticket_update", {
        status: "review",
        reason: "store child complete",
        checkpoint: {
          kind: "completed",
          stage: "implementation",
          title: "Store child completed",
          summary: "The persistence child completed its assigned work.",
          next_step: "Run automatic review.",
        },
      });
      updateRun(db, storeClaim.runId, { state: "finished", endedAt: true });
      transition(db, {
        itemId: storeClaim.itemId,
        to: "done",
        actor: "system",
        reason: "accepted for parent projection",
        runId: storeClaim.runId,
        now,
      });
      const coordinator = createCoordinator({ db, now: () => now });
      coordinator.recordSubitemCompleted({
        parentItemId: root.id,
        childItemId: storeClaim.itemId,
        runId: storeClaim.runId,
      });
      const completionCounts = authorityCounts(db);
      coordinator.recordSubitemCompleted({
        parentItemId: root.id,
        childItemId: storeClaim.itemId,
        runId: storeClaim.runId,
      });
      expect(authorityCounts(db)).toEqual(completionCounts);
      expect(count(
        db,
        "checkpoints",
        "idempotency_key=?",
        [`subitem-completed:${root.id}:${storeClaim.itemId}:${storeClaim.runId}`],
      )).toBe(1);

      now = new Date(now.getTime() + 60_000);
      const completed = await rootTools.call("ticket_update", {
        body_append: "Task 10 backend acceptance handoff",
        status: "review",
        reason: "backend acceptance scenario complete",
        checkpoint: {
          kind: "completed",
          stage: "acceptance",
          title: "Backend acceptance scenario completed",
          summary: "The real SQLite, Coordinator, paired HTTP, and authority paths were exercised.",
          next_step: "Run independent review.",
        },
      }) as { checkpoint_id: number };
      expect(getItem(db, root.id)).toMatchObject({ stage: "review" });

      const cardsResponse = await fetch(
        `${server.base}/v1/kernel/conversation/cards?ticket_id=${root.id}`,
        { headers: auth(viewer.accessToken) },
      );
      expect(cardsResponse.status).toBe(200);
      const cards = await cardsResponse.json() as {
        items: any[]; checkpoints: any[]; interventionRefs: any[];
      };
      expect(cards.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "intervention", interventionId: `decision:${decision.request_id}` }),
        expect.objectContaining({ kind: "intervention", interventionId: `approval:${approvalId}` }),
        expect.objectContaining({ kind: "checkpoint", checkpointId: completed.checkpoint_id }),
      ]));
      expect(cards.checkpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: completed.checkpoint_id, kind: "completed" }),
      ]));
      expect(cards.interventionRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `decision:${decision.request_id}`, requiresAction: false }),
        expect.objectContaining({ id: `approval:${approvalId}`, requiresAction: false }),
      ]));

      const frozenEvents = listGatewayEvents(db, {
        afterSeq: 0,
        bindingId: full.bindingId,
        scopes: ["tickets:view", "approvals:respond"],
      });
      expect(frozenEvents.every((event) => Value.Check(GatewayEventSchema, event))).toBe(true);
      expect(frozenEvents.some((event) => event.type === ("checkpoint.created" as any))).toBe(false);
      expect(frozenEvents.some((event) => event.type === ("decision.required" as any))).toBe(false);
    } finally {
      await server.close();
      db.close();
    }
  }, 30_000);

  it("persists resources and repairs crash/startup state exactly once across real daemon restarts", async () => {
    const dataDir = tempDir("plc-checkpoint-control-plane-restart-");
    const dbPath = join(dataDir, "plc.db");
    const db = openDb(dbPath);
    const now = new Date(Date.now() + 5 * 60_000);
    const coordinator = createCoordinator({ db, now: () => now });

    const durableItemId = coordinator.createRootItem({
      title: "Durable checkpoint resource",
      brief: "Remain readable after database and daemon restart",
      createdBy: "lead",
    });
    transition(db, {
      itemId: durableItemId,
      to: "active",
      actor: "system",
      reason: "run started",
      now,
    });
    const durableRunId = createRun(db, { itemId: durableItemId, runtime: "codex" });
    updateRun(db, durableRunId, { state: "running" });
    markItemExecutionStarted(db, durableItemId, now);
    const durableCheckpoint = createCheckpointDomainService({ db, now: () => now }).submitCheckpoint({
      itemId: durableItemId,
      runId: durableRunId,
      kind: "completed",
      title: "Durable checkpoint",
      summary: "This checkpoint and its conversation card must survive reopening SQLite.",
      nextStep: "Verify through the restarted daemon control plane.",
    }).checkpoint;
    transition(db, {
      itemId: durableItemId,
      to: "review",
      actor: "child",
      reason: "durable terminal handoff",
      runId: durableRunId,
      now,
    });
    updateRun(db, durableRunId, { state: "finished", endedAt: true });

    const crashItemId = coordinator.createRootItem({
      title: "Crash recovery",
      brief: "Create deterministic crash and recovery checkpoints",
      createdBy: "lead",
    });
    transition(db, {
      itemId: crashItemId,
      to: "active",
      actor: "system",
      reason: "crashing run started",
      now,
    });
    const crashedRunId = createRun(db, { itemId: crashItemId, runtime: "claude" });
    updateRun(db, crashedRunId, { state: "running", pid: 999_999_999 });
    let recoveredRunId = 0;
    expect(recoverOrphans(db, {
      redispatch: (itemId) => {
        transition(db, {
          itemId,
          to: "active",
          actor: "system",
          reason: "Task 10 recovery redispatch",
          now,
        });
        recoveredRunId = createRun(db, { itemId, runtime: "claude" });
        updateRun(db, recoveredRunId, { state: "starting" });
        return true;
      },
    })).toBe(1);
    expect(getRun(db, crashedRunId)?.state).toBe("failed");
    expect(db.prepare(
      "SELECT idempotency_key FROM checkpoints WHERE item_id=? ORDER BY id",
    ).all(crashItemId)).toEqual([
      { idempotency_key: `run-crash:${crashedRunId}` },
      { idempotency_key: `run-recovered:${crashedRunId}:${recoveredRunId}` },
    ]);
    updateRun(db, recoveredRunId, { state: "finished", endedAt: true });
    expect(recoverOrphans(db)).toBe(0);
    expect(count(db, "checkpoints", "item_id=?", [crashItemId])).toBe(2);

    const startupRunItemId = coordinator.createRootItem({
      title: "Startup active run projection",
      brief: "Repair run-start checkpoint exactly once",
      createdBy: "system",
    });
    const startupRunId = createRun(db, {
      itemId: startupRunItemId,
      runtime: "pi",
    });
    updateRun(db, startupRunId, { state: "running" });
    expect(repairDaemonStartupState(db, now)).toEqual({
      approvals: 0,
      decisions: 0,
      runStarts: 1,
      reregistered: 0,
      reregistrationErrors: 0,
      outcomes: 1,
      handoffs: 1,
    });
    expect(repairDaemonStartupState(db, now)).toEqual({
      approvals: 0,
      decisions: 0,
      runStarts: 0,
      reregistered: 0,
      reregistrationErrors: 0,
      outcomes: 0,
      handoffs: 0,
    });
    expect(count(db, "checkpoints", "idempotency_key=?", [`run-start:${startupRunId}`])).toBe(1);
    updateRun(db, startupRunId, { state: "finished", endedAt: true });

    const legacyItemId = coordinator.createRootItem({
      title: "Legacy intervention repair",
      brief: "Daemon startup must create missing checkpoint/card/inbox projections",
      createdBy: "lead",
    });
    const legacyApprovalId = createApproval(db, {
      itemId: legacyItemId,
      requestedBy: "child",
      tool: "legacy-deploy",
      action: "Repair pending approval projection",
      now,
    });
    const legacyDecision = insertDecisionRequest(db, {
      itemId: legacyItemId,
      kind: "question",
      audience: "user",
      prompt: "Which repaired region?",
      options: [],
      allowCustom: true,
      now,
    });

    const bootstrap = await startPaired(db, () => now);
    const viewer = await pair(db, bootstrap.base, "restart-viewer", ["tickets:view"]);
    await bootstrap.close();
    db.close();

    const firstDaemon = await startDaemon({
      dataDir,
      dbPath,
      sessionFactory: leadSessionFactory() as any,
      gatewayPort: 0,
      log: () => {},
    });
    expect(firstDaemon.pairedPort).toEqual(expect.any(Number));
    const firstBase = `http://127.0.0.1:${firstDaemon.pairedPort}`;
    try {
      const checkpoints = await fetch(
        `${firstBase}/v1/kernel/tickets/${durableItemId}/checkpoints`,
        { headers: auth(viewer.accessToken) },
      );
      expect(checkpoints.status).toBe(200);
      expect(await checkpoints.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: durableCheckpoint.id, title: "Durable checkpoint" }),
        ]),
      });

      const cards = await fetch(
        `${firstBase}/v1/kernel/conversation/cards?ticket_id=${durableItemId}`,
        { headers: auth(viewer.accessToken) },
      );
      expect(cards.status).toBe(200);
      expect(await cards.json()).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({
          kind: "checkpoint",
          checkpointId: durableCheckpoint.id,
        })]),
      });

      const repairDb = openDb(dbPath);
      try {
        expect(count(repairDb, "checkpoints", "idempotency_key=?", [
          `legacy-approval:${legacyApprovalId}`,
        ])).toBe(1);
        expect(count(repairDb, "checkpoints", "idempotency_key=?", [
          `legacy-decision:${legacyDecision.id}`,
        ])).toBe(1);
        expect(count(repairDb, "conversation_cards", "item_id=?", [legacyItemId])).toBe(2);
        expect(count(repairDb, "inbox", "item_id=?", [legacyItemId])).toBe(2);
      } finally {
        repairDb.close();
      }
    } finally {
      await firstDaemon.close();
    }

    const beforeSecondStart = openDb(dbPath);
    const repairedCounts = authorityCounts(beforeSecondStart);
    beforeSecondStart.close();

    const secondDaemon = await startDaemon({
      dataDir,
      dbPath,
      sessionFactory: leadSessionFactory() as any,
      gatewayPort: 0,
      log: () => {},
    });
    try {
      const secondBase = `http://127.0.0.1:${secondDaemon.pairedPort}`;
      const workbench = await fetch(
        `${secondBase}/v1/kernel/tickets/${durableItemId}/workbench`,
        { headers: auth(viewer.accessToken) },
      );
      expect(workbench.status).toBe(200);
      expect(await workbench.json()).toMatchObject({
        ticket: { id: durableItemId },
        latestCheckpoints: expect.arrayContaining([
          expect.objectContaining({ id: durableCheckpoint.id }),
        ]),
      });

      const verifyDb = openDb(dbPath);
      try {
        expect(authorityCounts(verifyDb)).toEqual(repairedCounts);
        expect(count(verifyDb, "checkpoints", "idempotency_key=?", [
          `run-crash:${crashedRunId}`,
        ])).toBe(1);
        expect(count(verifyDb, "checkpoints", "idempotency_key=?", [
          `run-recovered:${crashedRunId}:${recoveredRunId}`,
        ])).toBe(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      await secondDaemon.close();
    }
  }, 30_000);
});
