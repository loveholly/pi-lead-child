// @vitest-environment jsdom
// 审查发现（3688968）：失败行和提醒卡的单元测试只测了函数本身，没有锁住界面怎样把数据接进去。
// 这里从界面渲染：去掉 LeadConversation 传给失败行的 tools，「重发」会回来，这里就失败；
// 会话里提到提醒的另外两处（消息里的工单部件、Lead 画的卡片里的 TicketRef）也画成提醒、去日程。
import {
  LEAD_RESTART_INTERRUPTED_ERROR, type ConversationTurn, type Overview, type TicketDetail, type TicketSummary, type UiSurface,
} from '@pi-lead-child/protocol';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { setViewportWidth } from '../../../test/workbench';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { SurfaceView } from '../genui/SurfaceView';
import { LeadConversation } from './LeadConversation';
import { MessagePartView } from './MessagePartView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const REMIND_AT = new Date(2026, 9, 19, 9, 0).toISOString();

const overview: Overview = {
  model: 'stub', sessionId: SESSION, busy: false, runningTicketIds: [],
  counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
  aish: null,
};

function reminderDetail(): TicketDetail {
  const ticket: TicketSummary = {
    id: 83, title: '关注 aish PR86 是否合并', summary: '', kind: 'reminder', hasRun: false, priority: 'normal',
    project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-16T07:57:03.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'scheduled', status: 'scheduled',
  };
  return {
    ticket, brief: '', body: '', workdir: null, createdAt: '2026-10-16T07:57:03.000Z',
    totalTokens: 0, totalCostUsd: 0, remindAt: REMIND_AT, createdBy: 'lead',
  };
}

function runtimeWith(getTicket: () => Promise<TicketDetail> = async () => reminderDetail()) {
  const runtime = createCompanionStateRuntime({
    client: { getTicket: vi.fn(getTicket) } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview });
  return runtime;
}

describe('the failure row in the Lead conversation', () => {
  // 2026-10-16 的那一轮：提醒建好了，回复因为模型失败没完成。失败行说提醒建好了，不给「重发」。
  it('gets the turn tools, so it names the reminder and offers no resend', async () => {
    const runtime = runtimeWith();
    const sendChat = vi.fn(async () => ({ clientMessageId: 'resent' }));
    runtime.sendChat = sendChat as typeof runtime.sendChat;
    const turn: ConversationTurn = {
      id: 'turn-83', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'failed',
      userText: '提醒我下周一早上关注 aish', assistantText: '', error: '503: service unavailable',
      createdAt: '2026-10-16T07:56:59.000Z', updatedAt: '2026-10-16T07:57:06.000Z',
      toolCalls: [{
        callId: 'call-1', name: 'create_reminder', state: 'completed', textOffset: 0,
        args: { preview: '{"title":"关注 aish PR86 是否合并"}', truncated: false, redacted: false, artifactRefs: [] },
        result: { preview: '{"content":[{"type":"text","text":"created reminder #83，将于 2026-10-19T01:00:00.000Z 提醒"}]}', truncated: false, redacted: false, artifactRefs: [] },
        error: null, startedAt: '2026-10-16T07:57:02.000Z', endedAt: '2026-10-16T07:57:03.000Z',
      }],
    };
    runtime.control.getState().replaceConversation(SESSION, [turn]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    // 2026-10-27 画布「没有回答」：一行写「没有回答完」，做过的事在点开的浮层里第一行。
    const card = screen.getByTestId('failure-card');
    expect(card.textContent).toContain('没有回答完 · 你问的「提醒我下周一早上关注 aish」');
    expect(within(card).queryByRole('button', { name: '重发' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '没有回答完，展开' }));
    expect((await screen.findByTestId('failure-card-details')).textContent).toContain('做过提醒 #83 已创建');
  });
});

describe('a turn that a restart interrupted', () => {
  // Lead 在重启后接着回复了：失败行不再说「会接着回复你」（审查的 NIT，3688968）。
  it('says Lead already continued once a later Lead turn exists', () => {
    const runtime = runtimeWith();
    runtime.control.getState().replaceConversation(SESSION, [{
      id: 'turn-83', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'failed',
      userText: '提醒我下周一早上关注 aish', assistantText: '', error: LEAD_RESTART_INTERRUPTED_ERROR,
      createdAt: '2026-10-16T07:56:59.000Z', updatedAt: '2026-10-16T07:57:06.000Z',
    }, {
      id: 'turn-resume', originBindingId: null, originKind: 'system:blocker', ticketId: null, state: 'completed',
      userText: '', assistantText: '刚才被重启打断了。提醒已经建好。', error: null,
      createdAt: '2026-10-16T08:00:10.000Z', updatedAt: '2026-10-16T08:00:12.000Z',
    }]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    // 2026-10-27 画布「没有回答」状态 3：接在后面的琥珀虚线胶囊，一句短话。
    const card = screen.getByTestId('failure-card');
    expect(card.textContent).toBe('重启打断，已接着回复');
  });
});

describe('a reminder mentioned elsewhere in the conversation', () => {
  it('renders a ticket message part for a reminder as a reminder card', async () => {
    const runtime = runtimeWith();
    runtime.control.setState({ messagePartsById: { 'part-83': { kind: 'ticket', id: 'part-83', ticketId: 83 } } });
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <MessagePartView messageId="m1" partId="part-83" role="assistant" messageState="completed" />
      </CompanionRuntimeProvider>,
    );
    expect(await screen.findByTestId('reminder-card-83')).toBeTruthy();
    expect(screen.getByTestId('reminder-card-83-stub')).toBeTruthy();
  });

  it('sends a TicketRef to a reminder to the schedule, not to the ticket thread', async () => {
    setViewportWidth(1440);
    const runtime = runtimeWith();
    const surface: UiSurface = {
      id: 'reminder-ref', catalogVersion: 1, root: 'head', fallbackText: '提醒 #83',
      nodes: [{ id: 'head', type: 'TicketRef', props: { ticket: 83 } }],
    };
    renderUI(<CompanionRuntimeProvider runtime={runtime}><SurfaceView surface={surface} /></CompanionRuntimeProvider>);
    const head = await screen.findByTestId('surface-ticket-83');
    expect(await within(head).findByText('关注 aish PR86 是否合并')).toBeTruthy();
    expect(head.getAttribute('aria-label')).toBe('在日程里查看提醒 #83');
    fireEvent.click(head);
    expect(runtime.workspace.getState()).toMatchObject({ railView: 'agenda', selectedTicketId: null });
    setViewportWidth(0);
  });
});
