// @vitest-environment happy-dom
// Ticket #590: the main conversation shows "Brought back · <topic> · <conclusion>" with an arrow when a topic brings
// its conclusion back. Clicking it did nothing: the row only opened the topic, and right after a conclusion that
// topic's panel is usually open already. The whole conclusion was shown nowhere: the row cuts it to one line.
// Now the click expands the row in place with the whole conclusion and a button that opens the topic.
import { LEAD_TOPICS_CAPABILITY, type TopicDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { setViewportWidth } from '../../../test/workbench';
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
const CONCLUSION = 'Decided: keep the 8 px row gap.\nNext: drop the extra divider in the card footer and check the phone width.';

function concludedTopic(state: TopicDto['state']): TopicDto {
  return {
    id: 7, title: 'Card spacing', state, openedBy: 'user', originTurnId: null, originQuote: null, originRole: null,
    model: null, conclusion: CONCLUSION, concludedAt: '2026-11-25T02:10:00.000Z', turnCount: 2,
    lastTurnId: 'tturn_2', lastActivityAt: '2026-11-25T02:10:00.000Z',
    createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:10:00.000Z',
  };
}

function renderWorkbench(topic: TopicDto, topicOpenId: number | null = null) {
  setViewportWidth(1280);
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
  runtime.control.getState().mergeConversation(SESSION, [], { kind: 'window', complete: true });
  runtime.workspace.setState({ hydrated: true, topicOpenId });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  return runtime;
}

async function expand() {
  const row = await screen.findByTestId('topic-concluded-7');
  act(() => { fireEvent.click(row); });
  return within(await screen.findByTestId('topic-concluded-7-anchor-panel'));
}

describe('the "Brought back" row of a topic (#590)', () => {
  it('expands in place with the whole conclusion, also when the topic\'s panel is open already', async () => {
    // The case of the report: the topic's panel is open on the right when the conclusion comes back.
    renderWorkbench(concludedTopic('closed'), 7);
    expect(await screen.findByTestId('topic-panel')).toBeTruthy();
    const panel = await expand();
    expect(screen.getByTestId('topic-concluded-7').getAttribute('aria-label')).toBe('Show the conclusion of the topic Card spacing');
    // The whole conclusion, with its line breaks: the row shows one cut line only.
    expect(panel.getByTestId('topic-concluded-7-text').textContent).toBe(CONCLUSION);
    // The head of the panel is the row: a click on it folds the panel again.
    act(() => { fireEvent.click(panel.getByTestId('topic-concluded-7-collapse')); });
    await waitFor(() => expect(screen.queryByTestId('topic-concluded-7-anchor-panel')).toBeNull());
  });

  it.each(['open', 'closed'] as const)('opens the topic from the expanded row (topic %s)', async (state) => {
    const runtime = renderWorkbench(concludedTopic(state));
    expect(screen.queryByTestId('topic-panel')).toBeNull();
    const panel = await expand();
    act(() => { fireEvent.click(panel.getByTestId('topic-concluded-7-open')); });
    await waitFor(() => expect(runtime.workspace.getState().topicOpenId).toBe(7));
    expect(await screen.findByTestId('topic-panel')).toBeTruthy();
    // Opening the topic folds the conclusion.
    await waitFor(() => expect(screen.queryByTestId('topic-concluded-7-anchor-panel')).toBeNull());
    // A closed topic opens read-only: its input gives way to "Continue the topic".
    if (state === 'closed') expect(screen.getByTestId('topic-reopen')).toBeTruthy();
  });
});
