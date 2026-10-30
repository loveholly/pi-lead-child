// @vitest-environment jsdom
// 外部的人要求设的定时器的确认卡（统一的消息事件 spec D16，工单 12）：代价不够低时，Lead 把系统给的 user_action（confirm_timer）
// 原样放进 UserAction。卡片只带确认号，什么定时器、谁要求的、为什么问你都从 /v1/timer-requests/:id 读；
// 「设定时器」「不设」走只有用户能按到的路由。样子是审批模式（docs/design P9.2、主题 11.4）。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { TimerRequestDto, UiSurface } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { connectionsRuntime, renderWithRuntime, type FakeConnectionClient } from '../../../test/connections';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ID = 'tmr_AbCdEfGh1234';

function request(overrides: Partial<TimerRequestDto> = {}): TimerRequestDto {
  return {
    id: ID,
    state: 'pending',
    tool: 'follow_up',
    what: '10-28 09:00 叫醒 Lead：替 Sean 在 #release 发上线通知（到点要在公开频道里替你对外做事）',
    at: '2026-10-28T01:00:00.000Z',
    repeat: null,
    outward: { audience: 'public_channel' },
    origin: {
      kind: 'external', via: 'message', source: 'slack', sourceLabel: 'Slack', sender: { id: 'U0ETHAN', name: 'Ethan' },
      messageEvent: 42, conversation: { key: 'slack:@U0ETHAN', label: 'Ethan 的私信' },
    },
    requester: 'Ethan（Slack）',
    reasons: ['到点要替你对外做事，授权表没让代你做：这条消息的权限上限是「问你」（别的）'],
    cost: {
      level: 5, name: '最高',
      steps: [
        { id: 'audience', label: '受众', levels: 3, detail: '公开频道（人数不知道）' },
        { id: 'deferred', label: '延后执行', levels: 1, detail: '到点才做' },
        { id: 'outward_later', label: '到点后要对外做事', levels: 1, detail: '到点以后要替你在外部对话里发言或做事' },
      ],
    },
    note: '',
    createdAt: '2026-10-27T01:00:00.000Z',
    expiresAt: '2026-10-28T01:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    timer: null,
    resultPreview: null,
    ...overrides,
  };
}

function surface(): UiSurface {
  return {
    id: 'surface-timer-request', catalogVersion: 1, root: 'act', fallbackText: 'Ethan 要求设一个定时器，等你决定。',
    nodes: [{
      id: 'act', type: 'UserAction',
      props: { action: { kind: 'confirm_timer', target: `timer_request:${ID}`, title: '设定时器', reason: 'Ethan（Slack）要求：替 Sean 发上线通知' } },
    }],
  };
}

function runtimeWith(client: { timerRequest: ReturnType<typeof vi.fn>; resolveTimerRequest?: ReturnType<typeof vi.fn> }) {
  const fake = { resolveTimerRequest: vi.fn(() => new Promise(() => {})), ...client };
  return connectionsRuntime([], fake as unknown as Partial<FakeConnectionClient>);
}

describe('the confirm card for a timer someone else asked for', () => {
  it('shows who asked, what the timer does and why it asks; 设定时器 sets it', async () => {
    const { runtime, client } = runtimeWith({
      timerRequest: vi.fn(async () => request()),
      resolveTimerRequest: vi.fn(async () => request({
        state: 'done', resolvedAt: '2026-10-27T01:05:00.000Z', resolvedBy: 'user via Mac 网页（binding 1）', timer: 'follow_up:9',
        resultPreview: '已设跟进 #9，2026-10-28T09:00:00+08:00 叫醒你。',
      })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect((client as any).timerRequest).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    const card = screen.getByTestId(`surface-timer-request-${ID}`);
    expect(screen.getByTestId(`surface-timer-request-${ID}-state`).textContent).toBe('等你决定');
    expect(card.textContent).toContain('Ethan（Slack）');
    expect(screen.getByTestId(`surface-timer-request-${ID}-what`).textContent).toContain('替 Sean 在 #release 发上线通知');
    expect(card.textContent).toContain('授权表没让代你做');
    expect(card.textContent).toContain('到点后要对外做事');

    await act(async () => { fireEvent.click(screen.getByTestId(`surface-timer-request-${ID}-confirm`)); });
    expect((client as any).resolveTimerRequest).toHaveBeenCalledWith(ID, 'confirm');
    expect(screen.getByTestId(`surface-timer-request-${ID}-state`).textContent).toBe('已设');
    expect(screen.queryByTestId(`surface-timer-request-${ID}-confirm`)).toBeNull();
    expect(screen.queryByTestId(`surface-timer-request-${ID}-decline`)).toBeNull();
  });

  it('does not set it with 不设, and shows the new state when the card was already decided', async () => {
    const { runtime, client } = runtimeWith({
      timerRequest: vi.fn().mockResolvedValueOnce(request()).mockResolvedValueOnce(request({ state: 'declined', resolvedAt: '2026-10-27T01:06:00.000Z' })),
      resolveTimerRequest: vi.fn(async () => { throw new ControlPlaneClientError('这张确认卡已经点了「不设」', 'conflict', 409); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId(`surface-timer-request-${ID}-decline`)); });
    expect((client as any).resolveTimerRequest).toHaveBeenCalledWith(ID, 'decline');
    expect(screen.getByTestId(`surface-timer-request-${ID}-state`).textContent).toBe('没有设');
    expect(screen.getByTestId(`surface-timer-request-${ID}-result`).textContent).toContain('不设');
  });
  // 回归（2026-10-28）：Aurum 的消息叫醒的一轮里，Lead 接着做用户本人的跟进、设下一次跟进，卡上写成「Aurum Huang（Slack）要求设一个定时器」。
  // 现在 Lead 没指明是哪条消息要的时，来源里没有发信人：卡上不写谁要求的，只写这一轮读过哪个对话。
  it('does not say anyone asked when the request names no sender, and shows which conversation the turn read', async () => {
    const unnamed = request({
      origin: {
        kind: 'external', via: 'message', source: 'slack', sourceLabel: 'Slack', sender: null,
        messageEvent: 5951, conversation: { key: 'slack:C0FAKECHN1:main', label: 'Ivy Lin 等人的群聊' },
      },
      requester: 'Slack 的外部内容',
    });
    const { runtime } = runtimeWith({ timerRequest: vi.fn(async () => unnamed) });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    const card = screen.getByTestId(`surface-timer-request-${ID}`);
    expect(card.textContent).toContain('要设一个定时器');
    expect(card.textContent).not.toContain('要求设一个定时器');
    expect(card.textContent).toContain('这一轮读过');
    expect(card.textContent).toContain('Ivy Lin 等人的群聊');
  });
});
