// Lead 修改常设指令的流程（工单 10，spec D4）：三档各自怎样落库，更放开的修改在批准前不生效，回滚也写新版本。
// 每个用例都看行为：改完以后同样的事件按新的指令分诊（不只是表里多了一行）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, expireStale, getApproval, getStandingOrder, getStandingOrderProposal, listEvents, listInbox,
  listStandingOrderProposals, listStandingOrderVersions, noteExpiredStandingOrderProposal, openDb, pendingApprovalLine, proposeStandingOrderChange,
  recentStandingOrderExecutions, recordStandingOrderVersion, resolveStandingOrderProposal, rollbackStandingOrderByUser,
  StandingOrderChangeError, STANDING_ORDER_PROPOSAL_TOOL, SYSTEM_STANDING_ORDERS, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-standing-order-changes-"), "plc.db"));
});

const USER = "user via companion";

// 写一条不叫醒 Lead 的 attention（inbox.no_wake 管它的级别），返回它的事件级别和依据。
function attentionLevel(scope: string): { level: string | null; basis: unknown } {
  addInbox(db, { dedupScope: scope, severity: "attention", source: "structural", summary: `测试 ${scope}`, lossless: true,
    payload: { kind: "progress" } });
  const event = listEvents(db, { kind: "inbox.attention", order: "desc", limit: 1 })[0]!;
  return { level: event.level, basis: event.triage?.order };
}

// 写一条 blocker（inbox.wake_lead 管它的级别），返回它的事件级别。
function blockerLevel(scope: string): string | null {
  addInbox(db, { dedupScope: scope, severity: "blocker", source: "structural", summary: `测试 ${scope}`, lossless: true,
    payload: { kind: "test_blocker" } });
  return listEvents(db, { kind: "inbox.blocker", order: "desc", limit: 1 })[0]!.level;
}

const changedEvents = () => listEvents(db, { kind: "standing_order.changed" });

function expectChangeError(run: () => unknown, code: string, message?: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StandingOrderChangeError);
    expect((error as StandingOrderChangeError).code).toBe(code);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a StandingOrderChangeError");
}

describe("a conservative change takes effect at once and is reported", () => {
  it("writes a version by lead, a digest event for 「Lead 动态」, and triages by the new version", () => {
    expect(attentionLevel("before")).toMatchObject({ level: "digest", basis: { id: "inbox.no_wake", version: 1 } });
    const result = proposeStandingOrderChange(db, {
      op: "update", id: "inbox.no_wake", reason: "这些进展用户想马上知道", patch: { action: { type: "level", level: "tell" }, escalateTo: null },
    });
    expect(result.outcome).toBe("applied");
    expect(getStandingOrder(db, "inbox.no_wake")).toMatchObject({
      version: 2, author: "lead", approvedBy: null, reason: "这些进展用户想马上知道", action: { type: "level", level: "tell" },
    });
    const [event] = changedEvents();
    expect(event).toMatchObject({
      source: "lead", level: "digest", entityKey: "standing_order:inbox.no_wake", entityVersion: 2,
      triage: { order: null, hardRules: ["standing_order_change_reported"] },
      payload: { orderId: "inbox.no_wake", version: 2, previousVersion: 1, author: "lead", tier: "conservative", change: "update" },
    });
    expect(attentionLevel("after")).toMatchObject({ level: "tell", basis: { id: "inbox.no_wake", version: 2 } });
    // 没有生成审批。
    expect(listStandingOrderProposals(db)).toEqual([]);
  });

  it("creates a new level order that raises events, and reports nothing when the content is the same", () => {
    const created = proposeStandingOrderChange(db, {
      op: "create", id: "run.failed_tell", reason: "Run 失败要单独告诉我",
      patch: { title: "Run 失败单独告诉 Lead", priority: 90, condition: { kinds: ["run.failed"] }, action: { type: "level", level: "tell" } },
    });
    expect(created.outcome).toBe("applied");
    expect(getStandingOrder(db, "run.failed_tell")).toMatchObject({ version: 1, author: "lead", status: "active" });
    const same = proposeStandingOrderChange(db, { op: "update", id: "run.failed_tell", reason: "再说一遍", patch: { priority: 90 } });
    expect(same.outcome).toBe("unchanged");
    expect(listStandingOrderVersions(db, "run.failed_tell")).toHaveLength(1);
  });
});

