// 工单详情的骨架（工单详情与验收 spec 第 2、3 节，4.0–4.4、4.6，实现工单 12）。
//
// 页面（TicketThread）只做组合，这里算每一块要画什么：块的顺序、默认展开、出处、折叠后的摘要，
// 以及底部操作栏和头部「更多」里放哪几个工单操作。
// - 当前状态只从 TicketSummary 取（AGENTS.md 的 Core Invariants）：阶段读 ticket.status，不读别的块。
// - 按钮能不能点只看 GET /v1/tickets/:id/actions 的 available（工单 03）。这里只决定按钮放在哪个位置，
//   不判断能不能做：清单里没有的操作不画，清单说不能做的画成不能点，并写出原因。
import type { BadgeTone, ChecklistItem, DataTone, StatItem, StepItem, StepState, TimelineItem } from '@pi-lead-child/components';
import type {
  PlanStepStatus,
  TicketAcceptanceCriteria,
  TicketAction,
  TicketActionId as TicketOperationId,
  TicketDelivery,
  TicketExecutionPlan,
} from '@pi-lead-child/protocol';

import type { Ticket, TicketStatus } from '@/features/workspace/model';

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
export const DETAIL_SECTIONS = ['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history'] as const;
export type DetailSectionKind = typeof DETAIL_SECTIONS[number];

export const DETAIL_SECTION_TITLES: Record<DetailSectionKind, string> = {
  relations: '关系',
  task: '任务说明',
  criteria: '验收标准',
  info: '工单信息',
  execution: '执行',
  delivery: '交付与验收',
  history: '经过与记录',
};

// 默认展开哪几块（4.0）：
// - 执行中：执行展开，交付与验收只有一句话。
// - 等你验收：验收标准、交付与验收展开，任务说明和执行折叠。
// - 已完成：交付与验收展开，其余折叠。已取消同已完成。
// - 草稿：还没开跑，工单本身的信息展开。
const EXPANDED_BY_STAGE: Record<DetailStage, readonly DetailSectionKind[]> = {
  draft: ['relations', 'task', 'criteria', 'info', 'execution', 'history'],
  running: ['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history'],
  review: ['relations', 'criteria', 'info', 'delivery', 'history'],
  done: ['delivery'],
  cancelled: ['delivery'],
};

/** 你在这台设备上手动展开或折叠过的块：按块的种类记，不按工单记（4.0）。 */
export type RememberedSections = Partial<Record<DetailSectionKind, boolean>>;

/** 这一块现在折叠着吗。你手动选过的优先，没选过的按阶段的默认。 */
export function sectionCollapsed(stage: DetailStage, kind: DetailSectionKind, remembered: RememberedSections = {}): boolean {
  return remembered[kind] ?? !EXPANDED_BY_STAGE[stage].includes(kind);
}

// 五种出处（原则 5）。每块标题旁写一种，一眼能分开。Lead 写的那一种用你给 Lead 起的名字（sourceLabels）。
export const SOURCE_LABELS = {
  lead: 'Lead 写的',
  child: '执行 agent 自述',
  system: '系统记录',
  reviewer: '核查员',
  user: '你的操作',
} as const;

type Writer = 'user' | 'lead' | 'child' | 'system';

/** 出处的名字：Lead 写的那一种写成「Paimon 写的」这样，用你给 Lead 起的名字。 */
export function sourceLabels(leadName: string): Record<keyof typeof SOURCE_LABELS, string> {
  return { ...SOURCE_LABELS, lead: `${leadName} 写的` };
}

/** 文字是谁写的：任务说明、验收标准都可能是 Lead、你或执行 agent 写的。 */
export function writerLabel(writer: Writer | null | undefined, leadName: string): string {
  switch (writer ?? 'lead') {
    case 'user': return '你写的';
    case 'child': return '执行 agent 写的';
    case 'system': return SOURCE_LABELS.system;
    default: return `${leadName} 写的`;
  }
}

