// @vitest-environment jsdom
// 设置 → 身份与风格 → 形象（主题 11.15，用户 2026-10-28）：四种状态的图，和 Slack 署名的 emoji。
// 契约在 packages/protocol/src/lead-avatar.ts。
import { LEAD_AVATAR_CAPABILITY, type LeadAvatarDto, type SlackEmojiPreview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadAvatarSection } from './LeadAvatarSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/profile', Slot: () => null, Stack: () => null }));

const AVATAR: LeadAvatarDto = {
  fairyEye: false,
  slots: {
    default: { id: 'av_000000000000000000000001', mimeType: 'image/gif', bytes: 2048, updatedAt: '2026-10-28T15:00:00.000Z' },
    thinking: null,
    muted: null,
    offline: null,
  },
  slackEmoji: ':robot_face:',
  slackEmojiSource: 'default',
  updatedAt: '2026-10-28T15:00:00.000Z',
  updatedBy: 'user',
};

function preview(code: string): SlackEmojiPreview {
  if (!code) return { code: '', status: 'none', imageUrl: null, reason: null, byline: 'Paimon (Assistant) · auto-reply for Leo' };
  return code === ':robot_face:'
    ? { code, status: 'custom', imageUrl: 'https://emoji.slack-edge.com/T1/robot_face/abc.gif', reason: null, byline: 'Paimon (Assistant) · auto-reply for Leo' }
    : { code, status: 'not_found', imageUrl: null, reason: null, byline: 'Paimon (Assistant) · auto-reply for Leo' };
}

function avatarRuntime(initial: LeadAvatarDto) {
  const fake = {
    getLeadAvatarImage: vi.fn(async (id: string) => ({ id, mimeType: 'image/gif', data: 'R0lGODlhAQABAAAAACw=' })),
    clearLeadAvatarSlot: vi.fn(async () => ({ ...initial, slots: { ...initial.slots, default: null } })),
    setLeadAvatarSlackEmoji: vi.fn(async (request: { emoji: string }) => ({ ...initial, slackEmoji: request.emoji, slackEmojiSource: 'settings' as const })),
    previewSlackEmoji: vi.fn(async (code: string) => preview(code)),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', capabilities: [LEAD_AVATAR_CAPABILITY], leadAvatar: initial });
  return { runtime, client: fake };
}

describe('the avatar card', () => {
  it('says where each state comes from and resets an uploaded one', async () => {
    const { runtime, client } = avatarRuntime(AVATAR);
    renderWithRuntime(<LeadAvatarSection />, runtime);
    expect(screen.getByTestId('lead-avatar-status-default').textContent).toBe('已上传 · 2 KB');
    expect(screen.getByTestId('lead-avatar-status-thinking').textContent).toBe('用默认图');
    expect(screen.queryByTestId('lead-avatar-reset-thinking')).toBeNull();
    // FairyEye 关着时卡片上不提它。
    expect(screen.queryByTestId('lead-avatar-fairy-eye-note')).toBeNull();
    // 预览总是素材，不是 FairyEye。
    expect(screen.getByTestId('lead-avatar-preview-thinking')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByTestId('lead-avatar-reset-default')); });
    expect(client.clearLeadAvatarSlot).toHaveBeenCalledWith('default');
    expect(screen.getByTestId('lead-avatar-status-default').textContent).toBe('系统素材');
    expect(screen.getByTestId('lead-avatar-status-thinking').textContent).toBe('系统素材');
  });

  it('tells how to switch FairyEye off only while it is on, and still previews the assets', () => {
    const { runtime } = avatarRuntime({ ...AVATAR, fairyEye: true, slots: { default: null, thinking: null, muted: null, offline: null } });
    renderWithRuntime(<LeadAvatarSection />, runtime);
    expect(screen.getByTestId('lead-avatar-fairy-eye-note').textContent).toContain('/fairyeye off');
    expect(screen.getByTestId('lead-avatar-preview-default-image')).toBeTruthy();
  });

  it('previews the Slack byline as you type and saves the normalized code', async () => {
    const { runtime, client } = avatarRuntime(AVATAR);
    renderWithRuntime(<LeadAvatarSection />, runtime);
    await waitFor(() => expect(screen.getByTestId('slack-byline-preview-emoji')).toBeTruthy());
    expect(screen.getByTestId('slack-byline-preview-text').textContent).toBe('Paimon (Assistant) · auto-reply for Leo');
    expect(screen.getByTestId('slack-byline-emoji-save').getAttribute('aria-disabled')).toBe('true');

    // 写法不对：说明，不能保存，不去查。
    fireEvent.change(screen.getByTestId('slack-byline-emoji-input'), { target: { value: 'Fairy ZZ' } });
    expect(screen.getByTestId('slack-byline-preview-note').textContent).toContain('写法不对');
    expect(screen.getByTestId('slack-byline-emoji-save').getAttribute('aria-disabled')).toBe('true');

    // 清空：只有文字。
    fireEvent.change(screen.getByTestId('slack-byline-emoji-input'), { target: { value: '' } });
    await waitFor(() => expect(client.previewSlackEmoji).toHaveBeenLastCalledWith('', expect.anything()));
    await waitFor(() => expect(screen.queryByTestId('slack-byline-preview-emoji')).toBeNull());
    expect(screen.queryByTestId('slack-byline-preview-code')).toBeNull();

    // 不带冒号也行：查的是整理以后的短代码，保存的也是。
    fireEvent.change(screen.getByTestId('slack-byline-emoji-input'), { target: { value: 'sparkles' } });
    await waitFor(() => expect(client.previewSlackEmoji).toHaveBeenLastCalledWith(':sparkles:', expect.anything()));
    await waitFor(() => expect(screen.getByTestId('slack-byline-preview-code').textContent).toBe(':sparkles:'));
    expect(screen.getByTestId('slack-byline-preview-note').textContent).toContain('Slack 自带的 emoji');
    await act(async () => { fireEvent.click(screen.getByTestId('slack-byline-emoji-save')); });
    expect(client.setLeadAvatarSlackEmoji).toHaveBeenCalledWith({ emoji: ':sparkles:' });
    expect(screen.getByTestId('slack-byline-emoji-message').textContent).toContain('已保存');
    expect(screen.getByTestId('slack-byline-emoji-reset')).toBeTruthy();
  });
});
