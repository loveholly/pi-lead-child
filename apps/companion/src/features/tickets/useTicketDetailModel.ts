import type {
  DeliverySummary, KernelIntervention, KernelInterventionRef, TicketActionId as TicketOperationId, TicketActionRunRequest,
  ReviewEvidence, TicketAttachment, TicketReviewerInfo, TicketUsage,
} from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TicketRestoreMode } from '@pi-lead-child/client';

import { useLocale, type Locale } from '@/i18n';

import {
  checkpointPresentationFor,
  interventionActionRequest,
  interventionToAuthority,
  resourceToCheckpointFeedResource,
  ticketSummaryToTicket,
  type InterventionAuthority,
  type Ticket,
} from '@/features/workspace/model';
import { runtimeDisplayName } from '@/features/workspace/runtimeNames';
import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '@/state/CompanionStateProvider';
import {
  useAttemptLogsByAttempt,
  useConnectionPhase,
  useConnectionState,
  useLeadName,
  useTicketCheckpoints,
  useTicketArtifacts,
  useTicketInterventions,
  useTicketAcceptanceCriteria,
  useTicketActions,
  useTicketDelivery,
  useTicketDetail,
  useTicketExecution,
  useTicketExecutionPlan,
  useTicketMessageIds,
  useTickets,
  useTicketWorkbench,
} from '@/state/hooks';

import type { ChildTicketPresentation, TicketLogPresentation, TicketThreadProps } from './TicketThread';
import type { TicketLogRunPresentation } from './LogTimeline';
import { deliveryNumbersOf } from './deliveryNumbers';
import { legacyTicketActions, type LegacyTicketActionId } from './legacyTicketActions';
import { reviewerStatus } from './ticketDetailSections';
import {
  buildAttemptPresentation,
  buildLifecyclePresentation,
  buildRelationPresentation,
  selectDisplayedAttemptId,
} from './ticketHistory';
import { buildTicketLogPresentation } from './ticketLogs';
import { buildRunFacts } from './runFacts';
import { buildTicketStory } from './ticketStory';
import { latestUserAction, liveRunProgress } from './ticketChatStatus';
import { useNow } from './useNow';
import type { CheckpointFeedPagination } from './CheckpointFeed';
import { ticketThreadMessages } from './ticketThread.messages';
import { localizeTicketActions } from './ticketActionLabels.messages';

// 一张工单详情需要的全部数据和动作：读 hooks、算视图模型、包好动作的进行中和出错状态。
// 工单面板（TicketThread）和「证据与记录」都读它，谁都不再自己推导（AGENTS.md：每个界面从同一个 TicketSummary 推导当前状态）。
export type TicketDetailModel = Omit<TicketThreadProps, 'onClose' | 'standalone' | 'showComposer'>;

const EMPTY_ATTACHMENTS: TicketAttachment[] = [];
const EMPTY_EVIDENCE: ReviewEvidence[] = [];

