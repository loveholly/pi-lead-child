// @vitest-environment jsdom
// Lead 忙时的排队状态栏（统一消息事件 spec D6、D12，工单 10）。Lead 正在一轮里、有外部消息排着时，输入框上方「插话/排队」
// 那一行的右边写「排队 N 条：谁、谁」；点开是锚定浮层，每个对话可以打开卡、排到下一个、移出队列。状态从 daemon 推来
// （snapshot.required，resource 是 lead-queue，带着整份排队），操作经 runtime 发到网关（操作层的 lead_queue）。
// 面板里的行没有按钮（低频操作不默认露出，用户 2026-10-26）：点整行打开卡，「排到下一个」「移出队列」在右边的「⋯」里。
import {
  CHAT_PLACEMENT_CAPABILITY, LEAD_QUEUE_RESOURCE, PROTOCOL_VERSION,
  type GatewayEvent, type LeadQueue, type LeadQueueEntry, type LeadStatus, type Overview,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

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

function entry(key: string, sender: string, overrides: Partial<LeadQueueEntry> = {}): LeadQueueEntry {
  return {
    key, conversation: `${sender}的私信`, source: 'slack', sourceLabel: 'Slack', senders: [sender], count: 1,
    excerpt: `${sender}的原话`, cardIds: [key === 'slack:@U1' ? 61 : 62], firstAt: '2026-10-27T01:00:00.000Z',
    lastAt: '2026-10-27T01:02:00.000Z', next: false, actions: ['move_next', 'remove'], ...overrides,
  };
}

const lilei = entry('slack:@U1', '李雷', { next: true, actions: ['remove'] });
const kent = entry('slack:@U2', 'Kent', { count: 2, excerpt: '那个机器人 不好用' });

function setup(options: { busy?: boolean; leadQueueAction?: (action: string, key: string) => Promise<LeadQueue> } = {}) {
  const leadQueueAction = vi.fn(options.leadQueueAction ?? (async () => ({ busy: true, entries: [] })));
  const runtime = createCompanionStateRuntime({
    client: { leadQueueAction } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: overview(options.busy ?? true),
    capabilities: [CHAT_PLACEMENT_CAPABILITY],
  });
  runtime.control.getState().replaceConversation(SESSION, []);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { runtime, leadQueueAction };
}

let seq = 0;
// daemon 推来的排队（snapshot.required，resource 是 lead-queue）。
function pushQueue(runtime: ReturnType<typeof setup>['runtime'], queue: LeadQueue) {
  seq += 1;
  const event: GatewayEvent = {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'snapshot.required', occurredAt: '2026-10-27T01:02:00.000Z',
    requiredScope: 'chat', audienceBindingId: null, turnId: null, ticketId: null,
    payload: { resource: LEAD_QUEUE_RESOURCE, queue },
  };
  act(() => {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  });
}

// 打开一行右边的「⋯」，返回菜单。react-native-web 的 measureInWindow 是异步的：量完位置才打开。
async function openMenu(key: string) {
  fireEvent.click(screen.getByTestId(`lead-queue-entry-${key}-more`));
  return screen.findByTestId(`lead-queue-entry-${key}-more-panel`);
}

async function openPanel() {
  fireEvent.click(screen.getByTestId('lead-queue-bar'));
  // react-native-web 的 measureInWindow 是异步的：量完状态栏的位置才打开浮层。
  return screen.findByTestId('lead-queue-panel');
}

describe('the queue status bar above the composer', () => {
  it('shows how many messages wait and who sent them while Lead is in a turn, and goes away when the queue is empty (scenario 13)', () => {
    const { runtime } = setup();
    expect(screen.queryByTestId('lead-queue-bar')).toBeNull();
    pushQueue(runtime, { busy: true, entries: [entry('slack:@U1', '李雷', { next: true, actions: ['remove'] })] });
    expect(screen.getByTestId('lead-queue-summary').textContent).toBe('排队 1 条：李雷');
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    expect(screen.getByTestId('lead-queue-summary').textContent).toBe('排队 3 条：李雷、Kent');
    // 这一轮结束、Lead 拿走了排着的消息：状态栏消失。
    pushQueue(runtime, { busy: true, entries: [] });
    expect(screen.queryByTestId('lead-queue-bar')).toBeNull();
  });

  it('does not show while Lead is not in a turn', () => {
    const { runtime } = setup({ busy: false });
    pushQueue(runtime, { busy: false, entries: [lilei] });
    expect(screen.queryByTestId('lead-queue-bar')).toBeNull();
  });

  it('lists each conversation in the panel with its state and no buttons, and offers moving to the front only when it is not next', async () => {
    const { runtime } = setup();
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    const panel = await openPanel();
    expect(within(panel).getByTestId('lead-queue-entry-slack:@U1-state').textContent).toBe('下一个');
    expect(within(panel).getByTestId('lead-queue-entry-slack:@U2-state').textContent).toBe('排队中');
    expect(within(panel).getByTestId('lead-queue-entry-slack:@U2-excerpt').textContent).toBe('那个机器人 不好用');
    expect(within(panel).getByText('2 条')).toBeTruthy();
    // 收起态没有按钮：操作在「⋯」里。
    expect(within(panel).queryAllByRole('button', { name: /^(排到下一个|移出队列|打开卡)$/u })).toEqual([]);
    const first = await openMenu('slack:@U1');
    expect(within(first).queryByTestId('lead-queue-entry-slack:@U1-move_next')).toBeNull();
    expect(within(first).getByTestId('lead-queue-entry-slack:@U1-remove')).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: '关闭' }));
    const second = await openMenu('slack:@U2');
    expect(within(second).getByTestId('lead-queue-entry-slack:@U2-move_next')).toBeTruthy();
  });

  // P13.5：手机上能点的区域至少 44pt。「⋯」的图标不变大，点击区是它外面 44×44 的一块，整块都在触发按钮里。
  it('gives the ⋯ of each row a 44 pt tap area inside its trigger (P13.5)', async () => {
    const { runtime } = setup();
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    const panel = await openPanel();
    for (const key of ['slack:@U1', 'slack:@U2']) {
      const area = within(panel).getByTestId(`lead-queue-entry-${key}-more-target`);
      expect(getComputedStyle(area).width).toBe('44px');
      expect(getComputedStyle(area).height).toBe('44px');
      expect(within(panel).getByTestId(`lead-queue-entry-${key}-more`).contains(area)).toBe(true);
    }
  });

  it('removes a conversation from the queue: the user handles it, and it leaves the list', async () => {
    const { runtime, leadQueueAction } = setup({ leadQueueAction: async () => ({ busy: true, entries: [{ ...lilei }] }) });
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    await openPanel();
    fireEvent.click(within(await openMenu('slack:@U2')).getByTestId('lead-queue-entry-slack:@U2-remove'));
    expect(leadQueueAction).toHaveBeenCalledWith('remove', 'slack:@U2');
    await waitFor(() => expect(screen.queryByTestId('lead-queue-entry-slack:@U2')).toBeNull());
    expect(screen.getByTestId('lead-queue-entry-slack:@U1')).toBeTruthy();
    expect(screen.getAllByTestId('lead-queue-summary')[0]!.textContent).toBe('排队 1 条：李雷');
  });

  it('moves a conversation to the front', async () => {
    const { runtime, leadQueueAction } = setup({
      leadQueueAction: async () => ({
        busy: true, entries: [{ ...kent, next: true, actions: ['remove'] }, { ...lilei, next: false, actions: ['move_next', 'remove'] }],
      }),
    });
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    await openPanel();
    fireEvent.click(within(await openMenu('slack:@U2')).getByTestId('lead-queue-entry-slack:@U2-move_next'));
    expect(leadQueueAction).toHaveBeenCalledWith('move_next', 'slack:@U2');
    await waitFor(() => expect(screen.getByTestId('lead-queue-entry-slack:@U2-state').textContent).toBe('下一个'));
  });

  it('says why an action did not go through and keeps the entry', async () => {
    const { runtime } = setup({ leadQueueAction: async () => { throw new Error('Kent的私信已经是下一个。'); } });
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    await openPanel();
    fireEvent.click(within(await openMenu('slack:@U2')).getByTestId('lead-queue-entry-slack:@U2-move_next'));
    expect(await screen.findByText('没有做成：Kent的私信已经是下一个。')).toBeTruthy();
    expect(screen.getByTestId('lead-queue-entry-slack:@U2')).toBeTruthy();
  });

  it('opens the card itself inside the panel when the row is pressed, and goes back to the queue', async () => {
    const { runtime } = setup();
    pushQueue(runtime, { busy: true, entries: [lilei, kent] });
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('lead-queue-entry-slack:@U2-open'));
    expect(screen.getByTestId('lead-queue-card')).toBeTruthy();
    expect(screen.queryByTestId('lead-queue-entry-slack:@U2')).toBeNull();
    fireEvent.click(screen.getByTestId('lead-queue-back'));
    expect(screen.getByTestId('lead-queue-entry-slack:@U2')).toBeTruthy();
  });
});
