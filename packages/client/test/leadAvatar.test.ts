// 设置页「身份与风格 → 形象」在客户端里的包装（契约在 packages/protocol/src/lead-avatar.ts）：
// 六个方法的路由和请求体，响应按共享协议严格校验。客户端没有改 FairyEye 的方法。
import { describe, expect, it } from 'vitest';
import type { BindingDto, LeadAvatarDto, SlackEmojiPreview } from '@pi-lead-child/protocol';

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

interface Call { url: string; method: string; body: unknown }

function client(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
    calls.push(call);
    return reply(call);
  };
  return { calls, client: new ControlPlaneClient({ fetch: fetcher as typeof fetch, credentials: memoryCredentials() }) };
}

const avatar: LeadAvatarDto = {
  fairyEye: false,
  slots: {
    default: { id: 'av_0123456789abcdef01234567', mimeType: 'image/png', bytes: 68, updatedAt: '2026-10-28T08:00:00.000Z' },
    thinking: null, muted: null, offline: null,
  },
  slackEmoji: ':robot_face:', slackEmojiSource: 'default', updatedAt: '2026-10-28T08:00:00.000Z', updatedBy: 'user',
};

describe('the Lead avatar in the client', () => {
  it('reads the avatar and an image by id', async () => {
    const { calls, client: api } = client((call) => (call.url.includes('/images/')
      ? response({ id: 'av_0123456789abcdef01234567', mimeType: 'image/png', data: 'iVBORw0KGgo=' })
      : response({ leadAvatar: avatar })));
    await expect(api.getLeadAvatar()).resolves.toEqual(avatar);
    await expect(api.getLeadAvatarImage('av_0123456789abcdef01234567')).resolves.toMatchObject({ mimeType: 'image/png' });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', 'http://127.0.0.1:47130/v1/lead/avatar'],
      ['GET', 'http://127.0.0.1:47130/v1/lead/avatar/images/av_0123456789abcdef01234567'],
    ]);
  });

  it('uploads, clears and sets the Slack emoji on their routes', async () => {
    const { calls, client: api } = client(() => response({ leadAvatar: avatar }));
    await api.uploadLeadAvatarSlot('thinking', { mimeType: 'image/gif', data: 'R0lGODlh' });
    await api.clearLeadAvatarSlot('muted');
    await api.setLeadAvatarSlackEmoji({ emoji: 'sparkles' });
    await api.setLeadAvatarSlackEmoji({ emoji: '', reset: true });
    expect(calls.map((call) => [call.method, call.url.replace('http://127.0.0.1:47130', ''), call.body])).toEqual([
      ['POST', '/v1/lead/avatar/slots/thinking', { mimeType: 'image/gif', data: 'R0lGODlh' }],
      ['POST', '/v1/lead/avatar/slots/muted/clear', {}],
      ['POST', '/v1/lead/avatar/slack-emoji', { emoji: 'sparkles' }],
      ['POST', '/v1/lead/avatar/slack-emoji', { emoji: '', reset: true }],
    ]);
  });

  it('previews an emoji with the code in the query', async () => {
    const preview: SlackEmojiPreview = {
      code: ':robot_face:', status: 'custom', imageUrl: 'https://emoji.slack-edge.com/T0/robot_face/1.gif', reason: null,
      byline: 'Paimon (Assistant) · auto-reply for Leo',
    };
    const { calls, client: api } = client(() => response(preview));
    await expect(api.previewSlackEmoji(':robot_face:')).resolves.toEqual(preview);
    expect(calls[0]!.url).toBe('http://127.0.0.1:47130/v1/lead/avatar/slack-emoji/preview?code=%3Arobot_face%3A');
  });

  it('refuses a response that does not match the contract', async () => {
    const { client: api } = client(() => response({ leadAvatar: { ...avatar, extra: true } }));
    await expect(api.getLeadAvatar()).rejects.toBeInstanceOf(ControlPlaneClientError);
    const { client: bad } = client(() => response({ id: 'av_x', mimeType: 'image/jpeg', data: 'x' }));
    await expect(bad.getLeadAvatarImage('av_x')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('has no method that changes FairyEye', () => {
    const methods = Object.getOwnPropertyNames(ControlPlaneClient.prototype).filter((name) => /fairy/i.test(name));
    expect(methods).toEqual([]);
  });
});
