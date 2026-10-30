import {
  Type,
  type Static,
  type TObject,
  type TProperties,
  type TSchema,
} from "typebox";
import {
  CHECKPOINT_LIMITS,
  KernelCheckpointSchema,
  type KernelCheckpoint,
} from "./checkpoints.ts";
import { KernelInterventionRefSchema } from "./interventions.ts";
import {
  KernelTicketTimingSchema,
  KernelTicketWorkItemSchema,
} from "./workbench.ts";

const MAX_SAFE_DOMAIN_INTEGER = 2_147_483_647;
const MAX_PROOF_ITEMS_PER_CHECKPOINT = 20;
const MAX_CURRENT_PROOF_ITEMS = 200;
const MAX_ARTIFACTS_PER_TICKET = 200;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const KERNEL_FIDELITY_CAPABILITIES = {
  checkpoints: "kernel.checkpoints.v2",
  workItems: "kernel.work-items.v2",
  workbench: "kernel.ticket-workbench.v2",
  artifacts: "kernel.artifacts.v1",
} as const;

const DomainIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_SAFE_DOMAIN_INTEGER,
});

const PositiveDomainIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: MAX_SAFE_DOMAIN_INTEGER,
});

const NullableProgressLabelSchema = Type.Union([
  Type.String({ maxLength: 120 }),
  Type.Null(),
]);

const CheckpointProgressShape = StrictObject({
  current: DomainIntegerSchema,
  total: PositiveDomainIntegerSchema,
  label: NullableProgressLabelSchema,
});

export const CheckpointProgressSchema = Type.Refine(
  CheckpointProgressShape,
  (progress) => progress.current <= progress.total,
);
export type CheckpointProgress = Static<typeof CheckpointProgressSchema>;

export const CheckpointProofItemSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9._-]+$" }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("retired"),
  ]),
  evidence: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
});
export type CheckpointProofItem = Static<typeof CheckpointProofItemSchema>;

const CheckpointV2Fields = {
  progress: Type.Union([CheckpointProgressSchema, Type.Null()]),
  proofItems: Type.Array(CheckpointProofItemSchema, {
    maxItems: MAX_PROOF_ITEMS_PER_CHECKPOINT,
  }),
};

export type KernelCheckpointV2 = KernelCheckpoint & {
  progress: CheckpointProgress | null;
  proofItems: CheckpointProofItem[];
};

const extendCheckpointV2Variant = <T extends TObject>(schema: T) =>
  StrictObject({
    ...schema.properties,
    ...CheckpointV2Fields,
  });

const [firstCheckpointV1Variant, ...remainingCheckpointV1Variants] = KernelCheckpointSchema.anyOf;
const KernelCheckpointV2UnionSchema = Type.Union([
  extendCheckpointV2Variant(firstCheckpointV1Variant),
  ...remainingCheckpointV1Variants.map(extendCheckpointV2Variant),
]);

export const KernelCheckpointV2Schema = Type.Refine(
  Type.Unsafe<KernelCheckpointV2>(KernelCheckpointV2UnionSchema),
  (checkpoint) => new Set(checkpoint.proofItems.map((item) => item.id)).size
    === checkpoint.proofItems.length,
);

const KernelCheckpointV2ListResponseShape = StrictObject({
  items: Type.Array(KernelCheckpointV2Schema, { maxItems: CHECKPOINT_LIMITS.pageSize }),
  hasMore: Type.Boolean(),
  nextBeforeId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});

export const KernelCheckpointV2ListResponseSchema = Type.Refine(
  KernelCheckpointV2ListResponseShape,
  (response) => {
    const ascending = response.items.every((item, index) =>
      index === 0 || response.items[index - 1]!.id < item.id);
    if (!ascending) return false;
    const hasCursor = response.nextBeforeId !== null;
    if (response.hasMore !== hasCursor) return false;
    return !hasCursor
      || (response.items.length > 0 && response.nextBeforeId === response.items[0]!.id);
  },
);
export type KernelCheckpointV2ListResponse = Static<typeof KernelCheckpointV2ListResponseSchema>;

const KernelTicketProgressShape = StrictObject({
  current: DomainIntegerSchema,
  total: PositiveDomainIntegerSchema,
  percent: Type.Integer({ minimum: 0, maximum: 100 }),
  label: NullableProgressLabelSchema,
  source: Type.Union([
    Type.Literal("explicit"),
    Type.Literal("children"),
    Type.Literal("terminal"),
  ]),
  checkpointId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});

