// @vitest-environment happy-dom
// 会话文字里指向对象的链接（设计规范 P14.6–P14.8，2026-11-02）。用户说 Lead 写的「Run #12」「卡 #13」是系统用语，看不懂；
// 要的是人能懂的说法，再加一个能点过去的地方。Lead 写 [Ethan 的私信](plc:card/134)，用户看到一段可以点的文字。
import type { ChannelCardDto, TicketSummary } from '@pi-lead-child/protocol';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { MarkdownMessage } from './MarkdownMessage';
import { ObjectLinkProvider } from './ObjectLinkProvider';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const ticket: TicketSummary = {
  id: 165, title: '升级 Node', summary: '', kind: 'task', hasRun: true, priority: 'normal',
  project: null, dueAt: null, deferUntil: null, updatedAt: '2026-11-02T10:00:00.000Z', parentTicketId: null, rootTicketId: 165,
  runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage: 'review', status: 'review',
};

const card = {
  id: 134, version: 1, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:D0ETHAN:main', laneLabel: 'Ethan 的私信',
  sender: { id: 'U0ETHAN', name: 'Ethan', trust: 'colleague' }, excerpt: '快捷键那个设计你看了吗', messageCount: 1,
  delivery: 'card', state: 'open', draft: { text: ':joy:', drafter: 'template' },
  gate: null, lookup: null, handling: null,
  sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
  actions: ['send_draft', 'reply_myself', 'snooze', 'dismiss'],
  createdAt: '2026-11-02T07:00:00.000Z', updatedAt: '2026-11-02T07:00:05.000Z',
} as unknown as ChannelCardDto;

function renderText(markdown: string, options: { objectLinks?: boolean; tickets?: TicketSummary[]; cards?: ChannelCardDto[] } = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(options.tickets ?? [ticket]);
  runtime.control.getState().replaceChannelCards(options.cards ?? [card]);
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <ObjectLinkProvider renderCard={(cardId) => <div data-testid={`rendered-card-${cardId}`}>那张卡</div>}>
        <MarkdownMessage markdown={markdown} objectLinks={options.objectLinks} />
      </ObjectLinkProvider>
    </CompanionRuntimeProvider>,
  );
  return runtime;
}

describe('a link to an object in the conversation text', () => {
  it('shows the words, not the internal number, and opens the card in a panel', () => {
    renderText('回 [Ethan 的私信](plc:card/134) 的草稿放好了。');
    const link = screen.getByTestId('object-link-card-134');
    expect(link.textContent).toBe('Ethan 的私信');
    expect(screen.getByTestId('markdown-message').textContent).not.toContain('134');
    expect(screen.queryByTestId('rendered-card-134')).toBeNull();
    fireEvent.click(link);
    expect(screen.getByTestId('rendered-card-134')).toBeTruthy();
  });

  it('opens the ticket when the link names a ticket', () => {
    renderText('[#165](plc:ticket/165) 这次执行跑完了。');
    expect(screen.getByTestId('object-link-ticket-165').textContent).toBe('#165');
    expect(screen.getByRole('link', { name: '#165' })).toBeTruthy();
  });

  // P14.8：取不到对象时只显示文字，不给一个点了没反应的链接。
  it('shows plain words when the card is not there', () => {
    renderText('回 [Nina 的私信](plc:card/999) 的草稿放好了。', { cards: [] });
    expect(screen.queryByTestId('object-link-card-999')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('markdown-message').textContent).toBe('回 Nina 的私信 的草稿放好了。');
  });

  // 外来的原文（Slack 消息）里别人写的链接，不带用户去 App 里的东西。
  it('is plain text in an outside message', () => {
    renderText('看 [这个](plc:ticket/165)', { objectLinks: false });
    expect(screen.queryByTestId('object-link-ticket-165')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('markdown-message').textContent).toBe('看 这个');
  });
});
