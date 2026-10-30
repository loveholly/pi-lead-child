// @vitest-environment jsdom
// 工单详情只在用户自己打开时出现（2026-10-16 用户决定）：Lead 会话是主界面。
// 以前桌面上没有选中的工单时，工作台自己选一张在做的工单并打开详情（Workbench.web 的 effect）：
//   · 每次刷新页面都自己打开 #66（工作区的状态不落盘，刷新后没有选中）；
//   · 用户关掉详情、发一句话，刷新清掉选中以后，又自己打开另一张（例如选中的是提醒 #83，工单列表只装 task）。
// 现在没有自动打开。用户点左栏的工单行、会话里的工单小标签或卡片、Lead 画的卡片里的 TicketRef 才打开；
// 顶栏只在详情开着时写「当前工单」。
import {
  PROTOCOL_VERSION, type ConversationTurn, type HelloV2, type Overview, type TicketSummary, type TimelineResponse,
  type UiSurface,
} from '@pi-lead-child/protocol';
import type { ConnectionHandlers, ControlPlaneCredentials } from '@pi-lead-child/client';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { setViewportWidth } from '../../../test/workbench';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import type { ConversationCardEntity } from '../../state/types';
import { createCompanionStateRuntime, type CompanionTransport } from '../../state/runtime';
import { TicketExecutionConversationCard } from '../chat/ConversationTicketCard';
import { SurfaceView } from '../genui/SurfaceView';
import Workbench from './Workbench.web';

vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const binding = { id: 7, kind: 'companion', name: 'web', scopes: ['chat', 'tickets:view'] } as ControlPlaneCredentials['binding'];
const credentials: ControlPlaneCredentials = { baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 };

const hello: HelloV2 = {
  type: 'hello.v2', protocolVersion: PROTOCOL_VERSION, serverTime: '2026-10-16T01:00:00.000Z', timezone: 'Asia/Shanghai',
  latestSeq: 0, capabilities: ['chat.client-message-id.v1'], binding,
  daemon: { model: 'stub', sessionId: SESSION, busy: false },
};

const overview: Overview = {
  model: 'stub', sessionId: SESSION, busy: false, runningTicketIds: [],
  counts: { activeTickets: 1, reviewTickets: 1, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
  aish: null,
};

function ticket(id: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id, title: `工单 ${id}`, summary: '', kind: 'task', hasRun: true, priority: 'normal', project: null,
    dueAt: null, deferUntil: null, updatedAt: '2026-10-16T01:00:00.000Z', parentTicketId: null, rootTicketId: id,
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'active', status: 'active',
    ...overrides,
  };
}

function gateway() {
  let handlers: ConnectionHandlers = {};
  const turns: ConversationTurn[] = [];
  // 一张在做的、一张待验收的：以前桌面加载时会自己打开其中一张。
  let tickets = [ticket(7), ticket(66, { stage: 'review', status: 'review' })];
  const client = {
    getOverview: vi.fn(async () => overview),
    getTickets: vi.fn(async () => tickets.map((item) => ({ ...item }))),
    getProjects: vi.fn(async () => []),
    getAgenda: vi.fn(async () => []),
    // 日程里有一条提醒 #83（提醒不在工单列表里）。时间取「现在起一小时后」：日程默认只列今天以后的事，
    // 写死的日期过了那一天就不显示了（2026-10-20 起这条测试失败过）。
    getTimeline: vi.fn(async (): Promise<TimelineResponse> => ({
      entries: [{
        id: 'reminder:83', kind: 'reminder', at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), allDay: false, title: '关注 aish PR86',
        ticketId: 83, project: null, status: 'upcoming', risk: null, editable: false,
      }],
      overdue: [], generatedAt: '2026-10-16T01:00:00.000Z', leadNote: null,
    })),
    getConversationTurns: vi.fn(async () => turns.map((turn) => ({ ...turn }))),
    connect: vi.fn(async (next: ConnectionHandlers = {}) => {
      handlers = next;
      handlers.onHello?.(hello);
      handlers.onStateChange?.('connected');
    }),
    disconnect: vi.fn(),
    setPresence: vi.fn(),
    forget: vi.fn(async () => {}),
    sendChatCommand: vi.fn(async (input: Parameters<CompanionTransport['sendChatCommand']>[0]) => {
      const at = '2026-10-16T01:10:00.000Z';
      turns.push({
        id: 'turn-1', originBindingId: binding.id, originKind: 'paired:companion', ticketId: null, state: 'completed',
        userText: input.message, assistantText: '', error: null, createdAt: at, updatedAt: at,
      });
      return { turnId: 'turn-1' };
    }),
  } as unknown as CompanionTransport & { sendChatCommand: ReturnType<typeof vi.fn> };
  return {
    client,
    setTickets: (next: TicketSummary[]) => { tickets = next; },
    // daemon 在 Lead 调了改工单或日程的工具之后推的那条事件：客户端重取工单列表。
    ticketUpdated: (seq: number) => handlers.onEvent?.({
      protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'ticket.updated',
      occurredAt: '2026-10-16T01:10:01.000Z', requiredScope: 'tickets:view', audienceBindingId: null,
      turnId: null, ticketId: null, payload: { snapshotRequired: true },
    }),
  };
}

