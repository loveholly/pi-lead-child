// @vitest-environment jsdom
// 设置 → 账号 → 消息通道（2026-10-20）。每个来源一张卡：状态、缺的权限、每个密钥来自哪里（不显示值）、
// 不回显的输入框、「测试」「保存」（没过时逐项显示检查）、只对设置页存的密钥给「断开」、可展开可复制的应用清单。
// 不是这台 Mac 的网页（editable=false）只显示状态。契约在 packages/protocol/src/channel-settings.ts；后端是 S1，这里用假的 client。
import { ChannelSecretsRejectedError, ControlPlaneClientError } from '@pi-lead-child/client';
import type { ChannelSecretsTestResult, ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ChannelSettingsSection } from './ChannelSettingsSection';
import {
  canDisconnect, channelErrorText, channelStatusView, externalSecretNotes, secretRequest, secretStateText, testSummary,
} from './channelSettingsModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const MANIFEST = 'display_information:\n  name: 助手\nsettings:\n  socket_mode_enabled: true';
const ACCOUNT = { userId: 'U1', userName: 'bin', teamId: 'T1', teamName: 'Acme' };

function slack(overrides: Partial<ChannelSourceSettingsDto> = {}): ChannelSourceSettingsDto {
  return {
    source: 'slack',
    label: 'Slack',
    status: 'not_configured',
    account: null,
    missingScopes: [],
    lastError: null,
    lastConnectedAt: null,
    secrets: [
      { name: 'PLC_SLACK_APP_TOKEN', label: 'App-Level Token', prefix: 'xapp-', hint: '在 Basic Information → App-Level Tokens 里生成', present: false, origin: null },
      { name: 'PLC_SLACK_USER_TOKEN', label: 'User OAuth Token', prefix: 'xoxp-', hint: '在 OAuth & Permissions 里安装应用后拿到', present: false, origin: null },
    ],
    manifest: MANIFEST,
    setupUrl: 'https://api.slack.com/apps',
    editable: true,
    ...overrides,
  };
}

function saved(origins: ['vault' | 'keychain' | 'env', 'vault' | 'keychain' | 'env'], overrides: Partial<ChannelSourceSettingsDto> = {}) {
  const base = slack();
  return slack({
    status: 'connected',
    account: ACCOUNT,
    secrets: base.secrets.map((secret, index) => ({ ...secret, present: true, origin: origins[index]! })),
    ...overrides,
  });
}

const FAILED: ChannelSecretsTestResult = {
  ok: false,
  checks: [
    { id: 'app_token_kind', label: 'App-Level Token 的格式', pass: true, detail: '以 xapp- 开头。' },
    { id: 'user_token_kind', label: '用户令牌', pass: false, detail: '这是 bot token，要的是你本人的 user token。' },
  ],
  account: null,
  missingScopes: ['chat:write', 'im:history'],
};

type FakeClient = {
  getChannelSettings: ReturnType<typeof vi.fn>;
  testChannelSecrets: ReturnType<typeof vi.fn>;
  saveChannelSecrets: ReturnType<typeof vi.fn>;
  clearChannelSecrets: ReturnType<typeof vi.fn>;
};

