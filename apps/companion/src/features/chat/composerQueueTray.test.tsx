// @vitest-environment happy-dom
// 输入框上的状态栏（主题 11.13，2026-10-28 方案 C）：贴着输入框，默认收起，只露最新一条你的追问；
// 展开时其余几条从这一行往上长出来。每条追问上有 Steer 和 ×；外部消息不给 Steer。
// daemon 支持时，发送前不再选「插话/排队」，Lead 忙时发出的话一律先排队。
import {
  CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, CHAT_PLACEMENT_CAPABILITY,
  type ConversationTurn, type LeadQueue, type LeadStatus, type Overview, type UiActionView,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';
import { queueCount } from './ComposerQueueTray';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};

function overview(busy: boolean): Overview {
  return {
    model: 'stub', sessionId: SESSION, busy, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: `问题 ${id}`, assistantText: '', error: null,
    createdAt: '2026-10-28T02:00:00.000Z', updatedAt: '2026-10-28T02:00:01.000Z',
    ...overrides,
  };
}

const running = turn('turn-running', { state: 'streaming', userText: '#490 呢', createdAt: '2026-10-28T02:40:00.000Z' });
const first = turn('turn-q1', {
  state: 'queued', placement: 'queued', userText: '顺便看下 #488 的部署日志', createdAt: '2026-10-28T02:43:00.000Z',
});
const second = turn('turn-q2', {
  state: 'queued', placement: 'queued', userText: '改成 2 分钟以后，在 Slack 上告诉小周一声', createdAt: '2026-10-28T02:44:00.000Z',
});

const queue: LeadQueue = {
  busy: true,
  entries: [{
    key: 'slack:@U1', conversation: '李雷的私信', source: 'slack', sourceLabel: 'Slack', senders: ['李雷'], count: 1,
    excerpt: '能帮我看下 staging 吗？', cardIds: [7], firstAt: '2026-10-28T02:42:00.000Z', lastAt: '2026-10-28T02:42:00.000Z',
    next: true, actions: ['remove'],
  }],
};

