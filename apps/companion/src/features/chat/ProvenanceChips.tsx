import { Column, Icon, Popover, Pressable, Row, Text } from '@pi-lead-child/components';
import { useMemo } from 'react';

import { useTicketSummary } from '@/state/hooks';
import type { MessagePart } from '@/state/types';

import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';
import { provenanceSources, type ProvenanceGroup, type ProvenanceSource } from './provenance';
import { useOpenTicket } from './useOpenTicket';

// 回复下面的「依据」标签（方案 A）。2026-10-16 用户要求可以点开：宽屏是浮层，手机是底部面板，
// 列出 Lead 这次读到的具体工单、通知或事件。工单可以点，点了关浮层、打开那张工单。
export function ProvenanceChips({ parts }: { parts: readonly MessagePart[] }) {
  const groups = useMemo(() => provenanceSources(parts), [parts]);
  const openTicket = useOpenTicket();
  if (!groups.length) return null;
  return (
    <Row gap="chips" flexWrap="wrap">
      {groups.map((group) => (
        <Popover
          key={group.label}
          testID={`provenance-${group.label}`}
          label={`依据：${group.label}，查看来源`}
          title={`依据：${group.label}`}
          trigger={(
            <Row items="center" gap="icon-label" pl="pill-x" pr="pill-x" py="pill-y" rounded="sm" borderWidth={1} borderColor="border-soft">
              <Icon name="database" size={11} color="text-secondary" />
              {/* spacing-exempt: 标签字号 */}
              <Text size="11.5" tone="secondary">{`依据：${group.label}`}</Text>
              <Icon name="chevron-down" size={10} color="text-secondary" weight="semibold" />
            </Row>
          )}
        >
          {(close) => (
            <SourceList
              group={group}
              onOpenTicket={(ticketId) => {
                close();
                openTicket(ticketId);
              }}
            />
          )}
        </Popover>
      ))}
    </Row>
  );
}

function SourceList({ group, onOpenTicket }: { group: ProvenanceGroup; onOpenTicket: (ticketId: number) => void }) {
  return (
    <Column gap="stacked-card">
      {group.sources.length === 0 ? (
        <Text size="secondary" tone="secondary">这次读取没有返回具体条目。</Text>
      ) : group.sources.map((source) => (
        <SourceRow key={sourceKey(source)} source={source} onOpenTicket={onOpenTicket} />
      ))}
      {group.truncated ? (
        <Text size="note" tone="muted">结果较长，这里只列出前面的部分。</Text>
      ) : null}
    </Column>
  );
}

function SourceRow({ source, onOpenTicket }: { source: ProvenanceSource; onOpenTicket: (ticketId: number) => void }) {
  if (source.kind === 'ticket') return <TicketSource ticketId={source.ticketId} onOpen={() => onOpenTicket(source.ticketId)} />;
  if (source.kind === 'run') {
    return (
      <Row items="center" gap="icon-label" py="row-y">
        <Icon name="agent" size={13} color="text-secondary" />
        <Text size="card-title" weight="bold">{`Run #${source.runId}`}</Text>
      </Row>
    );
  }
  return <Text size="body" tone="secondary" numberOfLines={3}>{source.text}</Text>;
}

// 一张工单：编号、标题、现在的状态，都按编号从实时的 TicketSummary 读，和别处一致。
function TicketSource({ ticketId, onOpen }: { ticketId: number; onOpen: () => void }) {
  const summary = useTicketSummary(ticketId);
  const ticket = summary ? ticketSummaryToTicket(summary) : null;
  const title = ticket ? ticketDisplayTitle(ticket) : '';
  return (
    <Pressable
      aria-label={`打开工单 #${ticketId}${title ? ` ${title}` : ''}`}
      onPress={onOpen}
      feedback="highlight"
      rounded="md"
      px="row-x"
      py="row-y"
      mx={-8} // spacing-exempt: 负边距抵消行内边距
    >
      <Row items="center" gap="inline-item" minW={0}>
        <Text size="meta" mono tone="secondary" shrink={0}>{`#${ticketId}`}</Text>
        <Text flex={1} minW={0} size="card-title" weight="semibold" numberOfLines={1}>{title || '工单'}</Text>
        {ticket ? <Text size="label" tone="secondary" shrink={0}>{ticket.statusLabel}</Text> : null}
        <Icon name="chevron-right" size={11} color="text-secondary" weight="semibold" />
      </Row>
    </Pressable>
  );
}

function sourceKey(source: ProvenanceSource): string {
  return source.kind === 'ticket' ? `t${source.ticketId}` : source.kind === 'run' ? `r${source.runId}` : `l${source.text}`;
}
