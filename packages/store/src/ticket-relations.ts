import type { Db } from "./db.js";
import { addActivity } from "./activities.js";
import type { Actor, Item, ItemKind, ItemStage } from "@pi-lead-child/core";
import { resolveWorkspace } from "./workspaces.js";

interface RepositoryScope {
  id: number;
  project_id: number;
  repo_root: string;
  repo_name: string;
  remote_url: string | null;
}

export const TICKET_RELATION_INPUT_TYPES = [
  "parent_of", "child_of",
  "depends_on", "blocks",
  "implements", "implemented_by",
  "duplicates", "duplicated_by",
  "supersedes", "superseded_by",
  "relates_to",
] as const;

export type TicketRelationInputType = typeof TICKET_RELATION_INPUT_TYPES[number];

export const TICKET_RELATION_STORED_TYPES = [
  "depends_on", "implements", "duplicates", "supersedes", "relates_to",
] as const;

export type TicketRelationStoredType = typeof TICKET_RELATION_STORED_TYPES[number];

export type TicketRelationSemanticType = TicketRelationInputType;
export const TICKET_RELATION_EXECUTION_GATES = ["none", "target_done"] as const;
export type TicketRelationExecutionGate = typeof TICKET_RELATION_EXECUTION_GATES[number];

export interface TicketRelationRow {
  id: number;
  source_item_id: number;
  target_item_id: number;
  relation_type: TicketRelationStoredType;
  execution_gate: TicketRelationExecutionGate;
  created_by: Actor;
  created_by_run_id: number | null;
  reason: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: Actor | null;
  revoke_reason: string | null;
}

export interface TicketRelationView {
  relationId: number | null;
  itemId: number;
  relatedItemId: number;
  relationType: TicketRelationSemanticType;
  executionGate: TicketRelationExecutionGate | null;
  direction: "outgoing" | "incoming" | "tree";
  factSource: "ticket_relations" | "tree";
  sourceItemId: number;
  targetItemId: number;
  active: boolean;
  createdBy: Actor | null;
  createdByRunId: number | null;
  createdAt: string | null;
  reason: string | null;
  revokedAt: string | null;
  revokedBy: Actor | null;
  revokeReason: string | null;
}

export interface BlockingTicket {
  id: number;
  title: string;
  stage: ItemStage;
  gate: "depends_on" | "implementation_target_done";
}

export interface LinkTicketResult {
  status: "created" | "existing";
  relation: TicketRelationRow;
  requestedRelationType: TicketRelationInputType;
  risks: string[];
  schedulingImpact: string | null;
  canonicalImpact: string | null;
}

export interface RevokeTicketRelationResult {
  status: "revoked" | "already_revoked";
  relation: TicketRelationRow;
}

type NormalizedRelation = {
  sourceItemId: number;
  targetItemId: number;
  storedType: TicketRelationStoredType;
};

const INPUT_TYPES = new Set<TicketRelationInputType>(TICKET_RELATION_INPUT_TYPES);
const STORED_TYPES = new Set<TicketRelationStoredType>(TICKET_RELATION_STORED_TYPES);
const STATEFUL_RELATIONS = new Set<TicketRelationStoredType>([
  "depends_on", "duplicates", "supersedes",
]);
const TASK_ONLY_RELATIONS = new Set<TicketRelationStoredType>([
  "depends_on", "implements", "duplicates", "supersedes",
]);

const INVERSE_RELATION: Record<TicketRelationStoredType, TicketRelationSemanticType> = {
  depends_on: "blocks",
  implements: "implemented_by",
  duplicates: "duplicated_by",
  supersedes: "superseded_by",
  relates_to: "relates_to",
};

export function isTicketRelationInputType(value: string): value is TicketRelationInputType {
  return INPUT_TYPES.has(value as TicketRelationInputType);
}

export function isStoredTicketRelationType(value: string): value is TicketRelationStoredType {
  return STORED_TYPES.has(value as TicketRelationStoredType);
}

