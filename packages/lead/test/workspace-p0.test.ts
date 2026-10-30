import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { createRun, getRun } from "@pi-lead-child/store";
import { createWorkspace, getWorkspace, resolveWorkspace } from "@pi-lead-child/store";
import { createCoordinator } from "@pi-lead-child/engine";
import { createDispatcher } from "@pi-lead-child/engine";
import { provisionWorkspace } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "../src/tools.js";
import { runItem } from "@pi-lead-child/engine";
import type { AgentRuntime, RuntimeStartRequest } from "@pi-lead-child/runtime";

let db: Db;
let dir: string;
let repo: string;
beforeEach(() => {
  dir = tempDir("plc-workspace-p0-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "source.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  db = openDb(join(dir, "plc.db"));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function coding(): number {
  return createItem(db, { title: "code", brief: "code", createdBy: "user", workflowKind: "coding", workdir: repo });
}

function runtime(action: (request: RuntimeStartRequest) => void, afterCompletion?: () => void): AgentRuntime {
  return {
    id: "codex",
    capabilities: { streaming: true, steering: false, resume: false, interrupt: true,
      approvals: false, mcp: false, executableReadOnlyReview: true },
    async start(request) {
      return {
        pid: null,
        events: (async function*() {
          yield { runId: request.runId, seq: 1, occurredAt: new Date().toISOString(),
            type: "run.started" as const, runtime: "codex" as const, model: null };
          action(request);
          yield { runId: request.runId, seq: 2, occurredAt: new Date().toISOString(),
            type: "run.completed" as const, exitCode: 0 };
        })(),
        async interrupt() {},
        async wait() {
          afterCompletion?.();
          return { ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null };
        },
      };
    },
  };
}

describe("coding workspace P0 persisted flow", () => {
  it("inherits explicit workflow kind through coordinator plans and rejects a changed replay", () => {
    const coordinator = createCoordinator({ db });
    const root = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "user", workflowKind: "coding", workdir: repo });
    expect(getItem(db, root)?.workflow_kind).toBe("coding");
    provisionWorkspace(db, { itemId: root, mode: "shared" });
    const runId = createRun(db, { itemId: root, workspaceId: resolveWorkspace(db, root)!.workspace.id });
    const revision = coordinator.beginPlanning({ itemId: root, runId });
    const ctx = { itemId: root, runId, revision };
    const plan = { items: [{ key: "child", title: "child", brief: "b" }] };
    const child = coordinator.createWorkPlan(ctx, plan).byKey.child;
    expect(getItem(db, child)?.workflow_kind).toBe("coding");
    expect(() => coordinator.createWorkPlan(ctx, { items: [{ ...plan.items[0], workflowKind: "generic" }] }))
      .toThrow(/conflict/);
  });

  it("exposes resolve_workspace and provision_workspace only to Lead", async () => {
    const tools = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: join(dir, "data") });
    const lookup = (name: string) => tools.find((tool) => tool.name === name) as any;
    expect(lookup("create_task").parameters.properties).toHaveProperty("workflow_kind");
    const itemId = coding();
    expect(lookup("resolve_workspace")).toBeDefined();
    expect(lookup("provision_workspace")).toBeDefined();
    // 共享工作区要写明理由（2026-10-19）。
    await expect(lookup("provision_workspace").execute("provision", { item_id: itemId, mode: "shared", path: repo }))
      .rejects.toThrow(/reason/);
    await lookup("provision_workspace").execute("provision", {
      item_id: itemId, mode: "shared", path: repo, reason: "builds on the user's uncommitted change",
    });
    expect(resolveWorkspace(db, itemId)?.workspace.path).toBe(repo);
  });

  // 以前这里还有一个 PLC_WORKSPACE_ISOLATION_ENABLED 开关，代码从来不读它（2026-10-19 删掉）。
  it("rejects coding dispatch without a workspace", async () => {
    const itemId = createItem(db, { title: "missing", brief: "b", createdBy: "user", workflowKind: "coding" });
    await expect(runItem(db, itemId, { dbPath: join(dir, "plc.db"), prompt: "b", sessionDir: dir,
      runtime: runtime(() => { throw new Error("must not launch"); }) })).rejects.toThrow(/workspace/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(getItem(db, itemId)?.stage).toBe("ready");
  });

  it("actually executes in the isolated checkout, including dispatch binding and injected identity", async () => {
    const itemId = coding();
    provisionWorkspace(db, { itemId, mode: "shared" });
    const isolated = provisionWorkspace(db, { itemId, mode: "isolated", path: join(dir, "isolated") });
    expect(resolveWorkspace(db, itemId)?.workspace.id).toBe(isolated.id);
    const dispatcher = createDispatcher(db);
    dispatcher.request({ itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "isolated" });
    const claim = dispatcher.claimNext()!;
    expect(getRun(db, claim.runId)?.workspace_id).toBe(isolated.id);
    await runItem(db, itemId, { dbPath: join(dir, "plc.db"), prompt: "b", sessionDir: join(dir, "sessions"), runId: claim.runId,
      runtime: runtime((request) => {
        expect(request.workdir).toBe(isolated.path);
        expect(request.env.PLC_WORKSPACE_ID).toBe(String(isolated.id));
        expect(request.env.PLC_WORKFLOW_KIND).toBe("coding");
        writeFileSync(join(request.workdir, "source.txt"), "isolated change\n");
      }) });
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(isolated.path, "source.txt"), "utf8")).toBe("isolated change\n");
  });

  for (const drift of [false, true]) it(`holds workspace until reviewer exit and ${drift ? "invalidates drift" : "publishes matching hashes"}`, async () => {
    const itemId = coding();
    const workspace = provisionWorkspace(db, { itemId, mode: "shared" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const other = coding();
    createWorkspace(db, { ownerItemId: other, mode: "shared", kind: "primary", path: repo, state: "active" });
    const dispatcher = createDispatcher(db);
    const result = await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), prompt: "review", sessionDir: join(dir, "sessions"), role: "reviewer",
      runtime: runtime((request) => {
        expect(getWorkspace(db, workspace.id)?.state).toBe("review_hold");
        expect(getWorkspace(db, workspace.id)?.state).toBe("review_hold");
        dispatcher.submitReviewVerdict({ runId: request.runId, verdict: "pass", evidence: "independent checks" });
        expect(db.prepare("SELECT COUNT(*) AS n FROM review_verdicts").get()).toEqual({ n: 0 });
      }, () => { if (drift) writeFileSync(join(repo, "source.txt"), "late mutation\n"); }),
    });
    const verdict = db.prepare("SELECT pre_hash, post_hash FROM review_verdicts WHERE run_id=?").get(result.runId) as any;
    if (drift) {
      expect(verdict).toBeUndefined();
      expect(getRun(db, result.runId)?.error_code).toBe("review_workspace_drift");
    } else {
      // 核查前后的指纹是异步的 git 视角指纹，带 tree: 前缀（engine 的 workspace-integrity.ts）。
      expect(verdict?.pre_hash).toMatch(/^tree:[a-f0-9]{64}$/);
      expect(verdict?.post_hash).toBe(verdict.pre_hash);
    }
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(getWorkspace(db, workspace.id)?.state).toBe("idle");
  });
});
