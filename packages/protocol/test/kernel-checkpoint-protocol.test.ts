import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  CHECKPOINT_KINDS,
  CHECKPOINT_SOURCES,
  CONVERSATION_CARD_LIMITS,
  CheckpointArtifactInputSchema,
  CheckpointProgressSchema,
  CheckpointProofItemSchema,
  CreateDecisionRequestSchema,
  KERNEL_FIDELITY_CAPABILITIES,
  KernelOutcomeSnapshotResourceSchema,
  KernelArtifactContentMetadataSchema,
  KernelArtifactListResponseSchema,
  KernelArtifactSchema,
  KernelCheckpointListQuerySchema,
  KernelCheckpointListResponseSchema,
  KernelCheckpointSchema,
  KernelCheckpointV2ListResponseSchema,
  KernelCheckpointV2Schema,
  KernelConversationCardListQuerySchema,
  KernelConversationCardListResponseSchema,
  KernelConversationCardSchema,
  KernelDecisionRequestSchema,
  KernelInterventionListQuerySchema,
  KernelInterventionRefSchema,
  KernelInterventionSchema,
  KernelTicketTimingSchema,
  KernelTicketPowSchema,
  type KernelTicketProgress,
  KernelTicketProgressSchema,
  KernelTicketWorkbenchSchema,
  KernelTicketWorkbenchV2Schema,
  KernelTicketWorkItemListQuerySchema,
  KernelTicketWorkItemListResponseSchema,
  KernelTicketWorkItemSchema,
  KernelTicketWorkItemV2ListResponseSchema,
  KernelTicketWorkItemV2Schema,
  KernelWorkItemGroupSchema,
  ResolveKernelInterventionRequestSchema,
  TicketOperationProjectionSchema,
} from "../src/index.js";

const createdAt = "2026-07-24T04:00:00.000Z";

const checkpoint = {
  id: 12,
  ticketId: 42,
  attemptId: 73,
  author: { kind: "executor", runtime: "codex" },
  source: "agent_reported",
  kind: "progress",
  stage: "implementation",
  title: "协议基础已落地",
  summary: "Checkpoint schema 已实现，下一步接入 Coordinator。",
  keyFacts: [{ label: "tests", value: "3 passing" }],
  artifactRefs: ["artifact:patch-12"],
  relatedTicketIds: [],
  nextStep: "实现 append-only store",
  actionRef: null,
  createdAt,
};

const ticket = {
  id: 42,
  title: "实现 checkpoint control plane",
  brief: "保持 frozen v2 并增加 additive kernel resources",
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
  createdAt,
  updatedAt: createdAt,
  lastActivityAt: createdAt,
  totalTokens: 3200,
  totalCostUsd: 0.14,
  dueAt: null,
  remindAt: null,
};

const attempt = {
  id: 73,
  ticketId: 42,
  role: "executor",
  state: "running",
  runtime: "codex",
  purpose: "execution",
  model: "gpt-5.6-codex",
  runtimeVersion: "0.144.6",
  externalSessionId: "thread-73",
  sessionId: null,
  sessionPath: "/tmp/runtime-events/attempt-73.jsonl",
  pid: 1234,
  eventCursor: "2",
  lastEntryCursor: null,
  exitCode: null,
  errorCode: null,
  errorMessage: null,
  metadata: {},
  costKnown: true,
  eventLogDirty: false,
  startedAt: createdAt,
  endedAt: null,
};

const timing = {
  firstStartedAt: createdAt,
  completedAt: null,
  statusChangedAt: createdAt,
  computedAt: "2026-07-24T04:06:12.000Z",
  elapsedMs: 372_000,
  activeExecutionMs: 372_000,
  statusDurationMs: 372_000,
};

const progress = {
  current: 3,
  total: 5,
  label: "协议覆盖",
};

const proofItems = [
  { id: "auth.boundary", label: "鉴权边界", state: "passed", evidence: "paired tests pass" },
  { id: "legacy-v1", label: "旧协议隔离", state: "retired", evidence: null },
];

const checkpointV2 = {
  ...checkpoint,
  progress,
  proofItems,
};

const ticketProgress: KernelTicketProgress = {
  ...progress,
  percent: 60,
  source: "explicit",
  checkpointId: 12,
};

const pow = {
  verdict: "running",
  items: [
    {
      id: "auth.boundary",
      label: "鉴权边界",
      state: "passed",
      evidence: "paired tests pass",
      checkpointId: 12,
      updatedAt: createdAt,
    },
    {
      id: "artifact.download",
      label: "产物下载",
      state: "pending",
      evidence: null,
      checkpointId: 13,
      updatedAt: createdAt,
    },
  ],
  metrics: {
    passed: 1,
    total: 2,
    checkpointCount: 4,
    toolOperationCount: 7,
    elapsedMs: 372_000,
    pendingInterventionCount: 0,
  },
  computedAt: createdAt,
};

