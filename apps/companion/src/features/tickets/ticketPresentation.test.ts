import type {
  KernelCheckpoint, KernelIntervention, TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { leadNameNow } from '@/state/leadName';

import {
  activeTerminalHandoffFailure,
  buildCheckpointFeedPresentation,
  buildInterventionPresentation,
  buildTicketActionPresentation,
  buildTicketDetailPresentation,
  checkpointToPresentation,
  interventionActionRequest,
  interventionToAuthority,
  resourceToCheckpointFeedResource,
  ticketStatusLabel,
  ticketSummaryToTicket,
  ticketContextLabel,
  visibleTicketTabs,
  workspaceStatusPresentation,

  type CheckpointPresentationInput,
  type InterventionAuthority,
  type Ticket,
  groupForTicket,
} from '../workspace/model';

const ticket: Ticket = {
  id: '42',
  title: '移动控制面协议缺口审计',
  summary: '核对完整控制面所需能力与当前 paired API。',
  kind: 'task',
  status: 'active',
  statusLabel: '进行中',
  hasRun: true,
  priority: 'high',
  priorityLabel: '高',
  project: 'pi-lead-child',
  runtimeLabel: '运行中',
  runtimeName: 'codex',
  agentLabel: 'child #73',
  sessionId: 'sess_9f42a1c7',
  elapsedMs: 372_000,
  heartbeat: true,
  needsAttention: false,
  turn: 'running',
};

function summaryFixture(patch: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 42,
    title: 't',
    summary: 's',
    kind: 'task',
    stage: 'active',
    status: 'active',
    hasRun: true,
    priority: 'high',
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-07-24T08:00:00.000Z',
    runtime: { state: 'running', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...patch,
    ...(patch.status ? { stage: patch.status } : {}),
  };
}

const checkpoints: CheckpointPresentationInput[] = [{
  id: '10',
  source: 'agent_reported',
  sourceLabel: 'child #73 汇报',
  createdAt: '2026-07-24T08:03:00.000Z',
  kind: 'milestone',
  title: '完成 paired API 对照',
  summary: '已定位三个真实协议缺口。',
  keyFacts: [{ label: '缺口', value: '3' }],
  relatedTicketIds: ['55'],
  nextStep: '验证 approvals 鉴权边界',
}, {
  id: '11',
  source: 'system_derived',
  sourceLabel: '系统记录',
  createdAt: '2026-07-24T08:05:00.000Z',
  kind: 'blocked',
  title: '等待授权',
  summary: '需要 approvals:respond 后继续。',
  interventionId: 'approval:7',
}];

const terminalHandoffFailure: CheckpointPresentationInput = {
  id: '12',
  source: 'system_derived',
  sourceLabel: '系统记录',
  createdAt: '2026-07-24T08:07:00.000Z',
  kind: 'blocked',
  title: '运行结束，交接失败',
  summary: 'Run 已结束，但没有完成终态交接。',
};

describe('ticket presentation', () => {
  it('makes workspace state and cross-ticket context explicit', () => {
    expect(ticketContextLabel(42, 38)).toBe('其他工单 · #38');
    expect(ticketContextLabel(42, 42)).toBeNull();
    expect(workspaceStatusPresentation({
      id: 1, ownerTicketId: 42, kind: 'isolated_child', mode: 'isolated', state: 'review_hold', inherited: false,
      availableActions: ['release'],
    })).toMatchObject({ kindLabel: '子工单工作区', stateLabel: '等待核查', stateTone: 'attention' });
  });

  it('does not infer running work or successful cleanup from workspace readiness', () => {
    const workspace = { id: 1, ownerTicketId: 42, kind: 'experiment' as const, mode: 'isolated' as const, inherited: false, availableActions: [] };
    expect(workspaceStatusPresentation({ ...workspace, state: 'active' }).nextStep).not.toContain('正在');
    expect(workspaceStatusPresentation({ ...workspace, state: 'cleaning' }).nextStep).toContain('清理');
    expect(workspaceStatusPresentation({ ...workspace, state: 'active' }).kindLabel).toBe('实验工作区');
  });
  it('only promotes an unresolved terminal handoff failure as a current alert', () => {
    expect(activeTerminalHandoffFailure('blocked', [terminalHandoffFailure])).toBe(terminalHandoffFailure);

    for (const status of ['active', 'review', 'done', 'cancelled'] as const) {
      expect(activeTerminalHandoffFailure(status, [terminalHandoffFailure])).toBeUndefined();
    }

    const newerBlocker: CheckpointPresentationInput = {
      ...terminalHandoffFailure,
      id: '13',
      createdAt: '2026-07-24T08:08:00.000Z',
      title: '等待用户授权',
    };
    expect(activeTerminalHandoffFailure('blocked', [terminalHandoffFailure, newerBlocker])).toBeUndefined();
  });

  it('maps kernel checkpoints without inventing progress or artifact metadata', () => {
    const checkpoint: KernelCheckpoint = {
      id: 18,
      ticketId: 42,
      attemptId: 73,
      author: { kind: 'executor', runtime: 'codex' },
      source: 'agent_reported',
      kind: 'blocked',
      stage: 'install',
      title: '等待系统授权',
      summary: 'launchd 安装需要 sudo。',
      keyFacts: [{ label: 'stderr', value: 'Operation not permitted' }],
      artifactRefs: ['artifact:log:18'],
      relatedTicketIds: [55],
      nextStep: '授权后继续安装',
      actionRef: { type: 'approval', id: 9 },
      createdAt: '2026-07-24T08:06:00.000Z',
    };

    expect(checkpointToPresentation(checkpoint)).toEqual({
      id: '18',
      // 写下这条记录的 Run：用来判断"等待验收"说的是不是当前那次交付。
      attemptId: 73,
      source: 'agent_reported',
      sourceLabel: 'codex executor #73 汇报',
      createdAt: checkpoint.createdAt,
      kind: 'blocked',
      stage: 'install',
      title: checkpoint.title,
      summary: checkpoint.summary,
      keyFacts: checkpoint.keyFacts,
      artifactRefs: [{ id: 'artifact:log:18', label: 'artifact:log:18' }],
      relatedTicketIds: ['55'],
      nextStep: checkpoint.nextStep,
      interventionId: 'approval:9',
    });
  });

  it('maps full approval and decision authority without exposing hidden payloads', () => {
    const approval: KernelIntervention = {
      id: 'approval:9',
      kind: 'approval',
      authorityId: 9,
      ticketId: 42,
      attemptId: 73,
      audience: 'user',
      state: 'pending',
      title: '需要 sudo',
      detail: '安装 launchd 服务',
      actions: ['approve', 'reject', 'approve_session'],
      resolution: null,
      createdAt: '2026-07-24T08:06:00.000Z',
      resolvedBy: null,
      resolvedAt: null,
    };
    const decision: KernelIntervention = {
      id: 'decision:4',
      kind: 'decision',
      authorityId: 4,
      ticketId: 42,
      attemptId: 73,
      audience: 'lead_or_user',
      blocking: true,
      allowCustom: true,
      state: 'pending',
      title: '选择发布策略',
      detail: '需要确定灰度比例。',
      options: [{ id: 'safe', label: '安全灰度', description: null }],
      actions: [{ kind: 'select', optionId: 'safe', label: '安全灰度' }, { kind: 'respond', label: '其他决定' }],
      resolution: null,
      createdAt: '2026-07-24T08:06:00.000Z',
      resolvedBy: null,
      resolvedAt: null,
    };

    expect(interventionToAuthority(approval, true)).toEqual({
      id: 'approval:9', kind: 'approval', state: 'pending', canRespond: true,
      prompt: '安装 launchd 服务', allowSessionApproval: true,
    });
    expect(interventionToAuthority(decision, false)).toEqual({
      id: 'decision:4', kind: 'decision', state: 'pending', canRespond: false,
      prompt: '需要确定灰度比例。', allowCustom: true,
      options: [{ id: 'safe', label: '安全灰度' }],
    });
  });

  it('converts intervention UI actions to explicit protocol authority commands', () => {
    expect(interventionActionRequest('approval:9', 'approve_once')).toEqual({ authority: 'approval', decision: 'approve' });
    expect(interventionActionRequest('approval:9', 'approve_session')).toEqual({ authority: 'approval', decision: 'approve_session' });
    expect(interventionActionRequest('decision:4', 'option:safe')).toEqual({ authority: 'decision_request', decision: 'select', optionId: 'safe' });
    expect(interventionActionRequest('decision:4', 'custom', '推迟到明天')).toEqual({ authority: 'decision_request', decision: 'respond', resolution: '推迟到明天' });
    expect(() => interventionActionRequest('decision:4', 'custom')).toThrow('custom decision response is required');
  });

  it('keeps cached checkpoint content visible through stale or disconnected resources', () => {
    expect(resourceToCheckpointFeedResource('ready', { state: 'loading', error: null })).toEqual({ state: 'loading' });
    expect(resourceToCheckpointFeedResource('error', { state: 'ready', error: null })).toEqual({ state: 'disconnected' });
    expect(resourceToCheckpointFeedResource('ready', { state: 'error', error: 'timeout' })).toEqual({ state: 'error', error: 'timeout' });
  });

  it('projects checkpoints newest-first with explicit source and progress language', () => {
    const feed = buildCheckpointFeedPresentation(checkpoints, {
      'approval:7': {
        id: 'approval:7',
        kind: 'approval',
        state: 'pending',
        canRespond: true,
        allowSessionApproval: true,
      },
    });

    expect(feed.state).toBe('ready');
    expect(feed.items.map((item) => item.id)).toEqual(['11', '10']);
    expect(feed.items[0]).toMatchObject({ sourceLabel: '系统记录', kindLabel: '需要介入' });
    expect(feed.items[1]).toMatchObject({ sourceLabel: 'child #73 汇报', kindLabel: '已完成阶段' });
    expect(feed.items[1]?.keyFacts).toEqual([{ label: '缺口', value: '3' }]);
  });

  it('orders checkpoints by canonical database id instead of display timestamps', () => {
    const feed = buildCheckpointFeedPresentation([
      { ...checkpoints[0]!, id: '20', createdAt: '2026-07-24T09:00:00.000Z' },
      { ...checkpoints[1]!, id: '21', createdAt: '2026-07-24T08:00:00.000Z' },
    ], {});

    expect(feed.items.map((item) => item.id)).toEqual(['21', '20']);
  });

  it('returns stable loading, empty, disconnected, and page-error checkpoint states', () => {
    expect(buildCheckpointFeedPresentation([], {}, { state: 'loading' }).state).toBe('loading');
    expect(buildCheckpointFeedPresentation([], {}, { state: 'ready' }).state).toBe('empty');
    expect(buildCheckpointFeedPresentation([], {}, { state: 'disconnected' }).state).toBe('disconnected');
    expect(buildCheckpointFeedPresentation(checkpoints, {}, { state: 'error', error: 'timeout' })).toMatchObject({
      state: 'ready',
      pageError: 'timeout',
    });
  });

  it('derives approval actions only from a pending respondable authority', () => {
    const authority: InterventionAuthority = {
      id: 'approval:7',
      kind: 'approval',
      state: 'pending',
      canRespond: true,
      allowSessionApproval: true,
    };

    expect(buildInterventionPresentation(authority).actions.map((action) => action.id)).toEqual([
      'reject',
      'approve_once',
      'approve_session',
    ]);
    expect(buildInterventionPresentation(authority).actions[0]?.label).toBe('拒绝');
    expect(buildInterventionPresentation({ ...authority, canRespond: false }).actions).toEqual([]);
    expect(buildInterventionPresentation({ ...authority, state: 'resolved', resolvedBy: 'alice', resolutionLabel: '已授权本次' })).toMatchObject({
      stateLabel: '已解决',
      tone: 'success',
      resolutionText: 'alice · 已授权本次',
      actions: [],
    });
    expect(buildInterventionPresentation({ ...authority, state: 'rejected' })).toMatchObject({ tone: 'danger' });
    // 2026-10-26：resolvedBy 是内部的 actor 字符串，显示成给人看的说法，不再写「lead」「user via page」。
    expect(buildInterventionPresentation({ ...authority, state: 'resolved', resolvedBy: 'lead', resolutionLabel: '已授权本次' }).resolutionText)
      .toBe(`${leadNameNow()} · 已授权本次`);
    expect(buildInterventionPresentation({ ...authority, state: 'resolved', resolvedBy: 'user via page', resolutionLabel: '已授权本次' }).resolutionText)
      .toBe('你 · 已授权本次');
  });

  // 2026-10-16：同一件事只有一种说法。等你回答的决定写「待你决定」、等你批准的写「待审批」，
  // 和收件箱、状态标签（protocol 的 ticketNeedsUserLabel）一样，不再都写「需要你介入」。
  it('names a pending intervention the way the inbox and the status label do', () => {
    expect(buildInterventionPresentation({ id: 'decision:12', kind: 'decision', state: 'pending', canRespond: true, options: [] }).stateLabel)
      .toBe('待你决定');
    expect(buildInterventionPresentation({ id: 'approval:7', kind: 'approval', state: 'pending', canRespond: true }).stateLabel)
      .toBe('待审批');
  });

  it('derives decision actions from authoritative options and disables terminal states', () => {
    const decision: InterventionAuthority = {
      id: 'decision:9',
      kind: 'decision',
      state: 'pending',
      canRespond: true,
      options: [{ id: 'safe', label: '安全方案' }, { id: 'fast', label: '快速方案' }],
      allowCustom: true,
    };

    expect(buildInterventionPresentation(decision).actions.map((action) => action.id)).toEqual([
      'option:safe',
      'option:fast',
      'custom',
    ]);
    expect(buildInterventionPresentation({ ...decision, state: 'expired' })).toMatchObject({
      stateLabel: '已过期',
      tone: 'muted',
      actions: [],
    });
  });

  it('keeps artifacts honest and removes the prototype metric grid', () => {
    const detail = buildTicketDetailPresentation(ticket, {
      timing: { elapsedMs: ticket.elapsedMs },
      artifactCapability: 'unsupported',
    });

    expect(detail.artifactState).toEqual({
      kind: 'unsupported',
      title: '产物能力尚未接入',
      body: '当前内核还没有可读取的 Artifact 资源，不会从文件路径伪造产物。',
    });
    expect(detail).not.toHaveProperty('metrics');
    expect(detail.properties).toContainEqual({ id: 'elapsed', label: '耗时', value: '6m' });
  });
});

// 诉求 1/2 在 UI 层的落点（kernel spec §11）。
// 规则只有一条：**执行面板的数据源是 Run，没有 Run 就不渲染**。
// 判据是 hasRun 而不是 kind==='task'——一个已确认但还没开跑的任务同样什么都没有。
describe('visibleTicketTabs', () => {
  // 没有「详情」tab：说明文字由头部渲染，再开一个 tab 装同一段字是重复。
  it('offers no tabs at all for a reminder', () => {
    expect(visibleTicketTabs({ kind: 'reminder', hasRun: false })).toEqual([]);
  });

  it('offers no tabs for a task that has never run', () => {
    expect(visibleTicketTabs({ kind: 'task', hasRun: false })).toEqual([]);
  });

  it('offers only execution tabs once a run exists', () => {
    expect(visibleTicketTabs({ kind: 'task', hasRun: true }))
      .toEqual(['progress', 'artifacts', 'logs']);
  });

  // 结构上不可能：reminder 永远不能拥有 Run（kernel spec §3.1），但即便投影撒谎，
  // UI 也不该因此长出执行面板。
  it('never offers execution tabs for a reminder even if hasRun lies', () => {
    expect(visibleTicketTabs({ kind: 'reminder', hasRun: true })).toEqual([]);
  });
});

describe('ticket vocabulary matches the protocol', () => {
  it('labels every protocol stage, including the reminder machine', () => {
    for (const stage of [
      'draft', 'ready', 'active', 'blocked', 'review', 'done', 'cancelled',
      'scheduled', 'fired', 'acked',
    ] as const) {
      expect(ticketStatusLabel(stage)).toBeTruthy();
    }
  });

  // 迁移前这里是 'backlog' | 'assigned' | 'running'，并且 ticketSummaryToTicket 还做了
  // 一次 in_progress → running 的重映射。那套词汇在协议里早已不存在，tsc 看不到 apps/，
  // 于是它一直静默地活着：ConnectedTicketThread 和 LeadConversation 里两条
  // `=== 'in_progress'` 分支永远不成立，子工单一律显示成 waiting。
  it('carries the protocol stage through without remapping', () => {
    const ticket = ticketSummaryToTicket(summaryFixture({ status: 'active' }));
    expect(ticket.status).toBe('active');
    expect(ticket.statusLabel).toBe('进行中');
  });

  it('carries kind and hasRun onto the view model', () => {
    const reminder = ticketSummaryToTicket(summaryFixture({
      status: 'scheduled', kind: 'reminder', hasRun: false,
    }));
    expect(reminder.kind).toBe('reminder');
    expect(reminder.hasRun).toBe(false);
  });

  it('survives a work item that has no timing at all', () => {
    // timing 现在是可选的（没有 Run 就整个不投）。旧代码直接读 workItem.timing.elapsedMs，
    // 对一条提醒会当场抛 TypeError。
    const ticket = ticketSummaryToTicket(summaryFixture({ status: 'scheduled', kind: 'reminder' }), {
      ticketId: 7,
      activeExecution: null,
      pendingInterventionCount: 0,
      latestCheckpointId: null,
    });
    expect(ticket.elapsedMs ?? null).toBeNull();
  });
});

// groupForTicket 原本是"认不出的 stage 一律算进行中"，于是 draft / scheduled / fired
// 全掉进「进行中」。真实回归：一条已触发的提醒和一条待确认的 draft 并排出现在那里。
describe('rail grouping never calls a non-running stage running', () => {
  // 走真实的投影：分组读 ticketTurn，手写的 Ticket 没有它。
  const mk = (status: string, kind: 'task' | 'reminder' = 'task', runtime: 'idle' | 'running' = 'idle') =>
    ticketSummaryToTicket({
      id: 1, title: 't', summary: '', kind, stage: status, status, hasRun: runtime === 'running',
      priority: 'normal', project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-15T07:00:00.000Z',
      runtime: { state: runtime, lastActivityAt: null, activeAttemptId: runtime === 'running' ? 3 : null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    } as TicketSummary);

  it('puts a draft under 需要你介入, not 进行中 — it is waiting on the user', () => {
    expect(groupForTicket(mk('draft'))).toBe('needs_intervention');
  });

  // 实例上「进行中 6」里没有一张在跑：ready 没有 Run 就是排队，不是在执行。
  it('calls a ticket running only when a run is running, and a ready ticket queued', () => {
    expect(groupForTicket(mk('ready'))).toBe('queued');
    expect(groupForTicket(mk('active', 'task', 'running'))).toBe('running');
  });

  it('never files a reminder stage as 进行中', () => {
    for (const stage of ['scheduled', 'fired'] as const) {
      expect(groupForTicket(mk(stage, 'reminder'))).not.toBe('running');
    }
    expect(groupForTicket(mk('acked', 'reminder'))).toBe('completed');
  });
});

// 诉求：服务端一直有 POST /v1/tickets/:id/<action>，companion 却一个按钮都没画——
// 一张 draft 的根工单在界面上没有任何确认入口。动作集合必须从 protocol 的权限矩阵算出，
// 不能在 UI 里按 stage 手写第二份（那一份必然和内核分家）。
describe('ticket action row is derived from the actor matrix', () => {
  const at = (status: string, kind: 'task' | 'reminder' = 'task') =>
    buildTicketActionPresentation({ status, kind } as any);
  const ids = (status: string, kind: 'task' | 'reminder' = 'task') =>
    at(status, kind).map((action) => action.id);

  it('offers confirm on a draft task — the entry point the user was missing', () => {
    expect(ids('draft')).toEqual(['confirm', 'cancel']);
    expect(at('draft')[0]).toEqual({ id: 'confirm', label: '确认开跑', tone: 'primary' });
  });

  it('never offers confirm anywhere else', () => {
    for (const status of ['ready', 'active', 'blocked', 'review', 'done', 'cancelled']) {
      expect(ids(status)).not.toContain('confirm');
    }
  });

  it('offers exactly the user-legal moves for the other task stages', () => {
    expect(ids('ready')).toEqual(['start', 'unconfirm', 'cancel']);
    expect(ids('active')).toEqual(['stop', 'cancel']);
    expect(ids('blocked')).toEqual(['start', 'stop', 'cancel']);
    expect(ids('review')).toEqual(['complete', 'rework', 'cancel']);
    expect(ids('done')).toEqual(['rework']);
    expect(ids('cancelled')).toEqual(['restore']);
  });

  it('uses the reminder machine for reminders', () => {
    expect(ids('scheduled', 'reminder')).toEqual(['cancel']);
    expect(ids('fired', 'reminder')).toEqual(['ack', 'cancel']);
    // acked 是终态：没有任何动作，动作行整行不渲染。
    expect(ids('acked', 'reminder')).toEqual([]);
  });

  it('appends only server-authorized workspace actions without inferring them', () => {
    const active = { id: 7, ownerTicketId: 42, mode: 'shared' as const, kind: 'primary' as const, state: 'active' as const, inherited: false, availableActions: ['release' as const] };
    const released = { ...active, state: 'released' as const, availableActions: ['cleanup' as const] };
    expect(buildTicketActionPresentation({ status: 'done', kind: 'task', workspace: active }).map((a) => a.id))
      .toEqual(['rework', 'release']);
    expect(buildTicketActionPresentation({ status: 'done', kind: 'task', workspace: released }).map((a) => a.id))
      .toEqual(['rework', 'cleanup']);
    expect(buildTicketActionPresentation({ status: 'done', kind: 'task', workspace: { ...active, availableActions: [] } }).map((a) => a.id))
      .toEqual(['rework']);
  });

  it('marks cancel as the only destructive action', () => {
    const danger = ['draft', 'ready', 'active', 'blocked', 'review']
      .flatMap((status) => at(status).filter((action) => action.tone === 'danger').map((a) => a.id));
    expect(new Set(danger)).toEqual(new Set(['cancel']));
  });

  it('names the destructive ticket action explicitly', () => {
    expect(buildTicketActionPresentation({ status: 'blocked', kind: 'task' } as any).find((action) => action.id === 'cancel')?.label)
      .toBe('取消工单');
  });
});

describe('historical checkpoint labels (F14) and dates (F17)', () => {
  const at = (id: string, kind: CheckpointPresentationInput['kind'], createdAt: string): CheckpointPresentationInput => ({
    id, kind, createdAt, source: 'system_derived', sourceLabel: '系统记录', title: id, summary: '',
  });
  // #66：两个月前的崩溃与交接失败，以及工单现在停在 review。
  const history = [
    at('85', 'blocked', '2026-08-19T09:42:01.649Z'),
    at('93', 'blocked', '2026-08-21T09:17:54.141Z'),
    at('94', 'progress', '2026-08-21T10:27:45.463Z'),
    at('68', 'completed', '2026-08-17T11:01:46.424Z'),
  ];

  it('regression #66: does not label old crashes as needing intervention while the ticket is in review', () => {
    const feed = buildCheckpointFeedPresentation(history, {}, { state: 'ready' }, { ticketStatus: 'review' });
    const label = (id: string) => feed.items.find((item) => item.id === id);

    expect(label('85')).toMatchObject({ kindLabel: '当时阻塞', historical: true });
    expect(label('93')).toMatchObject({ kindLabel: '当时阻塞', historical: true });
    expect(label('94')).toMatchObject({ kindLabel: '进展', historical: true });
    // 工单确实在 review，最新那条提交记录说的就是现在。
    expect(label('68')).toMatchObject({ kindLabel: '执行完成，等待验收' });
    expect(label('68')!.historical).toBeUndefined();
  });

  it('regression #66: does not say an older delivery is waiting for acceptance', () => {
    const submitted = { ...at('68', 'completed', '2026-08-17T11:01:46.424Z'), attemptId: 42 };
    const feed = buildCheckpointFeedPresentation([submitted], {}, { state: 'ready' }, { ticketStatus: 'review', deliveryRunId: 49 });

    expect(feed.items[0]).toMatchObject({ kindLabel: '已提交验收', historical: true });
  });

  it('keeps the current blocker labelled as needing intervention', () => {
    const feed = buildCheckpointFeedPresentation(history, {}, { state: 'ready' }, { ticketStatus: 'blocked' });

    expect(feed.items.find((item) => item.id === '93')).toMatchObject({ kindLabel: '需要介入' });
    expect(feed.items.find((item) => item.id === '85')).toMatchObject({ kindLabel: '当时阻塞' });
  });

  it('regression #66: does not say a conversation run that crashed blocked the ticket', () => {
    // 对话 Run #71 崩溃后系统记了一条 blocked 的「Run crashed」，工单却一直在 review。
    const crashed = { ...at('153', 'blocked', '2026-10-13T11:07:42.000Z'), attemptId: 71 };
    const handoff = { ...at('93', 'blocked', '2026-08-21T09:17:54.141Z'), attemptId: 48 };
    const runs = new Map([
      [71, { purpose: 'conversation', blockedTicket: false }],
      [48, { purpose: 'execution', blockedTicket: true }],
    ]);
    const feed = buildCheckpointFeedPresentation([crashed, handoff], {}, { state: 'ready' }, { ticketStatus: 'review', runs });

    expect(feed.items.find((item) => item.id === '153')).toMatchObject({ kindLabel: '对话失败', historical: true });
    expect(feed.items.find((item) => item.id === '93')).toMatchObject({ kindLabel: '当时阻塞', historical: true });
  });

  it('regression #66: shows no next step on past records or on agent instructions', () => {
    const past = { ...at('85', 'blocked', '2026-08-19T09:42:01.649Z'), nextStep: 'Inspect the runtime failure, adjust the execution path if needed, and retry.' };
    const started = { ...at('152', 'progress', '2026-10-13T11:07:38.000Z'), nextStep: 'Answer the ticket-scoped conversation without changing the task lifecycle.' };
    const current = { ...at('93', 'blocked', '2026-08-21T09:17:54.141Z'), nextStep: '检查本次运行结果，修复交接通道后重新提交状态与终态 Checkpoint，再进入 Review。' };

    const inReview = buildCheckpointFeedPresentation([past, started], {}, { state: 'ready' }, { ticketStatus: 'active' });
    expect(inReview.items.map((item) => item.nextStep)).toEqual([undefined, undefined]);
    const blocked = buildCheckpointFeedPresentation([current], {}, { state: 'ready' }, { ticketStatus: 'blocked' });
    expect(blocked.items[0]?.nextStep).toBe(current.nextStep);
  });

  it('drops diagnostic facts that carry no information', () => {
    const crashed = {
      ...at('153', 'blocked', '2026-10-13T11:07:42.000Z'),
      keyFacts: [
        { label: 'Runtime', value: 'claude' },
        { label: 'Failure scope', value: 'unknown' },
        { label: 'Needs', value: 'none' },
      ],
    };
    const feed = buildCheckpointFeedPresentation([crashed], {}, { state: 'ready' }, { ticketStatus: 'review' });

    expect(feed.items[0]?.keyFacts).toEqual([{ label: 'Runtime', value: 'claude' }]);
  });

});

