import { subscribeWithSelector } from 'zustand/middleware';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  ProjectOverview,
  TimelineResponse,
  InboxView,
  AgendaItem,
  ApprovalDto,
  AttemptDto,
  ConversationTurn,
  KernelArtifact,
  KernelCheckpointListResponse,
  KernelCheckpointV2,
  KernelCheckpointV2ListResponse,
  KernelConversationCardListResponse,
  KernelIntervention,
  KernelInterventionRef,
  KernelTicketTiming,
  KernelTicketWorkbench,
  KernelTicketWorkbenchV2,
  KernelTicketWorkItem,
  KernelTicketWorkItemV2,
  NotificationDto,
  ProjectSummary,
  TicketSummary,
  TicketDetail,
} from '@pi-lead-child/protocol';

import type {
  AttemptEntity,
  ControlPlaneData,
  ResourceKey,
  TransientConversationCard,
} from '../types';
import {
  conversationCardEntity,
  equalArray,
  equalValue,
  mergeOrderedIds,
  normalizeConversationSnapshot,
  normalizeEntityPage,
  normalizeEntitySnapshot,
  reuseArray,
  type PageMergeMode,
} from './normalize';
import { applyLeadActivityPush, applyLeadActivitySnapshot, EMPTY_LEAD_ACTIVITY } from './leadActivity';
import { mergeChannelCardSnapshot, sameChannelCards, upsertChannelCard } from './channelCards';

export interface ControlPlaneStoreState extends ControlPlaneData {
  upsertTicket(ticket: TicketSummary): void;
  replaceTicketDetail(detail: TicketDetail): void;
  replaceTickets(tickets: TicketSummary[]): void;
  replaceProjects(projects: ProjectSummary[]): void;
  replaceAgenda(items: AgendaItem[]): void;
  replaceApprovals(approvals: ApprovalDto[]): void;
  replaceNotifications(notifications: NotificationDto[]): void;
  // 「Lead 动态」的快照和推送（工单 06）：都按版本应用，比手上旧的不用。
  replaceLeadActivity(view: import('@pi-lead-child/protocol').LeadActivityView): void;
  applyLeadActivityPush(push: {
    card?: import('@pi-lead-child/protocol').LeadActivityCard;
    interrupt?: import('@pi-lead-child/protocol').LeadInterrupt;
    reminder?: import('@pi-lead-child/protocol').ReminderCard;
  }): void;
  // 外部来源的会话卡（工单 11）：快照和动作的回应都按版本应用，比手上旧的不用。
  replaceChannelCards(cards: import('@pi-lead-child/protocol').ChannelCardDto[]): void;
  upsertChannelCard(card: import('@pi-lead-child/protocol').ChannelCardDto): void;
  // Lead 忙时排着的外部消息（工单 10）：推送和接口的回答都是整份，整体替换。
  replaceLeadQueue(queue: import('@pi-lead-child/protocol').LeadQueue): void;
  replaceInbox(view: InboxView): void;
  replaceProjectOverviews(overviews: ProjectOverview[]): void;
  replaceTimeline(timeline: TimelineResponse): void;
  replaceConversation(sessionId: string, turns: ConversationTurn[], scope?: { ticketId?: number }): void;
  replaceAttempts(ticketId: number, attempts: AttemptDto[]): void;
  replaceActivities(ticketId: number, activities: import('@pi-lead-child/protocol').ActivityDto[]): void;
  mergeCheckpointPage(
    ticketId: number,
    page: KernelCheckpointListResponse | KernelCheckpointV2ListResponse,
    mode: PageMergeMode,
  ): void;
  replaceWorkItems(items: KernelTicketWorkItem[] | KernelTicketWorkItemV2[]): void;
  replaceTicketWorkbench(workbench: KernelTicketWorkbench | KernelTicketWorkbenchV2): void;
  replaceArtifacts(ticketId: number, artifacts: KernelArtifact[]): void;
  replaceDelivery(ticketId: number, delivery: import('@pi-lead-child/protocol').TicketDelivery): void;
  replaceTicketActions(ticketId: number, actions: import('@pi-lead-child/protocol').TicketAction[]): void;
  replaceAcceptanceCriteria(ticketId: number, criteria: import('@pi-lead-child/protocol').TicketAcceptanceCriteria): void;
  replaceExecutionPlan(ticketId: number, plan: import('@pi-lead-child/protocol').TicketExecutionPlan | null): void;
  replaceInterventionRefs(refs: KernelInterventionRef[], ticketId?: number): void;
  replaceInterventions(interventions: KernelIntervention[], ticketId?: number): void;
  mergeConversationCardPage(
    page: KernelConversationCardListResponse,
    mode: PageMergeMode,
    resourceKey?: ResourceKey,
  ): void;
  upsertTransientConversationCard(card: TransientConversationCard): void;
  clearTransientConversationCards(): void;
  reset(): void;
}

