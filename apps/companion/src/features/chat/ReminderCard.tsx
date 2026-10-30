import { Box, Card, Column, MediaRow, Row, Text, Tile, type DataTone } from '@pi-lead-child/components';
import type { ReminderLevel, TicketStatus } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useConversationItemDetail, useTicketSummary } from '../../state/hooks';
import {
  ActionButton, ActionGroup, DisclosureView, FieldView, remainingWords, shortTimeWords, usePendingValue, type ActionProps,
} from '../genui/SurfaceControls';
import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (value: number) => String(value).padStart(2, '0');

// 提醒的时刻，用本地时间说：「周一 10-19 09:00」。
export function reminderTimeWords(at: string): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return `周${WEEKDAYS[date.getDay()]} ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ReminderCardView = {
  reminderId: number;
  // 提醒的标题。还没取到时为 null，卡片说操作本身（fallback）。
  title: string | null;
  remindAt: string | null;
  // 提醒现在的状态（items.stage，从 TicketSummary 来）。
  stage: TicketStatus | null;
  // 这张卡对应的操作是什么事件（改期、取消、确认）。只描述那次操作，不代表现在的状态：写在展开的浮层里。
  event: string | null;
  // 取不到提醒时，操作自己说了什么（「提醒 #83 已创建」）。
  fallback: string | null;
  // 提醒的级别（TicketDetail.reminder，工单 07）：interrupt 是「重要」。取不到时是 null。
  level?: ReminderLevel | null;
  // 到点以后推送的情况（到点卡给）：「08:55 提前推过 · 已推送 1 次 · 没确认 09:02 再推」。
  note?: string | null;
};

// 会话里的一条提醒：对象组件 Reminder（三层的最上层，.scratch/genui-catalog-v3/three-layers.md）。
// 2026-10-27 按画布「提醒卡 · 方案一」重画，用的是 genui 的同一套组件（Tile、MediaRow、DisclosureView、FieldView、ActionGroup）：
//   1 等待中：一张票根，日历页（月份、日期）贴着卡片左边，打孔线两头两个半圆缺口；标题；「周四 14:00 · 还有 3 天 1 小时」。没有按钮，整张卡可以点。
//   2 点开：卡片原位置撑开成浮层，日历页加宽放大（星期、日期、时刻）；改时间的选项；右下角「取消提醒」「改到…」。
//     选了一个时间：日历页先换成新的一天，标题下面写「~~周四 14:00~~ → 周五 14:00」，按钮写「改到周五 14:00」。
//   3 点「取消提醒」：右下角那一行换成确认。
//   4 重要：色带浅琥珀，「重要，到点会打断你」。
//   5 已确认：浅绿色带上一个勾，「14:03 已确认」，不再撑开。
//   6 已取消：日历页变灰，日期上一道斜线，标题划掉，「你在 10-27 09:12 取消」，不再撑开。
// 改时间和取消走操作层（提醒的 reschedule、工单的 cancel），和 Lead 的 perform_action、ticket_action 是同一个函数。
// 到点以后会话里另有一张到点卡（ReminderFireCard），画布里没有它，这次没改。
export function ReminderCard({ view }: { view: ReminderCardView }) {
  const listed = useTicketSummary(view.reminderId);
  const { detail } = useConversationItemDetail(view.reminderId, true);
  const summary = listed ?? detail?.ticket ?? null;
  const stage = summary?.stage ?? view.stage;
  const title = summary ? ticketDisplayTitle(ticketSummaryToTicket(summary)) : view.title ?? view.fallback ?? `提醒 #${view.reminderId}`;
  const remindAt = detail?.remindAt ?? view.remindAt;
  const at = remindAt ? new Date(remindAt) : null;
  const level = detail?.reminder?.level ?? view.level ?? null;
  const ended = stage === 'acked' || stage === 'cancelled' || stage === 'done';
  const changedAt = summary?.stageChangedAt ? new Date(summary.stageChangedAt) : null;
  const tone: DataTone = stage === 'acked' ? 'success' : stage === 'cancelled' ? 'neutral' : level === 'interrupt' || stage === 'fired' ? 'warning' : 'info';
  const id = view.reminderId;
  const actions: ActionProps[] = [
    {
      id: `reminder-${id}-cancel`, target: { type: 'ticket', id }, action: 'cancel', role: 'default', label: '取消提醒',
      confirmText: at ? `取消后，${shortTimeWords(at)} 不再提醒你。` : '取消后不再提醒你。',
    },
    {
      id: `reminder-${id}-save`, target: { type: 'reminder' as const, id: String(id) }, action: 'reschedule', role: 'primary',
      label: '改到…', labelWithValue: '改到{value}',
    },
  ];
  // 到点了还没确认（覆盖表「到点」：对象 Reminder 的到点态）：模式「事项」右边一个按钮「知道了」；
  // 「10 分钟后」是点开以后改时间的第一个选项。视觉稿没有单画这一态，色带和等待中的「重要」一样是琥珀。
  const fired = stage === 'fired';
  const summaryRow = (
    <MediaRow attach bleed testID={`reminder-card-${id}-stub`} lead={<ReminderPage at={at} tone={tone} stage={stage} />}>
      <Row items="center" gap="side-item">
        <Box flex={1} minW={0}>
          <ReminderLines reminderId={id} title={title} at={at} stage={stage} level={level} changedAt={changedAt} note={view.note ?? null} />
        </Box>
        {fired ? (
          // 「知道了」是操作层里提醒的 ack（和 Lead 的 perform_action 同一个函数），不在工单操作的清单里。
          <ActionButton id={`reminder-${id}-ack`} target={{ type: 'reminder' as const, id: String(id) }} action="ack" role="primary" label="知道了" />
        ) : null}
      </Row>
    </MediaRow>
  );
  return (
    <Card testID={`reminder-card-${id}`} w="100%" rounded="xl" overflow="visible" borderWidth={1} borderColor="border">
      <DisclosureView
        id={`reminder-${id}`}
        label={`提醒：${title}`}
        partial={false}
        ended={ended}
        targets={{ [actions[0]!.id]: id, [actions[1]!.id]: id }}
        summary={summaryRow}
        panel={(
          <MediaRow attach bleed notches={false} testID={`reminder-card-${id}-open`} lead={<ReminderPage at={at} tone={tone} stage={stage} reminderId={id} expanded />}>
            <Column gap="card-section">
              <ReminderLines reminderId={id} title={title} at={at} stage={stage} level={level} changedAt={changedAt} />
              {view.event ? <Text size="secondary" tone="muted" numberOfLines={1}>{view.event}</Text> : null}
              <FieldView
                id={`reminder-${id}-pick`}
                for={actions[1]!.id}
                param="remindAt"
                kind="datetime"
                label="改到"
                presets={reminderPresets(at, fired)}
                freeInput
                previewedByCard
              />
              <ActionGroup actions={actions} />
            </Column>
          </MediaRow>
        )}
      />
    </Card>
  );
}

