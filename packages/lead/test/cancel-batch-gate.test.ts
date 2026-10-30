import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, LEAD_CANCEL_BATCH_LIMIT } from "../src/tools.js";

let db: Db;
let turn: string | null;
let cancelTool: any;
// 会话只在建立时构造一次工具（src/lead/session.ts:88），预算计数器就活在那个闭包里。
// 测试必须照着来——每次调用都重建工具等于每次都重置预算，闸门就测不到了。
const cancel = (id: number) => cancelTool.execute("t", { ticket_id: id, action: "cancel", reason: "test" });

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  turn = "turn-1";
  cancelTool = createLeadTools({ db, currentTurnId: () => turn } as any)
    .find((x: any) => x.name === "ticket_action")!;
});

function makeItems(n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    createItem(db, { title: `t${i}`, brief: "b", createdBy: "system" }));
}

// 取消（ticket_action 的 cancel；2026-10-28 以前是 cancel_item）是 lead 手上的破坏性操作。单条随意，但一轮之内成批清空
// 用户的工单必须先请示——实测它曾在一轮里取消 13 条，包括用户还没决定要不要做的规划。
describe("lead cancel batch gate", () => {
  it("lets the lead cancel up to the limit within one turn", async () => {
    const ids = makeItems(LEAD_CANCEL_BATCH_LIMIT);
    for (const id of ids) await cancel(id);
    for (const id of ids) expect(getItem(db, id)!.stage).toBe("cancelled");
  });

  it("refuses the one that would exceed the limit, and says to ask the user", async () => {
    const ids = makeItems(LEAD_CANCEL_BATCH_LIMIT + 1);
    for (const id of ids.slice(0, LEAD_CANCEL_BATCH_LIMIT)) await cancel(id);
    const extra = ids[LEAD_CANCEL_BATCH_LIMIT]!;
    await expect(cancel(extra)).rejects.toThrow(/请先向用户确认/);
    expect(getItem(db, extra)!.stage).not.toBe("cancelled");
  });

  it("resets on a new turn, so the user can approve and it proceeds", async () => {
    const ids = makeItems(LEAD_CANCEL_BATCH_LIMIT + 1);
    for (const id of ids.slice(0, LEAD_CANCEL_BATCH_LIMIT)) await cancel(id);
    turn = "turn-2";                       // 用户回了话，新的一轮
    const extra = ids[LEAD_CANCEL_BATCH_LIMIT]!;
    await cancel(extra);
    expect(getItem(db, extra)!.stage).toBe("cancelled");
  });
});

// lead 自己发起的回合（blocker、通知、心跳）各有自己的轮次 id，但那不是用户回了话。
// daemon 给出 cancelBudgetTurnId（最近一次用户发起的轮次）时，闸门按它计数：
// 无人值守时，每次唤醒都不会重置预算。
describe("lead cancel batch gate across turns the lead started itself", () => {
  it("keeps one budget while only system turns change the current turn", async () => {
    let current = "turn-user";
    const budget = "turn-user";
    const tool: any = createLeadTools({
      db, currentTurnId: () => current, cancelBudgetTurnId: () => budget,
    } as any).find((x: any) => x.name === "ticket_action")!;
    const ids = makeItems(LEAD_CANCEL_BATCH_LIMIT + 1);
    for (const [index, id] of ids.slice(0, LEAD_CANCEL_BATCH_LIMIT).entries()) {
      current = `turn-system-${index}`;
      await tool.execute("t", { ticket_id: id, action: "cancel", reason: "test" });
    }
    current = "turn-system-next";
    await expect(tool.execute("t", { ticket_id: ids[LEAD_CANCEL_BATCH_LIMIT]!, action: "cancel", reason: "test" }))
      .rejects.toThrow(/请先向用户确认/);
  });
});
