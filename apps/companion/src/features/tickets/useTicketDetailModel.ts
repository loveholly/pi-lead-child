import type {
  KernelIntervention, KernelInterventionRef, TicketActionId as TicketOperationId, TicketActionRunRequest, TicketReviewerInfo,
} from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TicketRestoreMode } from '@pi-lead-child/client';

import {
  checkpointToPresentation,
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

// 一张工单详情需要的全部数据和动作：读 hooks、算视图模型、包好动作的进行中和出错状态。
// 工单面板（TicketThread）和「证据与记录」都读它，谁都不再自己推导（AGENTS.md：每个界面从同一个 TicketSummary 推导当前状态）。
export type TicketDetailModel = Omit<TicketThreadProps, 'onClose' | 'standalone' | 'showComposer'>;

export function useTicketDetailModel(
  ticket: Ticket,
  { onOpenTicket }: { onOpenTicket?: (ticketId: number) => void } = {},
): TicketDetailModel {
  const runtime = useCompanionRuntime();
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
  const { actions, resource: actionsResource } = useTicketActions(ticketId);
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
      setActionRequest({ ticketId, pendingActionId: null, error: actionErrorText(error) });
    }
  };

  // 还不在操作清单里的 4 个操作走旧接口（legacyTicketActions.ts 写了为什么、什么时候换）。
  const runLegacyOperation = async (action: LegacyTicketActionId, options: { restoreMode?: TicketRestoreMode } = {}) => {
    if (currentActionRequest.pendingActionId !== null) return;
    setActionRequest({ ticketId, pendingActionId: action, error: null });
    try {
      if (action === 'release') {
        if (!ticket.workspace) throw new Error('这张工单没有工作区。');
        await runtime.performWorkspaceAction(ticket.workspace.id, 'release');
      } else {
        await runtime.performTicketAction(ticketId, action, options.restoreMode ? { restoreMode: options.restoreMode } : {});
      }
      setActionRequest({ ticketId, pendingActionId: null, error: null });
    } catch (error) {
      setActionRequest({ ticketId, pendingActionId: null, error: actionErrorText(error) });
    }
  };

  const loadOlderCheckpoints = async () => {
    if (currentPaginationRequest.loading) return;
    setPaginationRequest({ ticketId, loading: true, error: null });
    try {
      await runtime.loadOlderCheckpoints(ticketId);
      setPaginationRequest({ ticketId, loading: false, error: null });
    } catch (error) {
      setPaginationRequest({ ticketId, loading: false, error: errorText(error) });
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
      setDelegationRequest({ ticketId, pending: false, error: actionErrorText(error) });
    }
  };
  const checkpointPagination: CheckpointFeedPagination = {
    hasMore: checkpointPage?.hasMore ?? false,
    loading: currentPaginationRequest.loading,
    error: currentPaginationRequest.error,
    onLoadOlder: checkpointPage?.hasMore && connected ? () => void loadOlderCheckpoints() : undefined,
  };
  const checkpointFeedResource = {
    ...resourceToCheckpointFeedResource(phase, checkpointResource, connectionState),
    pagination: checkpointPagination,
  };

  const checkpointItems = useMemo(
    () => checkpoints.map(checkpointToPresentation),
    [checkpoints],
  );
  const interventionAuthorities = useMemo(() => Object.fromEntries(
    interventions.map((intervention) => {
      const full = isFullIntervention(intervention);
      return [intervention.id, full
        ? interventionToAuthority(intervention, interventionResource?.state === 'ready' && connected)
        : interventionRefAuthority(intervention as KernelInterventionRef)];
    }),
  ) as Record<string, InterventionAuthority>, [connected, interventionResource?.state, interventions]);
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
  const lifecycleItems = useMemo(() => buildLifecyclePresentation({
    ticketId,
    detail,
    activities,
    leadName,
  }), [activities, detail, leadName, ticketId]);
  const reviewState = tickets.find((item) => item.id === ticketId)?.reviewState ?? null;
  // 一次 Run 的用途和结论只算一次：执行尝试、运行日志和进展记录都读它（runFacts）。
  const runFacts = useMemo(
    () => buildRunFacts({ attempts, activities, review: reviewState }),
    [activities, attempts, reviewState],
  );
  const attemptItems = useMemo(() => buildAttemptPresentation(attempts, runFacts), [attempts, runFacts]);
  // 概览上的「经过」：每件事一行，连续的失败合成一行（复核 P1-2）。
  const story = useMemo(() => buildTicketStory({
    created: detail ? { at: detail.createdAt, by: detail.createdBy ?? null } : null,
    attempts,
    activities,
    facts: runFacts,
    leadName,
  }), [activities, attempts, detail, leadName, runFacts]);
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
  const chatReceipt = useMemo(() => latestUserAction(activities, leadName), [activities, leadName]);
  // 有 Run 在跑时每 15 秒走一次表：进度上的「已 N 分钟」和「可能卡住了」靠它更新。
  const runInFlight = attempts.some((attempt) => attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused');
  const now = useNow(runInFlight ? 15_000 : null);
  const liveRun = useMemo(() => liveRunProgress(attempts, runFacts, now), [attempts, now, runFacts]);
  const logRuns = useMemo<TicketLogRunPresentation[]>(() => attemptItems.map((attempt) => ({
    id: attempt.id,
    purposeLabel: attempt.purposeLabel,
    choice: attempt.choice,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    result: attempt.result,
    logs: buildTicketLogPresentation(logsByAttemptId[attempt.id] ?? []),
  })), [attemptItems, logsByAttemptId]);
  const logAttemptId = activeAttemptId;
  const logItems = useMemo<TicketLogPresentation[]>(() => (
    logAttemptId === null ? [] : logRuns.find((run) => run.id === logAttemptId)?.logs ?? []
  ), [logAttemptId, logRuns]);
  const relationItems = useMemo(() => buildRelationPresentation(detail, tickets, leadName), [detail, leadName, tickets]);
  const enrichedTicket = useMemo(() => {
    const summary = tickets.find((item) => item.id === ticketId);
    if (!summary) return { ...ticket, elapsedMs: timing?.elapsedMs ?? ticket.elapsedMs };
    if (!timing && !activeAttempt) return {
      ...ticketSummaryToTicket(summary),
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
      }),
      ...(ticket.displayId ? { displayId: ticket.displayId } : {}),
    };
  }, [activeAttempt, checkpoints, interventionAuthorities, ticket, ticketId, tickets, timing, workbench?.progress]);

  const legacyActions = useMemo(() => legacyTicketActions(enrichedTicket, {
    cancelledChildCount: childTickets.filter((child) => child.state === 'cancelled').length,
  }), [childTickets, enrichedTicket]);
  // 工单信息和用量：建单、更新、截止、预算、累计的 token 和成本。
  const summary = tickets.find((item) => item.id === ticketId);
  const facts = useMemo(() => detail ? {
    createdAt: detail.createdAt,
    createdBy: detail.createdBy ?? null,
    updatedAt: summary?.updatedAt ?? detail.ticket.updatedAt,
    dueAt: summary?.dueAt ?? detail.ticket.dueAt,
    totalTokens: detail.totalTokens,
    totalCostUsd: detail.totalCostUsd,
    tokenBudget: workbench?.budget?.tokenBudget ?? null,
    costBudgetUsd: workbench?.budget?.costBudgetUsd ?? null,
  } : null, [detail, summary?.dueAt, summary?.updatedAt, workbench?.budget]);
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
    return { ...(profile ?? { runtime: '系统选', model: null, effort: null }), status };
  }, [attempts, enrichedTicket, reviewerInfo, ticketId]);
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
        .catch((error) => setResolutionRequest({ ticketId, error: actionErrorText(error) }));
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法读取更早的 Checkpoint。';
}

function actionErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/user control plane unavailable/i.test(message)) return '当前连接是只读环境，不能执行这个动作。工单状态未改变；请切换到真实 daemon 后重试。';
  if (/not connected|disconnected|reconnecting|timeout/i.test(message)) return '连接中断或响应超时，操作结果尚未确认。连接恢复后请先刷新工单状态，再决定是否重试。';
  return message ? `操作未完成：${message}` : '未能确认操作结果。请刷新工单状态后再决定是否重试。';
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
