// @ts-ignore Vitest executes source-boundary checks in Node.
import type {
  KernelConversationCard,
  KernelTicketWorkItemV2,
  TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationCardEntity, LeadTurnEntity, MessageEntity } from '../../state/types';
import {
  buildLeadFooterItems,
  buildLeadTimeline,
  filterLeadTimelineCards,
  formatConversationTime,
} from './LeadConversation';

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('./MessageComposer', () => ({ MessageComposer: () => null }));
vi.mock('./MessagePartView', () => ({ MessagePartView: () => null }));
vi.mock('../../components/LeadIdentity', () => ({ LeadIdentity: () => null }));
vi.mock('../../components/StatusBadge', () => ({ StatusBadge: () => null }));
vi.mock('../../state/CompanionStateProvider', () => ({
  useCompanionRuntime: () => ({}),
  useControlPlaneStore: () => ({}),
  useWorkspaceStore: () => () => {},
}));
vi.mock('../../state/hooks', () => ({
  useConnectionPhase: () => 'ready',
  useConversationCards: () => ({ cards: [], resource: undefined }),
  useLeadSessionId: () => 'session-1',
  useMessage: () => undefined,
  useMessageIds: () => [],
  useMessagePartIds: () => [],
  useOverview: () => null,
  useTicketInterventions: () => ({ interventions: [], resource: undefined }),
  useTicketSummary: () => undefined,
  useTickets: () => [],
}));

const createdAt = '2026-07-24T08:00:00.000Z';

