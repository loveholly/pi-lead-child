import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const DECISION_REQUEST_KINDS = ["decision", "question", "blocker"] as const;
export const DECISION_REQUEST_AUDIENCES = ["lead", "user", "lead_or_user"] as const;

export const DecisionRequestKindSchema = Type.Union([
  Type.Literal("decision"),
  Type.Literal("question"),
  Type.Literal("blocker"),
]);
export type DecisionRequestKind = Static<typeof DecisionRequestKindSchema>;

export const DecisionRequestAudienceSchema = Type.Union([
  Type.Literal("lead"),
  Type.Literal("user"),
  Type.Literal("lead_or_user"),
]);
export type DecisionRequestAudience = Static<typeof DecisionRequestAudienceSchema>;

export const DecisionRequestStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("resolved"),
  Type.Literal("dismissed"),
  Type.Literal("expired"),
]);
export type DecisionRequestState = Static<typeof DecisionRequestStateSchema>;

export const DecisionResolutionKindSchema = Type.Union([
  Type.Literal("option"),
  Type.Literal("text"),
  Type.Literal("dismissed"),
  Type.Literal("expired"),
]);
export type DecisionResolutionKind = Static<typeof DecisionResolutionKindSchema>;

export const DecisionRequestOptionSchema = StrictObject({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.Union([Type.String(), Type.Null()]),
});
export type DecisionRequestOption = Static<typeof DecisionRequestOptionSchema>;

export const CreateDecisionRequestOptionSchema = StrictObject({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
});

export const DecisionCheckpointContextSchema = StrictObject({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  next_step: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type DecisionCheckpointContext = Static<typeof DecisionCheckpointContextSchema>;

export const CreateDecisionRequestSchema = StrictObject({
  kind: DecisionRequestKindSchema,
  audience: DecisionRequestAudienceSchema,
  blocking: Type.Optional(Type.Boolean()),
  allow_custom: Type.Optional(Type.Boolean()),
  prompt: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(CreateDecisionRequestOptionSchema)),
  checkpoint: DecisionCheckpointContextSchema,
});
export type CreateDecisionRequest = Static<typeof CreateDecisionRequestSchema>;

export const KernelDecisionRequestSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  kind: DecisionRequestKindSchema,
  audience: DecisionRequestAudienceSchema,
  blocking: Type.Boolean(),
  allowCustom: Type.Boolean(),
  prompt: Type.String({ minLength: 1 }),
  options: Type.Array(DecisionRequestOptionSchema),
  state: DecisionRequestStateSchema,
  resolutionKind: Type.Union([DecisionResolutionKindSchema, Type.Null()]),
  selectedOptionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  resolutionText: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  dismissalReason: Type.Union([Type.String(), Type.Null()]),
  resolvedBy: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type KernelDecisionRequest = Static<typeof KernelDecisionRequestSchema>;

export const KernelInterventionIdSchema = Type.Union([
  Type.String({ pattern: "^approval:[1-9][0-9]*$" }),
  Type.String({ pattern: "^decision:[1-9][0-9]*$" }),
]);

export const KernelInterventionStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("resolved"),
  Type.Literal("dismissed"),
  Type.Literal("expired"),
]);

const ApprovalInterventionRefShape = StrictObject({
  id: Type.String({ pattern: "^approval:[1-9][0-9]*$" }),
  ticketId: Type.Integer({ minimum: 1 }),
  kind: Type.Literal("approval"),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("expired"),
  ]),
  requiresAction: Type.Boolean(),
});
const ApprovalInterventionRefSchema = Type.Refine(
  ApprovalInterventionRefShape,
  (ref) => ref.requiresAction === (ref.state === "pending"),
);

const DecisionInterventionRefShape = StrictObject({
  id: Type.String({ pattern: "^decision:[1-9][0-9]*$" }),
  ticketId: Type.Integer({ minimum: 1 }),
  kind: Type.Union([
    Type.Literal("decision"),
    Type.Literal("question"),
    Type.Literal("blocker"),
  ]),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("resolved"),
    Type.Literal("dismissed"),
    Type.Literal("expired"),
  ]),
  requiresAction: Type.Boolean(),
});
const DecisionInterventionRefSchema = Type.Refine(
  DecisionInterventionRefShape,
  (ref) => ref.requiresAction === (ref.state === "pending"),
);

export const KernelInterventionRefSchema = Type.Union([
  ApprovalInterventionRefSchema,
  DecisionInterventionRefSchema,
]);
export type KernelInterventionRef = Static<typeof KernelInterventionRefSchema>;

export const KernelInterventionKindSchema = Type.Union([
    Type.Literal("approval"),
    Type.Literal("decision"),
    Type.Literal("question"),
    Type.Literal("blocker"),
]);

export const ApprovalInterventionActionSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("reject"),
  Type.Literal("approve_session"),
]);

export const ApprovalInterventionResolutionSchema = StrictObject({
  decision: ApprovalInterventionActionSchema,
  sessionExempt: Type.Boolean(),
});

