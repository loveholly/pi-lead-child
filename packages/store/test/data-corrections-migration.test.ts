// v35–v37：工单 #66 复核后的一次性数据更正（src/data-corrections.ts）。
// 按 AGENTS.md 测三条路径：旧库升级（legacy）、全新库（fresh）、再次打开（reopen）。
// legacy 的做法：在新库里写入旧代码留下的那种数据，抹掉 v35–v37 的记账，关掉再打开。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { addActivity } from "../src/activities.js";
import { raiseBlocker } from "../src/blockers.js";
import { insertCheckpoint } from "../src/checkpoints.js";
import { completeTurn, createTurn } from "../src/conversations.js";
import { grantDelegationPolicy } from "../src/delegation-policies.js";
import { createItem, transition } from "../src/items.js";
import { createRun, updateRun } from "../src/runs.js";

const NEW_VERSIONS = [35, 36, 37];

function freshPath(): string {
  return join(tempDir("plc-data-corrections-"), "plc.db");
}

function finishedRun(db: Db, itemId: number, purpose: "execution" | "conversation", startedAt: string): number {
  const runId = createRun(db, { itemId, role: "executor", purpose, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(startedAt, runId);
  return runId;
}

// 旧代码写"成果缺失"时留下的全套记录：checkpoint、对话卡片、通知活动、inbox blocker 和通知。
function missingOutcomeRecord(db: Db, itemId: number, runId: number, at: string): number {
  const key = `outcome-registration-missing:${runId}`;
  const checkpoint = insertCheckpoint(db, {
    itemId, runId, source: "system_derived", kind: "blocked",
    title: "Outcome registration missing",
    summary: `Run #${runId} reached review, but no structured outcome snapshot could be recovered.`,
    nextStep: "Review the run log and register a real completion outcome.",
    idempotencyKey: key,
  }, { now: new Date(at) });
  db.prepare(
    "INSERT INTO conversation_cards (item_id, kind, checkpoint_id, idempotency_key) VALUES (?, 'checkpoint', ?, ?)",
  ).run(itemId, checkpoint.id, `checkpoint:${checkpoint.id}`);
  addActivity(db, {
    itemId, runId, actor: "system", kind: "notification",
    payload: { checkpointId: checkpoint.id, kind: "blocked", title: "Outcome registration missing" },
  });
  raiseBlocker(db, {
    itemId, runId, code: "outcome_registration_missing", payloadKind: "outcome_registration_missing",
    title: "Outcome registration missing", summary: `Run #${runId} has no structured outcome snapshot.`,
    source: "structural", dedupKey: key,
  });
  return checkpoint.id;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** 按 #66 的真实形状写一个旧库，再加几条必须原样保留的对照数据。 */
function legacyDatabase() {
  const path = freshPath();
  const db = openDb(path);
  // #66：Run #48 交接失败，Run #49 交付并恢复成果进了 review，之后两次提问（对话 Run）。
  const ticket = createItem(db, {
    title: "outcome snapshot and registry mechanism", brief: "implement", createdBy: "user",
    verificationPolicy: "independent_reviewer",
  });
  transition(db, { itemId: ticket, to: "active", actor: "system", reason: "spawn_child" });
  const policy = grantDelegationPolicy(db, { itemId: ticket, createdVia: "test", maxReworkCycles: 1 });
  const grantRework = addActivity(db, {
    itemId: ticket, actor: "user", kind: "decision",
    payload: { decision: "rework_dispatch_requested", reason: "用户授权 Lead 自动返工并启动本次修复" },
  });
  const manualRework = addActivity(db, {
    itemId: ticket, actor: "user", kind: "decision",
    payload: { decision: "rework_dispatch_requested", reason: "补跑 typecheck" },
  });
  const run48 = finishedRun(db, ticket, "execution", "2026-08-21 09:12:06");
  const run49 = finishedRun(db, ticket, "execution", "2026-08-21 10:27:45");
  transition(db, { itemId: ticket, to: "review", actor: "system", reason: "recovered", runId: run49 });
  const run50 = finishedRun(db, ticket, "conversation", "2026-08-21 10:49:24");
  const run51 = finishedRun(db, ticket, "conversation", "2026-08-21 10:51:53");
  const stale = missingOutcomeRecord(db, ticket, run48, "2026-08-21T10:48:07.267Z");
  const chat50 = missingOutcomeRecord(db, ticket, run50, "2026-08-21T10:50:07.791Z");
  const chat51 = missingOutcomeRecord(db, ticket, run51, "2026-08-21T10:57:31.069Z");

  // #66 第二轮对话：只留下了第一条助手消息。
  const turn = createTurn(db, {
    originKind: "paired:companion:ticket-agent", itemId: ticket,
    userText: "你跑吧，顺便告诉我我该怎么验收呢", state: "streaming",
  });
  db.prepare("UPDATE channel_turns SET assistant_text=? WHERE id=?").run("我先去跑一遍验收门。", turn.id);
  completeTurn(db, turn.id);
  addActivity(db, {
    itemId: ticket, runId: run51, actor: "user", kind: "comment",
    payload: { content: "你跑吧，顺便告诉我我该怎么验收呢", route: "ticket_agent_resume" },
  });
  const message = (seq: number, text: string) => db.prepare(
    "INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, 'message.completed', ?, ?)",
  ).run(run51, seq, JSON.stringify({ type: "message.completed", role: "assistant", text, messageId: `m${seq}` }), "2026-08-21T10:57:30.000Z");
  message(4, "我先去跑一遍验收门。");
  message(28, "跑完了：158 files / 1238 tests passed。\n# 你该怎么验收\n1. ...");

  // 对照 1：工单停在 blocked，它的"成果缺失"记录可能正是原因，迁移不碰。
  const blocked = createItem(db, { title: "blocked", brief: "b", createdBy: "user" });
  transition(db, { itemId: blocked, to: "active", actor: "system", reason: "spawn_child" });
  const blockedChat = finishedRun(db, blocked, "conversation", "2026-08-21 11:00:00");
  const keptBlocked = missingOutcomeRecord(db, blocked, blockedChat, "2026-08-21T11:01:00.000Z");
  transition(db, { itemId: blocked, to: "blocked", actor: "system", reason: "outcome self-recovery failed" });
  // 对照 2：真正交不出成果的最新交付，记录成立，保留。
  const genuine = createItem(db, { title: "genuine", brief: "b", createdBy: "user" });
  transition(db, { itemId: genuine, to: "active", actor: "system", reason: "spawn_child" });
  const genuineRun = finishedRun(db, genuine, "execution", "2026-08-21 12:00:00");
  transition(db, { itemId: genuine, to: "review", actor: "child", reason: "done", runId: genuineRun });
  const keptGenuine = missingOutcomeRecord(db, genuine, genuineRun, "2026-08-21T12:10:00.000Z");

  const lifecycle = db.prepare("SELECT id, stage, plan_state, closed_at FROM items ORDER BY id").all();
  db.prepare(`DELETE FROM schema_migrations WHERE version IN (${NEW_VERSIONS.join(",")})`).run();
  db.close();
  return {
    path, ticket, policy, grantRework, manualRework, run48, run50, run51,
    stale, chat50, chat51, keptBlocked, keptGenuine, turnId: turn.id, lifecycle,
  };
}

describe("data corrections after the #66 review (v35–v37)", () => {
  it("records all three versions on a fresh database without touching anything", () => {
    const db = openDb(freshPath());

    expect(db.prepare(`SELECT version, name FROM schema_migrations WHERE version IN (${NEW_VERSIONS.join(",")}) ORDER BY version`).all())
      .toEqual([
        { version: 35, name: "rework-grant-attribution-v1" },
        { version: 36, name: "spurious-outcome-records-v1" },
        { version: 37, name: "ticket-agent-turn-text-v1" },
      ]);
    expect(count(db, "SELECT COUNT(*) AS n FROM activities")).toBe(0);
  });

  it("upgrades a legacy database: attributes the grant rework, removes the spurious records, restores the turn", () => {
    const legacy = legacyDatabase();
    const db = openDb(legacy.path);

    // v35：只有授权时那一次带上授权编号，手动返工不带。
    const policyOf = (id: number) => (db.prepare(
      "SELECT json_extract(payload, '$.delegationPolicyId') AS policy FROM activities WHERE id=?",
    ).get(id) as { policy: number | null }).policy;
    expect(policyOf(legacy.grantRework)).toBe(legacy.policy.id);
    expect(policyOf(legacy.manualRework)).toBeNull();

    // v36：#95/#97/#99 的同类记录连同派生行一起删掉；两条对照保留。
    for (const checkpointId of [legacy.stale, legacy.chat50, legacy.chat51]) {
      expect(count(db, "SELECT COUNT(*) AS n FROM checkpoints WHERE id=?", checkpointId)).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS n FROM conversation_cards WHERE checkpoint_id=?", checkpointId)).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS n FROM activities WHERE kind='notification' AND json_extract(payload, '$.checkpointId')=?", checkpointId)).toBe(0);
    }
    for (const runId of [legacy.run48, legacy.run50, legacy.run51]) {
      expect(count(db, "SELECT COUNT(*) AS n FROM inbox WHERE json_extract(payload, '$.runId')=?", runId)).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS n FROM notifications WHERE dedup_key=?", `blocker:outcome-registration-missing:${runId}`)).toBe(0);
    }
    for (const checkpointId of [legacy.keptBlocked, legacy.keptGenuine]) {
      expect(count(db, "SELECT COUNT(*) AS n FROM checkpoints WHERE id=?", checkpointId)).toBe(1);
    }
    expect(db.prepare(
      `SELECT json_extract(payload, '$.removedCheckpointId') AS checkpoint, json_extract(payload, '$.why') AS why
       FROM activities WHERE json_extract(payload, '$.decision')='spurious_outcome_record_removed' ORDER BY id`,
    ).all()).toEqual([
      { checkpoint: legacy.stale, why: "superseded_delivery" },
      { checkpoint: legacy.chat50, why: "not_a_delivery" },
      { checkpoint: legacy.chat51, why: "not_a_delivery" },
    ]);

    // v37：这一轮对话补回了最终回答。
    expect((db.prepare("SELECT assistant_text FROM channel_turns WHERE id=?").get(legacy.turnId) as { assistant_text: string }).assistant_text)
      .toBe("我先去跑一遍验收门。\n\n跑完了：158 files / 1238 tests passed。\n# 你该怎么验收\n1. ...");

    // 迁移不改任何工单的生命周期字段。
    expect(db.prepare("SELECT id, stage, plan_state, closed_at FROM items ORDER BY id").all()).toEqual(legacy.lifecycle);
  });

  it("changes nothing more when the upgraded database is opened again", () => {
    const legacy = legacyDatabase();
    const first = openDb(legacy.path);
    const snapshot = (db: Db) => ({
      activities: count(db, "SELECT COUNT(*) AS n FROM activities"),
      checkpoints: count(db, "SELECT COUNT(*) AS n FROM checkpoints"),
      turn: db.prepare("SELECT assistant_text FROM channel_turns WHERE id=?").get(legacy.turnId),
      versions: count(db, `SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (${NEW_VERSIONS.join(",")})`),
    });
    const afterFirst = snapshot(first);
    first.close();

    const reopened = openDb(legacy.path);
    expect(snapshot(reopened)).toEqual(afterFirst);
    expect(afterFirst.versions).toBe(3);
  });
});