function normalizeInputRelation(
  sourceItemId: number,
  targetItemId: number,
  relationType: TicketRelationInputType,
): NormalizedRelation {
  switch (relationType) {
    case "depends_on":
    case "implements":
    case "duplicates":
    case "supersedes":
    case "relates_to":
      return { sourceItemId, targetItemId, storedType: relationType };
    case "blocks":
      return { sourceItemId: targetItemId, targetItemId: sourceItemId, storedType: "depends_on" };
    case "implemented_by":
      return { sourceItemId: targetItemId, targetItemId: sourceItemId, storedType: "implements" };
    case "duplicated_by":
      return { sourceItemId: targetItemId, targetItemId: sourceItemId, storedType: "duplicates" };
    case "superseded_by":
      return { sourceItemId: targetItemId, targetItemId: sourceItemId, storedType: "supersedes" };
    case "parent_of":
    case "child_of":
      throw new Error(
        `${relationType} is owned by the existing task tree, not ticket_relations; `
        + "create subtasks with parent_ticket_id instead of writing a second parent fact",
      );
  }
}

function item(db: Db, id: number, label: "source" | "target"): Item {
  const row = db.prepare("SELECT * FROM items WHERE id=?").get(id) as Item | undefined;
  if (!row) throw new Error(`${label} item #${id} not found`);
  if (row.stage === "cancelled") throw new Error(`${label} item #${id} is cancelled`);
  return row;
}

function activeExactRelation(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
  storedType: TicketRelationStoredType,
): TicketRelationRow | undefined {
  return db.prepare(
    `SELECT * FROM ticket_relations
     WHERE source_item_id=? AND target_item_id=? AND relation_type=? AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(sourceItemId, targetItemId, storedType) as TicketRelationRow | undefined;
}

function activeRelatesToEitherDirection(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
): TicketRelationRow | undefined {
  return db.prepare(
    `SELECT * FROM ticket_relations
     WHERE relation_type='relates_to' AND revoked_at IS NULL
       AND (
         (source_item_id=? AND target_item_id=?)
         OR (source_item_id=? AND target_item_id=?)
       )
     ORDER BY id LIMIT 1`,
  ).get(sourceItemId, targetItemId, targetItemId, sourceItemId) as TicketRelationRow | undefined;
}

function relationRisks(
  db: Db,
  source: Item,
  target: Item,
  storedType: TicketRelationStoredType,
  executionGate: TicketRelationExecutionGate,
): string[] {
  const risks: string[] = [];
  if (source.project_id !== null && target.project_id !== null && source.project_id !== target.project_id) {
    risks.push(`cross_project: #${source.id} project_id=${source.project_id}, #${target.id} project_id=${target.project_id}`);
  } else if (source.project && target.project && source.project !== target.project) {
    risks.push(`cross_project: #${source.id} project=${source.project}, #${target.id} project=${target.project}`);
  }
  if (source.workdir && target.workdir && !sameOrNestedWorkdir(source.workdir, target.workdir)) {
    risks.push(`workdir_scope_mismatch: #${source.id} ${source.workdir} vs #${target.id} ${target.workdir}`);
  }
  const sourceWorkspace = resolveWorkspace(db, source.id)?.workspace;
  const targetWorkspace = resolveWorkspace(db, target.id)?.workspace;
  if (sourceWorkspace && targetWorkspace && sourceWorkspace.id === targetWorkspace.id) {
    const active = (db.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND item_id IN (?, ?) AND state IN ('starting','running','paused')",
    ).get(sourceWorkspace.id, source.id, target.id) as { n: number }).n;
    if (active > 0) risks.push(`workspace_concurrency_risk: workspace #${sourceWorkspace.id} is shared by #${source.id} and #${target.id}`);
  }
  const sourceRepository = repositoryScope(db, source);
  const targetRepository = repositoryScope(db, target);
  if (sourceRepository && targetRepository && sourceRepository.id !== targetRepository.id) {
    risks.push(
      `repository_scope_mismatch: #${source.id} ${sourceRepository.repo_name}@${sourceRepository.repo_root} `
      + `vs #${target.id} ${targetRepository.repo_name}@${targetRepository.repo_root}`,
    );
  } else if ((sourceRepository && target.workdir && !targetRepository)
      || (targetRepository && source.workdir && !sourceRepository)) {
    risks.push(
      `repository_scope_unknown: #${source.id} repo=${sourceRepository?.repo_name ?? "unmatched"}; `
      + `#${target.id} repo=${targetRepository?.repo_name ?? "unmatched"}`,
    );
  }
  if (source.project_id !== null && sourceRepository && source.project_id !== sourceRepository.project_id) {
    risks.push(
      `repository_project_mismatch: #${source.id} project_id=${source.project_id} `
      + `but workdir maps to project_id=${sourceRepository.project_id}`,
    );
  }
  if (target.project_id !== null && targetRepository && target.project_id !== targetRepository.project_id) {
    risks.push(
      `repository_project_mismatch: #${target.id} project_id=${target.project_id} `
      + `but workdir maps to project_id=${targetRepository.project_id}`,
    );
  }
  if (source.purpose !== target.purpose && storedType !== "relates_to") {
    risks.push(
      `purpose_mismatch: #${source.id} purpose=${source.purpose ?? "none"}, `
      + `#${target.id} purpose=${target.purpose ?? "none"}`,
    );
  }
  if (storedType === "depends_on") {
    risks.push(`scheduling: #${source.id} cannot be dispatched until #${target.id} is done or this relation is revoked`);
  }
  if (storedType === "implements" && executionGate === "target_done") {
    risks.push(`scheduling: #${source.id} implementation waits until #${target.id} is accepted/done`);
  }
  if (storedType === "duplicates") {
    risks.push(`canonical: #${target.id} is the canonical ticket; #${source.id} remains separate history`);
  }
  if (storedType === "supersedes") {
    risks.push(`effective_ticket: #${source.id} formally replaces #${target.id}; the old ticket is not deleted`);
  }
  return risks;
}

