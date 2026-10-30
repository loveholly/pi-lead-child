import { classifyLeadModelError, type ConversationTurn, type KernelConversationCard } from '@pi-lead-child/protocol';

import type {
  ControlPlaneData,
  ConversationCardEntity,
  LeadSessionEntity,
  LeadTurnEntity,
  MessageEntity,
  MessagePart,
  TransientConversationCard,
} from '../types';

export interface NormalizedCollection<T, K extends string | number> {
  byId: Record<K, T>;
  ids: K[];
}

export type PageMergeMode = 'replace' | 'append' | 'prepend';

export type ConversationProjection = Pick<
  ControlPlaneData,
  | 'sessionsById'
  | 'sessionIds'
  | 'turnsById'
  | 'turnIdsBySession'
	  | 'messagesById'
	  | 'messageIdsBySession'
	  | 'messageIdsByTicket'
	  | 'messagePartsById'
  | 'partIdsByMessage'
  | 'assistantMessageIdByTurnId'
  | 'turnIdByCommandId'
>;

export function normalizeEntitySnapshot<T, K extends string | number>(
  previousById: Record<K, T>,
  previousIds: K[],
  items: T[],
  getId: (item: T) => K,
): NormalizedCollection<T, K> {
  const ids = items.map(getId);
  const byId = {} as Record<K, T>;
  for (const item of items) {
    const id = getId(item);
    const previous = previousById[id];
    byId[id] = previous !== undefined && equalValue(previous, item) ? previous : item;
  }
  const stableIds = equalArray(previousIds, ids) ? previousIds : ids;
  const stableById = equalRecordReferences(previousById, byId) ? previousById : byId;
  return { byId: stableById, ids: stableIds };
}

export function normalizeEntityPage<T, K extends string | number>(
  previousById: Record<K, T>,
  previousIds: K[],
  items: T[],
  getId: (item: T) => K,
  mode: PageMergeMode,
  compare?: (left: K, right: K) => number,
): NormalizedCollection<T, K> {
  const byId = (mode === 'replace' ? {} : { ...previousById }) as Record<K, T>;
  const incomingIds: K[] = [];
  for (const item of items) {
    const id = getId(item);
    const previous = previousById[id];
    byId[id] = previous !== undefined && equalValue(previous, item) ? previous : item;
    incomingIds.push(id);
  }
  const ids = mergeOrderedIds(previousIds, incomingIds, mode, compare);
  return {
    byId: equalRecordReferences(previousById, byId) ? previousById : byId,
    ids: equalArray(previousIds, ids) ? previousIds : ids,
  };
}

export function mergeOrderedIds<K extends string | number>(
  previousIds: K[],
  incomingIds: K[],
  mode: PageMergeMode,
  compare?: (left: K, right: K) => number,
): K[] {
  const uniqueIncoming = incomingIds.filter((id, index) => incomingIds.indexOf(id) === index);
  let ids: K[];
  if (mode === 'replace') {
    ids = uniqueIncoming;
  } else if (mode === 'prepend') {
    ids = [...uniqueIncoming, ...previousIds.filter((id) => !uniqueIncoming.includes(id))];
  } else {
    ids = [...previousIds, ...uniqueIncoming.filter((id) => !previousIds.includes(id))];
  }
  if (compare) ids.sort(compare);
  return ids;
}

export function conversationCardEntity(
  card: KernelConversationCard | TransientConversationCard,
  durableId: number | null,
  previous?: ConversationCardEntity,
): ConversationCardEntity {
  const { id: _durableId, ...projection } = card as KernelConversationCard;
  const entity = {
    ...projection,
    id: card.key,
    durableId,
    source: durableId === null ? 'live' : 'durable',
  } as ConversationCardEntity;
  return previous !== undefined && equalValue(previous, entity) ? previous : entity;
}

