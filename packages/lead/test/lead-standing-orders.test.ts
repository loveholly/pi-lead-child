// Lead 读常设指令（工单 05，spec D4、用户故事 23）：系统提示里有一份清单（编号、版本、标题），
// list_standing_orders 和 get_standing_order 读完整内容。改用 propose_standing_order_change（工单 10，见 lead-standing-order-changes.test.ts）。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  openDb, recordStandingOrderVersion, renderStandingOrdersForLead, SYSTEM_STANDING_ORDERS, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT, renderLeadSystemPrompt } from "../src/prompt.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";

let db: Db;
let deps: LeadDeps;

beforeEach(() => {
  const dir = tempDir("plc-lead-standing-orders-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = { db, dbPath, dataDir: dir };
});

async function call(name: string, params: Record<string, unknown>): Promise<any> {
  const tool = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!tool) throw new Error(`tool ${name} not found`);
  const result = await tool.execute("call", params);
  return JSON.parse(result.content.map((part: { text?: string }) => part.text ?? "").join("\n"));
}

const fuse = SYSTEM_STANDING_ORDERS.find((order) => order.id === "inbox.fuse_blockers")!;

describe("Lead reads the standing orders", () => {
  it("lists every active standing order with its version", async () => {
    const report = await call("list_standing_orders", {});
    expect(report.note).toContain("propose_standing_order_change");
    expect(report.orders.map((order: { id: string }) => order.id).sort())
      .toEqual(SYSTEM_STANDING_ORDERS.map((order) => order.id).sort());
    expect(report.orders.find((order: { id: string }) => order.id === "inbox.wake_lead")).toEqual({
      id: "inbox.wake_lead", version: 1, title: expect.stringContaining("叫醒 Lead"), status: "active", author: "system",
      priority: 30, action: "rule", rule: "inbox.wake_lead", level: "tell", escalate_to: null,
    });
  });

  it("reads one standing order in full, any version, with its history", async () => {
    recordStandingOrderVersion(db, { ...fuse, limits: { count: 4, windowMs: 3_600_000 }, reason: "用户放宽熔断" },
      { author: "user", approvedBy: "user" });
    const latest = await call("get_standing_order", { id: "inbox.fuse_blockers" });
    expect(latest.order).toMatchObject({
      id: "inbox.fuse_blockers", version: 2, author: "user", approved_by: "user", reason: "用户放宽熔断",
      limits: { count: 4, windowMs: 3_600_000 }, condition: fuse.condition, action: fuse.action, escalate_to: "tell",
    });
    expect(latest.versions.map((entry: { version: number; author: string; seed_revision: number | null }) =>
      [entry.version, entry.author, entry.seed_revision])).toEqual([[1, "system", 1], [2, "user", null]]);
    const first = await call("get_standing_order", { id: "inbox.fuse_blockers", version: 1 });
    expect(first.order).toMatchObject({ version: 1, limits: { count: 3, windowMs: 3_600_000 } });
    await expect(call("get_standing_order", { id: "inbox.nothing" })).rejects.toThrow(/list_standing_orders/);
  });

  it("lists a disabled order only on request", async () => {
    recordStandingOrderVersion(db, { ...SYSTEM_STANDING_ORDERS.find((order) => order.id === "notification.batchable")!, reason: "停用" },
      { author: "user", status: "disabled" });
    const ids = async (params: Record<string, unknown>) =>
      (await call("list_standing_orders", params)).orders.map((order: { id: string }) => order.id);
    expect(await ids({})).not.toContain("notification.batchable");
    expect(await ids({ include_disabled: true })).toContain("notification.batchable");
  });

  it("treats both tools as quiet reads", () => {
    expect(LEAD_QUIET_TOOLS.has("list_standing_orders")).toBe(true);
    expect(LEAD_QUIET_TOOLS.has("get_standing_order")).toBe(true);
  });

  it("puts the list of titles and versions in the system prompt, between the discipline and the core memory", () => {
    const prompt = renderLeadSystemPrompt("## 核心记忆\n用户叫小王", renderStandingOrdersForLead(db));
    expect(prompt.startsWith(LEAD_SYSTEM_PROMPT)).toBe(true);
    const section = prompt.indexOf("## 常设指令");
    expect(section).toBeGreaterThan(LEAD_SYSTEM_PROMPT.length - 1);
    expect(prompt.indexOf("## 核心记忆")).toBeGreaterThan(section);
    expect(prompt).toContain(`- inbox.fuse_blockers v1：${fuse.title}`);
    expect(LEAD_SYSTEM_PROMPT).toContain("list_standing_orders");
    // 没有清单时和以前一样。
    expect(renderLeadSystemPrompt("记忆")).toBe(`${LEAD_SYSTEM_PROMPT}\n\n记忆`);
    expect(renderLeadSystemPrompt()).toBe(LEAD_SYSTEM_PROMPT);
  });
});
