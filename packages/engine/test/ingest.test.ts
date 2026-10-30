import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { addInbox, listInbox, markInbox } from "@pi-lead-child/store";
import {
  assertRunAllowed,
  executorRetryBudget,
  repairNonBudgetRetryExhaustion,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIngestor } from "../src/pipeline/ingest.js";

let db: Db;
let itemId: number;
let runId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  // stage 在派发时就落到 active（manager 负责），agent_start 已不再推进 stage。
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId });
});

const usageMsg = {
  role: "assistant",
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
    cost: { total: 0.003 } },
};

const usage = (mode: "delta" | "cumulative", totalTokens: number, costUsd: number | null) => ({
  type: "usage.updated", mode, inputTokens: totalTokens, outputTokens: 0, totalTokens, costUsd,
});

describe("ingest rules", () => {
  it("agent_start moves the run to running and leaves the stage at active", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    expect(getRun(db, runId)!.state).toBe("running");
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(getItem(db, itemId)!.last_activity_at).not.toBeNull();
  });

  it("accumulates tokens and cost from assistant message_end", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "message_end", message: usageMsg });
    ing.onEvent({ type: "message_end", message: usageMsg });
    const t = getItem(db, itemId)!;
    expect(t.total_tokens).toBe(300);
    expect(t.total_cost_usd).toBeCloseTo(0.006);
  });

  // 工单 #102：旧代码把 delta 加起来，又把 cumulative 整个加上去，同一份用量算了两次。
  it("counts usage once when deltas are followed by a cumulative total", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent(usage("delta", 20, null));
    ing.onEvent(usage("cumulative", 33, 0.0125));
    expect(getItem(db, itemId)!).toMatchObject({ total_tokens: 33, total_cost_usd: 0.0125 });
  });

  it("takes the latest cumulative total as the process total, also when it is lower", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent(usage("cumulative", 100, null));
    ing.onEvent(usage("cumulative", 90, 0.02));
    expect(getItem(db, itemId)!).toMatchObject({ total_tokens: 90, total_cost_usd: 0.02 });
  });

  // 过期会话在同一个 Run 里开新会话：新进程的累计从 0 开始，前一个进程的用量不能丢。
  it("starts a new count when a new runtime process starts in the same run", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "run.started" });
    ing.onEvent(usage("cumulative", 100, 0.01));
    ing.onEvent({ type: "run.started" });
    ing.onEvent(usage("cumulative", 30, 0.003));
    expect(getItem(db, itemId)!.total_tokens).toBe(130);
    expect(getItem(db, itemId)!.total_cost_usd).toBeCloseTo(0.013);
  });

  // daemon 重启后接管：上一个 daemon 已经记过的用量只重建，不再写；之后的事件接着算。
  it("rebuilds the run's usage on adoption from both delta and cumulative events", () => {
    const first = createIngestor(db, { itemId, runId });
    const seen = [usage("delta", 20, null), usage("cumulative", 33, 0.0125)];
    for (const event of seen) first.onEvent(event);
    const adopted = createIngestor(db, { itemId, runId });
    for (const event of seen) adopted.restore(event);
    adopted.onEvent(usage("cumulative", 50, 0.02));
    expect(getItem(db, itemId)!).toMatchObject({ total_tokens: 50, total_cost_usd: 0.02 });
  });

  it("agent_end finishes the run and reports that terminal handoff is required", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    const outcome = ing.onEvent({ type: "agent_end", messages: [] });
    expect(getRun(db, runId)!.state).toBe("finished");
    expect(outcome).toEqual({ type: "terminal_handoff_required", criticalToolFailure: null });
    ing.onExit(0);
    expect(getRun(db, runId)!.state).toBe("finished");
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("preserves the failed critical tool that prevented terminal handoff", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "tool.failed", name: "plc.ticket_update", error: "connect EPERM" });
    expect(ing.onEvent({ type: "run.completed" })).toEqual({
      type: "terminal_handoff_required",
      criticalToolFailure: { name: "ticket_update", error: "connect EPERM" },
    });
  });

  it("exit before settle marks crash, records activity, blocks the item", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onExit(1);
    expect(getRun(db, runId)!.state).toBe("failed");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    const kinds = listActivities(db, itemId).map((a) => a.kind);
    expect(kinds).toContain("crash");
  });

  // 回归（工单 03）：payload 里 reason 排在错误码前面，Lead 的 get_ticket 按 200 字截断时把错误码截掉了。
  it("writes the error codes of a crash activity before its reason", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "run.failed", exitCode: 1, errorCode: "codex_error", error: `stack ${"x".repeat(1_000)}` });
    const crash = listActivities(db, itemId).find((activity) => activity.kind === "crash")!;
    expect(Object.keys(JSON.parse(crash.payload)).slice(0, 3)).toEqual(["errorCode", "failureScope", "failureCode"]);
    expect(crash.payload.slice(0, 200)).toContain("codex_error");
  });
});

