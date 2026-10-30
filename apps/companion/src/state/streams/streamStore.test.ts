import { describe, expect, it, vi } from 'vitest';

import type { AgentLogEntry } from '../types';
import { createStreamCoordinator, type StreamScheduler } from './batching';
import { createStreamStore } from './store';

function scheduler() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const value: StreamScheduler & { runAll(): void; advance(ms: number): void } = {
    schedule(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(handle) {
      callbacks.delete(handle as number);
    },
    now: () => now,
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    advance(ms) {
      now += ms;
      value.runAll();
    },
  };
  return value;
}

function log(attemptId: number, seq: number): AgentLogEntry {
  return {
    attemptId,
    seq,
    occurredAt: new Date(seq * 1_000).toISOString(),
    kind: 'stdout',
    text: `line ${seq}`,
  };
}

describe('bounded stream state', () => {
  it('commits 1,000 text deltas once after the scheduled flush', () => {
    const store = createStreamStore();
    const clock = scheduler();
    const coordinator = createStreamCoordinator(store, clock);
    const listener = vi.fn();
    store.subscribe(listener);

    for (let index = 0; index < 1_000; index += 1) {
      coordinator.appendTextDelta('message-a', 'x');
    }

    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().textByMessageId['message-a']).toBeUndefined();
    clock.runAll();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().textByMessageId['message-a']).toHaveLength(1_000);
  });

  it('flushes a log burst once without notifying another attempt selector', () => {
    const store = createStreamStore();
    const clock = scheduler();
    const coordinator = createStreamCoordinator(store, clock);
    store.getState().applyBatch({}, [log(2, 1)], 0);
    const attemptB = store.getState().logBuffersByAttemptId[2];
    const attemptBListener = vi.fn();
    const wholeStoreListener = vi.fn();
    store.subscribe((state) => state.logBuffersByAttemptId[2], attemptBListener);
    store.subscribe(wholeStoreListener);

    coordinator.appendLogEntries(Array.from({ length: 100 }, (_, index) => log(1, index + 1)));
    clock.runAll();

    expect(wholeStoreListener).toHaveBeenCalledTimes(1);
    expect(attemptBListener).not.toHaveBeenCalled();
    expect(store.getState().logBuffersByAttemptId[2]).toBe(attemptB);
    expect(store.getState().logBuffersByAttemptId[1]?.items).toHaveLength(100);
  });

  it('orders, deduplicates, truncates, and bounds attempt log buffers', () => {
    const store = createStreamStore();
    const entries = Array.from({ length: 2_001 }, (_, index) => log(1, 2_001 - index));
    entries.push(log(1, 2_001));
    store.getState().applyBatch({}, entries, 1);

    const firstBuffer = store.getState().logBuffersByAttemptId[1];
    expect(firstBuffer.items).toHaveLength(2_000);
    expect(firstBuffer.items[0]?.seq).toBe(2);
    expect(firstBuffer.items.at(-1)?.seq).toBe(2_001);
    expect(firstBuffer.discardThroughSeq).toBe(1);
    expect(Object.keys(firstBuffer.seenSeqs)).toHaveLength(2_000);

    store.getState().applyBatch({}, Array.from({ length: 8 }, (_, index) => log(index + 2, 1)), 2);
    expect(Object.keys(store.getState().logBuffersByAttemptId)).toHaveLength(8);
    expect(store.getState().logBuffersByAttemptId[1]).toBeUndefined();
  });

  it('uses composite tool part IDs and drains terminal progress once', () => {
    const store = createStreamStore();
    store.getState().setToolProgress({ partId: 'turn-1:call-1', state: 'running', updatedAt: 1 });
    store.getState().setToolProgress({ partId: 'turn-2:call-1', state: 'completed', updatedAt: 2 });

    expect(Object.keys(store.getState().toolProgressByPartId)).toEqual([
      'turn-1:call-1',
      'turn-2:call-1',
    ]);
    expect(store.getState().drainToolProgress('turn-2:call-1')).toMatchObject({ state: 'completed' });
    expect(store.getState().drainToolProgress('turn-2:call-1')).toBeNull();
    expect(store.getState().toolProgressByPartId['turn-1:call-1']).toBeDefined();
  });

  it('drains pending and committed text exactly once', () => {
    const store = createStreamStore();
    const clock = scheduler();
    const coordinator = createStreamCoordinator(store, clock);
    store.getState().applyBatch({ 'message-a': 'stored' }, [], 0);
    coordinator.appendTextDelta('message-a', '+pending');

    expect(coordinator.drainText('message-a')).toBe('stored+pending');
    expect(coordinator.drainText('message-a')).toBe('');
    expect(store.getState().textByMessageId['message-a']).toBeUndefined();
    clock.runAll();
    expect(store.getState().textByMessageId['message-a']).toBeUndefined();
  });

  it('caps and expires orphan text, tools, and heartbeats', () => {
    const store = createStreamStore();
    const textDeltas = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`message-${index}`, 'x']),
    );
    store.getState().applyBatch(textDeltas, [], 0);
    for (let index = 0; index < 257; index += 1) {
      store.getState().setToolProgress({
        partId: `part-${index}`,
        state: 'running',
        updatedAt: index,
      });
    }
    for (let index = 0; index < 65; index += 1) {
      store.getState().setHeartbeat({ attemptId: index + 1, state: 'running', updatedAt: index });
    }

    expect(Object.keys(store.getState().textByMessageId)).toHaveLength(256);
    expect(Object.keys(store.getState().toolProgressByPartId)).toHaveLength(256);
    expect(Object.keys(store.getState().heartbeatByAttemptId)).toHaveLength(64);
    store.getState().completeAttempt(65);
    expect(store.getState().heartbeatByAttemptId[65]).toBeUndefined();

    store.getState().pruneExpired(300_001 + 256);
    expect(store.getState().textByMessageId).toEqual({});
    expect(store.getState().toolProgressByPartId).toEqual({});
    expect(store.getState().heartbeatByAttemptId).toEqual({});
  });

  it('clears selected transient keys and cancels queued writes on disposal', () => {
    const store = createStreamStore();
    const clock = scheduler();
    const coordinator = createStreamCoordinator(store, clock);
    store.getState().applyBatch({ a: 'A', b: 'B' }, [log(1, 1), log(2, 1)], 0);
    store.getState().setToolProgress({ partId: 'part-a', state: 'running', updatedAt: 0 });
    store.getState().setHeartbeat({ attemptId: 1, state: 'running', updatedAt: 0 });
    store.getState().clearTransient({ messageIds: ['a'], partIds: ['part-a'], attemptIds: [1] });

    expect(store.getState().textByMessageId).toEqual({ b: 'B' });
    expect(store.getState().toolProgressByPartId).toEqual({});
    expect(store.getState().heartbeatByAttemptId).toEqual({});
    expect(store.getState().logBuffersByAttemptId[1]).toBeUndefined();
    expect(store.getState().logBuffersByAttemptId[2]).toBeDefined();

    coordinator.appendTextDelta('late', 'write');
    coordinator.dispose();
    clock.runAll();
    expect(store.getState().textByMessageId.late).toBeUndefined();
  });
});
