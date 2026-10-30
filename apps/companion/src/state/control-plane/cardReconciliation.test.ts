import type {
  KernelCheckpoint,
  KernelConversationCard,
  KernelConversationCardListResponse,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneStore } from './store';

const createdAt = '2026-07-24T04:00:00.000Z';

function liveExecution(state: 'started' | 'running' | 'completed' = 'started') {
  return {
    key: 'turn:turn-1:ticket:42',
    kind: 'ticket_execution' as const,
    turnId: 'turn-1',
    ticketId: 42,
    operations: [{
      id: 'turn-1:create-ticket',
      name: 'create_ticket',
      state,
      label: '创建工单 #42',
      detail: state === 'completed' ? 'created ticket #42' : null,
    }],
    operationsTruncated: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function durableExecution(
  id = 9,
): Extract<KernelConversationCard, { kind: 'ticket_execution' }> {
  return { id, ...liveExecution('completed') };
}

function durableExecutionForTicket(ticketId: number, id: number): KernelConversationCard {
  return {
    ...durableExecution(id),
    key: `turn:turn-${ticketId}:ticket:${ticketId}`,
    turnId: `turn-${ticketId}`,
    ticketId,
  };
}

const checkpoint: KernelCheckpoint = {
  id: 12,
  ticketId: 42,
  attemptId: 73,
  author: { kind: 'executor', runtime: 'codex' },
  source: 'agent_reported',
  kind: 'completed',
  stage: 'implementation',
  title: 'Implementation complete',
  summary: 'All checks pass',
  keyFacts: [],
  artifactRefs: [],
  relatedTicketIds: [],
  nextStep: null,
  actionRef: null,
  createdAt,
};

function response(items: KernelConversationCard[]): KernelConversationCardListResponse {
  return {
    items,
    checkpoints: items.some((item) => item.kind === 'checkpoint') ? [checkpoint] : [],
    interventionRefs: [],
    hasMore: false,
    nextBeforeId: items[0]?.id ?? null,
  };
}

describe('conversation-card reconciliation', () => {
  it('uses the stable key as one live identity across operation updates', () => {
    const store = createControlPlaneStore();
    store.getState().upsertTransientConversationCard(liveExecution('started'));
    const first = store.getState().conversationCardsById['turn:turn-1:ticket:42'];
    const listener = vi.fn();
    store.subscribe((state) => state.conversationCardIds, listener);

    store.getState().upsertTransientConversationCard(liveExecution('running'));

    const state = store.getState();
    expect(state.conversationCardIds).toEqual(['turn:turn-1:ticket:42']);
    expect(state.conversationCardsById['turn:turn-1:ticket:42']).not.toBe(first);
    expect(state.conversationCardsById['turn:turn-1:ticket:42']).toMatchObject({
      id: 'turn:turn-1:ticket:42',
      durableId: null,
      source: 'live',
      operations: [{ state: 'running' }],
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('attaches the durable id to an existing live card without duplication or ordering jumps', () => {
    const store = createControlPlaneStore();
    store.getState().upsertTransientConversationCard(liveExecution('running'));
    const ids = store.getState().conversationCardIds;

    store.getState().mergeConversationCardPage(response([durableExecution()]), 'replace');

    const state = store.getState();
    expect(state.conversationCardIds).toBe(ids);
    expect(state.conversationCardIds).toEqual(['turn:turn-1:ticket:42']);
    expect(state.conversationCardsById['turn:turn-1:ticket:42']).toMatchObject({
      id: 'turn:turn-1:ticket:42',
      durableId: 9,
      source: 'durable',
      operations: [{ state: 'completed' }],
    });
    expect(state.conversationCardKeyByDurableId[9]).toBe('turn:turn-1:ticket:42');
  });

  it('deduplicates repeated durable snapshots by stable key and authoritative durable id', () => {
    const store = createControlPlaneStore();
    const card = durableExecution();
    store.getState().mergeConversationCardPage(response([card]), 'replace');
    const firstEntity = store.getState().conversationCardsById[card.key];
    const firstIds = store.getState().conversationCardIds;

    store.getState().mergeConversationCardPage(response([{ ...card }]), 'replace');

    expect(store.getState().conversationCardsById[card.key]).toBe(firstEntity);
    expect(store.getState().conversationCardIds).toBe(firstIds);
  });

  it('replaces one ticket-scoped snapshot without deleting durable cards from other tickets', () => {
    const store = createControlPlaneStore();
    const ticket42 = durableExecutionForTicket(42, 9);
    const ticket55 = durableExecutionForTicket(55, 10);
    store.getState().mergeConversationCardPage(response([ticket42, ticket55]), 'replace');
    const otherTicketEntity = store.getState().conversationCardsById[ticket55.key];

    store.getState().mergeConversationCardPage(
      response([{ ...ticket42, updatedAt: '2026-07-24T04:01:00.000Z' }]),
      'replace',
      'conversation-cards:ticket:42',
    );

    const state = store.getState();
    expect(state.conversationCardIds).toEqual([ticket42.key, ticket55.key]);
    expect(state.conversationCardsById[ticket55.key]).toBe(otherTicketEntity);
    expect(state.conversationCardsById[ticket42.key]?.updatedAt).toBe('2026-07-24T04:01:00.000Z');
  });

  it('rejects an older durable card version after a newer terminal version is stored', () => {
    const store = createControlPlaneStore();
    const completed = {
      ...durableExecution(),
      updatedAt: '2026-07-24T04:02:00.000Z',
    };
    store.getState().mergeConversationCardPage(response([completed]), 'replace');

    store.getState().mergeConversationCardPage(response([{
      ...durableExecution(),
      operations: [{
        ...durableExecution().operations[0],
        state: 'running',
      }],
      updatedAt: '2026-07-24T04:01:00.000Z',
    }]), 'prepend');

    expect(store.getState().conversationCardsById[completed.key]).toMatchObject({
      updatedAt: completed.updatedAt,
      operations: [{ state: 'completed' }],
    });
  });

  it('clears transient-only cards on permanent disconnect while preserving durable cards', () => {
    const store = createControlPlaneStore();
    const durableCheckpoint: KernelConversationCard = {
      id: 10,
      key: 'checkpoint:12',
      kind: 'checkpoint',
      turnId: null,
      ticketId: 42,
      checkpointId: 12,
      createdAt,
      updatedAt: createdAt,
    };
    store.getState().upsertTransientConversationCard(liveExecution('running'));
    store.getState().mergeConversationCardPage(response([durableCheckpoint]), 'append');

    store.getState().clearTransientConversationCards();

    expect(store.getState().conversationCardIds).toEqual(['checkpoint:12']);
    expect(store.getState().conversationCardsById['turn:turn-1:ticket:42']).toBeUndefined();
    expect(store.getState().conversationCardsById['checkpoint:12']).toMatchObject({
      durableId: 10,
      source: 'durable',
    });
  });
});
