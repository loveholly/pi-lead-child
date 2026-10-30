import { foldToolCall, surfaceShadowedByFinal, surfacesReplacedBy, type ChatImageInput } from '@pi-lead-child/protocol';

import type { ControlPlaneMutation } from './eventReducer';
import type { ControlPlaneStore } from './store';
import type { LeadTurnEntity, MessageEntity, MessagePart } from '../types';

export function applyControlPlaneMutation(
  store: ControlPlaneStore,
  sessionId: string,
  mutation: ControlPlaneMutation,
): void {
  switch (mutation.type) {
    case 'lead-queue.replace':
      store.getState().replaceLeadQueue(mutation.queue);
      return;
    case 'lead-activity.apply':
      store.getState().applyLeadActivityPush({
        ...(mutation.card ? { card: mutation.card } : {}),
        ...(mutation.interrupt ? { interrupt: mutation.interrupt } : {}),
        ...(mutation.reminder ? { reminder: mutation.reminder } : {}),
        ...(mutation.setup ? { setup: mutation.setup } : {}),
        ...(mutation.setupHint ? { setupHint: mutation.setupHint } : {}),
      });
      return;
    case 'lead.ensure-shell':
      ensureLeadShell(store, sessionId, mutation.turnId, mutation.ticketId, mutation.occurredAt, mutation.originKind);
      return;
    case 'lead.start-turn': {
      if (!mutation.turnId) return;
      const state = store.getState();
      const turn = state.turnsById[mutation.turnId];
      if (!turn) return;
      // 结束了的一轮重新开始（daemon 重试系统回合），或者在等自动重试的用户的一轮开始重试：上一次的失败和文字不属于这一次。
      const retrying = state.messagesById[turn.assistantMessageId]?.failure?.kind === 'retry-pending';
      if (mutation.payload.mode === 'started' && (turn.state === 'completed' || turn.state === 'failed' || retrying)) {
        restartLeadTurn(store, sessionId, turn, mutation.occurredAt);
        return;
      }
      const assistant = state.messagesById[turn.assistantMessageId];
      const nextState: LeadTurnEntity['state'] = mutation.payload.mode === 'steered'
        ? 'steered'
        : mutation.payload.mode === 'queued' ? 'queued' : 'streaming';
      // 用户的消息怎么放的（工单 04）。开始回答（started）而且没有说放置方式时，它已经是普通的一轮。
      const placement = mutation.payload.placement !== undefined
        ? { placement: mutation.payload.placement, answeredWith: mutation.payload.answeredWith ?? null }
        : mutation.payload.mode === 'started' ? { placement: null, answeredWith: null } : {};
      const turnsById = {
        ...state.turnsById,
        [turn.id]: {
          ...turn,
          state: nextState,
          ...(mutation.payload.originKind === undefined ? {} : { originKind: mutation.payload.originKind }),
          ...placement,
        },
      };
      const messagesById = assistant ? {
        ...state.messagesById,
        [assistant.id]: { ...assistant, state: nextState },
      } : state.messagesById;
      const turnIdByCommandId = mutation.payload.commandId
        ? { ...state.turnIdByCommandId, [mutation.payload.commandId]: turn.id }
        : state.turnIdByCommandId;
      store.setState({ turnsById, messagesById, turnIdByCommandId });
      return;
    }
    case 'lead.complete-message': {
      if (!mutation.turnId) return;
      const state = store.getState();
      const turn = state.turnsById[mutation.turnId];
      if (!turn) return;
      const assistant = state.messagesById[turn.assistantMessageId];
      const textPartId = `${turn.assistantMessageId}:text`;
      const textPart: MessagePart = { kind: 'text', id: textPartId, text: mutation.text };
      // 结束的时间用 daemon 记的事件时间，不用本机的时间：重连后补收的事件也是对的，回合头的用时据此算（assistantTurn.ts）。
      store.setState({
        turnsById: { ...state.turnsById, [turn.id]: { ...turn, state: 'completed', updatedAt: mutation.occurredAt } },
        messagesById: assistant ? {
          ...state.messagesById,
          [assistant.id]: { ...assistant, state: 'completed', failure: null, updatedAt: mutation.occurredAt },
        } : state.messagesById,
        messagePartsById: { ...state.messagePartsById, [textPartId]: textPart },
      });
      return;
    }
    case 'lead.upsert-tool-part': {
      // 和服务端折叠快照的 toolCalls 用同一个 foldToolCall：结束事件只带结果，参数留着开始时的。
      const previous = store.getState().messagePartsById[mutation.partId];
      const previousCall = previous?.kind === 'tool' ? previous : undefined;
      const call = foldToolCall(previousCall, mutation.call);
      if (previousCall && call === previousCall) return;
      upsertAssistantPart(store, mutation.turnId, { kind: 'tool', ...call, id: mutation.partId });
      return;
    }
    case 'lead.upsert-surface-part': {
      const previous = store.getState().messagePartsById[mutation.partId];
      if (previous?.kind === 'surface' && !previous.partial && mutation.partial) return;
      const next = { callId: mutation.callId, partial: mutation.partial, surface: mutation.surface };
      const others = turnSurfaceParts(store, mutation.turnId).filter((part) => part.id !== mutation.partId);
      // 同一个 surface id 已经有别的调用定稿的版本：重画还在流，继续显示旧的定稿版。
      if (surfaceShadowedByFinal(others, next)) return;
      const replaced = new Set(surfacesReplacedBy(others, next));
      removeAssistantParts(store, mutation.turnId, others.filter((part) => replaced.has(part.callId)).map((part) => part.id));
      upsertAssistantPart(store, mutation.turnId, {
        kind: 'surface',
        id: mutation.partId,
        callId: mutation.callId,
        textOffset: mutation.textOffset,
        partial: mutation.partial,
        surface: mutation.surface,
      });
      return;
    }
    case 'lead.drop-failed-surface-part': {
      // render_ui 失败了：它不会再有定稿版，流式中途的「生成中」卡片撤掉。
      const previous = store.getState().messagePartsById[mutation.partId];
      if (previous?.kind === 'surface' && previous.partial) removeAssistantParts(store, mutation.turnId, [mutation.partId]);
      return;
    }
    case 'lead.upsert-ticket-part': {
      upsertAssistantPart(store, mutation.turnId, {
        kind: 'ticket',
        id: mutation.partId,
        ticketId: mutation.ticketId,
      });
      return;
    }
    case 'lead.upsert-approval-part': {
      upsertAssistantPart(store, mutation.turnId, {
        kind: 'approval',
        id: mutation.partId,
        approvalId: mutation.approvalId,
      });
      return;
    }
    case 'lead.upsert-artifact-part': {
      upsertAssistantPart(store, mutation.turnId, {
        kind: 'artifact',
        id: mutation.partId,
        artifactId: mutation.artifactId,
      });
      return;
    }
    case 'lead.upsert-live-ticket-card':
      store.getState().upsertTransientConversationCard(mutation.card);
      return;
    case 'lead.fail-turn': {
      if (!mutation.turnId) return;
      const state = store.getState();
      const turn = state.turnsById[mutation.turnId];
      if (!turn) return;
      const assistant = state.messagesById[turn.assistantMessageId];
      // 在等那一次自动重试：这一轮还没结束（queued），不是失败。
      const waiting = mutation.waitingFor !== undefined;
      // 失败的一轮在这一刻结束（回合头的用时量到这里）。在等重试的一轮还没结束，时间不动。
      const endedAt = waiting ? {} : { updatedAt: mutation.occurredAt };
      store.setState({
        turnsById: { ...state.turnsById, [turn.id]: { ...turn, state: waiting ? 'queued' : 'failed', error: mutation.message, ...endedAt } },
        messagesById: assistant ? {
          ...state.messagesById,
          [assistant.id]: {
            ...assistant,
            ...endedAt,
            state: waiting ? 'queued' : 'failed',
            failure: waiting
              ? { kind: 'retry-pending', code: mutation.waitingFor ?? 'model', message: mutation.message }
              : { kind: 'turn-error', code: null, message: mutation.message },
          },
        } : state.messagesById,
      });
      return;
    }
    case 'overview.patch': {
      const overview = store.getState().overview;
      if (!overview) return;
      store.setState({ overview: { ...overview, ...mutation.payload } });
    }
  }
}

