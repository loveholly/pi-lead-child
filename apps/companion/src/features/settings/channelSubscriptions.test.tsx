// @vitest-environment happy-dom
// 设置 → 消息通道里 Slack 的固定订阅（2026-11-25）。client 是假的：GET …/subscriptions 给名单，
// 加、删都走 performUiAction('channel_subscriptions', …)，结果就是新的名单。
//   - 列出固定的频道，排除名单里的标「已排除」，下面写出配置里排除了哪些；
//   - 输入框写一个频道点「固定」调 pin，成功以后清空输入框；每一行的「删掉」调 unpin；
//   - 不能固定订阅的来源（GET 回 404）不画这一块。
import type { ChannelSourceSettingsDto, ChannelSubscriptionsDto } from '@pi-lead-child/protocol';
import { DEFAULT_DESIGN_PREFERENCES } from '@pi-lead-child/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { DesignPreferencesBridge } from '../../components/DesignPreferencesBridge';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ChannelSettingsSection } from './ChannelSettingsSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const SOURCE: ChannelSourceSettingsDto = {
  source: 'slack', label: 'Slack', status: 'connected', account: { userId: 'U1', userName: 'Li Lei', teamId: 'T1', teamName: 'Acme' },
  missingScopes: [], lastError: null, lastConnectedAt: null,
  secrets: [
    { name: 'PLC_SLACK_APP_TOKEN', label: 'App-Level Token', prefix: 'xapp-', hint: '', present: true, origin: 'vault' },
    { name: 'PLC_SLACK_USER_TOKEN', label: 'User OAuth Token', prefix: 'xoxp-', hint: '', present: true, origin: 'vault' },
  ],
  manifest: null, setupUrl: null, editable: true,
};

function setup(first: ChannelSubscriptionsDto | null) {
  let current = first;
  const client = {
    getChannelSettings: vi.fn(async () => ({ sources: [SOURCE] })),
    testChannelSecrets: vi.fn(() => new Promise(() => {})),
    saveChannelSecrets: vi.fn(() => new Promise(() => {})),
    clearChannelSecrets: vi.fn(() => new Promise(() => {})),
    getChannelConnection: vi.fn(async () => { throw new Error('not found'); }),
    getChannelSubscriptions: vi.fn(async () => {
      if (!current) throw new Error('not found');
      return current;
    }),
    performUiAction: vi.fn(async (type: string, id: string, action: string, request: { input?: { entry?: string } }) => {
      const entry = request.input?.entry ?? '';
      const pinned = current!.pinned;
      current = { ...current!, pinned: action === 'pin' ? [...pinned, entry] : pinned.filter((item) => item !== entry) };
      return { target: { type, id }, action, result: { ...current, label: 'Slack', entryHint: '' } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready', connectionState: 'connected', channelSettings: { sources: [SOURCE] },
    designPreferences: { ...DEFAULT_DESIGN_PREFERENCES, locale: 'zh' },
    resourceState: { ...state.resourceState, 'channel-settings': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null } },
  }));
  renderWithRuntime(<DesignPreferencesBridge><ChannelSettingsSection /></DesignPreferencesBridge>, runtime);
  return { client };
}

describe('pinned Slack channels in settings', () => {
  it('lists the pinned channels, marks the excluded one, and pins and unpins through the shared operation', async () => {
    const { client } = setup({ source: 'slack', pinned: ['#release-train', '#ops'], excluded: ['#ops'] });
    await waitFor(() => expect(screen.getByTestId('channel-slack-pinned')).toBeTruthy());
    expect(screen.getAllByTestId('channel-slack-pinned-row')).toHaveLength(2);
    expect(screen.getByText('固定订阅的频道')).toBeTruthy();
    expect(screen.getByText('已排除')).toBeTruthy();
    expect(screen.getByTestId('channel-slack-excluded').textContent).toContain('#ops');

    fireEvent.change(screen.getByTestId('channel-slack-pin-input'), { target: { value: ' #design-review ' } });
    fireEvent.click(screen.getByTestId('channel-slack-pin'));
    await waitFor(() => expect(screen.getAllByTestId('channel-slack-pinned-row')).toHaveLength(3));
    expect(client.performUiAction).toHaveBeenCalledWith('channel_subscriptions', 'slack', 'pin', { input: { entry: '#design-review' } });
    expect((screen.getByTestId('channel-slack-pin-input') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByTestId('channel-slack-unpin-#release-train'));
    await waitFor(() => expect(screen.getAllByTestId('channel-slack-pinned-row')).toHaveLength(2));
    expect(client.performUiAction).toHaveBeenLastCalledWith('channel_subscriptions', 'slack', 'unpin', { input: { entry: '#release-train' } });
  });

  it('draws nothing for a source that cannot pin channels', async () => {
    const { client } = setup(null);
    await waitFor(() => expect(client.getChannelSubscriptions).toHaveBeenCalled());
    expect(screen.queryByTestId('channel-slack-pinned')).toBeNull();
  });
});
