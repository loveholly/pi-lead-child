import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type {
  AgentLogEntry,
  AttemptHeartbeat,
  StreamData,
  ToolProgress,
} from '../types';
import { appendAgentLogEntries } from './logBuffer';

const MAX_ORPHAN_STREAMS = 256;
const MAX_HEARTBEATS = 64;
const MAX_ATTEMPT_BUFFERS = 8;
const ORPHAN_TTL_MS = 5 * 60 * 1_000;

export interface StreamStoreState extends StreamData {
  setText(messageId: string, text: string): void;
  applyBatch(textDeltas: Record<string, string>, logEntries: AgentLogEntry[], now: number): void;
  drainText(messageId: string): string;
  setToolProgress(progress: ToolProgress): void;
  drainToolProgress(partId: string): ToolProgress | null;
  setHeartbeat(heartbeat: AttemptHeartbeat): void;
  completeAttempt(attemptId: number): void;
  clearTransient(input: { messageIds?: string[]; partIds?: string[]; attemptIds?: number[] }): void;
  pruneExpired(now: number): void;
  reset(): void;
}

export function createInitialStreamData(): StreamData {
  return {
    textByMessageId: {},
    textUpdatedAtByMessageId: {},
    toolProgressByPartId: {},
    logBuffersByAttemptId: {},
    heartbeatByAttemptId: {},
  };
}

export function createStreamStore() {
  return createStore<StreamStoreState>()(subscribeWithSelector((set, get) => ({
    ...createInitialStreamData(),
    setText: (messageId, text) => {
      if (get().textByMessageId[messageId] === text) return;
      set((state) => ({
        textByMessageId: { ...state.textByMessageId, [messageId]: text },
        textUpdatedAtByMessageId: { ...state.textUpdatedAtByMessageId, [messageId]: 0 },
      }));
    },
    applyBatch: (textDeltas, logEntries, now) => {
      const current = get();
      let textByMessageId = current.textByMessageId;
      let textUpdatedAtByMessageId = current.textUpdatedAtByMessageId;
      if (Object.keys(textDeltas).length > 0) {
        textByMessageId = { ...textByMessageId };
        textUpdatedAtByMessageId = { ...textUpdatedAtByMessageId };
        for (const [messageId, delta] of Object.entries(textDeltas)) {
          textByMessageId[messageId] = `${textByMessageId[messageId] ?? ''}${delta}`;
          textUpdatedAtByMessageId[messageId] = now;
        }
        ({ values: textByMessageId, timestamps: textUpdatedAtByMessageId } = capTimestampedRecord(
          textByMessageId,
          textUpdatedAtByMessageId,
          MAX_ORPHAN_STREAMS,
        ));
      }

      let logBuffersByAttemptId = current.logBuffersByAttemptId;
      if (logEntries.length > 0) {
        logBuffersByAttemptId = { ...logBuffersByAttemptId };
        const byAttempt = new Map<number, AgentLogEntry[]>();
        for (const entry of logEntries) {
          const group = byAttempt.get(entry.attemptId) ?? [];
          group.push(entry);
          byAttempt.set(entry.attemptId, group);
        }
        for (const [attemptId, entries] of byAttempt) {
          logBuffersByAttemptId[attemptId] = appendAgentLogEntries(
            logBuffersByAttemptId[attemptId],
            entries,
            now,
          );
        }
        logBuffersByAttemptId = capAttemptBuffers(logBuffersByAttemptId);
      }

      if (
        textByMessageId === current.textByMessageId &&
        textUpdatedAtByMessageId === current.textUpdatedAtByMessageId &&
        logBuffersByAttemptId === current.logBuffersByAttemptId
      ) return;
      set({ textByMessageId, textUpdatedAtByMessageId, logBuffersByAttemptId });
    },
    drainText: (messageId) => {
      const current = get();
      const text = current.textByMessageId[messageId];
      if (text === undefined) return '';
      const textByMessageId = { ...current.textByMessageId };
      const textUpdatedAtByMessageId = { ...current.textUpdatedAtByMessageId };
      delete textByMessageId[messageId];
      delete textUpdatedAtByMessageId[messageId];
      set({ textByMessageId, textUpdatedAtByMessageId });
      return text;
    },
    setToolProgress: (progress) => {
      const current = get();
      if (current.toolProgressByPartId[progress.partId] === progress) return;
      const next = { ...current.toolProgressByPartId, [progress.partId]: progress };
      set({ toolProgressByPartId: capByTimestamp(next, MAX_ORPHAN_STREAMS, (item) => item.updatedAt) });
    },
    drainToolProgress: (partId) => {
      const current = get();
      const progress = current.toolProgressByPartId[partId];
      if (!progress) return null;
      const toolProgressByPartId = { ...current.toolProgressByPartId };
      delete toolProgressByPartId[partId];
      set({ toolProgressByPartId });
      return progress;
    },
    setHeartbeat: (heartbeat) => {
      const current = get();
      const next = { ...current.heartbeatByAttemptId, [heartbeat.attemptId]: heartbeat };
      set({ heartbeatByAttemptId: capByTimestamp(next, MAX_HEARTBEATS, (item) => item.updatedAt) });
    },
    completeAttempt: (attemptId) => {
      const current = get();
      if (!current.heartbeatByAttemptId[attemptId]) return;
      const heartbeatByAttemptId = { ...current.heartbeatByAttemptId };
      delete heartbeatByAttemptId[attemptId];
      set({ heartbeatByAttemptId });
    },
    clearTransient: ({ messageIds = [], partIds = [], attemptIds = [] }) => {
      const current = get();
      const textByMessageId = { ...current.textByMessageId };
      const textUpdatedAtByMessageId = { ...current.textUpdatedAtByMessageId };
      const toolProgressByPartId = { ...current.toolProgressByPartId };
      const heartbeatByAttemptId = { ...current.heartbeatByAttemptId };
      const logBuffersByAttemptId = { ...current.logBuffersByAttemptId };
      for (const id of messageIds) {
        delete textByMessageId[id];
        delete textUpdatedAtByMessageId[id];
      }
      for (const id of partIds) delete toolProgressByPartId[id];
      for (const id of attemptIds) {
        delete heartbeatByAttemptId[id];
        delete logBuffersByAttemptId[id];
      }
      set({
        textByMessageId,
        textUpdatedAtByMessageId,
        toolProgressByPartId,
        heartbeatByAttemptId,
        logBuffersByAttemptId,
      });
    },
    pruneExpired: (now) => {
      const current = get();
      const cutoff = now - ORPHAN_TTL_MS;
      const textUpdatedAtByMessageId = Object.fromEntries(
        Object.entries(current.textUpdatedAtByMessageId).filter(([, updatedAt]) => updatedAt >= cutoff),
      );
      const textByMessageId = Object.fromEntries(
        Object.entries(current.textByMessageId).filter(([id]) => id in textUpdatedAtByMessageId),
      );
      const toolProgressByPartId = Object.fromEntries(
        Object.entries(current.toolProgressByPartId).filter(([, item]) => item.updatedAt >= cutoff),
      );
      const heartbeatByAttemptId = Object.fromEntries(
        Object.entries(current.heartbeatByAttemptId).filter(([, item]) => item.updatedAt >= cutoff),
      );
      set({ textByMessageId, textUpdatedAtByMessageId, toolProgressByPartId, heartbeatByAttemptId });
    },
    reset: () => set(createInitialStreamData()),
  })));
}

