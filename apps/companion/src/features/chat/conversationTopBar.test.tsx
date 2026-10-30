// @vitest-environment jsdom
// 会话顶栏（方案 C，2026-10-28，主题 11.14、F-7）：左栏开着时顶栏不放 Fairy（Fairy 在左栏头部）；
// 手机上和左栏收起时 Fairy 回到顶栏。顶栏写「执行中 N」；输入框上方原来那一行「执行中 · 需要处理 + 工单标签 + 查看全部」去掉。
import type { ConversationTurn, LeadQueue } from '@pi-lead-child/protocol';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const reply: ConversationTurn = {
  id: 'turn-1', originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
  userText: '今天有什么事', assistantText: '今天有三件事。', error: null,
  createdAt: '2026-10-28T08:00:00.000Z', updatedAt: '2026-10-28T08:01:00.000Z',
};

function render(props: { railOpen?: boolean; compact?: boolean } = {}, leadQueue: LeadQueue | null = null) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', leadQueue });
  runtime.control.getState().replaceConversation(SESSION, [reply]);
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <LeadConversation {...props} onOpenRail={() => {}} onOpenAll={() => {}} />
    </CompanionRuntimeProvider>,
  );
}

describe('the conversation top bar', () => {
  it('leaves Fairy to the rail while the rail is open, and shows the running count', () => {
    render({ railOpen: true });
    expect(screen.queryByTestId('lead-identity')).toBeNull();
    expect(screen.getByTestId('lead-running-count').getAttribute('aria-label')).toBe('执行中 0');
  });

  it('brings Fairy back to the top bar when the rail is closed', () => {
    render({ railOpen: false });
    const identity = screen.getByTestId('lead-identity');
    expect(within(identity).getByRole('img', { name: 'Paimon' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开工作列表' })).toBeTruthy();
  });

  it('shows Fairy in the phone top bar, thinking while Lead is in a turn', () => {
    render({ compact: true }, { busy: true, entries: [] });
    expect(within(screen.getByTestId('lead-identity')).getByRole('img', { name: 'Paimon 在想' })).toBeTruthy();
  });

  it('drops the summary row above the composer', () => {
    render({ railOpen: true });
    expect(screen.queryByText(/需要处理|需处理/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看全部|全部 ›/ })).toBeNull();
    // 输入框还在原来那一列里。
    expect(screen.getByTestId('conversation-footer-column').querySelector('[placeholder]')).toBeTruthy();
  });
});
