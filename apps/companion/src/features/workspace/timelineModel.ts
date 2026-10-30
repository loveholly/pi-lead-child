// 日程 tab（左栏改版阶段 3，方向 A）的视图模型。日程回答「什么时候会发生什么」：
// 顶部一句话（Lead 今天写的；没有时是同样内容的事实文案），周条，然后「已过期」「今天」「明天」「之后」。
// 节点带类型标签（截止 / 提测 / 发布 / 核查 / 自定义）和出处（「Lead 记下」「你定的」）；风险由服务端算（TimelineEntry.risk）。
import type { TimelineEntry, TimelineResponse } from '@pi-lead-child/protocol';

import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { leadNameNow } from '@/state/leadName';

import { waitedText } from './inboxModel';
import { localDateKey } from './model';

export type TimelineTagTone = 'danger' | 'warning' | 'success' | 'accent' | 'neutral';

export type TimelineRowView = {
  id: string;
  /** 「16:30」「全天」；过期区写日期「10/13」。 */
  time: string;
  tag: { label: string; tone: TimelineTagTone };
  /** 「#72 修复 review 状态投影」；提醒和例行没有编号。 */
  title: string;
  /** 出处或状态：「Lead 记下」「已触发，未确认」「已执行 · 生成 #85」。 */
  sub: string | null;
  risk: string | null;
  muted: boolean;
  ticketId: number | null;
  // 点这一行能不能打开工单详情。提醒不是工单：它在日程里就是全部，点了不打开工单详情（发布评审 3688968）。
  opensTicket: boolean;
  milestoneId: number | null;
  editable: boolean;
  at: string;
  allDay: boolean;
};

export type TimelineSection = { key: string; label: string; rows: TimelineRowView[] };

export type TimelineDayMark = { count: number; alert: boolean };