const artifact = {
  id: 9,
  ticketId: 42,
  attemptId: 73,
  checkpointId: 12,
  ref: "report/fidelity",
  name: "fidelity-report.md",
  kind: "report",
  mediaType: "text/markdown",
  description: "高保真验收报告",
  availability: "available",
  byteLength: 4_096,
  sha256: "a".repeat(64),
  createdAt,
};

const outcomeSnapshot = {
  latest: {
    id: 5,
    ticketId: 42,
    executorAttemptId: 73,
    completionCheckpointId: 12,
    source: "agent_reported",
    sourceEventSeq: null,
    sourceOutputSha256: null,
    summary: "Implemented the completion protocol.",
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Added ledger" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm run typecheck",
      outcome: "passed",
      exitCode: 0,
      summary: "TypeScript passed",
      evidenceRef: null,
    }],
    completeness: "complete",
    missingFields: [],
    recoveryNote: null,
    createdAt,
  },
  historyCount: 1,
  facts: {
    implementationCompleted: true,
    independentEvidence: "partial",
    acceptance: "none",
  },
  reviewerVerdict: {
    verdict: "pass",
    attemptId: 74,
    evidence: "Verified manually",
    evidenceRefs: [],
  },
};

describe("checkpoint kernel protocol", () => {
  it("freezes checkpoint literals, strict shape, and field limits", () => {
    expect(CHECKPOINT_KINDS).toEqual([
      "progress", "milestone", "decision", "delegation", "blocked", "completed",
    ]);
    expect(CHECKPOINT_SOURCES).toEqual(["agent_reported", "system_derived"]);
    expect(Value.Check(KernelCheckpointSchema, checkpoint)).toBe(true);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, kind: "proof" })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, source: "runtime_derived" })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, progress: 62 })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, title: "x".repeat(161) })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, summary: "x".repeat(2001) })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, stage: "x".repeat(121) })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint,
      keyFacts: Array.from({ length: 9 }, (_, index) => ({ label: `f${index}`, value: "v" })),
    })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint,
      keyFacts: [{ label: "x".repeat(81), value: "v" }],
    })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint,
      keyFacts: [{ label: "fact", value: "x".repeat(241) }],
    })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, artifactRefs: Array.from({ length: 21 }, (_, index) => `artifact:${index}`),
    })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, relatedTicketIds: Array.from({ length: 21 }, (_, index) => index + 1),
    })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, nextStep: "x".repeat(501) })).toBe(false);
  });

  it("enforces deterministic delegation and blocked checkpoint requirements", () => {
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, kind: "delegation", relatedTicketIds: [43], nextStep: null,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, kind: "delegation", relatedTicketIds: [], nextStep: null,
    })).toBe(false);

    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, kind: "blocked", nextStep: "等待用户授权", actionRef: null,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint,
      kind: "blocked",
      nextStep: null,
      actionRef: { type: "approval", id: 18 },
    })).toBe(true);
    expect(Value.Check(KernelCheckpointSchema, {
      ...checkpoint, kind: "blocked", nextStep: null, actionRef: null,
    })).toBe(false);
  });

  it("validates checkpoint cursor queries and collection responses", () => {
    expect(Value.Check(KernelCheckpointListQuerySchema, {})).toBe(true);
    expect(Value.Check(KernelCheckpointListQuerySchema, { after_id: 12, limit: 200 })).toBe(true);
    expect(Value.Check(KernelCheckpointListQuerySchema, { before_id: 12, limit: 1 })).toBe(true);
    expect(Value.Check(KernelCheckpointListQuerySchema, { after_id: 12, before_id: 15 })).toBe(false);
    expect(Value.Check(KernelCheckpointListQuerySchema, { limit: 201 })).toBe(false);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [checkpoint], hasMore: true, nextBeforeId: 12,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [checkpoint], hasMore: false, nextBeforeId: null, nextAfterId: 12,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [{ ...checkpoint, id: 13 }, checkpoint], hasMore: false, nextBeforeId: null,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [checkpoint], hasMore: true, nextBeforeId: 11,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [checkpoint], hasMore: false, nextBeforeId: 12,
    })).toBe(true);
  });

  it("publishes exact additive fidelity capabilities", () => {
    expect(KERNEL_FIDELITY_CAPABILITIES).toEqual({
      checkpoints: "kernel.checkpoints.v2",
      workItems: "kernel.work-items.v2",
      workbench: "kernel.ticket-workbench.v2",
      artifacts: "kernel.artifacts.v1",
    });
  });

  it("validates checkpoint-v2 progress cross-fields and proof retirement quotas", () => {
    expect(Value.Check(CheckpointProgressSchema, progress)).toBe(true);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, current: 6 })).toBe(false);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, current: -1 })).toBe(false);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, total: 0 })).toBe(false);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, total: 2_147_483_648 })).toBe(false);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, label: "" })).toBe(true);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, label: "x".repeat(121) })).toBe(false);
    expect(Value.Check(CheckpointProgressSchema, { ...progress, percent: 60 })).toBe(false);

    expect(Value.Check(CheckpointProofItemSchema, proofItems[0])).toBe(true);
    expect(Value.Check(CheckpointProofItemSchema, proofItems[1])).toBe(true);
    expect(Value.Check(CheckpointProofItemSchema, { ...proofItems[0], id: "bad id" })).toBe(false);
    expect(Value.Check(CheckpointProofItemSchema, { ...proofItems[0], id: "x".repeat(81) })).toBe(false);
    expect(Value.Check(CheckpointProofItemSchema, { ...proofItems[0], label: "x".repeat(161) })).toBe(false);
    expect(Value.Check(CheckpointProofItemSchema, { ...proofItems[0], evidence: "x".repeat(1_001) })).toBe(false);
    expect(Value.Check(CheckpointProofItemSchema, { ...proofItems[0], retired: false })).toBe(false);

    expect(Value.Check(KernelCheckpointV2Schema, checkpointV2)).toBe(true);
    expect(Value.Check(KernelCheckpointV2Schema, { ...checkpointV2, proofItems: undefined })).toBe(false);
    expect(Value.Check(KernelCheckpointV2Schema, { ...checkpointV2, progress: null })).toBe(true);
    expect(Value.Check(KernelCheckpointV2Schema, {
      ...checkpointV2,
      proofItems: [proofItems[0], { ...proofItems[0] }],
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2Schema, {
      ...checkpointV2,
      proofItems: Array.from({ length: 21 }, (_, index) => ({
        id: `proof-${index}`,
        label: `Proof ${index}`,
        state: "pending",
        evidence: null,
      })),
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2Schema, { ...checkpointV2, unknown: true })).toBe(false);
  });

  it("enforces checkpoint-v2 response order and cursor/hasMore equivalence", () => {
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [checkpointV2, { ...checkpointV2, id: 13 }],
      hasMore: false,
      nextBeforeId: null,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [checkpointV2, { ...checkpointV2, id: 13 }],
      hasMore: true,
      nextBeforeId: checkpointV2.id,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [{ ...checkpointV2, id: 13 }, checkpointV2],
      hasMore: false,
      nextBeforeId: null,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [checkpointV2],
      hasMore: true,
      nextBeforeId: 11,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [checkpointV2],
      hasMore: true,
      nextBeforeId: null,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [checkpointV2],
      hasMore: false,
      nextBeforeId: checkpointV2.id,
    })).toBe(false);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [],
      hasMore: false,
      nextBeforeId: null,
    })).toBe(true);
    expect(Value.Check(KernelCheckpointV2ListResponseSchema, {
      items: [],
      hasMore: true,
      nextBeforeId: null,
    })).toBe(false);
  });

  it("keeps the frozen checkpoint-v1 response strict against every v2 field", () => {
    expect(Value.Check(KernelCheckpointSchema, checkpoint)).toBe(true);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, progress })).toBe(false);
    expect(Value.Check(KernelCheckpointSchema, { ...checkpoint, proofItems })).toBe(false);
    expect(Value.Check(KernelCheckpointListResponseSchema, {
      items: [checkpointV2], hasMore: false, nextBeforeId: null,
    })).toBe(false);
  });
});

