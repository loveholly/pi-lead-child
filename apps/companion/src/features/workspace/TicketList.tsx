import {
  Avatar, Box, Button, Column, Dot, EmptyState, Icon, List, ListItem, Pressable, ProgressBar, Row, Text, type ColorToken,
} from '@pi-lead-child/components';
import { Fragment, useEffect, useState } from 'react';

import { useLocale, useMessages } from '@/i18n';

import {
  ticketRailEmptyCopy,
  buildTicketRailPresentation,
  groupForTicket,
  isPausedTicket,
  projectTicketSecondaryMeta,
  ticketRailCaption,
  ticketTitle,
  type Ticket,
  type TicketFilter,
  type TicketGroupId,
  type TicketProjectScope,
  type TicketRailState,
} from './model';
import { waitedText } from './inboxModel';
import { workspaceModelMessages } from './model.messages';
import { railMessages } from './rail.messages';
import { milestoneChip } from './timelineModel';

type TicketListProps = {
  items: Ticket[];
  selectedTicketId?: string | null;
  onSelect: (id: string) => void;
  cards?: boolean;
  grouped?: boolean;
  filter?: TicketFilter;
  query?: string;
  loading?: boolean;
  onCreateTask?: () => void;
  onClearFilters?: () => void;
  onSeedTask?: (draft: string) => void;
  // 只看一个项目时的范围（从项目 tab 点进来）。
  project?: TicketProjectScope | null;
  // 停太久的暂停工单在行上直接继续或取消（工单 #111）。不给时行上没有这两个按钮。
  onResumeTicket?: (ticket: Ticket) => Promise<unknown>;
  onCancelTicket?: (ticket: Ticket) => Promise<unknown>;
};

type PauseActions = Pick<TicketListProps, 'onResumeTicket' | 'onCancelTicket'>;

const STARTER_COMMAND_COUNT = 3;

const groupColor: Record<TicketGroupId, ColorToken> = {
  needs_intervention: 'danger-dark',
  running: 'accent-strong',
  paused: 'text-strong',
  queued: 'text-strong',
  lead: 'text-strong',
  background: 'text-secondary',
  completed: 'text-secondary',
  cancelled: 'text-muted',
};

// 两台状态机的取值都要有色（kernel spec §6.1/§6.2）。
const statusAccent: Record<Ticket['status'], ColorToken> = {
  draft: 'text-muted',
  ready: 'accent-muted',
  active: 'accent',
  review: 'warning',
  blocked: 'danger',
  done: 'success',
  cancelled: 'text-muted',
  scheduled: 'text-muted',
  fired: 'warning',
  acked: 'success',
};

function clampPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

// 不分组的列表（原生标签页以外的简单场景）：一行一张工单。
function TicketRow({ ticket, selected, onSelect }: { ticket: Ticket; selected: boolean; onSelect: () => void }) {
  const metadata = projectTicketSecondaryMeta(ticket);
  const metaLabel = `#${ticket.id}${metadata.length > 0 ? ` · ${metadata.join(' · ')}` : ''}`;
  const hasAgent = Boolean(ticket.agentLabel || ticket.runtimeName);
  const progressPercent = clampPercent(ticket.progressPercent);

  return (
    <ListItem
      testID={`ticket-row-${ticket.id}`}
      onPress={onSelect}
      selected={selected}
      title={ticketTitle(ticket)}
      subtitle={metaLabel}
      footer={progressPercent !== undefined ? <Row pt="card-row"><ProgressBar value={progressPercent} /></Row> : undefined}
      leading={(
        <Row items="center" gap="icon-label">
          <Box w={3} h={28} rounded={3} bg={selected ? 'accent' : statusAccent[ticket.status]} />
          {hasAgent ? <Avatar label={ticket.runtimeName?.slice(0, 1).toUpperCase() ?? 'π'} size={28} mono weight="bold" /> : null}
        </Row>
      )}
      trailing={(ticket.heartbeat || ticket.needsAttention)
        ? <Dot color={ticket.needsAttention ? 'danger' : 'success'} size={8} />
        : undefined}
    />
  );
}

