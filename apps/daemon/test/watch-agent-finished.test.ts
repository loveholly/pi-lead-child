// 子代理检查的整条路（.scratch/lead-watch/spec.md D2、D5）：到点系统建一张轻工单（和 create_task(light=true) 一样），
// 子 agent 交回以后系统结单，Run 结束的说明叫醒 Lead，说明里写是哪个后台检查、Lead 设它时写的话；检查记下这一次结束。
// 外部来源的检查交回的结果按外部的一轮算。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createWatchRunner } from "@pi-lead-child/engine";
import { createWatchLightTask } from "@pi-lead-child/lead";
import {
  activePairedUserTurn, createLoopbackBinding, createRun, createWatch, getItem, getWatch, isLightTask, listWatchChecks, openDb,
  transitionRunState, watchAgentChoice, type Db, type FollowUpSetBy,
} from "@pi-lead-child/store";
import { recordRunFinished } from "../src/run-finished.js";

const T0 = new Date("2026-10-28T07:00:00.000Z");

function deliver(db: Db, itemId: number, summary: string): number {
  const runId = createRun(db, { itemId, runtime: "pi", role: "executor", purpose: "execution" });
  transitionRunState(db, runId, "running");
  transitionRunState(db, runId, "finished");
  db.prepare("UPDATE runs SET ended_at = datetime('now') WHERE id=?").run(runId);
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  db.prepare(
    `INSERT INTO outcome_snapshots (item_id, executor_run_id, source, source_output_sha256, summary, changes_json,
       deliverables_json, validations_json, completeness, missing_fields_json, content_hash, idempotency_key, created_at)
     VALUES (?, ?, 'system_recovered', 'sha', ?, '[]', '[]', '[]', 'complete', '[]', 'h', ?, datetime('now'))`,
  ).run(itemId, runId, summary, `k-${runId}`);
  return runId;
}

function runFinished(db: Db, itemId: number): { id: number; summary: string; payload: Record<string, unknown> } {
  const row = db.prepare(
    "SELECT id, summary, payload FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='run_finished' ORDER BY id DESC LIMIT 1",
  ).get(itemId) as { id: number; summary: string; payload: string };
  return { id: row.id, summary: row.summary, payload: JSON.parse(row.payload) };
}

async function startAgentWatch(origin: Parameters<typeof createWatch>[1]["origin"], setBy?: (db: Db) => FollowUpSetBy) {
  const dir = tempDir("plc-watch-agent-");
  const db = openDb(join(dir, "plc.db"));
  const spawned: number[] = [];
  const runner = createWatchRunner(db, {
    now: () => T0,
    runCommand: async () => { throw new Error("no commands here"); },
    // daemon 里是同一个函数，再 spawnItemChild。
    startAgentCheck: (watch, task) => {
      const itemId = createWatchLightTask(db, { dataDir: dir, watchId: watch.id, task, agent: watchAgentChoice(watch) });
      spawned.push(itemId);
      return itemId;
    },
  });
  const watchId = createWatch(db, {
    label: "PR #119 的回复", check: { kind: "agent", brief: "看 PR #119 有没有新的评审意见", agent: { runtime: "pi" } }, mode: "until",
    everySeconds: 300, untilAt: new Date(T0.getTime() + 3_600_000).toISOString(), note: "有回复就总结给用户", origin,
    ...(setBy ? { setBy: setBy(db) } : {}),
  }, T0);
  await runner.tick();
  return { db, dir, watchId, itemId: spawned[0]! };
}

describe("an agent check from start to hand-back", () => {
  it("opens a light ticket, closes it on delivery, settles the check and tells Lead which watch it was", async () => {
    const { db, dir, watchId, itemId } = await startAgentWatch({ kind: "system" });
    const item = getItem(db, itemId)!;
    expect(item).toMatchObject({ title: "后台检查 #1：PR #119 的回复", requested_runtime: "pi", created_by: "lead", verification_policy: "lead_static" });
    expect(item.workdir?.startsWith(join(dir, "light-tasks"))).toBe(true);
    expect(isLightTask(db, itemId)).toBe(true);
    expect(listWatchChecks(db, watchId)[0]).toMatchObject({ status: "running", item_id: itemId });

    const runId = deliver(db, itemId, "PR #119 有 2 条新意见：Ethan 要求改命名。");
    expect(recordRunFinished(db, { itemId, runId }).woke).toBe(true);
    expect(getItem(db, itemId)!.stage).toBe("done");
    const told = runFinished(db, itemId);
    expect(told.summary).toContain("这是后台检查 #1「PR #119 的回复」的一次检查");
    expect(told.summary).toContain("你设它时写的：有回复就总结给用户");
    expect(told.summary).toContain("Ethan 要求改命名");
    expect(told.payload).toMatchObject({ lightTask: true, wakeLead: true });
    expect(told.payload).not.toHaveProperty("external");
    expect(getWatch(db, watchId)).toMatchObject({ state: "done", ended_reason: "agent_done", running_since: null, last_status: "pass" });
    // 检查自己不再叫醒 Lead：只有 Run 结束的那一条。
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE json_extract(payload, '$.kind') = 'watch_result'").get()).toEqual({ n: 0 });
  });

  it("marks the hand-back external when someone outside asked for the watch", async () => {
    const { db, itemId } = await startAgentWatch({
      kind: "external", via: "message", source: "slack", sourceLabel: "Slack", sender: { id: "U0ETHAN", name: "Ethan" },
      messageEvent: 9, conversation: null, confirmedBy: { bindingId: 1, request: "tmr_x", at: T0.toISOString() },
    });
    const runId = deliver(db, itemId, "没有新回复。");
    recordRunFinished(db, { itemId, runId });
    const told = runFinished(db, itemId);
    expect(told.payload).toMatchObject({ external: true });
    expect(told.summary).toContain("这个检查是外部来源要求设的");
  });

  // 维护者定（2026-11-04）：用户本人设的检查交回时，叫醒 Lead 的那一轮按 setBy 算用户的一轮（timer:<inbox 编号>），和用户设的跟进一样。
  it("lets the hand-back of a watch the user set count as the user's turn, and not one Lead set", async () => {
    const mine = await startAgentWatch({ kind: "user", turnId: "turn-set" }, (db) => ({
      turnId: "turn-set", bindingId: createLoopbackBinding(db, { name: "Mac 网页" }).binding.id, startedAt: T0.toISOString(),
    }));
    recordRunFinished(mine.db, { itemId: mine.itemId, runId: deliver(mine.db, mine.itemId, "有 1 条新意见。") });
    const told = runFinished(mine.db, mine.itemId);
    expect(told.payload).toMatchObject({ setBy: { turnId: "turn-set" } });
    expect(activePairedUserTurn(mine.db, `timer:${told.id}`, "x", "tickets:create")).toMatchObject({
      id: `timer:${told.id}`, origin_kind: "paired:timer", created_at: T0.toISOString(),
    });

    const own = await startAgentWatch({ kind: "system" });
    recordRunFinished(own.db, { itemId: own.itemId, runId: deliver(own.db, own.itemId, "没有新回复。") });
    const ownTold = runFinished(own.db, own.itemId);
    expect(ownTold.payload).not.toHaveProperty("setBy");
    expect(() => activePairedUserTurn(own.db, `timer:${ownTold.id}`, "x", "tickets:create")).toThrow(/not a follow-up the user set/);
  });
});
