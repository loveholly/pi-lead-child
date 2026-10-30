import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type {
  ArtifactDownloadState,
  CompactDestination,
  CompactPanel,
  InterventionCommandState,
  RailView,
  TicketFilter,
  TicketGroupId,
  WorkspaceData,
} from '../types';

export interface WorkspaceStoreState extends WorkspaceData {
  selectTicket(ticketId: number | null): void;
  selectSession(sessionId: string | null): void;
  selectAttempt(attemptId: number | null): void;
  setHydrated(hydrated: boolean): void;
  openRail(): void;
  closeRail(): void;
  openThread(): void;
  closeThread(): void;
  openViews(): void;
  closeViews(): void;
  selectView(view: string): void;
  setTicketChatExpanded(ticketId: number, expanded: boolean): void;
  markTicketChatSeen(ticketId: number, messageId: string): void;
  setTicketRecordsOpen(ticketId: number, open: boolean): void;
  openCompactPanel(panel: Exclude<CompactPanel, null>): void;
  closeCompactPanel(): void;
  setCompactDestination(destination: CompactDestination): void;
  setTicketReturnDestination(destination: CompactDestination): void;
  setRailView(view: RailView): void;
  setTicketFilter(filter: TicketFilter): void;
  setTicketProject(project: string | null): void;
  setTicketQuery(query: string): void;
  toggleTicketGroup(groupId: TicketGroupId): void;
  setScrollAnchor(context: string, anchor: string | null): void;
  toggleMessagePart(partId: string): void;
  setComposerDraft(context: string, draft: string): void;
  clearComposerDraft(context: string): void;
  setInterventionCommandState(interventionId: string, state: InterventionCommandState): void;
  setArtifactDownloadState(artifactId: number, state: ArtifactDownloadState): void;
  reconcileSelections(input: { ticketIds: number[]; sessionIds: string[]; attemptIds: number[] }): void;
  handleBreakpointChange(): void;
  resetForForget(): void;
}

export function createInitialWorkspaceData(hydrated = false): WorkspaceData {
  return {
    hydrated,
    selectedSessionId: null,
    selectedTicketId: null,
    selectedAttemptId: null,
    railOpen: true,
    threadOpen: false,
    viewsOpen: false,
    selectedView: null,
    ticketChatExpandedId: null,
    ticketChatSeenByTicket: {},
    ticketRecordsOpenId: null,
    compactPanel: null,
    compactDestination: 'inbox',
    ticketReturnDestination: 'inbox',
    railView: 'inbox',
    ticketFilter: 'all',
    ticketProject: null,
    ticketQuery: '',
    collapsedTicketGroupIds: [],
    scrollAnchorByContext: {},
    expandedMessagePartIds: {},
    composerDraftByContext: {},
    interventionCommandStateById: {},
    artifactDownloadStateById: {},
  };
}