describe("intervention kernel protocol", () => {
  const decisionRequest = {
    id: 7,
    ticketId: 42,
    attemptId: 73,
    kind: "decision",
    audience: "lead_or_user",
    blocking: true,
    allowCustom: true,
    prompt: "选择兼容策略",
    options: [{ id: "strict", label: "严格兼容", description: "冻结 v2" }],
    state: "pending",
    resolutionKind: null,
    selectedOptionId: null,
    resolutionText: null,
    dismissalReason: null,
    resolvedBy: null,
    resolvedAt: null,
    expiresAt: null,
    createdAt,
  };

  it("validates strict decision requests and agent creation input", () => {
    expect(Value.Check(KernelDecisionRequestSchema, decisionRequest)).toBe(true);
    expect(Value.Check(KernelDecisionRequestSchema, { ...decisionRequest, audience: "anyone" })).toBe(false);
    expect(Value.Check(KernelDecisionRequestSchema, { ...decisionRequest, opaqueResolution: {} })).toBe(false);

    const create = {
      kind: "question",
      audience: "lead",
      blocking: false,
      allow_custom: true,
      prompt: "需要切换 runtime 吗？",
      options: [],
      checkpoint: {
        title: "等待 runtime 决策",
        summary: "当前 runtime 不支持所需能力。",
        next_step: "收到选择后继续",
      },
    };
    expect(Value.Check(CreateDecisionRequestSchema, create)).toBe(true);
    expect(Value.Check(CreateDecisionRequestSchema, {
      ...create,
      allowCustom: true,
      checkpoint: { ...create.checkpoint, nextStep: "收到选择后继续" },
    })).toBe(false);
    expect(Value.Check(CreateDecisionRequestSchema, { ...create, actionRef: { type: "approval", id: 1 } })).toBe(false);
  });

  it("separates safe intervention refs from privileged authority details", () => {
    const ref = {
      id: "approval:18",
      ticketId: 42,
      kind: "approval",
      state: "pending",
      requiresAction: true,
    };
    expect(Value.Check(KernelInterventionRefSchema, ref)).toBe(true);
    expect(Value.Check(KernelInterventionRefSchema, { ...ref, detail: "secret" })).toBe(false);
    expect(Value.Check(KernelInterventionRefSchema, { ...ref, kind: "decision" })).toBe(false);
    expect(Value.Check(KernelInterventionRefSchema, {
      ...ref, state: "approved", requiresAction: true,
    })).toBe(false);

    const approval = {
      id: ref.id,
      kind: ref.kind,
      ticketId: ref.ticketId,
      state: ref.state,
      authorityId: 18,
      attemptId: 73,
      audience: "user",
      title: "授权安装 launchd 服务",
      detail: "需要 sudo 权限",
      actions: ["approve", "reject", "approve_session"],
      resolution: null,
      createdAt,
      resolvedBy: null,
      resolvedAt: null,
    };
    expect(Value.Check(KernelInterventionSchema, approval)).toBe(true);
    expect(Value.Check(KernelInterventionSchema, {
      ...approval, actions: [{ kind: "select", optionId: "yes", label: "同意" }],
    })).toBe(false);
    expect(Value.Check(KernelInterventionSchema, {
      ...approval,
      state: "approved",
      actions: ["approve"],
      resolution: { decision: "approve", sessionExempt: false },
    })).toBe(false);
    expect(Value.Check(KernelInterventionSchema, {
      ...approval,
      state: "approved",
      actions: [],
      resolution: null,
    })).toBe(false);

    const decision = {
      id: "decision:7",
      kind: "decision",
      authorityId: 7,
      ticketId: 42,
      attemptId: 73,
      audience: "lead_or_user",
      blocking: true,
      allowCustom: true,
      state: "pending",
      title: "选择兼容策略",
      detail: "v2 必须冻结",
      options: [{ id: "strict", label: "严格兼容", description: null }],
      actions: [
        { kind: "select", optionId: "strict", label: "严格兼容" },
        { kind: "respond", label: "自定义回复" },
        { kind: "dismiss", label: "暂不处理" },
      ],
      resolution: null,
      createdAt,
      resolvedBy: null,
      resolvedAt: null,
    };
    expect(Value.Check(KernelInterventionSchema, decision)).toBe(true);
    expect(Value.Check(KernelInterventionSchema, { ...decision, payload: { token: "secret" } })).toBe(false);
    expect(Value.Check(KernelInterventionSchema, {
      ...decision,
      state: "resolved",
      actions: decision.actions,
      resolution: { kind: "option", optionId: "strict", text: null },
    })).toBe(false);
    expect(Value.Check(KernelInterventionSchema, {
      ...decision,
      allowCustom: false,
      actions: [{ kind: "respond", label: "自定义回复" }],
    })).toBe(false);
    expect(Value.Check(KernelInterventionSchema, {
      ...decision,
      state: "resolved",
      actions: [],
      resolution: { kind: "option", optionId: null, text: null },
    })).toBe(false);
  });

  it("keeps approval and decision resolution commands disjoint", () => {
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "approval", decision: "approve_session",
    })).toBe(true);
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "decision_request", decision: "select", optionId: "strict",
    })).toBe(true);
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "decision_request", decision: "respond", resolution: "保持 v2",
    })).toBe(true);
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "decision_request", decision: "dismiss", reason: "稍后处理",
    })).toBe(true);
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "approval", decision: "select", optionId: "strict",
    })).toBe(false);
    expect(Value.Check(ResolveKernelInterventionRequestSchema, {
      authority: "decision_request", decision: "approve",
    })).toBe(false);
  });

  it("validates combinable intervention collection filters", () => {
    expect(Value.Check(KernelInterventionListQuerySchema, {
      ticket_id: 42, state: "pending", id: ["approval:18", "decision:7"],
    })).toBe(true);
    expect(Value.Check(KernelInterventionListQuerySchema, { id: ["raw:18"] })).toBe(false);
    expect(Value.Check(KernelInterventionListQuerySchema, { ticket_id: 0 })).toBe(false);
  });
});

