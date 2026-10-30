export interface InvalidationScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface InvalidationCoordinator {
  ensure(key: string): Promise<void>;
  refresh(key: string): Promise<void>;
  invalidate(keys: string[]): void;
  release(key: string): void;
  generation(key: string): number;
  dispose(): void;
}

export function createInvalidationCoordinator(_options: {
  scheduler: InvalidationScheduler;
  refresh(key: string, generation: number, signal: AbortSignal): Promise<void>;
  isObserved?(key: string): boolean;
  onStale?(key: string, generation: number): void;
}): InvalidationCoordinator {
  const options = _options;
  const generations = new Map<string, number>();
  const active = new Map<string, {
    promise: Promise<void>;
    controller: AbortController;
    forced: boolean;
  }>();
  const replacement = new Map<string, boolean>();
  const pending = new Set<string>();
  let scheduled: unknown = null;
  let disposed = false;

  const requestReplacement = (key: string, forced: boolean): void => {
    replacement.set(key, forced || replacement.get(key) === true);
  };

  const nextGeneration = (key: string): number => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    options.onStale?.(key, generation);
    return generation;
  };

  const followReplacement = (
    key: string,
    current: { promise: Promise<void>; controller: AbortController; forced: boolean },
  ): Promise<void> => current.promise.catch(() => {}).then(() => {
    const next = active.get(key);
    if (next && next !== current) return next.promise;
  });

  const start = (key: string, forced = false): Promise<void> => {
    const existing = active.get(key);
    if (existing) {
      if (existing.controller.signal.aborted) {
        requestReplacement(key, false);
        return followReplacement(key, existing);
      }
      return existing.promise;
    }
    const controller = new AbortController();
    const generation = generations.get(key) ?? 0;
    let refreshPromise: Promise<void>;
    try {
      refreshPromise = Promise.resolve(options.refresh(key, generation, controller.signal));
    } catch (error) {
      refreshPromise = Promise.reject(error);
    }
    const promise = refreshPromise.finally(() => {
      const current = active.get(key);
      if (current?.promise !== promise) return;
      active.delete(key);
      const forced = replacement.get(key);
      replacement.delete(key);
      if (disposed || forced === undefined || (!forced && options.isObserved?.(key) === false)) return;
      void start(key, forced).catch(() => {});
    });
    active.set(key, { promise, controller, forced });
    return promise;
  };

  const flush = () => {
    scheduled = null;
    if (disposed) return;
    const keys = [...pending];
    pending.clear();
    for (const key of keys) {
      nextGeneration(key);
      if (options.isObserved?.(key) === false) continue;
      if (active.has(key)) requestReplacement(key, false);
      else void start(key).catch(() => {});
    }
  };

  return {
    ensure: (key) => disposed ? Promise.resolve() : start(key),
    refresh: (key) => {
      if (disposed) return Promise.resolve();
      nextGeneration(key);
      const existing = active.get(key);
      if (!existing) return start(key, true);
      requestReplacement(key, true);
      existing.controller.abort();
      return followReplacement(key, existing);
    },
    invalidate: (keys) => {
      if (disposed) return;
      for (const key of keys) pending.add(key);
      if (scheduled === null) scheduled = options.scheduler.schedule(flush, 0);
    },
    release: (key) => {
      pending.delete(key);
      if (replacement.get(key) !== true) replacement.delete(key);
      const current = active.get(key);
      if (current && !current.forced) current.controller.abort();
    },
    generation: (key) => generations.get(key) ?? 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (scheduled !== null) options.scheduler.cancel(scheduled);
      scheduled = null;
      pending.clear();
      replacement.clear();
      for (const item of active.values()) item.controller.abort();
      active.clear();
    },
  };
}
