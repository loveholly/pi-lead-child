import type { TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneStore } from './control-plane/store';
import { createStreamStore } from './streams/store';
import { createWorkspaceStore } from './workspace/store';

function ticket(id: number): TicketSummary {
  return {
    id,
    title: `Ticket ${id}`,
    summary: `Summary ${id}`,
    kind: 'task',
    stage: 'draft',
    status: 'draft',
    hasRun: false,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-07-24T06:00:00.000Z',
    runtime: {
      state: 'idle',
      lastActivityAt: null,
      activeAttemptId: null,
    },
    attention: {
      pendingApprovalCount: 0,
      blockerCount: 0,
    },
  };
}

describe('isolated Zustand stores', () => {
  it('creates distinct vanilla store instances', () => {
    const first = createControlPlaneStore();
    const second = createControlPlaneStore();

    expect(first).not.toBe(second);
    expect(first.getState()).not.toBe(second.getState());
  });

  it('notifies a ticket selector only when that ticket changes', () => {
    const store = createControlPlaneStore();
    const listener = vi.fn();
    store.subscribe((state) => state.ticketsById[1], listener);

    store.getState().upsertTicket(ticket(2));
    expect(listener).not.toHaveBeenCalled();

    store.getState().upsertTicket(ticket(1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().ticketsById[1]?.title).toBe('Ticket 1');
  });

  it('keeps stream updates out of domain and workspace subscriptions', () => {
    const control = createControlPlaneStore();
    const streams = createStreamStore();
    const workspace = createWorkspaceStore();
    const controlListener = vi.fn();
    const streamListener = vi.fn();
    const workspaceListener = vi.fn();
    control.subscribe(controlListener);
    streams.subscribe((state) => state.textByMessageId.message_1, streamListener);
    workspace.subscribe(workspaceListener);

    streams.getState().setText('message_1', 'hello');

    expect(streamListener).toHaveBeenCalledTimes(1);
    expect(controlListener).not.toHaveBeenCalled();
    expect(workspaceListener).not.toHaveBeenCalled();
  });

  it('keeps workspace selection out of domain and stream subscriptions', () => {
    const control = createControlPlaneStore();
    const streams = createStreamStore();
    const workspace = createWorkspaceStore();
    const controlListener = vi.fn();
    const streamListener = vi.fn();
    const selectionListener = vi.fn();
    control.subscribe(controlListener);
    streams.subscribe(streamListener);
    workspace.subscribe((state) => state.selectedTicketId, selectionListener);

    workspace.getState().selectTicket(42);

    expect(selectionListener).toHaveBeenCalledTimes(1);
    expect(controlListener).not.toHaveBeenCalled();
    expect(streamListener).not.toHaveBeenCalled();
  });

  it('resets each store to deterministic initial data', () => {
    const control = createControlPlaneStore();
    const streams = createStreamStore();
    const workspace = createWorkspaceStore();
    control.setState({ phase: 'ready', ticketsById: { 1: ticket(1) }, ticketIds: [1] });
    streams.setState({ textByMessageId: { message_1: 'hello' } });
    workspace.setState({ hydrated: true, selectedTicketId: 42, threadOpen: true });

    control.getState().reset();
    streams.getState().reset();
    workspace.getState().resetForForget();

    expect(control.getState().phase).toBe('loading');
    expect(control.getState().ticketIds).toEqual([]);
    expect(streams.getState().textByMessageId).toEqual({});
    expect(workspace.getState().hydrated).toBe(true);
    expect(workspace.getState().selectedTicketId).toBeNull();
    expect(workspace.getState().threadOpen).toBe(false);
  });
});
