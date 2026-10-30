import { AnchoredPanel, Box, Column, Dot, Icon, Pressable, Row, Text, type ColorToken, type TextTone } from '@pi-lead-child/components';
import type { KernelCheckpoint } from '@pi-lead-child/protocol';
import { useMemo, useState } from 'react';

import { StatusBadge } from '../../components/StatusBadge';
import { useControlPlaneStore } from '../../state/CompanionStateProvider';
import { useConversationItemDetail, useTicketCheckpoints, useTicketSummary } from '../../state/hooks';
import type { ConversationCardEntity } from '../../state/types';
import { ticketDisplayTitle, ticketSummaryToTicket, type Ticket } from '../workspace/model';
import { formatCheckpointTime } from './CheckpointCard';
import { dispatchUpdates, type DispatchUpdate, type DispatchUpdateTone, type DispatchWindow } from './dispatchCards';
import { useOpenTicket } from './useOpenTicket';

type TicketCard = Extract<ConversationCardEntity, { kind: 'ticket_execution' }>;

const EMPTY_IDS: readonly number[] = [];

// 合一的工单卡（2026-10-17，会话方案第五版）：Lead 派活那条回复下面一张灰底卡片，只有一行。
//   · 左边的工单号「#77 ↗」打开工单详情；这一行的其余地方打开浮层，看这次派活以后的关键更新；
//   · 浮层从卡片原来的位置打开，盖在后面的消息上，会话列表不变高、不跳（组件库的 AnchoredPanel）；
//   · 点浮层外面、再点一次标题行、按 Esc（web）或返回键（Android）收起。手机宽度时是从底部升起的面板。
export function DispatchTicketCard({ card, scope }: { card: TicketCard; scope: DispatchWindow }) {
  const summary = useTicketSummary(card.ticketId);
  const { detail } = useConversationItemDetail(card.ticketId, !summary);
  const item = summary ?? detail?.ticket;
  const ticket = item ? ticketSummaryToTicket(item) : undefined;
  const openTicket = useOpenTicket();
  const checkpointsById = useControlPlaneStore((state) => state.checkpointsById);
  const ticketCheckpointIds = useControlPlaneStore((state) => state.checkpointIdsByTicket[card.ticketId] ?? EMPTY_IDS);
  const updates = useMemo(() => {
    const ids = [...new Set([...scope.checkpointIds, ...ticketCheckpointIds])];
    const checkpoints = ids.flatMap((id) => checkpointsById[id] ? [checkpointsById[id] as KernelCheckpoint] : []);
    return dispatchUpdates({ ticketId: card.ticketId, scope, checkpoints, ticket: item });
  }, [card.ticketId, checkpointsById, item, scope, ticketCheckpointIds]);
  // 「N 条新」：卡片收着的时候来的更新。展开看过以后清零。
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const fresh = updates.filter((update) => Date.parse(update.at) > seenAt).length;
  const [open, setOpen] = useState(false);
  const show = () => {
    setSeenAt(Date.now());
    setOpen(true);
  };
  const close = () => setOpen(false);
  const goToTicket = () => {
    close();
    openTicket(card.ticketId);
  };
  const title = ticket ? ticketDisplayTitle(ticket) : `工单 #${card.ticketId}`;
  const header = (expanded: boolean) => (
    <DispatchHeader
      ticketId={card.ticketId}
      title={title}
      ticket={ticket}
      count={updates.length}
      fresh={expanded ? 0 : fresh}
      expanded={expanded}
      onToggle={expanded ? close : show}
      onOpenTicket={goToTicket}
    />
  );

  return (
    <AnchoredPanel
      testID={`dispatch-card-${card.ticketId}`}
      open={open}
      onClose={close}
      label={`#${card.ticketId} 的进展`}
      header={header(true)}
      body={<DispatchUpdates ticketId={card.ticketId} updates={updates} />}
    >
      <Box w="100%" rounded="xl" bg="surface-subtle">{header(false)}</Box>
    </AnchoredPanel>
  );
}

