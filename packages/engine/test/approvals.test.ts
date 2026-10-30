import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import {
  createApproval, getApproval, pendingApprovals, resolveApproval,
  expireStale, isSessionExempt, resolveApprovalAuthority,
} from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import registerExtension from "../src/extension/ticket-tools.js";

let db: Db;
let dbPath: string;
let itemId: number;
let runId: number;
beforeEach(() => {
  const dir = tempDir("plc-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
});

const checkpoint = {
  title: "Approval required",
  summary: "The requested action cannot proceed without explicit authorization.",
  next_step: "Continue only after the approval is granted.",
};

describe("approvals DAO", () => {
  it("create → pending → resolve", () => {
    const id = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件给 X" });
    expect(pendingApprovals(db).length).toBe(1);
    resolveApproval(db, id, "approved", "user");
    expect(getApproval(db, id)!.status).toBe("approved");
    expect(pendingApprovals(db).length).toBe(0);
  });

  it("expireStale flips overdue pending to expired", () => {
    const id = createApproval(db, {
      itemId, requestedBy: "child", tool: "x", action: "a", ttlMs: -1, now: new Date(),
    });
    expect(expireStale(db, new Date())).toContain(id);
    expect(getApproval(db, id)!.status).toBe("expired");
  });

  it("session exemption: acceptForSession lets same tool skip", () => {
    const id = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "a" });
    expect(isSessionExempt(db, itemId, "send_email")).toBe(false);
    resolveApproval(db, id, "approved", "user", { sessionExempt: true });
    expect(isSessionExempt(db, itemId, "send_email")).toBe(true);
    expect(isSessionExempt(db, itemId, "place_order")).toBe(false); // 只豁免同 tool
  });

  it("exposes compare-and-set identity for coordinator delegation", () => {
    const id = createApproval(db, { itemId, requestedBy: "child", tool: "send", action: "send" });
    expect(resolveApprovalAuthority(db, id, {
      status: "approved", resolvedBy: "user via cli", sessionExempt: true,
    })).toBe("resolved");
    expect(resolveApprovalAuthority(db, id, {
      status: "approved", resolvedBy: "user via slack", sessionExempt: true,
    })).toBe("idempotent");
    expect(resolveApprovalAuthority(db, id, {
      status: "rejected", resolvedBy: "user via cli", sessionExempt: false,
    })).toBe("conflict");
  });
});

describe("request_approval child tool", () => {
  let tool: any;
  beforeEach(() => {
    process.env.PLC_DB = dbPath;
    process.env.PLC_TICKET_ID = String(itemId);
    process.env.PLC_ATTEMPT_ID = String(runId);
    const tools: any[] = [];
    registerExtension({ registerTool: (t: any) => tools.push(t), on: () => {} } as any);
    tool = tools.find((t) => t.name === "request_approval");
  });

  it("blocks until approved, then returns go-ahead", async () => {
    const p = tool.execute("tc", { tool: "send_email", action: "发周报", checkpoint });
    // 异步批准
    await vi.waitFor(() => expect(pendingApprovals(db).length).toBe(1), { timeout: 2000 });
    resolveApproval(db, pendingApprovals(db)[0].id, "approved", "user");
    const res = await p;
    expect(res.content[0].text).toContain("已获批准");
    expect(res.details.status).toBe("approved");
  });

  it("rejected → tells child not to execute", async () => {
    const p = tool.execute("tc", { tool: "delete", action: "删库", checkpoint });
    await vi.waitFor(() => expect(pendingApprovals(db).length).toBe(1), { timeout: 2000 });
    resolveApproval(db, pendingApprovals(db)[0].id, "rejected", "user");
    const res = await p;
    expect(res.content[0].text).toContain("被拒绝");
  });

  it("session-exempt short-circuits without new approval", async () => {
    const id = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "a" });
    resolveApproval(db, id, "approved", "user", { sessionExempt: true });
    const res = await tool.execute("tc", {
      tool: "send_email", action: "再发一封", checkpoint,
    });
    expect(res.content[0].text).toContain("会话豁免");
    expect(pendingApprovals(db).length).toBe(0); // 没有新建审批
  });

  it("respects abort signal", async () => {
    const ac = new AbortController();
    const p = tool.execute("tc", { tool: "x", action: "a", checkpoint }, ac.signal);
    await vi.waitFor(() => expect(pendingApprovals(db).length).toBe(1), { timeout: 2000 });
    ac.abort();
    const res = await p;
    expect(res.content[0].text).toContain("中止");
  });
});
