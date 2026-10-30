import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { repairDaemonStartupState } from "../src/server.js";
import {
  recoverOutcomeSnapshot,
  recordInvalidOutcomeEnvelope,
  recordOutcomeRegistrationMissing,
  registerOutcomeForRun,
  repairOutcomeSnapshots,
  ticketUpdateAttempted,
} from "@pi-lead-child/engine";
import { getRun } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { raiseBlockerFromCheckpoint, repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { getCheckpoint } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

let db: Db;
let workdir: string;
let now: Date;

beforeEach(() => {
  const dir = tempDir("plc-outcome-recovery-");
  workdir = join(dir, "workdir");
  db = openDb(join(dir, "plc.db"));
  now = new Date("2026-08-17T08:00:00.000Z");
});

function activeRunFixture() {
  const itemId = createItem(db, {
    title: "outcome",
    brief: "recover",
    createdBy: "system",
    workdir,
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  return { itemId, runId };
}

// 工单 07 起，规范化对输入宽松：未知的枚举值降级成 not_run，不再作废信封。
// 仍然作废整份信封的只有 summary 缺失或无效，所以无效信封的样本用空 summary。
function invalidOutcomeLine(summary = "") {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary,
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm test",
      outcome: "passed",
      exitCode: 0,
      summary: "tests passed",
      evidenceRef: null,
    }],
  })}`;
}

function unknownValidationOutcomeLine(outcome = "success") {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary: "Looked finished",
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm test",
      outcome,
      exitCode: 0,
      summary: "tests passed",
      evidenceRef: null,
    }],
  })}`;
}

function outcomeLine(summary = "Recovered implementation") {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary,
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Added ledger" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm run typecheck",
      outcome: "passed",
      exitCode: 0,
      summary: "typecheck passed",
      evidenceRef: null,
    }],
  })}`;
}

function toolEvent(
  runId: number,
  seq: number,
  eventType: "tool.started" | "tool.completed" | "tool.failed",
  name: string,
) {
  db.prepare(
    `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, seq, eventType, JSON.stringify({
    type: eventType,
    runId,
    seq,
    occurredAt: now.toISOString(),
    callId: `call-${seq}`,
    name,
    ...(eventType === "tool.started" ? { args: { status: "review" } } : {}),
    ...(eventType === "tool.failed" ? { error: "lost receipt" } : {}),
  }), now.toISOString());
}

function assistantMessage(runId: number, seq: number, text: string, stopReason = "stop") {
  db.prepare(
    `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
     VALUES (?, ?, 'message.completed', ?, ?)`,
  ).run(runId, seq, JSON.stringify({
    type: "message.completed",
    runId,
    seq,
    occurredAt: now.toISOString(),
    messageId: `m-${seq}`,
    role: "assistant",
    text,
    stopReason,
  }), now.toISOString());
}