// 诉求（defect 3）：重试耗尽之后要**停**。事故里 #38 的 child 连崩，账本上「系统更新 ·
// Run crashed」的卡片一张不少（通知那条路是好的，不动它），缺的是刹车：没有任何东西
// 告诉系统"这条线到此为止，把决定权交回用户"，于是 lead 一次次重开。
//
// 两种真实的失败形状都要走通：codex_error 带 HTTP 400 invalid_request_error 正文，
// 以及 process_exit exit=1 "Pi process exited before agent_end"。
describe("retry exhaustion halts the line of work", () => {
  const CODEX_400 = '{"type":"error","status":400,"error":'
    + '{"type":"invalid_request_error","message":"unsupported parameter"}}';
  const PI_EXIT = "Pi process exited before agent_end (1)";

  const crash = (id: number, run: number, errorCode: string, error: string, exitCode: number | null) => {
    createIngestor(db, { itemId: id, runId: run })
      .onEvent({ type: "run.failed", exitCode, errorCode, error });
  };

  it("allows retries up to retry_limit, then refuses and says why", () => {
    expect(getItem(db, itemId)!.retry_limit).toBe(1); // 缺省 1 → 首跑 + 1 次重试

    crash(itemId, runId, "codex_error", CODEX_400, null);
    expect(getRun(db, runId)!.state).toBe("failed");
    // 预算还没用完：重试必须仍然放行，否则"重试上限"就成了"一次都不许重试"。
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .not.toThrow();
    expect(getItem(db, itemId)!.plan_state).not.toBe("failed");

    transition(db, { itemId, to: "active", actor: "system", reason: "retry" });
    const second = createRun(db, { itemId });
    crash(itemId, second, "process_exit", PI_EXIT, 1);

    // 刹车：闸门是硬的，每条派发路径（lead 的 spawn_child、scheduler、编排器）都过它。
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .toThrow(/重试已耗尽[\s\S]*2\/1[\s\S]*用户/);
    expect(() => createRun(db, { itemId })).toThrow(/重试已耗尽/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(2);
  });

  it("makes the exhaustion visible in the ledger, not only at the gate", () => {
    crash(itemId, runId, "codex_error", CODEX_400, null);
    transition(db, { itemId, to: "active", actor: "system", reason: "retry" });
    crash(itemId, createRun(db, { itemId }), "process_exit", PI_EXIT, 1);

    expect(getItem(db, itemId)!.plan_state).toBe("failed");
    const blockers = listInbox(db, {}).filter((row) => row.severity === "blocker");
    // 宣告并进"让它停下的那一次崩溃"的 blocker 里，而不是另发一条：inbox 对同一 scope
    // 一小时内第三条 blocker 会熔断成聚合行，而按缺省 retry_limit=1 耗尽正好发生在第二次
    // 崩溃时——另发就正好是第三条，最该被读到的那句话每次都会被折叠掉。
    const halt = blockers.find((row) => /重试已耗尽/.test(row.summary));
    expect(halt?.summary).toMatch(/child crash/);
    expect(halt?.summary).toMatch(/2\/1/);
    expect(halt?.summary).toMatch(/用户/);
  });

  // 每次崩溃都重算，但耗尽这件事只宣告一次：否则同一条 blocker 会随每次崩溃复读。
  it("announces the halt once", () => {
    crash(itemId, runId, "codex_error", CODEX_400, null);
    transition(db, { itemId, to: "active", actor: "system", reason: "retry" });
    const second = createRun(db, { itemId });
    crash(itemId, second, "process_exit", PI_EXIT, 1);
    // 同一条 run 再来一次退出事件（onExit 紧随 run.failed 是常态）不该再宣告一次。
    createIngestor(db, { itemId, runId: second }).onExit(1);

    const halts = listInbox(db, {}).filter((row) => /重试已耗尽/.test(row.summary));
    expect(halts).toHaveLength(1);
  });

  // 上限是可调的：retry_limit=0 表示"崩了就停"，不许重试。
  it("honours retry_limit=0 as no retry at all", () => {
    db.prepare("UPDATE items SET retry_limit=0 WHERE id=?").run(itemId);
    crash(itemId, runId, "process_exit", PI_EXIT, 1);
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .toThrow(/重试已耗尽/);
    expect(getItem(db, itemId)!.plan_state).toBe("failed");
  });

  it("does not charge host spawn failures against the business retry budget", () => {
    crash(itemId, runId, "spawn_error", "spawn codex ENOENT", null);

    expect(executorRetryBudget(db, itemId)).toEqual({
      failures: 0,
      retryLimit: 1,
      exhausted: false,
    });
    expect(getItem(db, itemId)!.plan_state).not.toBe("failed");
  });

  it("repairs a stale exhausted plan marker created by an older spawn-error classifier", () => {
    crash(itemId, runId, "spawn_error", "spawn codex ENOENT", null);
    db.prepare("UPDATE items SET plan_state='failed' WHERE id=?").run(itemId);

    expect(repairNonBudgetRetryExhaustion(db)).toBe(1);
    expect(getItem(db, itemId)!.plan_state).toBe("none");
    expect(listActivities(db, itemId).some((activity) =>
      activity.kind === "decision" && activity.payload.includes("retry_exhaustion_repaired"))).toBe(true);
    expect(repairNonBudgetRetryExhaustion(db)).toBe(0);
  });

  // 停的是执行，不是评审：reviewer 有自己那套重试（orchestrator.ts）。
  it("does not gate the reviewer path", () => {
    crash(itemId, runId, "process_exit", PI_EXIT, 1);
    transition(db, { itemId, to: "active", actor: "system", reason: "retry" });
    crash(itemId, createRun(db, { itemId }), "process_exit", PI_EXIT, 1);
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    expect(() => assertRunAllowed(db, { itemId, role: "reviewer", purpose: "review" }))
      .not.toThrow();
  });
});

// 2026-10-28 晚到 10-29 上午：4M 预算告警按 Run 发。#158 的 Run #180、#182 各发一条，#161 的 Run #191、#192 各发一条，
// Lead 每条都要花一轮记 no_action。告警是工单的事：同一张工单越过一个档位只说一次，档位按预算翻倍（4M、8M、16M…）。
describe("token budget alert", () => {
  const budgetAlerts = () => listInbox(db)
    .filter((row) => row.item_id === itemId && JSON.parse(row.payload).kind === "token_budget_exceeded");
  // Lead 处理完了这张工单的告警（线上 #368 在 Run #182 开始前已经 consumed）。还 pending 的告警会把新的一条合并进去。
  const leadHandledAlerts = () => markInbox(db, budgetAlerts().map((row) => row.id), "consumed");

  beforeEach(() => {
    vi.stubEnv("PLC_BUDGET_TOKENS", "1000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("alerts once per ticket, not again for each new run while under the next threshold", () => {
    createIngestor(db, { itemId, runId }).onEvent(usage("cumulative", 1_500, null));
    expect(budgetAlerts()).toHaveLength(1);
    leadHandledAlerts();

    const second = createIngestor(db, { itemId, runId: createRun(db, { itemId }) });
    second.onEvent(usage("cumulative", 200, null));
    second.onEvent(usage("cumulative", 400, null));
    expect(getItem(db, itemId)!.total_tokens).toBe(1_900);
    expect(budgetAlerts()).toHaveLength(1);
  });

  it("alerts again only when the ticket passes the next, doubled threshold", () => {
    createIngestor(db, { itemId, runId }).onEvent(usage("cumulative", 1_500, null));
    leadHandledAlerts();
    const second = createIngestor(db, { itemId, runId: createRun(db, { itemId }) });
    second.onEvent(usage("cumulative", 400, null));
    leadHandledAlerts();
    second.onEvent(usage("cumulative", 700, null));

    const alerts = budgetAlerts().map((row) => JSON.parse(row.payload) as { threshold: number; budget: number });
    expect(alerts.map((payload) => payload.threshold)).toEqual([1_000, 2_000]);
    expect(alerts.every((payload) => payload.budget === 1_000)).toBe(true);
    expect(budgetAlerts().at(-1)!.summary).toContain("2000");
  });

  // 一次用量就跨过好几档：只说最高的那一档，一条。
  it("names the highest threshold passed when one update passes several", () => {
    createIngestor(db, { itemId, runId }).onEvent(usage("cumulative", 4_500, null));
    expect(budgetAlerts().map((row) => JSON.parse(row.payload).threshold)).toEqual([4_000]);
  });

  // 线上已有的旧告警行没有 threshold，按 budget 算：上线以后同一张工单的下一个 Run 不再从头告警。
  it("counts a legacy alert row without a threshold as the budget threshold", () => {
    db.prepare("UPDATE items SET total_tokens = 1500 WHERE id = ?").run(itemId);
    addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} 预算告警：累计 tokens 已超 1000`,
      payload: { kind: "token_budget_exceeded", runId, budget: 1_000, wakeLead: true, needsUser: false },
    });
    leadHandledAlerts();
    createIngestor(db, { itemId, runId: createRun(db, { itemId }) }).onEvent(usage("cumulative", 100, null));
    expect(budgetAlerts()).toHaveLength(1);
  });

  // 线上 #158：Run #181 的告警被去抖并进了 Run 结束的说明 #370，inbox 里没有它自己的行。它也算告警过。
  it("counts an alert that was merged into another notice of the ticket", () => {
    addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} 的 Run #${runId} 结束了`,
      payload: { kind: "run_finished", runId, wakeLead: true, needsUser: false }, lossless: true,
    });
    createIngestor(db, { itemId, runId }).onEvent(usage("cumulative", 1_500, null));
    expect(budgetAlerts()).toHaveLength(0);
    markInbox(db, listInbox(db).map((row) => row.id), "consumed");

    createIngestor(db, { itemId, runId: createRun(db, { itemId }) }).onEvent(usage("cumulative", 100, null));
    expect(budgetAlerts()).toHaveLength(0);
  });

  // daemon 重启后接管同一个 Run：重放的事件只重建用量账，之后的用量不再告警。
  it("does not alert again after the run is adopted by a restarted daemon", () => {
    const first = createIngestor(db, { itemId, runId });
    const seen = [usage("cumulative", 1_500, null)];
    for (const event of seen) first.onEvent(event);
    leadHandledAlerts();
    const adopted = createIngestor(db, { itemId, runId });
    for (const event of seen) adopted.restore(event);
    adopted.onEvent(usage("cumulative", 1_800, null));
    expect(budgetAlerts()).toHaveLength(1);
  });
});
