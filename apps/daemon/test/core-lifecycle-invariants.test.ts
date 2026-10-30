import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tempDir } from "@pi-lead-child/core/testing";
import { repairDaemonStartupState } from "../src/server.js";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { recordOutcomeRegistrationMissing } from "@pi-lead-child/engine";
import { repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { openDb } from "@pi-lead-child/store";
import { addInbox } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { addNotification } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { addActivity, getItem, transition } from "@pi-lead-child/store";
import { recoverLookupsAfterRestart } from "../src/lookup.js";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "@pi-lead-child/engine";
import { agentTaskResult, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { channelLookupInvariantViolations, getChannelLookup, listEvents, transitionRunState } from "@pi-lead-child/store";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";

function runtime() {
  return {
    model: "openai/gpt-5.5",
    sessionId: "invariant-session",
    busy: false,
    runningItemIds: [],
    runningChildren: [],
    clients: 0,
    pid: null,
    aish: { connected: false, bot: null },
  };
}

function terminalFixture(db: ReturnType<typeof openDb>, stage: "done" | "cancelled", index: number) {
  const itemId = createItem(db, {
    title: `${stage}-${index}`,
    brief: "historical terminal item",
    createdBy: "system",
  });
  const runId = createRun(db, { itemId, runtime: "codex", purpose: "execution" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  db.prepare(
    "UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?",
  ).run(runId);
  db.prepare(
    `UPDATE items
     SET stage=?, stage_changed_at='2026-01-01 00:00:01',
         closed_at='2026-01-01 00:00:01'
     WHERE id=?`,
  ).run(stage, itemId);
  return { itemId, runId };
}

describe("core lifecycle invariants", () => {
  it("keeps a large historical terminal population out of startup blocker backfill", () => {
    const db = openDb(join(tempDir("plc-core-invariants-"), "plc.db"));
    const rows = Array.from({ length: 40 }, (_, index) =>
      terminalFixture(db, index % 2 === 0 ? "done" : "cancelled", index));
    for (const row of rows) {
      addInbox(db, {
        itemId: row.itemId,
        severity: "blocker",
        source: "structural",
        summary: "historical warning retained only for audit",
      });
    }
    const before = db.prepare(
      "SELECT id, stage, stage_changed_at, closed_at FROM items ORDER BY id",
    ).all();

    const first = repairDaemonStartupState(db, new Date("2026-08-18T00:00:00.000Z"));
    const second = repairDaemonStartupState(db, new Date("2026-08-18T00:01:00.000Z"));
    repairMissingBlockerAlerts(db, new Date("2026-08-18T00:02:00.000Z"));

    expect(first.outcomes).toBe(0);
    expect(second.outcomes).toBe(0);
    expect(db.prepare(
      "SELECT id, stage, stage_changed_at, closed_at FROM items ORDER BY id",
    ).all()).toEqual(before);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key LIKE 'outcome-registration-missing:%'",
    ).get()).toEqual({ n: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE kind='outcome_registration_missing'",
    ).get()).toEqual({ n: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE json_extract(payload, '$.blockerCode')='outcome_registration_missing'`,
    ).get()).toEqual({ n: 0 });
    const summaries = createControlPlaneService(db, { runtime }).listItems();
    for (const row of rows) {
      expect(summaries.find((item) => item.id === row.itemId)).toMatchObject({
        stage: expect.stringMatching(/^(done|cancelled)$/),
        attention: { blockerCount: 0 },
      });
    }
    db.close();
  });

  it("keeps migration blast radius away from item lifecycle and unrelated outbox facts", () => {
    const dir = tempDir("plc-migration-invariants-");
    const path = join(dir, "plc.db");
    let db = openDb(path);
    const stages = ["draft", "ready", "active", "blocked", "review", "done", "cancelled"] as const;
    const itemIds = stages.map((stage) => {
      const id = createItem(db, {
        title: stage,
        brief: "migration matrix",
        createdBy: stage === "draft" ? "lead" : "system",
        hold: stage === "draft",
      });
      db.prepare("UPDATE items SET stage=? WHERE id=?").run(stage, id);
      return id;
    });
    const reviewId = itemIds[4]!;
    const historicalRunId = createRun(db, {
      itemId: reviewId,
      runtime: "codex",
      purpose: "conversation",
    });
    updateRun(db, historicalRunId, { state: "finished", endedAt: true });
    db.prepare(
      "UPDATE runs SET role='executor', purpose='execution', ended_at='2026-01-01 00:00:00' WHERE id=?",
    ).run(historicalRunId);
    expect(recordOutcomeRegistrationMissing(db, {
      itemId: reviewId,
      runId: historicalRunId,
      at: new Date("2026-08-18T00:00:00.000Z"),
    })).toBe(true);
    const unrelatedNotificationId = addNotification(db, {
      itemId: reviewId,
      kind: "unrelated",
      urgency: "batchable",
      title: "must survive",
    });
    addInbox(db, {
      itemId: reviewId,
      severity: "attention",
      source: "semantic",
      summary: "unrelated inbox fact",
    });
    const itemSnapshot = db.prepare(
      "SELECT id, stage, plan_state, retry_limit, closed_at FROM items ORDER BY id",
    ).all();
    db.prepare("DELETE FROM schema_migrations WHERE version=22").run();
    db.close();

    db = openDb(path);

    expect(db.prepare(
      "SELECT id, stage, plan_state, retry_limit, closed_at FROM items ORDER BY id",
    ).all()).toEqual(itemSnapshot);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`outcome-registration-missing:${historicalRunId}`)).toEqual({ n: 0 });
    expect(db.prepare("SELECT title FROM notifications WHERE id=?").get(unrelatedNotificationId))
      .toEqual({ title: "must survive" });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND summary='unrelated inbox fact'",
    ).get(reviewId)).toEqual({ n: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  // 代查（slack-takeover spec D14 的不变量 3）：代查工单的 stage 是终态，当且仅当这次代查是终态。
  // 重启时的修复有界、幂等：已经结束的代查不动，被打断的只收一次，不升 blocker、不发通知。
  it("closes every interrupted lookup ticket once on restart and leaves finished lookups alone", () => {
    const db = openDb(join(tempDir("plc-core-invariants-lookup-"), "plc.db"));
    const lookup = (index: number, running: boolean) => {
      const itemId = createItem(db, { title: `lookup-${index}`, brief: "b", createdBy: "system", purpose: "lookup" });
      const runId = createRun(db, { itemId, purpose: "lookup" });
      transition(db, { itemId, to: "active", actor: "system", reason: "lookup started", runId });
      addActivity(db, { itemId, runId, actor: "system", kind: "decision", payload: { decision: "lookup_started", lookupId: index } });
      if (running) {
        updateRun(db, runId, { state: "running" });
      } else {
        updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
        transition(db, { itemId, to: "review", actor: "system", reason: "lookup finished", runId });
        transition(db, { itemId, to: "done", actor: "system", reason: "lookup finished", runId });
      }
      return itemId;
    };
    const interrupted = Array.from({ length: 30 }, (_, index) => lookup(index + 1, true));
    const finished = Array.from({ length: 10 }, (_, index) => lookup(index + 100, false));

    expect(recoverLookupsAfterRestart(db).map((entry) => entry.lookupId)).toEqual(interrupted.map((_, index) => index + 1));
    expect(interrupted.map((id) => getItem(db, id)!.stage)).toEqual(interrupted.map(() => "cancelled"));
    expect(finished.map((id) => getItem(db, id)!.stage)).toEqual(finished.map(() => "done"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE purpose='lookup' AND state IN ('starting','running')").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    // 第二次启动什么也不做。
    expect(recoverLookupsAfterRestart(db)).toEqual([]);
    db.close();
  });

  // 通道派的子 agent 工单（落地计划 B、D1；spec D14 的不变量 1、2 照旧）：没有一张卡停在「在跑」超过时限；
  // 每一次结束的工单都有回复的决定。结果交回时 hub 一并写好；Run 结束了、结果却没有交回（例如 daemon 在两者之间退出）时，
  // hub 每一拍补上：记成失败、交给用户、交回 Lead。工单的 stage 跟着 Run 进终态（不变量 3）。
  it("never leaves a sub-agent task running after its run ended, and every ended task has a reply decision", async () => {
    const db = openDb(join(tempDir("plc-core-invariants-channel-task-"), "plc.db"));
    let clock = new Date("2026-10-20T10:00:00.000Z");
    const slack = new FakeSlack({ now: () => clock, users: { U0WANG: { name: "王五" } } });
    const dispatcher = new FakeAgentTaskDispatcher(db, { "acme/orders": "/work/orders" });
    const model = scriptedSmartModel({ answers: { ask_kind: "knowledge", target_repo: "acme/orders" } });
    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
      credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
      lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: null }],
      lead: { dispatcher, available: () => true },
    });
    dispatcher.hub = hub;
    const violations = () => channelLookupInvariantViolations(db, { now: clock, timeoutMs: () => 15 * 60_000 });
    for (const user of ["U0ZHANG", "U0LI"]) await hub.receive("slack", slack.dm(user, "重试最多等多久？"));
    await hub.idle();
    // Lead 派了两张工单（系统不替 Lead 派，统一消息事件工单 06）。
    for (const event of listEvents(db, { kind: MESSAGE_EVENT_KIND })) {
      await hub.leadDispatch(event.seq, { summary: "查重试最多等多久", intent: "knowledge" });
    }
    await hub.idle();
    const [finished, lost] = dispatcher.requests.map((request) => request.runId);
    expect(dispatcher.requests).toHaveLength(2);
    // 一张正常交回结果；另一张的 Run 结束了，结果没有交回。
    await dispatcher.finish(finished!, { result: agentTaskResult() });
    await hub.idle();
    transitionRunState(db, lost!, "failed", { endedAt: true, errorCode: "daemon_restart", errorMessage: "测试：daemon 重启" });
    // Run 的结束时间按这个测试的时钟记（库里写的是 SQLite 的当前时间）。daemon 重启时把没有活 Run 的工单收进 cancelled。
    db.prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(clock.toISOString(), lost);
    recoverLookupsAfterRestart(db);
    clock = new Date(clock.getTime() + 21 * 60_000);
    expect(violations()).toEqual(expect.arrayContaining([expect.stringContaining("停在 running")]));
    await hub.tick();
    await hub.idle();
    const rows = db.prepare("SELECT id, run_id FROM channel_lookups ORDER BY id").all() as Array<{ id: number; run_id: number }>;
    expect(getChannelLookup(db, rows.find((row) => row.run_id === lost)!.id)).toMatchObject({ state: "failed", reply: { decision: "hand_over" } });
    expect(getChannelLookup(db, rows.find((row) => row.run_id === finished)!.id)!.reply).not.toBeNull();
    expect(violations()).toEqual([]);
    db.close();
  });
});
