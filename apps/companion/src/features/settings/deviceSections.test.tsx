// @vitest-environment jsdom
// 设置的「本设备」和「已配对设备」（issue 06）。
// 列出 binding 要 admin scope，普通的 companion 凭证没有它：网关回 403 时只列这台设备，并说明在 Mac 上怎样管理别的设备。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { AdminBinding, BindingDto } from '@pi-lead-child/protocol';
import { fireEvent, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { ControlPlanePhase } from '../../state/types';
import { DeviceSection } from './DeviceSection';
import { DevicesSection } from './DevicesSection';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => router }));

const thisDevice: BindingDto = { id: 7, kind: 'companion', name: 'localhost-web', scopes: ['chat', 'tickets:view', 'tickets:create'] };

function admin(binding: Partial<AdminBinding> & Pick<AdminBinding, 'id' | 'kind' | 'name'>): AdminBinding {
  return { status: 'active', scopes: ['chat'], lastSeenAt: null, createdAt: '2026-10-01T00:00:00.000Z', ...binding };
}

type FakeClient = {
  getOwnBinding: ReturnType<typeof vi.fn>;
  listBindings: ReturnType<typeof vi.fn>;
  revokeBinding: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
};

function setup(client: Partial<FakeClient>, phase: ControlPlanePhase = 'ready') {
  const fake: FakeClient = {
    getOwnBinding: vi.fn(async () => thisDevice),
    listBindings: vi.fn(async () => []),
    revokeBinding: vi.fn(async (id: number) => admin({ id, kind: 'cli', name: 'plc', status: 'revoked' })),
    forget: vi.fn(async () => {}),
    ...client,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  // 配对时保存的凭证。真实运行时由 credentials.load() 读出。
  (runtime as unknown as { credentials: unknown }).credentials = {
    baseUrl: 'http://127.0.0.1:47130', accessToken: '', binding: thisDevice, lastSeq: 0,
  };
  runtime.control.setState({ phase, connectionState: phase === 'ready' ? 'connected' : 'disconnected' });
  return { fake, runtime };
}

function render(element: ReactElement, runtime: ReturnType<typeof setup>['runtime']) {
  renderUI(<CompanionRuntimeProvider runtime={runtime}>{element}</CompanionRuntimeProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe('paired devices without the admin scope', () => {
  it('shows only this device and how to manage the others from the Mac', async () => {
    const { runtime, fake } = setup({
      listBindings: vi.fn(async () => { throw new ControlPlaneClientError('missing scope: admin', 'forbidden', 403); }),
    });
    render(<DevicesSection />, runtime);

    const hint = await screen.findByTestId('devices-cli-hint');
    // 这两个命令是 apps/cli 里真实的 plc pair 子命令。
    expect(hint.textContent).toContain('plc pair list');
    expect(hint.textContent).toContain('plc pair revoke <编号>');
    const list = screen.getByTestId('devices-list');
    expect(within(list).getAllByTestId(/^device-row-/).map((row) => row.getAttribute('data-testid'))).toEqual(['device-row-7']);
    expect(within(screen.getByTestId('device-row-7')).getByText('localhost-web')).toBeTruthy();
    expect(within(screen.getByTestId('device-row-7')).getByText('本设备')).toBeTruthy();
    expect(within(screen.getByTestId('device-row-7')).getByText('Companion · 在线')).toBeTruthy();
    expect(screen.queryByTestId(/^device-revoke-/)).toBeNull();
    expect(fake.listBindings).toHaveBeenCalledTimes(1);
  });

  it('shows the error with a retry for other failures', async () => {
    const { runtime, fake } = setup({ listBindings: vi.fn(async () => { throw new Error('network down'); }) });
    render(<DevicesSection />, runtime);
    expect((await screen.findByTestId('devices-error')).textContent).toContain('读不到已配对设备：network down');
    fireEvent.click(screen.getByText('重试'));
    expect(fake.listBindings).toHaveBeenCalledTimes(2);
  });
});

describe('paired devices with the admin scope', () => {
  const items = [
    admin({ id: 3, kind: 'cli', name: 'plc', lastSeenAt: '2026-10-16T01:02:00.000Z' }),
    admin({ id: 7, kind: 'companion', name: 'localhost-web' }),
    admin({ id: 9, kind: 'companion', name: 'iPhone', status: 'revoked' }),
  ];

  it('lists every binding with this device first and marked, and never offers to revoke it', async () => {
    const { runtime } = setup({ listBindings: vi.fn(async () => items) });
    render(<DevicesSection />, runtime);

    await screen.findByTestId('device-row-3');
    const rows = within(screen.getByTestId('devices-list')).getAllByTestId(/^device-row-\d+$/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['device-row-7', 'device-row-3', 'device-row-9']);
    expect(within(rows[0]!).getByText('本设备')).toBeTruthy();
    expect(screen.queryByTestId('device-revoke-7')).toBeNull();
    expect(within(rows[1]!).getByText(/^plc 命令行 · 上次在线 /)).toBeTruthy();
    expect(screen.getByTestId('device-revoke-3')).toBeTruthy();
    expect(within(rows[2]!).getByText('已撤销')).toBeTruthy();
    expect(screen.queryByTestId('device-revoke-9')).toBeNull();
  });

  it('asks again inline before it revokes, then reloads the list', async () => {
    const { runtime, fake } = setup({ listBindings: vi.fn(async () => items) });
    render(<DevicesSection />, runtime);

    fireEvent.click(await screen.findByTestId('device-revoke-3'));
    const confirm = screen.getByTestId('device-revoke-confirm-3');
    expect(confirm.textContent).toContain('撤销以后，「plc」要重新配对才能再用。');
    expect(fake.revokeBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('device-revoke-confirm-button-3'));
    await vi.waitFor(() => expect(fake.revokeBinding).toHaveBeenCalledWith(3));
    await vi.waitFor(() => expect(fake.listBindings).toHaveBeenCalledTimes(2));
  });

  it('cancels the inline confirmation without revoking', async () => {
    const { runtime, fake } = setup({ listBindings: vi.fn(async () => items) });
    render(<DevicesSection />, runtime);

    fireEvent.click(await screen.findByTestId('device-revoke-3'));
    fireEvent.click(within(screen.getByTestId('device-revoke-confirm-3')).getByText('取消'));
    expect(screen.queryByTestId('device-revoke-confirm-3')).toBeNull();
    expect(fake.revokeBinding).not.toHaveBeenCalled();
  });

  it('refuses to revoke this device even when asked directly', async () => {
    const { runtime, fake } = setup({});
    await expect(runtime.revokeBinding(7)).rejects.toThrow('cannot revoke this device from itself');
    expect(fake.revokeBinding).not.toHaveBeenCalled();
  });
});

describe('This device', () => {
  it('shows the paired state with this binding’s name and kind from the daemon', async () => {
    const { runtime, fake } = setup({
      getOwnBinding: vi.fn(async () => ({ ...thisDevice, name: 'Mac 上的网页', kind: 'desktop' })),
    });
    render(<DeviceSection />, runtime);

    expect(screen.getByText('已配对')).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByTestId('device-name').textContent).toBe('Mac 上的网页'));
    expect(screen.getByTestId('device-kind').textContent).toBe('桌面');
    expect(screen.getByTestId('device-daemon').textContent).toBe('在线');
    expect(screen.getByTestId('pair-forget')).toBeTruthy();
    expect(fake.getOwnBinding).toHaveBeenCalledTimes(1);
  });

  it('shows the endpoint mismatch error', () => {
    const { runtime } = setup({});
    runtime.control.setState({
      endpointMismatch: { configuredEndpoint: 'http://127.0.0.1:47131', activeEndpoint: 'http://127.0.0.1:47130', error: 'refused' },
    });
    render(<DeviceSection />, runtime);
    expect(screen.getByText(/配置的本机 daemon http:\/\/127.0.0.1:47131 无法配对（refused）/)).toBeTruthy();
  });

  it('removes the credential and then offers to pair again on the pairing page', async () => {
    const { runtime, fake } = setup({});
    render(<DeviceSection />, runtime);

    fireEvent.click(screen.getByTestId('pair-forget'));
    await vi.waitFor(() => expect(fake.forget).toHaveBeenCalledTimes(1));
    await screen.findByTestId('settings-unpaired');
    fireEvent.click(screen.getByTestId('settings-pair'));
    expect(router.push).toHaveBeenCalledWith('/pair');
  });

  it('does not ask the daemon who it is before the device is paired', () => {
    const { runtime, fake } = setup({}, 'unpaired');
    render(<DeviceSection />, runtime);
    expect(screen.getByText('配对 Paimon')).toBeTruthy();
    expect(fake.getOwnBinding).not.toHaveBeenCalled();
  });
});
