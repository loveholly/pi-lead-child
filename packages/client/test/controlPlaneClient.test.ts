import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  buildSocketPairingUri,
  bytesToHex,
  createPairingKeyPair,
  derivePairingSessionKey,
  hashPairingSecret,
  hexToBytes,
  openPairingPayload,
  sealPairingPayload,
  type BindingDto,
  type TicketSummary,
} from '@pi-lead-child/protocol';

import { createJsonCredentialStore, type KeyValueStorage } from '../src/credentialStore.ts';
import {
  KERNEL_RESOURCE_CAPABILITIES,
  ControlPlaneClient,
  selectKernelResourceVersion,
  supportsKernelCapability,
  normalizeControlPlaneEndpoint,
  type ControlPlaneSocket,
} from '../src/controlPlaneClient.ts';

class MemoryKeyValueStorage implements KeyValueStorage {
  values = new Map<string, string>();

  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

class FakeSocket implements ControlPlaneSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'client closed' }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'network' }); }
}

const binding: BindingDto = {
  id: 7,
  kind: 'companion',
  name: 'phone',
  scopes: ['chat', 'tickets:view', 'approvals:respond'],
};

const ticketSummary: TicketSummary = {
  id: 42,
  title: '协议审计',
  summary: '核对控制面',
  kind: 'task',
  stage: 'active',
  status: 'active',
  hasRun: true,
  priority: 'high',
  project: 'pi-lead-child',
  dueAt: null,
  deferUntil: null,
  updatedAt: '2026-07-23T09:00:00.000Z',
  runtime: { state: 'running', lastActivityAt: '2026-07-23T09:00:00.000Z', activeAttemptId: 3 },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// generative UI（2026-10-15）：会话快照要带上每一轮的富交互卡片（include=surfaces）。
// 旧 daemon 不认识这个取值，回 400 invalid include：退回只要 tool_calls，会话照样能刷新。
describe('conversation turns with surfaces', () => {
  it('asks for surfaces, and falls back when an older daemon refuses the include', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.searchParams.get('include') ?? '');
      if (url.searchParams.get('include')?.includes('surfaces')) {
        return response({ error: { code: 'invalid_request', message: 'invalid include' } }, 400);
      }
      return response({ items: [] });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    await expect(client.getConversationTurns()).resolves.toEqual([]);
    expect(asked).toEqual([
      'tool_calls,surfaces,placement,reply_actions,images', 'tool_calls,surfaces,placement,reply_actions',
      'tool_calls,surfaces,placement', 'tool_calls,surfaces', 'tool_calls',
    ]);
  });

  // 工单 04：用户的消息怎么放的（include=placement）。只认识 surfaces 的 daemon 回 400：退回不要 placement。
  it('asks for placement, and keeps surfaces from a daemon that does not know placement', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.searchParams.get('include') ?? '');
      if (url.searchParams.get('include')?.includes('placement')) {
        return response({ error: { code: 'invalid_request', message: 'invalid include' } }, 400);
      }
      return response({ items: [] });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    await expect(client.getConversationTurns()).resolves.toEqual([]);
    expect(asked).toEqual([
      'tool_calls,surfaces,placement,reply_actions,images', 'tool_calls,surfaces,placement,reply_actions',
      'tool_calls,surfaces,placement', 'tool_calls,surfaces',
    ]);
  });

  // 2026-10-19：工单回复在问你要不要做的动作（include=reply_actions）。只认识 placement 的 daemon 回 400：退回不要它。
  it('asks for reply actions, and keeps placement from a daemon that does not know them', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: string[] = [];
    const turn = {
      id: 'turn_1', originBindingId: 7, originKind: 'paired:companion:ticket-agent', ticketId: 77, state: 'completed',
      userText: '进展？', assistantText: '要我派发核查吗？', error: null,
      createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:05.000Z',
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.searchParams.get('include') ?? '');
      if (url.searchParams.get('include')?.includes('reply_actions')) {
        return response({ error: { code: 'invalid_request', message: 'invalid include' } }, 400);
      }
      return response({ items: [turn] });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    await expect(client.getConversationTurns(77)).resolves.toEqual([turn]);
    expect(asked).toEqual([
      'tool_calls,surfaces,placement,reply_actions,images', 'tool_calls,surfaces,placement,reply_actions', 'tool_calls,surfaces,placement',
    ]);
  });
});

// 工单 06：「Lead 动态」的卡片和横幅（include=events）。旧 daemon 不认识这个参数，回旧的 items：换成卡片，没有横幅。
describe('Lead activity view', () => {
  async function clientWith(reply: (url: URL, init?: RequestInit) => Response) {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: Array<{ url: URL; method: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push({ url, method: init?.method ?? 'GET' });
      return reply(url, init);
    });
    return { client: new ControlPlaneClient({ fetch: fetcher, credentials }), asked };
  }

  it('asks for the cards, and turns an older daemon\'s items into cards', async () => {
    const { client, asked } = await clientWith(() => response({
      items: [{ id: 108, at: '2026-10-15T10:10:29.000Z', disposition: 'deferred', reason: '等最终结论一起说', summary: '核查报了缺陷', ticketId: 66 }],
    }));
    const view = await client.getLeadActivityView();
    // include=reminders（工单 07）：再要会话里的提醒卡。旧 daemon 不认识它，回的是旧的 items。
    expect(asked[0]!.url.searchParams.get('include')).toBe('events,reminders');
    expect(view).toEqual({
      watermark: 0, interrupts: [],
      cards: [expect.objectContaining({
        key: 'inbox:108', kind: 'lead', state: 'handled', ticketId: 66, summary: '核查报了缺陷',
        lead: { disposition: 'deferred', reason: '等最终结论一起说', at: '2026-10-15T10:10:29.000Z' },
      })],
    });
  });

  it('acknowledges an interrupt banner with a POST', async () => {
    const acknowledged = {
      key: 'interrupt:20', seq: 20, entityKey: 'reminder:5', entityVersion: 23, lastSeq: 22, at: '2026-10-17T01:05:00.000Z',
      ticketId: 5, kind: 'timer.fired', summary: '提醒「开会」到点', rootCause: null, basis: [],
      acknowledgedAt: '2026-10-17T01:06:00.000Z', resolvedElsewhere: false,
    };
    const { client, asked } = await clientWith(() => response({ interrupt: acknowledged }));
    await expect(client.acknowledgeLeadInterrupt(20)).resolves.toEqual(acknowledged);
    expect(asked.map((request) => [request.method, request.url.pathname])).toEqual([['POST', '/v1/lead/interrupts/20/ack']]);
  });
});