type ControlPlaneSet = StoreApi<ControlPlaneStoreState>['setState'];
type ControlPlaneGet = StoreApi<ControlPlaneStoreState>['getState'];

export function createInitialControlPlaneData(): ControlPlaneData {
  return {
    phase: 'loading',
    connectionState: 'disconnected',
    error: null,
    endpointMismatch: null,
    overview: null,
    ticketsById: {},
    ticketIds: [],
    ticketDetailsById: {},
    projectsById: {},
    projectIds: [],
    agendaById: {},
    agendaIds: [],
    approvalsById: {},
    approvalIds: [],
    notificationsById: {},
    notificationIds: [],
    leadActivity: EMPTY_LEAD_ACTIVITY,
    channelCards: [],
    leadQueue: null,
    inboxView: null,
    projectOverviews: null,
    timeline: null,
    connections: null,
    memory: null,
    memoryHindsight: null,
    memoryPreferences: null,
    decisionModel: null,
    modelSettings: null,
    setup: null,
    widgets: null,
    runtimeSettings: null,
    leadProfile: null,
    leadAvatar: null,
    leadAvatarImages: {},
    designPreferences: null,
    channelSettings: null,
    sessionsById: {},
    sessionIds: [],
	    turnsById: {},
	    turnIdsBySession: {},
	    messagesById: {},
	    messageIdsBySession: {},
	    messageIdsByTicket: {},
	    messagePartsById: {},
    partIdsByMessage: {},
    assistantMessageIdByTurnId: {},
    turnIdByCommandId: {},
    deliveredTurnIds: {},
    attemptsById: {},
    attemptIdsByTicket: {},
    activitiesById: {},
    activityIdsByTicket: {},
    artifactMetadataById: {},
    artifactIdsByAttempt: {},
    capabilities: [],
    checkpointsById: {},
    checkpointIdsByTicket: {},
    checkpointPagesByTicket: {},
    workItemsById: {},
    workItemIds: [],
    workbenchesById: {},
    workbenchIds: [],
    artifactsById: {},
    artifactIdsByTicket: {},
    deliveryByTicket: {},
    ticketActionsByTicket: {},
    acceptanceCriteriaByTicket: {},
    executionPlanByTicket: {},
    interventionRefsById: {},
    interventionsById: {},
    interventionIds: [],
    interventionIdsByTicket: {},
    ticketTimingsById: {},
    ticketTimingIds: [],
    conversationCardsById: {},
    conversationCardIds: [],
    conversationCardKeyByDurableId: {},
    conversationCardPagesByResource: {},
    resourceState: {},
    lastAppliedGatewaySeq: 0,
  };
}

