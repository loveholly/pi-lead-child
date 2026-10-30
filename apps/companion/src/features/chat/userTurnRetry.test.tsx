// @vitest-environment jsdom
// 用户的一轮因为断网失败：daemon 等网络恢复后自动再试一次（2026-10-16）。等待期间它不是失败：
// 会话里写「在等」，不给「重发」（再发一次会多出一轮）。再试成功，就是一条普通的回答；再试也失败，才是失败卡片。
import { PROTOCOL_VERSION, type ConversationTurn, type GatewayEvent, type LeadStatus, type Overview } from '@pi-lead-child/protocol';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// 「正在回复」的转圈是 Reanimated 的循环动画，jsdom 里卸载以后还在按帧更新。这些测试不看动画。
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const DNS = '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};

function overview(): Overview {
  return {
    model: 'stub', sessionId: SESSION, busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function userTurn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: 'turn-1', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'streaming',
    userText: '合盖前最后一条', assistantText: '', error: null,
    createdAt: '2026-10-16T01:29:30.000Z', updatedAt: '2026-10-16T01:29:38.000Z',
    ...overrides,
  };
}

function setup(turns: ConversationTurn[]) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview() });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

let seq = 0;
function apply(runtime: ReturnType<typeof setup>, type: GatewayEvent['type'], payload: Record<string, unknown>) {
  seq += 1;
  const event: GatewayEvent = {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type, occurredAt: '2026-10-16T01:29:40.000Z',
    requiredScope: 'chat', audienceBindingId: 1, turnId: 'turn-1', ticketId: null, payload,
  };
  act(() => {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  });
}

const WAITING = '网络不可用，这条消息还没有得到回答。网络恢复后会自动再试一次。';

describe('a user turn waiting for its one retry', () => {
  it('says it is waiting, with no resend, and becomes a normal answer when the retry works', () => {
    const runtime = setup([userTurn({})]);
    apply(runtime, 'notice.created', { severity: 'error', message: DNS, retry: 'waiting', waitingFor: 'network' });

    const card = screen.getByTestId('failure-card');
    expect(card.textContent).toContain(WAITING);
    expect(within(card).queryByRole('button', { name: '重发' })).toBeNull();

    apply(runtime, 'lead.turn.started', { messageId: 'msg_turn-1', commandId: null, originKind: 'paired:companion', mode: 'started' });
    apply(runtime, 'lead.message.completed', { messageId: 'msg_turn-1', text: '收到，我在。' });
    expect(screen.queryByTestId('failure-card')).toBeNull();
    expect(screen.getByText('收到，我在。')).toBeTruthy();
  });

  it('shows the same waiting state after a refresh', () => {
    setup([userTurn({ state: 'queued', error: DNS })]);
    expect(screen.getByTestId('failure-card').textContent).toContain(WAITING);
  });

  it('becomes a normal failure, with resend, when the retry also fails', () => {
    const runtime = setup([userTurn({})]);
    apply(runtime, 'notice.created', { severity: 'error', message: DNS, retry: 'waiting', waitingFor: 'network' });
    apply(runtime, 'lead.turn.started', { messageId: 'msg_turn-1', commandId: null, originKind: 'paired:companion', mode: 'started' });
    apply(runtime, 'notice.created', { severity: 'error', message: DNS });
    const card = screen.getByTestId('failure-card');
    expect(card.textContent).not.toContain('自动再试');
    expect(within(card).getByRole('button', { name: '重发' })).toBeTruthy();
  });
});
