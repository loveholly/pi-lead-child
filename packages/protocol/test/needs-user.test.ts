// 「需要你」只有一条规则：会话底栏、收件箱、导航角标和 Lead 的 list_needs_user 都用它。
// 实例上曾经是底栏 3、收件箱 4、Lead 说 5：三处各有一个判断，#66（独立核查未派发）
// 只有收件箱算进去了，阻塞的子工单 #75 只有 Lead 算进去了。
import { describe, expect, it } from "vitest";

import {
  ticketNeedsUser,
  ticketNeedsUserLabel,
  ticketsNeedingUser,
  ticketTurn,
  type TicketReviewState,
  type TicketSummary,
} from "../src/index.ts";

function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 1,
    title: "工单",
    summary: "",
    kind: "task",
    stage: "active",
    status: "active",
    hasRun: true,
    priority: "normal",
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: "2026-10-14T08:00:00.000Z",
    parentTicketId: null,
    runtime: { state: "running", lastActivityAt: null, activeAttemptId: 3 },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
    ...(overrides.stage ? { status: overrides.stage } : {}),
  };
}

function review(state: TicketReviewState["state"], extra: Partial<TicketReviewState> = {}): TicketReviewState {
  return { state, label: state, reviewerAttemptId: null, verdict: null, reason: null, ...extra };
}

describe("ticketNeedsUser", () => {
  // 2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈。
  // Lead 还在处理的阻塞不算「需要你」；审批照样算；Lead 处理完了还阻塞着，又算回来。
  it("does not count a blocked ticket while Lead handles it, but still counts an approval", () => {
    const blocked = { stage: "blocked" as const, runtime: { state: "blocked" as const, lastActivityAt: null, activeAttemptId: null } };
    expect(ticketNeedsUser(ticket({ ...blocked, attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true } }))).toBeNull();
    expect(ticketNeedsUser(ticket({ ...blocked, attention: { pendingApprovalCount: 1, blockerCount: 0, leadHandling: true } }))).toBe("approval");
    expect(ticketNeedsUser(ticket({ ...blocked, attention: { pendingApprovalCount: 0, blockerCount: 0 } }))).toBe("blocked");
    expect(ticketNeedsUser(ticket({ ...blocked, attention: { pendingApprovalCount: 0, blockerCount: 1, leadHandling: true } }))).toBe("blocked");
  });

  it("counts the #66 case: a delivery in review that no independent review will reach", () => {
    expect(ticketNeedsUser(ticket({
      stage: "review",
      runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
      reviewState: review("independent_review", { canRequestReview: true, reviewProgress: null }),
    }))).toBe("review_dispatch");
  });

  it("regression 2026-10-21: a paused review that can be re-picked needs the user, but it was dispatched", () => {
    // 服务端在核查挂起时也让「派发核查」可点，用来换一个能用的核查员。它不是「核查未派发」：核查排着，只是现在没人能做。
    expect(ticketNeedsUser(ticket({
      stage: "review",
      runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
      reviewState: review("independent_review", { canRequestReview: true, reviewProgress: "suspended" }),
    }))).toBe("blocked");
  });

  it("does not count a review that is queued or running: nobody waits for the user", () => {
    for (const reviewProgress of ["queued", "running"] as const) {
      expect(ticketNeedsUser(ticket({
        stage: "review",
        runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
        reviewState: review("independent_review", { canRequestReview: false, reviewProgress }),
      }))).toBeNull();
    }
  });

  it("counts reviews that wait for the user's decision or acceptance", () => {
    for (const state of ["review_failed", "evidence_conflict", "rework_exhausted"] as const) {
      expect(ticketNeedsUser(ticket({ stage: "review", reviewState: review(state) }))).toBe("decision");
    }
    for (const state of ["waiting_user", "review_passed"] as const) {
      expect(ticketNeedsUser(ticket({ stage: "review", reviewState: review(state) }))).toBe("acceptance");
    }
  });

  it("counts a blocked ticket, a blocked child and a ticket with an open approval", () => {
    expect(ticketNeedsUser(ticket({ stage: "blocked", runtime: { state: "blocked", lastActivityAt: null, activeAttemptId: null } })))
      .toBe("blocked");
    expect(ticketNeedsUser(ticket({ id: 75, parentTicketId: 47, stage: "blocked" }))).toBe("blocked");
    expect(ticketNeedsUser(ticket({ attention: { pendingApprovalCount: 1, blockerCount: 0 } }))).toBe("approval");
  });

  it("does not count a blocked ticket while the system recovers the run by itself", () => {
    const recovering = ticket({
      stage: "blocked",
      runtime: { state: "blocked", lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 1 },
      executionState: {
        kind: "recovery", state: "running", label: "自动恢复中", dispatchRequestId: 4, attemptId: 9, reason: null, updatedAt: null,
      },
    });
    expect(ticketNeedsUser(recovering)).toBeNull();
    expect(ticketNeedsUser({ ...recovering, executionState: { ...recovering.executionState!, state: "failed" } }))
      .toBe("blocked");
    expect(ticketNeedsUser({ ...recovering, executionState: undefined })).toBe("blocked");
    expect(ticketNeedsUser({ ...recovering, attention: { pendingApprovalCount: 1, blockerCount: 1 } })).toBe("approval");
  });

  it("counts a stalled run, a missing capability and a draft that waits for confirmation", () => {
    expect(ticketNeedsUser(ticket({ runtime: { state: "stale", lastActivityAt: null, activeAttemptId: 3 } }))).toBe("stalled");
    expect(ticketNeedsUser(ticket({ stage: "ready", workflowState: "waiting_capability" }))).toBe("capability");
    expect(ticketNeedsUser(ticket({ stage: "draft", hasRun: false }))).toBe("confirmation");
  });

  it("never counts a terminal ticket, whatever its derived signals say", () => {
    for (const stage of ["done", "cancelled", "acked"] as const) {
      expect(ticketNeedsUser(ticket({
        stage,
        attention: { pendingApprovalCount: 1, blockerCount: 2 },
        runtime: { state: "blocked", lastActivityAt: null, activeAttemptId: null },
      }))).toBeNull();
    }
  });

  it("does not count running work, a fired reminder or a scheduled one", () => {
    expect(ticketNeedsUser(ticket())).toBeNull();
    expect(ticketNeedsUser(ticket({ kind: "reminder", stage: "fired", hasRun: false }))).toBeNull();
    expect(ticketNeedsUser(ticket({ kind: "reminder", stage: "scheduled", hasRun: false }))).toBeNull();
  });

  it("gives every reason a short label", () => {
    expect(ticketNeedsUserLabel("review_dispatch")).toBe("核查未派发");
    expect(ticketNeedsUserLabel("blocked")).toBe("需介入");
  });
});