export type TimelineView = {
  note: { text: string; when: string | null; byLead: boolean };
  overdue: TimelineRowView[];
  /** 选中今天时是「今天」「明天」和之后有事的每一天；选中别的日子时只有那一天。 */
  sections: TimelineSection[];
  /** 周条上每天的点：有几件事，有没有过期或风险。键是本地日期 YYYY-MM-DD。 */
  days: Record<string, TimelineDayMark>;
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const MILESTONE_TONE: Record<string, TimelineTagTone> = {
  due: 'danger',
  test_handoff: 'warning',
  release: 'success',
  review: 'accent',
  custom: 'neutral',
};

// lead 记下的写 Lead 的名字。这里离组件太远，读最近一次取到的名字（leadNameNow）。
function provenanceLabel(actor: string): string | undefined {
  if (actor === 'lead') return `${leadNameNow()} 记下`;
  return ({ child: 'child 汇报', user: '你定的', system: '原来的截止' } as Record<string, string>)[actor];
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function shortDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 「今天」「明天」「周日」（一周内）或「10/20」。 */
export function dayWord(at: string, now: Date): string {
  const date = new Date(at);
  const key = localDateKey(date);
  if (key === localDateKey(now)) return '今天';
  if (key === localDateKey(addDays(now, 1))) return '明天';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
  if (days > 1 && days < 7) return `周${WEEKDAYS[date.getDay()]}`;
  return shortDate(date);
}

function tag(entry: TimelineEntry): TimelineRowView['tag'] {
  if (entry.kind === 'milestone' && entry.milestone) {
    return { label: entry.milestone.label, tone: MILESTONE_TONE[entry.milestone.kind] ?? 'neutral' };
  }
  if (entry.kind === 'reminder') return { label: '提醒', tone: 'accent' };
  if (entry.kind === 'deferred_start') return { label: '开始', tone: 'neutral' };
  return { label: '例行', tone: entry.status === 'failed' ? 'danger' : 'success' };
}

function sub(entry: TimelineEntry, now: Date, inOverdue: boolean): string | null {
  if (entry.kind === 'milestone') {
    const provenance = entry.provenance ? provenanceLabel(entry.provenance.actor) ?? null : null;
    if (entry.milestone?.state === 'done') return '已完成';
    if (entry.status === 'done') return '工单已结束';
    if (entry.status === 'failed') return '没赶上';
    if (inOverdue || entry.status === 'overdue') {
      return [`过期 ${waitedText(entry.at, now)}`, provenance].filter(Boolean).join(' · ');
    }
    return provenance;
  }
  if (entry.kind === 'reminder') {
    return entry.status === 'unacked' ? '已触发，未确认' : entry.status === 'done' ? '已确认' : null;
  }
  if (entry.kind === 'deferred_start') return '计划开始';
  return entry.detail ?? null;
}

function row(entry: TimelineEntry, now: Date, inOverdue = false): TimelineRowView {
  const date = new Date(entry.at);
  const numbered = entry.ticketId !== null && (entry.kind === 'milestone' || entry.kind === 'deferred_start');
  return {
    id: entry.id,
    time: inOverdue ? shortDate(date) : entry.allDay ? '全天' : clockTimeLabel(entry.at),
    tag: tag(entry),
    title: numbered ? `#${entry.ticketId} ${entry.title}` : entry.title,
    sub: sub(entry, now, inOverdue),
    risk: entry.risk?.label ?? null,
    muted: entry.status === 'done',
    ticketId: entry.ticketId,
    opensTicket: entry.ticketId !== null && entry.kind !== 'reminder',
    milestoneId: entry.milestone?.id ?? null,
    editable: entry.editable,
    at: entry.at,
    allDay: entry.allDay,
  };
}

// 明天以后：有事的每一天一节（「周二 · 10/20」），行里只写时刻。例行任务每个只列一次（第一次），写明之后还有几次：
// 工作日的例行任务不该把节点挤下去。
function laterSections(entries: readonly TimelineEntry[], now: Date): TimelineSection[] {
  const sections = new Map<string, TimelineSection>();
  for (const view of laterRows(entries, now)) {
    const date = new Date(view.at);
    const key = localDateKey(date);
    let section = sections.get(key);
    if (!section) {
      section = { key, label: `周${WEEKDAYS[date.getDay()]} · ${shortDate(date)}`, rows: [] };
      sections.set(key, section);
    }
    section.rows.push(view);
  }
  return [...sections.values()];
}

function laterRows(entries: readonly TimelineEntry[], now: Date): TimelineRowView[] {
  const routineCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'routine') routineCounts.set(routineKey(entry), (routineCounts.get(routineKey(entry)) ?? 0) + 1);
  }
  const shown = new Set<string>();
  const rows: TimelineRowView[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'routine') {
      rows.push(row(entry, now));
      continue;
    }
    const key = routineKey(entry);
    if (shown.has(key)) continue;
    shown.add(key);
    const more = (routineCounts.get(key) ?? 1) - 1;
    const view = row(entry, now);
    rows.push(more > 0 ? { ...view, sub: [view.sub, `之后还有 ${more} 次`].filter(Boolean).join(' · ') } : view);
  }
  return rows;
}

// "routine:<trigger id>:<时间>" → trigger id。
function routineKey(entry: TimelineEntry): string {
  return entry.id.split(':')[1] ?? entry.id;
}

function sectionLabel(date: Date, prefix?: string): string {
  const day = `周${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
  return prefix ? `${prefix} · ${day}` : `${day}日`;
}

// 没有 Lead 今天写的一句话时，用同样的事实写一句：还剩几件、最近的是哪件、哪个日期有风险、过期几件。
function factNote(entries: readonly TimelineEntry[], overdue: readonly TimelineEntry[], now: Date): string {
  const today = localDateKey(now);
  const nowIso = now.toISOString();
  const remaining = entries.filter((entry) => localDateKey(new Date(entry.at)) === today
    && entry.at >= nowIso && entry.status === 'upcoming');
  const parts: string[] = [];
  const first = remaining[0];
  parts.push(first
    ? `今天还剩 ${remaining.length} 件：${clockTimeLabel(first.at)} ${first.kind === 'milestone' ? `#${first.ticketId} ` : ''}${first.title}。`
    : '今天没有剩下的安排。');
  const risky = entries.find((entry) => entry.risk !== null && entry.status === 'upcoming');
  if (risky?.risk && risky.milestone) {
    parts.push(`${dayWord(risky.at, now)} ${clockTimeLabel(risky.at)} #${risky.ticketId} ${risky.milestone.label}，但${risky.risk.label}。`);
  }
  if (overdue.length > 0) parts.push(`另有 ${overdue.length} 件已过期。`);
  return parts.join('');
}

