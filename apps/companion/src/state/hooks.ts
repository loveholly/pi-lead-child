import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { useCompanionRuntime, useControlPlaneStore, useStreamStore } from './CompanionStateProvider';
import {
  EMPTY_IDS,
  selectAgendaIds,
  selectApprovalIds,
  selectPhase,
  selectProjectIds,
  selectCheckpointIdsNewestFirst,
  selectConversationCardsForTicket,
  selectInterventionsForTicket,
  selectTicketIds,
  selectWorkItemIds,
} from './selectors';
import { RESOURCE_KEYS, type MessagePart, type ResourceKey } from './types';
import { servedWebVersion, webUpdateAvailable } from './webVersion';
import { leadNameNow } from './leadName';

const EMPTY_BY_ID: Readonly<Record<PropertyKey, never>> = {};
const EMPTY_ACTIONS: import('@pi-lead-child/protocol').TicketAction[] = [];

export function useConnectionPhase() {
  return useControlPlaneStore(selectPhase);
}

export function useConnectionState() {
  return useControlPlaneStore((state) => state.connectionState);
}

export function useControlPlaneError() {
  return useControlPlaneStore((state) => state.error);
}

export function useEndpointMismatch() {
  return useControlPlaneStore((state) => state.endpointMismatch);
}

/** 重新加载 App、拿到新版本的动作。原生应用上没有，返回 null。 */
export function useReloadApp(): (() => void) | null {
  return useCompanionRuntime().dependencies.reloadApp ?? null;
}

/** daemon 提供的网页和这个页面是什么关系（./webVersion）。不受用户收起顶栏提示的影响。 */
export function useServedWebVersion() {
  return useStore(useCompanionRuntime().webVersion, servedWebVersion);
}

/** daemon 提供的网页比这个页面新，并且用户没有收起这个版本的提示（./webVersion）。 */
export function useWebUpdate() {
  const runtime = useCompanionRuntime();
  const available = useStore(runtime.webVersion, webUpdateAvailable);
  return { available, reload: runtime.dependencies.reloadApp ?? null, dismiss: () => runtime.dismissWebUpdate() };
}

export function useOverview() {
  return useControlPlaneStore((state) => state.overview);
}

// Lead 现在在不在一轮里。排队（GET /v1/lead/queue）在 Lead 开始、结束一轮时都会推过来，比概览准：
// 概览只在一轮失败、daemon 状态变了时重取，一轮正常答完以后它的 busy 会一直是 true（2026-10-28 在预览里看到：
// 左栏的 Fairy 答完了还在想）。没有排队（旧 daemon、还没取到）时退回概览。
export function leadBusyFrom(
  queue: Pick<import('@pi-lead-child/protocol').LeadQueue, 'busy'> | null,
  overview: { busy?: boolean } | null,
): boolean {
  return queue ? queue.busy : overview?.busy === true;
}

export function useLeadBusy(): boolean {
  return useControlPlaneStore((state) => leadBusyFrom(state.leadQueue, state.overview));
}

export function useTickets() {
  const ids = useControlPlaneStore((state) => selectTicketIds(state) ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.ticketsById ?? EMPTY_BY_ID);
  return useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
}

export function useProjects() {
  const ids = useControlPlaneStore((state) => selectProjectIds(state) ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.projectsById ?? EMPTY_BY_ID);
  return useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
}

export function useAgenda() {
  const ids = useControlPlaneStore((state) => selectAgendaIds(state) ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.agendaById ?? EMPTY_BY_ID);
  return useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
}

export function useApprovals() {
  const ids = useControlPlaneStore((state) => selectApprovalIds(state) ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.approvalsById ?? EMPTY_BY_ID);
  return useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
}

// 收件箱的服务端事实。收件箱在屏幕上时才取（observeResource），工单和通知变了跟着重取。
export function useInboxView() {
  const runtime = useCompanionRuntime();
  useEffect(() => runtime.observeResource(RESOURCE_KEYS.inbox), [runtime]);
  return useControlPlaneStore((state) => state.inboxView);
}

