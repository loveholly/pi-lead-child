import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  AGENT_TOOL_DEFINITIONS,
  createAgentToolHandlers,
} from "../src/agent-tools/definitions.js";
import type { CheckpointPolicyConfig } from "@pi-lead-child/core";
import { createRun, updateRun } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { getDecisionRequest } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { listNotifications } from "@pi-lead-child/store";

const POLICY: CheckpointPolicyConfig = {
  dedupeWindowMs: 60_000,
  progressMinIntervalMs: 120_000,
  silenceMs: 900_000,
  silenceToolEvents: 8,
  silenceDomainEvents: 3,
  reminderCooldownMs: 900_000,
};

let db: Db;
let dataDir: string;
let workdir: string;
let itemId: number;
let runId: number;
let now: Date;

beforeEach(() => {
  dataDir = tempDir("plc-checkpoint-tools-");
  workdir = join(dataDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  db = openDb(join(dataDir, "plc.db"));
  itemId = createItem(db, {
    title: "checkpoint", brief: "tools", createdBy: "system", workdir,
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "started" });
  runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  now = new Date("2026-07-24T08:00:00.000Z");
});

function handlers() {
  return createAgentToolHandlers({
    db,
    itemId,
    runId,
    dataDir,
    now: () => now,
    checkpointPolicy: POLICY,
  });
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

function artifactRegistration(relativePath: string | null = "report.md") {
  return {
    ref: "report",
    name: "report.md",
    kind: "report",
    media_type: "text/markdown",
    description: "Durable checkpoint report",
    ...(relativePath === null ? {} : { relative_path: relativePath }),
  };
}

function checkpoint(summary: string, kind = "progress") {
  return {
    kind,
    stage: "implementation",
    title: "Checkpoint title",
    summary,
    key_facts: [{ label: "tests", value: "running" }],
    artifact_refs: ["artifact:test-log"],
    related_ticket_ids: [],
    next_step: "Continue verification",
  };
}

describe("agent checkpoint tool schemas", () => {
  it("requires checkpoint context for approvals and exposes snake_case checkpoint inputs", () => {
    const byName = Object.fromEntries(AGENT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(byName.submit_checkpoint).toBeDefined();
    expect(byName.request_decision).toBeDefined();
    expect((byName.request_approval.inputSchema as any).required).toContain("checkpoint");
    expect((byName.request_approval.inputSchema as any).properties.checkpoint.required)
      .toContain("next_step");
    expect((byName.request_decision.inputSchema as any).properties.checkpoint.required)
      .not.toContain("next_step");
    expect((byName.ticket_update.inputSchema as any).required).toEqual([]);
    expect((byName.ticket_update.inputSchema as any).properties.checkpoint.properties)
      .toHaveProperty("key_facts");
    const checkpointProperties = (byName.ticket_update.inputSchema as any)
      .properties.checkpoint.properties;
    expect(checkpointProperties).toHaveProperty("progress");
    // proof_items 并进执行计划（工单 06，D2）。
    expect(checkpointProperties).not.toHaveProperty("proof_items");
    expect(checkpointProperties).toHaveProperty("artifacts");
    expect(checkpointProperties).not.toHaveProperty("keyFacts");
    expect(checkpointProperties).not.toHaveProperty("proofItems");
    expect(checkpointProperties.artifacts.items.required).toEqual([
      "ref", "name", "kind", "media_type",
    ]);
    expect(checkpointProperties.artifacts.items.properties).toHaveProperty("relative_path");
    expect(checkpointProperties.artifacts.items.properties).not.toHaveProperty("relativePath");
  });
});

describe("submit_checkpoint", () => {
  it("maps exact snake_case wire fields to camelCase domain fields", async () => {
    const result = await handlers().call("submit_checkpoint", checkpoint("Mapped once")) as any;

    expect(result).toEqual({
      checkpoint_id: expect.any(Number),
      created_at: "2026-07-24T08:00:00.000Z",
      deduplicated: false,
    });
    expect(db.prepare(
      `SELECT kind, stage, key_facts, artifact_refs, related_item_ids, next_step
       FROM checkpoints WHERE id=?`,
    ).get(result.checkpoint_id)).toEqual({
      kind: "progress",
      stage: "implementation",
      key_facts: JSON.stringify([{ label: "tests", value: "running" }]),
      artifact_refs: JSON.stringify(["artifact:test-log"]),
      related_item_ids: "[]",
      next_step: "Continue verification",
    });
  });

  it("persists progress and immutable artifact metadata from snake_case input", async () => {
    writeFileSync(join(workdir, "report.md"), "artifact bytes\n");
    const result = await handlers().call("submit_checkpoint", {
      ...checkpoint("Structured checkpoint", "milestone"),
      artifact_refs: [],
      progress: { current: 3, total: 5, label: "Protocol coverage" },
      artifacts: [artifactRegistration()],
    }) as any;

    expect(db.prepare(
      `SELECT artifact_refs, progress_current, progress_total, progress_label, proof_items
       FROM checkpoints WHERE id=?`,
    ).get(result.checkpoint_id)).toEqual({
      artifact_refs: JSON.stringify(["report"]),
      progress_current: 3,
      progress_total: 5,
      progress_label: "Protocol coverage",
      proof_items: "[]",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_proof_items").get()).toEqual({ n: 0 });
    expect(db.prepare(
      `SELECT ref, name, kind, media_type, description, availability, byte_length, sha256,
              checkpoint_id
       FROM artifacts`,
    ).get()).toEqual({
      ref: "report",
      name: "report.md",
      kind: "report",
      media_type: "text/markdown",
      description: "Durable checkpoint report",
      availability: "available",
      byte_length: Buffer.byteLength("artifact bytes\n"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      checkpoint_id: result.checkpoint_id,
    });
  });

  it("returns exact duplicates, rate limits new progress, and lets terminal kinds bypass", async () => {
    const tool = handlers();
    const first = await tool.call("submit_checkpoint", checkpoint("Same progress")) as any;
    now = new Date("2026-07-24T08:00:30.000Z");
    const duplicate = await tool.call("submit_checkpoint", checkpoint("Same progress")) as any;
    expect(duplicate).toEqual({
      checkpoint_id: first.checkpoint_id,
      created_at: first.created_at,
      deduplicated: true,
    });

    now = new Date("2026-07-24T08:01:00.000Z");
    await expect(tool.call("submit_checkpoint", checkpoint("Different progress")))
      .rejects.toThrow(/rate_limited/i);

    for (const [kind, summary] of [
      ["decision", "Direction changed"],
      ["blocked", "Work cannot continue"],
      ["completed", "Execution is complete"],
    ] as const) {
      now = new Date(now.getTime() + 1_000);
      await expect(tool.call("submit_checkpoint", checkpoint(summary, kind))).resolves.toMatchObject({
        checkpoint_id: expect.any(Number),
        deduplicated: false,
      });
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n).toBe(4);
  });

  it("uses staged artifact bytes in standalone checkpoint idempotency", async () => {
    writeFileSync(join(workdir, "report.md"), "standalone v1\n");
    const input = {
      ...checkpoint("Standalone artifact identity", "milestone"),
      artifact_refs: [],
      artifacts: [artifactRegistration()],
    };
    const first = await handlers().call("submit_checkpoint", input) as any;
    const replay = await handlers().call("submit_checkpoint", input) as any;
    expect(replay).toEqual({ ...first, deduplicated: true });
    expect(db.prepare("SELECT idempotency_key FROM checkpoints WHERE id=?").get(first.checkpoint_id))
      .toEqual({ idempotency_key: expect.stringMatching(/^submit-checkpoint:/) });

    mkdirSync(join(workdir, "alternate"));
    writeFileSync(join(workdir, "alternate", "report.md"), "standalone v1\n");
    await expect(handlers().call("submit_checkpoint", {
      ...input,
      artifacts: [{ ...artifactRegistration("alternate/report.md") }],
    })).rejects.toThrow(/artifact|content|ref|conflict|changed/i);

    writeFileSync(join(workdir, "report.md"), "standalone v2 changed bytes\n");
    await expect(handlers().call("submit_checkpoint", input))
      .rejects.toThrow(/artifact|content|ref|conflict|changed/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 1 });
  });

  it("does not let exact-dedupe bypass active run ownership", async () => {
    const tool = handlers();
    await tool.call("submit_checkpoint", checkpoint("Owned progress"));
    updateRun(db, runId, { state: "finished", endedAt: true });

    await expect(tool.call("submit_checkpoint", checkpoint("Owned progress")))
      .rejects.toThrow(/active|current|run/i);
  });

  it("rejects invalid kind payloads, authority injection, and obvious secrets", async () => {
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Delegated"), kind: "delegation", related_ticket_ids: [],
    })).rejects.toThrow(/related item/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Blocked"), kind: "blocked", next_step: "",
    })).rejects.toThrow(/blocked|next_step/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Injected"), action_ref: { type: "approval", id: 1 },
    })).rejects.toThrow(/unknown property|action_ref/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("API_TOKEN=secret-value"),
    })).rejects.toThrow(/secret/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Safe summary"), artifact_refs: ["sk_live_1234567890"],
    })).rejects.toThrow(/secret/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Safe summary"),
      progress: { current: 1, total: 2, label: "API_TOKEN=secret-value" },
    })).rejects.toThrow(/secret/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Safe summary"),
      artifacts: [{ ...artifactRegistration(null), name: "password=secret-value" }],
    })).rejects.toThrow(/secret/i);
    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("x".repeat(2_001)),
    })).rejects.toThrow(/summary/i);
  });

  it("preflights every artifact and quota before any database mutation or blob creation", async () => {
    writeFileSync(join(workdir, "report.md"), "valid first artifact\n");
    const before = {
      item: getItem(db, itemId),
      activities: (db.prepare("SELECT COUNT(*) AS n FROM activities").get() as any).n,
      checkpoints: (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n,
      outbox: (db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get() as any).n,
    };

    await expect(handlers().call("ticket_update", {
      body_append: "must not persist",
      status: "review",
      reason: "staging should fail",
      checkpoint: {
        ...checkpoint("Artifact staging must be all-or-nothing", "completed"),
        artifact_refs: [],
        artifacts: [
          artifactRegistration(),
          { ...artifactRegistration("missing.md"), ref: "missing", name: "missing.md" },
        ],
      },
    })).rejects.toThrow(/missing|path|artifact source/i);

    expect(getItem(db, itemId)).toEqual(before.item);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities").get())
      .toEqual({ n: before.activities });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get())
      .toEqual({ n: before.checkpoints });
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_proof_items").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_cards").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM kv").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get())
      .toEqual({ n: before.outbox });
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual([]);

    await expect(handlers().call("submit_checkpoint", {
      ...checkpoint("Quota failure", "milestone"),
      artifact_refs: [],
      artifacts: Array.from({ length: 21 }, (_, index) => ({
        ...artifactRegistration(null),
        ref: `report/${index}`,
        name: `report-${index}.md`,
      })),
    })).rejects.toThrow(/20|quota/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get())
      .toEqual({ n: before.checkpoints });
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual([]);
  });

  it("rejects a run that does not belong to the caller item", async () => {
    const otherItemId = createItem(db, { title: "other", brief: "b", createdBy: "system" });
    const otherRunId = createRun(db, { itemId: otherItemId, runtime: "codex" });
    updateRun(db, otherRunId, { state: "running" });

    await expect(createAgentToolHandlers({
      db,
      itemId,
      runId: otherRunId,
      now: () => now,
      checkpointPolicy: POLICY,
    }).call("submit_checkpoint", checkpoint("Wrong owner")))
      .rejects.toThrow(/does not belong/i);
  });
});

