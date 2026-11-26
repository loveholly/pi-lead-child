import {
  ActionBar, Box, Button, canCopyText, Card, Checklist, ChoiceGroup, Column, ConfirmBar, copyText, Density, DockedLayout, FactList, FloatingSheet, Icon,
  Popover, Pressable, RecordRow, Row, ScrollArea, Section, Sheet, Steps, Text, TextField, Timeline, type FactItem,
  type ScrollEvent,
} from '@pi-lead-child/components';
import type {
  KernelArtifact, KernelOutcomeSnapshotResource, KernelTicketPow, TicketAcceptanceCriteria, TicketAction,
  TicketActionId as TicketOperationId, TicketActionRunRequest, TicketChatResume, TicketDelivery, TicketExecutionPlan,
  ReviewEvidence, TicketAttachment, TicketReplyActionId,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useLocale, useMessages, type Locale } from '@/i18n';

import { useLeadName } from '@/state/hooks';
import type { ArtifactDownloadState, InterventionCommandState, ResourceLoadState } from '@/state/types';
import {
  buildInterventionPresentation,
  pendingDecisionsHeldByLead,
  latestBlockedCheckpoint,
  type ArtifactCapability,
  type CheckpointFeedResource,
  type CheckpointPresentationInput,
  type CheckpointRunFacts,
  type InterventionActionId,
  type InterventionAuthority,
  type Ticket,
} from '@/features/workspace/model';
import { runtimeDisplayName } from '@/features/workspace/runtimeNames';

import type { DeliveryNumbers } from './deliveryNumbers';
import { InterventionPanel } from './InterventionPanel';
import type { LegacyTicketAction, LegacyTicketActionId } from './legacyTicketActions';
import type { TicketLogRunPresentation } from './LogTimeline';
import { TicketAttachmentStrip, TicketAttachmentViewer, type TicketAttachmentLoader } from './TicketAttachments';
import { evidenceSummary, ReviewEvidenceList } from './ReviewEvidence';
import { reviewEvidenceMessages } from './reviewEvidence.messages';
import { TicketChatDock, type TicketChatAction } from './TicketChatDock';
import {
  DetailAttributes, DetailSection, DetailTitle, DetailTopBar, FoldRow, MoreTrigger, PlaceholderLines, RelationRows, TaskBrief, TaskBriefSheetContent, TokenAttribute, TokenBreakdown, type TokenPart,
  type AttributeItem, type RelationRowItem,
} from './TicketDetailParts';
import { ticketDetailLayoutMessages } from './ticketDetailLayout.messages';
import type { TicketActionReceipt, TicketRunProgress } from './ticketChatStatus';
import { isTicketBlockedForActions, ticketDecision } from './ticketDecision';
import {
  DELIVERY_OPERATIONS,
  barCaption,
  briefPreview,
  childBadge,
  clockText,
  criteriaPresentation,
  criteriaSourceLabel,
  detailActionBar,
  detailSectionTitles,
  detailStage,
  durationText,
  findAction,
  headerMoreActions,
  integrationBadge,
  historyItems,
  nextStepText,
  planSteps,
  reviewWentAgainst,
  reviewerStatusLabels,
  sectionCollapsed,
  sourceLabels,
  splitRequestText,
  tokenText,
  costText,
  tokenSummary,
  usagePartsCaption,
  writerLabel,
  type ChildStage,
  type DetailSectionKind,
  type DetailStage,
  type ReviewerStatus,
  type UsageParts,
} from './ticketDetailSections';
import type { AttemptPresentation, LifecyclePresentation, RelationPresentation } from './ticketHistory';
import type { TicketLogPresentation } from './ticketLogs';
import { TicketRecords } from './TicketRecords';
import type { TicketStoryEntry } from './ticketStory';
import { ticketStateMessages } from './ticketState.messages';
import { ticketThreadMessages } from './ticketThread.messages';
import { ticketDetailMessages } from './ticketDetail.messages';
import { useRememberedSections } from './useRememberedSections';

export type { TicketLogPresentation } from './ticketLogs';

export type ChildTicketPresentation = {
  id: string;
  displayId: string;
  title: string;
  state: ChildStage;
  /** 谁拆的：Lead 建单时带 parent_ticket_id，或者执行 agent 在规划里拆的（4.2）。读不到时没有。 */
  createdBy?: 'lead' | 'child' | 'user' | 'system';
};

/** 一个角色（执行者、核查员）用的 runtime、模型和推理强度。 */
export type RunProfilePresentation = {
  runtime: string;
  model: string | null;
  effort: string | null;
};

/** 工单本身的事实（GET /v1/tickets/:id 和工作台），给「工单信息」和「用量」。 */
export type TicketDetailFacts = {
  createdAt: string;
  createdBy: 'user' | 'lead' | 'child' | 'system' | null;
  updatedAt: string;
  dueAt: string | null;
  totalTokens: number;
  totalCostUsd: number;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  // token 按计费拆开的几部分（GET /v1/tickets/:id/usage）。旧 daemon 没有这个接口时省略。
  usageParts?: UsageParts | null;
};

export type TicketOperationState = {
  pendingActionId: TicketOperationId | LegacyTicketActionId | null;
  error: string | null;
};

export type TicketThreadProps = {
  ticket: Ticket;
  onClose: () => void;
  standalone?: boolean;
  showComposer?: boolean;
  timing?: { elapsedMs: number | null | undefined; activeExecutionMs?: number | null; statusDurationMs?: number | null };
  checkpoints?: CheckpointPresentationInput[];
  checkpointResource?: CheckpointFeedResource;
  interventions?: Record<string, InterventionAuthority>;
  interventionCommandStates?: Record<string, InterventionCommandState>;
  artifacts?: KernelArtifact[];
  artifactCapability?: ArtifactCapability;
  artifactDownloadStates?: Record<number, ArtifactDownloadState>;
  pow?: KernelTicketPow | null;
  outcome?: KernelOutcomeSnapshotResource | null;
  taskDescription?: { brief: string; body: string };
  /** 工单附件（工单 #231，GET /v1/tickets/:id/attachments）：任务说明下面的缩略图。 */
  attachments?: readonly TicketAttachment[];
  /** 核查证据（工单 #503，GET /v1/tickets/:id/review-evidence）：验收标准和经过与记录之间的折叠行。 */
  reviewEvidence?: readonly ReviewEvidence[];
  onLoadReviewEvidence?: TicketAttachmentLoader;
  /** 取一个附件的内容（点开看大图、画缩略图）。 */
  onLoadAttachment?: TicketAttachmentLoader;
  logs?: TicketLogPresentation[];
  logRuns?: TicketLogRunPresentation[];
  messageIds?: readonly string[];
  childTickets?: ChildTicketPresentation[];
  lifecycle?: LifecyclePresentation[];
  attempts?: AttemptPresentation[];
  /** 每次 Run 的用途和结论（runFacts），进展记录按它写「当时阻塞」还是「对话失败」。 */
  runFacts?: CheckpointRunFacts;
  relations?: RelationPresentation[];
  executionResource?: ResourceLoadState;
  onRetryExecution?: () => void;
  onResolveIntervention?: (interventionId: string, actionId: InterventionActionId, customResponse?: string) => void;
  resolutionError?: string | null;
  onRetryCheckpoints?: () => void;
  onDownloadArtifact?: (artifactId: number) => void;
  onCancelArtifactDownload?: (artifactId: number) => void;
  onOpenTicket?: (ticketId: string) => void;
  onSendMessage?: (message: string, ticketId: string) => void;
  /** 底部的对话坞展开着（方案 D）。状态放在工作区 store 里：会话里的回执能直接打开对话。 */
  chatExpanded?: boolean;
  onChatExpandedChange?: (expanded: boolean) => void;
  /** 你看过的最后一条工单消息。之后来的回复标成新回复。 */
  chatSeenMessageId?: string | null;
  onChatSeen?: (messageId: string) => void;
  /** 你在这张工单上做的最近一个动作，对话坞的预览里给回执。 */
  chatReceipt?: TicketActionReceipt | null;
  /** 正在跑的那次 Run：对话坞里的实时进度。 */
  liveRun?: TicketRunProgress | null;
  /** 回答工单对话的 agent，例如 Claude Code。 */
  agentName?: string | null;
  /** 没有 Run 在跑时，工单消息续接的会话（工单 08）。输入框据此写预估成本。 */
  chatResume?: TicketChatResume | null;
  /** 「完整记录」打开着。手机上它在工单面板里；桌面上它占 Lead 会话栏（中间栏）。 */
  recordsOpen?: boolean;
  onRecordsOpenChange?: (open: boolean) => void;
  /** 「经过」（buildTicketStory）。 */
  story?: readonly TicketStoryEntry[];
  /** 这张工单现在能做的操作（GET /v1/tickets/:id/actions）。按钮能不能点只看它。 */
  actions?: readonly TicketAction[];
  /** 结构化验收标准（工单 05）。 */
  acceptanceCriteria?: TicketAcceptanceCriteria | null;
  /** 执行计划（工单 06）。undefined：还没读到；null：执行 agent 没有提交计划。 */
  executionPlan?: TicketExecutionPlan | null;
  /** 这次交付（工作区的分支、合没合并）。 */
  delivery?: TicketDelivery | null;
  /** 每次交付是第几次（deliveryNumbers.ts）。文字里的交付写「第 N 次交付」，不写执行记录的编号。 */
  deliveryNumbers?: DeliveryNumbers;
  facts?: TicketDetailFacts | null;
  executor?: RunProfilePresentation | null;
  /** 不要求独立核查的工单没有核查员（null）。 */
  reviewer?: (RunProfilePresentation & { status: ReviewerStatus }) | null;
  /** 执行一个工单操作（POST /v1/tickets/:id/actions/:action）。没连上时没有。 */
  onRunAction?: (action: TicketOperationId, request?: TicketActionRunRequest) => void;
  actionState?: TicketOperationState;
  /** 往工单对话的输入框里预填一句话，并展开对话（「拆成子工单」请 Lead 来拆，D9）。 */
  onPrefillChat?: (text: string) => void;
  /** 输入框的草稿被预填过：换一个值，输入框重新读草稿。 */
  composerRevision?: number;
  /**
   * 授权托管、撤销托管走的原来的接口。授权：清单里有 delegate（工单 11）时按清单走工单操作，这个只在清单里还没有
   * delegate 时用（旧 daemon）。撤销还不是工单操作。
   */
  onSetLeadDelegation?: (granted: boolean) => void;
  delegationActionState?: { pending?: boolean; error?: string | null };
  /** 操作清单读到了没有。读取中、读不到、这个连接读不了（unsupported）时，底部操作栏说出来。 */
  actionsStatus?: 'loading' | 'ready' | 'error' | 'unsupported';
  onRetryActions?: () => void;
  /** 这张工单的完整链接（头部「更多」里的复制链接）。 */
  ticketLink?: string;
  /** 还不在操作清单里的 4 个操作（恢复、开始执行、撤回确认、释放工作区），走旧接口（legacyTicketActions.ts）。 */
  legacyActions?: readonly LegacyTicketAction[];
  onLegacyAction?: (action: LegacyTicketActionId, options?: { restoreMode?: 'root_only' | 'review_tree' }) => void;
};

