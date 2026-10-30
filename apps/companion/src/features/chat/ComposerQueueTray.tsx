import {
  Box, Button, Column, Dot, Grow, Icon, IconButton, isWeb, Popover, Pressable, RecordRow, Row, Text,
} from '@pi-lead-child/components';
import type { FollowUpAction, LeadQueue, LeadQueueAction, LeadQueueEntry } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import type { ControlPlaneData, LeadTurnEntity } from '../../state/types';
import { ACTION_LABELS } from './LeadQueueBar';
import type { ComposerTray } from './MessageComposer';

// 输入框上的状态栏（主题 11.13，2026-10-28 用户定：方案 C，贴着输入框，默认收起）。
// Lead 忙时排着的事：你排着的追问（daemon 交给 pi 的 followUp，会话里是 placement=queued 的轮次），
// 和排着的外部消息（GET /v1/lead/queue）。Lead 答完这一轮先答你的追问，再按顺序处理外部消息。
//   · 收起：输入卡片的上半截一行，写「排队 N」和最新的一条你的追问（没有追问时写下一个外部消息），右边 Steer、×、展开。
//   · 展开：其余几条从这一行往上长出来（Grow），最新的一条留在原位，成了列表的最后一行；卡片上面两个角变成直角。
//   · Steer（user_only，外部的一轮里 Lead 不能做）：把这一条插进 Lead 正在做的这一轮。
//   · ×（user_direct）：这一条不再发给 Lead。Lead 永远不能代你做。
//   · 外部消息不给 Steer；「排到下一个」「移出队列」收在「⋯」里，和以前的排队面板一样。

// 时间写本地的「时:分」（P14.2）。
function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

const FOLLOW_UP_LABELS: Record<FollowUpAction, { busy: string }> = {
  steer: { busy: '正在插入…' },
  cancel: { busy: '正在取消…' },
};

// 你排着的追问：主会话里、还在排队的用户轮次，按发出的先后。
export function isQueuedFollowUp(turn: Pick<LeadTurnEntity, 'placement' | 'state' | 'ticketId'>): boolean {
  return turn.placement === 'queued' && turn.state === 'queued' && turn.ticketId === null;
}

export function queuedFollowUpIds(state: Pick<ControlPlaneData, 'turnsById'>): string[] {
  return Object.values(state.turnsById)
    .filter(isQueuedFollowUp)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((turn) => turn.id);
}

// 一条追问的原话：用户消息的文字；只发了图片时写「[图片]」。
function useFollowUpText(turnId: string): { text: string; at: string } {
  return useControlPlaneStore(useShallow((state) => {
    const turn = state.turnsById[turnId];
    const part = turn ? state.messagePartsById[`${turn.userMessageId}:text`] : undefined;
    const text = part?.kind === 'text' ? part.text.trim() : '';
    return { text: text || '[图片]', at: turn?.createdAt ?? '' };
  }));
}

// 「排队 N」：你的追问几条，加外部消息几条（外部的一个对话可能排着几条）。
export function queueCount(followUps: number, queue: Pick<LeadQueue, 'entries'> | null): number {
  return followUps + (queue?.entries.reduce((sum, entry) => sum + entry.count, 0) ?? 0);
}

function CountLabel({ count }: { count: number }) {
  return (
    <Row items="center" gap="icon-label" shrink={0}>
      <Dot color="accent" size={7} />
      <Text testID="queue-tray-count" size="label" weight="semibold" tone="strong">{`排队 ${count}`}</Text>
    </Row>
  );
}

