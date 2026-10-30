import type { Db } from "./db.js";

export interface Project {
  id: number;
  slug: string;
  name: string;
  summary: string;
  status: "active" | "merged" | "archived";
  confidence: number;
  max_concurrency: number | null;
  merged_into_project_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRepository {
  id: number;
  project_id: number;
  repo_root: string;
  remote_url: string | null;
  repo_name: string;
  role: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectItemSummaryRow {
  id: string;
  name: string;
  item_count: number;
  running_count: number;
  review_count: number;
  blocked_count: number;
  nearest_due_at: string | null;
}

interface MergeCandidateRow {
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
}

interface MergeCapabilityRow {
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
  source_candidates: string;
  provenance: string;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function dedupeJson(items: unknown[], limit = 20): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const item of items) {
    const key = stableJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(-limit);
}

function parseCandidateIds(value: string): number[] {
  return [...new Set(parseJsonArray(value)
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
}

function strongestCandidateStatus(rows: MergeCandidateRow[]): MergeCandidateRow["status"] {
  const rank: Record<MergeCandidateRow["status"], number> = {
    dismissed: 0,
    candidate: 1,
    drafted: 2,
    promoted: 3,
  };
  return rows.reduce((best, row) => rank[row.status] > rank[best] ? row.status : best, rows[0].status);
}

function strongestCapabilityStatus(rows: MergeCapabilityRow[]): MergeCapabilityRow["status"] {
  const rank: Record<MergeCapabilityRow["status"], number> = {
    deprecated: 0,
    draft: 1,
    evaluating: 2,
    active: 3,
  };
  return rows.reduce((best, row) => rank[row.status] > rank[best] ? row.status : best, rows[0].status);
}

function sameImmutableContent(left: MergeCapabilityRow, right: MergeCapabilityRow): boolean {
  return left.asset_hash === right.asset_hash && left.evaluator_hash === right.evaluator_hash;
}

function mergeProjectLearning(
  db: Db,
  sourceId: number,
  targetId: number,
  args: { actor: string; reason: string },
): void {
  const sourceFingerprints = db.prepare(
    "SELECT DISTINCT fingerprint FROM learning_candidates WHERE project_id=? ORDER BY fingerprint",
  ).all(sourceId) as { fingerprint: string }[];
  const candidateRemap = new Map<number, number>();

  for (const { fingerprint } of sourceFingerprints) {
    const rows = db.prepare(
      `SELECT * FROM learning_candidates
       WHERE fingerprint=? AND project_id IN (?, ?) ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END, id`,
    ).all(fingerprint, targetId, sourceId, targetId) as MergeCandidateRow[];
    if (!rows.length) continue;
    const survivor = rows[0];
    const duplicates = rows.slice(1);
    for (const duplicate of duplicates) candidateRemap.set(duplicate.id, survivor.id);
    if (duplicates.length) {
      db.prepare(`DELETE FROM learning_candidates WHERE id IN (${duplicates.map(() => "?").join(",")})`)
        .run(...duplicates.map((row) => row.id));
    }
    const mergeMarker = {
      kind: "project_merge",
      sourceProjectId: sourceId,
      targetProjectId: targetId,
      candidateIds: rows.map((row) => row.id),
      actor: args.actor,
      reason: args.reason,
    };
    const evidence = dedupeJson([
      ...rows.flatMap((row) => parseJsonArray(row.evidence)),
      mergeMarker,
    ]);
    db.prepare(
      `UPDATE learning_candidates SET project_id=?, scope_key=?, item_id=?, run_id=?,
       occurrence_count=?, confidence=?, status=?, evidence=?, updated_at=datetime('now') WHERE id=?`,
    ).run(
      targetId,
      `project:${targetId}`,
      rows.find((row) => row.item_id !== null)?.item_id ?? null,
      rows.find((row) => row.run_id !== null)?.run_id ?? null,
      rows.reduce((sum, row) => sum + row.occurrence_count, 0),
      Math.max(...rows.map((row) => row.confidence)),
      strongestCandidateStatus(rows),
      JSON.stringify(evidence),
      survivor.id,
    );
  }

  const capabilities = db.prepare("SELECT * FROM capabilities ORDER BY id").all() as MergeCapabilityRow[];
  for (const capability of capabilities) {
    const remapped = [...new Set(parseCandidateIds(capability.source_candidates)
      .map((id) => candidateRemap.get(id) ?? id))];
    if (JSON.stringify(remapped) !== JSON.stringify(parseCandidateIds(capability.source_candidates))) {
      db.prepare("UPDATE capabilities SET source_candidates=?, updated_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(remapped), capability.id);
    }
  }

  const sourceCapabilities = db.prepare(
    "SELECT * FROM capabilities WHERE project_id=? ORDER BY slug, version, id",
  ).all(sourceId) as MergeCapabilityRow[];
  for (const sourceCapability of sourceCapabilities) {
    const collision = db.prepare(
      "SELECT * FROM capabilities WHERE scope_key=? AND slug=? AND version=? ORDER BY id LIMIT 1",
    ).get(`project:${targetId}`, sourceCapability.slug, sourceCapability.version) as MergeCapabilityRow | undefined;
    if (collision && sameImmutableContent(collision, sourceCapability)) {
      const sourceCandidates = parseCandidateIds(
        (db.prepare("SELECT source_candidates FROM capabilities WHERE id=?").get(sourceCapability.id) as { source_candidates: string })
          .source_candidates,
      );
      const targetCandidates = parseCandidateIds(collision.source_candidates);
      const targetProvenance = parseJsonObject(collision.provenance);
      const existingMerged = Array.isArray(targetProvenance.mergedCapabilities)
        ? targetProvenance.mergedCapabilities
        : [];
      const provenance = {
        ...targetProvenance,
        mergedCapabilities: dedupeJson([...existingMerged, {
          capabilityId: sourceCapability.id,
          sourceProjectId: sourceId,
          targetProjectId: targetId,
          actor: args.actor,
          reason: args.reason,
          provenance: parseJsonObject(sourceCapability.provenance),
        }], 100),
      };
      db.prepare("UPDATE capability_runs SET capability_id=? WHERE capability_id=?")
        .run(collision.id, sourceCapability.id);
      db.prepare("DELETE FROM capabilities WHERE id=?").run(sourceCapability.id);
      db.prepare(
        `UPDATE capabilities SET status=?, source_candidates=?, provenance=?,
         asset_path=COALESCE(asset_path, ?), evaluator_path=COALESCE(evaluator_path, ?),
         updated_at=datetime('now') WHERE id=?`,
      ).run(
        strongestCapabilityStatus([collision, sourceCapability]),
        JSON.stringify([...new Set([...targetCandidates, ...sourceCandidates])]),
        JSON.stringify(provenance),
        sourceCapability.asset_path,
        sourceCapability.evaluator_path,
        collision.id,
      );
      continue;
    }

    let assignedVersion = sourceCapability.version;
    if (collision) {
      const maxVersion = db.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM capabilities WHERE scope_key=? AND slug=?",
      ).get(`project:${targetId}`, sourceCapability.slug) as { version: number };
      assignedVersion = maxVersion.version + 1;
    }
    const sourceProvenance = parseJsonObject(sourceCapability.provenance);
    const projectMerge = {
      sourceProjectId: sourceId,
      targetProjectId: targetId,
      previousVersion: sourceCapability.version,
      assignedVersion,
      actor: args.actor,
      reason: args.reason,
    };
    db.prepare(
      `UPDATE capabilities SET project_id=?, scope_key=?, version=?, provenance=?, updated_at=datetime('now')
       WHERE id=?`,
    ).run(targetId, `project:${targetId}`, assignedVersion, JSON.stringify({
      ...sourceProvenance,
      projectMerge,
    }), sourceCapability.id);
  }
}

function slugify(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `project-${Buffer.from(name).toString("hex").slice(0, 20) || "unknown"}`;
}

function uniqueSlug(db: Db, requested: string, name: string): string {
  const base = slugify(requested);
  let slug = base;
  let suffix = 2;
  while (true) {
    const row = db.prepare("SELECT name FROM projects WHERE slug = ?").get(slug) as { name: string } | undefined;
    if (!row || row.name === name) return slug;
    slug = `${base.slice(0, 44)}-${suffix++}`;
  }
}

export function createProject(
  db: Db,
  args: {
    name: string; slug?: string; summary?: string; createdBy: string;
    confidence?: number; maxConcurrency?: number;
  },
): number {
  const existing = findProject(db, args.slug ?? args.name);
  if (existing && existing.name === args.name) return existing.id;
  const result = db.prepare(
    `INSERT INTO projects (slug, name, summary, confidence, max_concurrency, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    uniqueSlug(db, args.slug ?? args.name, args.name), args.name, args.summary ?? "",
    args.confidence ?? 1, args.maxConcurrency ?? null, args.createdBy,
  );
  return Number(result.lastInsertRowid);
}

export function getProject(db: Db, id: number): Project | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

export function canonicalProjectId(db: Db, id: number): number {
  const seen = new Set<number>();
  let current = id;
  while (true) {
    if (seen.has(current)) throw new Error(`project merge cycle at #${current}`);
    seen.add(current);
    const project = getProject(db, current);
    if (!project) throw new Error(`project #${current} not found`);
    if (project.status !== "merged" || project.merged_into_project_id === null) return project.id;
    current = project.merged_into_project_id;
  }
}

export function findProject(db: Db, ref: string): Project | undefined {
  const direct = db.prepare(
    `SELECT * FROM projects
     WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
     ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, id LIMIT 1`,
  ).get(ref, ref) as Project | undefined;
  if (direct) return getProject(db, canonicalProjectId(db, direct.id));
  const alias = db.prepare(
    "SELECT project_id FROM project_aliases WHERE alias = ? COLLATE NOCASE",
  ).get(ref) as { project_id: number } | undefined;
  return alias ? getProject(db, canonicalProjectId(db, alias.project_id)) : undefined;
}

export function listActiveProjectItemSummaries(db: Db): ProjectItemSummaryRow[] {
  return db.prepare(
    `WITH project_stats AS (
       SELECT
         CAST(p.id AS TEXT) AS id,
         p.name AS name,
         COUNT(t.id) AS item_count,
         SUM(CASE WHEN t.stage = 'active' THEN 1 ELSE 0 END) AS running_count,
         SUM(CASE WHEN t.stage = 'review' THEN 1 ELSE 0 END) AS review_count,
         SUM(CASE WHEN t.stage = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
         MIN(CASE WHEN t.stage NOT IN ('done','cancelled') THEN t.due_at END) AS nearest_due_at,
         0 AS unknown_rank
       FROM projects p
       LEFT JOIN items t ON t.project_id = p.id
       WHERE p.status = 'active'
       GROUP BY p.id, p.name
     ),
     unknown_stats AS (
       SELECT
         'unknown' AS id,
         'unknown' AS name,
         COUNT(t.id) AS item_count,
         SUM(CASE WHEN t.stage = 'active' THEN 1 ELSE 0 END) AS running_count,
         SUM(CASE WHEN t.stage = 'review' THEN 1 ELSE 0 END) AS review_count,
         SUM(CASE WHEN t.stage = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
         MIN(CASE WHEN t.stage NOT IN ('done','cancelled') THEN t.due_at END) AS nearest_due_at,
         1 AS unknown_rank
       FROM items t
       LEFT JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE p.id IS NULL AND t.parent_item_id IS NULL
     )
     SELECT id, name, item_count, running_count, review_count, blocked_count, nearest_due_at
     FROM (
       SELECT * FROM project_stats
       UNION ALL
       SELECT * FROM unknown_stats WHERE item_count > 0
     )
     ORDER BY unknown_rank, name COLLATE NOCASE, id`,
  ).all() as ProjectItemSummaryRow[];
}

export function linkProjectRepository(
  db: Db,
  projectId: number,
  args: { repoRoot: string; remoteUrl?: string; repoName: string; role?: string; confidence?: number },
): number {
  const canonical = canonicalProjectId(db, projectId);
  const existing = db.prepare("SELECT * FROM project_repositories WHERE repo_root = ?")
    .get(args.repoRoot) as ProjectRepository | undefined;
  if (existing) {
    if (canonicalProjectId(db, existing.project_id) !== canonical) {
      throw new Error(`repository already belongs to project #${existing.project_id}`);
    }
    db.prepare(
      `UPDATE project_repositories SET remote_url = COALESCE(?, remote_url), repo_name = ?,
       role = COALESCE(?, role), confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(args.remoteUrl ?? null, args.repoName, args.role ?? null, args.confidence ?? 1, existing.id);
    return existing.id;
  }
  const result = db.prepare(
    `INSERT INTO project_repositories
      (project_id, repo_root, remote_url, repo_name, role, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(canonical, args.repoRoot, args.remoteUrl ?? null, args.repoName,
    args.role ?? null, args.confidence ?? 1);
  return Number(result.lastInsertRowid);
}

export function listProjectRepositories(db: Db, projectId: number): ProjectRepository[] {
  return db.prepare("SELECT * FROM project_repositories WHERE project_id = ? ORDER BY id")
    .all(canonicalProjectId(db, projectId)) as ProjectRepository[];
}

// 归档或恢复一个项目（左栏改版决定 7）。合并掉的项目不能改：它的工单已经归到合并进去的那个项目。
export function setProjectStatus(
  db: Db,
  projectId: number,
  status: "active" | "archived",
  args: { actor: string; reason: string },
): void {
  db.transaction(() => {
    const before = getProject(db, projectId);
    if (!before) throw new Error(`project #${projectId} not found`);
    if (before.status === "merged") throw new Error(`project #${projectId} was merged and cannot be ${status}`);
    if (before.status === status) return;
    db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, projectId);
    const after = getProject(db, projectId);
    db.prepare(
      `INSERT INTO project_changes
       (project_id, actor, reason, evidence, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, args.actor, args.reason, JSON.stringify({}), JSON.stringify(before), JSON.stringify(after));
  })();
}

export function updateProjectSummary(
  db: Db,
  projectId: number,
  args: { summary: string; actor: string; reason: string; evidence?: unknown },
): void {
  const id = canonicalProjectId(db, projectId);
  db.transaction(() => {
    const before = getProject(db, id);
    db.prepare("UPDATE projects SET summary = ?, updated_at = datetime('now') WHERE id = ?")
      .run(args.summary, id);
    const after = getProject(db, id);
    db.prepare(
      `INSERT INTO project_changes
       (project_id, actor, reason, evidence, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, args.actor, args.reason, JSON.stringify(args.evidence ?? {}),
      JSON.stringify(before), JSON.stringify(after));
  })();
}

export function mergeProjects(
  db: Db,
  sourceProjectId: number,
  targetProjectId: number,
  args: { actor: string; reason: string; evidence?: unknown },
): void {
  db.transaction(() => {
    const sourceId = canonicalProjectId(db, sourceProjectId);
    const targetId = canonicalProjectId(db, targetProjectId);
    if (sourceId === targetId) return;
    const source = getProject(db, sourceId)!;
    const target = getProject(db, targetId)!;

    mergeProjectLearning(db, sourceId, targetId, args);
    db.prepare("UPDATE project_repositories SET project_id = ?, updated_at = datetime('now') WHERE project_id = ?")
      .run(targetId, sourceId);
    db.prepare(
      "UPDATE items SET project_id = ?, project = ?, updated_at = datetime('now') WHERE project_id = ?",
    ).run(targetId, target.name, sourceId);

    for (const alias of new Set([source.slug, source.name])) {
      db.prepare("INSERT OR REPLACE INTO project_aliases (alias, project_id) VALUES (?, ?)")
        .run(alias, targetId);
    }
    db.prepare(
      `UPDATE projects SET status = 'merged', merged_into_project_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(targetId, sourceId);
    db.prepare(
      `INSERT INTO project_changes
       (project_id, actor, reason, evidence, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(targetId, args.actor, args.reason, JSON.stringify(args.evidence ?? {}),
      JSON.stringify({ source, target }), JSON.stringify({ sourceId, targetId }));
  })();
}
