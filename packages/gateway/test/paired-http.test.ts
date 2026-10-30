import { beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  ConversationTurnSchema,
  KernelAttemptSchema,
  KernelCapabilityListResponseSchema,
  KernelLearningCandidateListResponseSchema,
  NotificationListResponseSchema,
  KernelProjectSchema,
  KernelRuntimeEventListResponseSchema,
  KernelTicketDependencyListResponseSchema,
  KernelTicketListResponseSchema,
  KernelTicketSchema,
  WorkspaceActionResultSchema,
} from "@pi-lead-child/protocol";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, redeemPairingById } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { createApproval, getApproval } from "@pi-lead-child/store";
import { addNotification } from "@pi-lead-child/store";
import { createTurn, markTurnInserted, publishGatewayEvent, settleTurnAnsweredWith } from "@pi-lead-child/store";
import { completeTurn, recordTicketReplyActions } from "@pi-lead-child/store";
import { addInbox, addLeadFollowUp, cancelLeadFollowUp, recordInboxDisposition, recordSeenDispositions } from "@pi-lead-child/store";
import { createCoordinator } from "@pi-lead-child/engine";
import { createProject, linkProjectRepository } from "@pi-lead-child/store";
import { createRuntimeEventStore } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
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

async function start(opts?: {
  maxBodyBytes?: number;
  redeemMaxAttempts?: number;
  allowLoopbackAutoPair?: boolean;
  loopbackAutoPairOrigins?: string[];
  host?: string;
}) {
  const controlPlane = createControlPlaneService(db, { runtime });
  const server = await startPairedServer({
    db,
    controlPlane,
   
    hello: () => runtime(),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0, ...opts });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function redeem(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ access_token: string; binding: { id: number; kind: string; scopes: string[] } }>;
}

// 本机网页的邀请，被另一台设备扫码兑换：用户的手机。配对码（redeem）兑换的设备做不了用户的决定（approvals:respond），
// 因为 child 用 plc.sock 的临时 admin token 也建得出配对码（.scratch/child-self-approve/options.md）。
function scannedPhone(scopes: string[]) {
  const { pairingId } = createPairing(db, { name: "phone", kind: "companion", scopes, origin: "web_invitation" });
  const { binding, accessToken } = redeemPairingById(db, pairingId, { peerIsThisMachine: false });
  return { access_token: accessToken, binding };
}