function FollowUpRow({ turnId, tagged, actions, pending, error, onAction }: {
  turnId: string;
  // 展开时最后一行也写「你的追问」，和上面几行一样。收起时这一行前面已经有「排队 N」，不写。
  tagged: boolean;
  actions: boolean;
  pending: FollowUpAction | null;
  error: string | null;
  onAction: (action: FollowUpAction) => void;
}) {
  const { text, at } = useFollowUpText(turnId);
  return (
    <Column flex={1} minW={0} gap="text-stack">
      <Row items="center" gap="inline-item" minW={0}>
        <Icon name="reply" size={14} color="text-secondary" />
        {tagged ? (
          <Box px="pill-x" py="pill-y" rounded="md" bg="surface-muted" shrink={0}>
            <Text size="meta" weight="semibold" tone="secondary">你的追问</Text>
          </Box>
        ) : null}
        <Text testID={`queue-follow-up-${turnId}-text`} size="body" numberOfLines={1} shrink={1}>{text}</Text>
        <Text size="meta" tone="secondary" mono shrink={0}>{clock(at)}</Text>
        <Box flex={1} />
        {pending ? <Text size="label" weight="semibold" color="accent-strong">{FOLLOW_UP_LABELS[pending].busy}</Text> : null}
        {actions && !pending ? (
          <>
            <Button
              testID={`queue-follow-up-${turnId}-steer`}
              label="Steer"
              variant="outline"
              tone="neutral"
              size="xs"
              onPress={() => onAction('steer')}
            />
            <IconButton
              testID={`queue-follow-up-${turnId}-cancel`}
              icon="close"
              label="取消这条追问"
              variant="ghost"
              size="xs"
              iconSize={14}
              iconColor="text-muted"
              onPress={() => onAction('cancel')}
            />
          </>
        ) : null}
      </Row>
      {error ? <Text size="note" tone="danger-dark">{`没有做成：${error}`}</Text> : null}
    </Column>
  );
}

function ExternalRow({ entry, pending, error, onAction }: {
  entry: LeadQueueEntry;
  pending: LeadQueueAction | null;
  error: string | null;
  onAction: (action: LeadQueueAction) => void;
}) {
  const who = entry.senders.join('、');
  return (
    <Column flex={1} minW={0} gap="text-stack">
      <Row items="center" gap="inline-item" minW={0}>
        <Icon name="chat" size={14} color="text-secondary" />
        <Text size="label" weight="semibold" numberOfLines={1} shrink={0}>{who}</Text>
        <Text size="meta" tone="secondary" numberOfLines={1} shrink={0}>{entry.conversation}</Text>
        <Text testID={`queue-external-${entry.key}-excerpt`} size="body" tone="strong" numberOfLines={1} shrink={1}>{entry.excerpt}</Text>
        <Box flex={1} />
        <Text size="label" weight="semibold" color="accent-strong" shrink={0}>
          {pending ? ACTION_LABELS[pending].busy : entry.next ? '下一个' : '排队中'}
        </Text>
        <Text size="meta" tone="secondary" mono shrink={0}>{clock(entry.lastAt)}</Text>
        {entry.actions.length ? (
          <Popover
            testID={`queue-external-${entry.key}-more`}
            label={`更多：${entry.actions.map((action) => ACTION_LABELS[action].idle).join('、')}`}
            title={`${who}的消息`}
            width={260}
            trigger={<Icon name="more" size={16} color="text-secondary" />}
          >
            {(close) => (
              <Column>
                {entry.actions.map((action, index) => (
                  <RecordRow
                    key={action}
                    divider={index > 0}
                    testID={`queue-external-${entry.key}-${action}`}
                    title={ACTION_LABELS[action].idle}
                    detail={ACTION_LABELS[action].detail}
                    onPress={pending === null ? () => { close(); onAction(action); } : undefined}
                  />
                ))}
              </Column>
            )}
          </Popover>
        ) : null}
      </Row>
      {error ? <Text size="note" tone="danger-dark">{`没有做成：${error}`}</Text> : null}
    </Column>
  );
}

type Item = { kind: 'follow_up'; id: string } | { kind: 'external'; id: string; entry: LeadQueueEntry };