function capTimestampedRecord<T>(
  values: Record<string, T>,
  timestamps: Record<string, number>,
  limit: number,
): { values: Record<string, T>; timestamps: Record<string, number> } {
  const keys = Object.keys(values);
  if (keys.length <= limit) return { values, timestamps };
  const remove = keys
    .sort((left, right) => (timestamps[left] ?? 0) - (timestamps[right] ?? 0) || left.localeCompare(right))
    .slice(0, keys.length - limit);
  const nextValues = { ...values };
  const nextTimestamps = { ...timestamps };
  for (const key of remove) {
    delete nextValues[key];
    delete nextTimestamps[key];
  }
  return { values: nextValues, timestamps: nextTimestamps };
}

function capByTimestamp<T>(
  values: Record<string | number, T>,
  limit: number,
  getTimestamp: (item: T) => number,
): Record<string | number, T> {
  const entries = Object.entries(values);
  if (entries.length <= limit) return values;
  entries.sort(([leftKey, left], [rightKey, right]) =>
    getTimestamp(left) - getTimestamp(right) || leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.slice(entries.length - limit));
}

function capAttemptBuffers(
  values: StreamData['logBuffersByAttemptId'],
): StreamData['logBuffersByAttemptId'] {
  const entries = Object.entries(values);
  if (entries.length <= MAX_ATTEMPT_BUFFERS) return values;
  entries.sort(([leftId, left], [rightId, right]) =>
    left.lastAccessedAt - right.lastAccessedAt || Number(leftId) - Number(rightId));
  return Object.fromEntries(entries.slice(entries.length - MAX_ATTEMPT_BUFFERS));
}

export type StreamStore = ReturnType<typeof createStreamStore>;
