import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { KernelConversationCardListResponseSchema } from "@pi-lead-child/protocol";
import { createCoordinator } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { createTurn } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import { upsertItemExecutionCard } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-cards-http-"), "plc.db"));
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
  const { code } = createPairing(db, { name: "card-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

function seedCards() {
  const coordinator = createCoordinator({ db, now: () => new Date("2026-07-24T09:00:00.000Z") });
  const itemId = coordinator.createRootItem({
    title: "Conversation cards",
    brief: "Durable Lead projections",
    createdBy: "system",
  });
  createTurn(db, {
    id: "turn-card-http",
    originKind: "companion",
    itemId,
    userText: "create and execute",
  });
  const execution = upsertItemExecutionCard(db, {
    turnId: "turn-card-http",
    itemId,
    operation: {
      id: "turn-card-http:create",
      name: "create_task",
      state: "started",
      label: `Create task #${itemId}`,
      detail: null,
    },
  });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  const completed = coordinator.submitCheckpoint({
    itemId,
    runId,
    kind: "completed",
    title: "Implementation complete",
    summary: "The owned implementation and targeted tests are complete.",
  }).checkpoint;
  const decision = coordinator.requestDecision({
    itemId,
    runId,
    kind: "question",
    audience: "user",
    allowCustom: true,
    prompt: "Secret deployment label should be privileged",
    options: [],
    checkpoint: {
      title: "Deployment label required",
      summary: "A user-provided release label is required.",
    },
  });
  return {
    itemId,
    executionKey: execution.key,
    completedId: completed.id,
    decisionId: decision.requestId,
  };
}

describe("conversation-card HTTP resource", () => {
  it("returns stable pages with immutable checkpoint and safe intervention sidecars", async () => {
    const { itemId, decisionId } = seedCards();
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };
      const response = await fetch(
        `${server.base}/v1/kernel/conversation/cards?ticket_id=${itemId}&limit=2`,
        { headers },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Value.Check(KernelConversationCardListResponseSchema, body)).toBe(true);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((item: any) => item.id)).toEqual([...body.items.map((item: any) => item.id)].sort((a, b) => a - b));
      expect(body.checkpoints.length).toBeGreaterThan(0);
      expect(body.interventionRefs).toContainEqual({
        id: `decision:${decisionId}`,
        // KernelInterventionRef 是线上 DTO，键名仍是 ticketId。
        ticketId: itemId,
        kind: "question",
        state: "pending",
        requiresAction: true,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Secret deployment label");
      expect(serialized).not.toContain("actions");
      expect(serialized).not.toContain("options");
    } finally {
      await server.close();
    }
  });

  it("supports key refetches for mutable cards and rejects invalid cursor/filter input", async () => {
    const { itemId, executionKey } = seedCards();
    upsertItemExecutionCard(db, {
      turnId: "turn-card-http",
      itemId,
      operation: {
        id: "turn-card-http:create",
        name: "create_task",
        state: "completed",
        label: `Create task #${itemId}`,
        detail: `Created task #${itemId}`,
      },
    });
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const headers = { authorization: `Bearer ${accessToken}` };
      const byKey = await fetch(
        `${server.base}/v1/kernel/conversation/cards?key=${encodeURIComponent(executionKey)}`,
        { headers },
      );
      expect(byKey.status).toBe(200);
      expect(await byKey.json()).toMatchObject({
        items: [{
          key: executionKey,
          operations: [{ state: "completed", detail: `Created task #${itemId}` }],
        }],
      });

      for (const query of [
        "after_id=1&before_id=2",
        "limit=201",
        "ticket_id=0",
        "key=not-a-card-key",
      ]) {
        const invalid = await fetch(
          `${server.base}/v1/kernel/conversation/cards?${query}`,
          { headers },
        );
        expect(invalid.status, query).toBe(400);
      }
    } finally {
      await server.close();
    }
  });
});
