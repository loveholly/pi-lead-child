// @vitest-environment jsdom
// 连接流程（issue 07）：预览、浏览器授权（新窗口必须在点击里同步打开）、GitHub 设备码、完成，以及要先配置和自定义服务器。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { StartConnectionResponse } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connection, connectionsRuntime, deferred, renderWithRuntime, setViewportWidth } from '../../../test/connections';
import { FLOW_POLL_MS } from './ConnectFlow';
import { ConnectionsSection } from './ConnectionsSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
// Spinner 的旋转是 Reanimated 的循环动画。它在测试中途被换掉（等授权 → 已连接）时，jsdom 里 Reanimated 还会给
// 已经卸载的视图写一帧样式并抛错。这里换成一个不转的占位，别的组件照旧。
vi.mock('@pi-lead-child/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pi-lead-child/components')>()),
  Spinner: () => null,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }) }));

const notion = connection({ key: 'notion' });
const github = connection({
  key: 'github', provider: 'github', label: 'GitHub', capability: '读 PR 和 issue，写评论',
  setupHint: '会显示一个设备码，在 GitHub 上输入即可',
});
const connectedNotion = connection({ key: 'notion', state: 'connected', account: 'Acme 工作区', tokenSource: 'oauth' });

type Popup = { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

let popup: Popup | null;
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setViewportWidth(1280);
  popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
  open = vi.fn(() => popup);
  vi.stubGlobal('open', open);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setViewportWidth(1024);
});

async function startFrom(key: string) {
  fireEvent.click(screen.getByTestId(`connection-action-${key}`));
  await act(async () => { fireEvent.click(screen.getByTestId('connect-continue')); });
}

