// @vitest-environment happy-dom
// 用户的消息在 Lead 忙时怎么放（工单 04，spec D6、D10）。daemon 在 lead.turn.started 里说明放置方式（payload.placement），
// 会话快照（include=placement）也带着它。用户的消息下面写「排队中」「已插入」「下一轮回答」；
// 没有自己回答、和后面那一条一起答了的消息，写「和下一条一起回答」，不是失败卡片。Lead 正忙时，输入框上面可以选插话或排队。
import {
  CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, CHAT_PLACEMENT_CAPABILITY, CHAT_PLACEMENT_PREFERENCE_CAPABILITY, PROTOCOL_VERSION,
  type ConversationTurn, type GatewayEvent, type LeadStatus, type Overview,
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
    expect(screen.getByTestId('placement-status').textContent).toBe('In queue · Paimon answers it after this turn');

    started(runtime, 'turn-1', { mode: 'steered', placement: 'steered' });
    expect(screen.getByTestId('placement-status').textContent).toBe('Steered in');

    started(runtime, 'turn-1', { mode: 'steered', placement: 'next_turn' });
    expect(screen.getByTestId('placement-status').textContent).toBe('Next turn');

    // 开始答它了：不再写放置方式。
    started(runtime, 'turn-1', { mode: 'started', placement: 'delivered' });
    expect(screen.queryByTestId('placement-status')).toBeNull();
  });

  // 工单 06：以前「下一轮回答」只在实时显示，刷新以后快照说 steered，变成「已插入」。现在快照带着它。
  it('still says it will be answered in the next round after a reload', () => {
    setup([turn('turn-1', { state: 'steered', placement: 'next_turn' })]);
    expect(screen.getByTestId('placement-status').textContent).toBe('Next turn');
  });

  // 2026-11-09：插话送到 Lead 以后，界面还写「当前步骤之后看到」，用时从发出时算。送到的那一刻它就在回答了，
  // Lead 的回答从这一刻算起（会话按它排，回合头的用时也从这里量）。
  it('turns a delivered steer into a reply that started when Lead got it', () => {
    const runtime = setup([turn('turn-1', { state: 'queued', createdAt: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z' })]);
    started(runtime, 'turn-1', { mode: 'steered', placement: 'steered' });
    expect(screen.getByText('Steered in. Paimon sees it after the current step')).toBeTruthy();

    started(runtime, 'turn-1', { mode: 'started', placement: 'delivered' });
    expect(screen.queryByText('Steered in. Paimon sees it after the current step')).toBeNull();
    expect(screen.queryByTestId('placement-status')).toBeNull();
    const state = runtime.control.getState();
    const assistant = state.messagesById[state.turnsById['turn-1']!.assistantMessageId]!;
    expect(assistant).toMatchObject({ state: 'streaming', createdAt: '2026-10-17T01:00:05.000Z' });
    // 你的话还是发出的时刻。
    expect(state.messagesById[state.turnsById['turn-1']!.userMessageId]!.createdAt).toBe('2026-10-17T01:00:00.000Z');
  });

  it('ends a reply that a steer took over at the moment it was handed over', () => {
    const runtime = setup([turn('turn-1', { state: 'streaming', createdAt: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z' })]);
    started(runtime, 'turn-1', { mode: 'steered', placement: 'answered_together', answeredWith: 'turn-2' });
    const state = runtime.control.getState();
    expect(state.messagesById[state.turnsById['turn-1']!.assistantMessageId]).toMatchObject({
      createdAt: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:05.000Z',
    });
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
    expect(screen.getByText('Answered with the next message')).toBeTruthy();
    expect(screen.queryByTestId('failure-card')).toBeNull();
    expect(runtime.control.getState().turnsById['turn-1']).toMatchObject({ placement: 'answered_together', answeredWith: 'turn-2' });

    act(() => {
      runtime.control.getState().replaceConversation(SESSION, [
        turn('turn-1', { state: 'steered', placement: 'answered_together', answeredWith: 'turn-2' }),
        turn('turn-2', { state: 'completed', assistantText: '两条一起答了。' }),
      ]);
    });
    expect(screen.getByText('Answered with the next message')).toBeTruthy();
    expect(screen.queryByTestId('failure-card')).toBeNull();
  });
});

// 2026-11-10：Lead 正在写长文时你插话，它马上停下来答你（lead 的 step-interrupt.ts）。写出的那一段照原样留着，
// 后面接一个琥珀虚线胶囊「被你的插话打断」（设计规范 P10.2，主题 11.7 的接尾），不是失败卡片，也没有「重发」。
describe('an answer that your steer interrupted', () => {
  it('keeps the words Lead wrote and marks them as interrupted by your message', () => {
    setup([
      turn('turn-1', { state: 'completed', assistantText: 'A 的长文第一段。', interrupted: 'steer' }),
      turn('turn-2', {
        state: 'completed', userText: '写短一点', assistantText: '短版。',
        createdAt: '2026-10-17T01:00:02.000Z', updatedAt: '2026-10-17T01:00:03.000Z',
      }),
    ]);
    expect(screen.getByText('A 的长文第一段。')).toBeTruthy();
    const tails = screen.getAllByTestId('interrupted-by-steer');
    expect(tails).toHaveLength(1);
    expect(tails[0]!.textContent).toBe('Interrupted by your message');
    expect(screen.queryByTestId('failure-card')).toBeNull();
    expect(screen.queryByText('Resend')).toBeNull();
  });

  it('shows no mark for an answer that was not interrupted, or from a daemon that does not say', () => {
    setup([turn('turn-1', { state: 'completed', assistantText: '完整的回答。' })]);
    expect(screen.getByText('完整的回答。')).toBeTruthy();
    expect(screen.queryByTestId('interrupted-by-steer')).toBeNull();
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

  // 「Lead 忙时你发的消息」做成了设置（主题 11.13、11.19，用户 2026-11-09）：daemon 按设置放没带 mode 的消息时，
  // 输入框不带 mode，交给 daemon；没有这个能力的 daemon 照旧收到 followUp（composerQueueTray.test.tsx）。
  it('sends no mode while Lead is busy when the daemon places messages by the setting', () => {
    const runtime = setup([], {
      busy: true, capabilities: [CHAT_PLACEMENT_CAPABILITY, CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, CHAT_PLACEMENT_PREFERENCE_CAPABILITY],
    });
    const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg-1' });
    expect(screen.queryByTestId('composer-placement')).toBeNull();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '忙的时候再问一句' } });
    fireEvent.click(screen.getByTestId('send-message'));
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(sendChat.mock.calls[0]).toEqual(['忙的时候再问一句', undefined, undefined]);
  });
});
