import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createRun } from "../src/runs.js";
import { insertCheckpoint } from "../src/checkpoints.js";
import { ensureInterventionCard } from "../src/conversation-cards.js";
import {
  expireDecisionRequests,
  findPendingDecisionProjectionGaps,
  getDecisionRequest,
  insertDecisionRequest,
  resolveDecisionRequest,
} from "../src/decision-requests.js";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";

let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-decisions-"), "plc.db"));
  itemId = createItem(db, { title: "decision", brief: "store", createdBy: "system" });
  runId = createRun(db, { itemId, runtime: "claude" });
});

function createDecision(overrides = {}) {
  return insertDecisionRequest(db, {
    itemId,
    runId,
    kind: "decision",
    audience: "lead_or_user",
    blocking: true,
    allowCustom: true,
    prompt: "选择兼容策略",
    options: [
      { id: "strict", label: "严格兼容", description: "冻结 v2" },
      { id: "additive", label: "增量扩展" },
    ],
    ...overrides,
  });
}

describe("decision request store", () => {
  it("round-trips structured columns and option resolution", () => {
    const request = createDecision();
    expect(request).toMatchObject({
      itemId, runId, blocking: true, allowCustom: true, state: "pending",
      resolutionKind: null, selectedOptionId: null, resolutionText: null,
    });
    expect(resolveDecisionRequest(db, request.id, {
      kind: "option", optionId: "strict", resolvedBy: "lead",
      now: new Date("2026-07-24T02:00:00.000Z"),
    })).toBe("resolved");
    expect(getDecisionRequest(db, request.id)).toMatchObject({
      state: "resolved",
      resolutionKind: "option",
      selectedOptionId: "strict",
      resolutionText: null,
      resolvedBy: "lead",
      resolvedAt: "2026-07-24T02:00:00.000Z",
    });
    expect(resolveDecisionRequest(db, request.id, {
      kind: "option", optionId: "strict", resolvedBy: "lead",
    })).toBe("idempotent");
    expect(resolveDecisionRequest(db, request.id, {
      kind: "text", text: "contradiction", resolvedBy: "lead",
    })).toBe("conflict");
  });

  it("persists text, dismissal, and expiry identities in dedicated columns", () => {
    const text = createDecision({ options: [] });
    expect(resolveDecisionRequest(db, text.id, {
      kind: "text", text: "  使用增量协议  ", resolvedBy: "user",
    })).toBe("resolved");
    expect(getDecisionRequest(db, text.id)).toMatchObject({
      resolutionKind: "text", resolutionText: "使用增量协议",
    });

    const dismissed = createDecision();
    resolveDecisionRequest(db, dismissed.id, {
      kind: "dismissed", reason: "稍后再定", resolvedBy: "lead",
    });
    expect(getDecisionRequest(db, dismissed.id)).toMatchObject({
      state: "dismissed", resolutionKind: "dismissed", dismissalReason: "稍后再定",
    });

    const expired = createDecision({ expiresAt: "2026-07-24T00:00:00.000Z" });
    expect(expireDecisionRequests(db, new Date("2026-07-24T01:00:00.000Z"))).toContain(expired.id);
    expect(getDecisionRequest(db, expired.id)).toMatchObject({
      state: "expired", resolutionKind: "expired",
    });
  });

  it("rejects invalid selections and finds only pending authorities missing projections", () => {
    const request = createDecision();
    expect(() => resolveDecisionRequest(db, request.id, {
      kind: "option", optionId: "missing", resolvedBy: "lead",
    })).toThrow(/option/i);
    expect(findPendingDecisionProjectionGaps(db)).toEqual([{
      authority: request,
      checkpointId: null,
      cardId: null,
    }]);

    const checkpoint = insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "blocked",
      stage: null,
      title: "等待决策",
      summary: "legacy repair",
      keyFacts: [],
      artifactRefs: [],
      relatedItemIds: [],
      nextStep: null,
      actionRef: { type: "decision_request", id: request.id },
      idempotencyKey: `legacy-decision:${request.id}`,
    });
    expect(findPendingDecisionProjectionGaps(db)[0]).toMatchObject({
      checkpointId: checkpoint.id, cardId: null,
    });
    const card = ensureInterventionCard(db, {
      itemId, checkpointId: checkpoint.id, actionType: "decision_request", actionId: request.id,
    });
    expect(card.key).toBe(`intervention:decision_request:${request.id}`);
    expect(findPendingDecisionProjectionGaps(db)).toEqual([]);
  });

  it("does not return cross-item projection ids from decision repair queries", () => {
    const request = createDecision();
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    const checkpointId = Number(db.prepare(
      `INSERT INTO checkpoints
        (item_id, source, kind, title, summary, action_type, action_id, idempotency_key, content_hash)
       VALUES (?, 'system_derived', 'blocked', 'wrong', 'wrong item', 'decision_request', ?, ?, 'hash')`,
    ).run(otherItem, request.id, `wrong-decision:${request.id}`).lastInsertRowid);
    db.prepare(
      `INSERT INTO conversation_cards
        (item_id, kind, checkpoint_id, action_type, action_id, idempotency_key)
       VALUES (?, 'intervention', ?, 'decision_request', ?, ?)`,
    ).run(otherItem, checkpointId, request.id, `wrong-decision-card:${request.id}`);

    expect(findPendingDecisionProjectionGaps(db)).toEqual([{
      authority: request,
      checkpointId: null,
      cardId: null,
    }]);
  });
});

// generative UI（2026-10-15）：Lead 自己在会话里发起的决定（render_ui 的 ChoiceGroup）没有 Run。
// 记下是谁发起的：用户选完以后，Lead 发起的要叫醒 Lead 去执行；agent 发起的由那个 Run 自己读结果。
describe("who asked for a decision", () => {
  it("records an agent run or Lead itself", () => {
    expect(createDecision().origin).toBe("agent");
    const lead = insertDecisionRequest(db, {
      itemId, runId: null, origin: "lead", kind: "decision", audience: "user",
      prompt: "#66 接下来怎么办？", options: [{ id: "merge", label: "并入 #72" }],
    });
    expect(lead).toMatchObject({ origin: "lead", runId: null });
    expect(getDecisionRequest(db, lead.id)?.origin).toBe("lead");
  });

  it("adds the column to an existing ledger, keeping its rows as agent requests (v41)", () => {
    const dir = tempDir("plc-decisions-legacy-");
    const legacy = openDb(join(dir, "plc.db"));
    const legacyItem = createItem(legacy, { title: "old", brief: "b", createdBy: "system" });
    legacy.prepare("ALTER TABLE decision_requests DROP COLUMN origin").run();
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 41").run();
    legacy.prepare(
      "INSERT INTO decision_requests (item_id, kind, audience, prompt, options, created_at) VALUES (?, 'decision', 'user', 'old', '[]', '2026-10-01T00:00:00.000Z')",
    ).run(legacyItem);
    legacy.close();
    const reopened = openDb(join(dir, "plc.db"));
    expect(reopened.prepare("SELECT origin FROM decision_requests").all()).toEqual([{ origin: "agent" }]);
    expect(reopened.prepare("SELECT 1 AS ok FROM schema_migrations WHERE version = 41").get()).toEqual({ ok: 1 });
    reopened.close();
    const again = openDb(join(dir, "plc.db"));
    expect(again.prepare("SELECT COUNT(*) AS n FROM decision_requests").get()).toEqual({ n: 1 });
    again.close();
  });
});
