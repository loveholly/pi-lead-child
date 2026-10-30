// @vitest-environment jsdom
// 请你做一件事的通用卡（2026-10-19，protocol 的 user-actions.ts）：Lead 把系统给的「需要用户做什么」原样放进 UserAction。
// 客户端按 kind 画控件，不按服务写特例：重新授权就是连接卡，走和设置页一样的连接流程；验收打开工单。
import { userActionRequest, type UiSurface, type UserActionRequest } from '@pi-lead-child/protocol';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connection, connectionsRuntime, renderWithRuntime } from '../../../test/connections';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@pi-lead-child/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pi-lead-child/components')>()),
  Spinner: () => null,
}));

function card(action: UserActionRequest): UiSurface {
  return {
    id: 'surface-user-action', catalogVersion: 1, root: 'card', fallbackText: action.reason,
    nodes: [
      { id: 'card', type: 'Section', props: { title: action.title }, children: ['act'] },
      { id: 'act', type: 'UserAction', props: { action } },
    ],
  };
}

let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  open = vi.fn(() => ({ opener: window, location: { href: 'about:blank' }, close: vi.fn() }));
  vi.stubGlobal('open', open);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a UserAction card', () => {
  it('turns a re-authorization into the connect card with its button', () => {
    const expired = connection({
      key: 'github', provider: 'github', label: 'GitHub', state: 'needs_reauth',
      problem: { kind: 'invalid_grant', message: 'GitHub 的授权失效了', since: null, nextAttemptAt: null },
    });
    const { runtime, client } = connectionsRuntime([expired]);
    const action = userActionRequest({ kind: 'reauthorize', target: 'connection:github', title: '重新授权 GitHub', reason: '发 PR #101 的评论要用 GitHub' });
    renderWithRuntime(<SurfaceView surface={card(action)} />, runtime);
    expect(screen.getByTestId('surface-connection-github').textContent).toContain('发 PR #101 的评论要用 GitHub');
    fireEvent.click(screen.getByTestId('surface-connect-github'));
    expect(client.startConnection).toHaveBeenCalledWith('github', {});
  });

  it('gives an acceptance a button with the action’s title and reason', () => {
    const { runtime } = connectionsRuntime([]);
    const action = userActionRequest({ kind: 'accept', target: 'ticket:98', title: '去验收 #98', reason: '核查通过了，等你验收' });
    renderWithRuntime(<SurfaceView surface={card(action)} />, runtime);
    const row = screen.getByTestId('surface-user-action-accept-98');
    expect(row.textContent).toContain('核查通过了，等你验收');
    expect(row.textContent).toContain('去验收 #98');
  });
});
