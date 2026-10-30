import {
  ActionBar, Button, canCopyText, Card, Checklist, ChoiceGroup, Column, ConfirmBar, copyText, Density, DetailHeader, DockedLayout, FactList, Icon,
  Popover, RecordRow, Row, ScrollArea, Section, Sheet, Stats, Steps, Text, TextField, Timeline, type FactItem,
  type ScrollEvent,
} from '@pi-lead-child/components';
import type {
  KernelArtifact, KernelOutcomeSnapshotResource, KernelTicketPow, TicketAcceptanceCriteria, TicketAction,
  TicketActionId as TicketOperationId, TicketActionRunRequest, TicketChatResume, TicketDelivery, TicketExecutionPlan,
  TicketReplyActionId,
} from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { StatusBadge } from '@/components/StatusBadge';
import { MarkdownMessage } from '@/features/chat/MarkdownMessage';
import { useLeadName } from '@/state/hooks';
import type { ArtifactDownloadState, InterventionCommandState, ResourceLoadState } from '@/state/types';
import {
  buildInterventionPresentation,
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

import { InterventionPanel } from './InterventionPanel';
import type { LegacyTicketAction, LegacyTicketActionId } from './legacyTicketActions';
import type { TicketLogRunPresentation } from './LogTimeline';
import { TicketChatDock, type TicketChatAction } from './TicketChatDock';
import type { TicketActionReceipt, TicketRunProgress } from './ticketChatStatus';
import { isTicketBlockedForActions, ticketDecision } from './ticketDecision';
import {
  CHILD_BADGES,
  DELIVERY_OPERATIONS,
  DETAIL_SECTION_TITLES,
  REVIEWER_STATUS_LABELS,
  barCaption,
  briefPreview,
  briefSummary,
  clockText,
  criteriaPresentation,
  criteriaSourceLabel,
  detailActionBar,
  detailStage,
  durationText,
  executionSummary,
  findAction,
  headerMoreActions,
  historyItems,
  integrationBadge,
  nextStepText,
  planSteps,
  planSummary,
  reviewWentAgainst,
  sectionCollapsed,
  sourceLabels,
  splitRequestText,
  usageCaption,
  usageStats,
  writerLabel,
  type ChildStage,
  type DetailSectionKind,
  type DetailStage,
  type RememberedSections,
  type ReviewerStatus,
} from './ticketDetailSections';
import type { AttemptPresentation, LifecyclePresentation, RelationPresentation } from './ticketHistory';
import type { TicketLogPresentation } from './ticketLogs';
import { TicketRecords } from './TicketRecords';
import type { TicketStoryEntry } from './ticketStory';
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
const CHAT_OPERATIONS: Record<string, (ticketId: string) => string> = {
  edit_acceptance_criteria: (ticketId) => `改一下 #${ticketId} 的验收标准：`,
  // 放宽子 agent 的权限要写放宽到哪里（scope）。只属于你：Lead 在你这一轮里代你做。
  widen_grant: (ticketId) => `放宽 #${ticketId} 的子 agent 的权限：`,
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
  const sources = sourceLabels(leadName);
  const [remembered, remember] = useRememberedSections();
  const [headerCompact, setHeaderCompact] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [barMenuOpen, setBarMenuOpen] = useState(false);
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
  const toggle = (kind: DetailSectionKind) => (next: boolean) => remember(kind, next);

  // 「下一步」：等你验收、受阻时用 ticketDecision 的那一句，和收件箱同一句话。
  const blockerCheckpoint = ticket.status === 'blocked' ? latestBlockedCheckpoint(checkpoints) : undefined;
  const decision = ticketDecision({
    ticket,
    outcome,
    timing,
    blocker: blockerCheckpoint ? { title: blockerCheckpoint.title, summary: blockerCheckpoint.summary } : null,
    liveRun,
    leadName,
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
      prefill(chat(displayId));
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

  // ── 头部 ──
  const headerActions = headerMoreActions(actions);
  const header = (
    <DetailHeader
      testID="ticket-thread-header"
      id={`#${displayId}`}
      title={titleText}
      compact={headerCompact}
      badges={(
        <>
          <StatusBadge label={ticket.statusLabel} tone={ticket.status} />
          <StatusBadge label={ticket.priorityLabel} tone={ticket.priority} />
        </>
      )}
      project={ticket.project}
      more={(
        <HeaderMenu
          link={ticketLink}
          actions={headerActions}
          pendingActionId={pendingActionId}
          onRun={(action, request) => runAction(action, request)}
        />
      )}
      onClose={standalone ? undefined : onClose}
      closeLabel="关闭工单详情"
      onBack={standalone ? onClose : undefined}
      dense={standalone}
    />
  );

  // ── 关系 ──
  const linkAction = findAction(actions, 'link');
  const unlinkAction = findAction(actions, 'unlink');
  // 子工单已经在上面的列表里；这里列父工单和相关工单。撤销了的关系不列。
  const relationLinks = relations.filter((relation) => relation.kind !== 'parent_of' && relation.active !== false);
  const hasRelations = childTickets.length > 0 || relationLinks.length > 0;
  const cancelledChildren = childTickets.filter((child) => child.state === 'cancelled').length;
  const relationsSection = (
    <Section
      testID="ticket-section-relations"
      title={DETAIL_SECTION_TITLES.relations}
      summary={hasRelations ? relationsSummary(childTickets, relationLinks) : (
        <Row items="baseline" gap="inline-item" flexWrap="wrap">
          <Text size="secondary" tone="secondary">没有子工单</Text>
          <Button testID="ticket-split-request" label="拆成子工单" variant="link" size="xs" onPress={() => prefill(splitRequestText(displayId))} disabled={!onPrefillChat} />
          <Text size="secondary" tone="secondary">·</Text>
          <Text size="secondary" tone="secondary">没有父工单和相关工单</Text>
          {linkAction ? (
            <Button testID="ticket-link-open" label="关联工单" variant="link" size="xs" onPress={() => setLinkFormOpen(true)} disabled={!linkAction.available} />
          ) : null}
        </Row>
      )}
      collapsed={hasRelations ? collapsed('relations') : !linkFormOpen}
      onToggle={hasRelations ? toggle('relations') : undefined}
      inset={!hasRelations || linkFormOpen}
    >
      {childTickets.map((child, index) => (
        <RecordRow
          key={child.id}
          testID={`child-ticket-${child.id}`}
          divider={index > 0}
          id={`#${child.displayId}`}
          title={child.title}
          badge={CHILD_BADGES[child.state]}
          detail={child.createdBy === 'lead' ? `${leadName} 拆的` : child.createdBy === 'child' ? '执行 agent 拆的' : undefined}
          onPress={onOpenTicket ? () => onOpenTicket(child.id) : undefined}
          accessibilityLabel={`打开子工单 #${child.displayId}，${CHILD_BADGES[child.state].label}`}
        />
      ))}
      {relationLinks.map((relation, index) => (
        <RecordRow
          key={`${relation.kind}-${relation.ticketId}`}
          testID={`ticket-relation-${relation.ticketId}`}
          divider={childTickets.length > 0 || index > 0}
          id={`#${relation.ticketId}`}
          title={relation.title ?? `#${relation.ticketId}`}
          badge={{ label: relation.label, tone: 'neutral' }}
          detail={relation.detail ?? undefined}
          onPress={onOpenTicket ? () => onOpenTicket(String(relation.ticketId)) : undefined}
          // 解除关联：关系账本里的关系才有编号（父子树上的关系没有），能不能点按清单。
          action={unlinkAction && relation.relationId ? {
            icon: 'close',
            label: `解除和 #${relation.ticketId} 的关联`,
            disabled: !canRun(unlinkAction),
            onPress: () => runAction(unlinkAction, { input: { relationId: relation.relationId! }, reason: '在工单详情里解除关联' }),
          } : undefined}
        />
      ))}
      {hasRelations && linkAction ? (
        <RecordRow
          divider
          testID="ticket-link-open"
          title="关联工单"
          detail={linkAction.available ? undefined : linkAction.reason ?? undefined}
          onPress={linkAction.available ? () => setLinkFormOpen(true) : undefined}
        />
      ) : null}
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
    </Section>
  );

  // ── 任务说明 ──
  const brief = briefPreview(taskDescription?.brief ?? '');
  const taskSection = brief.full ? (
    <Section
      testID="ticket-section-task"
      title={DETAIL_SECTION_TITLES.task}
      source={writerLabel(facts?.createdBy, leadName)}
      summary={collapsed('task') ? briefSummary(brief.full, ticket.summary) : undefined}
      collapsed={collapsed('task')}
      onToggle={toggle('task')}
    >
      <Column gap="card-row">
        <MarkdownMessage markdown={briefOpen ? brief.full : brief.preview} />
        {brief.truncated ? (
          <Row>
            <Button testID="ticket-brief-toggle" label={briefOpen ? '收起' : '展开全文'} variant="link" size="xs" onPress={() => setBriefOpen((open) => !open)} />
          </Row>
        ) : null}
      </Column>
    </Section>
  ) : null;

  // ── 验收标准 ──
  const criteria = criteriaPresentation(acceptanceCriteria);
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
    <Section
      testID="ticket-section-criteria"
      title={DETAIL_SECTION_TITLES.criteria}
      source={criteriaSourceLabel(acceptanceCriteria, leadName)}
      variant="subtle"
      summary={criteria.summary}
      collapsed={collapsed('criteria')}
      onToggle={toggle('criteria')}
    >
      {criteria.empty ? (
        <Text size="secondary" tone="secondary">这张工单没有结构化的验收标准。任务说明里写的要求以原文为准。</Text>
      ) : (
        <Checklist
          testID="ticket-criteria"
          items={criteria.items}
          columns={criteria.compare ? [{ label: sources.reviewer, emptyLabel: '核查员还没有结论' }] : []}
          checkColumn={criteria.compare ? '你' : undefined}
          onToggle={canToggleCriteria ? toggleCriterion : undefined}
          checkLabel={(_item, index) => `你确认达到：验收标准 ${index + 1}`}
        />
      )}
    </Section>
  );

  // ── 工单信息 ──
  const delegated = ticket.acceptancePolicy === 'delegated_to_lead';
  // 托管（spec 4.3、5.8）：托管了给「撤销托管」，没托管给「授权托管」。
  // 授权：清单里有 delegate（工单 11）时，能不能点、为什么不能点都按清单。旧 daemon 的清单里没有 delegate：
  // 退回原来的授权接口，只给要求独立核查的工单（不要求独立核查的工单不提供托管，spec 5.8）。
  const delegateAction = findAction(actions, 'delegate');
  const delegationBusy = delegationActionState?.pending ?? false;
  const delegationEntry: Pick<FactItem, 'action' | 'detail'> = delegated
    ? onSetLeadDelegation
      ? { action: { label: delegationBusy ? '处理中' : '撤销托管', onPress: () => onSetLeadDelegation(false), disabled: delegationBusy, testID: 'lead-delegation-revoke' } }
      : {}
    : delegateAction
      ? {
          action: {
            label: pendingActionId === delegateAction.id ? '处理中' : '授权托管',
            onPress: () => runAction(delegateAction, { input: { maxReworkCycles: 1 } }),
            disabled: !canRun(delegateAction),
            testID: 'lead-delegation-grant',
          },
          ...(delegateAction.available ? {} : { detail: delegateAction.reason ?? '现在不能托管。' }),
        }
      : ticket.verificationPolicy === 'independent_reviewer' && onSetLeadDelegation
        ? { action: { label: delegationBusy ? '处理中' : '授权托管', onPress: () => onSetLeadDelegation(true), disabled: delegationBusy, testID: 'lead-delegation-grant' } }
        : {};
  const infoItems: FactItem[] = [
    ...(facts ? [{ label: '建单', value: `${creatorName(facts.createdBy, leadName)} · ${clockText(facts.createdAt)}` }] : []),
    ...(facts ? [{ label: '最后更新', value: clockText(facts.updatedAt) }] : []),
    { label: '截止和提醒', value: facts?.dueAt ? clockText(facts.dueAt) : '没有', ...delegatedEntry(actions, 'set_due', '设置', () => prefill(`把 #${displayId} 的截止时间设成：`)) },
    { label: '预算', value: budgetText(facts), ...delegatedEntry(actions, 'set_budget', '设置', () => prefill(`给 #${displayId} 设预算：`)) },
    { label: '验收方式', value: acceptanceText(ticket, leadName), ...delegationEntry },
  ];
  const infoSection = (
    <Section
      testID="ticket-section-info"
      title={DETAIL_SECTION_TITLES.info}
      source={sources.system}
      summary={collapsed('info') ? acceptanceText(ticket, leadName) : undefined}
      collapsed={collapsed('info')}
      onToggle={toggle('info')}
    >
      <FactList variant="labeled" items={infoItems} />
      {delegationActionState?.error ? <Text role="alert" size="note" tone="danger-dark">{delegationActionState.error}</Text> : null}
    </Section>
  );

  // ── 执行 ──
  const running = stage === 'running';
  const usage = {
    activeExecutionMs: timing?.activeExecutionMs ?? null,
    totalTokens: facts?.totalTokens ?? null,
    totalCostUsd: facts?.totalCostUsd ?? null,
    running,
  };
  const changeReviewer = findAction(actions, 'change_reviewer');
  const profileItems: FactItem[] = [
    {
      label: '执行者',
      value: profileText(executor ?? (ticket.runtimeName ? { runtime: runtimeDisplayName(ticket.runtimeName) ?? ticket.runtimeName, model: null, effort: null } : null)),
      ...delegatedEntry(actions, 'set_run_profile' as TicketOperationId, '换模型和强度', () => prefill(`把 #${displayId} 执行者的模型和推理强度换成：`), 'end'),
    },
    ...(reviewer ? [{
      label: '核查员',
      value: `${profileText(reviewer)} · ${REVIEWER_STATUS_LABELS[reviewer.status]}`,
      ...(changeReviewer?.available ? {
        action: { label: '换核查员', align: 'end' as const, onPress: () => prefill(`把 #${displayId} 的核查员换成：`), testID: 'ticket-change-reviewer' },
      } : {}),
    }] : []),
  ];
  const latestProgress = running ? checkpoints.find((checkpoint) => checkpoint.source === 'agent_reported') ?? null : null;
  const recentLogs = running ? logs.slice(-5).reverse() : [];
  const steps = planSteps(executionPlan);
  const executionSection = ticket.hasRun || stage !== 'draft' ? (
    <Section
      testID="ticket-section-execution"
      variant="group"
      title={DETAIL_SECTION_TITLES.execution}
      summary={collapsed('execution') ? executionSummary(executor?.runtime ?? agent, usage) : undefined}
      collapsed={collapsed('execution')}
      onToggle={toggle('execution')}
    >
      <Card overflow="hidden">
        <Section testID="ticket-execution-profiles" variant="part" divider={false}>
          <FactList variant="labeled" items={profileItems} />
        </Section>
        <Section testID="ticket-execution-usage" variant="part" title="用量" source={sources.system}>
          <Column gap="card-row">
            <Stats variant="compact" items={usageStats(usage)} />
            <Text size="note" tone="secondary">{usageCaption(running)}</Text>
          </Column>
        </Section>
        <Section testID="ticket-execution-plan" variant="part" title="执行计划" source={sources.child} summary={planSummary(executionPlan) ?? undefined} summaryMono>
          {steps.length > 0
            ? <Steps variant="compact" items={steps} />
            : <Text size="secondary" tone="secondary">{executionPlan === undefined ? '正在读取执行计划。' : '执行 agent 没有提交计划。'}</Text>}
        </Section>
        {running ? (
          <Section testID="ticket-execution-now" variant="part" title="现在" source={sources.child} summary={latestProgress ? `${clockText(latestProgress.createdAt)} 说的` : undefined}>
            <Text size="body">{latestProgress ? latestProgress.summary || latestProgress.title : '执行 agent 还没有说进展。'}</Text>
          </Section>
        ) : null}
        {recentLogs.length > 0 ? (
          <Section testID="ticket-execution-actions" variant="part" title="最近的动作" source={sources.system}>
            <Timeline
              variant="compact"
              // 只写做了什么（工具和它的主要参数）；耗时、输出大小这些在完整记录里。
              items={recentLogs.map((log) => ({ at: clockText(log.createdAt), text: log.title }))}
            />
          </Section>
        ) : null}
        <Section testID="ticket-execution-runs" variant="part" title="运行记录" source={sources.system} summary={attempts.length > 0 ? '点一行，在中间栏看完整记录' : undefined} inset={attempts.length === 0}>
          {attempts.length === 0 ? <Text size="secondary" tone="secondary">还没有运行。</Text> : null}
          {attempts.map((attempt, index) => (
            <RecordRow
              key={attempt.id}
              testID={`ticket-run-${attempt.id}`}
              divider={index > 0}
              id={`#${attempt.id}`}
              title={attempt.purposeLabel}
              meta={`· ${runChoice(attempt)}`}
              badge={{ label: attempt.result, tone: RUN_TONE[attempt.resultTone] }}
              detail={runDetail(attempt)}
              detailMono
              onPress={openRecords}
              accessibilityLabel={`在中间栏看 #${attempt.id} 的记录`}
            />
          ))}
        </Section>
        {ticket.workflowKind === 'coding' && ticket.workspace ? (
          <Section testID="ticket-execution-workspace" variant="part">
            <FactList variant="labeled" items={[workspaceFact(stage, ticket, workspace)]} />
          </Section>
        ) : null}
      </Card>
    </Section>
  ) : null;

  // ── 交付与验收（内容在工单 13 做）──
  const latestOutcome = outcome?.latest ?? null;
  const deliverySection = stage === 'draft' ? null : (
    <Section
      testID="ticket-section-delivery"
      variant="group"
      title={DETAIL_SECTION_TITLES.delivery}
      summary={deliverySummary(stage, latestOutcome, acceptanceCriteria?.delivery ?? null)}
      collapsed={latestOutcome ? collapsed('delivery') : false}
      onToggle={latestOutcome ? toggle('delivery') : undefined}
    >
      <Card overflow="hidden">
        {latestOutcome ? (
          <Section testID="ticket-delivery-summary" variant="part" divider={false} title="做了什么" source={sources.child}>
            <Text size="body" numberOfLines={4}>{latestOutcome.summary}</Text>
          </Section>
        ) : (
          <Section testID="ticket-delivery-pending" variant="part" divider={false}>
            <Text size="secondary" tone="secondary">{stage === 'cancelled' ? '工单已取消，没有交付。' : '还没交付。'}</Text>
          </Section>
        )}
      </Card>
    </Section>
  );

  // ── 经过与记录 ──
  const historySection = (
    <Section
      testID="ticket-section-history"
      variant="group"
      title={DETAIL_SECTION_TITLES.history}
      summary={collapsed('history') ? `${story.length} 件事` : undefined}
      collapsed={collapsed('history')}
      onToggle={toggle('history')}
    >
      <Card overflow="hidden">
        <Section testID="ticket-history-story" variant="part" divider={false} title="经过" source={sources.system}>
          {story.length > 0
            ? <Timeline testID="ticket-history-timeline" variant="compact" items={historyItems(story)} />
            : <Text size="secondary" tone="secondary">还没有工单级的事件。</Text>}
        </Section>
        <RecordRow
          divider
          testID="ticket-records-open"
          title="完整记录"
          meta="进展、每次运行的日志、原始事件，在中间栏打开"
          onPress={openRecords}
          pressIcon="arrow-up-right"
          accessibilityLabel="打开完整记录"
        />
      </Card>
    </Section>
  );

  // 等你回答的决定直接放在最上面：收件箱「查看」打开的就是这里（2026-10-16）。
  const pendingDecisions = Object.values(interventions)
    .filter((intervention) => intervention.kind === 'decision' && intervention.state === 'pending');

  // ── 底部操作栏 ──
  // 清单读取中、读不到时说出来：不能只是没有按钮（审查 2026-10-22）。读不到时次要按钮的位置给「重试」。
  const actionsCaption = actions.length > 0
    ? null
    : actionsStatus === 'loading'
      ? '正在读取这张工单能做的操作。'
      : actionsStatus === 'error'
        ? '读不到这张工单能做的操作。'
        : actionsStatus === 'unsupported' ? '这个连接读不了工单能做的操作，按钮都不画。' : null;
  const retryButton = actions.length === 0 && actionsStatus === 'error' && onRetryActions
    ? { label: '重试', onPress: onRetryActions, tone: 'neutral' as const, testID: 'ticket-actions-retry' }
    : undefined;
  const deliveryCaption = [bar.primary, bar.secondary].some((action) => action?.available && waitingForDelivery(action))
    ? '正在读取这次交付。'
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
      next={next}
      caption={actionState?.error ?? actionsCaption ?? deliveryCaption ?? barCaption(bar, acceptanceCriteria)}
      primary={barButton(bar.primary, 'primary')}
      secondary={barButton(bar.secondary, 'secondary') ?? retryButton}
      more={bar.more.length + legacyActions.length > 0 ? {
        label: `更多操作：${[...bar.more, ...legacyActions].map((action) => action.label).join('、')}`,
        onPress: () => setBarMenuOpen(true),
        testID: 'ticket-bar-more',
      } : undefined}
      confirm={restoring ? (
        <ConfirmBar
          testID="ticket-confirm"
          title={restoring.label === '继续恢复' ? '继续恢复这一组工单？' : '恢复这张工单？'}
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
              accessibilityLabel="恢复哪些工单"
              value={restoreMode}
              onSelect={(mode) => setRestoreMode(mode === 'root_only' ? 'root_only' : 'review_tree')}
              options={[
                { id: 'review_tree', label: '恢复整组任务', description: `这张和 ${cancelledChildren} 张已取消的子工单；同名重复的保持取消。` },
                { id: 'root_only', label: '只恢复这张', description: '子工单保持取消。' },
              ]}
            />
          ) : null}
        </ConfirmBar>
      ) : confirming ? (
        <ConfirmBar
          testID="ticket-confirm"
          title={confirmTitle(confirming, reviewer, reviewAgainst, accepts(confirming))}
          details={confirming.id === 'open_pr' && workspace ? [
            { label: '推送', value: workspace.branch ?? '这张工单的分支', mono: true },
            { label: '目标', value: workspace.target ?? '原分支', mono: true },
          ] : []}
          note={confirmNote(confirming, reviewAgainst, accepts(confirming))}
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
              placeholder="写下要修什么（可选）。执行 agent 会收到核查意见和你写的话。"
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
            bar={actionBar}
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
            <Column testID="ticket-detail-sections" px="page-x" pb="page-bottom">
              <Column pt="stacked-card" gap="stacked-card">
                {pendingDecisions.length > 0 ? (
                  <Column testID="ticket-pending-decision" gap="stacked-card">
                    {pendingDecisions.map((intervention) => (
                      <InterventionPanel
                        key={intervention.id}
                        intervention={buildInterventionPresentation(intervention)}
                        commandState={interventionCommandStates[intervention.id]}
                        onResolve={onResolveIntervention}
                      />
                    ))}
                  </Column>
                ) : null}
                {resolutionError ? <Text role="alert" size="note" tone="danger-dark">{resolutionError}</Text> : null}
                {relationsSection}
                {taskSection}
                {criteriaSection}
                {infoSection}
              </Column>
              {executionSection ? <Column pt="page-section">{executionSection}</Column> : null}
              {deliverySection ? <Column pt="page-section">{deliverySection}</Column> : null}
              <Column pt="page-section">{historySection}</Column>
            </Column>
          </ScrollArea>
        )}
      </DockedLayout>
      <Sheet testID="ticket-bar-menu" open={barMenuOpen} onClose={() => setBarMenuOpen(false)} title="更多操作">
        {bar.more.map((action, index) => (
          <RecordRow
            key={action.id}
            testID={`ticket-bar-menu-${action.id}`}
            divider={index > 0}
            title={action.label}
            detail={waitingForDelivery(action) ? '正在读取这次交付。' : actionNote(action, reviewAgainst && accepts(action))}
            onPress={canRun(action) || CHAT_OPERATIONS[action.id] ? () => choose(action) : undefined}
          />
        ))}
        {legacyActions.map((action, index) => (
          <RecordRow
            key={action.id}
            testID={`ticket-bar-menu-${action.id}`}
            divider={bar.more.length + index > 0}
            title={action.label}
            detail={action.note ?? undefined}
            onPress={onLegacyAction && pendingActionId === null ? () => chooseLegacy(action) : undefined}
          />
        ))}
      </Sheet>
    </Column>
  );
}

