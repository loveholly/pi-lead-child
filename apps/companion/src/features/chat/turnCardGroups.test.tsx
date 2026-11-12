// @vitest-environment happy-dom
// When Lead sets many reminders in one turn (a calendar sync), every reminder used to show as a full card, one under
// the other, and the conversation filled with them. Three or more same-kind cards of one turn now show as one line
// (design P9.10) that opens an anchored panel. Failed operations, due reminders and dispatch cards stay on their own.
import type { ConversationTurn, KernelConversationCard, TicketDetail, TicketSummary } from '@pi-lead-child/protocol';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { ConversationCardEntity } from '../../state/types';
import { LeadConversation } from './LeadConversation';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { groupTicketParts, groupTurnCards, type TurnCardFacts } from './turnCardGroups';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

type Op = { name: string; state?: 'completed' | 'started' | 'failed' };

function card(cardId: number, ticketId: number, ops: Op[], turnId = 'turn-sync'): KernelConversationCard {
  return {
    id: cardId, key: `turn:${turnId}:ticket:${ticketId}`, kind: 'ticket_execution', turnId, ticketId,
    operations: ops.map((op, index) => ({ id: `${turnId}:${cardId}:${index}`, name: op.name, state: op.state ?? 'completed', label: op.name, detail: null })),
    operationsTruncated: false, createdAt: '2026-11-12T07:00:00.000Z', updatedAt: '2026-11-12T07:00:00.000Z',
  } as KernelConversationCard;
}

const asEntity = (value: KernelConversationCard) => ({ ...value, id: String(value.id) }) as unknown as ConversationCardEntity;

function byId(cards: KernelConversationCard[]) {
  return Object.fromEntries(cards.map((value) => [String(value.id), asEntity(value)]));
}

const facts = (overrides: Partial<TurnCardFacts> = {}): TurnCardFacts => ({
  itemKind: () => null, stage: () => null, isDispatch: () => false, ...overrides,
});

describe('groupTurnCards', () => {
  it('keeps two reminder cards as cards and merges three into one group at the first card', () => {
    const two = [card(1, 11, [{ name: 'create_reminder' }]), card(2, 12, [{ name: 'create_reminder' }])];
    expect(groupTurnCards(['1', '2'], byId(two), facts()).map((slot) => slot.kind)).toEqual(['card', 'card']);

    const many = [
      card(1, 11, [{ name: 'create_reminder' }]), card(2, 50, [{ name: 'add_comment' }]),
      card(3, 12, [{ name: 'create_reminder' }]), card(4, 13, [{ name: 'reschedule_reminder' }]),
    ];
    const slots = groupTurnCards(['1', '2', '3', '4'], byId(many), facts());
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      kind: 'group', group: { kind: 'reminder', cardIds: ['1', '3', '4'], ticketIds: [11, 12, 13], actions: { created: 2, rescheduled: 1 } },
    });
    expect(slots[1]).toEqual({ kind: 'card', cardId: '2' });
  });

  it('leaves out failed or unfinished operations, due reminders and dispatch cards', () => {
    const cards = [
      card(1, 11, [{ name: 'create_reminder' }]), card(2, 12, [{ name: 'create_reminder' }]),
      card(3, 13, [{ name: 'create_reminder', state: 'failed' }]), card(4, 14, [{ name: 'create_reminder', state: 'started' }]),
      card(5, 15, [{ name: 'create_reminder' }]),
    ];
    const ids = ['1', '2', '3', '4', '5'];
    // The fifth one is due and not acknowledged: it needs the user, so it stays a card and two are left: no group.
    expect(groupTurnCards(ids, byId(cards), facts({ stage: (id) => (id === 15 ? 'fired' : 'scheduled') })).every((slot) => slot.kind === 'card')).toBe(true);
    const grouped = groupTurnCards(ids, byId(cards), facts());
    expect(grouped.map((slot) => (slot.kind === 'group' ? slot.group.cardIds.join(',') : slot.cardId))).toEqual(['1,2,5', '3', '4']);
  });

  it('merges three new tickets but never dispatch cards or other ticket operations', () => {
    const cards = [
      card(1, 21, [{ name: 'create_task' }]), card(2, 22, [{ name: 'create_task' }]), card(3, 23, [{ name: 'create_task' }]),
      card(4, 24, [{ name: 'create_task' }, { name: 'spawn_child' }]), card(5, 25, [{ name: 'create_task' }]),
    ];
    const slots = groupTurnCards(['1', '2', '3', '4', '5'], byId(cards), facts({ isDispatch: (id) => id === '5', itemKind: () => 'task' }));
    expect(slots.map((slot) => (slot.kind === 'group' ? `${slot.group.kind}:${slot.group.cardIds.join(',')}` : slot.cardId)))
      .toEqual(['task:1,2,3', '4', '5']);
  });
});

