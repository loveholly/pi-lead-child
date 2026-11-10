// @vitest-environment happy-dom
// 底部操作栏（工单 12，spec 4.1、5.11）：按钮能不能点只看操作清单（GET /v1/tickets/:id/actions），点的时候走工单操作。
// 回归（复核 P1-9）：回复问「你要我现在就发起这次独立核查吗？」，回复下面的按钮和底部操作栏走同一个入口。
// 回复在问哪几个动作由 daemon 的快模型判断，结果在这一轮的 replyActions 里（2026-10-19）。
import type { ConversationTurn, KernelIntervention } from '@pi-lead-child/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWorkbenchWithTicket, setViewportWidth, ticket66, ticketAction, ticketDelivery } from '../../../test/workbench';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const TICKET = 66;

const waitingForReview = () => ticket66({
  verificationPolicy: 'independent_reviewer',
  reviewState: {
    state: 'independent_review',
    label: '等待独立核查',
    reviewerAttemptId: null,
    verdict: null,
    reason: null,
    deliveryRunId: 49,
    canRequestReview: true,
    reviewProgress: null,
  },
});

const reviewActions = () => [
  ticketAction('request_review', { label: '派发核查', area: 'execution' }),
  ticketAction('complete', { label: '验收', area: 'delivery' }),
  ticketAction('rework', { label: 'Send back for rework', area: 'delivery' }),
  ticketAction('cancel', { label: 'Cancel ticket' }),
];

afterEach(() => setViewportWidth(0));

function bar() {
  return within(screen.getByTestId('ticket-thread')).getByTestId('ticket-action-bar');
}

