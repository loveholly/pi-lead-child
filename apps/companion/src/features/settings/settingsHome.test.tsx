// @vitest-environment jsdom
// 手机上的设置首页：最上面是 Lead 的名字（缺省 Paimon），下面是分组，Lead 分组排第一（2026-10-22）；
// 每一行推进一个分组的页面；分组页左上角是「‹ 设置」。
import type { LeadStatus, Overview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { ControlPlanePhase } from '../../state/types';
import { SettingsHome } from './SettingsHome';
import { SettingsPage } from './SettingsPage';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => router }));

const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null,
  lastSuccessAt: '2026-10-16T08:00:00.000Z',
};

function overview(): Overview {
  return {
    model: 'claude-sonnet-5-5', sessionId: 'lead-session', busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null,
    lead: online,
  };
}

function setViewportWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

function renderWith(element: ReactElement, phase: ControlPlanePhase = 'ready', leadName: string | null = null) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase,
    connectionState: phase === 'ready' ? 'connected' : 'disconnected',
    overview: phase === 'ready' ? overview() : null,
    ...(leadName ? { leadProfile: { name: leadName, persona: '', interactionStyle: '', updatedAt: null, updatedBy: null } } : {}),
  });
  renderUI(<CompanionRuntimeProvider runtime={runtime}>{element}</CompanionRuntimeProvider>);
}

beforeEach(() => {
  setViewportWidth(390);
  vi.clearAllMocks();
});
afterEach(() => setViewportWidth(1024));

describe('the phone settings home', () => {
  it('shows Paimon first, then the groups as rows that push their section', () => {
    renderWith(<SettingsHome />);
    expect(screen.getByTestId('settings-paimon-name').textContent).toBe('Paimon');
    expect(screen.getByTestId('settings-paimon-status').textContent).toBe('在线');
    expect(screen.getByText('账号')).toBeTruthy();
    expect(screen.getByText('设备')).toBeTruthy();
    // Lead 分组（标题是它的名字）排在「账号」前面，第一行是「身份与风格」。
    const home = screen.getByTestId('settings-home').textContent ?? '';
    expect(home.indexOf('身份与风格')).toBeLessThan(home.indexOf('账号'));
    fireEvent.click(screen.getByTestId('settings-row-profile'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/profile');

    fireEvent.click(screen.getByTestId('settings-row-connections'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/connections');
    fireEvent.click(screen.getByTestId('settings-row-channels'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/channels');
    fireEvent.click(screen.getByTestId('settings-row-device'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/device');
    fireEvent.click(screen.getByTestId('settings-row-devices'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/devices');
    expect(screen.queryByTestId('settings-row-connections-badge')).toBeNull();
  });

  it('uses the name the user gave Lead on the card, the avatar and the group title', () => {
    renderWith(<SettingsHome />, 'ready', 'jarvis');
    expect(screen.getByTestId('settings-paimon-name').textContent).toBe('jarvis');
    const home = screen.getByTestId('settings-home');
    expect(home.textContent).toContain('J');
    expect(home.textContent).not.toContain('Paimon');
  });

  it('opens This device from the Paimon card when paired', () => {
    renderWith(<SettingsHome />);
    fireEvent.click(screen.getByTestId('settings-paimon'));
    expect(router.push).toHaveBeenLastCalledWith('/settings/device');
  });

  it('opens the pairing page from the Paimon card when the device is not paired', () => {
    renderWith(<SettingsHome />, 'unpaired');
    fireEvent.click(screen.getByTestId('settings-paimon'));
    expect(router.push).toHaveBeenLastCalledWith('/pair');
  });

  it('goes back to the conversation', () => {
    renderWith(<SettingsHome />);
    fireEvent.click(screen.getByTestId('settings-close'));
    expect(router.dismissTo).toHaveBeenCalledWith('/');
  });
});

describe('a phone settings section', () => {
  it('has a back button to settings', () => {
    renderWith(<SettingsPage title="本设备" />);
    expect(screen.getByTestId('settings-back').textContent).toBe('‹ 设置');
    expect(screen.getByTestId('settings-page-title').textContent).toBe('本设备');
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(router.dismissTo).toHaveBeenCalledWith('/settings');
  });

  it('has no back button on desktop, where the sidebar stays', () => {
    setViewportWidth(1280);
    renderWith(<SettingsPage title="本设备" />);
    expect(screen.queryByTestId('settings-back')).toBeNull();
    expect(screen.getByTestId('settings-page-title').textContent).toBe('本设备');
  });
});
