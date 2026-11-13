import {
  PROTOCOL_VERSION,
  type BindingDto,
  type ChannelSourceSettingsDto,
  type GatewayEvent,
  type HelloV2,
  type KernelConversationCard,
  type KernelConversationCardListResponse,
  type KernelIntervention,
  type Overview,
  type TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ControlPlaneCredentials, CredentialStore } from '@pi-lead-child/client';
import { ControlPlaneClientError, type ConnectionHandlers } from '@pi-lead-child/client';
import {
  createCompanionStateRuntime,
  mountCompanionRuntime,
  type CompanionTransport,
} from './runtime';
import { leadNameNow } from './leadName';
import type { StreamScheduler } from './streams/batching';
import { RESOURCE_KEYS } from './types';

const binding: BindingDto = {
  id: 7,
  kind: 'companion',
  name: 'phone',
  scopes: ['chat', 'tickets:view', 'approvals:respond'],
};

const credentialsRecord: ControlPlaneCredentials = {
  baseUrl: 'http://daemon.test',
  accessToken: 'secret',
  binding,
  lastSeq: 0,
};

const overview: Overview = {
  model: 'gpt-5.6-sol',
  sessionId: 'session-1',
  busy: false,
  runningTicketIds: [],
  counts: {
    activeTickets: 1,
    reviewTickets: 0,
    blockedTickets: 0,
    pendingApprovals: 0,
    unreadNotices: 0,
  },
  aish: null,
};

const ticket: TicketSummary = {
  id: 42,
  title: 'State migration',
  summary: 'Move Companion state',
  kind: 'task',
  stage: 'active',
  status: 'active',
  hasRun: true,
  priority: 'high',
  project: 'pi-lead-child',
  dueAt: null,
  deferUntil: null,
  updatedAt: '2026-07-24T08:00:00.000Z',
  runtime: { state: 'running', lastActivityAt: '2026-07-24T08:00:00.000Z', activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
};

const pendingIntervention = {
  id: 'approval:9',
  kind: 'approval',
  authorityId: 9,
  ticketId: 42,
  attemptId: 73,
  audience: 'user',
  state: 'pending',
  title: '需要 sudo',
  detail: '安装 launchd 服务',
  actions: ['approve', 'reject', 'approve_session'],
  resolution: null,
  createdAt: '2026-07-24T08:00:00.000Z',
  resolvedBy: null,
  resolvedAt: null,
} satisfies KernelIntervention;

const approvedIntervention = {
  ...pendingIntervention,
  state: 'approved',
  actions: [],
  resolution: { decision: 'approve', sessionExempt: false },
  resolvedBy: 'user via paired binding:7',
  resolvedAt: '2026-07-24T08:07:00.000Z',
} satisfies KernelIntervention;

function durableConversationCard(
  state: 'running' | 'completed',
  updatedAt: string,
): KernelConversationCard {
  return {
    id: 9,
    key: 'turn:turn-1:ticket:42',
    kind: 'ticket_execution',
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
    createdAt: '2026-07-24T08:00:00.000Z',
    updatedAt,
  };
}

function conversationCardPage(items: KernelConversationCard[]): KernelConversationCardListResponse {
  return {
    items,
    checkpoints: [],
    interventionRefs: [],
    hasMore: false,
    nextBeforeId: null,
  };
}

function emptyConversationCardPage(): KernelConversationCardListResponse {
  return conversationCardPage([]);
}

function scheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const value: StreamScheduler & { runAll(): void } = {
    schedule(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(handle) { callbacks.delete(handle as number); },
    now: () => 0,
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Timers fire only when the test moves virtual time forward, in due order.
function clockScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const value: StreamScheduler & { advance(ms: number): void } = {
    schedule(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { due: now + delayMs, callback });
      return id;
    },
    cancel(handle) { timers.delete(handle as number); },
    now: () => now,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= until)
          .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].due;
        due[1].callback();
      }
      now = until;
    },
  };
  return value;
}

