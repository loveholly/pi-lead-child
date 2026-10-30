// Lead 用 propose_standing_order_change 改常设指令（工单 10，spec D4）。档位由系统判断：
// 更保守的马上生效；更放开的生成审批，Lead 自己（perform_action 的审批 resolve）批不了；碰到硬性规则的被拒绝，什么也不写。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  getApproval, getStandingOrder, listEvents, listStandingOrderProposals, listStandingOrderVersions, openDb, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";

let db: Db;
let deps: LeadDeps;

beforeEach(() => {
  const dir = tempDir("plc-lead-standing-order-changes-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = { db, dbPath, dataDir: dir };
});

function tool(name: string): any {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function propose(params: Record<string, unknown>): Promise<any> {
  const result = await tool("propose_standing_order_change").execute("call", params);
  return JSON.parse(result.content.map((part: { text?: string }) => part.text ?? "").join("\n"));
}

describe("propose_standing_order_change", () => {
  it("applies a conservative change at once and says the user sees it in 「Lead 动态」", async () => {
    const result = await propose({
      op: "update", id: "notification.batchable", reason: "逾期通知要单独告诉我", action: { type: "level", level: "tell" }, escalate_to: null,
    });
    expect(result).toMatchObject({ result: "applied", tier: "conservative", order: { id: "notification.batchable", version: 2 } });
    expect(result.next).toContain("Lead 动态");
    expect(getStandingOrder(db, "notification.batchable")).toMatchObject({ version: 2, author: "lead" });
    expect(listEvents(db, { kind: "standing_order.changed" })).toHaveLength(1);
  });

  it("turns a permissive change into an approval that Lead cannot resolve itself", async () => {
    const result = await propose({ op: "disable", id: "notification.immediate", reason: "即时通知我自己会看" });
    expect(result).toMatchObject({ result: "pending_approval", tier: "permissive" });
    expect(result.next).toContain(`StandingOrderChangeConfirm 卡（approval 填 ${result.approval_id}）`);
    expect(getStandingOrder(db, "notification.immediate")).toMatchObject({ version: 1, status: "active" });

    // Lead 不能用 perform_action 批准，哪怕它说是用户在会话里同意的：它是 user_direct，总是拿到结构化的拒绝。
    const refused = await tool("perform_action").execute("call", {
      target_type: "approval", target_id: String(result.approval_id), action: "resolve", input: { decision: "approve" },
      reason: "用户在会话里同意了",
    });
    expect(JSON.parse(refused.content[0].text)).toMatchObject({
      refused: true,
      refusal: { code: "user_direct", permission: "user_direct", where: "会话里的确认卡，或者 设置 → Lead → 常设指令" },
    });
    expect(getApproval(db, result.approval_id)?.status).toBe("pending");
    expect(listStandingOrderVersions(db, "notification.immediate")).toHaveLength(1);
    // list_approvals 照常列出它，用户问「有什么要我批的」时能看到。
    const listed = await tool("list_approvals").execute("call", {});
    expect(listed.content[0].text).toContain("standing_order.change");
  });

  it("refuses a change that hits a hard rule, and one that changes nothing", async () => {
    await expect(propose({ op: "disable", id: "reminder.fire", reason: "提醒太多" })).rejects.toThrow(/硬性安全规则/);
    await expect(propose({ op: "update", id: "inbox.no_wake", reason: "x", priority: 40 })).rejects.toThrow(/一样/);
    await expect(propose({ op: "update", id: "inbox.no_wake", reason: "x", action: { type: "level", level: "tell" } }))
      .rejects.toThrow(/escalate_to/);
    expect(listStandingOrderProposals(db)).toEqual([]);
    expect(listStandingOrderVersions(db, "reminder.fire")).toHaveLength(1);
  });

  it("rolls back to the previous version through the same tiers", async () => {
    await propose({ op: "update", id: "notification.batchable", reason: "先告诉我", action: { type: "level", level: "tell" }, escalate_to: null });
    const back = await propose({ op: "rollback", id: "notification.batchable", reason: "回到原来的" });
    expect(back).toMatchObject({ result: "pending_approval" });
    expect(getStandingOrder(db, "notification.batchable")?.version).toBe(2);
  });

  it("is not a quiet tool: a turn that changes a standing order keeps its record", () => {
    expect(LEAD_QUIET_TOOLS.has("propose_standing_order_change")).toBe(false);
  });
});