function setup(turns: ConversationTurn[], options: {
  capabilities?: string[]; leadQueue?: LeadQueue | null; client?: Partial<CompanionRuntimeDependencies['client']>;
} = {}) {
  const runtime = createCompanionStateRuntime({
    client: (options.client ?? {}) as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: overview(true),
    capabilities: options.capabilities ?? [CHAT_PLACEMENT_CAPABILITY, CHAT_FOLLOW_UP_ACTIONS_CAPABILITY],
    leadQueue: options.leadQueue ?? null,
  });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

describe('the queue tray above the composer', () => {
  it('stays collapsed by default and shows only the newest follow-up with Steer and ×', () => {
    setup([running, first, second], { leadQueue: queue });
    const tray = screen.getByTestId('queue-tray');
    expect(within(tray).getByTestId('queue-tray-count').textContent).toBe('Queue 3');
    expect(within(tray).getByText('改成 2 分钟以后，在 Slack 上告诉小周一声')).toBeTruthy();
    expect(within(tray).getByTestId('queue-follow-up-turn-q2-steer')).toBeTruthy();
    expect(within(tray).getByTestId('queue-follow-up-turn-q2-cancel').getAttribute('aria-label')).toBe('Cancel this follow-up');
    expect(screen.getByTestId('queue-tray-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('queue-tray-drawer').getAttribute('aria-hidden')).toBe('true');
    // 收着的列表里没有点得到的按钮（2026-10-28 预览里点到了藏着的「收起」）。
    expect(screen.queryByTestId('queue-tray-collapse')).toBeNull();
    expect(screen.queryByTestId('queue-follow-up-turn-q1-steer')).toBeNull();
    // 发送前不再选「插话/排队」。
    expect(screen.queryByTestId('composer-placement')).toBeNull();
    // 状态栏是输入卡片的上半截。
    expect(screen.getByTestId('composer').contains(tray)).toBe(true);
  });

  it('grows the other items up out of the tray row when expanded, with the newest one left in place', () => {
    setup([running, first, second], { leadQueue: queue });
    fireEvent.click(screen.getByTestId('queue-tray-toggle'));
    const drawer = screen.getByTestId('queue-tray-drawer');
    expect(drawer.getAttribute('aria-hidden')).not.toBe('true');
    expect(within(drawer).getByText('顺便看下 #488 的部署日志')).toBeTruthy();
    expect(within(drawer).getByText('能帮我看下 staging 吗？')).toBeTruthy();
    // 外部消息不给 Steer。
    expect(within(drawer).queryByTestId('queue-follow-up-slack:@U1-steer')).toBeNull();
    // 最新的一条还在卡片里，展开后也写「你的追问」。
    const tray = screen.getByTestId('queue-tray');
    expect(within(tray).getByText('改成 2 分钟以后，在 Slack 上告诉小周一声')).toBeTruthy();
    expect(within(tray).getByText('Your follow-up')).toBeTruthy();
    // 收起按钮在列表头上。
    const collapse = within(drawer).getByTestId('queue-tray-collapse');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(screen.getByTestId('queue-tray-drawer').getAttribute('aria-hidden')).toBe('true');
  });

  it('sends Steer and × for that follow-up through the runtime', () => {
    const runtime = setup([running, first, second]);
    const action = vi.spyOn(runtime, 'followUpAction').mockResolvedValue();
    fireEvent.click(screen.getByTestId('queue-follow-up-turn-q2-steer'));
    expect(action).toHaveBeenCalledWith('steer', 'turn-q2');
  });

  // 2026-11-03 截图：这一轮读过外部内容，排着的追问只能单独开一轮。以前 Steer 照样能点，点了才报红字
  // 「Did not complete: …」，和气泡下面的「In queue」互相矛盾。现在先问操作层（P5.8），不能做就停用并写明原因。
  it('disables Steer and says why when the follow-up must wait for its own turn', async () => {
    const reason = 'This turn read external content, so this message gets its own turn.';
    const listUiActions = vi.fn(async (type: string, id: string | number): Promise<UiActionView[]> => [{
      target: { type, id: String(id) }, id: 'steer', label: '插进这一轮', permission: 'user_only', external: false,
      irreversible: false, where: '', confirm: null, available: false, reason,
    }]);
    const runtime = setup([running, first, second], { client: { listUiActions } });
    const action = vi.spyOn(runtime, 'followUpAction').mockResolvedValue();
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(listUiActions).toHaveBeenCalledWith('follow_up', 'turn-q2');
    const steer = screen.getByTestId('queue-follow-up-turn-q2-steer');
    expect(steer.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(steer);
    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByText(/Did not complete/)).toBeNull();
    // × 照常能用：不再发给 Lead 不受这一轮的限制。
    fireEvent.click(screen.getByTestId('queue-follow-up-turn-q2-cancel'));
    expect(action).toHaveBeenCalledWith('cancel', 'turn-q2');
  });

  it('keeps Steer when the operation says it can go into this turn', async () => {
    const listUiActions = vi.fn(async (type: string, id: string | number): Promise<UiActionView[]> => [{
      target: { type, id: String(id) }, id: 'steer', label: '插进这一轮', permission: 'user_only', external: false,
      irreversible: false, where: '', confirm: null, available: true, reason: null,
    }]);
    const runtime = setup([running, first, second], { client: { listUiActions } });
    const action = vi.spyOn(runtime, 'followUpAction').mockResolvedValue();
    await vi.waitFor(() => expect(listUiActions).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('queue-follow-up-turn-q2-steer'));
    expect(action).toHaveBeenCalledWith('steer', 'turn-q2');
  });

  it('shows why an action failed on that row', async () => {
    const runtime = setup([running, first, second]);
    vi.spyOn(runtime, 'followUpAction').mockRejectedValue(new Error('Lead 已经答完这一轮了'));
    fireEvent.click(screen.getByTestId('queue-follow-up-turn-q2-cancel'));
    expect(await screen.findByText('Did not complete: Lead 已经答完这一轮了')).toBeTruthy();
  });

  it('queues every message sent while Lead is busy', () => {
    const runtime = setup([running]);
    const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg-1' });
    // 没有排着的事时没有状态栏。
    expect(screen.queryByTestId('queue-tray')).toBeNull();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '再问一句' } });
    fireEvent.click(screen.getByTestId('send-message'));
    expect(sendChat).toHaveBeenCalledWith('再问一句', undefined, 'followUp');
  });

  it('keeps the old placement choice and no Steer for a daemon without follow-up actions', () => {
    setup([running, first], { capabilities: [CHAT_PLACEMENT_CAPABILITY], leadQueue: queue });
    expect(screen.getByTestId('composer-placement')).toBeTruthy();
    expect(screen.queryByTestId('queue-tray')).toBeNull();
  });

  // daemon 把取消了的一轮停在 steered（和「一起回答」同一个终态，不算失败）。助手一侧不能写成「已插话」。
  it('marks a cancelled follow-up under your message and gives it no answer', () => {
    setup([turn('turn-cancelled', { state: 'steered', placement: 'cancelled', userText: '不用了' })]);
    expect(screen.getByTestId('placement-status').textContent).toBe('Cancelled · not sent to Paimon');
    expect(screen.queryByText(/已插话/)).toBeNull();
    expect(screen.queryByTestId('message-fairy')).toBeNull();
  });
});

// 2026-10-28 在测试 daemon 上点出来的两个问题（预览：Lead 忙时连着发两句）。
describe('regressions found in the preview', () => {
  it('keeps the composer mounted when the tray appears, so focus and the typed text stay', () => {
    const runtime = setup([running]);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '正在打的字' } });
    act(() => runtime.control.getState().replaceConversation(SESSION, [running, first]));
    expect(screen.getByTestId('queue-tray')).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBe(input);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('正在打的字');
  });

  it('gives a queued follow-up no Lead side, so the live reply keeps the moving Fairy', () => {
    setup([{ ...running, assistantText: '我先查一下' }, first]);
    expect(screen.queryByText(/Paimon · 发送中/)).toBeNull();
    const marks = screen.getAllByTestId('message-fairy');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute('aria-label')).toBe('Paimon is thinking');
  });
});

describe('queueCount', () => {
  it('adds your follow-ups to every queued external message', () => {
    expect(queueCount(2, queue)).toBe(3);
    expect(queueCount(1, null)).toBe(1);
  });
});