// ── 头部的「更多」 ──────────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS = [
  { id: 'urgent', label: '紧急' },
  { id: 'high', label: '高' },
  { id: 'normal', label: '普通' },
  { id: 'low', label: '低' },
] as const;

function HeaderMenu({ link, actions, pendingActionId, onRun }: {
  link: string;
  actions: readonly TicketAction[];
  pendingActionId: string | null;
  onRun: (action: TicketAction, request: TicketActionRunRequest) => void;
}) {
  const [view, setView] = useState<'root' | 'set_priority' | 'set_project' | 'link'>('root');
  const [project, setProject] = useState('');
  return (
    <Popover
      testID="ticket-header-more"
      label={`更多：复制链接、${actions.map((action) => action.label).join('、')}`}
      title="工单操作"
      width={300}
      trigger={<Row testID="ticket-header-more-trigger"><Icon name="more" size={15} color="text-secondary" /></Row>}
    >
      {(close) => {
        const done = () => { setView('root'); close(); };
        const action = view === 'root' ? null : actions.find((candidate) => candidate.id === view) ?? null;
        if (action?.id === 'set_priority') {
          return PRIORITY_OPTIONS.map((option, index) => (
            <RecordRow key={option.id} divider={index > 0} title={option.label} onPress={() => { onRun(action, { input: { priority: option.id } }); done(); }} />
          ));
        }
        if (action?.id === 'set_project') {
          return (
            <Column gap="form-field">
              <TextField testID="ticket-project-input" value={project} onChangeText={setProject} placeholder="项目名" />
              <Row gap="actions">
                <Button label="保存" size="sm" disabled={!project.trim() || pendingActionId !== null} onPress={() => { onRun(action, { input: { project: project.trim() } }); done(); }} />
                <Button label="清掉项目" size="sm" variant="ghost" tone="neutral" onPress={() => { onRun(action, { input: { project: null } }); done(); }} />
              </Row>
            </Column>
          );
        }
        if (action?.id === 'link') {
          return <LinkTicketForm action={action} pending={pendingActionId === 'link'} onCancel={() => setView('root')} onSubmit={(request) => { onRun(action, request); done(); }} />;
        }
        return (
          <Column>
            {/* 原生应用里还没有剪贴板（canCopyText），不给这一项。 */}
            {canCopyText && link ? (
              <RecordRow testID="ticket-copy-link" title="复制链接" detail={link} detailMono onPress={() => { void copyText(link); done(); }} />
            ) : null}
            {actions.map((candidate, index) => (
              <RecordRow
                key={candidate.id}
                divider={index > 0 || (canCopyText && Boolean(link))}
                testID={`ticket-header-${candidate.id}`}
                title={candidate.label}
                detail={actionNote(candidate)}
                onPress={candidate.available ? () => setView(candidate.id as typeof view) : undefined}
              />
            ))}
          </Column>
        );
      }}
    </Popover>
  );
}

