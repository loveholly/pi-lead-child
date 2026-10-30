// @vitest-environment jsdom
// 原生应用本身就是手机：设置 → 设备里不显示「添加手机」。组件测试在 react-native-web 上渲染，
// 这里把 isWeb 换成 false，模拟 iOS 和 Android 上的同一棵组件树。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { BindingDto } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { DevicesSection } from './DevicesSection';

vi.mock('@pi-lead-child/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pi-lead-child/components')>()),
  isWeb: false,
}));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() }) }));

const thisDevice: BindingDto = { id: 7, kind: 'companion', name: 'iPhone', scopes: ['chat', 'tickets:view'] };

describe('the devices settings on a phone', () => {
  it('lists this device without the add-phone entry', async () => {
    const createLoopbackInvitation = vi.fn();
    const client = {
      getOwnBinding: vi.fn(async () => thisDevice),
      listBindings: vi.fn(async () => { throw new ControlPlaneClientError('missing scope: admin', 'forbidden', 403); }),
      revokeBinding: vi.fn(),
      forget: vi.fn(async () => {}),
      createLoopbackInvitation,
      getLoopbackInvitationStatus: vi.fn(),
    };
    const runtime = createCompanionStateRuntime({
      client: client as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    (runtime as unknown as { credentials: unknown }).credentials = {
      baseUrl: 'http://192.168.1.20:47130', accessToken: '', binding: thisDevice, lastSeq: 0,
    };
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><DevicesSection /></CompanionRuntimeProvider>);

    expect(await screen.findByTestId('devices-cli-hint')).toBeTruthy();
    expect(screen.getByTestId('device-row-7')).toBeTruthy();
    expect(screen.queryByTestId('add-phone')).toBeNull();
    expect(screen.queryByText('添加手机')).toBeNull();
    expect(createLoopbackInvitation).not.toHaveBeenCalled();
  });
});
