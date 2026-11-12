import { Group, Pressable, Row, Text, type GroupEntry } from '@pi-lead-child/components';
import { useEffect, useMemo } from 'react';

import { intlLocale, useLocale, useMessages, type Locale } from '@/i18n';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { RESOURCE_KEYS } from '../../state/types';
import { ticketDisplayTitle } from '../workspace/model';
import { turnCardGroupMessages } from './turnCardGroup.messages';
import type { TurnCardGroup } from './turnCardGroups';
import { useOpenAgenda } from './useOpenAgenda';
import { useOpenTicket } from './useOpenTicket';

const pad = (value: number) => String(value).padStart(2, '0');

// "11-12 Thu" / "11-12 周四".
function dayWords(at: Date, locale: Locale): string {
  const weekday = new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short' }).format(at);
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${weekday}`;
}

// "11-12 15:55", the mono time in front of each row.
function rowTime(at: Date): string {
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

type Words = ReturnType<typeof turnCardGroupMessages>;

function groupLabel(group: TurnCardGroup, m: Words): string {
  if (group.kind === 'task') return m.ticketsCreated;
  const { created, rescheduled, cancelled, acknowledged, other } = group.actions;
  const total = group.cardIds.length;
  if (created === total) return m.remindersCreated;
  if (rescheduled === total) return m.remindersMoved;
  if (cancelled === total) return m.remindersCancelled;
  if (acknowledged === total) return m.remindersAcknowledged;
  const parts = [
    created ? m.partCreated(created) : null, rescheduled ? m.partMoved(rescheduled) : null,
    cancelled ? m.partCancelled(cancelled) : null, acknowledged ? m.partAcknowledged(acknowledged) : null,
    other ? m.partOther(other) : null,
  ].filter(Boolean).join(' · ');
  return m.remindersChanged(parts);
}

type RowFacts = { ticketId: number; title: string | null; at: string | null; stage: string | null; important: boolean };

// One line per item in the panel. Reminders open the agenda (their home); tickets open the ticket.
function GroupRowContent({ group, row }: { group: TurnCardGroup; row: RowFacts }) {
  const m = useMessages(turnCardGroupMessages);
  const openAgenda = useOpenAgenda();
  const openTicket = useOpenTicket();
  const title = row.title ?? m.loading;
  const state = row.stage === 'cancelled' ? m.cancelled : row.stage === 'acked' ? m.acknowledged : row.important ? m.important : null;
  const ended = row.stage === 'cancelled' || row.stage === 'acked' || row.stage === 'done';
  return (
    <Pressable
      testID={`turn-card-group-row-${row.ticketId}`}
      onPress={() => (group.kind === 'reminder' ? openAgenda() : openTicket(row.ticketId))}
      aria-label={group.kind === 'reminder' ? m.openAgenda(title) : m.openTicket(row.ticketId)}
      feedback="opacity"
    >
      <Row items="baseline" gap="inline-item" minW={0}>
        <Text flex={1} minW={0} size="note" tone={ended ? 'muted' : 'secondary'} numberOfLines={1}
          {...(row.stage === 'cancelled' ? { textDecorationLine: 'line-through' as const } : {})}
        >
          {group.kind === 'task' ? `#${row.ticketId} ${title}` : title}
        </Text>
        {state ? <Text size="meta" weight="semibold" tone={row.important && !ended ? 'warning-dark' : 'muted'} shrink={0}>{state}</Text> : null}
      </Row>
    </Pressable>
  );
}

// Same-kind cards of one turn as one line (design P9.10, theme 11.11). The line keeps its height; the list opens in an
// anchored panel, so the conversation does not grow. Each row reads the same TicketSummary / TicketDetail as the card.
export function TurnCardGroupView({ group }: { group: TurnCardGroup }) {
  const m = useMessages(turnCardGroupMessages);
  const locale = useLocale();
  const runtime = useCompanionRuntime();
  // Reminders are not in the ticket list: load each one's detail (title, time, level), as the single card does.
  useEffect(() => {
    if (group.kind !== 'reminder') return undefined;
    const stops = group.ticketIds.map((id) => runtime.observeResource(RESOURCE_KEYS.ticket(id)));
    return () => { for (const stop of stops) stop(); };
  }, [group.kind, group.ticketIds, runtime]);
  // A JSON string keeps the selector's result stable between store updates that do not touch these items.
  const facts = useControlPlaneStore((state) => JSON.stringify(group.ticketIds.map((ticketId): RowFacts => {
    const detail = state.ticketDetailsById[ticketId];
    const summary = state.ticketsById[ticketId] ?? detail?.ticket;
    return {
      ticketId,
      title: summary ? ticketDisplayTitle(summary) : null,
      at: detail?.remindAt ?? null,
      stage: summary?.stage ?? null,
      important: detail?.reminder?.level === 'interrupt',
    };
  })));
  const rows = useMemo(() => JSON.parse(facts) as RowFacts[], [facts]);
  const ordered = useMemo(() => (group.kind === 'reminder'
    ? [...rows].sort((left, right) => (left.at ?? '').localeCompare(right.at ?? '') || left.ticketId - right.ticketId)
    : rows), [group.kind, rows]);
  const times = ordered.flatMap((row) => (row.at ? [new Date(row.at)] : [])).filter((at) => !Number.isNaN(at.getTime()));
  const first = times[0];
  const last = times.at(-1);
  const range = first && last
    ? (dayWords(first, locale) === dayWords(last, locale) ? dayWords(first, locale) : `${dayWords(first, locale)} – ${dayWords(last, locale)}`)
    : null;
  const entries: GroupEntry[] = ordered.map((row) => ({
    key: String(row.ticketId),
    time: group.kind === 'reminder' && row.at ? rowTime(new Date(row.at)) : null,
    content: <GroupRowContent group={group} row={row} />,
  }));
  return (
    <Group
      testID={`turn-card-group-${group.kind}`}
      tag={group.kind === 'reminder' ? m.reminderTag : m.ticketTag}
      tone={group.kind === 'reminder' && ordered.some((row) => row.important && row.stage === 'scheduled') ? 'warning' : 'neutral'}
      label={groupLabel(group, m)}
      entries={entries}
      range={range}
    />
  );
}
