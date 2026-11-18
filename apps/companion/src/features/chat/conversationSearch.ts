// 会话搜索（工单 #339）里不碰界面的部分：找到命中的消息在会话里的哪一行，上一条、下一条的循环，发送者怎么写。
type MessageLike = { role: string; turnId: string | null };
// LeadConversationRow 里搜索要看的几种行（不引 LeadConversation，免得两个文件互相引用）。
type SearchableRow =
  | { kind: 'message'; key: string; messageId: string }
  | { kind: 'failure-group' | 'owner-action-group'; key: string; messageIds: string[] }
  | { kind: 'incident'; key: string; noticeMessageIds: string[]; failureMessageIds: string[] }
  | { kind: 'ticket-direct'; key: string; turnId: string }
  | { kind: string; key: string };

function idsOfRow(row: SearchableRow): readonly string[] {
  const shape = row as { messageId?: string; messageIds?: string[]; noticeMessageIds?: string[]; failureMessageIds?: string[] };
  if (row.kind === 'message') return shape.messageId ? [shape.messageId] : [];
  if (row.kind === 'failure-group' || row.kind === 'owner-action-group') return shape.messageIds ?? [];
  if (row.kind === 'incident') return [...(shape.noticeMessageIds ?? []), ...(shape.failureMessageIds ?? [])];
  return [];
}

/**
 * 命中的那一轮、那一侧在会话里的哪一行。找不到（例如它被合并进了别的卡片）返回 null。
 * 先找同一侧的消息；没有就找这一轮的任何一条消息。
 */
export function rowKeyForTurn(
  rows: readonly SearchableRow[],
  messagesById: Readonly<Record<string, MessageLike | undefined>>,
  hit: { turnId: string; role: 'user' | 'assistant' },
): string | null {
  let fallback: string | null = null;
  for (const row of rows) {
    const ids = idsOfRow(row);
    for (const id of ids) {
      const message = messagesById[id];
      if (message?.turnId !== hit.turnId) continue;
      if (message.role === hit.role) return row.key;
      fallback ??= row.key;
    }
    if (row.kind === 'ticket-direct' && (row as { turnId?: string }).turnId === hit.turnId) fallback ??= row.key;
  }
  return fallback;
}

/** 上一条、下一条：到首尾时循环。current 是 -1（还没选）时，下一条是第一条，上一条是最后一条。 */
export function cycleIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** 发送者：你自己发的（paired:）、别人发的（外部渠道）、回答（assistant）。 */
export function senderKind(hit: { role: 'user' | 'assistant'; originKind: string }): 'you' | 'other' | 'lead' {
  if (hit.role === 'assistant') return 'lead';
  return hit.originKind.startsWith('paired:') ? 'you' : 'other';
}
