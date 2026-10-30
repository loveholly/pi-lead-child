import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLearningService } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { openDb } from "@pi-lead-child/store";
import { createPairing, redeemPairing } from "@pi-lead-child/store";
import { createProject } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { markCapabilityDeployed } from "@pi-lead-child/store";

describe("capability lifecycle", () => {
  it("copies immutable assets and activates a safe project capability after owned evaluation", () => {
    const dir = tempDir("plc-capability-");
    const db = openDb(join(dir, "plc.db"));
    const projectId = createProject(db, { name: "returns", createdBy: "lead" });
    const itemId = createItem(db, {
      title: "failure", brief: "b", createdBy: "lead", project: "returns", projectId,
    });
    const service = createLearningService(db, { dataDir: dir, threshold: 1 });
    const captured = service.captureFailure({
      projectId, itemId, kind: "review", errorCode: "TEST_FAIL", summary: "regression",
    });
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir);
    const asset = join(sourceDir, "SKILL.md");
    const evaluator = join(sourceDir, "eval.mjs");
    writeFileSync(asset, "# Returns regression skill\nRun the focused test first.\n");
    writeFileSync(evaluator, "process.exit(0);\n");

    const capability = service.registerCapability({
      candidateId: captured.candidate.id,
      type: "skill",
      name: "Returns regression guard",
      slug: "returns-regression-guard",
      summary: "Prevent repeated regression",
      assetPath: asset,
      evaluatorPath: evaluator,
    });
    const run = service.evaluateCapability(capability.id);
    expect(run.outcome).toBe("passed");
    expect(service.getCapability(capability.id)).toMatchObject({
      status: "active",
      implementation_status: "implementation_verified",
      deployment_status: "not_deployed",
      lead_tool_status: "not_loaded",
    });
    expect(service.renderActiveCapabilities(projectId)).not.toContain("returns-regression-guard");
    markCapabilityDeployed(db, capability.id, { deployed: true, leadToolLoaded: true });
    expect(service.renderActiveCapabilities(projectId)).toContain("returns-regression-guard");

    writeFileSync(service.getCapability(capability.id)!.asset_path!, "tampered\n");
    expect(() => service.evaluateCapability(capability.id)).toThrow(/hash mismatch/i);
  });

  it.each([
    { project: false, type: "skill", label: "global skill" },
    { project: true, type: "tool", label: "project executable tool" },
    { project: true, type: "network_action", label: "project network action" },
    { project: true, type: "policy_hook", label: "project policy hook" },
  ])("keeps $label evaluating after a passing evaluator", ({ project, type }) => {
    const dir = tempDir("plc-capability-gate-");
    const db = openDb(join(dir, "plc.db"));
    const projectId = project ? createProject(db, { name: `project-${type}`, createdBy: "lead" }) : undefined;
    const service = createLearningService(db, { dataDir: dir, threshold: 1 });
    const captured = service.captureFailure({
      projectId, kind: "review", errorCode: `FAIL_${type}`, summary: `failure ${type}`,
    });
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir);
    const asset = join(sourceDir, "asset.md");
    const evaluator = join(sourceDir, "eval.mjs");
    writeFileSync(asset, `# ${type}\n`);
    writeFileSync(evaluator, "process.exit(0);\n");

    const capability = service.registerCapability({
      candidateId: captured.candidate.id,
      type,
      name: type,
      slug: type,
      summary: type,
      assetPath: asset,
      evaluatorPath: evaluator,
    });
    const run = service.evaluateCapability(capability.id);

    expect(run.outcome).toBe("passed");
    expect(service.getCapability(capability.id)).toMatchObject({
      status: "evaluating",
      scope: project ? "project" : "global",
      scope_key: project ? `project:${projectId}` : "global",
    });
    expect((db.prepare("SELECT status FROM learning_candidates WHERE id=?")
      .get(captured.candidate.id) as any).status).toBe("drafted");
  });

  it("does not activate a safe project capability before its Coordinator evaluator passes", () => {
    const dir = tempDir("plc-capability-owned-eval-");
    const db = openDb(join(dir, "plc.db"));
    const projectId = createProject(db, { name: "returns", createdBy: "lead" });
    const service = createLearningService(db, { dataDir: dir, threshold: 1 });
    const captured = service.captureFailure({
      projectId, kind: "review", errorCode: "FAIL", summary: "failure before evaluation",
    });
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir);
    const asset = join(sourceDir, "SKILL.md");
    const evaluator = join(sourceDir, "eval.mjs");
    writeFileSync(asset, "# Safe skill\n");
    writeFileSync(evaluator, "process.exit(1);\n");
    const capability = service.registerCapability({
      candidateId: captured.candidate.id,
      type: "skill",
      name: "Safe skill",
      slug: "safe-skill",
      summary: "safe",
      assetPath: asset,
      evaluatorPath: evaluator,
    });

    expect(service.getCapability(capability.id)?.status).toBe("evaluating");
    expect(service.evaluateCapability(capability.id).outcome).toBe("failed");
    expect(service.getCapability(capability.id)?.status).toBe("evaluating");
  });
});

describe("paired kernel capability advertisement", () => {
  it("keeps protocol v2 and advertises the exact additive kernel resources", async () => {
    const dir = tempDir("plc-kernel-capabilities-");
    const db = openDb(join(dir, "plc.db"));
    const runtime = () => ({
      model: "stub/model",
      sessionId: "stub-session",
      busy: false,
      runningItemIds: [],
      aish: null,
    });
    const { code } = createPairing(db, {
      name: "capabilities-client",
      kind: "companion",
      scopes: ["tickets:view"],
    });
    const paired = redeemPairing(db, code);
    const server = await startPairedServer({
      db,
      controlPlane: createControlPlaneService(db, { runtime }),
      hello: runtime,
      chat: () => "started",
      addClient: () => () => {},
      log: () => {},
    }, { port: 0 });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/v1/paired/events?protocol=2&token=${paired.accessToken}`,
    );
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      const hello = messages.find((message) => message.type === "hello.v2");
      expect(hello.protocolVersion).toBe(2);
      expect(hello.capabilities.filter((capability: string) => capability.startsWith("kernel."))).toEqual([
        "kernel.checkpoints.v1",
        "kernel.checkpoints.v2",
        "kernel.interventions.v1",
        "kernel.work-items.v1",
        "kernel.work-items.v2",
        "kernel.ticket-workbench.v1",
        "kernel.ticket-workbench.v2",
        "kernel.artifacts.v1",
        "kernel.conversation-cards.v1",
      ]);
    } finally {
      socket.close();
      await server.close();
      db.close();
    }
  });
});