describe('the bottom action bar', () => {
  // 设计规范 P14.6（用户 2026-11-02）：「Run #49」是系统内部的记录编号，用户在界面上找不到。
  // 底部栏写「第 2 次交付」，序号来自交付列表；读不到交付列表时写「最新的交付」。
  it('names the delivery by its number from the delivery list, never by the run number', async () => {
    renderWorkbenchWithTicket(waitingForReview(), { actions: reviewActions(), deliveries: [{ attemptId: 49, sequence: 2 }] });

    await waitFor(() => expect(bar().textContent).toContain('Delivery 2 has no independent review yet.'));
    expect(screen.getByTestId('ticket-thread').textContent).not.toMatch(/Run #\d|#49\b/);
  });

  it('says the latest delivery when the connection cannot read the delivery list', () => {
    renderWorkbenchWithTicket(waitingForReview(), { actions: reviewActions() });

    expect(bar().textContent).toContain('The latest delivery has no independent review yet.');
  });

  it('places the review actions and takes their availability from the action list', () => {
    renderWorkbenchWithTicket(waitingForReview(), {
      actions: [
        ...reviewActions().filter((action) => action.id !== 'complete'),
        ticketAction('complete', { label: '验收', available: false, reason: '最新一次交付的快照还没存好。' }),
      ],
    });

    expect(within(bar()).getByTestId('ticket-bar-complete').getAttribute('aria-disabled')).toBe('true');
    expect(within(bar()).getByTestId('ticket-bar-rework').getAttribute('aria-disabled')).toBeNull();
    // 主按钮不能点时，下面那行小字写清单给的原因。
    expect(bar().textContent).toContain('最新一次交付的快照还没存好。');
  });

  it('runs the ticket action when a button is pressed', () => {
    const runtime = renderWorkbenchWithTicket(ticket66({ stage: 'done', status: 'done' }), {
      actions: [ticketAction('merge', { label: '合并到原分支', area: 'delivery' }), ticketAction('open_pr', { label: '开草稿 PR', external: true })],
      delivery: ticketDelivery(TICKET),
    });
    const run = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({ ticketId: TICKET, action: 'merge', result: null, ticket: null });

    fireEvent.click(within(bar()).getByTestId('ticket-bar-merge'));

    // 带上你看到的那份交付：交付在你看过以后变了，服务端拒绝。
    expect(run).toHaveBeenCalledWith(TICKET, 'merge', { input: { expectedHead: 'a'.repeat(40), expectedTarget: 'main' } });
  });

  it('asks once more before an outward action', () => {
    const runtime = renderWorkbenchWithTicket(ticket66({ stage: 'done', status: 'done' }), {
      actions: [ticketAction('merge', { label: '合并到原分支' }), ticketAction('open_pr', { label: '开草稿 PR', external: true })],
      delivery: ticketDelivery(TICKET),
    });
    const run = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({ ticketId: TICKET, action: 'open_pr', result: null, ticket: null });

    fireEvent.click(within(bar()).getByTestId('ticket-bar-open_pr'));
    expect(run).not.toHaveBeenCalled();
    expect(within(bar()).getByTestId('ticket-confirm').textContent).toContain('Push to GitHub and open a draft PR?');

    fireEvent.click(within(within(bar()).getByTestId('ticket-confirm')).getByText('开草稿 PR'));
    expect(run).toHaveBeenCalledWith(TICKET, 'open_pr', { input: { expectedHead: 'a'.repeat(40), expectedTarget: 'main' } });
  });

  it('regression #66: runs the review from the button under the reply, like the bar does', () => {
    const turns: ConversationTurn[] = [{
      id: 'turn_72',
      originBindingId: 7,
      originKind: 'paired:companion:ticket-agent',
      ticketId: TICKET,
      state: 'completed',
      userText: '现在需要我做什么',
      assistantText: '工单 #66 现在处于 review。我建议派一次新的独立核查。你要我现在就发起这次独立核查吗？',
      error: null,
      createdAt: '2026-10-14T09:57:07.000Z',
      updatedAt: '2026-10-14T09:58:43.000Z',
      replyActions: ['request_review'],
    }];
    const runtime = renderWorkbenchWithTicket(waitingForReview(), { turns, actions: reviewActions() });
    const run = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({ ticketId: TICKET, action: 'request_review', result: null, ticket: null });
    const dock = within(screen.getByTestId('ticket-thread')).getByTestId('ticket-chat-dock');

    fireEvent.click(within(dock).getByTestId('ticket-chat-action-request_review'));

    expect(run).toHaveBeenCalledWith(TICKET, 'request_review', {});
  });
});

// 2026-10-16 用户要求：工单在等你回答决定时，轮到你做的就是回答它。收件箱的「查看」打开的就是这里。
describe('a decision waiting for you', () => {
  const pendingDecision: KernelIntervention = {
    id: 'decision:12', kind: 'decision', authorityId: 12, ticketId: TICKET, attemptId: null, audience: 'user',
    blocking: true, allowCustom: false, state: 'pending', title: '#66 接下来怎么办？', detail: '#66 接下来怎么办？',
    options: [
      { id: 'merge', label: '并入 #72', description: '#66 关闭' },
      { id: 'cancel', label: '取消 #66', description: '不再推进' },
    ],
    actions: [
      { kind: 'select', optionId: 'merge', label: '并入 #72' },
      { kind: 'select', optionId: 'cancel', label: '取消 #66' },
    ],
    resolution: null, createdAt: '2026-10-15T10:15:00.000Z', resolvedBy: null, resolvedAt: null,
  } as KernelIntervention;

  it('puts the decision on top and says to answer it first', () => {
    const owed = ticket66({
      reviewState: waitingForReview().reviewState,
      attention: { pendingApprovalCount: 0, blockerCount: 1, pendingDecisionCount: 1 },
    });
    const runtime = renderWorkbenchWithTicket(owed, { interventions: [pendingDecision], actions: reviewActions() });
    const resolve = vi.spyOn(runtime, 'resolveIntervention').mockResolvedValue();
    const thread = screen.getByTestId('ticket-thread');

    expect(bar().textContent).toContain('First, answer the decision on this ticket');
    const pending = within(thread).getByTestId('ticket-pending-decision');
    fireEvent.click(within(pending).getByTestId('intervention-action-option:merge'));
    expect(resolve).toHaveBeenCalledWith('decision:12', { authority: 'decision_request', decision: 'select', optionId: 'merge' });
  });
});
