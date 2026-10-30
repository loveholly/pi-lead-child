// @vitest-environment jsdom
// 消息头的形象（方案 C，2026-10-28，主题 F-5、11.10）：桌面上 Lead 的消息头前面有 Lead 的形象。
// 最新的一条用默认的图：回复时在想，答完了待机。更早的用淡彩、静止（P12.4）。daemon 写的系统通知不加。
// 缺省画素材；FairyEye 是隐藏模式（/fairyeye on），那时最新的一条用彩色、更早的用淡彩。
import type { ConversationTurn, LeadAvatarDto, LeadProfileDto } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation, latestLeadMessage, type LeadConversationRow } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const JARVIS: LeadProfileDto = { name: 'Jarvis', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-28T08:00:00.000Z', updatedAt: '2026-10-28T08:00:00.000Z',
    ...overrides,
  };
}

const earlier = turn('turn-earlier', {
  userText: '今天有什么事', assistantText: '今天有三件事。',
  createdAt: '2026-10-28T08:00:00.000Z', updatedAt: '2026-10-28T08:01:00.000Z',
});
const latest = turn('turn-latest', {
  userText: '#490 呢', assistantText: '#490 在等你确认重试间隔。',
  createdAt: '2026-10-28T08:10:00.000Z', updatedAt: '2026-10-28T08:11:00.000Z',
});
// daemon 自己写的报警：系统通知，不加 Fairy，也不算「最新一条 Lead 消息」。
const alert = turn('turn-alert', {
  originKind: 'system:security-alert', assistantText: '有人绕过 API 改了账本里的设置。',
  createdAt: '2026-10-28T08:20:00.000Z', updatedAt: '2026-10-28T08:21:00.000Z',
});

const FAIRY_EYE_ON: LeadAvatarDto = {
  fairyEye: true,
  slots: { default: null, thinking: null, muted: null, offline: null },
  slackEmoji: '',
  slackEmojiSource: 'settings',
  updatedAt: null,
  updatedBy: null,
};

function render(turns: ConversationTurn[], leadAvatar: LeadAvatarDto | null = null) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', leadProfile: JARVIS, leadAvatar });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
}

// Fairy 的色调读圆盘的颜色（FairyEye.shared.ts 的 fairyPalettes）：彩色 #3045DC，淡彩 #7B8CE8。
function discColor(fairy: Element): string {
  return getComputedStyle(fairy.firstElementChild!).backgroundColor.toLowerCase();
}

describe('the Fairy in Lead message headers', () => {
  it('draws the image assets by default, one per Lead reply', () => {
    render([earlier, latest, alert]);
    const marks = screen.getAllByTestId('message-fairy');
    expect(marks).toHaveLength(2);
    expect(screen.getAllByTestId('message-fairy-image')).toHaveLength(2);
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual(['Jarvis', 'Jarvis']);
  });

  it('in FairyEye mode colors only the latest Lead reply and keeps earlier ones muted and still', () => {
    render([earlier, latest, alert], FAIRY_EYE_ON);
    const marks = screen.getAllByTestId('message-fairy');
    // 两条 Lead 的回答各一个；系统通知没有。
    expect(marks).toHaveLength(2);
    expect(marks.map(discColor)).toEqual(['rgb(123, 140, 232)', 'rgb(48, 69, 220)']);
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual(['Jarvis', 'Jarvis']);
  });

  it('thinks while the latest reply is still streaming', () => {
    render([earlier, { ...latest, state: 'streaming', assistantText: '我先查' }]);
    const marks = screen.getAllByTestId('message-fairy');
    expect(marks.at(-1)!.getAttribute('aria-label')).toBe('Jarvis 在想');
    expect(marks[0]!.getAttribute('aria-label')).toBe('Jarvis');
  });
});

describe('latestLeadMessage', () => {
  const rows = [
    { kind: 'message', key: 'a', messageId: 'a', cardIds: [] },
    { kind: 'message', key: 'b', messageId: 'b', cardIds: [] },
    { kind: 'message', key: 'c', messageId: 'c', cardIds: [] },
  ] as unknown as LeadConversationRow[];

  it('skips user messages and system notices', () => {
    const messages = {
      a: { role: 'assistant' as const, turnId: 'reply' },
      b: { role: 'assistant' as const, turnId: 'alert' },
      c: { role: 'user' as const, turnId: 'next' },
    };
    expect(latestLeadMessage(rows, messages, (message) => message.turnId === 'alert')).toBe('a');
  });

  it('returns null when Lead has not spoken', () => {
    expect(latestLeadMessage(rows, {}, () => false)).toBeNull();
  });
});
