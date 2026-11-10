// @vitest-environment happy-dom
// 2026-10-20：daemon 重启时页面只重连 WebSocket，不重新加载 JS。01:27 打开的页面在部署组件目录 v2 以后一直跑旧代码，
// 新组件的卡只剩纯文本，App 里没有任何「发现新版本」的机制。
// 现在网页由 daemon 提供时，App 每次连上（hello.v2）、每次回到前台都读一次 daemon 现在提供的网页版本，和自己的比较。
// 不一样时显示一条安静的提示和刷新按钮。不自动刷新：用户可能正在输入。同一个版本只提示一次。
import { PROTOCOL_VERSION, type HelloV2 } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../test/render';
import { CompanionRuntimeProvider } from '../state/CompanionStateProvider';
import {
  createCompanionStateRuntime, mountCompanionRuntime, type CompanionRuntimeDependencies, type ConnectivitySource,
} from '../state/runtime';
import { shellUpdateFromBridge } from '../state/shellUpdate';
import { WebUpdateNotice } from './WebUpdateNotice';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

const hello: HelloV2 = {
  type: 'hello.v2', protocolVersion: PROTOCOL_VERSION, serverTime: '2026-10-20T02:13:00.000Z', timezone: 'Asia/Shanghai',
  latestSeq: 0, capabilities: [], binding: { id: 7, kind: 'companion', name: 'web', scopes: ['chat'] } as HelloV2['binding'],
  daemon: { model: 'stub', sessionId: 'lead-session', busy: false },
};

const NOTICE = 'New version. Reload to use it.';

function setup(served: () => Promise<string | null>, options: { current?: string | null; compact?: boolean } = {}) {
  const reloadApp = vi.fn();
  const read = vi.fn(served);
  const current = options.current === undefined ? 'build-a' : options.current;
  const runtime = createCompanionStateRuntime({
    client: { disconnect: () => {} } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    reloadApp,
    ...(current === null ? {} : { webBuild: { current, served: read } }),
  });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><WebUpdateNotice compact={options.compact ?? false} /></CompanionRuntimeProvider>);
  // hello.v2 之后的读是异步的：等它落定再看界面。
  const connect = async () => {
    await act(async () => {
      runtime.handleHello(hello);
      await Promise.resolve();
    });
  };
  return { runtime, reloadApp, read, connect };
}

describe('the new-version notice', () => {
  it('appears when the daemon serves a newer web build, and refreshes only when asked', async () => {
    const { reloadApp, read, connect } = setup(async () => 'build-b');
    expect(screen.queryByText(NOTICE)).toBeNull();
    await connect();
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(reloadApp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  // 手机宽度的顶栏放不下整句（2026-10-20 预览：截成「有新版本，刷…」）。
  it('says it in fewer words in a narrow header, with the same refresh', async () => {
    const { reloadApp, connect } = setup(async () => 'build-b', { compact: true });
    await connect();
    expect(screen.getByTestId('web-update-notice').textContent).toContain('New version');
    expect(screen.queryByText(NOTICE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the page already runs the served build', async () => {
    const { connect } = setup(async () => 'build-a');
    await connect();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('stays quiet when the served build cannot be read', async () => {
    const failing = setup(async () => { throw new Error('offline'); });
    await failing.connect();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('stays quiet when this app has no build version (dev server, native app)', async () => {
    const { read, connect } = setup(async () => 'build-b', { current: null });
    await connect();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('asks only once per version: a dismissed version stays quiet after reconnecting, a newer one asks again', async () => {
    let served = 'build-b';
    const { connect } = setup(async () => served);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Do not show this version again' }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    await connect();
    expect(screen.queryByText(NOTICE)).toBeNull();
    served = 'build-c';
    await connect();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  // build:web 不重启 daemon 也能换掉网页（web-static.ts）：这时没有 hello，回到前台时再读一次。
  it('checks again when the app comes back to the foreground', async () => {
    const { runtime, read } = setup(async () => 'build-b');
    let emit: Parameters<ConnectivitySource['subscribe']>[0] = () => {};
    vi.spyOn(runtime, 'start').mockResolvedValue();
    vi.spyOn(runtime, 'checkConnection').mockResolvedValue(true);
    const unmount = mountCompanionRuntime(runtime, { connectivity: { subscribe: (listener) => { emit = listener; return () => {}; } } });
    await act(async () => {
      emit('foreground');
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    unmount();
  });
});

// 桌面 App 的一键更新（2026-11-04）：App 壳经 preload 的桥给状态，顶栏同一个位置写新版本号和「更新」，盖过网页的提示。
describe('the desktop app update', () => {
  function bridge(initial: unknown) {
    let push: (status: unknown) => void = () => {};
    const value = {
      get: vi.fn(async () => initial),
      apply: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
      onStatus: (callback: (status: unknown) => void) => { push = callback; },
    };
    return { value, push: (status: unknown) => act(() => { push(status); }) };
  }

  async function render(initial: unknown, served = 'build-b') {
    const shell = bridge(initial);
    const runtime = createCompanionStateRuntime({
      client: { disconnect: () => {} } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
      reloadApp: vi.fn(),
      webBuild: { current: 'build-a', served: async () => served },
      shellUpdate: shellUpdateFromBridge(shell.value)!,
    });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><WebUpdateNotice /></CompanionRuntimeProvider>);
    await act(async () => {
      runtime.handleHello(hello);
      await Promise.resolve();
    });
    return shell;
  }

  it('shows the new version with Update, and hands Update and Remind me tomorrow to the app', async () => {
    const shell = await render({ state: 'available', version: '1.4.0', size: 200_000_000 });
    expect(screen.getByTestId('app-update-notice').textContent).toContain('New version 1.4.0');
    expect(screen.queryByText(NOTICE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(shell.value.apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remind me tomorrow' }));
    expect(shell.value.dismiss).toHaveBeenCalledTimes(1);
  });

  it('follows the download and the install, then shows the reason and Try Again when it fails', async () => {
    const shell = await render({ state: 'available', version: '1.4.0', size: 200 });
    shell.push({ state: 'downloading', version: '1.4.0', received: 90, total: 200 });
    expect(screen.getByTestId('app-update-notice').textContent).toContain('Downloading the update: 45%');
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    shell.push({ state: 'installing', version: '1.4.0' });
    expect(screen.getByTestId('app-update-notice').textContent).toContain('Installing the update');
    shell.push({ state: 'failed', version: '1.4.0', code: 'checksum_mismatch', detail: 'got 3 bytes' });
    expect(screen.getByTestId('app-update-notice').textContent).toContain('The downloaded update is damaged. Reason: got 3 bytes');
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(shell.value.apply).toHaveBeenCalledTimes(1);
    // 下载卡住、404：提示里写出 App 给的原因。
    shell.push({ state: 'failed', version: '1.4.0', code: 'download_failed', detail: 'stalled: no data for 60 s' });
    expect(screen.getByTestId('app-update-notice').textContent).toContain('The update did not download. Reason: stalled: no data for 60 s');
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('leaves the web notice alone when the app has no update, and ignores a status it does not know', async () => {
    const shell = await render({ state: 'none' });
    expect(screen.getByText(NOTICE)).toBeTruthy();
    shell.push({ state: 'exploded', version: '9.9.9' });
    expect(screen.queryByTestId('app-update-notice')).toBeNull();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});