export function createControlPlaneStore() {
  return createStore<ControlPlaneStoreState>()(subscribeWithSelector((set, get) => ({
    ...createInitialControlPlaneData(),
    upsertTicket: (ticket) => {
      const current = get().ticketsById[ticket.id];
      if (current === ticket) return;
      set((state) => ({
        ticketsById: { ...state.ticketsById, [ticket.id]: ticket },
        ticketIds: current ? state.ticketIds : [...state.ticketIds, ticket.id],
      }));
    },
    replaceTicketDetail: (detail) => {
      const current = get().ticketDetailsById[detail.ticket.id];
      if (current !== undefined && equalValue(current, detail)) return;
      set((state) => ({
        ticketDetailsById: { ...state.ticketDetailsById, [detail.ticket.id]: detail },
      }));
    },
    replaceTickets: (tickets) => {
      const current = get();
      const normalized = normalizeEntitySnapshot(
        current.ticketsById,
        current.ticketIds,
        tickets,
        (ticket) => ticket.id,
      );
      if (normalized.byId === current.ticketsById && normalized.ids === current.ticketIds) return;
      set({ ticketsById: normalized.byId, ticketIds: normalized.ids });
    },
    replaceProjects: (projects) => {
      const current = get();
      const normalized = normalizeEntitySnapshot(
        current.projectsById,
        current.projectIds,
        projects,
        (project) => project.id,
      );
      if (normalized.byId === current.projectsById && normalized.ids === current.projectIds) return;
      set({ projectsById: normalized.byId, projectIds: normalized.ids });
    },
    replaceAgenda: (items) => {
      const current = get();
      const normalized = normalizeEntitySnapshot(
        current.agendaById,
        current.agendaIds,
        items,
        (item) => item.id,
      );
      if (normalized.byId === current.agendaById && normalized.ids === current.agendaIds) return;
      set({ agendaById: normalized.byId, agendaIds: normalized.ids });
    },
    replaceApprovals: (approvals) => {
      const current = get();
      const normalized = normalizeEntitySnapshot(
        current.approvalsById,
        current.approvalIds,
        approvals,
        (approval) => approval.id,
      );
      if (normalized.byId === current.approvalsById && normalized.ids === current.approvalIds) return;
      set({ approvalsById: normalized.byId, approvalIds: normalized.ids });
    },
    replaceLeadActivity: (view) => {
      const current = get().leadActivity;
      const next = applyLeadActivitySnapshot(current, view);
      if (next !== current) set({ leadActivity: next });
    },
    applyLeadActivityPush: (push) => {
      const current = get().leadActivity;
      const next = applyLeadActivityPush(current, push);
      if (next !== current) set({ leadActivity: next });
    },
    replaceChannelCards: (cards) => {
      const current = get().channelCards;
      const next = mergeChannelCardSnapshot(current, cards);
      if (sameChannelCards(current, next)) return;
      set({ channelCards: next });
    },
    replaceLeadQueue: (queue) => {
      if (JSON.stringify(get().leadQueue) === JSON.stringify(queue)) return;
      set({ leadQueue: queue });
    },
    upsertChannelCard: (card) => {
      const current = get().channelCards;
      const next = upsertChannelCard(current, card);
      if (sameChannelCards(current, next)) return;
      set({ channelCards: next });
    },
    replaceNotifications: (notifications) => {
      const current = get();
      const normalized = normalizeEntitySnapshot(
        current.notificationsById,
        current.notificationIds,
        notifications,
        (notification) => notification.id,
      );
      if (normalized.byId === current.notificationsById && normalized.ids === current.notificationIds) return;
      set({ notificationsById: normalized.byId, notificationIds: normalized.ids });
    },
    replaceInbox: (inboxView) => {
      set({ inboxView });
    },
    replaceProjectOverviews: (projectOverviews) => {
      set({ projectOverviews });
    },
    replaceTimeline: (timeline) => {
      set({ timeline });
    },
    replaceConversation: (sessionId, turns, scope) => {
      const current = get();
      const normalized = normalizeConversationSnapshot(current, sessionId, turns, scope);
      const patch = Object.fromEntries(
        Object.entries(normalized).filter(([key, value]) => current[key as keyof typeof normalized] !== value),
      );
      if (Object.keys(patch).length > 0) set(patch);
    },
    replaceAttempts: (ticketId, attempts) => {
      const current = get();
      const previousIds = current.attemptIdsByTicket[ticketId] ?? [];
      const previousById = Object.fromEntries(
        previousIds.flatMap((id) => current.attemptsById[id] ? [[id, current.attemptsById[id]]] : []),
      ) as Record<number, AttemptEntity>;
      const entities: AttemptEntity[] = attempts.map((attempt) => ({
        id: attempt.id,
        ticketId: attempt.ticketId,
        role: attempt.role,
        state: attempt.state,
        model: attempt.model,
        effort: attempt.effort ?? null,
        runtime: attempt.runtime ?? null,
        purpose: attempt.purpose ?? null,
        exitCode: attempt.exitCode ?? null,
        errorCode: attempt.errorCode ?? null,
        errorMessage: attempt.errorMessage ?? null,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        kernel: null,
      }));
      const normalized = normalizeEntitySnapshot(previousById, previousIds, entities, (attempt) => attempt.id);
      if (normalized.byId === previousById && normalized.ids === previousIds) return;
      const attemptsById = { ...current.attemptsById };
      for (const id of previousIds) delete attemptsById[id];
      Object.assign(attemptsById, normalized.byId);
      set({
        attemptsById,
        attemptIdsByTicket: { ...current.attemptIdsByTicket, [ticketId]: normalized.ids },
      });
    },
    replaceActivities: (ticketId, activities) => {
      const current = get();
      const previousIds = current.activityIdsByTicket[ticketId] ?? [];
      const previousById = Object.fromEntries(
        previousIds.flatMap((id) => current.activitiesById[id] ? [[id, current.activitiesById[id]]] : []),
      );
      const normalized = normalizeEntitySnapshot(previousById, previousIds, activities, (activity) => activity.id);
      if (normalized.byId === previousById && normalized.ids === previousIds) return;
      const activitiesById = { ...current.activitiesById };
      for (const id of previousIds) delete activitiesById[id];
      Object.assign(activitiesById, normalized.byId);
      set({
        activitiesById,
        activityIdsByTicket: { ...current.activityIdsByTicket, [ticketId]: normalized.ids },
      });
    },
    mergeCheckpointPage: (ticketId, page, mode) => {
      const current = get();
      const items = page.items.map(normalizeCheckpointV2);
      const previousIds = current.checkpointIdsByTicket[ticketId] ?? [];
      const previousById = scopedById(current.checkpointsById, previousIds);
      const normalized = normalizeEntityPage(
        previousById,
        previousIds,
        items,
        (checkpoint) => checkpoint.id,
        mode,
        (left, right) => left - right,
      );
      const checkpointsById = (() => {
        if (mode !== 'replace') return mergeGlobalById(current.checkpointsById, normalized.byId);
        const next = { ...current.checkpointsById };
        for (const id of previousIds) delete next[id];
        Object.assign(next, normalized.byId);
        return equalValue(next, current.checkpointsById) ? current.checkpointsById : next;
      })();
      const previousPage = current.checkpointPagesByTicket[ticketId];
      const pageState = mode === 'append' && previousPage
        ? previousPage
        : { hasMore: page.hasMore, nextBeforeId: page.nextBeforeId };
      if (
        checkpointsById === current.checkpointsById &&
        normalized.ids === previousIds &&
        previousPage !== undefined && equalValue(previousPage, pageState)
      ) return;
      set({
        checkpointsById,
        checkpointIdsByTicket: normalized.ids === previousIds
          ? current.checkpointIdsByTicket
          : { ...current.checkpointIdsByTicket, [ticketId]: normalized.ids },
        checkpointPagesByTicket: previousPage !== undefined && equalValue(previousPage, pageState)
          ? current.checkpointPagesByTicket
          : { ...current.checkpointPagesByTicket, [ticketId]: pageState },
      });
    },
    replaceWorkItems: (items) => {
      const current = get();
      const normalizedItems = items.map(normalizeWorkItemV2);
      const workItems = normalizeEntitySnapshot(
        current.workItemsById,
        current.workItemIds,
        normalizedItems,
        (item) => item.ticketId,
      );
      const ticketTimingIds = normalizedItems.map((item) => item.ticketId);
      const ticketTimingsById = Object.fromEntries(normalizedItems.map((item) => {
        const previous = current.ticketTimingsById[item.ticketId];
        const timing = previous !== undefined && equalValue(previous, item.timing) ? previous : item.timing;
        return [item.ticketId, timing];
      })) as Record<number, KernelTicketTiming>;
      const stableTimingById = equalTimingReferences(current.ticketTimingsById, ticketTimingsById)
        ? current.ticketTimingsById
        : ticketTimingsById;
      const stableTimingIds = equalArray(current.ticketTimingIds, ticketTimingIds)
        ? current.ticketTimingIds
        : ticketTimingIds;
      if (
        workItems.byId === current.workItemsById &&
        workItems.ids === current.workItemIds &&
        stableTimingById === current.ticketTimingsById &&
        stableTimingIds === current.ticketTimingIds
      ) return;
      set({
        workItemsById: workItems.byId,
        workItemIds: workItems.ids,
        ticketTimingsById: stableTimingById,
        ticketTimingIds: stableTimingIds,
      });
    },
    replaceTicketWorkbench: (workbench) => {
      mergeWorkbenchSnapshot(set, get, workbench);
    },
    replaceArtifacts: (ticketId, artifacts) => {
      const current = get();
      const previousIds = current.artifactIdsByTicket[ticketId] ?? [];
      const normalized = normalizeEntitySnapshot(
        scopedById(current.artifactsById, previousIds),
        previousIds,
        artifacts,
        (artifact) => artifact.id,
      );
      const artifactsById = mergeGlobalById(current.artifactsById, normalized.byId);
      if (artifactsById === current.artifactsById && normalized.ids === previousIds) return;
      set({
        artifactsById,
        artifactIdsByTicket: normalized.ids === previousIds
          ? current.artifactIdsByTicket
          : { ...current.artifactIdsByTicket, [ticketId]: normalized.ids },
      });
    },
    replaceDelivery: (ticketId, delivery) => {
      set((current) => ({ deliveryByTicket: { ...current.deliveryByTicket, [ticketId]: delivery } }));
    },
    replaceTicketActions: (ticketId, actions) => {
      set((current) => ({ ticketActionsByTicket: { ...current.ticketActionsByTicket, [ticketId]: actions } }));
    },
    replaceAcceptanceCriteria: (ticketId, criteria) => {
      set((current) => ({ acceptanceCriteriaByTicket: { ...current.acceptanceCriteriaByTicket, [ticketId]: criteria } }));
    },
    replaceExecutionPlan: (ticketId, plan) => {
      set((current) => ({ executionPlanByTicket: { ...current.executionPlanByTicket, [ticketId]: plan } }));
    },
    replaceInterventionRefs: (refs, ticketId) => {
      mergeInterventionRefs(set, get, refs, ticketId);
    },
    replaceInterventions: (interventions, ticketId) => {
      const current = get();
      const previousIds = ticketId === undefined
        ? current.interventionIds
        : current.interventionIdsByTicket[ticketId] ?? [];
      const previousById = scopedById(current.interventionsById, previousIds);
      const normalized = normalizeEntitySnapshot(
        previousById,
        previousIds,
        interventions,
        (intervention) => intervention.id,
      );
      const interventionsById = ticketId === undefined
        ? normalized.byId
        : mergeGlobalById(current.interventionsById, normalized.byId);
      const interventionIds = ticketId === undefined
        ? normalized.ids
        : mergeOrderedIds(current.interventionIds, normalized.ids, 'append');
      const interventionIdsByTicket = ticketId === undefined
        ? groupInterventionIds(interventions)
        : normalized.ids === previousIds
          ? current.interventionIdsByTicket
          : { ...current.interventionIdsByTicket, [ticketId]: normalized.ids };
      const missingRefs = interventions
        .filter((intervention) => current.interventionRefsById[intervention.id] === undefined)
        .map(interventionRefFromFull);
      if (
        interventionsById !== current.interventionsById ||
        interventionIds !== current.interventionIds ||
        interventionIdsByTicket !== current.interventionIdsByTicket
      ) {
        set({ interventionsById, interventionIds, interventionIdsByTicket });
      }
      if (missingRefs.length > 0) mergeInterventionRefs(set, get, missingRefs, ticketId);
    },
    mergeConversationCardPage: (page, mode, resourceKey = 'conversation-cards') => {
      const current = get();
      let cardsById = current.conversationCardsById;
      let durableKeys = current.conversationCardKeyByDurableId;
      let changed = false;
      const incomingKeys: string[] = [];
      for (const card of page.items) {
        const previousByKey = cardsById[card.key];
        if (previousByKey?.source === 'durable' && isOlderConversationCard(card, previousByKey)) {
          incomingKeys.push(card.key);
          continue;
        }
        const previousKey = durableKeys[card.id];
        if (previousKey && previousKey !== card.key) {
          if (!changed) {
            cardsById = { ...cardsById };
            durableKeys = { ...durableKeys };
            changed = true;
          }
          delete cardsById[previousKey];
        }
        const previous = cardsById[card.key];
        const entity = conversationCardEntity(card, card.id, previous);
        if (entity !== previous || durableKeys[card.id] !== card.key) {
          if (!changed) {
            cardsById = { ...cardsById };
            durableKeys = { ...durableKeys };
            changed = true;
          }
          cardsById[card.key] = entity;
          durableKeys[card.id] = card.key;
          if (previous?.durableId && previous.durableId !== card.id) delete durableKeys[previous.durableId];
        }
        incomingKeys.push(card.key);
      }
      const transientKeys = current.conversationCardIds.filter((key) =>
        current.conversationCardsById[key]?.durableId === null && !incomingKeys.includes(key));
      const scopedTicketId = resourceKey.startsWith('conversation-cards:ticket:')
        ? Number(resourceKey.slice('conversation-cards:ticket:'.length))
        : undefined;
      let baseIds: string[];
      if (mode === 'replace' && scopedTicketId !== undefined) {
        const incoming = new Set(incomingKeys);
        const firstScopedIndex = current.conversationCardIds.findIndex((key) => {
          const card = current.conversationCardsById[key];
          return incoming.has(key) || (card?.ticketId === scopedTicketId && card.durableId !== null);
        });
        const preservedIds = current.conversationCardIds.filter((key) => {
          if (incoming.has(key)) return false;
          const card = current.conversationCardsById[key];
          return card?.ticketId !== scopedTicketId || card.durableId === null;
        });
        const insertionIndex = firstScopedIndex < 0
          ? preservedIds.length
          : current.conversationCardIds.slice(0, firstScopedIndex)
            .filter((key) => preservedIds.includes(key)).length;
        baseIds = [...preservedIds];
        baseIds.splice(insertionIndex, 0, ...incomingKeys);
      } else {
        baseIds = mode === 'replace'
          ? [...incomingKeys, ...transientKeys]
          : mergeOrderedIds(current.conversationCardIds, incomingKeys, mode);
      }
      const conversationCardIds = equalArray(current.conversationCardIds, baseIds)
        ? current.conversationCardIds
        : baseIds;
      const pageState = { hasMore: page.hasMore, nextBeforeId: page.nextBeforeId };
      const previousPage = current.conversationCardPagesByResource[resourceKey];
      if (changed || conversationCardIds !== current.conversationCardIds || !equalValue(previousPage, pageState)) {
        set({
          conversationCardsById: cardsById,
          conversationCardIds,
          conversationCardKeyByDurableId: durableKeys,
          conversationCardPagesByResource: equalValue(previousPage, pageState)
            ? current.conversationCardPagesByResource
            : { ...current.conversationCardPagesByResource, [resourceKey]: pageState },
        });
      }
      mergeCheckpointSidecars(set, get, page.checkpoints);
      mergeInterventionRefs(set, get, page.interventionRefs);
    },
    upsertTransientConversationCard: (card) => {
      const current = get();
      const previous = current.conversationCardsById[card.key];
      if (previous?.durableId !== null && previous !== undefined) return;
      const projection = previous?.kind === 'ticket_execution' && card.kind === 'ticket_execution'
        ? {
            ...card,
            operations: mergeTicketOperations(previous.operations, card.operations),
            createdAt: previous.createdAt,
          }
        : card;
      const entity = conversationCardEntity(projection, null, previous);
      if (entity === previous) return;
      set({
        conversationCardsById: { ...current.conversationCardsById, [card.key]: entity },
        conversationCardIds: previous
          ? current.conversationCardIds
          : [...current.conversationCardIds, card.key],
      });
    },
    clearTransientConversationCards: () => {
      const current = get();
      const conversationCardIds = current.conversationCardIds.filter((key) =>
        current.conversationCardsById[key]?.durableId !== null);
      if (conversationCardIds.length === current.conversationCardIds.length) return;
      const conversationCardsById = Object.fromEntries(
        conversationCardIds.map((key) => [key, current.conversationCardsById[key]]),
      );
      set({ conversationCardsById, conversationCardIds });
    },
    reset: () => set(createInitialControlPlaneData()),
  })));
}