export function buildTimelineView(
  timeline: TimelineResponse | null,
  now: Date,
  selectedDate: string = localDateKey(now),
): TimelineView {
  const entries = timeline?.entries ?? [];
  const overdueEntries = timeline?.overdue ?? [];
  const today = localDateKey(now);
  const tomorrow = localDateKey(addDays(now, 1));
  const days: Record<string, TimelineDayMark> = {};
  for (const entry of entries) {
    const key = localDateKey(new Date(entry.at));
    const mark = days[key] ?? { count: 0, alert: false };
    mark.count += 1;
    mark.alert ||= entry.status === 'overdue' || entry.status === 'failed' || entry.risk !== null;
    days[key] = mark;
  }

  const rowsOn = (date: string) => entries.filter((entry) => localDateKey(new Date(entry.at)) === date).map((entry) => row(entry, now));
  const sections: TimelineSection[] = selectedDate === today
    ? [
        { key: 'today', label: sectionLabel(now, '今天'), rows: rowsOn(today) },
        { key: 'tomorrow', label: sectionLabel(addDays(now, 1), '明天'), rows: rowsOn(tomorrow) },
        ...laterSections(entries.filter((entry) => localDateKey(new Date(entry.at)) > tomorrow), now),
      ].filter((section) => section.key === 'today' || section.rows.length > 0)
    : [{ key: selectedDate, label: sectionLabel(new Date(`${selectedDate}T00:00:00`)), rows: rowsOn(selectedDate) }];

  const leadNote = timeline?.leadNote ?? null;
  const note = leadNote && localDateKey(new Date(leadNote.at)) === today
    ? { text: leadNote.text, when: `${clockTimeLabel(leadNote.at)} 更新`, byLead: true }
    : { text: factNote(entries, overdueEntries, now), when: null, byLead: false };

  return {
    note,
    overdue: overdueEntries.map((entry) => row(entry, now, true)),
    sections,
    days,
  };
}

/**
 * 改日期的输入框：「10/17 18:00」「2026-10-17 18:00」，只写日期时保留原来的时刻。
 * 返回 ISO 时间；看不懂时返回 null。按本地时区理解。
 */
export function parseMilestoneInput(text: string, current: string, now: Date): string | null {
  const match = text.trim().match(/^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const base = new Date(current);
  const date = new Date(
    year ? Number(year) : now.getFullYear(),
    Number(month) - 1,
    Number(day),
    hour !== undefined ? Number(hour) : base.getHours(),
    minute !== undefined ? Number(minute) : base.getMinutes(),
  );
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return null;
  return date.toISOString();
}

/** 输入框里的初始值：「10/17 18:00」。 */
export function milestoneInputValue(at: string): string {
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${clockTimeLabel(at)}`;
}

/** 工单行、收件箱卡和项目卡上的节点标签：「提测 明天 18:00」「截止 周日」「发布 10/20」。 */
export function milestoneChip(
  milestone: { label: string; at: string; allDay?: boolean },
  now: Date = new Date(),
): { text: string; overdue: boolean } {
  const overdue = new Date(milestone.at).getTime() < now.getTime();
  if (overdue) return { text: `${milestone.label}已过 ${waitedText(milestone.at, now)}`, overdue };
  const word = dayWord(milestone.at, now);
  const withTime = (word === '今天' || word === '明天') && !milestone.allDay;
  return { text: `${milestone.label} ${word}${withTime ? ` ${clockTimeLabel(milestone.at)}` : ''}`, overdue };
}
