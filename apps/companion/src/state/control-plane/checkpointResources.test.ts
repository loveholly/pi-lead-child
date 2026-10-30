import {
  PROTOCOL_VERSION,
  type GatewayEvent,
  type KernelCheckpoint,
  type KernelIntervention,
  type KernelTicketTiming,
  type KernelTicketWorkbench,
  type KernelTicketWorkItem,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { selectCheckpointIdsNewestFirst } from '../selectors';
import { reduceGatewayEvent } from './eventReducer';
import { adaptGatewayEvent } from './protocolAdapter';
import { createControlPlaneStore } from './store';

const createdAt = '2026-07-24T04:00:00.000Z';

const timing: KernelTicketTiming = {
  firstStartedAt: createdAt,
  completedAt: null,
  statusChangedAt: createdAt,
  computedAt: '2026-07-24T04:06:12.000Z',
  elapsedMs: 372_000,
  activeExecutionMs: 350_000,
  statusDurationMs: 372_000,
};

function checkpoint(id: number, title = `Checkpoint ${id}`): KernelCheckpoint {
  return {
    id,
    ticketId: 42,
    attemptId: 73,
    author: { kind: 'executor', runtime: 'codex' },
    source: 'agent_reported',
    kind: 'progress',
    stage: 'implementation',
    title,
    summary: `${title} summary`,
    keyFacts: [],
    artifactRefs: [],
    relatedTicketIds: [],
    nextStep: 'continue',
    actionRef: null,
    createdAt,
  };
}

const workItem: KernelTicketWorkItem = {
  ticketId: 42,
  timing,
  activeExecution: {
    attemptId: 73,
    role: 'executor',
    runtime: 'codex',
    state: 'running',
    model: 'gpt-5.6-codex',
    externalSessionId: 'thread-73',
  },
  pendingInterventionCount: 1,
  latestCheckpointId: 13,
};

const approvalRef = {
  id: 'approval:18' as const,
  ticketId: 42,
  kind: 'approval' as const,
  state: 'pending' as const,
  requiresAction: true,
};

const approval: KernelIntervention = {
  id: 'approval:18',
  kind: 'approval',
  authorityId: 18,
  ticketId: 42,
  attemptId: 73,
  audience: 'user',
  state: 'pending',
  title: 'Need sudo',
  detail: 'Install launchd service',
  actions: ['approve', 'reject', 'approve_session'],
  resolution: null,
  createdAt,
  resolvedBy: null,
  resolvedAt: null,
};

const kernelTicket = {
  id: 42,
  title: 'Checkpoint resources',
  brief: 'Normalize additive resources',
  body: '',
  status: 'active' as const,
  priority: 'high' as const,
  project: 'pi-lead-child',
  projectId: 3,
  parentTicketId: null,
  rootTicketId: 42,
  createdByAttemptId: null,
  orchestrationState: 'waiting' as const,
  requestedRuntime: 'codex' as const,
  requestedModel: null,
  purpose: 'execution' as const,
  verificationPolicy: 'independent_reviewer' as const,
  acceptancePolicy: 'user_only' as const,
  reworkPolicy: 'ask_user' as const,
  deliveryPolicy: 'notify_only' as const,
  maxDepth: 3,
  maxChildren: 12,
  maxConcurrency: 2,
  tokenBudget: 120_000,
  costBudgetUsd: 20,
  retryLimit: 2,
  activePlanRevision: 1,
  workdir: '/tmp/pi-lead-child',
  createdBy: 'lead',
  createdAt,
  updatedAt: createdAt,
  lastActivityAt: createdAt,
  totalTokens: 3_200,
  totalCostUsd: 0.14,
  dueAt: null,
  remindAt: null,
};

const kernelAttempt = {
  id: 73,
  ticketId: 42,
  role: 'executor' as const,
  state: 'running' as const,
  runtime: 'codex' as const,
  purpose: 'execution' as const,
  model: 'gpt-5.6-codex',
  runtimeVersion: '0.144.6',
  externalSessionId: 'thread-73',
  sessionId: null,
  sessionPath: '/tmp/runtime-events/attempt-73.jsonl',
  pid: 1234,
  eventCursor: '2',
  lastEntryCursor: null,
  exitCode: null,
  errorCode: null,
  errorMessage: null,
  metadata: {},
  costKnown: true,
  eventLogDirty: false,
  startedAt: createdAt,
  endedAt: null,
};

const workbench: KernelTicketWorkbench = {
  ticket: kernelTicket,
  timing,
  activeAttempt: kernelAttempt,
  children: [{ ...kernelTicket, id: 43, parentTicketId: 42, rootTicketId: 42 }],
  latestCheckpoints: [checkpoint(12), checkpoint(13)],
  interventionRefs: [approvalRef],
};

function event(type: GatewayEvent['type'], payload: Record<string, unknown>): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${type}`,
    seq: 1,
    type,
    occurredAt: createdAt,
    requiredScope: type.startsWith('approval.') ? 'approvals:respond' : 'tickets:view',
    audienceBindingId: null,
    turnId: type.startsWith('lead.') ? 'turn-1' : null,
    ticketId: 42,
    payload,
  };
}

function validated(input: GatewayEvent) {
  const result = adaptGatewayEvent(input);
  if (!result.ok) throw new Error(result.error);
  return result.event;
}

describe('checkpoint control-plane resources', () => {
  it('stores checkpoint pages in ascending ID order and preserves unchanged references', () => {
    const store = createControlPlaneStore();
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(12), checkpoint(13)],
      hasMore: true,
      nextBeforeId: 12,
    }, 'replace');
    const firstState = store.getState();
    const firstIds = firstState.checkpointIdsByTicket[42];
    const firstEntity = firstState.checkpointsById[12];
    const listener = vi.fn();
    store.subscribe((state) => state.checkpointIdsByTicket[42], listener);

    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(12), checkpoint(13)],
      hasMore: true,
      nextBeforeId: 12,
    }, 'replace');

    expect(store.getState().checkpointIdsByTicket[42]).toBe(firstIds);
    expect(store.getState().checkpointsById[12]).toBe(firstEntity);
    expect(listener).not.toHaveBeenCalled();
    expect(selectCheckpointIdsNewestFirst(42)(store.getState())).toEqual([13, 12]);
    expect(store.getState().checkpointIdsByTicket[42]).toEqual([12, 13]);
  });

  it('removes server-deleted checkpoints when the first page is replaced', () => {
    const store = createControlPlaneStore();
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(12), checkpoint(13)],
      hasMore: false,
      nextBeforeId: null,
    }, 'replace');
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(13), checkpoint(14)],
      hasMore: false,
      nextBeforeId: null,
    }, 'replace');

    expect(store.getState().checkpointIdsByTicket[42]).toEqual([13, 14]);
    expect(store.getState().checkpointsById[12]).toBeUndefined();
    expect(store.getState().checkpointsById[13]).toBeDefined();
    expect(store.getState().checkpointsById[14]).toBeDefined();
  });

  it('merges older and incremental checkpoint pages without duplicates', () => {
    const store = createControlPlaneStore();
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(12), checkpoint(13)], hasMore: true, nextBeforeId: 12,
    }, 'replace');
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(10), checkpoint(11)], hasMore: false, nextBeforeId: 10,
    }, 'prepend');
    store.getState().mergeCheckpointPage(42, {
      items: [checkpoint(13), checkpoint(14)], hasMore: false, nextBeforeId: 13,
    }, 'append');

    expect(store.getState().checkpointIdsByTicket[42]).toEqual([10, 11, 12, 13, 14]);
    expect(store.getState().checkpointPagesByTicket[42]).toEqual({ hasMore: false, nextBeforeId: 10 });
  });

  it('normalizes work items, timing, workbench indexes, safe refs, and full interventions', () => {
    const store = createControlPlaneStore();
    store.getState().replaceWorkItems([workItem]);
    store.getState().replaceTicketWorkbench(workbench);
    store.getState().replaceInterventions([approval]);

    const state = store.getState();
    expect(state.workItemIds).toEqual([42]);
    expect(state.workItemsById[42]).toEqual({ ...workItem, progress: null });
    expect(state.ticketTimingIds).toEqual([42]);
    expect(state.ticketTimingsById[42]).toEqual(timing);
    expect(state.workbenchIds).toEqual([42]);
    expect(state.workbenchesById[42]).toEqual({
      ticketId: 42,
      activeAttemptId: 73,
      childTicketIds: [43],
      latestCheckpointIds: [12, 13],
      interventionIds: ['approval:18'],
      progress: null,
      pow: null,
      // v1 workbench 没有成果快照：索引照实记为 null，而不是猜一个。
      outcomeSnapshot: null,
      // 工单详情的「工单信息」读预算（工单 12）。
      budget: { tokenBudget: workbench.ticket.tokenBudget, costBudgetUsd: workbench.ticket.costBudgetUsd },
    });
    expect(state.interventionRefsById['approval:18']).toBe(approvalRef);
    expect(state.interventionIdsByTicket[42]).toEqual(['approval:18']);
    expect(state.interventionIds).toEqual(['approval:18']);
    expect(state.interventionsById['approval:18']).toBe(approval);
  });

  it('preserves v2 progress/proof and normalizes artifact metadata by ticket', () => {
    const store = createControlPlaneStore();
    store.getState().replaceWorkItems([{
      ...workItem,
      progress: {
        current: 2,
        total: 3,
        percent: 67,
        label: 'Protocol fidelity',
        source: 'explicit',
        checkpointId: 20,
      },
    }]);
    store.getState().mergeCheckpointPage(42, {
      items: [{
        ...checkpoint(20),
        progress: { current: 2, total: 3, label: 'Protocol fidelity' },
        proofItems: [{
          id: 'schema', label: 'Schema validation', state: 'passed', evidence: 'v2 snapshot',
        }],
      }],
      hasMore: false,
      nextBeforeId: null,
    }, 'replace');
    store.getState().replaceArtifacts(42, [{
      id: 9,
      ticketId: 42,
      attemptId: 73,
      checkpointId: 20,
      ref: 'report',
      name: 'report.md',
      kind: 'report',
      mediaType: 'text/markdown',
      description: 'Protocol report',
      availability: 'available',
      byteLength: 12,
      sha256: 'a'.repeat(64),
      createdAt,
    }]);

    expect(store.getState().workItemsById[42]?.progress).toMatchObject({ percent: 67, source: 'explicit' });
    expect(store.getState().checkpointsById[20]).toMatchObject({
      progress: { current: 2, total: 3 },
      proofItems: [{ id: 'schema', state: 'passed' }],
    });
    expect(store.getState().artifactIdsByTicket[42]).toEqual([9]);
    expect(store.getState().artifactsById[9]?.availability).toBe('available');
  });

  it('maps frozen v2 events to additive invalidations without inventing event types', () => {
    const reductions = [
      reduceGatewayEvent(validated(event('ticket.updated', { snapshotRequired: true }))),
      reduceGatewayEvent(validated(event('attempt.updated', {
        attemptId: 73, state: 'settled', snapshotRequired: true,
      }))),
      reduceGatewayEvent(validated(event('approval.resolved', {
        approvalId: 18, status: 'approved',
      }))),
      reduceGatewayEvent(validated(event('lead.tool.completed', {
        toolCallId: 'call-1', toolName: 'create_ticket', result: { message: 'created ticket #42' }, isError: false,
      }))),
    ];

    expect(reductions[0].invalidations).toEqual(expect.arrayContaining([
      'work-items', 'workbench:42', 'checkpoints:42', 'interventions:42',
      'conversation-cards', 'conversation-cards:ticket:42',
    ]));
    expect(reductions[1].invalidations).toEqual(expect.arrayContaining([
      'execution:42', 'work-items', 'workbench:42', 'checkpoints:42',
      'conversation-cards', 'conversation-cards:ticket:42',
    ]));
    expect(reductions[2].invalidations).toEqual(expect.arrayContaining([
      'approvals', 'interventions:42', 'checkpoints:42', 'workbench:42',
      'conversation-cards', 'conversation-cards:ticket:42',
    ]));
    expect(reductions[3].invalidations).toContain('conversation-cards');
  });
});