describe("ticket workbench kernel protocol", () => {
  const workItem = {
    ticketId: 42,
    timing,
    activeExecution: {
      attemptId: 73,
      role: "executor",
      runtime: "codex",
      state: "running",
      model: "gpt-5.6-codex",
      externalSessionId: "thread-73",
    },
    pendingInterventionCount: 1,
    latestCheckpointId: 12,
  };

  it("validates timing, work-item groups, and batch work-item resources", () => {
    expect(Value.Check(KernelTicketTimingSchema, timing)).toBe(true);
    expect(Value.Check(KernelTicketTimingSchema, { ...timing, elapsedMs: -1 })).toBe(false);
    for (const group of ["needs_intervention", "running", "review", "completed"]) {
      expect(Value.Check(KernelWorkItemGroupSchema, group)).toBe(true);
    }
    expect(Value.Check(KernelWorkItemGroupSchema, "cancelled")).toBe(false);
    expect(Value.Check(KernelTicketWorkItemSchema, workItem)).toBe(true);
    expect(Value.Check(KernelTicketWorkItemSchema, { ...workItem, progress: 62 })).toBe(false);
    expect(Value.Check(KernelTicketWorkItemListQuerySchema, { ticket_id: [42, 55] })).toBe(true);
    expect(Value.Check(KernelTicketWorkItemListQuerySchema, { ticket_id: [0] })).toBe(false);
    expect(Value.Check(KernelTicketWorkItemListResponseSchema, { items: [workItem] })).toBe(true);
  });

  it("validates the composite ticket workbench without privileged intervention details", () => {
    const workbench = {
      ticket,
      timing,
      activeAttempt: attempt,
      children: [{ ...ticket, id: 43, parentTicketId: 42, rootTicketId: 42 }],
      latestCheckpoints: [checkpoint],
      interventionRefs: [{
        id: "approval:18",
        ticketId: 42,
        kind: "approval",
        state: "pending",
        requiresAction: true,
      }],
    };
    expect(Value.Check(KernelTicketWorkbenchSchema, workbench)).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchSchema, {
      ...workbench,
      interventionRefs: [{ ...workbench.interventionRefs[0], detail: "private" }],
    })).toBe(false);
  });

  it("validates authoritative ticket progress and work-item-v2 resources", () => {
    expect(Value.Check(KernelTicketProgressSchema, ticketProgress)).toBe(true);
    expect(Value.Check(KernelTicketProgressSchema, { ...ticketProgress, percent: 59 })).toBe(false);
    expect(Value.Check(KernelTicketProgressSchema, {
      ...ticketProgress, source: "children", checkpointId: 12,
    })).toBe(false);
    expect(Value.Check(KernelTicketProgressSchema, {
      current: 1, total: 1, percent: 100, label: null, source: "terminal", checkpointId: null,
    })).toBe(true);
    expect(Value.Check(KernelTicketProgressSchema, {
      current: 1, total: 2, percent: 50, label: null, source: "terminal", checkpointId: null,
    })).toBe(false);

    const workItemV2 = { ...workItem, progress: ticketProgress };
    expect(Value.Check(KernelTicketWorkItemV2Schema, workItemV2)).toBe(true);
    expect(Value.Check(KernelTicketWorkItemV2Schema, { ...workItemV2, progress: null })).toBe(true);
    expect(Value.Check(KernelTicketWorkItemV2Schema, { ...workItemV2, proof: [] })).toBe(false);
    expect(Value.Check(KernelTicketWorkItemV2ListResponseSchema, { items: [workItemV2] })).toBe(true);
    expect(Value.Check(KernelTicketWorkItemV2ListResponseSchema, {
      items: [workItemV2], nextCursor: "1",
    })).toBe(false);

    expect(Value.Check(KernelTicketWorkItemSchema, workItemV2)).toBe(false);
    expect(Value.Check(KernelTicketWorkItemListResponseSchema, { items: [workItemV2] })).toBe(false);
  });

  it("validates deterministic PoW counts, ordering, and workbench-v2 strictness", () => {
    expect(Value.Check(KernelTicketPowSchema, pow)).toBe(true);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, metrics: { ...pow.metrics, elapsedMs: 3_000_000_000 },
    })).toBe(true);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, metrics: { ...pow.metrics, passed: 2 },
    })).toBe(false);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, metrics: { ...pow.metrics, total: 3 },
    })).toBe(false);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, items: [...pow.items].reverse(),
    })).toBe(false);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, items: [pow.items[0], { ...pow.items[0] }], metrics: { ...pow.metrics, total: 2, passed: 2 },
    })).toBe(false);
    expect(Value.Check(KernelTicketPowSchema, {
      ...pow, verdict: "passed",
    })).toBe(false);
    expect(Value.Check(KernelTicketPowSchema, { ...pow, checkpointIds: [12, 13] })).toBe(false);

    const workbenchV2 = {
      ticket,
      timing,
      activeAttempt: attempt,
      children: [{ ...ticket, id: 43, parentTicketId: 42, rootTicketId: 42 }],
      latestCheckpoints: [checkpoint],
      interventionRefs: [],
      progress: ticketProgress,
      pow,
    };
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbenchV2)).toBe(true);
    expect(Value.Check(KernelOutcomeSnapshotResourceSchema, outcomeSnapshot)).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, {
      ...workbenchV2,
      outcomeSnapshot,
    })).toBe(true);
    expect(Value.Check(KernelOutcomeSnapshotResourceSchema, {
      ...outcomeSnapshot,
      facts: { ...outcomeSnapshot.facts, independentEvidence: "passed" },
    })).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, {
      ...workbenchV2,
      latestCheckpoints: [{ ...checkpoint, id: 13 }, checkpoint],
    })).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, { ...workbenchV2, artifacts: [] })).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchSchema, {
      ...workbenchV2,
      pow: undefined,
    })).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchSchema, {
      ...workbenchV2,
      progress: undefined,
    })).toBe(false);
  });

  it("resolves attention verdicts against the enclosing ticket context", () => {
    const workbench = (powValue: typeof pow, status = ticket.status) => ({
      ticket: { ...ticket, status },
      timing,
      activeAttempt: attempt,
      children: [],
      latestCheckpoints: [checkpoint],
      interventionRefs: [],
      progress: ticketProgress,
      pow: powValue,
    });
    const failedPow = {
      ...pow,
      verdict: "attention",
      items: [{
        id: "fidelity.failed",
        label: "高保真验收",
        state: "failed",
        evidence: "overlay mismatch",
        checkpointId: 14,
        updatedAt: createdAt,
      }],
      metrics: { ...pow.metrics, passed: 0, total: 1, pendingInterventionCount: 0 },
    };
    const interventionPow = {
      ...pow,
      verdict: "attention",
      metrics: { ...pow.metrics, pendingInterventionCount: 1 },
    };
    const emptyAttentionPow = {
      ...pow,
      verdict: "attention",
      items: [],
      metrics: { ...pow.metrics, passed: 0, total: 0, pendingInterventionCount: 0 },
    };
    const passedAttentionPow = {
      ...pow,
      verdict: "attention",
      items: [{
        id: "fidelity.passed",
        label: "高保真验收",
        state: "passed",
        evidence: "overlay matches",
        checkpointId: 14,
        updatedAt: createdAt,
      }],
      metrics: { ...pow.metrics, passed: 1, total: 1, pendingInterventionCount: 0 },
    };
    const runningAttentionPow = {
      ...pow,
      verdict: "attention",
      items: [{
        id: "fidelity.pending",
        label: "高保真验收",
        state: "pending",
        evidence: null,
        checkpointId: 14,
        updatedAt: createdAt,
      }],
      metrics: { ...pow.metrics, passed: 0, total: 1, pendingInterventionCount: 0 },
    };

    for (const contextDependent of [passedAttentionPow, runningAttentionPow]) {
      expect(Value.Check(KernelTicketPowSchema, contextDependent)).toBe(true);
    }
    expect(Value.Check(KernelTicketPowSchema, emptyAttentionPow)).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(failedPow))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(interventionPow))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(emptyAttentionPow, "blocked"))).toBe(false);

    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(emptyAttentionPow))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(passedAttentionPow))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench(runningAttentionPow))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench({
      ...emptyAttentionPow,
      verdict: "empty",
    }, "blocked"))).toBe(true);
  });

  it("enforces terminal-status progress consistency at workbench-v2 level", () => {
    const terminalProgress: KernelTicketProgress = {
      current: 1,
      total: 1,
      percent: 100,
      label: null,
      source: "terminal",
      checkpointId: null,
    };
    const childrenProgress: KernelTicketProgress = {
      current: 1,
      total: 2,
      percent: 50,
      label: "子任务",
      source: "children",
      checkpointId: null,
    };
    const workbench = (status: string, progressValue: KernelTicketProgress | null) => ({
      ticket: { ...ticket, status },
      timing,
      activeAttempt: attempt,
      children: [],
      latestCheckpoints: [checkpoint],
      interventionRefs: [],
      progress: progressValue,
      pow,
    });

    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("done", null))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("cancelled", null))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("done", ticketProgress))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("cancelled", ticketProgress))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("active", terminalProgress))).toBe(false);

    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("done", terminalProgress))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("cancelled", terminalProgress))).toBe(false);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("active", null))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("active", ticketProgress))).toBe(true);
    expect(Value.Check(KernelTicketWorkbenchV2Schema, workbench("active", childrenProgress))).toBe(true);
  });
});

