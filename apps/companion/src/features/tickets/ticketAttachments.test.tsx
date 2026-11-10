// @vitest-environment happy-dom
// 工单 #231：工单详情的任务说明下面显示附件的缩略图，点开在面板里看大图；外部来源的附件写明来源。
import type { TicketAttachment, TicketSummary } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignPreferencesProvider } from '@pi-lead-child/components';

import { ticketSummaryToTicket } from '@/features/workspace/model';
import { CompanionRuntimeProvider } from '@/state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '@/state/runtime';

import { renderUI } from '../../../test/render';
import { setViewportWidth, ticket66 } from '../../../test/workbench';
import { TicketThread, type TicketThreadProps } from './TicketThread';
import { resetRememberedSectionsForTesting } from './useRememberedSections';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const shot: TicketAttachment = {
  id: 'att_shot', ticketId: 230, name: 'screenshot.png', kind: 'image', mimeType: 'image/png', size: 68, sourceRef: 'slack:F0SHOT',
  origin: { kind: 'external', source: 'slack', conversation: '#returns', message: 'C0RET/1730700000.000100', sender: 'Ethan' },
  createdAt: '2026-11-04T08:00:00.000Z',
};
const note: TicketAttachment = {
  id: 'att_note', ticketId: 230, name: 'steps.txt', kind: 'text', mimeType: 'text/plain', size: 12, sourceRef: 'img_note',
  origin: { kind: 'user', source: 'chat' }, createdAt: '2026-11-04T08:01:00.000Z',
};

function summary(overrides: Partial<TicketSummary>): TicketSummary {
  return ticket66({ id: 230, title: 'Ethan 反馈的退货页问题', ...overrides });
}

function renderThread(ticket: TicketSummary, props: Partial<TicketThreadProps> = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <DesignPreferencesProvider value={{ locale: 'en' }}>
        <TicketThread ticket={ticketSummaryToTicket(ticket)} onClose={() => {}} taskDescription={{ brief: '看截图里的报错。', body: '' }} {...props} />
      </DesignPreferencesProvider>
    </CompanionRuntimeProvider>,
  );
  return screen.getByTestId('ticket-thread');
}

const load = vi.fn(async (id: string) => (id === 'att_shot'
  ? { mimeType: 'image/png', data: PNG }
  : { mimeType: 'text/plain', data: Buffer.from('第一步：打开退货页').toString('base64') }));

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

describe('ticket attachments in the ticket detail', () => {
  it('shows a thumbnail under the task and opens the large image with its source', async () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { attachments: [shot, note], onLoadAttachment: load });
    const strip = within(thread).getByTestId('ticket-attachments');
    expect(within(within(thread).getByTestId('ticket-section-task')).getByTestId('ticket-attachments')).toBe(strip);
    expect(within(strip).getByText('2 attachments')).toBeTruthy();
    await waitFor(() => expect(within(strip).getByTestId('ticket-attachment-0').querySelector('img')?.getAttribute('src'))
      .toBe(`data:image/png;base64,${PNG}`));
    expect(within(strip).getByLabelText('steps.txt, open the file')).toBeTruthy();

    await act(async () => { fireEvent.click(within(strip).getByTestId('ticket-attachment-0-open')); });
    const viewer = await screen.findByTestId('ticket-attachment-viewer');
    expect(within(viewer).getByText('screenshot.png')).toBeTruthy();
    expect(within(viewer).getByText('From Slack · #returns · Ethan')).toBeTruthy();
    expect(within(viewer).getByText(/Other people wrote this\./)).toBeTruthy();
    await waitFor(() => expect(within(viewer).getByTestId('ticket-attachment-viewer-image').querySelector('img')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('ticket-attachment-viewer-close')); });
    await waitFor(() => expect(screen.queryByTestId('ticket-attachment-viewer')).toBeNull());
  });

  it('opens a text attachment as text, without the external note for your own file', async () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { attachments: [note], onLoadAttachment: load });
    await act(async () => { fireEvent.click(within(thread).getByLabelText('steps.txt, open the file')); });
    const viewer = await screen.findByTestId('ticket-attachment-viewer');
    expect(within(viewer).getByText('You sent it in the conversation')).toBeTruthy();
    expect(within(viewer).queryByText(/Other people wrote this\./)).toBeNull();
    await waitFor(() => expect(within(viewer).getByText('第一步：打开退货页')).toBeTruthy());
  });

  it('counts the attachments in the folded task line, and draws nothing without attachments', () => {
    const review = renderThread(summary({ stage: 'review', status: 'review' }), { attachments: [shot, note], onLoadAttachment: load });
    expect(within(within(review).getByTestId('ticket-section-task')).getByText('看截图里的报错。 · 2 attachments')).toBeTruthy();
    cleanup();
    const plain = renderThread(summary({ stage: 'active', status: 'active' }));
    expect(within(plain).queryByTestId('ticket-attachments')).toBeNull();
  });
});
