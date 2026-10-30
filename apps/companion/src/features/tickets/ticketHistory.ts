import type { ActivityDto, TicketDetail, TicketRelation, TicketSummary } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import { decisionLabel } from './decisionLabels';
import { timeLabel } from './timeLabels';
import { runOutcome, type RunFacts, type RunOutcomeTone } from './runFacts';

export type LifecyclePresentation = {
  id: string;
  title: string;
  createdAt: string;
  actor: string;
  reason: string | null;
  sourceTicketId: number;
  attemptId: number | null;
};

export type AttemptPresentation = {
  id: number;
  runtime: string;
  model: string;
  /** 这次 Run 记下的模型。没记下时是 null（model 那时写「未记录 model」）。 */
  recordedModel: string | null;
  effort: string | null;
  /** runtime、模型和 effort 合成的一行，例如「codex · gpt-6.1-sol · effort high」。 */
  choice: string;
  /** 这次 Run 是做什么的：执行、核查、对话（runFacts）。 */
  purposeLabel: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** 按用途写的结果：核查写结论，对话写有没有回答，执行写有没有交付。 */
  result: string;
  resultTone: RunOutcomeTone;
  failurePreview: string | null;
  failureFull: string | null;
  failureTruncated: boolean;
};

// Workbench snapshots may lag behind the attempts collection. Prefer the newest
// live attempt, then the newest known attempt, and only use the workbench hint
// while the execution collection is still empty.
export function selectDisplayedAttemptId(
  attempts: readonly Pick<AttemptEntity, 'id' | 'state'>[],
  workbenchActiveAttemptId: number | null,
): number | null {
  const live = attempts
    .filter((attempt) => attempt.state === 'starting' || attempt.state === 'running')
    .reduce<number | null>((latest, attempt) => latest === null || attempt.id > latest ? attempt.id : latest, null);
  if (live !== null) return live;
  const latest = attempts.reduce<number | null>(
    (current, attempt) => current === null || attempt.id > current ? attempt.id : current,
    null,
  );
  return latest ?? workbenchActiveAttemptId;
}

export type RelationPresentation = TicketRelation & {
  title: string | null;
  relatedStage: TicketSummary['stage'] | null;
  label: string;
  group: 'family' | 'dependency' | 'implementation' | 'replacement' | 'duplicate' | 'related';
  groupLabel: string;
  stateLabel: string;
  meta: string;
  detail: string | null;
};

// leadName 是 Lead 的名字（useLeadName）。
function actorLabel(actor: ActivityDto['actor'], leadName: string): string {
  return actor === 'lead' ? leadName : { user: '用户', child: '执行 Agent', system: '系统' }[actor];
}

const transitionLabels: Record<string, string> = {
  draft: '待确认', ready: '已确认 / 就绪', active: '开始执行', blocked: '进入阻塞',
  cancelled: '已取消', review: '进入 Review', done: '已完成',
  scheduled: '已排期', fired: '已触发', acked: '已确认',
};

