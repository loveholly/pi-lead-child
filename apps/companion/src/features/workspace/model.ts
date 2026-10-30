import {
  ticketNeedsUser,
  ticketNeedsUserLabel,
  ticketTurn,
  userItemActionsFor,
  type KernelCheckpoint,
  type KernelIntervention,
  type KernelTicketPow,
  type KernelTicketWorkItem,
  type KernelTicketWorkItemV2,
  type ResolveKernelInterventionRequest,
  type TicketKind,
  type TicketNeedsUserReason,
  type TicketStatus,
  type TicketSummary,
  type TicketTurn,
  type UserItemActionId,
  type WorkspaceControlActionId,
} from '@pi-lead-child/protocol';

import { leadNameNow } from '@/state/leadName';
import { resolvedByLabel } from '@/features/chat/resolvedByLabel';
import type { ControlPlanePhase, ResourceLoadState } from '@/state/types';
import type { ConnectionState } from '@pi-lead-child/client';

import { systemCheckpointText } from './systemCheckpointText';
import { runtimeDisplayName } from './runtimeNames';

export type RailView = 'inbox' | 'tickets' | 'projects' | 'agenda';

export type RailViewDirection = 'forward' | 'backward' | 'none';

// 迁移前这里自己声明了一套 'backlog' | 'assigned' | 'running'，并在 ticketSummaryToTicket
// 里做 in_progress → running 的重映射。那套词汇在协议里早已不存在，而根 tsconfig 的
// include 不含 apps/，tsc 看不见这里，于是它一直静默地活着——代价是
// ConnectedTicketThread 与 LeadConversation 里两条 `=== 'in_progress'` 分支永远不成立。
// 现在直接复用协议的 union：本地再写一份就等于给下一次漂移留好位置。
export type { TicketKind, TicketStatus };

export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low';

export type TicketFilter = 'all' | 'todo' | 'running' | 'queued';

export type TicketGroupId = 'needs_intervention' | 'running' | 'queued' | 'lead' | 'background' | 'completed' | 'cancelled';

export type TicketRailState = 'loading' | 'populated' | 'first_use' | 'all_completed' | 'no_results';

export type TicketDetailTab = 'progress' | 'artifacts' | 'logs';

export type CheckpointKind = 'progress' | 'milestone' | 'decision' | 'delegation' | 'blocked' | 'completed';

export type CheckpointSource = 'agent_reported' | 'system_derived';

export type InterventionState = 'pending' | 'resolved' | 'rejected' | 'dismissed' | 'expired';

export type InterventionKind = 'approval' | 'decision';

export type Ticket = {
  id: string;
  displayId?: string;
  /** 原标题。列表和收件箱先用 displayTitle（ticketTitle）。 */
  title: string;
  /** Lead 写的短标题（set_display_title），原标题太长或带脚本前缀时才有。 */
  displayTitle?: string;
  /** 进入当前 stage 的时间。工单行右边的停留时间按它算。 */
  stageChangedAt?: string;
  /** 最近的一个未完成节点（阶段 3，任何类型）。工单行和收件箱卡上显示成小标签。 */
  nextMilestone?: TicketSummary['nextMilestone'];
  summary: string;
  kind: TicketKind;
  workflowKind?: TicketSummary['workflowKind'];
  status: TicketStatus;
  statusLabel: string;
  // 派生自 attempts 的存在性（kernel spec §11），由投影层给出，UI 只消费不计算。
  hasRun: boolean;
  workspace?: TicketSummary["workspace"];
  priority: TicketPriority;
  priorityLabel: string;
  project?: string;
  runtimeLabel: string;
  /** TicketSummary.runtime.state：这张工单有没有 Run 在进行（工单对话也算）。 */
  runtimeState?: TicketSummary['runtime']['state'];
  verificationPolicy?: TicketSummary['verificationPolicy'];
  acceptancePolicy?: TicketSummary['acceptancePolicy'];
  reworkPolicy?: TicketSummary['reworkPolicy'];
  deliveryPolicy?: TicketSummary['deliveryPolicy'];
  workflowState?: TicketSummary['workflowState'];
  reviewState?: TicketSummary['reviewState'];
  executionState?: TicketSummary['executionState'];
  runtimeName?: string;
  agentLabel?: string;
  sessionId?: string;
  elapsedMs?: number | null;
  heartbeat: boolean;
  needsAttention: boolean;
  // Lead 正在处理这张工单上的异常（protocol 的 attention.leadHandling，且没有升级给用户）。
  // 2026-10-15 用户决定：除非需要用户介入，UI 只给弱反馈。这时不标红，只写「Lead 处理中」。
  leadHandling?: boolean;
  // 需要你做什么（protocol 的 ticketNeedsUser）。收件箱、导航角标和会话底栏都按它计数。
  needsUser?: TicketNeedsUserReason | null;
  // 等你回答的决策请求有几条（protocol 的 attention.pendingDecisionCount）。有时决策卡不按阶段另推荐动作。
  pendingDecisionCount?: number;
  // 现在轮到谁（protocol 的 ticketTurn）。分组、筛选和会话底栏的「执行中」都按它算。
  turn: TicketTurn;
  // 后台工单（TicketSummary.worklistVisibility），例如系统建的学习工单。轮到 Lead 时进默认收起的组。
  background?: boolean;
  progressPercent?: number;
};

export type TicketRailGroup = {
  id: TicketGroupId;
  label: string;
  count: number;
  collapsible: boolean;
  collapsedByDefault: boolean;
  items: Ticket[];
};

export type TicketRailPresentation = {
  state: TicketRailState;
  groups: TicketRailGroup[];
  filterCounts: Record<TicketFilter, number>;
  totalCount: number;
  todoCount: number;
};

export type TicketPropertyPresentation = {
  id: 'project' | 'agent' | 'runtime' | 'session' | 'elapsed';
  label: string;
  value: string;
};

export type WorkspaceStatusPresentation = {
  title: string;
  modeLabel: string;
  kindLabel: string;
  stateLabel: string;
  stateTone: 'neutral' | 'info' | 'attention' | 'success' | 'danger';
  nextStep: string;
  mergeLabel?: string;
  retentionLabel?: string;
};

const workspaceStateLabels: Record<NonNullable<TicketSummary['workspace']>['state'], string> = {
  requested: '等待创建', provisioning: '正在创建', active: '可执行', idle: '空闲',
  review_hold: '等待核查', pending_integration: '等待合并', released: '已释放',
  cleaning: '正在清理', cleaned: '已清理', archived: '已归档', failed: '创建失败', blocked: '已阻塞',
};

export function workspaceStatusPresentation(
  workspace: NonNullable<TicketSummary['workspace']>,
): WorkspaceStatusPresentation {
  const modeLabel = workspace.mode === 'isolated' ? '隔离工作区' : '共享工作区';
  const kindLabel = workspace.kind === 'reviewer' ? '核查工作区'
    : workspace.kind === 'isolated_child' ? '子工单工作区'
      : workspace.kind === 'experiment' ? '实验工作区' : '主工作区';
  const stateTone = workspace.mergeStatus === 'conflict' || workspace.state === 'failed' || workspace.state === 'blocked'
    ? 'danger'
    : workspace.state === 'review_hold' || workspace.state === 'pending_integration'
      ? 'attention'
      : workspace.state === 'active' || workspace.state === 'provisioning'
        ? 'info'
        : workspace.state === 'released' || workspace.state === 'cleaned' || workspace.state === 'archived'
          ? 'success' : 'neutral';
  const nextStep = workspace.mergeStatus === 'conflict'
    ? '合并发生冲突，先解决冲突或放弃这次变更，才能释放 workspace。'
    : workspace.state === 'review_hold'
    ? '核查期间工作区受保护，暂不可修改。'
    : workspace.state === 'pending_integration'
      ? '确认合并或放弃变更后，才能释放 workspace。'
      : workspace.state === 'released'
        ? '释放完成，满足保留期和六项检查后才能清理。'
        : workspace.state === 'failed' || workspace.state === 'blocked'
          ? '先查看 workspace 错误，再重新创建或恢复。'
          : workspace.state === 'active'
            ? '工作区已就绪，执行进度以工单状态为准。'
            : workspace.state === 'cleaning'
              ? '清理尚未完成，等待系统确认结果。'
              : workspace.state === 'cleaned'
                ? '工作区已完成清理。'
                : workspace.state === 'requested' || workspace.state === 'provisioning'
                  ? '工作区创建完成后才可执行。'
                  : '工作区状态与工单验收状态分别记录。';
  return {
    title: '工作区', modeLabel, kindLabel,
    stateLabel: workspaceStateLabels[workspace.state], stateTone, nextStep,
    ...(workspace.mergeStatus && workspace.mergeStatus !== 'n/a'
      ? { mergeLabel: workspace.mergeStatus === 'conflict' ? '合并冲突' : workspace.mergeStatus === 'pending' ? '等待合并' : workspace.mergeStatus === 'merged' ? '已合并' : '已放弃' }
      : {}),
    ...(workspace.retainedUntil ? { retentionLabel: `保留至 ${workspace.retainedUntil.slice(0, 16).replace('T', ' ')}` } : {}),
  };
}

