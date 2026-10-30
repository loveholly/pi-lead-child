import type { KernelCheckpoint, KernelTicketPow, KernelTicketWorkItem, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import {
  TICKET_DETAIL_TABS,
  buildTicketDetailPresentation,
  buildPowMetricPresentation,
  buildTicketRailPresentation,
  buildWeek,
  formatTicketHeartbeatLabel,
  formatCompactElapsed,
  groupForTicket,
  groupTicketsByProject,
  projectTicketSecondaryMeta,
  resolveWorkspaceTicket,
  resolveWorkspaceTickets,
  shouldShowWorkspaceBootShell,
  ticketNextActionPresentation,
  ticketAttentionReason,
  ticketSummaryToTicket,
  ticketRailCaption,
  type Ticket,
} from './model';

const groupedTickets: Ticket[] = [
  { id: '42', title: 'A', summary: '', kind: 'task', hasRun: true, status: 'active', statusLabel: '', priority: 'high', priorityLabel: '', project: 'pi-lead-child', runtimeLabel: '运行中', heartbeat: true, needsAttention: false, agentLabel: 'child #73', runtimeName: 'codex', elapsedMs: 372_000, progressPercent: 62, turn: 'running' },
  { id: '43', title: 'Running but blocked', summary: '', kind: 'task', hasRun: true, status: 'active', statusLabel: '', priority: 'urgent', priorityLabel: '', project: 'pi-lead-child', runtimeLabel: '需介入', heartbeat: false, needsAttention: true, needsUser: 'blocked', turn: 'user' },
  { id: '41', title: 'B', summary: '', kind: 'task', hasRun: true, status: 'review', statusLabel: '', priority: 'normal', priorityLabel: '', project: 'pi-lead-child', runtimeLabel: '空闲', heartbeat: false, needsAttention: false, needsUser: 'acceptance', progressPercent: 100, turn: 'user' },
  { id: '38', title: 'C', summary: '', kind: 'task', hasRun: true, status: 'blocked', statusLabel: '', priority: 'low', priorityLabel: '', runtimeLabel: '需介入', heartbeat: false, needsAttention: true, needsUser: 'blocked', turn: 'user' },
  { id: '40', title: 'Done', summary: '', kind: 'task', hasRun: true, status: 'done', statusLabel: '', priority: 'normal', priorityLabel: '', runtimeLabel: '空闲', heartbeat: false, needsAttention: false, turn: 'ended' },
  { id: '39', title: 'Cancelled', summary: '', kind: 'task', hasRun: true, status: 'cancelled', statusLabel: '', priority: 'normal', priorityLabel: '', runtimeLabel: '空闲', heartbeat: false, needsAttention: false, turn: 'ended' },
];

describe('workspace model', () => {
  it('keeps the stable boot shell until hydration and the control plane are ready', () => {
    expect(shouldShowWorkspaceBootShell(false, 'ready')).toBe(true);
    expect(shouldShowWorkspaceBootShell(true, 'loading')).toBe(true);
    expect(shouldShowWorkspaceBootShell(true, 'connecting')).toBe(true);
    expect(shouldShowWorkspaceBootShell(true, 'ready')).toBe(false);
    expect(shouldShowWorkspaceBootShell(true, 'unpaired')).toBe(false);
    expect(shouldShowWorkspaceBootShell(true, 'error')).toBe(false);
  });

  it('projects the user action separately from the ticket lifecycle status', () => {
    expect(ticketNextActionPresentation(groupedTickets[2]!)).toMatchObject({
      label: '需要你验收',
      tone: 'attention',
    });
    expect(ticketNextActionPresentation(groupedTickets[0]!)).toMatchObject({
      label: '系统正在执行',
      tone: 'info',
    });
    expect(ticketNextActionPresentation(groupedTickets[4]!)).toBeNull();
  });

  it('uses one attention reason across user-facing projections', () => {
    const mergeConflict = {
      ...groupedTickets[0]!,
      needsAttention: true,
      workspace: { state: 'active', mode: 'isolated', kind: 'isolated_child', mergeStatus: 'conflict' },
    } as Ticket;

    expect(ticketAttentionReason(mergeConflict)).toBe('merge_conflict');
    expect(ticketNextActionPresentation(mergeConflict)).toMatchObject({ label: '需要你处理合并冲突', tone: 'danger' });
    expect(ticketRailCaption(mergeConflict)).toBe('#42 · 运行中 · 需要介入');
  });

  it('groups tickets without a project into unknown', () => {
    const grouped = groupTicketsByProject(groupedTickets);

    expect(grouped.get('pi-lead-child')?.map((ticket) => ticket.id)).toEqual(['42', '43', '41']);
    expect(grouped.get('unknown')?.map((ticket) => ticket.id)).toEqual(['38', '40', '39']);
  });

  // 分组就是「现在轮到谁」：等你、在执行、排队、Lead 后台、已结束。等你验收的工单也是等你，没有单独的「待验收」组。
  it('groups tickets by whose turn it is', () => {
    const projection = buildTicketRailPresentation(groupedTickets, { filter: 'all' });

    expect(projection.groups.map((group) => group.id)).toEqual([
      'needs_intervention',
      'running',
      'completed',
      'cancelled',
    ]);
    expect(projection.groups[0]?.items.map((ticket) => ticket.id)).toEqual(['43', '41', '38']);
    expect(projection.groups[1]?.items.map((ticket) => ticket.id)).toEqual(['42']);
    expect(projection.groups[2]?.items.map((ticket) => ticket.id)).toEqual(['40']);
    expect(projection.groups[2]?.count).toBe(1);
    expect(projection.groups[3]?.items.map((ticket) => ticket.id)).toEqual(['39']);
    expect(projection.groups[3]?.count).toBe(1);
  });

  it('applies all, todo, running, and queued filters with authoritative attention semantics', () => {
    const all = buildTicketRailPresentation(groupedTickets, { filter: 'all' });
    const running = buildTicketRailPresentation(groupedTickets, { filter: 'running' });
    const todo = buildTicketRailPresentation(groupedTickets, { filter: 'todo' });

    // #43 停在 active，但它在等你：不算在执行。
    expect(all.filterCounts).toEqual({ all: 6, todo: 3, running: 1, queued: 0 });
    expect(running.groups.flatMap((group) => group.items.map((ticket) => ticket.id))).toEqual(['42']);
    expect(todo.groups.flatMap((group) => group.items.map((ticket) => ticket.id))).toEqual(['43', '41', '38']);
  });

  it('keeps a blocked ticket in todo even before an attention counter arrives', () => {
    const blocked = { ...groupedTickets[3]!, needsAttention: false };

    expect(buildTicketRailPresentation([blocked], { filter: 'todo' }).groups[0]).toMatchObject({
      id: 'needs_intervention',
      items: [expect.objectContaining({ id: '38' })],
    });
  });

  it('keeps terminal status authoritative and names review attention without calling it blocked', () => {
    const doneWithHistoricalAttention = {
      ...groupedTickets[4]!,
      statusLabel: '已完成',
      needsAttention: true,
    };
    const failedReview = {
      ...groupedTickets[2]!,
      statusLabel: '核查不通过，等你决定',
      needsAttention: true,
    };

    expect(groupForTicket(doneWithHistoricalAttention)).toBe('completed');
    expect(ticketRailCaption(doneWithHistoricalAttention)).toBe('#40 · 已完成');
    expect(buildTicketRailPresentation([doneWithHistoricalAttention], { filter: 'todo' }).state).toBe('no_results');
    expect(groupForTicket(failedReview)).toBe('needs_intervention');
    expect(ticketRailCaption(failedReview)).toBe('#41 · 核查不通过，等你决定 · 需要处理');
  });

  it('returns the populated, first-use, all-completed, and no-results rail states', () => {
    expect(buildTicketRailPresentation(groupedTickets, { filter: 'all' }).state).toBe('populated');
    expect(buildTicketRailPresentation([], { filter: 'all' }).state).toBe('first_use');
    expect(buildTicketRailPresentation([groupedTickets[4]!], { filter: 'all' }).state).toBe('all_completed');
    expect(buildTicketRailPresentation([groupedTickets[0]!], { filter: 'todo' }).state).toBe('no_results');
  });

  it('formats compact elapsed time without fabricating a never-started value', () => {
    expect(formatCompactElapsed(null)).toBeNull();
    expect(formatCompactElapsed(42_000)).toBe('<1m');
    expect(formatCompactElapsed(372_000)).toBe('6m');
    expect(formatCompactElapsed(8_280_000)).toBe('2h 18m');
    expect(formatCompactElapsed(273_600_000)).toBe('3d 4h');
  });

  it('formats the detail heartbeat with authoritative progress', () => {
    expect(formatTicketHeartbeatLabel(groupedTickets[0]!)).toBe('心跳 · 62%');
    expect(formatTicketHeartbeatLabel(groupedTickets[2]!)).toBe('待验收 · 100%');
    expect(formatTicketHeartbeatLabel(groupedTickets[3]!)).toBe('需要介入');
  });

  it('projects capability coverage from structured checkpoint facts without conflating proof counts', () => {
    const pow = {
      metrics: { passed: 2, total: 3 },
    } as KernelTicketPow;
    const checkpoint = {
      keyFacts: [
        { label: '能力覆盖', value: '11/14' },
        { label: '发现缺口', value: '3' },
      ],
    } as KernelCheckpoint;

    expect(buildPowMetricPresentation(pow, checkpoint)).toEqual({ coverage: '11/14', gaps: '3' });
    expect(buildPowMetricPresentation(pow)).toEqual({ coverage: '2/3', gaps: '1' });
  });

  it('projects only real agent, runtime, and elapsed metadata onto ticket cards', () => {
    expect(projectTicketSecondaryMeta(groupedTickets[0]!)).toEqual([
      'child #73',
      'codex',
      '运行中',
      '6m',
    ]);
    expect(projectTicketSecondaryMeta(groupedTickets[2]!)).toEqual(['空闲']);
  });

  it('builds the current Monday-to-Sunday week around July 23, 2026', () => {
    const week = buildWeek('2026-07-23');

    expect(week.map((day) => day.dateLabel)).toEqual(['20', '21', '22', '23', '24', '25', '26']);
    expect(week.find((day) => day.isToday)?.weekdayLabel).toBe('四');
  });

  it('maps protocol runtime and attention without inventing a progress percentage', () => {
    const summary: TicketSummary = {
      id: 77, title: '协议接入', summary: '接入事件流',
      kind: 'task', stage: 'active', status: 'active', hasRun: true, priority: 'urgent',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-07-23T06:00:00.000Z',
      runtime: { state: 'stale', lastActivityAt: '2026-07-23T05:00:00.000Z', activeAttemptId: 9 },
      attention: { pendingApprovalCount: 1, blockerCount: 0 },
    };
    const workItem: KernelTicketWorkItem = {
      ticketId: 77,
      timing: {
        firstStartedAt: '2026-07-23T05:00:00.000Z', completedAt: null,
        statusChangedAt: '2026-07-23T05:00:00.000Z', computedAt: '2026-07-23T06:00:00.000Z',
        elapsedMs: 3_600_000, activeExecutionMs: 3_600_000, statusDurationMs: 3_600_000,
      },
      activeExecution: {
        attemptId: 9, role: 'executor', runtime: 'codex', state: 'running',
        model: 'gpt-5.6-codex', externalSessionId: 'session-9',
      },
      pendingInterventionCount: 1,
      latestCheckpointId: 18,
    };
    const ticket = ticketSummaryToTicket(summary, workItem);

    // 迁移前这里断言的是 in_progress → running 的重映射结果。那个映射已删除：
    // 协议的 stage 直接透传（kernel spec §5 命名映射表）。
    expect(ticket).toMatchObject({
      id: '77', status: 'active', kind: 'task', hasRun: true, priority: 'urgent',
      runtimeLabel: '停滞', heartbeat: false, needsAttention: true,
      runtimeName: 'codex', agentLabel: 'child #9', sessionId: 'session-9', elapsedMs: 3_600_000,
    });
    expect(ticket).not.toHaveProperty('project');
    expect(ticket).not.toHaveProperty('progress');
  });

  it('projects reviewer verdict and rework queue states into user-visible labels', () => {
    const failedReview = ticketSummaryToTicket({
      id: 88, title: 'review fail', summary: '',
      kind: 'task', stage: 'review', status: 'review', hasRun: true, priority: 'normal',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-08-14T02:00:00.000Z',
      reviewState: {
        state: 'review_failed',
        label: '核查不通过，等你决定',
        reviewerAttemptId: 12,
        verdict: 'fail',
        reason: 'tests failed',
      },
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    });
    expect(failedReview.statusLabel).toBe('核查不通过，等你决定');
    expect(failedReview.needsAttention).toBe(true);
    expect(formatTicketHeartbeatLabel(failedReview)).toBe('需要你');

    expect(formatTicketHeartbeatLabel({
      ...failedReview,
      status: 'blocked',
      statusLabel: '阻塞',
      executionState: {
        kind: 'rework',
        state: 'failed',
        label: '返工启动失败',
        dispatchRequestId: 7,
        attemptId: 8,
        reason: 'Selected model is at capacity',
        updatedAt: '2026-08-19T09:42:01.000Z',
      },
    })).toBe('需要你');

    const queuedRework = ticketSummaryToTicket({
      id: 89, title: 'queued rework', summary: '',
      kind: 'task', stage: 'active', status: 'active', hasRun: true, priority: 'normal',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-08-14T02:01:00.000Z',
      executionState: {
        kind: 'rework',
        state: 'waiting_dispatch',
        label: '返工已请求，等待 agent',
        dispatchRequestId: 44,
        attemptId: null,
        reason: '用户点击打回返工',
        updatedAt: '2026-08-14T02:01:00.000Z',
      },
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    });
    expect(queuedRework.statusLabel).toBe('返工已请求，等待 agent');
    expect(queuedRework.runtimeLabel).toBe('返工已请求，等待 agent');
    expect(queuedRework.needsAttention).toBe(false);
  });

  it('projects runtime recovery as current work and suppresses historical blocker attention', () => {
    const recovering = ticketSummaryToTicket({
      id: 90, title: 'recovering', summary: '',
      kind: 'task', stage: 'blocked', status: 'blocked', hasRun: true, priority: 'normal',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-08-21T08:00:00.000Z',
      executionState: {
        kind: 'recovery',
        state: 'waiting_dispatch',
        label: '正在恢复 · 等待 agent',
        dispatchRequestId: 45,
        attemptId: null,
        reason: 'Selected model is at capacity',
        updatedAt: '2026-08-21T08:00:00.000Z',
      },
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 2 },
    });

    expect(recovering.statusLabel).toBe('正在恢复 · 等待 agent');
    expect(recovering.runtimeLabel).toBe('正在恢复 · 等待 agent');
    expect(recovering.needsAttention).toBe(false);
    expect(recovering.heartbeat).toBe(true);
    expect(groupForTicket(recovering)).toBe('running');
    expect(ticketRailCaption(recovering)).toBe('#90 · 正在恢复 · 等待 agent');
    expect(buildTicketRailPresentation([recovering], { filter: 'running' }).groups[0])
      .toMatchObject({ id: 'running', items: [expect.objectContaining({ id: '90' })] });
    expect(buildTicketRailPresentation([recovering], { filter: 'todo' }).state).toBe('no_results');
  });

  // 2026-10-15 用户决定：「系统的异常情况，lead 应该都是及时感知的，并且尽可能介入处理，UI 上我希望除非需要我介入，
  // 否则我希望是弱反馈」。Lead 正在处理的异常：不进「需要你介入」，不标红，只写一句「Lead 处理中」。
  it('shows a failure that Lead is handling as quiet current work, until it needs the user', () => {
    const base: TicketSummary = {
      id: 91, title: 'handoff failed', summary: '',
      kind: 'task', stage: 'blocked', status: 'blocked', hasRun: true, priority: 'normal',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-15T08:00:00.000Z',
      executionState: {
        kind: 'execution', state: 'failed', label: '执行失败', dispatchRequestId: null, attemptId: 3,
        reason: '运行结束，交接失败', updatedAt: '2026-10-15T08:00:00.000Z',
      },
      runtime: { state: 'blocked', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true },
    };
    const handled = ticketSummaryToTicket(base);
    expect(handled).toMatchObject({ needsAttention: false, needsUser: null, leadHandling: true, turn: 'lead' });
    // 它是 Lead 的回合（ticketTurn），进展开的「Lead 处理中」组，不进「等你」，也不标红。
    expect(groupForTicket(handled)).toBe('lead');
    expect(formatTicketHeartbeatLabel(handled)).toBe('Paimon 处理中');
    expect(ticketRailCaption(handled)).toBe('#91 · Paimon 处理中');
    expect(ticketAttentionReason(handled)).toBeNull();
    expect(ticketNextActionPresentation(handled)).toMatchObject({ label: 'Paimon 正在处理', tone: 'info' });

    // Lead 处理不了、升级给了用户：又是「需要你介入」。
    const escalated = ticketSummaryToTicket({ ...base, attention: { pendingApprovalCount: 0, blockerCount: 1 } });
    expect(escalated).toMatchObject({ needsAttention: true, needsUser: 'blocked', leadHandling: false });
    expect(groupForTicket(escalated)).toBe('needs_intervention');
    // 审批总是要用户：Lead 在处理别的也一样。
    const approval = ticketSummaryToTicket({ ...base, attention: { pendingApprovalCount: 1, blockerCount: 0, leadHandling: true } });
    expect(approval).toMatchObject({ needsAttention: true, needsUser: 'approval' });
  });

  // 2026-10-15 live（#66）：卡片写「Lead 处理中」，正文写「需要你选」。核查不通过、返工用完时，
  // 每个界面都要显示需要用户决定，不能被「Lead 处理中」盖住（AGENTS.md：所有界面取同一个 TicketSummary）。
  it('never covers a decision the user owes with "Lead 处理中"', () => {
    const owed: TicketSummary = {
      id: 66, title: 'outcome snapshot', summary: '',
      kind: 'task', stage: 'review', status: 'review', hasRun: true, priority: 'normal',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-15T10:15:00.000Z',
      reviewState: { state: 'rework_exhausted', label: '返工次数用完', canRequestReview: false } as TicketSummary['reviewState'],
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true },
    };
    const ticket = ticketSummaryToTicket(owed);
    expect(ticket.needsUser).toBe('decision');
    expect(ticket.statusLabel).not.toBe('Paimon 处理中');
    expect(ticket.runtimeLabel).not.toBe('Paimon 处理中');
    expect(formatTicketHeartbeatLabel(ticket)).not.toBe('Paimon 处理中');
  });

  it('keeps ticket details focused on tabs and ticket-level elapsed timing', () => {
    const detail = buildTicketDetailPresentation(groupedTickets[0]!, {
      timing: { elapsedMs: 372_000 },
      artifactCapability: 'unsupported',
    });

    // tab 只装执行细节。说明文字归头部，不另开一个 tab 重复渲染同一段字；
    // 没有 Run 时 visibleTicketTabs 返回空数组，整条 tab 栏都不出现（kernel spec §11）。
    expect(TICKET_DETAIL_TABS.map((tab) => tab.label)).toEqual(['验收证据', '产物', '日志']);
    expect(detail.properties).toContainEqual({ id: 'elapsed', label: '耗时', value: '6m' });
    expect(detail.properties.map((property) => property.id)).not.toEqual(
      expect.arrayContaining(['capability_coverage', 'gaps', 'tool_calls']),
    );
    expect(detail.artifactState).toMatchObject({
      kind: 'unsupported',
      title: '产物能力尚未接入',
    });
  });

  it('never falls back to demo tickets after the control plane is connected', () => {
    expect(resolveWorkspaceTickets(true, [])).toEqual([]);
    expect(resolveWorkspaceTickets(false, [])).toEqual([]);
  });

  it('keeps child tickets out of the top-level work rail and background roots in it', () => {
    const root = {
      id: 42, title: '根工单', summary: '',
      kind: 'task', stage: 'active', status: 'active', hasRun: true, priority: 'high',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-07-23T06:00:00.000Z',
      parentTicketId: null, rootTicketId: 42,
      runtime: { state: 'running', lastActivityAt: '2026-07-23T06:00:00.000Z', activeAttemptId: 9 },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    } as TicketSummary;
    const child = {
      ...root,
      id: 43,
      title: '子任务',
      parentTicketId: 42,
      rootTicketId: 42,
    } as TicketSummary;
    const background = {
      ...root,
      id: 55,
      title: '后台周报汇总',
      worklistVisibility: 'background',
    } as TicketSummary;

    // 后台的根工单也列出来：它们进默认收起的「Lead 后台」组。子工单不列。
    expect(resolveWorkspaceTickets(true, [root, child, background]).map((ticket) => ticket.id)).toEqual(['42', '55']);
  });

  it('keeps child tickets addressable for the detail thread', () => {
    const root = {
      id: 42, title: '根工单', summary: '',
      kind: 'task', stage: 'active', status: 'active', hasRun: true, priority: 'high',
      project: null, dueAt: null, deferUntil: null, updatedAt: '2026-07-23T06:00:00.000Z',
      parentTicketId: null, rootTicketId: 42,
      runtime: { state: 'running', lastActivityAt: '2026-07-23T06:00:00.000Z', activeAttemptId: 9 },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    } as TicketSummary;
    const child = {
      ...root,
      id: 43,
      title: '子任务',
      parentTicketId: 42,
      rootTicketId: 42,
    } as TicketSummary;

    const resolvedChild = resolveWorkspaceTicket(true, [root, child], 43);
    expect(resolvedChild).toMatchObject({
      id: '43',
      title: '子任务',
    });
    expect(resolvedChild).not.toHaveProperty('displayId');
    expect(resolveWorkspaceTicket(true, [root, child], 99)).toBeUndefined();
    expect(resolveWorkspaceTicket(false, [root, child], 43)).toBeUndefined();
  });
});
