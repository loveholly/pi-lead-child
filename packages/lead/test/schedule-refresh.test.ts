// 改日程的 Lead 工具自己发一条刷新事件（ticket.updated，客户端重取快照）。以前 daemon 按工具名（SCHEDULE_MUTATING_LEAD_TOOLS）
// 另发一份，ui-action-parity P04 去掉了它；这里核对每个工具自己都发了，不然界面会停在旧的日程上。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createLoopbackBinding, createTurn, latestGatewaySeq, openDb, transition, type Db,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;

beforeEach(() => {
  const dir = tempDir("plc-schedule-refresh-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
});

// 这次调用之后写进 gateway_events 的刷新事件。
function refreshesAfter(seq: number): Array<{ itemId: number | null }> {
  return (db.prepare(
    "SELECT item_id, payload FROM gateway_events WHERE seq > ? AND event_type = 'ticket.updated' AND required_scope = 'tickets:view' ORDER BY seq",
  ).all(seq) as Array<{ item_id: number | null; payload: string }>)
    .filter((row) => JSON.parse(row.payload).snapshotRequired === true)
    .map((row) => ({ itemId: row.item_id }));
}

const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const CASES: Array<{ name: string; params: () => Record<string, unknown>; itemOf?: () => number }> = [
  { name: "create_task", params: () => ({ title: "写周报", brief: "b" }) },
  { name: "create_reminder", params: () => ({ title: "体检", remind_at: later(24) }) },
  { name: "update_item", params: () => ({ ticket_id: createItem(db, { title: "旧标题", brief: "b", createdBy: "user" }), title: "新标题" }) },
  { name: "reschedule_reminder", params: () => ({
    ticket_id: createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: later(24) }),
    remind_at: later(48), reason: "用户说推一天",
  }) },
  { name: "defer_item", params: () => ({ ticket_id: createItem(db, { title: "先放着", brief: "b", createdBy: "user" }), until: later(24) }) },
  // 取消是 ticket_action 的 cancel（2026-10-28 删掉了 cancel_item）。
  { name: "ticket_action", params: () => ({ ticket_id: createItem(db, { title: "不做了", brief: "b", createdBy: "user" }), action: "cancel", reason: "用户说不做了" }) },
  { name: "ack_reminder", params: () => {
    const id = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "user", remindAt: later(-1) });
    transition(db, { itemId: id, to: "fired", actor: "system", reason: "due", now: new Date(Date.now() - 60_000) });
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-ack", originBindingId: binding.id, originKind: "paired:companion", userText: "交了", state: "streaming" });
    deps.currentTurnId = () => "turn-ack";
    return { ticket_id: id, reason: "用户说交了" };
  } },
  { name: "create_cron_trigger", params: () => ({ label: "日报", cron: "0 9 * * 1", kind: "reminder", title: "日报" }) },
  { name: "create_once_trigger", params: () => ({ label: "明天", fire_at: later(24), kind: "reminder", title: "看 PR" }) },
  { name: "set_trigger_enabled", params: () => {
    tool("create_cron_trigger").execute("t", { label: "日报", cron: "0 9 * * 1", kind: "reminder", title: "日报" });
    return { trigger_id: 1, enabled: false };
  } },
];

describe("a Lead tool that changes the schedule publishes its own refresh", () => {
  for (const test of CASES) {
    it(test.name, async () => {
      const params = test.params();
      const before = latestGatewaySeq(db);
      const result = await tool(test.name).execute("t", params);
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(refreshesAfter(before).length, test.name).toBeGreaterThan(0);
    });
  }
});