export function ticketContextLabel(selectedTicketId: number | null, ticketId: number): string | null {
  return selectedTicketId !== null && selectedTicketId !== ticketId ? `其他工单 · #${ticketId}` : null;
}

export type ArtifactCapability = 'loading' | 'available' | 'unsupported';

export type PowMetricPresentation = {
  coverage: string;
  gaps: string;
};

// 列表、收件箱里的标题：有 Lead 写的短标题就用它，详情页同时显示原标题。
export function ticketTitle(ticket: Pick<Ticket, 'title' | 'displayTitle'>): string {
  return ticket.displayTitle ?? ticket.title;
}

// 没有项目的工单，服务端归在 id 和名字都是 'unknown' 的项目下。界面上叫「未归属」。
export const UNASSIGNED_PROJECT = 'unknown';

export function projectDisplayName(name: string): string {
  return name === UNASSIGNED_PROJECT ? '未归属' : name;
}

// 工单 tab 只看一个项目时的范围。knownNames 是当前的项目名：不在其中的工单算「未归属」，和服务端一致。
export type TicketProjectScope = { name: string; knownNames: readonly string[] };

export function ticketInProject(ticket: Ticket, scope: TicketProjectScope): boolean {
  if (scope.name === UNASSIGNED_PROJECT) return !ticket.project || !scope.knownNames.includes(ticket.project);
  return ticket.project === scope.name;
}

export type ArtifactPresentationState =
  | { kind: 'loading'; title: string; body: string }
  | { kind: 'unsupported'; title: string; body: string }
  | { kind: 'empty'; title: string; body: string }
  | { kind: 'available'; title: string; body: string };

export type TicketDetailPresentation = {
  tabs: typeof TICKET_DETAIL_TABS;
  properties: TicketPropertyPresentation[];
  artifactState: ArtifactPresentationState;
};

export type InterventionOption = {
  id: string;
  label: string;
};

export type InterventionAuthority = {
  id: string;
  kind: InterventionKind;
  state: InterventionState;
  canRespond: boolean;
  prompt?: string;
  allowSessionApproval?: boolean;
  allowCustom?: boolean;
  options?: InterventionOption[];
  resolvedBy?: string;
  resolutionLabel?: string;
  expiryExplanation?: string;
};

export type InterventionActionId = 'reject' | 'approve_once' | 'approve_session' | 'custom' | `option:${string}`;

export type InterventionActionPresentation = {
  id: InterventionActionId;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
};

export type InterventionPresentation = {
  id: string;
  kind: InterventionKind;
  state: InterventionState;
  stateLabel: string;
  tone: 'attention' | 'success' | 'danger' | 'muted';
  prompt?: string;
  resolutionText?: string;
  actions: InterventionActionPresentation[];
};

export type CheckpointFact = {
  label: string;
  value: string;
};

export type CheckpointArtifact = {
  id: string;
  label: string;
};

export type CheckpointPresentationInput = {
  id: string;
  /** 写下这条记录的 Run。系统记录可能没有。 */
  attemptId?: number;
  source: CheckpointSource;
  sourceLabel: string;
  createdAt: string;
  kind: CheckpointKind;
  stage?: string;
  title: string;
  summary: string;
  keyFacts?: CheckpointFact[];
  artifactRefs?: CheckpointArtifact[];
  relatedTicketIds?: string[];
  nextStep?: string;
  interventionId?: string;
};

export type CheckpointPresentation = CheckpointPresentationInput & {
  kindLabel: string;
  /** 这条记录说的是过去的事，不是工单现在的状态。 */
  historical?: boolean;
  intervention?: InterventionPresentation;
};

export type CheckpointFeedState = 'loading' | 'ready' | 'empty' | 'disconnected' | 'error';

export type CheckpointFeedPresentation = {
  state: CheckpointFeedState;
  items: CheckpointPresentation[];
  pageError?: string;
};

export type CheckpointFeedResource = {
  state: 'loading' | 'ready' | 'disconnected' | 'error';
  error?: string;
};

function compareCheckpointRecency(
  left: CheckpointPresentationInput,
  right: CheckpointPresentationInput,
): number {
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  if (Number.isSafeInteger(leftId) && Number.isSafeInteger(rightId)) return rightId - leftId;

  const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
  return right.id.localeCompare(left.id, undefined, { numeric: true });
}

export function activeTerminalHandoffFailure(
  status: TicketStatus,
  checkpoints: CheckpointPresentationInput[],
): CheckpointPresentationInput | undefined {
  if (status !== 'blocked') return undefined;

  const latestBlocked = latestBlockedCheckpoint(checkpoints);

  return latestBlocked?.source === 'system_derived'
    && latestBlocked.title === '运行结束，交接失败'
    ? latestBlocked
    : undefined;
}

export function latestBlockedCheckpoint(
  checkpoints: CheckpointPresentationInput[],
): CheckpointPresentationInput | undefined {
  return checkpoints
    .filter((checkpoint) => checkpoint.kind === 'blocked')
    .sort(compareCheckpointRecency)[0];
}

export type TimelineStep = {
  id: string;
  tool: string;
  description: string;
  time: string;
  state: 'complete' | 'running' | 'waiting';
  stateLabel: string;
};

export type WeekDay = {
  isoDate: string;
  weekdayLabel: string;
  dateLabel: string;
  isToday: boolean;
};

const railViewOrder: Record<RailView, number> = {
  inbox: 0,
  tickets: 1,
  projects: 2,
  agenda: 3,
};

// 没有「详情」tab：说明文字由 TicketThread 的头部渲染，再开一个 tab 装同一段字，
// 用户看到的就是同一段话出现两次。tab 只用来放头部装不下的执行细节。
export const TICKET_DETAIL_TABS = [
  { id: 'progress', label: '验收证据' },
  { id: 'artifacts', label: '产物' },
  { id: 'logs', label: '日志' },
] as const satisfies readonly { id: TicketDetailTab; label: string }[];

// 执行类面板（PoW/checkpoint、产物、日志）的数据源是 Run，仅在该 item 至少存在过一个 Run
// 时渲染（kernel spec §11）。这一条同时修好三个页面：提醒页、draft 未跑过的任务页、
// 以及确认了但还没开跑的任务页——它们今天渲染的都是一排空脚手架。
//
// 判据刻意是 hasRun 而不是 kind === 'task'：确认过但一次都没跑的任务同样什么都没有。
// 抽成纯函数而不是写进 JSX 的条件里，是为了让这条规则能被直接测到。
export function visibleTicketTabs(
  item: { kind: TicketKind; hasRun: boolean },
): TicketDetailTab[] {
  // reminder 结构上不可能有 Run（kernel spec §3.1）。这里仍然显式挡一道：
  // 即便投影撒谎，提醒也不该长出执行面板。
  if (item.kind === 'reminder' || !item.hasRun) return [];
  return ['progress', 'artifacts', 'logs'];
}

// ——— 用户控制面动作行（kernel spec §6.4）———
//
// 服务端早就有 POST /v1/tickets/:id/<action>，但 companion 一个都没调、一个按钮都没画：
// 一张 draft 的根工单在界面上没有任何确认入口，"建完先别跑"这条结构保证于是把用户本人
// 也锁在了外面。这里补的就是那半边。
//
// 哪几个动作合法**不在这里判断**：userItemActionsFor 来自 protocol，与内核拒绝非法跃迁
// 用的是同一张矩阵（packages/protocol/src/stages.ts）。这里只负责给动作配中文与视觉分量——
// 按 stage 写 if/else 摆按钮，就等于在 UI 里养第二份权限矩阵，它一定会和内核分家。
export type TicketActionId = UserItemActionId | WorkspaceControlActionId;