describe("a permissive change waits for the user's approval", () => {
  const lowerWake = () => proposeStandingOrderChange(db, {
    op: "update", id: "inbox.wake_lead", reason: "blocker 太多，先进摘要",
    patch: { action: { ...SYSTEM_STANDING_ORDERS.find((order) => order.id === "inbox.wake_lead")!.action, level: "digest" } as never },
  });

  it("does not take effect before approval", () => {
    const result = lowerWake();
    expect(result.outcome).toBe("pending_approval");
    if (result.outcome !== "pending_approval") return;
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);
    expect(changedEvents()).toEqual([]);
    expect(blockerLevel("still-told")).toBe("tell");
    const approval = getApproval(db, result.proposal.approvalId)!;
    expect(approval).toMatchObject({ item_id: null, run_id: null, requested_by: "lead", tool: STANDING_ORDER_PROPOSAL_TOOL, status: "pending" });
    const ttl = Date.parse(approval.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3_600_000);
    expect(result.proposal).toMatchObject({ orderId: "inbox.wake_lead", op: "update", state: "pending", baseVersion: 1, appliedVersion: null });
    expect(result.proposal.findings.some((item) => item.tier === "permissive")).toBe(true);
  });

  it("takes effect once the user approves: author lead, approved by the user", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const resolved = resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: true, resolvedBy: USER });
    expect(resolved.proposal).toMatchObject({ state: "approved", appliedVersion: 2, resolvedBy: USER });
    expect(getStandingOrder(db, "inbox.wake_lead")).toMatchObject({ version: 2, author: "lead", approvedBy: USER });
    expect(changedEvents()[0]).toMatchObject({
      source: "lead", payload: { tier: "permissive", approvalId: result.proposal.approvalId, approvedBy: USER, version: 2 },
    });
    expect(blockerLevel("now-digest")).toBe("digest");
    // Lead 在收件箱里看到结果，不叫醒它。
    const note = listInbox(db, { state: ["pending"] }).find((row) => row.dedup_scope === `standing-order-proposal:${result.proposal.approvalId}`);
    expect(note?.summary).toContain("批准");
    expect(JSON.parse(note!.payload)).toMatchObject({ state: "approved", wakeLead: false });
    expectChangeError(() => resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: true, resolvedBy: USER }), "conflict");
  });

  it("does not take effect when the user rejects it", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const resolved = resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: false, resolvedBy: USER });
    expect(resolved).toMatchObject({ proposal: { state: "rejected" }, written: null });
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);
    expect(blockerLevel("rejected")).toBe("tell");
    expect(changedEvents()).toEqual([]);
  });

  it("does not take effect when it expires, and tells Lead", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(getStandingOrderProposal(db, result.proposal.approvalId, later)?.state).toBe("expired");
    expectChangeError(() => resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: true, resolvedBy: USER, now: later }),
      "conflict", /过期/);
    expect(getApproval(db, result.proposal.approvalId)?.status).toBe("expired");
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);
    expect(listInbox(db, { state: ["pending"] }).some((row) => row.summary.includes("过期"))).toBe(true);
  });

  it("tells Lead when the scheduler expires it (expireStale + noteExpiredStandingOrderProposal)", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const [id] = expireStale(db, new Date(Date.now() + 25 * 3_600_000));
    expect(id).toBe(result.proposal.approvalId);
    noteExpiredStandingOrderProposal(db, getApproval(db, id!)!);
    expect(listInbox(db, { state: ["pending"] }).find((row) => row.dedup_scope === `standing-order-proposal:${id}`)?.summary).toContain("过期");
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);
  });

  it("is pushed to the user before it expires without asking for a reply", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const line = pendingApprovalLine(getApproval(db, result.proposal.approvalId)!);
    expect(line).toContain("Lead 提议修改常设指令 inbox.wake_lead");
    expect(line).toContain("设置 → 常设指令");
    expect(line).not.toContain("工单 #");
  });

  it("only takes a decision attributed to a user channel", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    for (const resolvedBy of ["lead", "user via lead", "user via ", ""]) {
      expectChangeError(() => resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: true, resolvedBy }), "forbidden");
    }
    expect(getApproval(db, result.proposal.approvalId)?.status).toBe("pending");
  });

  it("voids a pending proposal when the order gets a newer version first", () => {
    const first = lowerWake();
    if (first.outcome !== "pending_approval") throw new Error(first.outcome);
    // 一个更保守的修改先生效：旧提议是按 v1 判断的，作废。
    const applied = proposeStandingOrderChange(db, {
      op: "update", id: "inbox.wake_lead", reason: "标题写清楚", patch: { title: "blocker 和要叫醒的 attention 单独告诉 Lead" },
    });
    expect(applied.outcome).toBe("applied");
    if (applied.outcome === "applied") expect(applied.written.superseded).toEqual([first.proposal.approvalId]);
    expect(getStandingOrderProposal(db, first.proposal.approvalId)).toMatchObject({ state: "expired", voidedReason: "superseded" });
    expectChangeError(() => resolveStandingOrderProposal(db, first.proposal.approvalId, { approve: true, resolvedBy: USER }), "conflict");
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(2);
  });

  it("voids the proposal at approval time when someone else wrote a version in between", () => {
    const result = lowerWake();
    if (result.outcome !== "pending_approval") throw new Error(result.outcome);
    const wake = SYSTEM_STANDING_ORDERS.find((order) => order.id === "inbox.wake_lead")!;
    recordStandingOrderVersion(db, { ...wake, title: "别处改的" }, { author: "user", approvedBy: USER });
    expectChangeError(() => resolveStandingOrderProposal(db, result.proposal.approvalId, { approve: true, resolvedBy: USER }), "conflict", /又变了/);
    expect(getStandingOrderProposal(db, result.proposal.approvalId)).toMatchObject({ state: "expired", voidedReason: "superseded" });
    expect(getStandingOrder(db, "inbox.wake_lead")).toMatchObject({ version: 2, title: "别处改的" });
  });

  it("replaces Lead's older proposal for the same order with the newer one", () => {
    const first = lowerWake();
    const second = proposeStandingOrderChange(db, {
      op: "update", id: "inbox.wake_lead", reason: "改主意了：只记录", patch: {
        action: { ...SYSTEM_STANDING_ORDERS.find((order) => order.id === "inbox.wake_lead")!.action, level: "record" } as never,
      },
    });
    if (first.outcome !== "pending_approval" || second.outcome !== "pending_approval") throw new Error("expected proposals");
    expect(second.superseded).toEqual([first.proposal.approvalId]);
    expect(listStandingOrderProposals(db, { pendingOnly: true }).map((proposal) => proposal.approvalId)).toEqual([second.proposal.approvalId]);
  });
});

