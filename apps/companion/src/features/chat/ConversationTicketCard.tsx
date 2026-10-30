import { Column, Text } from '@pi-lead-child/components';
import type { ReactElement } from 'react';

import type { ConversationCardEntity } from '../../state/types';
import { useConversationItemDetail, useLeadName, useTicketSummary } from '../../state/hooks';
import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';
import { TicketChip } from './EmbeddedTicketCard';
import { itemOperationDoneWords, REMINDER_OPERATIONS, reminderEventWords } from './itemOperationWords';
import { ReminderCard } from './ReminderCard';
import { TicketExecutionCard } from './TicketExecutionCard';
import { useOpenAgenda } from './useOpenAgenda';
import { useOpenTicket } from './useOpenTicket';

type TicketExecutionConversationCardEntity = ConversationCardEntity & { kind: 'ticket_execution' };

// 卡片上最后一个做完的操作自己说了什么（「提醒 #83 已创建」）。事项还没取到、或者取不到时，卡片说这一句，不一直等。
function operationWords(card: TicketExecutionConversationCardEntity): string | null {
  for (const operation of [...card.operations].reverse()) {
    if (operation.state !== 'completed') continue;
    const words = itemOperationDoneWords(operation.name, card.ticketId);
    if (words) return words;
  }
  return null;
}

// 会话里一轮 Lead 回复碰到的一条事项（ticket_execution 卡片）。
// 工单列表只装 task。不在列表里的事项（提醒，或者刚建好、列表还没刷新的工单）按编号取它的 TicketDetail（不论 kind），
// 读的还是同一份 TicketSummary（AGENTS.md 的 Core Invariants）。提醒画成提醒卡，点开日程（2026-10-16 决定 D4）。
// contextLabel：工单卡上面的那一行（「其他工单 · #3」）。提醒不是工单，不写这一行。
export function TicketExecutionConversationCard({
  card,
  collapsed,
  compact,
  contextLabel = null,
}: {
  card: TicketExecutionConversationCardEntity;
  collapsed: boolean;
  compact: boolean;
  contextLabel?: string | null;
}) {
  const summary = useTicketSummary(card.ticketId);
  const { detail } = useConversationItemDetail(card.ticketId, !summary);
  const openTicket = useOpenTicket();
  const openAgenda = useOpenAgenda();
  const leadName = useLeadName();
  const item = summary ?? detail?.ticket;
  const fallback = operationWords(card);
  const reminderOperation = card.operations.some((operation) => REMINDER_OPERATIONS.has(operation.name));
  if (item?.kind === 'reminder' || (!item && reminderOperation)) {
    // 事件只认最后一个做完了的操作：失败的、还在跑的取消不能写成「<Lead 的名字> 取消了它」（AGENTS.md Core Invariants 第 4 条）。
    const latest = [...card.operations].reverse().find((operation) => operation.state === 'completed');
    return (
      <ReminderCard
        view={{
          reminderId: card.ticketId,
          title: item ? ticketDisplayTitle(item) : null,
          remindAt: detail?.remindAt ?? null,
          stage: item?.stage ?? null,
          event: latest ? reminderEventWords(latest.name, leadName) : null,
          fallback,
          level: detail?.reminder?.level ?? null,
        }}
      />
    );
  }
  const labelled = (content: ReactElement) => (contextLabel ? (
    <Column gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{contextLabel}</Text>
      {content}
    </Column>
  ) : content);
  if (!item) return labelled(<TicketExecutionCard card={card} compact={compact} onOpenTicket={openTicket} fallback={fallback} />);
  const ticket = ticketSummaryToTicket(item);
  if (collapsed) return <TicketChip ticket={ticket} onPress={() => openTicket(card.ticketId)} />;
  return labelled(<TicketExecutionCard card={card} compact={compact} onOpenTicket={openTicket} ticket={ticket} />);
}
