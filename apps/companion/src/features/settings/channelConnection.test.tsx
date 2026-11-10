// @vitest-environment happy-dom
// 设置 → 消息通道里 Slack 的连接方式（2026-11-02 视觉稿，.scratch/slack-session 工单 06）。client 是假的：
// GET …/connection 给连接方式，改动都走 performUiAction('channel_connection', …)。
//   - Slack 应用（现状）：两个选项，Slack 应用选中、推荐；下面是填令牌的表单；没有「代你发消息」开关。
//   - 选浏览器会话：不马上换，标「未启用」，风险说明原地展开，填令牌的表单收起；取消回到原样。
//   - 接受风险并登录：调 sign_in；等你登录时按钮写「正在等你登录…」并停用，写剩余时间，取消调 cancel_sign_in。
//   - 登录没成功：按原因写一句话（窗口关掉了、超时……）。
//   - 会话已连接：会话那一块（没有粘贴的入口），「代你发消息」开关缺省关，打开调 allow_writes。
//   - 会话失效：「重新登录」是主按钮，旁边「改用 Slack 应用」调 use_mode。
//   - 中文。
import { ControlPlaneClient } from '@pi-lead-child/client';
import { DEFAULT_DESIGN_PREFERENCES, type ChannelConnectionDto, type ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { DesignPreferencesBridge } from '../../components/DesignPreferencesBridge';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ChannelSettingsSection } from './ChannelSettingsSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const APP = { mode: 'app', needsSignIn: false, writesSwitch: false };
const SESSION = { mode: 'session', needsSignIn: true, writesSwitch: true };

function connection(overrides: Partial<ChannelConnectionDto> = {}): ChannelConnectionDto {
  return { source: 'slack', mode: 'app', modes: [APP, SESSION], writes: null, signIn: null, ...overrides };
}

function appSource(overrides: Partial<ChannelSourceSettingsDto> = {}): ChannelSourceSettingsDto {
  return {
    source: 'slack', label: 'Slack', status: 'connected', account: { userId: 'U1', userName: 'Li Lei', teamId: 'T1', teamName: 'Acme' },
    missingScopes: [], lastError: null, lastConnectedAt: null,
    secrets: [
      { name: 'PLC_SLACK_APP_TOKEN', label: 'App-Level Token', prefix: 'xapp-', hint: '', present: true, origin: 'vault' },
      { name: 'PLC_SLACK_USER_TOKEN', label: 'User OAuth Token', prefix: 'xoxp-', hint: '', present: true, origin: 'vault' },
    ],
    manifest: null, setupUrl: null, editable: true, ...overrides,
  };
}

function sessionSource(overrides: Partial<ChannelSourceSettingsDto> = {}): ChannelSourceSettingsDto {
  return appSource({
    secrets: [{ name: 'PLC_SLACK_SESSION_COOKIE', label: 'Slack 会话', prefix: 'xoxd-', hint: '', present: true, origin: 'vault' }],
    ...overrides,
  });
}

function setup(source: ChannelSourceSettingsDto, first: ChannelConnectionDto, options: { locale?: 'en' | 'zh' } = {}) {
  let current = first;
  const client = {
    getChannelSettings: vi.fn(async () => ({ sources: [source] })),
    testChannelSecrets: vi.fn(() => new Promise(() => {})),
    saveChannelSecrets: vi.fn(() => new Promise(() => {})),
    clearChannelSecrets: vi.fn(() => new Promise(() => {})),
    getChannelConnection: vi.fn(async () => current),
    performUiAction: vi.fn(async (type: string, id: string, action: string) => ({ target: { type, id }, action, result: current })),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready', connectionState: 'connected', channelSettings: { sources: [source] },
    ...(options.locale ? { designPreferences: { ...DEFAULT_DESIGN_PREFERENCES, locale: options.locale } } : {}),
    resourceState: { ...state.resourceState, 'channel-settings': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null } },
  }));
  // 外观偏好（包括语言）经过 DesignPreferencesBridge 交给组件库。
  renderWithRuntime(<DesignPreferencesBridge><ChannelSettingsSection /></DesignPreferencesBridge>, runtime);
  return { client, next: (dto: ChannelConnectionDto) => { current = dto; } };
}

const radio = (mode: string) => screen.getByTestId(`channel-slack-connection-mode-${mode}`);