function noop() {}

// 回复下面的按钮（daemon 的快模型判断回复在问哪个动作）对应的工单操作。
const REPLY_OPERATIONS: Record<TicketReplyActionId, TicketOperationId | null> = {
  request_review: 'request_review',
  complete: 'complete',
  rework: 'rework',
  cancel: 'cancel',
  stop: 'stop_run',
  start: 'confirm',
  restore: null,
};

// 做之前要再确认一次的操作：对外的（开 PR）、收不回的（放弃改动）、停下正在做的事、带意见的返工。
// 验收在核查没有结论、或者核查没通过时也要再确认（choose 里判断）。
const CONFIRMED_OPERATIONS = new Set<string>(['open_pr', 'abandon', 'cancel', 'stop_run', 'rework']);

// 「更多」里要你写一段话才能做的操作：页面上还没有表单，先打开工单对话请 Lead 代你做（spec 5.11）。
// 预填的话在文案的 prefill 里。
type ThreadMessages = ReturnType<typeof ticketThreadMessages>;
const CHAT_OPERATIONS: Record<string, (m: ThreadMessages, ticketId: string) => string> = {
  edit_acceptance_criteria: (m, ticketId) => m.prefill.criteria(ticketId),
  // 放宽子 agent 的权限要写放宽到哪里（scope）。只属于你：Lead 在你这一轮里代你做。
  widen_grant: (m, ticketId) => m.prefill.widenGrant(ticketId),
};