function repositoryScope(db: Db, item: Item): RepositoryScope | null {
  if (!item.workdir) return null;
  const rows = db.prepare(
    `SELECT id, project_id, repo_root, repo_name, remote_url
     FROM project_repositories
     ORDER BY length(repo_root) DESC, id`,
  ).all() as RepositoryScope[];
  return rows.find((row) => workdirWithinRepository(item.workdir!, row.repo_root)) ?? null;
}

function workdirWithinRepository(workdir: string, repoRoot: string): boolean {
  const repo = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return workdir === repoRoot || workdir.startsWith(repo);
}

function sameOrNestedWorkdir(left: string, right: string): boolean {
  const normalizedLeft = left.endsWith("/") ? left : `${left}/`;
  const normalizedRight = right.endsWith("/") ? right : `${right}/`;
  return left === right || normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function assertTaskOnlyRelation(
  storedType: TicketRelationStoredType,
  sourceKind: ItemKind,
  targetKind: ItemKind,
): void {
  if (!TASK_ONLY_RELATIONS.has(storedType)) return;
  if (sourceKind !== "task" || targetKind !== "task") {
    throw new Error(`${storedType} requires task tickets on both sides`);
  }
}

function assertPurposeCompatibility(
  storedType: TicketRelationStoredType,
  source: Item,
  target: Item,
): void {
  if (!TASK_ONLY_RELATIONS.has(storedType)) return;
  if (storedType === "implements" && source.purpose !== "execution" && source.purpose !== "integration") {
    throw new Error(
      `implements requires an execution or integration source ticket; `
      + `#${source.id} purpose is ${source.purpose ?? "none"}`,
    );
  }
  if (storedType === "depends_on" && source.purpose === "review") {
    throw new Error(
      `depends_on gates executor dispatch; review-purpose ticket #${source.id} should use review workflow gating`,
    );
  }
  if ((storedType === "duplicates" || storedType === "supersedes")
      && source.purpose !== target.purpose) {
    throw new Error(
      `${storedType} requires matching ticket purpose; `
      + `#${source.id} is ${source.purpose ?? "none"} and #${target.id} is ${target.purpose ?? "none"}`,
    );
  }
}

function assertNoDependencyCycle(db: Db, sourceItemId: number, targetItemId: number): void {
  const cycle = db.prepare(
    `WITH RECURSIVE reachable(id) AS (
       SELECT target_item_id FROM ticket_relations
        WHERE source_item_id=? AND revoked_at IS NULL
          AND (relation_type='depends_on' OR (relation_type='implements' AND execution_gate='target_done'))
       UNION
       SELECT r.target_item_id
         FROM ticket_relations r JOIN reachable ON r.source_item_id=reachable.id
        WHERE r.revoked_at IS NULL
          AND (r.relation_type='depends_on' OR (r.relation_type='implements' AND r.execution_gate='target_done'))
     )
     SELECT 1 FROM reachable WHERE id=? LIMIT 1`,
  ).get(targetItemId, sourceItemId);
  if (cycle) throw new Error(`depends_on cycle detected: #${sourceItemId} already blocks or depends on #${targetItemId}`);
}

function assertNoImplementationDependencyOverlap(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
  storedType: TicketRelationStoredType,
): void {
  if (storedType !== "implements" && storedType !== "depends_on") return;
  const conflictingType = storedType === "implements" ? "depends_on" : "implements";
  const conflict = activeExactRelation(db, sourceItemId, targetItemId, conflictingType);
  if (!conflict) return;
  throw new Error(
    `#${sourceItemId} and #${targetItemId} already have active ${conflictingType} relation #${conflict.id}; `
    + "use one implements relation with execution_gate='target_done' when implementation must wait for acceptance",
  );
}

function assertDuplicateCanonical(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
): void {
  const existingCanonical = db.prepare(
    `SELECT target_item_id FROM ticket_relations
     WHERE source_item_id=? AND relation_type='duplicates' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(sourceItemId) as { target_item_id: number } | undefined;
  if (existingCanonical && existingCanonical.target_item_id !== targetItemId) {
    throw new Error(
      `duplicate source #${sourceItemId} already points at canonical #${existingCanonical.target_item_id}; `
      + "revoke that relation before choosing a different canonical",
    );
  }
  const sourceCanonical = db.prepare(
    `SELECT source_item_id FROM ticket_relations
     WHERE target_item_id=? AND relation_type='duplicates' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(sourceItemId) as { source_item_id: number } | undefined;
  if (sourceCanonical) {
    throw new Error(
      `duplicate source #${sourceItemId} is already canonical for #${sourceCanonical.source_item_id}; `
      + "a canonical ticket cannot itself duplicate another ticket",
    );
  }
  const targetCanonical = db.prepare(
    `SELECT target_item_id FROM ticket_relations
     WHERE source_item_id=? AND relation_type='duplicates' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(targetItemId) as { target_item_id: number } | undefined;
  if (targetCanonical) {
    throw new Error(
      `duplicate target #${targetItemId} is itself a duplicate of canonical #${targetCanonical.target_item_id}; `
      + "link to the canonical ticket directly",
    );
  }
}

