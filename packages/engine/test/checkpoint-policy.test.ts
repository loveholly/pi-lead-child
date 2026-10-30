import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_POLICY_DEFAULTS,
  loadCheckpointPolicyConfig,
} from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  checkpointReminderDue,
  enforceStandaloneCheckpointPolicy,
  readCheckpointPolicyState,
} from "../src/coordinator/checkpoint-policy.js";
import { commitStagedArtifacts, stageArtifact } from "@pi-lead-child/store";
import { insertCheckpoint } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { openDb } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";

describe("checkpoint policy configuration", () => {
  it("uses the six documented defaults and accepts positive integer overrides", () => {
    expect(loadCheckpointPolicyConfig({})).toEqual(CHECKPOINT_POLICY_DEFAULTS);
    expect(loadCheckpointPolicyConfig({
      PLC_CHECKPOINT_DEDUPE_WINDOW_MS: "1",
      PLC_CHECKPOINT_PROGRESS_MIN_INTERVAL_MS: "2",
      PLC_CHECKPOINT_SILENCE_MS: "3",
      PLC_CHECKPOINT_SILENCE_TOOL_EVENTS: "4",
      PLC_CHECKPOINT_SILENCE_DOMAIN_EVENTS: "5",
      PLC_CHECKPOINT_REMINDER_COOLDOWN_MS: "6",
    })).toEqual({
      dedupeWindowMs: 1,
      progressMinIntervalMs: 2,
      silenceMs: 3,
      silenceToolEvents: 4,
      silenceDomainEvents: 5,
      reminderCooldownMs: 6,
    });
  });

  it.each(["0", "-1", "1.5", "nope", "Infinity"])(
    "rejects invalid checkpoint policy value %s",
    (value) => {
      expect(() => loadCheckpointPolicyConfig({ PLC_CHECKPOINT_SILENCE_MS: value }))
        .toThrow(/PLC_CHECKPOINT_SILENCE_MS/);
    },
  );
});

describe("persisted checkpoint silence state", () => {
  it("reconstructs tool, domain, child, checkpoint cursor, and reminder counters from SQLite", () => {
    const db = openDb(join(tempDir("plc-checkpoint-policy-"), "plc.db"));
    const itemId = createItem(db, { title: "policy", brief: "state", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "pi" });
    updateRun(db, runId, { state: "running" });
    db.prepare("UPDATE runs SET started_at=? WHERE id=?")
      .run("2026-07-24T08:00:00.000Z", runId);

    for (const [seq, occurredAt] of [
      [1, "2026-07-24T08:01:00.000Z"],
      [2, "2026-07-24T08:02:00.000Z"],
    ] as const) {
      db.prepare(
        `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
         VALUES (?, ?, 'tool.completed', '{}', ?)`,
      ).run(runId, seq, occurredAt);
    }
    insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "milestone",
      title: "Phase complete",
      summary: "The first phase is complete.",
    }, { now: new Date("2026-07-24T08:03:00.000Z") });
    for (const [seq, occurredAt] of [
      [3, "2026-07-24T08:04:00.000Z"],
      [4, "2026-07-24T08:05:00.000Z"],
      [5, "2026-07-24T08:06:00.000Z"],
    ] as const) {
      db.prepare(
        `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
         VALUES (?, ?, 'tool.completed', '{}', ?)`,
      ).run(runId, seq, occurredAt);
    }
    db.prepare(
      `INSERT INTO activities (item_id, run_id, actor, kind, payload, created_at)
       VALUES (?, ?, 'child', 'transition', '{}', ?)`,
    ).run(itemId, runId, "2026-07-24T08:07:00.000Z");
    const childId = createItem(db, {
      title: "child", brief: "delegated", createdBy: "child",
      parentItemId: itemId, rootItemId: itemId, createdByRunId: runId,
    });
    db.prepare("UPDATE items SET created_at=? WHERE id=?")
      .run("2026-07-24T08:08:00.000Z", childId);
    db.prepare(
      `INSERT INTO activities (item_id, run_id, actor, kind, payload, created_at)
       VALUES (?, ?, 'system', 'notification', ?, ?)`,
    ).run(
      itemId,
      runId,
      JSON.stringify({ kind: "checkpoint_reminder" }),
      "2026-07-24T08:09:00.000Z",
    );

    const state = readCheckpointPolicyState(db, { itemId, runId });
    expect(state).toEqual({
      runStartedAt: "2026-07-24T08:00:00.000Z",
      lastCheckpointAt: "2026-07-24T08:03:00.000Z",
      lastCheckpointRuntimeSeq: 2,
      completedToolEventsSinceCheckpoint: 3,
      domainEventsSinceCheckpoint: 1,
      childItemsSinceCheckpoint: 1,
      reminderSentAt: "2026-07-24T08:09:00.000Z",
    });
  });

  it("applies silence thresholds and persisted reminder cooldown deterministically", () => {
    const config = {
      ...CHECKPOINT_POLICY_DEFAULTS,
      silenceMs: 15 * 60_000,
      silenceToolEvents: 3,
      silenceDomainEvents: 2,
      reminderCooldownMs: 15 * 60_000,
    };
    const base = {
      runStartedAt: "2026-07-24T08:00:00.000Z",
      lastCheckpointAt: "2026-07-24T08:03:00.000Z",
      lastCheckpointRuntimeSeq: 2,
      completedToolEventsSinceCheckpoint: 3,
      domainEventsSinceCheckpoint: 0,
      childItemsSinceCheckpoint: 0,
      reminderSentAt: null,
    };
    expect(checkpointReminderDue(base, config, new Date("2026-07-24T08:18:00.000Z")))
      .toBe(true);
    expect(checkpointReminderDue({
      ...base,
      reminderSentAt: "2026-07-24T08:17:00.000Z",
    }, config, new Date("2026-07-24T08:18:00.000Z"))).toBe(false);
    expect(checkpointReminderDue({
      ...base,
      completedToolEventsSinceCheckpoint: 0,
      domainEventsSinceCheckpoint: 1,
      childItemsSinceCheckpoint: 1,
    }, config, new Date("2026-07-24T08:04:00.000Z"))).toBe(true);
  });

  it("treats SQLite datetime values as UTC when evaluating silence", () => {
    const state = {
      runStartedAt: "2026-07-24 08:00:00",
      lastCheckpointAt: null,
      lastCheckpointRuntimeSeq: null,
      completedToolEventsSinceCheckpoint: 8,
      domainEventsSinceCheckpoint: 0,
      childItemsSinceCheckpoint: 0,
      reminderSentAt: null,
    };
    expect(checkpointReminderDue(state, CHECKPOINT_POLICY_DEFAULTS, new Date("2026-07-24T08:14:59.000Z")))
      .toBe(false);
    expect(checkpointReminderDue(state, CHECKPOINT_POLICY_DEFAULTS, new Date("2026-07-24T08:15:00.000Z")))
      .toBe(true);
  });
});

