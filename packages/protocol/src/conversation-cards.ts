import { Type, type Static, type TProperties } from "typebox";
import { KernelCheckpointSchema } from "./checkpoints.ts";
import { KernelInterventionRefSchema } from "./interventions.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const CONVERSATION_CARD_LIMITS = {
  maxOperations: 16,
  operationId: 240,
  operationName: 120,
  operationLabel: 160,
  operationDetail: 500,
  payloadBytes: 16 * 1024,
} as const;

export const TicketOperationProjectionSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: CONVERSATION_CARD_LIMITS.operationId }),
  name: Type.String({ minLength: 1, maxLength: CONVERSATION_CARD_LIMITS.operationName }),
  state: Type.Union([
    Type.Literal("started"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  label: Type.String({ minLength: 1, maxLength: CONVERSATION_CARD_LIMITS.operationLabel }),
  detail: Type.Union([
    Type.String({ maxLength: CONVERSATION_CARD_LIMITS.operationDetail }),
    Type.Null(),
  ]),
});
export type TicketOperationProjection = Static<typeof TicketOperationProjectionSchema>;

const CardTimestamps = {
  createdAt: Type.String(),
  updatedAt: Type.String(),
};

const TicketExecutionCardShape = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  key: Type.String({ pattern: "^turn:.+:ticket:[1-9][0-9]*$" }),
  kind: Type.Literal("ticket_execution"),
  turnId: Type.String({ minLength: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  operations: Type.Array(TicketOperationProjectionSchema, {
    maxItems: CONVERSATION_CARD_LIMITS.maxOperations,
  }),
  operationsTruncated: Type.Boolean(),
  ...CardTimestamps,
});
const TicketExecutionCardSchema = Type.Refine(
  TicketExecutionCardShape,
  (card) => card.key === `turn:${card.turnId}:ticket:${card.ticketId}`,
);

const CheckpointCardShape = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  key: Type.String({ pattern: "^checkpoint:[1-9][0-9]*$" }),
  kind: Type.Literal("checkpoint"),
  turnId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  ticketId: Type.Integer({ minimum: 1 }),
  checkpointId: Type.Integer({ minimum: 1 }),
  ...CardTimestamps,
});
const CheckpointCardSchema = Type.Refine(
  CheckpointCardShape,
  (card) => card.key === `checkpoint:${card.checkpointId}`,
);

const ApprovalInterventionCardShape = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  key: Type.String({ pattern: "^intervention:approval:[1-9][0-9]*$" }),
  kind: Type.Literal("intervention"),
  turnId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  ticketId: Type.Integer({ minimum: 1 }),
  checkpointId: Type.Integer({ minimum: 1 }),
  interventionId: Type.String({ pattern: "^approval:[1-9][0-9]*$" }),
  ...CardTimestamps,
});
const ApprovalInterventionCardSchema = Type.Refine(
  ApprovalInterventionCardShape,
  (card) => card.key === `intervention:approval:${card.interventionId.slice("approval:".length)}`,
);

const DecisionInterventionCardShape = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  key: Type.String({ pattern: "^intervention:decision_request:[1-9][0-9]*$" }),
  kind: Type.Literal("intervention"),
  turnId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  ticketId: Type.Integer({ minimum: 1 }),
  checkpointId: Type.Integer({ minimum: 1 }),
  interventionId: Type.String({ pattern: "^decision:[1-9][0-9]*$" }),
  ...CardTimestamps,
});
const DecisionInterventionCardSchema = Type.Refine(
  DecisionInterventionCardShape,
  (card) => card.key === `intervention:decision_request:${card.interventionId.slice("decision:".length)}`,
);

export const KernelConversationCardSchema = Type.Union([
  TicketExecutionCardSchema,
  CheckpointCardSchema,
  ApprovalInterventionCardSchema,
  DecisionInterventionCardSchema,
]);
export type KernelConversationCard = Static<typeof KernelConversationCardSchema>;

export const KernelConversationCardKeySchema = Type.Union([
  Type.String({ pattern: "^turn:.+:ticket:[1-9][0-9]*$" }),
  Type.String({ pattern: "^checkpoint:[1-9][0-9]*$" }),
  Type.String({ pattern: "^intervention:(?:approval|decision_request):[1-9][0-9]*$" }),
]);

const ConversationCardQueryFilters = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  ticket_id: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 200 })),
  key: Type.Optional(Type.Array(KernelConversationCardKeySchema, { maxItems: 200 })),
};

export const KernelConversationCardListQuerySchema = Type.Union([
  StrictObject(ConversationCardQueryFilters),
  StrictObject({
    ...ConversationCardQueryFilters,
    after_id: Type.Integer({ minimum: 0 }),
  }),
  StrictObject({
    ...ConversationCardQueryFilters,
    before_id: Type.Integer({ minimum: 1 }),
  }),
]);
export type KernelConversationCardListQuery = Static<typeof KernelConversationCardListQuerySchema>;

const KernelConversationCardListResponseShape = StrictObject({
  items: Type.Array(KernelConversationCardSchema, { maxItems: 200 }),
  checkpoints: Type.Array(KernelCheckpointSchema),
  interventionRefs: Type.Array(KernelInterventionRefSchema),
  hasMore: Type.Boolean(),
  nextBeforeId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export const KernelConversationCardListResponseSchema = Type.Refine(
  KernelConversationCardListResponseShape,
  (response) => {
    const ascending = response.items.every((item, index) =>
      index === 0 || response.items[index - 1]!.id < item.id);
    if (!ascending) return false;
    if (response.nextBeforeId !== null
      && (response.items.length === 0 || response.nextBeforeId !== response.items[0]!.id)) {
      return false;
    }

    const checkpoints = new Map(response.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const interventions = new Map(response.interventionRefs.map((ref) => [ref.id, ref]));
    return response.items.every((card) => {
      if (card.kind === "ticket_execution") return true;
      const checkpoint = checkpoints.get(card.checkpointId);
      if (!checkpoint || checkpoint.ticketId !== card.ticketId) return false;
      if (card.kind === "checkpoint") return true;
      const intervention = interventions.get(card.interventionId);
      if (!intervention || intervention.ticketId !== card.ticketId || !checkpoint.actionRef) return false;
      const expectedInterventionId = checkpoint.actionRef.type === "approval"
        ? `approval:${checkpoint.actionRef.id}`
        : `decision:${checkpoint.actionRef.id}`;
      return expectedInterventionId === card.interventionId;
    });
  },
);
export type KernelConversationCardListResponse = Static<typeof KernelConversationCardListResponseSchema>;
