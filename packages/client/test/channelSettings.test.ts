// 设置页「消息通道」在客户端里的包装（契约在 packages/protocol/src/channel-settings.ts）：
// 四个方法的路由和请求体，响应按共享协议校验，PUT 没通过时 400 的 details（检查结果）交给调用方。
import { describe, expect, it } from 'vitest';
import type { BindingDto, ChannelSecretsTestResult, ChannelSourceSettingsDto } from '@pi-lead-child/protocol';

import type { ControlPlaneCredentials, CredentialStore } from '../src/credentialStore.ts';
import { ChannelSecretsRejectedError, ControlPlaneClient, ControlPlaneClientError } from '../src/controlPlaneClient.ts';

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

interface Call { url: string; method: string; contentType: string | null; body: unknown }

function client(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call);
  };
  return { calls, client: new ControlPlaneClient({ fetch: fetcher as typeof fetch, credentials: memoryCredentials() }) };
}

const source: ChannelSourceSettingsDto = {
  source: 'slack',
  label: 'Slack',
  status: 'connected',
  account: { userId: 'U1', userName: 'bin', teamId: 'T1', teamName: 'Acme' },
  missingScopes: [],
  lastError: null,
  lastConnectedAt: '2026-10-20T03:00:00.000Z',
  secrets: [
    { name: 'PLC_SLACK_APP_TOKEN', label: 'App-Level Token', prefix: 'xapp-', hint: 'Basic Information → App-Level Tokens', present: true, origin: 'vault' },
    { name: 'PLC_SLACK_USER_TOKEN', label: 'User OAuth Token', prefix: 'xoxp-', hint: 'OAuth & Permissions', present: true, origin: 'keychain' },
  ],
  manifest: 'display_information:\n  name: test',
  setupUrl: 'https://api.slack.com/apps',
  editable: true,
};

const failed: ChannelSecretsTestResult = {
  ok: false,
  checks: [
    { id: 'user_token_kind', label: '用户令牌', pass: false, detail: '这是 bot token，要的是你本人的 user token。' },
    { id: 'socket_mode', label: 'Socket Mode', pass: true, detail: '能打开连接。' },
  ],
  account: null,
  missingScopes: ['chat:write'],
};

const secrets = { PLC_SLACK_APP_TOKEN: 'xapp-test-value', PLC_SLACK_USER_TOKEN: 'xoxp-test-value' };

describe('getChannelSettings', () => {
  it('reads every source from the settings route', async () => {
    const { calls, client: c } = client(() => response({ sources: [source] }));
    expect(await c.getChannelSettings()).toEqual({ sources: [source] });
    expect(calls).toMatchObject([{ url: 'http://127.0.0.1:47130/v1/channels/settings', method: 'GET' }]);
  });

  it('refuses a response that does not match the shared protocol', async () => {
    for (const broken of [
      { sources: [{ ...source, status: 'online' }] },
      // 响应里多一个字段（例如密钥的值）也不收。
      { sources: [{ ...source, secrets: [{ ...source.secrets[0], value: 'xapp-leaked' }] }] },
      { items: [source] },
    ]) {
      const { client: c } = client(() => response(broken));
      await expect(c.getChannelSettings()).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('testChannelSecrets', () => {
  it('posts the secrets to the source’s test route and returns the checks', async () => {
    const passed: ChannelSecretsTestResult = { ok: true, checks: [], account: source.account, missingScopes: [] };
    const { calls, client: c } = client(() => response(passed));
    expect(await c.testChannelSecrets('slack', secrets)).toEqual(passed);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:47130/v1/channels/settings/slack/test',
      method: 'POST',
      contentType: 'application/json',
      body: { secrets },
    }]);
  });

  it('returns failed checks as a result, whether they come back as 200 or as a 400 with details', async () => {
    const ok200 = client(() => response(failed));
    expect(await ok200.client.testChannelSecrets('slack', secrets)).toEqual(failed);
    const as400 = client(() => response({ error: { code: 'invalid_request', message: 'checks failed', details: failed } }, 400));
    expect(await as400.client.testChannelSecrets('slack', secrets)).toEqual(failed);
  });

  it('passes other refusals through, for example a page that is not on this Mac', async () => {
    const { client: c } = client(() => response({ error: { code: 'forbidden', message: 'only the local web UI' } }, 403));
    const failure = await c.testChannelSecrets('slack', secrets).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlPlaneClientError);
    expect(failure).not.toBeInstanceOf(ChannelSecretsRejectedError);
    expect(failure).toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('saveChannelSecrets', () => {
  it('puts the secrets on the source and returns its new state', async () => {
    const { calls, client: c } = client(() => response({ source }));
    expect(await c.saveChannelSecrets('slack', secrets)).toEqual(source);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:47130/v1/channels/settings/slack',
      method: 'PUT',
      contentType: 'application/json',
      body: { secrets },
    }]);
  });

  it('hands the failed checks of a 400 to the caller: nothing was saved', async () => {
    const { client: c } = client(() => response({ error: { code: 'invalid_request', message: 'checks failed', details: failed } }, 400));
    const failure = await c.saveChannelSecrets('slack', secrets).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelSecretsRejectedError);
    expect(failure).toBeInstanceOf(ControlPlaneClientError);
    expect(failure).toMatchObject({ status: 400, code: 'invalid_request', result: failed });
  });

  it('keeps a 400 without checks a plain error, for example an unknown secret name', async () => {
    const { client: c } = client(() => response({
      error: { code: 'invalid_request', message: 'unknown secret name', details: { reason: 'invalid_request' } },
    }, 400));
    const failure = await c.saveChannelSecrets('slack', secrets).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlPlaneClientError);
    expect(failure).not.toBeInstanceOf(ChannelSecretsRejectedError);
    expect(failure).toMatchObject({ status: 400, message: 'unknown secret name' });
  });

  it('refuses a response that does not match the shared protocol', async () => {
    const { client: c } = client(() => response({ source: { ...source, editable: 'yes' } }));
    await expect(c.saveChannelSecrets('slack', secrets)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('clearChannelSecrets', () => {
  it('deletes the saved secrets of the source and returns its new state', async () => {
    const cleared: ChannelSourceSettingsDto = { ...source, status: 'not_configured', account: null, secrets: source.secrets.map((secret) => ({ ...secret, present: false, origin: null })) };
    const { calls, client: c } = client(() => response({ source: cleared }));
    expect(await c.clearChannelSecrets('slack')).toEqual(cleared);
    expect(calls).toEqual([{ url: 'http://127.0.0.1:47130/v1/channels/settings/slack', method: 'DELETE', contentType: null, body: undefined }]);
  });
});

describe('request checks before anything is sent', () => {
  it('refuses a source that would leave the settings path, and secrets the contract does not allow', async () => {
    const { calls, client: c } = client(() => response({ source }));
    for (const bad of ['..', '.', 'a/b', '', 'x'.repeat(61)]) {
      await expect(c.saveChannelSecrets(bad, secrets)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(c.testChannelSecrets(bad, secrets)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(c.clearChannelSecrets(bad)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // 空的键和过长的键单独查：TypeBox 的 Record 不检查键的长度。
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`NAME_${index}`, 'value']));
    for (const bad of [{}, tooMany, { PLC_SLACK_APP_TOKEN: '' }, { PLC_SLACK_APP_TOKEN: 'x'.repeat(1_001) }, { '': 'xapp-test' }, { ['K'.repeat(101)]: 'xapp-test' }]) {
      await expect(c.saveChannelSecrets('slack', bad)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(c.testChannelSecrets('slack', bad)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });
});