export type ControlPlaneStore = ReturnType<typeof createControlPlaneStore>;

function scopedById<T, K extends string | number>(byId: Record<K, T>, ids: K[]): Record<K, T> {
  return Object.fromEntries(ids.flatMap((id) => byId[id] === undefined ? [] : [[id, byId[id]]])) as Record<K, T>;
}

function mergeGlobalById<T, K extends string | number>(
  current: Record<K, T>,
  incoming: Record<K, T>,
): Record<K, T> {
  let next = current;
  for (const [rawId, value] of Object.entries(incoming) as [string, T][]) {
    const id = (/^\d+$/.test(rawId) ? Number(rawId) : rawId) as K;
    if (current[id] === value) continue;
    if (next === current) next = { ...current };
    next[id] = value;
  }
  return next;
}

function isOlderConversationCard(
  incoming: KernelConversationCardListResponse['items'][number],
  previous: ControlPlaneData['conversationCardsById'][string],
): boolean {
  const incomingTime = Date.parse(incoming.updatedAt);
  const previousTime = Date.parse(previous.updatedAt);
  if (Number.isFinite(incomingTime) && Number.isFinite(previousTime)) {
    if (incomingTime < previousTime) return true;
    if (incomingTime > previousTime) return false;
  } else {
    if (incoming.updatedAt < previous.updatedAt) return true;
    if (incoming.updatedAt > previous.updatedAt) return false;
  }
  if (previous.durableId !== null && incoming.id < previous.durableId) return true;
  if (incoming.kind !== 'ticket_execution' || previous.kind !== 'ticket_execution') return false;
  const incomingOperations = new Map(incoming.operations.map((operation) => [operation.id, operation.state]));
  return previous.operations.some((operation) =>
    (operation.state === 'completed' || operation.state === 'failed') &&
    !['completed', 'failed'].includes(incomingOperations.get(operation.id) ?? ''));
}

