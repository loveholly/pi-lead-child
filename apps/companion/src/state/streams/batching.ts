import type { AgentLogEntry } from '../types';
import type { StreamStore } from './store';

export interface StreamScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export interface StreamCoordinator {
  appendTextDelta(messageId: string, delta: string): void;
  appendLogEntries(entries: AgentLogEntry[]): void;
  drainText(messageId: string): string;
  flush(): void;
  dispose(): void;
}

export function createStreamCoordinator(
  store: StreamStore,
  scheduler: StreamScheduler,
): StreamCoordinator {
  const pendingText = new Map<string, string>();
  const pendingLogs: AgentLogEntry[] = [];
  let scheduled: unknown = null;
  let disposed = false;

  const cancelIfEmpty = () => {
    if (pendingText.size !== 0 || pendingLogs.length !== 0 || scheduled === null) return;
    scheduler.cancel(scheduled);
    scheduled = null;
  };

  const flush = () => {
    if (disposed) return;
    scheduled = null;
    if (pendingText.size === 0 && pendingLogs.length === 0) return;
    const textDeltas = Object.fromEntries(pendingText);
    const logEntries = pendingLogs.splice(0);
    pendingText.clear();
    store.getState().applyBatch(textDeltas, logEntries, scheduler.now());
  };

  const ensureScheduled = () => {
    if (scheduled !== null || disposed) return;
    scheduled = scheduler.schedule(flush, 16);
  };

  return {
    appendTextDelta: (messageId, delta) => {
      if (disposed || delta.length === 0) return;
      pendingText.set(messageId, `${pendingText.get(messageId) ?? ''}${delta}`);
      ensureScheduled();
    },
    appendLogEntries: (entries) => {
      if (disposed || entries.length === 0) return;
      pendingLogs.push(...entries);
      ensureScheduled();
    },
    drainText: (messageId) => {
      if (disposed) return '';
      const pending = pendingText.get(messageId) ?? '';
      pendingText.delete(messageId);
      cancelIfEmpty();
      return `${store.getState().drainText(messageId)}${pending}`;
    },
    flush,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (scheduled !== null) scheduler.cancel(scheduled);
      scheduled = null;
      pendingText.clear();
      pendingLogs.length = 0;
    },
  };
}