function settleRequests(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function connectAtLatestSeq(
  latestSeq: number,
  capture: (handlers: ConnectionHandlers) => void,
): CompanionTransport['connect'] {
  return vi.fn(async (handlers = {}) => {
    capture(handlers);
    handlers.onHello?.({
      type: 'hello.v2',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2026-07-24T08:00:00.000Z',
      timezone: 'Asia/Shanghai',
      latestSeq,
      capabilities: [],
      binding,
      daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
    });
    handlers.onStateChange?.('connected');
  });
}

function connectWithCapabilities(capabilities: HelloV2['capabilities']): CompanionTransport['connect'] {
  return vi.fn(async (handlers = {}) => {
    handlers.onHello?.({
      type: 'hello.v2',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2026-07-24T08:00:00.000Z',
      timezone: 'Asia/Shanghai',
      latestSeq: 0,
      capabilities,
      binding,
      daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
    });
    handlers.onStateChange?.('connected');
  });
}

function credentialStore(record: ControlPlaneCredentials | null = credentialsRecord): CredentialStore & {
  load: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(async () => record),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

function transport(overrides: Partial<CompanionTransport> = {}) {
  let handlers: ConnectionHandlers = {};
  const client: CompanionTransport & { emit(event: GatewayEvent): void } = {
    pair: vi.fn(async () => credentialsRecord),
    setPresence: vi.fn(),
    pairLoopback: vi.fn(async () => credentialsRecord),
    pairSocket: vi.fn(async () => credentialsRecord),
    forget: vi.fn(async () => {}),
    getOverview: vi.fn(async () => overview),
    getTickets: vi.fn(async () => [ticket]),
    getTicket: vi.fn(async () => ({
      ticket,
      brief: 'Move Companion state',
      body: '',
      workdir: null,
      createdAt: '2026-07-24T07:00:00.000Z',
      totalTokens: 0,
      totalCostUsd: 0,
      remindAt: null,
      createdBy: 'system' as const,
      relations: [],
    })),
    getProjects: vi.fn(async () => []),
    getAgenda: vi.fn(async () => []),
    getApprovals: vi.fn(async () => []),
    getNotifications: vi.fn(async () => []),
    getInbox: vi.fn(async () => ({ tickets: [], leadHandled: [], seenAt: null })),
    markInboxSeen: vi.fn(async () => '2026-10-15T08:00:00.000Z'),
    getProjectsOverview: vi.fn(async () => []),
    setProjectArchived: vi.fn(async () => undefined),
    getTimeline: vi.fn(async () => ({ entries: [], overdue: [], generatedAt: '2026-10-15T08:00:00.000Z', leadNote: null })),
    updateMilestone: vi.fn(async (milestoneId: number) => ({
      id: milestoneId, ticketId: 1, kind: 'due' as const, label: '截止', at: '2026-10-16T10:00:00.000Z', allDay: false, state: 'planned' as const,
    })),
    getConversationTurns: vi.fn(async () => [{
      id: 'turn-1',
      originBindingId: 7,
      originKind: 'companion',
      ticketId: 42,
      state: 'completed' as const,
      userText: 'Start',
      assistantText: 'Ready',
      error: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      updatedAt: '2026-07-24T08:01:00.000Z',
    }]),
    connect: vi.fn(async (nextHandlers = {}) => {
      handlers = nextHandlers;
      handlers.onHello?.({
        type: 'hello.v2',
        protocolVersion: PROTOCOL_VERSION,
        serverTime: '2026-07-24T08:00:00.000Z',
        timezone: 'Asia/Shanghai',
        latestSeq: 0,
        capabilities: [],
        binding,
        daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
      });
      handlers.onStateChange?.('connected');
    }),
    disconnect: vi.fn(),
    sendChat: vi.fn(async () => ({ turnId: 'turn-2' })),
    sendChatCommand: vi.fn(async () => ({ turnId: 'turn-2' })),
    resolveApproval: vi.fn(async () => ({})),
    ackNotification: vi.fn(async () => ({
      id: 1,
      ticketId: null,
      kind: 'test',
      dedupKey: null,
      urgency: 'immediate' as const,
      title: 'test',
      body: '',
      state: 'acked' as const,
      createdAt: '2026-07-24T08:00:00.000Z',
      deliveredAt: null,
      deliveredVia: null,
      ackedAt: '2026-07-24T08:01:00.000Z',
    })),
    setLeadDelegation: vi.fn(async () => ({})),
    getActivities: vi.fn(async () => []),
    getAttempts: vi.fn(async () => []),
    getAttemptEvents: vi.fn(async () => []),
    getKernelCheckpoints: vi.fn(async () => ({ items: [], hasMore: false, nextBeforeId: null })),
    getKernelWorkItems: vi.fn(async () => ({ items: [] })),
    getKernelTicketWorkbench: vi.fn(async () => { throw new Error('not configured'); }),
    getKernelInterventions: vi.fn(async () => ({ items: [] })),
    resolveKernelIntervention: vi.fn(async (interventionId: string) => ({ status: 'resolved', interventionId })),
    getKernelConversationCards: vi.fn(async () => ({
      items: [], checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null,
    })),
    getKernelArtifacts: vi.fn(async () => ({ items: [] })),
    performTicketAction: vi.fn(async (
      ticketId: number,
      action: import('@pi-lead-child/protocol').UserItemActionId,
    ) => ({ ticketId, action, ticket: null })),
    requestTicketReview: vi.fn(async (ticketId: number) => ({
      ticketId, dispatchRequestId: 9, deliveryRunId: 49, ticket: null,
    })),
    performWorkspaceAction: vi.fn(async (
      workspaceId: number,
      action: import('@pi-lead-child/protocol').WorkspaceControlActionId,
    ) => ({ workspaceId, ownerTicketId: 42, action, status: action === 'release' ? 'released' as const : 'cleaned' as const, ticket: null })),
    linkTicketRelation: vi.fn(async (
      sourceTicketId: number,
      input: import('@pi-lead-child/client').LinkTicketRelationInput,
    ) => ({
      status: 'created' as const,
      relationId: 1,
      sourceTicketId,
      targetTicketId: input.targetTicketId,
      relationType: input.relationType,
      requestedRelationType: input.relationType,
      active: true,
      risks: [],
      schedulingImpact: null,
      canonicalImpact: null,
    })),
    revokeTicketRelation: vi.fn(async (
      ticketId: number,
      relationId: number,
      _input: import('@pi-lead-child/client').RevokeTicketRelationInput,
    ) => ({
      status: 'revoked' as const,
      relationId,
      sourceTicketId: ticketId,
      targetTicketId: ticketId + 1,
      relationType: 'relates_to' as const,
      active: false,
      risks: [],
      schedulingImpact: null,
      canonicalImpact: null,
    })),
    downloadArtifact: vi.fn(async () => ({
      bytes: new ArrayBuffer(0), filename: 'artifact.bin', mediaType: 'application/octet-stream',
      byteLength: 0, sha256: '0'.repeat(64),
    })),
    emit(event) { handlers.onEvent?.(event); },
    ...overrides,
  };
  return client;
}

function gatewayEvent(
  seq: number,
  type: GatewayEvent['type'],
  payload: Record<string, unknown>,
): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${seq}`,
    seq,
    type,
    occurredAt: `2026-07-24T08:00:0${seq}.000Z`,
    requiredScope: 'chat',
    audienceBindingId: 7,
    turnId: 'turn-live',
    ticketId: 42,
    payload,
  };
}

describe('CompanionStateRuntime', () => {
  it('constructs three stores without reading credentials, timers, or transport', () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    expect(runtime.control).not.toBe(runtime.streams);
    expect(runtime.streams).not.toBe(runtime.workspace);
    expect(credentials.load).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(runtime.workspace.getState().hydrated).toBe(false);
  });

  it('hydrates every authorized core resource before opening one socket', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start();

    expect(client.getOverview).toHaveBeenCalledTimes(1);
    expect(client.getTickets).toHaveBeenCalledTimes(1);
    expect(client.getProjects).toHaveBeenCalledTimes(1);
    expect(client.getAgenda).toHaveBeenCalledTimes(1);
    expect(client.getApprovals).toHaveBeenCalledTimes(1);
    expect(client.getConversationTurns).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(runtime.control.getState()).toMatchObject({
      phase: 'ready',
      connectionState: 'connected',
      overview,
      ticketIds: [42],
      sessionIds: ['session-1'],
    });
  });

  it('hydrates notification outbox entries and refreshes them after ack', async () => {
    const notification = {
      id: 5,
      ticketId: 42,
      kind: 'automation_blocked',
      dedupKey: 'automation-blocked:test',
      urgency: 'immediate' as const,
      title: 'automation blocked',
      body: 'needs user attention',
      state: 'pending' as const,
      createdAt: '2026-08-14T01:00:00.000Z',
      deliveredAt: null,
      deliveredVia: null,
      ackedAt: null,
    };
    const record = {
      ...credentialsRecord,
      binding: { ...binding, scopes: [...binding.scopes, 'notices' as const] },
    };
    const credentials = credentialStore(record);
    const getNotifications = vi.fn()
      .mockResolvedValueOnce([notification])
      .mockResolvedValueOnce([]);
    const ackNotification = vi.fn(async () => ({
      ...notification,
      state: 'acked' as const,
      ackedAt: '2026-08-14T01:01:00.000Z',
    }));
    const client = transport({ getNotifications, ackNotification });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start();
    expect(runtime.control.getState().notificationIds).toEqual([5]);
    expect(getNotifications).toHaveBeenCalledWith(['pending', 'delivered'], expect.any(AbortSignal));

    await runtime.ackNotification(5);
    expect(ackNotification).toHaveBeenCalledWith(5);
    expect(getNotifications).toHaveBeenCalledTimes(2);
    expect(runtime.control.getState().notificationIds).toEqual([]);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
  });

  // 用户按下「确认开跑」到看见新状态，不该依赖一条可能正在重连的 socket。
  // ticket.updated 事件通路会再失效一次，那是幂等的补充，不是唯一依靠。
  it('refetches the authoritative snapshot after a user control-plane action', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();
    expect(client.getTickets).toHaveBeenCalledTimes(1);

    await runtime.performTicketAction(18, 'confirm');

    expect(client.performTicketAction).toHaveBeenCalledWith(18, 'confirm', {});
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
  });

  it('sends a stranded delivery to review and refetches the authoritative snapshot', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.requestTicketReview(66);

    expect(client.requestTicketReview).toHaveBeenCalledWith(66);
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
  });

  // 2026-10-20：用户选核查员。runtime 原样交给 POST /v1/tickets/:id/request-review；核查员信息走单独的只读接口。
  it('passes the chosen reviewer through, and reads the reviewer from its own endpoint', async () => {
    const credentials = credentialStore();
    const reviewer = {
      reviewer: { runtime: 'claude' as const, displayName: 'Claude Code' },
      options: [{ runtime: 'claude' as const, displayName: 'Claude Code', available: true }],
      canChange: true, progress: 'suspended' as const,
    };
    const client = { ...transport(), getTicketReviewer: vi.fn(async () => reviewer) };
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.requestTicketReview(66, { runtime: 'claude' });
    expect(client.requestTicketReview).toHaveBeenCalledWith(66, { runtime: 'claude' });
    expect(await runtime.getTicketReviewer(66)).toEqual(reviewer);
    expect(client.getTicketReviewer).toHaveBeenCalledWith(66, undefined);
  });

  // 2026-11-03：工单详情把交付写成「第 N 次交付」，序号来自交付列表（设计规范 P14.6）。旧 daemon 没有这个接口时报错，界面写「最新的交付」。
  it('reads the delivery sequence numbers from their own endpoint', async () => {
    const credentials = credentialStore();
    const deliveries = [{
      sequence: 1, attemptId: 49, revisions: 1, reason: 'delivered' as const, source: 'git' as const, backfilled: false,
      head: null, commitCount: 1, totals: null, deliveredAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T08:00:00.000Z',
    }];
    const client = { ...transport(), getTicketDeliveries: vi.fn(async () => deliveries) };
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    expect(await runtime.getTicketDeliveries(66)).toEqual(deliveries);
    expect(client.getTicketDeliveries).toHaveBeenCalledWith(66, {});
    const old = createCompanionStateRuntime({ client: transport(), credentials, scheduler: scheduler() });
    await expect(old.getTicketDeliveries(66)).rejects.toThrow('cannot read the ticket deliveries');
  });

  it('uses the workspace action transport and refetches authoritative snapshots', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.performWorkspaceAction(7, 'release');

    expect(client.performWorkspaceAction).toHaveBeenCalledWith(7, 'release', {});
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
    expect(client.getTicket).toHaveBeenCalledWith(42, expect.any(AbortSignal));
  });

  it('refreshes ticket snapshots after Lead delegation changes', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.setLeadDelegation(42, true, { maxReworkCycles: 1 });

    expect(client.setLeadDelegation).toHaveBeenCalledWith(42, true, { maxReworkCycles: 1 });
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
    expect(client.getTicket).toHaveBeenCalledWith(42, expect.any(AbortSignal));
  });

  it('passes a restore plan through the runtime and then refreshes snapshots', async () => {
    const credentials = credentialStore();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.performTicketAction(18, 'restore', {
      restoreMode: 'selected_children',
      childTicketIds: [19, 20],
    });

    expect(client.performTicketAction).toHaveBeenCalledWith(18, 'restore', {
      restoreMode: 'selected_children',
      childTicketIds: [19, 20],
    });
    expect(client.getTickets).toHaveBeenCalledTimes(2);
  });

  it('refreshes both ticket snapshots after relation mutations', async () => {
    const credentials = credentialStore();
    const client = transport({
      linkTicketRelation: vi.fn(async () => ({
        status: 'created' as const,
        relationId: 12,
        sourceTicketId: 18,
        targetTicketId: 42,
        relationType: 'depends_on' as const,
        requestedRelationType: 'depends_on' as const,
        active: true,
        risks: ['scheduling: #18 cannot be dispatched until #42 is done or this relation is revoked'],
        schedulingImpact: '#18 blocked until #42 is done',
        canonicalImpact: null,
      })),
      revokeTicketRelation: vi.fn(async () => ({
        status: 'revoked' as const,
        relationId: 12,
        sourceTicketId: 18,
        targetTicketId: 42,
        relationType: 'depends_on' as const,
        active: false,
        risks: [],
        schedulingImpact: null,
        canonicalImpact: null,
      })),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.linkTicketRelation(18, {
      targetTicketId: 42,
      relationType: 'depends_on',
      reason: 'wait for blocker',
    });
    await runtime.revokeTicketRelation(18, 12, { reason: 'blocker cleared manually' });

    expect(client.linkTicketRelation).toHaveBeenCalledWith(18, {
      targetTicketId: 42,
      relationType: 'depends_on',
      reason: 'wait for blocker',
    });
    expect(client.revokeTicketRelation).toHaveBeenCalledWith(18, 12, { reason: 'blocker cleared manually' });
    expect(client.getTicket).toHaveBeenCalledWith(18, expect.anything());
    expect(client.getTicket).toHaveBeenCalledWith(42, expect.anything());
  });

  it('applies the action response before relying on the follow-up ticket refresh', async () => {
    const credentials = credentialStore();
    const updatedTicket = { ...ticket, stage: 'draft' as const, status: 'draft' as const };
    const client = transport({
      performTicketAction: vi.fn(async () => ({
        ticketId: updatedTicket.id,
        action: 'restore' as const,
        ticket: updatedTicket,
      })),
      getTickets: vi.fn()
        .mockResolvedValueOnce([ticket])
        .mockRejectedValueOnce(new Error('refresh raced with reconnect')),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await runtime.performTicketAction(updatedTicket.id, 'restore', { restoreMode: 'root_only' });

    expect(runtime.control.getState().ticketsById[updatedTicket.id]?.stage).toBe('draft');
  });

  it('propagates a refused action instead of silently pretending it applied', async () => {
    const credentials = credentialStore();
    const client = transport({
      performTicketAction: vi.fn(async () => { throw new Error('illegal transition draft -> active'); }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });
    await runtime.start();

    await expect(runtime.performTicketAction(18, 'start'))
      .rejects.toThrow(/illegal transition/);
    // 失败的动作不该顺手重取快照：状态没变，重取只会把一次失败伪装成一次刷新。
    expect(client.getTickets).toHaveBeenCalledTimes(1);
  });

  it('retains successful snapshots but does not open the first socket when a required resource fails', async () => {
    const credentials = credentialStore();
    const client = transport({ getTickets: vi.fn(async () => { throw new Error('tickets unavailable'); }) });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start();

    expect(runtime.control.getState().overview).toEqual(overview);
    expect(runtime.control.getState()).toMatchObject({ phase: 'error', error: 'tickets unavailable' });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('recovers stale credentials once when the stored binding targets the same loopback endpoint', async () => {
    const staleCredentials = {
      ...credentialsRecord,
      baseUrl: 'http://127.0.0.1:47140',
      accessToken: 'stale-secret',
    };
    const freshCredentials = {
      ...staleCredentials,
      accessToken: 'fresh-secret',
    };
    const credentials = credentialStore(staleCredentials);
    const getOverview = vi.fn()
      .mockRejectedValueOnce(new ControlPlaneClientError('device is not paired', 'not_paired', 401))
      .mockResolvedValueOnce(overview);
    const client = transport({
      getOverview,
      pairLoopback: vi.fn(async () => freshCredentials),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start({ loopbackEndpoint: 'http://localhost:47140/' });

    expect(client.forget).toHaveBeenCalledTimes(1);
    expect(client.pairLoopback).toHaveBeenCalledTimes(1);
    expect(client.pairLoopback).toHaveBeenCalledWith(
      'http://localhost:47140/',
      'localhost-web',
      expect.any(AbortSignal),
    );
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(runtime.control.getState()).toMatchObject({ phase: 'ready', error: null });
  });

  it('retains the first auto-pair rejection for the pairing screen instead of hiding it', async () => {
    const client = transport({
      pairLoopback: vi.fn(async () => { throw new ControlPlaneClientError('loopback auto-pair is not allowed for this request', 'forbidden', 403); }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(null), scheduler: scheduler() });
    await runtime.start({ loopbackEndpoint: 'http://127.0.0.1:47140' });
    expect(runtime.control.getState()).toMatchObject({
      phase: 'unpaired', connectionState: 'disconnected', error: 'loopback auto-pair is not allowed for this request',
    });
    expect(client.connect).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('reports a failed local retry and does not hide failed hydration behind successful credential exchange', async () => {
    const client = transport({ getTickets: vi.fn(async () => { throw new Error('tickets unavailable'); }) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await expect(runtime.pairLoopback('http://127.0.0.1:47140')).rejects.toThrow('tickets unavailable');
    expect(runtime.control.getState()).toMatchObject({ phase: 'error', error: 'tickets unavailable' });
    expect(client.connect).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('replaces credentials for an old loopback daemon before loading snapshots', async () => {
    const staleCredentials = {
      ...credentialsRecord,
      baseUrl: 'http://127.0.0.1:47130',
      accessToken: 'stale-secret',
    };
    const freshCredentials = {
      ...staleCredentials,
      baseUrl: 'http://localhost:47140',
      accessToken: 'fresh-secret',
    };
    const credentials = credentialStore(staleCredentials);
    const client = transport({
      pairLoopback: vi.fn(async () => freshCredentials),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start({ loopbackEndpoint: 'http://localhost:47140/' });

    // The successful pairing overwrites the stored record, so nothing is forgotten first.
    expect(client.forget).not.toHaveBeenCalled();
    expect(client.pairLoopback).toHaveBeenCalledWith(
      'http://localhost:47140/',
      'localhost-web',
      expect.any(AbortSignal),
    );
    expect(client.getOverview).toHaveBeenCalledTimes(1);
    expect(client.getTickets).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(runtime.control.getState()).toMatchObject({ phase: 'ready', error: null, endpointMismatch: null });
  });

  it('keeps working loopback credentials when the configured loopback endpoint refuses pairing', async () => {
    const workingCredentials = {
      ...credentialsRecord,
      baseUrl: 'http://127.0.0.1:47130',
      accessToken: 'working-secret',
    };
    const credentials = credentialStore(workingCredentials);
    const client = transport({
      pairLoopback: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start({ loopbackEndpoint: 'http://127.0.0.1:47142' });

    expect(client.pairLoopback).toHaveBeenCalledTimes(1);
    expect(client.forget).not.toHaveBeenCalled();
    expect(client.getTickets).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(runtime.control.getState()).toMatchObject({
      phase: 'ready',
      connectionState: 'connected',
      error: null,
      endpointMismatch: {
        configuredEndpoint: 'http://127.0.0.1:47142',
        activeEndpoint: 'http://127.0.0.1:47130',
        error: 'Failed to fetch',
      },
    });
    expect(runtime.control.getState().ticketIds).toEqual([42]);
  });

  it('does not clear loopback credentials for a temporary network failure', async () => {
    const credentials = credentialStore({ ...credentialsRecord, baseUrl: 'http://127.0.0.1:47140' });
    const client = transport({
      getOverview: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start({ loopbackEndpoint: 'http://127.0.0.1:47140' });

    expect(client.forget).not.toHaveBeenCalled();
    expect(client.pairLoopback).not.toHaveBeenCalled();
    expect(runtime.control.getState()).toMatchObject({ phase: 'error', error: 'Failed to fetch' });
  });

  it('does not replace remote credentials after an authentication failure', async () => {
    const credentials = credentialStore({ ...credentialsRecord, baseUrl: 'https://lead.example.test' });
    const client = transport({
      getOverview: vi.fn(async () => {
        throw new ControlPlaneClientError('device is not paired', 'not_paired', 401);
      }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    await runtime.start({ loopbackEndpoint: 'http://127.0.0.1:47140' });

    expect(client.forget).not.toHaveBeenCalled();
    expect(client.pairLoopback).not.toHaveBeenCalled();
    expect(runtime.control.getState()).toMatchObject({ phase: 'error', error: 'device is not paired' });
  });

  it('does not commit an HTTP snapshot after a newer resource generation invalidates it', async () => {
    const stale = deferred<TicketSummary[]>();
    const current = deferred<TicketSummary[]>();
    const getTickets = vi.fn()
      .mockResolvedValueOnce([ticket])
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);
    const client = transport({ getTickets });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    const staleLoad = runtime.ensureResource('tickets', true);
    await vi.waitFor(() => expect(getTickets).toHaveBeenCalledTimes(2));
    const currentLoad = runtime.ensureResource('tickets', true);
    stale.resolve([{ ...ticket, title: 'stale snapshot' }]);
    await staleLoad;
    await vi.waitFor(() => expect(getTickets).toHaveBeenCalledTimes(3));

    expect(runtime.control.getState().ticketsById[42]?.title).toBe(ticket.title);
    current.resolve([{ ...ticket, title: 'authoritative snapshot' }]);
    await currentLoad;

    expect(runtime.control.getState().ticketsById[42]?.title).toBe('authoritative snapshot');
    expect(runtime.control.getState().resourceState.tickets).toMatchObject({
      state: 'ready',
      generation: 2,
    });
  });

  it('serializes event reductions and advances seq only after canonical completion', async () => {
    const clock = scheduler();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
    await runtime.start();

    client.emit(gatewayEvent(1, 'lead.message.delta', { messageId: 'message-live', delta: 'partial' }));
    client.emit(gatewayEvent(2, 'lead.message.completed', { messageId: 'message-live', text: 'complete' }));
    await runtime.whenIdle();
    clock.runAll();

    const state = runtime.control.getState();
    const assistantId = state.assistantMessageIdByTurnId['turn-live'];
    const textPartId = state.partIdsByMessage[assistantId]?.[0];
    expect(state.messagePartsById[textPartId]).toMatchObject({ kind: 'text', text: 'complete' });
    expect(runtime.streams.getState().textByMessageId[assistantId]).toBeUndefined();
    expect(state.lastAppliedGatewaySeq).toBe(2);
  });

  // 2026-10-15 部署前的预览发现：Lead 还在流的时候，会话快照刷新了一次（别的轮次结束、工单变化都会触发）。
  // 快照里这一轮已经有落库的文字和「生成中」的卡片。刷新以后，文字要只显示一遍，卡片还要继续跟着流式更新。
  it('keeps a streaming reply readable across a snapshot refresh', async () => {
    const clock = scheduler();
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
    await runtime.start();
    const node = (id: string, children?: string[]) => children
      ? { id, type: 'Stack' as const, props: {}, children }
      : { id, type: 'Text' as const, props: { text: id } };
    const surface = (ids: string[]) => ({
      id: 's_c1', catalogVersion: 1, root: 'card', fallbackText: '正在生成卡片…',
      nodes: [node('card', ids), ...ids.map((id) => node(id))],
    });

    client.emit(gatewayEvent(1, 'lead.turn.started', { messageId: 'message-live', commandId: null, originKind: 'companion', mode: 'started' }));
    client.emit(gatewayEvent(2, 'lead.message.delta', { messageId: 'message-live', delta: '#2 也需要你看一下。' }));
    client.emit(gatewayEvent(3, 'lead.tool.updated', { toolCallId: 'c1', toolName: 'render_ui', textOffset: 11, partial: true, surface: surface([]) }));
    await runtime.whenIdle();
    clock.runAll();
    // 这一轮不是这台设备发的，这里没有那句提问：开始时先取一次（这个 transport 不能按轮次取，取最近一段）。
    await vi.waitFor(() => expect(client.getConversationTurns).toHaveBeenCalledTimes(2));
    await runtime.whenIdle();

    vi.mocked(client.getConversationTurns).mockResolvedValue([{
      id: 'turn-live', originBindingId: 7, originKind: 'companion', ticketId: 42, state: 'streaming',
      userText: '#2 怎么样了', assistantText: '#2 也需要你看一下。', error: null,
      createdAt: '2026-07-24T08:00:01.000Z', updatedAt: '2026-07-24T08:00:03.000Z',
      toolCalls: [], surfaces: [{ callId: 'c1', textOffset: 11, partial: true, surface: surface(['a']) }],
    }]);
    client.emit({ ...gatewayEvent(4, 'lead.message.completed', { messageId: 'message-old', text: '旧的一轮' }), turnId: 'turn-old' });
    await runtime.whenIdle();
    clock.runAll();
    await vi.waitFor(() => expect(client.getConversationTurns).toHaveBeenCalledTimes(3));
    await runtime.whenIdle();

    const visible = () => {
      const state = runtime.control.getState();
      const assistantId = state.assistantMessageIdByTurnId['turn-live']!;
      const textPart = state.messagePartsById[`${assistantId}:text`];
      return `${textPart?.kind === 'text' ? textPart.text : ''}${runtime.streams.getState().textByMessageId[assistantId] ?? ''}`;
    };
    expect(visible()).toBe('#2 也需要你看一下。');

    client.emit(gatewayEvent(5, 'lead.message.delta', { messageId: 'message-live', delta: '还有一句。' }));
    client.emit(gatewayEvent(6, 'lead.tool.updated', { toolCallId: 'c1', toolName: 'render_ui', textOffset: 11, partial: true, surface: surface(['a', 'b']) }));
    await runtime.whenIdle();
    clock.runAll();
    expect(visible()).toBe('#2 也需要你看一下。还有一句。');
    const part = runtime.control.getState().messagePartsById['turn-live:surface:c1'];
    expect(part).toMatchObject({ kind: 'surface', partial: true });
    expect(part?.kind === 'surface' ? part.surface.nodes.map((value) => value.id) : []).toEqual(['card', 'a', 'b']);
  });

  it('prevents an old hydration completion from writing after disposal', async () => {
    let resolveTickets!: (tickets: TicketSummary[]) => void;
    const pendingTickets = new Promise<TicketSummary[]>((resolve) => { resolveTickets = resolve; });
    const client = transport({ getTickets: vi.fn(() => pendingTickets) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });

    const starting = runtime.start();
    runtime.stop();
    resolveTickets([ticket]);
    await starting;

    expect(runtime.control.getState().ticketIds).toEqual([]);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not let an old chat command repopulate state after forget', async () => {
    let resolveCommand!: (value: { turnId: string }) => void;
    const command = new Promise<{ turnId: string }>((resolve) => { resolveCommand = resolve; });
    const client = transport({ sendChatCommand: vi.fn(() => command) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    const sending = runtime.sendChat('stale command');
    await runtime.forget();
    resolveCommand({ turnId: 'turn-after-forget' });
    await sending;

    expect(runtime.control.getState().messageIdsBySession).toEqual({});
    expect(runtime.control.getState().turnsById).toEqual({});
  });

  it('does not merge older checkpoint or card pages after forget advances the lifecycle', async () => {
    const checkpoints = deferred<{ items: []; hasMore: false; nextBeforeId: null }>();
    const cards = deferred<{
      items: [];
      checkpoints: [];
      interventionRefs: [];
      hasMore: false;
      nextBeforeId: null;
    }>();
    const client = transport({
      connect: connectWithCapabilities([
        'kernel.checkpoints.v1',
        'kernel.conversation-cards.v1',
      ]),
      getKernelCheckpoints: vi.fn(() => checkpoints.promise),
      getKernelConversationCards: vi.fn(() => cards.promise),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.setState({
      checkpointPagesByTicket: { 42: { hasMore: true, nextBeforeId: 50 } },
      conversationCardPagesByResource: {
        'conversation-cards': { hasMore: true, nextBeforeId: 100 },
      },
    });

    const olderCheckpoints = runtime.loadOlderCheckpoints(42);
    const olderCards = runtime.loadOlderConversationCards();
    await vi.waitFor(() => expect(client.getKernelCheckpoints).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.getKernelConversationCards).toHaveBeenCalledTimes(1));
    await runtime.forget();
    checkpoints.resolve({ items: [], hasMore: false, nextBeforeId: null });
    cards.resolve({
      items: [], checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null,
    });
    await Promise.all([olderCheckpoints, olderCards]);

    expect(runtime.control.getState().checkpointPagesByTicket).toEqual({});
    expect(runtime.control.getState().conversationCardPagesByResource).toEqual({});
  });

  it('refetches the current agenda scope once for a burst of ticket invalidations', async () => {
    const clock = scheduler();
    const getAgenda = vi.fn(async () => []);
    const client = transport({ getAgenda });
    const runtime = createCompanionStateRuntime({
      client,
      credentials: credentialStore(),
      scheduler: clock,
      now: () => new Date('2026-07-24T08:00:00.000Z'),
      timezone: () => 'Asia/Shanghai',
    });
    await runtime.start();
    expect(getAgenda).toHaveBeenCalledTimes(1);
    const initialScope = getAgenda.mock.calls[0]?.slice(0, 3);

    client.emit(gatewayEvent(1, 'ticket.updated', { snapshotRequired: true }));
    client.emit(gatewayEvent(2, 'ticket.updated', { snapshotRequired: true }));
    await runtime.whenIdle();
    clock.runAll();
    await vi.waitFor(() => expect(getAgenda).toHaveBeenCalledTimes(2));

    expect(getAgenda.mock.calls[1]?.slice(0, 3)).toEqual(initialScope);
  });

  // 会话里的提醒卡读它自己的 TicketDetail（ticket:<id>）。Lead 取消或改期提醒时，daemon 推的 ticket.updated
  // 不带编号；提醒到点时只多一条通知。正在被看的提醒要跟着刷新，不能一直显示「已排期」（2026-10-16 决定 D4）。
  it('refetches an observed reminder detail when a ticket event names no ticket', async () => {
    const clock = scheduler();
    const reminder = { ...ticket, id: 83, kind: 'reminder' as const, stage: 'scheduled' as const, status: 'scheduled' as const };
    const getTicket = vi.fn(async () => ({
      ticket: reminder, brief: '', body: '', workdir: null, createdAt: '2026-07-24T07:00:00.000Z',
      totalTokens: 0, totalCostUsd: 0, remindAt: '2026-07-27T01:00:00.000Z',
    }));
    const client = transport({ getTicket });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
    await runtime.start();
    const release = runtime.observeResource('ticket:83');
    await vi.waitFor(() => expect(getTicket).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runtime.control.getState().ticketDetailsById[83]).toBeDefined());

    client.emit({ ...gatewayEvent(1, 'ticket.updated', { snapshotRequired: true }), ticketId: null });
    await runtime.whenIdle();
    clock.runAll();
    await vi.waitFor(() => expect(getTicket).toHaveBeenCalledTimes(2));
    release();
  });

  // 审查发现（3688968）：别的工单的事件也让每一张挂着的提醒卡重取；没人看的提醒一直是旧的；已结束的提醒也重取。
  describe('reminder details after ticket events', () => {
    function reminderDetail(id: number, stage: 'scheduled' | 'fired' | 'acked' | 'cancelled') {
      return {
        ticket: { ...ticket, id, kind: 'reminder' as const, stage, status: stage },
        brief: '', body: '', workdir: null, createdAt: '2026-07-24T07:00:00.000Z',
        totalTokens: 0, totalCostUsd: 0, remindAt: '2026-07-27T01:00:00.000Z',
      };
    }
    async function setup(stages: Record<number, 'scheduled' | 'fired' | 'acked' | 'cancelled'>) {
      const clock = scheduler();
      const getTicket = vi.fn(async (id: number) => reminderDetail(id, stages[id]!));
      const client = transport({ getTicket: getTicket as never });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      const settle = async () => { await runtime.whenIdle(); clock.runAll(); await new Promise((resolve) => setTimeout(resolve, 0)); };
      return { runtime, client, getTicket, settle };
    }
    const calls = (getTicket: ReturnType<typeof vi.fn>, id: number) => getTicket.mock.calls.filter(([value]) => value === id).length;

    it('ignores ticket events that name another ticket', async () => {
      const { runtime, client, getTicket, settle } = await setup({ 83: 'scheduled' });
      runtime.observeResource('ticket:83');
      await vi.waitFor(() => expect(runtime.control.getState().ticketDetailsById[83]).toBeDefined());
      client.emit(gatewayEvent(1, 'ticket.updated', { snapshotRequired: true }));
      await settle();
      expect(calls(getTicket, 83)).toBe(1);
    });

    it('skips reminders that cannot change any more', async () => {
      const { runtime, client, getTicket, settle } = await setup({ 84: 'cancelled', 85: 'acked' });
      runtime.observeResource('ticket:84');
      runtime.observeResource('ticket:85');
      await vi.waitFor(() => expect(runtime.control.getState().ticketDetailsById[85]).toBeDefined());
      client.emit({ ...gatewayEvent(1, 'ticket.updated', { snapshotRequired: true }), ticketId: null });
      await settle();
      expect(calls(getTicket, 84)).toBe(1);
      expect(calls(getTicket, 85)).toBe(1);
    });

    it('marks a reminder nobody looks at as stale, and fetches it when a card mounts again', async () => {
      const { runtime, client, getTicket, settle } = await setup({ 86: 'scheduled' });
      const release = runtime.observeResource('ticket:86');
      await vi.waitFor(() => expect(runtime.control.getState().ticketDetailsById[86]).toBeDefined());
      release();
      client.emit({ ...gatewayEvent(1, 'ticket.updated', { snapshotRequired: true }), ticketId: null });
      await settle();
      expect(calls(getTicket, 86)).toBe(1);
      expect(runtime.control.getState().resourceState['ticket:86']?.state).toBe('stale');
      runtime.observeResource('ticket:86');
      await vi.waitFor(() => expect(calls(getTicket, 86)).toBe(2));
    });
  });

  it('refetches snapshots once after a replayed backlog instead of once per replayed event', async () => {
    const clock = clockScheduler();
    let handlers: ConnectionHandlers = {};
    const client = transport({ connect: connectAtLatestSeq(5, (next) => { handlers = next; }) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
    await runtime.start();
    expect(client.getTickets).toHaveBeenCalledTimes(1);

    // The gateway replays seq 1..5 right after hello.v2. A browser delivers each
    // frame as its own task, so a 0 ms timer can run between two frames.
    for (let seq = 1; seq <= 5; seq += 1) {
      handlers.onEvent?.(gatewayEvent(seq, 'ticket.updated', { snapshotRequired: true }));
      await runtime.whenIdle();
      clock.advance(1);
      await settleRequests();
    }

    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(client.getOverview).toHaveBeenCalledTimes(2);
    expect(client.getProjects).toHaveBeenCalledTimes(2);
    expect(client.getAgenda).toHaveBeenCalledTimes(2);

    handlers.onEvent?.(gatewayEvent(6, 'ticket.updated', { snapshotRequired: true }));
    await runtime.whenIdle();
    clock.advance(0);
    await settleRequests();
    expect(client.getTickets).toHaveBeenCalledTimes(3);
  });

  it('refetches a replay that ends below hello.latestSeq once the stream goes quiet', async () => {
    const clock = clockScheduler();
    let handlers: ConnectionHandlers = {};
    const client = transport({ connect: connectAtLatestSeq(9, (next) => { handlers = next; }) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
    await runtime.start();

    // Events 4..9 are for other audiences, so this binding never sees seq 9.
    for (let seq = 1; seq <= 3; seq += 1) {
      handlers.onEvent?.(gatewayEvent(seq, 'ticket.updated', { snapshotRequired: true }));
      await runtime.whenIdle();
      clock.advance(1);
      await settleRequests();
    }
    expect(client.getTickets).toHaveBeenCalledTimes(1);

    clock.advance(1_000);
    await settleRequests();
    expect(client.getTickets).toHaveBeenCalledTimes(2);
  });

  // 2026-11-04：补发的历史里有旧的排队快照，早就处理过的外部消息出现在输入框上方。补发时不用它，补发完按 GET 的为准。
  it('does not show a replayed lead-queue snapshot, and refetches the queue when the replay ends', async () => {
    const stale = {
      key: 'slack:D0STALE', conversation: 'Ethan 的私信', source: 'slack', sourceLabel: 'Slack', senders: ['Ethan'],
      count: 4, excerpt: '早就处理过的消息', cardIds: [3], firstAt: '2026-11-03T09:20:00.000Z', lastAt: '2026-11-03T09:26:00.000Z',
      next: true, actions: ['remove'],
    };
    const getLeadQueue = vi.fn(async () => ({ busy: true, entries: [] }));
    let handlers: ConnectionHandlers = {};
    const client = transport({ connect: connectAtLatestSeq(5, (next) => { handlers = next; }), getLeadQueue });
    const timers = scheduler();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: timers });
    await runtime.start();
    expect(getLeadQueue).toHaveBeenCalledTimes(1);

    handlers.onEvent?.(gatewayEvent(4, 'snapshot.required', { resource: 'lead-queue', queue: { busy: true, entries: [stale] } }));
    await runtime.whenIdle();
    expect(runtime.control.getState().leadQueue?.entries).toEqual([]);

    handlers.onEvent?.(gatewayEvent(5, 'snapshot.required', { resource: 'lead-queue', queue: { busy: true, entries: [stale] } }));
    await runtime.whenIdle();
    timers.runAll();
    await vi.waitFor(() => expect(getLeadQueue).toHaveBeenCalledTimes(2));
    expect(runtime.control.getState().leadQueue?.entries).toEqual([]);

    // 连上以后推来的照常整份替换。
    handlers.onEvent?.(gatewayEvent(6, 'snapshot.required', { resource: 'lead-queue', queue: { busy: true, entries: [stale] } }));
    await runtime.whenIdle();
    expect(runtime.control.getState().leadQueue?.entries).toEqual([stale]);
  });

  // lead-scheduler spec D11（P3）：「这一步现在的状态」（模型回复慢）整份替换，null 是撤掉；补发的不用。
  it('shows the step status from a lead-step push, clears it on null, and ignores a replayed one', async () => {
    let handlers: ConnectionHandlers = {};
    const client = transport({ connect: connectAtLatestSeq(5, (next) => { handlers = next; }) });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    const slow = { turnId: 'turn_slow', kind: 'model_slow', since: '2026-11-09T10:00:00.000Z' };
    handlers.onEvent?.(gatewayEvent(4, 'snapshot.required', { resource: 'lead-step', status: slow }));
    await runtime.whenIdle();
    expect(runtime.control.getState().leadStep).toBeNull();
    handlers.onEvent?.(gatewayEvent(6, 'snapshot.required', { resource: 'lead-step', status: slow }));
    await runtime.whenIdle();
    expect(runtime.control.getState().leadStep).toEqual(slow);
    handlers.onEvent?.(gatewayEvent(7, 'snapshot.required', { resource: 'lead-step', status: null }));
    await runtime.whenIdle();
    expect(runtime.control.getState().leadStep).toBeNull();
  });

  it('refetches the snapshots when the gateway skipped the history', async () => {
    const getLeadQueue = vi.fn(async () => ({ busy: false, entries: [] }));
    const client = transport({
      getLeadQueue,
      connect: vi.fn(async (handlers: ConnectionHandlers = {}) => {
        handlers.onHello?.({
          type: 'hello.v2', protocolVersion: PROTOCOL_VERSION, serverTime: '2026-11-04T15:40:00.000Z',
          timezone: 'Asia/Shanghai', latestSeq: 133_598, capabilities: [], binding,
          daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
        }, { history: 'skipped' });
        handlers.onStateChange?.('connected');
      }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    await vi.waitFor(() => expect(client.getConversationTurns).toHaveBeenCalledTimes(2));
    expect(client.getTickets).toHaveBeenCalledTimes(2);
    expect(getLeadQueue).toHaveBeenCalledTimes(2);
  });

  it('does not merge an older conversation-card page after its resource generation changes', async () => {
    const older = deferred<ReturnType<typeof emptyConversationCardPage>>();
    const completed = durableConversationCard('completed', '2026-07-24T08:02:00.000Z');
    const getKernelConversationCards = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(conversationCardPage([completed]))
      .mockResolvedValueOnce(emptyConversationCardPage());
    const client = transport({
      connect: connectWithCapabilities(['kernel.conversation-cards.v1']),
      getKernelConversationCards,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().mergeConversationCardPage(
      conversationCardPage([durableConversationCard('running', '2026-07-24T08:00:00.000Z')]),
      'replace',
    );
    runtime.control.setState({
      conversationCardPagesByResource: {
        'conversation-cards': { hasMore: true, nextBeforeId: 9 },
      },
    });

    const historyLoad = runtime.loadOlderConversationCards();
    await vi.waitFor(() => expect(getKernelConversationCards).toHaveBeenCalledTimes(1));
    await runtime.ensureResource('conversation-cards', true);
    older.resolve(conversationCardPage([
      durableConversationCard('running', '2026-07-24T08:03:00.000Z'),
    ]));
    await historyLoad;

    expect(runtime.control.getState().conversationCardsById['turn:turn-1:ticket:42']).toMatchObject({
      updatedAt: completed.updatedAt,
      operations: [{ state: 'completed' }],
    });
  });

  it('does not let delayed global history overwrite a newer ticket-scoped card', async () => {
    const olderGlobal = deferred<ReturnType<typeof emptyConversationCardPage>>();
    const completed = durableConversationCard('completed', '2026-07-24T08:02:00.000Z');
    const getKernelConversationCards = vi.fn()
      .mockImplementationOnce(() => olderGlobal.promise)
      .mockResolvedValueOnce(conversationCardPage([completed]))
      .mockResolvedValueOnce(emptyConversationCardPage());
    const client = transport({
      connect: connectWithCapabilities(['kernel.conversation-cards.v1']),
      getKernelConversationCards,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().mergeConversationCardPage(
      conversationCardPage([durableConversationCard('running', '2026-07-24T08:00:00.000Z')]),
      'replace',
    );
    runtime.control.setState({
      conversationCardPagesByResource: {
        'conversation-cards': { hasMore: true, nextBeforeId: 9 },
      },
    });

    const historyLoad = runtime.loadOlderConversationCards();
    await vi.waitFor(() => expect(getKernelConversationCards).toHaveBeenCalledTimes(1));
    await runtime.ensureResource('conversation-cards:ticket:42', true);
    olderGlobal.resolve(conversationCardPage([
      durableConversationCard('running', '2026-07-24T08:01:00.000Z'),
    ]));
    await historyLoad;

    expect(runtime.control.getState().conversationCardsById['turn:turn-1:ticket:42']).toMatchObject({
      updatedAt: completed.updatedAt,
      operations: [{ state: 'completed' }],
    });
  });

  it('mounts hydration in a client lifecycle and disconnects once on cleanup', async () => {
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(null), scheduler: scheduler() });

    const cleanup = mountCompanionRuntime(runtime);
    await runtime.whenIdle();
    expect(runtime.workspace.getState().hydrated).toBe(true);
    cleanup();
    cleanup();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('captures a mounted startup rejection in control-plane error state', async () => {
    const credentials = credentialStore(null);
    credentials.load.mockRejectedValueOnce(new Error('secure storage unavailable'));
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler: scheduler() });

    const cleanup = mountCompanionRuntime(runtime);

    await vi.waitFor(() => expect(runtime.control.getState()).toMatchObject({
      phase: 'error',
      connectionState: 'disconnected',
      error: 'secure storage unavailable',
    }));
    cleanup();
  });

  it('falls back to an unsupported resource state when capability or scope is absent', async () => {
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    await runtime.ensureTicketCheckpoints(42);
    await runtime.ensureInterventions(42);

    expect(client.getKernelCheckpoints).not.toHaveBeenCalled();
    expect(client.getKernelInterventions).not.toHaveBeenCalled();
    expect(runtime.control.getState().resourceState['checkpoints:42']?.state).toBe('unsupported');
    expect(runtime.control.getState().resourceState['interventions:42']?.state).toBe('unsupported');
    await runtime.ensureArtifacts(42);
    expect(client.getKernelArtifacts).not.toHaveBeenCalled();
    expect(runtime.control.getState().resourceState['artifacts:42']?.state).toBe('unsupported');
  });

  it('negotiates checkpoint, work-item, and artifact resources independently', async () => {
    const getKernelCheckpoints = vi.fn(async () => ({ items: [], hasMore: false, nextBeforeId: null }));
    const getKernelWorkItems = vi.fn(async () => ({ items: [] }));
    const getKernelArtifacts = vi.fn(async () => ({ items: [] }));
    const client = transport({
      connect: connectWithCapabilities([
        'kernel.checkpoints.v2',
        'kernel.work-items.v1',
        'kernel.artifacts.v1',
      ]),
      getKernelCheckpoints,
      getKernelWorkItems,
      getKernelArtifacts,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    await Promise.all([
      runtime.ensureTicketCheckpoints(42),
      runtime.ensureWorkItems(),
      runtime.ensureArtifacts(42),
    ]);

    expect(getKernelCheckpoints).toHaveBeenCalledWith(42, {}, expect.any(AbortSignal), 2);
    expect(getKernelWorkItems).toHaveBeenCalledWith([], expect.any(AbortSignal), 1);
    expect(getKernelArtifacts).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    expect(runtime.control.getState().resourceState).toMatchObject({
      'checkpoints:42': { state: 'ready' },
      'work-items': { state: 'ready' },
      'artifacts:42': { state: 'ready' },
    });
  });

  it('cancels an artifact download without leaving canonical metadata in a loading state', async () => {
    let signal: AbortSignal | undefined;
    const downloadArtifact = vi.fn((_ticketId: number, _artifactId: number, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<never>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const client = transport({ downloadArtifact });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    const request = runtime.downloadArtifact(42, 9);
    await vi.waitFor(() => expect(downloadArtifact).toHaveBeenCalledTimes(1));
    expect(runtime.workspace.getState().artifactDownloadStateById[9]?.state).toBe('downloading');
    runtime.cancelArtifactDownload(9);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });

    expect(signal?.aborted).toBe(true);
    expect(runtime.workspace.getState().artifactDownloadStateById[9]).toEqual({
      state: 'idle', error: null, retryable: true,
    });
  });

  it('observes and releases a cancellable checkpoint resource', async () => {
    let requestSignal: AbortSignal | undefined;
    const getKernelCheckpoints = vi.fn((_ticketId: number, _query: unknown, signal?: AbortSignal) => {
      requestSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const client = transport({
      getKernelCheckpoints,
      connect: vi.fn(async (handlers = {}) => {
        handlers.onHello?.({
          type: 'hello.v2', protocolVersion: PROTOCOL_VERSION,
          serverTime: '2026-07-24T08:00:00.000Z', timezone: 'Asia/Shanghai', latestSeq: 0,
          capabilities: ['kernel.checkpoints.v1'], binding,
          daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
        });
        handlers.onStateChange?.('connected');
      }),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    const release = runtime.observeTicketCheckpoints(42);
    await vi.waitFor(() => expect(getKernelCheckpoints).toHaveBeenCalledTimes(1));
    expect(runtime.control.getState().resourceState['checkpoints:42']?.observerCount).toBe(1);
    release();

    expect(requestSignal?.aborted).toBe(true);
    expect(runtime.control.getState().resourceState['checkpoints:42']?.observerCount).toBe(0);
  });

  it('reloads a released resource when it is re-observed before the aborted request settles', async () => {
    const second = deferred<{ items: []; hasMore: false; nextBeforeId: null }>();
    const getKernelCheckpoints = vi.fn((_ticketId: number, _query: unknown, signal?: AbortSignal) => {
      if (getKernelCheckpoints.mock.calls.length === 1) {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return second.promise;
    });
    const client = transport({
      getKernelCheckpoints,
      connect: connectWithCapabilities(['kernel.checkpoints.v1']),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();

    const releaseFirst = runtime.observeTicketCheckpoints(42);
    await vi.waitFor(() => expect(getKernelCheckpoints).toHaveBeenCalledTimes(1));
    releaseFirst();
    const releaseSecond = runtime.observeTicketCheckpoints(42);

    await vi.waitFor(() => expect(getKernelCheckpoints).toHaveBeenCalledTimes(2));
    second.resolve({ items: [], hasMore: false, nextBeforeId: null });
    await vi.waitFor(() => expect(runtime.control.getState().resourceState['checkpoints:42']?.state).toBe('ready'));
    releaseSecond();
  });

  it('serializes intervention commands and locks the authority after a successful submission', async () => {
    const command = deferred<{ status: 'resolved'; interventionId: string }>();
    const resolveKernelIntervention = vi.fn()
      .mockImplementationOnce(() => command.promise)
      .mockResolvedValue({ status: 'resolved', interventionId: 'approval:9' });
    const client = transport({
      connect: connectWithCapabilities(['kernel.interventions.v1']),
      getKernelInterventions: vi.fn(async () => ({ items: [approvedIntervention] })),
      resolveKernelIntervention,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().replaceInterventions([pendingIntervention], 42);

    const first = runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'approve',
    });
    await vi.waitFor(() => expect(resolveKernelIntervention).toHaveBeenCalledTimes(1));
    await expect(runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'reject',
    })).rejects.toThrow('already submitted');

    command.resolve({ status: 'resolved', interventionId: 'approval:9' });
    await first;
    expect(runtime.control.getState().interventionsById['approval:9']?.state).toBe('approved');
    expect(runtime.workspace.getState().interventionCommandStateById['approval:9']?.state).toBe('succeeded');

    await expect(runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'reject',
    })).rejects.toThrow('already submitted');
    expect(resolveKernelIntervention).toHaveBeenCalledTimes(1);
  });

  it('rejects intervention commands while the control-plane socket is disconnected', async () => {
    const resolveKernelIntervention = vi.fn(async () => ({
      status: 'resolved' as const,
      interventionId: 'approval:9',
    }));
    const client = transport({
      connect: connectWithCapabilities(['kernel.interventions.v1']),
      resolveKernelIntervention,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().replaceInterventions([pendingIntervention], 42);
    runtime.disconnect();

    await expect(runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'approve',
    })).rejects.toThrow(/not connected/i);
    expect(resolveKernelIntervention).not.toHaveBeenCalled();
  });

  it('forces intervention authority reload after command success instead of reusing an older request', async () => {
    const staleSnapshot = deferred<{ items: KernelIntervention[] }>();
    const getKernelInterventions = vi.fn()
      .mockImplementationOnce(() => staleSnapshot.promise)
      .mockResolvedValueOnce({ items: [approvedIntervention] });
    const client = transport({
      connect: connectWithCapabilities(['kernel.interventions.v1']),
      getKernelInterventions,
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().replaceInterventions([pendingIntervention], 42);

    const oldLoad = runtime.ensureResource('interventions:42', true);
    await vi.waitFor(() => expect(getKernelInterventions).toHaveBeenCalledTimes(1));
    const resolving = runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'approve',
    });
    staleSnapshot.resolve({ items: [pendingIntervention] });
    await oldLoad;
    await resolving;

    expect(getKernelInterventions).toHaveBeenCalledTimes(2);
    expect(runtime.control.getState().interventionsById['approval:9']?.state).toBe('approved');
    expect(runtime.workspace.getState().interventionCommandStateById['approval:9']?.state).toBe('succeeded');
  });

  it('does not write an intervention command result after forget advances the lifecycle', async () => {
    const command = deferred<{ status: 'resolved'; interventionId: string }>();
    const client = transport({
      connect: connectWithCapabilities(['kernel.interventions.v1']),
      resolveKernelIntervention: vi.fn(() => command.promise),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().replaceInterventions([pendingIntervention], 42);

    const resolving = runtime.resolveIntervention('approval:9', {
      authority: 'approval',
      decision: 'approve',
    });
    await runtime.forget();
    command.resolve({ status: 'resolved', interventionId: 'approval:9' });
    await resolving;

    expect(runtime.workspace.getState().interventionCommandStateById['approval:9']).toBeUndefined();
    expect(runtime.control.getState().interventionIds).toEqual([]);
  });

  it('clears transient-only conversation cards on explicit disconnect', async () => {
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    runtime.control.getState().upsertTransientConversationCard({
      key: 'turn:turn-1:ticket:42',
      kind: 'ticket_execution',
      turnId: 'turn-1',
      ticketId: 42,
      operations: [],
      operationsTruncated: false,
      createdAt: '2026-07-24T08:00:00.000Z',
      updatedAt: '2026-07-24T08:00:00.000Z',
    });

    runtime.disconnect();

    expect(runtime.control.getState().conversationCardIds).toEqual([]);
  });
});

// daemon 只把有人在看的连接算作"有人在听"：只有这时 lead 才播报即时通知，桌面通知才不弹。
// companion 按页面或应用是否在前台上报，切到后台、回到前台都要跟着改。
describe('presence', () => {
  it('reports whether the app is in the foreground, and follows every change until unmounted', () => {
    const client = transport();
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    let listener: ((foreground: boolean) => void) | null = null;
    const unsubscribe = vi.fn();
    const cleanup = mountCompanionRuntime(runtime, {
      presence: { current: () => true, subscribe: (next) => { listener = next; return unsubscribe; } },
    });
    expect(client.setPresence).toHaveBeenLastCalledWith(true);
    listener!(false);
    expect(client.setPresence).toHaveBeenLastCalledWith(false);
    listener!(true);
    expect(client.setPresence).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

// 2026-10-16：Mac 合盖睡眠以后，半开的 WebSocket 看起来还连着，用户发的消息没到 daemon。
// 回到前台（web：标签页可见）、网络恢复时马上探一次连接；设备离线时马上当连接已经断了。
describe('connectivity', () => {
  it('checks the link when the app comes back, and drops it when the device goes offline', () => {
    const client = transport({ checkConnection: vi.fn(async () => true), connectionLost: vi.fn() });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    let listener: ((event: 'foreground' | 'online' | 'offline') => void) | null = null;
    const unsubscribe = vi.fn();
    const cleanup = mountCompanionRuntime(runtime, {
      connectivity: { subscribe: (next) => { listener = next; return unsubscribe; } },
    });
    listener!('foreground');
    expect(client.checkConnection).toHaveBeenCalledTimes(1);
    listener!('online');
    expect(client.checkConnection).toHaveBeenCalledTimes(2);
    listener!('offline');
    expect(client.connectionLost).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

// 发布评审 cb8a582：工单的执行日志也会显示 executor 的命令、失败原因和 stderr，这些文字里的密钥同样要去掉。
describe('agent logs', () => {
  it('keeps secrets in commands, errors and stderr out of the log buffer', async () => {
    const at = '2026-10-14T00:00:00.000Z';
    const client = transport({
      getAttemptEvents: vi.fn(async () => [
        { attemptId: 4, seq: 1, occurredAt: at, type: 'tool.started', callId: 'c1', name: 'command_execution', args: { command: 'curl -u admin:hunter2 https://x', cwd: '/repo' } },
        { attemptId: 4, seq: 2, occurredAt: at, type: 'tool.failed', callId: 'c1', name: 'command_execution', error: 'auth failed for https://bwen:ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234@github.com' },
        { attemptId: 4, seq: 3, occurredAt: at, type: 'runtime.stderr', text: 'mysql -uroot -pS3cret appdb' },
      ] as Awaited<ReturnType<CompanionTransport['getAttemptEvents']>>),
    });
    const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
    await runtime.start();
    const stop = runtime.observeResource(RESOURCE_KEYS.attemptEvents(4));
    await vi.waitFor(() => expect(runtime.streams.getState().logBuffersByAttemptId[4]?.items).toHaveLength(3));
    stop();

    const logs = JSON.stringify(runtime.streams.getState().logBuffersByAttemptId[4]!.items);
    for (const secret of ['hunter2', 'ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234', 'S3cret']) expect.soft(logs).not.toContain(secret);
    expect(logs).toContain('https://x');
  });

  // Lead 的名字（设置 → 身份与风格，2026-10-22）：界面上处处要用，所以连上就取，不等设置页打开。
  // 回归：第一版只把它放进了 core 的重取列表，首次连接走的是 hydrate，名字一直没取到，界面停在缺省的 Paimon。
  describe('the Lead profile', () => {
    const profile = (name: string) => ({ name, persona: '', interactionStyle: '', updatedAt: null, updatedBy: null });

    it('loads on connect and reloads only itself on snapshot.required for lead-profile', async () => {
      const clock = scheduler();
      const getLeadProfile = vi.fn()
        .mockResolvedValueOnce(profile('Jarvis'))
        .mockResolvedValue(profile('Friday'));
      const client = transport({ getLeadProfile });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      expect(getLeadProfile).toHaveBeenCalledTimes(1);
      expect(runtime.control.getState().leadProfile?.name).toBe('Jarvis');
      expect(leadNameNow()).toBe('Jarvis');

      client.emit(gatewayEvent(1, 'snapshot.required', { resource: 'lead-profile' }));
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(runtime.control.getState().leadProfile?.name).toBe('Friday'));
      expect(client.getTickets).toHaveBeenCalledTimes(1);
    });

    it('still connects when the daemon has no profile route', async () => {
      const getLeadProfile = vi.fn(async () => { throw new Error('404'); });
      const client = transport({ getLeadProfile });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
      await runtime.start();
      expect(runtime.control.getState()).toMatchObject({ phase: 'ready', leadProfile: null });
    });
  });

  // 设置页「消息通道」（2026-10-20）：页面在屏幕上时才取。连上、断开、出错时网关推 snapshot.required
  // （resource 是 channel-settings），只重取这一份；保存和断开以后马上换成 daemon 回的这个来源。
  describe('channel settings', () => {
    function channelSource(status: ChannelSourceSettingsDto['status']): ChannelSourceSettingsDto {
      return {
        source: 'slack', label: 'Slack', status,
        account: status === 'connected' ? { userId: 'U1', userName: 'bin', teamId: 'T1', teamName: 'Acme' } : null,
        missingScopes: [], lastError: null, lastConnectedAt: null, noEventsWarning: null,
        secrets: [{ name: 'PLC_SLACK_APP_TOKEN', label: 'App-Level Token', prefix: 'xapp-', hint: '', present: status !== 'not_configured', origin: status === 'not_configured' ? null : 'vault' }],
        manifest: null, setupUrl: null, setupNote: null, editable: true,
      };
    }

    it('loads only while observed and refetches only itself on snapshot.required for channel-settings', async () => {
      const clock = scheduler();
      const getChannelSettings = vi.fn()
        .mockResolvedValueOnce({ sources: [channelSource('not_configured')] })
        .mockResolvedValue({ sources: [channelSource('connected')] });
      const client = transport({ getChannelSettings });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      expect(getChannelSettings).not.toHaveBeenCalled();

      const release = runtime.observeResource(RESOURCE_KEYS.channelSettings);
      await vi.waitFor(() => expect(runtime.control.getState().channelSettings?.sources[0]?.status).toBe('not_configured'));

      client.emit(gatewayEvent(1, 'snapshot.required', { resource: 'channel-settings' }));
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(runtime.control.getState().channelSettings?.sources[0]?.status).toBe('connected'));
      expect(getChannelSettings).toHaveBeenCalledTimes(2);
      // 别的快照不跟着重取。
      expect(client.getTickets).toHaveBeenCalledTimes(1);
      release();
    });

    it('replaces the source with what the daemon answers after save and disconnect', async () => {
      const saveChannelSecrets = vi.fn(async () => channelSource('connecting'));
      const clearChannelSecrets = vi.fn(async () => channelSource('not_configured'));
      const client = transport({
        getChannelSettings: vi.fn(async () => ({ sources: [channelSource('not_configured')] })),
        saveChannelSecrets,
        clearChannelSecrets,
      });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
      await runtime.start();
      const release = runtime.observeResource(RESOURCE_KEYS.channelSettings);
      await vi.waitFor(() => expect(runtime.control.getState().channelSettings).not.toBeNull());

      await runtime.saveChannelSecrets('slack', { PLC_SLACK_APP_TOKEN: 'xapp-test' });
      expect(saveChannelSecrets).toHaveBeenCalledWith('slack', { PLC_SLACK_APP_TOKEN: 'xapp-test' });
      expect(runtime.control.getState().channelSettings?.sources.map((item) => item.status)).toEqual(['connecting']);

      await runtime.clearChannelSecrets('slack');
      expect(clearChannelSecrets).toHaveBeenCalledWith('slack');
      expect(runtime.control.getState().channelSettings?.sources.map((item) => item.status)).toEqual(['not_configured']);
      release();
    });

    it('marks the resource unsupported when the client has no channel settings', async () => {
      const runtime = createCompanionStateRuntime({ client: transport(), credentials: credentialStore(), scheduler: scheduler() });
      await runtime.start();
      const release = runtime.observeResource(RESOURCE_KEYS.channelSettings);
      await vi.waitFor(() => expect(runtime.control.getState().resourceState[RESOURCE_KEYS.channelSettings]?.state).toBe('unsupported'));
      release();
    });
  });

  // 2026-11-04：主会话打开时只取最近 30 轮，往上滚到头时一页一页取更早的，Lead 说完一句只取那一轮。
  // 以前每完成一条消息整份重取最近 100 轮（约 570 KB，九成是工具调用）。
  describe('conversation window, pages and single-turn corrections', () => {
    const base = Date.parse('2026-11-04T08:00:00.000Z');
    const mainTurn = (index: number, overrides: Partial<import('@pi-lead-child/protocol').ConversationTurn> = {}) => {
      const at = new Date(base + index * 60_000).toISOString();
      return {
        id: `turn-${String(index).padStart(2, '0')}`, originBindingId: 7, originKind: 'paired:companion', ticketId: null,
        state: 'completed' as const, userText: `第 ${index} 句`, assistantText: `回答 ${index}`, error: null,
        createdAt: at, updatedAt: at, ...overrides,
      };
    };
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => mainTurn(from + index));
    const shownTurnIds = (runtime: ReturnType<typeof createCompanionStateRuntime>) => {
      const state = runtime.control.getState();
      return [...new Set((state.messageIdsBySession['session-1'] ?? []).map((id) => state.messagesById[id]?.turnId))];
    };
    const event = (seq: number, type: GatewayEvent['type'], turnId: string, payload: Record<string, unknown>): GatewayEvent => ({
      ...gatewayEvent(seq, type, payload), turnId, ticketId: null,
    });

    it('opens on the newest turns and fetches only the turn Lead just finished', async () => {
      const clock = scheduler();
      const getConversationTurns = vi.fn(async () => range(11, 40));
      const getConversationTurnsById = vi.fn(async () => [mainTurn(41, { assistantText: '刚说完' })]);
      const client = transport({ getConversationTurns, getConversationTurnsById });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();

      expect(getConversationTurns).toHaveBeenCalledWith(undefined, expect.anything(), { limit: 30 });
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: true, oldest: { id: 'turn-11' } });

      client.emit(event(1, 'lead.turn.started', 'turn-41', { messageId: 'message-41', commandId: null, originKind: 'paired:companion', mode: 'started' }));
      client.emit(event(2, 'lead.message.completed', 'turn-41', { messageId: 'message-41', text: '刚说完' }));
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(getConversationTurnsById).toHaveBeenCalledWith(['turn-41'], expect.anything()));
      await runtime.whenIdle();

      expect(getConversationTurns).toHaveBeenCalledTimes(1);
      expect(shownTurnIds(runtime)).toEqual(range(11, 41).map((turn) => turn.id));
    });

    // 2026-11-10：daemon 把一轮的事件发给用户的每一台设备。别的设备发起的一轮，事件流只建了空壳，这里没有那句提问：
    // 一开始就单独取这一轮，提问在 Lead 回答的时候就出现，不等这一轮答完。
    it('fetches a turn another device started, so its question shows while Lead answers', async () => {
      const clock = scheduler();
      const getConversationTurnsById = vi.fn(async () => [mainTurn(41, { state: 'streaming', userText: '手机上问的', assistantText: '' })]);
      const client = transport({ getConversationTurns: vi.fn(async () => range(11, 40)), getConversationTurnsById });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();

      client.emit({ ...event(1, 'lead.turn.started', 'turn-41', {
        messageId: 'message-41', commandId: 'cmd-phone', originKind: 'paired:companion', mode: 'started', userText: '手机上问的',
      }), audienceBindingId: null });
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(getConversationTurnsById).toHaveBeenCalledWith(['turn-41'], expect.anything()));
      await runtime.whenIdle();

      const state = runtime.control.getState();
      const user = state.messagesById[state.turnsById['turn-41']!.userMessageId];
      expect(user?.source).toBe('snapshot');
      expect(state.messagePartsById[`${user!.id}:text`]).toMatchObject({ kind: 'text', text: '手机上问的' });
      expect(shownTurnIds(runtime)).toEqual(range(11, 41).map((turn) => turn.id));
    });

    it('does not fetch the turn of a message this device sent, nor a turn Lead started itself', async () => {
      const clock = scheduler();
      const getConversationTurnsById = vi.fn(async () => []);
      const sendChatCommand = vi.fn((_command: { id: string }) => new Promise<{ turnId: string }>(() => {}));
      const client = transport({ getConversationTurns: vi.fn(async () => range(11, 40)), getConversationTurnsById, sendChatCommand });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      void runtime.sendChat('这台设备发的');
      await vi.waitFor(() => expect(sendChatCommand).toHaveBeenCalled());
      const commandId = sendChatCommand.mock.calls[0]![0].id;

      client.emit(event(1, 'lead.turn.started', 'turn-41', { messageId: 'message-41', commandId, originKind: 'paired:companion', mode: 'started' }));
      client.emit({ ...event(2, 'lead.turn.started', 'turn-42', {
        messageId: 'message-42', commandId: null, originKind: 'system:heartbeat', mode: 'started',
      }), audienceBindingId: null });
      await runtime.whenIdle();
      clock.runAll();
      await runtime.whenIdle();

      expect(getConversationTurnsById).not.toHaveBeenCalled();
    });

    it('pages older turns before the oldest loaded one, one page at a time, until there are no more', async () => {
      const page = deferred<import('@pi-lead-child/protocol').ConversationTurnPage>();
      const getOlderConversationTurns = vi.fn()
        .mockImplementationOnce(() => page.promise)
        .mockResolvedValueOnce({ items: range(1, 2), hasMore: false });
      const client = transport({ getConversationTurns: vi.fn(async () => range(33, 62)), getOlderConversationTurns });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
      await runtime.start();

      const first = runtime.loadOlderConversationTurns();
      const again = runtime.loadOlderConversationTurns();
      expect(again).toBe(first);
      expect(runtime.control.getState().conversationHistory.loading).toBe(true);
      page.resolve({ items: range(3, 32), hasMore: true });
      await first;

      expect(getOlderConversationTurns).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'turn-33' }), { limit: 30 }, expect.anything(),
      );
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: true, loading: false, oldest: { id: 'turn-03' } });
      await runtime.loadOlderConversationTurns();
      expect(getOlderConversationTurns).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'turn-03' }), { limit: 30 }, expect.anything());
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: false, oldest: { id: 'turn-01' } });
      expect(shownTurnIds(runtime)).toEqual(range(1, 62).map((turn) => turn.id));

      await runtime.loadOlderConversationTurns();
      expect(getOlderConversationTurns).toHaveBeenCalledTimes(2);
    });

    it('keeps the error of a failed page and tries again on the next call', async () => {
      const getOlderConversationTurns = vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ items: range(1, 10), hasMore: false });
      const client = transport({ getConversationTurns: vi.fn(async () => range(11, 40)), getOlderConversationTurns });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: scheduler() });
      await runtime.start();

      await runtime.loadOlderConversationTurns();
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: true, loading: false, error: 'network down' });
      await runtime.loadOlderConversationTurns();
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: false, error: null });
    });

    // 重连（core）：重取最近一段。往上翻加载过的历史和它接得上，留着，游标也不变。
    it('keeps paged history when the newest window comes again after a reconnect', async () => {
      const clock = scheduler();
      const getConversationTurns = vi.fn()
        .mockResolvedValueOnce(range(11, 40))
        .mockResolvedValueOnce([...range(13, 40), mainTurn(41), mainTurn(42)]);
      const client = transport({
        getConversationTurns,
        getOlderConversationTurns: vi.fn(async () => ({ items: range(1, 10), hasMore: false })),
      });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      await runtime.loadOlderConversationTurns();

      client.emit(gatewayEvent(1, 'snapshot.required', { resource: 'something-new' }));
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(getConversationTurns).toHaveBeenCalledTimes(2));
      await runtime.whenIdle();

      expect(getConversationTurns).toHaveBeenLastCalledWith(undefined, expect.anything(), { limit: 30 });
      expect(shownTurnIds(runtime)).toEqual(range(1, 42).map((turn) => turn.id));
      expect(runtime.control.getState().conversationHistory).toMatchObject({ hasMore: false, oldest: { id: 'turn-01' } });
    });

    // 校正的一轮比还没取过的那一截还早：叠上去会在中间留一个洞，往上翻时那一截就被跳过了。
    it('does not place a corrected turn older than the loaded history', async () => {
      const clock = scheduler();
      const getConversationTurnsById = vi.fn(async () => [mainTurn(2, { assistantText: '很早以前的一轮' })]);
      const client = transport({ getConversationTurns: vi.fn(async () => range(11, 40)), getConversationTurnsById });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();

      client.emit(event(1, 'notice.created', 'turn-02', { severity: 'error', message: 'model failed' }));
      await runtime.whenIdle();
      clock.runAll();
      await vi.waitFor(() => expect(getConversationTurnsById).toHaveBeenCalled());
      await runtime.whenIdle();

      expect(shownTurnIds(runtime)[0]).toBe('turn-11');
      expect(runtime.control.getState().conversationHistory.oldest?.id).toBe('turn-11');
    });

    // 重放了很多事件（例如新配对的设备从头重放）：攒下的轮次太多，改取最近一段。
    it('fetches the newest window instead of many single turns', async () => {
      const clock = clockScheduler();
      const getConversationTurns = vi.fn(async () => range(11, 40));
      const getConversationTurnsById = vi.fn(async () => []);
      let handlers: ConnectionHandlers = {};
      const client = transport({
        getConversationTurns,
        getConversationTurnsById,
        connect: connectAtLatestSeq(25, (next) => { handlers = next; }),
      });
      const runtime = createCompanionStateRuntime({ client, credentials: credentialStore(), scheduler: clock });
      await runtime.start();
      for (let seq = 1; seq <= 25; seq += 1) {
        handlers.onEvent?.(event(seq, 'lead.message.completed', `turn-${String(seq + 15).padStart(2, '0')}`, { messageId: `m-${seq}`, text: `回答 ${seq + 15}` }));
      }
      await runtime.whenIdle();
      clock.advance(0);
      await vi.waitFor(() => expect(getConversationTurns).toHaveBeenCalledTimes(2));
      await runtime.whenIdle();

      expect(getConversationTurnsById).not.toHaveBeenCalled();
    });
  });
});