function assertSupersedesConstraints(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
): void {
  const sourceObsolete = db.prepare(
    `SELECT source_item_id FROM ticket_relations
     WHERE target_item_id=? AND relation_type='supersedes' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(sourceItemId) as { source_item_id: number } | undefined;
  if (sourceObsolete) {
    throw new Error(
      `superseding ticket #${sourceItemId} is already superseded by #${sourceObsolete.source_item_id}`,
    );
  }
  const cycle = db.prepare(
    `WITH RECURSIVE older(id) AS (
       SELECT target_item_id FROM ticket_relations
        WHERE source_item_id=? AND relation_type='supersedes' AND revoked_at IS NULL
       UNION
       SELECT r.target_item_id
         FROM ticket_relations r JOIN older ON r.source_item_id=older.id
        WHERE r.relation_type='supersedes' AND r.revoked_at IS NULL
     )
     SELECT 1 FROM older WHERE id=? LIMIT 1`,
  ).get(targetItemId, sourceItemId);
  if (cycle) throw new Error(`supersedes cycle detected between #${sourceItemId} and #${targetItemId}`);
}

function assertNoHighImpactPairConflict(
  db: Db,
  sourceItemId: number,
  targetItemId: number,
  storedType: TicketRelationStoredType,
): void {
  if (storedType !== "duplicates" && storedType !== "supersedes") return;
  const conflict = db.prepare(
    `SELECT id, source_item_id, target_item_id, relation_type FROM ticket_relations
     WHERE revoked_at IS NULL
       AND relation_type IN ('duplicates','supersedes')
       AND (
         (source_item_id=? AND target_item_id=?)
         OR (source_item_id=? AND target_item_id=?)
       )
       AND NOT (source_item_id=? AND target_item_id=? AND relation_type=?)
     ORDER BY id LIMIT 1`,
  ).get(
    sourceItemId, targetItemId,
    targetItemId, sourceItemId,
    sourceItemId, targetItemId, storedType,
  ) as {
    id: number; source_item_id: number; target_item_id: number; relation_type: string;
  } | undefined;
  if (conflict) {
    throw new Error(
      `relation conflicts with active ${conflict.relation_type} #${conflict.id} `
      + `(#${conflict.source_item_id} -> #${conflict.target_item_id})`,
    );
  }
}

