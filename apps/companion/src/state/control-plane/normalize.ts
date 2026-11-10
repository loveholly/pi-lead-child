import { classifyLeadModelError, compareConversationTurns, type ConversationTurn, type KernelConversationCard } from '@pi-lead-child/protocol';

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
    const projection = projectTurn(previous, sessionId, item);
    const { userMessageId, assistantMessageId } = projection.turn;
    turnsById[item.id] = projection.turn;
    messagesById[userMessageId] = projection.userMessage;
    messagesById[assistantMessageId] = projection.assistantMessage;
    for (const part of projection.parts) messagePartsById[part.id] = part;
    partIdsByMessage[userMessageId] = projection.userPartIds;
    partIdsByMessage[assistantMessageId] = projection.assistantPartIds;
    assistantMessageIdByTurnId[item.id] = assistantMessageId;
    if (!turnIds.includes(item.id)) turnIds.push(item.id);
    const targetMessageIds = item.ticketId === null
      ? messageIds
      : incomingTicketMessageIds.get(item.ticketId) ?? [];
    if (item.ticketId !== null && !incomingTicketMessageIds.has(item.ticketId)) {
      incomingTicketMessageIds.set(item.ticketId, targetMessageIds);
    }
    if (projection.hasUserText && !targetMessageIds.includes(userMessageId)) targetMessageIds.push(userMessageId);
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

// 主会话的快照怎样叠到手上的会话上（2026-11-04：打开时只取最近一段，往上翻时取更早的一页，Lead 说完一句只取那一轮）。
// · window：最近的一段（打开、重连）。这一段里快照没有的轮次删掉；complete（daemon 一共就这么多轮）时全部按快照。
//   比这一段更早、已经加载的历史留着，前提是和这一段接得上：接不上（离开太久，中间隔了没取的轮次）时也全部按快照，
//   不然往上翻时会跳过中间那一截。
// · merge：更早的一页，或者单独校正的几轮。只加、只改，不删。
// 两种都不碰：本机发件箱里的消息（乐观消息），比快照里最新的一轮还新的实时轮次（快照发出以后才开始的，实时事件先到了），
// 和比这一段早的工单轮次（工单对话自己取的）。
export type ConversationMerge = { kind: 'window'; complete: boolean } | { kind: 'merge' };

// 最近的一段和手上已经加载的轮次接不接得上：这一段最早的一轮不晚于手上最新的一轮（只有实时事件的轮次不算）。
export function conversationWindowJoins(
  previous: Pick<ConversationProjection, 'turnsById' | 'turnIdsBySession' | 'messagesById'>,
  sessionId: string,
  turns: readonly ConversationTurn[],
): boolean {
  const oldest = [...turns].sort(compareConversationTurns)[0];
  if (oldest === undefined) return false;
  return (previous.turnIdsBySession[sessionId] ?? []).some((id) => {
    const turn = previous.turnsById[id];
    return turn !== undefined && !isLiveOnlyTurn(previous, turn) && compareConversationTurns(oldest, turn) <= 0;
  });
}

// 只有实时事件、快照里还没见过的一轮：它的 Lead 消息还是 live。
function isLiveOnlyTurn(previous: Pick<ConversationProjection, 'messagesById'>, turn: LeadTurnEntity): boolean {
  return previous.messagesById[turn.assistantMessageId]?.source === 'live';
}