export function isWorkspaceControlActionId(action: TicketActionId): action is WorkspaceControlActionId {
  return action === "release" || action === "cleanup";
}

export type TicketActionTone = 'primary' | 'neutral' | 'danger';

export type TicketActionPresentation = {
  id: TicketActionId;
  label: string;
  tone: TicketActionTone;
};

const ticketActionCopy: Record<TicketActionId, { label: string; tone: TicketActionTone }> = {
  confirm: { label: '确认开跑', tone: 'primary' },
  start: { label: '开始执行', tone: 'primary' },
  complete: { label: '验收通过', tone: 'primary' },
  ack: { label: '知道了', tone: 'primary' },
  rework: { label: '打回返工', tone: 'neutral' },
  stop: { label: '停下', tone: 'neutral' },
  unconfirm: { label: '撤回确认', tone: 'neutral' },
  restore: { label: '恢复', tone: 'neutral' },
  cancel: { label: '取消工单', tone: 'danger' },
  release: { label: '释放工作区', tone: 'neutral' },
  cleanup: { label: '清理工作区', tone: 'danger' },
};

export function buildTicketActionPresentation(
  ticket: { kind: TicketKind; status: TicketStatus; workspace?: TicketSummary["workspace"] },
): TicketActionPresentation[] {
  const itemActions = userItemActionsFor(ticket.kind, ticket.status)
    .map((id) => ({ id, ...ticketActionCopy[id] }));
  const workspaceActions = ticket.workspace?.availableActions ?? [];
  return [
    ...itemActions,
    ...workspaceActions.map((id) => ({ id, ...ticketActionCopy[id] })),
  ];
}

export const TICKET_RAIL_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'todo', label: '等你' },
  { id: 'running', label: '在执行' },
  { id: 'queued', label: '排队' },
] as const satisfies readonly { id: TicketFilter; label: string }[];

// 这个文件里给人看的文字称呼 Lead 时写 Lead 的名字。这些纯函数离组件太远，读最近一次取到的名字（leadNameNow）。
export function ticketRailEmptyCopy(
  state: Exclude<TicketRailState, 'populated'>,
): { title: string; body: string; actionLabel?: string } {
  const leadName = leadNameNow();
  return {
    loading: { title: '正在读取工单', body: `等待 ${leadName} 返回真实工单列表。` },
    first_use: { title: '还没有任务', body: `在中间对话里告诉 ${leadName} 目标，它会建工单并派 child 执行。` },
    all_completed: { title: '全部完成', body: '所有 child 已完成，暂无待办。有新目标随时告诉我。', actionLabel: '新建任务' },
    no_results: { title: '没有匹配的工单', body: '当前筛选或搜索条件下没有工单。', actionLabel: '清除筛选' },
  }[state];
}

// 分组就是「现在轮到谁」。Lead 的后台工作和已结束的工单默认收起。
function ticketGroupMetadata(id: TicketGroupId): Omit<TicketRailGroup, 'items' | 'count'> {
  const leadName = leadNameNow();
  const metadata: Record<TicketGroupId, Omit<TicketRailGroup, 'items' | 'count'>> = {
    needs_intervention: { id: 'needs_intervention', label: '等你', collapsible: true, collapsedByDefault: false },
    running: { id: 'running', label: '在执行', collapsible: true, collapsedByDefault: false },
    queued: { id: 'queued', label: '排队 · 没人在动', collapsible: true, collapsedByDefault: false },
    lead: { id: 'lead', label: `${leadName} 处理中`, collapsible: true, collapsedByDefault: false },
    background: { id: 'background', label: `${leadName} 后台`, collapsible: true, collapsedByDefault: true },
    completed: { id: 'completed', label: '已完成', collapsible: true, collapsedByDefault: true },
    cancelled: { id: 'cancelled', label: '已取消', collapsible: true, collapsedByDefault: true },
  };
  return metadata[id];
}

export const TICKET_GROUP_ORDER = [
  'needs_intervention', 'running', 'lead', 'queued', 'background', 'completed', 'cancelled',
] as const satisfies readonly TicketGroupId[];

const checkpointKindLabel: Record<CheckpointKind, string> = {
  progress: '进行中',
  milestone: '已完成阶段',
  decision: '方向调整',
  delegation: '已委派',
  blocked: '需要介入',
  completed: '执行完成，等待验收',
};

const interventionStateLabel: Record<InterventionState, string> = {
  pending: '需要你介入',
  resolved: '已解决',
  rejected: '已拒绝',
  dismissed: '已撤销',
  expired: '已过期',
};

export function resolveRailViewDirection(
  previous: RailView,
  next: RailView,
): RailViewDirection {
  if (previous === next) return 'none';
  return railViewOrder[next] > railViewOrder[previous] ? 'forward' : 'backward';
}

export function groupTicketsByProject(items: Ticket[]): Map<string, Ticket[]> {
  return items.reduce((groups, ticket) => {
    const project = ticket.project ?? 'unknown';
    const group = groups.get(project) ?? [];
    group.push(ticket);
    groups.set(project, group);
    return groups;
  }, new Map<string, Ticket[]>());
}

// ——— review 的六种语义（kernel spec §6.3 / 工单 #66 复盘）———
//
// 迁移前这里只有一句 `status === 'review' → '待验收'`。#66 证明了那句话的代价：一张
// 返工额度 1/1 已用尽、reviewer 的 FAIL 早已被之后的交付作废、最新交付从来没被核查过的
// 工单，和一张干干净净等人点头的工单，在界面上一模一样——而"验收通过"就在旁边。
// （更正：#66 当初被说成"成果快照登记不上"，那是把两次对话 Run 误当成交付。）所以卡片按 reviewState.state 分流，判据来自服务端同一份事实投影，
// UI 不自己推算；这里只负责把事实翻成人话，以及决定"验收通过"该不该带风险提示。
export type ReviewNoticeTone = 'info' | 'success' | 'attention' | 'danger';

export type ReviewNoticePresentation = {
  id: NonNullable<TicketSummary['reviewState']>['state'];
  tone: ReviewNoticeTone;
  title: string;
  body: string;
  facts: { label: string; value: string }[];
  /** 非 null 时，"验收通过"必须带上这句风险提示，不能当作一次普通的确认。 */
  acceptanceRisk: string | null;
};

const verificationText: Record<'pass' | 'fail' | 'unknown', string> = {
  pass: '通过（PASS）',
  fail: '不通过（FAIL）',
  unknown: '未知',
};

function reviewBudgetFact(
  review: NonNullable<TicketSummary['reviewState']>,
): { label: string; value: string }[] {
  if (review.reworkCyclesUsed === undefined || review.maxReworkCycles === undefined
      || review.maxReworkCycles === null) {
    return [];
  }
  return [{ label: '已用返工次数', value: `${review.reworkCyclesUsed}/${review.maxReworkCycles}` }];
}

/** 作废的核查：它是谁、核查的是哪次交付、被哪次交付作废（F9）。 */
export function supersededReviewText(review: NonNullable<TicketSummary['reviewState']>): string | null {
  const superseded = review.supersededReview;
  if (!superseded) return null;
  return [
    `Run #${superseded.reviewerAttemptId} · ${superseded.verdict.toUpperCase()}`,
    superseded.reviewedRunId === null ? null : `核查的是 Run #${superseded.reviewedRunId}`,
    superseded.supersededByRunId === null ? '已作废' : `已被 Run #${superseded.supersededByRunId} 作废`,
  ].filter(Boolean).join(' · ');
}

function reviewHashFacts(review: NonNullable<TicketSummary['reviewState']>): { label: string; value: string }[] {
  // 哈希描述的是某一次核查看到的工作区。没有当前有效的核查时，它不是当前事实，不显示。
  if (review.reviewerAttemptId === null) return [];
  const state = review.reviewerHashState;
  if (state === undefined && review.reviewerPreHash === undefined && review.reviewerPostHash === undefined) return [];
  const short = (value: string | null | undefined) => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '缺失';
  if (state === 'matching' || state === 'drifted') return [
    { label: '工作区完整性', value: state === 'matching' ? 'pre/post hash 一致' : 'pre/post hash 不一致' },
    { label: '核查快照', value: `${short(review.reviewerPreHash)} → ${short(review.reviewerPostHash)}` },
  ];
  if (state === 'missing') return [{ label: '工作区完整性', value: '缺少 reviewer hash' }];
  return [{ label: '工作区完整性', value: '未知' }];
}

