import { Box, Button, Card, Column, Icon, Popover, Pressable, RecordRow, Row, Text } from '@pi-lead-child/components';
import {
  isOnBehalfOwnerActionNotification, ownerActionEventIdOfNotification, type InboxNotices, type InboxView, type LeadHandledEntry, type NotificationDto,
} from '@pi-lead-child/protocol';
import { useEffect, useRef, useState } from 'react';

import { timeLabel } from '@/features/tickets/timeLabels';
import type { TicketOptionPresentation } from '@/features/tickets/ticketState';
import { leadNameNow } from '@/state/leadName';

import {
  buildInboxCards, splitLeadHandled, splitReminders, splitUpcoming, type InboxCardView, type UpcomingReminder, type UpcomingWatch,
} from './inboxModel';
import type { Ticket } from './model';

export type { UpcomingReminder } from './inboxModel';

// 收件箱（阶段 1，方向 A）：每件等你的事一张卡，最多一个动作；Lead 自己处理掉的事另列，不计数。

type InboxQueueProps = {
  items: readonly Ticket[];
  inbox: InboxView | null;
  notices: InboxNotices;
  onOpenTicket: (ticketId: string, noticeIds: number[]) => void;
  onRunAction: (ticketId: string, option: TicketOptionPresentation, noticeIds: number[]) => Promise<void>;
  onAckNotification?: (id: number) => void;
  onAckReminders?: (notices: NotificationDto[]) => void;
  /** 主人操作的提醒上点了「不是我」（工单 15）：撤销那次操作，并作废发出它的凭证。 */
  onDisownOwnerAction?: (eventId: string, notificationId: number) => void;
  /** 收件箱打开时调用一次：记下「看过了」。 */
  onSeen?: () => void;
  /** 接下来还在等的提醒（工单 07），先到的在前。 */
  upcomingReminders?: readonly UpcomingReminder[];
  /** 取消一个外部的人要求设的定时器（操作层的 timer.cancel，spec D16）。 */
  onCancelTimer?: (ref: string) => Promise<void>;
  /** Lead 的名字（useLeadName）。不给时读最近一次取到的名字。 */
  leadName?: string;
};

