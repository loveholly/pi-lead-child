// 推回次数（lead-tools-and-routing spec D14）：Lead 每次请用户自己去做一件事，记一条 lead.handed_back，
// get_system_usage 按类别数最近 7 天的次数。能力缺口（gap）的推回就是要修的缺陷。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

describe("record_handback", () => {
  it("records what Lead handed back and why, and the usage report counts it by category", async () => {
    const dir = tempDir("plc-handback-");
    const db = openDb(join(dir, "plc.db"));
    const deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => "turn-1" } as LeadDeps;
    const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
    await tool("record_handback").execute("t", { category: "gap", what: "请用户去设置页看频道有没有被订阅", reason: "没有读订阅列表的工具" });
    await tool("record_handback").execute("t", { category: "presence", what: "请用户自己登录那台机器" });
    const events = listEvents(db, { kind: "lead.handed_back" } as never) as Array<{ level: string; payload: Record<string, unknown> }>;
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.level === "record")).toBe(true);
    expect(events.map((event) => event.payload.turnId)).toEqual(["turn-1", "turn-1"]);
    const usage = JSON.parse((await tool("get_system_usage").execute("t", {})).content[0].text);
    expect(usage.handed_back_last_7_days).toEqual({ floor: 0, presence: 1, gap: 1 });
  });
});
