import {
  Box, Button, Card, Column, Divider, Dot, Icon, Pressable, Row, Text, TextField, type ColorToken,
} from '@pi-lead-child/components';
import type { MilestoneState, TimelineResponse } from '@pi-lead-child/protocol';
import { Fragment, useState } from 'react';

import { buildWeek, localDateKey } from './model';
import {
  buildTimelineView,
  milestoneInputValue,
  parseMilestoneInput,
  type TimelineRowView,
  type TimelineTagTone,
} from './timelineModel';

export type MilestonePatch = { at?: string; state?: MilestoneState };

type AgendaTimelineProps = {
  timeline: TimelineResponse | null;
  onOpenTicket?: (ticketId: number) => void;
  onUpdateMilestone?: (milestoneId: number, patch: MilestonePatch) => Promise<void>;
};

const TAG_COLORS: Record<TimelineTagTone, { bg: ColorToken; text: ColorToken }> = {
  danger: { bg: 'danger-soft', text: 'danger-dark' },
  warning: { bg: 'warning-soft', text: 'warning-dark' },
  success: { bg: 'success-soft', text: 'success-dark' },
  accent: { bg: 'accent-soft', text: 'accent-strong' },
  neutral: { bg: 'surface-muted', text: 'text-secondary' },
};

// 一件事一行：时间、类型标签、标题；下面一行是出处或状态，有风险时标红。节点可以改日期、标完成、取消。
function TimelineRow({ row, onOpenTicket, onUpdateMilestone }: {
  row: TimelineRowView;
  onOpenTicket?: (ticketId: number) => void;
  onUpdateMilestone?: (milestoneId: number, patch: MilestonePatch) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const colors = TAG_COLORS[row.tag.tone];
  const canEdit = row.editable && row.milestoneId !== null && onUpdateMilestone !== undefined;

  const submit = async (patch: MilestonePatch) => {
    if (row.milestoneId === null || !onUpdateMilestone || pending) return;
    setPending(true);
    setError(null);
    try {
      await onUpdateMilestone(row.milestoneId, patch);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const save = () => {
    const at = parseMilestoneInput(value, row.at, new Date());
    if (!at) {
      setError('写成「10/17 18:00」或「2026-10-17 18:00」');
      return;
    }
    void submit({ at });
  };

  return (
    <Column testID={`agenda-row-${row.id}`} px="row-x" py="row-y" gap="card-row">
      <Pressable
        onPress={row.opensTicket && row.ticketId !== null && onOpenTicket ? () => onOpenTicket(row.ticketId!) : undefined}
        feedback="opacity"
      >
        <Row gap="timeline" items="flex-start">
          {/* spacing-exempt: 光学对齐 */}
          <Box w={44} pt={1}>
            <Text size="meta" mono weight="bold" tone={row.muted ? 'faint' : 'secondary'}>{row.time}</Text>
          </Box>
          <Column flex={1} minW={0} gap="text-stack">
            <Row items="center" gap="inline-item">
              <Box px="pill-x" rounded={5} bg={colors.bg}>
                {/* spacing-exempt: 徽标字号 */}
                <Text size="10.5" leading={17} weight="bold" color={colors.text}>{row.tag.label}</Text>
              </Box>
              <Text flex={1} minW={0} size="card-title" weight="bold" tone={row.muted ? 'muted' : 'default'} numberOfLines={1}>
                {row.title}
              </Text>
            </Row>
            {row.sub || row.risk || canEdit ? (
              <Row items="center" gap="inline-item" flexWrap="wrap">
                {row.sub ? <Text size="meta" tone="muted">{row.sub}</Text> : null}
                {canEdit && !row.muted ? (
                  <Pressable
                    testID={`agenda-edit-${row.id}`}
                    onPress={() => {
                      setValue(milestoneInputValue(row.at));
                      setError(null);
                      setEditing((open) => !open);
                    }}
                    feedback="opacity"
                  >
                    {/* spacing-exempt: 链接字号 */}
                    <Text size="11" weight="bold" color="accent">{editing ? '收起' : '改'}</Text>
                  </Pressable>
                ) : null}
                {row.risk ? (
                  <Row items="center" gap="icon-label">
                    <Icon name="warning" color="danger" size={11} />
                    <Text size="label" weight="bold" color="danger-dark">{row.risk}</Text>
                  </Row>
                ) : null}
              </Row>
            ) : null}
          </Column>
        </Row>
      </Pressable>
      {editing ? (
        // spacing-exempt: 对齐事件正文
        <Column pl={54} gap="card-row" pt="card-row">
          <TextField
            testID={`agenda-edit-input-${row.id}`}
            value={value}
            onChangeText={setValue}
            placeholder="10/17 18:00"
            size="sm"
            variant="outline"
            onSubmit={save}
            accessibilityLabel="新的日期和时间"
          />
          <Row gap="actions" flexWrap="wrap">
            <Button testID={`agenda-edit-save-${row.id}`} label={pending ? '正在保存…' : '改期'} size="xs" tone="accent" disabled={pending} onPress={save} />
            <Button testID={`agenda-edit-done-${row.id}`} label="标为完成" size="xs" variant="outline" tone="neutral" disabled={pending} onPress={() => { void submit({ state: 'done' }); }} />
            <Button testID={`agenda-edit-cancel-${row.id}`} label="取消这个节点" size="xs" variant="ghost" tone="neutral" disabled={pending} onPress={() => { void submit({ state: 'cancelled' }); }} />
          </Row>
          {error ? <Text size="secondary" color="danger-dark">{error}</Text> : null}
        </Column>
      ) : null}
    </Column>
  );
}

function RowsCard({ rows, testID, ...handlers }: {
  rows: TimelineRowView[];
  testID?: string;
  onOpenTicket?: (ticketId: number) => void;
  onUpdateMilestone?: (milestoneId: number, patch: MilestonePatch) => Promise<void>;
}) {
  return (
    // spacing-exempt: 行自带分隔线；行自带内边距
    <Card testID={testID} rounded="xl" p={0} gap={0} overflow="hidden">
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 ? <Divider /> : null}
          <TimelineRow row={row} {...handlers} />
        </Fragment>
      ))}
    </Card>
  );
}

