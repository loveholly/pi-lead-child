// @vitest-environment jsdom
// 工单详情的头部（工单 12，spec 4.1）：编号、完整标题（可以换行，不截断）、状态、优先级、项目。
// #66 的标题前面有「[E2E #51 T48-…]」：头部照原样写完整标题，不再拆进「详情」。
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWorkbenchWithTicket, setViewportWidth, ticket66 } from '../../../test/workbench';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => setViewportWidth(0));

describe('the ticket header', () => {
  it('shows the number, the full title, the stage, the priority and the project', () => {
    const title = '[E2E #51 T48-E2E-51-20260817061106] FINAL #45 implementation - outcome snapshot and registry mechanism';
    renderWorkbenchWithTicket(ticket66({ title }));
    const header = within(screen.getByTestId('ticket-thread')).getByTestId('ticket-thread-header');

    expect(within(header).getByTestId('ticket-thread-header-title').textContent).toBe(title);
    expect(header.textContent).toContain('#66');
    expect(within(header).getByTestId('ticket-thread-header-meta').textContent).toContain('pi-lead-child');
    // 去掉了「这张工单」这一层标题。
    expect(within(screen.getByTestId('ticket-thread')).queryByText('这张工单')).toBeNull();
  });
});
