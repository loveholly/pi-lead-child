// @vitest-environment happy-dom
// Ticket #590: an entry in the conversation opens a panel (a ticket detail, a topic, the agenda). When that panel
// already showed what you clicked, the click changed nothing, and it looked like the entry did not work. The shared
// open logic (store: openTopic, showTicket, showAgenda) now flashes the panel then (theme Q-9).
import { LEAD_TOPICS_CAPABILITY, type ConversationTurn, type TicketSummary, type TopicDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { createWorkspaceStore } from '../../state/workspace/store';
import Workbench from '../workspace/Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {}, useLocalSearchParams: () => ({}) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const TICKET = 8;

function ticket(id: number): TicketSummary {
  return {
    id, title: `Ticket ${id}`, summary: '', kind: 'task', hasRun: true, priority: 'normal', project: null, dueAt: null,
    deferUntil: null, updatedAt: '2026-10-14T08:00:00.000Z', parentTicketId: null, rootTicketId: id,
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage: 'ready', status: 'ready',
  };
}

const topic: TopicDto = {
  id: 7, title: 'Card spacing', state: 'open', openedBy: 'user', originTurnId: null, originQuote: null, originRole: null,
  model: null, conclusion: null, concludedAt: null, turnCount: 1, lastTurnId: 'tturn_1', lastActivityAt: '2026-10-14T08:02:00.000Z',
  createdAt: '2026-10-14T08:02:00.000Z', updatedAt: '2026-10-14T08:02:00.000Z',
};

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
    ...overrides,
  };
}

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

// The desktop workbench. The conversation has a reply of Lead that created #8 (an embedded ticket card) and a topic
// that you opened (its line points at the topic).
function renderDesktop() {
  setWidth(1280);
  const runtime = createCompanionStateRuntime({
    client: {
      getTopic: async () => ({ topic, turns: [] }),
      getTopics: async () => [topic],
      getConversationTurns: async () => [],
    } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  const internals = runtime as unknown as { scopes: Set<string>; capabilities: Set<string>; activeSessionId: string };
  internals.scopes = new Set(['chat', 'tickets:view']);
  internals.capabilities = new Set([LEAD_TOPICS_CAPABILITY]);
  internals.activeSessionId = SESSION;
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', capabilities: [LEAD_TOPICS_CAPABILITY], topics: [topic] });
  runtime.control.getState().replaceTickets([ticket(TICKET)]);
  runtime.control.getState().replaceConversation(SESSION, [
    turn('turn-created', { userText: 'Make a ticket', assistantText: 'Done.' }),
  ]);
  applyControlPlaneMutation(runtime.control, SESSION, {
    type: 'lead.upsert-ticket-part', turnId: 'turn-created', partId: `turn-created:ticket:${TICKET}`, ticketId: TICKET,
  });
  runtime.workspace.setState({ hydrated: true });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  return runtime;
}

afterEach(() => setWidth(0));

describe('the shared open logic when the panel already shows the object (#590)', () => {
  it('flashes only when nothing else would change', () => {
    const store = createWorkspaceStore();
    store.getState().openTopic(7);
    expect(store.getState().panelNudge).toBeNull();
    store.getState().openTopic(7);
    expect(store.getState().panelNudge).toEqual({ panel: 'topic', seq: 1 });

    store.getState().showTicket(8);
    expect(store.getState()).toMatchObject({ selectedTicketId: 8, threadOpen: true, topicOpenId: null });
    expect(store.getState().panelNudge?.seq).toBe(1);
    store.getState().showTicket(9);
    expect(store.getState().selectedTicketId).toBe(9);
    expect(store.getState().panelNudge?.seq).toBe(1);
    store.getState().showTicket(9);
    expect(store.getState().panelNudge).toEqual({ panel: 'thread', seq: 2 });

    store.getState().closeRail();
    store.getState().showAgenda();
    expect(store.getState()).toMatchObject({ railOpen: true, railView: 'agenda' });
    expect(store.getState().panelNudge?.seq).toBe(2);
    store.getState().showAgenda();
    expect(store.getState().panelNudge).toEqual({ panel: 'agenda', seq: 3 });
  });

  it('flashes the ticket detail when you click a ticket card of the ticket it shows', () => {
    renderDesktop();
    act(() => { fireEvent.click(screen.getByTestId(`open-ticket-${TICKET}`)); });
    expect(screen.getByTestId('ticket-thread')).toBeTruthy();
    // Opening it is the change you see: no flash.
    expect(screen.queryByTestId('ticket-thread-header-flash')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId(`open-ticket-${TICKET}`)); });
    expect(screen.getByTestId('ticket-thread-header-flash')).toBeTruthy();
  });

  it('flashes the topic panel when you click the line of the topic it shows', async () => {
    renderDesktop();
    const link = await screen.findByTestId('topic-link-7');
    act(() => { fireEvent.click(link); });
    expect(await screen.findByTestId('topic-panel')).toBeTruthy();
    expect(screen.queryByTestId('topic-panel-header-flash')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('topic-link-7')); });
    expect(screen.getByTestId('topic-panel-header-flash')).toBeTruthy();
  });

  it('flashes the agenda when it shows already and an entry opens it again', () => {
    const runtime = renderDesktop();
    act(() => { runtime.workspace.getState().showAgenda(); });
    expect(runtime.workspace.getState().railView).toBe('agenda');
    expect(screen.queryByTestId('agenda-flash')).toBeNull();
    act(() => { runtime.workspace.getState().showAgenda(); });
    expect(screen.getByTestId('agenda-flash')).toBeTruthy();
  });
});
