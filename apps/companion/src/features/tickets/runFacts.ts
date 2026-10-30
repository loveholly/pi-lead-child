// 一次 Run 的事实：它是做什么的、结果是什么。执行尝试、运行日志和进展记录说到同一个 Run 时都读这里，
// 不再各自从进程状态推导（工单 #66：核查 Run #43 的结论是不通过、Run #48 没有交接，两处都写成「成功」；
// 对话 Run #50、#51、#71 被写成「执行」，#71 的崩溃还被标成「当时阻塞」，而工单一直在 review）。
//
// 进程退出码只说明进程怎么结束，不说明这次 Run 做成了什么。结论来自活动流：
//   - 交付：一条以这次 Run 为来源、进入 review 的状态变更。
//   - 交接失败：一条以这次 Run 为来源、因为没有终态交接而进入 blocked 的状态变更，或者「运行结束，交接失败」的通知。
//   - 核查结论：带 reviewerRunId 和 verdict 的决策活动；工单还在 review 时也可以来自 reviewState。
//   - 让工单阻塞：一条以这次 Run 为来源、进入 blocked 的状态变更。
//   - 失败原因：服务端分类的 runtime_failure_classified 决策；更早的记录没有分类，按崩溃原文推断。
//   - 你停下了它：「停止执行」决策；为了换执行 agent 停下时，还有一条 ticket_runtime_switched。
import type { ActivityDto, KernelRuntimeId, TicketReviewState } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import { runtimeDisplayName } from '@/features/workspace/runtimeNames';

export type RunPurpose = 'execution' | 'review' | 'conversation' | 'integration' | 'learning';
export type RunVerdict = 'pass' | 'fail';

/** 失败的类别，和 packages/runtime 的 RuntimeFailureCategory 一致。 */
export type RunFailureCategory =
  | 'model_capacity'
  | 'provider_unavailable'
  | 'run_interrupted'
  | 'session_expired'
  | 'authentication'
  | 'account_quota'
  | 'usage_limit'
  | 'model_unsupported'
  | 'runtime_unavailable'
  | 'runtime_configuration'
  | 'host_defect'
  | 'task_failure';

export type RunFacts = {
  id: number;
  purpose: RunPurpose;
  /** 核查 Run 的结论。不是核查、或者没有结论时是 null。 */
  verdict: RunVerdict | null;
  /** 这次 Run 把工单推进了 review。 */
  delivered: boolean;
  /** 这次 Run 结束了，但没有完成终态交接。 */
  handoffFailed: boolean;
  /** 这次 Run 让工单进入了 blocked。没有这条记录的失败不改变工单状态（例如对话 Run 的崩溃）。 */
  blockedTicket: boolean;
  /** 失败的类别。没有失败、或者原因认不出来时是 null。 */
  failure: RunFailureCategory | null;
  /** 你停下了这次 Run。 */
  stoppedByUser: boolean;
  /** 你停下这次 Run 是为了换执行 agent：换成了哪一个。 */
  switchedTo: KernelRuntimeId | null;
};

export type RunFactsInput = {
  attempts: readonly Pick<AttemptEntity, 'id' | 'role' | 'purpose'>[];
  activities: readonly Pick<ActivityDto, 'kind' | 'attemptId' | 'payload'>[];
  /** 工单在 review 时的核查状态：当前和作废的核查结论。 */
  review?: Pick<TicketReviewState, 'reviewerAttemptId' | 'verdict' | 'supersededReview'> | null;
};

const HANDOFF_FAILED_TITLE = '运行结束，交接失败';