/** 验收标准的出处：每一条可能是不同的人写的。都是同一个人时写他，混着时写「Paimon 和你写的」这类。 */
export function criteriaSourceLabel(criteria: TicketAcceptanceCriteria | null, leadName: string): string {
  const writers = [...new Set((criteria?.criteria ?? []).map((criterion) => criterion.writtenBy))];
  if (writers.length <= 1) return writerLabel(writers[0] ?? 'lead', leadName);
  const names: Record<Writer, string> = { lead: leadName, user: '你', child: '执行 agent', system: '系统' };
  return `${writers.map((writer) => names[writer]).join('和')}写的`;
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
export function criteriaPresentation(criteria: TicketAcceptanceCriteria | null): CriteriaPresentation {
  const list = criteria?.criteria ?? [];
  const compare = criteria?.delivery != null;
  const items = list.map((criterion): ChecklistItem => ({
    id: String(criterion.id),
    label: criterion.text,
    ...(compare ? { verdicts: [null], checked: criterion.confirmation?.state === 'confirmed' } : {}),
  }));
  const summary = list.length === 0
    ? '没有结构化的验收标准'
    : compare
      ? `${list.length} 条 · 已确认 ${criteria?.confirmed ?? 0}/${list.length}`
      : `${list.length} 条 · 交付后，核查员和你逐条对照`;
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

const STEP_NOTE_PREFIX: Partial<Record<PlanStepStatus, string>> = { skipped: '跳过：', blocked: '受阻：' };

export function planSteps(plan: TicketExecutionPlan | null | undefined): StepItem[] {
  return (plan?.steps ?? []).map((step, index) => ({
    label: `${index + 1}. ${step.title}`,
    state: STEP_STATE[step.status],
    ...(step.note ? { detail: `${STEP_NOTE_PREFIX[step.status] ?? ''}${step.note}` } : {}),
  }));
}

/** 「4/5 · 15:18 更新」：跳过的步骤不算进分母（和 engine 的 executionPlanText 一样）。 */
export function planSummary(plan: TicketExecutionPlan | null | undefined, now: Date = new Date()): string | null {
  if (!plan) return null;
  const counted = plan.steps.filter((step) => step.status !== 'skipped');
  const done = counted.filter((step) => step.status === 'done').length;
  return `${done}/${counted.length} · ${clockText(plan.updatedAt, now)} 更新`;
}

// ── 用量 ──────────────────────────────────────────────────────────────────────────────

export type UsageInput = {
  activeExecutionMs: number | null | undefined;
  totalTokens: number | null | undefined;
  totalCostUsd: number | null | undefined;
  running: boolean;
};

// 三个数：耗时、token、成本（4.4）。token 按 ADR 0001 的口径：输入（含缓存读写）加输出，就是服务端的 totalTokens。
export function usageStats(input: UsageInput): StatItem[] {
  return [
    { label: input.running ? '已执行' : '耗时', value: durationText(input.activeExecutionMs) ?? '还没开始' },
    { label: 'Token', value: input.totalTokens ? tokenText(input.totalTokens) : '没有记录' },
    { label: '成本', value: input.totalCostUsd ? costText(input.totalCostUsd) : '没有记录' },
  ];
}

export function usageCaption(running: boolean): string {
  return running ? '含缓存读写，跑的时候会涨。' : '所有运行合计，含缓存读写。';
}

/** 执行这一块折叠后的摘要：「Claude Code · 15 分 51 秒 · 约 598 万 token · $2.58」。 */
export function executionSummary(agent: string | null, input: UsageInput): string {
  return [
    agent,
    durationText(input.activeExecutionMs),
    input.totalTokens ? `${tokenText(input.totalTokens)} token` : null,
    input.totalCostUsd ? costText(input.totalCostUsd) : null,
  ].filter(Boolean).join(' · ') || '还没开跑';
}

// 一万以上写「约 598 万」，以下照写。
export function tokenText(tokens: number): string {
  if (tokens < 10_000) return tokens.toLocaleString('en-US');
  return `约 ${Math.round(tokens / 10_000).toLocaleString('en-US')} 万`;
}

export function costText(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

export function durationText(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  return `${rest} 秒`;
}

// ── 核查员 ────────────────────────────────────────────────────────────────────────────

// 核查员的六种状态（4.4）。
export type ReviewerStatus = 'after_delivery' | 'queued' | 'suspended' | 'running' | 'done' | 'failed';

export const REVIEWER_STATUS_LABELS: Record<ReviewerStatus, string> = {
  after_delivery: '交付后开始',
  queued: '排队',
  suspended: '挂起',
  running: '在跑',
  done: '完成',
  failed: '没做成',
};

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
): { label: string; tone: BadgeTone } | null {
  const ended = stage === 'done' || stage === 'cancelled';
  if ((stage === 'draft' || stage === 'running') && integration !== 'conflict') return null;
  switch (integration) {
    case 'merged':
      return { label: '已合并', tone: 'success' };
    case 'abandoned':
      return { label: '已放弃', tone: 'neutral' };
    case 'no_changes':
      return { label: '没有改动', tone: 'neutral' };
    case 'conflict':
      return { label: '有冲突', tone: ended ? 'neutral' : 'danger' };
    case 'unmerged':
      return { label: '还没合并', tone: 'neutral' };
  }
}

// ── 经过 ──────────────────────────────────────────────────────────────────────────────

const STORY_TONE: Record<TicketStoryTone, DataTone | undefined> = { success: 'success', danger: 'danger', accent: 'info', neutral: undefined };

export function historyItems(story: readonly TicketStoryEntry[], now: Date = new Date()): TimelineItem[] {
  return story.map((entry) => {
    const tone = STORY_TONE[entry.tone];
    return {
      at: clockText(entry.at, now),
      text: entry.detail ? `${entry.title}。${entry.detail}` : `${entry.title}。`,
      ...(tone ? { tone } : {}),
    };
  });
}

// ── 关系 ──────────────────────────────────────────────────────────────────────────────

export type ChildStage = 'done' | 'running' | 'blocked' | 'waiting' | 'cancelled' | 'review';

export const CHILD_BADGES: Record<ChildStage, { label: string; tone: BadgeTone }> = {
  done: { label: '已完成', tone: 'success' },
  running: { label: '执行中', tone: 'accent' },
  blocked: { label: '受阻', tone: 'danger' },
  waiting: { label: '等待中', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'muted' },
  // 需要你处理的那一行要突出（4.2）。
  review: { label: '等你验收', tone: 'warning' },
};

/** 「拆成子工单」打开工单对话，预填一句请 Lead 来拆的话（D9）。 */
export function splitRequestText(ticketDisplayId: string): string {
  return `请把 #${ticketDisplayId} 拆成几张子工单：`;
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
export function barCaption(bar: DetailActionBar, criteria: TicketAcceptanceCriteria | null): string | undefined {
  const blocked = [bar.primary, bar.secondary].find((action) => action && !action.available);
  if (blocked?.reason) return blocked.reason;
  if (criteria?.delivery && criteria.criteria.length > 0) {
    return `已确认 ${criteria.confirmed}/${criteria.criteria.length} 条验收标准`;
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
};

/** 底部栏的「下一步」：这张工单现在要你做什么。 */
export function nextStepText(input: NextStepInput): string {
  const { stage, ticket } = input;
  if ((ticket.pendingDecisionCount ?? 0) > 0) return '先回答这张工单上的决定';
  switch (stage) {
    case 'draft':
      return '你确认以后才开跑';
    case 'running':
      // 停住了就写停在哪里（和收件箱同一句），不能说「继续做，现在不需要你」。
      if (ticket.status === 'blocked' || input.stuck) return input.decisionHeadline;
      if (input.paused) return '已暂停。点继续，接着做';
      return `${input.agentName ?? '执行 agent'} 继续做，现在不需要你`;
    case 'review':
      return input.decisionHeadline;
    case 'done':
      if (input.pullRequestUrl) return '你在 GitHub 上审阅草稿 PR';
      if (input.integration === 'unmerged') return '你决定代码怎么处理';
      return '工单已完成，不需要你';
    case 'cancelled':
      return '工单已取消，不需要你';
  }
}

// ── 时间 ──────────────────────────────────────────────────────────────────────────────

/** 今天的事写「15:18」，更早的写「10月21日 15:18」。 */
export function clockText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? hm : `${at.getMonth() + 1}月${at.getDate()}日 ${hm}`;
}