// 日程（阶段 3）。日程 tab 在屏幕上时才取；工单变了、Lead 改了节点或一句话时跟着重取。
export function useTimeline() {
  const runtime = useCompanionRuntime();
  useEffect(() => runtime.observeResource(RESOURCE_KEYS.timeline), [runtime]);
  return useControlPlaneStore((state) => state.timeline);
}

// 项目卡片。项目 tab 在屏幕上时才取，工单和项目变了跟着重取。
export function useProjectOverviews() {
  const runtime = useCompanionRuntime();
  useEffect(() => runtime.observeResource(RESOURCE_KEYS.projectsOverview), [runtime]);
  return useControlPlaneStore((state) => state.projectOverviews);
}

// 第三方账号的连接（GET /v1/connections）。设置页、角标和会话里的连接卡在屏幕上时才取；
// 网关推 snapshot.required（resource 是 connections）时跟着重取。
export function useConnections() {
  useObservedResource(RESOURCE_KEYS.connections);
  const connections = useControlPlaneStore((state) => state.connections);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.connections]);
  return { connections, resource };
}

// Lead 的记忆设置（GET /v1/memory）和决策模型（GET /v1/decision-model）。设置页在屏幕上时才取；
// 网关推 snapshot.required（resource 是 memory 或 decision-model）时跟着重取，下载进度也是这样更新。
export function useMemorySettings() {
  useObservedResource(RESOURCE_KEYS.memory);
  const memory = useControlPlaneStore((state) => state.memory);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.memory]);
  return { memory, resource };
}

// 设置 → 记忆的 Hindsight 部分（GET /v1/memory/hindsight，2026-10-29）：摘要模型、写入情况、记忆库的统计。
// 设置页在屏幕上时才取；网关推 snapshot.required（resource 是 memory）时跟着重取。改动走 runtime.memorySettingsAction。
export function useMemoryHindsight() {
  useObservedResource(RESOURCE_KEYS.memoryHindsight);
  const memoryHindsight = useControlPlaneStore((state) => state.memoryHindsight);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.memoryHindsight]);
  return { memoryHindsight, resource };
}

// 自定义控件（GET /v1/widgets，2026-10-30）：视图面板里的全部控件，从上到下，各带所在的视图。面板在屏幕上时才取；
// 网关推 snapshot.required（resource 是 widgets）时跟着重取。改、删、排序走 runtime.widgetAction。
export function useWidgets() {
  useObservedResource(RESOURCE_KEYS.widgets);
  const widgets = useControlPlaneStore((state) => state.widgets);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.widgets]);
  return { widgets, resource };
}

// 设置 → 记忆 → 常驻偏好（GET /v1/memory/preferences，2026-10-29）：每一条、最近一次改动、总字数和上限。
// 设置页在屏幕上时才取；网关推 snapshot.required（resource 是 memory）时跟着重取。改、删、撤销走 runtime.memoryAction。
export function useMemoryPreferences() {
  useObservedResource(RESOURCE_KEYS.memoryPreferences);
  const memoryPreferences = useControlPlaneStore((state) => state.memoryPreferences);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.memoryPreferences]);
  return { memoryPreferences, resource };
}

// 设置 → 模型（2026-10-29）：大脑和直觉的分工、服务商和目录。
export function useModelSettings() {
  useObservedResource(RESOURCE_KEYS.modelSettings);
  const modelSettings = useControlPlaneStore((state) => state.modelSettings);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.modelSettings]);
  return { modelSettings, resource };
}

// 首次启动引导（GET /v1/setup）：7 项关键设置配没配好。大脑不能用时整页显示首次启动页（RootTabs）。
export function useSetupStatus() {
  useObservedResource(RESOURCE_KEYS.setup);
  const setup = useControlPlaneStore((state) => state.setup);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.setup]);
  return { setup, resource };
}