export function useTicketDetailModel(
  ticket: Ticket,
  { onOpenTicket }: { onOpenTicket?: (ticketId: number) => void } = {},
): TicketDetailModel {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = ticketThreadMessages(locale);
  const phase = useConnectionPhase();
  const connectionState = useConnectionState();
  const connected = connectionState === 'connected';
  const ticketId = Number(ticket.id);
  const tickets = useTickets();
  const { detail } = useTicketDetail(ticketId);
	  const { activities, attempts, resource: executionResource } = useTicketExecution(ticketId);
	  const ticketMessageIds = useTicketMessageIds(ticketId);
	  const { workbench, timing } = useTicketWorkbench(ticketId);
  const { checkpoints, resource: checkpointResource } = useTicketCheckpoints(ticketId);
  const { artifacts, resource: artifactResource } = useTicketArtifacts(ticketId);
  const { interventions, resource: interventionResource } = useTicketInterventions(ticketId);
  // 工单详情的新数据走单独的接口（工单 03–06），不往 TicketSummary 里加字段。
  const { actions: rawActions, resource: actionsResource } = useTicketActions(ticketId);
  // daemon 的清单只给中文名：按界面语言换掉，按钮和页面上别的文字用同一种语言。
  const actions = useMemo(() => localizeTicketActions(rawActions, locale), [rawActions, locale]);
  // 清单读到了没有：读取中、读不到时底部操作栏要说出来，不能只是没有按钮。
  const actionsStatus = actionsResource?.state === 'error'
    ? 'error' as const
    : actionsResource?.state === 'unsupported'
      // 这个连接读不了（例如配对没有 tickets:view）：说出来，不当成「读到了、什么都不能做」。
      ? 'unsupported' as const
      : actionsResource?.state === 'ready' || actionsResource?.state === 'stale'
        ? 'ready' as const
        : 'loading' as const;
  const { criteria: acceptanceCriteria } = useTicketAcceptanceCriteria(ticketId);
  const { plan: executionPlan } = useTicketExecutionPlan(ticketId);
  const { delivery } = useTicketDelivery(ticketId);
  const activeAttemptId = useMemo(
    () => selectDisplayedAttemptId(attempts, workbench?.activeAttemptId ?? null),
    [attempts, workbench?.activeAttemptId],
  );
  const activeAttempt = useControlPlaneStore((state) => activeAttemptId === null
    ? undefined
    : state.attemptsById[activeAttemptId]?.kernel);
  const logAttemptIds = useMemo(() => attempts.map((attempt) => attempt.id), [attempts]);
  const { logsByAttemptId } = useAttemptLogsByAttempt(logAttemptIds);
  const selectTicket = useWorkspaceStore((state) => state.selectTicket);
  const interventionCommandStates = useWorkspaceStore((state) => state.interventionCommandStateById);
  const artifactDownloadStates = useWorkspaceStore((state) => state.artifactDownloadStateById);
  const checkpointPage = useControlPlaneStore((state) => state.checkpointPagesByTicket[ticketId]);
  const [paginationRequest, setPaginationRequest] = useState<{
    ticketId: number;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const currentPaginationRequest = paginationRequest?.ticketId === ticketId
    ? paginationRequest
    : { ticketId, loading: false, error: null };
  const [actionRequest, setActionRequest] = useState<{
    ticketId: number;
    pendingActionId: TicketOperationId | LegacyTicketActionId | null;
    error: string | null;
  } | null>(null);
  const [delegationRequest, setDelegationRequest] = useState<{
    ticketId: number;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const [resolutionRequest, setResolutionRequest] = useState<{ ticketId: number; error: string | null } | null>(null);
  // 切换工单时把上一张的 pending/error 丢掉，而不是让它跟着显示到新工单上。
  const currentActionRequest = actionRequest?.ticketId === ticketId
    ? actionRequest
    : { ticketId, pendingActionId: null, error: null };
  const currentDelegationRequest = delegationRequest?.ticketId === ticketId
    ? delegationRequest
    : { ticketId, pending: false, error: null };

  // 页面上会改后端的按钮都走工单操作（工单 03）：和 Lead 的 ticket_action 是同一个函数。
  const runOperation = async (action: TicketOperationId, request: TicketActionRunRequest = {}) => {
    if (currentActionRequest.pendingActionId !== null) return;
    setActionRequest({ ticketId, pendingActionId: action, error: null });
    try {
      await runtime.runTicketAction(ticketId, action, request);
      setActionRequest({ ticketId, pendingActionId: null, error: null });
    } catch (error) {
      setActionRequest({ ticketId, pendingActionId: null, error: actionErrorText(error, locale) });
    }
  };

  // 还不在操作清单里的 4 个操作走旧接口（legacyTicketActions.ts 写了为什么、什么时候换）。
  const runLegacyOperation = async (action: LegacyTicketActionId, options: { restoreMode?: TicketRestoreMode } = {}) => {
    if (currentActionRequest.pendingActionId !== null) return;
    setActionRequest({ ticketId, pendingActionId: action, error: null });
    try {
      if (action === 'release') {
        if (!ticket.workspace) throw new Error(m.noWorkspace);
        await runtime.performWorkspaceAction(ticket.workspace.id, 'release');
      } else {
        await runtime.performTicketAction(ticketId, action, options.restoreMode ? { restoreMode: options.restoreMode } : {});
      }
      setActionRequest({ ticketId, pendingActionId: null, error: null });
    } catch (error) {
      setActionRequest({ ticketId, pendingActionId: null, error: actionErrorText(error, locale) });
    }
  };

  const loadOlderCheckpoints = async () => {
    if (currentPaginationRequest.loading) return;
    setPaginationRequest({ ticketId, loading: true, error: null });
    try {
      await runtime.loadOlderCheckpoints(ticketId);
      setPaginationRequest({ ticketId, loading: false, error: null });
    } catch (error) {
      setPaginationRequest({ ticketId, loading: false, error: errorText(error, locale) });
    }
  };

  const setLeadDelegation = async (granted: boolean) => {
    if (currentDelegationRequest.pending) return;
    setDelegationRequest({ ticketId, pending: true, error: null });
    try {
      await runtime.setLeadDelegation(ticketId, granted, granted
        ? { maxReworkCycles: 1 }
        : { reason: 'revoked from Companion' });
      setDelegationRequest({ ticketId, pending: false, error: null });
    } catch (error) {
      setDelegationRequest({ ticketId, pending: false, error: actionErrorText(error, locale) });
    }
  };
  const checkpointPagination: CheckpointFeedPagination = {
    hasMore: checkpointPage?.hasMore ?? false,
    loading: currentPaginationRequest.loading,
    error: currentPaginationRequest.error,
    onLoadOlder: checkpointPage?.hasMore && connected ? () => void loadOlderCheckpoints() : undefined,
  };
  const checkpointFeedResource = {
    ...resourceToCheckpointFeedResource(phase, checkpointResource, connectionState, locale),
    pagination: checkpointPagination,
  };

  const checkpointItems = useMemo(
    () => checkpoints.map(checkpointPresentationFor(locale)),
    [checkpoints, locale],
  );
  const interventionAuthorities = useMemo(() => Object.fromEntries(
    interventions.map((intervention) => {
      const full = isFullIntervention(intervention);
      return [intervention.id, full
        ? interventionToAuthority(intervention, interventionResource?.state === 'ready' && connected, locale)
        : interventionRefAuthority(intervention as KernelInterventionRef)];
    }),
  ) as Record<string, InterventionAuthority>, [connected, interventionResource?.state, interventions, locale]);
  const ticketDetails = useControlPlaneStore((state) => state.ticketDetailsById);
  const childTickets = useMemo<ChildTicketPresentation[]>(() => {
    const byId = new Map(tickets.map((item) => [item.id, item]));
    return (workbench?.childTicketIds ?? []).flatMap((childId) => {
      const child = byId.get(childId);
      if (!child) return [];
      // 谁拆的：子工单的详情读过时才知道（建单的是 Lead 还是执行 agent）。
      const createdBy = ticketDetails[childId]?.createdBy;
      return [{
        id: String(child.id),
        displayId: String(child.id),
        title: child.displayTitle ?? child.title,
        // 迁移前这一支写的是 'in_progress'，而协议里从来没有这个取值——tsc 看不见 apps/，
        // 于是这条分支永远不成立，正在跑的子工单一律显示成 waiting。
        state: child.status === 'done'
          ? 'done'
          : child.status === 'cancelled'
            ? 'cancelled'
          : child.status === 'blocked'
            ? 'blocked'
            : child.status === 'review'
              ? 'review'
            : child.status === 'active'
              ? 'running'
              : 'waiting',
        ...(createdBy ? { createdBy } : {}),
      }];
    });
  }, [ticketDetails, tickets, workbench?.childTicketIds]);
  const leadName = useLeadName();
  const reviewState = tickets.find((item) => item.id === ticketId)?.reviewState ?? null;
  // 一次 Run 的用途和结论只算一次：执行尝试、运行日志和进展记录都读它（runFacts）。
  const runFacts = useMemo(
    () => buildRunFacts({ attempts, activities, review: reviewState }),
    [activities, attempts, reviewState],
  );
  const lifecycleItems = useMemo(() => buildLifecyclePresentation({
    ticketId,
    detail,
    activities,
    leadName,
    facts: runFacts,
    locale,
  }), [activities, detail, leadName, locale, runFacts, ticketId]);
  // 交付写「第 N 次交付」（设计规范 P14.6）：序号来自交付列表（GET /v1/tickets/:id/deliveries）。
  // 不放进工单快照：工单列表是严格校验的，加字段会让旧页面整张列表加载失败。工单变了再读一次；读不到时写「最新的交付」。
  const [deliveryList, setDeliveryList] = useState<{ ticketId: number; deliveries: DeliverySummary[] } | null>(null);
  const deliveriesKey = tickets.find((item) => item.id === ticketId)?.updatedAt ?? '';
  useEffect(() => {
    if (!connected) return undefined;
    const controller = new AbortController();
    runtime.getTicketDeliveries(ticketId, controller.signal)
      .then((deliveries) => setDeliveryList({ ticketId, deliveries }))
      .catch(() => {});
    return () => controller.abort();
  }, [connected, deliveriesKey, runtime, ticketId]);
  const deliveryNumbers = useMemo(() => deliveryNumbersOf(
    deliveryList?.ticketId === ticketId ? deliveryList.deliveries : [],
    acceptanceCriteria?.delivery ?? null,
  ), [acceptanceCriteria?.delivery, deliveryList, ticketId]);
  // 工单附件（工单 #231，GET /v1/tickets/:id/attachments）：不放进工单快照，理由和交付列表一样。工单变了再读一次
  // （Lead 挂附件时会改工单的更新时间）。读不到时（旧 daemon）按没有附件画。
  const [attachmentList, setAttachmentList] = useState<{ ticketId: number; attachments: TicketAttachment[] } | null>(null);
  useEffect(() => {
    if (!connected) return undefined;
    const controller = new AbortController();
    runtime.getTicketAttachments(ticketId, controller.signal)
      .then((attachments) => setAttachmentList({ ticketId, attachments }))
      .catch(() => {});
    return () => controller.abort();
  }, [connected, deliveriesKey, runtime, ticketId]);
  const attachments = attachmentList?.ticketId === ticketId ? attachmentList.attachments : EMPTY_ATTACHMENTS;
  const loadAttachment = useCallback(
    (attachmentId: string) => runtime.loadTicketAttachment(ticketId, attachmentId),
    [runtime, ticketId],
  );
  // 核查证据（工单 #503，GET /v1/tickets/:id/review-evidence）：和附件一样单独读，工单变了再读一次
  // （挂上证据时会改工单的更新时间）。读不到时（旧 daemon）按没有证据画。
  const [evidenceList, setEvidenceList] = useState<{ ticketId: number; evidence: ReviewEvidence[] } | null>(null);
  useEffect(() => {
    if (!connected) return undefined;
    const controller = new AbortController();
    runtime.getTicketReviewEvidence(ticketId, controller.signal)
      .then((evidence) => setEvidenceList({ ticketId, evidence }))
      .catch(() => {});
    return () => controller.abort();
  }, [connected, deliveriesKey, runtime, ticketId]);
  const reviewEvidence = evidenceList?.ticketId === ticketId ? evidenceList.evidence : EMPTY_EVIDENCE;
  const loadEvidence = useCallback(
    (evidenceId: string) => runtime.loadTicketReviewEvidence(ticketId, evidenceId),
    [runtime, ticketId],
  );
  const attemptItems = useMemo(() => buildAttemptPresentation(attempts, runFacts, locale), [attempts, locale, runFacts]);
  // 概览上的「经过」：每件事一行，连续的失败合成一行（复核 P1-2）。
  const story = useMemo(() => buildTicketStory({
    created: detail ? { at: detail.createdAt, by: detail.createdBy ?? null } : null,
    attempts,
    activities,
    facts: runFacts,
    deliveryNumbers,
    leadName,
    locale,
  }), [activities, attempts, deliveryNumbers, detail, leadName, locale, runFacts]);
  // 对话坞（方案 D）：展开状态和看过的最后一条消息放在工作区 store，会话里的回执能直接打开对话。
  const chatExpanded = useWorkspaceStore((state) => state.ticketChatExpandedId === ticketId);
  const chatSeenMessageId = useWorkspaceStore((state) => state.ticketChatSeenByTicket[ticketId] ?? null);
  const setTicketChatExpanded = useWorkspaceStore((state) => state.setTicketChatExpanded);
  const markTicketChatSeen = useWorkspaceStore((state) => state.markTicketChatSeen);
  const onChatExpandedChange = useCallback(
    (expanded: boolean) => setTicketChatExpanded(ticketId, expanded),
    [setTicketChatExpanded, ticketId],
  );
  const onChatSeen = useCallback((messageId: string) => markTicketChatSeen(ticketId, messageId), [markTicketChatSeen, ticketId]);
  const recordsOpen = useWorkspaceStore((state) => state.ticketRecordsOpenId === ticketId);
  const setTicketRecordsOpen = useWorkspaceStore((state) => state.setTicketRecordsOpen);
  const onRecordsOpenChange = useCallback((open: boolean) => setTicketRecordsOpen(ticketId, open), [setTicketRecordsOpen, ticketId]);
  const chatReceipt = useMemo(() => latestUserAction(activities, leadName, locale), [activities, leadName, locale]);
  // 有 Run 在跑时每 15 秒走一次表：进度上的「已 N 分钟」和「可能卡住了」靠它更新。
  const runInFlight = attempts.some((attempt) => attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused');
  const now = useNow(runInFlight ? 15_000 : null);
  const liveRun = useMemo(() => liveRunProgress(attempts, runFacts, now, locale), [attempts, locale, now, runFacts]);
  const logRuns = useMemo<TicketLogRunPresentation[]>(() => attemptItems.map((attempt) => ({
    id: attempt.id,
    purposeLabel: attempt.purposeLabel,
    choice: attempt.choice,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    result: attempt.result,
    logs: buildTicketLogPresentation(logsByAttemptId[attempt.id] ?? [], locale),
  })), [attemptItems, locale, logsByAttemptId]);
  const logAttemptId = activeAttemptId;
  const logItems = useMemo<TicketLogPresentation[]>(() => (
    logAttemptId === null ? [] : logRuns.find((run) => run.id === logAttemptId)?.logs ?? []
  ), [logAttemptId, logRuns]);
  const relationItems = useMemo(() => buildRelationPresentation(detail, tickets, leadName, locale), [detail, leadName, locale, tickets]);
  const enrichedTicket = useMemo(() => {
    const summary = tickets.find((item) => item.id === ticketId);
    if (!summary) return { ...ticket, elapsedMs: timing?.elapsedMs ?? ticket.elapsedMs };
    if (!timing && !activeAttempt) return {
      ...ticketSummaryToTicket(summary, undefined, locale),
      ...(ticket.displayId ? { displayId: ticket.displayId } : {}),
    };
    return {
      ...ticketSummaryToTicket(summary, {
      ticketId,
      timing: timing ?? {
        firstStartedAt: null,
        completedAt: null,
        statusChangedAt: null,
        computedAt: summary.updatedAt,
        elapsedMs: null,
        activeExecutionMs: 0,
        statusDurationMs: null,
      },
      activeExecution: activeAttempt ? {
        attemptId: activeAttempt.id,
        role: activeAttempt.role,
        runtime: activeAttempt.runtime,
        state: activeAttempt.state,
        model: activeAttempt.model,
        externalSessionId: activeAttempt.externalSessionId,
      } : null,
      pendingInterventionCount: Object.values(interventionAuthorities).filter((item) => item.state === 'pending').length,
      latestCheckpointId: checkpoints[0]?.id ?? null,
      progress: workbench?.progress ?? null,
      }, locale),
      ...(ticket.displayId ? { displayId: ticket.displayId } : {}),
    };
  }, [activeAttempt, checkpoints, interventionAuthorities, locale, ticket, ticketId, tickets, timing, workbench?.progress]);

  const legacyActions = useMemo(() => legacyTicketActions(enrichedTicket, {
    cancelledChildCount: childTickets.filter((child) => child.state === 'cancelled').length,
    locale,
  }), [childTickets, enrichedTicket, locale]);
  // 工单信息和用量：建单、更新、截止、预算、累计的 token 和成本。
  const summary = tickets.find((item) => item.id === ticketId);
  // token 按计费拆开（GET /v1/tickets/:id/usage）。用量变了再读一次；旧 daemon 没有这个接口时只显示总数。
  const [usage, setUsage] = useState<{ ticketId: number; usage: TicketUsage } | null>(null);
  const usageKey = `${detail?.totalTokens ?? ''}:${summary?.updatedAt ?? ''}`;
  useEffect(() => {
    if (!connected || !detail) return undefined;
    const controller = new AbortController();
    runtime.getTicketUsage(ticketId, controller.signal)
      .then((next) => setUsage({ ticketId, usage: next }))
      .catch(() => {});
    return () => controller.abort();
  }, [connected, Boolean(detail), usageKey, runtime, ticketId]);
  const usageParts = usage?.ticketId === ticketId ? usage.usage : null;
  const facts = useMemo(() => detail ? {
    createdAt: detail.createdAt,
    createdBy: detail.createdBy ?? null,
    updatedAt: summary?.updatedAt ?? detail.ticket.updatedAt,
    dueAt: summary?.dueAt ?? detail.ticket.dueAt,
    totalTokens: detail.totalTokens,
    totalCostUsd: detail.totalCostUsd,
    tokenBudget: workbench?.budget?.tokenBudget ?? null,
    costBudgetUsd: workbench?.budget?.costBudgetUsd ?? null,
    usageParts,
  } : null, [detail, summary?.dueAt, summary?.updatedAt, workbench?.budget, usageParts]);
  // 执行者：最近一次执行 Run 用的 runtime、模型和强度。
  const executor = useMemo(() => {
    const latest = [...attempts].reverse().find((attempt) => attempt.role === 'executor');
    if (!latest?.runtime) return null;
    return { runtime: runtimeDisplayName(latest.runtime) ?? latest.runtime, model: latest.model ?? null, effort: latest.effort ?? null };
  }, [attempts]);
  // 核查员：排着、挂起或在跑的核查用的核查员；没有时是下一次会用的（GET /v1/tickets/:id/reviewer）。
  const [reviewerInfo, setReviewerInfo] = useState<{ ticketId: number; info: TicketReviewerInfo } | null>(null);
  const reviewerKey = `${summary?.updatedAt ?? ''}:${summary?.reviewState?.reviewProgress ?? ''}`;
  useEffect(() => {
    if (!connected || enrichedTicket.verificationPolicy !== 'independent_reviewer') return undefined;
    const controller = new AbortController();
    runtime.getTicketReviewer(ticketId, controller.signal)
      .then((info) => setReviewerInfo({ ticketId, info }))
      .catch(() => {});
    return () => controller.abort();
  }, [connected, enrichedTicket.verificationPolicy, reviewerKey, runtime, ticketId]);
  const reviewer = useMemo(() => {
    const latestReview = [...attempts].reverse().find((attempt) => attempt.role === 'reviewer') ?? null;
    const status = reviewerStatus(enrichedTicket, latestReview);
    if (status === null) return null;
    const chosen = reviewerInfo?.ticketId === ticketId ? reviewerInfo.info.reviewer : null;
    const fromInfo = chosen ? { runtime: chosen.displayName, model: chosen.model ?? null, effort: chosen.effort ?? null } : null;
    const fromRun = latestReview?.runtime
      ? { runtime: runtimeDisplayName(latestReview.runtime) ?? latestReview.runtime, model: latestReview.model ?? null, effort: latestReview.effort ?? null }
      : null;
    // 核查做完或没做成时，写做了那次核查的核查员；还没开始或在路上时，写接口给的（排着的、下一次会用的）。
    const settled = status === 'done' || status === 'failed';
    const profile = settled ? fromRun ?? fromInfo : fromInfo ?? fromRun;
    return { ...(profile ?? { runtime: m.systemChooses, model: null, effort: null }), status };
  }, [attempts, enrichedTicket, m, reviewerInfo, ticketId]);
  // 「拆成子工单」等入口：往工单对话的输入框里预填一句话（D9）。输入框按 composerRevision 重新读草稿。
  const setComposerDraft = useWorkspaceStore((state) => state.setComposerDraft);
  const [composerRevision, setComposerRevision] = useState(0);
  const prefillChat = useCallback((text: string) => {
    setComposerDraft(`ticket:${ticketId}`, text);
    setComposerRevision((revision) => revision + 1);
  }, [setComposerDraft, ticketId]);

  const artifactCapability = artifactResource?.state === 'unsupported'
    ? 'unsupported'
    : artifacts.length > 0 || artifactResource?.state === 'ready' || artifactResource?.state === 'stale'
      ? 'available'
      : 'loading';

  return {
    ticket: enrichedTicket,
    timing,
    checkpoints: checkpointItems,
    checkpointResource: checkpointFeedResource,
    interventions: interventionAuthorities,
    interventionCommandStates,
    logs: logItems,
    logRuns,
    messageIds: ticketMessageIds,
    childTickets,
    lifecycle: lifecycleItems,
    attempts: attemptItems,
    runFacts,
    story,
    chatExpanded,
    onChatExpandedChange,
    chatSeenMessageId,
    onChatSeen,
    chatReceipt,
    liveRun,
    recordsOpen,
    onRecordsOpenChange,
    relations: relationItems,
    executionResource,
    onRetryExecution: connected ? () => void runtime.ensureTicketExecution(ticketId).catch(() => {}) : undefined,
    pow: workbench?.pow ?? null,
    outcome: workbench?.outcomeSnapshot ?? null,
    taskDescription: detail ? { brief: detail.brief, body: detail.body } : undefined,
    attachments,
    onLoadAttachment: loadAttachment,
    reviewEvidence,
    onLoadReviewEvidence: loadEvidence,
    artifacts,
    artifactCapability,
    artifactDownloadStates,
    onDownloadArtifact: (artifactId) => void runtime.downloadArtifact(ticketId, artifactId).catch(() => {}),
    onCancelArtifactDownload: (artifactId) => runtime.cancelArtifactDownload(artifactId),
    onResolveIntervention: connected ? (interventionId, actionId, customResponse) => {
      setResolutionRequest({ ticketId, error: null });
      void runtime.resolveIntervention(
        interventionId,
        interventionActionRequest(interventionId, actionId, customResponse),
      ).then(() => setResolutionRequest({ ticketId, error: null }))
        .catch((error) => setResolutionRequest({ ticketId, error: actionErrorText(error, locale) }));
    } : undefined,
    resolutionError: resolutionRequest?.ticketId === ticketId ? resolutionRequest.error : null,
    onRetryCheckpoints: connected ? () => void runtime.refreshCheckpoints(ticketId).catch(() => {}) : undefined,
    onOpenTicket: (childId) => {
      const id = Number(childId);
      if (onOpenTicket) onOpenTicket(id);
      else selectTicket(id);
    },
    // 断线时也能发：消息先进本机发件箱，连接恢复后发送。
    onSendMessage: (message) => void runtime.sendChat(message, ticketId).catch(() => {}),
    chatResume: detail?.chatResume ?? null,
    actions,
    acceptanceCriteria,
    executionPlan,
    delivery,
    deliveryNumbers,
    facts,
    executor,
    reviewer,
    onRunAction: connected ? (action, request) => void runOperation(action, request) : undefined,
    actionState: {
      pendingActionId: currentActionRequest.pendingActionId,
      error: currentActionRequest.error,
    },
    onPrefillChat: prefillChat,
    legacyActions,
    onLegacyAction: connected ? (action, options) => void runLegacyOperation(action, options) : undefined,
    actionsStatus,
    onRetryActions: connected ? () => void runtime.reloadTicketActions(ticketId).catch(() => {}) : undefined,
    ticketLink: ticketLink(runtime.endpoint(), ticket.displayId ?? ticket.id),
    composerRevision,
    onSetLeadDelegation: connected ? (granted) => void setLeadDelegation(granted) : undefined,
    delegationActionState: {
      pending: currentDelegationRequest.pending,
      error: currentDelegationRequest.error,
    },
  };
}

function errorText(error: unknown, locale: Locale): string {
  return error instanceof Error ? error.message : ticketThreadMessages(locale).olderCheckpointsError;
}

function actionErrorText(error: unknown, locale: Locale): string {
  const m = ticketThreadMessages(locale);
  const message = error instanceof Error ? error.message : '';
  if (/user control plane unavailable/i.test(message)) return m.readOnly;
  if (/not connected|disconnected|reconnecting|timeout/i.test(message)) return m.disconnected;
  return message ? m.actionFailed(message) : m.actionUnknown;
}

// 工单的链接：web 上用这一页的地址；手机应用里没有网页的地址，用连着的 daemon 的地址（daemon 也提供网页）。
function ticketLink(endpoint: string | null, ticketId: string): string {
  const origin = typeof window !== 'undefined' && window.location?.origin?.startsWith('http')
    ? window.location.origin
    : endpoint?.replace(/\/+$/, '') ?? '';
  return `${origin}/ticket/${ticketId}`;
}

function isFullIntervention(
  intervention: KernelIntervention | KernelInterventionRef,
): intervention is KernelIntervention {
  return 'authorityId' in intervention;
}

function interventionRefAuthority(
  intervention: KernelInterventionRef,
): InterventionAuthority {
  return {
    id: intervention.id,
    kind: intervention.kind === 'approval' ? 'approval' : 'decision',
    state: intervention.state === 'approved'
      ? 'resolved'
      : intervention.state === 'dismissed'
        ? 'dismissed'
        : intervention.state,
    canRespond: false,
  };
}
