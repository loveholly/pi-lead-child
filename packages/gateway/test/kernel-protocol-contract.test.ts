import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  CreateTicketRequestSchema,
  GatewayEventSchema,
  GatewayEventTypeSchema,
  KernelAttemptSchema,
  KernelCapabilitySchema,
  KernelCheckpointV2ListResponseSchema,
  KernelLearningCandidateSchema,
  KernelProjectSchema,
  KernelRuntimeEventSchema,
  KernelTicketDependencySchema,
  KernelTicketSchema,
  KernelTicketWorkbenchV2Schema,
  KernelTicketWorkItemV2ListResponseSchema,
} from "@pi-lead-child/protocol";
import { createCoordinator } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { createItem, createRun, updateRun } from "@pi-lead-child/store";
import { openDb } from "@pi-lead-child/store";
import { KernelTicketSchema04dd07d0 } from "./fixtures/protocol-04dd07d0.js";

const ticket = {
  id: 42,
  title: "实现 kernel snapshots",
  brief: "保持 v2 不变并暴露编排状态",
  body: "",
  status: "active",
  priority: "high",
  project: "pi-lead-child",
  projectId: 3,
  parentTicketId: null,
  rootTicketId: 42,
  createdByAttemptId: null,
  orchestrationState: "waiting",
  requestedRuntime: "codex",
  requestedModel: null,
  purpose: "execution",
  maxDepth: 3,
  maxChildren: 12,
  maxConcurrency: 2,
  tokenBudget: 120_000,
  costBudgetUsd: 20,
  retryLimit: 2,
  activePlanRevision: 1,
  workdir: "/tmp/pi-lead-child",
  createdBy: "lead",
  createdAt: "2026-07-23T04:00:00.000Z",
  updatedAt: "2026-07-23T05:00:00.000Z",
  lastActivityAt: "2026-07-23T04:59:00.000Z",
  totalTokens: 3200,
  totalCostUsd: 0.14,
  dueAt: null,
  remindAt: null,
};