// 停了多久：「停了 2 天」，不到一分钟写「刚暂停」。
function pausedForText(since: string, locale: ReturnType<typeof useLocale>): string {
  const m = workspaceModelMessages(locale);
  const elapsed = Date.now() - new Date(since).getTime();
  return Number.isFinite(elapsed) && elapsed >= 60_000 ? m.pausedFor(waitedText(since, undefined, locale)) : m.pausedJustNow;
}

// 停太久的暂停工单（pause.overdue）卡片下面的一行：继续（主按钮）、取消工单。
// 取消在原地再确认一次：确认行替换这一行，高度不变（设计规范 P5.3、P1.3）。进行中写「正在……」，失败时在下面写原因（P5.4）。
function PausedTicketActions({ ticket, onResumeTicket, onCancelTicket }: { ticket: Ticket } & PauseActions) {
  const m = useMessages(railMessages).paused;
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'resume' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (which: 'resume' | 'cancel', action: (ticket: Ticket) => Promise<unknown>) => {
    if (pending) return;
    setPending(which);
    setError(null);
    try {
      await action(ticket);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <Column testID={`ticket-paused-actions-${ticket.id}`} pr="row-x" pb="row-y" pl="row-x" gap="text-stack">
      {confirming && onCancelTicket ? (
        <Row items="center" gap="actions">
          <Text flex={1} minW={0} size="secondary" tone="strong" numberOfLines={1}>{m.cancelQuestion}</Text>
          <Button
            testID={`ticket-cancel-confirm-${ticket.id}`}
            label={pending === 'cancel' ? m.cancelling : m.confirmCancel}
            size="xs"
            tone="danger"
            disabled={pending !== null}
            onPress={() => { void run('cancel', onCancelTicket); }}
          />
          <Button label={m.keep} size="xs" variant="ghost" tone="neutral" disabled={pending !== null} onPress={() => setConfirming(false)} />
        </Row>
      ) : (
        <Row items="center" gap="actions">
          {onResumeTicket ? (
            <Button
              testID={`ticket-resume-${ticket.id}`}
              label={pending === 'resume' ? m.resuming : m.resume}
              size="xs"
              tone="accent"
              disabled={pending !== null}
              onPress={() => { void run('resume', onResumeTicket); }}
            />
          ) : null}
          {onCancelTicket ? (
            <Button
              testID={`ticket-cancel-${ticket.id}`}
              label={m.cancel}
              size="xs"
              variant="ghost"
              tone="neutral"
              disabled={pending !== null}
              onPress={() => setConfirming(true)}
            />
          ) : null}
        </Row>
      )}
      {error ? <Text size="secondary" color="danger-dark">{error}</Text> : null}
    </Column>
  );
}

// 侧栏里的工单卡片：头像、标题、一行说明；执行中的工单多一条进度。
function TicketRailCard({ ticket, selected, onSelect, onResumeTicket, onCancelTicket }: {
  ticket: Ticket; selected: boolean; onSelect: () => void;
} & PauseActions) {
  const locale = useLocale();
  const progressPercent = clampPercent(ticket.progressPercent);
  const hasProgress = ticket.status === 'active' && progressPercent !== undefined;
  // 暂停着、又没有别的在跑的工单（工单 #111）：右边写停了多久，停太久的用「等你」的琥珀色（主题 C-11），行下多一行继续、取消。
  const paused = isPausedTicket(ticket) && ticket.turn !== 'running' ? ticket.pause! : null;
  const overdue = paused?.overdue === true;
  const showPauseActions = overdue && Boolean(onResumeTicket || onCancelTicket);
  // 右边的停留时间：在当前 stage 待了多久。已结束的工单不写。
  const stayed = paused
    ? pausedForText(paused.since, locale)
    : ticket.turn !== 'ended' && ticket.stageChangedAt ? waitedText(ticket.stageChangedAt, undefined, locale) : null;
  const due = ticket.turn !== 'ended' && ticket.nextMilestone ? milestoneChip(ticket.nextMilestone, undefined, locale) : null;
  const assigned = ticket.status === 'review'
    || (Boolean(ticket.agentLabel || ticket.runtimeName) && !ticket.needsAttention);
  const signalColor: ColorToken = ticket.needsAttention
    ? 'danger'
    : ticket.status === 'review'
      ? 'warning'
      : ticket.heartbeat
        ? 'success'
        : 'text-muted';

  const boxShadow = selected ? '0 1px 3px rgba(16,24,40,0.08)' : '0 1px 2px rgba(16,24,40,0.04)';
  const card = (
    <Pressable
      testID={`ticket-row-${ticket.id}`}
      onPress={onSelect}
      feedback="opacity"
      position="relative"
      overflow="hidden"
      h={hasProgress ? 71 : 51}
      mb="stacked-card"
      pt="row-y"
      pr="row-x"
      pb="row-y"
      pl="row-x"
      rounded={9}
      bg="surface"
      boxShadow={showPauseActions ? undefined : boxShadow}
    >
      {selected ? <Box position="absolute" l={0} t={0} b={0} w={3} bg={statusAccent[ticket.status]} /> : null}
      <Row gap="side-item">
        <Avatar
          label={assigned ? 'π' : '?'}
          size={28}
          tone={assigned ? 'dark' : 'muted'}
          mono={assigned}
          weight={assigned ? 'bold' : 'extrabold'}
          textSize={assigned ? '11.5' : '11'}
          status={signalColor}
        />
        <Column flex={1} minW={0}>
          <Row items="center" gap="inline-item">
            <Text flex={1} minW={0} size="card-title" weight="bold" numberOfLines={1}>{ticketTitle(ticket)}</Text>
            {stayed ? (
              <Text testID={paused ? `ticket-paused-for-${ticket.id}` : undefined} size="meta" mono weight="bold" {...(overdue ? { color: 'warning-dark' as const } : { tone: 'muted' as const })}>
                {stayed}
              </Text>
            ) : null}
          </Row>
          <Row mt="text-stack" items="center" gap="inline-item">
            <Text flex={1} minW={0} size="secondary" tone="muted" numberOfLines={1}>{ticketRailCaption(ticket, locale)}</Text>
            {due ? (
              <Box px="pill-x" rounded={5} bg={due.overdue ? 'danger-soft' : 'warning-soft'}>
                {/* spacing-exempt: 徽标字号行高 */}
                <Text size="10" leading={15} weight="bold" color={due.overdue ? 'danger-dark' : 'warning-dark'}>{due.text}</Text>
              </Box>
            ) : null}
          </Row>
          {hasProgress ? (
            <Row mt="card-row" items="center" gap="inline-item">
              <ProgressBar value={progressPercent} />
              <Text size="meta" mono weight="bold" tone="faint">{`${progressPercent}%`}</Text>
            </Row>
          ) : null}
        </Column>
      </Row>
    </Pressable>
  );
  if (!showPauseActions) return card;
  // 按钮放在可点的卡片外面：点按钮不会同时打开工单。外层画卡片的底、圆角和阴影；里面卡片的下间距落在同一块白底上，成了按钮上方的空。
  return (
    <Column mb="stacked-card" rounded={9} overflow="hidden" bg="surface" boxShadow={boxShadow}>
      {card}
      <PausedTicketActions ticket={ticket} onResumeTicket={onResumeTicket} onCancelTicket={onCancelTicket} />
    </Column>
  );
}

function EmptyStateForRail({
  state,
  onCreateTask,
  onClearFilters,
  onSeedTask,
}: {
  state: Exclude<TicketRailState, 'populated'>;
  onCreateTask?: () => void;
  onClearFilters?: () => void;
  onSeedTask?: (draft: string) => void;
}) {
  const m = useMessages(railMessages);
  const copy = ticketRailEmptyCopy(state, useLocale());
  const starterCommands = Array.from({ length: STARTER_COMMAND_COUNT }, (_, index) => m.starterCommands(index));
  const icon = state === 'all_completed'
    ? { name: 'check' as const, color: 'success' as const }
    : state === 'no_results'
      ? { name: 'search' as const, color: 'text-muted' as const }
      : state === 'loading'
        ? { name: 'refresh' as const, color: 'accent' as const }
        : { name: 'tickets' as const, color: 'accent' as const };
  const action = state === 'all_completed' ? onCreateTask : state === 'no_results' ? onClearFilters : undefined;

  return (
    <Box h={360}>
      <EmptyState
        icon={icon.name}
        iconColor={icon.color}
        iconBackground={state === 'all_completed' ? 'success-soft' : 'surface'}
        title={copy.title}
        body={copy.body}
        action={copy.actionLabel && action ? { label: copy.actionLabel, onPress: action } : undefined}
      >
        {state === 'first_use' && onSeedTask ? (
          <Column gap="stacked-card">
            {starterCommands.map((command) => (
              <Pressable key={command} onPress={() => onSeedTask(command)} feedback="highlight" h={42} px="row-x" rounded="md" justify="center">
                <Row items="center" gap="icon-label">
                  <Text flex={1} size="label" weight="semibold" tone="secondary" numberOfLines={1}>{command}</Text>
                  <Icon name="arrow-up-right" color="accent" size={13} />
                </Row>
              </Pressable>
            ))}
          </Column>
        ) : null}
      </EmptyState>
    </Box>
  );
}

export function TicketList({
  items,
  selectedTicketId,
  onSelect,
  grouped = false,
  filter = 'all',
  query = '',
  loading = false,
  onCreateTask,
  onClearFilters,
  onSeedTask,
  project = null,
  onResumeTicket,
  onCancelTicket,
}: TicketListProps) {
  const locale = useLocale();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TicketGroupId>>(() => new Set(['background', 'completed', 'cancelled']));

  useEffect(() => {
    const selected = items.find((ticket) => ticket.id === selectedTicketId);
    if (!selected) return;
    const selectedGroup = groupForTicket(selected);
    setCollapsedGroups((current) => {
      if (!current.has(selectedGroup)) return current;
      const next = new Set(current);
      next.delete(selectedGroup);
      return next;
    });
  }, [items, selectedTicketId]);

  const toggleGroup = (groupId: TicketGroupId) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  if (!grouped) {
    return (
      <List testID="ticket-list">
        {items.map((ticket) => (
          <TicketRow key={ticket.id} ticket={ticket} selected={selectedTicketId === ticket.id} onSelect={() => onSelect(ticket.id)} />
        ))}
      </List>
    );
  }

  const projection = buildTicketRailPresentation(items, { filter, query, loading, project, locale });
  if (projection.state !== 'populated') {
    return <EmptyStateForRail state={projection.state} onCreateTask={onCreateTask} onClearFilters={onClearFilters} onSeedTask={onSeedTask} />;
  }

  return (
    <Column testID="grouped-ticket-list" w="100%">
      {projection.groups.map((group) => {
        const collapsed = collapsedGroups.has(group.id);
        return (
          <Fragment key={group.id}>
            <Pressable
              testID={`ticket-group-${group.id}`}
              aria-expanded={!collapsed}
              onPress={() => toggleGroup(group.id)}
              feedback="none"
              h={36}
              pt="section-label-top"
              pr="section-label-x"
              pb="section-label-bottom"
              pl="section-label-x"
            >
              <Row items="center" gap="inline-item">
                <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} color="text-muted" size={11} />
                <Text size="eyebrow" weight="extrabold" letterSpacing={0.4} color={groupColor[group.id]}>{group.label}</Text>
                <Text size="meta" weight="bold" tone="ghost">{String(group.count)}</Text>
              </Row>
            </Pressable>
            {!collapsed ? group.items.map((ticket) => (
              <TicketRailCard
                key={ticket.id}
                ticket={ticket}
                selected={selectedTicketId === ticket.id}
                onSelect={() => onSelect(ticket.id)}
                onResumeTicket={onResumeTicket}
                onCancelTicket={onCancelTicket}
              />
            )) : null}
          </Fragment>
        );
      })}
    </Column>
  );
}
