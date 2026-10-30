// lead 自己发起的回合（blocker、即时通知、心跳、整理笔记）和 daemon 的系统通知是会话流里的一轮，
// originKind 以 system: 开头，没有用户消息。companion 要把它们显示成带标签的 Lead 消息，
// 不显示空的用户气泡。实时事件和刷新后的快照要得到同样的结果。
import { PROTOCOL_VERSION, type ConversationTurn, type GatewayEvent } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { leadSenderLabel } from '../../features/chat/senderLabel';
import { applyControlPlaneMutation } from './actions';
import { reduceGatewayEvent } from './eventReducer';
import { createControlPlaneStore, createInitialControlPlaneData } from './store';
import { adaptGatewayEvent } from './protocolAdapter';
import { normalizeConversationSnapshot, type ConversationProjection } from './normalize';

const SESSION = 'lead-session';
let seq = 0;

function apply(store: ReturnType<typeof createControlPlaneStore>, type: GatewayEvent['type'], payload: Record<string, unknown>) {
  seq += 1;
  const adapted = adaptGatewayEvent({
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${seq}`,
    seq,
    type,
    occurredAt: '2026-10-13T04:00:00.000Z',
    requiredScope: 'chat',
    audienceBindingId: null,
    turnId: 'turn-system',
    ticketId: null,
    payload,
  });
  if (!adapted.ok) throw new Error(adapted.error);
  for (const mutation of reduceGatewayEvent(adapted.event).control) {
    applyControlPlaneMutation(store, SESSION, mutation);
  }
}

describe('a turn the Lead started itself', () => {
  it('keeps its system origin from the live events, so the conversation can label it', () => {
    const store = createControlPlaneStore();
    apply(store, 'lead.turn.started', {
      messageId: 'msg_turn-system', commandId: null, originKind: 'system:blocker', mode: 'started',
    });
    apply(store, 'lead.message.completed', { messageId: 'msg_turn-system', text: '工单 #12 卡住了，我先重试一次。' });

    const state = store.getState();
    const turn = state.turnsById['turn-system']!;
    expect(turn.originKind).toBe('system:blocker');
    // 2026-10-15 用户决定（方案 A）：Lead 主动发起的回合也只写「Lead」。
    expect(leadSenderLabel(turn.originKind)).toBe('Paimon');
    // 它在主会话里（不属于某张工单）。
    expect(state.messageIdsBySession[SESSION]).toContain(turn.assistantMessageId);
    // 没有人发过消息：用户那一侧是实时外壳（没有命令 id），会话列表不渲染它。
    expect(state.messagesById[turn.userMessageId]).toMatchObject({ source: 'live', clientCommandId: null });
  });

  it('has no user message after a snapshot refresh', () => {
    const initial = createInitialControlPlaneData();
    const previous: ConversationProjection = {
      sessionsById: initial.sessionsById,
      sessionIds: initial.sessionIds,
      turnsById: initial.turnsById,
      turnIdsBySession: initial.turnIdsBySession,
      messagesById: initial.messagesById,
      messageIdsBySession: initial.messageIdsBySession,
      messageIdsByTicket: initial.messageIdsByTicket,
      messagePartsById: initial.messagePartsById,
      partIdsByMessage: initial.partIdsByMessage,
      assistantMessageIdByTurnId: initial.assistantMessageIdByTurnId,
      turnIdByCommandId: initial.turnIdByCommandId,
    };
    const systemTurn: ConversationTurn = {
      id: 'turn-system', originBindingId: null, originKind: 'system:heartbeat', ticketId: null, state: 'completed',
      userText: '', assistantText: '积压的提醒都看过了。', error: null,
      createdAt: '2026-10-13T04:00:00.000Z', updatedAt: '2026-10-13T04:00:05.000Z',
    };
    const projection = normalizeConversationSnapshot(previous, SESSION, [systemTurn]);
    const turn = projection.turnsById['turn-system']!;
    expect(turn.originKind).toBe('system:heartbeat');
    expect(leadSenderLabel(turn.originKind)).toBe('Paimon');
    expect(projection.messageIdsBySession[SESSION]).toEqual([turn.assistantMessageId]);
  });

  it('labels user-originated turns as the Lead, as before', () => {
    expect(leadSenderLabel('paired:companion')).toBe('Paimon');
    expect(leadSenderLabel('live')).toBe('Paimon');
    expect(leadSenderLabel(undefined)).toBe('Paimon');
    expect(leadSenderLabel('system:fallback-notice')).toBe('系统通知');
  });
});

// daemon 重试同一条通知时复用它的系统回合（reopenTurn）：同一个 turnId 再来一次 lead.turn.started。
// 这一轮要从头开始：清掉上一次的文字、工具和失败，排到会话的末尾。
describe('a system turn the daemon starts again', () => {
  function applyTo(
    store: ReturnType<typeof createControlPlaneStore>,
    turnId: string,
    occurredAt: string,
    type: GatewayEvent['type'],
    payload: Record<string, unknown>,
  ) {
    seq += 1;
    const adapted = adaptGatewayEvent({
      protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type, occurredAt,
      requiredScope: 'chat', audienceBindingId: null, turnId, ticketId: null, payload,
    });
    if (!adapted.ok) throw new Error(adapted.error);
    const reduction = reduceGatewayEvent(adapted.event);
    for (const mutation of reduction.control) applyControlPlaneMutation(store, SESSION, mutation);
    return reduction;
  }

  it('starts clean and moves to the end of the conversation', () => {
    const store = createControlPlaneStore();
    const started = { messageId: 'msg_turn-retry', commandId: null, originKind: 'system:notification', mode: 'started' };
    applyTo(store, 'turn-retry', '2026-10-13T04:00:00.000Z', 'lead.turn.started', started);
    applyTo(store, 'turn-retry', '2026-10-13T04:00:01.000Z', 'lead.tool.started', { toolCallId: 'call-1', toolName: 'list_tickets', args: {} });
    applyTo(store, 'turn-retry', '2026-10-13T04:00:02.000Z', 'notice.created', { severity: 'error', message: '模型连不上' });
    applyTo(store, 'turn-user', '2026-10-13T04:01:00.000Z', 'lead.turn.started', {
      messageId: 'msg_turn-user', commandId: null, originKind: 'paired:companion', mode: 'started',
    });
    const failed = store.getState().turnsById['turn-retry']!;
    expect(failed.state).toBe('failed');
    const textPartId = `${failed.assistantMessageId}:text`;
    expect(store.getState().partIdsByMessage[failed.assistantMessageId]).toEqual([textPartId, 'turn-retry:call-1']);

    const reduction = applyTo(store, 'turn-retry', '2026-10-13T04:02:00.000Z', 'lead.turn.started', started);

    const state = store.getState();
    const turn = state.turnsById['turn-retry']!;
    expect(turn).toMatchObject({ state: 'streaming', error: null, createdAt: '2026-10-13T04:02:00.000Z' });
    expect(state.messagesById[turn.assistantMessageId]).toMatchObject({ state: 'streaming', failure: null });
    expect(state.partIdsByMessage[turn.assistantMessageId]).toEqual([textPartId]);
    expect(state.messagePartsById[textPartId]).toEqual({ kind: 'text', id: textPartId, text: '' });
    expect(state.turnIdsBySession[SESSION]).toEqual(['turn-user', 'turn-retry']);
    expect(state.messageIdsBySession[SESSION]!.slice(-2)).toEqual([turn.userMessageId, turn.assistantMessageId]);
    // 上一次流到一半的文字也不留：它不属于这一次。
    expect(reduction.streams).toContainEqual({ type: 'message.clear-transient', turnId: 'turn-retry' });
  });
});
