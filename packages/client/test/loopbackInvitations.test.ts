// 本机网页给手机发扫码配对邀请（设置 → 设备 → 添加手机）在客户端里的包装：
// 请求带网页自己的凭证，响应按共享协议校验，状态查询用 POST。
import { describe, expect, it } from 'vitest';
import type { BindingDto, LoopbackInvitation } from '@pi-lead-child/protocol';

import type { ControlPlaneCredentials, CredentialStore } from '../src/credentialStore.ts';
import { ControlPlaneClient, ControlPlaneClientError } from '../src/controlPlaneClient.ts';

const binding: BindingDto = {
  id: 7, kind: 'companion', name: 'localhost-web',
  scopes: ['chat', 'tickets:view', 'tickets:create', 'approvals:respond', 'notices'],
};

function memoryCredentials(): CredentialStore {
  const record: ControlPlaneCredentials = { baseUrl: 'http://127.0.0.1:47130', accessToken: 'web-token', binding, lastSeq: 0 };
  return { load: async () => record, save: async () => {}, clear: async () => {} };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

interface Call { url: string; method: string; authorization: string | null; body: unknown }

function client(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call);
  };
  return { calls, client: new ControlPlaneClient({ fetch: fetcher as typeof fetch, credentials: memoryCredentials() }) };
}

const invitation: LoopbackInvitation = {
  pairingId: 12,
  expiresAt: '2026-10-17T04:15:00.000Z',
  uri: 'plc-pair://connect?v=2&pairing_id=12',
  qr: { size: 21, rows: Array.from({ length: 21 }, (_, y) => (y % 2 ? '1' : '0').repeat(21)) },
  endpoint: 'ws://192.168.1.20:47130',
  endpoints: ['ws://192.168.1.20:47130', 'ws://100.101.102.103:47130'],
};

describe('createLoopbackInvitation', () => {
  it('posts the name and the picked endpoint with the page’s own credential', async () => {
    const { calls, client: c } = client(() => response(invitation, 201));
    const created = await c.createLoopbackInvitation({ name: '手机', endpoint: 'ws://100.101.102.103:47130' });
    expect(created).toEqual(invitation);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:47130/v1/paired/loopback/invitations',
      method: 'POST',
      authorization: 'Bearer web-token',
      body: { name: '手机', endpoint: 'ws://100.101.102.103:47130' },
    }]);
  });

  it('refuses a response that does not match the shared protocol', async () => {
    for (const broken of [
      { ...invitation, qr: { size: 21, rows: ['01x'] } },
      { ...invitation, endpoints: [] },
      { ...invitation, code: 'PLC-ABCD' },
    ]) {
      const { client: c } = client(() => response(broken, 201));
      await expect(c.createLoopbackInvitation({ name: '手机' })).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('passes the gateway’s refusal through with its status and code', async () => {
    const { client: c } = client(() => response({
      error: { code: 'conflict', message: 'the gateway does not listen on a LAN address' },
    }, 409));
    const failure = await c.createLoopbackInvitation({ name: '手机' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlPlaneClientError);
    expect(failure).toMatchObject({ status: 409, code: 'conflict' });
  });
});

describe('getLoopbackInvitationStatus and cancelLoopbackInvitation', () => {
  it('posts to the status route and parses the state', async () => {
    const status = { pairingId: 12, state: 'redeemed', expiresAt: invitation.expiresAt };
    const { calls, client: c } = client(() => response(status));
    expect(await c.getLoopbackInvitationStatus(12)).toEqual(status);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:47130/v1/paired/loopback/invitations/12/status',
      method: 'POST',
      authorization: 'Bearer web-token',
      body: {},
    }]);
  });

  it('cancels through the cancel route and parses the state it reports', async () => {
    const revoked = { pairingId: 12, state: 'revoked', expiresAt: invitation.expiresAt };
    const { calls, client: c } = client(() => response(revoked));
    expect(await c.cancelLoopbackInvitation(12)).toEqual(revoked);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:47130/v1/paired/loopback/invitations/12/cancel',
      method: 'POST',
      authorization: 'Bearer web-token',
      body: {},
    }]);
    for (const id of [0, 2.5]) {
      await expect(c.cancelLoopbackInvitation(id)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toHaveLength(1);
  });

  it('refuses an unknown state and an invalid id', async () => {
    const { calls, client: c } = client(() => response({ pairingId: 12, state: 'paired', expiresAt: invitation.expiresAt }));
    await expect(c.getLoopbackInvitationStatus(12)).rejects.toMatchObject({ code: 'invalid_response' });
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(c.getLoopbackInvitationStatus(id)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toHaveLength(1);
  });
});
