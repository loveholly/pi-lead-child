// @vitest-environment happy-dom
// 设置 → 连接（issue 07）：三组、健康条、侧栏角标，以及一个连接的详情。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connection, connectionsRuntime, renderWithRuntime, setViewportWidth } from '../../../test/connections';
import { cssVar } from '../../../test/render';
import SettingsLayout from '../../app/settings/_layout';
import { ConnectionDetail } from './ConnectionDetail';
import { ConnectionsSection } from './ConnectionsSection';
import { connectionSecondLine, connectionStatus, groupConnections, serverUrlProblem, toolCountLabel } from './connectionModel';
import { SettingsHome } from './SettingsHome';

const nav = vi.hoisted(() => ({
  pathname: '/settings/connections',
  router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() },
}));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  Slot: () => null,
  Stack: () => null,
}));

const now = Date.now();
const minutes = (count: number) => new Date(now + count * 60_000).toISOString();

const jira = connection({
  key: 'atlassian', provider: 'atlassian', label: 'Jira & Confluence', capability: '查、建、改 issue；搜索和读 Confluence 页面',
  state: 'connected', account: 'you@acme.com', tokenSource: 'oauth', connectedAt: minutes(-60 * 24 * 3),
  lastUsedAt: minutes(-12), lastRefreshAt: minutes(-30), accessExpiresAt: minutes(52), grantExpiresAt: minutes(60 * 24 * 80),
  tools: { total: 29, readOnly: 23, write: 6 },
});
const notion = connection({
  key: 'notion', state: 'needs_reauth', account: 'Acme', tokenSource: 'oauth', connectedAt: minutes(-600),
  problem: { kind: 'invalid_grant', message: 'Notion 的授权失效了（可能被撤销或已过期），需要重新授权', since: null, nextAttemptAt: null },
});
const linear = connection({
  key: 'custom-a1b2', provider: 'custom', label: 'linear.app', state: 'degraded', account: 'me', tokenSource: 'oauth',
  problem: { kind: 'transient', message: '暂时连不上 linear.app，daemon 会自动重试', since: null, nextAttemptAt: '2026-10-16T09:41:00.000Z' },
});
const github = connection({ key: 'github', provider: 'github', label: 'GitHub', capability: '读 PR 和 issue，写评论', setupHint: '会使用这台 Mac 上 gh 的登录' });
const slack = connection({ key: 'slack', provider: 'slack', label: 'Slack', state: 'needs_setup', setupHint: '需要先在 daemon 上配置你们工作区的 Slack app（client ID）' });
const google = connection({ key: 'google', provider: 'google', label: 'Google', state: 'unavailable', setupHint: 'Gmail、日历、云端硬盘的 MCP 还在预览期' });

const everything = [google, slack, github, linear, notion, jira];

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = '/settings/connections';
  setViewportWidth(1280);
});
afterEach(() => setViewportWidth(1024));

describe('the connections list', () => {
  it('groups connections as connected, one-click and needs extra setup', () => {
    const { runtime } = connectionsRuntime(everything);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);

    const rows = (group: string) => within(screen.getByTestId(`connections-group-${group}`))
      .getAllByTestId(/^connection-row-/).map((row) => row.getAttribute('data-testid'));
    expect(rows('connected')).toEqual(['connection-row-custom-a1b2', 'connection-row-notion', 'connection-row-atlassian']);
    expect(rows('available')).toEqual(['connection-row-github']);
    // 「即将支持」排在需要设置的后面。
    expect(rows('setup')).toEqual(['connection-row-slack', 'connection-row-google']);
    expect(['connected', 'available', 'setup'].map((group) => screen.getByTestId(`connections-group-title-${group}`).textContent))
      .toEqual(['Connected', 'Available', 'Needs more setup']);
  });

  it('writes each row status and second line from the connection state', () => {
    const { runtime } = connectionsRuntime(everything);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);

    expect(screen.getByTestId('connection-status-atlassian').textContent).toBe('Connected');
    expect(screen.getByTestId('connection-second-atlassian').textContent).toBe('you@acme.com · Used 12 minutes ago');
    expect(screen.getByTestId('connection-status-custom-a1b2').textContent).toBe('Cannot connect now');
    expect(screen.getByTestId('connection-second-custom-a1b2').textContent).toBe('暂时连不上 linear.app，daemon 会自动重试');
    expect(screen.getByTestId('connection-status-notion').textContent).toBe('Needs a new authorization');
    expect(screen.getByTestId('connection-action-notion').textContent).toBe('Authorize again');
    expect(screen.getByTestId('connection-second-github').textContent).toBe('读 PR 和 issue，写评论');
    expect(screen.getByTestId('connection-action-github').textContent).toBe('Connect');
    expect(screen.getByTestId('connection-status-google').textContent).toBe('Coming soon');
    expect(screen.getByTestId('connection-second-google').textContent).toBe('Gmail、日历、云端硬盘的 MCP 还在预览期');
    expect(screen.queryByTestId('connection-action-google')).toBeNull();
    expect(screen.getByTestId('connections-add-custom').textContent).toContain('+ Add an MCP server');
    expect(screen.getByTestId('connections-add-custom').textContent).toContain('Any remote MCP server that supports OAuth');
  });

  it('opens a connected row in the desktop drawer without stacking history, and pushes a page on phones', () => {
    const { runtime } = connectionsRuntime(everything);
    const { unmount } = renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    fireEvent.click(screen.getByTestId('connection-open-atlassian'));
    expect(nav.router.replace).toHaveBeenCalledWith('/settings/connections/atlassian');
    unmount();

    setViewportWidth(390);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    fireEvent.click(screen.getByTestId('connection-open-atlassian'));
    expect(nav.router.push).toHaveBeenCalledWith('/settings/connections/atlassian');
  });
});

