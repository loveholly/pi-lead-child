// @vitest-environment happy-dom
// 设置 → 账号 → 消息通道（2026-10-20）。每个来源一张卡：状态、缺的权限、每个密钥来自哪里（不显示值）、
// 不回显的输入框、「测试」「保存」（没过时逐项显示检查）、只对设置页存的密钥给「断开」、可展开可复制的应用清单。
// 不是这台 Mac 的网页（editable=false）只显示状态。契约在 packages/protocol/src/channel-settings.ts；后端是 S1，这里用假的 client。
import { ChannelSecretsRejectedError, ControlPlaneClientError } from '@pi-lead-child/client';
import { CHANNEL_SECRET_MAX_LENGTH, type ChannelSecretsTestResult, type ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
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
    expect(channelStatusView(slack(), 'en')).toEqual({ label: 'Not set up', tone: 'muted', detail: 'No secrets yet.' });
    expect(channelStatusView(slack({ status: 'connecting' }), 'en')).toMatchObject({ label: 'Connecting', tone: 'accent' });
    expect(channelStatusView(saved(['vault', 'vault']), 'en')).toEqual({ label: 'Connected', tone: 'success', detail: 'Uses the account of bin, workspace Acme.' });
    expect(channelStatusView(saved(['vault', 'vault'], { account: { ...ACCOUNT, userName: '', teamName: '' } }), 'en').detail).toBe('Uses the account of U1, workspace T1.');
    expect(channelStatusView(slack({ status: 'error', lastError: 'invalid_auth' }), 'en')).toEqual({ label: 'Error', tone: 'danger', detail: 'invalid_auth' });
    expect(channelStatusView(slack({ status: 'error' }), 'en').detail).toBe('Cannot connect. The daemon gave no reason.');
    expect(channelStatusView(saved(['vault', 'vault']), 'zh')).toEqual({ label: '已连接', tone: 'success', detail: '用 bin 的账号，工作区 Acme。' });
  });

  it('says where a saved secret comes from and never shows a value', () => {
    const [app] = slack().secrets;
    expect(secretStateText(app!, 'en')).toBe('Not saved');
    expect(secretStateText({ ...app!, present: true, origin: 'vault' }, 'en')).toBe('Saved · from the settings page');
    expect(secretStateText({ ...app!, present: true, origin: 'keychain' }, 'en')).toBe('Saved · from Keychain');
    expect(secretStateText({ ...app!, present: true, origin: 'env' }, 'en')).toBe('Saved · from an environment variable');
    expect(secretStateText({ ...app!, present: true, origin: 'env' }, 'zh')).toBe('已保存 · 来自环境变量');
  });

  it('offers disconnect only for secrets saved on the settings page of this Mac', () => {
    expect(canDisconnect(slack())).toBe(false);
    expect(canDisconnect(saved(['vault', 'keychain']))).toBe(true);
    expect(canDisconnect(saved(['keychain', 'env']))).toBe(false);
    expect(canDisconnect(saved(['vault', 'vault'], { editable: false }))).toBe(false);
  });

  it('explains how to delete Keychain and environment secrets in a terminal', () => {
    const notes = externalSecretNotes(saved(['keychain', 'env']), 'en');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ name: 'PLC_SLACK_APP_TOKEN', command: 'security delete-generic-password -a "$USER" -s "dev-secret:PLC_SLACK_APP_TOKEN"' });
    expect(notes[0]!.text).toContain('Keychain');
    expect(notes[1]).toMatchObject({ name: 'PLC_SLACK_USER_TOKEN', command: null });
    expect(notes[1]!.text).toContain('environment variable PLC_SLACK_USER_TOKEN');
    expect(externalSecretNotes(saved(['vault', 'vault']), 'en')).toEqual([]);
  });

  it('sends only the secrets you filled, and asks for the ones that were never saved', () => {
    const empty = { PLC_SLACK_APP_TOKEN: '', PLC_SLACK_USER_TOKEN: '' };
    expect(secretRequest(slack(), { ...empty, PLC_SLACK_APP_TOKEN: 'xapp-1' }, 'en')).toEqual({ problem: 'Also fill in: User OAuth Token.' });
    expect(secretRequest(slack(), { PLC_SLACK_APP_TOKEN: ' xapp-1 ', PLC_SLACK_USER_TOKEN: 'xoxp-2\n' }, 'en'))
      .toEqual({ secrets: { PLC_SLACK_APP_TOKEN: 'xapp-1', PLC_SLACK_USER_TOKEN: 'xoxp-2' } });
    expect(secretRequest(saved(['vault', 'keychain']), empty, 'en')).toEqual({ problem: 'First paste the secret that you want to replace.' });
    expect(secretRequest(saved(['vault', 'keychain']), { ...empty, PLC_SLACK_USER_TOKEN: 'xoxp-new' }, 'en'))
      .toEqual({ secrets: { PLC_SLACK_USER_TOKEN: 'xoxp-new' } });
  });

  // 回归（#220）：上限和客户端、网关是同一个数（协议的 CHANNEL_SECRET_MAX_LENGTH），浏览器会话的 cookie 超过 1000 个字符也能发。
  it('sends a secret longer than 1000 characters, and stops one over the protocol limit', () => {
    const session = slack({ secrets: [{ name: 'PLC_SLACK_SESSION_COOKIE', label: 'Session', prefix: 'xoxd-', hint: '', present: false, origin: null }] });
    const cookie = `xoxd-${'a'.repeat(4_000)}`;
    expect(secretRequest(session, { PLC_SLACK_SESSION_COOKIE: cookie }, 'en')).toEqual({ secrets: { PLC_SLACK_SESSION_COOKIE: cookie } });
    const longest = 'a'.repeat(CHANNEL_SECRET_MAX_LENGTH);
    expect(secretRequest(session, { PLC_SLACK_SESSION_COOKIE: longest }, 'en')).toEqual({ secrets: { PLC_SLACK_SESSION_COOKIE: longest } });
    expect(secretRequest(session, { PLC_SLACK_SESSION_COOKIE: `${longest}a` }, 'en'))
      .toEqual({ problem: `A secret is too long. Each secret can have at most ${CHANNEL_SECRET_MAX_LENGTH} characters.` });
    expect(secretRequest(session, { PLC_SLACK_SESSION_COOKIE: `${longest}a` }, 'zh'))
      .toEqual({ problem: `密钥太长：每个最多 ${CHANNEL_SECRET_MAX_LENGTH} 个字符。` });
    expect(channelErrorText(new Error('channel secrets are invalid'), 'Paimon', 'en'))
      .toBe(`The secret format is not correct. Each secret can have at most ${CHANNEL_SECRET_MAX_LENGTH} characters.`);
  });

  it('writes the test summary and the errors in the interface language', () => {
    expect(testSummary(FAILED, 'en')).toBe('Some checks did not pass. See below. The secrets are not saved.');
    expect(testSummary({ ok: true, checks: [], account: ACCOUNT, missingScopes: [] }, 'en'))
      .toBe('All checks passed. Uses the account of bin, workspace Acme. The secrets are not saved yet.');
    expect(channelErrorText(new ControlPlaneClientError('only the local web UI', 'forbidden', 403), 'Paimon', 'en'))
      .toContain('You can enter the secrets only on the web page of this Mac. Open the web page on the Mac that runs Paimon');
    expect(channelErrorText(new Error('this client cannot manage channel settings'), 'Paimon', 'en')).toBe('This version of the client cannot set up message channels.');
    expect(testSummary({ ok: true, checks: [], account: ACCOUNT, missingScopes: [] }, 'zh')).toBe('检查都通过了。用 bin 的账号，工作区 Acme。还没有保存。');
    expect(channelErrorText(new Error('this client cannot manage channel settings'), 'Paimon', 'zh')).toBe('这个版本的客户端不能设置消息通道。');
  });
});