// 工单详情（工单详情与验收 spec 第 3 节，第四轮画板 D4-running、D4-review-pass）。自上而下：
//   头部 → 关系 → 任务说明 · 验收标准 · 工单信息 → 执行 → 交付与验收 → 经过与记录 → 底部操作栏和工单对话坞。
// 页面只做组合：每块画什么由 ticketDetailSections 算，样式都在组件库里。
// 当前状态只从 TicketSummary 取；按钮能不能点只看操作清单（GET /v1/tickets/:id/actions）。
export function TicketThread({
  ticket,
  onClose,
  standalone = false,
  showComposer,
  timing,
  checkpoints = [],
  checkpointResource = { state: 'ready' },
  interventions = {},
  interventionCommandStates = {},
  artifacts = [],
  artifactCapability = 'unsupported',
  artifactDownloadStates = {},
  pow = null,
  outcome = null,
  taskDescription,
  attachments = [],
  onLoadAttachment,
  reviewEvidence = [],
  onLoadReviewEvidence,
  logs = [],
  logRuns = [],
  messageIds = [],
  childTickets = [],
  lifecycle = [],
  attempts = [],
  runFacts,
  relations = [],
  executionResource,
  onRetryExecution,
  onResolveIntervention,
  resolutionError = null,
  onRetryCheckpoints,
  onDownloadArtifact,
  onCancelArtifactDownload,
  onOpenTicket,
  onSendMessage,
  chatExpanded = false,
  onChatExpandedChange = noop,
  chatSeenMessageId = null,
  onChatSeen = noop,
  chatReceipt = null,
  liveRun = null,
  agentName = null,
  chatResume = null,
  recordsOpen = false,
  onRecordsOpenChange = noop,
  story = [],
  actions = [],
  acceptanceCriteria = null,
  executionPlan,
  delivery = null,
  deliveryNumbers,
  facts = null,
  executor = null,
  reviewer = null,
  onRunAction,
  actionState,
  onPrefillChat,
  composerRevision = 0,
  onSetLeadDelegation,
  delegationActionState,
  actionsStatus = 'ready',
  onRetryActions,
  ticketLink = '',
  legacyActions = [],
  onLegacyAction,
}: TicketThreadProps) {
  const leadName = useLeadName();
  const locale = useLocale();
  const m = useMessages(ticketThreadMessages);
  const layout = useMessages(ticketDetailLayoutMessages);
  const sources = sourceLabels(leadName, locale);
  const titles = detailSectionTitles(locale);
  const [remembered, remember] = useRememberedSections();
  const [headerCompact, setHeaderCompact] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [barMenuOpen, setBarMenuOpen] = useState(false);
  // 手机上从页面根上升起的面板：Token 明细、任务说明全文（面板不能画在滚动区里，见 TokenAttribute）。
  const [rootSheet, setRootSheet] = useState<'token' | 'brief' | null>(null);
  const [openAttachment, setOpenAttachment] = useState<TicketAttachment | null>(null);
  const [confirming, setConfirming] = useState<TicketAction | null>(null);
  // 恢复已取消的工单：先确认，有已取消的子工单时选恢复范围（旧接口，legacyTicketActions.ts）。
  const [restoring, setRestoring] = useState<LegacyTicketAction | null>(null);
  const [restoreMode, setRestoreMode] = useState<'review_tree' | 'root_only'>('review_tree');
  const [reworkReason, setReworkReason] = useState('');
  const showTicketComposer = showComposer ?? true;
  const displayId = ticket.displayId ?? ticket.id;
  const stage = detailStage(ticket.status);
  const recordsInline = standalone && recordsOpen;
  const pendingActionId = actionState?.pendingActionId ?? null;
  const agent = agentName ?? ticket.agentLabel ?? runtimeDisplayName(ticket.runtimeName);
  const titleText = ticket.title;

  const collapsed = (kind: DetailSectionKind) => sectionCollapsed(stage, kind, remembered);

  // 「下一步」：等你验收、受阻时用 ticketDecision 的那一句，和收件箱同一句话。
  const blockerCheckpoint = ticket.status === 'blocked' ? latestBlockedCheckpoint(checkpoints) : undefined;
  const decision = ticketDecision({
    ticket,
    outcome,
    timing,
    blocker: blockerCheckpoint ? { title: blockerCheckpoint.title, summary: blockerCheckpoint.summary } : null,
    liveRun,
    ...(deliveryNumbers ? { deliveryNumbers } : {}),
    leadName,
    locale,
  });
  const workspace = delivery?.workspace ?? null;
  const reviewAgainst = reviewWentAgainst(ticket);
  const bar = detailActionBar(stage, actions, { reviewAgainst });
  const next = nextStepText({
    stage,
    ticket,
    agentName: executor?.runtime ?? agent,
    stuck: isTicketBlockedForActions(ticket),
    paused: liveRun?.phase === 'paused',
    decisionHeadline: decision.headline,
    integration: workspace?.integration ?? null,
    pullRequestUrl: workspace?.pullRequestUrl ?? null,
    locale,
  });

  const openRecords = () => {
    onRecordsOpenChange(true);
    if (!standalone) onChatExpandedChange(true);
  };

  // 合并、开 PR、放弃改动带上你看到的那份交付：交付在你看过以后变了，服务端拒绝（409），不会做到别的提交上。
  // 交付还没读到时这三个不能点：不带 expectedHead 就做，可能做到你没看过的提交上（放弃改动还收不回）。
  const waitingForDelivery = (action: TicketAction) => DELIVERY_OPERATIONS.has(action.id) && !workspace;
  const deliveryInput = () => (workspace ? { expectedHead: workspace.head, expectedTarget: workspace.target } : {});
  const canRun = (action: TicketAction) => action.available && Boolean(onRunAction) && pendingActionId === null && !waitingForDelivery(action);

  const runAction = (action: TicketAction, request: TicketActionRunRequest = {}) => {
    if (!canRun(action) || !onRunAction) return;
    onRunAction(action.id as TicketOperationId, request);
  };

  const prefill = (text: string) => {
    onPrefillChat?.(text);
    onChatExpandedChange(true);
  };

  // 等验收时合并会顺带验收（delivery 的 acceptsTicket）：它和验收一样，要过下面的确认（审查 2026-10-22）。
  const accepts = (action: TicketAction) => action.id === 'complete' || (action.id === 'merge' && stage === 'review');
  // 验收前要再确认：核查员还没有结论（等于跳过核查），或者核查没有通过。
  const confirmsComplete = (action: TicketAction) => accepts(action)
    && (reviewAgainst || (reviewer !== null && reviewer.status !== 'done'));

  // 点一个按钮：要写一段话的打开工单对话，要再确认的先换成确认栏，其余的直接做。
  const choose = (action: TicketAction) => {
    if (!action.available) return;
    setBarMenuOpen(false);
    const chat = CHAT_OPERATIONS[action.id];
    if (chat) {
      prefill(chat(m, displayId));
      return;
    }
    if (!canRun(action)) return;
    if (CONFIRMED_OPERATIONS.has(action.id) || confirmsComplete(action)) {
      setReworkReason('');
      setConfirming(action);
      onChatExpandedChange(false);
      return;
    }
    runAction(action, DELIVERY_OPERATIONS.has(action.id) ? { input: deliveryInput() } : {});
  };

  const chooseLegacy = (action: LegacyTicketAction) => {
    setBarMenuOpen(false);
    if (!onLegacyAction || pendingActionId !== null) return;
    if (action.id === 'restore') {
      setRestoreMode('review_tree');
      setRestoring(action);
      onChatExpandedChange(false);
      return;
    }
    onLegacyAction(action.id);
  };

  const confirm = () => {
    if (!confirming) return;
    const action = confirming;
    setConfirming(null);
    const reason = reworkReason.trim();
    runAction(action, {
      ...(DELIVERY_OPERATIONS.has(action.id) ? { input: deliveryInput() } : {}),
      ...(reason ? { reason } : {}),
    });
  };

  // ── 头部（主题 11.21）──
  const headerActions = headerMoreActions(actions);
  // 要你处理的事：等你验收、受阻、草稿待确认、有等你回答的决定、有子工单等你，或者你正在确认一个操作。
  // 有的时候标题下面出决定卡；没有的时候不出卡片，工单的操作并进顶栏的「⋯」。
  const childrenWaiting = childTickets.filter((child) => child.state === 'review' || child.state === 'blocked');
  const pendingDecisionsEarly = Object.values(interventions).filter((intervention) => intervention.kind === 'decision' && intervention.state === 'pending');
  const ownDecision = stage === 'draft' || stage === 'review' || ticket.status === 'blocked' || ticket.needsUser != null
    || pendingDecisionsEarly.length > 0 || confirming !== null || restoring !== null || Boolean(actionState?.error)
    // 做完了还没合并：合并或开 PR 是你的事。操作清单读不到时也出卡，写原因、给重试。
    || (stage === 'done' && Boolean(bar.primary?.available))
    || (actions.length === 0 && (actionsStatus === 'error' || actionsStatus === 'unsupported'));
  const showDecisionCard = ownDecision || childrenWaiting.length > 0;
  // 不出决定卡时，工单的操作（包括旧接口的恢复、开始）并进顶栏的「⋯」，点了走和决定卡同一个入口（确认框照样出在决定卡里）。
  const menuActions = showDecisionCard ? [] : [
    ...[bar.primary, bar.secondary, ...bar.more].filter((action): action is TicketAction => action !== null).map((action) => ({
      id: action.id,
      label: action.label,
      detail: waitingForDelivery(action) ? m.deliveryLoading : actionNote(action, m),
      onPress: canRun(action) || (action.available && CHAT_OPERATIONS[action.id]) ? () => choose(action) : undefined,
    })),
    ...legacyActions.map((action) => ({
      id: action.id,
      label: action.label,
      detail: action.note ?? undefined,
      onPress: onLegacyAction && pendingActionId === null ? () => chooseLegacy(action) : undefined,
    })),
  ];
  const header = (
    <DetailTopBar
      phone={standalone}
      project={ticket.project ?? null}
      displayId={displayId}
      title={titleText}
      scrolled={headerCompact}
      onBack={onClose}
      onClose={standalone ? undefined : onClose}
      closeLabel={m.closeDetail}
      more={(
        <HeaderMenu
          link={ticketLink}
          actions={headerActions}
          pendingActionId={pendingActionId}
          onRun={(action, request) => runAction(action, request)}
          trigger={<MoreTrigger phone={standalone} />}
          phone={standalone}
          extra={menuActions}
        />
      )}
    />
  );
  // 手机上顶栏没有工单号，这一行总要写它；创建的人和时间还没读到时只写工单号。
  const creatorMeta = facts
    ? layout.meta(standalone ? displayId : null, creatorName(facts.createdBy, leadName, m), clockText(facts.createdAt, undefined, locale))
    : standalone ? layout.ticketId(displayId) : null;

  // ── 关系 ──
  const linkAction = findAction(actions, 'link');
  const unlinkAction = findAction(actions, 'unlink');
  // 子工单已经在上面的列表里；这里列父工单和相关工单。撤销了的关系不列。
  const relationLinks = relations.filter((relation) => relation.kind !== 'parent_of' && relation.active !== false);
  const hasRelations = childTickets.length > 0 || relationLinks.length > 0;
  // 工单详情（任务说明、关联、用量）还没读到：这几块先画同高的占位。
  const detailLoading = taskDescription === undefined;
  const cancelledChildren = childTickets.filter((child) => child.state === 'cancelled').length;
  // ── 任务说明 ──
  const brief = briefPreview(taskDescription?.brief ?? '');
  // ── 验收标准 ──
  const criteria = criteriaPresentation(acceptanceCriteria, locale);
  const confirmAction = findAction(actions, 'confirm_criterion');
  const unconfirmAction = findAction(actions, 'unconfirm_criterion');
  const deliverySequence = acceptanceCriteria?.delivery?.sequence;
  const toggleCriterion = (id: string, checked: boolean) => {
    const action = checked ? confirmAction : unconfirmAction;
    if (!action) return;
    runAction(action, { input: { criterionId: Number(id), ...(deliverySequence ? { deliverySequence } : {}) } });
  };
  const canToggleCriteria = criteria.compare && (confirmAction?.available || unconfirmAction?.available) && pendingActionId === null;
  const criteriaSection = (
    <FoldRow
      testID="ticket-section-criteria"
      title={titles.criteria}
      summary={criteria.summary}
      source={criteriaSourceLabel(acceptanceCriteria, leadName, locale)}
      open={!collapsed('criteria')}
      onToggle={(open) => remember('criteria', !open)}
    >
      {criteria.empty ? (
        <Text size="secondary" tone="secondary">{m.noCriteria}</Text>
      ) : (
        <Checklist
          testID="ticket-criteria"
          items={criteria.items}
          // 没有核查员的工单（只由你验收）不画核查员那一列：那一列只会是一排「—」，还把标准的文字挤窄（2026-11-15）。
          columns={criteria.compare && reviewer ? [{ label: sources.reviewer, emptyLabel: m.reviewerNoVerdict }] : []}
          checkColumn={criteria.compare ? m.you : undefined}
          onToggle={canToggleCriteria ? toggleCriterion : undefined}
          checkLabel={(_item, index) => m.confirmCriterion(index + 1)}
        />
      )}
    </FoldRow>
  );

  // ── 核查证据（工单 #503）──
  // 核查员截的图，标明对应哪几条标准。排在验收标准和经过与记录（里面有交付）之间；没有证据时不画。
  const evidenceMessages = reviewEvidenceMessages(locale);
  const evidenceSection = reviewEvidence.length ? (
    <FoldRow
      testID="ticket-section-evidence"
      title={titles.evidence}
      summary={evidenceSummary(reviewEvidence, new Map((acceptanceCriteria?.criteria ?? []).map((criterion) => [criterion.id, { number: criterion.number, text: criterion.text }])), evidenceMessages)}
      source={sources.reviewer}
      open={!collapsed('evidence')}
      onToggle={(open) => remember('evidence', !open)}
    >
      <ReviewEvidenceList evidence={reviewEvidence} criteria={acceptanceCriteria} load={onLoadReviewEvidence} />
    </FoldRow>
  ) : null;

  // ── 工单信息 ──
  const delegated = ticket.acceptancePolicy === 'delegated_to_lead';
  // 托管（spec 4.3、5.8）：托管了给「撤销托管」，没托管给「授权托管」。
  // 授权：清单里有 delegate（工单 11）时，能不能点、为什么不能点都按清单。旧 daemon 的清单里没有 delegate：
  // 退回原来的授权接口，只给要求独立核查的工单（不要求独立核查的工单不提供托管，spec 5.8）。
  const delegateAction = findAction(actions, 'delegate');
  const delegationBusy = delegationActionState?.pending ?? false;
  const delegationEntry: Pick<FactItem, 'action' | 'detail'> = delegated
    ? onSetLeadDelegation
      ? { action: { label: delegationBusy ? m.working : m.revokeDelegation, onPress: () => onSetLeadDelegation(false), disabled: delegationBusy, testID: 'lead-delegation-revoke' } }
      : {}
    : delegateAction
      ? {
          action: {
            label: pendingActionId === delegateAction.id ? m.working : m.grantDelegation,
            onPress: () => runAction(delegateAction, { input: { maxReworkCycles: 1 } }),
            disabled: !canRun(delegateAction),
            testID: 'lead-delegation-grant',
          },
          ...(delegateAction.available ? {} : { detail: delegateAction.reason ?? m.cannotDelegate }),
        }
      : ticket.verificationPolicy === 'independent_reviewer' && onSetLeadDelegation
        ? { action: { label: delegationBusy ? m.working : m.grantDelegation, onPress: () => onSetLeadDelegation(true), disabled: delegationBusy, testID: 'lead-delegation-grant' } }
        : {};
  const infoItems: FactItem[] = [
    ...(facts ? [{ label: m.created, value: m.createdValue(creatorName(facts.createdBy, leadName, m), clockText(facts.createdAt, undefined, locale)) }] : []),
    ...(facts ? [{ label: m.updated, value: clockText(facts.updatedAt, undefined, locale) }] : []),
    { label: m.dueAndReminders, value: facts?.dueAt ? clockText(facts.dueAt, undefined, locale) : m.none, ...delegatedEntry(actions, 'set_due', m.set, () => prefill(m.prefill.due(displayId))) },
    { label: m.budget, value: budgetText(facts, m), ...delegatedEntry(actions, 'set_budget', m.set, () => prefill(m.prefill.budget(displayId))) },
    { label: m.acceptance, value: acceptanceText(ticket, leadName, m), ...delegationEntry },
  ];
  // ── 执行 ──
  const changeReviewer = findAction(actions, 'change_reviewer');
  const profileItems: FactItem[] = [
    {
      label: m.executor,
      value: profileText(executor ?? (ticket.runtimeName ? { runtime: runtimeDisplayName(ticket.runtimeName) ?? ticket.runtimeName, model: null, effort: null } : null), m),
      ...delegatedEntry(actions, 'set_run_profile' as TicketOperationId, m.changeProfile, () => prefill(m.prefill.runProfile(displayId))),
    },
    ...(reviewer ? [{
      label: m.reviewer,
      value: `${profileText(reviewer, m)} · ${reviewerStatusLabels(locale)[reviewer.status]}`,
      ...(changeReviewer?.available ? {
        action: { label: m.changeReviewer, align: 'end' as const, onPress: () => prefill(m.prefill.reviewer(displayId)), testID: 'ticket-change-reviewer' },
      } : {}),
    }] : []),
  ];
  const steps = planSteps(executionPlan, locale);
  // ── 交付与验收（内容在工单 13 做）──
  const latestOutcome = outcome?.latest ?? null;
  // ── 经过与记录 ──
  // 画布 M3：页面在这里收尾，收起时写最近的一件事。交付、工单信息（截止、预算、验收方式、执行者）都在展开以后，
  // 每次执行的日志在「完整记录」里。
  const latestStory = story.at(-1);
  const historySection = (
    <FoldRow
      testID="ticket-section-history"
      title={titles.history}
      summary={latestStory ? `${clockText(latestStory.at, undefined, locale)} ${latestStory.title}` : m.eventCount(0)}
      open={!collapsed('history')}
      onToggle={(open) => remember('history', !open)}
    >
      <Card overflow="hidden">
        <Section testID="ticket-history-story" variant="part" divider={false} title={m.story} source={sources.system}>
          {story.length > 0
            ? <Timeline testID="ticket-history-timeline" variant="compact" items={historyItems(story, undefined, locale)} />
            : <Text size="secondary" tone="secondary">{m.noStory}</Text>}
        </Section>
        {latestOutcome ? (
          <Section testID="ticket-delivery-summary" variant="part" title={m.whatWasDone} source={sources.child}
            summary={deliverySummary(stage, latestOutcome, acceptanceCriteria?.delivery ?? null, m, locale)}>
            <Text size="body" numberOfLines={4}>{latestOutcome.summary}</Text>
          </Section>
        ) : null}
        <Section testID="ticket-section-info" variant="part" title={titles.info} source={sources.system}>
          <FactList variant="labeled" items={[
            ...infoItems, ...profileItems,
            ...(ticket.workflowKind === 'coding' && ticket.workspace ? [workspaceFact(stage, ticket, workspace, m, locale)] : []),
          ]} />
          {delegationActionState?.error ? <Text role="alert" size="note" tone="danger-dark">{delegationActionState.error}</Text> : null}
        </Section>
        <RecordRow
          divider
          testID="ticket-records-open"
          title={m.fullRecords}
          meta={m.fullRecordsMeta}
          onPress={openRecords}
          pressIcon="arrow-up-right"
          accessibilityLabel={m.openFullRecords}
        />
      </Card>
    </FoldRow>
  );

  // 等你回答的决定直接放在最上面：收件箱「查看」打开的就是这里（2026-10-16）。
  const pendingDecisions = Object.values(interventions)
    .filter((intervention) => intervention.kind === 'decision' && intervention.state === 'pending');
  // 先交给 Lead、还没摆给你的决定（#561）：和会话卡片、列表一样写「Lead 处理中」，不写「待你决定」。
  const decisionsHeldByLead = pendingDecisionsHeldByLead(ticket);

  // ── 底部操作栏 ──
  // 清单读取中、读不到时说出来：不能只是没有按钮（审查 2026-10-22）。读不到时次要按钮的位置给「重试」。
  const actionsCaption = actions.length > 0
    ? null
    : actionsStatus === 'loading'
      ? m.actionsLoading
      : actionsStatus === 'error'
        ? m.actionsError
        : actionsStatus === 'unsupported' ? m.actionsUnsupported : null;
  const retryButton = actions.length === 0 && actionsStatus === 'error' && onRetryActions
    ? { label: m.retry, onPress: onRetryActions, tone: 'neutral' as const, testID: 'ticket-actions-retry' }
    : undefined;
  const deliveryCaption = [bar.primary, bar.secondary].some((action) => action?.available && waitingForDelivery(action))
    ? m.deliveryLoading
    : null;
  const barButton = (action: TicketAction | null, slot: 'primary' | 'secondary') => action ? {
    label: pendingActionId === action.id ? `${action.label}…` : action.label,
    onPress: () => choose(action),
    disabled: !canRun(action) && !(action.available && CHAT_OPERATIONS[action.id]),
    tone: action.id === 'cancel' || action.id === 'abandon' ? 'danger' as const : slot === 'primary' ? 'accent' as const : 'neutral' as const,
    testID: `ticket-bar-${action.id}`,
  } : undefined;
  const actionBar = (
    <ActionBar
      testID="ticket-action-bar"
      // 决定卡里的操作条（主题 T-7）：胶囊按钮，不排满一行。
      buttons="compact"
      // 决定卡上面已经用大字写了结论（T-7）；「下一步」是同一句时不再写一遍。
      next={next === decision.headline ? undefined : next}
      caption={actionState?.error ?? actionsCaption ?? deliveryCaption ?? barCaption(bar, acceptanceCriteria, locale)}
      primary={barButton(bar.primary, 'primary')}
      secondary={barButton(bar.secondary, 'secondary') ?? retryButton}
      more={bar.more.length + legacyActions.length > 0 ? {
        label: m.moreActions([...bar.more, ...legacyActions].map((action) => action.label)),
        onPress: () => setBarMenuOpen(true),
        testID: 'ticket-bar-more',
      } : undefined}
      confirm={restoring ? (
        <ConfirmBar
          testID="ticket-confirm"
          title={restoring.label === ticketStateMessages(locale).continueRestore ? m.restoreGroup : m.restoreOne}
          note={restoring.note ?? undefined}
          confirmLabel={restoring.label}
          busy={pendingActionId !== null}
          onConfirm={() => {
            setRestoring(null);
            onLegacyAction?.('restore', { restoreMode: cancelledChildren > 0 && ticket.status !== 'draft' ? restoreMode : 'review_tree' });
          }}
          onCancel={() => setRestoring(null)}
        >
          {cancelledChildren > 0 && ticket.status !== 'draft' ? (
            <ChoiceGroup
              variant="radio"
              accessibilityLabel={m.restoreScope}
              value={restoreMode}
              onSelect={(mode) => setRestoreMode(mode === 'root_only' ? 'root_only' : 'review_tree')}
              options={[
                { id: 'review_tree', label: m.restoreTree, description: m.restoreTreeDetail(cancelledChildren) },
                { id: 'root_only', label: m.restoreRoot, description: m.restoreRootDetail },
              ]}
            />
          ) : null}
        </ConfirmBar>
      ) : confirming ? (
        <ConfirmBar
          testID="ticket-confirm"
          title={confirmTitle(confirming, reviewer, reviewAgainst, accepts(confirming), m)}
          details={confirming.id === 'open_pr' && workspace ? [
            { label: m.push, value: workspace.branch ?? m.pushBranch, mono: true },
            { label: m.target, value: workspace.target ?? m.originalBranch, mono: true },
          ] : []}
          note={confirmNote(confirming, reviewAgainst, accepts(confirming), m)}
          confirmLabel={confirming.label}
          tone={confirming.irreversible || confirming.id === 'cancel' ? 'danger' : 'accent'}
          busy={pendingActionId !== null}
          onConfirm={confirm}
          onCancel={() => setConfirming(null)}
        >
          {confirming.id === 'rework' ? (
            <TextField
              testID="ticket-rework-reason"
              value={reworkReason}
              onChangeText={setReworkReason}
              placeholder={m.reworkPlaceholder}
              multiline
            />
          ) : null}
        </ConfirmBar>
      ) : undefined}
    />
  );

  // 回复下面的按钮：回复在问的动作 ∩ 现在能做的操作，和底部操作栏走同一个入口。
  const chatActions: TicketChatAction[] = (Object.keys(REPLY_OPERATIONS) as TicketReplyActionId[]).flatMap((replyId) => {
    const operation = REPLY_OPERATIONS[replyId];
    const action = operation ? findAction(actions, operation) : null;
    if (!action) return [];
    return [{
      id: replyId,
      label: action.label,
      tone: action.id === 'cancel' ? 'danger' : 'neutral',
      recommended: action.id === bar.primary?.id,
      disabled: !canRun(action),
    }];
  });
  const chooseFromChat = (replyId: TicketReplyActionId) => {
    const operation = REPLY_OPERATIONS[replyId];
    const action = operation ? findAction(actions, operation) : null;
    if (action) choose(action);
  };

  // ── 新版式的各块（主题 11.21，2026-11-14）──
  // 决定卡：只在有要你处理的事时出现，白底悬浮。第一行是琥珀点和状态词，第二行是结论，下面是操作（确认栏也在这里）。
  // 父工单自己没有决定、但有子工单等你时，卡片转达那张子工单。
  const relayChild = !ownDecision ? childrenWaiting[0] ?? null : null;
  const decisionCard = showDecisionCard ? (
    <Card testID="ticket-decision-card" variant="float" p="card" gap="card-row">
      <Row items="center" gap="icon-label">
        <Box w={7} h={7} rounded="full" bg="warning" />
        <Text size="label" weight="semibold" tone="warning-dark">
          {relayChild ? layout.childWaiting(childrenWaiting.length) : ticket.statusLabel}
        </Text>
      </Row>
      {relayChild ? (
        <>
          <Text size="sheet-title" weight="semibold">{relayChild.title}</Text>
          {onOpenTicket ? (
            <Row>
              <Button testID="ticket-decision-open-child" label={layout.openTicket(relayChild.displayId)} shape="pill" size="sm" onPress={() => onOpenTicket(relayChild.id)} />
            </Row>
          ) : null}
        </>
      ) : (
        <>
          {decision.headline ? <Text size="sheet-title" weight="semibold">{decision.headline}</Text> : null}
          {pendingDecisions.length > 0 ? (
            <Column testID="ticket-pending-decision" gap="stacked-card">
              {pendingDecisions.map((intervention) => (
                <InterventionPanel
                  key={intervention.id}
                  intervention={buildInterventionPresentation(intervention, locale, { heldByLead: decisionsHeldByLead })}
                  commandState={interventionCommandStates[intervention.id]}
                  onResolve={onResolveIntervention}
                />
              ))}
            </Column>
          ) : null}
          {actionBar}
        </>
      )}
    </Card>
  ) : null;

  // 属性：两列的小表。草稿是项目、优先级、执行者；开跑以后是状态、项目、已执行、成本，再加一整行的 Token。
  const statusTone = ticket.status === 'active' ? 'accent' as const : ticket.status === 'done' ? 'success-dark' as const
    : ticket.status === 'blocked' || ticket.status === 'review' ? 'warning-dark' as const : 'secondary' as const;
  const executorText = profileText(executor ?? (ticket.runtimeName ? { runtime: runtimeDisplayName(ticket.runtimeName) ?? ticket.runtimeName, model: null, effort: null } : null), m);
  const attributeItems: AttributeItem[] = stage === 'draft'
    ? [
        ...(ticket.project ? [{ key: 'project', label: layout.project, value: ticket.project }] : []),
        { key: 'priority', label: layout.priority, value: ticket.priorityLabel },
        { key: 'executor', label: layout.executor, value: executorText },
      ]
    : [
        { key: 'status', label: layout.status, value: ticket.statusLabel, tone: statusTone },
        ...(ticket.project ? [{ key: 'project', label: layout.project, value: ticket.project }] : []),
        { key: 'ran', label: layout.ran, value: durationText(timing?.activeExecutionMs, locale) ?? '-' },
        { key: 'cost', label: layout.cost, value: facts?.totalCostUsd ? costText(facts.totalCostUsd) : '-' },
      ];
  if (facts?.dueAt) attributeItems.push({ key: 'due', label: layout.due, value: clockText(facts.dueAt, undefined, locale) });
  const tokens = stage === 'draft' ? null : tokenSummary(facts?.usageParts);
  // Token 一行（主题 T-8）：有拆分时写缓存、未缓存；没有拆分（旧的用量）时写总数。都有圆圈里的 i，点了看明细。
  const parts = facts?.usageParts ?? null;
  const usageLabels = ticketDetailMessages(locale).usage;
  const tokenParts: TokenPart[] = parts ? [
    { key: 'cache-read', label: usageLabels.cacheRead, value: tokenText(parts.cacheReadTokens, locale), weight: parts.cacheReadTokens, color: 'success' },
    { key: 'cache-write', label: usageLabels.cacheWrite, value: tokenText(parts.cacheWriteTokens, locale), weight: parts.cacheWriteTokens, color: 'success-line' },
    { key: 'uncached', label: usageLabels.uncachedInput, value: tokenText(parts.uncachedInputTokens, locale), weight: parts.uncachedInputTokens, color: 'accent' },
    { key: 'output', label: usageLabels.output, value: tokenText(parts.outputTokens, locale), weight: parts.outputTokens, color: 'text' },
    ...(parts.unsplitTokens > 0 ? [{ key: 'unsplit', label: layout.unsplit, value: tokenText(parts.unsplitTokens, locale), weight: parts.unsplitTokens, color: 'border-strong' as const }] : []),
  ] : [];
  const tokenCaption = parts ? usagePartsCaption(parts, locale) : usageLabels.captionParts;
  const tokenRow = stage !== 'draft' && detailLoading ? (
    // 用量还没读到：Token 这一行先占住，读到以后不把下面的块往下推。
    <>
      <Text w={44} size="label" tone="muted">{layout.tokens}</Text>
      <Box flex={1}><PlaceholderLines lines={1} lineHeight={28} /></Box>
    </>
  ) : stage !== 'draft' && facts?.totalTokens ? (
    <TokenAttribute
      onShowDetails={standalone ? () => setRootSheet('token') : undefined}
      summary={tokens ? { cached: tokenText(tokens.cached, locale), uncached: tokenText(tokens.uncached, locale), percent: tokens.cachedPercent } : null}
      total={tokenText(facts.totalTokens, locale)}
      parts={tokenParts}
      caption={tokenCaption}
    />
  ) : null;

  // 关联工单：子工单和别的关联在一起，按状态分组。
  const childRowState = (state: ChildStage): RelationRowItem['state'] => (
    state === 'review' || state === 'blocked' ? 'waiting' : state === 'running' ? 'running' : state === 'waiting' ? 'queued' : state);
  const relatedRowState = (relation: RelationPresentation): RelationRowItem['state'] => {
    switch (relation.relatedStage) {
      case 'active': return 'running';
      case 'review': case 'blocked': return 'waiting';
      case 'done': case 'acked': return 'done';
      case 'cancelled': return 'cancelled';
      case null: case undefined: return null;
      default: return 'queued';
    }
  };
  const relationItems: RelationRowItem[] = [
    ...childTickets.map((child) => ({
      key: `child-${child.id}`,
      testID: `child-ticket-${child.id}`,
      ticketId: child.displayId,
      title: child.title,
      relation: null,
      state: childRowState(child.state),
      stateLabel: childBadge(child.state, locale).label,
      onPress: onOpenTicket ? () => onOpenTicket(child.id) : undefined,
    })),
    ...relationLinks.map((relation) => ({
      key: `${relation.kind}-${relation.ticketId}`,
      testID: `ticket-relation-${relation.ticketId}`,
      ticketId: String(relation.ticketId),
      title: relation.title ?? `#${relation.ticketId}`,
      relation: relation.label,
      state: relatedRowState(relation),
      stateLabel: relation.stateLabel || null,
      onPress: onOpenTicket ? () => onOpenTicket(String(relation.ticketId)) : undefined,
      action: unlinkAction && relation.relationId ? (
        <Pressable testID={`ticket-relation-${relation.ticketId}-action`} aria-label={m.unlink(relation.ticketId)} disabled={!canRun(unlinkAction)} feedback="opacity"
          onPress={() => runAction(unlinkAction, { input: { relationId: relation.relationId! }, reason: m.unlinkReason })}>
          <Icon name="close" size={12} color="text-secondary" />
        </Pressable>
      ) : undefined,
    })),
  ];
  const childDone = childTickets.filter((child) => child.state === 'done').length;
  const segments = childTickets.map((child) => (child.state === 'done' || child.state === 'cancelled' ? 'done' as const
    : child.state === 'running' ? 'running' as const : child.state === 'review' || child.state === 'blocked' ? 'waiting' as const : 'queued' as const));
  const relationsBlock = (
    <DetailSection
      testID="ticket-section-relations"
      title={layout.relations}
      count={hasRelations ? relationItems.length : undefined}
      aside={childTickets.length > 0 ? <Text size="label" tone="muted">{layout.childProgress(childDone, childTickets.length)}</Text> : undefined}
      gap="text-stack"
    >
      {!hasRelations && detailLoading ? <PlaceholderLines testID="ticket-relations-placeholder" lines={2} lineHeight={30} /> : hasRelations ? (
        <RelationRows
          items={relationItems}
          childDone={childDone}
          childTotal={childTickets.length}
          segments={segments}
          footer={linkAction ? (
            <Row pt="text-stack">
              <Button testID="ticket-link-open" label={m.linkTicket} variant="link" size="xs" onPress={() => setLinkFormOpen(true)} disabled={!linkAction.available} />
            </Row>
          ) : undefined}
        />
      ) : (
        <Row items="baseline" gap="inline-item" flexWrap="wrap">
          <Text size="secondary" tone="secondary">{m.noChildren}</Text>
          <Button testID="ticket-split-request" label={m.split} variant="link" size="xs" onPress={() => prefill(splitRequestText(displayId, locale))} disabled={!onPrefillChat} />
          <Text size="secondary" tone="secondary">·</Text>
          <Text size="secondary" tone="secondary">{m.noRelations}</Text>
          {linkAction ? (
            <Button testID="ticket-link-open" label={m.linkTicket} variant="link" size="xs" onPress={() => setLinkFormOpen(true)} disabled={!linkAction.available} />
          ) : null}
        </Row>
      )}
      {linkFormOpen && linkAction ? (
        <LinkTicketForm
          action={linkAction}
          pending={pendingActionId === 'link'}
          onCancel={() => setLinkFormOpen(false)}
          onSubmit={(request) => {
            setLinkFormOpen(false);
            runAction(linkAction, request);
          }}
        />
      ) : null}
    </DetailSection>
  );

  // 任务说明：在关联工单和执行计划之间。最多 6 行，渐隐，「展开全文」。附件跟在下面。
  // 详情还没读到（taskDescription 是 undefined）：先画任务说明的占位，6 行正文加「展开全文」那一行。
  const taskBlock = taskDescription === undefined ? (
    <DetailSection testID="ticket-section-task" title={titles.task}>
      <PlaceholderLines testID="ticket-task-placeholder" lines={7} lineHeight={24} />
    </DetailSection>
  ) : brief.full || attachments.length ? (
    <DetailSection testID="ticket-section-task" title={titles.task} aside={<Text size="label" tone="muted">{writerLabel(facts?.createdBy, leadName, locale)}</Text>}>
      {brief.full ? <TaskBrief markdown={brief.full} expanded={briefOpen} onExpandInline={setBriefOpen} onOpenSheet={() => setRootSheet('brief')} /> : null}
      <TicketAttachmentStrip attachments={attachments} load={onLoadAttachment} onOpen={setOpenAttachment} />
    </DetailSection>
  ) : null;

  // 执行计划：每步一行。执行中展开；草稿阶段（都没开始）收成一行。
  // 跳过的步骤不算进分母（和 planSummary、engine 的 executionPlanText 一样）。
  const planCounted = (executionPlan?.steps ?? []).filter((step) => step.status !== 'skipped');
  const planDone = planCounted.filter((step) => step.status === 'done').length;
  const planAside = steps.length ? layout.planUpdated(planDone, planCounted.length, null) : undefined;
  const planBlock = stage === 'draft'
    ? (steps.length ? (
        <FoldRow testID="ticket-section-plan" title={layout.plan} summary={planAside} open={!collapsed('execution')} onToggle={(open) => remember('execution', !open)}>
          <Steps variant="compact" items={steps} />
        </FoldRow>
      ) : null)
    : (
        <DetailSection testID="ticket-section-plan" title={layout.plan} aside={planAside ? <Text size="label" tone="muted" mono>{planAside}</Text> : undefined}>
          {steps.length > 0
            ? <Steps variant="compact" items={steps} />
            : executionPlan === undefined
              ? <PlaceholderLines testID="ticket-plan-placeholder" lines={3} lineHeight={28} />
              : <Text size="secondary" tone="secondary">{m.noPlan}</Text>}
        </DetailSection>
      );

  // 决定卡「⋯」里的各行：手机面板和桌面 Sheet 用不同的行组件，内容相同。
  const barMenuRows = (Item: typeof RecordRow | typeof SheetMenuRow) => (
    <>
        {bar.more.map((action, index) => (
          <Item
            key={action.id}
            testID={`ticket-bar-menu-${action.id}`}
            divider={index > 0}
            title={action.label}
            detail={waitingForDelivery(action) ? m.deliveryLoading : actionNote(action, m, reviewAgainst && accepts(action))}
            onPress={canRun(action) || CHAT_OPERATIONS[action.id] ? () => choose(action) : undefined}
          />
        ))}
        {legacyActions.map((action, index) => (
          <Item
            key={action.id}
            testID={`ticket-bar-menu-${action.id}`}
            divider={bar.more.length + index > 0}
            title={action.label}
            detail={action.note ?? undefined}
            onPress={onLegacyAction && pendingActionId === null ? () => chooseLegacy(action) : undefined}
          />
        ))}
    </>
  );

  const onScroll = (event: ScrollEvent) => setHeaderCompact(event.nativeEvent.contentOffset.y > 24);

  return (
    // 手机上单独打开时也是白底，和桌面的详情栏一样。底部的「更多」面板（Sheet）盖住整个详情栏。
    <Column testID="ticket-thread" flex={1} minW={0} bg="surface">
      {header}
      <DockedLayout
        testID="ticket-thread-body"
        expanded={chatExpanded}
        // 对话坞回到会话的密度：工单详情外面是 <Density zone="ticket">（ConnectedTicketThread）。
        dock={showTicketComposer ? (
          <Density zone="conversation"><TicketChatDock
            ticketId={Number(ticket.id)}
            ticketDisplayId={displayId}
            messageIds={messageIds}
            expanded={chatExpanded}
            onExpandedChange={onChatExpandedChange}
            seenMessageId={chatSeenMessageId}
            onSeen={onChatSeen}
            receipt={chatReceipt}
            liveRun={liveRun}
            agentName={agent}
            runtimeName={ticket.runtimeName ?? null}
            chatResume={chatResume}
            onSendMessage={onSendMessage ? (message) => onSendMessage(message, ticket.id) : undefined}
            actions={confirming ? [] : chatActions}
            onAction={chooseFromChat}
            composerRevision={composerRevision}
          /></Density>
        ) : null}
      >
        {recordsInline ? (
          <TicketRecords
            variant="panel"
            onClose={() => onRecordsOpenChange(false)}
            ticket={ticket}
            checkpoints={checkpoints}
            checkpointResource={checkpointResource}
            interventions={interventions}
            interventionCommandStates={interventionCommandStates}
            onResolveIntervention={onResolveIntervention}
            resolutionError={resolutionError}
            onRetryCheckpoints={onRetryCheckpoints}
            onOpenTicket={onOpenTicket}
            runFacts={runFacts}
            pow={pow}
            outcome={outcome}
            deliveryNumbers={deliveryNumbers}
            attempts={attempts}
            logs={logs}
            logRuns={logRuns}
            lifecycle={lifecycle}
            executionResource={executionResource}
            onRetryExecution={onRetryExecution}
            artifacts={artifacts}
            artifactCapability={artifactCapability}
            artifactDownloadStates={artifactDownloadStates}
            onDownloadArtifact={onDownloadArtifact}
            onCancelArtifactDownload={onCancelArtifactDownload}
          />
        ) : (
          <ScrollArea testID="ticket-thread-scroll" fillContent onScroll={onScroll}>
            <Column testID="ticket-detail-sections" px="page-x" pt="card-row" pb="page-bottom" gap="detail-section">
              <DetailTitle title={titleText} meta={creatorMeta} />
              {decisionCard}
              {resolutionError ? <Text role="alert" size="note" tone="danger-dark">{resolutionError}</Text> : null}
              <DetailAttributes items={attributeItems} token={tokenRow} />
              <Column>
                {relationsBlock}
              </Column>
              {taskBlock}
              {planBlock}
              <Column>
                {criteriaSection}
                {evidenceSection}
                {historySection}
              </Column>
            </Column>
          </ScrollArea>
        )}
      </DockedLayout>
      <TicketAttachmentViewer attachment={openAttachment} load={onLoadAttachment} onClose={() => setOpenAttachment(null)} />
      {standalone && tokenRow ? (
        <FloatingSheet testID="ticket-token-sheet" open={rootSheet === 'token'} onClose={() => setRootSheet(null)} label={layout.tokenDetails}>
          <TokenBreakdown total={tokenText(facts?.totalTokens ?? 0, locale)} parts={tokenParts} caption={tokenCaption} heading />
        </FloatingSheet>
      ) : null}
      {standalone && brief.full ? (
        <FloatingSheet testID="ticket-brief-sheet" open={rootSheet === 'brief'} onClose={() => setRootSheet(null)} label={layout.fullTask} tall>
          <TaskBriefSheetContent markdown={brief.full} writer={writerLabel(facts?.createdBy, leadName, locale)} />
        </FloatingSheet>
      ) : null}
      {/* 决定卡里的「⋯」：手机上和顶栏的「⋯」同一种悬浮面板（画板 SheetRules），桌面上还是 Sheet。 */}
      {standalone ? (
        <FloatingSheet testID="ticket-bar-menu" inset="menu" open={barMenuOpen} onClose={() => setBarMenuOpen(false)} label={m.moreActionsTitle}>
          {barMenuRows(SheetMenuRow)}
        </FloatingSheet>
      ) : (
        <Sheet testID="ticket-bar-menu" open={barMenuOpen} onClose={() => setBarMenuOpen(false)} title={m.moreActionsTitle}>
          {barMenuRows(RecordRow)}
        </Sheet>
      )}
    </Column>
  );
}

