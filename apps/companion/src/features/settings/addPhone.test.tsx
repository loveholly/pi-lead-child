// @vitest-environment jsdom
// 设置 → 设备 → 添加手机（web）：生成配对二维码、倒计时、过期后重新生成、手机兑换后显示已配对。
// 邀请 URI 是凭证：页面上只画二维码，不出现 URI 的文字。原生端不显示入口（见 addPhoneNative.test.tsx）。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { BindingDto, LoopbackInvitation, LoopbackInvitationStatus } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { DevicesSection } from './DevicesSection';
import { countdownLabel, endpointLabel, phoneNameError, qrModuleSize } from './phonePairingModel';
import { INVITATION_POLL_MS } from './usePhoneInvitation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() }) }));

const NOW = new Date('2026-10-17T04:00:00.000Z');
const thisDevice: BindingDto = { id: 7, kind: 'companion', name: 'localhost-web', scopes: ['chat', 'tickets:view'] };
// 测试用的假邀请，不是能用的凭证。
const FAKE_URI = 'plc-pair://connect?v=2&pairing_id=12&secret=test-only';

function invitation(overrides: Partial<LoopbackInvitation> = {}): LoopbackInvitation {
  return {
    pairingId: 12,
    expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    uri: FAKE_URI,
    qr: { size: 21, rows: Array.from({ length: 21 }, (_, y) => (y % 2 ? '10' : '01').repeat(11).slice(0, 21)) },
    endpoint: 'ws://192.168.1.20:47130',
    endpoints: ['ws://192.168.1.20:47130'],
    ...overrides,
  };
}

function status(state: LoopbackInvitationStatus['state'], pairingId = 12): LoopbackInvitationStatus {
  return { pairingId, state, expiresAt: invitation().expiresAt };
}

