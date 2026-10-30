// @vitest-environment jsdom
// 设置页的外框（方案 A）：桌面上是分组侧栏加内容，手机上是一个栈。按真实的 app/settings/_layout.tsx 渲染。
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';

import { renderUI } from '../../../test/render';
import SettingsLayout from '../../app/settings/_layout';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { SettingsDesktopShell } from './SettingsDesktopShell';

const nav = vi.hoisted(() => ({
  pathname: '/settings',
  router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() },
  slot: vi.fn(() => null),
  stack: vi.fn(() => null),
}));

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  Slot: nav.slot,
  Stack: nav.stack,
}));

// react-native-web 读 documentElement.clientWidth，jsdom 里它是 0。
function setViewportWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

// 设置的外框读连接列表（侧栏的角标）。这里的客户端没有连接接口，资源标成不支持，不发请求。
function renderLayout(element: ReactElement = <SettingsLayout />) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  return renderUI(<CompanionRuntimeProvider runtime={runtime}>{element}</CompanionRuntimeProvider>);
}

beforeEach(() => {
  nav.pathname = '/settings';
  vi.clearAllMocks();
});

afterEach(() => setViewportWidth(1024));

describe('settings on desktop', () => {
  beforeEach(() => setViewportWidth(1280));

  it('shows only the groups that have screens, with the content next to it', () => {
    renderLayout();
    const sidebar = screen.getByTestId('settings-sidebar');
    expect(within(sidebar).getByText('‹ 回到工作台')).toBeTruthy();
    expect(within(sidebar).getByText('设置')).toBeTruthy();
    expect(within(sidebar).getByText('账号')).toBeTruthy();
    expect(within(sidebar).getByText('设备')).toBeTruthy();
    // Lead 分组的标题是它的名字（缺省 Paimon），排在最上面（2026-10-22）。
    expect(within(sidebar).getByText('Paimon')).toBeTruthy();
    expect(within(sidebar).queryByText('Lead')).toBeNull();
    expect(within(sidebar).getByText('执行')).toBeTruthy();
    const text = sidebar.textContent ?? '';
    expect(text.indexOf('Paimon')).toBeLessThan(text.indexOf('账号'));
    const labels = ['身份与风格', '外观', '模型', '记忆', '常设指令', '连接', '消息通道', '本设备', '已配对设备', '执行器'];
    expect(labels.map((label) => within(sidebar).getByText(label).textContent)).toEqual(labels);
    // 还没有界面的功能不出现，也就没有点了没反应的条目。
    for (const missing of ['授权与委托', 'Daemon']) {
      expect.soft(within(sidebar).queryByText(missing), missing).toBeNull();
    }
    expect(screen.getByTestId('settings-content')).toBeTruthy();
    expect(nav.slot).toHaveBeenCalled();
    expect(nav.stack).not.toHaveBeenCalled();
  });

  it('titles the Lead group with the name the user gave it', () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ leadProfile: { name: 'Jarvis', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null } });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><SettingsLayout /></CompanionRuntimeProvider>);
    const sidebar = screen.getByTestId('settings-sidebar');
    expect(within(sidebar).getByText('Jarvis')).toBeTruthy();
    expect(within(sidebar).queryByText('Paimon')).toBeNull();
  });

  it('lands on the first entry at /settings and selects the section in the address', () => {
    const { unmount } = renderLayout();
    const selected = screen.getByTestId('settings-nav-profile');
    const other = screen.getByTestId('settings-nav-device');
    expect(selected.getAttribute('aria-current')).toBe('page');
    expect(other.getAttribute('aria-current')).toBeNull();
    // 选中的条目是浅蓝底、深蓝字。jsdom 不解析 CSS 变量，读到的是 token 的变量名。
    expect(getComputedStyle(selected).backgroundColor).toBe('var(--c-accent-soft)');
    expect(getComputedStyle(selected.firstElementChild!).color).toBe('var(--c-accent-strong)');
    expect(getComputedStyle(other).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(screen.getByTestId('settings-sidebar')).width).toBe('236px');
    unmount();

    nav.pathname = '/settings/devices';
    renderLayout();
    expect(screen.getByTestId('settings-nav-devices').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('settings-nav-connections').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('settings-nav-device').getAttribute('aria-current')).toBeNull();
  });

  it('switches sections in place and goes back to the workbench', () => {
    renderLayout();
    fireEvent.click(screen.getByTestId('settings-nav-channels'));
    expect(nav.router.replace).toHaveBeenCalledWith('/settings/channels');
    fireEvent.click(screen.getByTestId('settings-nav-device'));
    expect(nav.router.replace).toHaveBeenCalledWith('/settings/device');
    fireEvent.click(screen.getByTestId('settings-nav-devices'));
    expect(nav.router.replace).toHaveBeenLastCalledWith('/settings/devices');
    expect(nav.router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('settings-exit'));
    expect(nav.router.dismissTo).toHaveBeenCalledWith('/');
  });

  it('keeps the connections badge hidden until a count is passed', () => {
    const { unmount } = renderLayout(<SettingsDesktopShell selected="connections" onSelect={() => {}} onExit={() => {}} />);
    expect(screen.queryByTestId('settings-nav-connections-badge')).toBeNull();
    unmount();

    renderLayout(<SettingsDesktopShell selected="connections" onSelect={() => {}} onExit={() => {}} badges={{ connections: 0 }} />);
    expect(screen.queryByTestId('settings-nav-connections-badge')).toBeNull();
  });

  it('shows the count it is given', () => {
    renderLayout(<SettingsDesktopShell selected="device" onSelect={() => {}} onExit={() => {}} badges={{ connections: 2 }} />);
    expect(screen.getByTestId('settings-nav-connections-badge').textContent).toBe('2');
  });
});

describe('settings on a phone', () => {
  beforeEach(() => setViewportWidth(390));

  it('uses a stack and has no sidebar', () => {
    renderLayout();
    expect(screen.queryByTestId('settings-sidebar')).toBeNull();
    expect(nav.stack).toHaveBeenCalled();
    expect(nav.slot).not.toHaveBeenCalled();
  });
});
