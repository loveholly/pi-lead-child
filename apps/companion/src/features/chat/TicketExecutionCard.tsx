import { Card, Column, Icon, Pressable, Row, Text } from '@pi-lead-child/components';
import type { TicketOperationProjection } from '@pi-lead-child/protocol';

import type { ConversationCardEntity } from '../../state/types';
import type { Ticket } from '../workspace/model';
import { EmbeddedTicketCard } from './EmbeddedTicketCard';

const MAX_VISIBLE_OPERATIONS = 16;
const MAX_COLLAPSED_OPERATIONS = 4;

type TicketExecutionConversationCard = ConversationCardEntity & { kind: 'ticket_execution' };

export type TicketExecutionViewModel = {
  ticketId: string;
  title: string;
  statusLabel: string | null;
  priorityLabel: string | null;
  project: string | null;
  operations: TicketOperationProjection[];
  operationsTruncated: boolean;
};

export function buildTicketExecutionViewModel(
  card: TicketExecutionConversationCard,
  ticket?: Ticket,
): TicketExecutionViewModel {
  return {
    ticketId: String(card.ticketId),
    title: ticket?.title ?? `工单 #${card.ticketId}`,
    statusLabel: ticket?.statusLabel ?? null,
    priorityLabel: ticket?.priorityLabel ?? null,
    project: ticket?.project ?? null,
    operations: boundTicketExecutionOperations(card.operations),
    operationsTruncated: card.operationsTruncated || card.operations.length > MAX_VISIBLE_OPERATIONS,
  };
}

// 会话里一轮 Lead 回复碰到的工单（方案 A）：只画紧凑的工单卡。这一轮做了哪些操作已经在消息头的工具摘要里，
// 卡片下面不再列操作（2026-10-15 用户决定：卡片要紧凑，不列英文工具名）。完整记录在工单线程里。
// 还没有工单摘要时（刚建好、列表还没刷新），卡片说操作自己的结果（fallback），不写「正在同步」一直等下去。
export function TicketExecutionCard({
  card,
  ticket,
  compact = false,
  onOpenTicket,
  fallback = null,
}: {
  card: TicketExecutionConversationCard;
  ticket?: Ticket;
  compact?: boolean;
  onOpenTicket: (ticketId: number) => void;
  fallback?: string | null;
}) {
  if (!ticket) {
    return (
      <Card w="100%" rounded="xl" overflow="hidden">
        <Pressable testID={`open-ticket-${card.ticketId}`} onPress={() => onOpenTicket(card.ticketId)} feedback="highlight" px="card" py="card">
          <Row items="center" gap="side-item">
            <Column flex={1} minW={0} gap="text-stack">
              <Text size="meta" mono tone="secondary">{`#${card.ticketId}`}</Text>
              <Text size="secondary" tone="secondary">{fallback ?? '点开查看这张工单。'}</Text>
            </Column>
            <Icon name="chevron-right" size={12} color="text-secondary" weight="semibold" />
          </Row>
        </Pressable>
      </Card>
    );
  }
  return <EmbeddedTicketCard compact={compact} onPress={() => onOpenTicket(card.ticketId)} ticket={ticket} />;
}

function boundTicketExecutionOperations(
  operations: readonly TicketOperationProjection[],
): TicketOperationProjection[] {
  if (operations.length <= MAX_VISIBLE_OPERATIONS) return [...operations];
  return [operations[0]!, ...operations.slice(-(MAX_VISIBLE_OPERATIONS - 1))];
}

export function selectTicketExecutionOperations(
  operations: readonly TicketOperationProjection[],
  showAll: boolean,
): TicketOperationProjection[] {
  if (showAll || operations.length <= MAX_COLLAPSED_OPERATIONS) return [...operations];
  return [operations[0]!, ...operations.slice(-(MAX_COLLAPSED_OPERATIONS - 1))];
}