function mergeCheckpointSidecars(
  set: ControlPlaneSet,
  get: ControlPlaneGet,
  checkpoints: KernelCheckpointListResponse['items'] | KernelCheckpointV2ListResponse['items'],
): void {
  if (checkpoints.length === 0) return;
  const normalizedCheckpoints = checkpoints.map(normalizeCheckpointV2);
  const byTicket = new Map<number, KernelCheckpointV2[]>();
  for (const item of normalizedCheckpoints) {
    const items = byTicket.get(item.ticketId) ?? [];
    items.push(item);
    byTicket.set(item.ticketId, items);
  }
  for (const [ticketId, items] of byTicket) {
    const current = get();
    const previousIds = current.checkpointIdsByTicket[ticketId] ?? [];
    const normalized = normalizeEntityPage(
      scopedById(current.checkpointsById, previousIds),
      previousIds,
      items,
      (item) => item.id,
      'append',
      (left, right) => left - right,
    );
    const checkpointsById = mergeGlobalById(current.checkpointsById, normalized.byId);
    if (checkpointsById !== current.checkpointsById || normalized.ids !== previousIds) {
      set({
        checkpointsById,
        checkpointIdsByTicket: normalized.ids === previousIds
          ? current.checkpointIdsByTicket
          : { ...current.checkpointIdsByTicket, [ticketId]: normalized.ids },
      });
    }
  }
}