describe('the browser flow', () => {
  it('opens the window inside the click, before the start request returns', async () => {
    const start = deferred<StartConnectionResponse>();
    const { runtime, client } = connectionsRuntime([notion], { startConnection: vi.fn(() => start.promise) });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);

    fireEvent.click(screen.getByTestId('connection-action-notion'));
    const consent = screen.getByTestId('connect-consent');
    expect(consent.textContent).toContain('连接 Notion');
    expect(consent.textContent).toContain('会打开 Notion 的授权页');
    expect(consent.textContent).toContain('连接以后，Paimon 可以');
    expect(consent.textContent).toContain('会写入的操作每次先问你。');
    expect(consent.textContent).toContain('授权只保存在这台 Mac 上。你随时可以在设置里断开。');

    fireEvent.click(screen.getByTestId('connect-continue'));
    // 请求还没回来，窗口已经开了：等完请求再开，浏览器会当作弹窗拦下。
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(client.startConnection).toHaveBeenCalledWith('notion', {});
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(client.startConnection.mock.invocationCallOrder[0]!);
    expect(popup!.location.href).toBe('about:blank');

    await act(async () => {
      start.resolve({ flow: 'browser', flowId: 'flow_abcdefgh12', authorizeUrl: 'https://mcp.notion.com/authorize?state=x', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    });
    expect(popup!.location.href).toBe('https://mcp.notion.com/authorize?state=x');
    expect(popup!.opener).toBeNull();
    const waiting = screen.getByTestId('connect-browser');
    expect(waiting.textContent).toContain('在新窗口里完成授权');
    expect(waiting.textContent).toContain('完成后这里会自动更新');
    expect(waiting.textContent).toContain('窗口没有打开？');
    expect(screen.getByTestId('connect-open-link').textContent).toBe('打开授权页');
    expect(screen.getByTestId('connect-copy-link').textContent).toBe('复制授权链接');
  });

  it('checks the flow at once when the gateway says connections changed, then shows done', async () => {
    const { runtime, client } = connectionsRuntime([notion], {
      startConnection: vi.fn(async () => ({ flow: 'browser', flowId: 'flow_abcdefgh12', authorizeUrl: 'https://mcp.notion.com/authorize', expiresAt: '2099-01-01T00:00:00.000Z' })),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    await startFrom('notion');
    expect(screen.getByTestId('connect-browser')).toBeTruthy();
    expect(client.connectionFlow).not.toHaveBeenCalled();

    client.connectionFlow.mockResolvedValue({ flowId: 'flow_abcdefgh12', state: 'connected', message: null, connection: connectedNotion });
    // 网关推了 snapshot.required（resource 是 connections），连接列表重取回来了。
    await act(async () => {
      runtime.control.setState({ connections: { items: [connectedNotion], attention: 0 } });
    });
    expect(client.connectionFlow).toHaveBeenCalledWith('flow_abcdefgh12', undefined);
    const done = await screen.findByTestId('connect-done');
    expect(done.textContent).toContain('Notion 已连接');
    expect(done.textContent).toContain('Acme 工作区');
    expect(done.textContent).toContain('试一下：帮我找一下上周的会议记录');
  });

  it('shows the link buttons when the browser blocked the window', async () => {
    popup = null;
    const { runtime } = connectionsRuntime([notion], {
      startConnection: vi.fn(async () => ({ flow: 'browser', flowId: 'flow_abcdefgh12', authorizeUrl: 'https://mcp.notion.com/authorize', expiresAt: '2099-01-01T00:00:00.000Z' })),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    await startFrom('notion');
    expect(screen.getByTestId('connect-browser').textContent).toContain('浏览器没有打开新窗口');
    expect(screen.getByTestId('connect-open-link')).toBeTruthy();
    expect(screen.getByTestId('connect-copy-link')).toBeTruthy();
  });

  it('stops on a failed flow and shows the daemon’s message', async () => {
    const { runtime, client } = connectionsRuntime([notion], {
      startConnection: vi.fn(async () => ({ flow: 'browser', flowId: 'flow_abcdefgh12', authorizeUrl: 'https://mcp.notion.com/authorize', expiresAt: '2099-01-01T00:00:00.000Z' })),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startFrom('notion');
    client.connectionFlow.mockResolvedValue({ flowId: 'flow_abcdefgh12', state: 'failed', message: 'Notion 拒绝了这次授权', connection: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLOW_POLL_MS); });
    expect(screen.getByTestId('connect-failed').textContent).toContain('Notion 拒绝了这次授权');
    // 停了：不再问。
    await act(async () => { await vi.advanceTimersByTimeAsync(FLOW_POLL_MS * 3); });
    expect(client.connectionFlow).toHaveBeenCalledTimes(1);
  });
});

describe('the GitHub device flow', () => {
  it('shows the code, copies it and opens GitHub, then polls until done', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { runtime, client } = connectionsRuntime([github], {
      startConnection: vi.fn(async () => ({
        flow: 'device', flowId: 'flow_device1234', userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      })),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startFrom('github');

    // GitHub 不用浏览器授权，不开空白窗口。
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId('connect-device-code').textContent).toBe('ABCD-1234');
    expect(screen.getByTestId('connect-device').textContent).toContain('github.com/login/device · 15 分钟内有效');

    await act(async () => { fireEvent.click(screen.getByTestId('connect-device-open')); });
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank', 'noopener');

    await act(async () => { await vi.advanceTimersByTimeAsync(FLOW_POLL_MS); });
    expect(client.connectionFlow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('connect-device')).toBeTruthy();

    client.connectionFlow.mockResolvedValue({
      flowId: 'flow_device1234', state: 'connected', message: null,
      connection: { ...github, state: 'connected', account: '@octo-dev', tokenSource: 'device' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLOW_POLL_MS); });
    const done = screen.getByTestId('connect-done');
    expect(done.textContent).toContain('GitHub 已连接');
    expect(done.textContent).toContain('@octo-dev');
    expect(done.textContent).toContain('我有哪些待 review 的 PR？');
  });

  it('offers a pasted token when GitHub needs setup, and never shows the token again', async () => {
    const needsSetup = connection({ ...github, state: 'needs_setup', setupHint: '需要先安装并登录 gh，或者粘贴一个 PAT' });
    const start = deferred<StartConnectionResponse>();
    const { runtime, client } = connectionsRuntime([needsSetup], { startConnection: vi.fn(() => start.promise) });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);

    fireEvent.click(screen.getByTestId('connection-action-github'));
    expect(screen.getByTestId('connect-setup').textContent).toContain('粘贴一个 GitHub 令牌');
    const field = screen.getByTestId('connect-github-token') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('password');
    const token = 'ghp_0123456789abcdefghijABCDEFGHIJ';
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByTestId('connect-github-token-submit'));
    expect(client.startConnection).toHaveBeenCalledWith('github', { token });
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      start.reject(new ControlPlaneClientError('GitHub 不接受这个令牌', 'invalid_request', 400, {
        error: { code: 'invalid_request', message: 'GitHub 不接受这个令牌', details: { reason: 'authorization_failed' } },
      }));
    });
    expect(screen.getByTestId('connect-failed').textContent).toContain('GitHub 不接受这个令牌');
    expect(document.body.textContent).not.toContain(token);
  });

  it('turns a needs_setup answer from the daemon into the token step', async () => {
    const { runtime } = connectionsRuntime([github], {
      startConnection: vi.fn(async () => {
        throw new ControlPlaneClientError('这台 Mac 上没有登录过的 gh。请先运行 gh auth login，或者粘贴一个 GitHub 令牌', 'conflict', 409, {
          error: { code: 'conflict', message: '这台 Mac 上没有登录过的 gh。请先运行 gh auth login，或者粘贴一个 GitHub 令牌', details: { reason: 'needs_setup' } },
        });
      }),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    await startFrom('github');
    const setup = screen.getByTestId('connect-setup');
    expect(setup.textContent).toContain('请先运行 gh auth login');
    expect(screen.getByTestId('connect-github-token')).toBeTruthy();
  });
});

describe('Slack setup', () => {
  it('says the daemon needs the workspace app’s client ID first', () => {
    const slack = connection({ key: 'slack', provider: 'slack', label: 'Slack', state: 'needs_setup', setupHint: '需要先在 daemon 上配置你们工作区的 Slack app（client ID）' });
    const { runtime } = connectionsRuntime([slack]);
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    fireEvent.click(screen.getByTestId('connection-action-slack'));
    expect(screen.getByTestId('connect-setup').textContent).toContain('connections.slack.clientId');
  });
});

describe('a custom MCP server', () => {
  it('checks the address, then shows the daemon’s message when the daemon refuses it', async () => {
    const { runtime, client } = connectionsRuntime([notion], {
      addCustomConnection: vi.fn(async () => {
        throw new ControlPlaneClientError('这个地址没有回应 MCP 的授权发现', 'invalid_request', 400, {
          error: { code: 'invalid_request', message: '这个地址没有回应 MCP 的授权发现', details: { reason: 'invalid_request' } },
        });
      }),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    fireEvent.click(screen.getByTestId('connections-add-custom'));

    fireEvent.change(screen.getByTestId('connections-custom-url'), { target: { value: 'http://mcp.example.com/mcp' } });
    fireEvent.click(screen.getByTestId('connections-custom-connect'));
    expect(screen.getByTestId('connections-custom-problem').textContent).toBe('地址要以 https:// 开头。');
    expect(client.addCustomConnection).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('connections-custom-url'), { target: { value: 'https://mcp.example.com/mcp' } });
    await act(async () => { fireEvent.click(screen.getByTestId('connections-custom-connect')); });
    expect(client.addCustomConnection).toHaveBeenCalledWith('https://mcp.example.com/mcp');
    expect(screen.getByTestId('connections-custom-problem').textContent).toBe('这个地址没有回应 MCP 的授权发现');
    expect(popup!.close).toHaveBeenCalled();
    // 地址还在，可以改了再试。
    expect((screen.getByTestId('connections-custom-url') as HTMLInputElement).value).toBe('https://mcp.example.com/mcp');
  });

  it('continues with the same browser flow when the daemon accepts it', async () => {
    const { runtime } = connectionsRuntime([notion], {
      addCustomConnection: vi.fn(async () => ({ flow: 'browser', flowId: 'flow_custom12345', authorizeUrl: 'https://auth.example.com/authorize', expiresAt: '2099-01-01T00:00:00.000Z' })),
    });
    renderWithRuntime(<ConnectionsSection connectionId={null} />, runtime);
    fireEvent.click(screen.getByTestId('connections-add-custom'));
    fireEvent.change(screen.getByTestId('connections-custom-url'), { target: { value: 'https://mcp.example.com/mcp' } });
    await act(async () => { fireEvent.click(screen.getByTestId('connections-custom-connect')); });
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(popup!.location.href).toBe('https://auth.example.com/authorize');
    expect(screen.getByTestId('connect-browser')).toBeTruthy();
  });
});
