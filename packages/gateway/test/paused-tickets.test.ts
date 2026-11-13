// 工单 #111（2026-11-06）：暂停的工单在列表的任何一类里都找不到。
// 实例上 #26、#28 的 Run 从 11-04 起暂停着，#89 刚被暂停。暂停期间 stage 还是 active、runtime 是 idle，TicketSummary 里
// 没有任何暂停的信息；#28、#89 是轻子任务，还被算成 Lead 的后台工作，进了默认收起的组。
// 这里走真实的暂停（pause_run 工单操作）和账本，看投影出来的 TicketSummary、收件箱和「需要你」的规则。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { PAUSE_OVERDUE_MS, ticketNeedsUser, ticketTurn } from "@pi-lead-child/protocol";
import { runTicketAction } from "@pi-lead-child/engine";
import {
  createItem, createRun, insertCheckpoint, markLightTask, openDb, recordExecutionPlan, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-paused-"), "plc.db"));
});

const runtime = () => ({ model: "m", sessionId: "s", busy: false, runningItemIds: [], aish: { connected: false, bot: null } });

function runningTicket(title: string): { itemId: number; runId: number } {
  const itemId = createItem(db, { title, brief: title, createdBy: "lead", runtime: "claude" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  return { itemId, runId };
}

function serviceAt(now: Date) {
  return createControlPlaneService(db, { runtime, now: () => now });
}

describe("a ticket whose run is paused", () => {
  it("carries when, by whom and at which step it paused, and is nobody's turn while fresh", async () => {
    const { itemId, runId } = runningTicket("补测试");
    insertCheckpoint(db, {
      itemId, runId, source: "agent_reported", kind: "progress", title: "改完了解析器", summary: "接着补测试",
      nextStep: null, idempotencyKey: "paused:progress",
    });
    await runTicketAction(db, { itemId, action: "pause_run", caller: { kind: "user" } });

    const pausedAt = new Date(db.prepare("SELECT paused_at FROM runs WHERE id = ?").pluck().get(runId) as string);
    const summary = serviceAt(new Date(pausedAt.getTime() + 60_000)).listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.pause).toEqual({
      attemptId: runId, since: pausedAt.toISOString(), by: "user", lastCheckpoint: "改完了解析器", overdue: false,
    });
    expect(summary.stage).toBe("active");
    expect(ticketTurn(summary)).toBe("queued");
    expect(ticketNeedsUser(summary)).toBeNull();
  });

  // #28 的样子：轻子任务，用户暂停，2 天没动静。以前它算 Lead 的后台工作（turn = lead），进默认收起的组。
  it("needs the user after a day, also for a light task, and the inbox says why and since when", async () => {
    const { itemId, runId } = runningTicket("复盘费用");
    markLightTask(db, itemId, "lead");
    recordExecutionPlan(db, { itemId, runId, steps: [
      { id: "read", title: "读会话记录", status: "done" },
      { id: "count", title: "核对 token 计数", status: "in_progress" },
    ] });
    await runTicketAction(db, { itemId, action: "pause_run", caller: { kind: "user" } });
    const pausedAt = new Date(db.prepare("SELECT paused_at FROM runs WHERE id = ?").pluck().get(runId) as string);

    const later = serviceAt(new Date(pausedAt.getTime() + PAUSE_OVERDUE_MS + 2 * 60 * 60_000));
    const summary = later.listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.worklistVisibility).toBe("background");
    // 没有执行 agent 报的 checkpoint 时，「暂停前在做什么」用执行计划里正在做的那一步。
    expect(summary.pause).toMatchObject({ by: "user", lastCheckpoint: "核对 token 计数", overdue: true });
    expect(ticketNeedsUser(summary)).toBe("paused");
    expect(ticketTurn(summary)).toBe("user");

    const fact = later.inboxView().tickets.find((ticket) => ticket.ticketId === itemId);
    expect(fact).toEqual({
      ticketId: itemId,
      since: pausedAt.toISOString(),
      // 界面缺省是英文（docs/i18n.md）。
      reason: 'You paused it more than a day ago, during "核对 token 计数". Resume or cancel it',
    });
  });

  it("names Lead when Lead paused it, and the system when a refused start put the run back", async () => {
    const byLead = runningTicket("lead paused");
    db.prepare("UPDATE runs SET state = 'paused', paused_at = ? WHERE id = ?").run(new Date().toISOString(), byLead.runId);
    db.prepare("INSERT INTO activities (item_id, run_id, actor, kind, payload) VALUES (?, ?, 'lead', 'decision', ?)")
      .run(byLead.itemId, byLead.runId, JSON.stringify({ decision: "暂停执行" }));
    const bySystem = runningTicket("refused start");
    db.prepare("UPDATE runs SET state = 'paused', paused_at = ? WHERE id = ?").run(new Date().toISOString(), bySystem.runId);
    db.prepare("INSERT INTO activities (item_id, run_id, actor, kind, payload) VALUES (?, ?, 'system', 'decision', ?)")
      .run(bySystem.itemId, bySystem.runId, JSON.stringify({ decision: "run_start_refused", reason: "busy" }));

    const tickets = serviceAt(new Date()).listItems();
    expect(tickets.find((ticket) => ticket.id === byLead.itemId)!.pause).toMatchObject({ by: "lead", lastCheckpoint: null });
    expect(tickets.find((ticket) => ticket.id === bySystem.itemId)!.pause).toMatchObject({ by: "system" });
  });

  it("drops the pause when the ticket is cancelled: a finished ticket never needs the user", async () => {
    const { itemId, runId } = runningTicket("取消它");
    await runTicketAction(db, { itemId, action: "pause_run", caller: { kind: "user" } });
    await runTicketAction(db, { itemId, action: "cancel", caller: { kind: "user" }, reason: "不做了" });
    const pausedAt = Date.parse(db.prepare("SELECT paused_at FROM runs WHERE id = ?").pluck().get(runId) as string ?? new Date().toISOString());

    const summary = serviceAt(new Date(pausedAt + 3 * PAUSE_OVERDUE_MS)).listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.stage).toBe("cancelled");
    expect(summary.pause).toBeUndefined();
    expect(ticketNeedsUser(summary)).toBeNull();
  });

  it("has no pause while its run runs", () => {
    const { itemId } = runningTicket("在跑");
    expect(serviceAt(new Date()).listItems().find((ticket) => ticket.id === itemId)!.pause).toBeUndefined();
  });
});