const RELATION_OPTIONS = [
  { id: 'relates_to', label: '相关', description: '只记一笔，不影响谁先做。' },
  { id: 'depends_on', label: '依赖它', description: '那张工单做完以前，这张不开跑。' },
  { id: 'blocks', label: '挡住它', description: '这张做完以前，那张不开跑。' },
] as const;

// 关联一张工单：头部「更多」和关系那一块共用。走工单操作 link，和 Lead 的 ticket_action 是同一个函数。
function LinkTicketForm({ action, pending, onCancel, onSubmit }: {
  action: TicketAction;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (request: TicketActionRunRequest) => void;
}) {
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<string>('relates_to');
  const targetId = Number(target.replace(/^#/, '').trim());
  const valid = Number.isSafeInteger(targetId) && targetId > 0;
  return (
    <Column testID="ticket-link-form" gap="form-field">
      <TextField testID="ticket-link-target" value={target} onChangeText={setTarget} placeholder="工单编号，例如 #18" />
      <ChoiceGroup variant="radio" accessibilityLabel="和这张工单是什么关系" value={kind} onSelect={setKind} options={RELATION_OPTIONS} />
      <Row gap="actions">
        <Button
          testID="ticket-link-submit"
          label={pending ? `${action.label}…` : action.label}
          size="sm"
          disabled={!valid || pending || !action.available}
          onPress={() => onSubmit({ input: { targetTicketId: targetId, relationType: kind }, reason: '在工单详情里关联' })}
        />
        <Button label="取消" size="sm" variant="ghost" tone="neutral" onPress={onCancel} />
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
function actionNote(action: TicketAction, acceptingAgainst = false): string | undefined {
  if (!action.available) return action.reason ?? '现在不能做。';
  if (acceptingAgainst) return '核查没有通过。做之前会再问你一次。';
  if (CHAT_OPERATIONS[action.id]) return '打开工单对话，写下要怎么改。';
  if (action.external) return '对外操作，做之前会再问你一次。';
  if (action.irreversible) return '做了就收不回，做之前会再问你一次。';
  return undefined;
}

// accepting：这个操作会验收（验收，或等验收时的合并）。
function confirmTitle(action: TicketAction, reviewer: TicketThreadProps['reviewer'], reviewAgainst: boolean, accepting: boolean): string {
  if (action.id === 'merge' && accepting) {
    if (reviewAgainst) return '核查没有通过，仍要验收并合并？';
    if (reviewer && reviewer.status !== 'done') return '不等核查，直接验收并合并？';
  }
  switch (action.id) {
    case 'open_pr': return '推到 GitHub，开一个草稿 PR？';
    case 'abandon': return '放弃这次的改动？';
    case 'cancel': return '取消这张工单？';
    case 'stop_run': return '停下正在跑的这次运行？';
    case 'rework': return '打回返工？';
    case 'complete':
      if (reviewAgainst) return '核查没有通过，仍要验收？';
      return reviewer && reviewer.status !== 'done' ? '不等核查，直接验收？' : '验收这张工单？';
    default: return `${action.label}？`;
  }
}

function confirmNote(action: TicketAction, reviewAgainst: boolean, accepting: boolean): string | undefined {
  if (action.external) return '推送是对外操作：推送以后，仓库里有权限的人都能看到这个分支和 PR。';
  if (action.irreversible) return '做了就收不回。';
  if (accepting && reviewAgainst) return '没有通过的核查结论。现在验收，等于不按核查的结论结单。';
  if (accepting) return '核查员还没有结论。现在验收，等于跳过独立核查。';
  return undefined;
}

function creatorName(createdBy: TicketDetailFacts['createdBy'], leadName: string): string {
  switch (createdBy) {
    case 'user': return '你';
    case 'child': return '执行 agent';
    case 'system': return '系统';
    default: return leadName;
  }
}

function budgetText(facts: TicketDetailFacts | null): string {
  const parts = [
    facts?.tokenBudget ? `${facts.tokenBudget.toLocaleString('en-US')} token` : null,
    facts?.costBudgetUsd ? `$${facts.costBudgetUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '没设 token 和成本预算';
}

// 验收方式：一句话说清楚谁核查、谁验收、是否托管、返工额度（4.3）。
function acceptanceText(ticket: Ticket, leadName: string): string {
  const who = ticket.verificationPolicy === 'independent_reviewer'
    ? '先由独立核查员核查，再由你验收。'
    : ticket.verificationPolicy === 'lead_static'
      ? `由 ${leadName} 静态核对，再由你验收。`
      : '由你验收。';
  if (ticket.acceptancePolicy !== 'delegated_to_lead') return `${who}没托管，返工由你决定。`;
  const review = ticket.reviewState;
  const budget = review?.maxReworkCycles != null
    ? `额度 ${review.maxReworkCycles} 次，${review.reworkCyclesUsed ? `已用 ${review.reworkCyclesUsed} 次` : '还没用'}。`
    : '';
  const rework = ticket.reworkPolicy === 'automatic' ? (budget ? `不通过时自动返工，${budget}` : '不通过时自动返工。') : '不通过时等你决定。';
  return `${who}已托管给 ${leadName}：核查通过后系统自动验收；${rework}`;
}

function profileText(profile: RunProfilePresentation | null): string {
  if (!profile) return '还没定';
  return [profile.runtime, profile.model, profile.effort ? `推理强度 ${profile.effort}` : null].filter(Boolean).join(' · ');
}

const RUN_TONE: Record<AttemptPresentation['resultTone'], 'success' | 'danger' | 'accent' | 'neutral'> = {
  success: 'success', danger: 'danger', running: 'accent', neutral: 'neutral',
};

// 「Claude Code · sonnet · high」：和执行者那一行同一种写法。
function runChoice(attempt: AttemptPresentation): string {
  return [runtimeDisplayName(attempt.runtime) ?? attempt.runtime, attempt.recordedModel, attempt.effort].filter(Boolean).join(' · ');
}

function runDetail(attempt: AttemptPresentation): string {
  const start = clockText(attempt.startedAt);
  const range = attempt.endedAt ? `${start}–${clockText(attempt.endedAt)}` : `${start} 开始`;
  const duration = attempt.endedAt ? durationText(attempt.durationMs) : null;
  return [range, duration].filter(Boolean).join(' · ');
}

function workspaceFact(stage: DetailStage, ticket: Ticket, workspace: TicketDelivery['workspace']): FactItem {
  const mode = ticket.workspace?.mode === 'isolated' ? '隔离分支' : '共享工作区';
  const badge = workspace ? integrationBadge(stage, workspace.integration) : null;
  return {
    label: '工作区',
    value: workspace?.branch ?? mode,
    mono: Boolean(workspace?.branch),
    detail: [mode, workspace?.target ? `合并目标 ${workspace.target}` : null].filter(Boolean).join(' · '),
    ...(badge ? { badge } : {}),
  };
}

function relationsSummary(children: readonly ChildTicketPresentation[], relations: readonly RelationPresentation[]): string {
  const waiting = children.filter((child) => child.state === 'review').length;
  return [
    children.length > 0 ? `${children.length} 张子工单` : null,
    waiting > 0 ? `${waiting} 张等你验收` : null,
    relations.length > 0 ? `${relations.length} 个关联` : null,
  ].filter(Boolean).join(' · ');
}

// 「第 1 次交付 · 15:18」：第几次读交付快照（工单 04、05），读不到时只写交付的时间。
function deliverySummary(
  stage: DetailStage,
  latest: KernelOutcomeSnapshotResource['latest'] | null,
  delivery: TicketAcceptanceCriteria['delivery'],
): ReactNode {
  if (stage === 'cancelled') return '已取消';
  // 还没交付时正文就是这一句，标题行不再重复。
  if (!latest) return undefined;
  if (delivery && delivery.attemptId === latest.executorAttemptId) return `第 ${delivery.sequence} 次交付 · ${clockText(delivery.deliveredAt)}`;
  return `${clockText(latest.createdAt)} 交付`;
}