export function buildRunFacts(input: RunFactsInput): Map<number, RunFacts> {
  const facts = new Map<number, RunFacts>();
  for (const attempt of input.attempts) {
    facts.set(attempt.id, {
      id: attempt.id,
      purpose: attempt.purpose ?? (attempt.role === 'reviewer' ? 'review' : 'execution'),
      verdict: null,
      delivered: false,
      handoffFailed: false,
      blockedTicket: false,
      failure: null,
      stoppedByUser: false,
      switchedTo: null,
    });
  }
  const verdicts = new Map<number, RunVerdict>();
  for (const activity of input.activities) {
    const payload = activity.payload;
    const reviewerRunId = positiveInteger(payload.reviewerRunId);
    const verdict = verdictOf(payload.verdict);
    if (activity.kind === 'decision' && reviewerRunId !== null && verdict !== null) {
      verdicts.set(reviewerRunId, verdict);
    }
    if (activity.kind === 'decision' && payload.decision === 'ticket_runtime_switched') {
      const previous = facts.get(positiveInteger(payload.previousRunId) ?? 0);
      const to = runtimeIdOf(payload.toRuntime);
      if (previous && to) previous.switchedTo = to;
    }
    const run = activity.attemptId === null ? undefined : facts.get(activity.attemptId);
    if (!run) continue;
    if (activity.kind === 'decision' && payload.decision === '停止执行') run.stoppedByUser = true;
    if (activity.kind === 'decision' && payload.decision === 'runtime_failure_classified') {
      run.failure = failureCategoryOf(payload.category) ?? run.failure;
    }
    if (activity.kind === 'crash' && run.failure === null) run.failure = failureFromText(text(payload.reason));
    if (activity.kind === 'transition') {
      const to = text(payload.to);
      if (to === 'review') run.delivered = true;
      if (to === 'blocked') {
        run.blockedTicket = true;
        if (/terminal handoff/i.test(text(payload.reason) ?? '')) run.handoffFailed = true;
      }
    } else if (activity.kind === 'notification' && text(payload.title) === HANDOFF_FAILED_TITLE) {
      run.handoffFailed = true;
    }
  }
  const review = input.review;
  if (review?.reviewerAttemptId && review.verdict) verdicts.set(review.reviewerAttemptId, review.verdict);
  if (review?.supersededReview?.verdict) verdicts.set(review.supersededReview.reviewerAttemptId, review.supersededReview.verdict);
  for (const [runId, verdict] of verdicts) {
    const run = facts.get(runId);
    if (run && run.purpose === 'review') run.verdict = verdict;
  }
  return facts;
}

export type RunOutcomeTone = 'success' | 'danger' | 'neutral' | 'running';

export type RunOutcome = {
  /** 这次 Run 是做什么的：执行、核查、对话。 */
  purposeLabel: string;
  /** 结果，按用途写：核查写结论，对话写有没有回答，执行写有没有交付。 */
  result: string;
  tone: RunOutcomeTone;
};

const PURPOSE_LABEL: Record<RunPurpose, string> = {
  execution: '执行',
  review: '核查',
  conversation: '对话',
  integration: '合并',
  learning: '学习',
};

const RUNNING_LABEL: Record<RunPurpose, string> = {
  execution: '执行中',
  review: '核查中',
  conversation: '正在回答',
  integration: '合并中',
  learning: '进行中',
};

/** 一次 Run 的用途和结果。没有事实时（还没读到活动流）按角色推断用途，结果只说进程怎么结束。 */
export function runOutcome(
  attempt: Pick<AttemptEntity, 'id' | 'role' | 'purpose' | 'state' | 'exitCode'>,
  facts?: RunFacts,
): RunOutcome {
  const purpose = facts?.purpose ?? attempt.purpose ?? (attempt.role === 'reviewer' ? 'review' : 'execution');
  const purposeLabel = PURPOSE_LABEL[purpose];
  const exit = attempt.exitCode === null || attempt.exitCode === 0 ? '' : `（exit ${attempt.exitCode}）`;
  switch (attempt.state) {
    case 'starting':
      return { purposeLabel, result: '正在启动', tone: 'running' };
    case 'running':
      return { purposeLabel, result: RUNNING_LABEL[purpose], tone: 'running' };
    case 'paused':
      return { purposeLabel, result: '已暂停', tone: 'neutral' };
    case 'stopped':
      return { purposeLabel, result: '已停止', tone: 'neutral' };
    case 'crashed':
      return { purposeLabel, result: purpose === 'conversation' ? `没有回答${exit}` : `失败${exit}`, tone: 'danger' };
    default:
      break;
  }
  // settled：进程结束了。结果看这次 Run 做成了什么。
  if (purpose === 'conversation') {
    return exit ? { purposeLabel, result: `没有回答${exit}`, tone: 'danger' } : { purposeLabel, result: '已回答', tone: 'success' };
  }
  if (purpose === 'review') {
    if (facts?.verdict === 'pass') return { purposeLabel, result: '通过', tone: 'success' };
    if (facts?.verdict === 'fail') return { purposeLabel, result: '不通过', tone: 'danger' };
    return { purposeLabel, result: exit ? `结束${exit}，没有结论` : '已结束，没有结论', tone: exit ? 'danger' : 'neutral' };
  }
  if (facts?.handoffFailed) return { purposeLabel, result: '交接失败', tone: 'danger' };
  if (facts?.delivered) return { purposeLabel, result: '已交付', tone: 'success' };
  return exit
    ? { purposeLabel, result: `结束${exit}`, tone: 'danger' }
    : { purposeLabel, result: '已结束', tone: 'neutral' };
}

