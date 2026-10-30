import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './store';

describe('shared workspace state', () => {
  it('composes desktop ticket selection with the right thread column', () => {
    const store = createWorkspaceStore();
    store.getState().selectTicket(42);
    store.getState().openThread();

    expect(store.getState()).toMatchObject({
      selectedTicketId: 42,
      threadOpen: true,
      compactPanel: null,
    });
    store.getState().closeThread();
    expect(store.getState()).toMatchObject({ selectedTicketId: 42, threadOpen: false });
  });

  // 选中的那一项刷新后不见了（例如它是提醒，工单列表只装 task）：选中清掉，详情跟着关上。工作台不会自己再打开一张。
  it('closes the ticket detail when a refresh removes the selected ticket', () => {
    const store = createWorkspaceStore();
    store.getState().selectTicket(83);
    store.getState().openThread();
    store.getState().reconcileSelections({ ticketIds: [7, 8], sessionIds: [], attemptIds: [] });
    expect(store.getState()).toMatchObject({ selectedTicketId: null, threadOpen: false });
  });

  it('keeps one ticket chat dock expanded and remembers the last message seen per ticket', () => {
    const store = createWorkspaceStore();
    store.getState().setTicketChatExpanded(66, true);
    expect(store.getState().ticketChatExpandedId).toBe(66);
    // 收起别的工单的对话坞，不影响展开着的这一张。
    store.getState().setTicketChatExpanded(71, false);
    expect(store.getState().ticketChatExpandedId).toBe(66);
    store.getState().setTicketChatExpanded(71, true);
    expect(store.getState().ticketChatExpandedId).toBe(71);
    store.getState().setTicketChatExpanded(71, false);
    expect(store.getState().ticketChatExpandedId).toBeNull();

    store.getState().markTicketChatSeen(66, 'session:turn:assistant');
    expect(store.getState().ticketChatSeenByTicket).toEqual({ 66: 'session:turn:assistant' });

    store.getState().setTicketChatExpanded(66, true);
    store.getState().reconcileSelections({ ticketIds: [71], sessionIds: [], attemptIds: [] });
    expect(store.getState().ticketChatExpandedId).toBeNull();
  });

  it('opens the evidence and records of one ticket at a time', () => {
    const store = createWorkspaceStore();
    store.getState().setTicketRecordsOpen(66, true);
    expect(store.getState().ticketRecordsOpenId).toBe(66);
    store.getState().setTicketRecordsOpen(71, false);
    expect(store.getState().ticketRecordsOpenId).toBe(66);
    store.getState().setTicketRecordsOpen(66, false);
    expect(store.getState().ticketRecordsOpenId).toBeNull();
    store.getState().setTicketRecordsOpen(66, true);
    store.getState().reconcileSelections({ ticketIds: [], sessionIds: [], attemptIds: [] });
    expect(store.getState().ticketRecordsOpenId).toBeNull();
  });

  it('composes compact and native selection without mutating latent desktop panels', () => {
    const store = createWorkspaceStore();
    store.getState().closeRail();
    store.getState().selectTicket(42);
    store.getState().openCompactPanel('thread');

    expect(store.getState()).toMatchObject({
      selectedTicketId: 42,
      railOpen: false,
      threadOpen: false,
      compactPanel: 'thread',
    });
    store.getState().handleBreakpointChange();
    expect(store.getState()).toMatchObject({
      selectedTicketId: 42,
      railOpen: false,
      threadOpen: false,
      compactPanel: null,
      compactDestination: 'inbox',
    });
  });

  it('shares session, attempt, rail view, filter, expansions, and composer drafts', () => {
    const store = createWorkspaceStore();
    store.getState().selectSession('session-1');
    store.getState().selectAttempt(9);
    store.getState().setRailView('agenda');
    store.getState().setCompactDestination('projects');
    store.getState().setTicketReturnDestination('tickets');
    store.getState().setTicketFilter('running');
    store.getState().setTicketQuery('protocol');
    store.getState().toggleTicketGroup('completed');
    store.getState().setScrollAnchor('tickets', 'ticket:42');
    store.getState().toggleMessagePart('part-1');
    store.getState().setComposerDraft('lead', 'continue');
    store.getState().setComposerDraft('ticket:42', 'ticket context');

    expect(store.getState()).toMatchObject({
      selectedSessionId: 'session-1',
      selectedAttemptId: 9,
      railView: 'agenda',
      compactDestination: 'projects',
      ticketReturnDestination: 'tickets',
      ticketFilter: 'running',
      ticketQuery: 'protocol',
      collapsedTicketGroupIds: ['completed'],
      scrollAnchorByContext: { tickets: 'ticket:42' },
      expandedMessagePartIds: { 'part-1': true },
      composerDraftByContext: { lead: 'continue', 'ticket:42': 'ticket context' },
    });
    store.getState().toggleMessagePart('part-1');
    store.getState().clearComposerDraft('lead');
    expect(store.getState().expandedMessagePartIds).toEqual({});
    expect(store.getState().composerDraftByContext).toEqual({ 'ticket:42': 'ticket context' });
  });

  it('tracks intervention command lifecycle separately from authority state', () => {
    const store = createWorkspaceStore();

    store.getState().setInterventionCommandState('approval:9', {
      state: 'pending', error: null, retryable: false,
    });
    expect(store.getState().interventionCommandStateById['approval:9']).toEqual({
      state: 'pending', error: null, retryable: false,
    });

    store.getState().setInterventionCommandState('approval:9', {
      state: 'error', error: 'resolution unavailable', retryable: true,
    });
    expect(store.getState().interventionCommandStateById['approval:9']).toEqual({
      state: 'error', error: 'resolution unavailable', retryable: true,
    });
  });

  it('tracks artifact downloads outside canonical artifact metadata', () => {
    const store = createWorkspaceStore();
    store.getState().setArtifactDownloadState(9, {
      state: 'downloading', error: null, retryable: false,
    });
    store.getState().setArtifactDownloadState(9, {
      state: 'error', error: 'share unavailable', retryable: true,
    });
    expect(store.getState().artifactDownloadStateById[9]).toEqual({
      state: 'error', error: 'share unavailable', retryable: true,
    });
  });

  it('clears only selections removed by accepted snapshots', () => {
    const store = createWorkspaceStore();
    store.getState().selectTicket(42);
    store.getState().selectSession('session-1');
    store.getState().selectAttempt(9);
    store.getState().openThread();

    store.getState().reconcileSelections({
      ticketIds: [41],
      sessionIds: ['session-1'],
      attemptIds: [],
    });

    expect(store.getState()).toMatchObject({
      selectedTicketId: null,
      selectedSessionId: 'session-1',
      selectedAttemptId: null,
      threadOpen: false,
      compactPanel: null,
    });
  });

  it('resets business state for forget while preserving client hydration', () => {
    const store = createWorkspaceStore();
    store.getState().setHydrated(true);
    store.getState().selectTicket(42);
    store.getState().openCompactPanel('work');
    store.getState().setComposerDraft('lead', 'draft');

    store.getState().resetForForget();

    expect(store.getState()).toMatchObject({
      hydrated: true,
      selectedTicketId: null,
      compactPanel: null,
      composerDraftByContext: {},
      railOpen: true,
      threadOpen: false,
    });
  });
});
