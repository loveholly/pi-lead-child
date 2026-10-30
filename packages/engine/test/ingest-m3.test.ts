import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIngestor } from "../src/pipeline/ingest.js";

let db: Db;
let itemId: number;
let runId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "" });
  runId = createRun(db, { itemId });
});
afterEach(() => { delete process.env.PLC_BUDGET_TOKENS; });

const okMsg = (tokens = 100) => ({
  role: "assistant", stopReason: "stop",
  usage: { totalTokens: tokens, cost: { total: 0 } },
});

describe("M3 structural notification rules", () => {
  it("stopReason=error → blocker + item blocked at agent_end", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "API key invalid", usage: { totalTokens: 0, cost: { total: 0 } } } });
    ing.onEvent({ type: "agent_end", messages: [] });
    const blockers = listInbox(db, { severity: "blocker" });
    expect(blockers.some((r) => r.summary.includes("LLM error"))).toBe(true);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
  });

  // 工单 13：pi adapter 在 LLM 错误消息之后给出类型化的 run.failed。这时由失败的处理决定谁来行动。
  // 消息到达时就升起 llm_error blocker 的话，账号故障也会请 lead 检查，用户还会多收到一条通知。
  it("stopReason=error followed by a typed run.failed → no llm_error blocker", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "run.started", runtime: "pi", model: null });
    ing.onEvent({ type: "message.completed", messageId: "m-1", role: "assistant", text: "", stopReason: "error" });
    ing.onEvent({
      type: "run.failed", exitCode: null, errorCode: "llm_error", error: "Your workspace is out of credits.",
      failure: { scope: "account", retry: "never", needs: "refill", code: "out_of_credits", evidence: "out of credits" },
    });
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
  });

  // 修复回合（spec D4）不升起新的 blocker，也不改变工单的 stage。来源 Run 原来的 blocker 保留。
  it("a repair turn that completes after stopReason=error → no llm_error blocker, stage unchanged", () => {
    db.prepare("UPDATE runs SET purpose='outcome_repair' WHERE id=?").run(runId);
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "run.started", runtime: "pi", model: null });
    ing.onEvent({ type: "message.completed", messageId: "m-1", role: "assistant", text: "", stopReason: "error" });
    ing.onEvent({ type: "run.completed", exitCode: 0 });
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("crash exit → blocker", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onExit(1);
    expect(listInbox(db, { severity: "blocker" }).some((r) => r.summary.includes("crash"))).toBe(true);
  });

  it("agent_end with the item still active requests deterministic terminal reconciliation", () => {
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "message_end", message: okMsg() });
    const outcome = ing.onEvent({ type: "agent_end", messages: [] });
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(outcome).toEqual({ type: "terminal_handoff_required", criticalToolFailure: null });
    expect(listInbox(db, { severity: "attention" })).toHaveLength(0);
  });

  it("token budget exceeded → attention once per run", () => {
    process.env.PLC_BUDGET_TOKENS = "150";
    const ing = createIngestor(db, { itemId, runId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "message_end", message: okMsg(100) });
    ing.onEvent({ type: "message_end", message: okMsg(100) }); // 越线
    ing.onEvent({ type: "message_end", message: okMsg(100) }); // 不重复
    const rows = listInbox(db, { severity: "attention" });
    const budget = rows.filter((r) => r.summary.includes("预算"));
    expect(budget.length).toBe(1);
  });
});
