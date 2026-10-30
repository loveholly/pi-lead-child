// 收件箱里哪些通知单独露出来。实例上（2026-10-15）黄色通知卡在四个 tab 都出现，显示 42 条未确认
// 通知里 id 最小的 3 条：7 月的一条提醒、已完成的 #46「运行结束，但交接失败」、#51 的英文阻塞。
// #51 同时也在「需要你介入」里，确认一条以后又冒出 #51 的下一条（它有 9 条）。
import { describe, expect, it } from "vitest";

import { inboxNotices, type NotificationDto, type TicketSummary } from "../src/index.ts";

function ticket(id: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? "blocked";
  return {
    id,
    title: `工单 ${id}`,
    summary: "",
    kind: "task",
    hasRun: true,
    priority: "normal",
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: "2026-10-15T07:00:00.000Z",
    parentTicketId: null,
    runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
    stage,
    status: stage,
  };
}

let nextId = 1;
function notice(ticketId: number | null, createdAt: string, overrides: Partial<NotificationDto> = {}): NotificationDto {
  const id = nextId++;
  return {
    id,
    ticketId,
    kind: "blocked_checkpoint",
    dedupKey: null,
    urgency: "immediate",
    title: `通知 ${id}`,
    body: "",
    state: "delivered",
    createdAt,
    deliveredAt: createdAt,
    deliveredVia: "lead",
    ackedAt: null,
    ...overrides,
  };
}

describe("inboxNotices", () => {
  const done46 = ticket(46, { stage: "done" });
  const blocked51 = ticket(51);
  const running66 = ticket(66, { stage: "active", runtime: { state: "running", lastActivityAt: null, activeAttemptId: 85 } });

  it("hides notices of ended tickets: a historical notice cannot reopen #46", () => {
    const result = inboxNotices([notice(46, "2026-08-11T09:59:02.597Z", { kind: "terminal_handoff_failed" })], [done46]);
    expect(result.general).toEqual([]);
    expect(result.byTicket).toEqual({});
  });

  it("folds a ticket's notices into its needs-you row instead of listing them again", () => {
    const first = notice(51, "2026-08-14T06:57:26.236Z");
    const second = notice(51, "2026-08-17T06:29:57.553Z");
    const result = inboxNotices([first, second], [blocked51]);
    expect(result.general).toEqual([]);
    expect(result.byTicket[51]?.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it("hides notices of a ticket that no longer waits for the user", () => {
    const result = inboxNotices([notice(66, "2026-08-21T08:57:02.449Z", { title: "工单 #66 阻塞：Run crashed" })], [running66]);
    expect(result.general).toEqual([]);
    expect(result.byTicket).toEqual({});
  });

  it("lists notices without a ticket, newest first", () => {
    const older = notice(null, "2026-10-12T08:00:00.000Z", { title: "Claude Code 启动失败：派发已挂起" });
    const newer = notice(null, "2026-10-14T16:41:11.302Z", { title: "Codex 不支持该模型（gpt-5.5）：派发已挂起" });
    expect(inboxNotices([older, newer], []).general.map((item) => item.id)).toEqual([newer.id, older.id]);
  });

  it("groups reminder notices, and drops the ones whose reminder is already acknowledged", () => {
    const fired = notice(14, "2026-07-28T09:57:54.788Z", { kind: "reminder", title: "提醒：验收样本" });
    const acked = notice(17, "2026-07-29T09:00:03.100Z", { kind: "reminder", title: "提醒：Working Session 会议" });
    const result = inboxNotices([fired, acked], [], { reminderStages: new Map([[17, "acked"]]) });
    expect(result.reminders.map((item) => item.id)).toEqual([fired.id]);
    expect(result.general).toEqual([]);
  });

  it("never shows an acknowledged notice", () => {
    const result = inboxNotices([notice(null, "2026-10-14T16:41:11.302Z", { state: "acked", ackedAt: "2026-10-14T17:00:00.000Z" })], []);
    expect(result.general).toEqual([]);
  });
});