function addColumnIfMissing(
  db: ReturnType<typeof openDb>,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

describe("kernel protocol contract", () => {
  // 审查 M1（工单 09）：旧客户端（master 04dd07d0 的协议）严格校验工单，reviewPolicy 是必填字段。删掉它以后旧客户端打不开工单。
  // 过渡一个版本：daemon 照发 reviewPolicy: null，旧客户端和新客户端都接受。
  it("sends tickets that an old client (protocol 04dd07d0) still accepts", () => {
    const db = openDb(join(tempDir("plc-old-client-ticket-"), "plc.db"));
    const coordinator = createCoordinator({ db });
    const taskId = coordinator.createRootItem({
      title: "old client", brief: "b", createdBy: "lead", runtime: "codex", verificationPolicy: "independent_reviewer",
    });
    const reminderId = createItem(db, {
      kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z",
    });
    const service = createControlPlaneService(db, {
      runtime: () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null }),
    });
    for (const id of [taskId, reminderId]) {
      const sent = service.getKernelTicket(id)!;
      expect(sent).toMatchObject({ reviewPolicy: null });
      expect(Value.Errors(KernelTicketSchema04dd07d0, sent).map((error) => error.message)).toEqual([]);
      expect(Value.Check(KernelTicketSchema, sent)).toBe(true);
    }
    expect(Value.Check(KernelTicketSchema04dd07d0, service.getKernelTicketWorkbench(taskId)!.ticket)).toBe(true);
    db.close();
  });

  it("keeps kernel ticket and create payloads strict", () => {
    expect(Value.Check(KernelTicketSchema, ticket)).toBe(true);
    expect(Value.Check(KernelTicketSchema, { ...ticket, progress: 62 })).toBe(false);
    expect(Value.Check(KernelTicketSchema, { ...ticket, timing: { elapsedMs: 1000 } })).toBe(false);
    expect(Value.Check(KernelTicketSchema, { ...ticket, checkpoint: { id: 1 } })).toBe(false);
    expect(Value.Check(KernelTicketSchema, { ...ticket, intervention: { id: "approval:1" } })).toBe(false);

    const create = {
      title: "新增根工单",
      brief: "经 Coordinator 建单",
      priority: "urgent",
      project: "pi-lead-child",
      workdir: "/tmp/pi-lead-child",
      runtime: "claude",
      model: "sonnet",
      purpose: "execution",
      verificationPolicy: "user",
    };
    expect(Value.Check(CreateTicketRequestSchema, create)).toBe(true);
    expect(Value.Check(CreateTicketRequestSchema, { ...create, createdBy: "lead" })).toBe(false);
    expect(Value.Check(CreateTicketRequestSchema, { ...create, runtime: "shell" })).toBe(false);
  });

  it("keeps the frozen v2 gateway event envelope additive-resource free", () => {
    const event = {
      protocolVersion: 2,
      eventId: "evt-1",
      seq: 1,
      type: "ticket.updated",
      occurredAt: "2026-07-24T04:00:00.000Z",
      requiredScope: "tickets:view",
      audienceBindingId: null,
      turnId: null,
      ticketId: 42,
      payload: { ticketId: 42 },
    };
    expect(Value.Check(GatewayEventSchema, event)).toBe(true);
    expect(Value.Check(GatewayEventSchema, { ...event, checkpointId: 12 })).toBe(false);
    expect(Value.Check(GatewayEventSchema, { ...event, timing: { elapsedMs: 1000 } })).toBe(false);
    expect(Value.Check(GatewayEventSchema, { ...event, interventionId: "approval:18" })).toBe(false);
    expect(Value.Check(GatewayEventSchema, { ...event, type: "checkpoint.created" })).toBe(false);
  });

  it("keeps the protocol-v2 event literal union byte-for-byte unchanged", () => {
    expect(GatewayEventTypeSchema.anyOf.map((schema) => schema.const)).toEqual([
      "lead.turn.started",
      "lead.message.delta",
      "lead.message.completed",
      "lead.tool.started",
      "lead.tool.updated",
      "lead.tool.completed",
      "lead.tool.failed",
      "ticket.created",
      "ticket.updated",
      "attempt.started",
      "attempt.updated",
      "child.tool.started",
      "child.tool.updated",
      "child.tool.completed",
      "child.tool.failed",
      "approval.required",
      "approval.resolved",
      "notice.created",
      "daemon.status.changed",
      "snapshot.required",
    ]);

    for (const additiveType of [
      "checkpoint.created",
      "checkpoint.updated",
      "proof.updated",
      "artifact.created",
      "workbench.updated",
    ]) {
      expect(Value.Check(GatewayEventTypeSchema, additiveType)).toBe(false);
    }
  });

  it("keeps real checkpoint, work-item, and workbench v1 mappers byte-identical", () => {
    const db = openDb(join(tempDir("plc-v1-mapper-contract-"), "plc.db"));
    const computedAt = new Date("2026-07-24T10:00:00.000Z");
    const coordinator = createCoordinator({ db, now: () => computedAt });
    const ticketId = coordinator.createRootItem({
      title: "v1 mapper fixture",
      brief: "new migration fields must not leak",
      createdBy: "lead",
      priority: "high",
      runtime: "codex",
      model: "gpt-5.6-codex",
      verificationPolicy: "independent_reviewer",
    });
    // 本用例逐字节比对 v1 mapper 的输出，created_by 也在其中，所以作者必须保持 lead；
    // lead 建的单子不 hold 就生于 ready，无须再补一次确认（spec §6.4/§6.6）。
    const attemptId = createRun(db, {
      itemId: ticketId,
      runtime: "codex",
      model: "gpt-5.6-codex",
    });
    updateRun(db, attemptId, {
      state: "running",
      sessionId: "session-local",
      sessionPath: "/tmp/session.jsonl",
      pid: 4321,
      runtimeVersion: "0.144.6",
      externalSessionId: "thread-v1",
      eventCursor: "7",
      lastEntryCursor: "entry-6",
      metadata: { sandbox: "workspace-write" },
      costKnown: true,
      eventLogDirty: false,
    });
    const checkpointId = coordinator.submitCheckpoint({
      itemId: ticketId,
      runId: attemptId,
      kind: "milestone",
      stage: "implementation",
      title: "v1 mapper checkpoint",
      summary: "Only the frozen checkpoint shape may be serialized.",
      keyFacts: [{ label: "tests", value: "passing" }],
      artifactRefs: ["artifact:legacy-report"],
      nextStep: "Run compatibility suite",
    }).checkpoint.id;

    db.prepare("UPDATE items SET stage = 'active' WHERE id = ?").run(ticketId);
    db.prepare(
      `UPDATE items SET
        first_run_at = ?, stage_changed_at = ?, created_at = ?, updated_at = ?,
        last_activity_at = ?, total_tokens = ?, total_cost_usd = ?
       WHERE id = ?`,
    ).run(
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T09:15:00.000Z",
      "2026-07-24T08:45:00.000Z",
      "2026-07-24T09:45:00.000Z",
      "2026-07-24T09:45:00.000Z",
      3_200,
      0.14,
      ticketId,
    );
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?")
      .run("2026-07-24T09:00:00.000Z", attemptId);
    db.prepare("UPDATE checkpoints SET created_at = ? WHERE id = ?")
      .run("2026-07-24T09:30:00.000Z", checkpointId);

    addColumnIfMissing(db, "checkpoints", "progress_current", "progress_current INTEGER");
    addColumnIfMissing(db, "checkpoints", "progress_total", "progress_total INTEGER");
    addColumnIfMissing(db, "checkpoints", "progress_label", "progress_label TEXT");
    addColumnIfMissing(
      db,
      "checkpoints",
      "proof_items",
      "proof_items TEXT NOT NULL DEFAULT '[]'",
    );
    db.prepare(
      `UPDATE checkpoints SET
        progress_current = ?, progress_total = ?, progress_label = ?, proof_items = ?
       WHERE id = ?`,
    ).run(
      3,
      5,
      "协议覆盖",
      JSON.stringify([{
        id: "auth.boundary",
        label: "鉴权边界",
        state: "passed",
        evidence: "paired tests pass",
      }]),
      checkpointId,
    );
    db.prepare(
      `INSERT INTO item_proof_items
       (item_id, proof_key, label, state, evidence, checkpoint_id, updated_at)
       VALUES (?, 'auth.boundary', '鉴权边界', 'passed', 'paired tests pass', ?, ?)`,
    ).run(ticketId, checkpointId, "2026-07-24T09:30:00.000Z");

    const service = createControlPlaneService(db, {
      runtime: () => ({
        model: "stub/model",
        sessionId: "stub-session",
        busy: false,
        runningItemIds: [ticketId],
        aish: null,
      }),
      now: () => computedAt,
    });

    const expectedCheckpoint = {
      id: checkpointId,
      ticketId,
      attemptId,
      author: { kind: "executor", runtime: "codex" },
      source: "agent_reported",
      stage: "implementation",
      title: "v1 mapper checkpoint",
      summary: "Only the frozen checkpoint shape may be serialized.",
      keyFacts: [{ label: "tests", value: "passing" }],
      artifactRefs: ["artifact:legacy-report"],
      relatedTicketIds: [],
      nextStep: "Run compatibility suite",
      actionRef: null,
      createdAt: "2026-07-24T09:30:00.000Z",
      kind: "milestone",
    };
    const expectedTiming = {
      firstStartedAt: "2026-07-24T09:00:00.000Z",
      completedAt: null,
      statusChangedAt: "2026-07-24T09:15:00.000Z",
      computedAt: "2026-07-24T10:00:00.000Z",
      elapsedMs: 3_600_000,
      activeExecutionMs: 3_600_000,
      statusDurationMs: 2_700_000,
    };
    const expectedWorkbenchCheckpoint = {
      id: checkpointId,
      ticketId,
      attemptId,
      author: { kind: "executor", runtime: "codex" },
      source: "agent_reported",
      stage: "implementation",
      title: "v1 mapper checkpoint",
      summary: "Only the frozen checkpoint shape may be serialized.",
      keyFacts: [{ label: "tests", value: "passing" }],
      artifactRefs: ["artifact:legacy-report"],
      createdAt: "2026-07-24T09:30:00.000Z",
      kind: "milestone",
      relatedTicketIds: [],
      nextStep: "Run compatibility suite",
      actionRef: null,
    };
    const expectedActiveExecution = {
      attemptId,
      role: "executor",
      runtime: "codex",
      state: "running",
      model: "gpt-5.6-codex",
      externalSessionId: "thread-v1",
    };
    const expectedAttempt = {
      id: attemptId,
      ticketId,
      role: "executor",
      state: "running",
      runtime: "codex",
      purpose: "execution",
      model: "gpt-5.6-codex",
      runtimeVersion: "0.144.6",
      externalSessionId: "thread-v1",
      sessionId: "session-local",
      sessionPath: "/tmp/session.jsonl",
      pid: 4321,
      eventCursor: "7",
      lastEntryCursor: "entry-6",
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      metadata: { sandbox: "workspace-write" },
      costKnown: true,
      eventLogDirty: false,
      startedAt: "2026-07-24T09:00:00.000Z",
      endedAt: null,
    };
    const expectedTicket = {
      id: ticketId,
      title: "v1 mapper fixture",
      brief: "new migration fields must not leak",
      body: "",
      status: "active",
      priority: "high",
      project: null,
      projectId: null,
      parentTicketId: null,
      rootTicketId: ticketId,
      createdByAttemptId: null,
      orchestrationState: "none",
      requestedRuntime: "codex",
      requestedModel: "gpt-5.6-codex",
      purpose: "execution",
      // 已停用（工单 09），只为旧客户端照发 null。
      reviewPolicy: null,
      maxDepth: null,
      maxChildren: null,
      maxConcurrency: null,
      tokenBudget: null,
      costBudgetUsd: null,
      retryLimit: 1,
      activePlanRevision: null,
      workdir: null,
      createdBy: "lead",
      createdAt: "2026-07-24T08:45:00.000Z",
      updatedAt: "2026-07-24T09:45:00.000Z",
      lastActivityAt: "2026-07-24T09:45:00.000Z",
      totalTokens: 3_200,
      totalCostUsd: 0.14,
      dueAt: null,
      remindAt: null,
    };

    const checkpointsV1 = service.listKernelCheckpoints(ticketId);
    const workItemsV1 = service.listKernelWorkItems([ticketId]);
    const workbenchV1 = service.getKernelTicketWorkbench(ticketId);

    expect(JSON.stringify(checkpointsV1)).toBe(JSON.stringify({
      items: [expectedCheckpoint],
      hasMore: false,
      nextBeforeId: null,
    }));
    expect(JSON.stringify(workItemsV1)).toBe(JSON.stringify([{
      ticketId,
      timing: expectedTiming,
      activeExecution: expectedActiveExecution,
      pendingInterventionCount: 0,
      latestCheckpointId: checkpointId,
    }]));
    expect(JSON.stringify(workbenchV1)).toBe(JSON.stringify({
      ticket: expectedTicket,
      timing: expectedTiming,
      activeAttempt: expectedAttempt,
      children: [],
      latestCheckpoints: [expectedWorkbenchCheckpoint],
      interventionRefs: [],
    }));

    for (const serialized of [
      JSON.stringify(checkpointsV1),
      JSON.stringify(workItemsV1),
      JSON.stringify(workbenchV1),
    ]) {
      expect(serialized).not.toContain('"progress"');
      expect(serialized).not.toContain('"proofItems"');
      expect(serialized).not.toContain('"pow"');
      expect(serialized).not.toContain('"artifacts"');
    }

    const checkpointsV2 = service.listKernelCheckpointsV2(ticketId);
    const workItemsV2 = { items: service.listKernelWorkItemsV2([ticketId]) };
    const workbenchV2 = service.getKernelTicketWorkbenchV2(ticketId);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, checkpointsV2)).toBe(true);
    expect(Value.Check(KernelTicketWorkItemV2ListResponseSchema, workItemsV2)).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbenchV2)).toBe(true);
    expect(checkpointsV2?.items[0]).toMatchObject({
      progress: { current: 3, total: 5, label: "协议覆盖" },
      proofItems: [{ id: "auth.boundary", state: "passed" }],
    });
    expect(workItemsV2.items[0]?.progress).toMatchObject({
      current: 3, total: 5, percent: 60, source: "explicit", checkpointId,
    });
    expect(workbenchV2).toMatchObject({
      progress: { current: 3, total: 5, percent: 60, source: "explicit", checkpointId },
      pow: {
        verdict: "passed",
        metrics: { passed: 1, total: 1, checkpointCount: 1, toolOperationCount: 0 },
      },
    });
  });

  it("validates strict project and dependency snapshots", () => {
    const project = {
      id: 3,
      slug: "pi-lead-child",
      name: "pi-lead-child",
      summary: "Runtime-neutral orchestration kernel",
      status: "active",
      confidence: 0.9,
      maxConcurrency: 4,
      mergedIntoProjectId: null,
      createdBy: "system:repo-resolution",
      createdAt: "2026-07-23T04:00:00.000Z",
      updatedAt: "2026-07-23T05:00:00.000Z",
      repositories: [{
        id: 7,
        projectId: 3,
        repoRoot: "/tmp/pi-lead-child",
        remoteUrl: "git@github.com:example/pi-lead-child.git",
        repoName: "pi-lead-child",
        role: "kernel",
        confidence: 1,
        createdAt: "2026-07-23T04:00:00.000Z",
        updatedAt: "2026-07-23T05:00:00.000Z",
      }],
    };
    expect(Value.Check(KernelProjectSchema, project)).toBe(true);
    expect(Value.Check(KernelProjectSchema, { ...project, ticketCount: 1 })).toBe(false);

    const dependency = {
      parentTicketId: 42,
      planRevision: 1,
      ticketId: 44,
      dependsOnTicketId: 43,
      kind: "blocks",
      createdByAttemptId: 9,
      createdAt: "2026-07-23T05:00:00.000Z",
    };
    expect(Value.Check(KernelTicketDependencySchema, dependency)).toBe(true);
    expect(Value.Check(KernelTicketDependencySchema, { ...dependency, state: "ready" })).toBe(false);
  });

  it("validates strict attempt and normalized runtime event snapshots", () => {
    const attempt = {
      id: 9,
      ticketId: 42,
      role: "executor",
      state: "running",
      runtime: "codex",
      purpose: "execution",
      model: "gpt-5.6-codex",
      runtimeVersion: "0.144.6",
      externalSessionId: "thread-1",
      sessionId: null,
      sessionPath: "/tmp/runtime-events/attempt-9.jsonl",
      pid: 1234,
      eventCursor: "2",
      lastEntryCursor: null,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      metadata: { sandbox: "workspace-write" },
      costKnown: true,
      eventLogDirty: false,
      startedAt: "2026-07-23T05:00:00.000Z",
      endedAt: null,
    };
    expect(Value.Check(KernelAttemptSchema, attempt)).toBe(true);
    expect(Value.Check(KernelAttemptSchema, { ...attempt, nativeEvent: "turn.started" })).toBe(false);

    const event = {
      type: "tool.completed",
      attemptId: 9,
      seq: 2,
      occurredAt: "2026-07-23T05:00:01.000Z",
      callId: "call-1",
      name: "ticket_update",
      result: { status: "review" },
    };
    expect(Value.Check(KernelRuntimeEventSchema, event)).toBe(true);
    expect(Value.Check(KernelRuntimeEventSchema, { ...event, nativeType: "item.completed" })).toBe(false);
    expect(Value.Check(KernelRuntimeEventSchema, { ...event, type: "codex.item.completed" })).toBe(false);
  });

  it("validates strict learning and capability snapshots", () => {
    const candidate = {
      id: 5,
      projectId: 3,
      scopeKey: "project:3",
      ticketId: 42,
      attemptId: 9,
      fingerprint: "runtime-failure:timeout",
      kind: "runtime_failure",
      summary: "Runtime timed out repeatedly",
      evidence: { errorCode: "timeout" },
      occurrenceCount: 3,
      confidence: 0.8,
      status: "drafted",
      createdAt: "2026-07-23T05:00:00.000Z",
      updatedAt: "2026-07-23T05:10:00.000Z",
    };
    expect(Value.Check(KernelLearningCandidateSchema, candidate)).toBe(true);
    expect(Value.Check(KernelLearningCandidateSchema, { ...candidate, occurrences: 3 })).toBe(false);

    const capability = {
      id: 8,
      projectId: 3,
      scopeKey: "project:3",
      type: "runbook",
      slug: "runtime-timeout-recovery",
      name: "Runtime timeout recovery",
      version: 1,
      scope: "project",
      status: "active",
      summary: "Bounded recovery procedure",
      assetPath: "/tmp/capabilities/runbook.md",
      evaluatorPath: "/tmp/capabilities/evaluate.sh",
      assetHash: "sha256:asset",
      evaluatorHash: "sha256:evaluator",
      sourceCandidates: [5],
      provenance: { promotedBy: "coordinator" },
      createdAt: "2026-07-23T05:00:00.000Z",
      updatedAt: "2026-07-23T05:15:00.000Z",
    };
    expect(Value.Check(KernelCapabilitySchema, capability)).toBe(true);
    expect(Value.Check(KernelCapabilitySchema, { ...capability, runs: [] })).toBe(false);
  });
});
