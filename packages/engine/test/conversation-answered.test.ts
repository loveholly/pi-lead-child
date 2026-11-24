// 工单对话正常答完时谁会被叫醒。决策边界：谁发起的这次对话。
// Lead 发起的（continue_ticket_agent）：叫醒 Lead，说明里带执行者最后的回复。以前一律不叫醒，执行者交回的结论就沉了。
// 用户本人发起的：不叫醒 Lead，用户在工单对话里直接看到回答。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addActivity, createItem, createRun, getRun, inboxWakesLead, listInbox, listNotifications, openDb, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIngestor } from "../src/pipeline/ingest.js";

let db: Db;
let itemId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-chat-answered-"), "plc.db"));
  itemId = createItem(db, { title: "Deploy check", brief: "verify", createdBy: "user" });
});

function chat(actor: "user" | "lead", events: any[]): number {
  const runId = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
  addActivity(db, { itemId, runId, actor, kind: "comment", payload: { content: "再试一次连目标主机", route: "ticket_agent_resume" } });
  const ingest = createIngestor(db, { itemId, runId });
  ingest.onEvent({ type: "agent_start" });
  for (const event of events) ingest.onEvent(event);
  return runId;
}

const itemRows = () => listInbox(db, {}).filter((row) => row.item_id === itemId);

describe("a ticket chat that finished normally", () => {
  it("wakes Lead with the executor's last reply when Lead asked", () => {
    const runId = chat("lead", [
      { type: "message.completed", messageId: "m1", role: "assistant", text: "先看一下网络。" },
      { type: "message.completed", messageId: "m2", role: "assistant", text: "沙箱连不到目标主机，没做成，需要 Lead 在沙箱外替我跑。" },
      { type: "run.completed" },
    ]);
    const rows = itemRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.severity).toBe("attention");
    expect(inboxWakesLead(row, db)).toBe(true);
    expect(row.summary).toContain("沙箱连不到目标主机，没做成，需要 Lead 在沙箱外替我跑。");
    expect(row.summary).not.toContain("先看一下网络");
    expect(JSON.parse(row.payload)).toEqual(expect.objectContaining({
      kind: "conversation_run_finished", runId, requestedBy: "lead", wakeLead: true, needsUser: false,
    }));
    expect(listNotifications(db, {}).filter((n) => n.item_id === itemId)).toEqual([]);
    expect(getRun(db, runId)!.state).toBe("finished");
  });

  it("reads the reply from a raw pi message_end and truncates a long one", () => {
    const long = "结论".repeat(2_000);
    chat("lead", [
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: long }] } },
      { type: "agent_end" },
    ]);
    const [row] = itemRows();
    expect(row!.summary).toContain("结论结论");
    expect(row!.summary).toContain("已截断");
    expect(row!.summary.length).toBeLessThan(1_700);
  });

  it("says once even when both terminal events arrive", () => {
    chat("lead", [
      { type: "message.completed", messageId: "m1", role: "assistant", text: "做完了。" },
      { type: "run.completed" },
      { type: "agent_end" },
    ]);
    expect(itemRows()).toHaveLength(1);
  });

  it("stays quiet when the user asked", () => {
    chat("user", [
      { type: "message.completed", messageId: "m1", role: "assistant", text: "沙箱连不到目标主机。" },
      { type: "run.completed" },
    ]);
    expect(itemRows()).toEqual([]);
    expect(listNotifications(db, {}).filter((n) => n.item_id === itemId)).toEqual([]);
  });

  it("keeps the failure note, and only it, when Lead's chat ends with an LLM error", () => {
    const runId = chat("lead", [
      { type: "message.completed", messageId: "m1", role: "assistant", text: "", stopReason: "error", error: "rate limited" },
      { type: "run.completed" },
    ]);
    const rows = itemRows();
    expect(rows.map((row) => JSON.parse(row.payload).kind)).toEqual(["conversation_run_failed"]);
    expect(rows[0]!.summary).toContain(`对话 Run #${runId} 以 LLM 错误结束`);
  });

  it("keeps the failure note, and only it, when Lead's chat crashes", () => {
    chat("lead", [
      { type: "message.completed", messageId: "m1", role: "assistant", text: "开始。" },
      { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: "boom" },
    ]);
    expect(itemRows().map((row) => JSON.parse(row.payload).kind)).toEqual(["conversation_run_failed"]);
  });
});
