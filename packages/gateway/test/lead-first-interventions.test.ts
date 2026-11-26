// 免沙箱开关打开时，child 的决定和审批先交给 Lead（用户 2026-11-11）。工单的 attention 要跟着：
// 还在 Lead 手里的不算「等你」，算「Lead 处理中」；Lead 摆给用户以后才算「等你」。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ticketNeedsUser } from "@pi-lead-child/protocol";
import { createRun, openDb, updateRun, type Db } from "@pi-lead-child/store";
import { createCoordinator, enableHostBypass, escalateInterventionToUser } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";

// 用真实的时刻：工单的「很久没有动静」按真实的钟算，固定的旧时刻会让它算成停滞。
const NOW = new Date();
let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-first-gw-"), "plc.db"));
});

// 这张工单的 child 正在跑（挂在它的请求上等答复）。
function runtime(runningItemIds: number[]) {
  return { model: "openai/gpt-5.6-sol", sessionId: "lead-session", busy: false, runningItemIds, aish: { connected: true, bot: "bot" } };
}

function setup(options: { bypass: boolean }) {
  if (options.bypass) enableHostBypass(db, { bindingId: null, resolvedBy: "user via page", reason: "test", now: NOW });
  const coordinator = createCoordinator({ db, now: () => NOW });
  const itemId = coordinator.createRootItem({ title: "build the export page", brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  const service = createControlPlaneService(db, { runtime: () => runtime([itemId]) });
  const summary = () => service.listItems().find((item) => item.id === itemId)!;
  return { coordinator, itemId, runId, summary, service };
}

function askDecision(coordinator: ReturnType<typeof createCoordinator>, itemId: number, runId: number) {
  return coordinator.requestDecision({
    itemId, runId, kind: "blocker", audience: "user", blocking: true,
    prompt: "Replace the missing component or build it?",
    options: [{ id: "replace", label: "Replace" }, { id: "build", label: "Build" }],
    checkpoint: { title: "Component missing", summary: "DateRangePicker is not in the library.", nextStep: "Wait for the choice." },
  }).requestId;
}

function askApproval(coordinator: ReturnType<typeof createCoordinator>, itemId: number, runId: number) {
  const result = coordinator.requestApproval({
    itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin feature/export",
    checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
  });
  if (result.status !== "pending") throw new Error("expected a pending approval");
  return result.approvalId!;
}

describe("ticket attention for child interventions", () => {
  it("switch off: a blocking child decision waits for the user at once (unchanged)", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: false });
    askDecision(coordinator, itemId, runId);
    expect(summary().attention.pendingDecisionCount).toBe(1);
    expect(ticketNeedsUser(summary())).toBe("decision");
  });

  it("switch on: a blocking child decision is with Lead, not with the user", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: true });
    askDecision(coordinator, itemId, runId);
    expect(summary().attention).toEqual({ pendingApprovalCount: 0, blockerCount: 0, leadHandling: true });
    expect(ticketNeedsUser(summary())).toBeNull();
  });

  it("switch on: stays with Lead after Lead's turn consumed the inbox row", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: true });
    askDecision(coordinator, itemId, runId);
    db.prepare("UPDATE inbox SET state='consumed' WHERE item_id = ?").run(itemId);
    expect(summary().attention).toEqual({ pendingApprovalCount: 0, blockerCount: 0, leadHandling: true });
    expect(ticketNeedsUser(summary())).toBeNull();
  });

  it("switch on: the decision waits for the user once Lead escalates it", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: true });
    const requestId = askDecision(coordinator, itemId, runId);
    escalateInterventionToUser(db, { type: "decision_request", id: requestId, reason: "Lead sent a card", now: NOW });
    expect(summary().attention.pendingDecisionCount).toBe(1);
    expect(summary().attention.blockerCount).toBe(1);
    expect(ticketNeedsUser(summary())).toBe("decision");
  });

  it("switch on: a child approval is with Lead until Lead escalates it", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: true });
    const approvalId = askApproval(coordinator, itemId, runId);
    expect(summary().attention).toEqual({ pendingApprovalCount: 0, blockerCount: 0, leadHandling: true });
    expect(ticketNeedsUser(summary())).toBeNull();

    escalateInterventionToUser(db, { type: "approval", id: approvalId, reason: "Lead sent a card", now: NOW });
    expect(summary().attention.pendingApprovalCount).toBe(1);
    expect(ticketNeedsUser(summary())).toBe("approval");
  });

  it("switch on: nothing is left with Lead after the decision is answered", () => {
    const { coordinator, itemId, runId, summary } = setup({ bypass: true });
    const requestId = askDecision(coordinator, itemId, runId);
    coordinator.resolveDecision({ requestId, decision: "select", optionId: "replace", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(summary().attention.leadHandling).toBeUndefined();
    expect(ticketNeedsUser(summary())).toBeNull();
  });

  // #561：Lead 已经答了的决定，在工单详情读的介入接口里也不是待处理，和外面（TicketSummary）一致。
  it("switch on: the detail's intervention list shows a decision Lead answered as resolved, with no buttons", () => {
    const { coordinator, itemId, runId, summary, service } = setup({ bypass: true });
    const requestId = askDecision(coordinator, itemId, runId);
    const before = service.listKernelInterventions({ itemId }).find((item) => item.id === `decision:${requestId}`)!;
    expect(before.state).toBe("pending");

    coordinator.resolveDecision({ requestId, decision: "select", optionId: "replace", actor: { kind: "lead", resolvedBy: "lead" } });

    const detail = service.listKernelInterventions({ itemId });
    expect(detail.filter((item) => item.state === "pending")).toEqual([]);
    expect(detail.find((item) => item.id === `decision:${requestId}`)).toMatchObject({
      state: "resolved", resolvedBy: "lead", actions: [], resolution: { kind: "option", optionId: "replace" },
    });
    expect(service.listKernelInterventions({ itemId, state: "pending" })).toEqual([]);
    expect(ticketNeedsUser(summary())).toBeNull();
  });
});