describe("paired HTTP control-plane", () => {
  it("auto-pairs only enabled loopback requests from an exact allowed origin", async () => {
    const enabled = await start({
      allowLoopbackAutoPair: true,
      loopbackAutoPairOrigins: ["http://localhost:8081"],
      host: "0.0.0.0",
    });
    try {
      const paired = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8081" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(paired.status).toBe(201);
      expect(await paired.json()).toEqual({
        binding: expect.objectContaining({
          id: expect.any(Number),
          kind: "companion",
          name: "localhost-web",
          scopes: ["chat", "tickets:view", "tickets:create", "approvals:respond", "notices"],
        }),
        access_token: expect.any(String),
      });
      const pairedBody = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8081" },
        body: JSON.stringify({ name: "localhost-web-owner-check" }),
      }).then((response) => response.json()) as { access_token: string };
      const created = await fetch(`${enabled.base}/v1/tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${pairedBody.access_token}`,
        },
        body: JSON.stringify({ title: "loopback owner can create", brief: "localhost web is the user" }),
      });
      expect(created.status).toBe(201);

      const missingOrigin = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(missingOrigin.status).toBe(403);

      const wrongOrigin = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8082" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(wrongOrigin.status).toBe(403);
    } finally {
      await enabled.close();
    }

    const disabled = await start({ allowLoopbackAutoPair: false });
    try {
      const response = await fetch(`${disabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8081" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await disabled.close();
    }
  });

  it("requires the actual Companion port to be explicitly allowed before issuing credentials", async () => {
    const enabled = await start({ allowLoopbackAutoPair: true, loopbackAutoPairOrigins: ["http://localhost:49211"] });
    try {
      const denied = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:49163" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(denied.status).toBe(403);
      const response = await fetch(`${enabled.base}/v1/paired/loopback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:49211" },
        body: JSON.stringify({ name: "localhost-web" }),
      });
      expect(response.status).toBe(201);
    } finally {
      await enabled.close();
    }
  });

  it("requires authentication and enforces route scopes", async () => {
    const server = await start();
    try {
      expect((await fetch(`${server.base}/v1/tickets`)).status).toBe(401);
      const { access_token } = await redeem(server.base, ["chat"]);
      const forbidden = await fetch(`${server.base}/v1/tickets`, {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({
        error: { code: "forbidden", message: "missing scope: tickets:view" },
      });
    } finally {
      await server.close();
    }
  });

  it("serves and acknowledges durable user notifications through the notices scope", async () => {
    const itemId = createItem(db, { title: "notify", brief: "b", createdBy: "system" });
    const notificationId = addNotification(db, {
      itemId,
      kind: "review_failed",
      urgency: "immediate",
      title: "review failed",
      body: "needs rework",
      dedupKey: "review-failed:test",
    });
    const server = await start();
    try {
      const noNotices = await redeem(server.base, ["tickets:view"]);
      const forbidden = await fetch(`${server.base}/v1/notifications`, {
        headers: { authorization: `Bearer ${noNotices.access_token}` },
      });
      expect(forbidden.status).toBe(403);

      const { access_token } = await redeem(server.base, ["tickets:view", "notices"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const overview = await fetch(`${server.base}/v1/overview`, { headers });
      expect(await overview.json()).toMatchObject({ counts: { unreadNotices: 1 } });

      const list = await fetch(`${server.base}/v1/notifications`, { headers });
      const listed = await list.json();
      expect(Value.Check(NotificationListResponseSchema, listed)).toBe(true);
      expect(listed).toEqual({
        items: [expect.objectContaining({
          id: notificationId,
          ticketId: itemId,
          kind: "review_failed",
          state: "pending",
          title: "review failed",
        })],
      });

      const ack = await fetch(`${server.base}/v1/notifications/${notificationId}/ack`, {
        method: "POST",
        headers,
      });
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({
        notification: expect.objectContaining({ id: notificationId, state: "acked", ackedAt: expect.any(String) }),
      });
      expect(await (await fetch(`${server.base}/v1/notifications`, { headers })).json())
        .toEqual({ items: [] });
      expect(await (await fetch(`${server.base}/v1/notifications?state=acked`, { headers })).json())
        .toEqual({ items: [expect.objectContaining({ id: notificationId, state: "acked" })] });
      expect(await (await fetch(`${server.base}/v1/overview`, { headers })).json())
        .toMatchObject({ counts: { unreadNotices: 0 } });
    } finally {
      await server.close();
    }
  });

  it("serves overview and ticket snapshot resources", async () => {
    const projectId = createProject(db, { name: "alpha", createdBy: "lead" });
    const emptyProjectId = createProject(db, { name: "empty", createdBy: "lead" });
    const itemId = createItem(db, {
      title: "协议实现", brief: "实现 API", createdBy: "system",
      project: "alpha", projectId,
    });
    createItem(db, { title: "未归属", brief: "unknown", createdBy: "system" });
    const server = await start();
    try {
      const { access_token, binding } = await redeem(server.base, ["chat", "tickets:view"]);
      expect(binding).toMatchObject({ kind: "companion", scopes: ["chat", "tickets:view"] });
      expect((binding as any).token_hash).toBeUndefined();
      const headers = { authorization: `Bearer ${access_token}` };

      const overview = await fetch(`${server.base}/v1/overview`, { headers });
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ model: "stub/model", sessionId: "stub-session" });

      const tickets = await fetch(`${server.base}/v1/tickets?project=alpha`, { headers });
      expect(await tickets.json()).toEqual({ items: [expect.objectContaining({ id: itemId, project: "alpha" })] });

      expect(await (await fetch(`${server.base}/v1/tickets/${itemId}`, { headers })).json())
        .toMatchObject({ ticket: { id: itemId }, brief: "实现 API" });
      expect(await (await fetch(`${server.base}/v1/tickets/${itemId}/activities`, { headers })).json())
        .toEqual({ items: [] });
      expect(await (await fetch(`${server.base}/v1/tickets/${itemId}/attempts`, { headers })).json())
        .toEqual({ items: [] });
      expect(await (await fetch(`${server.base}/v1/projects`, { headers })).json())
        .toEqual({ items: [
          expect.objectContaining({ id: String(projectId), name: "alpha", ticketCount: 1 }),
          expect.objectContaining({ id: String(emptyProjectId), name: "empty", ticketCount: 0 }),
          expect.objectContaining({ id: "unknown", name: "unknown", ticketCount: 1 }),
        ] });

      const missing = await fetch(`${server.base}/v1/tickets/9999`, { headers });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: "ticket not found" } });
    } finally {
      await server.close();
    }
  });

  it("creates root tickets through the Coordinator with strict tickets:create input", async () => {
    const server = await start();
    try {
      const readOnly = await redeem(server.base, ["tickets:view"]);
      const forbidden = await fetch(`${server.base}/v1/tickets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${readOnly.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Create", brief: "Must be forbidden" }),
      });
      expect(forbidden.status).toBe(403);

      const creator = await redeem(server.base, ["tickets:create"]);
      const createHeaders = {
        authorization: `Bearer ${creator.access_token}`,
        "content-type": "application/json",
      };
      for (const invalidBody of [
        { title: "", brief: "empty title" },
        { title: "   ", brief: "blank title" },
        { title: "extra", brief: "strict", unexpected: true },
        { title: "ambiguous", brief: "project", project: "alpha", projectId: 1 },
        { title: "runtime", brief: "invalid", runtime: "shell" },
      ]) {
        const invalid = await fetch(`${server.base}/v1/tickets`, {
          method: "POST", headers: createHeaders, body: JSON.stringify(invalidBody),
        });
        expect(invalid.status).toBe(400);
        expect((await invalid.json() as any).error.code).toBe("invalid_request");
      }

      const created = await fetch(`${server.base}/v1/tickets`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify({
          title: "  Kernel protocol  ",
          brief: "  Create through Coordinator  ",
          priority: "high",
          project: "control-plane",
          runtime: "codex",
          purpose: "execution",
          verificationPolicy: "independent_reviewer",
        }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(Value.Check(KernelTicketSchema, body)).toBe(true);
      expect(body).toMatchObject({
        title: "Kernel protocol",
        brief: "Create through Coordinator",
        priority: "high",
        project: "control-plane",
        projectId: expect.any(Number),
        parentTicketId: null,
        requestedRuntime: "codex",
        verificationPolicy: "independent_reviewer",
        createdBy: "user",
      });
    } finally {
      await server.close();
    }
  });

  it("serves scoped kernel snapshots and returns 404 for missing singular resources", async () => {
    const projectId = createProject(db, {
      name: "kernel-http", summary: "HTTP snapshots", createdBy: "lead",
    });
    linkProjectRepository(db, projectId, {
      repoRoot: "/tmp/kernel-http", repoName: "kernel-http", role: "primary",
    });
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({
      title: "root", brief: "root", createdBy: "system", projectId,
    });
    const ownerRunId = createRun(db, { itemId: rootId, runtime: "pi" });
    updateRun(db, ownerRunId, { state: "running" });
    const revision = coordinator.beginPlanning({ itemId: rootId, runId: ownerRunId });
    const firstId = coordinator.createSubitem({ itemId: rootId, runId: ownerRunId, revision }, {
      title: "first", brief: "first",
    });
    const secondId = coordinator.createSubitem({ itemId: rootId, runId: ownerRunId, revision }, {
      title: "second", brief: "second",
    });
    coordinator.addDependency({ itemId: rootId, runId: ownerRunId, revision }, secondId, firstId);
    coordinator.finishPlanning({ itemId: rootId, runId: ownerRunId, revision });
    createRuntimeEventStore(db, { dataDir: tempDir("plc-http-events-") }).persist({
      type: "run.started",
      runId: ownerRunId,
      seq: 1,
      occurredAt: "2026-07-23T05:00:00.000Z",
      runtime: "pi",
      model: null,
    });
    const candidateId = Number(db.prepare(
      `INSERT INTO learning_candidates
       (project_id, scope_key, item_id, run_id, fingerprint, kind, summary, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId, `project:${projectId}`, rootId, ownerRunId,
      "failure:http", "runtime_failure", "HTTP test failure", JSON.stringify({ code: "http" }),
    ).lastInsertRowid);
    db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, scope, status, summary, source_candidates, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId, `project:${projectId}`, "runbook", "http-recovery", "HTTP recovery",
      "project", "draft", "Recover HTTP tests", JSON.stringify([candidateId]), JSON.stringify({ source: "test" }),
    );

    const server = await start();
    try {
      const chatOnly = await redeem(server.base, ["chat"]);
      const noScope = await fetch(`${server.base}/v1/kernel/tickets/${rootId}`, {
        headers: { authorization: `Bearer ${chatOnly.access_token}` },
      });
      expect(noScope.status).toBe(403);

      const viewer = await redeem(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${viewer.access_token}` };
      const project = await fetch(`${server.base}/v1/kernel/projects/${projectId}`, { headers });
      expect(project.status).toBe(200);
      expect(Value.Check(KernelProjectSchema, await project.json())).toBe(true);

      const ticket = await fetch(`${server.base}/v1/kernel/tickets/${rootId}`, { headers });
      expect(Value.Check(KernelTicketSchema, await ticket.json())).toBe(true);

      const children = await fetch(`${server.base}/v1/kernel/tickets/${rootId}/children`, { headers });
      const childrenBody = await children.json();
      expect(Value.Check(KernelTicketListResponseSchema, childrenBody)).toBe(true);
      expect(childrenBody.items.map((item: any) => item.id)).toEqual([firstId, secondId]);

      const dependencies = await fetch(`${server.base}/v1/kernel/tickets/${secondId}/dependencies`, { headers });
      const dependenciesBody = await dependencies.json();
      expect(Value.Check(KernelTicketDependencyListResponseSchema, dependenciesBody)).toBe(true);
      expect(dependenciesBody.items).toEqual([
        expect.objectContaining({ ticketId: secondId, dependsOnTicketId: firstId }),
      ]);

      const attempt = await fetch(`${server.base}/v1/kernel/attempts/${ownerRunId}`, { headers });
      expect(Value.Check(KernelAttemptSchema, await attempt.json())).toBe(true);

      const events = await fetch(`${server.base}/v1/kernel/attempts/${ownerRunId}/events`, { headers });
      expect(Value.Check(KernelRuntimeEventListResponseSchema, await events.json())).toBe(true);

      const candidates = await fetch(`${server.base}/v1/kernel/learning/candidates`, { headers });
      expect(Value.Check(KernelLearningCandidateListResponseSchema, await candidates.json())).toBe(true);

      const capabilities = await fetch(`${server.base}/v1/kernel/capabilities`, { headers });
      expect(Value.Check(KernelCapabilityListResponseSchema, await capabilities.json())).toBe(true);

      for (const path of [
        "/v1/kernel/projects/9999",
        "/v1/kernel/tickets/9999",
        "/v1/kernel/tickets/9999/children",
        "/v1/kernel/tickets/9999/dependencies",
        "/v1/kernel/attempts/9999",
        "/v1/kernel/attempts/9999/events",
      ]) {
        const missing = await fetch(`${server.base}${path}`, { headers });
        expect(missing.status, path).toBe(404);
        expect((await missing.json() as any).error.code).toBe("not_found");
      }
    } finally {
      await server.close();
    }
  });

  it("resolves approvals with audit identity and returns conflict on duplicates", async () => {
    const itemId = createItem(db, { title: "approve", brief: "b", createdBy: "system" });
    const approvalId = createApproval(db, {
      itemId, requestedBy: "child", tool: "delete", action: "删除临时资源",
    });
    const server = await start();
    try {
      const { access_token, binding } = scannedPhone(["approvals:respond"]);
      const headers = {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      };
      const approvals = await fetch(`${server.base}/v1/approvals`, { headers });
      expect(await approvals.json()).toEqual({ items: [expect.objectContaining({ id: approvalId })] });

      const resolved = await fetch(`${server.base}/v1/approvals/${approvalId}/resolve`, {
        method: "POST", headers, body: JSON.stringify({ decision: "approve_session" }),
      });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toEqual({ approvalId, status: "approved", sessionExempt: true });
      expect(getApproval(db, approvalId)).toMatchObject({
        status: "approved", session_exempt: 1,
        resolved_by: `user via paired binding:${binding.id}`,
      });
      expect(db.prepare(
        "SELECT kind, action_type, action_id FROM checkpoints WHERE item_id=? ORDER BY id",
      ).all(itemId)).toEqual([
        { kind: "progress", action_type: "approval", action_id: approvalId },
      ]);
      expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all()).toEqual([
        { event_type: "approval.resolved" },
        { event_type: "ticket.updated" },
      ]);

      const identical = await fetch(`${server.base}/v1/approvals/${approvalId}/resolve`, {
        method: "POST", headers, body: JSON.stringify({ decision: "approve_session" }),
      });
      expect(identical.status).toBe(200);
      expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 1 });

      const duplicate = await fetch(`${server.base}/v1/approvals/${approvalId}/resolve`, {
        method: "POST", headers, body: JSON.stringify({ decision: "reject" }),
      });
      expect(duplicate.status).toBe(409);
      expect((await duplicate.json() as any).error.code).toBe("conflict");
    } finally {
      await server.close();
    }
  });

  it("supports loopback CORS and issues short-lived websocket tickets", async () => {
    const server = await start();
    try {
      const preflight = await fetch(`${server.base}/v1/tickets`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:49160", "access-control-request-headers": "authorization" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:49160");

      const { access_token } = await redeem(server.base, ["chat"]);
      const ticket = await fetch(`${server.base}/v1/paired/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, origin: "http://localhost:49160" },
      });
      expect(ticket.status).toBe(201);
      expect(await ticket.json()).toEqual({
        ws_ticket: expect.stringMatching(/^wst_/),
        expires_at: expect.stringMatching(/Z$/),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed numeric query parameters before they reach SQLite", async () => {
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat", "tickets:view"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const badTicket = await fetch(`${server.base}/v1/conversation/turns?ticket_id=not-a-number`, { headers });
      expect(badTicket.status).toBe(400);
      expect((await badTicket.json() as any).error.code).toBe("invalid_request");

      const badLimit = await fetch(`${server.base}/v1/conversation/turns?limit=0`, { headers });
      expect(badLimit.status).toBe(400);
      expect((await badLimit.json() as any).error.message).toContain("limit");
    } finally {
      await server.close();
    }
  });

  // 2026-10-15 方案 A「Lead 动态」：Lead 处理了、但没有对用户说的事，在会话里收成一块淡色的动态，
  // 不占一个对话回合。只列 Lead 自己说了处置的事：延后、不处理、自己修好。告诉过用户的已经在对话里，
  // 自动记的「看过了」和取消的跟进是 Lead 的内部记账，不列。
  it("lists what Lead handled without telling the user, oldest first", async () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    const add = (summary: string) => addInbox(db, { itemId, severity: "blocker", source: "semantic", summary, lossless: true }).id!;
    const deferred = add("核查报了缺陷 F2");
    const ignored = add("工单 #66 异常频繁");
    const told = add("核查报了缺陷 F1");
    const seen = add("例行完成");
    recordInboxDisposition(db, [deferred], { disposition: "deferred", reason: "等最终结论一起说", at: new Date("2026-10-15T10:10:29.000Z") });
    recordInboxDisposition(db, [ignored], { disposition: "no_action", reason: "这些是核查的发现，不是故障", at: new Date("2026-10-15T10:14:40.000Z") });
    recordInboxDisposition(db, [told], { disposition: "told_user", reason: "已告诉用户", at: new Date("2026-10-15T10:04:22.000Z") });
    recordSeenDispositions(db, [seen], new Date("2026-10-15T10:15:00.000Z"));
    const followUp = addLeadFollowUp(db, { at: new Date("2026-10-15T11:10:00.000Z"), note: "看最终报告", itemId });
    cancelLeadFollowUp(db, followUp, { reason: "已经出来了" });

    const server = await start();
    try {
      const denied = await fetch(`${server.base}/v1/lead/activity`, {
        headers: { authorization: `Bearer ${(await redeem(server.base, ["tickets:view"])).access_token}` },
      });
      expect(denied.status).toBe(403);
      const { access_token } = await redeem(server.base, ["chat"]);
      const response = await fetch(`${server.base}/v1/lead/activity`, { headers: { authorization: `Bearer ${access_token}` } });
      expect(response.status).toBe(200);
      const { items } = await response.json() as { items: Array<Record<string, unknown>> };
      expect(items).toEqual([
        { id: deferred, at: "2026-10-15T10:10:29.000Z", disposition: "deferred", reason: "等最终结论一起说", summary: "核查报了缺陷 F2", ticketId: itemId },
        { id: ignored, at: "2026-10-15T10:14:40.000Z", disposition: "no_action", reason: "这些是核查的发现，不是故障", summary: "工单 #66 异常频繁", ticketId: itemId },
      ]);
    } finally {
      await server.close();
    }
  });

  // generative UI（2026-10-15）：Lead 在一轮里生成的富交互卡片，刷新以后和实时看到的一样。
  // 只在客户端要（include=surfaces）时才带：旧客户端严格校验每一轮，多一个字段就整页失败。
  it("returns the surfaces Lead rendered in a turn when asked", async () => {
    const turn = createTurn(db, { originKind: "system:blocker", userText: "" });
    const surface = {
      id: "s1", catalogVersion: 1, root: "t", fallbackText: "#66 核查不通过，需要你决定。",
      nodes: [{ id: "t", type: "Text", props: { text: "核查不通过" } }],
    };
    publishGatewayEvent(db, {
      type: "lead.tool.updated", requiredScope: "chat", turnId: turn.id,
      payload: { toolCallId: "call-1", toolName: "render_ui", textOffset: 12, surface, partial: true },
    });
    publishGatewayEvent(db, {
      type: "lead.tool.updated", requiredScope: "chat", turnId: turn.id,
      payload: { toolCallId: "call-1", toolName: "render_ui", textOffset: 12, surface },
    });
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const plain = await (await fetch(`${server.base}/v1/conversation/turns`, { headers })).json() as { items: Array<Record<string, unknown>> };
      expect(plain.items[0]).not.toHaveProperty("surfaces");
      const asked = await (await fetch(`${server.base}/v1/conversation/turns?include=tool_calls,surfaces`, { headers })).json() as { items: Array<Record<string, unknown>> };
      expect(asked.items[0]!.surfaces).toEqual([{ callId: "call-1", textOffset: 12, surface }]);
    } finally {
      await server.close();
    }
  });

  // 工单 04（spec D10）：用户的消息怎么放的，刷新以后和实时看到的一样。只在客户端要（include=placement）时才带。
  it("returns how each user message was placed when asked", async () => {
    const base = Date.parse("2026-10-17T01:00:00.000Z");
    const answered = createTurn(db, { originKind: "paired:companion", userText: "第一句", state: "streaming", now: new Date(base) });
    const steer = createTurn(db, { originKind: "paired:companion", userText: "插话", state: "queued", now: new Date(base + 1_000) });
    const queued = createTurn(db, { originKind: "paired:companion", userText: "排队", state: "queued", now: new Date(base + 2_000) });
    const inFlight = createTurn(db, { originKind: "paired:companion", userText: "还在路上", state: "queued", now: new Date(base + 3_000) });
    markTurnInserted(db, steer.id);
    markTurnInserted(db, inFlight.id);
    settleTurnAnsweredWith(db, answered.id, { answeredWith: steer.id, note: "和后面的插话一起回答" });
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const plain = await (await fetch(`${server.base}/v1/conversation/turns`, { headers })).json() as { items: Array<Record<string, unknown>> };
      expect(plain.items.some((turn) => "placement" in turn)).toBe(false);
      const asked = await (await fetch(`${server.base}/v1/conversation/turns?include=tool_calls,surfaces,placement`, { headers })).json() as
        { items: Array<{ id: string; placement?: string; answeredWith?: string }> };
      const byId = Object.fromEntries(asked.items.map((turn) => [turn.id, turn]));
      expect(byId[answered.id]).toMatchObject({ placement: "answered_together", answeredWith: steer.id });
      expect(byId[queued.id]).toMatchObject({ placement: "queued" });
      expect(byId[inFlight.id]).toMatchObject({ placement: "steered" });
      expect(byId[inFlight.id]).not.toHaveProperty("answeredWith");
    } finally {
      await server.close();
    }
  });

  // 2026-10-19：工单 agent 的回复在问你要不要做哪几个动作（daemon 用 SmartModel 判断，记成事件）。刷新、重连以后
  // 照样读得回来。只在客户端要（include=reply_actions）时才带：旧客户端严格校验每一轮，多一个字段整页失败。
  it("returns the actions a ticket reply asks about only when asked", async () => {
    const itemId = createItem(db, { title: "核查", brief: "b", createdBy: "user" });
    const asking = createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "进展？", state: "streaming" });
    completeTurn(db, asking.id);
    const reporting = createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "好", state: "streaming" });
    completeTurn(db, reporting.id);
    const unjudged = createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "还在吗", state: "streaming" });
    completeTurn(db, unjudged.id);
    recordTicketReplyActions(db, { turnId: asking.id, itemId, actions: ["request_review", "complete"], backend: "jev" });
    // 同一轮只记一次。
    recordTicketReplyActions(db, { turnId: asking.id, itemId, actions: ["cancel"], backend: "jev" });
    recordTicketReplyActions(db, { turnId: reporting.id, itemId, actions: [], backend: "llm" });
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const plain = await (await fetch(`${server.base}/v1/conversation/turns?ticket_id=${itemId}&include=tool_calls,surfaces,placement`, { headers }))
        .json() as { items: Array<Record<string, unknown>> };
      expect(plain.items.some((turn) => "replyActions" in turn)).toBe(false);
      for (const turn of plain.items) expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
      const asked = await (await fetch(`${server.base}/v1/conversation/turns?ticket_id=${itemId}&include=reply_actions`, { headers }))
        .json() as { items: Array<{ id: string; replyActions?: string[] }> };
      const byId = Object.fromEntries(asked.items.map((turn) => [turn.id, turn]));
      expect(byId[asking.id]!.replyActions).toEqual(["request_review", "complete"]);
      expect(byId[reporting.id]!.replyActions).toEqual([]);
      expect(byId[unjudged.id]).not.toHaveProperty("replyActions");
      for (const turn of asked.items) expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
    } finally {
      await server.close();
    }
  });

  // 工单 06（04 留下的显示问题）：插话赶不上这一轮、转为下一轮的输入时，界面写「下一轮回答」。以前只有实时事件带着它，
  // 刷新以后快照只看 channel_turns 的 steered，变回「已插入」。daemon 发的 lead.turn.started 已经落在账本里，快照读最后一条。
  it("keeps 'answered in the next round' after a reload", async () => {
    const steer = createTurn(db, { originKind: "paired:companion", userText: "插话", state: "queued" });
    const carried = createTurn(db, { originKind: "paired:companion", userText: "赶不上的插话", state: "queued" });
    const answering = createTurn(db, { originKind: "paired:companion", userText: "开始答了", state: "queued" });
    for (const turn of [steer, carried, answering]) {
      markTurnInserted(db, turn.id);
      publishGatewayEvent(db, {
        type: "lead.turn.started", requiredScope: "chat", turnId: turn.id,
        payload: { messageId: `msg_${turn.id}`, commandId: null, originKind: "paired:companion", mode: "steered", placement: "steered" },
      });
    }
    for (const turn of [carried, answering]) {
      publishGatewayEvent(db, {
        type: "lead.turn.started", requiredScope: "chat", turnId: turn.id,
        payload: { messageId: `msg_${turn.id}`, commandId: null, originKind: "paired:companion", mode: "steered", placement: "next_turn" },
      });
    }
    // 下一轮开始答它了：最后一条是 started，不再是「下一轮回答」。
    publishGatewayEvent(db, {
      type: "lead.turn.started", requiredScope: "chat", turnId: answering.id,
      payload: { messageId: `msg_${answering.id}`, commandId: null, originKind: "paired:companion", mode: "started" },
    });
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat"]);
      const headers = { authorization: `Bearer ${access_token}` };
      const asked = await (await fetch(`${server.base}/v1/conversation/turns?include=tool_calls,surfaces,placement`, { headers })).json() as
        { items: Array<{ id: string; placement?: string }> };
      const byId = Object.fromEntries(asked.items.map((turn) => [turn.id, turn]));
      expect(byId[carried.id]).toMatchObject({ placement: "next_turn" });
      expect(byId[steer.id]).toMatchObject({ placement: "steered" });
      expect(byId[answering.id]).toMatchObject({ placement: "steered" });
    } finally {
      await server.close();
    }
  });

  // companion 刷新会话时不带 limit：缺省的 100 轮必须是最近的 100 轮。
  it("returns the newest conversation turns, oldest first, when there are more than the default limit", async () => {
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    for (let index = 1; index <= 101; index += 1) {
      createTurn(db, {
        id: `turn-${String(index).padStart(3, "0")}`, originKind: "companion", userText: `第 ${index} 句`,
        now: new Date(base + index * 60_000),
      });
    }
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat"]);
      const response = await fetch(`${server.base}/v1/conversation/turns`, { headers: { authorization: `Bearer ${access_token}` } });
      expect(response.status).toBe(200);
      const ids = ((await response.json()) as { items: Array<{ id: string }> }).items.map((turn) => turn.id);
      expect(ids).toHaveLength(100);
      expect(ids[0]).toBe("turn-002");
      expect(ids.at(-1)).toBe("turn-101");
    } finally {
      await server.close();
    }
  });

  it("limits request bodies and repeated invalid pairing attempts", async () => {
    const server = await start({ maxBodyBytes: 32, redeemMaxAttempts: 2 });
    try {
      const tooLarge = await fetch(`${server.base}/v1/paired/redeem`, {
        method: "POST", body: JSON.stringify({ pairing_code: "X".repeat(100) }),
      });
      expect(tooLarge.status).toBe(413);

      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${server.base}/v1/paired/redeem`, {
          method: "POST", body: JSON.stringify({ pairing_code: "PLC-BAD1" }),
        });
        expect(response.status).toBe(400);
      }
      const limited = await fetch(`${server.base}/v1/paired/redeem`, {
        method: "POST", body: JSON.stringify({ pairing_code: "PLC-BAD1" }),
      });
      expect(limited.status).toBe(429);
      expect((await limited.json() as any).error.code).toBe("rate_limited");
    } finally {
      await server.close();
    }
  });
});

// 诉求 1 的服务端咽喉：任务面板拉的是这个端点，它必须只给 task。
// 靠每个消费方自己记得过滤 kind 是行不通的——companion 就没记得，
// 于是一条 fired 的提醒并排出现在"进行中"里（真实回归）。
describe("GET /v1/tickets kind filter", () => {
  it("returns only tasks by default and reminders only when asked", async () => {
    const task = createItem(db, { title: "真任务", brief: "b", createdBy: "system" });
    const reminder = createItem(db, {
      title: "日程提醒", brief: "", createdBy: "lead", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    const server = await start();
    try {
      const { access_token } = await redeem(server.base, ["chat", "tickets:view"]);
      const headers = { authorization: `Bearer ${access_token}` };

      const body = await (await fetch(`${server.base}/v1/tickets`, { headers })).json() as any;
      const ids = body.items.map((t: any) => t.id);
      expect(ids).toContain(task);
      expect(ids).not.toContain(reminder);

      const rem = await (await fetch(`${server.base}/v1/tickets?kind=reminder`, { headers })).json() as any;
      expect(rem.items.map((t: any) => t.id)).toEqual([reminder]);
    } finally {
      await server.close();
    }
  });

  it("uses the shared workspace authority for release and cleanup actions", async () => {
    const dir = tempDir("plc-workspace-http-");
    const itemId = createItem(db, {
      title: "workspace http", brief: "b", createdBy: "user", workdir: dir,
    });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    const workspaceId = Number(db.prepare(
      `INSERT INTO workspaces (owner_item_id, mode, kind, path, state, merge_status)
       VALUES (?, 'shared', 'primary', ?, 'active', 'n/a')`,
    ).run(itemId, dir).lastInsertRowid);
    const server = await start();
    try {
      const user = await redeem(server.base, ["tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${user.access_token}` };
      const before = await fetch(`${server.base}/v1/tickets/${itemId}`, { headers });
      expect(before.status).toBe(200);
      const beforeBody = await before.json();
      expect(beforeBody.ticket.workspace.availableActions).toEqual(["release"]);

      const released = await fetch(`${server.base}/v1/workspaces/${workspaceId}/release`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
      });
      expect(released.status).toBe(200);
      const releasedBody = await released.json();
      expect(Value.Check(WorkspaceActionResultSchema, releasedBody)).toBe(true);
      expect(releasedBody.status).toBe("released");
      expect(releasedBody.ticket.workspace.availableActions).toEqual(["cleanup"]);

      const cleaned = await fetch(`${server.base}/v1/workspaces/${workspaceId}/cleanup`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
      });
      expect(cleaned.status).toBe(200);
      const cleanedBody = await cleaned.json();
      expect(cleanedBody.status).toBe("cleaned");
      expect(cleanedBody.ticket.workspace).toBeUndefined();
      expect(db.prepare("SELECT state FROM workspaces WHERE id=?").get(workspaceId))
        .toEqual({ state: "archived" });
      expect(existsSync(dir)).toBe(true);

      const forbidden = await redeem(server.base, ["tickets:view"]);
      const denied = await fetch(`${server.base}/v1/workspaces/${workspaceId}/cleanup`, {
        method: "POST", headers: { ...{ authorization: `Bearer ${forbidden.access_token}` }, "content-type": "application/json" }, body: "{}",
      });
      expect(denied.status).toBe(403);
    } finally {
      await server.close();
    }
  });

});
