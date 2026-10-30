// @vitest-environment jsdom
// 一次停摆，一张卡片（2026-10-16）。用户问：这两张卡片都像系统消息，为什么不一样？
//   · 「系统通知 · 19:19」：Lead 不能工作时系统发的兜底通知，正文是 Lead 写给自己的跟进，原样转给了用户
//     （"跟进：看 #66 reviewer Run #87 … 用 notify_user（batchable）推送 …"）；
//   · 橙色的「Lead 的模型服务暂时连不上，这次没能处理新的 blocker … 共 2 次 · 最近 20:06」。
// 两张说的是同一件事：19:11–20:07 断网。现在是一张系统卡片，开头一句说清什么时候、为什么、积压几件、恢复了没有，
// 展开才看到积压的事和 Lead 那几次没完成的处理。积压的事写给用户看，不出现工具名。
import { PROTOCOL_VERSION, type ConversationTurn, type LeadStatus, type Overview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
const DNS = '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};
// 本地时间（测试机的时区）：卡片按本地时间写钟点。
const at = (hour: number, minute: number, second = 0) => new Date(2026, 9, 15, hour, minute, second).toISOString();
void PROTOCOL_VERSION;

function overview(): Overview {
  return {
    model: 'stub', sessionId: SESSION, busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'system:blocker', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null, createdAt: at(19, 0), updatedAt: at(19, 0),
    ...overrides,
  };
}

function setup(turns: ConversationTurn[]) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview() });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
}

// 2026-10-15 实例上的那几轮。
const LIVE = [
  turn('blocker-1', { state: 'failed', error: DNS, createdAt: at(19, 19, 30), updatedAt: at(19, 19, 35) }),
  turn('fallback-1', {
    originKind: 'system:fallback-notice', createdAt: at(19, 19, 35), updatedAt: at(19, 19, 35),
    assistantText: '⏰ Lead 现在不可用：Lead 的模型调用失败（Lead 的模型服务暂时连不上）。积压了 1 件事：\n'
      + '1. 跟进：看 #66 reviewer Run #87 恢复了没有；如果用户不在，用 notify_user（batchable）推送，再 record_disposition。',
  }),
  turn('blocker-2', { state: 'failed', error: DNS, createdAt: at(20, 6, 40), updatedAt: at(20, 6, 47) }),
  turn('heartbeat-ok', {
    originKind: 'system:heartbeat', assistantText: '网络恢复了，#66 的核查已经重新派发。',
    createdAt: at(20, 7, 10), updatedAt: at(20, 7, 30),
  }),
];

describe('one outage, one card', () => {
  it('merges the fallback notice and the failed Lead turns of the same window into one system card', () => {
    setup(LIVE);
    const cards = screen.getAllByTestId('incident-card');
    expect(cards).toHaveLength(1);
    expect(screen.queryAllByTestId('failure-card')).toEqual([]);
    expect(cards[0]!.textContent).toContain('Paimon 离线 19:19–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复');
    expect(cards[0]!.textContent).toContain('系统通知');
    // 和会话里别的警告一样是一行可以展开的条目：没有「技术详情」按钮。
    expect(cards[0]!.textContent).not.toContain('技术详情');
    // 收起时只有一句；Lead 写给自己的话、工具名从不出现。
    expect(screen.getByTestId('lead-conversation').textContent).not.toMatch(/notify_user|record_disposition|batchable|跟进：看/);

    act(() => fireEvent.click(within(cards[0]!).getByRole('button', { name: /展开/ })));
    expect(cards[0]!.textContent).toContain('Paimon 设的一次跟进到点了');
    expect(cards[0]!.textContent).toContain('期间 Paimon 有 2 次自动处理没有完成（网络不可用）');
    expect(screen.getByTestId('lead-conversation').textContent).not.toMatch(/notify_user|record_disposition|batchable/);
  });

  it('shows the daemon\'s own outage headline, and its lines only when expanded', () => {
    setup([turn('outage', {
      originKind: 'system:fallback-notice', createdAt: at(19, 12), updatedAt: at(20, 7),
      assistantText: 'Lead 离线 19:11–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复并补处理\n'
        + '· 工单 #66「E2E 终验」：Lead 设的一次跟进到点了 —— 已交给 Lead',
    })]);
    const card = screen.getByTestId('incident-card');
    // daemon 写下的标题照原文显示：写的时候用的是那时的名字，这里不改写（2026-10-22）。
    expect(card.textContent).toContain('Lead 离线 19:11–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复并补处理');
    expect(card.textContent).not.toContain('E2E 终验');
    act(() => fireEvent.click(within(card).getByRole('button', { name: /展开/ })));
    expect(card.textContent).toContain('工单 #66「E2E 终验」：Lead 设的一次跟进到点了 —— 已交给 Lead');
  });
});
