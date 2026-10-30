// @ts-ignore Vitest executes source-boundary checks in Node.
import { readFileSync } from 'node:fs';
import type { ActivityDto, AttemptDto, KernelRuntimeEvent } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CredentialStore } from '@pi-lead-child/client';
import { createCompanionStateRuntime, type CompanionTransport } from '../runtime';
import type { StreamScheduler } from '../streams/batching';

function scheduler(): StreamScheduler & { runAll(): void } {
  const callbacks: (() => void)[] = [];
  return {
    schedule(callback) { callbacks.push(callback); return callback; },
    cancel(handle) {
      const index = callbacks.indexOf(handle as () => void);
      if (index >= 0) callbacks.splice(index, 1);
    },
    now: () => 1,
    runAll() {
      const pending = callbacks.splice(0);
      for (const callback of pending) callback();
    },
  };
}

function runtimeWith(client: Partial<CompanionTransport>) {
  const credentials: CredentialStore = {
    async load() { return null; },
    async save() {},
    async clear() {},
  };
  return createCompanionStateRuntime({
    client: client as CompanionTransport,
    credentials,
    scheduler: scheduler(),
  });
}

function activity(id: number): ActivityDto {
  return {
    id,
    ticketId: 42,
    attemptId: 9,
    actor: 'child',
    kind: 'tool',
    payload: { summary: 'running' },
    sessionCursor: null,
    createdAt: '2026-07-24T08:00:00.000Z',
  };
}

function attempt(): AttemptDto {
  return {
    id: 9,
    ticketId: 42,
    role: 'executor',
    state: 'running',
    model: 'gpt-5.6-sol',
    runtime: 'codex',
    purpose: 'execution',
    exitCode: null,
    errorCode: null,
    errorMessage: null,
    startedAt: '2026-07-24T08:00:00.000Z',
    endedAt: null,
  };
}

describe('ticket execution cache', () => {
  it('shares one in-flight activities/attempts load and reuses ready cache', async () => {
    let resolveActivities!: (value: ActivityDto[]) => void;
    let resolveAttempts!: (value: AttemptDto[]) => void;
    const getActivities = vi.fn(() => new Promise<ActivityDto[]>((resolve) => { resolveActivities = resolve; }));
    const getAttempts = vi.fn(() => new Promise<AttemptDto[]>((resolve) => { resolveAttempts = resolve; }));
    const runtime = runtimeWith({ getActivities, getAttempts });

    const first = runtime.ensureTicketExecution(42);
    const second = runtime.ensureTicketExecution(42);
    expect(second).toBe(first);
    expect(getActivities).toHaveBeenCalledTimes(1);
    expect(getAttempts).toHaveBeenCalledTimes(1);
    resolveActivities([activity(1)]);
    resolveAttempts([attempt()]);
    await first;

    expect(runtime.control.getState().activityIdsByTicket[42]).toEqual([1]);
    expect(runtime.control.getState().attemptIdsByTicket[42]).toEqual([9]);
    expect(runtime.control.getState().attemptsById[9]).toMatchObject({ runtime: 'codex', purpose: 'execution' });
    expect(runtime.control.getState().resourceState['execution:42']?.state).toBe('ready');
    await runtime.ensureTicketExecution(42);
    expect(getActivities).toHaveBeenCalledTimes(1);
  });

  it('keeps execution errors resource-local and retries on the next ensure', async () => {
    const getActivities = vi.fn()
      .mockRejectedValueOnce(new Error('activities unavailable'))
      .mockResolvedValueOnce([activity(1)]);
    const getAttempts = vi.fn(async () => [attempt()]);
    const runtime = runtimeWith({ getActivities, getAttempts });

    await expect(runtime.ensureTicketExecution(42)).rejects.toThrow('activities unavailable');
    expect(runtime.control.getState().resourceState['execution:42']).toMatchObject({
      state: 'error',
      error: 'activities unavailable',
    });
    await runtime.ensureTicketExecution(42);
    expect(runtime.control.getState().resourceState['execution:42']?.state).toBe('ready');
    expect(getActivities).toHaveBeenCalledTimes(2);
  });

  it('loads validated attempt events into the bounded stream projection', async () => {
    const events: KernelRuntimeEvent[] = [{
      type: 'runtime.stderr',
      attemptId: 9,
      seq: 2,
      occurredAt: '2026-07-24T08:00:02.000Z',
      text: 'second',
    }, {
      type: 'run.started',
      attemptId: 9,
      seq: 1,
      occurredAt: '2026-07-24T08:00:01.000Z',
      runtime: 'codex',
      model: 'gpt-5.6-sol',
    }];
    const runtime = runtimeWith({ getAttemptEvents: vi.fn(async () => events) });

    await runtime.ensureAttemptEvents(9);

    expect(runtime.streams.getState().logBuffersByAttemptId[9]?.items.map((item) => item.seq))
      .toEqual([1, 2]);
  });

  it('removes TicketThread local execution and demo fallback ownership', () => {
    const source = readFileSync(new URL('../../features/tickets/TicketThread.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain("import { timeline }");
    expect(source).not.toContain('useState<{ ticketId: string; steps: TimelineStep[] }');
    expect(source).not.toContain('useControlPlane');
  });
});
