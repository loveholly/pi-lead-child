// 项目卡片（左栏改版阶段 2，方向 A）的视图模型。项目 tab 回答「每个项目现在怎么样」：
// 分布用工单 tab 的同一组词（ticketTurn），Lead 写的一句话带更新时间，最近的截止，累计花费。
// 有未结束工单的项目在「在推进」，等你的排最前；没有未结束工单的项目收进「安静的项目」，归档的收进「已归档」。
import type { ProjectOverview } from '@pi-lead-child/protocol';

import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { leadNameNow } from '@/state/leadName';

import { waitedText } from './inboxModel';
import { projectDisplayName, UNASSIGNED_PROJECT } from './model';
import { milestoneChip } from './timelineModel';

export type ProjectCountKey = keyof ProjectOverview['counts'];

export type ProjectLegendEntry = { key: ProjectCountKey; label: string; count: number };

export type ProjectCardView = {
  id: string;
  /** 服务端的项目名：点卡片时按它筛工单。 */
  projectName: string;
  /** 界面上的名字：没有项目的工单叫「未归属」。 */
  name: string;
  /** 分布和图例，只列不为 0 的。 */
  legend: ProjectLegendEntry[];
  leadLine: { text: string; when: string } | null;
  /** 最近的节点：「#72 提测 明天 18:00」。 */
  nextMilestone: string | null;
  nextMilestoneOverdue: boolean;
  spend: string | null;
  /** 有未结束的工单、一周以上没有动静时写「27 天没有动静」。 */
  stale: string | null;
  /** 收起的行上的一句话：「1 已结束」。 */
  caption: string;
  canArchive: boolean;
};

export type ProjectCards = {
  active: ProjectCardView[];
  quiet: ProjectCardView[];
  archived: ProjectCardView[];
};

// lead 那一格写 Lead 的名字。这里离组件太远，读最近一次取到的名字（leadNameNow）。
function countLabel(key: ProjectCountKey): string {
  if (key === 'lead') return leadNameNow();
  return { user: '等你', running: '在执行', queued: '排队', ended: '已结束' }[key];
}
const COUNT_ORDER: ProjectCountKey[] = ['user', 'running', 'lead', 'queued', 'ended'];

const DAY = 24 * 60 * 60_000;
// 有未结束的工单、这么久没有动静，卡片上就提一句。
const STALE_AFTER = 7 * DAY;

function openCount(project: ProjectOverview): number {
  const { user, running, lead, queued } = project.counts;
  return user + running + lead + queued;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** 卡片上的日期：今天的写时分，其余写「10/16」。 */
function shortDate(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (sameLocalDay(date, now)) return clockTimeLabel(value);
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}/${day}`;
}

function card(project: ProjectOverview, now: Date): ProjectCardView {
  const legend = COUNT_ORDER
    .filter((key) => project.counts[key] > 0)
    .map((key) => ({ key, label: countLabel(key), count: project.counts[key] }));
  const open = openCount(project);
  const lastActivity = project.lastActivityAt ? new Date(project.lastActivityAt).getTime() : NaN;
  const stale = open > 0 && Number.isFinite(lastActivity) && now.getTime() - lastActivity >= STALE_AFTER
    ? `${waitedText(project.lastActivityAt!, now)}没有动静`
    : null;
  const next = project.nextMilestone ? milestoneChip(project.nextMilestone, now) : null;
  return {
    id: project.id,
    projectName: project.name,
    name: projectDisplayName(project.name),
    legend,
    leadLine: project.leadStatus
      ? { text: project.leadStatus.text, when: `${shortDate(project.leadStatus.at, now)} 更新` }
      : null,
    nextMilestone: next ? `#${project.nextMilestone!.ticketId} ${next.text}` : null,
    nextMilestoneOverdue: next?.overdue ?? false,
    spend: project.spend.costUsd > 0 ? `$${project.spend.costUsd.toFixed(2)}` : null,
    stale,
    caption: legend.length > 0 ? legend.map((entry) => `${entry.count} ${entry.label}`).join(' · ') : '没有工单',
    canArchive: project.id !== UNASSIGNED_PROJECT && project.status === 'active' && open === 0,
  };
}

// 最近有动静的在前，没有记录的在后。
function byRecentActivity(left: ProjectOverview, right: ProjectOverview): number {
  return (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? '') || left.name.localeCompare(right.name);
}

export function buildProjectCards(overviews: readonly ProjectOverview[], now: Date = new Date()): ProjectCards {
  const live = overviews.filter((project) => project.status === 'active');
  const active = live
    .filter((project) => openCount(project) > 0)
    .sort((left, right) => Number(right.counts.user > 0) - Number(left.counts.user > 0) || byRecentActivity(left, right));
  // 未归属不是一个真的项目，放在安静的项目最后。
  const quiet = live
    .filter((project) => openCount(project) === 0)
    .sort((left, right) => Number(left.id === UNASSIGNED_PROJECT) - Number(right.id === UNASSIGNED_PROJECT)
      || byRecentActivity(left, right));
  const archived = overviews
    .filter((project) => project.status === 'archived')
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    active: active.map((project) => card(project, now)),
    quiet: quiet.map((project) => card(project, now)),
    archived: archived.map((project) => card(project, now)),
  };
}