export function buildReviewNoticePresentation(
  ticket: Pick<Ticket, 'status' | 'reviewState' | 'acceptancePolicy'>,
): ReviewNoticePresentation | null {
  const review = ticket.reviewState;
  if (ticket.status !== 'review' || !review) return null;
  const verification = verificationText[review.verdict ?? 'unknown'];
  const facts = [
    { label: '当前验证状态', value: verification },
    ...(review.reviewerAttemptId === null
      ? []
      : [{ label: '核查 Run', value: `#${review.reviewerAttemptId}` }]),
    ...(supersededReviewText(review) ? [{ label: '上次核查', value: supersededReviewText(review)! }] : []),
    ...reviewBudgetFact(review),
    ...reviewHashFacts(review),
  ];
  const base = { id: review.state, facts, body: review.reason ?? '' };

  switch (review.state) {
    case 'rework_exhausted':
      return {
        ...base,
        tone: 'danger',
        title: review.outcomeRecoveryFailed
          ? '这张工单卡住了，不是在等你验收'
          : '返工额度已用尽，自动化已停止',
        body: review.reason
          ?? '自动返工已停止，且当前没有可验收的核查结论。',
        // 按钮不删。用户仍然是唯一能拍板的人——把入口拿掉，就是把用户锁在自己的闸门外面，
        // 而这正是本仓库反复修的那个错。改的是它的分量：默认动作变成需要承担风险的动作。
        acceptanceRisk: `当前验证状态为${verification}，`
          + `${review.outcomeRecoveryFailed ? '最后一次执行没有登记任何成果快照，' : ''}`
          + '现在点"验收通过"等于在没有通过证据的情况下结单。',
      };
    case 'evidence_conflict':
      return {
        ...base,
        tone: 'danger',
        title: '证据冲突，需要你判断',
        body: review.reason ?? '核查报告与产物证据互相矛盾，自动化已停手。',
        acceptanceRisk: '核查证据自相矛盾，验收前请先确认以哪一份为准。',
      };
    case 'review_failed':
      return {
        ...base,
        tone: 'attention',
        title: '独立核查不通过',
        body: review.reason ?? '核查未通过，等待返工。',
        acceptanceRisk: null,
      };
    case 'review_passed':
      return {
        ...base,
        tone: 'success',
        // 还停在 review 的 PASS 就是在等用户验收：托管的 PASS 会在出结论时直接结单。
        title: '核查通过，等待你验收',
        body: review.reason ?? '独立核查已通过。',
        acceptanceRisk: null,
      };
    case 'waiting_user':
      return {
        ...base,
        tone: 'info',
        title: '等待你验收',
        body: review.reason ?? '这张工单没有独立核查，由你判断是否完成。',
        acceptanceRisk: null,
      };
    default:
      return {
        ...base,
        tone: 'info',
        title: review.label,
        body: review.reason ?? '执行已结束，独立核查尚未给出结论。',
        // 核查还没有结论就点验收，等于替 reviewer 下结论。提示但不拦。
        acceptanceRisk: '独立核查尚未给出结论，现在验收等于跳过核查。',
      };
  }
}

/** review 卡死态：stage 还是 review，但它并不在等人验收。 */
export function isReviewDeadlocked(
  ticket: Pick<Ticket, 'status' | 'reviewState'>,
): boolean {
  return ticket.status === 'review' && ticket.reviewState?.state === 'rework_exhausted';
}

function leadHandlingLabel(): string {
  return `${leadNameNow()} 处理中`;
}
// 和 protocol 的 ticketNeedsUserLabel('decision') 同一个说法。
const PENDING_DECISION_LABEL = ticketNeedsUserLabel('decision');

export function isRuntimeRecoveryActive(
  ticket: { executionState?: TicketSummary['executionState'] },
): boolean {
  return ticket.executionState?.kind === 'recovery' && [
    'requested', 'waiting_dispatch', 'starting', 'running',
  ].includes(ticket.executionState.state);
}

// 「需要我」只看共用的规则，不在这里另算一遍（底栏和导航角标数的也是它）。
function isTodoTicket(ticket: Ticket): boolean {
  return ticket.needsUser != null;
}

