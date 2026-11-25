// @vitest-environment happy-dom
// Ticket #535: the user opened a ticket from a topic (the ticket detail took the place on the right), then clicked
// the topic in the work rail to come back. The topic panel showed its title and its input, but no message: loading the
// ticket's conversation (conversation:ticket:<id>) rebuilt the per-session lists of the store with the main session
// only, so the topic's session lost its messages. The topic was already loaded, so coming back did not read it again.
import { LEAD_TOPICS_CAPABILITY, type ConversationTurn, type TopicDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { setViewportWidth, ticket66 } from '../../../test/workbench';
import Workbench from '../workspace/Workbench.web';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({}) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session-1';

const topic: TopicDto = {
  id: 5, title: 'Slack card layout', state: 'open', openedBy: 'lead', originTurnId: null, originQuote: null, originRole: null,
  model: null, conclusion: null, concludedAt: null, turnCount: 2, lastTurnId: 'tturn_2', lastActivityAt: '2026-11-25T02:00:05.000Z',
  createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:00:05.000Z',
};

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: 1, originKind: 'paired:companion:topic', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:00:01.000Z',
    ...overrides,
  };
}

const topicTurns = [
  turn('tturn_1', { originKind: 'system:topic-opening', assistantText: 'Here are three layouts for the card.' }),
  turn('tturn_2', { userText: 'Which one is shortest?', assistantText: 'The second one.', createdAt: '2026-11-25T02:00:04.000Z' }),
];
const ticketTurn = turn('turn_t1', {
  originKind: 'paired:companion:ticket', ticketId: 66, userText: 'How is the review going?', assistantText: 'It passed.',
});

function renderWorkbench() {
  setViewportWidth(1280);
  const getTopic = vi.fn(async () => ({ topic, turns: topicTurns }));
  const getConversationTurns = vi.fn(async () => [ticketTurn]);
  const runtime = createCompanionStateRuntime({
    client: { getTopic, getTopics: async () => [topic], getConversationTurns } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  // The binding can chat and see tickets, and the main conversation's session is known. The real runtime learns these
  // from the pairing, hello and GET /v1/overview; a ticket's conversation goes into the main session.
  const internals = runtime as unknown as { scopes: Set<string>; capabilities: Set<string>; activeSessionId: string };
  internals.scopes = new Set(['chat', 'tickets:view']);
  internals.capabilities = new Set([LEAD_TOPICS_CAPABILITY]);
  internals.activeSessionId = SESSION;
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', capabilities: [LEAD_TOPICS_CAPABILITY], topics: [topic] });
  runtime.control.getState().replaceTickets([ticket66()]);
  runtime.control.getState().mergeConversation(SESSION, [], { kind: 'window', complete: true });
  runtime.workspace.setState({ hydrated: true, topicOpenId: topic.id });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  return { runtime, getTopic, getConversationTurns };
}

describe('coming back to a topic from a ticket detail (#535)', () => {
  it('shows the topic\'s conversation again after the ticket detail took the place on the right', async () => {
    const { runtime, getConversationTurns } = renderWorkbench();
    await waitFor(() => expect(within(screen.getByTestId('topic-panel')).getByText('The second one.')).toBeTruthy());

    // A ticket opens from the topic: the ticket detail takes the place, and it reads the ticket's conversation.
    act(() => {
      runtime.workspace.getState().selectTicket(66);
      runtime.workspace.getState().openThread();
    });
    await waitFor(() => expect(getConversationTurns).toHaveBeenCalledWith(66, expect.anything()));
    await waitFor(() => expect(runtime.control.getState().messageIdsByTicket[66]?.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('topic-panel')).toBeNull();

    // Back to the topic from the work rail.
    act(() => { fireEvent.click(screen.getByTestId('rail-topic-5')); });
    const panel = within(await screen.findByTestId('topic-panel'));
    await waitFor(() => expect(panel.getByText('The second one.')).toBeTruthy());
    expect(panel.getByText('Here are three layouts for the card.')).toBeTruthy();
    expect(panel.getByText('Which one is shortest?')).toBeTruthy();
    expect(panel.queryByText('No conversation yet. Say what you want to discuss.')).toBeNull();
  });
});
