// @vitest-environment jsdom
// 会话顶栏的 Lead 名字：已经配对时打开设置的「本设备」，还没配对时照旧打开配对页（issue 06）。
// 手机上没有第五个 tab，这里就是设置的入口。
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../test/render';
import { CompanionRuntimeProvider } from '../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../state/runtime';
import type { ControlPlanePhase } from '../state/types';
import { LeadIdentity } from './LeadIdentity';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => router }));

function renderIdentity(phase: ControlPlanePhase) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase, connectionState: phase === 'ready' ? 'connected' : 'disconnected' });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadIdentity /></CompanionRuntimeProvider>);
}

beforeEach(() => router.push.mockClear());

describe('the Paimon identity', () => {
  it('opens This device in settings when the device is paired', () => {
    renderIdentity('ready');
    fireEvent.click(screen.getByTestId('lead-identity'));
    expect(router.push).toHaveBeenCalledWith('/settings/device');
  });

  it('also opens settings while a paired device reconnects', () => {
    renderIdentity('connecting');
    fireEvent.click(screen.getByTestId('lead-identity'));
    expect(router.push).toHaveBeenCalledWith('/settings/device');
  });

  it('opens the pairing page when the device is not paired', () => {
    renderIdentity('unpaired');
    fireEvent.click(screen.getByTestId('lead-identity'));
    expect(router.push).toHaveBeenCalledWith('/pair');
    // 设备和 daemon 之间叫「配对」（D2）。
    expect(screen.getByText('未配对 · 点击配对')).toBeTruthy();
  });
});