describe("ticketsNeedingUser", () => {
  it("keeps every ticket that needs the user, children and background tickets included", () => {
    const tickets = [
      ticket({ id: 51, stage: "blocked" }),
      ticket({ id: 66, stage: "review", reviewState: review("independent_review", { canRequestReview: true }) }),
      ticket({ id: 75, parentTicketId: 47, stage: "blocked" }),
      ticket({ id: 80, worklistVisibility: "background", stage: "blocked" }),
      ticket({ id: 18, stage: "ready", runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null } }),
      ticket({ id: 14, kind: "reminder", stage: "fired" }),
    ];
    expect(ticketsNeedingUser(tickets).map((item) => item.id)).toEqual([51, 66, 75, 80]);
  });
});

// 「现在轮到谁」只有一条规则。实例上（2026-10-15）工单 tab 写「进行中 6」，会话底栏写「执行中 0」：
// 那 6 张都是 ready、没有 Run 在跑（#18 和 5 张系统建的「沉淀失败经验」）。
describe("ticketTurn", () => {
  const idle = { state: "idle", lastActivityAt: null, activeAttemptId: null } as const;

  it("calls a ready ticket with no run queued, not running (the #18 case)", () => {
    expect(ticketTurn(ticket({ id: 18, stage: "ready", runtime: idle }))).toBe("queued");
  });

  it("calls a ticket running only when a run starts or runs", () => {
    expect(ticketTurn(ticket())).toBe("running");
    expect(ticketTurn(ticket({ runtime: { state: "starting", lastActivityAt: null, activeAttemptId: 3 } }))).toBe("running");
    expect(ticketTurn(ticket({ stage: "active", runtime: idle }))).toBe("queued");
  });

  it("calls a dispatched or recovering run running, with or without a live process yet", () => {
    for (const state of ["requested", "waiting_dispatch", "starting", "running"] as const) {
      expect(ticketTurn(ticket({
        stage: "blocked",
        runtime: { state: "blocked", lastActivityAt: null, activeAttemptId: null },
        attention: { pendingApprovalCount: 0, blockerCount: 1 },
        executionState: { kind: "recovery", state, label: "正在恢复", dispatchRequestId: 4, attemptId: null, reason: null, updatedAt: null },
      }))).toBe("running");
    }
    expect(ticketTurn(ticket({
      stage: "ready", runtime: idle,
      executionState: { kind: "execution", state: "waiting_dispatch", label: "等待派发", dispatchRequestId: 7, attemptId: null, reason: null, updatedAt: null },
    }))).toBe("running");
  });

  it("calls a review on its way running and a suspended review the system's turn", () => {
    const inReview = (reviewProgress: "queued" | "running" | "suspended") => ticket({
      stage: "review", runtime: idle,
      reviewState: review("independent_review", { canRequestReview: false, reviewProgress }),
    });
    expect(ticketTurn(inReview("queued"))).toBe("running");
    expect(ticketTurn(inReview("running"))).toBe("running");
    expect(ticketTurn(inReview("suspended"))).toBe("lead");
    // 「等待独立核查」：交付结束，核查还没派出去。下一步是系统的，不是「没人在动」。
    expect(ticketTurn(ticket({
      stage: "review", runtime: idle, reviewState: review("independent_review", { canRequestReview: false, reviewProgress: null }),
    }))).toBe("lead");
  });

  it("gives background work to Lead unless it needs the user or runs", () => {
    expect(ticketTurn(ticket({ id: 52, worklistVisibility: "background", stage: "ready", runtime: idle }))).toBe("lead");
    expect(ticketTurn(ticket({ id: 52, worklistVisibility: "background" }))).toBe("running");
    expect(ticketTurn(ticket({ id: 80, worklistVisibility: "background", stage: "blocked" }))).toBe("user");
  });

  // 自愈：Lead 正在处理一张阻塞的工单、没有升级给你。那是 Lead 的回合，不是「排队」，也不是「等你」。
  it("gives a blocked ticket Lead is handling to Lead until it escalates", () => {
    const handled = ticket({
      stage: "blocked", runtime: { ...idle, state: "blocked" },
      attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true },
    });
    expect(ticketTurn(handled)).toBe("lead");
    expect(ticketTurn({ ...handled, attention: { ...handled.attention, blockerCount: 1 } })).toBe("user");
  });

  it("is user exactly when ticketNeedsUser names a reason", () => {
    const tickets = [
      ticket({ stage: "blocked" }),
      ticket({ stage: "draft", hasRun: false }),
      ticket({ stage: "review", reviewState: review("waiting_user") }),
      ticket({ runtime: { state: "stale", lastActivityAt: null, activeAttemptId: 3 } }),
      ticket({ attention: { pendingApprovalCount: 1, blockerCount: 0 } }),
      ticket({ stage: "ready", runtime: idle }),
      ticket(),
    ];
    for (const item of tickets) {
      expect(ticketTurn(item) === "user").toBe(ticketNeedsUser(item) !== null);
    }
  });

  it("keeps terminal stages ended whatever the derived signals say", () => {
    for (const stage of ["done", "cancelled", "acked"] as const) {
      expect(ticketTurn(ticket({
        stage,
        attention: { pendingApprovalCount: 1, blockerCount: 2 },
        runtime: { state: "running", lastActivityAt: null, activeAttemptId: 3 },
      }))).toBe("ended");
    }
  });

  it("never calls a reminder running: a fired or scheduled reminder is not work", () => {
    expect(ticketTurn(ticket({ kind: "reminder", stage: "fired", hasRun: false, runtime: idle }))).toBe("queued");
    expect(ticketTurn(ticket({ kind: "reminder", stage: "scheduled", hasRun: false, runtime: idle }))).toBe("queued");
  });

  it("calls a ticket that waits on another ticket queued", () => {
    expect(ticketTurn(ticket({ stage: "ready", runtime: idle, workflowState: "waiting_dependency" }))).toBe("queued");
    expect(ticketTurn(ticket({ stage: "ready", runtime: idle, workflowState: "continuing" }))).toBe("lead");
  });
});

