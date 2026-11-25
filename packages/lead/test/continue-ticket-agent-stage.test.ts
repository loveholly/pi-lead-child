import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, createRun, listRuns, transition, updateRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { ItemStage } from "@pi-lead-child/core";
import { continueNeedsExecutorRefusal, createLeadTools, runningChildren, type LeadDeps } from "../src/tools.js";

// 工单 #550（2026-11-25）：Lead 对 done 和 review 的工单调 continue_ticket_agent，要执行者 rebase PR。
// 工具续接了最近的会话：那是核查员的，于是起来的是只读核查员。它报
// `executor run requires stage in {ready, active, blocked}` 就退出，Lead 拿到的却是一次成功的交付。

let db: Db;
let deps: LeadDeps;

function tool(name: string) {
  return createLeadTools(deps).find((t: any) => t.name === name) as any;
}

async function callContinue(itemId: number, needsChanges: boolean) {
  const result = await tool("continue_ticket_agent").execute("t", {
    ticket_id: itemId, instruction: "把分支 rebase 到最新的 origin/master，解决冲突后提交。", needs_changes: needsChanges,
  });
  return JSON.parse(result.content[0].text);
}

function finishedRun(itemId: number, role: "executor" | "reviewer", session: string): number {
  const runId = createRun(db, { itemId, role, runtime: "pi" });
  updateRun(db, runId, { state: "finished", externalSessionId: session, sessionId: session, endedAt: true });
  return runId;
}

// 和事故里一样的工单：执行者交付过，核查员核查过，最近能续接的会话是核查员的。
function deliveredTicket(stage: "review" | "done"): number {
  const itemId = createItem(db, { title: "rebase PR", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  finishedRun(itemId, "executor", "executor-session");
  transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
  finishedRun(itemId, "reviewer", "reviewer-session");
  if (stage === "done") transition(db, { itemId, to: "done", actor: "system", reason: "accepted" });
  return itemId;
}

function ticketIn(stage: "ready" | "active" | "blocked"): number {
  const itemId = createItem(db, { title: "running work", brief: "b", createdBy: "system" });
  if (stage !== "ready") transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  if (stage === "blocked") transition(db, { itemId, to: "blocked", actor: "system", reason: "waiting" });
  return itemId;
}

beforeEach(() => {
  const dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
  };
});

afterEach(async () => {
  await Promise.allSettled([...runningChildren().values()]);
  db.close();
});

describe("continueNeedsExecutorRefusal", () => {
  it("lets ready, active and blocked through and refuses every other task stage", () => {
    for (const stage of ["ready", "active", "blocked"] as ItemStage[]) {
      expect(continueNeedsExecutorRefusal({ id: 7, stage })).toBeNull();
    }
    for (const stage of ["draft", "review", "done", "cancelled"] as ItemStage[]) {
      expect(continueNeedsExecutorRefusal({ id: 7, stage })).toMatchObject({
        mode: "refused", code: "executor_unavailable", ticketId: 7, stage, delivered: false,
      });
    }
  });

  it("names the next step for each stage", () => {
    expect(continueNeedsExecutorRefusal({ id: 7, stage: "review" })!.nextStep).toMatch(/ticket_action[\s\S]*rework/);
    expect(continueNeedsExecutorRefusal({ id: 7, stage: "done" })!.nextStep)
      .toMatch(/create_task[\s\S]*target_ticket_id: 7, relation_type: "relates_to"/);
    expect(continueNeedsExecutorRefusal({ id: 7, stage: "draft" })!.nextStep).toMatch(/confirm/);
  });
});

describe("continue_ticket_agent on a ticket that cannot run an executor", () => {
  it.each(["review", "done"] as const)("refuses work that needs changes on a %s ticket and starts no run", async (stage) => {
    const itemId = deliveredTicket(stage);
    const before = listRuns(db, itemId).length;

    const payload = await callContinue(itemId, true);

    expect(payload).toMatchObject({ mode: "refused", code: "executor_unavailable", ticketId: itemId, stage, delivered: false });
    expect(payload.reason).toContain("指令没有发出");
    expect(payload.nextStep).toMatch(stage === "review" ? /rework/ : /create_task[\s\S]*relates_to/);
    expect(payload.runId).toBeUndefined();
    expect(listRuns(db, itemId)).toHaveLength(before);
    expect(runningChildren().has(itemId)).toBe(false);
  });

  it("still answers a question on a done ticket, and says the conversation is read-only", async () => {
    const itemId = deliveredTicket("done");

    const payload = await callContinue(itemId, false);

    expect(payload).toMatchObject({ mode: "resumed", ticketId: itemId, role: "reviewer", readOnly: true });
    expect(payload.note).toContain("只能回答问题");
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });
  }, 30_000);
});

describe("continue_ticket_agent on a ticket that can run an executor (unchanged)", () => {
  it.each(["ready", "active", "blocked"] as const)("delivers the instruction on a %s ticket", async (stage) => {
    const itemId = ticketIn(stage);
    const resumeFrom = stage === "ready" ? null : finishedRun(itemId, "executor", `session-${stage}`);

    const payload = await callContinue(itemId, true);

    expect(payload).toMatchObject({
      mode: resumeFrom ? "resumed" : "started", ticketId: itemId, role: "executor", resumedFromRunId: resumeFrom,
    });
    expect(payload).not.toHaveProperty("readOnly");
    expect(payload).not.toHaveProperty("code");
    expect(listRuns(db, itemId).at(-1)).toMatchObject({ id: payload.runId, purpose: "conversation" });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });
  }, 30_000);
});