export function useDecisionModel() {
  useObservedResource(RESOURCE_KEYS.decisionModel);
  const decisionModel = useControlPlaneStore((state) => state.decisionModel);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.decisionModel]);
  return { decisionModel, resource };
}

// 执行器的开关（GET /v1/runtimes/settings）。设置页「执行器」在屏幕上时才取；snapshot.required（resource 是 runtime-settings）时重取。
export function useRuntimeSettings() {
  useObservedResource(RESOURCE_KEYS.runtimeSettings);
  const runtimeSettings = useControlPlaneStore((state) => state.runtimeSettings);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.runtimeSettings]);
  return { runtimeSettings, resource };
}

// Lead 的名字、人格和互动风格（GET /v1/lead/profile）。连上就取（runtime 的 core 资源里有它）；
// snapshot.required（resource 是 lead-profile）时重取。设置页「身份与风格」读它。
export function useLeadProfile() {
  const leadProfile = useControlPlaneStore((state) => state.leadProfile);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.leadProfile]);
  return { leadProfile, resource };
}

// Lead 的形象（GET /v1/lead/avatar）。连上就取；snapshot.required（resource 是 lead-avatar）时重取。
// 设置页「形象」读它；界面上画形象用 components/leadAvatarSource 的 useLeadAvatarSource。
export function useLeadAvatar() {
  const leadAvatar = useControlPlaneStore((state) => state.leadAvatar);
  const images = useControlPlaneStore((state) => state.leadAvatarImages);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.leadAvatar]);
  return { leadAvatar, images, resource };
}

// 界面的外观偏好（GET /v1/design/preferences）。连上就取；snapshot.required（resource 是 design-preferences）时重取。
export function useDesignPreferences() {
  const designPreferences = useControlPlaneStore((state) => state.designPreferences);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.designPreferences]);
  return { designPreferences, resource };
}

/** 界面上称呼 Lead 用的名字。还没取到时用本机记下的，再没有就是缺省的 Paimon（leadName.ts）。 */
export function useLeadName(): string {
  return useControlPlaneStore((state) => state.leadProfile?.name) ?? leadNameNow();
}

// 外部消息通道的凭据和状态（GET /v1/channels/settings）。设置页「消息通道」在屏幕上时才取；
// snapshot.required（resource 是 channel-settings）时重取：连上、断开、出错都会推。
export function useChannelSettings() {
  useObservedResource(RESOURCE_KEYS.channelSettings);
  const channelSettings = useControlPlaneStore((state) => state.channelSettings);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.channelSettings]);
  return { channelSettings, resource };
}

export function useNotifications() {
  const ids = useControlPlaneStore((state) => state.notificationIds ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.notificationsById ?? EMPTY_BY_ID);
  return useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
}

export function useTicket(ticketId: number | null) {
  return useControlPlaneStore((state) => ticketId === null ? undefined : state.ticketsById[ticketId]);
}

export function useSessionIds() {
  return useControlPlaneStore((state) => state.sessionIds);
}

export function useLeadSessionId() {
  return useControlPlaneStore((state) => state.overview?.sessionId ?? state.sessionIds[0] ?? null);
}

export function useMessageIds(sessionId: string | null) {
  return useControlPlaneStore((state) => sessionId ? state.messageIdsBySession[sessionId] ?? EMPTY_IDS : EMPTY_IDS);
}

export function useTicketMessageIds(ticketId: number | null) {
  const runtime = useCompanionRuntime();
  const key = ticketId === null ? null : RESOURCE_KEYS.ticketConversation(ticketId);
  useEffect(() => key === null ? undefined : runtime.observeResource(key), [key, runtime]);
  return useControlPlaneStore((state) => ticketId === null ? EMPTY_IDS : state.messageIdsByTicket[ticketId] ?? EMPTY_IDS);
}

