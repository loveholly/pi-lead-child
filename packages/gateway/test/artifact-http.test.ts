import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { KernelArtifactListResponseSchema } from "@pi-lead-child/protocol";
import { createCoordinator } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { listArtifacts, stageArtifact } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";

let db: Db;
let dataDir: string;
let workdir: string;

beforeEach(() => {
  dataDir = tempDir("plc-artifact-http-");
  workdir = join(dataDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  db = openDb(join(dataDir, "plc.db"));
});

function runtime() {
  return {
    model: "stub/model",
    sessionId: "stub-session",
    busy: false,
    runningItemIds: [],
    aish: null,
  };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, dataDir }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "artifact-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

function seedArtifacts(options: { includeLarge?: boolean } = {}) {
  const report = Buffer.from("# 验收报告\nartifact payload\n", "utf8");
  const unavailable = Buffer.from("unavailable payload\n", "utf8");
  const large = options.includeLarge ? Buffer.alloc(4 * 1024 * 1024, 0x61) : null;
  writeFileSync(join(workdir, "report.md"), report);
  writeFileSync(join(workdir, "unavailable.txt"), unavailable);
  if (large) writeFileSync(join(workdir, "large.bin"), large);

  const coordinator = createCoordinator({ db, now: () => new Date("2026-07-25T08:00:00.000Z") });
  const itemId = coordinator.createRootItem({
    title: "Artifact delivery",
    brief: "Serve immutable proof artifacts",
    createdBy: "system",
    workdir,
  });
  const otherItemId = coordinator.createRootItem({
    title: "Other item",
    brief: "Must not access another item's artifacts",
    createdBy: "system",
  });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  const stagedArtifacts = [
    stageArtifact(db, {
      dataDir,
      itemId,
      runId,
      ref: "report",
      name: "报告 final.md",
      kind: "report",
      mediaType: "text/markdown",
      description: "Acceptance report",
      relativePath: "report.md",
    }),
    stageArtifact(db, {
      dataDir,
      itemId,
      runId,
      ref: "external-link",
      name: "External evidence",
      kind: "link",
      mediaType: "text/plain",
      description: "Metadata-only evidence",
      relativePath: null,
    }),
    stageArtifact(db, {
      dataDir,
      itemId,
      runId,
      ref: "unavailable",
      name: "Unavailable evidence.txt",
      kind: "log",
      mediaType: "text/plain",
      description: null,
      relativePath: "unavailable.txt",
    }),
    ...(large ? [stageArtifact(db, {
      dataDir,
      itemId,
      runId,
      ref: "large",
      name: "large.bin",
      kind: "binary",
      mediaType: "application/octet-stream",
      description: "Cancellation fixture",
      relativePath: "large.bin",
    })] : []),
  ];
  coordinator.submitCheckpoint({
    itemId,
    runId,
    kind: "milestone",
    title: "Artifact delivery ready",
    summary: "Immutable artifacts are registered for paired delivery.",
    artifactRefs: stagedArtifacts.map((artifact) => artifact.ref),
    stagedArtifacts,
  });
  const artifacts = listArtifacts(db, itemId);
  const byRef = new Map(artifacts.map((artifact) => [artifact.ref, artifact]));
  const unavailableArtifact = byRef.get("unavailable")!;
  db.prepare("UPDATE artifacts SET availability='unavailable', storage_key=NULL WHERE id=?")
    .run(unavailableArtifact.id);
  return {
    itemId,
    otherItemId,
    report,
    artifacts: listArtifacts(db, itemId),
  };
}

describe("artifact HTTP resource", () => {
  it("lists metadata and streams exact immutable bytes with safe download headers", async () => {
    const { itemId, report, artifacts } = seedArtifacts();
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };
      const list = await fetch(`${server.base}/v1/kernel/v1/tickets/${itemId}/artifacts`, { headers });
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(Value.Check(KernelArtifactListResponseSchema, body)).toBe(true);
      expect(body.items.map((item: any) => item.id)).toEqual(artifacts.map((artifact) => artifact.id));

      const reportArtifact = body.items.find((item: any) => item.ref === "report");
      const content = await fetch(
        `${server.base}/v1/kernel/v1/tickets/${itemId}/artifacts/${reportArtifact.id}/content`,
        { headers },
      );
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toBe("text/markdown");
      expect(content.headers.get("content-length")).toBe(String(report.byteLength));
      expect(content.headers.get("cache-control")).toBe("private, no-store");
      expect(content.headers.get("x-content-type-options")).toBe("nosniff");
      expect(content.headers.get("x-artifact-id")).toBe(String(reportArtifact.id));
      expect(content.headers.get("x-artifact-sha256")).toBe(reportArtifact.sha256);
      expect(content.headers.get("content-disposition")).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A%20final.md");
      const bytes = Buffer.from(await content.arrayBuffer());
      expect(bytes).toEqual(report);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(reportArtifact.sha256);
    } finally {
      await server.close();
    }
  });

  it("uses indistinguishable not-found responses for inaccessible artifact content", async () => {
    const { itemId, otherItemId, artifacts } = seedArtifacts();
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };
      const byRef = new Map(artifacts.map((artifact) => [artifact.ref, artifact]));
      const paths = [
        `/v1/kernel/v1/tickets/${itemId}/artifacts/999999/content`,
        `/v1/kernel/v1/tickets/${otherItemId}/artifacts/${byRef.get("report")!.id}/content`,
        `/v1/kernel/v1/tickets/${itemId}/artifacts/${byRef.get("external-link")!.id}/content`,
        `/v1/kernel/v1/tickets/${itemId}/artifacts/${byRef.get("unavailable")!.id}/content`,
      ];
      const results = [];
      for (const path of paths) {
        const response = await fetch(`${server.base}${path}`, { headers });
        results.push({ status: response.status, body: await response.json() });
      }
      expect(results).toEqual(paths.map(() => ({
        status: 404,
        body: { error: { code: "not_found", message: "artifact not found" } },
      })));
    } finally {
      await server.close();
    }
  });

  it("enforces tickets:view and survives a client-cancelled download", async () => {
    const { itemId, artifacts } = seedArtifacts({ includeLarge: true });
    const server = await start();
    try {
      const largeArtifact = artifacts.find((artifact) => artifact.ref === "large")!;
      const path = `${server.base}/v1/kernel/v1/tickets/${itemId}/artifacts/${largeArtifact.id}/content`;
      expect((await fetch(path)).status).toBe(401);

      const chatOnly = await token(server.base, ["chat"]);
      expect((await fetch(path, {
        headers: { authorization: `Bearer ${chatOnly}` },
      })).status).toBe(403);

      const accessToken = await token(server.base, ["tickets:view"]);
      const response = await fetch(path, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.byteLength).toBeGreaterThan(0);
      await reader.cancel();

      const health = await fetch(`${server.base}/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, protocolVersion: 2 });
    } finally {
      await server.close();
    }
  });
});
