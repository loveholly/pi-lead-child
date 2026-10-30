import type { KernelInterventionRef } from "@pi-lead-child/protocol";
import { getApproval, leadDisplayName } from "@pi-lead-child/store";
import { getCheckpoint } from "@pi-lead-child/store";
import {
  ensureCheckpointCard,
  ensureInterventionCard,
  getConversationCardByKey,
} from "@pi-lead-child/store";
import { getDecisionRequest } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import type { Checkpoint, ConversationCard } from "@pi-lead-child/core";

export interface ConversationCardSourceProjection {
  sourceLine: string;
  itemId: number;
  runId: number | null;
  agent: {
    kind: Checkpoint["author"]["kind"];
    runtime: Checkpoint["author"]["runtime"];
    label: string;
  } | null;
}

export interface ConversationCardDisplayProjection {
  card: ConversationCard;
  checkpoint: Checkpoint | null;
  source: ConversationCardSourceProjection;
  interventionRef: KernelInterventionRef | null;
}

function requiredCheckpoint(db: Db, checkpointId: number): Checkpoint {
  const checkpoint = getCheckpoint(db, checkpointId);
  if (!checkpoint) throw new Error(`checkpoint ${checkpointId} not found`);
  return checkpoint;
}

export function projectCheckpointConversationCard(
  db: Db,
  input: { checkpointId: number; turnId?: string | null; now?: Date },
): Extract<ConversationCard, { kind: "checkpoint" }> {
  const checkpoint = requiredCheckpoint(db, input.checkpointId);
  return ensureCheckpointCard(db, {
    itemId: checkpoint.itemId,
    checkpointId: checkpoint.id,
    turnId: input.turnId,
    now: input.now,
  });
}

export function projectInterventionConversationCard(
  db: Db,
  input: { checkpointId: number; turnId?: string | null; now?: Date },
): Extract<ConversationCard, { kind: "intervention" }> {
  const checkpoint = requiredCheckpoint(db, input.checkpointId);
  if (!checkpoint.actionRef) throw new Error("intervention card requires checkpoint action context");
  return ensureInterventionCard(db, {
    itemId: checkpoint.itemId,
    checkpointId: checkpoint.id,
    actionType: checkpoint.actionRef.type,
    actionId: checkpoint.actionRef.id,
    turnId: input.turnId,
    now: input.now,
  });
}

export function projectLeadConversationCardForCheckpoint(
  db: Db,
  input: { checkpointId: number; turnId?: string | null; now?: Date },
): Extract<ConversationCard, { kind: "checkpoint" | "intervention" }> {
  const checkpoint = requiredCheckpoint(db, input.checkpointId);
  return checkpoint.actionRef
    ? projectInterventionConversationCard(db, input)
    : projectCheckpointConversationCard(db, input);
}

function interventionRef(
  db: Db,
  card: Extract<ConversationCard, { kind: "intervention" }>,
): KernelInterventionRef {
  if (card.actionType === "approval") {
    const approval = getApproval(db, card.actionId);
    if (!approval || approval.item_id !== card.itemId) {
      throw new Error(`approval ${card.actionId} does not match conversation card`);
    }
    return {
      id: `approval:${approval.id}`,
      ticketId: card.itemId,
      kind: "approval",
      state: approval.status,
      requiresAction: approval.status === "pending",
    };
  }
  const decision = getDecisionRequest(db, card.actionId);
  if (!decision || decision.itemId !== card.itemId) {
    throw new Error(`decision request ${card.actionId} does not match conversation card`);
  }
  return {
    id: `decision:${decision.id}`,
    ticketId: card.itemId,
    kind: decision.kind,
    state: decision.state,
    requiresAction: decision.state === "pending",
  };
}

function displayTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "--:--" : date.toISOString().slice(11, 16);
}

function checkpointSource(checkpoint: Checkpoint): ConversationCardSourceProjection {
  const system = checkpoint.author.kind === "system";
  const label = system
    ? "system"
    : checkpoint.runId === null
      ? "child"
      : `child #${checkpoint.runId}`;
  return {
    sourceLine: `来自 ${label} 的消息 · ${displayTime(checkpoint.createdAt)}`,
    itemId: checkpoint.itemId,
    runId: checkpoint.runId,
    agent: {
      kind: checkpoint.author.kind,
      runtime: checkpoint.author.runtime,
      label,
    },
  };
}

export function getConversationCardDisplayProjection(
  db: Db,
  key: string,
): ConversationCardDisplayProjection | undefined {
  const card = getConversationCardByKey(db, key);
  if (!card) return undefined;
  if (card.kind === "ticket_execution") {
    return {
      card,
      checkpoint: null,
      source: {
        sourceLine: `来自 ${leadDisplayName(db)} 的操作 · ${displayTime(card.createdAt)}`,
        itemId: card.itemId,
        runId: null,
        agent: null,
      },
      interventionRef: null,
    };
  }
  const checkpoint = requiredCheckpoint(db, card.checkpointId);
  return {
    card,
    checkpoint,
    source: checkpointSource(checkpoint),
    interventionRef: card.kind === "intervention" ? interventionRef(db, card) : null,
  };
}