afterEach(() => {
  vi.useRealTimers();
});

describe('the Slack connection on the settings page', () => {
  it('shows the Slack app as the current, recommended mode, with the token form and no send switch', async () => {
    setup(appSource(), connection());
    await screen.findByTestId('channel-slack-connection');
    expect(radio('app').getAttribute('aria-checked')).toBe('true');
    expect(radio('app').textContent).toContain('Slack app');
    expect(radio('app').textContent).toContain('Recommended');
    expect(radio('session').textContent).toContain('Browser session');
    expect(radio('session').textContent).toContain('Unofficial API');
    expect(screen.getByTestId('channel-slack-input-PLC_SLACK_APP_TOKEN')).toBeTruthy();
    expect(screen.queryByTestId('channel-slack-connection-writes')).toBeNull();
  });

  it('opens the risk note in place when you pick the browser session, and cancel puts it back', async () => {
    const { client } = setup(appSource(), connection());
    await screen.findByTestId('channel-slack-connection');
    fireEvent.click(radio('session'));
    const risks = screen.getByTestId('channel-slack-connection-risks');
    expect(risks.textContent).toContain('The switch happens only after you sign in.');
    expect(risks.textContent).toContain('Unofficial method. Read these 4 points first');
    expect(risks.textContent).toContain('the power of your whole Slack account');
    expect(radio('session').textContent).toContain('Not active');
    expect(screen.queryByTestId('channel-slack-input-PLC_SLACK_APP_TOKEN')).toBeNull();
    expect(client.performUiAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('channel-slack-connection-risks')).toBeNull();
    expect(screen.getByTestId('channel-slack-input-PLC_SLACK_APP_TOKEN')).toBeTruthy();
  });

  // 剩余时间按组件自己记下的 now 算（ChannelConnection 的 useState(() => Date.now())），等待开始以后每秒才刷新一次。
  // 以前用真时钟：组件挂上以后过了 500ms 以上才算 expiresAt（整套跑时机器一忙就会），四舍五入成 300 秒，显示「5:00」，
  // 和「4:5x」对不上（2026-11-06，#279）。现在冻住 Date.now()，组件和测试用同一个时刻，剩余时间固定是 4:59。
  it('signs in after you accept the risks, waits with the time left, and can cancel', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const { client, next } = setup(appSource(), connection());
      await screen.findByTestId('channel-slack-connection');
      fireEvent.click(radio('session'));
      next(connection({ signIn: { mode: 'session', state: 'waiting', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 299_000).toISOString(), code: null } }));
      await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-connection-sign-in')); });
      expect(client.performUiAction).toHaveBeenCalledWith('channel_connection', 'slack', 'sign_in', { input: { mode: 'session' } });
      const waiting = await screen.findByTestId('channel-slack-connection-waiting');
      expect(waiting.textContent).toContain('A sign-in window is open on this Mac.');
      expect(waiting.textContent).toMatch(/Time left 4:5\d/);
      const button = screen.getByText('Waiting for you to sign in…').closest('[role="button"], button');
      expect(button?.getAttribute('aria-disabled') === 'true' || button?.hasAttribute('disabled')).toBe(true);
      next(connection({ signIn: { mode: 'session', state: 'cancelled', startedAt: new Date().toISOString(), expiresAt: null, code: 'cancelled' } }));
      await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-connection-cancel')); });
      expect(client.performUiAction).toHaveBeenLastCalledWith('channel_connection', 'slack', 'cancel_sign_in', { input: {} });
      expect((await screen.findByTestId('channel-slack-connection-result')).textContent).toBe('Sign-in cancelled. Nothing changed.');
    } finally {
      clock.mockRestore();
    }
  });

  it('says why the sign-in did not work', async () => {
    const { next } = setup(appSource(), connection());
    await screen.findByTestId('channel-slack-connection');
    fireEvent.click(radio('session'));
    next(connection({ signIn: { mode: 'session', state: 'failed', startedAt: new Date().toISOString(), expiresAt: null, code: 'window_closed' } }));
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-connection-sign-in')); });
    expect((await screen.findByTestId('channel-slack-connection-result')).textContent)
      .toBe('The sign-in window closed before you signed in. Nothing changed.');
  });

  it('shows the session without a paste field, and the send switch that only you turn on', async () => {
    const { client } = setup(sessionSource(), connection({ mode: 'session', writes: false }));
    await screen.findByTestId('channel-slack-connection-writes');
    expect(radio('session').getAttribute('aria-checked')).toBe('true');
    const session = screen.getByTestId('channel-slack-session');
    expect(session.textContent).toContain('Session');
    expect(session.textContent).toContain('Saved · from the settings page');
    expect(session.textContent).toContain('Derived at each start, never saved');
    expect(screen.queryByTestId('channel-slack-input-PLC_SLACK_SESSION_COOKIE')).toBeNull();
    const toggle = screen.getByTestId('channel-slack-connection-writes-switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('channel-slack-connection-writes').textContent).toContain('only reads');
    await act(async () => { fireEvent.click(toggle); });
    expect(client.performUiAction).toHaveBeenCalledWith('channel_connection', 'slack', 'allow_writes', { input: {} });
  });

  // 回归（#220）：会话那一块的「测试」不带密钥（daemon 用现在存的会话试）。以前客户端不发这个请求，
  // 页面报「The secret format is not correct. Each secret can have at most 1000 characters.」。这里用真的客户端。
  it('tests the saved session through the real client, without a secret format error', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const real = new ControlPlaneClient({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, checks: [], account: null, missingScopes: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      credentials: {
        load: async () => ({
          baseUrl: 'http://127.0.0.1:47130', accessToken: 'web-token', lastSeq: 0,
          binding: { id: 7, kind: 'companion', name: 'localhost-web', scopes: ['chat', 'tickets:view', 'tickets:create'] },
        }),
        save: async () => {}, clear: async () => {},
      },
    });
    const { client } = setup(sessionSource(), connection({ mode: 'session', writes: false }));
    client.testChannelSecrets.mockImplementation((...args: unknown[]) =>
      real.testChannelSecrets(args[0] as string, args[1] as Record<string, string>));
    const test = await screen.findByTestId('channel-slack-session-test');
    await act(async () => { fireEvent.click(test); });
    await waitFor(() => expect(requests).toEqual([{ url: 'http://127.0.0.1:47130/v1/channels/settings/slack/test', body: { secrets: {} } }]));
    expect(screen.getByTestId('channel-slack-session').textContent).not.toContain('secret format');
    expect(await screen.findByText('All checks passed. The secrets are not saved yet.')).toBeTruthy();
  });

  it('offers to sign in again, or to go back to the Slack app, when the session ended', async () => {
    const { client } = setup(sessionSource({ status: 'error', lastError: 'session ended' }), connection({ mode: 'session', writes: false }));
    const signIn = await screen.findByTestId('channel-slack-session-sign-in');
    expect(signIn.textContent).toContain('Sign in again');
    await act(async () => { fireEvent.click(screen.getByTestId('channel-slack-session-use-fallback')); });
    expect(client.performUiAction).toHaveBeenCalledWith('channel_connection', 'slack', 'use_mode', { input: { mode: 'app' } });
    await act(async () => { fireEvent.click(signIn); });
    expect(client.performUiAction).toHaveBeenCalledWith('channel_connection', 'slack', 'sign_in', { input: { mode: 'session' } });
  });

  it('hides the block for a source with a single connection method', async () => {
    const { client } = setup(appSource(), connection());
    client.getChannelConnection.mockRejectedValue(new Error('not found'));
    await waitFor(() => expect(client.getChannelConnection).toHaveBeenCalled());
    expect(screen.getByTestId('channel-slack-input-PLC_SLACK_APP_TOKEN')).toBeTruthy();
  });

  it('writes everything in Chinese', async () => {
    setup(appSource(), connection(), { locale: 'zh' });
    await screen.findByTestId('channel-slack-connection');
    expect(screen.getByTestId('channel-slack-connection').textContent).toContain('连接方式');
    expect(radio('app').textContent).toContain('Slack 应用');
    expect(radio('session').textContent).toContain('浏览器会话');
    fireEvent.click(radio('session'));
    expect(screen.getByTestId('channel-slack-connection-risks').textContent).toContain('非官方方式，先读这 4 点');
    expect(screen.getByText('接受风险并登录')).toBeTruthy();
    expect(radio('session').textContent).toContain('未启用');
  });
});