// 外部来源的会话卡带上代查（Slack 代查与按信心代回 spec D9，工单 01）：客户端按严格 schema 收卡，「改一下再发」带上文字。
describe('channel cards with a lookup', () => {
  const lookup = {
    id: 12, state: 'finished', playbook: 'lookup', repos: ['acme/orders'], ticketId: 482,
    startedAt: '2026-10-19T06:30:00.000Z', finishedAt: '2026-10-19T06:32:10.000Z',
    result: {
      found: 'partial', answer: '只在支付成功以后触发。', checked: ['acme/orders'], caveats: [],
      sources: [{ via: 'local', repo: 'acme/orders', path: 'src/a.ts', startLine: 1, endLine: 2, quote: 'if (!paid) return;', verified: true }],
      connectionSources: [], actions: [],
    },
    review: null, reads: { count: 1, items: [{ tool: 'read_file', repo: 'acme/orders', path: 'src/a.ts', bytes: 900, at: '2026-10-19T06:31:00.000Z' }] },
    confidence: { value: 0.6, threshold: 0.9, checks: [], vetoes: [], calibration: null },
    reply: { decision: 'ask_user', reasons: ['信心 0.6，低于 0.9'], at: '2026-10-19T06:32:12.000Z' },
    audience: { label: '#proj-x', externalShared: false }, ownerName: '李雷', newerMessages: 1, deniedReasons: [], error: null,
  };
  const card = {
    id: 7, version: 9, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:C0PROJ:1', laneLabel: '#proj-x',
    sender: { id: 'U0ZHANG', name: '张三', trust: 'colleague' }, excerpt: 'webhook 为什么没触发？', messageCount: 2,
    delivery: 'card', state: 'open', draft: { text: '订单还在待支付。', drafter: 'lookup' }, gate: null, lookup, handling: null,
    sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null, actions: ['send_draft', 'send_edited', 'dismiss'],
    createdAt: '2026-10-19T06:29:58.000Z', updatedAt: '2026-10-19T06:32:12.000Z',
  };

  async function clientWith(reply: (url: URL, init?: RequestInit) => Response) {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: Array<{ url: URL; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return reply(url, init);
    });
    return { client: new ControlPlaneClient({ fetch: fetcher, credentials }), asked };
  }

  it('accepts cards with a lookup or with lookup null, and refuses a card from a daemon that does not send it', async () => {
    const { client } = await clientWith(() => response({ items: [card, { ...card, id: 8, lookup: null }] }));
    expect((await client.getChannelCards()).map((item) => item.lookup?.id ?? null)).toEqual([12, null]);
    const { lookup: _lookup, ...older } = card;
    const { client: strict } = await clientWith(() => response({ items: [older] }));
    await expect(strict.getChannelCards()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('sends the edited text with send_edited, and no text field otherwise', async () => {
    const { client, asked } = await clientWith(() => response({ card }));
    await expect(client.actOnChannelCard(7, 'send_edited', 9, '我改过的回复')).resolves.toMatchObject({ id: 7, lookup: { id: 12 } });
    await client.actOnChannelCard(7, 'cancel_lookup', 9);
    expect(asked.map((request) => [request.method, request.url.pathname, request.body])).toEqual([
      ['POST', '/v1/channels/cards/7/actions', { action: 'send_edited', expectedVersion: 9, text: '我改过的回复' }],
      ['POST', '/v1/channels/cards/7/actions', { action: 'cancel_lookup', expectedVersion: 9 }],
    ]);
  });
});

describe('control-plane client', () => {
  it('normalizes daemon endpoints without leaking query or hash state', () => {
    expect(normalizeControlPlaneEndpoint('127.0.0.1:47130/')).toBe('http://127.0.0.1:47130');
    expect(normalizeControlPlaneEndpoint('https://control.example.com/plc/?token=bad#x'))
      .toBe('https://control.example.com/plc');
    expect(() => normalizeControlPlaneEndpoint('file:///tmp/plc.sock')).toThrow('http or https');
  });

  it('redeems pairing credentials and stores only the client-side connection record', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:47130/v1/paired/redeem');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ pairing_code: 'PLC-ABCD-EFGH' });
      return response({ binding, access_token: 'access-secret' }, 201);
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    const paired = await client.pair('127.0.0.1:47130', 'plc-abcd-efgh');

    expect(paired).toEqual({ baseUrl: 'http://127.0.0.1:47130', accessToken: 'access-secret', binding, lastSeq: 0 });
    expect(await credentials.load()).toEqual(paired);
    expect(JSON.stringify(await credentials.load())).not.toContain('token_hash');
  });

  it('requests a loopback binding and stores the returned credentials', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:47130/v1/paired/loopback');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'localhost-web' });
      return response({ binding, access_token: 'loopback-secret' }, 201);
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    const paired = await client.pairLoopback('http://127.0.0.1:47130');

    expect(paired).toEqual({
      baseUrl: 'http://127.0.0.1:47130',
      accessToken: 'loopback-secret',
      binding,
      lastSeq: 0,
    });
    expect(await credentials.load()).toEqual(paired);
  });

  it('pairs over an encrypted LAN WebSocket invitation and persists only the accepted credentials', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    const daemon = createPairingKeyPair(new Uint8Array(32).fill(3));
    const clientSecret = new Uint8Array(32).fill(9);
    const confirmNonce = new Uint8Array(24).fill(13);
    const pairingSecret = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const invitation = buildSocketPairingUri({
      endpoint: 'ws://172.16.9.13:47130',
      pairingId: 42,
      pairingSecret,
      daemonPublicKey: daemon.publicKey,
    });
    const sockets: FakeSocket[] = [];
    const randomValues = [clientSecret, confirmNonce];
    const client = new ControlPlaneClient({
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      randomBytes: async (length) => {
        const value = randomValues.shift();
        expect(value?.length).toBe(length);
        return value!;
      },
    });

    const pairing = client.pairSocket(invitation);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    const hello = JSON.parse(sockets[0].sent[0]);
    expect(hello).toMatchObject({
      type: 'pair.hello',
      protocolVersion: PROTOCOL_VERSION,
      pairingId: 42,
      clientPublicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const sessionKey = derivePairingSessionKey(
      daemon.secretKey,
      hexToBytes(hello.clientPublicKey),
      hashPairingSecret(pairingSecret),
    );
    sockets[0].receive({
      type: 'pair.challenge',
      protocolVersion: PROTOCOL_VERSION,
      daemonPublicKey: bytesToHex(daemon.publicKey),
      envelope: sealPairingPayload({
        type: 'pair.challenge',
        pairingId: 42,
        challenge: 'a'.repeat(48),
        expiresAt: '2026-07-23T10:00:00.000Z',
      }, sessionKey, new Uint8Array(24).fill(7)),
    });

    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
    const confirm = JSON.parse(sockets[0].sent[1]);
    expect(openPairingPayload(confirm.envelope, sessionKey)).toEqual({
      type: 'pair.confirm',
      pairingId: 42,
      challenge: 'a'.repeat(48),
    });
    sockets[0].receive({
      type: 'pair.accepted',
      protocolVersion: PROTOCOL_VERSION,
      envelope: sealPairingPayload({
        type: 'pair.accepted',
        binding,
        access_token: 'socket-secret',
      }, sessionKey, new Uint8Array(24).fill(8)),
    });

    await expect(pairing).resolves.toEqual({
      baseUrl: 'http://172.16.9.13:47130',
      accessToken: 'socket-secret',
      binding,
      lastSeq: 0,
    });
    expect(await credentials.load()).toEqual(await pairing);
    expect(JSON.stringify(await credentials.load())).not.toContain(pairingSecret);
  });

  it('loads snapshots with bearer auth and surfaces stable protocol errors', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      if (String(input).endsWith('/v1/tickets')) return response({ items: [ticketSummary] });
      return response({ error: { code: 'forbidden', message: 'missing scope' } }, 403);
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    expect(await client.getTickets()).toEqual([ticketSummary]);
    await expect(client.getApprovals()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('uses a one-time WS ticket, correlates commands, and persists the replay cursor', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'https://daemon.test/plc', accessToken: 'secret', binding, lastSeq: 7 });
    const fetcher = vi.fn(async () => response({ ws_ticket: 'wst_once', expires_at: '2026-07-23T10:00:00.000Z' }, 201));
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const events: any[] = [];
    const states: string[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: (url) => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket; },
      createCommandId: () => 'cmd-1',
    });

    await client.connect({ onEvent: (event) => events.push(event), onStateChange: (state) => states.push(state) });
    // include=lead_health：选收 Lead 健康（带 lead 的 daemon.status.changed）。
    // include=lead_activity：选收「Lead 动态」的推送（工单 06）。
    // include=ui_surfaces：选收 Lead 生成的富交互卡片（带 surface 的 lead.tool.updated，2026-10-15）。
    // include=reply_actions：选收工单回复的动作按钮有了判断结果（2026-10-19）。
    // include=lead_queue：选收 Lead 忙时排着的外部消息（工单 10）。
    expect(urls).toEqual(['wss://daemon.test/plc/v1/paired/events?ticket=wst_once&protocol=2&after_seq=7&include=lead_health%2Cui_surfaces%2Clead_activity%2Creply_actions%2Clead_queue']);
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-23T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 8, capabilities: ['event-replay'], binding,
      daemon: { model: 'openai/gpt-5.6-sol', sessionId: 'session-1', busy: false },
    });

    const command = client.sendChat('继续核对', 42);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: 'chat.send', id: 'cmd-1', protocolVersion: 2,
      message: '继续核对', context: { ticketId: 42 },
    });
    sockets[0].receive({ type: 'command.result', id: 'cmd-1', success: true, data: { mode: 'started', turnId: 'turn-1' } });
    await expect(command).resolves.toEqual({ mode: 'started', turnId: 'turn-1' });

    sockets[0].receive({
      protocolVersion: 2, eventId: 'evt-8', seq: 8, type: 'ticket.updated',
      occurredAt: '2026-07-23T09:00:01.000Z', requiredScope: 'tickets:view',
      audienceBindingId: null, turnId: null, ticketId: 42, payload: { snapshotRequired: true },
    });
    await vi.waitFor(async () => expect((await credentials.load())?.lastSeq).toBe(8));
    expect(events.map((event) => event.eventId)).toEqual(['evt-8']);
    expect(states).toContain('connected');
    client.disconnect();
  });

  it('enters reconnecting state and resumes from the latest persisted sequence', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 11 });
    const fetcher = vi.fn(async () => response({ ws_ticket: `wst_${fetcher.mock.calls.length}`, expires_at: '2026-07-23T10:00:00.000Z' }, 201));
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const states: string[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });

    await client.connect({ onStateChange: (state) => states.push(state) });
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-23T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 11, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 's', busy: false },
    });
    sockets[0].disconnect();
    expect(states.at(-1)).toBe('reconnecting');

    timers.at(-1)!();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  // 凭证被拒（签 ws ticket 时 401，或者连着时 binding 被撤销、按 4001 断开）不会自己好：
  // 停止重连，告诉调用方一次，不要每隔 30 秒重试一遍。
  it('stops reconnecting and reports once when the gateway rejects the credential', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async () => response({ error: { code: 'unauthorized', message: 'invalid token' } }, 401));
    const timers: (() => void)[] = [];
    const states: string[] = [];
    const rejected: Error[] = [];
    const protocolErrors: Error[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => new FakeSocket(),
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });

    await client.connect({
      onStateChange: (state) => states.push(state),
      onCredentialRejected: (error) => rejected.push(error),
      onProtocolError: (error) => protocolErrors.push(error),
    });
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { status?: number }).status).toBe(401);
    expect(protocolErrors).toEqual([]);
    expect(states.at(-1)).toBe('disconnected');
    expect(timers).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // 存着的局域网地址上可能是别的设备在回答（例如 IP 换了主人）。它的 401 不是网关拒绝了凭证：照常重连。
  it('keeps reconnecting on a 401 that does not come from the gateway', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://192.168.1.20:47130', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async () => new Response('<html>login required</html>', { status: 401, headers: { 'content-type': 'text/html' } }));
    const timers: (() => void)[] = [];
    const states: string[] = [];
    const rejected: Error[] = [];
    const protocolErrors: Error[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => new FakeSocket(),
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });

    await client.connect({
      onStateChange: (state) => states.push(state),
      onCredentialRejected: (error) => rejected.push(error),
      onProtocolError: (error) => protocolErrors.push(error),
    });
    expect(rejected).toEqual([]);
    expect(protocolErrors).toHaveLength(1);
    expect(states.at(-1)).toBe('reconnecting');
    expect(timers).toHaveLength(1);
    client.disconnect();
  });

  it('stops reconnecting when the gateway closes the socket because the binding was revoked', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async () => response({ ws_ticket: 'wst_1', expires_at: '2026-07-23T10:00:00.000Z' }, 201));
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const states: string[] = [];
    const rejected: Error[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });

    await client.connect({ onStateChange: (state) => states.push(state), onCredentialRejected: (error) => rejected.push(error) });
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-23T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 0, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 's', busy: false },
    });
    const heartbeatTimers = timers.length;
    sockets[0].readyState = 3;
    sockets[0].onclose?.({ code: 4001, reason: 'binding revoked' });
    expect(rejected).toHaveLength(1);
    expect(states.at(-1)).toBe('disconnected');
    expect(timers.length).toBe(heartbeatTimers);
    expect(sockets).toHaveLength(1);
  });

  it('detects a half-open socket with the application heartbeat and reconnects', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async () => response({ ws_ticket: `wst_${fetcher.mock.calls.length}`, expires_at: '2026-07-23T10:00:00.000Z' }, 201));
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const states: string[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
      heartbeatIntervalMs: 1,
      heartbeatTimeoutMs: 1,
    });

    await client.connect({ onStateChange: (state) => states.push(state) });
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-23T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 0, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });

    timers[0]!();
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1));
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: 'status.get' });
    timers.at(-1)!();
    await vi.waitFor(() => expect(states.at(-1)).toBe('reconnecting'));
    client.disconnect();
  });

  it('accepts a runtime-owned chat command ID and validates the turn result', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const sockets: FakeSocket[] = [];
    const client = new ControlPlaneClient({
      fetch: async () => response({ ws_ticket: 'wst_once', expires_at: '2026-07-24T10:00:00.000Z' }, 201),
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    await client.connect();
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-24T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 0, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });

    const command = client.sendChatCommand({ id: 'runtime-command', message: '继续', ticketId: 42 });
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ id: 'runtime-command', message: '继续' });
    sockets[0].receive({
      type: 'command.result', id: 'runtime-command', success: true,
      data: { mode: 'started', turnId: 'turn-runtime' },
    });

    await expect(command).resolves.toEqual({ turnId: 'turn-runtime' });
    client.disconnect();
  });

  it('falls back to HTTP when a runtime-owned chat command has no live socket', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://daemon.test/v1/chat/send');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      expect(JSON.parse(String(init?.body))).toEqual({
        id: 'runtime-command',
        message: '这个单需要我干什么',
        context: { ticketId: 49 },
      });
      return response({ mode: 'started', turnId: 'turn-http' });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await expect(client.sendChatCommand({
      id: 'runtime-command',
      message: '这个单需要我干什么',
      ticketId: 49,
    })).resolves.toEqual({ turnId: 'turn-http' });
  });

  it('falls back to HTTP when a connected runtime-owned chat command times out', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/v1/paired/ws-ticket')) {
        return response({ ws_ticket: 'wst_once', expires_at: '2026-07-24T10:00:00.000Z' }, 201);
      }
      if (String(input).endsWith('/v1/chat/send')) {
        return response({ mode: 'started', turnId: 'turn-http-timeout' });
      }
      throw new Error(`unexpected URL ${String(input)}`);
    });
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
      commandTimeoutMs: 1,
    });
    await client.connect();
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-24T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 0, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });

    const command = client.sendChatCommand({ id: 'runtime-command', message: '继续处理', ticketId: 49 });
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: 'chat.send',
      id: 'runtime-command',
      message: '继续处理',
      context: { ticketId: 49 },
    });
    timers.at(-1)!();

    await expect(command).resolves.toEqual({ turnId: 'turn-http-timeout' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://daemon.test/v1/chat/send',
      expect.objectContaining({ method: 'POST' }),
    );
    client.disconnect();
  });

  it('aborts HTTP pairing before credentials can be persisted', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new ControlPlaneClient({ fetch: fetcher as typeof fetch, credentials });
    const controller = new AbortController();

    const pairing = client.pair('http://daemon.test', 'PLC-ABCD-EFGH', controller.signal);
    controller.abort();

    await expect(pairing).rejects.toMatchObject({ name: 'AbortError' });
    expect(await credentials.load()).toBeNull();
  });

  it('recovers from a failed cursor save without applying the event or poisoning replay', async () => {
    let record = { baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 };
    let failNextCursorSave = true;
    const credentials = {
      async load() { return record; },
      async save(next: typeof record) {
        if (next.lastSeq > 0 && failNextCursorSave) {
          failNextCursorSave = false;
          throw new Error('disk full');
        }
        record = next;
      },
      async clear() {},
    };
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const events: string[] = [];
    const errors: string[] = [];
    const client = new ControlPlaneClient({
      fetch: async () => response({ ws_ticket: `wst_${sockets.length}`, expires_at: '2026-07-24T10:00:00.000Z' }, 201),
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    });
    await client.connect({
      onEvent: (seen) => events.push(seen.eventId),
      onProtocolError: (error) => errors.push(error.message),
    });
    sockets[0].open();
    sockets[0].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-24T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 1, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });
    sockets[0].receive({
      protocolVersion: 2, eventId: 'event-1', seq: 1, type: 'ticket.updated',
      occurredAt: '2026-07-24T09:00:01.000Z', requiredScope: 'tickets:view',
      audienceBindingId: null, turnId: null, ticketId: 42, payload: { snapshotRequired: true },
    });

    await vi.waitFor(() => expect(errors).toContain('failed to persist replay cursor'));
    expect(events).toEqual([]);
    expect(record.lastSeq).toBe(0);
    expect(timers.length).toBeGreaterThanOrEqual(2);

    timers.at(-1)!();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].open();
    sockets[1].receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-07-24T09:00:02.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 1, capabilities: [], binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });
    sockets[1].receive({
      protocolVersion: 2, eventId: 'event-1-replay', seq: 1, type: 'ticket.updated',
      occurredAt: '2026-07-24T09:00:03.000Z', requiredScope: 'tickets:view',
      audienceBindingId: null, turnId: null, ticketId: 42, payload: { snapshotRequired: true },
    });
    await vi.waitFor(() => expect(events).toEqual(['event-1-replay']));
    expect(record.lastSeq).toBe(1);
    client.disconnect();
  });

  it('loads additive kernel resources with exact cursor and repeated filter parameters', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      if (url.includes('/checkpoints')) {
        return response({ items: [], hasMore: false, nextBeforeId: null });
      }
      if (url.includes('/work-items')) return response({ items: [] });
      if (url.includes('/workbench')) return response({ invalid: true });
      if (url.includes('/interventions')) return response({ items: [] });
      return response({ items: [], checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await client.getKernelCheckpoints(42, { afterId: 12, limit: 50 });
    await client.getKernelWorkItems([55, 42]);
    await expect(client.getKernelTicketWorkbench(42)).rejects.toMatchObject({ code: 'invalid_response' });
    await client.getKernelInterventions({ ticketId: 42, state: 'pending', ids: ['approval:7', 'decision:8'] });
    await client.getKernelConversationCards({
      ticketIds: [42, 55],
      keys: ['checkpoint:12', 'turn:turn-1:ticket:42'],
      beforeId: 20,
      limit: 10,
    });

    expect(seen).toEqual([
      'http://daemon.test/v1/kernel/tickets/42/checkpoints?after_id=12&limit=50',
      'http://daemon.test/v1/kernel/work-items?ticket_id=55&ticket_id=42',
      'http://daemon.test/v1/kernel/tickets/42/workbench',
      'http://daemon.test/v1/kernel/interventions?ticket_id=42&state=pending&id=approval%3A7&id=decision%3A8',
      'http://daemon.test/v1/kernel/conversation/cards?ticket_id=42&ticket_id=55&key=checkpoint%3A12&key=turn%3Aturn-1%3Aticket%3A42&before_id=20&limit=10',
    ]);
  });

  it('addresses each fidelity resource through its independently negotiated version', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/checkpoints')) return response({ items: [], hasMore: false, nextBeforeId: null });
      if (url.includes('/work-items')) return response({ items: [] });
      if (url.includes('/workbench')) return response({ invalid: true });
      if (url.endsWith('/artifacts')) return response({ items: [] });
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await client.getKernelCheckpoints(42, {}, undefined, 2);
    await client.getKernelWorkItems([], undefined, 2);
    await expect(client.getKernelTicketWorkbench(42, undefined, 2))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await client.getKernelArtifacts(42);

    expect(seen).toEqual([
      'http://daemon.test/v1/kernel/v2/tickets/42/checkpoints',
      'http://daemon.test/v1/kernel/v2/work-items',
      'http://daemon.test/v1/kernel/v2/tickets/42/workbench',
      'http://daemon.test/v1/kernel/v1/tickets/42/artifacts',
    ]);
  });

  it('validates artifact download headers, bytes, and SHA before returning content', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const bytes = new TextEncoder().encode('artifact payload\n');
    const sha256 = 'b4cd19480a364f7591933eb93a7072f937e11e6def3ab21fc85aa175b0070e08';
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(bytes.byteLength),
          'content-disposition': "attachment; filename*=UTF-8''report%20final.txt",
          'x-artifact-id': '9',
          'x-artifact-sha256': sha256,
        },
      });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await expect(client.downloadArtifact(42, 9)).resolves.toEqual({
      bytes: expect.any(ArrayBuffer),
      filename: 'report final.txt',
      mediaType: 'text/plain',
      byteLength: bytes.byteLength,
      sha256,
    });

    const badClient = new ControlPlaneClient({
      credentials,
      fetch: async () => new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(bytes.byteLength),
          'content-disposition': "attachment; filename*=UTF-8''report.txt",
          'x-artifact-id': '9',
          'x-artifact-sha256': '0'.repeat(64),
        },
      }),
    });
    await expect(badClient.downloadArtifact(42, 9)).rejects.toMatchObject({ code: 'integrity_error' });
  });

  it('checks artifact integrity with an injected SHA-256 on platforms without WebCrypto', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const bytes = new TextEncoder().encode('artifact payload\n');
    const sha256 = 'b4cd19480a364f7591933eb93a7072f937e11e6def3ab21fc85aa175b0070e08';
    const fetcher = async () => new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(bytes.byteLength),
        'content-disposition': "attachment; filename*=UTF-8''report.txt",
        'x-artifact-id': '9',
        'x-artifact-sha256': sha256,
      },
    });
    const digests: number[] = [];
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      sha256: async (input) => {
        digests.push(input.byteLength);
        return new Uint8Array(sha256.match(/../g)!.map((pair) => parseInt(pair, 16))).buffer;
      },
    });

    await expect(client.downloadArtifact(42, 9)).resolves.toMatchObject({ sha256 });
    expect(digests).toEqual([bytes.byteLength]);
  });

  it('resolves an intervention with an explicit command id and supports cancellation', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://daemon.test/v1/kernel/interventions/decision%3A8/resolve');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('cmd-decision-8');
      expect(JSON.parse(String(init?.body))).toEqual({
        authority: 'decision_request',
        decision: 'select',
        optionId: 'staging',
      });
      return response({ status: 'resolved', interventionId: 'decision:8' });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await expect(client.resolveKernelIntervention(
      'decision:8',
      { authority: 'decision_request', decision: 'select', optionId: 'staging' },
      'cmd-decision-8',
    )).resolves.toEqual({ status: 'resolved', interventionId: 'decision:8' });

    const controller = new AbortController();
    controller.abort();
    await expect(client.getKernelCheckpoints(42, {}, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('posts user control-plane actions and ticket relation mutations without an actor field', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const calls: { url: string; method?: string; body: unknown; auth: string | null }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        body: JSON.parse(String(init?.body ?? '{}')),
        auth: new Headers(init?.headers).get('authorization'),
      });
      if (String(input).includes('/relations')) {
        return response({
          status: String(input).endsWith('/revoke') ? 'revoked' : 'created',
          relationId: 9,
          sourceTicketId: 18,
          targetTicketId: 22,
          relationType: 'duplicates',
          requestedRelationType: 'duplicates',
          active: !String(input).endsWith('/revoke'),
          risks: ['canonical: #22 is the canonical ticket; #18 remains separate history'],
          schedulingImpact: null,
          canonicalImpact: '#22 is canonical for duplicate #18',
        });
      }
      return response({ ticketId: 18, action: 'confirm', ticket: null });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await client.performTicketAction(18, 'confirm');
    await client.performTicketAction(18, 'cancel', { reason: '不做了' });
    await client.performTicketAction(18, 'restore', {
      restoreMode: 'selected_children',
      childTicketIds: [19, 20],
    });
    await client.linkTicketRelation(18, {
      targetTicketId: 22,
      relationType: 'duplicates',
      reason: 'same user request',
    });
    await client.revokeTicketRelation(18, 9, { reason: 'not a duplicate' });

    expect(calls[0]).toEqual({
      url: 'http://daemon.test/v1/tickets/18/confirm',
      method: 'POST',
      body: {},
      auth: 'Bearer secret',
    });
    // actor 不出现在请求体里：这条平面只以 user 身份行事，服务端的 assertUserActor
    // 会拒掉任何别的取值，客户端更不该提供那个参数位。
    expect(calls[0]!.body).not.toHaveProperty('actor');
    expect(calls[1]!.url).toBe('http://daemon.test/v1/tickets/18/cancel');
    expect(calls[1]!.body).toEqual({ reason: '不做了' });
    expect(calls[2]).toMatchObject({
      url: 'http://daemon.test/v1/tickets/18/restore',
      method: 'POST',
      body: { mode: 'selected_children', child_ticket_ids: [19, 20] },
    });
    expect(calls[3]).toEqual({
      url: 'http://daemon.test/v1/tickets/18/relations',
      method: 'POST',
      body: { targetTicketId: 22, relationType: 'duplicates', reason: 'same user request' },
      auth: 'Bearer secret',
    });
    expect(calls[3]!.body).not.toHaveProperty('actor');
    expect(calls[4]).toEqual({
      url: 'http://daemon.test/v1/tickets/18/relations/9/revoke',
      method: 'POST',
      body: { reason: 'not a duplicate' },
      auth: 'Bearer secret',
    });
  });

  it('reads and acknowledges notification outbox entries', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const calls: { url: string; method?: string; auth: string | null }[] = [];
    const notification = {
      id: 9,
      ticketId: 42,
      kind: 'review_failed',
      dedupKey: 'review-failed:test',
      urgency: 'immediate' as const,
      title: 'review failed',
      body: 'needs rework',
      state: 'pending' as const,
      createdAt: '2026-08-14T01:00:00.000Z',
      deliveredAt: null,
      deliveredVia: null,
      ackedAt: null,
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        auth: new Headers(init?.headers).get('authorization'),
      });
      if (String(input).endsWith('/ack')) {
        return response({
          notification: { ...notification, state: 'acked' as const, ackedAt: '2026-08-14T01:01:00.000Z' },
        });
      }
      return response({ items: [notification] });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await expect(client.getNotifications(['pending', 'delivered'])).resolves.toEqual([notification]);
    await expect(client.ackNotification(9)).resolves.toMatchObject({ id: 9, state: 'acked' });
    expect(calls).toEqual([
      {
        url: 'http://daemon.test/v1/notifications?state=pending&state=delivered',
        auth: 'Bearer secret',
      },
      {
        url: 'http://daemon.test/v1/notifications/9/ack',
        method: 'POST',
        auth: 'Bearer secret',
      },
    ]);
  });

  it('posts Lead delegation grants and revocations through the user control plane', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const calls: { url: string; method?: string; body: unknown; auth: string | null }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        body: JSON.parse(String(init?.body ?? '{}')),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return response({ ticketId: 18, granted: Boolean((calls[calls.length - 1]?.body as { granted?: boolean }).granted) });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });

    await client.setLeadDelegation(18, true, {
      maxReworkCycles: 2,
      requireContinuation: true,
      requiredCapabilityId: 7,
      startRework: true,
      acceptWithoutReview: true,
    });
    await client.setLeadDelegation(18, false, { reason: 'revoked from test' });

    expect(calls).toEqual([
      {
        url: 'http://daemon.test/v1/lead/delegation',
        method: 'POST',
        body: {
          ticket_id: 18,
          granted: true,
          max_rework_cycles: 2,
          require_continuation: true,
          required_capability_id: 7,
          start_rework: true,
          accept_without_review: true,
        },
        auth: 'Bearer secret',
      },
      {
        url: 'http://daemon.test/v1/lead/delegation',
        method: 'POST',
        body: { ticket_id: 18, granted: false, reason: 'revoked from test' },
        auth: 'Bearer secret',
      },
    ]);
    expect(calls[0]!.body).not.toHaveProperty('actor');
    expect(calls[1]!.body).not.toHaveProperty('actor');
  });

  it('paginates the activity ledger instead of presenting the first 500 rows as complete history', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const ledger = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      ticketId: 19,
      attemptId: null,
      actor: 'system' as const,
      kind: 'transition',
      payload: { from: 'ready', to: 'active', reason: `event ${index + 1}` },
      sessionCursor: null,
      createdAt: `2026-08-11T00:00:00.${String(index).padStart(3, '0')}Z`,
    }));
    const calls: string[] = [];
    const client = new ControlPlaneClient({
      credentials,
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url.toString());
        const afterId = Number(url.searchParams.get('after_id') ?? 0);
        return response({ items: ledger.filter((item) => item.id > afterId).slice(0, 500) });
      },
    });

    await expect(client.getActivities(19)).resolves.toHaveLength(501);
    expect(calls).toEqual([
      'http://daemon.test/v1/tickets/19/activities?after_id=0&limit=500',
      'http://daemon.test/v1/tickets/19/activities?after_id=500&limit=500',
    ]);
  });

  it('surfaces a refused action as a typed protocol error instead of resolving', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const client = new ControlPlaneClient({
      credentials,
      fetch: async () => response(
        { error: { code: 'forbidden', message: "actor 'lead' may not transition draft -> ready" } },
        403,
      ),
    });
    await expect(client.performTicketAction(18, 'confirm'))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('fails closed on malformed additive snapshots and exposes capability fallback checks', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const client = new ControlPlaneClient({
      fetch: async () => response({ items: [{ id: 'not-a-checkpoint' }], hasMore: false, nextBeforeId: null }),
      credentials,
    });

    await expect(client.getKernelCheckpoints(42)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(KERNEL_RESOURCE_CAPABILITIES).toEqual({
      checkpoints: { 2: 'kernel.checkpoints.v2', 1: 'kernel.checkpoints.v1' },
      interventions: { 1: 'kernel.interventions.v1' },
      workItems: { 2: 'kernel.work-items.v2', 1: 'kernel.work-items.v1' },
      ticketWorkbench: { 2: 'kernel.ticket-workbench.v2', 1: 'kernel.ticket-workbench.v1' },
      artifacts: { 1: 'kernel.artifacts.v1' },
      conversationCards: { 1: 'kernel.conversation-cards.v1' },
    });
    expect(supportsKernelCapability(['event-replay', 'kernel.checkpoints.v1'], 'checkpoints')).toBe(true);
    expect(supportsKernelCapability(['event-replay'], 'checkpoints')).toBe(false);
    expect(selectKernelResourceVersion(['kernel.checkpoints.v1'], 'checkpoints')).toBe(1);
    expect(selectKernelResourceVersion(['kernel.checkpoints.v1', 'kernel.checkpoints.v2'], 'checkpoints')).toBe(2);
    expect(selectKernelResourceVersion(['kernel.checkpoints.v2', 'kernel.work-items.v1'], 'workItems')).toBe(1);
    expect(selectKernelResourceVersion([], 'artifacts')).toBeNull();
  });

  it('posts workspace actions through the shared user control route without an actor', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new ControlPlaneClient({
      credentials,
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return response({
          workspaceId: 7, ownerTicketId: 42, action: 'release', status: 'released', ticket: ticketSummary,
        });
      },
    });

    const result = await client.performWorkspaceAction(7, 'release');

    expect(result).toMatchObject({ workspaceId: 7, ownerTicketId: 42, action: 'release', status: 'released' });
    expect(calls).toEqual([{
      url: 'http://daemon.test/v1/workspaces/7/release', method: 'POST', body: {},
    }]);
    expect(calls[0]!.body).not.toHaveProperty('actor');
  });

  // 复审 2026-10-27 B：清理隔离 worktree 不可逆，服务端要求 confirm: true。客户端要能把就地确认发出去。
  it('sends the in-place confirmation with a workspace cleanup', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const calls: Array<{ url: string; body?: unknown }> = [];
    const client = new ControlPlaneClient({
      credentials,
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return response({ workspaceId: 7, ownerTicketId: 42, action: 'cleanup', status: 'cleaned', ticket: ticketSummary });
      },
    });

    await client.performWorkspaceAction(7, 'cleanup', { confirm: true, reason: '确认删掉 worktree' });
    await client.performWorkspaceAction(7, 'cleanup');

    expect(calls).toEqual([
      { url: 'http://daemon.test/v1/workspaces/7/cleanup', body: { reason: '确认删掉 worktree', confirm: true } },
      { url: 'http://daemon.test/v1/workspaces/7/cleanup', body: {} },
    ]);
  });

  // 2026-10-21 审查 M2：合并、开 PR、放弃时带上用户看到的交付。服务端比对，交付变了返回 409（stale）。
  it('posts a delivery action with the head and target the user saw', async () => {
    const keyValue = new MemoryKeyValueStorage();
    const credentials = createJsonCredentialStore(keyValue);
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const head = 'a'.repeat(40);
    const unavailable = { available: false, reason: '改动已经合并。' };
    const delivery = {
      ticketId: 42, attemptId: null, source: 'isolated', files: [], truncated: false, totals: null,
      workspace: {
        workspaceId: 7, branch: 'plc/item-42', head, target: 'main', commits: 0, uncommittedFiles: 0,
        integration: 'merged', mergedInto: 'main', pullRequestUrl: null,
      },
      actions: { merge: { ...unavailable, acceptsTicket: false }, openPullRequest: unavailable, abandon: unavailable },
    };
    const calls: Array<{ url: string; body?: unknown }> = [];
    const client = new ControlPlaneClient({
      credentials,
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return response({ action: 'merge', delivery });
      },
    });

    await client.performDeliveryAction(42, 'merge', { expected: { head, target: 'main' } });
    await client.performDeliveryAction(42, 'merge');
    expect(calls).toEqual([
      { url: 'http://daemon.test/v1/tickets/42/delivery/merge', body: { expectedHead: head, expectedTarget: 'main' } },
      { url: 'http://daemon.test/v1/tickets/42/delivery/merge', body: {} },
    ]);
  });

});

