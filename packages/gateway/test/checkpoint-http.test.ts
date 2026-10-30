import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  KernelCheckpointListResponseSchema,
  KernelCheckpointV2ListResponseSchema,
} from "@pi-lead-child/protocol";
import { createCoordinator } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-checkpoint-http-"), "plc.db"));
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
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "checkpoint-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

function seedCheckpoints() {
  const coordinator = createCoordinator({ db, now: () => new Date("2026-07-24T09:00:00.000Z") });
  const itemId = coordinator.createRootItem({
    title: "Checkpoint HTTP",
    brief: "Serve append-only progress",
    createdBy: "system",
  });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  const ids = ["one", "two", "three", "four"].map((title, index) =>
    coordinator.submitCheckpoint({
      itemId,
      runId,
      kind: index === 3 ? "completed" : "milestone",
      title,
      summary: `checkpoint ${title}`,
      ...(index === 2 ? {
        progress: { current: 3, total: 4, label: "HTTP coverage" },
        proofItems: [{
          id: "http",
          label: "HTTP resource",
          state: "passed" as const,
          evidence: "v2 route",
        }],
      } : {}),
    }).checkpoint.id);
  return { itemId, ids };
}

describe("checkpoint HTTP resource", () => {
  it("serves canonical ascending cursor pages through tickets:view", async () => {
    const { itemId, ids } = seedCheckpoints();
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };

      const latest = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/checkpoints?limit=2`,
        { headers },
      );
      expect(latest.status).toBe(200);
      const latestBody = await latest.json();
      expect(Value.Check(KernelCheckpointListResponseSchema, latestBody)).toBe(true);
      expect(latestBody).toMatchObject({
        items: [{ id: ids[2] }, { id: ids[3] }],
        hasMore: true,
        nextBeforeId: ids[2],
      });

      const history = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/checkpoints?before_id=${ids[2]}&limit=2`,
        { headers },
      );
      expect((await history.json() as any).items.map((item: any) => item.id)).toEqual(ids.slice(0, 2));

      const incremental = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/checkpoints?after_id=${ids[1]}&limit=1`,
        { headers },
      );
      expect(await incremental.json()).toMatchObject({
        items: [{ id: ids[2] }],
        hasMore: true,
      });

      const v2 = await fetch(
        `${server.base}/v1/kernel/v2/tickets/${itemId}/checkpoints?limit=2`,
        { headers },
      );
      expect(v2.status).toBe(200);
      const v2Body = await v2.json();
      expect(Value.Check(KernelCheckpointV2ListResponseSchema, v2Body)).toBe(true);
      expect(v2Body.items[0]).toMatchObject({
        id: ids[2],
        progress: { current: 3, total: 4, label: "HTTP coverage" },
        proofItems: [{ id: "http", state: "passed" }],
      });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed cursors, missing items, denied scopes, and public writes", async () => {
    const { itemId } = seedCheckpoints();
    const server = await start();
    try {
      const viewer = await token(server.base, ["tickets:view"]);
      const viewerHeaders = { authorization: `Bearer ${viewer}` };
      for (const query of [
        "after_id=1&before_id=2",
        "after_id=-1",
        "before_id=0",
        "limit=201",
        "limit=abc",
      ]) {
        const response = await fetch(
          `${server.base}/v1/kernel/tickets/${itemId}/checkpoints?${query}`,
          { headers: viewerHeaders },
        );
        expect(response.status, query).toBe(400);
        expect((await response.json() as any).error.code).toBe("invalid_request");
      }

      const missing = await fetch(
        `${server.base}/v1/kernel/tickets/999999/checkpoints`,
        { headers: viewerHeaders },
      );
      expect(missing.status).toBe(404);

      const chatOnly = await token(server.base, ["chat"]);
      const forbidden = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/checkpoints`,
        { headers: { authorization: `Bearer ${chatOnly}` } },
      );
      expect(forbidden.status).toBe(403);

      const write = await fetch(
        `${server.base}/v1/kernel/tickets/${itemId}/checkpoints`,
        {
          method: "POST",
          headers: { ...viewerHeaders, "content-type": "application/json" },
          body: JSON.stringify({ kind: "progress", title: "forbidden", summary: "internal only" }),
        },
      );
      expect(write.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