// 改时间的常用选项：一小时后、明天 09:00、原来那一天的后一天同一时刻、下周一 09:00。按下时才换算（resolveDatetimePreset）。
function reminderPresets(at: Date | null, fired = false): Array<{ label: string; value: string }> {
  // 到点了：最常用的是再等一会儿。
  const presets = [...(fired ? [{ label: '10 分钟后', value: '+10m' }] : []), { label: '1 小时后', value: '+1h' }, { label: '明天 09:00', value: '+1d 09:00' }];
  if (at) {
    const next = new Date(at);
    next.setDate(next.getDate() + 1);
    if (next.getTime() > Date.now()) presets.push({ label: shortTimeWords(next), value: next.toISOString() });
  }
  presets.push({ label: '下周一 09:00', value: 'mon 09:00' });
  return presets;
}

// 日历页：月份的色带、日期；展开时加宽，多写星期和时刻。选了新时间时先换成新的一天，最下面划掉原来那天。
function ReminderPage({ at, tone, stage, expanded = false, reminderId }: {
  at: Date | null; tone: DataTone; stage: TicketStatus | null; expanded?: boolean; reminderId?: number;
}) {
  const pendingIso = usePendingValue(reminderId ?? 0, 'remindAt');
  const pending = expanded && pendingIso ? new Date(pendingIso) : null;
  const shown = pending ?? at;
  const weekday = (date: Date) => `周${WEEKDAYS[date.getDay()]}`;
  return (
    <Tile
      testID={`reminder-page${expanded ? '-open' : ''}`}
      attached
      size={expanded ? 'md' : 'sm'}
      tone={tone}
      eyebrow={shown ? `${shown.getMonth() + 1}月` : '提醒'}
      value={shown ? shown.getDate() : '—'}
      done={stage === 'acked'}
      crossed={stage === 'cancelled'}
      highlight={pending !== null}
      {...(expanded && shown ? { above: weekday(shown), caption: `${pad(shown.getHours())}:${pad(shown.getMinutes())}` } : {})}
      {...(pending && at ? { was: `原 ${weekday(at)} ${at.getDate()}` } : {})}
    />
  );
}

