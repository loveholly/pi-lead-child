// @vitest-environment jsdom
// 左栏头部的 Fairy（方案 C，2026-10-28，主题 F-4）：π 换成 FairyEye，Lead 在一轮里时在想，离线时灰色，
// 离线和降级时下面一行写说明。
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { leadFairy as railFairy, type LeadPresence } from '../../components/leadPresence';
import { leadBusyFrom } from '../../state/hooks';
import { WorkRail } from './WorkRail';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const online: LeadPresence = { state: 'online', dotColor: 'success', pulse: true, label: 'Paimon 在线', subtitle: '最近巡检 10:24' };
const offline: LeadPresence = { state: 'offline', dotColor: 'text-muted', pulse: false, label: 'Paimon 离线', subtitle: '离线 · 正在重连' };
const degraded: LeadPresence = { state: 'degraded', dotColor: 'warning', pulse: false, label: 'Paimon 降级', subtitle: '模型限流 · 10:30 自动重试' };

describe('railFairy', () => {
  it('thinks while Lead is in a turn and keeps the run count line', () => {
    expect(railFairy(online, true)).toEqual({ state: 'thinking', tone: 'color', note: null });
    expect(railFairy(online, false)).toEqual({ state: 'idle', tone: 'color', note: null });
  });

  it('turns grey and still when Lead is offline, and says why', () => {
    expect(railFairy(offline, true)).toEqual({ state: 'idle', tone: 'quiet', note: '离线 · 正在重连' });
  });

  it('stays in color when degraded but explains the degradation', () => {
    expect(railFairy(degraded, false)).toEqual({ state: 'idle', tone: 'color', note: '模型限流 · 10:30 自动重试' });
  });
});

describe('the Fairy in the rail header', () => {
  it('replaces the π avatar and is named after Lead', () => {
    renderUI(<WorkRail selectedTicketId={null} onSelectTicket={() => {}} leadName="Paimon" fairy={{ state: 'thinking', tone: 'color', note: null }} />);
    const header = screen.getByTestId('work-rail-header');
    expect(within(header).getByRole('img', { name: 'Paimon 在想' })).toBeTruthy();
    expect(within(header).queryByText('π')).toBeNull();
    expect(within(header).getByText('没有 Run 在跑')).toBeTruthy();
  });

  it('shows the presence note instead of the run count when Lead is offline', () => {
    renderUI(<WorkRail selectedTicketId={null} onSelectTicket={() => {}} leadName="Paimon" fairy={{ state: 'idle', tone: 'quiet', note: '离线 · 正在重连' }} />);
    const header = screen.getByTestId('work-rail-header');
    expect(within(header).getByText('离线 · 正在重连')).toBeTruthy();
    expect(within(header).queryByText('没有 Run 在跑')).toBeNull();
  });
});

// 2026-10-28 预览里看到：一轮正常答完以后，概览的 busy 还是 true（概览只在失败、daemon 状态变了时重取），
// 左栏的 Fairy 一直在想。排队在 Lead 开始、结束一轮时都会推过来，以它为准。
describe('leadBusyFrom', () => {
  it('trusts the pushed queue over a stale overview', () => {
    expect(leadBusyFrom({ busy: false }, { busy: true })).toBe(false);
    expect(leadBusyFrom({ busy: true }, { busy: false })).toBe(true);
  });

  it('falls back to the overview when there is no queue yet', () => {
    expect(leadBusyFrom(null, { busy: true })).toBe(true);
    expect(leadBusyFrom(null, null)).toBe(false);
  });
});