describe("outcome snapshot recovery", () => {
  it("recovers the last valid terminal envelope and advances active items to review", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, `${outcomeLine("old")}\n${outcomeLine("latest")}`);

    const result = recoverOutcomeSnapshot(db, { itemId, runId, at: now });

    expect(result).toMatchObject({
      status: "recovered",
      completeness: "complete",
      transitionedToReview: true,
    });
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare(
      `SELECT source, source_event_seq, summary, completeness
       FROM outcome_snapshots WHERE executor_run_id=?`,
    ).get(runId)).toEqual({
      source: "system_recovered",
      source_event_seq: 1,
      summary: "latest",
      completeness: "complete",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_verdicts").get()).toEqual({ n: 0 });
  });

  it("does not register a live text envelope unless ticket_update was attempted", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, outcomeLine("text only"));

    expect(ticketUpdateAttempted(db, runId)).toBe(false);
    expect(recoverOutcomeSnapshot(db, {
      itemId,
      runId,
      at: now,
      textRecovery: "if_ticket_update_attempted",
    })).toMatchObject({
      status: "no_envelope",
      snapshotId: null,
      transitionedToReview: false,
    });
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
  });

  it("uses a text envelope as backup after a lost ticket_update receipt", () => {
    const { itemId, runId } = activeRunFixture();
    toolEvent(runId, 1, "tool.started", "mcp__plc__ticket_update");
    toolEvent(runId, 2, "tool.failed", "mcp__plc__ticket_update");
    assistantMessage(runId, 3, outcomeLine("backup after lost receipt"));

    expect(ticketUpdateAttempted(db, runId)).toBe(true);
    expect(recoverOutcomeSnapshot(db, {
      itemId,
      runId,
      at: now,
      textRecovery: "if_ticket_update_attempted",
    })).toMatchObject({
      status: "recovered",
      completeness: "complete",
      transitionedToReview: true,
    });
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("runs startup outcome repair before terminal handoff failure repair", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, outcomeLine());

    expect(repairDaemonStartupState(db, now)).toMatchObject({
      outcomes: 1,
      handoffs: 0,
    });
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key LIKE 'run-handoff-failed:%'",
    ).get()).toEqual({ n: 0 });
  });

  it("falls through to handoff failure when an active finished run has no envelope", () => {
    const { itemId } = activeRunFixture();

    expect(repairDaemonStartupState(db, now)).toMatchObject({
      outcomes: 0,
      handoffs: 1,
    });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
  });

  it("records missing outcome registration for review without moving the item backward", () => {
    const { itemId, runId } = activeRunFixture();
    transition(db, {
      itemId,
      to: "review",
      actor: "system",
      reason: "legacy completed without outcome",
      runId,
      now,
    });

    expect(recordOutcomeRegistrationMissing(db, { itemId, runId, at: now })).toBe(true);
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare(
      "SELECT kind, idempotency_key FROM checkpoints WHERE item_id=? ORDER BY id DESC LIMIT 1",
    ).get(itemId)).toEqual({
      kind: "blocked",
      idempotency_key: `outcome-registration-missing:${runId}`,
    });
  });

  it("never reopens an accepted done item for missing outcome registration", () => {
    const { itemId, runId } = activeRunFixture();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);

    expect(recordOutcomeRegistrationMissing(db, { itemId, runId, at: now })).toBe(false);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`outcome-registration-missing:${runId}`)).toEqual({ n: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE item_id=? AND kind='outcome_registration_missing'",
    ).get(itemId)).toEqual({ n: 0 });
  });

  it("does not backfill user-facing blockers for runs completed before the outcome feature rollout", () => {
    const { itemId, runId } = activeRunFixture();
    transition(db, { itemId, to: "review", actor: "system", reason: "legacy review", runId, now });
    db.prepare("UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?").run(runId);

    expect(repairDaemonStartupState(db, now).outcomes).toBe(0);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`outcome-registration-missing:${runId}`)).toEqual({ n: 0 });
  });

  it("explicitly registers a pre-rollout run the automatic sweep will never touch", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, outcomeLine("Implemented the outcome registry"));
    transition(db, { itemId, to: "review", actor: "system", reason: "handoff", runId, now });
    db.prepare("UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?").run(runId);

    // The sweep is cutoff-bound on purpose, so it leaves this run alone forever.
    expect(repairOutcomeSnapshots(db, now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });

    const result = registerOutcomeForRun(db, {
      itemId,
      runId,
      authorityRef: "review-run #43 fail: outcome_snapshots has no row for this run",
      at: now,
    });

    expect(result).toMatchObject({
      status: "registered",
      completeness: "complete",
      snapshotId: expect.any(Number),
    });
    expect(db.prepare(
      `SELECT item_id, executor_run_id, source, summary, completeness, recovery_note
       FROM outcome_snapshots WHERE id=?`,
    ).get(result.snapshotId)).toEqual({
      item_id: itemId,
      executor_run_id: runId,
      source: "system_recovered",
      summary: "Implemented the outcome registry",
      completeness: "complete",
      recovery_note: "Recovered from PLC_OUTCOME_V1 in runtime event seq 1.",
    });
    // Registering the executor's own outcome is not acceptance: no stage change,
    // and no reviewer evidence is manufactured on its behalf.
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_verdicts").get()).toEqual({ n: 0 });
    expect(db.prepare(
      `SELECT json_extract(payload, '$.authorityRef') AS authority
       FROM activities
       WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')='outcome_registered_from_run_evidence'`,
    ).all(itemId)).toEqual([
      { authority: "review-run #43 fail: outcome_snapshots has no row for this run" },
    ]);
  });

  it("is idempotent and never invents an outcome the run did not report", () => {
    const { itemId, runId } = activeRunFixture();
    transition(db, { itemId, to: "review", actor: "system", reason: "handoff", runId, now });

    const authorityRef = "user asked Lead to backfill";
    expect(registerOutcomeForRun(db, { itemId, runId, authorityRef, at: now })).toEqual({
      status: "no_envelope",
      snapshotId: null,
      completeness: null,
      clearedRegistrationBlocker: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });

    assistantMessage(runId, 1, outcomeLine("Late envelope"));
    const first = registerOutcomeForRun(db, { itemId, runId, authorityRef, at: now });
    expect(first.status).toBe("registered");
    expect(registerOutcomeForRun(db, { itemId, runId, authorityRef, at: now })).toEqual({
      status: "already_present",
      snapshotId: first.snapshotId,
      completeness: "complete",
      clearedRegistrationBlocker: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM activities
       WHERE json_extract(payload, '$.decision')='outcome_registered_from_run_evidence'`,
    ).get()).toEqual({ n: 1 });
  });

  it("retracts the actionable blocker when a late envelope answers it", () => {
    const { itemId, runId } = activeRunFixture();
    transition(db, { itemId, to: "review", actor: "system", reason: "handoff", runId, now });
    expect(recordOutcomeRegistrationMissing(db, { itemId, runId, at: now })).toBe(true);
    const blockerKey = `outcome-registration-missing:${runId}`;
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE json_extract(payload, '$.blockerKey')=?`,
    ).get(blockerKey)).toEqual({ n: 1 });

    assistantMessage(runId, 1, outcomeLine("Envelope ingested after the run ended"));
    expect(repairOutcomeSnapshots(db, now)).toBe(1);

    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE json_extract(payload, '$.blockerKey')=?`,
    ).get(blockerKey)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE dedup_key=?")
      .get(`blocker:${blockerKey}`)).toEqual({ n: 0 });
    // The blocked checkpoint is history, not a pending action: it stays.
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?")
      .get(blockerKey)).toEqual({ n: 1 });
  });

  // 工单停在 blocked 时，启动时的 blocker 补发会为同一张检查点再升起一条 blocker。
  // 成果登记以后，这一条和检查点自己的 blocker 一起撤回。检查点本身保留。
  it("retracts the startup copy of a registration blocker together with the blocker", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, invalidOutcomeLine());
    expect(recordInvalidOutcomeEnvelope(db, { itemId, runId, at: now, demoteLatestExecutor: true })).toBe(true);
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    // 启动修复不再给已有 blocker 的检查点补发一条（最终审计，高影响 2）。
    expect(repairMissingBlockerAlerts(db, now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual({ n: 1 });
    // 修复之前的版本已经补发过的副本仍可能留在库里。撤回时要连它一起撤回。
    const checkpoint = db.prepare("SELECT id FROM checkpoints WHERE idempotency_key=?")
      .get(`invalid-outcome-envelope:${runId}`) as { id: number };
    raiseBlockerFromCheckpoint(db, getCheckpoint(db, checkpoint.id)!, { at: now });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual({ n: 2 });

    assistantMessage(runId, 2, outcomeLine("Envelope fixed after the invalid one"));
    expect(recoverOutcomeSnapshot(db, { itemId, runId, at: now })).toMatchObject({
      status: "recovered", clearedRegistrationBlocker: true,
    });

    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?")
      .get(`invalid-outcome-envelope:${runId}`)).toEqual({ n: 1 });
  });

  it("refuses to register an outcome for a run that belongs to another item", () => {
    const { itemId, runId } = activeRunFixture();
    const other = activeRunFixture();
    assistantMessage(runId, 1, outcomeLine());

    expect(() => registerOutcomeForRun(db, {
      itemId: other.itemId,
      runId,
      authorityRef: "wrong owner",
      at: now,
    })).toThrow(/does not belong/i);
    expect(() => registerOutcomeForRun(db, {
      itemId,
      runId,
      authorityRef: "   ",
      at: now,
    })).toThrow(/authority_ref/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
  });

  it("does not throw when the recovered envelope has no usable summary", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, invalidOutcomeLine());

    expect(() => recoverOutcomeSnapshot(db, { itemId, runId, at: now })).not.toThrow();
    expect(recoverOutcomeSnapshot(db, { itemId, runId, at: now })).toMatchObject({
      status: "invalid_envelope",
      snapshotId: null,
      completeness: null,
      transitionedToReview: false,
      reason: "outcome.summary must be a non-empty string",
    });
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
  });

  // 一条失败的验证缺了 command 会被丢弃。成果仍然登记，但必须是 partial：
  // 否则账本里只剩通过的验证，工单却被推进到 review，像是全部验证都通过了。
  it("registers an envelope that lost a validation as partial and does not move the item to review", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, `PLC_OUTCOME_V1 ${JSON.stringify({
      summary: "Implemented, one check failed",
      changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
      deliverables: [],
      validations: [
        { command: "npm run typecheck", outcome: "passed", exitCode: 0, summary: "ok", evidenceRef: null },
        { outcome: "failed", exitCode: 1, summary: "3 tests failed", evidenceRef: null },
      ],
    })}`);

    expect(recoverOutcomeSnapshot(db, { itemId, runId, at: now })).toMatchObject({
      status: "recovered",
      completeness: "partial",
      transitionedToReview: false,
    });
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare("SELECT missing_fields_json FROM outcome_snapshots WHERE executor_run_id=?").get(runId))
      .toEqual({ missing_fields_json: JSON.stringify(["validations"]) });
  });

  // 信封本身不是对象，是 agent 交错了成果，不是宿主缺陷：它必须落在无效信封，而不是抛出去变成登记待处理。
  it("treats an envelope that is not an object as invalid, not as a host defect", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, `PLC_OUTCOME_V1 ${JSON.stringify(["summary", "changes"])}`);

    expect(recoverOutcomeSnapshot(db, { itemId, runId, at: now })).toMatchObject({
      status: "invalid_envelope",
      reason: "outcome must be an object",
    });
  });

  it("registers an unknown validation outcome as not_run and records a diagnostic", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, unknownValidationOutcomeLine("success"));

    expect(recoverOutcomeSnapshot(db, { itemId, runId, at: now })).toMatchObject({
      status: "recovered",
      completeness: "complete",
      transitionedToReview: true,
    });
    expect(JSON.parse((db.prepare(
      "SELECT validations_json FROM outcome_snapshots WHERE executor_run_id=?",
    ).get(runId) as { validations_json: string }).validations_json)[0].outcome).toBe("not_run");
    expect(db.prepare(
      `SELECT json_extract(payload, '$.diagnostics[0].code') AS code,
              json_extract(payload, '$.diagnostics[0].received') AS received
       FROM activities WHERE run_id=? AND json_extract(payload, '$.decision')='outcome_normalized'`,
    ).all(runId)).toEqual([{ code: "unknown_value", received: "success" }]);
  });

  it("records a host registration blocker instead of failing the finished run", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, invalidOutcomeLine());
    const recovered = recoverOutcomeSnapshot(db, { itemId, runId, at: now });

    expect(recordInvalidOutcomeEnvelope(db, {
      itemId,
      runId,
      at: now,
      reason: recovered.reason,
      demoteLatestExecutor: true,
    })).toBe(true);
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(getRun(db, runId)).toMatchObject({ state: "finished", error_code: null });
    expect(db.prepare(
      "SELECT title, idempotency_key FROM checkpoints WHERE item_id=? ORDER BY id DESC LIMIT 1",
    ).get(itemId)).toEqual({
      title: "成果登记失败",
      idempotency_key: `invalid-outcome-envelope:${runId}`,
    });
    const inbox = db.prepare(
      `SELECT payload FROM inbox
       WHERE json_extract(payload, '$.blockerCode')='invalid_outcome_envelope'`,
    ).get() as { payload: string };
    expect(JSON.parse(inbox.payload)).toMatchObject({
      intervention: "propose",
      leadNextStep: expect.stringContaining("不要 spawn_child"),
      nextStep: expect.stringContaining("不要在同一缺陷上再派一次"),
    });
    expect(JSON.parse(inbox.payload).summary).not.toMatch(/\s+at\s+/);
    expect(recordInvalidOutcomeEnvelope(db, {
      itemId,
      runId,
      at: now,
      reason: recovered.reason,
      demoteLatestExecutor: true,
    })).toBe(false);
  });

  it("never reopens an accepted done item for an invalid outcome envelope", () => {
    const { itemId, runId } = activeRunFixture();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);

    expect(recordInvalidOutcomeEnvelope(db, {
      itemId,
      runId,
      at: now,
      reason: "outcome.summary must be a non-empty string",
      demoteLatestExecutor: true,
    })).toBe(false);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`invalid-outcome-envelope:${runId}`)).toEqual({ n: 0 });
  });

  it("tells explicit registration that the envelope is invalid instead of inventing an outcome", () => {
    const { itemId, runId } = activeRunFixture();
    assistantMessage(runId, 1, invalidOutcomeLine());

    expect(registerOutcomeForRun(db, {
      itemId,
      runId,
      authorityRef: "user asked Lead to backfill the envelope without a summary",
      at: now,
    })).toEqual({
      status: "invalid_envelope",
      snapshotId: null,
      completeness: null,
      clearedRegistrationBlocker: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
  });

  it("v22 removes invalid historical outcome blockers and records one correction decision", () => {
    const { itemId, runId } = activeRunFixture();
    transition(db, { itemId, to: "review", actor: "system", reason: "legacy review", runId, now });
    db.prepare("UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?").run(runId);
    expect(recordOutcomeRegistrationMissing(db, { itemId, runId, at: now })).toBe(true);
    db.prepare("DELETE FROM schema_migrations WHERE version=22").run();
    const path = db.name;
    db.close();

    db = openDb(path);

    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`outcome-registration-missing:${runId}`)).toEqual({ n: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE item_id=? AND kind='outcome_registration_missing'",
    ).get(itemId)).toEqual({ n: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE item_id=? AND json_extract(payload, '$.blockerCode')='outcome_registration_missing'`,
    ).get(itemId)).toEqual({ n: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM activities
       WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')='historical_outcome_blocker_reconciled'`,
    ).get(itemId)).toEqual({ n: 1 });
  });
});