// 标题和下面一行。下面一行按状态写：等待中写时刻和剩余时间，重要写会打断你，已确认、已取消写什么时候。
function ReminderLines({ reminderId, title, at, stage, level, changedAt, note = null }: {
  reminderId: number; title: string; at: Date | null; stage: TicketStatus | null; level: ReminderLevel | null; changedAt: Date | null;
  note?: string | null;
}) {
  const pendingIso = usePendingValue(reminderId, 'remindAt');
  const pending = pendingIso ? new Date(pendingIso) : null;
  const when = at ? shortTimeWords(at) : null;
  const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(date)}`;
  let line;
  if (pending && when) {
    line = (
      <Row items="center" gap="icon-label" flexWrap="wrap">
        <Text size="note" tone="muted" textDecorationLine="line-through">{when}</Text>
        <Text size="note" tone="secondary">→</Text>
        <Text size="note" weight="semibold" tone="accent">{shortTimeWords(pending)}</Text>
      </Row>
    );
  } else if (stage === 'acked') {
    line = <Text size="note" tone="success-dark">{changedAt ? `${clock(changedAt)} 已确认` : '已确认'}</Text>;
  } else if (stage === 'cancelled') {
    line = <Text size="note" tone="secondary">{changedAt ? `你在 ${day(changedAt)} 取消` : '已取消'}</Text>;
  } else {
    // 到点了先说到点了：重要的提醒到点以后不再说「到点会打断你」。
    const tail = stage === 'fired'
      ? <Text testID="reminder-card-fired" size="note" tone="warning-dark">{level === 'interrupt' ? '重要，到点了' : '到点了'}</Text>
      : level === 'interrupt'
        ? <Text size="note" tone="warning-dark">重要，到点会打断你</Text>
        : at ? <LiveRemaining at={at} /> : null;
    line = (
      <Row items="center" gap="icon-label" flexWrap="wrap">
        {when ? <Text size="note" tone="secondary">{when}</Text> : null}
        {when && tail ? <Text size="note" tone="faint">·</Text> : null}
        {tail}
      </Row>
    );
  }
  return (
    <Column gap="text-stack" minW={0}>
      <Text
        size="card-title"
        weight="bold"
        tone={stage === 'cancelled' ? 'muted' : 'default'}
        {...(stage === 'cancelled' ? { textDecorationLine: 'line-through' as const } : {})}
        numberOfLines={2}
      >
        {title}
      </Text>
      {line}
      {note ? <Text testID="reminder-card-note" size="note" tone="secondary" numberOfLines={1}>{note}</Text> : null}
    </Column>
  );
}

// 剩余时间每 30 秒更新一次。
function LiveRemaining({ at }: { at: Date }) {
  const now = useMinuteClock();
  return <Text size="note" tone="accent">{remainingWords(at, now)}</Text>;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