describe('the channel settings section', () => {
  it('shows each of the four states on the card', () => {
    const { runtime } = channelsRuntime([slack()]);
    const view = renderWithRuntime(<ChannelSettingsSection />, runtime);
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('Not set up');
    expect(screen.getByTestId('channel-slack-detail').textContent).toBe('No secrets yet.');

    for (const [source, label, detail] of [
      [slack({ status: 'connecting' }), 'Connecting', 'Connecting…'],
      [saved(['vault', 'vault']), 'Connected', 'Uses the account of bin, workspace Acme.'],
      [slack({ status: 'error', lastError: 'Slack 拒绝了这个令牌（invalid_auth）。' }), 'Error', 'Slack 拒绝了这个令牌（invalid_auth）。'],
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
    expect(app.textContent).toContain('Saved · from the settings page');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_USER_TOKEN').textContent).toContain('Saved · from Keychain');
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
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('Connected');
    expect(screen.getByTestId('channel-slack-read-only').textContent)
      .toBe('You can enter the secrets only on the web page of this Mac. Open the web page on the Mac that runs Paimon, then go to Settings → Message channels.');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_USER_TOKEN').textContent).toContain('Saved · from an environment variable');
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
    expect(screen.getByTestId('channel-slack-check-missing-scopes').textContent).toBe('Missing permissions: chat:write, im:history');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('Some checks did not pass. See below. The secrets are not saved.');
    // 测试不清空输入框。
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('xoxb-test-bot');
  });

  it('asks for a secret that was never saved before it sends anything', async () => {
    const { client } = render([slack()]);
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(client.saveChannelSecrets).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('Also fill in: User OAuth Token.');
  });

  it('shows the failed checks when the daemon refuses to save, and keeps the input', async () => {
    const saveChannelSecrets = vi.fn(async () => { throw new ChannelSecretsRejectedError('checks failed', FAILED, null); });
    render([slack()], { saveChannelSecrets });
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    type('PLC_SLACK_USER_TOKEN', 'xoxb-test-bot');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(saveChannelSecrets).toHaveBeenCalledWith('slack', { PLC_SLACK_APP_TOKEN: 'xapp-test-app', PLC_SLACK_USER_TOKEN: 'xoxb-test-bot' });
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('Not saved: some checks did not pass. See below.');
    expect(screen.getByTestId('channel-slack-check-user_token_kind').textContent).toContain('✗');
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('xoxb-test-bot');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('Not set up');
  });

  it('clears the fields after a successful save and shows the new state', async () => {
    const saveChannelSecrets = vi.fn(async () => saved(['vault', 'vault'], { status: 'connecting', account: null }));
    render([slack()], { saveChannelSecrets });
    type('PLC_SLACK_APP_TOKEN', 'xapp-test-app');
    type('PLC_SLACK_USER_TOKEN', 'xoxp-test-user');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-save')); });
    expect(input('PLC_SLACK_APP_TOKEN').value).toBe('');
    expect(input('PLC_SLACK_USER_TOKEN').value).toBe('');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('Saved. Connecting with the new secrets.');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('Connecting');
    expect(screen.getByTestId('channel-slack-secret-PLC_SLACK_APP_TOKEN').textContent).toContain('Saved · from the settings page');
    // 页面上任何地方都没有刚才填的值。
    expect(document.body.textContent).not.toContain('xapp-test-app');
    expect(document.body.textContent).not.toContain('xoxp-test-user');
  });

  it('offers disconnect only for secrets from the settings page, behind a confirmation', async () => {
    const clearChannelSecrets = vi.fn(async () => slack());
    const { runtime } = render([saved(['vault', 'vault'])], { clearChannelSecrets });
    fireEvent.click(screen.getByTestId('channel-slack-disconnect-start'));
    expect(clearChannelSecrets).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-slack-disconnect-confirm').textContent).toContain('Delete the secrets saved on the settings page and disconnect');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-disconnect')); });
    expect(clearChannelSecrets).toHaveBeenCalledWith('slack');
    expect(screen.getByTestId('channel-slack-message').textContent).toBe('Disconnected. The secrets saved on the settings page are deleted.');
    expect(screen.getByTestId('channel-slack-status').textContent).toBe('Not set up');
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
    expect(screen.getByTestId('channel-slack-manifest-copy').textContent).toContain('Copied');

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
