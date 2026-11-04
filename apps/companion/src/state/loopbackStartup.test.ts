import {
  PROTOCOL_VERSION,
  type BindingDto,
  type GatewayEvent,
  type HelloV2,
  type MemorySettingsDto,
  type MemorySwitch,
  type Overview,
  type TicketSummary,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClient, type ControlPlaneSocket } from '@pi-lead-child/client';
import { createJsonCredentialStore, type KeyValueStorage } from '@pi-lead-child/client';
import { resolveLoopbackAutoPairEndpoint } from '@pi-lead-child/client';
import { createCompanionStateRuntime } from './runtime';

// The startup path of the web companion: the real client, the JSON credential
// store and the provider's timer scheduler. Only fetch and the WebSocket are fakes.

const CREDENTIAL_KEY = 'pi-lead-child.control-plane.v2';
const WORKING_ORIGIN = 'http://127.0.0.1:47130';
const REFUSED_ORIGIN = 'http://127.0.0.1:47142';

const binding: BindingDto = {
  id: 7,
  kind: 'companion',
  name: 'localhost-web',
  scopes: ['chat', 'tickets:view', 'approvals:respond'],
};

const overview: Overview = {
  model: 'gpt-5.6-sol',
  sessionId: 'session-1',
  busy: false,
  runningTicketIds: [],
  counts: { activeTickets: 1, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
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
  updatedAt: '2026-10-12T08:00:00.000Z',
  runtime: { state: 'running', lastActivityAt: '2026-10-12T08:00:00.000Z', activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
};

const scheduler = {
  schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

class MemoryKeyValueStorage implements KeyValueStorage {
  values = new Map<string, string>();

  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

class FakeSocket implements ControlPlaneSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'client closed' }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  hello(latestSeq: number) {
    this.readyState = 1;
    this.onopen?.();
    const hello: HelloV2 = {
      type: 'hello.v2',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2026-10-12T08:00:00.000Z',
      timezone: 'Asia/Shanghai',
      latestSeq,
      capabilities: [],
      binding,
      daemon: { model: overview.model, sessionId: overview.sessionId, busy: false },
    };
    this.receive(hello);
  }
}

function ticketUpdated(seq: number): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${seq}`,
    seq,
    type: 'ticket.updated',
    occurredAt: '2026-10-12T08:00:00.000Z',
    requiredScope: 'tickets:view',
    audienceBindingId: null,
    turnId: null,
    ticketId: 42,
    payload: { snapshotRequired: true },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

// A gateway on WORKING_ORIGIN. Nothing listens on REFUSED_ORIGIN, which a
// browser reports as a TypeError (net::ERR_CONNECTION_REFUSED).
function loopbackGateway(extra: (pathname: string, init?: RequestInit) => Response | null = () => null) {
  const requests: string[] = [];
  const sockets: FakeSocket[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (url.origin !== WORKING_ORIGIN) throw new TypeError('Failed to fetch');
    const answered = extra(url.pathname, init);
    if (answered) return answered;
    switch (url.pathname) {
      case '/v1/paired/loopback': return json({ binding, access_token: 'fresh-test-token' }, 201);
      case '/v1/paired/ws-ticket': return json({ ws_ticket: 'ws-test-ticket', expires_at: '2026-10-12T09:00:00.000Z' });
      case '/v1/overview': return json(overview);
      case '/v1/tickets': return json({ items: [ticket] });
      case '/v1/projects':
      case '/v1/agenda':
      case '/v1/approvals':
      case '/v1/conversation/turns': return json({ items: [] });
      case '/v1/connections': return json({ items: [], attention: 0 });
      default: return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    }
  });
  const createWebSocket = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  const count = (request: string) => requests.filter((entry) => entry === request).length;
  return { fetch: fetch as typeof globalThis.fetch, createWebSocket, requests, sockets, count };
}

function storedCredentials(storage: MemoryKeyValueStorage) {
  const raw = storage.values.get(CREDENTIAL_KEY);
  return raw ? JSON.parse(raw) as { baseUrl: string; accessToken: string; lastSeq: number } : null;
}

function webLoopbackEndpoint(configuredEndpoint?: string) {
  return resolveLoopbackAutoPairEndpoint({
    platform: 'web',
    appOrigin: 'http://127.0.0.1:8081',
    ...(configuredEndpoint === undefined ? {} : { configuredEndpoint }),
  });
}

function nextTask(delayMs = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

describe('web companion loopback startup', () => {
  it('stays connected with working credentials when the configured loopback port refuses connections', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'working-test-token',
      binding,
      lastSeq: 40,
    }));
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway();
    const client = new ControlPlaneClient({
      fetch: gateway.fetch,
      credentials,
      createWebSocket: gateway.createWebSocket,
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint(REFUSED_ORIGIN) });
    expect(gateway.sockets).toHaveLength(1);
    gateway.sockets[0]!.hello(40);

    expect(gateway.requests.filter((request) => request.includes(REFUSED_ORIGIN)))
      .toEqual([`POST ${REFUSED_ORIGIN}/v1/paired/loopback`]);
    expect(storedCredentials(storage)).toMatchObject({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'working-test-token',
      lastSeq: 40,
    });
    expect(gateway.sockets[0]!.url).toContain('ws://127.0.0.1:47130/v1/paired/events?');
    expect(runtime.control.getState()).toMatchObject({
      phase: 'ready',
      connectionState: 'connected',
      error: null,
      endpointMismatch: {
        configuredEndpoint: REFUSED_ORIGIN,
        activeEndpoint: WORKING_ORIGIN,
        error: 'Failed to fetch',
      },
    });
    expect(runtime.control.getState().ticketIds).toEqual([42]);
    runtime.stop();
  });

  it('refetches snapshots once after a fresh binding replays the event history', async () => {
    const storage = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway();
    const client = new ControlPlaneClient({
      fetch: gateway.fetch,
      credentials,
      createWebSocket: gateway.createWebSocket,
    });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/tickets`)).toBe(1);
    const socket = gateway.sockets[0]!;
    expect(new URL(socket.url).searchParams.get('after_seq')).toBe('0');

    // A fresh binding has cursor 0, so the gateway replays the whole history.
    // Each frame is its own task, as in a browser.
    socket.hello(30);
    for (let seq = 1; seq <= 30; seq += 1) {
      socket.receive(ticketUpdated(seq));
      await nextTask(1);
    }
    await nextTask(400);

    expect(storedCredentials(storage)?.lastSeq).toBe(30);
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/tickets`)).toBe(2);
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/overview`)).toBe(2);
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/projects`)).toBe(2);
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/agenda`)).toBe(2);
    runtime.stop();
  });

  // 2026-10-29 部署设置 → 模型时：网页先生效，旧 daemon 没有 GET /v1/models/settings，回 404。
  // 页面记成不支持（写明 daemon 还没更新），daemon 重启、重新连上（hello.v2）以后自动再取，不用刷新页面。
  it('marks model settings unsupported on an older daemon and fetches them once the restarted daemon says hello', async () => {
    let upgraded = false;
    const gateway = loopbackGateway((pathname) => (pathname === '/v1/models/settings' && upgraded ? json({ modelSettings: {
      brain: { chain: [{ model: 'vibeproxy/claude-sonnet-5', effort: null }], current: { model: 'vibeproxy/claude-sonnet-5', effort: null }, providers: [] },
      fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
      maxBackups: 3,
    } }) : null));
    const storage = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(storage);
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    const release = runtime.observeResource('model-settings');
    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(0);
    await vi.waitFor(() => expect(runtime.control.getState().resourceState['model-settings']).toMatchObject({
      state: 'unsupported', error: 'daemon_older_than_web',
    }));

    upgraded = true;
    gateway.sockets[0]!.hello(0);
    await vi.waitFor(() => expect(runtime.control.getState().resourceState['model-settings']).toMatchObject({ state: 'ready' }));
    expect(runtime.control.getState().modelSettings?.brain.current.model).toBe('vibeproxy/claude-sonnet-5');
    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/models/settings`)).toBe(2);
    release();
    runtime.stop();
  });

  // 第一次打开的是设置页的深链（/settings/connections）：页面先挂上，自动配对后来才完成。
  // 页面挂上时还没有凭证，资源被标成 unsupported；配对完成后要补取，不能一直停在「正在读取」。
  it('fetches a resource that a page observed before the first loopback pairing finished', async () => {
    const storage = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway();
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    const release = runtime.observeResource('connections');
    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(0);
    await nextTask();
    await nextTask();

    expect(gateway.count(`GET ${WORKING_ORIGIN}/v1/connections`)).toBe(1);
    expect(runtime.control.getState().resourceState.connections).toMatchObject({ state: 'ready' });
    release();
  });

  // 2026-11 第一次用：网页用 plc pair new 配的凭证（来历 admin_pairing），网关去掉了 approvals:respond，点批准回 403。
  // 开了 PLC_ALLOW_LOOPBACK_AUTO_PAIR=1 也没用：只有没凭证或 401 时才走回环自动配对。现在启动时就换一张能做决定的。
  const adminPairedBinding: BindingDto = {
    id: 3,
    kind: 'companion',
    name: 'Ethan 的浏览器',
    // 去掉了 approvals:respond 的 DEFAULT_SCOPES；这里只留假网关答得上的。
    scopes: ['chat', 'tickets:view'],
  };
  const missingDecisionScope = () => json({ error: {
    code: 'forbidden',
    message: 'missing scope: approvals:respond. Only the user decides, in the web page or on the paired phone',
  } }, 403);
  const bearer = (init?: RequestInit) => new Headers(init?.headers).get('authorization');

  it('swaps a stored credential that cannot decide for a loopback credential, so approving works', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: adminPairedBinding,
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway((pathname, init) => {
      if (pathname !== '/v1/approvals/5/resolve') return null;
      return bearer(init) === 'Bearer fresh-test-token' ? json({ ok: true }) : missingDecisionScope();
    });
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(0);

    expect(gateway.count(`POST ${WORKING_ORIGIN}/v1/paired/loopback`)).toBe(1);
    expect(storedCredentials(storage)).toMatchObject({ baseUrl: WORKING_ORIGIN, accessToken: 'fresh-test-token' });
    expect(gateway.sockets).toHaveLength(1);
    await expect(runtime.resolveApproval(5, 'approve')).resolves.toBeUndefined();
    runtime.stop();
  });

  // 设置 → 记忆的切换卡（reranker 改用决策模型、数据发去外部）也是用户的决定：换到本机网页的凭证以后，同意能生效。
  it('swaps a stored credential that cannot decide, so agreeing to a memory switch works', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: adminPairedBinding,
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    const applied: MemorySwitch = {
      id: 'msw_rerank00001', summary: 'reranker 改用决策模型', reason: '每次召回会把查询和最多 30 条记忆片段发给 api.example.com',
      needsConfirmation: true, dataFlows: [{ kind: 'rerank', host: 'api.example.com', maxCandidates: 30 }], parts: ['reranker'],
      state: 'applied', createdAt: '2026-10-16T09:00:00.000Z',
    };
    const memory: MemorySettingsDto = {
      embedding: {
        mode: 'unset',
        local: { model: 'acme/local-embedding', download: { model: 'acme/local-embedding', state: 'idle', bytes: 0, total: 0, error: null } },
        remote: { baseUrl: null, model: null, dimensions: null, apiKeySet: false, apiKeyHost: null },
      },
      reranker: {
        mode: 'decision', effective: 'decision',
        local: { model: 'acme/local-reranker', download: { model: 'acme/local-reranker', state: 'idle', bytes: 0, total: 0, error: null } },
        external: { host: 'api.example.com', maxCandidates: 30 },
      },
      service: { state: 'off', backend: 'hindsight', embedding: null, reranker: null, index: { notes: 0, indexed: 0 }, message: null },
      pendingSwitch: null,
    };
    const gateway = loopbackGateway((pathname, init) => {
      if (pathname !== '/v1/memory/switches/msw_rerank00001/confirm') return null;
      return bearer(init) === 'Bearer fresh-test-token' ? json({ memory, switch: applied }) : missingDecisionScope();
    });
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(0);

    await expect(runtime.confirmMemorySwitch('msw_rerank00001', true)).resolves.toMatchObject({ switch: { state: 'applied' } });
    expect(gateway.count(`POST ${WORKING_ORIGIN}/v1/memory/switches/msw_rerank00001/confirm`)).toBe(1);
    runtime.stop();
  });

  it('keeps the credential when loopback auto-pair is off and says what to do on a refused decision', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: adminPairedBinding,
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    // 没开 PLC_ALLOW_LOOPBACK_AUTO_PAIR：网关上没有回环配对的路由。
    const gateway = loopbackGateway((pathname) => {
      if (pathname === '/v1/paired/loopback') return json({ error: { code: 'not_found', message: 'not found' } }, 404);
      if (pathname === '/v1/approvals/5/resolve') return missingDecisionScope();
      return null;
    });
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(12);

    expect(storedCredentials(storage)).toMatchObject({ accessToken: 'admin-paired-test-token', lastSeq: 12 });
    expect(runtime.control.getState()).toMatchObject({ phase: 'ready', connectionState: 'connected', error: null });
    await expect(runtime.resolveApproval(5, 'approve')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('PLC_ALLOW_LOOPBACK_AUTO_PAIR=1'),
    });
    runtime.stop();
  });

  // 配对那时网关还没按来历去掉 approvals:respond：存着的 scope 里有，网关现在不给。以前启动时取审批回 403，整页进入错误。
  it('decides on the scopes the gateway gives now, not the ones stored at pairing time', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: { ...adminPairedBinding, scopes: ['chat', 'tickets:view', 'approvals:respond'] },
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway((pathname, init) => {
      const fresh = bearer(init) === 'Bearer fresh-test-token';
      if (pathname === '/v1/paired/me') return json({ binding: fresh ? binding : adminPairedBinding });
      if (pathname === '/v1/approvals' && !fresh) return missingDecisionScope();
      return null;
    });
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(0);

    expect(gateway.count(`POST ${WORKING_ORIGIN}/v1/paired/loopback`)).toBe(1);
    expect(storedCredentials(storage)).toMatchObject({ accessToken: 'fresh-test-token' });
    expect(runtime.control.getState()).toMatchObject({ phase: 'ready', connectionState: 'connected', error: null });
    runtime.stop();
  });

  // 网关不认这个页面是本机网页（origin 不在允许列表，回 403）：不能叫用户去开 PLC_ALLOW_LOOPBACK_AUTO_PAIR，它已经开了。
  it('names the origin allow-list when the gateway refuses this page as a local page', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: adminPairedBinding,
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway((pathname) => {
      if (pathname === '/v1/paired/loopback') {
        return json({ error: { code: 'forbidden', message: 'loopback auto-pair is not allowed for this request' } }, 403);
      }
      if (pathname === '/v1/approvals/5/resolve') return missingDecisionScope();
      return null;
    });
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start({ loopbackEndpoint: webLoopbackEndpoint() });
    gateway.sockets[0]!.hello(12);

    const refused = await runtime.resolveApproval(5, 'approve').catch((reason: unknown) => reason as Error);
    expect(refused).toMatchObject({ status: 403, message: expect.stringContaining('PLC_LOOPBACK_AUTO_PAIR_ORIGINS') });
    expect((refused as Error).message).not.toContain('PLC_ALLOW_LOOPBACK_AUTO_PAIR=1');
    runtime.stop();
  });

  // 不是本机网页（例如手机），存着的 scope 也是配对那时的：取审批回 403 不让整页进入错误，点决定时说去哪里做。
  it('stays usable when stored scopes are wider than the gateway gives, away from the local page', async () => {
    const storage = new MemoryKeyValueStorage();
    storage.values.set(CREDENTIAL_KEY, JSON.stringify({
      baseUrl: WORKING_ORIGIN,
      accessToken: 'admin-paired-test-token',
      binding: { ...adminPairedBinding, scopes: ['chat', 'tickets:view', 'approvals:respond'] },
      lastSeq: 12,
    }));
    const credentials = createJsonCredentialStore(storage);
    const gateway = loopbackGateway((pathname) => (
      pathname === '/v1/approvals' || pathname === '/v1/approvals/5/resolve' ? missingDecisionScope() : null
    ));
    const client = new ControlPlaneClient({ fetch: gateway.fetch, credentials, createWebSocket: gateway.createWebSocket });
    const runtime = createCompanionStateRuntime({ client, credentials, scheduler });

    await runtime.start();
    gateway.sockets[0]!.hello(12);

    expect(runtime.control.getState()).toMatchObject({ phase: 'ready', connectionState: 'connected', error: null });
    await expect(runtime.resolveApproval(5, 'approve')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('phone paired by QR code'),
    });
    runtime.stop();
  });
});
