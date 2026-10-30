// plc 用到的网关路由在客户端里的包装。plc 只依赖这个包和 protocol，所以每条路由都要在这里有一个
// 按共享协议校验响应的方法。
import { describe, expect, it, vi } from 'vitest';
import type { BindingDto } from '@pi-lead-child/protocol';

import type { ControlPlaneCredentials, CredentialStore } from '../src/credentialStore.ts';
import { ControlPlaneClient, ControlPlaneClientError, type ControlPlaneSocket } from '../src/controlPlaneClient.ts';

const binding: BindingDto = {
  id: 9, kind: 'cli', name: 'plc',
  scopes: ['chat', 'tickets:view', 'tickets:create', 'approvals:respond', 'notices', 'admin'],
};

function memoryCredentials(lastSeq = 0): CredentialStore & { record: ControlPlaneCredentials | null } {
  const store = {
    record: { baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq } as ControlPlaneCredentials | null,
    async load() { return store.record; },
    async save(value: ControlPlaneCredentials) { store.record = value; },
    async clear() { store.record = null; },
  };
  return store;
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

interface Call { url: string; method: string; body: unknown }

function client(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call);
  };
  return { calls, client: new ControlPlaneClient({ fetch: fetcher as typeof fetch, credentials: memoryCredentials() }) };
}

const kernelTicket = {
  id: 31, title: '写周报', brief: '整理本周进展', body: '', status: 'ready', priority: 'normal',
  project: null, projectId: null, parentTicketId: null, rootTicketId: 31, createdByAttemptId: null,
  orchestrationState: 'none', requestedRuntime: null, requestedModel: null, purpose: null,
  maxDepth: null, maxChildren: null, maxConcurrency: null, tokenBudget: null, costBudgetUsd: null, retryLimit: null,
  activePlanRevision: null, workdir: null, createdBy: 'user', createdAt: '2026-10-13T04:00:00.000Z',
  updatedAt: '2026-10-13T04:00:00.000Z', lastActivityAt: null, totalTokens: 0, totalCostUsd: 0,
  dueAt: null, remindAt: null,
};

const grant = {
  id: 2, capability: 'confirm_item', granted_at: '2026-10-13 04:00:00', granted_via: 'cli',
  revoked_at: null, revoked_via: null, note: '私人助理',
};

describe('ticket routes', () => {
  it('creates a ticket as the user and validates the kernel ticket', async () => {
    const { calls, client: c } = client(() => response(kernelTicket, 201));
    const created = await c.createTicket({ title: '写周报', brief: '整理本周进展', priority: 'normal' });
    expect(created.id).toBe(31);
    expect(calls[0]).toEqual({
      url: 'http://daemon.test/v1/tickets', method: 'POST',
      body: { title: '写周报', brief: '整理本周进展', priority: 'normal' },
    });
  });

  it('lists tickets by view', async () => {
    const { calls, client: c } = client(() => response({ items: [] }));
    await c.listTickets({ view: 'drafts' });
    await c.listTickets();
    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon.test/v1/tickets?view=drafts',
      'http://daemon.test/v1/tickets',
    ]);
  });
});

describe('lead trust and delegation', () => {
  it('reads and changes the confirm_item grant', async () => {
    const { calls, client: c } = client((call) => call.method === 'GET'
      ? response({ capability: 'confirm_item', grant })
      : response(call.body && (call.body as { granted: boolean }).granted
        ? { capability: 'confirm_item', granted: true, grant }
        : { capability: 'confirm_item', granted: false, revoked: 1, grant: null }));
    expect((await c.getLeadTrust()).grant?.id).toBe(2);
    expect(await c.setLeadTrust(true, { note: '私人助理' })).toMatchObject({ granted: true });
    expect(await c.setLeadTrust(false)).toEqual({ capability: 'confirm_item', granted: false, revoked: 1, grant: null });
    expect(calls.map(({ method, url, body }) => [method, url, body])).toEqual([
      ['GET', 'http://daemon.test/v1/lead/trust?capability=confirm_item', undefined],
      ['POST', 'http://daemon.test/v1/lead/trust', { capability: 'confirm_item', granted: true, note: '私人助理' }],
      ['POST', 'http://daemon.test/v1/lead/trust', { capability: 'confirm_item', granted: false }],
    ]);
  });

  it('reads the delegation status of a ticket', async () => {
    const { calls, client: c } = client(() => response({ ticketId: 5, active: null, history: [] }));
    expect(await c.getLeadDelegation(5)).toEqual({ ticketId: 5, active: null, history: [] });
    expect(calls[0]!.url).toBe('http://daemon.test/v1/lead/delegation?ticket_id=5');
  });

  it('keeps the response body of a refused delegation so the caller can show the blockers', async () => {
    const preflight = { canAccept: false, blockers: ['没有结构化 continuation'], warnings: [], status: 'blocked' };
    const { client: c } = client(() => response({
      error: { code: 'delegation_preflight_failed', message: 'delegation cannot close the unattended workflow' },
      preflight,
    }, 409));
    const error = await c.setLeadDelegation(5, true).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ControlPlaneClientError);
    expect(error).toMatchObject({ status: 409, body: { preflight } });
  });
});