export const KernelTicketProgressSchema = Type.Refine(
  KernelTicketProgressShape,
  (progress) => {
    if (progress.current > progress.total) return false;
    if (progress.percent !== Math.round(progress.current * 100 / progress.total)) return false;
    if (progress.source === "explicit" && progress.checkpointId === null) return false;
    if (progress.source !== "explicit" && progress.checkpointId !== null) return false;
    if (progress.source === "terminal") {
      return progress.current === 1 && progress.total === 1 && progress.percent === 100;
    }
    return true;
  },
);
export type KernelTicketProgress = Static<typeof KernelTicketProgressSchema>;

export const KernelOutcomeChangeSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("file"),
    Type.Literal("commit"),
    Type.Literal("other"),
  ]),
  ref: Type.String({ minLength: 1, maxLength: 4_096 }),
  summary: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
});
export type KernelOutcomeChange = Static<typeof KernelOutcomeChangeSchema>;

export const KernelOutcomeDeliverableSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("artifact"),
    Type.Literal("path"),
    Type.Literal("url"),
    Type.Literal("other"),
  ]),
  ref: Type.String({ minLength: 1, maxLength: 4_096 }),
  label: Type.String({ minLength: 1, maxLength: 240 }),
});
export type KernelOutcomeDeliverable = Static<typeof KernelOutcomeDeliverableSchema>;

export const KernelOutcomeValidationSchema = StrictObject({
  command: Type.String({ minLength: 1, maxLength: 1_000 }),
  outcome: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("not_run"),
  ]),
  exitCode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  summary: Type.String({ minLength: 1, maxLength: 1_000 }),
  evidenceRef: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
});
export type KernelOutcomeValidation = Static<typeof KernelOutcomeValidationSchema>;

export const KernelOutcomeSnapshotSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  executorAttemptId: Type.Integer({ minimum: 1 }),
  completionCheckpointId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  source: Type.Union([
    Type.Literal("agent_reported"),
    Type.Literal("system_recovered"),
  ]),
  sourceEventSeq: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  sourceOutputSha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  changes: Type.Array(KernelOutcomeChangeSchema, { maxItems: 50 }),
  deliverables: Type.Array(KernelOutcomeDeliverableSchema, { maxItems: 50 }),
  validations: Type.Array(KernelOutcomeValidationSchema, { maxItems: 50 }),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  missingFields: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 }),
  recoveryNote: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
  createdAt: Type.String(),
});
export type KernelOutcomeSnapshot = Static<typeof KernelOutcomeSnapshotSchema>;

export const KernelOutcomeSnapshotResourceSchema = StrictObject({
  latest: Type.Union([KernelOutcomeSnapshotSchema, Type.Null()]),
  historyCount: Type.Integer({ minimum: 0 }),
  facts: StrictObject({
    implementationCompleted: Type.Boolean(),
    independentEvidence: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("missing"),
    ]),
    acceptance: Type.Union([
      Type.Literal("user"),
      Type.Literal("automatic"),
      Type.Literal("none"),
    ]),
  }),
  reviewerVerdict: Type.Union([
    StrictObject({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      attemptId: Type.Integer({ minimum: 1 }),
      evidence: Type.String(),
      evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
    }),
    Type.Null(),
  ]),
});
export type KernelOutcomeSnapshotResource = Static<typeof KernelOutcomeSnapshotResourceSchema>;

export const KernelTicketWorkItemV2Schema = StrictObject({
  ...KernelTicketWorkItemSchema.properties,
  progress: Type.Union([KernelTicketProgressSchema, Type.Null()]),
});
export type KernelTicketWorkItemV2 = Static<typeof KernelTicketWorkItemV2Schema>;

export const KernelTicketWorkItemV2ListResponseSchema = StrictObject({
  items: Type.Array(KernelTicketWorkItemV2Schema),
});
export type KernelTicketWorkItemV2ListResponse = Static<
  typeof KernelTicketWorkItemV2ListResponseSchema
>;

export const KernelTicketPowItemSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9._-]+$" }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("passed"),
    Type.Literal("failed"),
  ]),
  evidence: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
  checkpointId: Type.Integer({ minimum: 1 }),
  // 哪个 Run 报的这一项（来自它所在 checkpoint 的 run_id）。没有 Run 的系统 checkpoint 为 null。
  attemptId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  // 这一项属于哪一次交付。交付 Run 报的就是它自己；reviewer、工单对话和修复回合报的，
  // 属于它们之前最近的那次交付（它们核查或谈论的就是那一次）。没有 Run 时为 null。
  deliveryAttemptId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  updatedAt: Type.String(),
});
export type KernelTicketPowItem = Static<typeof KernelTicketPowItemSchema>;