function reminderClock(at: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// 通知卡一次最多列几条；更多的写一句「还有 N 条」。
const VISIBLE_NOTICES = 3;

function SectionTitle({ label, count, tone, testID }: { label: string; count?: number; tone?: 'danger' | 'success'; testID?: string }) {
  return (
    <Row items="center" gap="inline-item" px="section-label-x" pt="section-label-top" pb="section-label-bottom">
      {tone === 'success' ? <Icon name="check" color="success-dark" size={12} /> : null}
      <Text size="eyebrow" weight="extrabold" letterSpacing={0.3} color={tone === 'danger' ? 'danger-dark' : tone === 'success' ? 'success-dark' : 'text-strong'}>
        {label}
      </Text>
      {count !== undefined ? (
        <Box testID={testID}>
          <Text size="meta" weight="bold" tone="muted">{String(count)}</Text>
        </Box>
      ) : null}
    </Row>
  );
}

function InboxCard({ card, onOpen, onRun }: {
  card: InboxCardView;
  onOpen: () => void;
  onRun: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRun();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card testID={`inbox-card-${card.ticketId}`} rounded="xl" p="card" gap="card-row">
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="meta" tone="muted" numberOfLines={1}>{card.meta}</Text>
        {card.milestone ? (
          <Box px="pill-x" rounded={5} bg={card.milestone.overdue ? 'danger-soft' : 'warning-soft'}>
            {/* spacing-exempt: 标签字号行高 */}
            <Text size="10.5" leading={17} weight="bold" color={card.milestone.overdue ? 'danger-dark' : 'warning-dark'}>
              {card.milestone.text}
            </Text>
          </Box>
        ) : null}
      </Row>
      <Text size="card-title" weight="bold" numberOfLines={2}>{card.title}</Text>
      {card.reason ? <Text size="secondary" tone="secondary" numberOfLines={3}>{card.reason}</Text> : null}
      {error ? <Text size="secondary" color="danger-dark">{error}</Text> : null}
      <Row gap="actions" pt="text-stack" items="center">
        {card.action ? (
          <Button
            testID={`inbox-action-${card.ticketId}`}
            label={pending ? '正在处理…' : card.action.label}
            size="xs"
            tone="accent"
            disabled={pending}
            onPress={() => { void run(); }}
          />
        ) : null}
        {/* 只有「查看」时它就是这张卡的动作，用描边按钮；旁边有主动作时退成文字按钮。 */}
        <Button
          testID={`inbox-open-${card.ticketId}`}
          label="查看"
          variant={card.action ? 'ghost' : 'outline'}
          tone="neutral"
          size="xs"
          onPress={onOpen}
        />
      </Row>
    </Card>
  );
}

function HandledLine({ label, value }: { label: string; value: string }) {
  return (
    <Row gap="inline-item" items="flex-start">
      <Box w={44}>
        <Text size="label" weight="bold" tone="muted">{label}</Text>
      </Box>
      <Text flex={1} minW={0} size="secondary" tone="secondary">{value}</Text>
    </Row>
  );
}

// Lead 自己处理掉的一件事。收起时一行写出了什么事和 Lead 做了什么；展开后按「问题 / 原因 / 我做了 / 以后」写，
// 时间挪到第一行，正文占满整行（实机截图：时间列压在展开的正文上）。
function HandledRow({ entry, expanded, onToggle }: { entry: LeadHandledEntry; expanded: boolean; onToggle: () => void }) {
  const when = (
    <Row items="center" gap="inline-item">
      <Text size="meta" mono weight="bold" tone="muted">{timeLabel(entry.handledAt)}</Text>
      {entry.eventCount > 1 ? <Text size="meta" tone="faint">{`${entry.eventCount} 次`}</Text> : null}
    </Row>
  );
  return (
    <Pressable testID={`lead-handled-${entry.id}`} onPress={onToggle} feedback="highlight" px="row-x" py="row-y" rounded="md" aria-expanded={expanded}>
      <Row gap="side-item" items="flex-start">
        {/* spacing-exempt: 光学对齐 */}
        <Box pt={5}><Box w={7} h={7} rounded="full" bg="success" /></Box>
        {expanded ? (
          <Column flex={1} minW={0} gap="card-row">
            {when}
            <HandledLine label="问题" value={entry.problem} />
            {entry.cause ? <HandledLine label="原因" value={entry.cause} /> : null}
            <HandledLine label="我做了" value={entry.action} />
            {entry.followUp ? <HandledLine label="以后" value={entry.followUp} /> : null}
          </Column>
        ) : (
          <>
            <Column flex={1} minW={0} gap="text-stack">
              <Text size="card-title" weight="bold" numberOfLines={1}>{entry.problem}</Text>
              <Text size="secondary" tone="secondary" numberOfLines={2}>{entry.action}</Text>
            </Column>
            {when}
          </>
        )}
      </Row>
    </Pressable>
  );
}

// 主人操作的一条提醒。「不是我」会撤销操作、作废凭证，所以先在这一行里再确认一次。
// Lead 在对话里代你做的（onBehalf，工单 03 审查 M5）：给「撤销」和「知道了」。「撤销」只撤销这次操作，不作废凭证。
function OwnerActionNoticeRow({ notification, onBehalf, onItsMe, onNotMe }: {
  notification: NotificationDto;
  onBehalf: boolean;
  onItsMe: () => void;
  onNotMe: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const words = onBehalf
    ? { action: '撤销', ack: '知道了', question: '撤销这次操作？不作废凭证。', confirm: '确认撤销', id: 'owner-action-undo' }
    : { action: '不是我', ack: '是我', question: '撤销这次操作，并作废发出它的凭证？', confirm: '确认不是我', id: 'owner-action-disown' };
  return (
    <Column testID={`owner-action-notice-${notification.id}`} gap="card-row">
      <Row minH={40} items="center" gap="side-item">
        <Column flex={1} minW={0}>
          <Text size="card-title" weight="extrabold" numberOfLines={2}>{notification.title}</Text>
          {notification.body ? (
            <Text size="secondary" tone="secondary" numberOfLines={3}>{notification.body}</Text>
          ) : null}
        </Column>
        {confirming ? null : (
          <Column gap="actions" shrink={0}>
            <Button
              testID={`${words.id}-${notification.id}`}
              label={words.action}
              variant="outline"
              tone="danger"
              size="xs"
              onPress={() => setConfirming(true)}
            />
            <Button
              testID={`notification-ack-${notification.id}`}
              label={words.ack}
              variant="outline"
              tone="neutral"
              size="xs"
              onPress={onItsMe}
            />
          </Column>
        )}
      </Row>
      {confirming ? (
        <Row items="center" gap="side-item" flexWrap="wrap">
          <Text size="secondary" tone="danger-dark" flex={1} minW={0}>{words.question}</Text>
          <Button
            testID={`${words.id}-confirm-${notification.id}`}
            label={words.confirm}
            tone="danger"
            size="xs"
            onPress={() => { setConfirming(false); onNotMe(); }}
          />
          <Button label="取消" variant="ghost" tone="neutral" size="xs" onPress={() => setConfirming(false)} />
        </Row>
      ) : null}
    </Column>
  );
}

// 外部来源的定时器是怎么来的：说得出是谁要求的写「Ethan 要求」；说不出时（Lead 没指明是哪条消息，名字是空的）写
// 「来自 Slack」，不写成「Slack 要求」（2026-10-28）。
function askedWords(requester: { name: string; sourceLabel: string }): { short: string; title: string; detail: string } {
  return requester.name
    ? { short: `${requester.name} 要求`, title: `${requester.name} 要求设的定时器`, detail: `${requester.sourceLabel} 里 ${requester.name} 要求设的` }
    : { short: `来自 ${requester.sourceLabel}`, title: `读了 ${requester.sourceLabel} 消息以后设的定时器`, detail: `读了 ${requester.sourceLabel} 的消息以后设的` };
}

// 后台检查（.scratch/lead-watch/spec.md D5）是谁设的：你在自己那一轮让 Lead 设的、Lead 自己设的、外部的人要求的。
// 外部的说不出是谁时（名字是空的）写「来自 Slack」，和别人要求设的定时器一样（askedWords）。
function watchSetByWords(watch: UpcomingWatch, requester: UpcomingReminder['requester'], leadName: string): { short: string; title: string } {
  if (watch.setBy === 'user') return { short: `你让 ${leadName} 设的`, title: `你让 ${leadName} 设的后台检查` };
  if (watch.setBy === 'lead') return { short: `${leadName} 设的`, title: `${leadName} 自己设的后台检查` };
  if (!requester) return { short: '来自外部', title: '读了外部消息以后设的后台检查' };
  return requester.name
    ? { short: `${requester.name}（${requester.sourceLabel}）要求的`, title: `${requester.sourceLabel} 里 ${requester.name} 要求设的后台检查` }
    : { short: `来自 ${requester.sourceLabel}`, title: `读了 ${requester.sourceLabel} 消息以后设的后台检查` };
}

// 后台检查现在的状态：正在查是进行中（C-12）；没在查时写上一次的结果，加「上次」，不暗示现在的状态（P7.3）。
// 出错是检查本身没跑成，算失败（C-15）；没通过是检查的正常结果，不用红色（C-16）。
function watchStatusWords(watch: UpcomingWatch): { text: string; tone: 'running' | 'quiet' | 'error' } | null {
  if (watch.running) return { text: '正在查', tone: 'running' };
  if (watch.lastStatus === 'pass') return { text: '上次通过', tone: 'quiet' };
  if (watch.lastStatus === 'fail') return { text: '上次没通过', tone: 'quiet' };
  if (watch.lastStatus === 'error') return { text: '上次出错', tone: 'error' };
  return null;
}

function WatchStatus({ watch }: { watch: UpcomingWatch }) {
  const status = watchStatusWords(watch);
  if (!status) return null;
  if (status.tone === 'running') return <Text size="label" weight="semibold" color="accent-strong" shrink={0}>{status.text}</Text>;
  return <Text size="meta" tone={status.tone === 'error' ? 'danger-dark' : 'secondary'} shrink={0}>{status.text}</Text>;
}

// 浮层里的说明：怎样查，上一次的结果，下一次什么时候查。
function watchDetail(watch: UpcomingWatch, at: string | null): string {
  const last = watch.lastCheckedAt ? `上次 ${reminderClock(watch.lastCheckedAt)} 查过，` : '上次';
  const result = watch.running
    ? '现在正在查。'
    : watch.lastStatus === 'pass' ? `${last}通过了。`
      : watch.lastStatus === 'fail' ? `${last}没通过。`
        : watch.lastStatus === 'error' ? `${last}出错了。`
          : '还没查过。';
  const next = !watch.running && at ? `下次 ${reminderClock(at)} 查。` : '';
  return `${watch.schedule}。${result}${next}`;
}

// 一行提醒的内容：时间、标题、「重要」。外部的人要求设的，后面写「Ethan 要求」（辅助信息，P6.1）。
// 后台检查在标题后面写状态（正在查、上次的结果）；怎样查和谁设的在第二行（UpcomingWatchLine）。
function UpcomingReminderLine({ reminder }: { reminder: UpcomingReminder }) {
  const clock = reminderClock(reminder.at);
  return (
    <>
      <Icon name="clock" color="text-secondary" size={12} />
      {clock ? <Text size="meta" mono tone="secondary" shrink={0}>{clock}</Text> : null}
      <Text flex={1} minW={0} size="card-title" weight="semibold" numberOfLines={1}>{reminder.title}</Text>
      {reminder.important ? <Text size="label" weight="bold" color="warning-dark" shrink={0}>重要</Text> : null}
      {reminder.watch ? <WatchStatus watch={reminder.watch} />
        : reminder.requester ? <Text size="meta" tone="secondary" shrink={0}>{askedWords(reminder.requester).short}</Text> : null}
    </>
  );
}

// 后台检查的第二行：怎样查（超长截断），后面是谁设的（不截断）。一直是一行，行高在画出来时就定了。
function UpcomingWatchLine({ watch, setBy }: { watch: UpcomingWatch; setBy: string }) {
  return (
    <Row items="center" gap="inline-item">
      <Text shrink={1} minW={0} size="meta" tone="secondary" numberOfLines={1}>{watch.schedule}</Text>
      <Text size="meta" tone="secondary" shrink={0}>{setBy}</Text>
    </Row>
  );
}

// 外部的人要求设的定时器（spec D16，工单 12）和后台检查（.scratch/lead-watch/spec.md D5）：事项（P9.5，主题 11.1）的收起态
// 没有按钮，点整行打开浮层；「取消」是低频操作，收在浮层里（A-4，用户 2026-10-26），和排队状态栏的「⋯」同一种（Popover 加 RecordRow）。
// 行尾的「⋯」告诉你这一行能点开。取消是操作层的 timer.cancel（P5.7）。
type TimerRowWords = { title: string; label: string; detail: string; cancel: string; setBy?: string };

function timerRowWords(reminder: UpcomingReminder, leadName: string): TimerRowWords {
  if (reminder.watch) {
    const setBy = watchSetByWords(reminder.watch, reminder.requester, leadName);
    return {
      title: setBy.title,
      label: `后台检查「${reminder.title}」：查看详情、取消`,
      detail: watchDetail(reminder.watch, reminder.at),
      cancel: `不再检查，也不会再叫醒 ${leadName}`,
      setBy: setBy.short,
    };
  }
  const asked = askedWords(reminder.requester!);
  return {
    title: asked.title,
    label: `${asked.title}：查看来源、取消`,
    detail: `${asked.detail}${reminder.at ? `，${reminderClock(reminder.at)} 到点` : ''}。`,
    cancel: '不再提醒你，到点也不会叫醒 Lead',
  };
}

function UpcomingTimerRow({ reminder, leadName, onCancel }: {
  reminder: UpcomingReminder;
  leadName: string;
  onCancel?: (ref: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = reminder.timerRef!;
  const words = timerRowWords(reminder, leadName);
  const cancel = () => {
    if (!onCancel) return;
    setPending(true);
    setError(null);
    onCancel(ref).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setPending(false));
  };
  return (
    <Column testID={`reminder-upcoming-${reminder.id}`} gap="text-stack">
      <Popover
        testID={`reminder-upcoming-${reminder.id}-more`}
        label={words.label}
        title={words.title}
        width={260}
        // 触发区按内容定宽（Popover 的锚点 alignSelf: flex-start）：第二行放在触发区外面，不然它比第一行长时把第一行撑开，
        // 每行的「⋯」停在不同的地方。第一行和外部定时器的行一样，「⋯」紧跟在内容后面。
        trigger={(
          <Row minH={22} items="center" gap="inline-item">
            <UpcomingReminderLine reminder={reminder} />
            <Icon name="more" color="text-secondary" size={12} />
          </Row>
        )}
      >
        {(close) => (
          <Column>
            <Column px="row-x" py="row-y" gap="text-stack">
              {reminder.watch ? <Text size="body" weight="semibold" numberOfLines={2}>{reminder.title}</Text> : null}
              <Text size="secondary" tone="secondary">{words.detail}</Text>
            </Column>
            <RecordRow
              divider
              testID={`reminder-upcoming-${reminder.id}-cancel`}
              title={pending ? '正在取消…' : '取消'}
              detail={words.cancel}
              onPress={onCancel && !pending ? () => { close(); cancel(); } : undefined}
            />
          </Column>
        )}
      </Popover>
      {reminder.watch && words.setBy ? <UpcomingWatchLine watch={reminder.watch} setBy={words.setBy} /> : null}
      {error ? <Text size="note" tone="danger-dark">{`没有取消：${error}`}</Text> : null}
    </Column>
  );
}

// 卡里露不下的后台检查（第 4 个以后）：收成一行，点开是锚定浮层，一个检查一行，每行可以直接取消（P4.3、P2）。
function FoldedWatchesRow({ watches, leadName, onCancel }: {
  watches: readonly UpcomingReminder[];
  leadName: string;
  onCancel?: (ref: string) => Promise<void>;
}) {
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = `还有 ${watches.length} 个后台检查`;
  const cancel = (ref: string) => {
    if (!onCancel || pendingRef) return;
    setPendingRef(ref);
    setError(null);
    onCancel(ref).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setPendingRef(null));
  };
  return (
    <Column gap="text-stack">
      <Popover
        testID="reminder-upcoming-watches-more"
        label={`${label}：查看、取消`}
        title={label}
        width={260}
        trigger={(
          <Row minH={22} items="center" gap="inline-item">
            <Text size="label" tone="secondary">{label}</Text>
            <Icon name="more" color="text-secondary" size={12} />
          </Row>
        )}
      >
        <Column>
          <Box px="row-x" py="row-y">
            <Text size="secondary" tone="secondary">{`取消以后不再检查，也不会再叫醒 ${leadName}。`}</Text>
          </Box>
          {watches.map((reminder) => {
            const watch = reminder.watch!;
            const status = watchStatusWords(watch);
            const setBy = watchSetByWords(watch, reminder.requester, leadName).short;
            return (
              <RecordRow
                key={reminder.id}
                divider
                testID={`reminder-upcoming-${reminder.id}`}
                title={reminder.title}
                detail={[status?.text, watch.schedule, setBy].filter(Boolean).join(' · ')}
                action={{
                  icon: 'close',
                  label: pendingRef === reminder.timerRef ? '正在取消…' : `取消后台检查「${reminder.title}」`,
                  onPress: () => cancel(reminder.timerRef!),
                  disabled: !onCancel || pendingRef !== null,
                }}
              />
            );
          })}
        </Column>
      </Popover>
      {error ? <Text size="note" tone="danger-dark">{`没有取消：${error}`}</Text> : null}
    </Column>
  );
}

export function InboxQueue({
  items, inbox, notices, onOpenTicket, onRunAction, onAckNotification, onAckReminders, onDisownOwnerAction, onSeen,
  upcomingReminders = [], onCancelTimer, leadName = leadNameNow(),
}: InboxQueueProps) {
  const noticeIdsByTicket = Object.fromEntries(
    Object.entries(notices.byTicket).map(([ticketId, list]) => [ticketId, list.map((notice) => notice.id)]),
  );
  const cards = buildInboxCards(items, inbox?.tickets ?? [], noticeIdsByTicket);
  // 「自上次查看以来」按打开收件箱时拿到的上次时间算。先拿到它，再记下这一次（onSeen）：
  // 以前一打开就记，数据还没到，第一次拿到的已经是现在，Lead 刚处理的事全被收进「更早」。
  // 记下以后服务端的时间更新了，这一次仍然按打开时的时间展开那些新的。
  const openedSeenAt = useRef<string | null | undefined>(undefined);
  if (openedSeenAt.current === undefined && inbox !== null) openedSeenAt.current = inbox.seenAt;
  const handled = splitLeadHandled(inbox?.leadHandled ?? [], openedSeenAt.current ?? null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const loaded = inbox !== null;
  const recordedVisit = useRef(false);

  useEffect(() => {
    if (!loaded || recordedVisit.current) return;
    recordedVisit.current = true;
    onSeen?.();
  }, [loaded, onSeen]);

  const toggle = (id: string) => setExpandedId((current) => current === id ? null : id);
  const reminders = splitReminders(notices.reminders);
  const upcoming = splitUpcoming(upcomingReminders);

  return (
    <Column testID="inbox-queue" gap="stacked-card" w="100%">
      <Row items="center" gap="inline-item" px="section-label-x" pt="section-label-top" pb="section-label-bottom">
        <Text size="eyebrow" weight="extrabold" letterSpacing={0.3} color="danger-dark">需要你</Text>
        <Box testID="inbox-needs-count">
          <Text size="meta" weight="bold" tone="muted">{String(cards.length)}</Text>
        </Box>
      </Row>
      {cards.length === 0 ? (
        <Card rounded="xl" p="card" gap="text-stack">
          <Text size="card-title" weight="bold">没有需要你的事</Text>
          <Text size="secondary" tone="secondary">在跑和排队的事在工单里看。</Text>
        </Card>
      ) : null}
      {cards.map((card) => (
        <InboxCard
          key={card.ticketId}
          card={card}
          onOpen={() => onOpenTicket(card.ticketId, card.noticeIds)}
          onRun={() => (card.action ? onRunAction(card.ticketId, card.action, card.noticeIds) : Promise.resolve())}
        />
      ))}
      {notices.general.length ? (
        <Card testID="notification-outbox" tone="warning" rounded="sm" gap="card-row" p="card">
          {notices.general.slice(0, VISIBLE_NOTICES).map((notification) => {
            // 主人操作的提醒（工单 15）：「是我」确认这条通知，「不是我」撤销那次操作并作废凭证。
            const ownerActionId = ownerActionEventIdOfNotification(notification);
            if (ownerActionId) {
              return (
                <OwnerActionNoticeRow
                  key={notification.id}
                  notification={notification}
                  onBehalf={isOnBehalfOwnerActionNotification(notification)}
                  onItsMe={() => onAckNotification?.(notification.id)}
                  onNotMe={() => onDisownOwnerAction?.(ownerActionId, notification.id)}
                />
              );
            }
            return (
              <Row key={notification.id} minH={40} items="center" gap="side-item">
                <Column flex={1} minW={0}>
                  <Text size="card-title" weight="extrabold" numberOfLines={1}>{notification.title}</Text>
                  {notification.body ? (
                    <Text size="secondary" tone="secondary" numberOfLines={2}>{notification.body}</Text>
                  ) : null}
                </Column>
                <Button
                  testID={`notification-ack-${notification.id}`}
                  label="确认"
                  variant="outline"
                  tone="neutral"
                  size="xs"
                  onPress={() => onAckNotification?.(notification.id)}
                />
              </Row>
            );
          })}
          {notices.general.length > VISIBLE_NOTICES ? (
            <Text size="secondary" tone="secondary">{`还有 ${notices.general.length - VISIBLE_NOTICES} 条较早的通知`}</Text>
          ) : null}
        </Card>
      ) : null}
      {notices.reminders.length ? (
        <Card testID="reminder-notices" rounded="sm" p="card">
          <Row minH={28} items="center" gap="side-item">
            <Icon name="clock" color="text-secondary" size={14} />
            <Column flex={1} minW={0} gap="text-stack">
              {reminders.recent.length > 0 ? (
                <Text size="card-title" weight="bold" numberOfLines={1}>{`${reminders.recent.length} 条提醒没有确认`}</Text>
              ) : null}
              {reminders.folded.length > 0 ? (
                <Text size="secondary" tone="muted">
                  {reminders.recent.length > 0
                    ? `另有 ${reminders.folded.length} 条超过 30 天，收在日程的「已过期」里`
                    : `${reminders.folded.length} 条提醒超过 30 天没有确认，收在日程的「已过期」里`}
                </Text>
              ) : null}
            </Column>
            <Button
              testID="reminder-notices-ack"
              label="全部确认"
              variant="outline"
              tone="neutral"
              size="xs"
              onPress={() => onAckReminders?.(notices.reminders)}
            />
          </Row>
        </Card>
      ) : null}
      {upcomingReminders.length ? (
        // 等待中的提醒（工单 07）：会话里的卡不重复出现，这里和日程里一直看得到，到点前可以去改。
        <Card testID="reminder-upcoming" rounded="sm" p="card" gap="card-row">
          <Text size="eyebrow" weight="bold" tone="secondary">等待中的提醒</Text>
          {upcoming.shown.map((reminder) => (reminder.timerRef && (reminder.requester || reminder.watch)
            ? <UpcomingTimerRow key={reminder.id} reminder={reminder} leadName={leadName} onCancel={onCancelTimer} />
            : (
              <Row key={reminder.id} testID={`reminder-upcoming-${reminder.id}`} minH={22} items="center" gap="inline-item">
                <UpcomingReminderLine reminder={reminder} />
              </Row>
            )))}
          {upcoming.foldedWatches.length ? (
            <FoldedWatchesRow watches={upcoming.foldedWatches} leadName={leadName} onCancel={onCancelTimer} />
          ) : null}
        </Card>
      ) : null}
      {handled.fresh.length > 0 || handled.earlier.length > 0 ? (
        <Column testID="lead-handled" gap="group-label">
          <SectionTitle label={`${leadName} 已处理`} count={handled.fresh.length} tone="success" />
          {/* spacing-exempt: 行自带内边距 */}
          <Card rounded="xl" p={2} gap={0}>
            {handled.fresh.map((entry) => (
              <HandledRow key={entry.id} entry={entry} expanded={expandedId === entry.id} onToggle={() => toggle(entry.id)} />
            ))}
            {handled.earlier.length > 0 ? (
              <Pressable testID="lead-handled-earlier" onPress={() => setEarlierOpen((open) => !open)} feedback="highlight" px="row-x" py="row-y" rounded="md">
                <Row items="center" gap="icon-label">
                  <Icon name={earlierOpen ? 'chevron-down' : 'chevron-right'} color="text-muted" size={11} />
                  <Text size="label" tone="secondary">{`更早 ${handled.earlier.length} 件`}</Text>
                </Row>
              </Pressable>
            ) : null}
            {earlierOpen ? handled.earlier.map((entry) => (
              <HandledRow key={entry.id} entry={entry} expanded={expandedId === entry.id} onToggle={() => toggle(entry.id)} />
            )) : null}
          </Card>
        </Column>
      ) : null}
    </Column>
  );
}