describe("checkpoint semantic identity", () => {
  it("includes progress, proof updates, and staged artifact SHA/byte length", () => {
    const dataDir = tempDir("plc-checkpoint-policy-identity-");
    const workdir = join(dataDir, "workdir");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "report.md"), "identity bytes\n");
    const db = openDb(join(dataDir, "plc.db"));
    const itemId = createItem(db, {
      title: "identity", brief: "structured checkpoint identity", createdBy: "system", workdir,
    });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const staged = stageArtifact(db, {
      dataDir,
      itemId,
      runId,
      ref: "report",
      name: "report.md",
      kind: "report",
      mediaType: "text/markdown",
      description: "Identity report",
      relativePath: "report.md",
    });
    const checkpoint = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "milestone",
      title: "Structured checkpoint",
      summary: "Progress, proof, and artifacts form one semantic identity.",
      progress: { current: 3, total: 5, label: "Coverage" },
      proofItems: [{
        id: "auth",
        label: "Authorization boundary",
        state: "passed",
        evidence: "tests pass",
      }],
      artifactRefs: ["report"],
    }, { now: new Date("2026-07-24T08:00:00.000Z") });
    commitStagedArtifacts(db, checkpoint.id, [staged]);

    const input = {
      itemId,
      runId,
      kind: "milestone" as const,
      title: "Structured checkpoint",
      summary: "Progress, proof, and artifacts form one semantic identity.",
      progress: { current: 3, total: 5, label: "Coverage" },
      proofItems: [{
        id: "auth",
        label: "Authorization boundary",
        state: "passed" as const,
        evidence: "tests pass",
      }],
      artifactRefs: ["report"],
      artifactIdentities: [{
        ref: "report",
        sha256: staged.sha256,
        byteLength: staged.byteLength,
      }],
    };

    expect(enforceStandaloneCheckpointPolicy(
      db,
      input,
      CHECKPOINT_POLICY_DEFAULTS,
      new Date("2026-07-24T08:00:30.000Z"),
    )?.id).toBe(checkpoint.id);
    expect(enforceStandaloneCheckpointPolicy(
      db,
      { ...input, progress: { current: 4, total: 5, label: "Coverage" } },
      CHECKPOINT_POLICY_DEFAULTS,
      new Date("2026-07-24T08:00:30.000Z"),
    )).toBeNull();
    expect(enforceStandaloneCheckpointPolicy(
      db,
      { ...input, proofItems: [{ ...input.proofItems[0]!, evidence: "different evidence" }] },
      CHECKPOINT_POLICY_DEFAULTS,
      new Date("2026-07-24T08:00:30.000Z"),
    )).toBeNull();
    expect(enforceStandaloneCheckpointPolicy(
      db,
      {
        ...input,
        artifactIdentities: [{
          ref: "report",
          sha256: "f".repeat(64),
          byteLength: staged.byteLength,
        }],
      },
      CHECKPOINT_POLICY_DEFAULTS,
      new Date("2026-07-24T08:00:30.000Z"),
    )).toBeNull();
  });
});