function ticketMatchesQuery(ticket: Ticket, query: string): boolean {
  if (!query) return true;
  return [
    ticket.id,
    ticket.displayTitle,
    ticket.title,
    ticket.summary,
    ticket.project ?? 'unknown',
    ticket.agentLabel,
    ticket.runtimeName,
    ticket.runtimeLabel,
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}

function ticketMatchesFilter(ticket: Ticket, filter: TicketFilter): boolean {
  if (filter === 'running') return ticket.turn === 'running';
  if (filter === 'queued') return ticket.turn === 'queued';
  if (filter === 'todo') return isTodoTicket(ticket);
  return true;
}

// 导出是为了让分组规则能被直接测到。分组只看 ticketTurn（protocol），不在这里按 stage 另写一套：
// 以前这里把 ready 算成「进行中」，于是没有 Run 的工单和真在跑的并排，会话底栏却写「执行中 0」。
export function groupForTicket(ticket: Ticket): TicketGroupId {
  // 终态优先：历史上的提醒和计数器不能把已结束的工单拉回来。
  if (ticket.status === 'cancelled') return 'cancelled';
  if (ticket.turn === 'ended') return 'completed';
  if (ticket.turn === 'user') return 'needs_intervention';
  if (ticket.turn === 'running') return 'running';
  // Lead 正在处理的异常（leadHandling）也是 Lead 的回合，进「Lead 处理中」，不标红。
  if (ticket.turn === 'lead') return ticket.background ? 'background' : 'lead';
  return 'queued';
}

export function buildTicketRailPresentation(
  allItems: Ticket[],
  options: { filter: TicketFilter; query?: string; loading?: boolean; project?: TicketProjectScope | null },
): TicketRailPresentation {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  // 从项目 tab 点进来时只看这个项目。筛选条上的数字也只数这个项目，和项目 tab 一样。
  const projectScope = options.project ?? null;
  const items = projectScope ? allItems.filter((ticket) => ticketInProject(ticket, projectScope)) : allItems;
  const filterCounts = {
    all: items.length,
    todo: items.filter(isTodoTicket).length,
    running: items.filter((ticket) => ticket.turn === 'running').length,
    queued: items.filter((ticket) => ticket.turn === 'queued').length,
  };

  if (options.loading) {
    return { state: 'loading', groups: [], filterCounts, totalCount: items.length, todoCount: filterCounts.todo };
  }
  if (allItems.length === 0) {
    return { state: 'first_use', groups: [], filterCounts, totalCount: 0, todoCount: 0 };
  }
  if (!query && options.filter === 'all' && items.every((ticket) => ticket.status === 'done')) {
    return { state: 'all_completed', groups: [], filterCounts, totalCount: items.length, todoCount: 0 };
  }

  const filteredItems = items.filter((ticket) => ticketMatchesFilter(ticket, options.filter) && ticketMatchesQuery(ticket, query));
  if (filteredItems.length === 0) {
    return { state: 'no_results', groups: [], filterCounts, totalCount: items.length, todoCount: filterCounts.todo };
  }

  const groupItems = new Map<TicketGroupId, Ticket[]>(TICKET_GROUP_ORDER.map((id) => [id, []]));
  for (const ticket of filteredItems) groupItems.get(groupForTicket(ticket))!.push(ticket);

  const groups = TICKET_GROUP_ORDER
    .map((id): TicketRailGroup => {
      const grouped = groupItems.get(id)!;
      return {
        ...ticketGroupMetadata(id),
        count: grouped.length,
        items: grouped,
      };
    })
    .filter((group) => group.items.length > 0);

  return { state: 'populated', groups, filterCounts, totalCount: items.length, todoCount: filterCounts.todo };
}

export function formatCompactElapsed(elapsedMs: number | null | undefined): string | null {
  if (elapsedMs === null || elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 60_000) return '<1m';
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 48) return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function projectTicketSecondaryMeta(ticket: Ticket): string[] {
  const elapsed = formatCompactElapsed(ticket.elapsedMs);
  return [ticket.agentLabel, ticket.runtimeName, ticket.runtimeLabel, elapsed].filter((value): value is string => Boolean(value));
}

export function buildInterventionPresentation(authority: InterventionAuthority): InterventionPresentation {
  const actions: InterventionActionPresentation[] = [];
  if (authority.state === 'pending' && authority.canRespond) {
    if (authority.kind === 'approval') {
      actions.push(
        { id: 'reject', label: '拒绝', tone: 'secondary' },
        { id: 'approve_once', label: '授权本次', tone: 'primary' },
      );
      if (authority.allowSessionApproval) actions.push({ id: 'approve_session', label: '本会话允许', tone: 'secondary' });
    } else {
      for (const option of authority.options ?? []) {
        actions.push({ id: `option:${option.id}`, label: option.label, tone: actions.length === 0 ? 'primary' : 'secondary' });
      }
      if (authority.allowCustom) actions.push({ id: 'custom', label: '其他决定', tone: 'secondary' });
    }
  }

  let resolutionText: string | undefined;
  if (authority.state === 'resolved' || authority.state === 'rejected' || authority.state === 'dismissed') {
    resolutionText = [resolvedByLabel(authority.resolvedBy, leadNameNow()), authority.resolutionLabel ?? (authority.state === 'rejected' ? '已拒绝' : '已解决')]
      .filter(Boolean)
      .join(' · ');
  } else if (authority.state === 'expired') {
    resolutionText = authority.expiryExplanation ?? `操作已过期，请等待 ${leadNameNow()} 重新评估。`;
  }

  return {
    id: authority.id,
    kind: authority.kind,
    state: authority.state,
    // 等你处理的介入和收件箱、状态标签同一种说法：「待你决定」「待审批」（2026-10-16）。
    stateLabel: authority.state === 'pending'
      ? ticketNeedsUserLabel(authority.kind === 'approval' ? 'approval' : 'decision')
      : interventionStateLabel[authority.state],
    tone: authority.state === 'pending'
      ? 'attention'
      : authority.state === 'resolved'
        ? 'success'
        : authority.state === 'rejected'
          ? 'danger'
          : 'muted',
    ...(authority.prompt ? { prompt: authority.prompt } : {}),
    ...(resolutionText ? { resolutionText } : {}),
    actions,
  };
}

// 历史事件只描述事件本身（AGENTS.md 核心不变量）。"需要介入""执行完成，等待验收""进行中"说的是
// 现在；只有那条记录确实就是工单当前所处的状态时才用它们，其余的改用描述事件的说法（F14）。
// #66 上两个月前的崩溃一直挂着"需要介入"，而工单早已在 review。
// 诊断键值里没有信息的取值（Failure scope unknown、Needs none）。
const UNINFORMATIVE_FACT = /^(?:unknown|none|n\/a|-)?$/i;

const historicalCheckpointKindLabel: Partial<Record<CheckpointKind, string>> = {
  progress: '进展',
  blocked: '当时阻塞',
  completed: '已提交验收',
};

function latestCheckpointIdOf(checkpoints: CheckpointPresentationInput[], kind?: CheckpointKind): string | undefined {
  return checkpoints.filter((checkpoint) => !kind || checkpoint.kind === kind).sort(compareCheckpointRecency)[0]?.id;
}

/** 进展记录需要的那部分 Run 事实（features/tickets/runFacts.ts）。 */
export type CheckpointRunFacts = ReadonlyMap<number, { purpose: string; blockedTicket: boolean }>;

function checkpointKindLabelFor(
  checkpoint: CheckpointPresentationInput,
  checkpoints: CheckpointPresentationInput[],
  ticketStatus: TicketStatus | undefined,
  deliveryRunId: number | null | undefined,
  runs: CheckpointRunFacts | undefined,
): string {
  if (ticketStatus === undefined) return checkpointKindLabel[checkpoint.kind];
  // 「当时阻塞」只给真让工单阻塞过的 Run。#66 上对话 Run #71 崩溃了，工单一直在 review：那是一次没有回答的对话。
  const run = checkpoint.kind === 'blocked' && checkpoint.attemptId !== null && checkpoint.attemptId !== undefined
    ? runs?.get(checkpoint.attemptId)
    : undefined;
  if (run && !run.blockedTicket) return run.purpose === 'conversation' ? '对话失败' : '运行失败';
  // "执行完成，等待验收"只属于正在等待验收的那次交付。#66 上它挂在两个月前 Run #42 的提交记录上，
  // 而在等验收的是 Run #49。
  const sameDelivery = deliveryRunId === undefined || deliveryRunId === null || checkpoint.attemptId === deliveryRunId;
  const current = checkpoint.kind === 'blocked'
    ? ticketStatus === 'blocked' && latestCheckpointIdOf(checkpoints, 'blocked') === checkpoint.id
    : checkpoint.kind === 'completed'
      ? ticketStatus === 'review' && sameDelivery && latestCheckpointIdOf(checkpoints, 'completed') === checkpoint.id
      : checkpoint.kind === 'progress'
        ? ticketStatus === 'active' && latestCheckpointIdOf(checkpoints) === checkpoint.id
        : true;
  return current ? checkpointKindLabel[checkpoint.kind] : historicalCheckpointKindLabel[checkpoint.kind] ?? checkpointKindLabel[checkpoint.kind];
}

export function buildCheckpointFeedPresentation(
  checkpoints: CheckpointPresentationInput[],
  interventions: Record<string, InterventionAuthority>,
  resource: CheckpointFeedResource = { state: 'ready' },
  context: { ticketStatus?: TicketStatus; deliveryRunId?: number | null; runs?: CheckpointRunFacts } = {},
): CheckpointFeedPresentation {
  const items = checkpoints
    .map((checkpoint): CheckpointPresentation => {
      const authority = checkpoint.interventionId ? interventions[checkpoint.interventionId] : undefined;
      const kindLabel = checkpointKindLabelFor(checkpoint, checkpoints, context.ticketStatus, context.deliveryRunId, context.runs);
      const historical = kindLabel !== checkpointKindLabel[checkpoint.kind];
      // 「下一步」说的是现在要做什么。过去的记录不再有下一步：#66 上它们是写给 agent 的提示和早已作废的指令。
      // 系统记的「Run started」的下一步一直是写给 agent 的（"Answer the ticket-scoped conversation…"），也不显示。
      const { nextStep, keyFacts, ...rest } = checkpoint;
      const informativeFacts = keyFacts?.filter((fact) => !UNINFORMATIVE_FACT.test(fact.value.trim()));
      const agentInstruction = checkpoint.source === 'system_derived' && checkpoint.kind === 'progress';
      return {
        ...rest,
        ...systemCheckpointText(checkpoint),
        ...(historical || agentInstruction || !nextStep ? {} : { nextStep }),
        ...(informativeFacts && informativeFacts.length > 0 ? { keyFacts: informativeFacts } : {}),
        kindLabel,
        ...(historical ? { historical: true } : {}),
        ...(authority ? { intervention: buildInterventionPresentation(authority) } : {}),
      };
    })
    .sort((left, right) => {
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (Number.isSafeInteger(leftId) && Number.isSafeInteger(rightId)) return rightId - leftId;
      return right.id.localeCompare(left.id, undefined, { numeric: true });
    });

  if (items.length > 0) {
    return {
      state: 'ready',
      items,
      ...(resource.state === 'error' && resource.error ? { pageError: resource.error } : {}),
    };
  }
  if (resource.state === 'loading') return { state: 'loading', items: [] };
  if (resource.state === 'disconnected') return { state: 'disconnected', items: [] };
  if (resource.state === 'error') return { state: 'error', items: [], ...(resource.error ? { pageError: resource.error } : {}) };
  return { state: 'empty', items: [] };
}

export function checkpointToPresentation(checkpoint: KernelCheckpoint): CheckpointPresentationInput {
  const attemptLabel = checkpoint.attemptId === null ? '' : ` #${checkpoint.attemptId}`;
  const sourceLabel = checkpoint.source === 'system_derived'
    ? '系统记录'
    : `${checkpoint.author.runtime ?? checkpoint.author.kind} ${checkpoint.author.kind}${attemptLabel} 汇报`;
  const actionRef = checkpoint.actionRef;
  const interventionId = actionRef === null
    ? undefined
    : actionRef.type === 'approval'
      ? `approval:${actionRef.id}`
      : `decision:${actionRef.id}`;
  return {
    id: String(checkpoint.id),
    ...(checkpoint.attemptId === null ? {} : { attemptId: checkpoint.attemptId }),
    source: checkpoint.source,
    sourceLabel,
    createdAt: checkpoint.createdAt,
    kind: checkpoint.kind,
    ...(checkpoint.stage ? { stage: checkpoint.stage } : {}),
    title: checkpoint.title,
    summary: checkpoint.summary,
    ...(checkpoint.keyFacts.length > 0 ? { keyFacts: checkpoint.keyFacts } : {}),
    ...(checkpoint.artifactRefs.length > 0 ? {
      artifactRefs: checkpoint.artifactRefs.map((id) => ({ id, label: id })),
    } : {}),
    ...(checkpoint.relatedTicketIds.length > 0 ? {
      relatedTicketIds: checkpoint.relatedTicketIds.map(String),
    } : {}),
    ...(checkpoint.nextStep ? { nextStep: checkpoint.nextStep } : {}),
    ...(interventionId ? { interventionId } : {}),
  };
}

export function interventionToAuthority(
  intervention: KernelIntervention,
  canRespond: boolean,
): InterventionAuthority {
  const pending = intervention.state === 'pending';
  const state: InterventionState = intervention.state === 'approved'
    ? 'resolved'
    : intervention.state;
  let resolutionLabel: string | undefined;
  if (intervention.resolution) {
    if (intervention.kind === 'approval') {
      resolutionLabel = intervention.resolution.decision === 'approve_session'
        ? '本会话已允许'
        : intervention.resolution.decision === 'approve'
          ? '已授权本次'
          : '已拒绝';
    } else if (intervention.resolution.kind === 'option') {
      resolutionLabel = intervention.options.find((option) => option.id === intervention.resolution?.optionId)?.label
        ?? intervention.resolution.optionId
        ?? '已选择';
    } else if (intervention.resolution.kind === 'text') {
      resolutionLabel = intervention.resolution.text ?? '已回复';
    } else {
      resolutionLabel = '已撤销';
    }
  }
  return {
    id: intervention.id,
    kind: intervention.kind === 'approval' ? 'approval' : 'decision',
    state,
    canRespond: canRespond && pending && intervention.actions.length > 0,
    ...(intervention.detail ? { prompt: intervention.detail } : {}),
    ...(intervention.kind === 'approval'
      ? { allowSessionApproval: intervention.actions.includes('approve_session') }
      : {
          allowCustom: intervention.allowCustom && intervention.actions.some((action) => action.kind === 'respond'),
          options: intervention.options.map((option) => ({ id: option.id, label: option.label })),
        }),
    ...(intervention.resolvedBy ? { resolvedBy: intervention.resolvedBy } : {}),
    ...(resolutionLabel ? { resolutionLabel } : {}),
    ...(state === 'expired' ? { expiryExplanation: `操作已过期，请等待 ${leadNameNow()} 重新评估。` } : {}),
  };
}

export function interventionActionRequest(
  interventionId: string,
  actionId: InterventionActionId,
  customResponse?: string,
): ResolveKernelInterventionRequest {
  if (interventionId.startsWith('approval:')) {
    if (actionId === 'approve_once') return { authority: 'approval', decision: 'approve' };
    if (actionId === 'approve_session') return { authority: 'approval', decision: 'approve_session' };
    if (actionId === 'reject') return { authority: 'approval', decision: 'reject' };
    throw new Error(`unsupported approval action: ${actionId}`);
  }
  if (!interventionId.startsWith('decision:')) throw new Error(`unsupported intervention: ${interventionId}`);
  if (actionId.startsWith('option:')) {
    return { authority: 'decision_request', decision: 'select', optionId: actionId.slice('option:'.length) };
  }
  if (actionId === 'custom') {
    const resolution = customResponse?.trim();
    if (!resolution) throw new Error('custom decision response is required');
    return { authority: 'decision_request', decision: 'respond', resolution };
  }
  throw new Error(`unsupported decision action: ${actionId}`);
}

export function resourceToCheckpointFeedResource(
  phase: ControlPlanePhase,
  resource: Pick<ResourceLoadState, 'state' | 'error'> | undefined,
  connectionState?: ConnectionState,
): CheckpointFeedResource {
  if (
    (connectionState !== undefined && connectionState !== 'connected') ||
    (connectionState === undefined && phase !== 'ready')
  ) {
    if (resource?.state === 'ready' || resource?.state === 'stale') return { state: 'disconnected' };
  }
  if (resource?.state === 'error') {
    return { state: 'error', ...(resource.error ? { error: resource.error } : {}) };
  }
  if (resource?.state === 'ready' || resource?.state === 'stale') return { state: 'ready' };
  if (resource?.state === 'unsupported') return { state: 'error', error: '当前内核不支持 Checkpoint 资源。' };
  return { state: 'loading' };
}

export function buildTicketDetailPresentation(
  ticket: Ticket,
  options: { timing?: { elapsedMs: number | null | undefined }; artifactCapability: ArtifactCapability; artifactCount?: number },
): TicketDetailPresentation {
  const elapsed = formatCompactElapsed(options.timing?.elapsedMs ?? ticket.elapsedMs);
  const properties: TicketPropertyPresentation[] = [];
  if (ticket.project) properties.push({ id: 'project', label: '项目', value: ticket.project });
  if (ticket.agentLabel) properties.push({ id: 'agent', label: '执行 agent', value: ticket.agentLabel });
  if (ticket.runtimeName) properties.push({ id: 'runtime', label: '执行引擎', value: ticket.runtimeName });
  if (ticket.sessionId) properties.push({ id: 'session', label: '会话 ID', value: ticket.sessionId });
  properties.push({ id: 'elapsed', label: '耗时', value: elapsed ?? '尚未开始' });

  let artifactState: ArtifactPresentationState;
  if (options.artifactCapability === 'loading') {
    artifactState = { kind: 'loading', title: '正在读取产物', body: '等待内核返回真实 Artifact 资源。' };
  } else if (options.artifactCapability === 'unsupported') {
    artifactState = { kind: 'unsupported', title: '产物能力尚未接入', body: '当前内核还没有可读取的 Artifact 资源，不会从文件路径伪造产物。' };
  } else if ((options.artifactCount ?? 0) === 0) {
    artifactState = { kind: 'empty', title: '还没有产物', body: 'child 提交真实 Artifact 后会显示在这里。' };
  } else {
    artifactState = { kind: 'available', title: `${options.artifactCount} 个产物`, body: '真实 Artifact 已由内核返回。' };
  }

  return { tabs: TICKET_DETAIL_TABS, properties, artifactState };
}

// 两台状态机各自的取值都要有标签（kernel spec §6.1/§6.2）：少一半就会在提醒页面
// 显示 undefined。
const statusLabel: Record<TicketStatus, string> = {
  draft: '待确认', ready: '待开始', active: '进行中', blocked: '阻塞',
  review: '待验收', done: '完成', cancelled: '已取消',
  scheduled: '已排期', fired: '已提醒', acked: '已确认',
};

export function ticketStatusLabel(status: TicketStatus): string {
  return statusLabel[status];
}

const priorityLabel: Record<TicketSummary['priority'], string> = {
  urgent: '紧急', high: '高', normal: '普通', low: '低',
};

const runtimeLabel: Record<TicketSummary['runtime']['state'], string> = {
  idle: '空闲', starting: '启动中', running: '运行中', stale: '停滞', blocked: '需介入',
};

const workflowRuntimeLabel: Partial<Record<NonNullable<TicketSummary['workflowState']>, string>> = {
  waiting_dependency: '等待依赖',
  waiting_capability: '等待能力部署',
  continuing: '续作中',
};

export function ticketSummaryToTicket(ticket: TicketSummary, workItem?: KernelTicketWorkItem | KernelTicketWorkItemV2): Ticket {
  const execution = workItem?.activeExecution;
  const progress = workItem && 'progress' in workItem ? workItem.progress : null;
  const recoveryInProgress = isRuntimeRecoveryActive(ticket);
  // Lead 正在处理、也没有升级给用户：阻塞和失败先不算「需要你」，和 protocol 的 ticketNeedsUser 一致。
  // 用户欠着一个决定（审批、核查不通过、返工用完……）时，任何标签都不写「Lead 处理中」（2026-10-15 #66）。
  const leadHandling = ticket.attention.leadHandling === true && ticket.attention.blockerCount === 0
    && ticketNeedsUser(ticket) === null;
  const attention = ticket.attention.pendingApprovalCount > 0 ||
    (ticket.attention.blockerCount > 0 && !recoveryInProgress);
  // rework_exhausted 必须算"需要你介入"：它是自动化停手后没人接手的状态，
  // 而 blockerCount 恰恰可能是 0（Lead 已经把 inbox 消费掉了，#66 就是这样）。
  // 要求独立核查的工单，交付进了 review 却没有核查会来，不由用户派发就永远停在那里。
  // 由用户自己验收的工单也能派核查，但那只是可选动作，不算"需要你介入"。
  const reviewNeedsAttention = ticket.reviewState?.state === 'review_failed'
    || ticket.reviewState?.state === 'evidence_conflict'
    || ticket.reviewState?.state === 'rework_exhausted'
    || (ticket.reviewState?.state === 'independent_review' && ticket.reviewState.canRequestReview === true);
  const executionNeedsAttention = !leadHandling
    && (ticket.executionState?.state === 'blocked' || ticket.executionState?.state === 'failed');
  const executionHeartbeat = ticket.executionState?.state === 'starting' || ticket.executionState?.state === 'running';
  // 等你回答的决定压过其他说法（2026-10-16）：会话里的工单卡、决定卡的工单头、列表和详情都写「待你决定」。
  const pendingDecisionCount = ticket.attention.pendingDecisionCount ?? 0;
  const projectedStatusLabel = pendingDecisionCount > 0
    ? PENDING_DECISION_LABEL
    : leadHandling && !recoveryInProgress
    ? leadHandlingLabel()
    : ticket.executionState?.kind === 'rework' || ticket.executionState?.kind === 'recovery'
      ? ticket.executionState.label
      : ticket.reviewState?.label ?? statusLabel[ticket.stage];
  return {
    id: String(ticket.id),
    title: ticket.title,
    ...(ticket.displayTitle ? { displayTitle: ticket.displayTitle } : {}),
    ...(ticket.stageChangedAt ? { stageChangedAt: ticket.stageChangedAt } : {}),
    ...(ticket.nextMilestone ? { nextMilestone: ticket.nextMilestone } : {}),
    summary: ticket.summary,
    kind: ticket.kind,
    ...(ticket.workflowKind ? { workflowKind: ticket.workflowKind } : {}),
    // 不再重映射：stage 就是 stage（kernel spec §5 的命名映射表）。
    status: ticket.stage,
    statusLabel: projectedStatusLabel,
    hasRun: ticket.hasRun,
    ...(ticket.workspace ? { workspace: ticket.workspace } : {}),
    priority: ticket.priority,
    priorityLabel: priorityLabel[ticket.priority],
    ...(ticket.project === null ? {} : { project: ticket.project }),
    runtimeLabel: leadHandling && !recoveryInProgress
      ? leadHandlingLabel()
      : ticket.executionState?.label
        ?? workflowRuntimeLabel[ticket.workflowState ?? 'idle']
        ?? runtimeLabel[ticket.runtime.state],
    runtimeState: ticket.runtime.state,
    ...(ticket.workflowState && ticket.workflowState !== 'idle' ? { workflowState: ticket.workflowState } : {}),
    ...(ticket.verificationPolicy === undefined ? {} : { verificationPolicy: ticket.verificationPolicy }),
    ...(ticket.acceptancePolicy === undefined ? {} : { acceptancePolicy: ticket.acceptancePolicy }),
    ...(ticket.reworkPolicy === undefined ? {} : { reworkPolicy: ticket.reworkPolicy }),
    ...(ticket.deliveryPolicy === undefined ? {} : { deliveryPolicy: ticket.deliveryPolicy }),
    ...(ticket.reviewState ? { reviewState: ticket.reviewState } : {}),
    ...(ticket.executionState ? { executionState: ticket.executionState } : {}),
    ...(execution ? {
      runtimeName: execution.runtime,
      agentLabel: `child #${execution.attemptId}`,
      ...(execution.externalSessionId ? { sessionId: execution.externalSessionId } : {}),
    } : {}),
    // timing 现在是可选的：没有 Run 就整个不投（kernel spec §11）。
    // 直接读 workItem.timing.elapsedMs 对一条提醒会当场抛 TypeError。
    ...(workItem?.timing ? { elapsedMs: workItem.timing.elapsedMs } : {}),
    ...(progress === null ? {} : { progressPercent: progress.percent }),
    heartbeat: recoveryInProgress || executionHeartbeat || ticket.runtime.state === 'starting' || ticket.runtime.state === 'running',
    needsUser: ticketNeedsUser(ticket),
    ...(pendingDecisionCount > 0 ? { pendingDecisionCount } : {}),
    turn: ticketTurn(ticket),
    ...(ticket.worklistVisibility === 'background' ? { background: true } : {}),
    leadHandling,
    needsAttention: attention || ticket.runtime.state === 'stale' || (ticket.runtime.state === 'blocked' && !leadHandling)
      || ticket.workflowState === 'waiting_capability' || reviewNeedsAttention || executionNeedsAttention,
  };
}

// 会话里显示的工单标题：去掉开头方括号里的机器前缀，例如「[E2E #51 T48-…] FINAL #45 …」→「FINAL #45 …」。
// 整个标题都是方括号时原样保留。原标题在工单详情里（2026-10-15 方案 A）。
export function ticketDisplayTitle(ticket: Pick<Ticket, 'title' | 'displayTitle'>): string {
  // Lead 写的短标题（set_display_title）优先；没有时去掉原标题的机器前缀。
  if (ticket.displayTitle?.trim()) return ticket.displayTitle.trim();
  const stripped = ticket.title.replace(/^(?:\s*(?:\[[^\]]*\]|【[^】]*】))+\s*/u, '').trim();
  return stripped || ticket.title;
}