function setup(client: Record<string, unknown> = {}) {
  const fake = {
    getOwnBinding: vi.fn(async () => thisDevice),
    listBindings: vi.fn(async () => { throw new ControlPlaneClientError('missing scope: admin', 'forbidden', 403); }),
    revokeBinding: vi.fn(),
    forget: vi.fn(async () => {}),
    createLoopbackInvitation: vi.fn(async () => invitation()),
    getLoopbackInvitationStatus: vi.fn(async () => status('pending')),
    cancelLoopbackInvitation: vi.fn(async (pairingId: number) => status('revoked', pairingId)),
    ...client,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { credentials: unknown }).credentials = {
    baseUrl: 'http://127.0.0.1:47130', accessToken: '', binding: thisDevice, lastSeq: 0,
  };
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  const rendered = renderUI(<CompanionRuntimeProvider runtime={runtime}><DevicesSection /></CompanionRuntimeProvider>);
  return Object.assign(fake, { unmount: rendered.unmount });
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// 页面生成和作废邀请时不传 AbortSignal（见 usePhoneInvitation），这里只比较第一个参数。
type Fake = ReturnType<typeof setup>;
const createdWith = (fake: Fake) => (fake.createLoopbackInvitation.mock.calls as unknown[][]).map((call) => call[0]);
const cancelledIds = (fake: Fake) => (fake.cancelLoopbackInvitation.mock.calls as unknown[][]).map((call) => call[0]);

async function openAndCreate() {
  await flush();
  fireEvent.click(screen.getByTestId('add-phone'));
  fireEvent.click(screen.getByTestId('add-phone-create'));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('adding a phone from the web settings', () => {
  it('shows the entry next to the device list, with the default name', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('devices-list')).toBeTruthy();
    expect(screen.getByTestId('add-phone').textContent).toBe('添加手机');
    expect(screen.queryByTestId('add-phone-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('add-phone'));
    expect((screen.getByTestId('add-phone-name') as HTMLInputElement).value).toBe('手机');
    expect(screen.getByTestId('add-phone-panel').textContent).toContain('扫描局域网配对码');
  });

  it('creates an invitation and shows its QR code, countdown and address, but never the URI', async () => {
    const fake = setup();
    await openAndCreate();

    expect(createdWith(fake)).toEqual([{ name: '手机' }]);
    const qr = screen.getByTestId('add-phone-qr');
    expect(qr.getAttribute('aria-label')).toBe('配对「手机」的二维码');
    expect(qr.children.length).toBeGreaterThan(0);
    expect(screen.getByTestId('add-phone-countdown').textContent).toBe('15:00 后过期');
    expect(screen.getByTestId('add-phone-endpoint').textContent).toBe('地址 192.168.1.20:47130');
    expect(document.body.textContent).not.toContain('plc-pair://');
    expect(document.body.innerHTML).not.toContain(FAKE_URI);
  });

  it('counts down while the invitation waits', async () => {
    setup();
    await openAndCreate();
    await flush(1_000);
    expect(screen.getByTestId('add-phone-countdown').textContent).toBe('14:59 后过期');
    await flush(60_000);
    expect(screen.getByTestId('add-phone-countdown').textContent).toBe('13:59 后过期');
  });

  it('expires after 15 minutes, stops polling, and regenerates with one click', async () => {
    const fake = setup();
    await openAndCreate();
    await flush(15 * 60_000);

    expect(screen.queryByTestId('add-phone-qr')).toBeNull();
    expect(screen.getByTestId('add-phone-expired').textContent).toContain('二维码已过期');
    const polls = fake.getLoopbackInvitationStatus.mock.calls.length;
    await flush(INVITATION_POLL_MS * 3);
    expect(fake.getLoopbackInvitationStatus.mock.calls.length).toBe(polls);

    fake.createLoopbackInvitation.mockResolvedValueOnce(invitation({
      pairingId: 13, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }));
    fireEvent.click(screen.getByTestId('add-phone-regenerate'));
    await flush();
    expect(createdWith(fake).at(-1)).toEqual({ name: '手机', endpoint: 'ws://192.168.1.20:47130' });
    expect(screen.getByTestId('add-phone-qr')).toBeTruthy();
    expect(screen.getByTestId('add-phone-countdown').textContent).toBe('15:00 后过期');
  });

  it('treats an expired or unknown invitation reported by the gateway as expired', async () => {
    const fake = setup({
      getLoopbackInvitationStatus: vi.fn(async () => { throw new ControlPlaneClientError('invitation not found', 'not_found', 404); }),
    });
    await openAndCreate();
    await flush(INVITATION_POLL_MS);
    expect(fake.getLoopbackInvitationStatus).toHaveBeenCalledWith(12, expect.any(AbortSignal));
    expect(screen.getByTestId('add-phone-expired')).toBeTruthy();
  });

  it('shows the phone as paired once it redeems the invitation, and reloads the device list', async () => {
    const fake = setup();
    fake.getLoopbackInvitationStatus
      .mockResolvedValueOnce(status('pending'))
      .mockResolvedValueOnce(status('redeemed'));
    await openAndCreate();
    expect(fake.listBindings).toHaveBeenCalledTimes(1);

    await flush(INVITATION_POLL_MS);
    expect(screen.getByTestId('add-phone-qr')).toBeTruthy();
    await flush(INVITATION_POLL_MS);
    expect(screen.getByTestId('add-phone-paired').textContent).toContain('「手机」已配对。');
    expect(screen.queryByTestId('add-phone-qr')).toBeNull();
    expect(fake.listBindings).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('add-phone-done'));
    expect(screen.queryByTestId('add-phone-panel')).toBeNull();
    expect(screen.getByTestId('add-phone')).toBeTruthy();
  });

  it('keeps polling through a network blip', async () => {
    const fake = setup();
    fake.getLoopbackInvitationStatus
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(status('redeemed'));
    await openAndCreate();
    await flush(INVITATION_POLL_MS);
    expect(screen.getByTestId('add-phone-qr')).toBeTruthy();
    await flush(INVITATION_POLL_MS);
    expect(screen.getByTestId('add-phone-paired')).toBeTruthy();
  });

  it('uses the name the user typed, and refuses an empty one', async () => {
    const fake = setup();
    await flush();
    fireEvent.click(screen.getByTestId('add-phone'));
    const field = screen.getByTestId('add-phone-name');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByTestId('add-phone-name-error').textContent).toBe('请填写设备名');
    expect(screen.getByTestId('add-phone-create').getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(field, { target: { value: '  Pixel 9  ' } });
    expect(screen.queryByTestId('add-phone-name-error')).toBeNull();
    fireEvent.click(screen.getByTestId('add-phone-create'));
    await flush();
    expect(createdWith(fake)).toEqual([{ name: 'Pixel 9' }]);
    expect(screen.getByTestId('add-phone-qr').getAttribute('aria-label')).toBe('配对「Pixel 9」的二维码');
  });

  it('lets the user pick another LAN address, which regenerates the invitation', async () => {
    const endpoints = ['ws://192.168.1.20:47130', 'ws://100.101.102.103:47130'];
    const fake = setup({ createLoopbackInvitation: vi.fn(async () => invitation({ endpoints })) });
    await openAndCreate();
    expect(screen.getByTestId('add-phone-endpoint-192.168.1.20:47130').getAttribute('aria-pressed')).toBe('true');

    fake.createLoopbackInvitation.mockResolvedValueOnce(invitation({ pairingId: 13, endpoint: endpoints[1], endpoints }));
    fireEvent.click(screen.getByTestId('add-phone-endpoint-100.101.102.103:47130'));
    await flush();
    expect(createdWith(fake).at(-1)).toEqual({ name: '手机', endpoint: 'ws://100.101.102.103:47130' });
    expect(screen.getByTestId('add-phone-endpoint-100.101.102.103:47130').getAttribute('aria-pressed')).toBe('true');
  });

  it('copies the invitation without showing it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    setup();
    await openAndCreate();
    fireEvent.click(screen.getByTestId('add-phone-copy'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(FAKE_URI);
    expect(screen.getByTestId('add-phone-copy').textContent).toBe('已复制');
    expect(document.body.textContent).not.toContain('plc-pair://');
  });

  it('explains how to reach the phone when the gateway listens on loopback only', async () => {
    setup({
      createLoopbackInvitation: vi.fn(async () => {
        throw new ControlPlaneClientError('the gateway does not listen on a LAN address', 'conflict', 409);
      }),
    });
    await openAndCreate();
    expect(screen.getByTestId('add-phone-error').textContent).toContain('PLC_GATEWAY_HOST 和 PLC_GATEWAY_PORT');
    // 表单还在，可以再试。
    expect(screen.getByTestId('add-phone-create')).toBeTruthy();
    expect(document.body.textContent).not.toContain('plc-pair://');
  });

  it('stops polling when the panel closes', async () => {
    const fake = setup();
    await openAndCreate();
    fireEvent.click(screen.getByTestId('add-phone-close'));
    await flush(INVITATION_POLL_MS * 3);
    expect(fake.getLoopbackInvitationStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('add-phone-panel')).toBeNull();
  });
});

describe('cancelling the invitation the page no longer shows', () => {
  it('cancels the shown invitation when the panel closes', async () => {
    const fake = setup();
    await openAndCreate();
    expect(fake.cancelLoopbackInvitation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('add-phone-close'));
    await flush();
    expect(cancelledIds(fake)).toEqual([12]);
  });

  it('cancels the old invitation before it creates the new one on regenerate', async () => {
    const fake = setup();
    await openAndCreate();
    await flush(15 * 60_000);
    fake.createLoopbackInvitation.mockResolvedValueOnce(invitation({
      pairingId: 13, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }));
    fireEvent.click(screen.getByTestId('add-phone-regenerate'));
    await flush();
    expect(cancelledIds(fake)).toEqual([12]);
    expect(fake.cancelLoopbackInvitation.mock.invocationCallOrder[0])
      .toBeLessThan(fake.createLoopbackInvitation.mock.invocationCallOrder[1]!);
    expect(screen.getByTestId('add-phone-qr')).toBeTruthy();

    // 关闭时作废的是新的那一份。
    fireEvent.click(screen.getByTestId('add-phone-close'));
    await flush();
    expect(cancelledIds(fake)).toEqual([12, 13]);
  });

  it('cancels the old invitation when the user picks another address', async () => {
    const endpoints = ['ws://192.168.1.20:47130', 'ws://100.101.102.103:47130'];
    const fake = setup({ createLoopbackInvitation: vi.fn(async () => invitation({ endpoints })) });
    await openAndCreate();
    fake.createLoopbackInvitation.mockResolvedValueOnce(invitation({ pairingId: 13, endpoint: endpoints[1], endpoints }));
    fireEvent.click(screen.getByTestId('add-phone-endpoint-100.101.102.103:47130'));
    await flush();
    expect(cancelledIds(fake)).toEqual([12]);
  });

  it('cancels the shown invitation when the page goes away', async () => {
    const fake = setup();
    await openAndCreate();
    fake.unmount();
    await flush();
    expect(cancelledIds(fake)).toEqual([12]);
  });

  it('cancels an invitation that arrives after the panel closed', async () => {
    let resolve: (value: LoopbackInvitation) => void = () => {};
    const fake = setup({ createLoopbackInvitation: vi.fn(() => new Promise<LoopbackInvitation>((done) => { resolve = done; })) });
    await flush();
    fireEvent.click(screen.getByTestId('add-phone'));
    fireEvent.click(screen.getByTestId('add-phone-create'));
    fireEvent.click(screen.getByTestId('add-phone-close'));
    await act(async () => { resolve(invitation({ pairingId: 21 })); });
    await flush();
    expect(cancelledIds(fake)).toEqual([21]);
    expect(screen.queryByTestId('add-phone-panel')).toBeNull();
  });

  it('does not cancel an invitation the phone redeemed', async () => {
    const fake = setup({ getLoopbackInvitationStatus: vi.fn(async () => status('redeemed')) });
    await openAndCreate();
    await flush(INVITATION_POLL_MS);
    expect(screen.getByTestId('add-phone-paired')).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-phone-done'));
    fake.unmount();
    await flush();
    expect(fake.cancelLoopbackInvitation).not.toHaveBeenCalled();
  });

  it('keeps the page working when the gateway cannot cancel', async () => {
    const fake = setup({
      cancelLoopbackInvitation: vi.fn(async () => { throw new ControlPlaneClientError('Failed to fetch', 'network'); }),
    });
    await openAndCreate();
    fireEvent.click(screen.getByTestId('add-phone-close'));
    await flush();
    expect(cancelledIds(fake)).toEqual([12]);
    expect(screen.queryByTestId('add-phone-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('add-phone'));
    fireEvent.click(screen.getByTestId('add-phone-create'));
    await flush();
    expect(screen.getByTestId('add-phone-qr')).toBeTruthy();
    expect(screen.queryByTestId('add-phone-error')).toBeNull();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });
});

describe('phone pairing model', () => {
  it('formats the countdown, the address and the module size', () => {
    expect(countdownLabel(15 * 60_000)).toBe('15:00');
    expect(countdownLabel(59_001)).toBe('1:00');
    expect(countdownLabel(500)).toBe('0:01');
    expect(countdownLabel(-5)).toBe('0:00');
    expect(endpointLabel('ws://192.168.1.20:47130')).toBe('192.168.1.20:47130');
    expect(qrModuleSize(21)).toBe(10);
    expect(qrModuleSize(61)).toBe(4);
    expect(qrModuleSize(177)).toBe(3);
  });

  it('checks the name the way the gateway does', () => {
    expect(phoneNameError('手机')).toBeNull();
    expect(phoneNameError(' ')).toBe('请填写设备名');
    expect(phoneNameError('手机\n伪造')).toBe('设备名不能包含换行等控制字符');
    expect(phoneNameError('长'.repeat(80))).toBeNull();
    expect(phoneNameError('长'.repeat(81))).toBe('设备名最多 80 个字符');
  });
});