function message(
  id: string,
  role: MessageEntity['role'],
  turnId = 'turn-1',
  occurredAt = createdAt,
): MessageEntity {
  return {
	    id,
	    sessionId: 'session-1',
	    turnId,
	    ticketId: null,
	    role,
    state: 'completed',
    failure: null,
    clientCommandId: null,
    source: 'snapshot',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type TransientCard = WithoutId<KernelConversationCard>;

function entity<T extends TransientCard>(card: T, source: 'live' | 'durable', durableId: number | null): ConversationCardEntity {
  return { ...card, id: card.key, source, durableId } as ConversationCardEntity;
}

function execution(source: 'live' | 'durable' = 'live'): ConversationCardEntity {
  return entity({
    key: 'turn:turn-1:ticket:42',
    kind: 'ticket_execution',
    turnId: 'turn-1',
    ticketId: 42,
    operations: [{
      id: 'turn-1:create-ticket',
      name: 'create_ticket',
      state: source === 'live' ? 'running' : 'completed',
      label: '创建工单 #42',
      detail: null,
    }],
    operationsTruncated: false,
    createdAt,
    updatedAt: createdAt,
  }, source, source === 'durable' ? 9 : null);
}

function turn(id: string, ticketId: number | null): LeadTurnEntity {
  return {
    id,
    sessionId: 'session-1',
    ticketId,
    originBindingId: null,
    originKind: ticketId === null ? 'companion' : 'paired:browser:ticket',
    state: 'completed',
    error: null,
    userMessageId: `session-1:${id}:user`,
    assistantMessageId: `session-1:${id}:assistant`,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('Lead conversation card timeline', () => {
  it('formats conversation timestamps with the prototype 24-hour clock', () => {
    expect(formatConversationTime('2026-07-25T07:38:00.000Z', 'Asia/Shanghai')).toBe('15:38');
  });

  it('places a turn card after its assistant message while keeping message order', () => {
    const user = message('user-1', 'user');
    const assistant = message('assistant-1', 'assistant');

    expect(buildLeadTimeline([user, assistant], [execution()])).toEqual([
      { kind: 'message', key: 'message:user-1', messageId: 'user-1', cardIds: [] },
      {
        kind: 'message',
        key: 'message:assistant-1',
        messageId: 'assistant-1',
        cardIds: ['turn:turn-1:ticket:42'],
      },
    ]);
  });

  it('represents ticket-scoped turns as lightweight direct-message notices', () => {
    const global = message('assistant-1', 'assistant', 'global-turn');

    expect(buildLeadTimeline([global], [], [{
      id: 'ticket-turn',
      sessionId: 'session-1',
      ticketId: 49,
      originBindingId: null,
      originKind: 'paired:browser:ticket',
      state: 'completed',
      error: null,
      userMessageId: 'session-1:ticket-turn:user',
      assistantMessageId: 'session-1:ticket-turn:assistant',
      createdAt: '2026-07-24T08:00:30.000Z',
      updatedAt: '2026-07-24T08:01:00.000Z',
    }])).toEqual([
      { kind: 'message', key: 'message:assistant-1', messageId: 'assistant-1', cardIds: [] },
      { kind: 'ticket-direct', key: 'ticket-direct:ticket-turn', turnId: 'ticket-turn' },
    ]);
  });

  it('keeps ticket-scoped tool cards out of the Lead timeline card feed', () => {
    const ticketCard = execution('durable');
    const globalCard = entity({
      ...ticketCard,
      key: 'turn:global-turn:ticket:49',
      turnId: 'global-turn',
      ticketId: 49,
    }, 'durable', 10);

    expect(filterLeadTimelineCards([ticketCard, globalCard], {
      'turn-1': turn('turn-1', 49),
      'global-turn': turn('global-turn', null),
    }).map((card) => card.id)).toEqual(['turn:global-turn:ticket:49']);
  });

  it('uses one stable timeline identity when a live card becomes durable', () => {
    const live = buildLeadTimeline([], [execution('live')]);
    const durable = buildLeadTimeline([], [execution('durable')]);

    expect(live).toEqual(durable);
    expect(durable).toEqual([
      { kind: 'card', key: 'card:turn:turn-1:ticket:42', cardId: 'turn:turn-1:ticket:42' },
    ]);
  });

  it('deduplicates repeated stable keys and prefers the durable projection', () => {
    const items = buildLeadTimeline([], [execution('live'), execution('durable')]);
    expect(items).toEqual([
      { kind: 'card', key: 'card:turn:turn-1:ticket:42', cardId: 'turn:turn-1:ticket:42' },
    ]);
  });

  it('hides a checkpoint card when an intervention card owns the same checkpoint', () => {
    const checkpoint = entity({
      key: 'checkpoint:12',
      kind: 'checkpoint',
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      createdAt,
      updatedAt: createdAt,
    }, 'durable', 10);
    const intervention = entity({
      key: 'intervention:approval:18',
      kind: 'intervention',
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      interventionId: 'approval:18',
      createdAt,
      updatedAt: createdAt,
    }, 'durable', 11);

    expect(buildLeadTimeline([], [checkpoint, intervention])).toEqual([
      { kind: 'card', key: 'card:intervention:approval:18', cardId: 'intervention:approval:18' },
    ]);
  });

  it('keeps unrelated durable checkpoints in chronological order', () => {
    const later = entity({
      key: 'checkpoint:13', kind: 'checkpoint', turnId: null, ticketId: 42, checkpointId: 13,
      createdAt: '2026-07-24T08:02:00.000Z', updatedAt: '2026-07-24T08:02:00.000Z',
    }, 'durable', 13);
    const earlier = entity({
      key: 'checkpoint:12', kind: 'checkpoint', turnId: null, ticketId: 42, checkpointId: 12,
      createdAt: '2026-07-24T08:01:00.000Z', updatedAt: '2026-07-24T08:01:00.000Z',
    }, 'durable', 12);

    expect(buildLeadTimeline([], [later, earlier]).map((item) => item.key)).toEqual([
      'card:checkpoint:12', 'card:checkpoint:13',
    ]);
  });

  it('orders durable cards created at the same time by durable id', () => {
    const lowerDurableId = entity({
      key: 'checkpoint:z-last', kind: 'checkpoint', turnId: null, ticketId: 42, checkpointId: 12,
      createdAt, updatedAt: createdAt,
    }, 'durable', 20);
    const higherDurableId = entity({
      key: 'checkpoint:a-first', kind: 'checkpoint', turnId: null, ticketId: 42, checkpointId: 13,
      createdAt, updatedAt: createdAt,
    }, 'durable', 21);

    expect(buildLeadTimeline([], [higherDurableId, lowerDurableId]).map((item) => item.key)).toEqual([
      'card:checkpoint:z-last', 'card:checkpoint:a-first',
    ]);
  });

  it('inserts unanchored checkpoint feedback between messages by creation time', () => {
    const first = message('assistant-1', 'assistant', 'turn-1', '2026-07-24T08:00:00.000Z');
    const second = message('user-2', 'user', 'turn-2', '2026-07-24T08:02:00.000Z');
    const checkpoint = entity({
      key: 'checkpoint:12', kind: 'checkpoint', turnId: null, ticketId: 42, checkpointId: 12,
      createdAt: '2026-07-24T08:01:00.000Z', updatedAt: '2026-07-24T08:01:00.000Z',
    }, 'durable', 12);

    expect(buildLeadTimeline([first, second], [checkpoint]).map((item) => item.key)).toEqual([
      'message:assistant-1', 'card:checkpoint:12', 'message:user-2',
    ]);
  });

  it('orders a message by the time it shows, not the time its turn started', () => {
    // 通知播报的一轮 19:07 开始、20:28 重试失败，气泡写 20:28；19:12 的系统通知要排在它上面。
    const voicing = { ...message('assistant-voicing', 'assistant', 'turn-voicing', '2026-10-13T11:07:47.000Z'), updatedAt: '2026-10-13T12:28:00.000Z' };
    const notice = message('assistant-notice', 'assistant', 'turn-notice', '2026-10-13T11:12:38.000Z');
    expect(buildLeadTimeline([voicing, notice], []).map((item) => item.key)).toEqual([
      'message:assistant-notice', 'message:assistant-voicing',
    ]);
  });

  it('renders one assistant message when live and snapshot projections share a turn', () => {
    const live = message('assistant-live', 'assistant', 'turn-shared', '2026-07-24T08:00:00.000Z');
    const snapshot = message('assistant-snapshot', 'assistant', 'turn-shared', '2026-07-24T08:01:00.000Z');
    expect(buildLeadTimeline([live, snapshot], []).map((item) => item.key)).toEqual([
      'message:assistant-snapshot',
    ]);
  });

  it('projects every running or intervention ticket with authoritative progress', () => {
    const tickets: TicketSummary[] = [
      ticketSummary(42, 'running'),
      ticketSummary(43, 'starting'),
      {
        ...ticketSummary(44, 'blocked'),
        attention: { pendingApprovalCount: 1, blockerCount: 1 },
      },
      ticketSummary(45, 'idle'),
      { ...ticketSummary(41, 'running'), status: 'review' },
      {
        ...ticketSummary(55, 'running'),
        status: 'review',
        worklistVisibility: 'background',
      },
      {
        ...ticketSummary(46, 'blocked'),
        parentTicketId: 42,
        rootTicketId: 42,
        attention: { pendingApprovalCount: 1, blockerCount: 1 },
      },
    ];
    const workItems: KernelTicketWorkItemV2[] = [
      workItem(42, 62, 0),
      workItem(43, null, 0),
      workItem(44, 40, 2),
      workItem(41, 100, 0),
      workItem(55, 28, 0),
      workItem(46, 50, 1),
    ];

    // 需要你的工单用共用规则（protocol 的 ticketNeedsUser）和它给的原因：子工单 #46 和草稿 #45 也算。
    // 「执行中」用 ticketTurn：#41 停在 review，但它有 Run 在跑，工单 tab 也把它放在「在执行」。
    expect(buildLeadFooterItems(tickets, workItems)).toEqual([
      { ticketId: 42, stateLabel: '运行中', tone: 'running', progressPercent: 62 },
      { ticketId: 43, stateLabel: '启动中', tone: 'running', progressPercent: null },
      { ticketId: 44, stateLabel: '待审批', tone: 'attention', progressPercent: null },
      { ticketId: 45, stateLabel: '待确认', tone: 'attention', progressPercent: null },
      { ticketId: 41, stateLabel: '运行中', tone: 'running', progressPercent: 100 },
      { ticketId: 55, stateLabel: '运行中', tone: 'running', progressPercent: 28 },
      { ticketId: 46, stateLabel: '待审批', tone: 'attention', progressPercent: null },
    ]);
  });
});

function ticketSummary(id: number, state: TicketSummary['runtime']['state']): TicketSummary {
  return {
    id,
    title: `Ticket ${id}`,
    summary: `Summary ${id}`,
    kind: 'task',
    stage: state === 'blocked' ? 'blocked' : state === 'idle' ? 'draft' : 'active',
    status: state === 'blocked' ? 'blocked' : state === 'idle' ? 'draft' : 'active',
    hasRun: state !== 'idle',
    priority: 'normal',
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: createdAt,
    runtime: { state, lastActivityAt: createdAt, activeAttemptId: state === 'idle' ? null : id },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
  };
}

function workItem(
  ticketId: number,
  progressPercent: number | null,
  pendingInterventionCount: number,
): KernelTicketWorkItemV2 {
  return {
    ticketId,
    timing: {
      firstStartedAt: createdAt,
      completedAt: null,
      statusChangedAt: createdAt,
      computedAt: createdAt,
      elapsedMs: 60_000,
      activeExecutionMs: 60_000,
      statusDurationMs: 60_000,
    },
    activeExecution: {
      attemptId: ticketId,
      role: 'executor',
      runtime: 'codex',
      state: 'running',
      model: null,
      externalSessionId: null,
    },
    pendingInterventionCount,
    latestCheckpointId: 12,
    progress: progressPercent === null ? null : {
      current: progressPercent,
      total: 100,
      percent: progressPercent,
      label: '实现进度',
      source: 'explicit',
      checkpointId: 12,
    },
  };
}
