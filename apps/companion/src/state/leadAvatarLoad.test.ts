// @vitest-environment jsdom
// Lead 的形象（GET /v1/lead/avatar）要等 hello.v2 说 daemon 有 lead.avatar.v1 才能取：hydrate 在连上之前跑，
// 那时还不知道。2026-10-28 预览时发现：直接打开设置页一直「正在读取形象…」，刷新以后 FairyEye 开着也画成素材。
import { LEAD_AVATAR_CAPABILITY, type HelloV2, type LeadAvatarDto } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from './runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

const AVATAR: LeadAvatarDto = {
  fairyEye: true,
  slots: {
    default: { id: 'av_000000000000000000000001', mimeType: 'image/png', bytes: 1200, updatedAt: '2026-10-28T15:00:00.000Z' },
    thinking: null,
    muted: null,
    offline: null,
  },
  slackEmoji: ':robot_face:',
  slackEmojiSource: 'default',
  updatedAt: '2026-10-28T15:00:00.000Z',
  updatedBy: 'user',
};

function setup() {
  const client = {
    getLeadAvatar: vi.fn(async () => AVATAR),
    getLeadAvatarImage: vi.fn(async (id: string) => ({ id, mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' })),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view']);
  return { runtime, client };
}

const hello = (capabilities: string[]) => ({ latestSeq: 0, daemon: { sessionId: 's' }, capabilities }) as unknown as HelloV2;

describe('loading the Lead avatar', () => {
  it('fetches the avatar and its images once hello says the daemon has it', async () => {
    const { runtime, client } = setup();
    runtime.handleHello(hello([LEAD_AVATAR_CAPABILITY]));
    await vi.waitFor(() => expect(runtime.control.getState().leadAvatar).toEqual(AVATAR));
    await vi.waitFor(() => expect(runtime.control.getState().leadAvatarImages).toEqual({
      av_000000000000000000000001: 'data:image/png;base64,iVBORw0KGgo=',
    }));
    expect(client.getLeadAvatarImage).toHaveBeenCalledTimes(1);
  });

  it('leaves an old daemon alone: no request, the UI draws the system assets', async () => {
    const { runtime, client } = setup();
    runtime.handleHello(hello([]));
    await runtime.whenIdle();
    expect(client.getLeadAvatar).not.toHaveBeenCalled();
    expect(runtime.control.getState().leadAvatar).toBeNull();
  });
});