export function useTurnIds(sessionId: string | null) {
  return useControlPlaneStore((state) => sessionId ? state.turnIdsBySession[sessionId] ?? EMPTY_IDS : EMPTY_IDS);
}

export function useTurn(turnId: string) {
  return useControlPlaneStore((state) => state.turnsById[turnId]);
}

export function useMessage(messageId: string) {
  return useControlPlaneStore((state) => state.messagesById[messageId]);
}

export function useMessagePartIds(messageId: string) {
  return useControlPlaneStore((state) => state.partIdsByMessage[messageId] ?? EMPTY_IDS);
}

export function useMessagePart(partId: string) {
  return useControlPlaneStore((state) => state.messagePartsById[partId]);
}

// 一条消息的全部 part，按顺序。别的消息的 part 变了，这里不重新渲染。
export function useMessageParts(messageId: string): MessagePart[] {
  return useControlPlaneStore(useShallow((state) => (state.partIdsByMessage[messageId] ?? EMPTY_IDS)
    .flatMap((partId) => state.messagePartsById[partId] ? [state.messagePartsById[partId]!] : [])));
}

export function useTicketSummary(ticketId: number | null) {
  return useControlPlaneStore((state) => ticketId === null ? undefined : state.ticketsById[ticketId]);
}

export function useApproval(approvalId: number | null) {
  return useControlPlaneStore((state) => approvalId === null ? undefined : state.approvalsById[approvalId]);
}

export function useArtifactMetadata(artifactId: string | null) {
  return useControlPlaneStore((state) => artifactId === null ? undefined : state.artifactMetadataById[artifactId]);
}

export function useStreamingText(messageId: string) {
  return useStreamStore((state) => state.textByMessageId[messageId]);
}

export function useToolProgress(partId: string) {
  return useStreamStore((state) => state.toolProgressByPartId[partId]);
}

export function useTicketExecution(ticketId: number) {
  useObservedResource(`execution:${ticketId}`);
  const activityIds = useControlPlaneStore((state) => state.activityIdsByTicket[ticketId] ?? EMPTY_IDS);
  const attemptIds = useControlPlaneStore((state) => state.attemptIdsByTicket[ticketId] ?? EMPTY_IDS);
  const activitiesById = useControlPlaneStore((state) => state.activitiesById);
  const attemptsById = useControlPlaneStore((state) => state.attemptsById);
  const resource = useControlPlaneStore((state) => state.resourceState[`execution:${ticketId}`]);
  const activities = useMemo(
    () => activityIds.flatMap((id) => activitiesById[id] ? [activitiesById[id]] : []),
    [activitiesById, activityIds],
  );
  const attempts = useMemo(
    () => attemptIds.flatMap((id) => attemptsById[id] ? [attemptsById[id]] : []),
    [attemptIds, attemptsById],
  );
  return { activities, attempts, resource };
}

export function useTicketDetail(ticketId: number) {
  const runtime = useCompanionRuntime();
  const key = RESOURCE_KEYS.ticket(ticketId);
  useObservedResource(key);
  // Ticket details carry relation and policy ledgers that may be changed by a
  // background migration without a live ticket.updated event. Opening a ticket
  // is the user-visible consistency boundary, so fetch a fresh snapshot here
  // instead of trusting a previously-ready lazy resource forever.
  useEffect(() => {
    void runtime.ensureResource(key, true).catch(() => {});
  }, [key, runtime]);
  const detail = useControlPlaneStore((state) => state.ticketDetailsById[ticketId]);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { detail, resource };
}