describe("artifact kernel protocol", () => {
  it("validates strict checkpoint artifact registration input", () => {
    const input = {
      ref: "report/fidelity",
      name: "fidelity-report.md",
      kind: "report",
      mediaType: "text/markdown",
      description: "高保真验收报告",
      relativePath: "reports/fidelity-report.md",
    };
    expect(Value.Check(CheckpointArtifactInputSchema, input)).toBe(true);
    expect(Value.Check(CheckpointArtifactInputSchema, {
      ...input, relativePath: "reports/2026/fidelity-report.md",
    })).toBe(true);
    expect(Value.Check(CheckpointArtifactInputSchema, {
      ...input, relativePath: "reports\\2026\\fidelity-report.md",
    })).toBe(true);
    expect(Value.Check(CheckpointArtifactInputSchema, {
      ...input, relativePath: "reports/version..2/report.md",
    })).toBe(true);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, relativePath: null })).toBe(true);
    for (const relativePath of [
      "/etc/passwd",
      "\\windows\\system32\\config",
      "C:\\Windows\\system32\\config",
      "C:/Windows/system32/config",
      "C:Windows\\system32\\config",
      "\\\\server\\share\\report.md",
      "//server/share/report.md",
      "./report.md",
      "reports/./report.md",
      "../report.md",
      "reports/../report.md",
      "..\\report.md",
      "reports\\..\\report.md",
      "reports/\0report.md",
      "reports/\nreport.md",
      "reports/\rreport.md",
      "reports/\treport.md",
      "reports/\u007freport.md",
    ]) {
      expect(Value.Check(CheckpointArtifactInputSchema, { ...input, relativePath }), relativePath)
        .toBe(false);
    }
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, ref: "bad ref" })).toBe(false);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, ref: "x".repeat(161) })).toBe(false);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, name: "x".repeat(181) })).toBe(false);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, kind: "x".repeat(121) })).toBe(false);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, description: "x".repeat(1_001) })).toBe(false);
    expect(Value.Check(CheckpointArtifactInputSchema, { ...input, originalPath: input.relativePath })).toBe(false);
  });

  it("enforces artifact SHA, byte bounds, and availability nullability", () => {
    expect(Value.Check(KernelArtifactSchema, artifact)).toBe(true);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "metadata_only", byteLength: null, sha256: null,
    })).toBe(true);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "unavailable", byteLength: null, sha256: null,
    })).toBe(true);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "unavailable",
    })).toBe(true);
    expect(Value.Check(KernelArtifactSchema, { ...artifact, sha256: "A".repeat(64) })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, { ...artifact, sha256: "a".repeat(63) })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, { ...artifact, byteLength: 25 * 1024 * 1024 + 1 })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "available", byteLength: null,
    })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "metadata_only", byteLength: artifact.byteLength, sha256: null,
    })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, {
      ...artifact, availability: "unavailable", byteLength: artifact.byteLength, sha256: null,
    })).toBe(false);
    expect(Value.Check(KernelArtifactSchema, { ...artifact, storageKey: "blobs/a" })).toBe(false);
  });

  it("enforces artifact ordering, list quota, and content metadata strictness", () => {
    expect(Value.Check(KernelArtifactListResponseSchema, {
      items: [artifact, { ...artifact, id: 10, ref: "report/second" }],
    })).toBe(true);
    expect(Value.Check(KernelArtifactListResponseSchema, {
      items: [{ ...artifact, id: 10 }, artifact],
    })).toBe(false);
    expect(Value.Check(KernelArtifactListResponseSchema, {
      items: Array.from({ length: 201 }, (_, index) => ({
        ...artifact, id: index + 1, ref: `artifact/${index}`,
      })),
    })).toBe(false);

    const content = {
      artifactId: artifact.id,
      filename: artifact.name,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    };
    expect(Value.Check(KernelArtifactContentMetadataSchema, content)).toBe(true);
    expect(Value.Check(KernelArtifactContentMetadataSchema, { ...content, sha256: null })).toBe(false);
    expect(Value.Check(KernelArtifactContentMetadataSchema, { ...content, byteLength: null })).toBe(false);
    expect(Value.Check(KernelArtifactContentMetadataSchema, { ...content, availability: "available" })).toBe(false);
  });
});