function auditRelation(
  db: Db,
  relation: TicketRelationRow,
  actor: Actor,
  decision: "link_ticket_relation" | "revoke_ticket_relation",
  payload: Record<string, unknown>,
): void {
  const base = {
    decision,
    relationId: relation.id,
    relationType: relation.relation_type,
    sourceTicketId: relation.source_item_id,
    targetTicketId: relation.target_item_id,
    ...payload,
  };
  for (const itemId of [...new Set([relation.source_item_id, relation.target_item_id])]) {
    addActivity(db, {
      itemId,
      actor,
      kind: "decision",
      payload: { ...base, itemPerspective: itemId === relation.source_item_id ? "source" : "target" },
    });
  }
}

function readRelation(db: Db, relationId: number): TicketRelationRow | undefined {
  return db.prepare("SELECT * FROM ticket_relations WHERE id=?")
    .get(relationId) as TicketRelationRow | undefined;
}

export function linkTickets(
  db: Db,
  input: {
    sourceTicketId: number;
    targetTicketId: number;
    relationType: TicketRelationInputType;
    executionGate?: TicketRelationExecutionGate;
    reason: string;
    actor: Actor;
    runId?: number;
  },
): LinkTicketResult {
  if (!Number.isSafeInteger(input.sourceTicketId) || input.sourceTicketId < 1) {
    throw new Error("source_ticket_id must be a positive integer");
  }
  if (!Number.isSafeInteger(input.targetTicketId) || input.targetTicketId < 1) {
    throw new Error("target_ticket_id must be a positive integer");
  }
  if (!INPUT_TYPES.has(input.relationType)) throw new Error(`invalid relation_type: ${input.relationType}`);
  const reason = input.reason.trim();
  if (!reason) throw new Error("reason is required to create a ticket relation");
  if (input.sourceTicketId === input.targetTicketId) {
    throw new Error("cannot link a ticket to itself");
  }

  const normalized = normalizeInputRelation(
    input.sourceTicketId,
    input.targetTicketId,
    input.relationType,
  );
  const executionGate = input.executionGate ?? "none";
  if (!TICKET_RELATION_EXECUTION_GATES.includes(executionGate)) {
    throw new Error(`invalid execution_gate: ${executionGate}`);
  }
  if (executionGate !== "none" && normalized.storedType !== "implements") {
    throw new Error("execution_gate is only supported on implements relations");
  }

  return db.transaction((): LinkTicketResult => {
    const inputSource = item(db, input.sourceTicketId, "source");
    const inputTarget = item(db, input.targetTicketId, "target");
    const source = normalized.sourceItemId === inputSource.id ? inputSource : inputTarget;
    const target = normalized.targetItemId === inputTarget.id ? inputTarget : inputSource;
    assertTaskOnlyRelation(normalized.storedType, source.kind, target.kind);
    assertPurposeCompatibility(normalized.storedType, source, target);

    const risks = relationRisks(db, source, target, normalized.storedType, executionGate);
    if (STATEFUL_RELATIONS.has(normalized.storedType)
        && risks.some((risk) => risk.startsWith("cross_project")
          || risk.startsWith("workdir_scope_mismatch")
          || risk.startsWith("repository_scope_mismatch")
          || risk.startsWith("repository_scope_unknown")
          || risk.startsWith("repository_project_mismatch"))
        && !reason) {
      throw new Error("cross-project, cross-workdir, or cross-repository stateful relations require an explicit reason");
    }

    const existing = normalized.storedType === "relates_to"
      ? activeRelatesToEitherDirection(db, normalized.sourceItemId, normalized.targetItemId)
      : activeExactRelation(db, normalized.sourceItemId, normalized.targetItemId, normalized.storedType);
    if (existing) {
      if (existing.execution_gate !== executionGate) {
        throw new Error(
          `active ${existing.relation_type} relation #${existing.id} already uses execution_gate=${existing.execution_gate}; `
          + "revoke it before changing the gate",
        );
      }
      return {
        status: "existing",
        relation: existing,
        requestedRelationType: input.relationType,
        risks,
        schedulingImpact: schedulingImpact(existing),
        canonicalImpact: canonicalImpact(existing),
      };
    }

    assertNoImplementationDependencyOverlap(
      db, normalized.sourceItemId, normalized.targetItemId, normalized.storedType,
    );

    if (normalized.storedType === "depends_on"
        || (normalized.storedType === "implements" && executionGate === "target_done")) {
      assertNoDependencyCycle(db, normalized.sourceItemId, normalized.targetItemId);
    }
    if (normalized.storedType === "duplicates") {
      assertDuplicateCanonical(db, normalized.sourceItemId, normalized.targetItemId);
    }
    if (normalized.storedType === "supersedes") {
      assertSupersedesConstraints(db, normalized.sourceItemId, normalized.targetItemId);
    }
    assertNoHighImpactPairConflict(
      db,
      normalized.sourceItemId,
      normalized.targetItemId,
      normalized.storedType,
    );

    const result = db.prepare(
      `INSERT INTO ticket_relations (
         source_item_id, target_item_id, relation_type, execution_gate,
         created_by, created_by_run_id, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      normalized.sourceItemId,
      normalized.targetItemId,
      normalized.storedType,
      executionGate,
      input.actor,
      input.runId ?? null,
      reason,
    );
    const relation = readRelation(db, Number(result.lastInsertRowid));
    if (!relation) throw new Error("failed to read created ticket relation");
    auditRelation(db, relation, input.actor, "link_ticket_relation", {
      requestedRelationType: input.relationType,
      executionGate,
      reason,
      risks,
      schedulingImpact: schedulingImpact(relation),
      canonicalImpact: canonicalImpact(relation),
    });
    return {
      status: "created",
      relation,
      requestedRelationType: input.relationType,
      risks,
      schedulingImpact: schedulingImpact(relation),
      canonicalImpact: canonicalImpact(relation),
    };
  }).immediate();
}

export function revokeTicketRelation(
  db: Db,
  input: { relationId: number; reason: string; actor: Actor },
): RevokeTicketRelationResult {
  if (!Number.isSafeInteger(input.relationId) || input.relationId < 1) {
    throw new Error("relation_id must be a positive integer");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("reason is required to revoke a ticket relation");
  return db.transaction((): RevokeTicketRelationResult => {
    const existing = readRelation(db, input.relationId);
    if (!existing) throw new Error(`ticket relation #${input.relationId} not found`);
    if (existing.revoked_at !== null) return { status: "already_revoked", relation: existing };
    db.prepare(
      `UPDATE ticket_relations
       SET revoked_at=datetime('now'), revoked_by=?, revoke_reason=?
       WHERE id=? AND revoked_at IS NULL`,
    ).run(input.actor, reason, input.relationId);
    const relation = readRelation(db, input.relationId);
    if (!relation) throw new Error("failed to read revoked ticket relation");
    auditRelation(db, relation, input.actor, "revoke_ticket_relation", {
      reason,
      schedulingImpact: schedulingImpact(relation),
      canonicalImpact: canonicalImpact(relation),
    });
    return { status: "revoked", relation };
  }).immediate();
}

export function getTicketRelations(db: Db, itemId: number): TicketRelationView[] {
  const current = db.prepare("SELECT * FROM items WHERE id=?").get(itemId) as Item | undefined;
  if (!current) throw new Error(`item #${itemId} not found`);
  const views: TicketRelationView[] = [];
  if (current.parent_item_id !== null) {
    views.push({
      relationId: null,
      itemId,
      relatedItemId: current.parent_item_id,
      relationType: "child_of",
      executionGate: null,
      direction: "tree",
      factSource: "tree",
      sourceItemId: current.parent_item_id,
      targetItemId: itemId,
      active: true,
      createdBy: null,
      createdByRunId: null,
      createdAt: null,
      reason: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
  }
  const children = db.prepare(
    "SELECT id FROM items WHERE parent_item_id=? ORDER BY id",
  ).all(itemId) as Array<{ id: number }>;
  for (const child of children) {
    views.push({
      relationId: null,
      itemId,
      relatedItemId: child.id,
      relationType: "parent_of",
      executionGate: null,
      direction: "tree",
      factSource: "tree",
      sourceItemId: itemId,
      targetItemId: child.id,
      active: true,
      createdBy: null,
      createdByRunId: null,
      createdAt: null,
      reason: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
  }

  const rows = db.prepare(
    `SELECT * FROM ticket_relations
     WHERE source_item_id=? OR target_item_id=?
     ORDER BY revoked_at IS NOT NULL, created_at, id`,
  ).all(itemId, itemId) as TicketRelationRow[];
  for (const row of rows) {
    const outgoing = row.source_item_id === itemId;
    views.push({
      relationId: row.id,
      itemId,
      relatedItemId: outgoing ? row.target_item_id : row.source_item_id,
      relationType: outgoing ? row.relation_type : INVERSE_RELATION[row.relation_type],
      executionGate: row.execution_gate,
      direction: outgoing ? "outgoing" : "incoming",
      factSource: "ticket_relations",
      sourceItemId: row.source_item_id,
      targetItemId: row.target_item_id,
      active: row.revoked_at === null,
      createdBy: row.created_by,
      createdByRunId: row.created_by_run_id,
      createdAt: row.created_at,
      reason: row.reason,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokeReason: row.revoke_reason,
    });
  }
  return views;
}

export function listBlockingDependencies(db: Db, itemId: number): BlockingTicket[] {
  return db.prepare(
    `SELECT blocker.id, blocker.title, blocker.stage,
            CASE WHEN relation.relation_type='depends_on'
                 THEN 'depends_on' ELSE 'implementation_target_done' END AS gate
     FROM ticket_relations relation
     JOIN items blocker ON blocker.id=relation.target_item_id
     WHERE relation.source_item_id=?
       AND (
         relation.relation_type='depends_on'
         OR (relation.relation_type='implements' AND relation.execution_gate='target_done')
       )
       AND relation.revoked_at IS NULL
       AND blocker.stage <> 'done'
     ORDER BY blocker.id`,
  ).all(itemId) as BlockingTicket[];
}

export function assertTicketRelationsAllowRun(db: Db, itemId: number): void {
  const blockers = listBlockingDependencies(db, itemId);
  if (!blockers.length) return;
  const detail = blockers.map((blocker) => `#${blocker.id} [${blocker.stage}] ${blocker.title}`).join(", ");
  throw new Error(
    `item #${itemId} is blocked by execution gate(s): ${detail}; `
    + "the blocker ticket must be done or the relation must be revoked",
  );
}

export function canonicalDuplicateOf(db: Db, itemId: number): number | null {
  const row = db.prepare(
    `SELECT target_item_id FROM ticket_relations
     WHERE source_item_id=? AND relation_type='duplicates' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(itemId) as { target_item_id: number } | undefined;
  return row?.target_item_id ?? null;
}

export function duplicateSourcesFor(db: Db, canonicalItemId: number): number[] {
  return (db.prepare(
    `SELECT source_item_id FROM ticket_relations
     WHERE target_item_id=? AND relation_type='duplicates' AND revoked_at IS NULL
     ORDER BY source_item_id`,
  ).all(canonicalItemId) as Array<{ source_item_id: number }>)
    .map((row) => row.source_item_id);
}

export function supersededBy(db: Db, itemId: number): number | null {
  const row = db.prepare(
    `SELECT source_item_id FROM ticket_relations
     WHERE target_item_id=? AND relation_type='supersedes' AND revoked_at IS NULL
     ORDER BY id LIMIT 1`,
  ).get(itemId) as { source_item_id: number } | undefined;
  return row?.source_item_id ?? null;
}

function schedulingImpact(relation: TicketRelationRow): string | null {
  if (relation.revoked_at !== null) return null;
  if (relation.relation_type === "depends_on") {
    return `#${relation.source_item_id} blocked until #${relation.target_item_id} is done`;
  }
  if (relation.relation_type === "implements" && relation.execution_gate === "target_done") {
    return `#${relation.source_item_id} waits for #${relation.target_item_id} design acceptance`;
  }
  return null;
}

function canonicalImpact(relation: TicketRelationRow): string | null {
  if (relation.revoked_at !== null) return null;
  if (relation.relation_type === "duplicates") {
    return `#${relation.target_item_id} is canonical for duplicate #${relation.source_item_id}`;
  }
  if (relation.relation_type === "supersedes") {
    return `#${relation.source_item_id} supersedes #${relation.target_item_id}`;
  }
  return null;
}