const FAILURE_REASONS: Record<Exclude<RunFailureCategory, 'model_unsupported'>, string> = {
  model_capacity: '模型满载',
  provider_unavailable: 'Provider 不可用',
  run_interrupted: 'Run 被中断',
  session_expired: '会话已过期',
  authentication: '认证失败',
  account_quota: '账号余额不足',
  usage_limit: '用量额度用完',
  runtime_unavailable: '启动失败',
  runtime_configuration: '配置错误',
  host_defect: '宿主代码出错',
  task_failure: '任务失败',
};

/**
 * 一次 Run 为什么没做成，一个短语：「模型满载」「你换成 Claude Code」「交接失败」。
 * 「经过」把连续的失败合成一行时，用这些短语列原因。做成了的 Run 返回 null。
 */
export function runFailureReason(
  attempt: Pick<AttemptEntity, 'state' | 'runtime' | 'model'>,
  facts: Pick<RunFacts, 'purpose' | 'verdict' | 'delivered' | 'handoffFailed' | 'failure' | 'stoppedByUser' | 'switchedTo'>,
): string | null {
  if (attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused') return null;
  if (facts.delivered || facts.verdict !== null) return null;
  if (facts.handoffFailed) return '交接失败';
  if (attempt.state === 'stopped') {
    if (facts.switchedTo) return `你换成 ${runtimeDisplayName(facts.switchedTo)}`;
    return facts.stoppedByUser ? '你停止了' : '已停止';
  }
  if (facts.failure === 'model_unsupported') {
    const agent = runtimeDisplayName(attempt.runtime) ?? '执行 agent';
    return attempt.model ? `${agent} 不支持模型 ${attempt.model}` : `${agent} 不支持该模型`;
  }
  if (facts.failure) return FAILURE_REASONS[facts.failure];
  if (attempt.state === 'crashed') return '运行失败';
  return facts.purpose === 'review' ? '没有结论' : '没有交付';
}

const FAILURE_CATEGORIES = new Set<string>([
  'model_capacity', 'provider_unavailable', 'run_interrupted', 'session_expired', 'authentication',
  'account_quota', 'usage_limit', 'model_unsupported', 'runtime_unavailable', 'runtime_configuration', 'host_defect', 'task_failure',
]);

function failureCategoryOf(value: unknown): RunFailureCategory | null {
  return typeof value === 'string' && FAILURE_CATEGORIES.has(value) ? value as RunFailureCategory : null;
}

// 服务端开始分类失败（runtime_failure_classified）以前的记录只有崩溃原文。只认几种明确的说法。
function failureFromText(reason: string | null): RunFailureCategory | null {
  if (!reason) return null;
  if (/at capacity|overloaded/i.test(reason)) return 'model_capacity';
  if (/failed to authenticate|oauth|not logged in|unauthori[sz]ed/i.test(reason)) return 'authentication';
  if (/no conversation found/i.test(reason)) return 'session_expired';
  if (/model is not supported|unsupported model/i.test(reason)) return 'model_unsupported';
  // daemon 重启时回收的孤儿 Run（2026-10-15 部署时的核查 Run #78）。packages/runtime 把它归为 run_interrupted。
  if (/orphaned run reclaimed/i.test(reason)) return 'run_interrupted';
  return null;
}

function runtimeIdOf(value: unknown): KernelRuntimeId | null {
  return value === 'pi' || value === 'codex' || value === 'claude' ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function verdictOf(value: unknown): RunVerdict | null {
  return value === 'pass' || value === 'fail' ? value : null;
}