describe("durable conversation card kernel protocol", () => {
  const operation = {
    id: "turn-1:call-1",
    name: "create_ticket",
    state: "completed",
    label: "创建工单 #42",
    detail: null,
  };

  it("bounds ticket operation projections and exposes truncation metadata", () => {
    expect(CONVERSATION_CARD_LIMITS).toEqual({
      maxOperations: 16,
      operationId: 240,
      operationName: 120,
      operationLabel: 160,
      operationDetail: 500,
      payloadBytes: 16 * 1024,
    });
    expect(Value.Check(TicketOperationProjectionSchema, operation)).toBe(true);
    expect(Value.Check(TicketOperationProjectionSchema, { ...operation, id: "x".repeat(241) })).toBe(false);
    expect(Value.Check(TicketOperationProjectionSchema, { ...operation, name: "x".repeat(121) })).toBe(false);
    expect(Value.Check(TicketOperationProjectionSchema, { ...operation, label: "x".repeat(161) })).toBe(false);
    expect(Value.Check(TicketOperationProjectionSchema, { ...operation, detail: "x".repeat(501) })).toBe(false);

    const execution = {
      id: 9,
      key: "turn:turn-1:ticket:42",
      kind: "ticket_execution",
      turnId: "turn-1",
      ticketId: 42,
      operations: Array.from({ length: 16 }, (_, index) => ({ ...operation, id: `turn-1:call-${index}` })),
      operationsTruncated: true,
      createdAt,
      updatedAt: createdAt,
    };
    expect(Value.Check(KernelConversationCardSchema, execution)).toBe(true);
    expect(Value.Check(KernelConversationCardSchema, {
      ...execution,
      operations: [...execution.operations, { ...operation, id: "turn-1:call-17" }],
    })).toBe(false);
    expect(Value.Check(KernelConversationCardSchema, { ...execution, key: "ticket:42" })).toBe(false);
  });

  it("validates checkpoint and intervention card stable keys", () => {
    expect(Value.Check(KernelConversationCardSchema, {
      id: 10,
      key: "checkpoint:12",
      kind: "checkpoint",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      createdAt,
      updatedAt: createdAt,
    })).toBe(true);
    expect(Value.Check(KernelConversationCardSchema, {
      id: 10,
      key: "checkpoint:13",
      kind: "checkpoint",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      createdAt,
      updatedAt: createdAt,
    })).toBe(false);
    expect(Value.Check(KernelConversationCardSchema, {
      id: 11,
      key: "intervention:approval:18",
      kind: "intervention",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      interventionId: "approval:18",
      createdAt,
      updatedAt: createdAt,
    })).toBe(true);
    expect(Value.Check(KernelConversationCardSchema, {
      id: 11,
      key: "intervention:approval:19",
      kind: "intervention",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      interventionId: "approval:18",
      createdAt,
      updatedAt: createdAt,
    })).toBe(false);
    expect(Value.Check(KernelConversationCardSchema, {
      id: 11,
      key: "intervention:approval:18",
      kind: "intervention",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      interventionId: "decision:18",
      createdAt,
      updatedAt: createdAt,
    })).toBe(false);
  });

  it("validates conversation card filters and sidecar collection response", () => {
    expect(Value.Check(KernelConversationCardListQuerySchema, {
      after_id: 8, limit: 100, ticket_id: [42], key: ["checkpoint:12"],
    })).toBe(true);
    expect(Value.Check(KernelConversationCardListQuerySchema, {
      after_id: 8, before_id: 9,
    })).toBe(false);
    expect(Value.Check(KernelConversationCardListQuerySchema, { limit: 201 })).toBe(false);

    const card = {
      id: 10,
      key: "checkpoint:12",
      kind: "checkpoint",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      createdAt,
      updatedAt: createdAt,
    };
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [card],
      checkpoints: [checkpoint],
      interventionRefs: [],
      hasMore: false,
      nextBeforeId: null,
    })).toBe(true);
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [card], checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null,
    })).toBe(false);
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [{ ...card, id: 11 }, card],
      checkpoints: [checkpoint], interventionRefs: [], hasMore: false, nextBeforeId: null,
    })).toBe(false);
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [card], checkpoints: [checkpoint], interventionRefs: [], hasMore: true, nextBeforeId: 9,
    })).toBe(false);

    const interventionCard = {
      id: 11,
      key: "intervention:approval:18",
      kind: "intervention",
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      interventionId: "approval:18",
      createdAt,
      updatedAt: createdAt,
    };
    const interventionRef = {
      id: "approval:18",
      ticketId: 42,
      kind: "approval",
      state: "pending",
      requiresAction: true,
    };
    const interventionCheckpoint = {
      ...checkpoint,
      kind: "blocked",
      nextStep: null,
      actionRef: { type: "approval", id: 18 },
    };
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [interventionCard], checkpoints: [interventionCheckpoint],
      interventionRefs: [interventionRef], hasMore: false, nextBeforeId: null,
    })).toBe(true);
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      items: [interventionCard], checkpoints: [checkpoint], interventionRefs: [interventionRef],
      hasMore: false, nextBeforeId: null,
    })).toBe(false);
  });
});
