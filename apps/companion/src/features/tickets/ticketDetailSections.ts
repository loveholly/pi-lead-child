// 工单详情的骨架（工单详情与验收 spec 第 2、3 节，4.0–4.4、4.6，实现工单 12）。
//
// 页面（TicketThread）只做组合，这里算每一块要画什么：块的顺序、默认展开、出处、折叠后的摘要，
// 以及底部操作栏和头部「更多」里放哪几个工单操作。
// - 当前状态只从 TicketSummary 取（AGENTS.md 的 Core Invariants）：阶段读 ticket.status，不读别的块。
// - 按钮能不能点只看 GET /v1/tickets/:id/actions 的 available（工单 03）。这里只决定按钮放在哪个位置，
//   不判断能不能做：清单里没有的操作不画，清单说不能做的画成不能点，并写出原因。
import type { BadgeTone, ChecklistItem, DataTone, StatItem, StepItem, StepState, TimelineItem } from '@pi-lead-child/components';
import type {
  Locale,
  PlanStepStatus,
  TicketAcceptanceCriteria,
  TicketAction,
  TicketActionId as TicketOperationId,
  TicketDelivery,
  TicketExecutionPlan,
} from '@pi-lead-child/protocol';

import type { Ticket, TicketStatus } from '@/features/workspace/model';

import { ticketDetailMessages, ticketTimeMessages } from './ticketDetail.messages';
import type { TicketStoryEntry, TicketStoryTone } from './ticketStory';

// ── 阶段 ────────────────────────────────────────────────────────────────────────────

/** 骨架按阶段决定默认展开和底部操作栏。阶段只从 TicketSummary.stage 来。 */
export type DetailStage = 'draft' | 'running' | 'review' | 'done' | 'cancelled';

export function detailStage(status: TicketStatus): DetailStage {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'review':
      return 'review';
    case 'done':
    case 'acked':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      // ready、active、blocked：已经开跑或排着等开跑，都按执行中排。
      return 'running';
  }
}

// ── 块的顺序、默认展开、出处 ────────────────────────────────────────────────────────────

// 头部以下的每一块（第 3 节的顺序）。没有「这张工单」这一层标题：任务说明、验收标准、工单信息直接排。
export const DETAIL_SECTIONS = ['relations', 'task', 'criteria', 'evidence', 'info', 'execution', 'delivery', 'history'] as const;
export type DetailSectionKind = typeof DETAIL_SECTIONS[number];

export function detailSectionTitles(locale: Locale = 'en'): Record<DetailSectionKind, string> {
  return ticketDetailMessages(locale).sections;
}

// 默认展开哪几块（画布 M3，2026-11-15）：页面的最后是「验收标准」「经过与记录」两行，平时收起。
// - 等你验收：验收标准展开，要对着它验收。
// - 已完成、已取消：经过与记录展开，交付的结果在里面。
// - 草稿：验收标准展开，开跑前要确认；执行计划（execution）也展开。
const EXPANDED_BY_STAGE: Record<DetailStage, readonly DetailSectionKind[]> = {
  draft: ['relations', 'task', 'criteria', 'execution'],
  running: ['relations', 'task'],
  review: ['relations', 'criteria', 'evidence'],
  done: ['history'],
  cancelled: ['history'],
};

/** 你在这台设备上手动展开或折叠过的块：按块的种类记，不按工单记（4.0）。 */
export type RememberedSections = Partial<Record<DetailSectionKind, boolean>>;

/** 这一块现在折叠着吗。你手动选过的优先，没选过的按阶段的默认。 */
export function sectionCollapsed(stage: DetailStage, kind: DetailSectionKind, remembered: RememberedSections = {}): boolean {
  return remembered[kind] ?? !EXPANDED_BY_STAGE[stage].includes(kind);
}

// 五种出处（原则 5）：lead、child、system、reviewer、user。每块标题旁写一种，一眼能分开。
type SourceKind = 'lead' | 'child' | 'system' | 'reviewer' | 'user';

type Writer = 'user' | 'lead' | 'child' | 'system';

