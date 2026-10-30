// 「经过」：这张工单发生过的事，一件一行（复核 P1-2）。#66 的生命周期有 56 行，
// Run #71 的失败在页面上出现 6 次，每次 Run 开始写 3 遍。经过只留你需要知道的事：
//   - 每次执行有没有交付，每次核查的结论。
//   - 你做的决定：授权托管、发起返工、派发核查、换执行 agent、验收、取消。
//   - 连续几次没做成的 Run 合成一行，写次数和原因，展开才看每一次。
// 不放进经过的事：
//   - 对话 Run。它们在工单对话里，失败也在那里（每件事只放一处）。
//   - 正在跑的 Run。决策卡和对话坞的实时进度说它。
//   - Run 开始、重试、系统内部的修复记录。原始记录在「证据与记录」的生命周期页签里。
import type { ActivityDto } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import { runFailureReason, type RunFacts } from './runFacts';
import { runtimeDisplayName } from '@/features/workspace/runtimeNames';

export type TicketStoryTone = 'success' | 'danger' | 'accent' | 'neutral';

export type TicketStoryRun = {
  runId: number;
  /** 「Run #44」 */
  title: string;
  /** 「模型满载」 */
  reason: string | null;
  at: string;
};

export type TicketStoryEntry = {
  key: string;
  tone: TicketStoryTone;
  /** 「Run #42 交付」「5 次执行没有交付」「你授权 Lead 托管，发起返工」 */
  title: string;
  /** 一句说明：核查报告的要点、失败的原因。 */
  detail: string | null;
  /** 这件事的时间。几次 Run 合成一行时，是第一次结束的时间。 */
  at: string;
  /** 几次 Run 合成一行时，最后一次结束的时间。其他时候是 null。 */
  until: string | null;
  /** 合成一行的那几次 Run。 */
  runs: TicketStoryRun[];
};

export type TicketStoryInput = {
  /** 工单详情读到以后才有。 */
  created?: { at: string; by: ActivityDto['actor'] | null } | null;
  attempts: readonly Pick<AttemptEntity, 'id' | 'state' | 'runtime' | 'model' | 'startedAt' | 'endedAt'>[];
  activities: readonly Pick<ActivityDto, 'id' | 'actor' | 'kind' | 'attemptId' | 'payload' | 'createdAt'>[];
  facts: ReadonlyMap<number, RunFacts>;
  /** Lead 的名字（useLeadName）。 */
  leadName: string;
};

type StoryLine = { kind: 'line'; entry: TicketStoryEntry; userAction: boolean; order: number };
type StoryFailure = { kind: 'failure'; purpose: 'execution' | 'review'; run: TicketStoryRun; order: number };
type StoryEvent = StoryLine | StoryFailure;

function userDecisions(leadName: string): Record<string, string> {
  return {
    delegation_preflight_accepted: `你授权 ${leadName} 托管`,
    rework_dispatch_requested: '你发起返工',
    review_requested_by_user: '你派发了独立核查',
  };
}