// 2026-10-16：用户的 3 条消息从来没到 daemon。Mac 合盖睡眠，手机或另一个标签页的 WebSocket 半开着，
// 客户端以为还连着。现在回到前台、标签页可见、网络恢复时，客户端马上探一次连接，几秒内转成"重连中"。
// 发件箱重发时带稳定的 clientMessageId，daemon 按它去重；旧 daemon 不认识这个字段，只在它宣布能力时才带。
describe('a link that may be dead', () => {
  async function connectedClient(capabilities: string[], extra: { fetch?: typeof fetch } = {}) {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const sockets: FakeSocket[] = [];
    const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
    const states: string[] = [];
    const fetcher = extra.fetch ?? vi.fn(async () => response({ ws_ticket: 'wst', expires_at: '2026-10-16T10:00:00.000Z' }, 201));
    const client = new ControlPlaneClient({
      fetch: fetcher,
      credentials,
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs, cleared: false }); return timers.length - 1; },
      clearTimeout: (handle) => { const timer = timers[handle as number]; if (timer) timer.cleared = true; },
    });
    await client.connect({ onStateChange: (state) => states.push(state) });
    sockets[0]!.open();
    sockets[0]!.receive({
      type: 'hello.v2', protocolVersion: 2, serverTime: '2026-10-16T09:00:00.000Z',
      timezone: 'Asia/Shanghai', latestSeq: 0, capabilities, binding,
      daemon: { model: 'stub', sessionId: 'session-1', busy: false },
    });
    return { client, sockets, timers, states };
  }

  it('sends the client message id only to a daemon that advertises it', async () => {
    const old = await connectedClient([]);
    void old.client.sendChatCommand({ id: 'cmd-1', message: '在吗', clientMessageId: 'msg_1' }).catch(() => {});
    expect(JSON.parse(old.sockets[0]!.sent.at(-1)!)).not.toHaveProperty('clientMessageId');
    old.client.disconnect();

    const current = await connectedClient(['chat.client-message-id.v1']);
    const sent = current.client.sendChatCommand({ id: 'cmd-2', message: '在吗', clientMessageId: 'msg_1' });
    expect(JSON.parse(current.sockets[0]!.sent.at(-1)!)).toMatchObject({ id: 'cmd-2', clientMessageId: 'msg_1' });
    current.sockets[0]!.receive({
      type: 'command.result', id: 'cmd-2', success: true, data: { mode: 'started', turnId: 'turn-1', duplicate: true },
    });
    await expect(sent).resolves.toEqual({ turnId: 'turn-1', duplicate: true });
    current.client.disconnect();
  });

  // 工单 04：Lead 正忙时插话还是排队（mode）。旧 daemon 严格校验命令、不认识这个字段：只在它宣布能力时才带。
  it('sends the placement only to a daemon that advertises it', async () => {
    const old = await connectedClient(['chat.client-message-id.v1']);
    void old.client.sendChatCommand({ id: 'cmd-1', message: '排队问', clientMessageId: 'msg_1', mode: 'followUp' }).catch(() => {});
    expect(JSON.parse(old.sockets[0]!.sent.at(-1)!)).not.toHaveProperty('mode');
    old.client.disconnect();

    const current = await connectedClient(['chat.client-message-id.v1', 'chat.placement.v1']);
    void current.client.sendChatCommand({ id: 'cmd-2', message: '排队问', clientMessageId: 'msg_2', mode: 'followUp' }).catch(() => {});
    expect(JSON.parse(current.sockets[0]!.sent.at(-1)!)).toMatchObject({ id: 'cmd-2', mode: 'followUp' });
    current.client.disconnect();
  });

  // 2026-10-19：工单对话一律交给工单的 agent。即使 daemon 还宣布 chat.ticket-answerer.v1（工单 08 第一版），
  // 客户端也只带工单号，不带回答者。
  it('sends only the ticket id as the chat context', async () => {
    const current = await connectedClient(['chat.client-message-id.v1', 'chat.ticket-answerer.v1']);
    void current.client.sendChatCommand({ id: 'cmd-2', message: '进展？', ticketId: 77 }).catch(() => {});
    expect(JSON.parse(current.sockets[0]!.sent.at(-1)!).context).toEqual({ ticketId: 77 });
    current.client.disconnect();
  });

  // 2026-10-25：发给 Lead 的图片（protocol 的 chat-images.ts）。旧 daemon 严格校验命令、不收图片：只发文字会丢掉图片，
  // 所以整条拒收（发件箱标成发送失败，用户可以删掉它）。
  it('sends images only to a daemon that accepts them, and refuses the message otherwise', async () => {
    const images = [{ mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
    const old = await connectedClient(['chat.client-message-id.v1']);
    await expect(old.client.sendChatCommand({ id: 'cmd-1', message: '看图', images }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(old.sockets[0]!.sent.some((frame) => JSON.parse(frame).type === 'chat.send')).toBe(false);
    old.client.disconnect();

    const current = await connectedClient(['chat.client-message-id.v1', 'chat.images.v1']);
    void current.client.sendChatCommand({ id: 'cmd-2', message: '', images }).catch(() => {});
    expect(JSON.parse(current.sockets[0]!.sent.at(-1)!)).toMatchObject({ id: 'cmd-2', message: '', images });
    void current.client.sendChatCommand({ id: 'cmd-3', message: '只有字', images: [] }).catch(() => {});
    expect(JSON.parse(current.sockets[0]!.sent.at(-1)!)).not.toHaveProperty('images');
    current.client.disconnect();
  });

  it('keeps the images on the HTTP fallback', async () => {
    const images = [{ mimeType: 'image/jpeg' as const, data: '/9j/4AAQ' }];
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/send')) {
        bodies.push(JSON.parse(String(init?.body)));
        return response({ mode: 'started', turnId: 'turn-http' });
      }
      return response({ ws_ticket: 'wst', expires_at: '2026-10-16T10:00:00.000Z' }, 201);
    });
    const { client, sockets } = await connectedClient(['chat.images.v1'], { fetch: fetcher as unknown as typeof fetch });
    sockets[0]!.disconnect();
    await expect(client.sendChatCommand({ id: 'cmd-1', message: '看图', clientMessageId: 'msg_1', images }))
      .resolves.toEqual({ turnId: 'turn-http' });
    expect(bodies).toEqual([{ id: 'cmd-1', message: '看图', clientMessageId: 'msg_1', images }]);
    client.disconnect();
  });

  // 页面打开时，会话快照在 hello.v2 之前就取了（2026-10-25 在浏览器里看到：刷新以后图片不见了）。所以不看能力，
  // 总是先要 images；旧 daemon 回 400 时退回。
  it('asks for the images of the conversation before it knows the capabilities, and reads one image by id', async () => {
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/conversation/turns') {
        asked.push(url.searchParams.get('include') ?? '');
        return response({ items: [] });
      }
      if (url.pathname === '/v1/chat/images/img_1') return response({ id: 'img_1', mimeType: 'image/png', data: 'iVBORw0KGgo=' });
      return response({ ws_ticket: 'wst', expires_at: '2026-10-16T10:00:00.000Z' }, 201);
    });
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    // 还没有连上 WebSocket，不知道 daemon 的能力。
    const client = new ControlPlaneClient({ fetch: fetcher as unknown as typeof fetch, credentials });
    await client.getConversationTurns();
    await expect(client.getChatImage('img_1')).resolves.toEqual({ id: 'img_1', mimeType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(asked).toEqual(['tool_calls,surfaces,placement,reply_actions,images']);
  });

  it('keeps the client message id on the HTTP fallback', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const bodies: unknown[] = [];
    const client = new ControlPlaneClient({
      credentials,
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({ mode: 'started', turnId: 'turn-http' });
      }),
    });
    await expect(client.sendChatCommand({ id: 'cmd-1', message: '在吗', clientMessageId: 'msg_1' }))
      .resolves.toEqual({ turnId: 'turn-http' });
    expect(bodies).toEqual([{ id: 'cmd-1', message: '在吗', clientMessageId: 'msg_1' }]);
  });

  it('turns a half-open socket into "reconnecting" as soon as a check gets no answer', async () => {
    const { client, sockets, timers, states } = await connectedClient([]);
    const alive = client.checkConnection(3_000);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({ type: 'status.get' });
    // 3 秒内没有回答：不等 socket 自己报告关闭（半开的 socket 可能很久都不报），马上转成重连中。
    timers.find((timer) => timer.delayMs === 3_000 && !timer.cleared)!.callback();
    await expect(alive).resolves.toBe(false);
    expect(states.at(-1)).toBe('reconnecting');
    // 下一次重连在 1 秒后，不沿用之前的退避。
    expect(timers.filter((timer) => !timer.cleared).at(-1)!.delayMs).toBe(1_000);
    client.disconnect();
  });

  it('keeps a live socket when the check is answered', async () => {
    const { client, sockets, states } = await connectedClient([]);
    const alive = client.checkConnection(3_000);
    const probe = JSON.parse(sockets[0]!.sent.at(-1)!);
    sockets[0]!.receive({ type: 'command.result', id: probe.id, success: true, data: {} });
    await expect(alive).resolves.toBe(true);
    expect(states.at(-1)).toBe('connected');
    client.disconnect();
  });

  it('reconnects at once, without waiting for the backoff, when the link may be back', async () => {
    const { client, sockets, timers, states } = await connectedClient([]);
    sockets[0]!.disconnect();
    expect(states.at(-1)).toBe('reconnecting');
    // 回到前台：不等退避的计时器，马上重连。
    await client.checkConnection(3_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(timers.filter((timer) => timer.delayMs === 1_000).every((timer) => timer.cleared)).toBe(true);
    client.disconnect();
  });

  it('drops the socket at once when the device goes offline', async () => {
    const { client, states } = await connectedClient([]);
    client.connectionLost('offline');
    expect(states.at(-1)).toBe('reconnecting');
    client.disconnect();
  });
});