/** 出处的名字：Lead 写的那一种写成「Paimon 写的」这样，用你给 Lead 起的名字。 */
export function sourceLabels(leadName: string, locale: Locale = 'en'): Record<SourceKind, string> {
  const m = ticketDetailMessages(locale).sources;
  return { lead: m.lead(leadName), child: m.child, system: m.system, reviewer: m.reviewer, user: m.user };
}

/** 文字是谁写的：任务说明、验收标准都可能是 Lead、你或执行 agent 写的。 */
export function writerLabel(writer: Writer | null | undefined, leadName: string, locale: Locale = 'en'): string {
  const m = ticketDetailMessages(locale);
  switch (writer ?? 'lead') {
    case 'user': return m.writer.user;
    case 'child': return m.writer.child;
    case 'system': return m.sources.system;
    default: return m.sources.lead(leadName);
  }
}

/** 验收标准的出处：每一条可能是不同的人写的。都是同一个人时写他，混着时写「Paimon 和你写的」这类。 */
export function criteriaSourceLabel(criteria: TicketAcceptanceCriteria | null, leadName: string, locale: Locale = 'en'): string {
  const writers = [...new Set((criteria?.criteria ?? []).map((criterion) => criterion.writtenBy))];
  if (writers.length <= 1) return writerLabel(writers[0] ?? 'lead', leadName, locale);
  const m = ticketDetailMessages(locale);
  const names: Record<Writer, string> = { lead: leadName, ...m.writerNames };
  return m.writtenBy(writers.map((writer) => names[writer]));
}

// ── 任务说明 ─────────────────────────────────────────────────────────────────────────

// 默认显示前几段（4.3），其余收在「展开全文」后面。段落按空行分。
const BRIEF_PREVIEW_BLOCKS = 3;

export type BriefPreview = { preview: string; full: string; truncated: boolean };

export function briefPreview(brief: string): BriefPreview {
  const full = brief.trim();
  const blocks = full.split(/\n\s*\n/);
  if (blocks.length <= BRIEF_PREVIEW_BLOCKS) return { preview: full, full, truncated: false };
  return { preview: blocks.slice(0, BRIEF_PREVIEW_BLOCKS).join('\n\n'), full, truncated: true };
}