describe("raising events to interrupt waits for approval", () => {
  it("does not apply an escalation to interrupt until the user approves it", () => {
    const result = proposeStandingOrderChange(db, {
      op: "update", id: "inbox.no_wake", reason: "到时限没人管就打断", patch: { escalateTo: "interrupt" },
    });
    expect(result.outcome).toBe("pending_approval");
    expect(getStandingOrder(db, "inbox.no_wake")).toMatchObject({ version: 1, escalateTo: "tell" });
    expect(changedEvents()).toEqual([]);
  });
});

describe("hard rules refuse the change and write nothing", () => {
  it("refuses to turn off a rule", () => {
    const result = proposeStandingOrderChange(db, { op: "disable", id: "run.transient_retry", reason: "不要重试了" });
    expect(result.outcome).toBe("refused");
    expect(result.plan.classification.findings[0]).toMatchObject({ hardRule: "rules_stay_on" });
    expect(listStandingOrderVersions(db, "run.transient_retry")).toHaveLength(1);
    expect(listStandingOrderProposals(db)).toEqual([]);
    expect(changedEvents()).toEqual([]);
  });

  it("refuses an order aimed at approvals", () => {
    const result = proposeStandingOrderChange(db, {
      op: "create", id: "inbox.approvals_quiet", reason: "审批太吵",
      patch: { title: "审批只记录", priority: 1, condition: { kinds: ["inbox.blocker"], fields: { "payload.payload.authorityType": "approval" } },
        action: { type: "level", level: "record" } },
    });
    expect(result.outcome).toBe("refused");
    expect(getStandingOrder(db, "inbox.approvals_quiet")).toBeUndefined();
  });

  it("rejects requests that do not make sense", () => {
    expectChangeError(() => proposeStandingOrderChange(db, { op: "update", id: "inbox.nothing", reason: "x", patch: { priority: 1 } }), "not_found");
    expectChangeError(() => proposeStandingOrderChange(db, { op: "create", id: "inbox.no_wake", reason: "x", patch: {} }), "conflict");
    expectChangeError(() => proposeStandingOrderChange(db, { op: "create", id: "x.new", reason: "x", patch: { title: "t" } }), "invalid_request");
    expectChangeError(() => proposeStandingOrderChange(db, { op: "update", id: "inbox.no_wake", reason: " ", patch: { priority: 1 } }), "invalid_request");
    expectChangeError(() => proposeStandingOrderChange(db, {
      op: "update", id: "inbox.no_wake", reason: "x", patch: { action: { type: "level", level: "conversation" as never } },
    }), "invalid_request", /不合格/);
    expectChangeError(() => proposeStandingOrderChange(db, { op: "rollback", id: "inbox.no_wake", reason: "x" }), "invalid_request", /v1/);
  });
});