describe("critical child mutations", () => {
  it("requires a completed checkpoint for review and commits body, status, checkpoint, and outbox atomically", async () => {
    const tool = handlers();
    await expect(tool.call("ticket_update", { status: "review" }))
      .rejects.toThrow(/completed checkpoint/i);
    await expect(tool.call("ticket_update", {
      body_append: "not complete",
      status: "review",
      checkpoint: checkpoint("Still working", "milestone"),
    })).rejects.toThrow(/completed checkpoint/i);
    expect(getItem(db, itemId)).toMatchObject({ stage: "active", body: "" });

    const input = {
      body_append: "Durable handoff context",
      status: "review",
      reason: "implementation complete",
      checkpoint: checkpoint("All acceptance checks pass", "completed"),
    };
    const result = await tool.call("ticket_update", input) as any;
    expect(result).toMatchObject({
      ticket_id: itemId,
      status: "review",
      checkpoint_id: expect.any(Number),
      outcome_snapshot_id: expect.any(Number),
    });
    expect(db.prepare(
      `SELECT executor_run_id, completion_checkpoint_id, source, summary, completeness,
              missing_fields_json
       FROM outcome_snapshots WHERE id=?`,
    ).get(result.outcome_snapshot_id)).toEqual({
      executor_run_id: runId,
      completion_checkpoint_id: result.checkpoint_id,
      source: "agent_reported",
      summary: "All acceptance checks pass",
      completeness: "partial",
      missing_fields_json: JSON.stringify(["changes", "deliverables", "validations"]),
    });
    expect(getItem(db, itemId)).toMatchObject({
      stage: "review",
      body: expect.stringContaining("Durable handoff context"),
    });
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([{ event_type: "ticket.updated" }]);

    now = new Date("2026-07-24T08:05:00.000Z");
    const replay = await tool.call("ticket_update", input) as any;
    expect(replay).toEqual(result);
    expect(getItem(db, itemId)?.body).toBe("Durable handoff context");
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get() as any).n).toBe(1);
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([{ event_type: "ticket.updated" }]);
    await expect(tool.call("ticket_update", {
      ...input,
      body_append: "Conflicting handoff context",
    })).rejects.toThrow(/replay conflict/i);
    await expect(tool.call("ticket_update", {
      ...input,
      reason: "different completion reason",
    })).rejects.toThrow(/replay conflict/i);
  });

  it("atomically registers a complete outcome snapshot from completed handoff outcome", async () => {
    const input = {
      status: "review",
      reason: "implementation complete",
      checkpoint: {
        ...checkpoint("Complete with structured outcome", "completed"),
        outcome: {
          summary: "Implemented the task completion protocol.",
          changes: [
            { kind: "file", ref: "src/store/outcomes.ts", summary: "Added outcome ledger" },
          ],
          deliverables: [
            { kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" },
          ],
          validations: [
            {
              command: "npm run typecheck",
              outcome: "passed",
              exitCode: 0,
              summary: "TypeScript passed",
              evidenceRef: null,
            },
          ],
        },
      },
    };

    const result = await handlers().call("ticket_update", input) as any;

    expect(db.prepare(
      `SELECT source, summary, changes_json, deliverables_json, validations_json,
              completeness, missing_fields_json
       FROM outcome_snapshots WHERE id=?`,
    ).get(result.outcome_snapshot_id)).toEqual({
      source: "agent_reported",
      summary: "Implemented the task completion protocol.",
      changes_json: JSON.stringify([
        { kind: "file", ref: "src/store/outcomes.ts", summary: "Added outcome ledger" },
      ]),
      deliverables_json: JSON.stringify([
        { kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" },
      ]),
      validations_json: JSON.stringify([
        {
          command: "npm run typecheck",
          outcome: "passed",
          exitCode: 0,
          summary: "TypeScript passed",
          evidenceRef: null,
        },
      ]),
      completeness: "complete",
      missing_fields_json: "[]",
    });
  });

  // 工单 07（spec D3）：一个枚举值不再作废整份成果。ticket_update 登记成功，诊断记进账本。
  it("registers a handoff outcome with a synonym validation value and records a diagnostic", async () => {
    const result = await handlers().call("ticket_update", {
      status: "review",
      reason: "implementation complete",
      checkpoint: {
        ...checkpoint("Complete with structured outcome", "completed"),
        outcome: {
          summary: "Implemented the task completion protocol.",
          changes: [],
          deliverables: [],
          validations: [{
            command: "npm run e2e", outcome: "pass", exitCode: 0, summary: "E2E passed", evidenceRef: null,
          }],
        },
      },
    }) as any;

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(JSON.parse((db.prepare("SELECT validations_json FROM outcome_snapshots WHERE id=?")
      .get(result.outcome_snapshot_id) as { validations_json: string }).validations_json)[0].outcome).toBe("passed");
    const decision = db.prepare(
      `SELECT payload FROM activities
       WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='outcome_normalized'`,
    ).get(runId) as { payload: string };
    expect(JSON.parse(decision.payload)).toEqual({
      decision: "outcome_normalized",
      snapshotId: result.outcome_snapshot_id,
      diagnostics: [{
        field: "outcome.validations[0].outcome", code: "synonym_mapped",
        received: "pass", normalized: "passed", reason: null,
      }],
    });
  });

  it("requires a blocked checkpoint with next_step and rolls back every write on failure", async () => {
    const tool = handlers();
    await expect(tool.call("ticket_update", {
      status: "blocked",
      checkpoint: { ...checkpoint("Blocked", "blocked"), next_step: "" },
    })).rejects.toThrow(/next_step/i);

    db.exec(`
      CREATE TRIGGER fail_atomic_item_update
      BEFORE INSERT ON gateway_events
      BEGIN
        SELECT RAISE(FAIL, 'outbox unavailable');
      END;
    `);
    await expect(tool.call("ticket_update", {
      body_append: "must roll back",
      status: "blocked",
      checkpoint: checkpoint("Waiting for dependency", "blocked"),
    })).rejects.toThrow(/outbox unavailable/i);
    expect(getItem(db, itemId)).toMatchObject({ stage: "active", body: "" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as any).n).toBe(0);
  });

  it("turns a blocked ticket_update into one Lead blocker, without a user notification", async () => {
    const tool = handlers();
    const input = {
      status: "blocked",
      checkpoint: {
        ...checkpoint("Daemon socket is unavailable", "blocked"),
        key_facts: [{ label: "影响", value: "当前执行无法进入 Review。" }],
        next_step: "检查 daemon 状态后再决定是否重试。",
      },
    };

    await tool.call("ticket_update", input);
    await tool.call("ticket_update", input);

    const blockers = listInbox(db, { severity: "blocker" });
    expect(blockers).toHaveLength(1);
    expect(JSON.parse(blockers[0]!.payload)).toMatchObject({
      kind: "blocker",
      blockerCode: "blocked_checkpoint",
      summary: "Daemon socket is unavailable",
      impact: "当前执行无法进入 Review。",
      nextStep: "检查 daemon 状态后再决定是否重试。",
      // agent 报告的阻塞先交给 Lead（2026-10-15 起）：它能答的自己答，答不了再找用户。
      needsUser: false,
    });
    expect(listNotifications(db, { itemId, urgency: "immediate" })).toEqual([]);
  });

  it.each([
    ["body", "items", "BEFORE UPDATE ON items WHEN NEW.body IS NOT OLD.body"],
    ["stage", "items", "BEFORE UPDATE ON items WHEN NEW.stage IS NOT OLD.stage"],
    [
      "transition activity",
      "activities",
      "BEFORE INSERT ON activities WHEN NEW.kind='transition' AND json_extract(NEW.payload, '$.to')='review'",
    ],
    ["checkpoint", "checkpoints", "BEFORE INSERT ON checkpoints"],
    ["artifact", "artifacts", "BEFORE INSERT ON artifacts"],
    [
      "checkpoint activity",
      "activities",
      "BEFORE INSERT ON activities WHEN json_extract(NEW.payload, '$.checkpointId') IS NOT NULL",
    ],
    ["card", "conversation_cards", "BEFORE INSERT ON conversation_cards"],
    [
      "item touch",
      "items",
      "BEFORE UPDATE ON items WHEN NEW.last_activity_at IS NOT OLD.last_activity_at",
    ],
    [
      "receipt",
      "kv",
      "BEFORE INSERT ON kv WHEN NEW.key LIKE 'agent-tool-receipt:v1:%'",
    ],
    ["outbox", "gateway_events", "BEFORE INSERT ON gateway_events"],
  ] as const)("rolls back the full ticket_update when %s persistence fails", async (_label, table, clause) => {
    writeFileSync(join(workdir, "report.md"), `failure at ${table}\n`);
    const activityCount = (db.prepare("SELECT COUNT(*) AS n FROM activities").get() as any).n;
    db.exec(`
      CREATE TRIGGER fail_item_update_${table.replaceAll("_", "")}
      ${clause}
      BEGIN
        SELECT RAISE(FAIL, '${table} unavailable');
      END;
    `);

    await expect(handlers().call("ticket_update", {
      invocation_id: `atomic-${table}`,
      body_append: "must roll back",
      status: "review",
      reason: "atomicity injection",
      checkpoint: {
        ...checkpoint("Atomic completion", "completed"),
        artifact_refs: [],
        progress: { current: 1, total: 1, label: "Atomicity" },
        artifacts: [artifactRegistration()],
      },
    })).rejects.toThrow(new RegExp(`${table} unavailable`, "i"));

    expect(getItem(db, itemId)).toMatchObject({
      stage: "active",
      body: "",
      last_activity_at: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities").get()).toEqual({ n: activityCount });
    for (const domainTable of [
      "checkpoints",
      "artifacts",
      "conversation_cards",
      "kv",
      "gateway_events",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${domainTable}`).get()).toEqual({ n: 0 });
    }
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual([]);
  });

  it("keeps legacy body-only updates while requiring at least one mutation", async () => {
    await expect(handlers().call("ticket_update", {})).rejects.toThrow(/at least one/i);
    await handlers().call("ticket_update", { body_append: "handoff only" });
    expect(getItem(db, itemId)?.body).toContain("handoff only");
  });

  it("replays a body-only mutation from a persistent receipt after a lost response", async () => {
    const input = {
      invocation_id: "ticket-update-body-1",
      body_append: "durable body-only handoff",
    };
    const first = await handlers().call("ticket_update", input) as any;

    now = new Date("2026-07-24T10:00:00.000Z");
    const replay = await handlers().call("ticket_update", input) as any;

    expect(replay).toEqual(first);
    expect(getItem(db, itemId)?.body).toBe("durable body-only handoff");
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND kind='milestone'",
    ).get(itemId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get()).toEqual({ n: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'agent-tool-receipt:v1:%'",
    ).get()).toEqual({ n: 1 });

    await expect(handlers().call("ticket_update", {
      invocation_id: "ticket-update-body-1",
      body_append: "changed body-only handoff",
    })).rejects.toThrow(/request payload changed/i);
    expect(getItem(db, itemId)?.body).toBe("durable body-only handoff");
  });

  it("replays checkpoint-less status mutations and rejects changed status or reason", async () => {
    transition(db, {
      itemId,
      to: "blocked",
      actor: "system",
      reason: "fixture blocker",
      runId,
    });
    const input = {
      invocation_id: "ticket-update-status-1",
      status: "active",
      reason: "dependency recovered",
    };
    const first = await handlers().call("ticket_update", input) as any;

    now = new Date("2026-07-24T10:05:00.000Z");
    const replay = await handlers().call("ticket_update", input) as any;
    expect(replay).toEqual(first);
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND kind='transition'",
      // 3 而不是 4：夹具里 ready->active 现在是一条边（旧的 backlog->assigned->in_progress 是两条），
      // 加上 active->blocked 与本用例的 blocked->active。重放不再写第四条，这才是被测的性质。
    ).get(itemId)).toEqual({ n: 3 });

    await expect(handlers().call("ticket_update", {
      invocation_id: "ticket-update-status-1",
      status: "review",
      reason: "dependency recovered",
    })).rejects.toThrow(/request payload changed/i);
    await expect(handlers().call("ticket_update", {
      invocation_id: "ticket-update-status-1",
      status: "active",
      reason: "different reason",
    })).rejects.toThrow(/request payload changed/i);
  });
});

describe("approval and decision tools", () => {
  it("fails closed without approval checkpoint context and creates authority atomically", async () => {
    await expect(handlers().call("request_approval", {
      tool: "send_email", action: "Send the report", payload: { recipient: "user@example.com" },
    })).rejects.toThrow(/checkpoint/i);

    const controller = new AbortController();
    controller.abort();
    const result = await handlers().call("request_approval", {
      tool: "send_email",
      action: "Send the report",
      payload: { recipient: "user@example.com" },
      checkpoint: {
        title: "Waiting for send approval",
        summary: "The report is ready but sending is irreversible.",
        next_step: "Send only after approval.",
      },
    }, controller.signal) as any;

    expect(result).toMatchObject({
      approval_id: expect.any(Number),
      status: "aborted",
      checkpoint_id: expect.any(Number),
    });
    expect(db.prepare(
      "SELECT kind, action_type, action_id FROM checkpoints WHERE id=?",
    ).get(result.checkpoint_id)).toEqual({
      kind: "blocked",
      action_type: "approval",
      action_id: result.approval_id,
    });
  });

  it("maps request_decision wire fields and returns immediately when non-blocking", async () => {
    const result = await handlers().call("request_decision", {
      kind: "decision",
      audience: "lead_or_user",
      blocking: false,
      allow_custom: true,
      prompt: "Choose the rollout strategy",
      options: [{ id: "canary", label: "Canary", description: "Start with 10%" }],
      checkpoint: {
        title: "Rollout choice required",
        summary: "Implementation is complete; rollout strategy changes the validation path.",
      },
    }) as any;

    expect(result).toMatchObject({
      request_id: expect.any(Number),
      status: "pending",
      checkpoint_id: expect.any(Number),
    });
    expect(getDecisionRequest(db, result.request_id)).toMatchObject({
      kind: "decision",
      audience: "lead_or_user",
      blocking: false,
      allowCustom: true,
      options: [{ id: "canary", label: "Canary", description: "Start with 10%" }],
    });
  });
});
