import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { getProject } from "@pi-lead-child/store";
import {
  findCapabilityBySourceCandidate, getCapability, getLearningCandidate, listActiveCapabilities,
  parseSourceCandidateIds,
  type Capability, type CapabilityRun, type LearningCandidate,
} from "@pi-lead-child/store";

function scrub(message: string): string {
  return message.toLowerCase()
    .replace(/(?:\/private)?\/(?:tmp|var\/folders|users)\/[^\s:]+/g, "<path>")
    .replace(/#[0-9]+/g, "#<id>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|tokens?)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

// 认不出根因的失败码：这类失败只能按错误原文区分（runtime 的 typed-failure.ts）。
const UNSPECIFIC_ROOT_CAUSES = new Set(["unknown", "task_failed"]);

/** 这个根因代码能不能代表一类失败（不是 unknown 这类兜底的代码）。 */
export function specificRootCause(code: string | undefined | null): string | null {
  const value = code?.trim();
  return value && !UNSPECIFIC_ROOT_CAUSES.has(value) ? value : null;
}

// 失败的指纹：同一个指纹的失败累计次数，到阈值时沉淀一次经验。
// 有具体的根因代码时（例如 account_deactivated、out_of_credits）按根因算，不看错误原文（2026-10-19）：
// 以前按原文算，同一个根因措辞不同就算成不同的失败，各开一张「沉淀失败经验」工单。
export function failureFingerprint(input: {
  kind: string; errorCode?: string; message: string; tool?: string; rootCause?: string | null;
}): string {
  const root = specificRootCause(input.rootCause);
  const parts = root
    ? [input.kind, `root:${root}`, input.tool ?? ""]
    : [input.kind, input.errorCode ?? "", input.tool ?? "", scrub(input.message)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "capability";
}

export interface LearningService {
  captureFailure(input: {
    projectId?: number; itemId?: number; runId?: number;
    kind: string; errorCode?: string; tool?: string; summary: string; evidence?: unknown;
    // 这次失败的根因代码（runtime 的 runFailure(run).code）。具体的根因按根因去重，不分项目。
    rootCause?: string | null;
  }): { candidate: LearningCandidate; capabilityId: number | null; learningItemId: number | null };
  registerCapability(input: {
    candidateId: number; type: string; name: string; slug: string; summary: string;
    assetPath: string; evaluatorPath?: string;
  }): Capability;
  evaluateCapability(capabilityId: number): CapabilityRun;
  getCapability(id: number): Capability | undefined;
  renderActiveCapabilities(projectId: number): string;
}

export function createLearningService(
  db: Db,
  options: { dataDir: string; threshold?: number },
): LearningService {
  const threshold = options.threshold ?? Number(process.env.PLC_LEARNING_THRESHOLD ?? 2);

  const captureFailure: LearningService["captureFailure"] = (input) => db.transaction(() => {
    // 具体的根因（账号停用、额度用完、runtime 缺失……）和项目无关：不同项目里的同一个根因算一类，只沉淀一次。
    const root = specificRootCause(input.rootCause);
    const scopeKey = !root && input.projectId ? `project:${input.projectId}` : "global";
    const fingerprint = failureFingerprint({
      kind: input.kind, errorCode: input.errorCode, message: input.summary, tool: input.tool, rootCause: root,
    });
    let candidate = db.prepare(
      `SELECT * FROM learning_candidates
       WHERE scope_key=? AND fingerprint=? AND status IN ('candidate','drafted','promoted')
       ORDER BY id LIMIT 1`,
    ).get(scopeKey, fingerprint) as LearningCandidate | undefined;
    const evidenceItem = {
      itemId: input.itemId ?? null, runId: input.runId ?? null,
      summary: input.summary, evidence: input.evidence ?? null, at: new Date().toISOString(),
    };
    if (candidate) {
      const evidence = JSON.parse(candidate.evidence || "[]") as unknown[];
      evidence.push(evidenceItem);
      db.prepare(
        `UPDATE learning_candidates SET occurrence_count=occurrence_count+1,
         confidence=MIN(0.99, confidence+0.15), evidence=?, updated_at=datetime('now') WHERE id=?`,
      ).run(JSON.stringify(evidence.slice(-20)), candidate.id);
    } else {
      const result = db.prepare(
        `INSERT INTO learning_candidates
         (project_id, scope_key, item_id, run_id, fingerprint, kind, summary, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.projectId ?? null, scopeKey, input.itemId ?? null, input.runId ?? null,
        fingerprint, input.kind, input.summary, JSON.stringify([evidenceItem]));
      candidate = getLearningCandidate(db, Number(result.lastInsertRowid))!;
    }
    candidate = getLearningCandidate(db, candidate.id)!;
    let capabilityId: number | null = null;
    let learningItemId: number | null = null;
    if (candidate.occurrence_count >= threshold) {
      const capability = findCapabilityBySourceCandidate(db, candidate);
      if (!capability) {
        const slug = `lesson-${fingerprint.slice(0, 12)}`;
        const project = input.projectId ? getProject(db, input.projectId) : undefined;
        const learningItem = createItem(db, {
          title: `沉淀失败经验：${input.summary.slice(0, 60)}`,
          brief: `分析 learning candidate #${candidate.id}，产出项目级 SKILL.md 和可执行 evaluator。`,
          createdBy: "system", project: project?.name, projectId: input.projectId,
          purpose: "learning", verificationPolicy: "independent_reviewer",
        });
        learningItemId = learningItem;
        const result = db.prepare(
          `INSERT INTO capabilities
           (project_id, scope_key, type, slug, name, version, scope, status, summary,
            source_candidates, provenance)
           VALUES (?, ?, 'skill', ?, ?, 1, ?, 'draft', ?, ?, ?)`,
        ).run(input.projectId ?? null, scopeKey, slug, `Lesson ${fingerprint.slice(0, 8)}`,
          input.projectId ? "project" : "global", input.summary, JSON.stringify([candidate.id]),
          JSON.stringify({ learningItemId: learningItem, fingerprint }));
        capabilityId = Number(result.lastInsertRowid);
        db.prepare("UPDATE learning_candidates SET status='drafted', updated_at=datetime('now') WHERE id=?")
          .run(candidate.id);
      } else {
        capabilityId = capability.id;
        try { learningItemId = JSON.parse(capability.provenance).learningItemId ?? null; } catch { /* noop */ }
      }
    }
    return { candidate: getLearningCandidate(db, candidate.id)!, capabilityId, learningItemId };
  })();

  return {
    captureFailure,
    registerCapability(input): Capability {
      const candidate = getLearningCandidate(db, input.candidateId);
      if (!candidate) throw new Error(`learning candidate #${input.candidateId} not found`);
      const draft = findCapabilityBySourceCandidate(db, candidate, ["draft"]);
      if (!draft) throw new Error("candidate has no draft capability");
      const scopeDir = draft.project_id ? join("projects", String(draft.project_id)) : "global";
      const versionDir = join(options.dataDir, "capabilities", scopeDir, slugify(input.slug), `v${draft.version}`);
      mkdirSync(versionDir, { recursive: true });
      const assetPath = join(versionDir, basename(input.assetPath));
      copyFileSync(input.assetPath, assetPath);
      const evaluatorPath = input.evaluatorPath ? join(versionDir, basename(input.evaluatorPath)) : null;
      if (input.evaluatorPath && evaluatorPath) copyFileSync(input.evaluatorPath, evaluatorPath);
      db.prepare(
        `UPDATE capabilities SET type=?, slug=?, name=?, summary=?, status='evaluating',
         asset_path=?, evaluator_path=?, asset_hash=?, evaluator_hash=?, updated_at=datetime('now')
         WHERE id=?`,
      ).run(input.type, slugify(input.slug), input.name, input.summary, assetPath, evaluatorPath,
        fileHash(assetPath), evaluatorPath ? fileHash(evaluatorPath) : null, draft.id);
      return getCapability(db, draft.id)!;
    },
    evaluateCapability(capabilityId): CapabilityRun {
      const capability = getCapability(db, capabilityId);
      if (!capability) throw new Error(`capability #${capabilityId} not found`);
      if (!capability.asset_path || !capability.asset_hash) throw new Error("capability asset is not registered");
      if (fileHash(capability.asset_path) !== capability.asset_hash) throw new Error("capability asset hash mismatch");
      if (!capability.evaluator_path || !capability.evaluator_hash) throw new Error("capability evaluator is not registered");
      if (fileHash(capability.evaluator_path) !== capability.evaluator_hash) throw new Error("capability evaluator hash mismatch");
      let outcome: CapabilityRun["outcome"] = "passed";
      let output = "";
      try {
        const ext = extname(capability.evaluator_path);
        const command = ext === ".js" || ext === ".mjs" || ext === ".cjs"
          ? process.execPath
          : capability.evaluator_path;
        const args = command === process.execPath ? [capability.evaluator_path] : [];
        output = execFileSync(command, args, {
          cwd: dirname(capability.asset_path), encoding: "utf8", timeout: 30_000,
          maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error: any) {
        outcome = typeof error?.status === "number" ? "failed" : "error";
        output = String(error?.stdout ?? error?.stderr ?? error?.message ?? error).slice(0, 20_000);
      }
      const result = db.prepare(
        `INSERT INTO capability_runs (capability_id, outcome, metrics, evidence)
         VALUES (?, ?, ?, ?)`,
      ).run(capability.id, outcome, JSON.stringify({ outputLength: output.length }), JSON.stringify({
        assetHash: capability.asset_hash, evaluatorHash: capability.evaluator_hash,
        outputDigest: createHash("sha256").update(output).digest("hex"),
      }));
      const autoActivatable = capability.scope === "project"
        && ["skill", "runbook", "evaluator"].includes(capability.type);
      if (outcome === "passed" && autoActivatable) {
        db.prepare(
          `UPDATE capabilities
           SET status='active', implementation_status='implementation_verified',
               updated_at=datetime('now')
           WHERE id=?`,
        )
          .run(capability.id);
        for (const candidateId of parseSourceCandidateIds(capability.source_candidates)) {
          db.prepare("UPDATE learning_candidates SET status='promoted', updated_at=datetime('now') WHERE id=?")
            .run(candidateId);
        }
      }
      return db.prepare("SELECT * FROM capability_runs WHERE id=?").get(Number(result.lastInsertRowid)) as CapabilityRun;
    },
    getCapability: (id) => getCapability(db, id),
    renderActiveCapabilities(projectId): string {
      const rows = listActiveCapabilities(db, projectId);
      if (!rows.length) return "";
      return ["## Active project capabilities", ...rows.map((capability) =>
        `- ${capability.slug} (${capability.type}): ${capability.summary} [${capability.asset_path}]`,
      )].join("\n");
    },
  };
}
