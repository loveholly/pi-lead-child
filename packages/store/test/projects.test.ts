import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem } from "../src/items.js";
import {
  canonicalProjectId,
  createProject,
  findProject,
  getProject,
  linkProjectRepository,
  listProjectRepositories,
  mergeProjects,
  updateProjectSummary,
} from "../src/projects.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-projects-"), "plc.db"));
});

describe("projects", () => {
  it("resolves by slug, name, and alias and records summary history", () => {
    const id = createProject(db, { name: "Returns", slug: "returns", createdBy: "lead" });
    expect(findProject(db, "returns")?.id).toBe(id);
    expect(findProject(db, "Returns")?.id).toBe(id);
    updateProjectSummary(db, id, {
      summary: "Buyer and seller returns workflows",
      actor: "lead",
      reason: "learned multi-repo business boundary",
    });
    expect(getProject(db, id)?.summary).toContain("Buyer and seller");
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_changes WHERE project_id=?").get(id) as any).n)
      .toBe(1);
  });

  it("merges repositories and items transactionally while preserving aliases", () => {
    const buyer = createProject(db, { name: "returns-buyer", createdBy: "system" });
    const returns = createProject(db, { name: "returns", createdBy: "lead" });
    linkProjectRepository(db, buyer, { repoRoot: "/tmp/returns-buyer", repoName: "returns-buyer" });
    linkProjectRepository(db, returns, { repoRoot: "/tmp/returns-seller", repoName: "returns-seller" });
    const item = createItem(db, {
      title: "buyer fix", brief: "b", createdBy: "lead",
      project: "returns-buyer", projectId: buyer,
    });

    mergeProjects(db, buyer, returns, { actor: "lead", reason: "same logical product" });

    expect(canonicalProjectId(db, buyer)).toBe(returns);
    expect(findProject(db, "returns-buyer")?.id).toBe(returns);
    expect(getItem(db, item)).toMatchObject({ project_id: returns, project: "returns" });
    expect(listProjectRepositories(db, returns).map((repo) => repo.repo_name).sort())
      .toEqual(["returns-buyer", "returns-seller"]);
    expect(getProject(db, buyer)?.status).toBe("merged");
  });

  it("coalesces learning candidates and immutable capabilities during a project merge", () => {
    const source = createProject(db, { name: "returns-buyer", createdBy: "system" });
    const target = createProject(db, { name: "returns", createdBy: "lead" });
    const learningItem = createItem(db, {
      title: "learn buyer regression", brief: "b", createdBy: "system",
      project: "returns-buyer", projectId: source, purpose: "learning",
    });
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(learningItem);

    const targetCandidate = Number(db.prepare(
      `INSERT INTO learning_candidates
       (project_id, scope_key, fingerprint, kind, summary, evidence, occurrence_count, confidence, status)
       VALUES (?, ?, 'same-fingerprint', 'review', 'target summary', ?, 2, 0.7, 'drafted')`,
    ).run(target, `project:${target}`, JSON.stringify([
      { kind: "failure", message: "shared" },
      { kind: "failure", message: "target-only" },
    ])).lastInsertRowid);
    const sourceCandidate = Number(db.prepare(
      `INSERT INTO learning_candidates
       (project_id, scope_key, fingerprint, kind, summary, evidence, occurrence_count, confidence, status)
       VALUES (?, ?, 'same-fingerprint', 'review', 'source summary', ?, 3, 0.9, 'promoted')`,
    ).run(source, `project:${source}`, JSON.stringify([
      { message: "shared", kind: "failure" },
      { kind: "failure", message: "source-only" },
    ])).lastInsertRowid);

    const targetSame = Number(db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary,
        asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, 'skill', 'same', 'Target same', 1, 'evaluating', 'target',
        'asset-a', 'eval-a', ?, ?)`,
    ).run(target, `project:${target}`, JSON.stringify([targetCandidate]),
      JSON.stringify({ origin: "target" })).lastInsertRowid);
    const sourceSame = Number(db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary,
        asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, 'skill', 'same', 'Source same', 1, 'active', 'source',
        'asset-a', 'eval-a', ?, ?)`,
    ).run(source, `project:${source}`, JSON.stringify([sourceCandidate]),
      JSON.stringify({ origin: "source" })).lastInsertRowid);
    const sourceRun = Number(db.prepare(
      `INSERT INTO capability_runs (capability_id, outcome, metrics, evidence)
       VALUES (?, 'passed', '{}', '{}')`,
    ).run(sourceSame).lastInsertRowid);

    db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary,
        asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, 'skill', 'conflict', 'Conflict v1', 1, 'active', 'target v1',
        'asset-target-v1', 'eval-target-v1', ?, '{}')`,
    ).run(target, `project:${target}`, JSON.stringify([targetCandidate]));
    db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary,
        asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, 'skill', 'conflict', 'Conflict v2', 2, 'active', 'target v2',
        'asset-target-v2', 'eval-target-v2', ?, '{}')`,
    ).run(target, `project:${target}`, JSON.stringify([targetCandidate]));
    const sourceConflict = Number(db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary,
        asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, 'skill', 'conflict', 'Source conflict', 1, 'evaluating', 'source conflict',
        'asset-source', 'eval-source', ?, ?)`,
    ).run(source, `project:${source}`, JSON.stringify([sourceCandidate]),
      JSON.stringify({ origin: "source-conflict" })).lastInsertRowid);

    mergeProjects(db, source, target, { actor: "lead", reason: "same logical product" });

    const candidates = db.prepare(
      "SELECT * FROM learning_candidates WHERE fingerprint='same-fingerprint'",
    ).all() as any[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: targetCandidate,
      project_id: target,
      scope_key: `project:${target}`,
      occurrence_count: 5,
      confidence: 0.9,
      status: "promoted",
    });
    const candidateEvidence = JSON.parse(candidates[0].evidence);
    expect(candidateEvidence.filter((item: any) => item.message === "shared")).toHaveLength(1);
    expect(candidateEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "target-only" }),
      expect.objectContaining({ message: "source-only" }),
      expect.objectContaining({ kind: "project_merge", sourceProjectId: source, targetProjectId: target }),
    ]));

    const sameCapabilities = db.prepare(
      "SELECT * FROM capabilities WHERE scope_key=? AND slug='same' ORDER BY version",
    ).all(`project:${target}`) as any[];
    expect(sameCapabilities).toHaveLength(1);
    expect(sameCapabilities[0]).toMatchObject({ id: targetSame, status: "active" });
    expect(JSON.parse(sameCapabilities[0].source_candidates)).toEqual([targetCandidate]);
    expect(JSON.parse(sameCapabilities[0].provenance)).toMatchObject({
      origin: "target",
      mergedCapabilities: expect.arrayContaining([
        expect.objectContaining({ capabilityId: sourceSame, sourceProjectId: source }),
      ]),
    });
    expect((db.prepare("SELECT capability_id FROM capability_runs WHERE id=?").get(sourceRun) as any).capability_id)
      .toBe(targetSame);

    const conflict = db.prepare("SELECT * FROM capabilities WHERE id=?").get(sourceConflict) as any;
    expect(conflict).toMatchObject({
      project_id: target,
      scope_key: `project:${target}`,
      version: 3,
    });
    expect(JSON.parse(conflict.source_candidates)).toEqual([targetCandidate]);
    expect(JSON.parse(conflict.provenance)).toMatchObject({
      origin: "source-conflict",
      projectMerge: expect.objectContaining({
        sourceProjectId: source,
        targetProjectId: target,
        previousVersion: 1,
        assignedVersion: 3,
      }),
    });
    expect(getItem(db, learningItem)).toMatchObject({ project_id: target, project: "returns" });
  });
});