export const KernelTicketPowMetricsSchema = StrictObject({
  passed: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  checkpointCount: Type.Integer({ minimum: 0 }),
  toolOperationCount: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  pendingInterventionCount: Type.Integer({ minimum: 0 }),
});
export type KernelTicketPowMetrics = Static<typeof KernelTicketPowMetricsSchema>;

const KernelTicketPowShape = StrictObject({
  verdict: Type.Union([
    Type.Literal("empty"),
    Type.Literal("running"),
    Type.Literal("attention"),
    Type.Literal("passed"),
  ]),
  items: Type.Array(KernelTicketPowItemSchema, { maxItems: MAX_CURRENT_PROOF_ITEMS }),
  metrics: KernelTicketPowMetricsSchema,
  // 最新的交付 Run（对话和修复回合不算）。attemptId 不等于它的条目是更早交付留下的证据。
  deliveryAttemptId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  computedAt: Type.String(),
});

export const KernelTicketPowSchema = Type.Refine(
  KernelTicketPowShape,
  (pow) => {
    const ids = new Set(pow.items.map((item) => item.id));
    if (ids.size !== pow.items.length) return false;

    const ordered = pow.items.every((item, index) => {
      if (index === 0) return true;
      const previous = pow.items[index - 1]!;
      return previous.checkpointId < item.checkpointId
        || (previous.checkpointId === item.checkpointId && previous.id < item.id);
    });
    if (!ordered) return false;

    const passed = pow.items.filter((item) => item.state === "passed").length;
    if (pow.metrics.total !== pow.items.length || pow.metrics.passed !== passed) return false;

    const hasFailure = pow.items.some((item) => item.state === "failed");
    const hasPendingIntervention = pow.metrics.pendingInterventionCount > 0;
    const allPassed = pow.items.length > 0 && passed === pow.items.length;
    if (pow.verdict === "empty") {
      return pow.items.length === 0;
    }
    if (pow.items.length === 0) return false;
    if (pow.verdict === "passed") {
      return allPassed && !hasPendingIntervention;
    }
    if (pow.verdict === "running") {
      return pow.items.length > 0 && !hasFailure && !hasPendingIntervention && !allPassed;
    }
    return true;
  },
);
export type KernelTicketPow = Static<typeof KernelTicketPowSchema>;

function powVerdictMatchesTicketContext(
  ticketStatus: string,
  pow: KernelTicketPow,
): boolean {
  const hasFailure = pow.items.some((item) => item.state === "failed");
  const hasPendingIntervention = pow.metrics.pendingInterventionCount > 0;
  const blocked = ticketStatus === "blocked";
  const requiresAttention = hasFailure || hasPendingIntervention || blocked;
  if (pow.items.length === 0) return pow.verdict === "empty";
  if (pow.verdict === "attention") return requiresAttention;
  if (requiresAttention) return false;
  if (pow.metrics.passed === pow.metrics.total) return pow.verdict === "passed";
  return pow.verdict === "running";
}

function progressMatchesTicketStatus(
  ticketStatus: string,
  progress: KernelTicketProgress | null,
): boolean {
  if (ticketStatus === "done") return progress !== null && progress.source === "terminal";
  if (ticketStatus === "cancelled") return progress === null;
  return progress === null || progress.source !== "terminal";
}

type KernelTicketWorkbenchV2RefinementValue = {
  ticket: { status: string };
  latestCheckpoints: Array<{ id: number }>;
  progress: KernelTicketProgress | null;
  pow: KernelTicketPow;
};

export function createKernelTicketWorkbenchV2Schema<
  TTicket extends TSchema,
  TAttempt extends TSchema,
