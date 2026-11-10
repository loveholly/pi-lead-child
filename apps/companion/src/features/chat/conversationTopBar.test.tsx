// @vitest-environment happy-dom
// 会话顶栏（方案 C，2026-10-28，主题 11.14、F-7）：左栏开着时顶栏不放 Fairy（Fairy 在左栏头部）；
// 手机上和左栏收起时 Fairy 回到顶栏。顶栏写「执行中 N」；输入框上方原来那一行「执行中 · 需要处理 + 工单标签 + 查看全部」去掉。
import type { ConversationTurn, LeadQueue } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(screen.getByTestId('lead-running-count').getAttribute('aria-label')).toBe('Running 0');
  });

  it('brings Fairy back to the top bar when the rail is closed', () => {
    render({ railOpen: false });
    const identity = screen.getByTestId('lead-identity');
    expect(within(identity).getByRole('img', { name: 'Paimon' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the work list' })).toBeTruthy();
  });

  it('shows Fairy in the phone top bar, thinking while Lead is in a turn', () => {
    render({ compact: true }, { busy: true, entries: [] });
    expect(within(screen.getByTestId('lead-identity')).getByRole('img', { name: 'Paimon is thinking' })).toBeTruthy();
  });

  it('drops the summary row above the composer', () => {
    render({ railOpen: true });
    expect(screen.queryByText(/需要处理|需处理/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看全部|全部 ›/ })).toBeNull();
    // 输入框还在原来那一列里。
    expect(screen.getByTestId('conversation-footer-column').querySelector('[placeholder]')).toBeTruthy();
  });
});

// 「用户本人发话时免沙箱」开着时，输入框上方一行标记（工单 #246 设计 5.3、主题 11.17）：写「开着」，有「关闭」；
// 没有剩余时间（用户 2026-11-10 去掉了时限），过了很久也还在。关掉以后标记消失。标记在输入框那一栏里，会话列表还是同一个，里面的消息不动（P1）。
describe('the sandbox bypass marker above the composer', () => {
  afterEach(() => vi.useRealTimers());

  function renderWithBypass(on: boolean) {
    const off = { enabled: false, enabledAt: null, bindingId: null, reason: null };
    const onState = { enabled: true, enabledAt: new Date().toISOString(), bindingId: 3, reason: '在设置页打开了免沙箱' };
    // 假的 daemon：读回的是现在的开关，关掉以后读回关。
    let current = on ? onState : off;
    const client = {
      getHostBypass: vi.fn(async () => current),
      disableHostBypass: vi.fn(async () => { current = off; return off; }),
    };
    const runtime = createCompanionStateRuntime({
      client: client as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
    runtime.control.setState({
      phase: 'ready', connectionState: 'connected', leadQueue: null,
      hostBypass: current,
    });
    runtime.control.getState().replaceConversation(SESSION, [reply]);
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <LeadConversation railOpen onOpenRail={() => {}} onOpenAll={() => {}} />
      </CompanionRuntimeProvider>,
    );
    return client;
  }

  it('shows nothing while the switch is off', () => {
    renderWithBypass(false);
    expect(screen.queryByTestId('host-bypass-bar')).toBeNull();
  });

  it('says it is on with no time left, stays after hours, and goes away without moving the conversation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const client = renderWithBypass(true);
    expect(screen.getByTestId('host-bypass-bar-text').textContent).toBe('Sandbox bypass · On');
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 60_000); });
    expect(screen.getByTestId('host-bypass-bar-text').textContent).toBe('Sandbox bypass · On');
    vi.useRealTimers();
    const list = screen.getByTestId('lead-conversation-scroll');
    const message = screen.getByText('今天有三件事。');
    await act(async () => { fireEvent.click(screen.getByTestId('host-bypass-bar-close')); });
    expect(client.disableHostBypass).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('host-bypass-bar')).toBeNull();
    expect(screen.getByTestId('lead-conversation-scroll')).toBe(list);
    expect(screen.getByText('今天有三件事。')).toBe(message);
    expect(screen.getByTestId('conversation-footer-column').querySelector('[placeholder]')).toBeTruthy();
  });
});
