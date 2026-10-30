// @vitest-environment jsdom
// 桌面上设置的入口：侧栏头部「Paimon / N 个 Run 在跑」一行右边的齿轮（issue 06）。按真实的 Workbench 渲染。
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { renderWorkbenchWithTicket, setViewportWidth, ticket66 } from '../../../test/workbench';
import { WorkRail } from './WorkRail';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => router }));

beforeEach(() => router.push.mockClear());
afterEach(() => setViewportWidth(1024));

describe('the settings gear in the rail header', () => {
  it('sits in the Paimon row and opens settings', () => {
    renderWorkbenchWithTicket(ticket66(), { width: 1280 });
    const header = screen.getByTestId('work-rail-header');
    expect(within(header).getByText('Paimon')).toBeTruthy();
    const gear = within(header).getByTestId('open-settings');
    expect(gear.getAttribute('aria-label')).toBe('设置');

    fireEvent.click(gear);
    expect(router.push).toHaveBeenCalledWith('/settings');
  });

  it('is not shown when the rail has no settings action', () => {
    renderUI(<WorkRail selectedTicketId={null} onSelectTicket={() => {}} />);
    expect(screen.getByTestId('work-rail-header')).toBeTruthy();
    expect(screen.queryByTestId('open-settings')).toBeNull();
  });
});