// 2026-10-16 用户要求：收件箱的主按钮写「派发独立核查」，会话里的决定卡问的却是「并入 #72 / 再返工 / 取消」。
// 工单上有等用户回答的决策请求时，轮到用户做的就是回答它：原因是「待你决定」，压过阻塞、Lead 处理中和核查未派发。
// 审批照样排在最前（会过期），终态照样一律不算。
describe("a decision the user owes", () => {
  const owed = (attention: Partial<TicketSummary["attention"]> = {}, extra: Partial<TicketSummary> = {}) => ticket({
    stage: "review",
    runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
    reviewState: review("independent_review", { canRequestReview: true }),
    attention: { pendingApprovalCount: 0, blockerCount: 1, leadHandling: true, pendingDecisionCount: 1, ...attention },
    ...extra,
  });

  it("is the reason, ahead of blockers, Lead handling and an undispatched review", () => {
    expect(ticketNeedsUser(owed())).toBe("decision");
    expect(ticketNeedsUserLabel("decision")).toBe("待你决定");
    expect(ticketTurn(owed())).toBe("user");
  });

  it("still comes after an approval, and never counts on a finished ticket", () => {
    expect(ticketNeedsUser(owed({ pendingApprovalCount: 1 }))).toBe("approval");
    expect(ticketNeedsUser(owed({}, { stage: "done" }))).toBeNull();
  });
});

