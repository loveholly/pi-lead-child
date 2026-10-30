import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const CHECKPOINT_KINDS = [
  "progress",
  "milestone",
  "decision",
  "delegation",
  "blocked",
  "completed",
] as const;

export const CHECKPOINT_SOURCES = ["agent_reported", "system_derived"] as const;

export const CHECKPOINT_LIMITS = {
  title: 160,
  summary: 2_000,
  stage: 120,
  keyFacts: 8,
  factLabel: 80,
  factValue: 240,
  artifactRefs: 20,
  relatedTicketIds: 20,
  nextStep: 500,
  pageSize: 200,
} as const;

export const CheckpointKindSchema = Type.Union([
  Type.Literal("progress"),
  Type.Literal("milestone"),
  Type.Literal("decision"),
  Type.Literal("delegation"),
  Type.Literal("blocked"),
  Type.Literal("completed"),
]);
export type CheckpointKind = Static<typeof CheckpointKindSchema>;

export const CheckpointSourceSchema = Type.Union([
  Type.Literal("agent_reported"),
  Type.Literal("system_derived"),
]);
export type CheckpointSource = Static<typeof CheckpointSourceSchema>;

export const CheckpointRuntimeSchema = Type.Union([
  Type.Literal("pi"),
  Type.Literal("codex"),
  Type.Literal("claude"),
]);

export const CheckpointFactSchema = StrictObject({
  label: Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.factLabel }),
  value: Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.factValue }),
});
export type CheckpointFact = Static<typeof CheckpointFactSchema>;

export const CheckpointActionRefSchema = Type.Union([
  StrictObject({
    type: Type.Literal("approval"),
    id: Type.Integer({ minimum: 1 }),
  }),
  StrictObject({
    type: Type.Literal("decision_request"),
    id: Type.Integer({ minimum: 1 }),
  }),
]);
export type CheckpointActionRef = Static<typeof CheckpointActionRefSchema>;

export const CheckpointAuthorSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("executor"),
    Type.Literal("reviewer"),
    Type.Literal("system"),
  ]),
  runtime: Type.Union([CheckpointRuntimeSchema, Type.Null()]),
});
export type CheckpointAuthor = Static<typeof CheckpointAuthorSchema>;

const RelatedTicketIdsSchema = Type.Array(Type.Integer({ minimum: 1 }), {
  maxItems: CHECKPOINT_LIMITS.relatedTicketIds,
});

const RequiredRelatedTicketIdsSchema = Type.Array(Type.Integer({ minimum: 1 }), {
  minItems: 1,
  maxItems: CHECKPOINT_LIMITS.relatedTicketIds,
});

const NextStepSchema = Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.nextStep });
const NullableNextStepSchema = Type.Union([NextStepSchema, Type.Null()]);
const NullableActionRefSchema = Type.Union([CheckpointActionRefSchema, Type.Null()]);

const CheckpointBase = {
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  author: CheckpointAuthorSchema,
  source: CheckpointSourceSchema,
  stage: Type.Union([
    Type.String({ maxLength: CHECKPOINT_LIMITS.stage }),
    Type.Null(),
  ]),
  title: Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.title }),
  summary: Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.summary }),
  keyFacts: Type.Array(CheckpointFactSchema, { maxItems: CHECKPOINT_LIMITS.keyFacts }),
  artifactRefs: Type.Array(Type.String({ minLength: 1 }), {
    maxItems: CHECKPOINT_LIMITS.artifactRefs,
  }),
  createdAt: Type.String(),
};

const StandardCheckpoint = (kind: "progress" | "milestone" | "decision" | "completed") =>
  StrictObject({
    ...CheckpointBase,
    kind: Type.Literal(kind),
    relatedTicketIds: RelatedTicketIdsSchema,
    nextStep: NullableNextStepSchema,
    actionRef: NullableActionRefSchema,
  });

const DelegationCheckpointSchema = StrictObject({
  ...CheckpointBase,
  kind: Type.Literal("delegation"),
  relatedTicketIds: RequiredRelatedTicketIdsSchema,
  nextStep: NullableNextStepSchema,
  actionRef: NullableActionRefSchema,
});

const BlockedWithNextStepSchema = StrictObject({
  ...CheckpointBase,
  kind: Type.Literal("blocked"),
  relatedTicketIds: RelatedTicketIdsSchema,
  nextStep: NextStepSchema,
  actionRef: NullableActionRefSchema,
});

const BlockedWithActionSchema = StrictObject({
  ...CheckpointBase,
  kind: Type.Literal("blocked"),
  relatedTicketIds: RelatedTicketIdsSchema,
  nextStep: NullableNextStepSchema,
  actionRef: CheckpointActionRefSchema,
});

export const KernelCheckpointSchema = Type.Union([
  StandardCheckpoint("progress"),
  StandardCheckpoint("milestone"),
  StandardCheckpoint("decision"),
  DelegationCheckpointSchema,
  BlockedWithNextStepSchema,
  BlockedWithActionSchema,
  StandardCheckpoint("completed"),
]);
export type KernelCheckpoint = Static<typeof KernelCheckpointSchema>;

const CheckpointQueryBase = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CHECKPOINT_LIMITS.pageSize })),
};

export const KernelCheckpointListQuerySchema = Type.Union([
  StrictObject(CheckpointQueryBase),
  StrictObject({
    ...CheckpointQueryBase,
    after_id: Type.Integer({ minimum: 0 }),
  }),
  StrictObject({
    ...CheckpointQueryBase,
    before_id: Type.Integer({ minimum: 1 }),
  }),
]);
export type KernelCheckpointListQuery = Static<typeof KernelCheckpointListQuerySchema>;

const KernelCheckpointListResponseShape = StrictObject({
  items: Type.Array(KernelCheckpointSchema, { maxItems: CHECKPOINT_LIMITS.pageSize }),
  hasMore: Type.Boolean(),
  nextBeforeId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export const KernelCheckpointListResponseSchema = Type.Refine(
  KernelCheckpointListResponseShape,
  (response) => {
    const ascending = response.items.every((item, index) =>
      index === 0 || response.items[index - 1]!.id < item.id);
    if (!ascending) return false;
    return response.nextBeforeId === null
      || (response.items.length > 0 && response.nextBeforeId === response.items[0]!.id);
  },
);
export type KernelCheckpointListResponse = Static<typeof KernelCheckpointListResponseSchema>;
