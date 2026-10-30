// 后台检查的列表（.scratch/lead-watch/spec.md D5）：状态层读 GET /v1/timers/watches。旧的客户端没有这个方法时，
// 返回失败的 Promise，不同步抛错：工作台的提醒卡接住它，当作没有后台检查，其他行照常显示。
import type { WatchTimerDto } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from './runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

function timerRuntime(client: Record<string, unknown>) {
  return createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
}

const check: WatchTimerDto = {
  ref: 'watch:3', title: '盯 clime 登录', check: 'command', schedule: '每 10 秒查一次，最晚到 10-28 14:38',
  nextAt: '2026-10-28T06:30:10.000Z', running: false, lastStatus: null, lastCheckedAt: null, setBy: 'user', requester: null,
};

describe('background checks in the state layer', () => {
  it('reads the waiting checks from the client', async () => {
    const watchTimers = vi.fn(async () => [check]);
    const controller = new AbortController();
    await expect(timerRuntime({ watchTimers }).watchTimers(controller.signal)).resolves.toEqual([check]);
    expect(watchTimers).toHaveBeenCalledWith(controller.signal);
  });

  it('rejects instead of throwing when the client cannot read them', async () => {
    const runtime = timerRuntime({});
    let result: Promise<WatchTimerDto[]> | undefined;
    expect(() => { result = runtime.watchTimers(); }).not.toThrow();
    await expect(result).rejects.toThrow('this client cannot read timers');
  });
});