function channelsRuntime(sources: ChannelSourceSettingsDto[], client: Partial<FakeClient> = {}) {
  const fake: FakeClient = {
    getChannelSettings: vi.fn(async () => ({ sources })),
    testChannelSecrets: vi.fn(() => new Promise(() => {})),
    saveChannelSecrets: vi.fn(() => new Promise(() => {})),
    clearChannelSecrets: vi.fn(() => new Promise(() => {})),
    ...client,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    channelSettings: { sources },
    resourceState: {
      ...state.resourceState,
      'channel-settings': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

function render(sources: ChannelSourceSettingsDto[], client: Partial<FakeClient> = {}) {
  const value = channelsRuntime(sources, client);
  renderWithRuntime(<ChannelSettingsSection />, value.runtime);
  return value;
}

const input = (name: string) => screen.getByTestId(`channel-slack-input-${name}`) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(input(name), { target: { value } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the channel settings view model', () => {
  it('names the four states and says who is connected, or why it failed', () => {
    expect(channelStatusView(slack())).toEqual({ label: '没有配置', tone: 'muted', detail: '还没有密钥。' });
    expect(channelStatusView(slack({ status: 'connecting' }))).toMatchObject({ label: '连接中', tone: 'accent' });
    expect(channelStatusView(saved(['vault', 'vault']))).toEqual({ label: '已连接', tone: 'success', detail: '用 bin 的账号，工作区 Acme。' });
    expect(channelStatusView(saved(['vault', 'vault'], { account: { ...ACCOUNT, userName: '', teamName: '' } })).detail).toBe('用 U1 的账号，工作区 T1。');
    expect(channelStatusView(slack({ status: 'error', lastError: 'invalid_auth' }))).toEqual({ label: '出错', tone: 'danger', detail: 'invalid_auth' });
    expect(channelStatusView(slack({ status: 'error' })).detail).toBe('连不上，daemon 没有给出原因。');
  });

  it('says where a saved secret comes from and never shows a value', () => {
    const [app] = slack().secrets;
    expect(secretStateText(app!)).toBe('没有保存');
    expect(secretStateText({ ...app!, present: true, origin: 'vault' })).toBe('已保存 · 来自设置页');
    expect(secretStateText({ ...app!, present: true, origin: 'keychain' })).toBe('已保存 · 来自 Keychain');
    expect(secretStateText({ ...app!, present: true, origin: 'env' })).toBe('已保存 · 来自环境变量');
  });

  it('offers disconnect only for secrets saved on the settings page of this Mac', () => {
    expect(canDisconnect(slack())).toBe(false);
    expect(canDisconnect(saved(['vault', 'keychain']))).toBe(true);
    expect(canDisconnect(saved(['keychain', 'env']))).toBe(false);
    expect(canDisconnect(saved(['vault', 'vault'], { editable: false }))).toBe(false);
  });

  it('explains how to delete Keychain and environment secrets in a terminal', () => {
    const notes = externalSecretNotes(saved(['keychain', 'env']));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ name: 'PLC_SLACK_APP_TOKEN', command: 'security delete-generic-password -a "$USER" -s "dev-secret:PLC_SLACK_APP_TOKEN"' });
    expect(notes[0]!.text).toContain('Keychain');
    expect(notes[1]).toMatchObject({ name: 'PLC_SLACK_USER_TOKEN', command: null });
    expect(notes[1]!.text).toContain('环境变量 PLC_SLACK_USER_TOKEN');
    expect(externalSecretNotes(saved(['vault', 'vault']))).toEqual([]);
  });

  it('sends only the secrets you filled, and asks for the ones that were never saved', () => {
    const empty = { PLC_SLACK_APP_TOKEN: '', PLC_SLACK_USER_TOKEN: '' };
    expect(secretRequest(slack(), { ...empty, PLC_SLACK_APP_TOKEN: 'xapp-1' })).toEqual({ problem: '还要填：User OAuth Token。' });
    expect(secretRequest(slack(), { PLC_SLACK_APP_TOKEN: ' xapp-1 ', PLC_SLACK_USER_TOKEN: 'xoxp-2\n' }))
      .toEqual({ secrets: { PLC_SLACK_APP_TOKEN: 'xapp-1', PLC_SLACK_USER_TOKEN: 'xoxp-2' } });
    expect(secretRequest(saved(['vault', 'keychain']), empty)).toEqual({ problem: '先粘贴要更换的密钥。' });
    expect(secretRequest(saved(['vault', 'keychain']), { ...empty, PLC_SLACK_USER_TOKEN: 'xoxp-new' }))
      .toEqual({ secrets: { PLC_SLACK_USER_TOKEN: 'xoxp-new' } });
  });

  it('writes the test summary and the errors in Chinese', () => {
    expect(testSummary(FAILED)).toBe('有检查没通过，见下面。密钥没有保存。');
    expect(testSummary({ ok: true, checks: [], account: ACCOUNT, missingScopes: [] })).toBe('检查都通过了。用 bin 的账号，工作区 Acme。还没有保存。');
    expect(channelErrorText(new ControlPlaneClientError('only the local web UI', 'forbidden', 403), 'Paimon')).toContain('密钥只能在这台 Mac 的网页上填。在运行 Paimon 的那台 Mac');
    expect(channelErrorText(new Error('this client cannot manage channel settings'), 'Paimon')).toBe('这个版本的客户端不能设置消息通道。');
  });
});

describe('the channel settings section', () => {
  it('shows each of the four states on the card', () => {
    const { runtime } = channelsRuntime([slack()]);
    const view = renderWithRuntime(<ChannelSettingsSection />, runtime);
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('没有配置');
    expect(screen.getByTestId('channel-slack-detail').textContent).toBe('还没有密钥。');

    for (const [source, label, detail] of [
      [slack({ status: 'connecting' }), '连接中', '正在连接…'],
      [saved(['vault', 'vault']), '已连接', '用 bin 的账号，工作区 Acme。'],
      [slack({ status: 'error', lastError: 'Slack 拒绝了这个令牌（invalid_auth）。' }), '出错', 'Slack 拒绝了这个令牌（invalid_auth）。'],
    ] as const) {
      act(() => { runtime.control.setState({ channelSettings: { sources: [source] } }); });
      expect(screen.getByTestId('channel-slack-status').textContent).toBe(label);
      expect(screen.getByTestId('channel-slack-detail').textContent).toBe(detail);
    }
    view.unmount();
  });

  it('lists the missing scopes', () => {
    render([saved(['vault', 'vault'], { missingScopes: ['chat:write', 'users:read'] })]);
    const block = screen.getByTestId('channel-slack-missing-scopes');
    expect(block.textContent).toContain('chat:write');
    expect(block.textContent).toContain('users:read');
  });

  it('shows each secret with its hint and where it comes from, in empty fields that never echo', () => {
    render([saved(['vault', 'keychain'])]);
    const app = screen.getByTestId('channel-slack-secret-PLC_SLACK_APP_TOKEN');
    expect(app.textContent).toContain('App-Level Token');
    expect(app.textContent).toContain('在 Basic Information → App-Level Tokens 里生成');
    expect(app.textContent).toContain('已保存 · 来自设置页');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_USER_TOKEN').textContent).toContain('已保存 · 来自 Keychain');
    for (const name of ['PLC_SLACK_APP_TOKEN', 'PLC_SLACK_USER_TOKEN']) {
      expect(input(name).value).toBe('');
      expect(input(name).type).toBe('password');
      expect(input(name).getAttribute('autocomplete')).toBe('new-password');
    }
    // Keychain 里的密钥：页面删不掉，告诉你在终端里怎么删。
    expect(screen.getByTestId('channel-slack-external').textContent).toContain('security delete-generic-password -a "$USER" -s "dev-secret:PLC_SLACK_USER_TOKEN"');
  });

  it('shows only the state on a page that is not on this Mac', () => {
    render([saved(['vault', 'env'], { editable: false })]);
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('已连接');
    expect(screen.getByTestId('channel-slack-read-only').textContent).toBe('密钥只能在这台 Mac 的网页上填。在运行 Paimon 的那台 Mac 上打开网页，再进设置 → 消息通道。');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_USER_TOKEN').textContent).toContain('已保存 · 来自环境变量');
    for (const missing of [
      'channel-slack-input-PLC_SLACK_APP_TOKEN', 'channel-slack-test', 'channel-slack-save', 'channel-slack-disconnect-start', 'channel-slack-app',
    ]) {
      expect.soft(screen.queryByTestId(missing), missing).toBeNull();
    }
  });

  it('tests the pasted secrets without saving and shows every check', async () => {
    const { client } = render([slack()], { testChannelSecrets: vi.fn(async () => FAILED) });
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    type('PLC_SLACK_USER_TOKEN', 'xoxb-test-bot');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-test')); });
    expect(client.testChannelSecrets).toHaveBeenCalledWith('slack', { PLC_SLACK_APP_TOKEN: 'xapp-test-app', PLC_SLACK_USER_TOKEN: 'xoxb-test-bot' });
    expect(client.saveChannelSecrets).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-slack-check-app_token_kind').textContent).toBe('✓App-Level Token 的格式以 xapp- 开头。');
    expect(screen.getByTestId('channel-slack-check-user_token_kind').textContent).toBe('✗用户令牌这是 bot token，要的是你本人的 user token。');
    expect(screen.getByTestId('channel-slack-check-missing-scopes').textContent).toBe('缺的权限：chat:write、im:history');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('有检查没通过，见下面。密钥没有保存。');
    // 测试不清空输入框。
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('xoxb-test-bot');
  });

  it('asks for a secret that was never saved before it sends anything', async () => {
    const { client } = render([slack()]);
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(client.saveChannelSecrets).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('还要填：User OAuth Token。');
  });

  it('shows the failed checks when the daemon refuses to save, and keeps the input', async () => {
    const saveChannelSecrets = vi.fn(async () => { throw new ChannelSecretsRejectedError('checks failed', FAILED, null); });
    render([slack()], { saveChannelSecrets });
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    type('PLC_SLACK_USER_TOKEN', 'xoxb-test-bot');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(saveChannelSecrets).toHaveBeenCalledWith('slack', { PLC_SLACK_APP_TOKEN: 'xapp-test-app', PLC_SLACK_USER_TOKEN: 'xoxb-test-bot' });
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('没有保存：有检查没通过，见下面。');
    expect(screen.getByTestId('channel-slack-check-user_token_kind').textContent).toContain('✗');
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('xoxb-test-bot');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('没有配置');
  });

  it('clears the fields after a successful save and shows the new state', async () => {
    const saveChannelSecrets = vi.fn(async () => saved(['vault', 'vault'], { status: 'connecting', account: null }));
    render([slack()], { saveChannelSecrets });
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    type('PLC_SLACK_USER_TOKEN', 'xoxp-test-user');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(input('PLC_SLACK_APP_TOKEN').value).toBe('');
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('已保存，正在用新的密钥连接。');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('连接中');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_APP_TOKEN').textContent).toContain('已保存 · 来自设置页');
    // 页面上任何地方都没有刚才填的值。
    expect(document.body.textContent).not.toContain('xapp-test-app');
    expect(document.body.textContent).not.toContain('xoxp-test-user');
  });

  it('offers disconnect only for secrets from the settings page, behind a confirmation', async () => {
    const clearChannelSecrets = vi.fn(async () => slack());
    const { runtime } = render([saved(['vault', 'vault'])], { clearChannelSecrets });
    fireEvent.click(screen.getByTestId('channel-slack-disconnect-start'));
    expect(clearChannelSecrets).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-slack-disconnect-confirm').textContent).toContain('删掉设置页存的密钥并断开');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-disconnect')); });
    expect(clearChannelSecrets).toHaveBeenCalledWith('slack');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('已断开，设置页存的密钥已删除。');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('没有配置');
    expect(screen.queryByTestId('channel-slack-disconnect-start')).toBeNull();

    // 密钥都来自 Keychain 或环境变量：没有「断开」，只有终端里的说明。
    act(() => { runtime.control.setState({ channelSettings: { sources: [saved(['keychain', 'env'])] } }); });
    expect(screen.queryByTestId('channel-slack-disconnect-start')).toBeNull();
    expect(screen.getByTestId('channel-slack-external').textContent).toContain('dev-secret:PLC_SLACK_APP_TOKEN');
  });

  it('expands the app manifest, copies it, and links to the page that creates the app', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render([slack()]);
    expect(screen.getByTestId('channel-slack-setup-url').textContent).toBe('https://api.slack.com/apps');
    expect(screen.queryByTestId('channel-slack-manifest')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-slack-manifest-toggle'));
    expect(screen.getByTestId('channel-slack-manifest').textContent).toContain('socket_mode_enabled: true');

    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-manifest-copy')); });
    expect(writeText).toHaveBeenCalledWith(MANIFEST);
    expect(screen.getByTestId('channel-slack-manifest-copy').textContent).toContain('已复制');

    fireEvent.click(screen.getByTestId('channel-slack-manifest-toggle'));
    expect(screen.queryByTestId('channel-slack-manifest')).toBeNull();
  });

  it('says what went wrong when the settings cannot be read', async () => {
    const { runtime } = channelsRuntime([], {
      getChannelSettings: vi.fn(async () => { throw new ControlPlaneClientError('消息通道的设置还没有启动', 'internal_error', 503); }),
    });
    runtime.control.setState((state) => ({
      channelSettings: null,
      resourceState: { ...state.resourceState, 'channel-settings': { state: 'idle', generation: 0, observerCount: 0, lastSuccessAt: null, error: null } },
    }));
    renderWithRuntime(<ChannelSettingsSection />, runtime);
    await waitFor(() => expect(screen.getByTestId('channels-error').textContent).toContain('消息通道的设置还没有启动'));
  });
});
