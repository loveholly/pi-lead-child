// @vitest-environment jsdom
// 工单 #66 的 Run #71（2026-10-13）：工单对话这一轮失败了，agent 一个字也没说。
// 卡片上是一个空的 agent 气泡，下面一条红色错误。normalize 给每一轮都建一个文本部分，
// 回答为空时它也在，所以旧的判断把它当成内容。只显示错误就够了。
// 错误用主会话那张白话的失败卡：一句白话、「重发」，英文原文收在「技术详情」里（工单详情复核 P1-7）。
import { fireEvent, screen, within } from '@testing-library/react';
import type { ConversationTurn } from '@pi-lead-child/protocol';
import type { CredentialStore } from '@pi-lead-child/client';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionTransport } from '../../state/runtime';
import { TicketConversation } from './TicketConversation';

vi.mock('../../components/StatusBadge', () => ({ StatusBadge: () => null }));
// 提供 runtime 的模块会引入 expo-crypto。它在 node 里加载不了，这个测试也用不到它。
vi.mock('expo-crypto', () => ({}));
// 消息里的工单卡片用 useOpenTicket 打开工单，它引入 expo-router。expo-router 在 node 里也加载不了。
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const TICKET = 66;

function renderTicketConversation(turns: ConversationTurn[], onResend?: (text: string) => void) {
  const credentials: CredentialStore = {
    async load() { return null; },
    async save() {},
    async clear() {},
  };
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionTransport,
    credentials,
    scheduler: {
      schedule(callback) { return setTimeout(callback, 0); },
      cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => 1,
    },
  });
  runtime.control.getState().replaceConversation('lead-session-1', turns, { ticketId: TICKET });
  const messageIds = runtime.control.getState().messageIdsByTicket[TICKET] ?? [];
  return renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <TicketConversation ticketId={TICKET} messageIds={messageIds} onResend={onResend} now={new Date('2026-10-14T12:00:00.000Z')} />
    </CompanionRuntimeProvider>,
  );
}

function turn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: 'turn_71',
    originBindingId: 7,
    originKind: 'paired:companion:ticket-agent',
    ticketId: TICKET,
    state: 'completed',
    userText: '现在还需要我做什么',
    assistantText: '',
    error: null,
    createdAt: '2026-10-13T11:02:00.000Z',
    updatedAt: '2026-10-13T11:02:01.000Z',
    ...overrides,
  };
}

describe('ticket conversation messages', () => {
  it('shows only the error when the agent turn failed without saying anything', () => {
    const error = 'Run #71 crashed (claude_error_during_execution): No conversation found with session ID: 20fd5938';
    const onResend = vi.fn();
    renderTicketConversation([turn({ state: 'failed', error })], onResend);

    // 只有用户自己的那个气泡。agent 那一条没有气泡，只有错误。
    const bubbles = screen.queryAllByTestId('ticket-message-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toBe('现在还需要我做什么');
    const card = screen.getByTestId('failure-card');
    expect(card.textContent).toContain('没能回答这条消息，工单本身没有变化');
    expect(card.textContent).not.toContain(error);
    expect(within(card).queryByRole('button', { name: '技术详情' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /展开详情$/ }));
    expect(card.textContent).toContain(error);
    fireEvent.click(within(card).getByRole('button', { name: '重发' }));
    expect(onResend).toHaveBeenCalledWith('现在还需要我做什么');
  });

  it('separates days with a divider', () => {
    renderTicketConversation([
      turn({ id: 'turn_51', userText: '你跑吧', assistantText: '好的。', createdAt: '2026-08-21T10:51:53.000Z', updatedAt: '2026-08-21T10:57:31.000Z' }),
      turn({ id: 'turn_72', userText: '现在需要我做什么', assistantText: '派一次核查。', createdAt: '2026-10-14T09:57:07.000Z', updatedAt: '2026-10-14T09:58:43.000Z' }),
    ]);
    expect(screen.getAllByTestId('conversation-date-divider').map((divider) => divider.textContent))
      .toEqual([expect.stringMatching(/^8月21日/), '今天']);
  });

  it('keeps the bubble of an answer', () => {
    renderTicketConversation([turn({ assistantText: '需要你验收三个技能。' })]);

    const bubbles = screen.queryAllByTestId('ticket-message-bubble');
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual(['现在还需要我做什么', '需要你验收三个技能。']);
  });

  // 复核 P2-5：#66 在 8 月 21 日 18:52 的回复约 2,900 字，在窄栏里要翻好几屏。
  it('folds a long earlier reply and keeps the latest reply whole', () => {
    const long = `用户授权到位，我把门跑完。${'先说明一点：activate_ticket_run 在这个会话里没有暴露给我。'.repeat(30)}`;
    renderTicketConversation([
      turn({ id: 'turn_51', userText: '你跑吧', assistantText: long, createdAt: '2026-08-21T10:51:53.000Z', updatedAt: '2026-08-21T10:57:31.000Z' }),
      turn({ id: 'turn_72', userText: '现在需要我做什么', assistantText: long, createdAt: '2026-10-14T09:57:07.000Z', updatedAt: '2026-10-14T09:58:43.000Z' }),
    ]);

    const toggles = screen.getAllByTestId('ticket-reply-toggle');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.textContent).toBe(`展开全文 · 约 ${(Math.round(long.length / 100) * 100).toLocaleString('en-US')} 字`);

    fireEvent.click(toggles[0]!);

    expect(screen.getByTestId('ticket-reply-toggle').textContent).toBe('收起');
  });
});