const ApprovalInterventionShape = StrictObject({
  id: Type.String({ pattern: "^approval:[1-9][0-9]*$" }),
  kind: Type.Literal("approval"),
  authorityId: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  audience: Type.Literal("user"),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("expired"),
  ]),
  title: Type.String(),
  detail: Type.String(),
  actions: Type.Array(ApprovalInterventionActionSchema, { maxItems: 3 }),
  resolution: Type.Union([ApprovalInterventionResolutionSchema, Type.Null()]),
  createdAt: Type.String(),
  resolvedBy: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
});
const ApprovalInterventionSchema = Type.Refine(
  ApprovalInterventionShape,
  (intervention) => {
    if (intervention.state === "pending") return intervention.resolution === null;
    if (intervention.actions.length > 0) return false;
    if (intervention.state === "expired") return intervention.resolution === null;
    if (intervention.resolution === null) return false;
    if (intervention.state === "rejected") {
      return intervention.resolution.decision === "reject" && !intervention.resolution.sessionExempt;
    }
    if (intervention.resolution.decision === "reject") return false;
    return intervention.resolution.sessionExempt ===
      (intervention.resolution.decision === "approve_session");
  },
);

export const DecisionInterventionActionSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("select"),
    optionId: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    kind: Type.Literal("respond"),
    label: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    kind: Type.Literal("dismiss"),
    label: Type.String({ minLength: 1 }),
  }),
]);

export const DecisionInterventionResolutionSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("option"),
    Type.Literal("text"),
    Type.Literal("dismissed"),
  ]),
  optionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  text: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});

const DecisionInterventionShape = StrictObject({
  id: Type.String({ pattern: "^decision:[1-9][0-9]*$" }),
  kind: DecisionRequestKindSchema,
  authorityId: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  audience: DecisionRequestAudienceSchema,
  blocking: Type.Boolean(),
  allowCustom: Type.Boolean(),
  state: DecisionRequestStateSchema,
  title: Type.String(),
  detail: Type.String(),
  options: Type.Array(DecisionRequestOptionSchema),
  actions: Type.Array(DecisionInterventionActionSchema),
  resolution: Type.Union([DecisionInterventionResolutionSchema, Type.Null()]),
  createdAt: Type.String(),
  resolvedBy: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
});
const DecisionInterventionSchema = Type.Refine(
  DecisionInterventionShape,
  (intervention) => {
    const optionIds = new Set(intervention.options.map((option) => option.id));
    const actionsValid = intervention.actions.every((action) => {
      if (action.kind === "select") return optionIds.has(action.optionId);
      if (action.kind === "respond") {
        return intervention.options.length === 0 || intervention.allowCustom;
      }
      return true;
    });
    if (!actionsValid) return false;
    if (intervention.state === "pending") return intervention.resolution === null;
    if (intervention.actions.length > 0) return false;
    if (intervention.state === "expired") return intervention.resolution === null;
    if (intervention.resolution === null) return false;
    const resolution = intervention.resolution;
    if (intervention.state === "dismissed") {
      return resolution.kind === "dismissed" && resolution.optionId === null && resolution.text === null;
    }
    if (resolution.kind === "option") {
      return resolution.optionId !== null && optionIds.has(resolution.optionId) && resolution.text === null;
    }
    if (resolution.kind === "text") {
      return resolution.optionId === null && resolution.text !== null;
    }
    return false;
  },
);

export const KernelInterventionSchema = Type.Union([
  ApprovalInterventionSchema,
  DecisionInterventionSchema,
]);
export type KernelIntervention = Static<typeof KernelInterventionSchema>;

export const ResolveKernelInterventionRequestSchema = Type.Union([
  StrictObject({
    authority: Type.Literal("approval"),
    decision: ApprovalInterventionActionSchema,
  }),
  StrictObject({
    authority: Type.Literal("decision_request"),
    decision: Type.Literal("select"),
    optionId: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    authority: Type.Literal("decision_request"),
    decision: Type.Literal("respond"),
    resolution: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    authority: Type.Literal("decision_request"),
    decision: Type.Literal("dismiss"),
    reason: Type.Optional(Type.String()),
  }),
]);
export type ResolveKernelInterventionRequest = Static<typeof ResolveKernelInterventionRequestSchema>;

export const KernelInterventionListQuerySchema = StrictObject({
  ticket_id: Type.Optional(Type.Integer({ minimum: 1 })),
  state: Type.Optional(KernelInterventionStateSchema),
  id: Type.Optional(Type.Array(KernelInterventionIdSchema, { maxItems: 200 })),
});
export type KernelInterventionListQuery = Static<typeof KernelInterventionListQuerySchema>;

export const KernelInterventionListResponseSchema = StrictObject({
  items: Type.Array(KernelInterventionSchema),
});
export type KernelInterventionListResponse = Static<typeof KernelInterventionListResponseSchema>;
