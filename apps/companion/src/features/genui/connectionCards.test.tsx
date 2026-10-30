// @vitest-environment jsdom
// 会话里的两张连接卡（issue 08，方案 C）：Lead 请你连接一个账号，以及一次写入的确认。
// 卡片只带 key 或确认号，状态从 /v1/connections 和 /v1/connections/confirmations/:id 实时读取。
import type { ConnectionConfirmationDto, UiSurface } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connection, connectionsRuntime, deferred, renderWithRuntime } from '../../../test/connections';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// 见 settings/connectFlow.test.tsx：卸载中的 Spinner 在 jsdom 里会让 Reanimated 抛错。
vi.mock('@pi-lead-child/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pi-lead-child/components')>()),
  Spinner: () => null,
}));

const CONFIRMATION_ID = 'cfm_abcdefgh1234';

function surface(type: 'ConnectionConnect' | 'ConnectionConfirm', props: Record<string, unknown>): UiSurface {
  return {
    id: `surface-${type}`, catalogVersion: 1, root: 'card',
    fallbackText: type === 'ConnectionConnect' ? '要先连接 Notion。' : '要你确认一次写入。',
    nodes: [{ id: 'card', type, props }],
  };
}

function confirmation(overrides: Partial<ConnectionConfirmationDto> = {}): ConnectionConfirmationDto {
  return {
    id: CONFIRMATION_ID, key: 'atlassian', label: 'Jira & Confluence', tool: 'createJiraIssue',
    summary: '在 ACME 项目里建一个 issue：「登录页白屏」', argumentsPreview: '{"project":"ACME","summary":"登录页白屏"}',
    state: 'pending', createdAt: '2026-10-16T08:00:00.000Z', expiresAt: '2026-10-16T08:30:00.000Z',
    resolvedBy: null, resultPreview: null, ...overrides,
  };
}

const notion = connection({ key: 'notion' });
const jira = connection({ key: 'atlassian', provider: 'atlassian', label: 'Jira & Confluence', state: 'connected', account: 'you@acme.com' });

let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  open = vi.fn(() => ({ opener: window, location: { href: 'about:blank' }, close: vi.fn() }));
  vi.stubGlobal('open', open);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the connect card', () => {
  it('asks to connect with Lead’s reason and runs the same connect flow', () => {
    const { runtime, client } = connectionsRuntime([notion]);
    renderWithRuntime(<SurfaceView surface={surface('ConnectionConnect', { connection: 'notion', reason: '要读你上周的会议记录' })} />, runtime);
    const card = screen.getByTestId('surface-connection-notion');
    expect(card.textContent).toContain('连接 Notion');
    expect(card.textContent).toContain('要读你上周的会议记录');
    expect(card.textContent).toContain('连接以后，Paimon 可以搜索和读 Notion 页面');

    fireEvent.click(screen.getByTestId('surface-connect-notion'));
    // 和设置页一样：新窗口在点击里打开，再发请求。
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(client.startConnection).toHaveBeenCalledWith('notion', {});
    expect(screen.getByTestId('connect-starting')).toBeTruthy();
  });

  it('only collapses on this device when you say later', () => {
    const { runtime, client } = connectionsRuntime([notion]);
    renderWithRuntime(<SurfaceView surface={surface('ConnectionConnect', { connection: 'notion' })} />, runtime);
    fireEvent.click(screen.getByTestId('surface-connect-later-notion'));
    expect(screen.getByTestId('surface-connection-notion').textContent).toContain('还没有连接 Notion');
    expect(screen.queryByTestId('surface-connect-notion')).toBeNull();
    expect(client.startConnection).not.toHaveBeenCalled();
  });

  it('asks to re-authorize when the connection needs it', () => {
    const expired = connection({
      key: 'notion', state: 'needs_reauth',
      problem: { kind: 'invalid_grant', message: 'Notion 的授权失效了', since: null, nextAttemptAt: null },
    });
    const { runtime } = connectionsRuntime([expired]);
    renderWithRuntime(<SurfaceView surface={surface('ConnectionConnect', { connection: 'notion' })} />, runtime);
    expect(screen.getByTestId('surface-connection-notion').textContent).toContain('重新授权 Notion');
    expect(screen.getByTestId('surface-connect-notion').textContent).toBe('重新授权');
  });

  it('is one line when the connection is already connected', () => {
    const { runtime } = connectionsRuntime([jira]);
    renderWithRuntime(<SurfaceView surface={surface('ConnectionConnect', { connection: 'atlassian' })} />, runtime);
    expect(screen.getByTestId('surface-connection-atlassian').textContent).toBe('JJira & Confluence 已连接');
    expect(screen.queryByTestId('surface-connect-atlassian')).toBeNull();
  });

  it('turns into one line once the flow finishes', async () => {
    const start = deferred<unknown>();
    const { runtime } = connectionsRuntime([notion], { startConnection: vi.fn(() => start.promise) });
    renderWithRuntime(<SurfaceView surface={surface('ConnectionConnect', { connection: 'notion' })} />, runtime);
    fireEvent.click(screen.getByTestId('surface-connect-notion'));
    const connected = { ...notion, state: 'connected' as const, account: 'Acme' };
    await act(async () => {
      start.resolve({ flow: 'connected', connection: connected });
    });
    expect(screen.getByTestId('connect-done').textContent).toContain('Notion 已连接');
    fireEvent.click(screen.getByTestId('connect-finish'));
    expect(screen.getByTestId('surface-connection-notion').textContent).toBe('NNotion 已连接');
  });
});

