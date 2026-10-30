// @ts-ignore Vitest executes source-boundary checks in Node.
import { readFileSync } from 'node:fs';
import {
  PROTOCOL_VERSION,
  type BindingDto,
  type ConversationTurn,
  type GatewayEvent,
  type KernelAttempt,
  type KernelCheckpoint,
  type KernelConversationCard,
  type KernelIntervention,
  type KernelInterventionRef,
  type KernelTicket,
  type KernelTicketTiming,
  type KernelTicketWorkbench,
  type KernelTicketWorkItem,
  type Overview,
  type TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneClient,
  type ControlPlaneSocket,
} from '@pi-lead-child/client';
import {
  createJsonCredentialStore,
  type KeyValueStorage,
} from '@pi-lead-child/client';
import {
  createCompanionStateRuntime,
  type CompanionStateRuntime,
} from '../../state/runtime';
import type { StreamScheduler } from '../../state/streams/batching';
import {
  buildCheckpointFeedPresentation,
  buildTicketDetailPresentation,
  buildTicketRailPresentation,
  checkpointToPresentation,
  interventionToAuthority,
  resourceToCheckpointFeedResource,
  ticketSummaryToTicket,
} from './model';

const createdAt = '2026-07-24T08:00:00.000Z';

const binding: BindingDto = {
  id: 7,
  kind: 'companion',
  name: 'android-phone',
  scopes: ['chat', 'tickets:view', 'approvals:respond'],
};

const overview: Overview = {
  model: 'openai/gpt-5.6-codex',
  sessionId: 'lead-session-1',
  busy: true,
  runningTicketIds: [42],
  counts: {
    activeTickets: 2,
    reviewTickets: 1,
    blockedTickets: 1,
    pendingApprovals: 1,
    unreadNotices: 0,
  },
  aish: null,
};

