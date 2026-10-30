import type {
  AgendaItem,
  ApprovalDto,
  AttemptDto,
  ConversationTurn,
  ProjectSummary,
  TicketDetail,
  TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneStore, createInitialControlPlaneData } from './store';
import { normalizeConversationSnapshot, normalizeEntitySnapshot, type ConversationProjection } from './normalize';

function ticket(id: number, title = `Ticket ${id}`): TicketSummary {
  return {
    id,
    title,
    summary: `Summary ${id}`,
    kind: 'task',
    stage: 'draft',
    status: 'draft',
    hasRun: false,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-07-24T06:00:00.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
  };
}

function project(id: string): ProjectSummary {
  return {
    id,
    name: id,
    ticketCount: 1,
    runningCount: 0,
    reviewCount: 0,
    blockedCount: 0,
    nearestDueAt: null,
  };
}

function agenda(id: string): AgendaItem {
  return {
    id,
    kind: 'schedule',
    startsAt: '2026-07-24T08:00:00.000Z',
    title: id,
    ticketId: null,
    scheduleId: 1,
    status: null,
    project: null,
  };
}

function approval(id: number): ApprovalDto {
  return {
    id,
    ticketId: 42,
    requestedBy: 'child',
    tool: 'shell',
    action: 'run tests',
    payload: {},
    status: 'pending',
    expiresAt: '2026-07-24T09:00:00.000Z',
    createdAt: '2026-07-24T08:00:00.000Z',
  };
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    originBindingId: 7,
    originKind: 'companion',
    ticketId: 42,
    state: 'steered',
    userText: 'Implement the state layer',
    assistantText: 'I updated the plan.',
    error: null,
    createdAt: '2026-07-24T08:00:00.000Z',
    updatedAt: '2026-07-24T08:01:00.000Z',
    ...overrides,
  };
}

function conversationProjection(): ConversationProjection {
  const initial = createInitialControlPlaneData();
  return {
    sessionsById: initial.sessionsById,
    sessionIds: initial.sessionIds,
    turnsById: initial.turnsById,
    turnIdsBySession: initial.turnIdsBySession,
    messagesById: initial.messagesById,
    messageIdsBySession: initial.messageIdsBySession,
    messageIdsByTicket: initial.messageIdsByTicket,
    messagePartsById: initial.messagePartsById,
    partIdsByMessage: initial.partIdsByMessage,
    assistantMessageIdByTurnId: initial.assistantMessageIdByTurnId,
    turnIdByCommandId: initial.turnIdByCommandId,
  };
}