export function mergeConversationTurns(
  previous: ConversationProjection,
  sessionId: string,
  turns: ConversationTurn[],
  merge: ConversationMerge,
): ConversationProjection {
  const incoming = [...turns].sort(compareConversationTurns);
  const incomingIds = new Set(incoming.map((turn) => turn.id));
  const oldest = incoming[0];
  const newest = incoming.at(-1);
  const previousTurnIds = previous.turnIdsBySession[sessionId] ?? [];
  const liveOnly = (turn: LeadTurnEntity) => isLiveOnlyTurn(previous, turn);

  const removed = new Set<string>();
  if (merge.kind === 'window') {
    const coversAll = merge.complete || !conversationWindowJoins(previous, sessionId, incoming);
    for (const id of previousTurnIds) {
      const turn = previous.turnsById[id];
      if (!turn || incomingIds.has(id)) continue;
      const older = oldest !== undefined && compareConversationTurns(turn, oldest) < 0;
      // 比这一段早的工单轮次是工单对话自己取的历史（conversation:ticket:<id>）：主会话的快照不替它做主。
      if (older && (!coversAll || turn.ticketId !== null)) continue;
      if (liveOnly(turn) && (newest === undefined || compareConversationTurns(turn, newest) > 0)) continue;
      removed.add(id);
    }
  }

  const turnsById: Record<string, LeadTurnEntity> = { ...previous.turnsById };
  const messagesById: Record<string, MessageEntity> = { ...previous.messagesById };
  const messagePartsById: Record<string, MessagePart> = { ...previous.messagePartsById };
  const partIdsByMessage: Record<string, string[]> = { ...previous.partIdsByMessage };
  const assistantMessageIdByTurnId: Record<string, string> = { ...previous.assistantMessageIdByTurnId };
  // 列表里不再有的消息（删掉的轮次的消息，和快照说没有文字的「你的消息」）。
  const unlisted = new Set<string>();
  const touchedTickets = new Set<number>();
  const dropMessage = (messageId: string, keepPartIds: readonly string[] = []) => {
    for (const partId of previous.partIdsByMessage[messageId] ?? []) {
      if (!keepPartIds.includes(partId)) delete messagePartsById[partId];
    }
  };
  for (const id of removed) {
    const turn = previous.turnsById[id]!;
    delete turnsById[id];
    delete assistantMessageIdByTurnId[id];
    for (const messageId of [turn.userMessageId, turn.assistantMessageId]) {
      dropMessage(messageId);
      delete partIdsByMessage[messageId];
      delete messagesById[messageId];
      unlisted.add(messageId);
    }
    if (turn.ticketId !== null) touchedTickets.add(turn.ticketId);
  }

  const listedSession: string[] = [];
  const listedByTicket = new Map<number, string[]>();
  for (const item of incoming) {
    const projection = projectTurn(previous, sessionId, item);
    const { userMessageId, assistantMessageId } = projection.turn;
    turnsById[item.id] = projection.turn;
    messagesById[userMessageId] = projection.userMessage;
    messagesById[assistantMessageId] = projection.assistantMessage;
    // 这一轮不再有的部件（例如快照里换了编号的图片）不留着。
    dropMessage(userMessageId, projection.userPartIds);
    dropMessage(assistantMessageId, projection.assistantPartIds);
    for (const part of projection.parts) messagePartsById[part.id] = part;
    partIdsByMessage[userMessageId] = projection.userPartIds;
    partIdsByMessage[assistantMessageId] = projection.assistantPartIds;
    assistantMessageIdByTurnId[item.id] = assistantMessageId;
    const listed = item.ticketId === null ? listedSession : listedByTicket.get(item.ticketId) ?? [];
    if (item.ticketId !== null) {
      listedByTicket.set(item.ticketId, listed);
      touchedTickets.add(item.ticketId);
    }
    if (projection.hasUserText) listed.push(userMessageId);
    else unlisted.add(userMessageId);
    listed.push(assistantMessageId);
  }

  const turnIds = [...new Set([...previousTurnIds.filter((id) => !removed.has(id) && turnsById[id]), ...incoming.map((turn) => turn.id)])]
    .sort((left, right) => compareConversationTurns(turnsById[left]!, turnsById[right]!));
  const orderMessages = (current: readonly string[], listed: readonly string[]) => orderConversationMessages(
    [...current.filter((id) => !unlisted.has(id)), ...listed],
    messagesById,
    turnsById,
  );
  const messageIdsByTicket: Record<number, string[]> = { ...previous.messageIdsByTicket };
  for (const ticketId of touchedTickets) {
    messageIdsByTicket[ticketId] = reuseArray(
      previous.messageIdsByTicket[ticketId] ?? [],
      orderMessages(previous.messageIdsByTicket[ticketId] ?? [], listedByTicket.get(ticketId) ?? []),
    );
  }
  const session: LeadSessionEntity = previous.sessionsById[sessionId] ?? {
    id: sessionId,
    kind: 'lead',
    title: 'Lead',
    createdAt: oldest?.createdAt ?? null,
    updatedAt: newest?.updatedAt ?? null,
  };

  return {
    sessionsById: reuseRecord(previous.sessionsById, { ...previous.sessionsById, [sessionId]: session }),
    sessionIds: previous.sessionIds.includes(sessionId) ? previous.sessionIds : [...previous.sessionIds, sessionId],
    turnsById: reuseRecord(previous.turnsById, turnsById),
    turnIdsBySession: reuseRecord(previous.turnIdsBySession, {
      ...previous.turnIdsBySession,
      [sessionId]: reuseArray(previousTurnIds, turnIds),
    }),
    messagesById: reuseRecord(previous.messagesById, messagesById),
    messageIdsBySession: reuseRecord(previous.messageIdsBySession, {
      ...previous.messageIdsBySession,
      [sessionId]: reuseArray(
        previous.messageIdsBySession[sessionId] ?? [],
        orderMessages(previous.messageIdsBySession[sessionId] ?? [], listedSession),
      ),
    }),
    messageIdsByTicket: reuseRecord(previous.messageIdsByTicket, messageIdsByTicket),
    messagePartsById: reuseRecord(previous.messagePartsById, messagePartsById),
    partIdsByMessage: reuseRecord(previous.partIdsByMessage, partIdsByMessage),
    assistantMessageIdByTurnId: reuseRecord(previous.assistantMessageIdByTurnId, assistantMessageIdByTurnId),
    turnIdByCommandId: previous.turnIdByCommandId,
  };
}

