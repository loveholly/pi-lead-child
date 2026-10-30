import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  KernelInterventionListResponseSchema,
  KernelTicketWorkbenchSchema,
  KernelTicketWorkbenchV2Schema,
  KernelTicketWorkItemListResponseSchema,
  KernelTicketWorkItemV2ListResponseSchema,
} from "@pi-lead-child/protocol";
import { createCoordinator } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { getDecisionRequest } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, redeemPairingById } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-workbench-http-"), "plc.db"));
});

function runtime() {
  return {
    model: "stub/model",
    sessionId: "stub-session",
    busy: false,
    runningItemIds: [],
    aish: null,
  };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, {
      runtime,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

// 扫码配对的手机（本机网页的邀请，被另一台设备兑换）。配对码兑换的设备做不了用户的决定（approvals:respond），
// 因为 child 用 plc.sock 的临时 admin token 也建得出配对码（.scratch/child-self-approve/options.md）。
async function token(_base: string, scopes: string[]) {
  const { pairingId } = createPairing(db, { name: "workbench-client", kind: "companion", scopes, origin: "web_invitation" });
  return redeemPairingById(db, pairingId, { peerIsThisMachine: false }).accessToken;
}

function seedWorkbench() {
  const coordinator = createCoordinator({ db, now: () => new Date("2026-07-24T09:00:00.000Z") });
  const itemId = coordinator.createRootItem({
    title: "Workbench",
    brief: "Open detail without N+1",
    createdBy: "system",
  });
  const otherItemId = coordinator.createRootItem({
    title: "Other",
    brief: "Batch filtering",
    createdBy: "system",
  });
  const runId = createRun(db, { itemId, runtime: "claude", model: "claude-opus" });
  updateRun(db, runId, { state: "running", externalSessionId: "session-1" });
  const request = coordinator.requestDecision({
    itemId,
    runId,
    kind: "decision",
    audience: "user",
    allowCustom: false,
    prompt: "Choose a deployment target containing privileged context",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    checkpoint: {
      title: "Deployment target required",
      summary: "Execution is waiting for an explicit target.",
      nextStep: "Deploy to the selected target.",
    },
  });
  const leadOnly = coordinator.requestDecision({
    itemId,
    runId,
    kind: "question",
    audience: "lead",
    allowCustom: true,
    prompt: "Lead-only routing question",
    options: [],
    checkpoint: {
      title: "Lead routing input required",
      summary: "Only Lead may answer this question.",
    },
  });
  coordinator.submitCheckpoint({
    itemId,
    runId,
    kind: "milestone",
    title: "Workbench projection ready",
    summary: "The v2 workbench can project explicit progress and proof.",
    progress: { current: 2, total: 3, label: "HTTP fidelity" },
    proofItems: [{
      id: "workbench-http",
      label: "Workbench HTTP projection",
      state: "passed",
      evidence: "served by the paired API",
    }],
  });
  return { itemId, otherItemId, requestId: request.requestId, leadOnlyId: leadOnly.requestId };
}

describe("work-item and workbench HTTP resources", () => {
  it("serves filtered batch work items and a safe composite workbench", async () => {
    const { itemId, otherItemId } = seedWorkbench();
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };
      const itemsResponse = await fetch(
        `${server.base}/v1/kernel/work-items?ticket_id=${otherItemId}&ticket_id=${itemId}`,
        { headers },
      );
      expect(itemsResponse.status).toBe(200);
      const itemsBody = await itemsResponse.json();
      expect(Value.Check(KernelTicketWorkItemListResponseSchema, itemsBody)).toBe(true);
      expect(itemsBody.items.map((item: any) => item.ticketId)).toEqual([itemId, otherItemId]);
      expect(itemsBody.items[0]).toMatchObject({
        ticketId: itemId,
        activeExecution: {
          runtime: "claude",
          state: "running",
          externalSessionId: "session-1",
        },
        pendingInterventionCount: 2,
        latestCheckpointId: expect.any(Number),
      });

      const v2ItemsResponse = await fetch(
        `${server.base}/v1/kernel/v2/work-items?ticket_id=${otherItemId}&ticket_id=${itemId}`,
        { headers },
      );
      expect(v2ItemsResponse.status).toBe(200);
      const v2ItemsBody = await v2ItemsResponse.json();
      expect(Value.Check(KernelTicketWorkItemV2ListResponseSchema, v2ItemsBody)).toBe(true);
      expect(v2ItemsBody.items[0]).toMatchObject({
        ticketId: itemId,
        progress: {
          current: 2,
          total: 3,
          percent: 67,
          label: "HTTP fidelity",
          source: "explicit",
          checkpointId: expect.any(Number),
        },
      });

      const workbenchResponse = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/workbench`,
        { headers },
      );
      expect(workbenchResponse.status).toBe(200);
      const workbench = await workbenchResponse.json();
      expect(Value.Check(KernelTicketWorkbenchSchema, workbench)).toBe(true);
      expect(workbench).toMatchObject({
        ticket: { id: itemId },
        activeAttempt: { runtime: "claude" },
        interventionRefs: [
          expect.objectContaining({ ticketId: itemId, requiresAction: true }),
          expect.objectContaining({ ticketId: itemId, requiresAction: true }),
        ],
      });
      expect(JSON.stringify(workbench)).not.toContain("privileged context");
      expect(JSON.stringify(workbench)).not.toContain("Production");

      const v2WorkbenchResponse = await fetch(
        `${server.base}/v1/kernel/v2/tickets/${itemId}/workbench`,
        { headers },
      );
      expect(v2WorkbenchResponse.status).toBe(200);
      const v2Workbench = await v2WorkbenchResponse.json();
      expect(Value.Check(KernelTicketWorkbenchV2Schema, v2Workbench)).toBe(true);
      expect(v2Workbench).toMatchObject({
        ticket: { id: itemId },
        progress: { current: 2, total: 3, percent: 67, source: "explicit" },
        pow: {
          verdict: "attention",
          items: [{ id: "workbench-http", state: "passed" }],
          metrics: {
            passed: 1,
            total: 1,
            pendingInterventionCount: 2,
          },
        },
      });

      const missing = await fetch(`${server.base}/v1/kernel/tickets/999999/workbench`, { headers });
      expect(missing.status).toBe(404);
      const missingV2 = await fetch(`${server.base}/v1/kernel/v2/tickets/999999/workbench`, { headers });
      expect(missingV2.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("requires approvals:respond for full reads and strict audience-aware resolution", async () => {
    const { requestId, leadOnlyId } = seedWorkbench();
    const server = await start();
    try {
      const readOnly = await token(server.base, ["tickets:view"]);
      const denied = await fetch(`${server.base}/v1/kernel/interventions`, {
        headers: { authorization: `Bearer ${readOnly}` },
      });
      expect(denied.status).toBe(403);

      const responder = await token(server.base, ["approvals:respond"]);
      const headers = {
        authorization: `Bearer ${responder}`,
        "content-type": "application/json",
      };
      const full = await fetch(
        `${server.base}/v1/kernel/interventions?state=pending&id=decision:${requestId}`,
        { headers },
      );
      expect(full.status).toBe(200);
      const fullBody = await full.json();
      expect(Value.Check(KernelInterventionListResponseSchema, fullBody)).toBe(true);
      expect(fullBody.items).toEqual([expect.objectContaining({
        id: `decision:${requestId}`,
        detail: "Choose a deployment target containing privileged context",
        actions: expect.arrayContaining([
          { kind: "select", optionId: "staging", label: "Staging" },
        ]),
      })]);

      const mismatch = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${requestId}/resolve`,
        { method: "POST", headers, body: JSON.stringify({ authority: "approval", decision: "approve" }) },
      );
      expect(mismatch.status).toBe(400);

      const leadDenied = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${leadOnlyId}/resolve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            authority: "decision_request",
            decision: "respond",
            resolution: "user must not answer lead-only",
          }),
        },
      );
      expect(leadDenied.status).toBe(403);

      const input = {
        authority: "decision_request",
        decision: "select",
        optionId: "staging",
      };
      const resolved = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${requestId}/resolve`,
        { method: "POST", headers, body: JSON.stringify(input) },
      );
      expect(resolved.status).toBe(200);
      expect(getDecisionRequest(db, requestId)).toMatchObject({
        state: "resolved",
        selectedOptionId: "staging",
      });

      const retry = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${requestId}/resolve`,
        { method: "POST", headers, body: JSON.stringify(input) },
      );
      expect(retry.status).toBe(200);

      const conflict = await fetch(
        `${server.base}/v1/kernel/interventions/decision:${requestId}/resolve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, optionId: "production" }),
        },
      );
      expect(conflict.status).toBe(409);
    } finally {
      await server.close();
    }
  });
});
