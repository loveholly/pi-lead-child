import type { AgentLogBuffer, AgentLogEntry } from '../types';

export function appendAgentLogEntries(
  buffer: AgentLogBuffer | undefined,
  entries: AgentLogEntry[],
  now: number,
  limit = 2_000,
): AgentLogBuffer {
  const discardThroughSeq = buffer?.discardThroughSeq ?? null;
  const bySeq = new Map<number, AgentLogEntry>();
  for (const item of buffer?.items ?? []) bySeq.set(item.seq, item);
  for (const item of entries) {
    if (discardThroughSeq !== null && item.seq <= discardThroughSeq) continue;
    if (!bySeq.has(item.seq)) bySeq.set(item.seq, item);
  }
  const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  const removed = ordered.length > limit ? ordered.splice(0, ordered.length - limit) : [];
  const nextDiscard = removed.length === 0
    ? discardThroughSeq
    : Math.max(discardThroughSeq ?? 0, removed.at(-1)!.seq);
  const seenSeqs = Object.fromEntries(ordered.map((item) => [item.seq, true])) as Record<number, true>;
  const next: AgentLogBuffer = {
    items: ordered,
    seenSeqs,
    firstSeq: ordered[0]?.seq ?? null,
    lastSeq: ordered.at(-1)?.seq ?? null,
    discardThroughSeq: nextDiscard,
    lastAccessedAt: now,
  };
  if (
    buffer &&
    removed.length === 0 &&
    entries.every((entry) => buffer.seenSeqs[entry.seq]) &&
    buffer.lastAccessedAt === now
  ) return buffer;
  return next;
}
