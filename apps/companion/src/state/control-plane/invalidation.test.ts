import { describe, expect, it, vi } from 'vitest';

import { createInvalidationCoordinator, type InvalidationScheduler } from './invalidation';

function scheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const value: InvalidationScheduler & { runAll(): void } = {
    schedule(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(handle) {
      callbacks.delete(handle as number);
    },
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('resource invalidation coordination', () => {
  it('coalesces 100 invalidations into one generation and one request', async () => {
    const clock = scheduler();
    const refresh = vi.fn(async () => {});
    const stale = vi.fn();
    const coordinator = createInvalidationCoordinator({ scheduler: clock, refresh, onStale: stale });

    for (let index = 0; index < 100; index += 1) coordinator.invalidate(['tickets']);
    expect(coordinator.generation('tickets')).toBe(0);
    clock.runAll();
    await Promise.resolve();

    expect(coordinator.generation('tickets')).toBe(1);
    expect(stale).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('runs exactly one non-overlapping replacement after an active request', async () => {
    const clock = scheduler();
    const first = deferred();
    const second = deferred();
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const target = refresh.mock.calls.length === 1 ? first : second;
      await target.promise;
      active -= 1;
    });
    const coordinator = createInvalidationCoordinator({ scheduler: clock, refresh });

    const initial = coordinator.ensure('tickets');
    for (let index = 0; index < 100; index += 1) coordinator.invalidate(['tickets']);
    clock.runAll();
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve();
    await initial;
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    second.resolve();
    await Promise.resolve();
  });

  it('forces a new generation without reusing the active request', async () => {
    const clock = scheduler();
    const first = deferred();
    const second = deferred();
    const generations: number[] = [];
    const stale = vi.fn();
    const refresh = vi.fn(async (_key: string, generation: number) => {
      generations.push(generation);
      await (refresh.mock.calls.length === 1 ? first.promise : second.promise);
    });
    const coordinator = createInvalidationCoordinator({ scheduler: clock, refresh, onStale: stale });

    const initial = coordinator.ensure('tickets');
    const forced = coordinator.refresh('tickets');

    expect(coordinator.generation('tickets')).toBe(1);
    expect(stale).toHaveBeenCalledWith('tickets', 1);
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await initial;
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(generations).toEqual([0, 1]);

    second.resolve();
    await forced;
  });

  it('reloads after an aborted release when the resource is re-observed before settle', async () => {
    const clock = scheduler();
    let observed = true;
    const second = deferred();
    const refresh = vi.fn((_key: string, _generation: number, signal: AbortSignal) => {
      if (refresh.mock.calls.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return second.promise;
    });
    const coordinator = createInvalidationCoordinator({
      scheduler: clock,
      refresh,
      isObserved: () => observed,
    });

    const initial = coordinator.ensure('checkpoints:42');
    observed = false;
    coordinator.release('checkpoints:42');
    observed = true;
    const reobserved = coordinator.ensure('checkpoints:42');

    await expect(initial).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    second.resolve();
    await reobserved;
  });

  it('does not cancel an explicit force refresh when the last observer releases', async () => {
    const clock = scheduler();
    const request = deferred();
    let requestSignal: AbortSignal | undefined;
    const refresh = vi.fn((_key: string, _generation: number, signal: AbortSignal) => {
      requestSignal = signal;
      return request.promise;
    });
    const coordinator = createInvalidationCoordinator({
      scheduler: clock,
      refresh,
      isObserved: () => false,
    });

    const forced = coordinator.refresh('interventions:42');
    coordinator.release('interventions:42');

    expect(requestSignal?.aborted).toBe(false);
    request.resolve();
    await forced;
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('marks unobserved resources stale without eagerly refreshing them', () => {
    const clock = scheduler();
    const refresh = vi.fn(async () => {});
    const stale = vi.fn();
    const coordinator = createInvalidationCoordinator({
      scheduler: clock,
      refresh,
      onStale: stale,
      isObserved: () => false,
    });

    coordinator.invalidate(['execution:42']);
    clock.runAll();

    expect(stale).toHaveBeenCalledWith('execution:42', 1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