// 工单卡第二行的现状：在跑的 Run、runtime 和跑了多久，例如「Run #87 · Codex · 已 12 分钟」。
// 只用 TicketSummary 投影出来的数据，不用 Lead 写的话。没有在跑的东西时返回 null。
export function ticketNowLine(ticket: Ticket): string | null {
  if (!ticket.heartbeat) return null;
  const run = ticket.agentLabel?.replace(/^child #/, 'Run #') ?? null;
  const runtime = runtimeDisplayName(ticket.runtimeName);
  const minutes = ticket.elapsedMs !== null && ticket.elapsedMs !== undefined && ticket.elapsedMs >= 60_000
    ? `已 ${Math.floor(ticket.elapsedMs / 60_000)} 分钟`
    : null;
  const parts = [run, runtime, minutes].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : null;
}

export function formatTicketHeartbeatLabel(ticket: Ticket): string {
  if (isRuntimeRecoveryActive(ticket)) return ticket.executionState!.label;
  if (ticket.leadHandling && !ticket.needsAttention) return leadHandlingLabel();
  if (ticket.executionState?.state === 'blocked' || ticket.executionState?.state === 'failed') {
    return '需要你';
  }
  if (ticket.status === 'blocked') return '需要介入';
  if (ticket.status === 'review') {
    if (ticket.reviewState?.state === 'review_failed'
        || ticket.reviewState?.state === 'evidence_conflict'
        || ticket.reviewState?.state === 'rework_exhausted') {
      return '需要你';
    }
    if (ticket.reviewState) return ticket.reviewState.label;
    return ticket.progressPercent === undefined ? '待验收' : `待验收 · ${ticket.progressPercent}%`;
  }
  if (ticket.needsAttention) return '需要你';
  if (ticket.heartbeat && ticket.progressPercent !== undefined) return `心跳 · ${ticket.progressPercent}%`;
  if (ticket.heartbeat) return '心跳';
  return ticket.runtimeLabel;
}

export type TicketNextActionPresentation = {
  label: string;
  body: string;
  tone: 'info' | 'attention' | 'danger';
};

export type TicketAttentionReason =
  | 'review_failed'
  | 'evidence_conflict'
  | 'execution_failed'
  | 'execution_blocked'
  | 'merge_conflict'
  | 'workspace_failed'
  | 'workspace_blocked'
  | 'capability_waiting'
  | 'runtime_stale'
  | 'ticket_blocked'
  | 'user_attention';

/** One attention reason keeps the rail, inbox, and detail copy aligned. */
export function ticketAttentionReason(ticket: Ticket): TicketAttentionReason | null {
  if (ticket.status === 'done' || ticket.status === 'acked' || ticket.status === 'cancelled') return null;
  if (ticket.leadHandling && !ticket.needsAttention) return null;
  if (ticket.reviewState?.state === 'evidence_conflict') return 'evidence_conflict';
  if (ticket.reviewState?.state === 'review_failed' || ticket.reviewState?.state === 'rework_exhausted') return 'review_failed';
  if (ticket.executionState?.state === 'failed') return 'execution_failed';
  if (ticket.executionState?.state === 'blocked') return 'execution_blocked';
  if (ticket.workspace?.mergeStatus === 'conflict') return 'merge_conflict';
  if (ticket.workspace?.state === 'failed') return 'workspace_failed';
  if (ticket.workspace?.state === 'blocked') return 'workspace_blocked';
  if (ticket.workflowState === 'waiting_capability') return 'capability_waiting';
  if (ticket.runtimeLabel === '停滞' || ticket.runtimeLabel === '过期') return 'runtime_stale';
  if (ticket.status === 'blocked') return 'ticket_blocked';
  if (ticket.needsAttention) return 'user_attention';
  return null;
}

export function ticketNextActionPresentation(ticket: Ticket): TicketNextActionPresentation | null {
  if (ticket.status === 'done' || ticket.status === 'acked' || ticket.status === 'cancelled') return null;
  if (ticket.leadHandling && !ticket.needsAttention) {
    const leadName = leadNameNow();
    return { label: `${leadName} 正在处理`, body: `系统发现了异常，${leadName} 正在处理，处理完会告诉你。需要你时它会直接找你。`, tone: 'info' };
  }
  const attentionReason = ticketAttentionReason(ticket);
  if (attentionReason === 'execution_blocked' || attentionReason === 'execution_failed') {
    return { label: '需要你处理执行异常', body: ticket.executionState?.reason ?? '执行没有继续推进，请查看错误并选择恢复或停止。', tone: 'danger' };
  }
  if (attentionReason === 'evidence_conflict') {
    return { label: '需要你判断证据冲突', body: '核查结论与产物证据不一致，验收前请先确认依据。', tone: 'danger' };
  }
  if (attentionReason === 'review_failed') {
    return { label: '需要你决定是否返工', body: '独立核查未通过，当前不会自动修改这张工单。', tone: 'attention' };
  }
  if (attentionReason === 'merge_conflict') {
    return { label: '需要你处理合并冲突', body: '工作区变更无法自动合并，请先解决冲突或放弃变更。', tone: 'danger' };
  }
  if (attentionReason === 'workspace_failed' || attentionReason === 'workspace_blocked') {
    return { label: '需要你处理工作区异常', body: '工作区没有准备好，请查看错误后重新创建或恢复。', tone: 'danger' };
  }
  if (ticket.status === 'review') {
    return { label: '需要你验收', body: '执行已结束，请查看验收依据后通过或退回返工。', tone: 'attention' };
  }
  if (attentionReason || ticket.status === 'draft') {
    return { label: '需要你介入', body: ticket.summary || '这张工单暂时无法自动推进。', tone: 'attention' };
  }
  if (ticket.status === 'active' || ticket.status === 'ready') {
    return { label: '系统正在执行', body: `${leadNameNow()} 和 child 正在推进这张工单，暂时不需要你操作。`, tone: 'info' };
  }
  return null;
}

export function ticketRailCaption(ticket: Ticket): string {
  if (ticket.status === 'done' || ticket.status === 'acked') return `#${ticket.id} · 已完成`;
  if (ticket.status === 'cancelled') return `#${ticket.id} · 已取消`;
  if (isRuntimeRecoveryActive(ticket)) return `#${ticket.id} · ${ticket.executionState!.label}`;
  if (ticket.leadHandling && !ticket.needsAttention) return `#${ticket.id} · ${leadHandlingLabel()}`;
  if (ticket.status === 'review') {
    return `#${ticket.id} · ${ticket.statusLabel || '待验收'}${ticket.needsAttention ? ' · 需要处理' : ''}`;
  }
  const attentionReason = ticketAttentionReason(ticket);
  if (attentionReason === 'ticket_blocked') return `#${ticket.id} · 阻塞 · 需要介入`;
  if (attentionReason) return `#${ticket.id} · ${ticket.statusLabel || ticket.runtimeLabel} · 需要介入`;
  if (ticket.turn === 'queued') return `#${ticket.id} · 排队 · 没有 Run 在跑`;
  if (ticket.turn === 'lead') return `#${ticket.id} · ${ticket.background ? `${leadNameNow()} 后台` : ticket.statusLabel || leadHandlingLabel()}`;
  return `#${ticket.id} · ${ticket.agentLabel ?? 'child'} ${ticket.runtimeLabel === '运行中' ? '执行中' : ticket.runtimeLabel}`;
}

export function buildPowMetricPresentation(
  pow: Pick<KernelTicketPow, 'metrics'>,
  checkpoint?: { keyFacts?: KernelCheckpoint['keyFacts'] },
): PowMetricPresentation {
  const coverageFact = checkpoint?.keyFacts?.find((fact) => fact.label === '能力覆盖');
  const gapFact = checkpoint?.keyFacts?.find((fact) => fact.label === '发现缺口');
  const coverage = coverageFact?.value.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  const gaps = gapFact?.value.match(/^\s*(\d+)\s*$/);
  return {
    coverage: coverage ? `${coverage[1]}/${coverage[2]}` : `${pow.metrics.passed}/${pow.metrics.total}`,
    gaps: gaps?.[1] ?? String(Math.max(0, pow.metrics.total - pow.metrics.passed)),
  };
}

export function resolveWorkspaceTickets(
  connected: boolean,
  liveTickets: TicketSummary[],
  workItems: (KernelTicketWorkItem | KernelTicketWorkItemV2)[] = [],
): Ticket[] {
  if (!connected) return [];
  const workItemsByTicket = new Map(workItems.map((item) => [item.ticketId, item]));
  // 列表只列根工单，后台的根工单也列（它们进默认收起的「Lead 后台」组）。子工单需要你时也列出来：
  // 它们算在「需要我」里，就得在收件箱里找得到（实例上的 #75：父工单已经完成，它自己还阻塞着）。
  return liveTickets
    .filter((ticket) => ticket.parentTicketId == null || ticketNeedsUser(ticket) !== null)
    .map((ticket) => ticketSummaryToTicket(ticket, workItemsByTicket.get(ticket.id)));
}

export function resolveWorkspaceTicket(
  connected: boolean,
  liveTickets: TicketSummary[],
  selectedTicketId: number | string | null,
  workItems: (KernelTicketWorkItem | KernelTicketWorkItemV2)[] = [],
): Ticket | undefined {
  if (!connected || selectedTicketId === null) return undefined;
  const summary = liveTickets.find((ticket) => String(ticket.id) === String(selectedTicketId));
  if (!summary) return undefined;
  const workItem = workItems.find((item) => item.ticketId === summary.id);
  return ticketSummaryToTicket(summary, workItem);
}

export function shouldShowWorkspaceBootShell(
  hydrated: boolean,
  phase: 'loading' | 'unpaired' | 'connecting' | 'ready' | 'error',
): boolean {
  return !hydrated || phase === 'loading' || phase === 'connecting';
}

export function buildWeek(referenceDate: string): WeekDay[] {
  const reference = new Date(`${referenceDate}T12:00:00`);
  const mondayOffset = (reference.getDay() + 6) % 7;
  const monday = new Date(reference);
  monday.setDate(reference.getDate() - mondayOffset);
  const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'];

  return weekdayLabels.map((weekdayLabel, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const isoDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return {
      isoDate,
      weekdayLabel,
      dateLabel: String(date.getDate()),
      isToday: isoDate === referenceDate,
    };
  });
}

// ——— 日程 ———

/** 本地日期 YYYY-MM-DD。日程按它分天。 */
export function localDateKey(value: Date): string {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}

