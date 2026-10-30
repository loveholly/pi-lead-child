import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import registerExtension from "../src/extension/ticket-tools.js";

let db: Db;
let dbPath: string;
let itemId: number;
let tool: any;
let notifyTool: any;

beforeEach(() => {
  dbPath = join(tempDir("plc-"), "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "" });
  const runId = createRun(db, { itemId });
  process.env.PLC_DB = dbPath;
  process.env.PLC_TICKET_ID = String(itemId);
  process.env.PLC_ATTEMPT_ID = String(runId);
  const tools: any[] = [];
  registerExtension({ registerTool: (t: any) => tools.push(t), on: () => {} } as any);
  tool = tools.find((t) => t.name === "ticket_update");
  notifyTool = tools.find((t) => t.name === "notify_lead");
});
afterEach(() => {
  delete process.env.PLC_DB; delete process.env.PLC_TICKET_ID; delete process.env.PLC_ATTEMPT_ID;
});

describe("ticket_update tool", () => {
  it("appends milestone to body and records activity", async () => {
    const res = await tool.execute("tc1", { body_append: "阶段一完成" });
    expect(res.content[0].text).toContain(`#${itemId}`);
    expect(getItem(db, itemId)!.body).toContain("阶段一完成");
    expect(listActivities(db, itemId).map((a) => a.kind)).toContain("milestone");
  });

  it("transitions to review when child claims done", async () => {
    await tool.execute("tc2", {
      body_append: "全部完成",
      status: "review",
      reason: "完成",
      checkpoint: {
        kind: "completed",
        title: "实现完成",
        summary: "指定工作已完成并准备进入独立验收。",
        next_step: "请 reviewer 核查结果。",
      },
    });
    expect(getItem(db, itemId)!.stage).toBe("review");
  });

  it("notify_lead writes semantic inbox entry", async () => {
    const { listInbox } = await import("@pi-lead-child/store");
    const res = await notifyTool.execute("tn", { severity: "blocker", summary: "需要决策：方案 A 还是 B" });
    expect(res.content[0].text).toContain("已通知");
    const rows = listInbox(db, { state: ["pending"], severity: "blocker" });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("semantic");
    expect(rows[0].summary).toContain("需要决策");
  });

  it("rejects privileged status via the shared permission matrix", async () => {
    // schema 枚举不含 done；即便绕过 schema 也会被 transition 的 child 矩阵拦截
    await expect(tool.execute("tc3", { body_append: "x", status: "done" }))
      .rejects.toThrow();
  });
});