// 刷新以后的桌面工作台：工作区状态是新的（不落盘），没有选中的工单。extra 放在同一个运行时下面（会话里的卡片）。
async function mount(extra: ReactNode = null) {
  setViewportWidth(1440);
  const stub = gateway();
  const runtime = createCompanionStateRuntime({
    client: stub.client,
    credentials: { load: async () => credentials, save: async () => {}, clear: async () => {} },
    scheduler: { schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (handle) => clearTimeout(handle as never), now: () => Date.now() },
  });
  await act(async () => { await runtime.start(); });
  runtime.workspace.setState({ hydrated: true });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench />{extra}</CompanionRuntimeProvider>);
  await act(async () => {});
  return { runtime, stub };
}

async function openFromRail(ticketId: number) {
  fireEvent.click(screen.getByTestId('rail-view-tickets'));
  fireEvent.click(await screen.findByTestId(`ticket-row-${ticketId}`));
  await act(async () => {});
}

afterEach(() => setViewportWidth(0));

describe('the ticket panel on desktop', () => {
  it('stays closed on a fresh load, even with an active and a review ticket', async () => {
    const { runtime } = await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByTestId('ticket-thread')).toBeNull();
    expect(runtime.workspace.getState()).toMatchObject({ selectedTicketId: null, threadOpen: false });
    expect(screen.queryByTestId('lead-selected-ticket-context')).toBeNull();
  });

  it('names the current ticket in the header only while its panel is open', async () => {
    await mount();
    await openFromRail(66);
    expect(screen.queryByTestId('ticket-thread')).toBeTruthy();
    expect(within(screen.getByTestId('lead-selected-ticket-context')).getByText('#66 · 当前工单')).toBeTruthy();

    fireEvent.click(screen.getAllByTestId('ticket-thread-header-close')[0]!);
    await act(async () => {});
    expect(screen.queryByTestId('ticket-thread')).toBeNull();
    expect(screen.queryByTestId('lead-selected-ticket-context')).toBeNull();
    expect(screen.queryByText('#66 · 当前工单')).toBeNull();
  });
});

describe('what the user can open the panel from', () => {
  it('opens from a ticket row in the rail', async () => {
    const { runtime } = await mount();
    await openFromRail(7);
    expect(screen.queryByTestId('ticket-thread')).toBeTruthy();
    expect(runtime.workspace.getState().selectedTicketId).toBe(7);
  });

  it('opens from a ticket chip in the conversation', async () => {
    const chipCard = {
      id: 'turn:t1:ticket:7', key: 'turn:t1:ticket:7', kind: 'ticket_execution', turnId: 't1', ticketId: 7,
      operations: [], operationsTruncated: false, createdAt: '2026-10-16T01:00:00.000Z', updatedAt: '2026-10-16T01:00:00.000Z',
      source: 'durable', durableId: 1,
    } as unknown as ConversationCardEntity & { kind: 'ticket_execution' };
    const { runtime } = await mount(<TicketExecutionConversationCard card={chipCard} collapsed compact={false} />);
    fireEvent.click(await screen.findByTestId('ticket-chip-7'));
    await act(async () => {});
    expect(screen.queryByTestId('ticket-thread')).toBeTruthy();
    expect(runtime.workspace.getState().selectedTicketId).toBe(7);
  });

  it('opens from a TicketRef in a card Lead drew', async () => {
    const surface: UiSurface = {
      id: 'ref-66', catalogVersion: 1, root: 'head', fallbackText: '#66',
      nodes: [{ id: 'head', type: 'TicketRef', props: { ticket: 66 } }],
    };
    const { runtime } = await mount(<SurfaceView surface={surface} />);
    fireEvent.click(await screen.findByTestId('surface-ticket-66'));
    await act(async () => {});
    expect(screen.queryByTestId('ticket-thread')).toBeTruthy();
    expect(runtime.workspace.getState().selectedTicketId).toBe(66);
  });
});

describe('a ticket panel the user closed', () => {
  it('stays closed after the user sends a message, even when the selection then leaves the ticket list', async () => {
    const { runtime, stub } = await mount();
    await openFromRail(7);
    fireEvent.click(screen.getAllByTestId('ticket-thread-header-close')[0]!);
    await act(async () => {});
    expect(screen.queryByTestId('ticket-thread')).toBeNull();

    stub.setTickets([ticket(66, { stage: 'review', status: 'review' })]);
    const input = screen.getByTestId('composer-input');
    await act(async () => { fireEvent.change(input, { target: { value: '你好' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 }); });
    await vi.waitFor(() => expect(stub.client.sendChatCommand).toHaveBeenCalledTimes(1));
    await act(async () => { stub.ticketUpdated(1); });
    await vi.waitFor(() => expect(runtime.control.getState().ticketIds).toEqual([66]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(screen.queryByTestId('ticket-thread')).toBeNull();
    expect(runtime.workspace.getState().threadOpen).toBe(false);
  });

  it('does not select a reminder from the schedule, and no refresh opens a ticket', async () => {
    const { runtime, stub } = await mount();
    fireEvent.click(screen.getByTestId('rail-view-agenda'));
    const row = await screen.findByTestId('agenda-row-reminder:83');
    fireEvent.click(within(row).getByText('关注 aish PR86'));
    await act(async () => {});
    expect(runtime.workspace.getState().selectedTicketId).toBeNull();

    await act(async () => { stub.ticketUpdated(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByTestId('ticket-thread')).toBeNull();
  });
});