describe("rollback writes a new version with the old content", () => {
  it("lets Lead roll back to a more conservative version at once, and asks for approval to roll back to a more permissive one", () => {
    // v2：更保守（tell），马上生效。
    proposeStandingOrderChange(db, { op: "update", id: "inbox.no_wake", reason: "先都告诉我", patch: { action: { type: "level", level: "tell" }, escalateTo: null } });
    // 回到 v1（digest）是更放开：要批准。
    const back = proposeStandingOrderChange(db, { op: "rollback", id: "inbox.no_wake", reason: "太吵了，回到原来的" });
    expect(back.outcome).toBe("pending_approval");
    if (back.outcome !== "pending_approval") return;
    expect(back.proposal).toMatchObject({ op: "rollback", rollbackTo: 1, baseVersion: 2 });
    expect(attentionLevel("still-tell").level).toBe("tell");
    resolveStandingOrderProposal(db, back.proposal.approvalId, { approve: true, resolvedBy: USER });
    expect(getStandingOrder(db, "inbox.no_wake")).toMatchObject({ version: 3, author: "lead", approvedBy: USER, action: { type: "level", level: "digest" } });
    expect(changedEvents().at(-1)).toMatchObject({ payload: { change: "rollback", rolledBackTo: 1, version: 3 } });
    // 再回到 v2（tell）是更保守：马上生效。
    const forward = proposeStandingOrderChange(db, { op: "rollback", id: "inbox.no_wake", reason: "还是都告诉我", toVersion: 2 });
    expect(forward.outcome).toBe("applied");
    expect(getStandingOrder(db, "inbox.no_wake")).toMatchObject({ version: 4, action: { type: "level", level: "tell" } });
    expect(listStandingOrderVersions(db, "inbox.no_wake").map((order) => order.version)).toEqual([1, 2, 3, 4]);
  });

  it("lets the user roll back from the settings page directly, even to a more permissive version", () => {
    proposeStandingOrderChange(db, { op: "update", id: "inbox.no_wake", reason: "先都告诉我", patch: { action: { type: "level", level: "tell" }, escalateTo: null } });
    const pending = proposeStandingOrderChange(db, { op: "update", id: "inbox.no_wake", reason: "只记录", patch: { action: { type: "level", level: "record" } } });
    expect(pending.outcome).toBe("pending_approval");
    const written = rollbackStandingOrderByUser(db, { id: "inbox.no_wake", toVersion: 1, resolvedBy: USER });
    expect(written.order).toMatchObject({ version: 3, author: "user", approvedBy: USER, action: { type: "level", level: "digest" } });
    expect(written.event).toMatchObject({ source: "system", level: "digest", payload: { author: "user", tier: "user", change: "rollback", rolledBackTo: 1 } });
    // Lead 还在等的提议是按旧版本判断的，作废。
    if (pending.outcome === "pending_approval") expect(written.superseded).toEqual([pending.proposal.approvalId]);
    expect(attentionLevel("rolled-back").level).toBe("digest");
    expectChangeError(() => rollbackStandingOrderByUser(db, { id: "inbox.no_wake", toVersion: 1, resolvedBy: USER }), "conflict");
    expectChangeError(() => rollbackStandingOrderByUser(db, { id: "inbox.no_wake", toVersion: 2, resolvedBy: "lead" }), "forbidden");
  });

  it("refuses a user rollback to a version the hard rules forbid", () => {
    const retry = SYSTEM_STANDING_ORDERS.find((order) => order.id === "run.transient_retry")!;
    recordStandingOrderVersion(db, { ...retry, reason: "系统停用过" }, { author: "system", status: "disabled", seedRevision: 2 });
    recordStandingOrderVersion(db, { ...retry, reason: "系统又启用" }, { author: "system", seedRevision: 3 });
    expectChangeError(() => rollbackStandingOrderByUser(db, { id: "run.transient_retry", toVersion: 2, resolvedBy: USER }), "forbidden");
    expect(listStandingOrderVersions(db, "run.transient_retry")).toHaveLength(3);
  });
});

describe("recent executions", () => {
  it("lists the events whose triage points at the order, newest first, with the version and the effect", () => {
    blockerLevel("one");
    proposeStandingOrderChange(db, {
      op: "update", id: "inbox.wake_lead", reason: "标题写清楚", patch: { title: "blocker 和要叫醒的 attention 单独告诉 Lead" },
    });
    blockerLevel("two");
    addInbox(db, { dedupScope: "merge", severity: "attention", source: "structural", summary: "a", payload: {} });
    addInbox(db, { dedupScope: "merge", severity: "attention", source: "structural", summary: "b", payload: {} });
    const wake = recentStandingOrderExecutions(db, "inbox.wake_lead");
    expect(wake.map((entry) => [entry.kind, entry.version, entry.effect])).toEqual([["inbox.blocker", 2, "level"], ["inbox.blocker", 1, "level"]]);
    expect(wake[0]!.summary).toBe("测试 two");
    const merged = recentStandingOrderExecutions(db, "inbox.merge_attention");
    expect(merged.map((entry) => entry.effect)).toEqual(["inbox_merged"]);
    expect(recentStandingOrderExecutions(db, "inbox.wake_lead", { limit: 1 })).toHaveLength(1);
  });
});