/** 任务说明折叠后的一句摘要：第一行正文。小标题（「## 背景」）说不出内容，跳过。 */
export function briefSummary(brief: string, fallback: string): string {
  const lines = brief.split('\n').map((text) => text.trim()).filter((text) => text.length > 0);
  const body = lines.find((text) => !text.startsWith('#'));
  return (body ?? lines[0]?.replace(/^#+\s*/, '') ?? fallback).replace(/^(?:[-*]|\d+\.)\s+/, '');
}

// ── 验收标准 ─────────────────────────────────────────────────────────────────────────

export type CriteriaPresentation = {
  items: ChecklistItem[];
  /** 交付以后才有「核查员」「你」两列（4.3）。交付前只列标准。 */
  compare: boolean;
  summary: string;
  empty: boolean;
};

// 核查员的逐条结论由工单 10 填（verdict 现在总是 null），这一列先显示「还没有结论」。
export function criteriaPresentation(criteria: TicketAcceptanceCriteria | null, locale: Locale = 'en'): CriteriaPresentation {
  const m = ticketDetailMessages(locale).criteria;
  const list = criteria?.criteria ?? [];
  const compare = criteria?.delivery != null;
  const items = list.map((criterion): ChecklistItem => ({
    id: String(criterion.id),
    label: criterion.text,
    ...(compare ? { verdicts: [null], checked: criterion.confirmation?.state === 'confirmed' } : {}),
  }));
  const summary = list.length === 0
    ? m.none
    : compare
      ? m.confirmed(list.length, criteria?.confirmed ?? 0)
      : m.beforeDelivery(list.length);
  return { items, compare, summary, empty: list.length === 0 };
}

// ── 执行计划 ─────────────────────────────────────────────────────────────────────────

// 06 的 in_progress 在 Steps 里叫 current。
const STEP_STATE: Record<PlanStepStatus, StepState> = {
  pending: 'pending',
  in_progress: 'current',
  done: 'done',
  skipped: 'skipped',
  blocked: 'blocked',
};

export function planSteps(plan: TicketExecutionPlan | null | undefined, locale: Locale = 'en'): StepItem[] {
  const prefix: Partial<Record<PlanStepStatus, string>> = ticketDetailMessages(locale).stepNote;
  return (plan?.steps ?? []).map((step, index) => ({
    label: `${index + 1}. ${step.title}`,
    state: STEP_STATE[step.status],
    ...(step.note ? { detail: `${prefix[step.status] ?? ''}${step.note}` } : {}),
  }));
}

/** 「4/5 · 15:18 更新」：跳过的步骤不算进分母（和 engine 的 executionPlanText 一样）。 */
export function planSummary(plan: TicketExecutionPlan | null | undefined, now: Date = new Date(), locale: Locale = 'en'): string | null {
  if (!plan) return null;
  const counted = plan.steps.filter((step) => step.status !== 'skipped');
  const done = counted.filter((step) => step.status === 'done').length;
  return ticketDetailMessages(locale).planUpdated(done, counted.length, clockText(plan.updatedAt, now, locale));
}

// ── 用量 ──────────────────────────────────────────────────────────────────────────────

export type UsageInput = {
  activeExecutionMs: number | null | undefined;
  totalTokens: number | null | undefined;
  totalCostUsd: number | null | undefined;
  running: boolean;
};

// 三个数：耗时、token、成本（4.4）。token 按 ADR 0001 的口径：输入（含缓存读写）加输出，就是服务端的 totalTokens。
export function usageStats(input: UsageInput, locale: Locale = 'en'): StatItem[] {
  const m = ticketDetailMessages(locale).usage;
  return [
    { label: input.running ? m.ran : m.duration, value: durationText(input.activeExecutionMs, locale) ?? m.notStarted },
    { label: m.tokens, value: input.totalTokens ? tokenText(input.totalTokens, locale) : m.noRecord },
    { label: m.cost, value: input.totalCostUsd ? costText(input.totalCostUsd) : m.noRecord },
  ];
}

// token 按计费拆开的四部分（GET /v1/tickets/:id/usage，ADR 0001）。一部分都没有记下时（旧工单、旧 daemon）不画这一行。
export type UsageParts = {
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  unsplitTokens: number;
};

export function usagePartsStats(parts: UsageParts | null | undefined, locale: Locale = 'en'): StatItem[] {
  if (!parts || parts.uncachedInputTokens + parts.cacheWriteTokens + parts.cacheReadTokens + parts.outputTokens === 0) return [];
  const m = ticketDetailMessages(locale).usage;
  return [
    { label: m.uncachedInput, value: tokenText(parts.uncachedInputTokens, locale) },
    { label: m.cacheWrite, value: tokenText(parts.cacheWriteTokens, locale) },
    { label: m.cacheRead, value: tokenText(parts.cacheReadTokens, locale) },
    { label: m.output, value: tokenText(parts.outputTokens, locale) },
  ];
}

// 属性里 Token 一行的两个数（主题 11.21，用户 2026-11-14 选的算法）：缓存 = 缓存读；未缓存 = 未缓存输入 + 缓存写 + 输出；
// 百分比 = 缓存读占四部分合计的多少。没拆分的旧用量不算进去（明细里另外写）。一部分都没有时返回 null。
export function tokenSummary(parts: UsageParts | null | undefined): { cached: number; uncached: number; cachedPercent: number } | null {
  if (!parts) return null;
  const cached = parts.cacheReadTokens;
  const uncached = parts.uncachedInputTokens + parts.cacheWriteTokens + parts.outputTokens;
  const total = cached + uncached;
  if (total === 0) return null;
  return { cached, uncached, cachedPercent: Math.round((cached / total) * 100) };
}

// 有明细时说明几部分的价差；有没拆分的旧用量时说出多少。
export function usagePartsCaption(parts: UsageParts, locale: Locale = 'en'): string {
  const m = ticketDetailMessages(locale).usage;
  return parts.unsplitTokens > 0 ? `${m.captionParts} ${m.unsplit(tokenText(parts.unsplitTokens, locale))}` : m.captionParts;
}

export function usageCaption(running: boolean, locale: Locale = 'en'): string {
  const m = ticketDetailMessages(locale).usage;
  return running ? m.captionRunning : m.captionTotal;
}

/** 执行这一块折叠后的摘要：「Claude Code · 15 分 51 秒 · 约 598 万 token · $2.58」。 */
export function executionSummary(agent: string | null, input: UsageInput, locale: Locale = 'en'): string {
  const m = ticketDetailMessages(locale).usage;
  return [
    agent,
    durationText(input.activeExecutionMs, locale),
    input.totalTokens ? m.tokenCount(tokenText(input.totalTokens, locale)) : null,
    input.totalCostUsd ? costText(input.totalCostUsd) : null,
  ].filter(Boolean).join(' · ') || m.notRun;
}

// 一万以上写「约 598 万」（英文写「about 5.98M」这类），以下照写。
export function tokenText(tokens: number, locale: Locale = 'en'): string {
  if (tokens < 10_000) return tokens.toLocaleString('en-US');
  return ticketDetailMessages(locale).tokens(tokens);
}

export function costText(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

export function durationText(ms: number | null | undefined, locale: Locale = 'en'): string | null {
  if (!ms || ms <= 0) return null;
  const m = ticketDetailMessages(locale).duration;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return m.hoursMinutes(hours, minutes);
  if (minutes > 0) return rest > 0 ? m.minutesSeconds(minutes, rest) : m.minutes(minutes);
  return m.seconds(rest);
}

// ── 核查员 ────────────────────────────────────────────────────────────────────────────

// 核查员的六种状态（4.4）。
export type ReviewerStatus = 'after_delivery' | 'queued' | 'suspended' | 'running' | 'done' | 'failed';

export function reviewerStatusLabels(locale: Locale = 'en'): Record<ReviewerStatus, string> {
  return ticketDetailMessages(locale).reviewerStatus;
}

/** 不要求独立核查的工单没有核查员这一行（返回 null）。 */
export function reviewerStatus(
  ticket: Pick<Ticket, 'verificationPolicy' | 'reviewState'>,
  latestReviewRun: { state: string; errorCode?: string | null } | null,
): ReviewerStatus | null {
  if (ticket.verificationPolicy !== 'independent_reviewer') return null;
  const review = ticket.reviewState;
  if (review?.reviewProgress) return review.reviewProgress;
  if (review?.verdict) return 'done';
  // 工单离开待验收以后没有 reviewState：看最近一次核查 Run 怎么结束的（线上的 Run 状态）。
  if (latestReviewRun?.state === 'settled' && !latestReviewRun.errorCode) return 'done';
  if (latestReviewRun && ['settled', 'crashed', 'stopped'].includes(latestReviewRun.state)) return 'failed';
  return 'after_delivery';
}

// ── 工作区 ────────────────────────────────────────────────────────────────────────────

/**
 * 改动合没合并。原则 6：items.stage 是唯一的生命周期事实。工单已完成或已取消时，「还没合并」只是一个事实，
 * 不用警告色，免得看起来像工单出了问题；冲突在工单结束前才标红。
 * 还没交付（草稿、执行中）时不挂标签：那时还谈不上合并（第四轮画板 D4-running 没有这个标签）。冲突照样标出来。
 */
export function integrationBadge(
  stage: DetailStage,
  integration: NonNullable<TicketDelivery['workspace']>['integration'],
  locale: Locale = 'en',
): { label: string; tone: BadgeTone } | null {
  const ended = stage === 'done' || stage === 'cancelled';
  if ((stage === 'draft' || stage === 'running') && integration !== 'conflict') return null;
  const label = ticketDetailMessages(locale).integration[integration];
  switch (integration) {
    case 'merged':
      return { label, tone: 'success' };
    case 'abandoned':
    case 'no_changes':
    case 'unmerged':
      return { label, tone: 'neutral' };
    case 'conflict':
      return { label, tone: ended ? 'neutral' : 'danger' };
  }
}

// ── 经过 ──────────────────────────────────────────────────────────────────────────────

const STORY_TONE: Record<TicketStoryTone, DataTone | undefined> = { success: 'success', danger: 'danger', accent: 'info', neutral: undefined };

export function historyItems(story: readonly TicketStoryEntry[], now: Date = new Date(), locale: Locale = 'en'): TimelineItem[] {
  const m = ticketDetailMessages(locale);
  return story.map((entry) => {
    const tone = STORY_TONE[entry.tone];
    return {
      at: clockText(entry.at, now, locale),
      text: m.sentence(entry.title, entry.detail),
      ...(tone ? { tone } : {}),
    };
  });
}

// ── 关系 ──────────────────────────────────────────────────────────────────────────────

export type ChildStage = 'done' | 'running' | 'blocked' | 'waiting' | 'cancelled' | 'review';

const CHILD_TONES: Record<ChildStage, BadgeTone> = {
  done: 'success',
  running: 'accent',
  blocked: 'danger',
  waiting: 'neutral',
  cancelled: 'muted',
  // 需要你处理的那一行要突出（4.2）。
  review: 'warning',
};

export function childBadge(stage: ChildStage, locale: Locale = 'en'): { label: string; tone: BadgeTone } {
  return { label: ticketDetailMessages(locale).child[stage], tone: CHILD_TONES[stage] };
}

/** 「拆成子工单」打开工单对话，预填一句请 Lead 来拆的话（D9）。 */
export function splitRequestText(ticketDisplayId: string, locale: Locale = 'en'): string {
  return ticketDetailMessages(locale).splitRequest(ticketDisplayId);
}

// ── 底部操作栏和两个「更多」 ──────────────────────────────────────────────────────────────

type BarLayout = {
  /** 主按钮的候选，按顺序：第一个能做的放上去；都不能做时放第一个清单里有的，画成不能点。 */
  primary: readonly TicketOperationId[];
  secondary: readonly TicketOperationId[];
};

// 按第 6 节的表放：每个阶段的主按钮和次要按钮。能不能点由清单决定，这里只决定位置。
// 执行中的次要按钮是「暂停」，暂停以后同一个位置换成「继续」：哪个能做，由清单的 available 决定。
const BAR_LAYOUT: Record<DetailStage, BarLayout> = {
  draft: { primary: ['confirm'], secondary: [] },
  running: { primary: [], secondary: ['pause_run', 'resume_run'] },
  review: { primary: ['complete'], secondary: ['rework'] },
  done: { primary: ['merge'], secondary: ['open_pr'] },
  cancelled: { primary: [], secondary: [] },
};

// 核查没有通过（不通过、证据冲突、返工额度用完）时，推荐的是打回返工。验收不放在主按钮上：它进「更多」，先确认（审查 2026-10-22）。
const REVIEW_AGAINST: BarLayout = { primary: ['rework'], secondary: [] };

// 头部的「更多」放工单级的操作（4.1）：复制链接（只在客户端）、改优先级、改项目、关联工单。
const HEADER_MORE: readonly TicketOperationId[] = ['set_priority', 'set_project', 'link'];

// 在页面别处有入口的操作：头部「更多」、关系行尾的解除关联、工单信息的「设置」、验收方式旁的托管、
// 验收标准的勾选、执行者和核查员两行的入口。打开交付的文件要一个文件，入口在交付的文件行（工单 13）。
// 其余能做的操作都放进底部的「更多」：清单里能做的，页面上都有入口（协调会话 2026-10-22 定的规则）。
const PLACED_ELSEWHERE = new Set<string>([
  ...HEADER_MORE, 'unlink', 'set_due', 'set_budget', 'delegate', 'confirm_criterion', 'unconfirm_criterion',
  'change_reviewer', 'set_run_profile', 'open_delivery_file',
]);

// 合并、开 PR、放弃改动要带上你看到的那份交付（expectedHead、expectedTarget）。交付还没读到时不能点。
export const DELIVERY_OPERATIONS = new Set<string>(['merge', 'open_pr', 'abandon']);

export type DetailActionBar = {
  primary: TicketAction | null;
  secondary: TicketAction | null;
  more: TicketAction[];
};

function pick(actions: readonly TicketAction[], candidates: readonly TicketOperationId[]): TicketAction | null {
  const listed = candidates.flatMap((id) => actions.filter((action) => action.id === id));
  return listed.find((action) => action.available) ?? listed[0] ?? null;
}

/** 核查没有给出通过的结论：不通过、证据冲突、返工额度用完。这时验收不是推荐的操作。 */
export function reviewWentAgainst(ticket: Pick<Ticket, 'status' | 'reviewState'>): boolean {
  const state = ticket.status === 'review' ? ticket.reviewState?.state : undefined;
  return state === 'review_failed' || state === 'evidence_conflict' || state === 'rework_exhausted';
}

export function detailActionBar(
  stage: DetailStage,
  actions: readonly TicketAction[],
  options: { reviewAgainst?: boolean } = {},
): DetailActionBar {
  const layout = stage === 'review' && options.reviewAgainst ? REVIEW_AGAINST : BAR_LAYOUT[stage];
  const primary = pick(actions, layout.primary);
  const secondary = pick(actions, layout.secondary);
  const placed = new Set([primary?.id, secondary?.id]);
  // 按清单的顺序（清单的顺序就是呈现顺序）。只放现在能做的。
  const more = actions.filter((action) => action.available && !placed.has(action.id) && !PLACED_ELSEWHERE.has(action.id));
  return { primary, secondary, more };
}

export function headerMoreActions(actions: readonly TicketAction[]): TicketAction[] {
  return HEADER_MORE.flatMap((id) => actions.filter((action) => action.id === id));
}

// id 是字符串：清单里可能有这个客户端还不认识的操作（例如工单 11 的 delegate）。
export function findAction(actions: readonly TicketAction[], id: string): TicketAction | null {
  return actions.find((action) => action.id === id) ?? null;
}

/** 底部栏下一步下面那行小字：主按钮不能点时写原因（清单给的原话）。 */
export function barCaption(bar: DetailActionBar, criteria: TicketAcceptanceCriteria | null, locale: Locale = 'en'): string | undefined {
  const blocked = [bar.primary, bar.secondary].find((action) => action && !action.available);
  if (blocked?.reason) return blocked.reason;
  if (criteria?.delivery && criteria.criteria.length > 0) {
    return ticketDetailMessages(locale).criteriaConfirmed(criteria.confirmed, criteria.criteria.length);
  }
  return undefined;
}

export type NextStepInput = {
  stage: DetailStage;
  ticket: Pick<Ticket, 'status' | 'pendingDecisionCount'>;
  agentName: string | null;
  /** 工单停住了：派发失败、执行受阻、要你处理的执行或工作区异常（isTicketBlockedForActions）。 */
  stuck: boolean;
  /** 这张工单的 Run 停在暂停（Run 的状态，不是工单的阶段）。 */
  paused: boolean;
  /** 等你验收、受阻时的那一句（ticketDecision 的 headline），和收件箱是同一句话。 */
  decisionHeadline: string;
  integration: NonNullable<TicketDelivery['workspace']>['integration'] | null;
  pullRequestUrl: string | null;
  /** 界面语言。不给时按英文。 */
  locale?: Locale;
};

/** 底部栏的「下一步」：这张工单现在要你做什么。 */
export function nextStepText(input: NextStepInput): string {
  const { stage, ticket } = input;
  const m = ticketDetailMessages(input.locale ?? 'en').next;
  if ((ticket.pendingDecisionCount ?? 0) > 0) return m.decision;
  switch (stage) {
    case 'draft':
      return m.draft;
    case 'running':
      // 停住了就写停在哪里（和收件箱同一句），不能说「继续做，现在不需要你」。
      if (ticket.status === 'blocked' || input.stuck) return input.decisionHeadline;
      if (input.paused) return m.paused;
      return m.continues(input.agentName);
    case 'review':
      return input.decisionHeadline;
    case 'done':
      if (input.pullRequestUrl) return m.reviewPullRequest;
      if (input.integration === 'unmerged') return m.decideCode;
      return m.done;
    case 'cancelled':
      return m.cancelled;
  }
}

// ── 时间 ──────────────────────────────────────────────────────────────────────────────

/** 今天的事写「15:18」，更早的写「10月21日 15:18」。 */
export function clockText(iso: string, now: Date = new Date(), locale: Locale = 'en'): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? hm : `${ticketTimeMessages(locale).monthDay(at.getMonth() + 1, at.getDate())} ${hm}`;
}
