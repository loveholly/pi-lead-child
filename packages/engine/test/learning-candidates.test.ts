import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLearningService, failureFingerprint } from "../src/coordinator/learning.js";
import { openDb } from "@pi-lead-child/store";
import { createProject } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { runItem } from "../src/children/manager.js";

describe("failure learning candidates", () => {
  it("normalizes volatile paths, ids, and numbers into one project fingerprint", () => {
    expect(failureFingerprint({
      kind: "runtime", errorCode: "ENOENT",
      message: "failed /tmp/work-123/file.ts ticket #42 after 381ms",
    })).toBe(failureFingerprint({
      kind: "runtime", errorCode: "ENOENT",
      message: "failed /private/tmp/work-999/file.ts ticket #77 after 912ms",
    }));
  });

  it("aggregates repeated failures and creates one draft plus learning item at threshold", () => {
    const dir = tempDir("plc-learning-");
    const db = openDb(join(dir, "plc.db"));
    const projectId = createProject(db, { name: "returns", createdBy: "lead" });
    const itemId = createItem(db, {
      title: "failure", brief: "b", createdBy: "lead", project: "returns", projectId,
    });
    const service = createLearningService(db, { dataDir: dir, threshold: 2 });
    service.captureFailure({ projectId, itemId, kind: "runtime", errorCode: "EPIPE", summary: "socket broke 123" });
    const second = service.captureFailure({ projectId, itemId, kind: "runtime", errorCode: "EPIPE", summary: "socket broke 456" });

    expect(second.candidate.occurrence_count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM learning_candidates").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM capabilities WHERE status='draft'").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE purpose='learning'").get() as any).n).toBe(1);
  });

  // 2026-10-19：同一个根因（例如 Codex 账号停用），错误原文措辞不同、出在不同项目里，以前各算一类，
  // 各开一张「沉淀失败经验」工单。现在有具体的根因代码时按根因算，只沉淀一次。
  it("counts failures with the same root cause as one, whatever their wording or project", () => {
    const dir = tempDir("plc-learning-root-cause-");
    const db = openDb(join(dir, "plc.db"));
    const returns = createProject(db, { name: "returns", createdBy: "lead" });
    const tracking = createProject(db, { name: "tracking", createdBy: "lead" });
    const service = createLearningService(db, { dataDir: dir, threshold: 2 });
    service.captureFailure({
      projectId: returns, kind: "reviewer", errorCode: "process_exit", rootCause: "account_deactivated",
      summary: "codex exited 1: Your workspace has been deactivated",
    });
    const second = service.captureFailure({
      projectId: tracking, kind: "reviewer", errorCode: "process_exit", rootCause: "account_deactivated",
      summary: "402 deactivated_workspace while refreshing models",
    });
    expect(second.candidate.occurrence_count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM learning_candidates").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE purpose='learning'").get() as any).n).toBe(1);
    // 认不出根因的（unknown）还按原文区分。
    expect(failureFingerprint({ kind: "reviewer", message: "a", rootCause: "unknown" }))
      .not.toBe(failureFingerprint({ kind: "reviewer", message: "b", rootCause: "unknown" }));
  });

  // 2026-10-19 审查：执行 Run 的失败沉淀经验时没有带根因，现网 #23、#24、#28（402）按项目拆成了几条。
  it("counts execution runs that fail for the same root cause in two projects as one", async () => {
    const dir = tempDir("plc-learning-execution-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const fail = async (project: string, message: string) => {
      const projectId = createProject(db, { name: project, createdBy: "lead" });
      const itemId = createItem(db, { title: `${project} 的工单`, brief: "b", createdBy: "user", project, projectId });
      const runtime = new ReplayRuntime({
        runtime: "codex",
        events: [
          { type: "run.started", runtime: "codex", model: null },
          { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: message,
            failure: { code: "out_of_credits", scope: "account", retry: "never", needs: "refill", evidence: message } },
        ] as RecordedEvent[],
      });
      await runItem(db, itemId, { dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "go", lingerMs: 0, runtime });
    };
    await fail("returns", "402 Payment Required: You exceeded your current quota");
    await fail("tracking", "codex: out of credits for this workspace (402)");
    const candidates = db.prepare("SELECT scope_key, occurrence_count FROM learning_candidates").all();
    expect(candidates).toEqual([{ scope_key: "global", occurrence_count: 2 }]);
    db.close();
  });

  it("matches source candidate ids exactly instead of using substring LIKE semantics", () => {
    const dir = tempDir("plc-learning-exact-candidate-");
    const db = openDb(join(dir, "plc.db"));
    const projectId = createProject(db, { name: "returns", createdBy: "lead" });
    const service = createLearningService(db, { dataDir: dir, threshold: 2 });
    const first = service.captureFailure({
      projectId, kind: "runtime", errorCode: "EPIPE", summary: "socket broke 123",
    });
    expect(first.candidate.id).toBe(1);
    db.prepare(
      `INSERT INTO learning_candidates
       (id, project_id, scope_key, fingerprint, kind, summary, evidence)
       VALUES (10, ?, ?, 'decoy', 'runtime', 'decoy', '[]')`,
    ).run(projectId, `project:${projectId}`);
    const decoyCapabilityId = Number(db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, status, summary, source_candidates)
       VALUES (?, ?, 'skill', 'decoy', 'Decoy', 1, 'draft', 'decoy', '[10]')`,
    ).run(projectId, `project:${projectId}`).lastInsertRowid);

    const second = service.captureFailure({
      projectId, kind: "runtime", errorCode: "EPIPE", summary: "socket broke 456",
    });
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir);
    const asset = join(sourceDir, "SKILL.md");
    writeFileSync(asset, "# Exact candidate\n");
    const registered = service.registerCapability({
      candidateId: second.candidate.id,
      type: "skill",
      name: "Exact candidate",
      slug: "exact-candidate",
      summary: "exact",
      assetPath: asset,
    });

    expect(registered.id).not.toBe(decoyCapabilityId);
    expect(JSON.parse(registered.source_candidates)).toContain(first.candidate.id);
    expect((db.prepare("SELECT status FROM capabilities WHERE id=?").get(decoyCapabilityId) as any).status)
      .toBe("draft");
  });
});