export function buildLifecyclePresentation(input: {
  ticketId: number;
  detail?: TicketDetail;
  activities: ActivityDto[];
  leadName: string;
}): LifecyclePresentation[] {
  const { leadName } = input;
  const items: LifecyclePresentation[] = [];
  if (input.detail) {
    items.push({
      id: `ticket:${input.ticketId}:created`,
      title: '创建工单',
      createdAt: input.detail.createdAt,
      actor: input.detail.createdBy ? actorLabel(input.detail.createdBy, leadName) : '未记录',
      reason: null,
      sourceTicketId: input.ticketId,
      attemptId: null,
    });
  }
  for (const activity of input.activities) {
    if (activity.kind === 'transition') {
      const from = text(activity.payload.from);
      const to = text(activity.payload.to);
      const label = to ? transitionLabels[to] ?? `状态变为 ${to}` : '状态变更';
      items.push({
        id: `activity:${activity.id}`,
        title: from && to ? `${label}（${from} → ${to}）` : label,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName),
        reason: text(activity.payload.reason) ?? '未记录原因',
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'decision') {
      const label = decisionLabel(text(activity.payload.decision), leadName, activity.payload);
      const reason = decisionReason(activity.payload) ?? text(activity.payload.summary);
      items.push({
        id: `activity:${activity.id}`,
        title: label.title,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName),
        // 没收录的机器 id 不当标题，留在说明里方便排查。
        reason: [reason, label.unknownId ? `记录类型 ${label.unknownId}` : null].filter(Boolean).join(' · ') || null,
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'attempt_start') {
      const runtime = text(activity.payload.runtime);
      const model = text(activity.payload.model);
      const effort = text(activity.payload.effort);
      items.push({
        id: `activity:${activity.id}`,
        title: activity.attemptId === null ? 'Run 开始启动' : `Run #${activity.attemptId} 开始启动`,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName),
        reason: [runtime, model, effort ? `effort ${effort}` : null].filter(Boolean).join(' · ') || null,
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'crash') {
      items.push({
        id: `activity:${activity.id}`,
        title: activity.attemptId === null ? 'Run 失败' : `Run #${activity.attemptId} 失败`,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName),
        reason: decisionReason(activity.payload),
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'notification') {
      items.push({
        id: `activity:${activity.id}`,
        title: text(activity.payload.title) ?? '系统阻塞',
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName),
        reason: text(activity.payload.summary) ?? decisionReason(activity.payload),
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    }
  }
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
}

export function buildAttemptPresentation(
  attempts: AttemptEntity[],
  facts: ReadonlyMap<number, RunFacts> = new Map(),
): AttemptPresentation[] {
  return [...attempts].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id - right.id)
    .map((attempt) => {
      const failure = attempt.errorMessage ?? attempt.errorCode;
      const preview = failure ? truncateText(failure, 240) : null;
      const outcome = runOutcome(attempt, facts.get(attempt.id));
      const runtime = attempt.runtime ?? '未知 runtime';
      const model = attempt.model ?? '未记录 model';
      return {
        id: attempt.id,
        runtime,
        model,
        recordedModel: attempt.model ?? null,
        effort: attempt.effort,
        choice: [runtime, model, attempt.effort ? `effort ${attempt.effort}` : null].filter(Boolean).join(' · '),
        purposeLabel: outcome.purposeLabel,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        durationMs: duration(attempt.startedAt, attempt.endedAt),
        result: outcome.result,
        resultTone: outcome.tone,
        failurePreview: preview,
        failureFull: failure ?? null,
        failureTruncated: failure !== null && preview !== failure,
      };
    });
}

export function buildRelationPresentation(
  detail: TicketDetail | undefined,
  tickets: TicketSummary[],
  leadName: string,
): RelationPresentation[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return (detail?.relations ?? []).map((relation) => {
    const related = byId.get(relation.ticketId);
    return ({
    ...relation,
    title: related?.title ?? null,
    relatedStage: related?.stage ?? null,
    label: relationLabel(relation.kind),
    group: relationGroup(relation.kind),
    groupLabel: relationGroupLabel(relation.kind),
    stateLabel: relation.active === false ? '已撤销' : '有效',
    meta: relationMeta(relation, leadName),
    detail: relationDetail(relation, related?.stage ?? null),
  });
  }).sort((left, right) => relationGroupOrder(left.group) - relationGroupOrder(right.group)
    || Number(left.active === false) - Number(right.active === false)
    || (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
    || left.ticketId - right.ticketId);
}

export function truncateText(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}

function decisionReason(payload: Record<string, unknown>): string | null {
  const direct = text(payload.reason) ?? text(payload.message) ?? text(payload.text);
  if (direct) return direct;
  const mode = text(payload.mode);
  const restored = integerList(payload.restoredItemIds);
  const retained = integerList(payload.retainedCancelledIds);
  const parts = [
    mode ? `模式：${mode}` : null,
    restored.length > 0 ? `恢复：${restored.map((id) => `#${id}`).join('、')}` : null,
    retained.length > 0 ? `保留取消：${retained.map((id) => `#${id}`).join('、')}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join('；') || null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function integerList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
}

function duration(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const value = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function relationLabel(kind: TicketRelation['kind']): string {
  return {
    parent_of: '父工单',
    child_of: '子工单',
    depends_on: '依赖',
    blocks: '阻塞',
    implements: '实施',
    implemented_by: '实施任务',
    supersedes: '替代',
    superseded_by: '被替代',
    duplicates: '重复于',
    duplicated_by: '被标为 canonical',
    relates_to: '相关事项',
  }[kind];
}

function relationGroup(kind: TicketRelation['kind']): RelationPresentation['group'] {
  if (kind === 'parent_of' || kind === 'child_of') return 'family';
  if (kind === 'depends_on' || kind === 'blocks') return 'dependency';
  if (kind === 'implements' || kind === 'implemented_by') return 'implementation';
  if (kind === 'supersedes' || kind === 'superseded_by') return 'replacement';
  if (kind === 'duplicates' || kind === 'duplicated_by') return 'duplicate';
  return 'related';
}

function relationGroupLabel(kind: TicketRelation['kind']): string {
  return {
    family: '父子',
    dependency: '依赖 / 阻塞',
    implementation: '实施',
    replacement: '替代',
    duplicate: '重复',
    related: '相关事项',
  }[relationGroup(kind)];
}

function relationGroupOrder(group: RelationPresentation['group']): number {
  return {
    family: 0,
    dependency: 1,
    implementation: 2,
    replacement: 3,
    duplicate: 4,
    related: 5,
  }[group];
}

function relationMeta(relation: TicketRelation, leadName: string): string {
  const source = relation.source === 'tree' ? '任务树' : '关系账本';
  const actor = relation.createdBy ? actorLabel(relation.createdBy, leadName) : source;
  const created = relation.createdAt ? timeLabel(relation.createdAt) : '既有结构';
  const revoked = relation.revokedAt ? ` · 撤销 ${timeLabel(relation.revokedAt)}` : '';
  return `${source} · ${actor} · ${created}${revoked}`;
}

function relationDetail(relation: TicketRelation, relatedStage: TicketSummary['stage'] | null): string | null {
  const gate = relation.executionGate === 'target_done'
    ? relation.kind === 'implements'
      ? relatedStage === 'done'
        ? `闸门已满足：#${relation.ticketId} 已完成，当前工单可启动`
        : `等待 #${relation.ticketId} 验收完成后启动`
      : relation.kind === 'implemented_by'
        ? relatedStage === 'done'
          ? `#${relation.ticketId} 已完成`
          : `#${relation.ticketId} 将在当前工单验收完成后启动`
        : null
    : null;
  const parts = [
    gate,
    relation.reason ? `原因：${relation.reason}` : null,
    relation.revokeReason ? `撤销原因：${relation.revokeReason}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join('；') || null;
}