function upsertAssistantPart(
  store: ControlPlaneStore,
  turnId: string | null,
  part: MessagePart,
): void {
  if (!turnId) return;
  const state = store.getState();
  const turn = state.turnsById[turnId];
  if (!turn) return;
  const currentIds = state.partIdsByMessage[turn.assistantMessageId] ?? [];
  const partIds = currentIds.includes(part.id) ? currentIds : [...currentIds, part.id];
  store.setState({
    messagePartsById: { ...state.messagePartsById, [part.id]: part },
    partIdsByMessage: partIds === currentIds
      ? state.partIdsByMessage
      : { ...state.partIdsByMessage, [turn.assistantMessageId]: partIds },
  });
}

function turnSurfaceParts(store: ControlPlaneStore, turnId: string | null): Array<Extract<MessagePart, { kind: 'surface' }>> {
  if (!turnId) return [];
  const state = store.getState();
  const turn = state.turnsById[turnId];
  if (!turn) return [];
  return (state.partIdsByMessage[turn.assistantMessageId] ?? [])
    .map((partId) => state.messagePartsById[partId])
    .filter((part): part is Extract<MessagePart, { kind: 'surface' }> => part?.kind === 'surface');
}

function removeAssistantParts(store: ControlPlaneStore, turnId: string | null, partIds: readonly string[]): void {
  if (!turnId || partIds.length === 0) return;
  const state = store.getState();
  const turn = state.turnsById[turnId];
  if (!turn) return;
  const removed = new Set(partIds);
  const messagePartsById = { ...state.messagePartsById };
  for (const partId of removed) delete messagePartsById[partId];
  store.setState({
    messagePartsById,
    partIdsByMessage: {
      ...state.partIdsByMessage,
      [turn.assistantMessageId]: (state.partIdsByMessage[turn.assistantMessageId] ?? []).filter((partId) => !removed.has(partId)),
    },
  });
}