// 状态栏：返回输入卡片要的那一行和往上长的列表。没有排着的事时返回 null，输入框变回原来的样子。
//   actions：daemon 支持 Steer 和取消（CHAT_FOLLOW_UP_ACTIONS_CAPABILITY）时才给这两个按钮。
export function useComposerQueueTray({ leadName, actions }: { leadName: string; actions: boolean }): ComposerTray | null {
  const runtime = useCompanionRuntime();
  const followUpIds = useControlPlaneStore(useShallow(queuedFollowUpIds));
  const queue = useControlPlaneStore((state) => state.leadQueue);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ id: string; action: FollowUpAction | LeadQueueAction } | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const external = queue?.busy ? queue.entries : [];
  const items: Item[] = [
    ...external.map((entry): Item => ({ kind: 'external', id: entry.key, entry })),
    ...followUpIds.map((id): Item => ({ kind: 'follow_up', id })),
  ];
  const empty = items.length === 0;

  // 排空了就收回（下一次有排着的事时从收起开始）。
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  // web 上 Esc 收起（P13.6）。
  useEffect(() => {
    if (!open || !isWeb || typeof window === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (empty) return null;

  const run = (id: string, action: FollowUpAction | LeadQueueAction, task: () => Promise<unknown>) => {
    setPending({ id, action });
    setError(null);
    task().then(
      () => setPending(null),
      (cause: unknown) => {
        setPending(null);
        setError({ id, message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  };
  const renderItem = (item: Item, tagged: boolean) => item.kind === 'follow_up' ? (
    <FollowUpRow
      turnId={item.id}
      tagged={tagged}
      actions={actions}
      pending={pending?.id === item.id ? pending.action as FollowUpAction : null}
      error={error?.id === item.id ? error.message : null}
      onAction={(action) => run(item.id, action, () => runtime.followUpAction(action, item.id))}
    />
  ) : (
    <ExternalRow
      entry={item.entry}
      pending={pending?.id === item.id ? pending.action as LeadQueueAction : null}
      error={error?.id === item.id ? error.message : null}
      onAction={(action) => run(item.id, action, () => runtime.leadQueueAction(action, item.id))}
    />
  );

  // 最新的一条你的追问留在卡片里；没有追问时是下一个外部消息（排在最前面的那个）。
  const latest = followUpIds.length ? items.at(-1)! : items[0]!;
  const rest = items.filter((item) => item !== latest);
  const count = queueCount(followUpIds.length, queue?.busy ? queue : null);
  const summary = `排队 ${count}`;

  // 收起时在那一行的最右边，展开时在列表头的最右边：同一个按钮，两个位置（只有一个看得见、点得到）。
  const toggle = (testID: string) => (
    <Pressable
      testID={testID}
      aria-label={open ? `${summary}，收起` : `${summary}，展开`}
      aria-expanded={open}
      onPress={() => setOpen(!open)}
      feedback="highlight"
      rounded="md"
      items="center"
      justify="center"
      w={28}
      h={28}
      borderWidth={1}
      borderColor="border-strong"
      bg="surface"
    >
      <Icon name={open ? 'chevron-down' : 'chevron-up'} size={14} color="text-strong" />
    </Pressable>
  );

  const row = (
    <Row
      testID="queue-tray"
      items="center"
      gap="inline-item"
      px="composer-x"
      py="pill-y"
      bg={open ? 'surface' : 'surface-subtle'}
      borderBottomWidth={1}
      borderBottomColor="border-soft"
    >
      {open ? null : (
        <>
          <CountLabel count={count} />
          <Box w={1} h={12} bg="border-strong" shrink={0} />
        </>
      )}
      {renderItem(latest, open)}
      {open ? null : toggle('queue-tray-toggle')}
    </Row>
  );

  const drawer = (
    <Grow open={open} placement="above" testID="queue-tray-drawer">
      <Column
        role="list"
        aria-label={summary}
        bg="surface"
        borderWidth={1}
        borderBottomWidth={0}
        borderColor="border-input"
        rounded="4xl"
        borderBottomLeftRadius={0}
        borderBottomRightRadius={0}
        overflow="hidden"
      >
        <Row items="center" gap="inline-item" px="composer-x" py="pill-y" bg="surface-subtle">
          <CountLabel count={count} />
          <Text size="meta" tone="secondary" numberOfLines={1} shrink={1}>{`${leadName} 回完这一轮先答你的追问，再按顺序处理外部消息`}</Text>
          <Box flex={1} />
          {toggle('queue-tray-collapse')}
        </Row>
        {rest.map((item) => (
          <Row key={`${item.kind}:${item.id}`} role="listitem" items="center" px="composer-x" py="pill-y" borderTopWidth={1} borderTopColor="border-soft">
            {renderItem(item, true)}
          </Row>
        ))}
      </Column>
    </Grow>
  );

  return { row, drawer, open };
}
