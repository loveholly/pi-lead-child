// @vitest-environment happy-dom
// 工单 #503：工单详情在「验收标准」和「经过与记录」（里面有交付）之间画「核查证据」，标明每张截图对应的标准。
// 点一张小图从这一张打开同一组大图，左右翻页；只有一张时没有翻页；第一张没有「上一张」，最后一张没有「下一张」。
import type { ReviewEvidence, TicketSummary } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignPreferencesProvider } from '@pi-lead-child/components';

import { ticketSummaryToTicket } from '@/features/workspace/model';
import { CompanionRuntimeProvider } from '@/state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '@/state/runtime';

import { renderUI } from '../../../test/render';
import { criteria } from '../../../test/ticketDetail';
import { setViewportWidth, ticket66 } from '../../../test/workbench';
import { TicketThread, type TicketThreadProps } from './TicketThread';
import { resetRememberedSectionsForTesting } from './useRememberedSections';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const shot = (index: number, criterionIds: number[], overrides: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  id: `evd_${index}`, ticketId: 230, attemptId: 41, name: `shot-${index}.png`, mimeType: 'image/png', size: 68,
  criterionIds, caption: `截图 ${index} 的说明`, path: `.scratch/review/shot-${index}.png`, addedBy: 'reviewer',
  createdAt: `2026-11-24T08:0${index}:00.000Z`, ...overrides,
});

function renderThread(props: Partial<TicketThreadProps>, stage: 'review' | 'active' = 'review') {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  const ticket: TicketSummary = ticket66({ id: 230, title: '核查截图', stage, status: stage });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <DesignPreferencesProvider value={{ locale: 'en' }}>
        <TicketThread ticket={ticketSummaryToTicket(ticket)} onClose={() => {}} taskDescription={{ brief: 'b', body: '' }}
          acceptanceCriteria={criteria({ ticketId: 230 })} {...props} />
      </DesignPreferencesProvider>
    </CompanionRuntimeProvider>,
  );
  return screen.getByTestId('ticket-thread');
}

const load = vi.fn(async () => ({ mimeType: 'image/png', data: PNG }));

beforeEach(() => {
  setViewportWidth(1280);
  localStorage.clear();
  resetRememberedSectionsForTesting();
  load.mockClear();
});

afterEach(() => {
  cleanup();
  setViewportWidth(0);
});

describe('review evidence in the ticket detail', () => {
  it('sits between the acceptance criteria and the history, and names the criteria of each screenshot', async () => {
    const thread = renderThread({ reviewEvidence: [shot(1, [1]), shot(2, [3, 2]), shot(3, [99])], onLoadReviewEvidence: load });
    const sections = within(thread).getByTestId('ticket-detail-sections');
    const order = ['ticket-section-criteria', 'ticket-section-evidence', 'ticket-section-history']
      .map((id) => within(sections).getByTestId(id));
    for (let index = 1; index < order.length; index += 1) {
      // eslint-disable-next-line no-bitwise -- DOM 的位掩码
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const evidence = within(thread).getByTestId('ticket-section-evidence');
    // 等你验收时展开。
    expect(within(evidence).getByTestId('ticket-review-evidence-criteria-0').textContent).toBe('Criterion 1');
    expect(within(evidence).getByTestId('ticket-review-evidence-criteria-1').textContent).toBe('Criteria 2, 3');
    expect(within(evidence).getByTestId('ticket-review-evidence-criteria-2').textContent).toBe('A removed criterion');
    expect(within(evidence).getByText('截图 2 的说明')).toBeTruthy();
    await waitFor(() => expect(within(evidence).getByTestId('ticket-review-evidence-thumb-0').querySelector('img')?.getAttribute('src'))
      .toBe(`data:image/png;base64,${PNG}`));
  });

  it('shows a one-line summary when folded, and nothing without evidence', async () => {
    const thread = renderThread({ reviewEvidence: [shot(1, [1]), shot(2, [3])], onLoadReviewEvidence: load }, 'active');
    const evidence = within(thread).getByTestId('ticket-section-evidence');
    expect(within(evidence).getByText('2 screenshots · Criteria 1, 3')).toBeTruthy();
    expect(within(evidence).queryByTestId('ticket-review-evidence')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    cleanup();
    const plain = renderThread({});
    expect(within(plain).queryByTestId('ticket-section-evidence')).toBeNull();
  });

  it('opens the clicked screenshot in the same group, pages left and right, and stops at both ends', async () => {
    const thread = renderThread({ reviewEvidence: [shot(1, [1]), shot(2, [2]), shot(3, [3])], onLoadReviewEvidence: load });
    await act(async () => { fireEvent.click(within(thread).getByTestId('ticket-review-evidence-thumb-1-open')); });
    const viewer = await screen.findByTestId('ticket-review-evidence-viewer');
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-count').textContent).toBe('2 / 3');
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-caption').textContent).toContain('Criterion 2');
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-caption').textContent).toContain('2. 验收标准 2');
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-previous')).toBeTruthy();
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-next')).toBeTruthy();

    await act(async () => { fireEvent.click(within(viewer).getByTestId('ticket-review-evidence-viewer-next')); });
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-count').textContent).toBe('3 / 3');
    expect(within(viewer).queryByTestId('ticket-review-evidence-viewer-next')).toBeNull();

    await act(async () => { fireEvent.click(within(viewer).getByTestId('ticket-review-evidence-viewer-previous')); });
    await act(async () => { fireEvent.click(within(viewer).getByTestId('ticket-review-evidence-viewer-previous')); });
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-count').textContent).toBe('1 / 3');
    expect(within(viewer).queryByTestId('ticket-review-evidence-viewer-previous')).toBeNull();

    await act(async () => { fireEvent.click(within(viewer).getByTestId('ticket-review-evidence-viewer-close')); });
    await waitFor(() => expect(screen.queryByTestId('ticket-review-evidence-viewer')).toBeNull());
    // 关上以后回到证据区。
    expect(within(thread).getByTestId('ticket-review-evidence')).toBeTruthy();
  });

  it('shows no paging for a single screenshot, and says who attached one after the review', async () => {
    const thread = renderThread({ reviewEvidence: [shot(1, [1], { addedBy: 'user' })], onLoadReviewEvidence: load });
    await act(async () => { fireEvent.click(within(thread).getByTestId('ticket-review-evidence-thumb-0-open')); });
    const viewer = await screen.findByTestId('ticket-review-evidence-viewer');
    expect(within(viewer).queryByTestId('ticket-review-evidence-viewer-count')).toBeNull();
    expect(within(viewer).queryByTestId('ticket-review-evidence-viewer-previous')).toBeNull();
    expect(within(viewer).queryByTestId('ticket-review-evidence-viewer-next')).toBeNull();
    expect(within(viewer).getByTestId('ticket-review-evidence-viewer-caption').textContent).toContain('Attached after the review by you');
  });
});