export function createWorkspaceStore() {
  return createStore<WorkspaceStoreState>()(subscribeWithSelector((set, get) => ({
    ...createInitialWorkspaceData(),
    selectTicket: (ticketId) => {
      if (get().selectedTicketId === ticketId) return;
      set({ selectedTicketId: ticketId });
    },
    selectSession: (sessionId) => {
      if (get().selectedSessionId !== sessionId) set({ selectedSessionId: sessionId });
    },
    selectAttempt: (attemptId) => {
      if (get().selectedAttemptId !== attemptId) set({ selectedAttemptId: attemptId });
    },
    setHydrated: (hydrated) => {
      if (get().hydrated !== hydrated) set({ hydrated });
    },
    openRail: () => {
      if (!get().railOpen) set({ railOpen: true });
    },
    closeRail: () => {
      if (get().railOpen) set({ railOpen: false });
    },
    // 右侧只有一个位置（patterns P16.2）：打开工单详情时收起视图面板，打开视图面板时收起工单详情。
    openThread: () => {
      if (!get().threadOpen || get().viewsOpen) set({ threadOpen: true, viewsOpen: false });
    },
    closeThread: () => {
      if (get().threadOpen) set({ threadOpen: false });
    },
    openViews: () => {
      const current = get();
      if (!current.viewsOpen || current.threadOpen || current.compactPanel !== null) set({ viewsOpen: true, threadOpen: false, compactPanel: null });
    },
    closeViews: () => {
      if (get().viewsOpen) set({ viewsOpen: false });
    },
    selectView: (selectedView) => {
      if (get().selectedView !== selectedView) set({ selectedView });
    },
    setTicketChatExpanded: (ticketId, expanded) => {
      const current = get().ticketChatExpandedId;
      const next = expanded ? ticketId : current === ticketId ? null : current;
      if (next !== current) set({ ticketChatExpandedId: next });
    },
    setTicketRecordsOpen: (ticketId, open) => {
      const current = get().ticketRecordsOpenId;
      const next = open ? ticketId : current === ticketId ? null : current;
      if (next !== current) set({ ticketRecordsOpenId: next });
    },
    markTicketChatSeen: (ticketId, messageId) => {
      if (get().ticketChatSeenByTicket[ticketId] === messageId) return;
      set({ ticketChatSeenByTicket: { ...get().ticketChatSeenByTicket, [ticketId]: messageId } });
    },
    openCompactPanel: (compactPanel) => {
      if (get().compactPanel !== compactPanel || get().viewsOpen) set({ compactPanel, viewsOpen: false });
    },
    closeCompactPanel: () => {
      if (get().compactPanel !== null) set({ compactPanel: null });
    },
    setCompactDestination: (compactDestination) => {
      if (get().compactDestination !== compactDestination) set({ compactDestination });
    },
    setTicketReturnDestination: (ticketReturnDestination) => {
      if (get().ticketReturnDestination !== ticketReturnDestination) set({ ticketReturnDestination });
    },
    setRailView: (railView) => {
      if (get().railView !== railView) set({ railView });
    },
    setTicketFilter: (ticketFilter) => {
      if (get().ticketFilter !== ticketFilter) set({ ticketFilter });
    },
    setTicketProject: (ticketProject) => {
      if (get().ticketProject !== ticketProject) set({ ticketProject });
    },
    setTicketQuery: (ticketQuery) => {
      if (get().ticketQuery !== ticketQuery) set({ ticketQuery });
    },
    toggleTicketGroup: (groupId) => {
      const current = get().collapsedTicketGroupIds;
      set({
        collapsedTicketGroupIds: current.includes(groupId)
          ? current.filter((id) => id !== groupId)
          : [...current, groupId],
      });
    },
    setScrollAnchor: (context, anchor) => {
      if (get().scrollAnchorByContext[context] === anchor) return;
      set({ scrollAnchorByContext: { ...get().scrollAnchorByContext, [context]: anchor } });
    },
    toggleMessagePart: (partId) => {
      const expandedMessagePartIds = { ...get().expandedMessagePartIds };
      if (expandedMessagePartIds[partId]) delete expandedMessagePartIds[partId];
      else expandedMessagePartIds[partId] = true;
      set({ expandedMessagePartIds });
    },
    setComposerDraft: (context, draft) => {
      if (get().composerDraftByContext[context] === draft) return;
      set({ composerDraftByContext: { ...get().composerDraftByContext, [context]: draft } });
    },
    clearComposerDraft: (context) => {
      if (!(context in get().composerDraftByContext)) return;
      const composerDraftByContext = { ...get().composerDraftByContext };
      delete composerDraftByContext[context];
      set({ composerDraftByContext });
    },
    setInterventionCommandState: (interventionId, state) => {
      if (get().interventionCommandStateById[interventionId] === state) return;
      set({
        interventionCommandStateById: {
          ...get().interventionCommandStateById,
          [interventionId]: state,
        },
      });
    },
    setArtifactDownloadState: (artifactId, state) => {
      if (get().artifactDownloadStateById[artifactId] === state) return;
      set({
        artifactDownloadStateById: {
          ...get().artifactDownloadStateById,
          [artifactId]: state,
        },
      });
    },
    reconcileSelections: ({ ticketIds, sessionIds, attemptIds }) => {
      const current = get();
      const selectedTicketId = current.selectedTicketId !== null && ticketIds.includes(current.selectedTicketId)
        ? current.selectedTicketId
        : null;
      const selectedSessionId = current.selectedSessionId !== null && sessionIds.includes(current.selectedSessionId)
        ? current.selectedSessionId
        : null;
      const selectedAttemptId = current.selectedAttemptId !== null && attemptIds.includes(current.selectedAttemptId)
        ? current.selectedAttemptId
        : null;
      const ticketChatExpandedId = current.ticketChatExpandedId !== null && ticketIds.includes(current.ticketChatExpandedId)
        ? current.ticketChatExpandedId
        : null;
      const ticketRecordsOpenId = current.ticketRecordsOpenId !== null && ticketIds.includes(current.ticketRecordsOpenId)
        ? current.ticketRecordsOpenId
        : null;
      set({
        selectedTicketId,
        selectedSessionId,
        selectedAttemptId,
        ticketChatExpandedId,
        ticketRecordsOpenId,
        ...(selectedTicketId === null ? { threadOpen: false, compactPanel: null } : {}),
      });
    },
    handleBreakpointChange: () => {
      const current = get();
      if (current.compactPanel !== null) set({ compactPanel: null });
      // 视图面板在桌面上是一栏，在手机宽度上盖住会话（P16.1、P16.3）：换宽度时收起，不带到另一种布局里。
      if (current.viewsOpen) set({ viewsOpen: false });
    },
    resetForForget: () => set(createInitialWorkspaceData(get().hydrated)),
  })));
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