function DispatchHeader({ ticketId, title, ticket, count, fresh, expanded, onToggle, onOpenTicket }: {
  ticketId: number;
  title: string;
  ticket: Ticket | undefined;
  count: number;
  fresh: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenTicket: () => void;
}) {
  return (
    <Row items="center" minH={56} pl="card">
      {/* 工单号代表这张工单：点它去工单详情。↗ 说明点了会跳走。 */}
      <Pressable
        testID={`dispatch-card-${ticketId}-open`}
        aria-label={`打开工单 #${ticketId} 详情`}
        onPress={onOpenTicket}
        feedback="none"
        px={4} // spacing-exempt: 按钮点击区
        py={8} // spacing-exempt: 按钮点击区
        shrink={0}
      >
        <Row items="center" gap="icon-label" h={30} px="pill-x" rounded="md" borderWidth={1} borderColor="border" bg="surface">
          {/* spacing-exempt: 工单号徽标字号 */}
          <Text size="13" mono weight="semibold" tone="strong">{`#${ticketId}`}</Text>
          <Icon name="arrow-up-right" size={12} color="text-secondary" weight="semibold" />
        </Row>
      </Pressable>
      {/* 这一行的其余地方：打开、收起浮层。 */}
      <Pressable
        testID={`dispatch-card-${ticketId}-toggle`}
        aria-label={expanded ? `收起 #${ticketId} 的进展` : `展开 #${ticketId} 的进展`}
        aria-expanded={expanded}
        onPress={onToggle}
        feedback="highlight"
        flex={1}
        minW={0}
        minH={56}
        justify="center"
        pl="card"
        pr="card"
        rounded="xl"
      >
        <Row items="center" gap="inline-item" minW={0}>
          <Text flex={1} minW={0} size="card-title" weight="bold" numberOfLines={1}>{title}</Text>
          {ticket ? <StatusBadge label={ticket.statusLabel} tone={ticket.status} /> : null}
          {fresh > 0 ? (
            <Row testID={`dispatch-card-${ticketId}-fresh`} items="center" gap="icon-label" shrink={0}>
              <Dot color="accent" size={6} />
              <Text size="meta" weight="semibold" tone="accent">{`${fresh} 条新`}</Text>
            </Row>
          ) : count > 0 ? (
            <Text size="meta" tone="secondary" shrink={0}>{`${count} 条`}</Text>
          ) : null}
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="text-secondary" weight="semibold" />
        </Row>
      </Pressable>
    </Row>
  );
}

// 浮层里的关键更新。打开时才去取这张工单的全部 checkpoint（里程碑不在会话卡片里）。
function DispatchUpdates({ ticketId, updates }: { ticketId: number; updates: readonly DispatchUpdate[] }) {
  useTicketCheckpoints(ticketId);
  return (
    // spacing-exempt: 弹层面板自己的规格
    <Column gap="card-section" px={18} pt={14} pb={16}>
      {updates.length === 0 ? (
        <Text size="secondary" tone="secondary">child 还没有汇报。</Text>
      ) : updates.map((update) => <UpdateRow key={update.id} update={update} />)}
      <Text size="note" tone="secondary">只显示关键更新。完整记录在工单详情里。</Text>
    </Column>
  );
}

const TONE_DOT: Record<DispatchUpdateTone, ColorToken> = {
  accent: 'accent', success: 'success', warning: 'warning', danger: 'danger', neutral: 'text-muted',
};
const TONE_TEXT: Record<DispatchUpdateTone, TextTone> = {
  accent: 'accent', success: 'success-dark', warning: 'warning-dark', danger: 'danger-dark', neutral: 'strong',
};

function UpdateRow({ update }: { update: DispatchUpdate }) {
  const meta = [update.source, formatCheckpointTime(update.at)].filter(Boolean).join(' · ');
  return (
    <Column testID={`dispatch-update-${update.id}`} gap="text-stack">
      <Row items="center" gap="inline-item">
        <Dot color={TONE_DOT[update.tone]} size={7} />
        <Text size="label" weight="semibold" tone={TONE_TEXT[update.tone]}>{update.label}</Text>
        {meta ? <Text size="meta" tone="secondary">{meta}</Text> : null}
      </Row>
      {/* spacing-exempt: 缩进到圆点之后 */}
      <Text pl={14} size="card-title" weight={update.body ? 'bold' : 'semibold'}>{update.title}</Text>
      {/* spacing-exempt: 缩进到圆点之后 */}
      {update.body ? <Text pl={14} size="secondary" tone="secondary">{update.body}</Text> : null}
    </Column>
  );
}
