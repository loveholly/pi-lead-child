// @vitest-environment jsdom
// 会话顶栏的 Lead 状态点说真话：在线、降级（模型连不上，系统会自己重试，下一次几点）、离线。
// 实例上每次 Lead 调模型都是 503，顶栏却一直亮着绿点：它只看 WebSocket 连没连上。
import { PROTOCOL_VERSION, type GatewayEvent, type LeadStatus, type Overview } from '@pi-lead-child/protocol';
import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { formatConversationTime, LeadConversation } from './LeadConversation';

// 方案 C（2026-10-28，主题 11.14）：顶栏的 Lead 身份只在手机上和左栏收起时出现，这里按左栏收起渲染。
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null,
  lastSuccessAt: '2026-10-14T11:00:00.000Z',
};
const degraded: LeadStatus = {
  state: 'degraded',
  since: '2026-10-14T11:07:47.000Z',
  failures: 3,
  reason: 'Lead 的模型服务暂时连不上',
  detail: '503 Service Unavailable: upstream connect error',
  nextAttemptAt: '2026-10-14T12:38:00.000Z',
  lastSuccessAt: '2026-10-14T11:00:00.000Z',
};

function overview(lead: LeadStatus): Overview {
  return {
    model: 'claude-sonnet-5-5', sessionId: 'lead-session', busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null,
    lead,
  };
}

function runtimeWith(lead: LeadStatus, connectionState: 'connected' | 'reconnecting' = 'connected') {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState, overview: overview(lead) });
  return runtime;
}

function statusChanged(lead: LeadStatus): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION, eventId: 'event-9', seq: 9, type: 'daemon.status.changed',
    occurredAt: '2026-10-14T12:08:00.000Z', requiredScope: 'tickets:view', audienceBindingId: null,
    turnId: null, ticketId: null, payload: { lead },
  };
}

function dotLabel(): string | null {
  return screen.getByTestId('lead-status-dot').getAttribute('aria-label');
}

function render(runtime: ReturnType<typeof runtimeWith>) {
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation railOpen={false} /></CompanionRuntimeProvider>);
}

describe('the Lead status in the conversation header', () => {
  it('is online only when the connection is up and Lead model calls succeed', () => {
    render(runtimeWith(online));
    expect(dotLabel()).toBe('Paimon 在线');
    expect(screen.queryByText(/自动重试/)).toBeNull();
  });

  it('is degraded while the model is unreachable, with the next automatic attempt', () => {
    // 重试时间过了以后顶栏就不再写它（见最后一个用例）。时钟固定在重试之前，免得这条用例在 12:38Z 之后失败。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-14T12:30:00.000Z'));
      render(runtimeWith(degraded));
      expect(dotLabel()).toBe('Paimon 降级：Lead 的模型服务暂时连不上');
      expect(screen.getByText(`模型暂时连不上 · ${formatConversationTime(degraded.nextAttemptAt!)} 自动重试`)).toBeTruthy();
      expect(screen.queryByText(/503|upstream/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns degraded as soon as the daemon says so, without a refresh', () => {
    const runtime = runtimeWith(online);
    render(runtime);
    act(() => {
      const adapted = adaptGatewayEvent(statusChanged(degraded));
      if (!adapted.ok) throw new Error(adapted.error);
      for (const mutation of reduceGatewayEvent(adapted.event).control) {
        applyControlPlaneMutation(runtime.control, 'lead-session', mutation);
      }
    });
    expect(dotLabel()).toBe('Paimon 降级：Lead 的模型服务暂时连不上');
  });

  it('does not promise an automatic retry for the proxy\'s 503 auth_unavailable around an upstream 403', () => {
    // 用户实际遇到的失败。daemon 的健康状态给出原文（detail），顶栏按原文分类。
    const live = '503: {"message":"auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5; '
      + 'last upstream error: {\\n  \\"error\\": {\\n    \\"type\\": \\"forbidden\\",\\n    '
      + '\\"message\\": \\"Request not allowed\\"}}","type":"server_error"}';
    render(runtimeWith({ ...degraded, reason: 'Lead 的模型账号认证失败', detail: live }));
    expect(screen.getByText('模型认证失败，需要检查配置')).toBeTruthy();
    expect(screen.queryByText(/自动重试/)).toBeNull();
  });

  it('says the network is down, not the model, and promises no time while it is', () => {
    render(runtimeWith({
      ...degraded, reason: '网络不可用',
      detail: '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}',
    }));
    expect(screen.getByText('离线：网络不可用，恢复后继续')).toBeTruthy();
    expect(dotLabel()).toBe('Paimon 离线：网络不可用');
    expect(screen.queryByText(/自动重试|模型/)).toBeNull();
  });

  it('does not promise an automatic retry for a failure that needs the user', () => {
    render(runtimeWith({ ...degraded, reason: 'Lead 的模型账号认证失败', detail: '401 Unauthorized' }));
    expect(screen.getByText('模型认证失败，需要检查配置')).toBeTruthy();
    expect(screen.queryByText(/自动重试/)).toBeNull();
  });

  it('names a model configuration failure as needing the user too', () => {
    render(runtimeWith({ ...degraded, reason: 'Lead 的模型配置有误', detail: '404 {"error":"model not found: claude-sonnet-9"}' }));
    expect(screen.getByText('模型配置有误，需要检查配置')).toBeTruthy();
    expect(screen.queryByText(/自动重试/)).toBeNull();
  });

  it('stops showing a retry time once it has passed', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-10-14T12:37:00.000Z'));
      render(runtimeWith({ ...degraded, nextAttemptAt: '2026-10-14T12:38:00.000Z' }));
      expect(screen.getByText(`模型暂时连不上 · ${formatConversationTime(degraded.nextAttemptAt!)} 自动重试`)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(61_000); });
      expect(screen.queryByText(/自动重试/)).toBeNull();
      expect(screen.getByText('模型暂时连不上 · 正在重试')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when it will retry if nothing automatic is scheduled', () => {
    render(runtimeWith({ ...degraded, nextAttemptAt: null }));
    expect(screen.getByText('模型暂时连不上 · 你发消息时会再试')).toBeTruthy();
  });

  it('shows the last quiet patrol in the header instead of a message in the conversation', () => {
    render(runtimeWith({ ...online, lastPatrolAt: '2026-10-14T11:05:00.000Z' }));
    expect(dotLabel()).toBe('Paimon 在线');
    expect(screen.getByText(`最近巡检 ${formatConversationTime('2026-10-14T11:05:00.000Z')}`)).toBeTruthy();
  });

  it('is offline when the daemon connection is down, whatever the last health was', () => {
    render(runtimeWith(online, 'reconnecting'));
    expect(dotLabel()).toBe('Paimon 离线');
    expect(screen.getByText('离线 · 正在重连')).toBeTruthy();
  });
});