function mergeInterventionRefs(
  set: ControlPlaneSet,
  get: ControlPlaneGet,
  refs: KernelInterventionRef[],
  ticketId?: number,
): void {
  if (refs.length === 0 && ticketId === undefined) return;
  const current = get();
  let interventionRefsById = current.interventionRefsById;
  for (const ref of refs) {
    const previous = interventionRefsById[ref.id];
    const value = previous !== undefined && equalValue(previous, ref) ? previous : ref;
    if (value === previous) continue;
    if (interventionRefsById === current.interventionRefsById) {
      interventionRefsById = { ...current.interventionRefsById };
    }
    interventionRefsById[ref.id] = value;
  }
  const grouped = ticketId === undefined ? groupInterventionIds(refs) : { [ticketId]: refs.map((ref) => ref.id) };
  let interventionIdsByTicket = current.interventionIdsByTicket;
  for (const [rawTicketId, ids] of Object.entries(grouped)) {
    const id = Number(rawTicketId);
    const previousIds = interventionIdsByTicket[id] ?? [];
    const nextIds = reuseArray(previousIds, ids);
    if (nextIds === previousIds) continue;
    if (interventionIdsByTicket === current.interventionIdsByTicket) {
      interventionIdsByTicket = { ...current.interventionIdsByTicket };
    }
    interventionIdsByTicket[id] = nextIds;
  }
  if (
    interventionRefsById !== current.interventionRefsById ||
    interventionIdsByTicket !== current.interventionIdsByTicket
  ) set({ interventionRefsById, interventionIdsByTicket });
}

