// @vitest-environment jsdom
// 用户的消息在 Lead 忙时怎么放（工单 04，spec D6、D10）。daemon 在 lead.turn.started 里说明放置方式（payload.placement），
// 会话快照（include=placement）也带着它。用户的消息下面写「排队中」「已插入」「下一轮回答」；
// 没有自己回答、和后面那一条一起答了的消息，写「和下一条一起回答」，不是失败卡片。Lead 正忙时，输入框上面可以选插话或排队。
import {
  CHAT_PLACEMENT_CAPABILITY, PROTOCOL_VERSION, type ConversationTurn, type GatewayEvent, type LeadStatus, type Overview,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
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
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};

function overview(busy: boolean): Overview {
  return {
    model: 'stub', sessionId: SESSION, busy, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'streaming',
    userText: `问题 ${id}`, assistantText: '', error: null,
    createdAt: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:01.000Z',
    ...overrides,
  };
}

function setup(turns: ConversationTurn[], options: { busy?: boolean; capabilities?: string[] } = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: overview(options.busy ?? false),
    capabilities: options.capabilities ?? [],
  });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

let seq = 0;
function started(runtime: ReturnType<typeof setup>, turnId: string, payload: Record<string, unknown>) {
  seq += 1;
  const event: GatewayEvent = {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'lead.turn.started', occurredAt: '2026-10-17T01:00:05.000Z',
    requiredScope: 'chat', audienceBindingId: 1, turnId, ticketId: null,
    payload: { messageId: `msg_${turnId}`, commandId: null, originKind: 'paired:companion', ...payload },
  };
  act(() => {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  });
}

describe('a message sent while Lead is busy', () => {
  it('shows it is queued, inserted, or answered in the next round', () => {
    const runtime = setup([turn('turn-1', { state: 'queued' })]);
    started(runtime, 'turn-1', { mode: 'queued', placement: 'queued' });
    expect(screen.getByTestId('placement-status').textContent).toBe('排队中 · Paimon 答完这一轮后回答');

    started(runtime, 'turn-1', { mode: 'steered', placement: 'steered' });
    expect(screen.getByTestId('placement-status').textContent).toBe('已插入');

    started(runtime, 'turn-1', { mode: 'steered', placement: 'next_turn' });
    expect(screen.getByTestId('placement-status').textContent).toBe('下一轮回答');

    // 开始答它了：不再写放置方式。
    started(runtime, 'turn-1', { mode: 'started', placement: 'delivered' });
    expect(screen.queryByTestId('placement-status')).toBeNull();
  });

  // 工单 06：以前「下一轮回答」只在实时显示，刷新以后快照说 steered，变成「已插入」。现在快照带着它。
  it('still says it will be answered in the next round after a reload', () => {
    setup([turn('turn-1', { state: 'steered', placement: 'next_turn' })]);
    expect(screen.getByTestId('placement-status').textContent).toBe('下一轮回答');
  });

  it('ignores a placement it does not know, and keeps working with an old daemon that sends none', () => {
    const runtime = setup([turn('turn-1', { state: 'queued' })]);
    started(runtime, 'turn-1', { mode: 'steered', placement: 'teleported' });
    expect(screen.queryByTestId('placement-status')).toBeNull();
    expect(runtime.control.getState().turnsById['turn-1']!.state).toBe('steered');
  });
});

describe('a message Lead answered together with the next one', () => {
  it('says so instead of showing a failure, live and after a reload', () => {
    const runtime = setup([turn('turn-1', { state: 'streaming' }), turn('turn-2', { state: 'completed', assistantText: '两条一起答了。' })]);
    started(runtime, 'turn-1', { mode: 'steered', placement: 'answered_together', answeredWith: 'turn-2' });
    expect(screen.getByText('和下一条一起回答')).toBeTruthy();
    expect(screen.queryByTestId('failure-card')).toBeNull();
    expect(runtime.control.getState().turnsById['turn-1']).toMatchObject({ placement: 'answered_together', answeredWith: 'turn-2' });

    act(() => {
      runtime.control.getState().replaceConversation(SESSION, [
        turn('turn-1', { state: 'steered', placement: 'answered_together', answeredWith: 'turn-2' }),
        turn('turn-2', { state: 'completed', assistantText: '两条一起答了。' }),
      ]);
    });
    expect(screen.getByText('和下一条一起回答')).toBeTruthy();
    expect(screen.queryByTestId('failure-card')).toBeNull();
  });
});

describe('the composer while Lead is busy', () => {
  it('lets the user queue the message instead of steering it in', () => {
    const runtime = setup([], { busy: true, capabilities: [CHAT_PLACEMENT_CAPABILITY] });
    const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg-1' });
    expect(screen.getByTestId('composer-placement')).toBeTruthy();

    fireEvent.click(screen.getByTestId('composer-placement-followUp'));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '排队问一句' } });
    fireEvent.click(screen.getByTestId('send-message'));
    expect(sendChat).toHaveBeenCalledWith('排队问一句', undefined, 'followUp');
  });

  it('offers no choice when Lead is idle or the daemon cannot place messages', () => {
    setup([], { busy: false, capabilities: [CHAT_PLACEMENT_CAPABILITY] });
    expect(screen.queryByTestId('composer-placement')).toBeNull();
  });

  it('offers no choice to an old daemon', () => {
    setup([], { busy: true, capabilities: [] });
    expect(screen.queryByTestId('composer-placement')).toBeNull();
  });
});