const tickets: TicketSummary[] = [{
  id: 38,
  title: '迁移 daemon 到常开机器',
  summary: '等待用户授权安装 launchd 服务。',
  kind: 'task',
  stage: 'blocked',
  status: 'blocked',
  hasRun: true,
  priority: 'low',
  project: null,
  dueAt: null,
  deferUntil: null,
  updatedAt: createdAt,
  runtime: { state: 'blocked', lastActivityAt: createdAt, activeAttemptId: 70 },
  attention: { pendingApprovalCount: 1, blockerCount: 1 },
}, {
  id: 42,
  title: '移动控制面协议缺口审计',
  summary: '核对完整控制面所需能力与 paired API。',
  kind: 'task',
  stage: 'active',
  status: 'active',
  hasRun: true,
  priority: 'high',
  project: 'pi-lead-child',
  dueAt: null,
  deferUntil: null,
  updatedAt: createdAt,
  runtime: { state: 'running', lastActivityAt: createdAt, activeAttemptId: 73 },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
}, {
  id: 41,
  title: 'M9 launchd 真机验收',
  summary: '等待最终验收。',
  kind: 'task',
  stage: 'review',
  status: 'review',
  hasRun: true,
  priority: 'normal',
  project: 'pi-lead-child',
  dueAt: null,
  deferUntil: null,
  updatedAt: createdAt,
  runtime: { state: 'idle', lastActivityAt: createdAt, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
}, {
  id: 40,
  title: '协议 schema 冻结',
  summary: '冻结 v2 schema。',
  kind: 'task',
  stage: 'done',
  status: 'done',
  hasRun: true,
  priority: 'normal',
  project: 'pi-lead-child',
  dueAt: null,
  deferUntil: null,
  updatedAt: createdAt,
  runtime: { state: 'idle', lastActivityAt: createdAt, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
}];

const timing: KernelTicketTiming = {
  firstStartedAt: createdAt,
  completedAt: null,
  statusChangedAt: createdAt,
  computedAt: '2026-07-24T08:06:12.000Z',
  elapsedMs: 372_000,
  activeExecutionMs: 350_000,
  statusDurationMs: 372_000,
};

const kernelTicket: KernelTicket = {
  id: 42,
  title: tickets[1]!.title,
  brief: tickets[1]!.summary,
  body: '',
  status: 'active',
  priority: 'high',
  project: 'pi-lead-child',
  projectId: 3,
  parentTicketId: null,
  rootTicketId: 42,
  createdByAttemptId: null,
  orchestrationState: 'waiting',
  requestedRuntime: 'codex',
  requestedModel: null,
  purpose: 'execution',
  verificationPolicy: 'independent_reviewer',
  acceptancePolicy: 'user_only',
  reworkPolicy: 'ask_user',
  deliveryPolicy: 'notify_only',
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

const activeAttempt: KernelAttempt = {
  id: 73,
  ticketId: 42,
  role: 'executor',
  state: 'running',
  runtime: 'codex',
  purpose: 'execution',
  model: 'gpt-5.6-codex',
  runtimeVersion: '0.144.6',
  externalSessionId: 'sess_9f42a1c7',
  sessionId: null,
  sessionPath: '/tmp/runtime-events/attempt-73.jsonl',
  pid: 7300,
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

const blockedCheckpoint: KernelCheckpoint = {
  id: 11,
  ticketId: 42,
  attemptId: 73,
  author: { kind: 'executor', runtime: 'codex' },
  source: 'agent_reported',
  kind: 'blocked',
  stage: 'install',
  title: '等待系统授权',
  summary: 'launchd 安装需要 sudo。',
  keyFacts: [{ label: 'stderr', value: 'Operation not permitted' }],
  artifactRefs: [],
  relatedTicketIds: [38],
  nextStep: '授权后继续安装',
  actionRef: { type: 'approval', id: 9 },
  createdAt: '2026-07-24T08:04:00.000Z',
};

const completedCheckpoint: KernelCheckpoint = {
  id: 12,
  ticketId: 42,
  attemptId: 73,
  author: { kind: 'executor', runtime: 'codex' },
  source: 'agent_reported',
  kind: 'milestone',
  stage: 'protocol',
  title: '完成 paired API 对照',
  summary: '已定位并验证控制面资源。',
  keyFacts: [{ label: '验收', value: 'schema valid' }],
  artifactRefs: [],
  relatedTicketIds: [],
  nextStep: '接入 Companion 详情页',
  actionRef: null,
  createdAt: '2026-07-24T08:06:00.000Z',
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
  createdAt: blockedCheckpoint.createdAt,
  resolvedBy: null,
  resolvedAt: null,
} satisfies KernelIntervention;

const workItem: KernelTicketWorkItem = {
  ticketId: 42,
  timing,
  activeExecution: {
    attemptId: 73,
    role: 'executor',
    runtime: 'codex',
    state: 'running',
    model: 'gpt-5.6-codex',
    externalSessionId: 'sess_9f42a1c7',
  },
  pendingInterventionCount: 1,
  latestCheckpointId: 12,
};

const conversationTurn: ConversationTurn = {
  id: 'turn-1',
  originBindingId: binding.id,
  originKind: 'companion',
  ticketId: 42,
  state: 'completed',
  userText: '审计控制面协议缺口',
  assistantText: '已创建工单并启动 child。',
  error: null,
  createdAt,
  updatedAt: '2026-07-24T08:01:00.000Z',
};

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

class FixtureSocket implements ControlPlaneSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string) { this.sent.push(data); }
  close(code = 1000, reason = 'client closed') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scheduler(): StreamScheduler {
  const cancelled = new WeakSet<object>();
  return {
    schedule(callback) {
      const handle = {};
      queueMicrotask(() => {
        if (!cancelled.has(handle)) callback();
      });
      return handle;
    },
    cancel(handle) {
      if (typeof handle === 'object' && handle !== null) cancelled.add(handle);
    },
    now: () => 1,
  };
}

type Fixture = Awaited<ReturnType<typeof pairedClientFixture>>;

async function pairedClientFixture() {
  const storage = new MemoryStorage();
  const credentials = createJsonCredentialStore(storage);
  const sockets: FixtureSocket[] = [];
  const requests: { url: string; method: string; commandId: string | null }[] = [];
  let malformedCheckpoints = false;
  let failNextResolution = false;
  let intervention: KernelIntervention = pendingIntervention;

  const interventionRef = (): KernelInterventionRef => ({
    id: intervention.id,
    ticketId: intervention.ticketId,
    kind: 'approval',
    state: intervention.state as 'pending' | 'approved' | 'rejected' | 'expired',
    requiresAction: intervention.state === 'pending',
  });
  const workbench = (): KernelTicketWorkbench => ({
    ticket: kernelTicket,
    timing,
    activeAttempt,
    children: [],
    latestCheckpoints: [blockedCheckpoint, completedCheckpoint],
    interventionRefs: [interventionRef()],
  });
  const cards = (): { items: KernelConversationCard[]; checkpoints: KernelCheckpoint[]; interventionRefs: KernelInterventionRef[]; hasMore: false; nextBeforeId: number } => ({
    items: [{
      id: 1,
      key: 'turn:turn-1:ticket:42',
      kind: 'ticket_execution',
      turnId: 'turn-1',
      ticketId: 42,
      operations: [{
        id: 'turn-1:create-ticket',
        name: 'create_ticket',
        state: 'completed',
        label: '创建工单 #42',
        detail: 'created ticket #42',
      }],
      operationsTruncated: false,
      createdAt,
      updatedAt: '2026-07-24T08:01:00.000Z',
    }, {
      id: 2,
      key: 'checkpoint:12',
      kind: 'checkpoint',
      turnId: 'turn-1',
      ticketId: 42,
      checkpointId: 12,
      createdAt: completedCheckpoint.createdAt,
      updatedAt: completedCheckpoint.createdAt,
    }, {
      id: 3,
      key: 'intervention:approval:9',
      kind: 'intervention',
      turnId: 'turn-1',
      ticketId: 42,
      checkpointId: 11,
      interventionId: 'approval:9',
      createdAt: blockedCheckpoint.createdAt,
      updatedAt: blockedCheckpoint.createdAt,
    }],
    checkpoints: [blockedCheckpoint, completedCheckpoint],
    interventionRefs: [interventionRef()],
    hasMore: false,
    nextBeforeId: 1,
  });

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({ url: url.toString(), method, commandId: headers.get('idempotency-key') });

    if (url.pathname === '/v1/paired/redeem') {
      return response({ binding, access_token: 'fixture-token' }, 201);
    }
    if (headers.get('authorization') !== 'Bearer fixture-token') {
      return response({ error: { code: 'unauthorized', message: 'missing bearer token' } }, 401);
    }
    if (url.pathname === '/v1/paired/ws-ticket') {
      return response({ ws_ticket: 'ws-fixture', expires_at: '2026-07-24T09:00:00.000Z' }, 201);
    }
    if (url.pathname === '/v1/overview') return response(overview);
    if (url.pathname === '/v1/tickets') return response({ items: tickets });
    if (url.pathname === '/v1/projects') return response({ items: [] });
    if (url.pathname === '/v1/agenda') return response({ items: [] });
    if (url.pathname === '/v1/approvals') return response({ items: [] });
    if (url.pathname === '/v1/conversation/turns') return response({ items: [conversationTurn] });
    if (url.pathname === '/v1/kernel/work-items') return response({ items: [workItem] });
    if (url.pathname === '/v1/kernel/tickets/42/workbench') return response(workbench());
    if (url.pathname === '/v1/kernel/tickets/42/checkpoints') {
      if (malformedCheckpoints) {
        return response({ items: [{ id: 'not-a-checkpoint' }], hasMore: false, nextBeforeId: null });
      }
      const afterId = Number(url.searchParams.get('after_id') ?? 0);
      const items = [blockedCheckpoint, completedCheckpoint].filter((item) => item.id > afterId);
      return response({ items, hasMore: false, nextBeforeId: items[0]?.id ?? null });
    }
    if (url.pathname === '/v1/kernel/interventions/approval%3A9/resolve') {
      if (failNextResolution) {
        failNextResolution = false;
        return response({ error: { code: 'internal_error', message: 'resolution unavailable' } }, 503);
      }
      intervention = {
        ...pendingIntervention,
        state: 'approved',
        actions: [],
        resolution: { decision: 'approve', sessionExempt: false },
        resolvedBy: 'user via paired binding:7',
        resolvedAt: '2026-07-24T08:07:00.000Z',
      };
      return response({ status: 'resolved', interventionId: 'approval:9' });
    }
    if (url.pathname === '/v1/kernel/interventions') return response({ items: [intervention] });
    if (url.pathname === '/v1/kernel/conversation/cards') return response(cards());
    return response({ error: { code: 'not_found', message: `fixture route missing: ${url.pathname}` } }, 404);
  };

  const client = new ControlPlaneClient({
    fetch: fetcher,
    credentials,
    createWebSocket: () => {
      const socket = new FixtureSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await client.pair('http://daemon.fixture', 'plc-abcd-efgh');
  const commandIds = ['resolve-1', 'resolve-2', 'resolve-3'];
  const runtime = createCompanionStateRuntime({
    client,
    credentials,
    scheduler: scheduler(),
    createCommandId: () => commandIds.shift() ?? 'resolve-fallback',
  });
  await runtime.start();
  expect(sockets).toHaveLength(1);
  sockets[0]!.open();
  sockets[0]!.receive({
    type: 'hello.v2',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: createdAt,
    timezone: 'Asia/Shanghai',
    latestSeq: 0,
    capabilities: [
      'kernel.checkpoints.v1',
      'kernel.interventions.v1',
      'kernel.work-items.v1',
      'kernel.ticket-workbench.v1',
      'kernel.conversation-cards.v1',
    ],
    binding,
    daemon: { model: overview.model, sessionId: overview.sessionId, busy: overview.busy },
  });
  await vi.waitFor(() => expect(runtime.control.getState().phase).toBe('ready'));

  return {
    runtime,
    requests,
    setMalformedCheckpoints(value: boolean) { malformedCheckpoints = value; },
    failResolutionOnce() { failNextResolution = true; },
    stop() { runtime.stop(); },
  };
}

async function hydrateAdditiveResources(fixture: Fixture) {
  const { runtime } = fixture;
  runtime.handleEvent(liveTicketCardEvent());
  await runtime.whenIdle();
  await Promise.all([
    runtime.ensureWorkItems(),
    runtime.ensureTicketWorkbench(42),
    runtime.ensureTicketCheckpoints(42),
    runtime.ensureInterventions(42),
    runtime.ensureConversationCards(),
  ]);
}

function liveTicketCardEvent(): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'event-live-card',
    seq: 1,
    type: 'lead.tool.completed',
    occurredAt: '2026-07-24T08:00:30.000Z',
    requiredScope: 'chat',
    audienceBindingId: binding.id,
    turnId: 'turn-1',
    ticketId: 42,
    payload: {
      toolCallId: 'create-ticket',
      toolName: 'create_ticket',
      result: { ticket_id: 42, status: 'backlog' },
      isError: false,
    },
  };
}

function interventionCommandState(runtime: CompanionStateRuntime, interventionId: string) {
  return runtime.workspace.getState().interventionCommandStateById[interventionId];
}

describe('checkpoint control-plane UX integration', () => {
  it('hydrates real paired-client resources into grouped rail, timing, detail feed, interventions, and durable Lead cards', async () => {
    const fixture = await pairedClientFixture();
    try {
      await hydrateAdditiveResources(fixture);
      const state = fixture.runtime.control.getState();
      const rail = buildTicketRailPresentation(
        state.ticketIds.map((id) => ticketSummaryToTicket(state.ticketsById[id]!)),
        { filter: 'all' },
      );

      // #41 停在 review、不等你：下一步是系统的核查，进「Lead 处理中」。
      expect(rail.groups.map((group) => group.id)).toEqual([
        'needs_intervention',
        'running',
        'lead',
        'completed',
      ]);
      expect(state.ticketTimingsById[42]).toEqual(timing);
      expect(state.workbenchesById[42]).toMatchObject({
        ticketId: 42,
        activeAttemptId: 73,
        latestCheckpointIds: [11, 12],
        interventionIds: ['approval:9'],
      });

      const authorities = Object.fromEntries(
        state.interventionIdsByTicket[42]!.map((id) => [
          id,
          interventionToAuthority(state.interventionsById[id]!, true),
        ]),
      );
      const feed = buildCheckpointFeedPresentation(
        state.checkpointIdsByTicket[42]!.map((id) => checkpointToPresentation(state.checkpointsById[id]!)),
        authorities,
      );
      expect(feed.items.map((item) => item.id)).toEqual(['12', '11']);
      expect(feed.items[1]).toMatchObject({
        title: '等待系统授权',
        intervention: {
          id: 'approval:9',
          actions: [
            expect.objectContaining({ id: 'reject' }),
            expect.objectContaining({ id: 'approve_once' }),
            expect.objectContaining({ id: 'approve_session' }),
          ],
        },
      });

      expect(state.conversationCardIds).toEqual([
        'turn:turn-1:ticket:42',
        'checkpoint:12',
        'intervention:approval:9',
      ]);
      expect(state.conversationCardsById['turn:turn-1:ticket:42']).toMatchObject({
        durableId: 1,
        source: 'durable',
        operations: [{ state: 'completed' }],
      });
      expect(state.conversationCardIds.filter((key) => key === 'turn:turn-1:ticket:42')).toHaveLength(1);
      expect(fixture.requests.some((request) => request.url.endsWith('/v1/paired/redeem'))).toBe(true);
      expect(fixture.requests.some((request) => request.url.includes('/v1/kernel/conversation/cards'))).toBe(true);
    } finally {
      fixture.stop();
    }
  });

  it('keeps empty and unsupported states honest without fabricating domain data', () => {
    expect(buildTicketRailPresentation([], { filter: 'all' }).state).toBe('first_use');
    expect(buildTicketRailPresentation([ticketSummaryToTicket(tickets[3]!)], { filter: 'all' }).state)
      .toBe('all_completed');
    expect(buildTicketRailPresentation([ticketSummaryToTicket(tickets[1]!)], { filter: 'todo' }).state)
      .toBe('no_results');
    expect(buildCheckpointFeedPresentation([], {}, { state: 'ready' }).state).toBe('empty');
    expect(buildCheckpointFeedPresentation([], {}, { state: 'disconnected' }).state).toBe('disconnected');

    const detail = buildTicketDetailPresentation(ticketSummaryToTicket(tickets[1]!), {
      timing,
      artifactCapability: 'unsupported',
    });
    expect(detail.artifactState).toEqual({
      kind: 'unsupported',
      title: '产物能力尚未接入',
      body: '当前内核还没有可读取的 Artifact 资源，不会从文件路径伪造产物。',
    });
    expect(detail).not.toHaveProperty('metrics');
  });

  it('preserves cached additive content on disconnect and fails closed on a malformed refresh', async () => {
    const fixture = await pairedClientFixture();
    try {
      await hydrateAdditiveResources(fixture);
      const cachedIds = fixture.runtime.control.getState().checkpointIdsByTicket[42];
      fixture.setMalformedCheckpoints(true);

      await expect(fixture.runtime.refreshCheckpoints(42)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fixture.runtime.control.getState().checkpointIdsByTicket[42]).toBe(cachedIds);
      expect(fixture.runtime.control.getState().resourceState['checkpoints:42']).toMatchObject({
        state: 'error',
        error: 'response does not match the shared protocol',
      });

      fixture.setMalformedCheckpoints(false);
      await fixture.runtime.refreshCheckpoints(42);
      fixture.runtime.disconnect();
      const disconnected = fixture.runtime.control.getState();
      expect(disconnected.connectionState).toBe('disconnected');
      expect(disconnected.checkpointIdsByTicket[42]).toEqual([11, 12]);
      expect(disconnected.conversationCardIds).toEqual([
        'turn:turn-1:ticket:42',
        'checkpoint:12',
        'intervention:approval:9',
      ]);
      expect(resourceToCheckpointFeedResource(
        disconnected.phase,
        disconnected.resourceState['checkpoints:42'],
        disconnected.connectionState,
      )).toEqual({ state: 'disconnected' });
    } finally {
      fixture.stop();
    }
  });

  it('records a retryable intervention command error and clears it after a successful retry', async () => {
    const fixture = await pairedClientFixture();
    try {
      await hydrateAdditiveResources(fixture);
      fixture.failResolutionOnce();

      await expect(fixture.runtime.resolveIntervention('approval:9', {
        authority: 'approval',
        decision: 'approve',
      })).rejects.toThrow('resolution unavailable');
      expect.soft(interventionCommandState(fixture.runtime, 'approval:9')).toMatchObject({
        state: 'error',
        error: 'resolution unavailable',
        retryable: true,
      });

      await fixture.runtime.resolveIntervention('approval:9', {
        authority: 'approval',
        decision: 'approve',
      });
      expect.soft(interventionCommandState(fixture.runtime, 'approval:9')).toMatchObject({
        state: 'succeeded',
        error: null,
        retryable: false,
      });
      expect(fixture.runtime.control.getState().interventionsById['approval:9']).toMatchObject({
        state: 'approved',
        resolvedBy: 'user via paired binding:7',
      });
      expect(fixture.requests.filter((request) => request.url.includes('/resolve')).map((request) => request.commandId))
        .toEqual(['resolve-1', 'resolve-2']);
    } finally {
      fixture.stop();
    }
  });

  it('wires additive resources at the workspace boundary and keeps intervention actions accessible', () => {
    const nativeWorkbench = readFileSync(new URL('./Workbench.tsx', import.meta.url), 'utf8');
    const webWorkbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');
    const ticketsRoute = readFileSync(new URL('../../app/(tabs)/tickets.tsx', import.meta.url), 'utf8');
    const ticketRoute = readFileSync(new URL('../../app/ticket/[id].tsx', import.meta.url), 'utf8');
    const connectedRail = readFileSync(new URL('./ConnectedWorkRail.tsx', import.meta.url), 'utf8');
    const connectedThread = readFileSync(new URL('../tickets/useTicketDetailModel.ts', import.meta.url), 'utf8');
    const conversation = readFileSync(new URL('../chat/LeadConversation.tsx', import.meta.url), 'utf8');
    const checkpointFeed = readFileSync(new URL('../tickets/CheckpointFeed.tsx', import.meta.url), 'utf8');
    const interventionPanel = readFileSync(new URL('../tickets/InterventionPanel.tsx', import.meta.url), 'utf8');

    expect.soft(webWorkbench).toContain('ConnectedWorkRail');
    expect.soft(webWorkbench).toContain('ConnectedTicketThread');
    expect.soft(nativeWorkbench).toContain('LeadConversation');
    expect.soft(nativeWorkbench).toContain("router.push('/tickets')");
    expect.soft(nativeWorkbench).not.toContain('ConnectedWorkRail');
    expect.soft(nativeWorkbench).not.toContain('ConnectedTicketThread');
    expect.soft(ticketsRoute).toContain('TicketList');
    expect.soft(ticketRoute).toContain('ConnectedTicketThread');
    for (const source of [nativeWorkbench, webWorkbench, ticketsRoute, ticketRoute]) {
      expect.soft(source).not.toContain('ControlPlaneClient');
      expect.soft(source).not.toMatch(/\b(?:mock|fixture|demo)(?:Tickets|Checkpoints|Interventions|Cards)\b/i);
    }
    expect.soft(connectedRail).toContain('useWorkItems');
    expect.soft(connectedRail).toContain('useProjects');
    expect.soft(connectedRail).toContain('useAgenda');
    expect.soft(connectedRail).toContain('state.railView');
    expect.soft(connectedRail).toContain('state.ticketQuery');
    expect.soft(connectedRail).toContain('setRailView');
    expect.soft(connectedRail).toContain('setTicketQuery');
    expect.soft(connectedRail).toContain('projects={projects}');
    // 日程 tab 读 /v1/timeline（阶段 3）；useAgenda 只给收件箱的提醒状态。
    expect.soft(connectedRail).toContain('timeline={timeline}');
    expect.soft(connectedThread).toContain('useTicketWorkbench');
    expect.soft(connectedThread).toContain('useTicketCheckpoints');
    expect.soft(connectedThread).toContain('useTicketInterventions');
    expect.soft(connectedThread).toContain('checkpointToPresentation');
    expect.soft(connectedThread).toContain('interventionToAuthority');
    expect.soft(connectedThread).toContain('resourceToCheckpointFeedResource');
    expect.soft(connectedThread).toContain('loadOlderCheckpoints');
    expect.soft(connectedThread).toContain('checkpointPagesByTicket');
    expect.soft(connectedThread).toContain("const connected = connectionState === 'connected'");
    expect.soft(connectedThread).toContain("interventionResource?.state === 'ready' && connected");
    // 工单消息断线时也能发：先进本机发件箱，连接恢复后发送（2026-10-16）。
    expect.soft(connectedThread).toContain("onSendMessage: (message) => void runtime.sendChat(message, ticketId)");
    expect.soft(connectedThread).toContain("onLoadOlder: checkpointPage?.hasMore && connected");
    expect.soft(checkpointFeed).toContain('加载更早的进展');
    expect.soft(checkpointFeed).toContain('正在加载更早的进展');
    expect.soft(checkpointFeed).toContain('更早的进展加载失败');
    expect.soft(connectedThread).not.toContain('ControlPlaneClient');
    expect.soft(conversation).toContain('useConversationCards');
    expect.soft(conversation).toContain('loadOlderConversationCards');
    expect.soft(conversation).toContain('conversationCardPagesByResource');
    expect.soft(conversation).toContain('加载更早的会话卡片');
    expect.soft(conversation).toContain('正在加载更早的会话卡片');
    expect.soft(conversation).toContain('更早的会话卡片加载失败');
    expect.soft(conversation).toMatch(/ConversationCard|TicketExecutionCard/);
    expect.soft(interventionPanel).toContain('<Button');
    expect.soft(interventionPanel).toContain('testID={`intervention-action-${action.id}`}');
    expect.soft(interventionPanel).not.toContain('accessibilityRole="button"');
    expect.soft(interventionPanel).toContain("commandState?.state === 'succeeded'");
    expect.soft(interventionPanel).not.toContain('fetch(');
  });

  it('keeps compact panels bounded while rail, conversation, and detail content remain scrollable', () => {
    const nativeWorkbench = readFileSync(new URL('./Workbench.tsx', import.meta.url), 'utf8');
    const webWorkbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');
    const workRail = readFileSync(new URL('./WorkRail.tsx', import.meta.url), 'utf8');
    const conversation = readFileSync(new URL('../chat/LeadConversation.tsx', import.meta.url), 'utf8');
    const ticketThread = readFileSync(new URL('../tickets/TicketThread.tsx', import.meta.url), 'utf8');

    expect(nativeWorkbench).toContain("<Screen edges={['top', 'bottom']}");
    expect(nativeWorkbench).toContain("router.push('/tickets')");
    // 紧凑布局里，工单线程作为 modal SlidePanel 铺满工作台；工作台本身裁掉溢出。
    expect(webWorkbench).toContain('<SlidePanel edge="right" modal');
    expect(webWorkbench).toContain('<Box flex={1} minH={0} overflow="hidden">');
    expect(workRail).toContain('<ScrollArea');
    // 会话的滚动区是 ChatScroll（原来另一个 ScrollArea 是输入框上方的工单标签，方案 C 去掉了那一行）。
    expect(conversation).toContain('<ChatScroll');
    expect(ticketThread).toContain('<ScrollArea testID="ticket-thread-scroll" fillContent onScroll={onScroll}>');
    // 进展记录不再套在详情的滚动区里自己滚（复核 P1-4）：它在「证据与记录」的页签里。
    expect(ticketThread).not.toContain('ticket-pow-scroll');
  });

  it('exposes compact overlays and rail navigation with accessibility semantics', () => {
    const workRail = readFileSync(new URL('./WorkRail.tsx', import.meta.url), 'utf8');
    const webWorkbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');

    // SlidePanel 的 modal 面板暴露为对话框；SegmentedControl 暴露 tablist/tab 和选中状态。
    // 这两项语义由组件库实现和测试（packages/components/test）。
    expect.soft(webWorkbench).toContain('<SlidePanel edge="right" modal');
    expect.soft(workRail).toMatch(/<SegmentedControl\s+options=\{RAIL_VIEWS\}\s+value=\{view\}/);
  });
});
