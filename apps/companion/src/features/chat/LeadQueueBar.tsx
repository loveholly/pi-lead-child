import { AnchoredPanel, Box, Button, Column, Dot, Icon, Popover, Pressable, RecordRow, Row, Text } from '@pi-lead-child/components';
import {
  leadQueueSummary, leadQueueVisible, type LeadQueue, type LeadQueueAction, type LeadQueueEntry,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { ChannelCardSlot } from './ChannelMessageCard';

// Lead 忙时排着的外部消息（统一消息事件 spec D6、D12，工单 10）。Lead 正在一轮里、有外部消息排着时，主对话输入框上方
// 「插话/排队」那一行的右边显示一行状态，例如「排队 2 条：李雷、Kent」。那一行只在 Lead 忙时出现，状态栏不增加它的高度，
// 会话列表不跳（P1）。点开是锚定浮层（P2，AnchoredPanel），从状态栏向上展开；手机上是底部面板（P13.2）。
//   · 状态栏是系统信息行（P9.9，主题 11.9）：meta、text-secondary、12 的图标，右边是展开箭头（11.5）。作者是系统（P8.1）。
//   · 面板里每个对话一行，是外来消息（P9.3，主题 11.2 的收起态）去掉 Fairy 那一行（Lead 处理以前不放草稿，spec D8）：
//     头部（来源图标、人名、对话、时间，右边是状态），对方最新一条（别人说话的气泡，多条时前面是「N 条」小标签）。
//     状态是进行中（C-12，小圆点加文字，不加徽章）：排在最前面的写「下一个」，别的写「排队中」。
//   · 收起态没有按钮（A-4，用户 2026-10-26：低频操作不默认露出成按钮）。点整行打开卡：面板里换成这张卡本身
//     （会话里的同一个 ChannelCardSlot，P3.4 的详情层），上面有「返回」，不滚动会话列表。
//   · 「排到下一个」「移出队列」收在每行右边的「⋯」里（和工单头部的「⋯」同一种：Popover 加 RecordRow）。
//     它们是操作层的 lead_queue（P5.7）；只列现在能做的（entry.actions，daemon 的 available 给的）。
//   样式的对应经主会话确认（2026-10-27），不另写主题规则。
// 状态从 daemon 推来（GET /v1/lead/queue 和 lead-queue 的推送，protocol 的 lead-queue.ts），Web 和 iOS 是同一份。

// 「⋯」的点击区（P13.5：手机上能点的区域至少 44pt）。这是组件自己的规格，不是间距：图标还是 16，
// 贴在点击区的右上角，位置和以前一样。这一行的内容比 44 高，所以行高不变；点击区整块在触发按钮里，三端都点得到。
const MORE_TAP_AREA = 44;

// 本地的「时:分」（P14.2）。
function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export const ACTION_LABELS: Record<LeadQueueAction, { idle: string; busy: string; detail: string }> = {
  move_next: { idle: '排到下一个', busy: '正在排…', detail: '这一轮结束以后先处理它' },
  remove: { idle: '移出队列', busy: '正在移出…', detail: '你自己处理，卡结束' },
};

// 状态栏那一行。收着时是状态栏，打开以后是浮层的头（压在原位置上），右边的箭头换成收起。
function QueueLine({ summary, open }: { summary: string; open: boolean }) {
  return (
    <Row items="center" justify="flex-end" gap="icon-label" px="banner-x">
      <Icon name="clock" size={12} color="text-secondary" />
      <Text testID="lead-queue-summary" size="meta" tone="secondary" numberOfLines={1} shrink={1}>{summary}</Text>
      <Icon name={open ? 'chevron-down' : 'chevron-up'} size={12} color="text-secondary" />
    </Row>
  );
}

function QueueEntryRow({ entry, first, pending, error, onAction, onOpenCard }: {
  entry: LeadQueueEntry;
  first: boolean;
  // 这一行正在做的操作（P5.4：状态写「正在……」）。
  pending: LeadQueueAction | null;
  error: string | null;
  onAction: (action: LeadQueueAction) => void;
  onOpenCard: ((cardId: number) => void) | null;
}) {
  const cardId = entry.cardIds.at(-1) ?? null;
  const who = entry.senders.join('、');
  // 不给 flex：它在 Pressable（纵向）里，flex 1 会让它在 web 上高度变成 0。横向撑满由外面那一层给。
  const content = (
    <Column w="100%" minW={0} gap="card-row">
      <Row items="center" gap="inline-item">
        <Row flex={1} minW={0} items="center" gap="icon-label">
          <Icon name="chat" size={16} color="text-secondary" />
          <Text size="card-title" weight="semibold" numberOfLines={1} shrink={1}>{who}</Text>
          <Text size="meta" tone="secondary" numberOfLines={1} shrink={1}>{entry.conversation}</Text>
          <Text size="meta" tone="secondary" mono shrink={0}>{clock(entry.lastAt)}</Text>
        </Row>
        <Row items="center" gap="icon-label" shrink={0}>
          <Dot color="accent" size={7} />
          <Text testID={`lead-queue-entry-${entry.key}-state`} size="label" weight="semibold" color="accent-strong">
            {pending ? ACTION_LABELS[pending].busy : entry.next ? '下一个' : '排队中'}
          </Text>
        </Row>
      </Row>
      <Row items="center" gap="icon-label">
        {entry.count > 1 ? (
          <Box px="pill-x" py="pill-y" rounded="full" bg="surface-muted" shrink={0}>
            <Text size="meta" weight="semibold" tone="secondary">{`${entry.count} 条`}</Text>
          </Box>
        ) : null}
        {/* 别人说话的气泡：圆角是气泡自己的规格（主题 R-5：左上 4，其余 14）。 */}
        <Box
          shrink={1}
          minW={0}
          bg="accent-soft"
          px="inset-x"
          py="inset-y"
          borderTopLeftRadius={4}
          borderTopRightRadius={14}
          borderBottomLeftRadius={14}
          borderBottomRightRadius={14}
        >
          <Text testID={`lead-queue-entry-${entry.key}-excerpt`} size="body" numberOfLines={1}>{entry.excerpt}</Text>
        </Box>
      </Row>
      {error ? <Text size="note" tone="danger-dark">{`没有做成：${error}`}</Text> : null}
    </Column>
  );
  return (
    <Row
      testID={`lead-queue-entry-${entry.key}`}
      items="flex-start"
      gap="side-item"
      p="card"
      borderTopWidth={first ? 0 : 1}
      borderTopColor="border-soft"
    >
      {/* 收起态没有按钮：点整行打开这张卡（P2.3、A-4）。 */}
      {cardId !== null && onOpenCard ? (
        <Pressable
          testID={`lead-queue-entry-${entry.key}-open`}
          aria-label={`打开${who}的卡`}
          onPress={() => onOpenCard(cardId)}
          feedback="highlight"
          rounded="md"
          flex={1}
          minW={0}
        >
          {content}
        </Pressable>
      ) : <Box flex={1} minW={0}>{content}</Box>}
      {/* 低频操作收进「⋯」（A-4，用户 2026-10-26）：只列现在能做的（entry.actions，daemon 给的）。 */}
      {entry.actions.length ? (
        <Popover
          testID={`lead-queue-entry-${entry.key}-more`}
          label={`更多：${entry.actions.map((action) => ACTION_LABELS[action].idle).join('、')}`}
          title={`${who}的消息`}
          width={260}
          trigger={(
            <Box
              testID={`lead-queue-entry-${entry.key}-more-target`}
              w={MORE_TAP_AREA}
              h={MORE_TAP_AREA}
              items="flex-end"
              justify="flex-start"
            >
              <Icon name="more" size={16} color="text-secondary" />
            </Box>
          )}
        >
          {(close) => (
            <Column>
              {entry.actions.map((action, index) => (
                <RecordRow
                  key={action}
                  divider={index > 0}
                  testID={`lead-queue-entry-${entry.key}-${action}`}
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
  );
}

export function LeadQueueBarView({ queue, onAction, renderCard }: {
  queue: LeadQueue;
  onAction: (action: LeadQueueAction, key: string) => Promise<void>;
  // 「打开卡」：面板里换成这张卡本身。不给时没有「打开卡」。
  renderCard?: (cardId: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 面板里打开的卡（详情层）。null 是在看排队。
  const [cardId, setCardId] = useState<number | null>(null);
  const [pending, setPending] = useState<{ key: string; action: LeadQueueAction } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  if (!leadQueueVisible(queue)) return null;
  const summary = leadQueueSummary(queue);
  const close = () => {
    setOpen(false);
    setCardId(null);
  };
  const run = (action: LeadQueueAction, key: string) => {
    setPending({ key, action });
    setError(null);
    onAction(action, key).then(
      () => setPending(null),
      (cause: unknown) => {
        setPending(null);
        setError({ key, message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  };
  const body = cardId !== null && renderCard ? (
    <Column testID="lead-queue-card" p="card" gap="card-row">
      <Row>
        <Button testID="lead-queue-back" label="返回" icon="chevron-left" onPress={() => setCardId(null)} variant="link" size="xs" />
      </Row>
      {renderCard(cardId)}
    </Column>
  ) : (
    <Column>
      {queue.entries.map((entry, index) => (
        <QueueEntryRow
          key={entry.key}
          entry={entry}
          first={index === 0}
          pending={pending?.key === entry.key ? pending.action : null}
          error={error?.key === entry.key ? error.message : null}
          onAction={(action) => run(action, entry.key)}
          onOpenCard={renderCard ? setCardId : null}
        />
      ))}
    </Column>
  );
  return (
    <AnchoredPanel
      testID="lead-queue"
      open={open}
      onClose={close}
      label={summary}
      header={(
        <Pressable testID="lead-queue-header" aria-label={`${summary}，收起`} onPress={close} feedback="none" py="banner-y">
          <QueueLine summary={summary} open />
        </Pressable>
      )}
      body={body}
    >
      <Pressable
        testID="lead-queue-bar"
        aria-label={`${summary}，展开`}
        aria-expanded={open}
        onPress={() => setOpen(true)}
        feedback="highlight"
        rounded="md"
        // 上下的留白比「插话/排队」那一行矮（web 34、iOS 30）：状态栏出现时那一行不变高。
        py="pill-y"
      >
        <QueueLine summary={summary} open={false} />
      </Pressable>
    </AnchoredPanel>
  );
}

// 主对话输入框上方的排队状态栏。排队从 store 取（daemon 推来的整份），操作经 runtime 发到网关。
export function LeadQueueBar() {
  const runtime = useCompanionRuntime();
  const queue = useControlPlaneStore((state) => state.leadQueue);
  if (!queue) return null;
  return (
    <LeadQueueBarView
      queue={queue}
      onAction={(action, key) => runtime.leadQueueAction(action, key)}
      renderCard={(cardId) => <ChannelCardSlot cardId={cardId} />}
    />
  );
}