export function buildTicketStory(input: TicketStoryInput): TicketStoryEntry[] {
  const events: StoryEvent[] = [];
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  for (const attempt of input.attempts) {
    const facts = input.facts.get(attempt.id);
    if (!facts || (facts.purpose !== 'execution' && facts.purpose !== 'review')) continue;
    if (attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused') continue;
    const at = attempt.endedAt ?? attempt.startedAt;
    const order = attempt.id;
    if (facts.purpose === 'execution' && facts.delivered) {
      events.push(line({ key: `run:${attempt.id}`, tone: 'success', title: `Run #${attempt.id} 交付`, at }, order));
    } else if (facts.purpose === 'review' && facts.verdict !== null) {
      const pass = facts.verdict === 'pass';
      events.push(line({
        key: `run:${attempt.id}`,
        tone: pass ? 'success' : 'danger',
        title: `Run #${attempt.id} 核查${pass ? '通过' : '不通过'}`,
        detail: reviewReportOf(input.activities, attempt.id),
        at,
      }, order));
    } else {
      events.push({
        kind: 'failure',
        purpose: facts.purpose,
        run: { runId: attempt.id, title: `Run #${attempt.id}`, reason: runFailureReason(attempt, facts), at },
        order,
      });
    }
  }
  for (const activity of input.activities) {
    const title = activityTitle(activity, attemptsById, input.leadName);
    if (!title) continue;
    events.push(line({
      key: `activity:${activity.id}`,
      tone: title.tone,
      title: title.text,
      at: activity.createdAt,
    }, activity.id, activity.actor === 'user'));
  }
  events.sort((left, right) => eventTime(left).localeCompare(eventTime(right)) || left.order - right.order);
  const entries = mergeUserActions(groupFailures(events));
  if (!input.created) return entries;
  // 创建总是第一件事。记录里的创建时间晚于别的事时（导入或种子数据），也不把它排到后面。
  const who = input.created.by === 'user' ? '你' : input.created.by === 'lead' ? `${input.leadName} ` : '';
  return [
    { key: 'created', tone: 'neutral', title: `${who}创建了工单`, detail: null, at: input.created.at, until: null, runs: [] },
    ...entries,
  ];
}

function line(
  entry: Pick<TicketStoryEntry, 'key' | 'tone' | 'title' | 'at'> & { detail?: string | null },
  order: number,
  userAction = false,
): StoryLine {
  return { kind: 'line', entry: { detail: null, until: null, runs: [], ...entry }, userAction, order };
}

function eventTime(event: StoryEvent): string {
  return event.kind === 'line' ? event.entry.at : event.run.at;
}

function activityTitle(
  activity: TicketStoryInput['activities'][number],
  attempts: ReadonlyMap<number, TicketStoryInput['attempts'][number]>,
  leadName: string,
): { text: string; tone: TicketStoryTone } | null {
  const payload = activity.payload;
  if (activity.kind === 'transition') {
    const to = payload.to;
    const user = activity.actor === 'user';
    if (to === 'done') return { text: user ? '你验收通过' : '工单完成', tone: 'success' };
    if (to === 'cancelled') return { text: user ? '你取消了工单' : '工单已取消', tone: 'neutral' };
    return null;
  }
  if (activity.kind !== 'decision' || activity.actor !== 'user' || typeof payload.decision !== 'string') return null;
  if (payload.decision === 'ticket_runtime_switched') {
    // 为了换执行 agent 停下的那次 Run，失败原因已经写了「你换成 …」，这里不再单独写一行。
    const previous = typeof payload.previousRunId === 'number' ? attempts.get(payload.previousRunId) : undefined;
    if (previous?.state === 'stopped') return null;
    const to = runtimeDisplayName(typeof payload.toRuntime === 'string' ? payload.toRuntime : null);
    return to ? { text: `你把执行 agent 换成 ${to}`, tone: 'accent' } : null;
  }
  const text = userDecisions(leadName)[payload.decision];
  return text ? { text, tone: 'accent' } : null;
}

// 连着的几次同一用途、都没做成的 Run 合成一行。中间夹着别的事（交付、核查结论、你的决定）就断开。
function groupFailures(events: StoryEvent[]): StoryLine[] {
  const lines: StoryLine[] = [];
  let pending: StoryFailure[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const [first] = pending;
    const last = pending[pending.length - 1]!;
    const noun = first!.purpose === 'review' ? '核查' : '执行';
    const missed = first!.purpose === 'review' ? '没有完成' : '没有交付';
    if (pending.length === 1) {
      lines.push(line({
        key: `run:${first!.run.runId}`,
        tone: 'danger',
        title: first!.purpose === 'review' ? `核查 Run #${first!.run.runId} ${missed}` : `Run #${first!.run.runId} ${missed}`,
        detail: first!.run.reason,
        at: first!.run.at,
      }, first!.order));
    } else {
      lines.push({
        kind: 'line',
        entry: {
          key: `runs:${first!.run.runId}-${last.run.runId}`,
          tone: 'danger',
          title: `${pending.length} 次${noun}${missed}`,
          detail: reasonSummary(pending.map((failure) => failure.run.reason)),
          at: first!.run.at,
          until: last.run.at,
          runs: pending.map((failure) => failure.run),
        },
        userAction: false,
        order: first!.order,
      });
    }
    pending = [];
  };
  for (const event of events) {
    if (event.kind === 'failure') {
      if (pending.length > 0 && pending[0]!.purpose !== event.purpose) flush();
      pending.push(event);
      continue;
    }
    flush();
    lines.push(event);
  }
  flush();
  return lines;
}

// 同一秒里你做的几件事是一次操作（授权托管时同时发起返工）：合成一行。
function mergeUserActions(lines: StoryLine[]): TicketStoryEntry[] {
  const entries: TicketStoryEntry[] = [];
  let previous: StoryLine | null = null;
  for (const current of lines) {
    const last = entries[entries.length - 1];
    if (previous?.userAction && current.userAction && last && sameSecond(previous.entry.at, current.entry.at)) {
      last.title = `${last.title}，${current.entry.title.replace(/^你/, '')}`;
    } else {
      entries.push({ ...current.entry });
    }
    previous = current;
  }
  return entries;
}

function sameSecond(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.floor(a / 1000) === Math.floor(b / 1000);
}

/** 「模型满载、你换成 Claude Code、认证失败 ×2、交接失败」：按第一次出现的顺序，重复的写次数。 */
function reasonSummary(reasons: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts].map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason)).join('、');
}

// 核查报告的要点：去掉「独立核查 FAIL。关键证据：」这类开头和代码标记，留下证据。
function reviewReportOf(activities: TicketStoryInput['activities'], reviewerRunId: number): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const payload = activities[index]!.payload;
    if (activities[index]!.kind !== 'decision' || payload.reviewerRunId !== reviewerRunId) continue;
    if (typeof payload.reviewerReport !== 'string') continue;
    const text = payload.reviewerReport
      .replace(/^\s*独立核查\s*(?:PASS|FAIL)\s*[。.:：]?\s*/i, '')
      .replace(/^关键证据\s*[:：]\s*/, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  }
  return null;
}