describe('the write confirmation card', () => {
  it('reads the confirmation and lets you allow it, then follows the run to the result', async () => {
    const { runtime, client } = connectionsRuntime([jira], {
      connectionConfirmation: vi.fn(async () => confirmation()),
      resolveConnectionConfirmation: vi.fn(async () => confirmation({ state: 'running', resolvedBy: 'user via localhost-web' })),
    });
    await act(async () => {
      renderWithRuntime(<SurfaceView surface={surface('ConnectionConfirm', { confirmation: CONFIRMATION_ID })} />, runtime);
    });
    const card = screen.getByTestId(`surface-confirmation-${CONFIRMATION_ID}`);
    expect(client.connectionConfirmation).toHaveBeenCalledWith(CONFIRMATION_ID, expect.any(AbortSignal));
    expect(card.textContent).toContain('Jira & Confluence · 写入确认');
    expect(card.textContent).toContain('在 ACME 项目里建一个 issue：「登录页白屏」');
    expect(screen.queryByTestId('surface-confirmation-args')).toBeNull();
    fireEvent.click(screen.getByTestId('surface-confirmation-args-toggle'));
    expect(screen.getByTestId('surface-confirmation-args').textContent).toBe('{"project":"ACME","summary":"登录页白屏"}');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { fireEvent.click(screen.getByTestId('surface-confirmation-approve')); });
    expect(client.resolveConnectionConfirmation).toHaveBeenCalledWith(CONFIRMATION_ID, true);
    expect(screen.getByTestId('surface-confirmation-running').textContent).toBe('正在执行');
    expect(screen.queryByTestId('surface-confirmation-approve')).toBeNull();

    client.connectionConfirmation.mockResolvedValue(confirmation({ state: 'done', resultPreview: '已建 ACME-142' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const result = screen.getByTestId('surface-confirmation-result');
    expect(result.textContent).toContain('已执行');
    expect(result.textContent).toContain('已建 ACME-142');
  });

  it('sends a rejection with 不要', async () => {
    const { runtime, client } = connectionsRuntime([jira], {
      connectionConfirmation: vi.fn(async () => confirmation()),
      resolveConnectionConfirmation: vi.fn(async () => confirmation({ state: 'rejected' })),
    });
    await act(async () => {
      renderWithRuntime(<SurfaceView surface={surface('ConnectionConfirm', { confirmation: CONFIRMATION_ID })} />, runtime);
    });
    await act(async () => { fireEvent.click(screen.getByTestId('surface-confirmation-reject')); });
    expect(client.resolveConnectionConfirmation).toHaveBeenCalledWith(CONFIRMATION_ID, false);
    expect(screen.getByTestId('surface-confirmation-result').textContent).toBe('已拒绝');
  });

  it('shows failed and expired confirmations without buttons', async () => {
    for (const [state, label] of [['failed', '执行失败'], ['expired', '已过期']] as const) {
      const { runtime } = connectionsRuntime([jira], {
        connectionConfirmation: vi.fn(async () => confirmation({ state, resultPreview: state === 'failed' ? 'Jira 回 403' : null })),
      });
      const { unmount } = await act(async () => renderWithRuntime(
        <SurfaceView surface={surface('ConnectionConfirm', { confirmation: CONFIRMATION_ID })} />, runtime,
      ));
      expect(screen.getByTestId('surface-confirmation-result').textContent).toContain(label);
      if (state === 'failed') expect(screen.getByTestId('surface-confirmation-result').textContent).toContain('Jira 回 403');
      expect(screen.queryByTestId('surface-confirmation-approve')).toBeNull();
      unmount();
    }
  });
});

describe('unknown components', () => {
  it('still falls back to the text when a surface does not validate', () => {
    const { runtime } = connectionsRuntime([notion]);
    const bad = { ...surface('ConnectionConnect', { connection: 'Not A Key' }) };
    renderWithRuntime(<SurfaceView surface={bad} />, runtime);
    expect(screen.getByText('要先连接 Notion。')).toBeTruthy();
    expect(screen.queryByTestId('surface-connection-notion')).toBeNull();
  });
});
