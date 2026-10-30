import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createCoordinator } from "@pi-lead-child/engine";
import { createLearningService } from "@pi-lead-child/engine";
import { createAgentToolHandlers } from "@pi-lead-child/engine";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { openDb } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { createRun, listRuns, updateRun } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";

class WorkflowRuntime implements AgentRuntime {
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };

  constructor(readonly id: RuntimeId, private readonly dbPath: string, private readonly dataDir: string) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const db = openDb(this.dbPath);
    const now = new Date().toISOString();
    const events = async function* (runtime: WorkflowRuntime): AsyncGenerator<RuntimeEvent> {
      yield {
        type: "run.started", runId: request.runId, seq: 1, occurredAt: now,
        runtime: runtime.id, model: request.model ?? null,
      };
      const tools = createAgentToolHandlers({
        db, itemId: request.itemId, runId: request.runId, dataDir: runtime.dataDir,
      });
      if (request.role === "reviewer") {
        await tools.call("review_verdict", { verdict: "pass", evidence: `${runtime.id} verified` });
      } else {
        await tools.call("ticket_update", {
          body_append: request.purpose === "integration" ? "integration verified" : `${runtime.id} execution complete`,
          status: "review", reason: "fake workflow complete",
          checkpoint: {
            kind: "completed",
            stage: request.purpose,
            title: request.purpose === "integration" ? "Integration complete" : `${runtime.id} execution complete`,
            summary: request.purpose === "integration"
              ? "The descendant results were integrated and the parent is ready for review."
              : `The ${runtime.id} child completed its assigned execution and is ready for review.`,
            next_step: "Run independent review.",
          },
        });
      }
      yield {
        type: "run.completed", runId: request.runId, seq: 2,
        occurredAt: new Date().toISOString(), exitCode: 0,
      };
      db.close();
    };
    return {
      pid: null,
      events: events(this),
      interrupt: async () => {},
      wait: async () => ({
        ok: true, exitCode: 0, signal: null, externalSessionId: null,
        errorCode: null, errorMessage: null,
      }),
    };
  }
}

function leadSessionFactory() {
  return async () => ({
    modelName: "stub/lead",
    session: {
      sessionId: "lead-e2e", subscribe: () => () => {},
      prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {},
    },
  });
}

describe("kernel daemon end-to-end", () => {
  it("runs a multi-runtime DAG through automatic review and parent integration", async () => {
    const dataDir = tempDir("plc-kernel-e2e-");
    const dbPath = join(dataDir, "plc.db");
    const db = openDb(dbPath);
    const coordinator = createCoordinator({ db });
    const root = coordinator.createRootItem({
      title: "root", brief: "coordinate delivery", createdBy: "lead",
      project: "kernel-e2e", runtime: "pi",
    });
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(root);
    const planner = createRun(db, { itemId: root, runtime: "pi" });
    updateRun(db, planner, { state: "running" });
    const revision = coordinator.beginPlanning({ itemId: root, runId: planner });
    const plan = coordinator.createWorkPlan({ itemId: root, runId: planner, revision }, {
      items: [
        { key: "pi", title: "Pi leaf", brief: "execute", runtime: "pi" },
        { key: "claude", title: "Claude leaf", brief: "execute", runtime: "claude" },
        { key: "codex", title: "Codex serial", brief: "integrate leaves", runtime: "codex", dependsOn: ["pi", "claude"] },
      ],
    });
    for (const itemId of Object.values(plan.byKey)) {
      grantDelegationPolicy(db, { itemId, createdVia: "test" });
    }
    coordinator.finishPlanning({ itemId: root, runId: planner, revision });
    updateRun(db, planner, { state: "finished", endedAt: true });

    const registry = new RuntimeRegistry([
      new WorkflowRuntime("pi", dbPath, dataDir),
      new WorkflowRuntime("codex", dbPath, dataDir),
      new WorkflowRuntime("claude", dbPath, dataDir),
    ]);
    const daemon = await startDaemon({
      dataDir, dbPath, runtimeRegistry: registry,
      sessionFactory: leadSessionFactory() as any,
      gatewayPort: 0, log: () => {},
    });
    try {
      await vi.waitFor(() => {
        expect(getItem(db, plan.byKey.pi)?.stage).toBe("done");
        expect(getItem(db, plan.byKey.claude)?.stage).toBe("done");
        expect(getItem(db, plan.byKey.codex)?.stage).toBe("done");
        expect(getItem(db, root)).toMatchObject({ stage: "review", plan_state: "integrating" });
      }, { timeout: 12_000, interval: 50 });

      expect(listRuns(db, plan.byKey.pi).map((run) => run.role)).toEqual(["executor", "reviewer"]);
      expect(listRuns(db, plan.byKey.claude).map((run) => run.role)).toEqual(["executor", "reviewer"]);
      expect(listRuns(db, plan.byKey.codex).map((run) => run.role)).toEqual(["executor", "reviewer"]);
      expect(listRuns(db, root).some((run) => run.purpose === "integration")).toBe(true);

      const learning = createLearningService(db, { dataDir, threshold: 2 });
      learning.captureFailure({ projectId: getItem(db, root)?.project_id ?? undefined, kind: "runtime", summary: "stable repeated failure 42" });
      const promoted = learning.captureFailure({ projectId: getItem(db, root)?.project_id ?? undefined, kind: "runtime", summary: "stable repeated failure 43" });
      expect(promoted.capabilityId).not.toBeNull();
      expect(promoted.learningItemId).not.toBeNull();
    } finally {
      await daemon.close();
      db.close();
    }
  }, 20_000);
});