describe('groupTicketParts', () => {
  it('merges three created reminders of one reply, leaves a due one and an unknown one on their own', () => {
    const parts = [11, 12, 13, 14, 15].map((ticketId) => ({ partId: `t:ticket:${ticketId}`, ticketId }));
    const slots = groupTicketParts(parts, {
      itemKind: (id) => (id === 15 ? null : 'reminder'),
      stage: (id) => (id === 14 ? 'fired' : 'scheduled'),
    });
    expect(slots.map((slot) => (slot.kind === 'group' ? `${slot.group.kind}:${slot.group.ticketIds.join(',')}` : slot.cardId)))
      .toEqual(['reminder:11,12,13', 't:ticket:14', 't:ticket:15']);
    expect(slots[0]).toMatchObject({ group: { actions: { created: 3 } } });
  });
});

const SESSION = 'lead-session';

function reminderSummary(id: number, stage: TicketSummary['stage'] = 'scheduled'): TicketSummary {
  return {
    id, title: `Meeting ${id}`, summary: '', kind: 'reminder', hasRun: false, priority: 'normal', project: null, dueAt: null,
    deferUntil: null, updatedAt: '2026-11-12T07:00:00.000Z', runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage, status: stage,
  } as TicketSummary;
}

function reminderDetail(id: number): TicketDetail {
  return {
    ticket: reminderSummary(id, id === 104 ? 'cancelled' : 'scheduled'), brief: '', body: '', workdir: null,
    createdAt: '2026-11-12T07:00:00.000Z', totalTokens: 0, totalCostUsd: 0,
    remindAt: new Date(2026, 10, 12 + (id - 100), 9, 55).toISOString(), createdBy: 'lead',
    reminder: { level: 'interrupt', earlyMs: null, repeat: null, ticketId: null, check: null },
  } as TicketDetail;
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: 'Sync my calendar', assistantText: 'Set reminders for your meetings.', error: null,
    createdAt: '2026-11-12T07:00:00.000Z', updatedAt: '2026-11-12T07:00:10.000Z', ...overrides,
  };
}

describe('a turn that set many reminders', () => {
  it('shows one line instead of a card per reminder, and lists them in an anchored panel', async () => {
    const ids = [100, 101, 102, 103, 104, 105];
    const runtime = createCompanionStateRuntime({
      client: { getTicket: vi.fn(async (id: number) => reminderDetail(id)) } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceConversation(SESSION, [turn('turn-sync', {})]);
    runtime.control.getState().mergeConversationCardPage({
      items: ids.map((id, index) => card(index + 1, id, [{ name: 'create_reminder' }])),
      checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null,
    }, 'replace');
    runtime.workspace.setState({ hydrated: true });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);

    const group = await screen.findByTestId('turn-card-group-reminder');
    // No single reminder card is drawn; the line counts the six and names the action.
    expect(screen.queryAllByTestId(/^reminder-card-/)).toHaveLength(0);
    expect(within(group).getByText('Set reminders')).toBeTruthy();
    expect(await within(group).findByText(/^6 items · 11-12 \w{3} – 11-17 \w{3}$/)).toBeTruthy();

    fireEvent.click(within(group).getByTestId('turn-card-group-reminder-expand'));
    const list = await screen.findByTestId('turn-card-group-reminder-list');
    expect(within(list).getByText('Meeting 100')).toBeTruthy();
    expect(within(list).getAllByText('Important')).toHaveLength(5);
    expect(within(list).getByText('Cancelled')).toBeTruthy();
    expect(within(list).getByText('11-12 09:55')).toBeTruthy();
  });
});

describe('a reply that created many reminders with create_ticket', () => {
  it('shows the ticket parts as one line too, not a card per reminder', async () => {
    const ids = [100, 101, 102, 103];
    const runtime = createCompanionStateRuntime({
      client: { getTicket: vi.fn(async (id: number) => reminderDetail(id)) } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceConversation(SESSION, [turn('turn-parts', {})]);
    for (const id of ids) {
      applyControlPlaneMutation(runtime.control, SESSION, {
        type: 'lead.upsert-ticket-part', turnId: 'turn-parts', partId: `turn-parts:ticket:${id}`, ticketId: id,
      });
    }
    runtime.workspace.setState({ hydrated: true });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);

    const group = await screen.findByTestId('turn-card-group-reminder');
    expect(screen.queryAllByTestId(/^reminder-card-\d+$/)).toHaveLength(0);
    expect(within(group).getByText('Set reminders')).toBeTruthy();
    expect(await within(group).findByText(/^4 items · /)).toBeTruthy();
  });
});

