// 一轮里的工具调用（任务卡的步骤）。实时事件和刷新后的快照必须得到同样的 message parts：
// 快照的 toolCalls 由服务端用 foldTurnToolCalls 从同一批事件折叠出来（apps/daemon 的集成测试钉住这一点），
// 这里钉住客户端这一侧：实时折叠和快照归一化给出一样的结果。
import {
  foldTurnToolCalls,
  PROTOCOL_VERSION,
  type ConversationTurn,
  type GatewayEvent,
} from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildAssistantTurn } from '../../features/chat/assistantTurn';
import type { MessagePart } from '../types';
import { applyControlPlaneMutation } from './actions';
import { reduceGatewayEvent } from './eventReducer';
import { normalizeConversationSnapshot, type ConversationProjection } from './normalize';
import { adaptGatewayEvent } from './protocolAdapter';
import { createControlPlaneStore } from './store';

const SESSION = 'lead-session';
const TURN = 'turn-1';
const ASSISTANT = `${SESSION}:${TURN}:assistant`;

type Store = ReturnType<typeof createControlPlaneStore>;

function gatewayEvent(
  seq: number,
  type: GatewayEvent['type'],
  payload: Record<string, unknown>,
  extra: Partial<GatewayEvent> = {},
): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${seq}`,
    seq,
    type,
    occurredAt: `2026-10-13T04:00:${String(seq).padStart(2, '0')}.000Z`,
    requiredScope: 'chat',
    audienceBindingId: null,
    turnId: TURN,
    ticketId: null,
    payload,
    ...extra,
  };
}

function applyLive(store: Store, events: GatewayEvent[]) {
  for (const event of events) {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) {
      applyControlPlaneMutation(store, SESSION, mutation);
    }
  }
}

function projectionOf(store: Store): ConversationProjection {
  const state = store.getState();
  return {
    sessionsById: state.sessionsById,
    sessionIds: state.sessionIds,
    turnsById: state.turnsById,
    turnIdsBySession: state.turnIdsBySession,
    messagesById: state.messagesById,
    messageIdsBySession: state.messageIdsBySession,
    messageIdsByTicket: state.messageIdsByTicket,
    messagePartsById: state.messagePartsById,
    partIdsByMessage: state.partIdsByMessage,
    assistantMessageIdByTurnId: state.assistantMessageIdByTurnId,
    turnIdByCommandId: state.turnIdByCommandId,
  };
}

function partsOf(projection: Pick<ConversationProjection, 'partIdsByMessage' | 'messagePartsById'>, messageId: string) {
  return (projection.partIdsByMessage[messageId] ?? []).map((partId) => projection.messagePartsById[partId]);
}

function snapshotTurn(events: GatewayEvent[], overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: TURN,
    originBindingId: 1,
    originKind: 'paired:companion',
    ticketId: null,
    state: 'completed',
    userText: '看看待验收的',
    assistantText: events
      .filter((event) => event.type === 'lead.message.delta')
      .map((event) => String(event.payload.delta))
      .join(''),
    error: null,
    createdAt: '2026-10-13T04:00:00.000Z',
    updatedAt: '2026-10-13T04:00:30.000Z',
    toolCalls: foldTurnToolCalls(events),
    ...overrides,
  };
}

const narratedTurn: GatewayEvent[] = [
  gatewayEvent(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }),
  gatewayEvent(2, 'lead.message.delta', { messageId: `msg_${TURN}`, delta: '我先去查一下。' }),
  gatewayEvent(3, 'lead.tool.started', { toolCallId: 'a', toolName: 'query_tickets', args: { stage: 'review' }, textOffset: 7 }),
  gatewayEvent(4, 'lead.tool.completed', { toolCallId: 'a', toolName: 'query_tickets', result: '[]', isError: false, textOffset: 7 }),
  gatewayEvent(5, 'lead.tool.started', { toolCallId: 'b', toolName: 'query_tickets', args: { stage: 'active' }, textOffset: 7 }),
  gatewayEvent(6, 'lead.tool.failed', { toolCallId: 'b', toolName: 'query_tickets', result: 'db locked', isError: true, textOffset: 7 }),
  gatewayEvent(7, 'lead.message.delta', { messageId: `msg_${TURN}`, delta: '两种状态下都没有工单。' }),
  gatewayEvent(8, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '我先去查一下。两种状态下都没有工单。' }),
];

describe('tool calls in a live turn', () => {
  it('keeps the arguments of a call after its end event, which carries only the result', () => {
    const store = createControlPlaneStore();
    applyLive(store, narratedTurn);

    const tools = partsOf(store.getState(), ASSISTANT).filter((part) => part?.kind === 'tool');
    expect(tools).toEqual([
      expect.objectContaining({
        id: `${TURN}:a`, name: 'query_tickets', state: 'completed', textOffset: 7,
        args: expect.objectContaining({ preview: '{"stage":"review"}' }),
        result: expect.objectContaining({ preview: '[]' }),
        startedAt: '2026-10-13T04:00:03.000Z', endedAt: '2026-10-13T04:00:04.000Z',
      }),
      expect.objectContaining({ id: `${TURN}:b`, state: 'failed', error: 'db locked', args: expect.objectContaining({ preview: '{"stage":"active"}' }) }),
    ]);
  });

  it('attaches an executor tool to the ticket turn it belongs to, and ignores one without a turn', () => {
    const store = createControlPlaneStore();
    const ticketTurn = { ticketId: 12 };
    applyLive(store, [
      gatewayEvent(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion:ticket-agent', mode: 'started' }, ticketTurn),
      gatewayEvent(2, 'child.tool.started', { attemptId: 4, toolCallId: 'bash-1', toolName: 'Bash', args: { command: 'npm test' }, textOffset: 0 }, { ...ticketTurn, requiredScope: 'tickets:view' }),
      gatewayEvent(3, 'child.tool.started', { attemptId: 4, toolCallId: 'bash-2', toolName: 'Bash', args: { command: 'ls' } }, { ...ticketTurn, turnId: null, requiredScope: 'tickets:view' }),
      gatewayEvent(4, 'child.tool.started', { attemptId: 4, toolCallId: 'bash-3', toolName: 'Bash', args: { command: 'pwd' } }, { ...ticketTurn, turnId: 'turn-unknown', requiredScope: 'tickets:view' }),
    ]);

    const state = store.getState();
    expect(partsOf(state, ASSISTANT).filter((part) => part?.kind === 'tool').map((part) => part!.id)).toEqual([`${TURN}:bash-1`]);
    expect(state.turnsById['turn-unknown']).toBeUndefined();
  });
});

describe('tool calls after a reload', () => {
  it('rebuilds the same parts from the snapshot as the live events built', () => {
    const live = createControlPlaneStore();
    applyLive(live, narratedTurn);

    const reloaded = normalizeConversationSnapshot(projectionOf(createControlPlaneStore()), SESSION, [snapshotTurn(narratedTurn)]);

    expect(partsOf(reloaded, ASSISTANT)).toEqual(partsOf(live.getState(), ASSISTANT));
  });

  it('renders the same task card and reply after a reload', () => {
    const live = createControlPlaneStore();
    applyLive(live, narratedTurn);
    // 快照里轮次的开始和结束时间就是 daemon 记的那两刻：开始那一轮、发出 lead.message.completed。
    const reloaded = normalizeConversationSnapshot(projectionOf(createControlPlaneStore()), SESSION, [snapshotTurn(narratedTurn, {
      createdAt: narratedTurn[0]!.occurredAt, updatedAt: narratedTurn.at(-1)!.occurredAt,
    })]);
    const turnOf = (projection: Pick<ConversationProjection, 'partIdsByMessage' | 'messagePartsById' | 'messagesById'>) => {
      const parts = partsOf(projection, ASSISTANT).filter((part): part is MessagePart => part !== undefined);
      const textPart = parts.find((part) => part.kind === 'text');
      const message = projection.messagesById[ASSISTANT]!;
      return buildAssistantTurn({
        messageId: ASSISTANT,
        messageState: message.state,
        text: textPart?.kind === 'text' ? textPart.text : '',
        parts,
        startedAt: message.createdAt,
        endedAt: message.updatedAt,
      });
    };

    const liveTurn = turnOf(live.getState());
    expect(turnOf(reloaded)).toEqual(liveTurn);
    expect(liveTurn.reply).toBe('两种状态下都没有工单。');
    // 用时是这一轮从开始（第 1 个事件）到结束（第 8 个事件），不是两个工具的用时（spec D9）。
    expect(liveTurn.card).toMatchObject({ status: 'done', durationMs: 7_000 });
    expect(liveTurn.card!.steps.map((step) => step.kind === 'note' ? step.text : `${step.name}:${step.state}`))
      .toEqual(['我先去查一下。', 'query_tickets:done', 'query_tickets:failed']);
  });

  it('keeps a call the snapshot has not seen yet, after the calls it has', () => {
    const store = createControlPlaneStore();
    applyLive(store, narratedTurn.slice(0, 4));
    const stale = snapshotTurn(narratedTurn.slice(0, 2), { state: 'streaming' });

    const projection = normalizeConversationSnapshot(projectionOf(store), SESSION, [stale]);

    expect(partsOf(projection, ASSISTANT).map((part) => part!.id)).toEqual([`${ASSISTANT}:text`, `${TURN}:a`]);
  });

  it('does not let an older snapshot reopen a call that the live events already ended', () => {
    const store = createControlPlaneStore();
    applyLive(store, narratedTurn.slice(0, 4));
    const stale = snapshotTurn(narratedTurn.slice(0, 3), { state: 'streaming' });

    const projection = normalizeConversationSnapshot(projectionOf(store), SESSION, [stale]);

    expect(projection.messagePartsById[`${TURN}:a`]).toMatchObject({ state: 'completed', result: { preview: '[]' } });
  });
});
