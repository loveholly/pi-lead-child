// @vitest-environment jsdom
// 工单 07（Lead 事件主干 spec D10、D11）：提醒在会话里的样子。
//   · 到点卡：daemon 推来一张提醒卡（resource=lead-activity，带 reminder），会话里马上出现，不等 Lead：
//     时间、事情、「重要」标记、推送的情况，「知道了」「10 分钟后再提醒」。
//   · 一条提醒一张卡：新版本原地更新；确认以后收成一行「09:00 抢票 · 09:01 已确认」；旧版本忽略。
//   · Lead 为它单独回的那一轮挂在卡下面，不另起气泡。
//   · interrupt 级的同时在输入框上方显示横幅：横幅上的「知道了」确认这条提醒，另有「10 分钟后再提醒」，没有「打开 #N」。
//   · 创建时的提醒卡：「重要」标记，「改时间」「取消」。
import {
  PROTOCOL_VERSION, type ConversationTurn, type GatewayEvent, type LeadInterrupt, type ReminderCard, type TicketDetail,
  type TicketSummary,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { ConversationCardEntity } from '../../state/types';
import { TicketExecutionConversationCard } from './ConversationTicketCard';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const SESSION = 'lead-session';
// 本地时间 2026-10-18 09:00。按本地时间造，测试不依赖机器的时区。
const local = (hour: number, minute: number) => new Date(2026, 9, 18, hour, minute).toISOString();

function reminder(overrides: Partial<ReminderCard> = {}): ReminderCard {
  return {
    key: 'reminder:5@40', entityKey: 'reminder:5', entityVersion: 41, lastSeq: 41, seq: 40,
    at: local(9, 0), updatedAt: local(9, 0), reminderId: 5, title: '抢票', remindAt: local(9, 0), level: 'interrupt',
    state: 'fired', closedAt: null, closedBy: null, nextAt: null,
    pushes: { count: 1, planned: 6, lastAt: local(9, 0), nextAt: local(9, 2), exhausted: false, earlyAt: local(8, 55) },
    ticketId: null, check: null, leadTurnId: null, lead: null,
    ...overrides,
  };
}

function interrupt(overrides: Partial<LeadInterrupt> = {}): LeadInterrupt {
  return {
    key: 'interrupt:40', seq: 40, entityKey: 'reminder:5', entityVersion: 41, lastSeq: 40,
    at: local(9, 0), ticketId: 5, kind: 'timer.fired', summary: '提醒「抢票」到点', rootCause: null,
    basis: [{ kind: 'order', id: 'reminder.fire', version: 1 }], acknowledgedAt: null, resolvedElsewhere: false,
    ...overrides,
  };
}

function setup(client: Partial<CompanionRuntimeDependencies['client']> = {}, turns: ConversationTurn[] = []) {
  const runtime = createCompanionStateRuntime({
    client: client as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceConversation(SESSION, turns);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

let seq = 0;
function push(runtime: ReturnType<typeof setup>, item: { reminder: ReminderCard } | { interrupt: LeadInterrupt }) {
  seq += 1;
  const projection = 'reminder' in item ? item.reminder : item.interrupt;
  const event: GatewayEvent = {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'snapshot.required', occurredAt: local(9, 0),
    requiredScope: 'chat', audienceBindingId: null, turnId: null, ticketId: null,
    payload: { resource: 'lead-activity', entityKey: projection.entityKey, entityVersion: projection.entityVersion, ...item },
  };
  act(() => {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  });
}

describe('the card when a reminder fires', () => {
  // 2026-10-27 用户：到点卡还是改版以前的样子，而且会话里有两张。现在到点卡就是那条提醒（对象组件 Reminder 的到点态）：
  // 票根、标题、「重要，到点了」、推送的情况，右边「知道了」；「10 分钟后」在点开以后改时间的选项里。
  it('appears at once as the reminder itself, with the important mark, the pushes and 知道了', () => {
    const runtime = setup();
    push(runtime, { reminder: reminder() });
    const card = within(screen.getByTestId('reminder-fire-5'));
    expect(card.getByTestId('reminder-card-5')).toBeTruthy();
    expect(card.getByTestId('reminder-card-5').textContent).toContain('抢票');
    expect(card.getByTestId('reminder-card-fired').textContent).toBe('重要，到点了');
    expect(card.getByTestId('reminder-card-note').textContent).toBe('08:55 提前推过 · 已推送 1 次 · 没确认 09:02 再推');
    expect(card.getByRole('button', { name: '知道了' })).toBeTruthy();
  });

  it('updates in place, folds into one line when confirmed, and ignores an older version', () => {
    const runtime = setup();
    push(runtime, { reminder: reminder() });
    push(runtime, { reminder: reminder({ entityVersion: 43, lastSeq: 43, pushes: { ...reminder().pushes, count: 2, nextAt: local(9, 4) } }) });
    expect(screen.getAllByTestId(/^reminder-fire-5$/)).toHaveLength(1);
    expect(screen.getByTestId('reminder-card-note').textContent).toContain('已推送 2 次');
    push(runtime, { reminder: reminder({ entityVersion: 44, lastSeq: 44, state: 'acked', closedAt: local(9, 1), closedBy: 'user' }) });
    expect(screen.getByTestId('reminder-fire-line').textContent).toBe('09:00 抢票 · 09:01 已确认');
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull();
    // 乱序到达的旧版本不让它回到「到点」。
    push(runtime, { reminder: reminder() });
    expect(screen.getByTestId('reminder-fire-line').textContent).toBe('09:00 抢票 · 09:01 已确认');
    push(runtime, { reminder: reminder({ entityVersion: 50, lastSeq: 50, state: 'snoozed', closedAt: local(9, 1), nextAt: local(9, 11) }) });
    expect(screen.getByTestId('reminder-fire-line').textContent).toBe('09:00 抢票 · 改到 09:11');
  });

  it('says it stays in the tray when the pushes ran out', () => {
    const runtime = setup();
    push(runtime, { reminder: reminder({ pushes: { count: 6, planned: 6, lastAt: local(9, 10), nextAt: null, exhausted: true, earlyAt: null } }) });
    expect(screen.getByTestId('reminder-card-note').textContent).toBe('已推送 6 次 · 还没确认，留在「待你」里');
  });

  it('hangs Lead\'s own turn under the card instead of a separate bubble', () => {
    const answer: ConversationTurn = {
      id: 'turn_reminder_1', originBindingId: null, originKind: 'system:reminder', ticketId: null, state: 'completed',
      userText: '', assistantText: '12306 的候补入口在「我的」里，9:00 开售。', error: null,
      createdAt: local(9, 0), updatedAt: local(9, 0),
    };
    const runtime = setup({}, [answer]);
    // 映射还没到：它暂时是一个普通的 Lead 回合。
    expect(screen.getAllByText('12306 的候补入口在「我的」里，9:00 开售。')).toHaveLength(1);
    push(runtime, { reminder: reminder({ entityVersion: 42, lastSeq: 42, leadTurnId: 'turn_reminder_1' }) });
    const card = within(screen.getByTestId('reminder-fire-5'));
    expect(card.getByTestId('reminder-fire-lead').textContent).toContain('12306 的候补入口在「我的」里，9:00 开售。');
    // 只有卡下面这一处，没有另起的气泡。
    expect(screen.getAllByText('12306 的候补入口在「我的」里，9:00 开售。')).toHaveLength(1);
  });

  it('shows what Lead wrote on the card when it was steered into another turn', () => {
    const runtime = setup();
    push(runtime, { reminder: reminder({ entityVersion: 42, lead: { disposition: 'handled', reason: '我看了，还有余票。', at: local(9, 1) } }) });
    expect(within(screen.getByTestId('reminder-fire-5')).getByTestId('reminder-fire-lead').textContent).toContain('我看了，还有余票。');
  });

  it('confirms with 知道了, and moves it 10 minutes on from the panel', async () => {
    const runtime = setup();
    const runTicketAction = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue(undefined as never);
    const performUiAction = vi.spyOn(runtime, 'performUiAction').mockResolvedValue(undefined as never);
    // 「知道了」和改时间都是操作层里提醒的操作，能不能按由同一个函数回答。
    vi.spyOn(runtime, 'listUiActions').mockResolvedValue([
      { id: 'ack', label: '知道了', permission: 'user_only', available: true, reason: null, irreversible: false, where: '', params: [] } as never,
      { id: 'reschedule', label: '改时间', permission: 'lead_allowed', available: true, reason: null, irreversible: false, where: '', params: [] } as never,
    ]);
    push(runtime, { reminder: reminder() });
    fireEvent.click(await screen.findByRole('button', { name: '知道了' }));
    await waitFor(() => expect(performUiAction).toHaveBeenCalledWith('reminder', '5', 'ack', { input: {} }));
    expect(runTicketAction).not.toHaveBeenCalled();
    performUiAction.mockClear();
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-5-summary'));
    fireEvent.click(await screen.findByRole('radio', { name: '10 分钟后' }));
    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: /^改到/ }));
    await waitFor(() => expect(performUiAction).toHaveBeenCalled());
    const [type, id, action, options] = performUiAction.mock.calls[0]! as [string, string, string, { input: { remindAt: string } }];
    expect([type, id, action]).toEqual(['reminder', '5', 'reschedule']);
    expect(Date.parse(options.input.remindAt) - before).toBeGreaterThanOrEqual(9 * 60_000);
  });

  // 线上 2026-10-27 #151：设提醒那一轮的卡是一张 ticket_execution 会话卡片（不是消息里的工单片段），到点以后它也不再画。
  it('does not draw the reminder a second time from the card of the turn that set it', () => {
    const runtime = setup();
    act(() => runtime.control.getState().mergeConversationCardPage({
      items: [{
        id: 1, key: 'turn:t1:ticket:5', kind: 'ticket_execution', turnId: 't1', ticketId: 5,
        operations: [{ id: 't1:call-0', name: 'create_reminder', state: 'completed', label: 'create_reminder #5', detail: 'Created reminder #5' }],
        operationsTruncated: false, createdAt: local(8, 0), updatedAt: local(8, 0),
      }],
      checkpoints: [], interventionRefs: [], hasMore: false, nextBeforeId: null,
    } as never, 'replace'));
    expect(screen.getAllByTestId('reminder-card-5')).toHaveLength(1);
    push(runtime, { reminder: reminder() });
    expect(screen.getAllByTestId('reminder-card-5')).toHaveLength(1);
    expect(within(screen.getByTestId('reminder-fire-5')).getByTestId('reminder-card-5')).toBeTruthy();
  });

  // 会话里一条提醒只有一张卡：到点以后，设提醒那一轮里的提醒卡不再画，到点卡就是它。
  it('does not draw the reminder a second time in the turn that set it', () => {
    const turn: ConversationTurn = {
      id: 'turn-set', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
      userText: '9 点提醒我抢票', assistantText: '好，记下了。', error: null, createdAt: local(8, 0), updatedAt: local(8, 0),
      toolCalls: [{
        callId: 'c1', name: 'create_reminder', state: 'completed', textOffset: 0,
        args: { preview: '{"title":"抢票"}', truncated: false, redacted: false, artifactRefs: [] },
        result: { preview: '{"content":[{"type":"text","text":"created reminder #5"}]}', truncated: false, redacted: false, artifactRefs: [] },
        error: null, startedAt: local(8, 0), endedAt: local(8, 0),
      }],
    };
    const runtime = setup({}, [turn]);
    push(runtime, { reminder: reminder() });
    expect(screen.getAllByTestId('reminder-card-5')).toHaveLength(1);
    expect(within(screen.getByTestId('reminder-fire-5')).getByTestId('reminder-card-5')).toBeTruthy();
  });
});

describe('the banner for an important reminder', () => {
  it('confirms the reminder itself, offers 10 分钟后再提醒, and does not open it as a ticket', async () => {
    const performTicketAction = vi.fn(async (ticketId: number, action: string) => ({ ticketId, action, ticket: null }));
    const acknowledgeLeadInterrupt = vi.fn();
    const rescheduleReminder = vi.fn(async (ticketId: number) => ({ ticketId, remindAt: local(9, 11), ticket: null }));
    const runtime = setup({ performTicketAction, acknowledgeLeadInterrupt, rescheduleReminder } as never);
    push(runtime, { interrupt: interrupt() });
    const banner = within(screen.getByTestId('interrupt-banner'));
    expect(banner.getByTestId('interrupt-banner-text').textContent).toBe('提醒「抢票」到点');
    expect(banner.queryByText('打开 #5')).toBeNull();
    fireEvent.click(banner.getByTestId('interrupt-banner-snooze'));
    await waitFor(() => expect(rescheduleReminder).toHaveBeenCalledWith(5, { snoozeMinutes: 10 }));
    fireEvent.click(banner.getByTestId('interrupt-banner-ack'));
    await waitFor(() => expect(performTicketAction).toHaveBeenCalledWith(5, 'ack', {}));
    expect(acknowledgeLeadInterrupt).not.toHaveBeenCalled();
    // 提醒结束了：daemon 推横幅结束的样子，横幅收起。
    push(runtime, { interrupt: interrupt({ entityVersion: 45, lastSeq: 44, acknowledgedAt: local(9, 1) }) });
    expect(screen.queryByTestId('interrupt-banner')).toBeNull();
  });
});

describe('the reminder card Lead created', () => {
  const summary: TicketSummary = {
    id: 5, title: '抢票', summary: '', kind: 'reminder', hasRun: false, priority: 'normal',
    project: null, dueAt: null, deferUntil: null, updatedAt: local(8, 0),
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'scheduled', status: 'scheduled',
  };
  const detail = (stage: 'scheduled' | 'fired'): TicketDetail => ({
    ticket: { ...summary, stage, status: stage }, brief: '', body: '', workdir: null, createdAt: local(8, 0),
    totalTokens: 0, totalCostUsd: 0, remindAt: local(9, 0), createdBy: 'lead',
    reminder: { level: 'interrupt', earlyMs: 300_000, repeat: { everyMs: 120_000, max: 5 }, ticketId: null, check: null },
  });
  const operationCard = {
    id: 'turn:t1:ticket:5', key: 'turn:t1:ticket:5', kind: 'ticket_execution', turnId: 't1', ticketId: 5,
    operations: [{ id: 't1:call-0', name: 'create_reminder', state: 'completed', label: 'create_reminder #5', detail: 'Created reminder #5' }],
    operationsTruncated: false, createdAt: local(8, 0), updatedAt: local(8, 0), source: 'durable', durableId: 1,
  } as ConversationCardEntity & { kind: 'ticket_execution' };

  function render(getTicket: () => Promise<TicketDetail>, extra: Partial<CompanionRuntimeDependencies['client']> = {}) {
    const runtime = createCompanionStateRuntime({
      client: { getTicket: vi.fn(getTicket), ...extra } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      // 失效重取按这个调度器排（真的计时器，0 毫秒）。
      scheduler: {
        schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
        cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <TicketExecutionConversationCard card={operationCard} collapsed={false} compact={false} />
      </CompanionRuntimeProvider>,
    );
    return runtime;
  }

  // 2026-10-27 按画布重画：卡上没有按钮，点开以后在浮层里改时间、取消（细节见 reminderCard.test.tsx）。
  it('marks it important and offers 改到… and 取消提醒 once it is opened', async () => {
    render(async () => detail('scheduled'));
    expect(await screen.findByText('重要，到点会打断你')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消提醒' })).toBeNull();
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-5-summary'));
    expect(await screen.findByRole('button', { name: '取消提醒' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '改到…' })).toBeTruthy();
  });

  // 到点以后会话里另有一张到点卡（ReminderFireCard）；这张卡写「到点了」。
  // daemon 到点时推一条带编号的 ticket.updated（工单 07）：卡片马上重取，不等到点 70 秒以后。
  it('shows the fired state as soon as the daemon announces the reminder, without the 70 second timer', async () => {
    let current = detail('scheduled');
    const runtime = render(async () => current);
    expect(await screen.findByText('重要，到点会打断你')).toBeTruthy();
    current = detail('fired');
    // 连上了 daemon（hello 带来 Lead 的会话）：之后的事件照常应用。
    act(() => runtime.handleHello({ latestSeq: 0, daemon: { sessionId: SESSION }, capabilities: [] } as never));
    act(() => {
      runtime.handleEvent({
        protocolVersion: PROTOCOL_VERSION, eventId: 'event-fired', seq: 900, type: 'ticket.updated', occurredAt: local(9, 0),
        requiredScope: 'tickets:view', audienceBindingId: null, turnId: null, ticketId: 5,
        payload: { ticketId: 5, snapshotRequired: true },
      });
    });
    expect(await screen.findByText(/到点了$/, {}, { timeout: 1_000 })).toBeTruthy();
  });
});