// 日程 tab（阶段 3，方向 A）：一句话、周条、已过期、今天、明天、之后。
export function AgendaTimeline({ timeline, onOpenTicket, onUpdateMilestone }: AgendaTimelineProps) {
  const now = new Date();
  const today = localDateKey(now);
  const [selectedDate, setSelectedDate] = useState(today);
  const week = buildWeek(today);
  const view = buildTimelineView(timeline, now, selectedDate);
  const handlers = { onOpenTicket, onUpdateMilestone };

  if (timeline === null) {
    return (
      <Column testID="agenda-timeline" px="section-label-x" py="banner-y">
        <Text size="secondary" tone="muted">正在读取日程</Text>
      </Column>
    );
  }

  return (
    <Column testID="agenda-timeline" w="100%" gap="page-section">
      <Card testID="agenda-note" tone="accent" rounded="xl" p="card">
        <Row gap="side-item" items="flex-start">
          {/* spacing-exempt: 光学对齐 */}
          <Box w={18} h={18} mt={1} rounded={5} bg="text" center>
            {/* spacing-exempt: 文字当图标用 */}
            <Text size="9.5" mono weight="bold" color="surface">π</Text>
          </Box>
          <Column flex={1} minW={0} gap="text-stack">
            <Text size="body">{view.note.text}</Text>
            {view.note.when ? <Text size="meta" tone="muted">{view.note.when}</Text> : null}
          </Column>
        </Row>
      </Card>
      <Row items="center" justify="space-between" gap="nav-item" p="card" borderWidth={1} borderColor="border-soft" rounded="xl" bg="surface">
        {week.map((day) => {
          const active = day.isoDate === selectedDate;
          const mark = view.days[day.isoDate];
          return (
            <Pressable
              key={day.isoDate}
              testID={`agenda-day-${day.isoDate}`}
              aria-selected={active}
              feedback="none"
              onPress={() => setSelectedDate(day.isoDate)}
              w={38}
              h={52}
              rounded="md"
              items="center"
              justify="center"
              gap="text-stack"
              bg={active ? 'accent' : 'transparent'}
            >
              <Text size="label" weight="bold" tone={active ? 'inverse' : 'muted'} align="center">{day.weekdayLabel}</Text>
              <Text size="card-title" weight="extrabold" tone={active ? 'inverse' : 'default'} align="center">{day.dateLabel}</Text>
              {mark ? <Dot color={active ? 'surface' : mark.alert ? 'danger' : 'accent'} size={5} /> : <Box w={5} h={5} />}
            </Pressable>
          );
        })}
      </Row>
      {view.overdue.length > 0 ? (
        <Column testID="agenda-overdue" gap="group-label">
          <Text size="eyebrow" weight="extrabold" color="danger-dark" px="section-label-x">{`已过期 ${view.overdue.length}`}</Text>
          <RowsCard rows={view.overdue} {...handlers} />
        </Column>
      ) : null}
      {view.sections.map((section) => (
        <Column key={section.key} testID={`agenda-section-${section.key}`} gap="group-label">
          <Row items="center" justify="space-between" px="section-label-x">
            <Text size="eyebrow" weight="extrabold">{section.label}</Text>
            {selectedDate !== today ? (
              <Pressable testID="agenda-back-to-today" onPress={() => setSelectedDate(today)} feedback="opacity">
                {/* spacing-exempt: 链接字号 */}
                <Text size="11" weight="bold" color="accent">回到今天</Text>
              </Pressable>
            ) : null}
          </Row>
          {section.rows.length > 0 ? (
            <RowsCard rows={section.rows} {...handlers} />
          ) : (
            <Card rounded="xl" p="card">
              <Text size="secondary" tone="faint" align="center">这天没有安排</Text>
            </Card>
          )}
        </Column>
      ))}
    </Column>
  );
}
