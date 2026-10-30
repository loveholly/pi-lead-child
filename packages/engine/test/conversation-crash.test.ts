// 工单对话 Run 崩溃不是 blocker（#66）：工单没有受阻，失败的回执就是这次失败的记录。
// 决策边界：谁发起的这次对话。用户发的：不留 inbox，不发通知。Lead 发的（continue_ticket_agent）：
// 记一条 attention，让 Lead 知道它的请求没答上。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addActivity, createItem, createRun, getItem, listInbox, listNotifications, openDb, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIngestor } from "../src/pipeline/ingest.js";

let db: Db;
let itemId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-chat-crash-"), "plc.db"));
  itemId = createItem(db, { title: "E2E final acceptance", brief: "verify", createdBy: "user" });
});

function crashedChat(actor: "user" | "lead"): number {
  const runId = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
  addActivity(db, { itemId, runId, actor, kind: "comment", payload: { content: "现在还需要我做什么", route: "ticket_agent_resume" } });
  const ingest = createIngestor(db, { itemId, runId });
  ingest.onEvent({ type: "agent_start" });
  ingest.onEvent({
    type: "run.failed", exitCode: 1, errorCode: "process_exit",
    error: "No conversation found with session ID: 20fd5938-01a7-42ce-b4b4-bb1a98831c80",
  });
  return runId;
}

describe("a crashed ticket chat", () => {
  // 2026-10-15 起用户发的消息没答上，Lead 也马上知道（异常先交给 Lead）：它可以换个模型重发。用户只看到那条回执。
  it("tells only Lead when the user asked", () => {
    crashedChat("user");
    const rows = listInbox(db, {}).filter((row) => row.item_id === itemId);
    expect(rows.map((row) => ({ severity: row.severity, payload: JSON.parse(row.payload) }))).toEqual([{
      severity: "attention",
      payload: expect.objectContaining({ kind: "conversation_run_failed", requestedBy: "user", wakeLead: true, needsUser: false }),
    }]);
    expect(listNotifications(db, {}).filter((row) => row.item_id === itemId)).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("ready");
  });

  it("tells Lead with one attention item when Lead asked", () => {
    const runId = crashedChat("lead");
    const rows = listInbox(db, {}).filter((row) => row.item_id === itemId);
    expect(rows.map((row) => row.severity)).toEqual(["attention"]);
    expect(rows[0]!.summary).toContain(`对话 Run #${runId} 没有答完`);
    expect(listNotifications(db, {}).filter((row) => row.item_id === itemId)).toEqual([]);
  });
});