describe('runtime recheck', () => {
  it('rechecks one runtime or all of them', async () => {
    const results = [{ incidentId: 4, runtime: 'codex', outcome: 'canary_armed', summary: '重检通过' }];
    const { calls, client: c } = client(() => response({ results }));
    expect(await c.recheckRuntimes('codex')).toEqual(results);
    await c.recheckRuntimes();
    expect(calls.map((call) => call.body)).toEqual([{ runtime: 'codex' }, {}]);
    expect(calls[0]!.url).toBe('http://daemon.test/v1/runtimes/recheck');
  });
});

describe('admin routes', () => {
  it('manage pairings and bindings', async () => {
    const adminBinding = {
      id: 3, kind: 'companion', name: 'phone', status: 'active', scopes: ['chat'],
      lastSeenAt: null, createdAt: '2026-10-13T04:00:00.000Z',
    };
    const { calls, client: c } = client((call) => {
      if (call.url.endsWith('/v1/admin/pairings')) {
        return response({ pairingId: 1, code: 'PLC-ABCD', expiresAt: '2026-10-13T04:15:00.000Z', uri: null }, 201);
      }
      if (call.url.endsWith('/revoke')) return response({ binding: { ...adminBinding, status: 'revoked' } });
      return response({ items: [adminBinding] });
    });
    expect((await c.createPairing({ name: 'phone', kind: 'companion' })).code).toBe('PLC-ABCD');
    expect(await c.listBindings()).toEqual([adminBinding]);
    expect((await c.revokeBinding(3)).status).toBe('revoked');
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST http://daemon.test/v1/admin/pairings',
      'GET http://daemon.test/v1/admin/bindings',
      'POST http://daemon.test/v1/admin/bindings/3/revoke',
    ]);
  });

  it('reads and forgets the aish credential', async () => {
    const { calls, client: c } = client((call) => call.method === 'GET'
      ? response({ stored: false, url: null, failure: null, envToken: 'unset' })
      : response({ removed: false, envTokenSet: false }));
    expect((await c.getAishStatus()).stored).toBe(false);
    expect(await c.forgetAish()).toEqual({ removed: false, envTokenSet: false });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET http://daemon.test/v1/admin/aish',
      'POST http://daemon.test/v1/admin/aish/forget',
    ]);
  });

  it('fails closed when a response does not match the protocol', async () => {
    const { client: c } = client(() => response({ stored: false, url: null, failure: null, envToken: 'unset', token: 'x' }));
    await expect(c.getAishStatus()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('a live-only event stream', () => {
  it('asks the gateway for after_seq=-1 when the stored cursor is -1', async () => {
    const urls: string[] = [];
    const socket: ControlPlaneSocket = {
      readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const c = new ControlPlaneClient({
      credentials: memoryCredentials(-1),
      fetch: (async () => response({ ws_ticket: 'wst_once', expires_at: '2026-10-13T04:00:30.000Z' }, 201)) as typeof fetch,
      createWebSocket: (url) => { urls.push(url); return socket; },
    });
    await c.connect();
    c.disconnect();
    expect(new URL(urls[0]!).searchParams.get('after_seq')).toBe('-1');
  });
});

describe('the gateway address', () => {
  it('is resolved again for every request and every socket, never cached', async () => {
    const urls = ['http://127.0.0.1:47130', 'http://127.0.0.1:51000'];
    let next = 0;
    const requested: string[] = [];
    const sockets: string[] = [];
    const socket: ControlPlaneSocket = {
      readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send() {}, close() {},
    };
    const c = new ControlPlaneClient({
      credentials: memoryCredentials(),
      resolveBaseUrl: async () => urls[Math.min(next++, urls.length - 1)]!,
      fetch: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return String(input).endsWith('/v1/paired/ws-ticket')
          ? response({ ws_ticket: 'wst_once', expires_at: '2026-10-13T04:00:30.000Z' }, 201)
          : response({ items: [] });
      }) as typeof fetch,
      createWebSocket: (url) => { sockets.push(url); return socket; },
    });
    await c.listTickets();
    await c.connect();
    c.disconnect();
    expect(requested[0]).toBe('http://127.0.0.1:47130/v1/tickets');
    expect(requested[1]).toBe('http://127.0.0.1:51000/v1/paired/ws-ticket');
    expect(new URL(sockets[0]!).host).toBe('127.0.0.1:51000');
    // 存下来的 baseUrl（http://daemon.test）一次都没用到。
    expect([...requested, ...sockets].some((url) => url.includes('daemon.test'))).toBe(false);
  });

  it('tells a credential which binding it is', async () => {
    const { calls, client: c } = client(() => response({ binding }));
    expect(await c.getOwnBinding()).toEqual(binding);
    expect(calls[0]!.url).toBe('http://daemon.test/v1/paired/me');
  });
});

describe('presence', () => {
  const hello = {
    type: 'hello.v2', protocolVersion: 2, serverTime: '', timezone: 'UTC', latestSeq: 0, capabilities: [],
    binding, daemon: { model: 'm', sessionId: 's', busy: false },
  };

  function socketFactory() {
    const created: Array<ControlPlaneSocket & { sent: string[]; open(): void; receive(value: unknown): void; drop(): void }> = [];
    const create = () => {
      const socket = {
        readyState: 0, sent: [] as string[], onopen: null as (() => void) | null, onmessage: null as ((event: { data: unknown }) => void) | null,
        onerror: null, onclose: null as ((event: { code?: number }) => void) | null,
        send(data: string) { this.sent.push(data); },
        close() { this.readyState = 3; },
        open() { this.readyState = 1; this.onopen?.(); },
        receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); },
        drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); },
      };
      created.push(socket);
      return socket;
    };
    return { created, create };
  }

  it('tells the gateway whether someone is looking, and again after every reconnect', async () => {
    const sockets = socketFactory();
    const timers: Array<() => void> = [];
    const c = new ControlPlaneClient({
      credentials: memoryCredentials(),
      fetch: (async () => response({ ws_ticket: 'wst', expires_at: '2026-10-13T04:00:30.000Z' }, 201)) as typeof fetch,
      createWebSocket: () => sockets.create(),
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });
    c.setPresence(true);
    await c.connect();
    const first = sockets.created[0]!;
    first.open();
    first.receive(hello);
    const presence = (socket: { sent: string[] }) => socket.sent.map((raw) => JSON.parse(raw)).filter((command) => command.type === 'presence.set');
    expect(presence(first)).toMatchObject([{ type: 'presence.set', protocolVersion: 2, attended: true }]);
    c.setPresence(false);
    expect(presence(first).map((command) => command.attended)).toEqual([true, false]);

    first.drop();
    timers.pop()!(); // 断线之后最后排上的是重连定时器
    await vi.waitFor(() => expect(sockets.created).toHaveLength(2));
    const second = sockets.created[1]!;
    second.open();
    second.receive(hello);
    expect(presence(second).map((command) => command.attended)).toEqual([false]);
    c.disconnect();
  });

  it('says nothing until the caller sets a presence', async () => {
    const sockets = socketFactory();
    const c = new ControlPlaneClient({
      credentials: memoryCredentials(),
      fetch: (async () => response({ ws_ticket: 'wst', expires_at: '2026-10-13T04:00:30.000Z' }, 201)) as typeof fetch,
      createWebSocket: () => sockets.create(),
    });
    await c.connect();
    sockets.created[0]!.open();
    sockets.created[0]!.receive(hello);
    expect(sockets.created[0]!.sent.filter((raw) => raw.includes('presence.set'))).toEqual([]);
    c.disconnect();
  });
});
