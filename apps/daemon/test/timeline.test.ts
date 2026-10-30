// 日程（左栏改版阶段 3）走完整的持久化路径：Lead 用 set_milestone 记下节点，经 gateway 的 /v1/timeline 读出来，
// 带出处和风险；你在日程里改期，Lead 再改你定的日期时收件箱的「Lead 已处理」告诉你。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "@pi-lead-child/lead";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import { createItem, createTurn, getItem, openDb, setItemTime, type Db } from "@pi-lead-child/store";
import {
  patchGatewayMilestone,
  readGatewayInbox,
  readGatewayTickets,
  readGatewayTimeline,
} from "@pi-lead-child/gateway/testing";

let db: Db;
let dir: string;
let turnId: string;

function leadTool(name: string) {
  const tools = createLeadTools({
    db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([]),
    currentTurnId: () => turnId,
  });
  const found = tools.find((candidate: { name: string }) => candidate.name === name) as
    { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

const day = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const range = () => ({ from: at(-14 * day), to: at(14 * day), timezone: "Asia/Shanghai" });

beforeEach(() => {
  dir = tempDir("plc-timeline-");
  db = openDb(join(dir, "plc.db"));
  turnId = createTurn(db, { originKind: "companion", userText: "#72 明天下午提测" }).id;
});

describe("the agenda through the gateway", () => {
  it("shows a date Lead wrote down, where it came from, and the risk when the ticket is blocked", async () => {
    const ticket = createItem(db, { title: "修复 review 状态投影", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(ticket);
    await leadTool("set_milestone").execute("t", {
      ticket_id: ticket, kind: "test_handoff", at: at(day), quote: "#72 明天下午提测",
    });

    const timeline = await readGatewayTimeline(db, range());
    const entry = timeline.entries.find((candidate) => candidate.ticketId === ticket)!;
    expect(entry).toMatchObject({
      kind: "milestone",
      milestone: { kind: "test_handoff", label: "提测", state: "planned" },
      provenance: { actor: "lead", quote: "#72 明天下午提测", turnId, confidence: "high" },
      status: "upcoming",
      risk: { reason: "ticket_blocked", label: "工单还阻塞" },
      editable: true,
    });
    // 工单行读同一个节点。
    const [summary] = (await readGatewayTickets(db)).filter((candidate) => candidate.id === ticket);
    expect(summary?.nextMilestone).toMatchObject({ kind: "test_handoff", label: "提测" });
  });

  // 回归（issue 04）：已结束工单的截止不进过期区，节点状态也不改。
  it("never lists the due date of an ended ticket as overdue", async () => {
    const done = createItem(db, { title: "已完成", brief: "b", createdBy: "user" });
    const open = createItem(db, { title: "还没做完", brief: "b", createdBy: "user" });
    setItemTime(db, done, { dueAt: at(-3 * day) }, { actor: "user" });
    setItemTime(db, open, { dueAt: at(-2 * day) }, { actor: "user" });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(done);

    const timeline = await readGatewayTimeline(db, range());
    expect(timeline.overdue.map((entry) => entry.ticketId)).toEqual([open]);
    expect(timeline.entries.find((entry) => entry.ticketId === done)).toMatchObject({
      status: "done", milestone: { state: "planned" },
    });
  });

  it("moves a date you set in the agenda, and tells you when Lead changes it again", async () => {
    const ticket = createItem(db, { title: "发布", brief: "b", createdBy: "user" });
    await leadTool("set_milestone").execute("t", { ticket_id: ticket, kind: "release", at: at(3 * day), quote: "周日发布" });
    const [entry] = (await readGatewayTimeline(db, range())).entries;

    await patchGatewayMilestone(db, entry!.milestone!.id, { at: at(4 * day) });
    expect((await readGatewayInbox(db)).leadHandled).toEqual([]);

    await leadTool("update_milestone").execute("t", {
      milestone_id: entry!.milestone!.id, at: at(5 * day), reason: "#72 还阻塞，发布顺延一天",
    });
    const handled = (await readGatewayInbox(db)).leadHandled;
    expect(handled).toEqual([expect.objectContaining({
      ticketId: ticket, problem: `#${ticket} 的「发布」是你定的，Paimon 改了日期`, action: "#72 还阻塞，发布顺延一天",
    })]);
  });

  it("keeps items.due_at on the earliest planned due date", async () => {
    const ticket = createItem(db, { title: "截止", brief: "b", createdBy: "user" });
    await leadTool("set_milestone").execute("t", { ticket_id: ticket, kind: "due", at: at(2 * day), quote: "后天前做完" });
    const due = (await readGatewayTimeline(db, range())).entries[0]!;
    expect(getItem(db, ticket)?.due_at).toBe(due.at);
    await patchGatewayMilestone(db, due.milestone!.id, { state: "cancelled" });
    expect(getItem(db, ticket)?.due_at).toBeNull();
  });
});