describe('the health bar', () => {
  it('appears only when a connection needs the user', () => {
    const { runtime } = connectionsRuntime([jira, github, linear]);
    const { unmount } = renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    // 暂时连不上不用你做什么：daemon 自己会重试。
    expect(screen.queryByTestId('connection-health-bar')).toBeNull();
    unmount();

    const expiring = connection({
      ...jira, key: 'notion', provider: 'notion', label: 'Notion',
      problem: { kind: 'expiring', message: 'Notion 的授权 3 天后到期。Notion 每 180 天要重新授权一次', since: null, nextAttemptAt: null },
    });
    const second = connectionsRuntime([jira, expiring]);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, second.runtime);
    const bar = screen.getByTestId('connection-health-bar');
    expect(within(bar).getAllByTestId(/^connection-health-[a-z]/).filter((item) => !item.getAttribute('data-testid')!.includes('reauth')))
      .toHaveLength(1);
    expect(bar.textContent).toContain('Notion 的授权 3 天后到期');
  });

  it('starts the re-authorization flow from the bar', () => {
    const { runtime } = connectionsRuntime([jira, notion]);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    expect(screen.getByTestId('connection-health-notion').textContent).toContain('Notion 的授权失效了');

    fireEvent.click(screen.getByTestId('connection-health-reauth-notion'));
    const consent = screen.getByTestId('connect-consent');
    expect(consent.textContent).toContain('Authorize Notion again');
    expect(consent.textContent).toContain('Opens the Notion authorization page');
    expect(within(consent).getByTestId('connect-continue').textContent).toBe('Continue to Notion');
  });

  it('is also on the phone settings home', () => {
    setViewportWidth(390);
    const { runtime } = connectionsRuntime([jira, notion]);
    renderWithRuntime(<SettingsHome badges={{ connections: 1 }} connections={[jira, notion]} />, runtime);
    expect(screen.getByTestId('connection-health-notion')).toBeTruthy();
    expect(screen.getByTestId('settings-row-connections-badge').textContent).toBe('1');
  });
});

describe('the settings sidebar', () => {
  it('counts the connections that need the user, in the warning color', () => {
    nav.pathname = '/settings';
    const expiring = connection({ ...jira, key: 'atlassian', problem: { kind: 'expiring', message: '快到期', since: null, nextAttemptAt: null } });
    const { runtime } = connectionsRuntime([expiring, notion, github]);
    renderWithRuntime(<SettingsLayout />, runtime);
    const badge = screen.getByTestId('settings-nav-connections-badge');
    expect(badge.textContent).toBe('2');
    expect(getComputedStyle(badge.firstElementChild!).backgroundColor).toBe(cssVar('--c-warning'));
  });

  it('shows the selected connection in a drawer next to the list on desktop', () => {
    nav.pathname = '/settings/connections/atlassian';
    const { runtime } = connectionsRuntime(everything);
    renderWithRuntime(<SettingsLayout />, runtime);
    const drawer = screen.getByTestId('settings-drawer');
    expect(within(drawer).getByTestId('connection-detail-atlassian')).toBeTruthy();
    fireEvent.click(within(drawer).getByTestId('connection-detail-close'));
    expect(nav.router.replace).toHaveBeenCalledWith('/settings/connections');
  });
});