// 发布评审 f796c1c：chat 的 HTTP 兜底没有期限。网络半通时这次请求可能一直挂着，发件箱的发送也一直占着，后面的消息都发不出去。
// 现在 20 秒没有回答就当超时：发件箱按临时错误退避以后再发（同一个 clientMessageId，daemon 去重）。
describe('the HTTP fallback for chat', () => {
  it('gives up after its deadline instead of hanging', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    let aborted = false;
    const client = new ControlPlaneClient({
      credentials,
      setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length - 1; },
      clearTimeout: () => {},
      fetch: vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
      })),
    });
    const sending = client.sendChatCommand({ id: 'cmd-1', message: '在吗', clientMessageId: 'msg_1' });
    await vi.waitFor(() => expect(timers.some((timer) => timer.delayMs === 20_000)).toBe(true));
    timers.find((timer) => timer.delayMs === 20_000)!.callback();
    await expect(sending).rejects.toMatchObject({ code: 'timeout' });
    expect(aborted).toBe(true);
  });
});

// 工单详情（工单 12）：按钮能不能点读操作清单（工单 03），点的时候走同一个操作；执行计划读工单 06 的接口。
describe('ticket actions and the execution plan', () => {
  async function clientWith(reply: (url: URL, init?: RequestInit) => Response) {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: Array<{ url: URL; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return reply(url, init);
    });
    return { client: new ControlPlaneClient({ fetch: fetcher, credentials }), asked };
  }

  const pause = {
    id: 'pause_run', label: '暂停', area: 'execution', permission: 'user_only', external: false, irreversible: false,
    undoable: false, available: false, reason: '没有正在运行的 Run 可以暂停。',
  };

  it('lists what the ticket can do now, with the reason when it cannot', async () => {
    const { client, asked } = await clientWith(() => response({ ticketId: 42, actions: [pause] }));
    await expect(client.listTicketActions(42)).resolves.toEqual([pause]);
    expect(asked.map((request) => [request.method, request.url.pathname])).toEqual([['GET', '/v1/tickets/42/actions']]);
  });

  it('runs an action with its input and reason, and no actor', async () => {
    const { client, asked } = await clientWith(() => response({ ticketId: 42, action: 'rework', result: { ok: true }, ticket: ticketSummary }));
    await expect(client.runTicketAction(42, 'rework', { reason: '第 2 条没做到' })).resolves.toMatchObject({ action: 'rework' });
    await client.runTicketAction(42, 'set_priority', { input: { priority: 'high' } });
    expect(asked.map((request) => [request.method, request.url.pathname, request.body])).toEqual([
      ['POST', '/v1/tickets/42/actions/rework', { reason: '第 2 条没做到' }],
      ['POST', '/v1/tickets/42/actions/set_priority', { input: { priority: 'high' } }],
    ]);
  });

  it('reads the execution plan, and null when the agent submitted none', async () => {
    const plan = {
      ticketId: 42, revision: 2, attemptId: 3, createdAt: '2026-10-21T07:04:00.000Z', updatedAt: '2026-10-21T07:18:00.000Z',
      steps: [{ id: 'survey', title: '现状剖析', status: 'in_progress', note: null }],
    };
    const { client, asked } = await clientWith((url) => response({ plan: url.pathname.includes('/43/') ? null : plan }));
    await expect(client.getTicketExecutionPlan(42)).resolves.toEqual(plan);
    await expect(client.getTicketExecutionPlan(43)).resolves.toBeNull();
    expect(asked.map((request) => request.url.pathname)).toEqual(['/v1/tickets/42/plan', '/v1/tickets/43/plan']);
  });
});

