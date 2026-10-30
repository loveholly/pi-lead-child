import { Box, Card, Column, Dot, Icon, Pressable, Row, Text } from '@pi-lead-child/components';
import type { ReactNode } from 'react';

import { StatusBadge } from '../../components/StatusBadge';
import { ticketDisplayTitle, ticketNowLine, type Ticket } from '../workspace/model';

type EmbeddedTicketCardProps = {
  ticket: Ticket;
  onPress: () => void;
  compact?: boolean;
  children?: ReactNode;
};

// 会话里嵌入的工单卡片（方案 A）：两行。第一行编号、标题、状态；第二行现状（在跑的 Run、runtime、跑了多久）。
// 整张卡可以点，打开工单线程；右侧的圆形箭头提示可以点，不写文字提示。children 是卡片下半部分的补充内容。
export function EmbeddedTicketCard({ ticket, onPress, compact = false, children }: EmbeddedTicketCardProps) {
  const title = ticketDisplayTitle(ticket);
  const now = ticketNowLine(ticket);
  return (
    <Card w="100%" rounded="xl" overflow="hidden">
      <Pressable
        testID={`open-ticket-${ticket.id}`}
        aria-label={`打开工单 #${ticket.id} ${title}`}
        onPress={onPress}
        feedback="highlight"
        px={compact ? 12 : 14}
        py="card"
      >
        <Row items="center" gap="side-item">
          <Column flex={1} minW={0} gap="text-stack">
            <Row items="center" gap="inline-item" minW={0}>
              <Text size="meta" mono tone="secondary" shrink={0}>{`#${ticket.id}`}</Text>
              <Text flex={1} minW={0} size="card-title" weight="bold" numberOfLines={1}>{title}</Text>
              <StatusBadge label={ticket.statusLabel} tone={ticket.status} />
              {ticket.heartbeat ? (
                <Dot color="success" size={7} pulse testID="ticket-heartbeat-pulse" accessibilityLabel="任务心跳正常" />
              ) : null}
            </Row>
            {now ? <Text size="secondary" tone="secondary" numberOfLines={1}>{now}</Text> : null}
          </Column>
          <Box testID={`open-ticket-${ticket.id}-arrow`} w={28} h={28} rounded="full" bg="surface-muted" items="center" justify="center" shrink={0}>
            <Icon name="chevron-right" size={12} color="text-secondary" weight="semibold" />
          </Box>
        </Row>
      </Pressable>
      {/* spacing-exempt: 紧贴分隔线的细条 */}
      {children ? <Column py={2} borderTopWidth={1} borderTopColor="border-soft">{children}</Column> : null}
    </Card>
  );
}

// 同一段对话里再次提到同一张工单时的小标签：编号、标题、状态和一个小箭头，点开工单线程（方案 A）。
export function TicketChip({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const title = ticketDisplayTitle(ticket);
  return (
    <Box self="flex-start" maxW="100%">
      <Pressable
        testID={`ticket-chip-${ticket.id}`}
        aria-label={`打开工单 #${ticket.id} ${title}`}
        onPress={onPress}
        feedback="highlight"
        rounded="full"
        borderWidth={1}
        borderColor="border-soft"
        bg="surface"
        pl="pill-x"
        pr="pill-x"
        minH={32}
        justify="center"
      >
        <Row items="center" gap="inline-item" minW={0}>
          {/* spacing-exempt: 状态标签字号 */}
          <Text size="12.5" mono tone="secondary" shrink={0}>{`#${ticket.id}`}</Text>
          {/* spacing-exempt: 状态标签字号 */}
          <Text size="12.5" minW={0} numberOfLines={1}>{title}</Text>
          {/* spacing-exempt: 状态标签字号 */}
          <Text size="12.5" weight="semibold" tone="secondary" shrink={0}>{ticket.statusLabel}</Text>
          <Box w={22} h={22} rounded="full" bg="surface-muted" items="center" justify="center" shrink={0}>
            <Icon name="chevron-right" size={10} color="text-secondary" weight="semibold" />
          </Box>
        </Row>
      </Pressable>
    </Box>
  );
}
