import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneStore } from './control-plane/store';
import {
  selectAgendaIds,
  selectApprovalIds,
  selectCheckpointIdsNewestFirst,
  selectConversationCardsForTicket,
  selectConversationCardIds,
  selectInterventionsForTicket,
  selectPhase,
  selectProjectIds,
  selectTicket,
  selectTicketIds,
} from './selectors';

const ticket = (id: number) => ({
  id,
  title: `Ticket ${id}`,
  summary: '',
  kind: 'task' as const,
  stage: 'draft' as const,
  status: 'draft' as const,
  hasRun: false,
  priority: 'normal' as const,
  project: null,
  dueAt: null,
  deferUntil: null,
  updatedAt: '2026-07-24T08:00:00.000Z',
  runtime: { state: 'idle' as const, lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
});

describe('focused control-plane selectors', () => {
  it('returns stored primitives, entity references, and ordered ID arrays', () => {
    const store = createControlPlaneStore();
    store.getState().replaceTickets([ticket(1)]);
    store.setState({ phase: 'ready', projectIds: ['core'], agendaIds: ['a'], approvalIds: [3] });

    expect(selectPhase(store.getState())).toBe('ready');
    expect(selectTicketIds(store.getState())).toBe(store.getState().ticketIds);
    expect(selectProjectIds(store.getState())).toBe(store.getState().projectIds);
    expect(selectAgendaIds(store.getState())).toBe(store.getState().agendaIds);
    expect(selectApprovalIds(store.getState())).toBe(store.getState().approvalIds);
    expect(selectTicket(1)(store.getState())).toBe(store.getState().ticketsById[1]);
  });

  it('does not notify ticket A when ticket B changes', () => {
    const store = createControlPlaneStore();
    store.getState().replaceTickets([ticket(1), ticket(2)]);
    const listener = vi.fn();
    store.subscribe(selectTicket(1), listener);

    store.getState().upsertTicket({ ...ticket(2), title: 'Updated B' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('emits zero selector notifications for an unchanged snapshot', () => {
    const store = createControlPlaneStore();
    store.getState().replaceTickets([ticket(1)]);
    const ids = vi.fn();
    const entity = vi.fn();
    store.subscribe(selectTicketIds, ids);
    store.subscribe(selectTicket(1), entity);

    store.getState().replaceTickets([ticket(1)]);

    expect(ids).not.toHaveBeenCalled();
    expect(entity).not.toHaveBeenCalled();
  });

  it('derives newest-first checkpoint feeds without mutating canonical storage order', () => {
    const store = createControlPlaneStore();
    store.setState({
      checkpointIdsByTicket: { 42: [10, 11, 12] },
      conversationCardIds: ['checkpoint:10'],
    });

    expect(selectCheckpointIdsNewestFirst(42)(store.getState())).toEqual([12, 11, 10]);
    expect(store.getState().checkpointIdsByTicket[42]).toEqual([10, 11, 12]);
    expect(selectConversationCardIds(store.getState())).toBe(store.getState().conversationCardIds);
  });

  it('keeps ticket-scoped intervention and card selections stable across unrelated updates', () => {
    const store = createControlPlaneStore();
    const intervention42 = { id: 'approval:42', ticketId: 42 } as never;
    const intervention55 = { id: 'approval:55', ticketId: 55 } as never;
    const card42 = { id: 'checkpoint:42', ticketId: 42 } as never;
    const card55 = { id: 'checkpoint:55', ticketId: 55 } as never;
    store.setState({
      interventionIdsByTicket: { 42: ['approval:42'], 55: ['approval:55'] },
      interventionRefsById: { 'approval:42': intervention42, 'approval:55': intervention55 },
      conversationCardIds: ['checkpoint:42', 'checkpoint:55'],
      conversationCardsById: { 'checkpoint:42': card42, 'checkpoint:55': card55 },
    });

    const selectInterventions = selectInterventionsForTicket(42);
    const selectCards = selectConversationCardsForTicket(42);
    const firstInterventions = selectInterventions(store.getState());
    const firstCards = selectCards(store.getState());

    store.setState({
      interventionRefsById: {
        ...store.getState().interventionRefsById,
        'approval:55': { id: 'approval:55', ticketId: 55, state: 'approved' } as never,
      },
      conversationCardsById: {
        ...store.getState().conversationCardsById,
        'checkpoint:55': { id: 'checkpoint:55', ticketId: 55, updatedAt: '2026-07-24T09:00:00.000Z' } as never,
      },
    });

    expect(selectInterventions(store.getState())).toBe(firstInterventions);
    expect(selectCards(store.getState())).toBe(firstCards);
  });
});