describe('control-plane snapshot normalization', () => {
  it('normalizes ordered collections and preserves equal entity and id-array identity', () => {
    const firstTickets = normalizeEntitySnapshot({}, [], [ticket(1), ticket(2)], (item) => item.id);
    const nextTickets = normalizeEntitySnapshot(firstTickets.byId, firstTickets.ids, [ticket(1), ticket(2)], (item) => item.id);
    const nextProjects = normalizeEntitySnapshot({}, [], [project('core')], (item) => item.id);
    const nextAgenda = normalizeEntitySnapshot({}, [], [agenda('agenda-1')], (item) => item.id);
    const nextApprovals = normalizeEntitySnapshot({}, [], [approval(3)], (item) => item.id);

    expect(firstTickets.ids).toEqual([1, 2]);
    expect(nextTickets.byId[1]).toBe(firstTickets.byId[1]);
    expect(nextTickets.ids).toBe(firstTickets.ids);
    expect(nextProjects.ids).toEqual(['core']);
    expect(nextAgenda.ids).toEqual(['agenda-1']);
    expect(nextApprovals.ids).toEqual([3]);
  });

  it('removes absent summary entities without deleting cached ticket detail', () => {
    const store = createControlPlaneStore();
    const detail: TicketDetail = {
      ticket: ticket(1),
      brief: 'brief',
      body: 'body',
      workdir: '/tmp/repo',
      createdAt: '2026-07-24T06:00:00.000Z',
      totalTokens: 0,
      totalCostUsd: 0,
      remindAt: null,
    };
    store.setState({ ticketDetailsById: { 1: detail } });

    store.getState().replaceTickets([ticket(1), ticket(2)]);
    store.getState().replaceTickets([ticket(2)]);

    expect(store.getState().ticketIds).toEqual([2]);
    expect(store.getState().ticketsById[1]).toBeUndefined();
    expect(store.getState().ticketDetailsById[1]).toBe(detail);
  });

  it('normalizes a turn into deterministic session, turn, message, and text-part entities', () => {
    const result = normalizeConversationSnapshot(conversationProjection(), 'session-1', [turn()]);
    const userMessageId = 'session-1:turn-1:user';
    const assistantMessageId = 'session-1:turn-1:assistant';

    expect(result.sessionIds).toEqual(['session-1']);
    expect(result.turnIdsBySession['session-1']).toEqual(['turn-1']);
    expect(result.messageIdsBySession['session-1']).toEqual([]);
    expect(result.messageIdsByTicket[42]).toEqual([userMessageId, assistantMessageId]);
    expect(result.turnsById['turn-1']).toMatchObject({
      sessionId: 'session-1',
      ticketId: 42,
      originBindingId: 7,
      originKind: 'companion',
      state: 'steered',
      userMessageId,
      assistantMessageId,
    });
    expect(result.messagesById[assistantMessageId]).toMatchObject({
      state: 'steered',
      clientCommandId: null,
      source: 'snapshot',
    });
    expect(result.messagePartsById[`${assistantMessageId}:text`]).toEqual({
      kind: 'text',
      id: `${assistantMessageId}:text`,
      text: 'I updated the plan.',
    });
  });

  it('keeps assistant-only snapshot turns out of the visible user message order', () => {
    const result = normalizeConversationSnapshot(conversationProjection(), 'session-1', [turn({ userText: '' })]);

    expect(result.messageIdsBySession['session-1']).toEqual([]);
    expect(result.messageIdsByTicket[42]).toEqual(['session-1:turn-1:assistant']);
  });

  it('keeps global turns in the Lead conversation and ticket turns in the ticket conversation', () => {
    const result = normalizeConversationSnapshot(conversationProjection(), 'session-1', [
      turn({ id: 'global-turn', ticketId: null, userText: '全局问题' }),
      turn({ id: 'ticket-turn', ticketId: 49, userText: '这个单需要我干什么' }),
    ]);

    expect(result.messageIdsBySession['session-1']).toEqual([
      'session-1:global-turn:user',
      'session-1:global-turn:assistant',
    ]);
    expect(result.messageIdsByTicket[49]).toEqual([
      'session-1:ticket-turn:user',
      'session-1:ticket-turn:assistant',
    ]);
  });

  it('is idempotent and does not fabricate non-text parts from assistant text', () => {
    const first = normalizeConversationSnapshot(conversationProjection(), 'session-1', [turn()]);
    const second = normalizeConversationSnapshot(first, 'session-1', [turn()]);
    const assistantMessageId = 'session-1:turn-1:assistant';

    expect(second.sessionsById['session-1']).toBe(first.sessionsById['session-1']);
    expect(second.turnsById['turn-1']).toBe(first.turnsById['turn-1']);
    expect(second.messagesById[assistantMessageId]).toBe(first.messagesById[assistantMessageId]);
    expect(second.messagePartsById[`${assistantMessageId}:text`]).toBe(first.messagePartsById[`${assistantMessageId}:text`]);
    expect(second.sessionIds).toBe(first.sessionIds);
    expect(second.turnIdsBySession['session-1']).toBe(first.turnIdsBySession['session-1']);
    expect(second.messageIdsByTicket[42]).toEqual([
      'session-1:turn-1:user',
      'session-1:turn-1:assistant',
    ]);
    expect(Object.values(second.messagePartsById).map((part) => part.kind)).toEqual(['text', 'text']);
  });

  it('cleans duplicate message ids left by an older snapshot merge', () => {
    const first = normalizeConversationSnapshot(conversationProjection(), 'session-1', [turn()]);
    const legacy = {
      ...first,
      messageIdsByTicket: { 42: [...first.messageIdsByTicket[42], ...first.messageIdsByTicket[42]] },
    };
    const repaired = normalizeConversationSnapshot(legacy, 'session-1', [turn()]);
    expect(repaired.messageIdsByTicket[42]).toEqual([
      'session-1:turn-1:user',
      'session-1:turn-1:assistant',
    ]);
  });

  it('normalizes exact attempt summary fields and reuses an unchanged snapshot', () => {
    const store = createControlPlaneStore();
    const attempts: AttemptDto[] = [{
      id: 9,
      ticketId: 42,
      role: 'reviewer',
      state: 'running',
      model: 'gpt-5.6-sol',
      startedAt: '2026-07-24T08:00:00.000Z',
      endedAt: null,
    }];
    const listener = vi.fn();
    store.subscribe((state) => state.attemptsById[9], listener);

    store.getState().replaceAttempts(42, attempts);
    const first = store.getState().attemptsById[9];
    store.getState().replaceAttempts(42, [{ ...attempts[0] }]);

    expect(first).toMatchObject({
      id: 9,
      ticketId: 42,
      role: 'reviewer',
      state: 'running',
      model: 'gpt-5.6-sol',
      runtime: null,
      startedAt: '2026-07-24T08:00:00.000Z',
      endedAt: null,
      kernel: null,
    });
    expect(store.getState().attemptIdsByTicket[42]).toEqual([9]);
    expect(store.getState().attemptsById[9]).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