function groupInterventionIds(items: { id: string; ticketId: number }[]): Record<number, string[]> {
  const result: Record<number, string[]> = {};
  for (const item of items) (result[item.ticketId] ??= []).push(item.id);
  return result;
}

function interventionRefFromFull(intervention: KernelIntervention): KernelInterventionRef {
  return {
    id: intervention.id,
    ticketId: intervention.ticketId,
    kind: intervention.kind,
    state: intervention.state,
    requiresAction: intervention.state === 'pending',
  } as KernelInterventionRef;
}

function mergeWorkbenchSnapshot(
  set: ControlPlaneSet,
  get: ControlPlaneGet,
  workbench: KernelTicketWorkbench | KernelTicketWorkbenchV2,
): void {
  // timing / latestCheckpoints / pow 现在是可选的：没有 Run 就整个不投（kernel spec §11）。
  // 提醒和没跑过的任务走到这里时它们都不存在，所以每一处都要能接住缺席。
  mergeCheckpointSidecars(set, get, workbench.latestCheckpoints ?? []);
  mergeInterventionRefs(set, get, workbench.interventionRefs, workbench.ticket.id);
  const current = get();
  const ticketId = workbench.ticket.id;
  const previousIndex = current.workbenchesById[ticketId];
  const index = {
    ticketId,
    activeAttemptId: workbench.activeAttempt?.id ?? null,
    childTicketIds: reuseArray(previousIndex?.childTicketIds ?? [], workbench.children.map((ticket) => ticket.id)),
    latestCheckpointIds: reuseArray(
      previousIndex?.latestCheckpointIds ?? [],
      (workbench.latestCheckpoints ?? []).map((checkpoint) => checkpoint.id),
    ),
    interventionIds: reuseArray(
      previousIndex?.interventionIds ?? [],
      workbench.interventionRefs.map((ref) => ref.id),
    ),
    progress: 'progress' in workbench ? workbench.progress : null,
    pow: ('pow' in workbench ? workbench.pow : null) ?? null,
    outcomeSnapshot: ('outcomeSnapshot' in workbench ? workbench.outcomeSnapshot : null) ?? null,
    budget: { tokenBudget: workbench.ticket.tokenBudget, costBudgetUsd: workbench.ticket.costBudgetUsd },
  };
  const stableIndex = previousIndex !== undefined && equalValue(previousIndex, index) ? previousIndex : index;
  const timing = current.ticketTimingsById[ticketId];
  // 没有 timing 就保持原样，而不是往 Record 里写一个 undefined：那会让
  // ticketTimingIds 里出现一个查不到值的 id，下游读到 undefined 当场炸。
  const stableTiming = workbench.timing === undefined
    ? timing
    : timing !== undefined && equalValue(timing, workbench.timing) ? timing : workbench.timing;
  let attemptsById = current.attemptsById;
  let attemptIdsByTicket = current.attemptIdsByTicket;
  if (workbench.activeAttempt) {
    const attempt = workbench.activeAttempt;
    const previousAttempt = current.attemptsById[attempt.id];
    const entity: AttemptEntity = {
      id: attempt.id,
      ticketId: attempt.ticketId,
      role: attempt.role,
      state: attempt.state,
      model: attempt.model,
      // 工作台的 KernelAttempt 是冻结的 v1 形状，不带 effort：保留 attempt 列表给的值。
      effort: previousAttempt?.effort ?? null,
      runtime: attempt.runtime,
      purpose: attempt.purpose,
      exitCode: attempt.exitCode,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      kernel: attempt,
    };
    const stableAttempt = previousAttempt !== undefined && equalValue(previousAttempt, entity) ? previousAttempt : entity;
    if (stableAttempt !== previousAttempt) attemptsById = { ...current.attemptsById, [attempt.id]: stableAttempt };
    const ids = current.attemptIdsByTicket[ticketId] ?? [];
    if (!ids.includes(attempt.id)) attemptIdsByTicket = { ...current.attemptIdsByTicket, [ticketId]: [...ids, attempt.id] };
  }
  const workbenchIds = current.workbenchIds.includes(ticketId)
    ? current.workbenchIds
    : [...current.workbenchIds, ticketId];
  const ticketTimingIds = current.ticketTimingIds.includes(ticketId) || stableTiming === undefined
    ? current.ticketTimingIds
    : [...current.ticketTimingIds, ticketId];
  if (
    stableIndex !== previousIndex || stableTiming !== timing || attemptsById !== current.attemptsById ||
    attemptIdsByTicket !== current.attemptIdsByTicket || workbenchIds !== current.workbenchIds ||
    ticketTimingIds !== current.ticketTimingIds
  ) {
    set({
      workbenchesById: stableIndex === previousIndex
        ? current.workbenchesById
        : { ...current.workbenchesById, [ticketId]: stableIndex },
      workbenchIds,
      ticketTimingsById: stableTiming === timing || stableTiming === undefined
        ? current.ticketTimingsById
        : { ...current.ticketTimingsById, [ticketId]: stableTiming },
      ticketTimingIds,
      attemptsById,
      attemptIdsByTicket,
    });
  }
}

function equalTimingReferences(
  left: Record<number, KernelTicketTiming>,
  right: Record<number, KernelTicketTiming>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length && rightIds.every((id) => left[Number(id)] === right[Number(id)]);
}

function mergeTicketOperations<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  let items = previous;
  for (const operation of incoming) {
    const index = items.findIndex((item) => item.id === operation.id);
    if (index < 0) {
      items = [...items, operation];
      continue;
    }
    if (equalValue(items[index], operation)) continue;
    items = items.map((item, itemIndex) => itemIndex === index ? operation : item);
  }
  return items;
}

function normalizeCheckpointV2(
  checkpoint: KernelCheckpointListResponse['items'][number] | KernelCheckpointV2,
): KernelCheckpointV2 {
  return 'proofItems' in checkpoint
    ? checkpoint
    : { ...checkpoint, progress: null, proofItems: [] };
}

function normalizeWorkItemV2(
  item: KernelTicketWorkItem | KernelTicketWorkItemV2,
): KernelTicketWorkItemV2 {
  return 'progress' in item ? item : { ...item, progress: null };
}
