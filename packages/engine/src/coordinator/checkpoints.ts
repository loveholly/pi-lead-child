import type { GatewayEventType, Scope } from "@pi-lead-child/protocol";
import { addActivity } from "@pi-lead-child/store";
import {
  insertCheckpointWithResult,
  type InsertCheckpointInput,
  type InsertCheckpointResult,
} from "@pi-lead-child/store";
import { ensureCheckpointCard } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { commitStagedArtifacts, type StagedArtifact } from "@pi-lead-child/store";
import { itemUpdatedEvent, publishGatewayEvents } from "@pi-lead-child/store";
import type {
  ActivityKind,
  CheckpointKind,
  CheckpointProgress,
  CheckpointProofItem,
} from "@pi-lead-child/core";

export interface SubmitCheckpointInput {
  itemId: number;
  runId: number;
  kind: CheckpointKind;
  stage?: string | null;
  title: string;
  summary: string;
  keyFacts?: Array<{ label: string; value: string }>;
  artifactRefs?: string[];
  relatedItemIds?: number[];
  nextStep?: string | null;
  progress?: CheckpointProgress | null;
  proofItems?: CheckpointProofItem[];
  stagedArtifacts?: StagedArtifact[];
  publishItemUpdated?: boolean;
  idempotencyKey?: string;
}

export interface SystemCheckpointInput {
  itemId: number;
  runId?: number | null;
  kind: CheckpointKind;
  stage?: string | null;
  title: string;
  summary: string;
  keyFacts?: Array<{ label: string; value: string }>;
  artifactRefs?: string[];
  relatedItemIds?: number[];
  nextStep?: string | null;
  progress?: CheckpointProgress | null;
  proofItems?: CheckpointProofItem[];
  actionRef?: { type: "approval" | "decision_request"; id: number } | null;
  idempotencyKey: string;
  leadVisible?: boolean;
  precedingEvents?: Array<{
    type: GatewayEventType;
    requiredScope: Scope;
    itemId?: number;
    payload: Record<string, unknown>;
  }>;
  stagedArtifacts?: StagedArtifact[];
}

export interface CheckpointDomainService {
  submitCheckpoint(input: SubmitCheckpointInput): InsertCheckpointResult;
  recordSystemCheckpoint(input: SystemCheckpointInput): InsertCheckpointResult;
}

function activityKind(kind: CheckpointKind): ActivityKind {
  if (kind === "decision") return "decision";
  if (kind === "blocked") return "notification";
  return "milestone";
}

function touchItem(db: Db, itemId: number, now: Date): void {
  const result = db.prepare(
    `UPDATE items SET last_activity_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now.toISOString(), now.toISOString(), itemId);
  if (result.changes !== 1) throw new Error(`item ${itemId} not found`);
}

function checkpointActivity(
  db: Db,
  checkpoint: InsertCheckpointResult["checkpoint"],
): void {
  addActivity(db, {
    itemId: checkpoint.itemId,
    runId: checkpoint.runId ?? undefined,
    actor: checkpoint.source === "agent_reported" ? "child" : "system",
    kind: activityKind(checkpoint.kind),
    payload: {
      checkpointId: checkpoint.id,
      kind: checkpoint.kind,
      title: checkpoint.title,
      summary: checkpoint.summary,
    },
  });
}

export function createCheckpointDomainService(args: {
  db: Db;
  now?: () => Date;
}): CheckpointDomainService {
  const { db } = args;
  const now = args.now ?? (() => new Date());

  return {
    submitCheckpoint(input): InsertCheckpointResult {
      const write = () => {
        const at = now();
        const {
          stagedArtifacts = [],
          publishItemUpdated = true,
          ...checkpointInput
        } = input;
        const result = insertCheckpointWithResult(db, {
          ...checkpointInput,
          source: "agent_reported",
          actionRef: null,
          idempotencyKey: input.idempotencyKey ?? null,
        }, { now: at });
        if (stagedArtifacts.length > 0) {
          commitStagedArtifacts(db, result.checkpoint.id, stagedArtifacts);
        }
        if (result.deduplicated) return result;
        checkpointActivity(db, result.checkpoint);
        touchItem(db, input.itemId, at);
        const item = db.prepare("SELECT parent_item_id FROM items WHERE id=?")
          .get(input.itemId) as { parent_item_id: number | null };
        if (input.kind === "completed" && item.parent_item_id === null) {
          ensureCheckpointCard(db, {
            itemId: input.itemId,
            checkpointId: result.checkpoint.id,
            now: at,
          });
        }
        if (publishItemUpdated) {
          publishGatewayEvents(db, [itemUpdatedEvent(input.itemId, at)]);
        }
        return result;
      };
      return db.inTransaction ? write() : db.transaction(write).immediate();
    },

    recordSystemCheckpoint(input): InsertCheckpointResult {
      const write = () => {
        const at = now();
        const checkpointInput: InsertCheckpointInput = {
          itemId: input.itemId,
          runId: input.runId ?? null,
          source: "system_derived",
          kind: input.kind,
          stage: input.stage,
          title: input.title,
          summary: input.summary,
          keyFacts: input.keyFacts,
          artifactRefs: input.artifactRefs,
          relatedItemIds: input.relatedItemIds,
          nextStep: input.nextStep,
          actionRef: input.actionRef,
          progress: input.progress,
          proofItems: input.proofItems,
          idempotencyKey: input.idempotencyKey,
        };
        const result = insertCheckpointWithResult(db, checkpointInput, { now: at });
        if (input.stagedArtifacts?.length) {
          commitStagedArtifacts(db, result.checkpoint.id, input.stagedArtifacts);
        }
        if (result.deduplicated) return result;
        checkpointActivity(db, result.checkpoint);
        touchItem(db, input.itemId, at);
        if (input.leadVisible) {
          ensureCheckpointCard(db, {
            itemId: input.itemId,
            checkpointId: result.checkpoint.id,
            now: at,
          });
        }
        publishGatewayEvents(db, [
          ...(input.precedingEvents ?? []).map((event) => ({ ...event, now: at })),
          itemUpdatedEvent(input.itemId, at),
        ]);
        return result;
      };
      return db.inTransaction ? write() : db.transaction(write).immediate();
    },
  };
}