// 会话卡片提到、却不在工单列表里的一条事项：提醒（工单列表只装 task），或者刚建好、列表还没刷新的工单。
// 按编号取它的 TicketDetail，不论 kind；和别的界面一样读其中的 TicketSummary。enabled 为 false 时不取。
export function useConversationItemDetail(ticketId: number, enabled: boolean) {
  const runtime = useCompanionRuntime();
  const key = RESOURCE_KEYS.ticket(ticketId);
  useEffect(() => {
    if (!enabled) return undefined;
    return runtime.observeResource(key);
  }, [enabled, key, runtime]);
  const detail = useControlPlaneStore((state) => enabled ? state.ticketDetailsById[ticketId] : undefined);
  const resource = useControlPlaneStore((state) => enabled ? state.resourceState[key] : undefined);
  // 提醒到点（scheduled → fired）时 daemon 推一条带编号的 ticket.updated（工单 07），卡片马上重取，不用等。
  // 下面的定时重取只给工单 07 之前的 daemon 兜底：那时到点不推事件，调度器每分钟走一次，
  // 所以等到提醒时刻之后 REMINDER_FIRE_REFRESH_MS。事件先到时提醒已经不是 scheduled，定时器随之取消。一天以后的提醒不排。
  const remindAt = detail?.ticket.kind === 'reminder' && detail.ticket.stage === 'scheduled' ? detail.remindAt : null;
  useEffect(() => {
    if (!enabled || !remindAt) return undefined;
    const delay = Date.parse(remindAt) + REMINDER_FIRE_REFRESH_MS - Date.now();
    if (!Number.isFinite(delay) || delay < 0 || delay > 24 * 60 * 60_000) return undefined;
    const timer = setTimeout(() => { void runtime.ensureResource(key, true).catch(() => {}); }, delay);
    return () => clearTimeout(timer);
  }, [enabled, key, remindAt, runtime]);
  return { detail, resource };
}

const REMINDER_FIRE_REFRESH_MS = 70_000;

export function useWorkItems() {
  useObservedResource(RESOURCE_KEYS.workItems);
  const ids = useControlPlaneStore((state) => selectWorkItemIds(state) ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.workItemsById ?? EMPTY_BY_ID);
  const resource = useControlPlaneStore((state) => state.resourceState[RESOURCE_KEYS.workItems]);
  const items = useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
  return { items, resource };
}

export function useTicketWorkbench(ticketId: number) {
  const key = RESOURCE_KEYS.workbench(ticketId);
  useObservedResource(key);
  const workbench = useControlPlaneStore((state) => state.workbenchesById[ticketId]);
  const timing = useControlPlaneStore((state) => state.ticketTimingsById[ticketId]);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { workbench, timing, resource };
}

export function useTicketCheckpoints(ticketId: number) {
  const key = RESOURCE_KEYS.checkpoints(ticketId);
  const selector = useMemo(() => selectCheckpointIdsNewestFirst(ticketId), [ticketId]);
  useObservedResource(key);
  const ids = useControlPlaneStore(selector);
  const byId = useControlPlaneStore((state) => state.checkpointsById);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  const checkpoints = useMemo(
    () => ids.flatMap((id) => byId[id] ? [byId[id]] : []),
    [byId, ids],
  );
  return { checkpoints, resource };
}

// 工单的「这次交付」（2026-10-20）。没有时（还没拉到、旧服务端）为 null。
export function useTicketDelivery(ticketId: number) {
  const key = RESOURCE_KEYS.delivery(ticketId);
  useObservedResource(key);
  const delivery = useControlPlaneStore((state) => state.deliveryByTicket[ticketId] ?? null);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { delivery, resource };
}

// 这张工单现在能做的操作（工单 03）。还没读到、旧服务端时是空数组：按钮都不画。
export function useTicketActions(ticketId: number) {
  const key = RESOURCE_KEYS.actions(ticketId);
  useObservedResource(key);
  const actions = useControlPlaneStore((state) => state.ticketActionsByTicket[ticketId] ?? EMPTY_ACTIONS);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { actions, resource };
}