export function createOptimisticUserMessage(
  store: ControlPlaneStore,
	  input: {
	    sessionId: string;
	    commandId: string;
	    message: string;
	    ticketId?: number;
	    createdAt: string;
	    replaceMessageId?: string;
	    // 随消息发的图片：画在文字上面（LeadConversation 的 UserMessageImages）。
	    images?: readonly ChatImageInput[];
	  },
): string {
  const state = store.getState();
	  const messageId = `optimistic:${input.commandId}:user`;
	  const partId = `${messageId}:text`;
	  const imageParts: MessagePart[] = (input.images ?? []).map((image, index) => ({
	    kind: 'image', id: `${messageId}:image:${index}`, mimeType: image.mimeType, data: image.data,
	  }));
	  const entity: MessageEntity = {
	    id: messageId,
	    sessionId: input.sessionId,
	    turnId: null,
	    ticketId: input.ticketId ?? null,
	    role: 'user',
	    state: 'queued',
    failure: null,
    clientCommandId: input.commandId,
    source: 'optimistic',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
	  };
	  const part: MessagePart = { kind: 'text', id: partId, text: input.message };
	  const ticketId = input.ticketId;
	  const scopedToTicket = ticketId !== undefined;
	  const previousIds = scopedToTicket
	    ? state.messageIdsByTicket[ticketId] ?? []
	    : state.messageIdsBySession[input.sessionId] ?? [];
	  const messageIds = input.replaceMessageId && previousIds.includes(input.replaceMessageId)
	    ? previousIds.map((id: string) => id === input.replaceMessageId ? messageId : id)
	    : [...previousIds, messageId];
  const messagesById = { ...state.messagesById, [messageId]: entity };
  const messagePartsById = {
    ...state.messagePartsById, [partId]: part,
    ...Object.fromEntries(imageParts.map((image) => [image.id, image])),
  };
  const partIdsByMessage = { ...state.partIdsByMessage, [messageId]: [partId, ...imageParts.map((image) => image.id)] };
  if (input.replaceMessageId) {
    const oldPartIds = state.partIdsByMessage[input.replaceMessageId] ?? [];
    delete messagesById[input.replaceMessageId];
    delete partIdsByMessage[input.replaceMessageId];
    for (const oldPartId of oldPartIds) delete messagePartsById[oldPartId];
  }
  store.setState({
    sessionsById: state.sessionsById[input.sessionId] ? state.sessionsById : {
      ...state.sessionsById,
      [input.sessionId]: {
        id: input.sessionId,
        kind: 'lead',
        title: 'Lead',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    },
	    sessionIds: state.sessionIds.includes(input.sessionId) ? state.sessionIds : [...state.sessionIds, input.sessionId],
	    messagesById,
	    messageIdsBySession: scopedToTicket
	      ? state.messageIdsBySession
	      : { ...state.messageIdsBySession, [input.sessionId]: messageIds },
	    messageIdsByTicket: scopedToTicket
	      ? { ...state.messageIdsByTicket, [ticketId]: messageIds }
	      : state.messageIdsByTicket,
	    messagePartsById,
    partIdsByMessage,
  });
  return messageId;
}

export function resolveOptimisticUserMessage(
  store: ControlPlaneStore,
  input: { sessionId: string; commandId: string; turnId: string; optimisticMessageId: string },
): void {
  const state = store.getState();
  const optimistic = state.messagesById[input.optimisticMessageId];
  const turn = state.turnsById[input.turnId];
  if (!optimistic || !turn) return;
  const targetId = `${input.sessionId}:${input.turnId}:user`;
  const targetPartId = `${targetId}:text`;
  const optimisticPartIds = state.partIdsByMessage[input.optimisticMessageId] ?? [];
  const optimisticPart = optimisticPartIds[0] ? state.messagePartsById[optimisticPartIds[0]] : null;
  const text = optimisticPart?.kind === 'text' ? optimisticPart.text : '';
  // 图片留着本机的数据，送达以后不用再向 daemon 取一次。快照（include=images）补上 daemon 给的 id。
  const imageParts = optimisticPartIds.flatMap((id) => {
    const part = state.messagePartsById[id];
    return part?.kind === 'image' ? [part] : [];
  }).map((part, index): MessagePart => ({ ...part, id: `${targetId}:image:${index}` }));
  const messagesById = { ...state.messagesById };
  const messagePartsById = { ...state.messagePartsById };
  const partIdsByMessage = { ...state.partIdsByMessage };
  delete messagesById[input.optimisticMessageId];
  delete messagesById[targetId];
  delete partIdsByMessage[input.optimisticMessageId];
  for (const id of optimisticPartIds) delete messagePartsById[id];
  for (const id of state.partIdsByMessage[targetId] ?? []) delete messagePartsById[id];
	  const { delivery: _delivery, ...sent } = optimistic;
	  messagesById[targetId] = {
	    ...sent,
	    id: targetId,
	    turnId: input.turnId,
	    ticketId: turn.ticketId,
	    state: 'completed',
	    failure: null,
	  };
	  messagePartsById[targetPartId] = { kind: 'text', id: targetPartId, text };
	  for (const image of imageParts) messagePartsById[image.id] = image;
	  partIdsByMessage[targetId] = [targetPartId, ...imageParts.map((image) => image.id)];
	  const ticketId = turn.ticketId;
	  const scopedToTicket = ticketId !== null;
	  const previousIds = scopedToTicket
	    ? state.messageIdsByTicket[ticketId] ?? []
	    : state.messageIdsBySession[input.sessionId] ?? [];
	  const messageIds = previousIds
	    .map((id: string) => id === input.optimisticMessageId ? targetId : id)
	    .filter((id: string, index: number, values: string[]) => values.indexOf(id) === index);
	  store.setState({
	    turnsById: { ...state.turnsById, [turn.id]: { ...turn, userMessageId: targetId } },
	    messagesById,
	    messageIdsBySession: scopedToTicket
	      ? state.messageIdsBySession
	      : { ...state.messageIdsBySession, [input.sessionId]: messageIds },
	    messageIdsByTicket: scopedToTicket
	      ? { ...state.messageIdsByTicket, [ticketId]: messageIds }
	      : state.messageIdsByTicket,
	    messagePartsById,
    partIdsByMessage,
    turnIdByCommandId: { ...state.turnIdByCommandId, [input.commandId]: input.turnId },
  });
}

export function failOptimisticMessage(
  store: ControlPlaneStore,
  messageId: string,
  failure: MessageEntity['failure'],
): void {
  const state = store.getState();
  const message = state.messagesById[messageId];
  if (!message || message.source !== 'optimistic') return;
  store.setState({
    messagesById: {
      ...state.messagesById,
      [messageId]: { ...message, state: 'failed', failure, updatedAt: new Date().toISOString() },
    },
  });
}

export function dismissOptimisticMessage(store: ControlPlaneStore, messageId: string): boolean {
  const state = store.getState();
  const message = state.messagesById[messageId];
  if (!message || message.source !== 'optimistic') return false;
  const messagesById = { ...state.messagesById };
  const messagePartsById = { ...state.messagePartsById };
  const partIdsByMessage = { ...state.partIdsByMessage };
  delete messagesById[messageId];
  for (const partId of state.partIdsByMessage[messageId] ?? []) delete messagePartsById[partId];
  delete partIdsByMessage[messageId];
  store.setState({
    messagesById,
    messagePartsById,
    partIdsByMessage,
	    messageIdsBySession: {
	      ...state.messageIdsBySession,
	      [message.sessionId]: (state.messageIdsBySession[message.sessionId] ?? []).filter((id) => id !== messageId),
	    },
	    messageIdsByTicket: message.ticketId === null ? state.messageIdsByTicket : {
	      ...state.messageIdsByTicket,
	      [message.ticketId]: (state.messageIdsByTicket[message.ticketId] ?? []).filter((id) => id !== messageId),
	    },
	  });
  return true;
}

// daemon 重试同一件事（例如同一条通知的播报）时复用已经结束的系统回合（store 的 reopenTurn）。
// 这一轮从头开始：清掉上一次的文字、工具和失败，时间改成这一次开始的时间，排到会话的末尾。
function restartLeadTurn(store: ControlPlaneStore, sessionId: string, turn: LeadTurnEntity, occurredAt: string): void {
  const state = store.getState();
  const assistant = state.messagesById[turn.assistantMessageId];
  const textPartId = `${turn.assistantMessageId}:text`;
  const own = new Set([turn.userMessageId, turn.assistantMessageId]);
  const moveToEnd = (ids: string[] | undefined) => ids?.some((id) => own.has(id))
    ? [...ids.filter((id) => !own.has(id)), turn.userMessageId, turn.assistantMessageId]
    : ids;
  const sessionTurns = state.turnIdsBySession[sessionId] ?? [];
  const sessionMessages = moveToEnd(state.messageIdsBySession[sessionId]);
  const ticketMessages = turn.ticketId === null ? undefined : moveToEnd(state.messageIdsByTicket[turn.ticketId]);
  store.setState({
    turnsById: {
      ...state.turnsById,
      [turn.id]: { ...turn, state: 'streaming', error: null, createdAt: occurredAt, updatedAt: occurredAt },
    },
    turnIdsBySession: sessionTurns.includes(turn.id)
      ? { ...state.turnIdsBySession, [sessionId]: [...sessionTurns.filter((id) => id !== turn.id), turn.id] }
      : state.turnIdsBySession,
    messagesById: assistant ? {
      ...state.messagesById,
      [assistant.id]: { ...assistant, state: 'streaming', failure: null, createdAt: occurredAt, updatedAt: occurredAt },
    } : state.messagesById,
    messageIdsBySession: sessionMessages
      ? { ...state.messageIdsBySession, [sessionId]: sessionMessages }
      : state.messageIdsBySession,
    messageIdsByTicket: turn.ticketId !== null && ticketMessages
      ? { ...state.messageIdsByTicket, [turn.ticketId]: ticketMessages }
      : state.messageIdsByTicket,
    messagePartsById: { ...state.messagePartsById, [textPartId]: { kind: 'text', id: textPartId, text: '' } },
    partIdsByMessage: { ...state.partIdsByMessage, [turn.assistantMessageId]: [textPartId] },
  });
}

function ensureLeadShell(
  store: ControlPlaneStore,
  sessionId: string,
  turnId: string,
  ticketId: number | null,
  occurredAt: string,
  originKind = 'live',
): void {
  const state = store.getState();
  if (state.turnsById[turnId]) return;
  const userMessageId = `${sessionId}:${turnId}:user`;
  const assistantMessageId = `${sessionId}:${turnId}:assistant`;
  const userPartId = `${userMessageId}:text`;
  const assistantPartId = `${assistantMessageId}:text`;
  const turn: LeadTurnEntity = {
    id: turnId,
    sessionId,
    ticketId,
    originBindingId: null,
    originKind,
    state: 'streaming',
    error: null,
    userMessageId,
    assistantMessageId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
	  const user: MessageEntity = {
	    id: userMessageId,
	    sessionId,
	    turnId,
	    ticketId,
	    role: 'user',
    state: 'completed',
    failure: null,
    clientCommandId: null,
    source: 'live',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
	  const assistant: MessageEntity = {
	    id: assistantMessageId,
	    sessionId,
	    turnId,
	    ticketId,
	    role: 'assistant',
    state: 'streaming',
    failure: null,
    clientCommandId: null,
    source: 'live',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const sessionIds = state.sessionIds.includes(sessionId) ? state.sessionIds : [...state.sessionIds, sessionId];
  const turnIds = [...(state.turnIdsBySession[sessionId] ?? []), turnId];
	  const visibleMessageIds = [userMessageId, assistantMessageId];
	  const messageIds = ticketId === null
	    ? [...(state.messageIdsBySession[sessionId] ?? []), ...visibleMessageIds]
	    : state.messageIdsBySession[sessionId] ?? [];
	  const ticketMessageIds = ticketId === null
	    ? state.messageIdsByTicket
	    : { ...state.messageIdsByTicket, [ticketId]: [...(state.messageIdsByTicket[ticketId] ?? []), ...visibleMessageIds] };
  store.setState({
    sessionsById: state.sessionsById[sessionId] ? state.sessionsById : {
      ...state.sessionsById,
      [sessionId]: { id: sessionId, kind: 'lead', title: 'Lead', createdAt: occurredAt, updatedAt: occurredAt },
    },
    sessionIds,
    turnsById: { ...state.turnsById, [turnId]: turn },
    turnIdsBySession: { ...state.turnIdsBySession, [sessionId]: turnIds },
    messagesById: { ...state.messagesById, [userMessageId]: user, [assistantMessageId]: assistant },
	    messageIdsBySession: { ...state.messageIdsBySession, [sessionId]: messageIds },
	    messageIdsByTicket: ticketMessageIds,
    messagePartsById: {
      ...state.messagePartsById,
      [userPartId]: { kind: 'text', id: userPartId, text: '' },
      [assistantPartId]: { kind: 'text', id: assistantPartId, text: '' },
    },
    partIdsByMessage: {
      ...state.partIdsByMessage,
      [userMessageId]: [userPartId],
      [assistantMessageId]: [assistantPartId],
    },
    assistantMessageIdByTurnId: { ...state.assistantMessageIdByTurnId, [turnId]: assistantMessageId },
  });
}

// 发件箱里一条消息的状态，画到它的本地消息上：待发送、发送中是 queued，发送失败是 failed，带服务端拒收的原因。
export function setOutboxMessageState(
  store: ControlPlaneStore,
  messageId: string,
  entry: { state: 'pending' | 'sending' | 'failed'; error: string | null },
): void {
  const state = store.getState();
  const message = state.messagesById[messageId];
  if (!message || message.source !== 'optimistic') return;
  const next: MessageEntity = entry.state === 'failed'
    ? { ...message, state: 'failed', delivery: 'failed', failure: { kind: 'rejected', code: null, message: entry.error ?? '' } }
    : { ...message, state: 'queued', delivery: entry.state, failure: null };
  if (message.state === next.state && message.delivery === next.delivery && message.failure?.message === next.failure?.message) return;
  store.setState({ messagesById: { ...state.messagesById, [messageId]: next } });
}

// 发件箱送达了一轮：记下来，这一轮的用户消息显示「已送达」（刷新会话以后也一样）。
export function markTurnDelivered(store: ControlPlaneStore, turnId: string): void {
  const state = store.getState();
  if (state.deliveredTurnIds[turnId]) return;
  store.setState({ deliveredTurnIds: { ...state.deliveredTurnIds, [turnId]: true } });
}