// ── 头部的「更多」 ──────────────────────────────────────────────────────────────────

const PRIORITY_IDS = ['urgent', 'high', 'normal', 'low'] as const;

function HeaderMenu({ link, actions, pendingActionId, onRun, trigger, phone = false, extra = [] }: {
  link: string;
  actions: readonly TicketAction[];
  pendingActionId: string | null;
  onRun: (action: TicketAction, request: TicketActionRunRequest) => void;
  // 触发按钮（手机上是悬浮圆钮）。不给时是一个小图标。
  trigger?: ReactNode;
  // 手机上「⋯」升起贴合内容的悬浮面板（画板 SheetRules：「⋯」里的菜单用小的一档），桌面上是弹出的小浮层。
  phone?: boolean;
  // 决定卡不出现时（没有要你处理的事），工单的操作并进这个菜单（主题 11.21）：点了走和决定卡同一个入口。
  extra?: readonly { id: string; label: string; detail?: string; onPress?: () => void }[];
}) {
  const m = useMessages(ticketThreadMessages);
  const [view, setView] = useState<'root' | 'set_priority' | 'set_project' | 'link'>('root');
  const [project, setProject] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const Item = phone ? SheetMenuRow : RecordRow;
  const label = m.headerMore(actions.map((action) => action.label));
  const content = (close: () => void) => {
    const done = () => { setView('root'); close(); };
    const action = view === 'root' ? null : actions.find((candidate) => candidate.id === view) ?? null;
    if (action?.id === 'set_priority') {
      return PRIORITY_IDS.map((id, index) => (
        <Item key={id} divider={index > 0} title={m.priority[id]} onPress={() => { onRun(action, { input: { priority: id } }); done(); }} />
      ));
    }
    if (action?.id === 'set_project') {
      return (
        <Column gap="form-field" p={phone ? 'row-x' : undefined}>
          <TextField testID="ticket-project-input" value={project} onChangeText={setProject} placeholder={m.projectName} />
          <Row gap="actions">
            <Button label={m.save} size={phone ? 'md' : 'sm'} shape={phone ? 'pill' : undefined} disabled={!project.trim() || pendingActionId !== null} onPress={() => { onRun(action, { input: { project: project.trim() } }); done(); }} />
            <Button label={m.clearProject} size={phone ? 'md' : 'sm'} shape={phone ? 'pill' : undefined} variant="ghost" tone="neutral" onPress={() => { onRun(action, { input: { project: null } }); done(); }} />
          </Row>
        </Column>
      );
    }
    if (action?.id === 'link') {
      return (
        <Column p={phone ? 'row-x' : undefined}>
          <LinkTicketForm action={action} pending={pendingActionId === 'link'} onCancel={() => setView('root')} onSubmit={(request) => { onRun(action, request); done(); }} />
        </Column>
      );
    }
    return (
      <Column>
        {/* 原生应用里还没有剪贴板（canCopyText），不给这一项。 */}
        {extra.map((entry, index) => (
          <Item
            key={`extra-${entry.id}`}
            divider={index > 0}
            // 和决定卡里「更多」面板的那一行同一个标识：同一个操作，两处入口不会同时出现。
            testID={`ticket-bar-menu-${entry.id}`}
            title={entry.label}
            detail={entry.detail}
            onPress={entry.onPress ? () => { done(); entry.onPress!(); } : undefined}
          />
        ))}
        {canCopyText && link ? (
          <Item testID="ticket-copy-link" divider={extra.length > 0} title={m.copyLink} detail={link} detailMono onPress={() => { void copyText(link); done(); }} />
        ) : null}
        {actions.map((candidate, index) => (
          <Item
            key={candidate.id}
            divider={index > 0 || extra.length > 0 || (canCopyText && Boolean(link))}
            testID={`ticket-header-${candidate.id}`}
            title={candidate.label}
            detail={actionNote(candidate, m)}
            onPress={candidate.available ? () => setView(candidate.id as typeof view) : undefined}
          />
        ))}
      </Column>
    );
  };
  if (phone) {
    const close = () => { setSheetOpen(false); setView('root'); };
    return (
      <>
        <Pressable testID="ticket-header-more" aria-label={label} feedback="opacity" rounded="full" onPress={() => setSheetOpen(true)}>
          {trigger}
        </Pressable>
        <FloatingSheet testID="ticket-header-more-sheet" inset="menu" open={sheetOpen} onClose={close} label={m.ticketActions}>
          {content(close)}
        </FloatingSheet>
      </>
    );
  }
  return (
    <Popover
      testID="ticket-header-more"
      label={label}
      title={m.ticketActions}
      width={300}
      trigger={trigger ?? <Row testID="ticket-header-more-trigger"><Icon name="more" size={15} color="text-secondary" /></Row>}
    >
      {content}
    </Popover>
  );
}