// 结构化验收标准和你在现在这次交付上的确认（工单 05）。还没读到、旧服务端时是 null。
export function useTicketAcceptanceCriteria(ticketId: number) {
  const key = RESOURCE_KEYS.acceptanceCriteria(ticketId);
  useObservedResource(key);
  const criteria = useControlPlaneStore((state) => state.acceptanceCriteriaByTicket[ticketId] ?? null);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { criteria, resource };
}

// 执行 agent 维护的执行计划（工单 06）。undefined：还没读到；null：执行 agent 没有提交计划。
export function useTicketExecutionPlan(ticketId: number) {
  const key = RESOURCE_KEYS.plan(ticketId);
  useObservedResource(key);
  const plan = useControlPlaneStore((state) => state.executionPlanByTicket[ticketId]);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { plan, resource };
}

export function useTicketArtifacts(ticketId: number) {
  const key = RESOURCE_KEYS.artifacts(ticketId);
  useObservedResource(key);
  const ids = useControlPlaneStore((state) => state.artifactIdsByTicket[ticketId] ?? EMPTY_IDS);
  const byId = useControlPlaneStore((state) => state.artifactsById);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  const artifacts = useMemo(
    () => ids.flatMap((id) => byId[id] ? [byId[id]] : []),
    [byId, ids],
  );
  return { artifacts, resource };
}

export function useTicketInterventions(ticketId: number) {
  const key = RESOURCE_KEYS.interventions(ticketId);
  const selector = useMemo(() => selectInterventionsForTicket(ticketId), [ticketId]);
  useObservedResource(key);
  const interventions = useControlPlaneStore(selector);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { interventions, resource };
}

export function useConversationCards(ticketId?: number) {
  const key = ticketId === undefined
    ? RESOURCE_KEYS.conversationCards
    : RESOURCE_KEYS.conversationCardsForTicket(ticketId);
  const selector = useMemo(() => selectConversationCardsForTicket(ticketId), [ticketId]);
  useObservedResource(key);
  const cards = useControlPlaneStore(selector);
  const resource = useControlPlaneStore((state) => state.resourceState[key]);
  return { cards, resource };
}

export function useAttemptLogs(attemptId: number | null) {
  const runtime = useCompanionRuntime();
  const key = attemptId === null ? null : RESOURCE_KEYS.attemptEvents(attemptId);
  useEffect(() => key === null ? undefined : runtime.observeResource(key), [key, runtime]);
  const buffer = useStreamStore((state) => attemptId === null ? undefined : state.logBuffersByAttemptId[attemptId]);
  const resource = useControlPlaneStore((state) => key === null ? undefined : state.resourceState[key]);
  return { logs: buffer?.items ?? EMPTY_IDS, resource };
}

export function useAttemptLogsByAttempt(attemptIds: readonly number[]) {
  const runtime = useCompanionRuntime();
  const keys = useMemo(() => attemptIds.map((id) => RESOURCE_KEYS.attemptEvents(id)), [attemptIds]);
  useEffect(() => {
    const cleanups = keys.map((key) => runtime.observeResource(key));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [keys, runtime]);

  const logBuffersByAttemptId = useStreamStore((state) => state.logBuffersByAttemptId);
  const resourceState = useControlPlaneStore((state) => state.resourceState);
  const logsByAttemptId = useMemo(() => Object.fromEntries(
    attemptIds.map((id) => [id, logBuffersByAttemptId[id]?.items ?? EMPTY_IDS]),
  ) as Record<number, ReturnType<typeof useAttemptLogs>['logs']>, [attemptIds, logBuffersByAttemptId]);
  const resourcesByAttemptId = useMemo(() => Object.fromEntries(
    attemptIds.map((id) => [id, resourceState[RESOURCE_KEYS.attemptEvents(id)]]),
  ), [attemptIds, resourceState]);

  return { logsByAttemptId, resourcesByAttemptId };
}

function useObservedResource(key: ResourceKey): void {
  const runtime = useCompanionRuntime();
  useEffect(() => runtime.observeResource(key), [key, runtime]);
}