// 会话列表的顺序：有轮次的消息按轮次的先后（同一轮里你的消息在前），本机发件箱里的消息（还没有轮次）排在最后、保持原来的先后。
function orderConversationMessages(
  ids: readonly string[],
  messagesById: Record<string, MessageEntity>,
  turnsById: Record<string, LeadTurnEntity>,
): string[] {
  const turnOf = (id: string) => {
    const message = messagesById[id];
    if (!message || message.source === 'optimistic' || message.turnId === null) return undefined;
    return turnsById[message.turnId];
  };
  return [...new Set(ids)].filter((id) => messagesById[id] !== undefined).sort((left, right) => {
    const leftTurn = turnOf(left);
    const rightTurn = turnOf(right);
    if (!leftTurn || !rightTurn) return leftTurn ? -1 : rightTurn ? 1 : 0;
    const order = compareConversationTurns(leftTurn, rightTurn);
    if (order !== 0) return order;
    return messagesById[left]!.role === messagesById[right]!.role ? 0 : messagesById[left]!.role === 'user' ? -1 : 1;
  });
}

// 快照里的一轮在客户端上的样子：这一轮、你的消息、Lead 的消息和它们的部件。手上已有、值也一样的原样复用。
type TurnProjection = {
  turn: LeadTurnEntity;
  userMessage: MessageEntity;
  assistantMessage: MessageEntity;
  // 要写进 messagePartsById 的部件。
  parts: MessagePart[];
  userPartIds: string[];
  assistantPartIds: string[];
  // 你的消息进不进会话列表：只发了图片的消息没有文字，也是你的一条消息。
  hasUserText: boolean;
};

function projectTurn(previous: ConversationProjection, sessionId: string, item: ConversationTurn): TurnProjection {
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
    // 回答写到一半被你的插话打断了（2026-11-10，快照里 include=interrupted 才有）。
    ...(item.interrupted === undefined ? {} : { interrupted: item.interrupted }),
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
    // 会话列表据此认出它还是你发的那一条（ChatList 不因为刷新把你拽回底部）。
    clientCommandId: previous.messagesById[userMessageId]?.clientCommandId ?? null,
    source: 'snapshot',
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
  };
  // Lead 的回答从开始回答的时刻算起（2026-11-09，include=answer_started）：排队、插话的消息要等前一轮答完。
  // 快照没带它（旧 daemon）时，留着实时事件记下的时刻（actions.ts 的 lead.start-turn），刷新不把回答挪回发出的时刻。
  const previousAssistant = previous.messagesById[assistantMessageId];
  const answerStartedAt = item.answerStartedAt
    ?? (previousAssistant && previousAssistant.createdAt > item.createdAt ? previousAssistant.createdAt : item.createdAt);
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
    createdAt: answerStartedAt,
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

  const parts: MessagePart[] = [
    reuseValue(previous.messagePartsById[userTextPartId], userTextPart),
    ...userImageParts.map((part) => reuseValue(previous.messagePartsById[part.id], part)),
    reuseValue(previous.messagePartsById[assistantTextPartId], assistantTextPart),
    ...liveAssistantPartIds.map((partId) => previous.messagePartsById[partId]!),
  ];
  for (const part of [...snapshotToolParts, ...snapshotSurfaceParts]) {
    const prior = previous.messagePartsById[part.id];
    // 已经收到定稿的卡片：晚到的快照里还是生成中的版本时，不退回去。
    if (part.kind === 'surface' && part.partial && prior?.kind === 'surface' && !prior.partial) {
      parts.push(prior);
      continue;
    }
    parts.push(reuseValue(prior, part));
  }
  return {
    turn: reuseValue(previous.turnsById[item.id], turnEntity),
    userMessage: reuseValue(previous.messagesById[userMessageId], userMessage),
    assistantMessage: reuseValue(previous.messagesById[assistantMessageId], assistantMessage),
    parts,
    userPartIds: reuseArray(
      previous.partIdsByMessage[userMessageId] ?? [],
      [userTextPartId, ...userImageParts.map((part) => part.id)],
    ),
    // 快照里的工具调用按开始的先后排在文字后面；快照还没见到的实时 part（快照取得早于这些事件）接在后面。
    assistantPartIds: reuseArray(
      previous.partIdsByMessage[assistantMessageId] ?? [],
      [
        assistantTextPartId,
        ...snapshotToolParts.map((part) => part.id),
        ...snapshotSurfaceParts.map((part) => part.id),
        ...liveAssistantPartIds.filter((partId) => !snapshotToolPartIds.has(partId)),
      ],
    ),
    hasUserText,
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
