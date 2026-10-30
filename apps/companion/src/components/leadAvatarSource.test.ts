// Lead 的形象从哪来（主题 11.12，用户 2026-10-28）。用户的底线：只有 daemon 说 fairyEye 开着（用户发了 /fairyeye on）
// 才画 FairyEye；没取到形象、旧 daemon、fairyEye 关着都用素材。
import type { LeadAvatarDto, LeadAvatarImageRef } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { leadAvatarDefaults } from './leadAvatarDefaults';
import { leadAvatarSource } from './leadAvatarSource';

const EMPTY: LeadAvatarDto = {
  fairyEye: false,
  slots: { default: null, thinking: null, muted: null, offline: null },
  slackEmoji: ':robot_face:',
  slackEmojiSource: 'default',
  updatedAt: null,
  updatedBy: null,
};
const ref = (id: string): LeadAvatarImageRef => ({ id, mimeType: 'image/gif', bytes: 2048, updatedAt: '2026-10-28T15:00:00.000Z' });
const idle = { state: 'idle', tone: 'color' } as const;
const thinking = { state: 'thinking', tone: 'color' } as const;

describe('leadAvatarSource', () => {
  it('never picks FairyEye unless the daemon says fairyEye is on', () => {
    for (const avatar of [null, EMPTY, { ...EMPTY, slots: { ...EMPTY.slots, default: ref('av_1') } }]) {
      for (const look of [idle, thinking, { state: 'idle', tone: 'muted' } as const, { state: 'idle', tone: 'quiet' } as const]) {
        expect(leadAvatarSource(avatar, {}, look).kind).toBe('image');
      }
    }
    expect(leadAvatarSource({ ...EMPTY, fairyEye: true }, {}, idle)).toEqual({ kind: 'fairy-eye' });
  });

  it('uses the system assets for each state when nothing is uploaded', () => {
    expect(leadAvatarSource(null, {}, idle)).toMatchObject({ uri: leadAvatarDefaults.default });
    expect(leadAvatarSource(EMPTY, {}, thinking)).toEqual({ kind: 'image', uri: leadAvatarDefaults.thinking, stillUri: leadAvatarDefaults.default });
    expect(leadAvatarSource(EMPTY, {}, { state: 'idle', tone: 'muted' })).toMatchObject({ uri: leadAvatarDefaults.muted });
    expect(leadAvatarSource(EMPTY, {}, { state: 'thinking', tone: 'quiet' })).toMatchObject({ uri: leadAvatarDefaults.offline });
  });

  it('falls back from a missing state to the uploaded default, then to the system asset', () => {
    const avatar = { ...EMPTY, slots: { ...EMPTY.slots, default: ref('av_d'), muted: ref('av_m') } };
    const images = { av_d: 'data:image/gif;base64,ZA==', av_m: 'data:image/gif;base64,bQ==' };
    expect(leadAvatarSource(avatar, images, idle)).toMatchObject({ uri: images.av_d });
    expect(leadAvatarSource(avatar, images, thinking)).toEqual({ kind: 'image', uri: images.av_d, stillUri: images.av_d });
    expect(leadAvatarSource(avatar, images, { state: 'idle', tone: 'muted' })).toMatchObject({ uri: images.av_m });
    expect(leadAvatarSource(avatar, images, { state: 'idle', tone: 'quiet' })).toMatchObject({ uri: images.av_d });
    // 还在取：空位，不先闪一下系统素材。取不到：系统素材。
    expect(leadAvatarSource(avatar, {}, idle)).toMatchObject({ uri: null });
    expect(leadAvatarSource(avatar, { av_d: '' }, idle)).toMatchObject({ uri: leadAvatarDefaults.default });
  });
});