describe('a connection’s detail', () => {
  it('shows the authorization facts and the tool counts', async () => {
    const { runtime, client } = connectionsRuntime([jira], {
      connectionTools: vi.fn(async () => [
        { name: 'searchJiraIssues', title: null, description: '按 JQL 搜索 issue', readOnly: true },
        { name: 'createJiraIssue', title: '新建 issue', description: null, readOnly: false },
      ]),
    });
    renderWithRuntime(<ConnectionDetail connectionKey="atlassian" />, runtime);
    const detail = screen.getByTestId('connection-detail-atlassian');
    expect(detail.textContent).toContain('you@acme.com');
    expect(detail.textContent).toMatch(/RenewalAutomatic · last renewed /);
    expect(detail.textContent).toContain('Expires in 52 minutes. It renews before that.');
    expect(detail.textContent).toContain('Authorization expires');
    expect(detail.textContent).toContain('29 tools · 23 read-only · 6 can write');

    fireEvent.click(screen.getByTestId('connection-tools-toggle'));
    const tools = await screen.findByText('createJiraIssue');
    expect(client.connectionTools).toHaveBeenCalledWith('atlassian', undefined);
    expect(within(screen.getByTestId('connection-tools')).getByText('按 JQL 搜索 issue')).toBeTruthy();
    expect(within(screen.getByTestId('connection-tools')).getByText('Read-only')).toBeTruthy();
    expect(within(tools.parentElement!.parentElement!).getByText('Can write')).toBeTruthy();
  });

  it('saves who can use it and the write policy', async () => {
    const { runtime, client } = connectionsRuntime([jira]);
    renderWithRuntime(<ConnectionDetail connectionKey="atlassian" />, runtime);

    expect(screen.getByTestId('connection-role-reviewer').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('connection-role-reviewer'));
    expect(client.updateConnectionSettings).toHaveBeenCalledWith('atlassian', { roles: ['lead', 'executor'] });

    await vi.waitFor(() => expect(screen.getByTestId('connection-role-reviewer').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(screen.getByTestId('connection-write-direct'));
    expect(client.updateConnectionSettings).toHaveBeenLastCalledWith('atlassian', { writePolicy: 'direct' });
    expect(screen.getByText('Tools that create issues, change status or post comments send a confirm card first.')).toBeTruthy();
  });

  it('tests the connection and shows the result inline', async () => {
    const { runtime, client } = connectionsRuntime([jira], {
      testConnection: vi.fn(async () => ({ ok: true, message: '连接正常，29 个工具可用', connection: jira })),
    });
    renderWithRuntime(<ConnectionDetail connectionKey="atlassian" />, runtime);
    fireEvent.click(screen.getByTestId('connection-test'));
    expect((await screen.findByTestId('connection-test-result')).textContent).toBe('连接正常，29 个工具可用');
    expect(client.testConnection).toHaveBeenCalledWith('atlassian');
  });

  it('asks again inline before it disconnects', async () => {
    const { runtime, client } = connectionsRuntime([jira]);
    renderWithRuntime(<ConnectionDetail connectionKey="atlassian" />, runtime);

    fireEvent.click(screen.getByTestId('connection-disconnect'));
    expect(screen.getByTestId('connection-disconnect-confirm').textContent).toContain('After you disconnect, Paimon cannot use this account.');
    fireEvent.click(within(screen.getByTestId('connection-disconnect-confirm')).getByText('Cancel'));
    expect(screen.queryByTestId('connection-disconnect-confirm')).toBeNull();
    expect(client.disconnectConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('connection-disconnect'));
    fireEvent.click(screen.getByTestId('connection-disconnect-confirm-button'));
    await vi.waitFor(() => expect(client.disconnectConnection).toHaveBeenCalledWith('atlassian'));
    // 断开以后详情换成「连接」。
    expect(await screen.findByTestId('connection-detail-connect')).toBeTruthy();
  });

  it('shows the daemon’s error when a setting is refused', async () => {
    const { runtime } = connectionsRuntime([jira], {
      updateConnectionSettings: vi.fn(async () => {
        throw new ControlPlaneClientError('至少要留一个可以用它的角色', 'invalid_request', 400);
      }),
    });
    renderWithRuntime(<ConnectionDetail connectionKey="atlassian" />, runtime);
    fireEvent.click(screen.getByTestId('connection-role-lead'));
    expect(await screen.findByText('至少要留一个可以用它的角色')).toBeTruthy();
  });

  it('explains a degraded connection and offers re-authorization when it is needed', () => {
    const { runtime } = connectionsRuntime([linear, notion]);
    const { unmount } = renderWithRuntime(<ConnectionDetail connectionKey="custom-a1b2" />, runtime);
    expect(screen.getByTestId('connection-detail-problem').textContent).toMatch(/^Cannot connect now. The daemon tries again at \d\d:\d\d\.$/);
    unmount();

    renderWithRuntime(<ConnectionDetail connectionKey="notion" />, runtime);
    expect(screen.getByTestId('connection-detail-problem').textContent).toContain('Notion 的授权失效了');
    fireEvent.click(screen.getByTestId('connection-detail-reauth'));
    expect(screen.getByTestId('connect-consent').textContent).toContain('Authorize Notion again');
  });
});

describe('the connection words in each language', () => {
  it('writes English by default and the original Chinese for zh', () => {
    expect(groupConnections(everything, null, 'zh').map((group) => group.label)).toEqual(['已连接', '可以连接', '需要额外设置']);
    expect(connectionStatus(jira, 'zh')?.label).toBe('已连接');
    expect(connectionSecondLine(jira, 'zh', new Date(now)).text).toBe('you@acme.com · 12 分钟前用过');
    expect(toolCountLabel(jira.tools!, 'zh')).toBe('29 个工具 · 只读 23 · 会写入 6');
    expect(toolCountLabel({ total: 1, readOnly: 1, write: 0 }, 'en')).toBe('1 tool · 1 read-only · 0 can write');
    expect(serverUrlProblem('http://mcp.example.com', 'zh')).toBe('地址要以 https:// 开头。');
  });
});