// 手机面板里的一行（和加号面板同一种）：整行可点，高至少 48，圆角的按下底色；不能点的写灰，原因在下面一行。
function SheetMenuRow({ title, detail, detailMono, onPress, testID }: {
  title: string;
  detail?: string;
  detailMono?: boolean;
  onPress?: () => void;
  testID?: string;
  divider?: boolean;
}) {
  return (
    <Pressable testID={testID} onPress={onPress} disabled={!onPress} feedback="highlight" rounded="3xl" px="row-x" py="row-y" minH={48} justify="center">
      <Text size="card-title" weight="semibold" tone={onPress ? 'default' : 'muted'} numberOfLines={1}>{title}</Text>
      {detail ? <Text size="note" tone="secondary" mono={detailMono} numberOfLines={2}>{detail}</Text> : null}
    </Pressable>
  );
}

const RELATION_IDS = ['relates_to', 'depends_on', 'blocks'] as const;

// 关联一张工单：头部「更多」和关系那一块共用。走工单操作 link，和 Lead 的 ticket_action 是同一个函数。
function LinkTicketForm({ action, pending, onCancel, onSubmit }: {
  action: TicketAction;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (request: TicketActionRunRequest) => void;
}) {
  const m = useMessages(ticketThreadMessages);
  const relationOptions = RELATION_IDS.map((id) => ({ id, ...m.relationOptions[id] }));
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<string>('relates_to');
  const targetId = Number(target.replace(/^#/, '').trim());
  const valid = Number.isSafeInteger(targetId) && targetId > 0;
  return (
    <Column testID="ticket-link-form" gap="form-field">
      <TextField testID="ticket-link-target" value={target} onChangeText={setTarget} placeholder={m.linkTarget} />
      <ChoiceGroup variant="radio" accessibilityLabel={m.linkKind} value={kind} onSelect={setKind} options={relationOptions} />
      <Row gap="actions">
        <Button
          testID="ticket-link-submit"
          label={pending ? `${action.label}…` : action.label}
          size="sm"
          disabled={!valid || pending || !action.available}
          onPress={() => onSubmit({ input: { targetTicketId: targetId, relationType: kind }, reason: m.linkReason })}
        />
        <Button label={m.cancel} size="sm" variant="ghost" tone="neutral" onPress={onCancel} />
      </Row>
    </Column>
  );
}

// ── 小工具 ──────────────────────────────────────────────────────────────────────────

// 工单信息和执行者行旁边的入口：操作清单里有、并且现在能做时才给。面板在后面的工单做，现在先请 Lead 代你做（spec 5.11）。
function delegatedEntry(
  actions: readonly TicketAction[],
  id: TicketOperationId,
  label: string,
  onPress: () => void,
  align: 'inline' | 'end' = 'inline',
): Pick<FactItem, 'action'> {
  const action = findAction(actions, id);
  return action?.available ? { action: { label, onPress, align, testID: `ticket-entry-${id}` } } : {};
}

// acceptingAgainst：这个操作会验收（验收，或等验收时的合并），而核查没有通过。
function actionNote(action: TicketAction, m: ThreadMessages, acceptingAgainst = false): string | undefined {
  if (!action.available) return action.reason ?? m.cannotNow;
  if (acceptingAgainst) return m.noteAgainst;
  if (CHAT_OPERATIONS[action.id]) return m.noteChat;
  if (action.external) return m.noteExternal;
  if (action.irreversible) return m.noteIrreversible;
  return undefined;
}

// accepting：这个操作会验收（验收，或等验收时的合并）。
function confirmTitle(
  action: TicketAction,
  reviewer: TicketThreadProps['reviewer'],
  reviewAgainst: boolean,
  accepting: boolean,
  m: ThreadMessages,
): string {
  if (action.id === 'merge' && accepting) {
    if (reviewAgainst) return m.confirm.mergeAgainst;
    if (reviewer && reviewer.status !== 'done') return m.confirm.mergeSkip;
  }
  switch (action.id) {
    case 'open_pr': return m.confirm.openPr;
    case 'abandon': return m.confirm.abandon;
    case 'cancel': return m.confirm.cancel;
    case 'stop_run': return m.confirm.stopRun;
    case 'rework': return m.confirm.rework;
    case 'complete':
      if (reviewAgainst) return m.confirm.completeAgainst;
      return reviewer && reviewer.status !== 'done' ? m.confirm.completeSkip : m.confirm.complete;
    default: return m.confirm.other(action.label);
  }
}

function confirmNote(action: TicketAction, reviewAgainst: boolean, accepting: boolean, m: ThreadMessages): string | undefined {
  if (action.external) return m.confirmNote.external;
  if (action.irreversible) return m.confirmNote.irreversible;
  if (accepting && reviewAgainst) return m.confirmNote.against;
  if (accepting) return m.confirmNote.skip;
  return undefined;
}

function creatorName(createdBy: TicketDetailFacts['createdBy'], leadName: string, m: ThreadMessages): string {
  switch (createdBy) {
    case 'user': return m.creator.user;
    case 'child': return m.creator.child;
    case 'system': return m.creator.system;
    default: return leadName;
  }
}

function budgetText(facts: TicketDetailFacts | null, m: ThreadMessages): string {
  const parts = [
    facts?.tokenBudget ? `${facts.tokenBudget.toLocaleString('en-US')} token` : null,
    facts?.costBudgetUsd ? `$${facts.costBudgetUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : m.noBudget;
}

// 验收方式：一句话说清楚谁核查、谁验收、是否托管、返工额度（4.3）。
function acceptanceText(ticket: Ticket, leadName: string, m: ThreadMessages): string {
  const t = m.acceptanceText;
  const who = ticket.verificationPolicy === 'independent_reviewer'
    ? t.independent
    : ticket.verificationPolicy === 'lead_static'
      ? t.leadStatic(leadName)
      : t.you;
  if (ticket.acceptancePolicy !== 'delegated_to_lead') return t.notDelegated(who);
  const review = ticket.reviewState;
  const budget = review?.maxReworkCycles != null ? t.budget(review.maxReworkCycles, review.reworkCyclesUsed ?? 0) : '';
  const rework = ticket.reworkPolicy === 'automatic' ? t.autoRework(budget) : t.waitRework;
  return t.delegated(who, leadName, rework);
}

function profileText(profile: RunProfilePresentation | null, m: ThreadMessages): string {
  if (!profile) return m.notSet;
  return [profile.runtime, profile.model, profile.effort ? m.effort(profile.effort) : null].filter(Boolean).join(' · ');
}

function workspaceFact(
  stage: DetailStage,
  ticket: Ticket,
  workspace: TicketDelivery['workspace'],
  m: ThreadMessages,
  locale: Locale,
): FactItem {
  const mode = ticket.workspace?.mode === 'isolated' ? m.isolatedBranch : m.sharedWorkspace;
  const badge = workspace ? integrationBadge(stage, workspace.integration, locale) : null;
  return {
    label: m.workspace,
    value: workspace?.branch ?? mode,
    mono: Boolean(workspace?.branch),
    detail: [mode, workspace?.target ? m.mergeTarget(workspace.target) : null].filter(Boolean).join(' · '),
    ...(badge ? { badge } : {}),
  };
}

// 「第 1 次交付 · 15:18」：第几次读交付快照（工单 04、05），读不到时只写交付的时间。
function deliverySummary(
  stage: DetailStage,
  latest: KernelOutcomeSnapshotResource['latest'] | null,
  delivery: TicketAcceptanceCriteria['delivery'],
  m: ThreadMessages,
  locale: Locale,
): ReactNode {
  if (stage === 'cancelled') return m.cancelled;
  // 还没交付时正文就是这一句，标题行不再重复。
  if (!latest) return undefined;
  if (delivery && delivery.attemptId === latest.executorAttemptId) {
    return m.deliveryNumber(delivery.sequence, clockText(delivery.deliveredAt, undefined, locale));
  }
  return m.deliveredAt(clockText(latest.createdAt, undefined, locale));
}
