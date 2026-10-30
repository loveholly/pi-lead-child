// @vitest-environment jsdom
// 会话按事件时间排，日期变了插一条日期分隔线。
// 实例上一条写着 20:28 的 Lead 回合排在 19:12 的系统通知上面：那条通知播报回合 19:07 开始，
// 20:28 重试时又失败了。气泡上写的是最后一次（updatedAt），排序却用开始时间（createdAt）。
import type { ConversationTurn } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { formatConversationDate, formatConversationTime, LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z',
    ...overrides,
  };
}

// 2026-10-13 实例上的三轮（时间是 UTC；界面按本地时区显示），外加前一天的一轮。
const yesterday = turn('turn-yesterday', {
  userText: '昨天的问题', assistantText: '昨天的回答',
  createdAt: '2026-10-12T09:00:00.000Z', updatedAt: '2026-10-12T09:00:20.000Z',
});
const voicing = turn('turn_297d', {
  originKind: 'system:notification', state: 'completed', assistantText: '通知播报：#66 的对话没答上。',
  createdAt: '2026-10-13T11:07:47.307Z', updatedAt: '2026-10-13T12:28:00.603Z',
});
const fallback = turn('turn_87fe', {
  originKind: 'system:fallback-notice', assistantText: '⏰ 工单 #66 阻塞',
  createdAt: '2026-10-13T11:12:38.058Z', updatedAt: '2026-10-13T11:12:38.063Z',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T14:00:00.000Z'));
});

afterEach(() => vi.useRealTimers());

function render() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  // 快照里的顺序就是 created_at 的顺序。
  runtime.control.getState().replaceConversation(SESSION, [yesterday, voicing, fallback]);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
}

function before(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('the order of the Lead conversation', () => {
  it('places every item at the time it shows', () => {
    render();
    // 兜底通知画成停摆卡片（incidentCard.test.tsx）。
    const notice = screen.getByTestId('incident-card');
    const voiced = screen.getByText('通知播报：#66 的对话没答上。');
    // 2026-10-15 用户决定（方案 A）：Lead 主动发起的回合也只写「Lead 的名字 · 时间」（缺省 Paimon）。
    expect(screen.getByText(`Paimon · ${formatConversationTime(voicing.updatedAt)}`)).toBeTruthy();
    expect(before(notice, voiced)).toBe(true);
  });

  it('puts a date divider before the first item of each day', () => {
    render();
    const now = new Date('2026-10-13T14:00:00.000Z');
    const firstDay = screen.getByText(formatConversationDate(yesterday.createdAt, now));
    const secondDay = screen.getByText(formatConversationDate(fallback.createdAt, now));
    expect(screen.getAllByTestId('conversation-date-divider')).toHaveLength(2);
    expect(before(firstDay, screen.getByText('昨天的回答'))).toBe(true);
    expect(before(screen.getByText('昨天的回答'), secondDay)).toBe(true);
    expect(before(secondDay, screen.getByTestId('incident-card'))).toBe(true);
  });
});

describe('formatConversationDate', () => {
  it('names today and yesterday, and spells out older days with the weekday', () => {
    const now = new Date(2026, 9, 13, 22, 0);
    expect(formatConversationDate(new Date(2026, 9, 13, 8, 0).toISOString(), now)).toBe('今天');
    expect(formatConversationDate(new Date(2026, 9, 12, 23, 59).toISOString(), now)).toBe('昨天');
    expect(formatConversationDate(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe('10月5日 周一');
    expect(formatConversationDate(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe('2025年12月31日 周三');
  });
});
