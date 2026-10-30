import type { Db } from "./db.js";
import { enqueueContinuationEvent } from "./continuations.js";

export interface LearningCandidate {
  id: number;
  project_id: number | null;
  scope_key: string;
  item_id: number | null;
  run_id: number | null;
  fingerprint: string;
  kind: string;
  summary: string;
  evidence: string;
  occurrence_count: number;
  confidence: number;
  status: "candidate" | "drafted" | "promoted" | "dismissed";
  created_at: string;
  updated_at: string;
}

export interface Capability {
  id: number;
  project_id: number | null;
  scope_key: string;
  type: string;
  slug: string;
  name: string;
  version: number;
  scope: "project" | "global";
  status: "draft" | "evaluating" | "active" | "deprecated";
  summary: string;
  asset_path: string | null;
  evaluator_path: string | null;
  asset_hash: string | null;
  evaluator_hash: string | null;
  implementation_status: "unknown" | "implementation_verified";
  deployment_status: "not_deployed" | "deployed";
  lead_tool_status: "not_loaded" | "loaded";
  source_candidates: string;
  provenance: string;
  created_at: string;
  updated_at: string;
}

export interface CapabilityRun {
  id: number;
  capability_id: number;
  item_id: number | null;
  run_id: number | null;
  outcome: "passed" | "failed" | "error";
  metrics: string;
  evidence: string;
  created_at: string;
}

export function getLearningCandidate(db: Db, id: number): LearningCandidate | undefined {
  return db.prepare("SELECT * FROM learning_candidates WHERE id=?").get(id) as LearningCandidate | undefined;
}

export function getCapability(db: Db, id: number): Capability | undefined {
  return db.prepare("SELECT * FROM capabilities WHERE id=?").get(id) as Capability | undefined;
}

export function parseSourceCandidateIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is number => Number.isInteger(id) && id > 0))];
  } catch {
    return [];
  }
}

export function findCapabilityBySourceCandidate(
  db: Db,
  candidate: LearningCandidate,
  statuses?: Capability["status"][],
): Capability | undefined {
  const rows = db.prepare("SELECT * FROM capabilities WHERE scope_key=? ORDER BY id")
    .all(candidate.scope_key) as Capability[];
  return rows.find((row) =>
    (!statuses || statuses.includes(row.status))
    && parseSourceCandidateIds(row.source_candidates).includes(candidate.id));
}

export function listActiveCapabilities(db: Db, projectId: number): Capability[] {
  return db.prepare(
    `SELECT * FROM capabilities
     WHERE scope_key IN (?, 'global')
       AND status='active'
       AND implementation_status='implementation_verified'
       AND deployment_status='deployed'
       AND lead_tool_status='loaded'
     ORDER BY scope_key, slug, version`,
  ).all(`project:${projectId}`) as Capability[];
}

export function capabilityReadyForLeadUse(capability: Capability): boolean {
  return capability.status === "active"
    && capability.implementation_status === "implementation_verified"
    && capability.deployment_status === "deployed"
    && capability.lead_tool_status === "loaded";
}

export function markCapabilityDeployed(
  db: Db,
  id: number,
  state: { deployed?: boolean; leadToolLoaded?: boolean },
): Capability {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (state.deployed !== undefined) {
    sets.push("deployment_status=?");
    values.push(state.deployed ? "deployed" : "not_deployed");
  }
  if (state.leadToolLoaded !== undefined) {
    sets.push("lead_tool_status=?");
    values.push(state.leadToolLoaded ? "loaded" : "not_loaded");
  }
  if (!sets.length) {
    const capability = getCapability(db, id);
    if (!capability) throw new Error(`capability #${id} not found`);
    return capability;
  }
  sets.push("updated_at=datetime('now')");
  values.push(id);
  db.prepare(`UPDATE capabilities SET ${sets.join(", ")} WHERE id=?`).run(...values);
  const capability = getCapability(db, id);
  if (!capability) throw new Error(`capability #${id} not found`);
  if (capabilityReadyForLeadUse(capability)) {
    enqueueContinuationEvent(db, {
      itemId: null,
      eventType: "capability_deployed",
      payload: {
        capabilityId: capability.id,
        scopeKey: capability.scope_key,
        slug: capability.slug,
        version: capability.version,
      },
      idempotencyKey: `capability-deployed:${capability.id}:ready:${capability.updated_at}`,
    });
  }
  return capability;
}