>(ticketSchema: TTicket, attemptSchema: TAttempt) {
  // timing / latestCheckpoints / pow 可选：数据源是 Run，没跑过就整个不投（kernel spec §11）。
  // 空数组 + 全 null 的 timing + verdict='empty' 的 pow 会被下游读成"有这类数据，只是现在
  // 为空"，UI 照样把一排空脚手架渲染出来——那正是提醒页面今天的样子。
  const schema = StrictObject({
    ticket: ticketSchema,
    timing: Type.Optional(KernelTicketTimingSchema),
    activeAttempt: Type.Union([attemptSchema, Type.Null()]),
    children: Type.Array(ticketSchema),
    latestCheckpoints: Type.Optional(Type.Array(KernelCheckpointSchema, { maxItems: 50 })),
    interventionRefs: Type.Array(KernelInterventionRefSchema),
    progress: Type.Union([KernelTicketProgressSchema, Type.Null()]),
    pow: Type.Optional(KernelTicketPowSchema),
    outcomeSnapshot: Type.Optional(KernelOutcomeSnapshotResourceSchema),
  });
  return Type.Refine<typeof schema, KernelTicketWorkbenchV2RefinementValue>(
    schema,
    (workbench) => {
      // 缺席的字段没有可校验的不变量——这些 refinement 描述的是"若存在则必须自洽"。
      const checkpoints = workbench.latestCheckpoints ?? [];
      const checkpointsAscending = checkpoints.every((checkpoint, index) =>
        index === 0 || checkpoints[index - 1]!.id < checkpoint.id);
      return checkpointsAscending
        && (workbench.pow === undefined
          || powVerdictMatchesTicketContext(workbench.ticket.status, workbench.pow))
        && progressMatchesTicketStatus(workbench.ticket.status, workbench.progress);
    },
  );
}

const CheckpointArtifactInputShape = StrictObject({
  ref: Type.String({
    minLength: 1,
    maxLength: 160,
    pattern: "^[A-Za-z0-9._:/-]+$",
  }),
  name: Type.String({ minLength: 1, maxLength: 180 }),
  kind: Type.String({ minLength: 1, maxLength: 120 }),
  mediaType: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
  relativePath: Type.Union([
    Type.String({ minLength: 1, maxLength: 4_096 }),
    Type.Null(),
  ]),
});

export const CheckpointArtifactInputSchema = Type.Refine(
  CheckpointArtifactInputShape,
  (artifact) => {
    const path = artifact.relativePath;
    if (path === null) return true;
    if (/[\u0000-\u001f\u007f]/.test(path)) return false;
    if (path.startsWith("/") || path.startsWith("\\")) return false;
    if (/^[A-Za-z]:/.test(path)) return false;
    return !path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
  },
);
export type CheckpointArtifactInput = Static<typeof CheckpointArtifactInputSchema>;

const ArtifactAvailabilitySchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("metadata_only"),
  Type.Literal("unavailable"),
]);

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);
const NullableArtifactByteLengthSchema = Type.Union([
  Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  Type.Null(),
]);

const KernelArtifactShape = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  checkpointId: Type.Integer({ minimum: 1 }),
  ref: Type.String({ minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9._:/-]+$" }),
  name: Type.String({ minLength: 1, maxLength: 180 }),
  kind: Type.String({ minLength: 1, maxLength: 120 }),
  mediaType: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
  availability: ArtifactAvailabilitySchema,
  byteLength: NullableArtifactByteLengthSchema,
  sha256: NullableSha256Schema,
  createdAt: Type.String(),
});

export const KernelArtifactSchema = Type.Refine(
  KernelArtifactShape,
  (artifact) => {
    const hasByteLength = artifact.byteLength !== null;
    const hasSha = artifact.sha256 !== null;
    if (hasByteLength !== hasSha) return false;
    if (artifact.availability === "available") return hasByteLength;
    if (artifact.availability === "metadata_only") return !hasByteLength;
    return true;
  },
);
export type KernelArtifact = Static<typeof KernelArtifactSchema>;

const KernelArtifactListResponseShape = StrictObject({
  items: Type.Array(KernelArtifactSchema, { maxItems: MAX_ARTIFACTS_PER_TICKET }),
});

export const KernelArtifactListResponseSchema = Type.Refine(
  KernelArtifactListResponseShape,
  (response) => response.items.every((item, index) =>
    index === 0 || response.items[index - 1]!.id < item.id),
);
export type KernelArtifactListResponse = Static<typeof KernelArtifactListResponseSchema>;

export const KernelArtifactContentMetadataSchema = StrictObject({
  artifactId: Type.Integer({ minimum: 1 }),
  filename: Type.String({ minLength: 1, maxLength: 180 }),
  mediaType: Type.String({ minLength: 1, maxLength: 120 }),
  byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  sha256: Sha256Schema,
});
export type KernelArtifactContentMetadata = Static<
  typeof KernelArtifactContentMetadataSchema
>;