// 2026-10-26：会话输入框右下角的模型选择。目录和切换各一个请求，响应按共享的协议校验。
describe('Lead model choice', () => {
  it('reads the model catalog and switches the model with its effort', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: Array<{ method: string; path: string; body: unknown }> = [];
    const catalog = {
      current: { model: 'vibeproxy/claude-sonnet-5', effort: null },
      selected: { model: 'vibeproxy/claude-sonnet-5', effort: null },
      models: [{
        model: 'vibeproxy/as4/claude-sonnet-5', provider: 'vibeproxy', id: 'as4/claude-sonnet-5', prefix: 'as4', source: 'anthropic',
        name: null, image: true, efforts: ['low', 'high'], defaultEffort: null, blockedUntil: null,
      }],
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === '/v1/lead/models') return response(catalog);
      return response({
        previous: catalog.selected, selected: { model: 'vibeproxy/as4/claude-sonnet-5', effort: 'high' }, applied: 'after_turn',
      });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    await expect(client.getLeadModels()).resolves.toEqual(catalog);
    await expect(client.switchLeadModel({ model: 'vibeproxy/as4/claude-sonnet-5', effort: 'high' }))
      .resolves.toMatchObject({ applied: 'after_turn' });
    expect(asked).toEqual([
      { method: 'GET', path: '/v1/lead/models', body: null },
      { method: 'POST', path: '/v1/lead/model', body: { model: 'vibeproxy/as4/claude-sonnet-5', effort: 'high' } },
    ]);
  });
});

// 2026-10-28：状态栏上排着的追问的「Steer」和「×」。一个请求，响应按共享的协议校验。
describe('queued follow-up actions', () => {
  it('posts the turn id to the action and reads the placement back', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: Array<{ method: string; path: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as { turnId: string } : null;
      asked.push({ method: init?.method ?? 'GET', path: url.pathname, body });
      return response({ turnId: body?.turnId, placement: url.pathname.endsWith('/steer') ? 'steered' : 'cancelled' });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    await expect(client.followUpAction('steer', 'turn_c')).resolves.toEqual({ turnId: 'turn_c', placement: 'steered' });
    await expect(client.followUpAction('cancel', 'turn_b')).resolves.toEqual({ turnId: 'turn_b', placement: 'cancelled' });
    expect(asked).toEqual([
      { method: 'POST', path: '/v1/lead/follow-ups/steer', body: { turnId: 'turn_c' } },
      { method: 'POST', path: '/v1/lead/follow-ups/cancel', body: { turnId: 'turn_b' } },
    ]);
  });
});