export function normalizeConversationSnapshot(
  previous: ConversationProjection,
  sessionId: string,
  turns: ConversationTurn[],
  scope: { ticketId?: number } = {},
): ConversationProjection {
  const scopedTicketId = scope.ticketId;
  const scopedToTicket = scopedTicketId !== undefined;
  const session: LeadSessionEntity = {
    id: sessionId,
    kind: 'lead',
    title: 'Lead',
    createdAt: turns[0]?.createdAt ?? null,
    updatedAt: turns.at(-1)?.updatedAt ?? null,
  };
  const sessionsById = reuseRecord(previous.sessionsById, {
    [sessionId]: reuseValue(previous.sessionsById[sessionId], session),
  });
  const sessionIds = reuseArray(previous.sessionIds, [sessionId]);
  const turnsById: Record<string, LeadTurnEntity> = scopedToTicket ? { ...previous.turnsById } : {};
  const messagesById: Record<string, MessageEntity> = scopedToTicket ? { ...previous.messagesById } : {};
  const messagePartsById: Record<string, MessagePart> = scopedToTicket ? { ...previous.messagePartsById } : {};
  const assistantMessageIdByTurnId: Record<string, string> = scopedToTicket ? { ...previous.assistantMessageIdByTurnId } : {};
  const turnIds: string[] = scopedToTicket ? [...(previous.turnIdsBySession[sessionId] ?? [])] : [];
  const messageIds: string[] = scopedToTicket
    ? [...new Set(previous.messageIdsBySession[sessionId] ?? [])]
    : [];
  const messageIdsByTicket: Record<number, string[]> = scopedToTicket
    ? Object.fromEntries(Object.entries(previous.messageIdsByTicket).map(([ticketId, ids]) => [ticketId, [...new Set(ids)]]))
    : {};
  const incomingTicketMessageIds = new Map<number, string[]>();
  if (scopedTicketId !== undefined) incomingTicketMessageIds.set(scopedTicketId, []);
  const partIdsByMessage: Record<string, string[]> = scopedToTicket ? { ...previous.partIdsByMessage } : {};

  for (const item of turns) {
    // 只发了图片的消息没有文字，也是用户的一条消息。
    const hasUserText = item.userText.trim().length > 0 || (item.images?.length ?? 0) > 0;
    const userMessageId = `${sessionId}:${item.id}:user`;
    const assistantMessageId = `${sessionId}:${item.id}:assistant`;
    const userTextPartId = `${userMessageId}:text`;
    const assistantTextPartId = `${assistantMessageId}:text`;
    const turnEntity: LeadTurnEntity = {
      id: item.id,
      sessionId,
      ticketId: item.ticketId,
      originBindingId: item.originBindingId,
      originKind: item.originKind,
      state: item.state,
      error: item.error,
      userMessageId,
      assistantMessageId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      // 用户的消息怎么放的（工单 04，快照里 include=placement 才有）。
      ...(item.placement === undefined ? {} : { placement: item.placement }),
      ...(item.answeredWith === undefined ? {} : { answeredWith: item.answeredWith }),
      // 工单回复在问你要不要做的动作（2026-10-19，快照里 include=reply_actions 才有）。
      ...(item.replyActions === undefined ? {} : { replyActions: item.replyActions }),
    };
	    const userMessage: MessageEntity = {
	      id: userMessageId,
	      sessionId,
	      turnId: item.id,
	      ticketId: item.ticketId,
	      role: 'user',
      state: 'completed',
      failure: null,
      // 本机发件箱发出的消息送达以后，快照里的同一条消息留着它的 clientMessageId：
      // 会话列表据此认出它还是你发的那一条（ChatScroll 不因为刷新把你拽回底部）。
      clientCommandId: previous.messagesById[userMessageId]?.clientCommandId ?? null,
      source: 'snapshot',
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    };
	    const assistantMessage: MessageEntity = {
	      id: assistantMessageId,
	      sessionId,
	      turnId: item.id,
	      ticketId: item.ticketId,
	      role: 'assistant',
      state: item.state,
      // 排着队却带着错误：用户的一轮没答上，在等那一次自动重试（daemon 的 waitToRetry）。
      failure: item.error === null ? null : item.state === 'queued' ? {
        kind: 'retry-pending',
        code: classifyLeadModelError(item.error) === 'network' ? 'network' : 'model',
        message: item.error,
      } : {
        kind: 'turn-error',
        code: null,
        message: item.error,
      },
      clientCommandId: null,
      source: 'snapshot',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    const userTextPart: MessagePart = { kind: 'text', id: userTextPartId, text: item.userText };
    // 用户发的图片（include=images）。本机刚发出去的那几张还留着数据，留下它们，不用再向 daemon 取。
    // 快照没带 images（旧 daemon，或者退回了少要几项的请求）时，留着已有的图片。
    const previousImageParts = (previous.partIdsByMessage[userMessageId] ?? []).flatMap((partId) => {
      const part = previous.messagePartsById[partId];
      return part?.kind === 'image' ? [part] : [];
    });
    const userImageParts: MessagePart[] = item.images === undefined ? previousImageParts : item.images.map((image, index) => {
      const id = `${userMessageId}:image:${index}`;
      const prior = previous.messagePartsById[id];
      const data = prior?.kind === 'image' && (prior.imageId === undefined || prior.imageId === image.id) ? prior.data : undefined;
      return { kind: 'image', id, mimeType: image.mimeType, imageId: image.id, ...(data === undefined ? {} : { data }) };
    });
    const assistantTextPart: MessagePart = {
      kind: 'text',
      id: assistantTextPartId,
      text: item.assistantText,
    };
    const liveAssistantPartIds = (previous.partIdsByMessage[assistantMessageId] ?? []).filter((partId) => {
      const part = previous.messagePartsById[partId];
      return part !== undefined && part.kind !== 'text';
    });
    const snapshotToolParts = (item.toolCalls ?? []).map((call) => snapshotToolPart(
      previous.messagePartsById[`${item.id}:${call.callId}`],
      { kind: 'tool', ...call, id: `${item.id}:${call.callId}` },
    ));
    const snapshotToolPartIds = new Set(snapshotToolParts.map((part) => part.id));
    // Lead 在这一轮画的卡片（include=surfaces）。和实时事件用同一个部件 id，刷新以后还是同一张卡。
    const snapshotSurfaceParts: MessagePart[] = (item.surfaces ?? []).map((placement) => ({
      kind: 'surface',
      id: `${item.id}:surface:${placement.callId}`,
      callId: placement.callId,
      textOffset: placement.textOffset,
      // 刷新时这一轮还在流：快照里的是「生成中」的版本，后面的流式版本要能替换它。
      partial: placement.partial === true,
      surface: placement.surface,
    }));
    for (const part of snapshotSurfaceParts) snapshotToolPartIds.add(part.id);

    turnsById[item.id] = reuseValue(previous.turnsById[item.id], turnEntity);
    messagesById[userMessageId] = reuseValue(previous.messagesById[userMessageId], userMessage);
    messagesById[assistantMessageId] = reuseValue(previous.messagesById[assistantMessageId], assistantMessage);
    messagePartsById[userTextPartId] = reuseValue(previous.messagePartsById[userTextPartId], userTextPart);
    for (const part of userImageParts) messagePartsById[part.id] = reuseValue(previous.messagePartsById[part.id], part);
    messagePartsById[assistantTextPartId] = reuseValue(
      previous.messagePartsById[assistantTextPartId],
      assistantTextPart,
    );
    for (const partId of liveAssistantPartIds) {
      messagePartsById[partId] = previous.messagePartsById[partId];
    }
    for (const part of [...snapshotToolParts, ...snapshotSurfaceParts]) {
      const prior = previous.messagePartsById[part.id];
      // 已经收到定稿的卡片：晚到的快照里还是生成中的版本时，不退回去。
      if (part.kind === 'surface' && part.partial && prior?.kind === 'surface' && !prior.partial) {
        messagePartsById[part.id] = prior;
        continue;
      }
      messagePartsById[part.id] = reuseValue(prior, part);
    }
    partIdsByMessage[userMessageId] = reuseArray(
      previous.partIdsByMessage[userMessageId] ?? [],
      [userTextPartId, ...userImageParts.map((part) => part.id)],
    );
    // 快照里的工具调用按开始的先后排在文字后面；快照还没见到的实时 part（快照取得早于这些事件）接在后面。
    partIdsByMessage[assistantMessageId] = reuseArray(
      previous.partIdsByMessage[assistantMessageId] ?? [],
      [
        assistantTextPartId,
        ...snapshotToolParts.map((part) => part.id),
        ...snapshotSurfaceParts.map((part) => part.id),
        ...liveAssistantPartIds.filter((partId) => !snapshotToolPartIds.has(partId)),
      ],
    );
	    assistantMessageIdByTurnId[item.id] = assistantMessageId;
	    if (!turnIds.includes(item.id)) turnIds.push(item.id);
	    const targetMessageIds = item.ticketId === null
	      ? messageIds
	      : incomingTicketMessageIds.get(item.ticketId) ?? [];
	    if (item.ticketId !== null && !incomingTicketMessageIds.has(item.ticketId)) {
	      incomingTicketMessageIds.set(item.ticketId, targetMessageIds);
	    }
    if (hasUserText && !targetMessageIds.includes(userMessageId)) targetMessageIds.push(userMessageId);
    if (!targetMessageIds.includes(assistantMessageId)) targetMessageIds.push(assistantMessageId);
	  }

	  for (const [ticketId, ids] of incomingTicketMessageIds) {
    messageIdsByTicket[ticketId] = reuseArray(previous.messageIdsByTicket[ticketId] ?? [], [...new Set(ids)]);
	  }

	  for (const messageId of Object.keys(previous.messagesById)) {
	    const message = previous.messagesById[messageId];
	    if (!message || message.source !== 'optimistic' || messagesById[messageId]) continue;
	    messagesById[messageId] = message;
	    if (message.ticketId === null) messageIds.push(messageId);
	    else {
	      messageIdsByTicket[message.ticketId] = [
	        ...(messageIdsByTicket[message.ticketId] ?? []),
	        messageId,
	      ].filter((id, index, values) => values.indexOf(id) === index);
	    }
	    const partIds = previous.partIdsByMessage[messageId] ?? [];
	    partIdsByMessage[messageId] = partIds;
    for (const partId of partIds) {
      const part = previous.messagePartsById[partId];
      if (part) messagePartsById[partId] = part;
    }
  }

  return {
    sessionsById,
    sessionIds,
    turnsById: reuseRecord(previous.turnsById, turnsById),
    turnIdsBySession: reuseRecord(previous.turnIdsBySession, {
      [sessionId]: reuseArray(previous.turnIdsBySession[sessionId] ?? [], turnIds),
    }),
	    messagesById: reuseRecord(previous.messagesById, messagesById),
	    messageIdsBySession: reuseRecord(previous.messageIdsBySession, {
	      [sessionId]: reuseArray(previous.messageIdsBySession[sessionId] ?? [], messageIds),
	    }),
	    messageIdsByTicket: reuseRecord(previous.messageIdsByTicket, messageIdsByTicket),
	    messagePartsById: reuseRecord(previous.messagePartsById, messagePartsById),
    partIdsByMessage: reuseRecord(previous.partIdsByMessage, partIdsByMessage),
    assistantMessageIdByTurnId: reuseRecord(
      previous.assistantMessageIdByTurnId,
      assistantMessageIdByTurnId,
    ),
    turnIdByCommandId: previous.turnIdByCommandId,
  };
}

type ToolPart = Extract<MessagePart, { kind: 'tool' }>;

// 快照可能早于已经收到的实时事件（请求还在路上时工具结束了）。实时已经结束、快照还在跑的调用，留实时的。
function snapshotToolPart(live: MessagePart | undefined, snapshot: ToolPart): ToolPart {
  if (live?.kind !== 'tool') return snapshot;
  const ended = (part: ToolPart) => part.state === 'completed' || part.state === 'failed';
  return ended(live) && !ended(snapshot) ? live : snapshot;
}

export function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function reuseValue<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && equalValue(previous, next) ? previous : next;
}

export function equalArray<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

export function reuseArray<T>(previous: T[], next: T[]): T[] {
  return equalArray(previous, next) ? previous : next;
}

export function equalRecordReferences<T>(left: Record<string | number, T>, right: Record<string | number, T>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every((key) => Object.is(left[key], right[key]));
}

export function reuseRecord<T, K extends string | number>(previous: Record<K, T>, next: Record<K, T>): Record<K, T> {
  return equalRecordReferences(previous, next) ? previous : next;
}
