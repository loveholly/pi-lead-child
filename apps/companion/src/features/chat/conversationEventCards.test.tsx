// @vitest-environment jsdom
// 工单 06（Lead 事件主干 spec D10）：会话里的卡片和状态。
//   · 「Lead 动态」里每种卡片的状态：摘要、自动处理、常设指令的修改、Lead 自己处理掉的事、Lead 的补充、别处已处理；
//     每一行写明依据（常设指令的编号和版本）。
//   · 一个对象一张卡：新版本原地更新同一行，Lead 后来的补充挂在同一行下面，不另起一行或一个气泡；旧版本忽略。
//   · interrupt 级在输入框上方显示横幅，用户点「知道了」之前一直在；别的客户端确认了、别处已处理了，横幅也收起。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import {
  PROTOCOL_VERSION, type GatewayEvent, type LeadActivityCard, type LeadInterrupt, type LeadStatus, type Overview,
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
const overview: Overview = {
  model: 'stub', sessionId: SESSION, busy: false, runningTicketIds: [],
  counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
  aish: null, lead: online,
};

function card(overrides: Partial<LeadActivityCard> = {}): LeadActivityCard {
  return {
    key: 'ticket:7@10', entityKey: 'ticket:7', entityVersion: 10, lastSeq: 10,
    at: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z', ticketId: 7,
    kind: 'digest', state: 'open', summary: '#7 第一次重试', count: 1,
    basis: [{ kind: 'order', id: 'run.transient_retry', version: 1 }], lead: null, entries: [],
    ...overrides,
  };
}

function interrupt(overrides: Partial<LeadInterrupt> = {}): LeadInterrupt {
  return {
    key: 'interrupt:20', seq: 20, entityKey: 'reminder:5', entityVersion: 20, lastSeq: 20,
    at: '2026-10-17T01:05:00.000Z', ticketId: 5, kind: 'timer.fired', summary: '提醒「交房租」到点', rootCause: null,
    basis: [{ kind: 'order', id: 'reminder.fire', version: 1 }], acknowledgedAt: null, resolvedElsewhere: false,
    ...overrides,
  };
}

function setup(client: Partial<CompanionRuntimeDependencies['client']> = {}) {
  const runtime = createCompanionStateRuntime({
    client: client as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview });
  runtime.control.getState().replaceConversation(SESSION, []);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

let seq = 0;
function push(runtime: ReturnType<typeof setup>, item: { card: LeadActivityCard } | { interrupt: LeadInterrupt }) {
  seq += 1;
  const projection = 'card' in item ? item.card : item.interrupt;
  const event: GatewayEvent = {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'snapshot.required', occurredAt: '2026-10-17T01:00:00.000Z',
    requiredScope: 'chat', audienceBindingId: null, turnId: null, ticketId: projection.ticketId,
    payload: { resource: 'lead-activity', entityKey: projection.entityKey, entityVersion: projection.entityVersion, ...item },
  };
  act(() => {
    const adapted = adaptGatewayEvent(event);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  });
}

function row(key: string) {
  return within(screen.getByTestId(`lead-activity-${key}`));
}

describe('cards in Lead activity', () => {
  it('shows every kind of card with its state and its basis', async () => {
    const runtime = setup();
    act(() => runtime.control.getState().replaceLeadActivity({
      watermark: 60,
      interrupts: [],
      cards: [
        card(),
        card({
          key: 'ticket:8@20', entityKey: 'ticket:8', entityVersion: 20, lastSeq: 20, ticketId: 8, kind: 'auto', state: 'seen',
          at: '2026-10-17T01:01:00.000Z', summary: '#8 按常设指令自动重试，成功了',
        }),
        card({
          key: 'standing_order:inbox.no_wake@30', entityKey: 'standing_order:inbox.no_wake', entityVersion: 31, lastSeq: 30, ticketId: null,
          kind: 'standing_order', state: 'seen', at: '2026-10-17T01:02:00.000Z',
          summary: '常设指令「不叫醒 Lead 的事进摘要」修改 v1→v2（Lead 改得更保守，直接生效）',
          basis: [{ kind: 'rule', name: 'standing_order_change_reported' }],
        }),
        card({
          key: 'inbox:40', entityKey: 'ticket:9', entityVersion: 40, lastSeq: 40, ticketId: 9, kind: 'lead', state: 'handled',
          at: '2026-10-17T01:03:00.000Z', summary: '#9 核查报了缺陷', basis: [{ kind: 'order', id: 'inbox.wake_lead', version: 1 }],
          lead: { disposition: 'deferred', reason: '等最终结论一起说', at: '2026-10-17T01:03:00.000Z' },
        }),
        card({
          key: 'ticket:10@50', entityKey: 'ticket:10', entityVersion: 52, lastSeq: 51, ticketId: 10, state: 'handled', count: 2,
          at: '2026-10-17T01:04:00.000Z', summary: '#10 子任务完成',
          basis: [{ kind: 'order', id: 'inbox.no_wake', version: 1 }, { kind: 'order', id: 'inbox.merge_attention', version: 1, effect: 'inbox_merged' }],
          lead: { disposition: 'handled', reason: '已经合进主分支', at: '2026-10-17T01:06:00.000Z' },
        }),
        card({
          key: 'ticket:11@60', entityKey: 'ticket:11', entityVersion: 61, lastSeq: 60, ticketId: 11, state: 'resolved_elsewhere',
          at: '2026-10-17T01:05:00.000Z', summary: '#11 等你批准部署',
        }),
      ],
    }));

    expect(screen.getByText(/^Paimon 在后台处理了 6 件事 · /)).toBeTruthy();
    // 块默认收起，每行只有一行字（2026-10-24）；依据和 Lead 的补充展开后才有。
    expect(screen.queryByTestId('lead-activity-basis')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await screen.findByTestId('lead-activity-panel');
    expect(row('ticket:7@10').getByTestId('lead-activity-label').textContent).toBe('摘要');
    expect(row('ticket:7@10').getAllByTestId('lead-activity-basis-item').map((item) => item.textContent)).toEqual(['run.transient_retry v1']);
    expect(row('ticket:8@20').getByTestId('lead-activity-label').textContent).toBe('自动处理');
    expect(row('standing_order:inbox.no_wake@30').getByTestId('lead-activity-label').textContent).toBe('指令修改');
    expect(row('standing_order:inbox.no_wake@30').getAllByTestId('lead-activity-basis-item').map((item) => item.textContent)).toEqual(['指令修改要告诉你']);
    expect(row('inbox:40').getByTestId('lead-activity-label').textContent).toBe('延后');
    expect(row('inbox:40').getByText('#9 核查报了缺陷')).toBeTruthy();
    expect(row('inbox:40').getByTestId('lead-activity-note').textContent).toBe('Paimon：等最终结论一起说');
    expect(row('ticket:10@50').getByTestId('lead-activity-note').textContent).toBe('Paimon：处理好了 · 已经合进主分支');
    expect(row('ticket:10@50').getAllByTestId('lead-activity-basis-item').map((item) => item.textContent)).toEqual(['inbox.no_wake v1', 'inbox.merge_attention v1']);
    expect(row('ticket:10@50').getByText('2 条')).toBeTruthy();
    expect(row('ticket:11@60').getByTestId('lead-activity-label').textContent).toBe('已在别处处理');
    expect(screen.queryByTestId('interrupt-banner')).toBeNull();
  });

  it('updates the same card in place and hangs Lead\'s later note under it', async () => {
    const runtime = setup();
    push(runtime, { card: card() });
    expect(screen.getAllByTestId(/^lead-activity-ticket:/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await screen.findByTestId('lead-activity-panel');

    push(runtime, { card: card({ entityVersion: 13, lastSeq: 12, count: 2, summary: '#7 第二次重试' }) });
    expect(screen.getAllByTestId(/^lead-activity-ticket:/)).toHaveLength(1);
    expect(row('ticket:7@10').getByText('#7 第二次重试')).toBeTruthy();
    expect(row('ticket:7@10').getByText('2 条')).toBeTruthy();

    // 乱序到达的旧版本不覆盖。
    push(runtime, { card: card() });
    expect(row('ticket:7@10').getByText('#7 第二次重试')).toBeTruthy();

    // Lead 后来的补充：同一行下面多一行，没有新的一行，也没有新的消息气泡。
    push(runtime, {
      card: card({
        entityVersion: 15, lastSeq: 12, count: 2, summary: '#7 第二次重试', state: 'handled',
        lead: { disposition: 'no_action', reason: '重试成功了，不用管', at: '2026-10-17T01:20:00.000Z' },
      }),
    });
    expect(screen.getAllByTestId(/^lead-activity-ticket:/)).toHaveLength(1);
    expect(row('ticket:7@10').getByTestId('lead-activity-note').textContent).toBe('Paimon：不处理 · 重试成功了，不用管');
    expect(screen.getAllByTestId('lead-activity-block')).toHaveLength(1);
    expect(runtime.control.getState().messageIdsBySession[SESSION] ?? []).toEqual([]);

    // 别处已处理：结束状态。
    push(runtime, { card: card({ entityVersion: 17, lastSeq: 12, count: 2, summary: '#7 第二次重试', state: 'resolved_elsewhere' }) });
    expect(row('ticket:7@10').getByTestId('lead-activity-label').textContent).toBe('已在别处处理');
  });
});

// 2026-10-29 用户：Lead 发现常驻偏好有出入时自己改，「推一条 lead agent 动态消息，附带一个撤销按钮」。
// 卡上的 action 是一个操作层的操作；点了以后同一张卡原地更新，action 没了，按钮跟着消失。按钮的状态变化不让这一行变高。
describe('the button on a Lead activity card', () => {
  const changed = (overrides: Partial<LeadActivityCard> = {}) => card({
    key: 'core_memory:12@70', entityKey: 'core_memory:12', entityVersion: 70, lastSeq: 70, ticketId: null, state: 'seen',
    at: '2026-10-17T02:00:00.000Z', summary: 'Paimon 改了常驻偏好「周报语言」：原来「周报用中文」，现在「周报用英文」。依据：你上周说过',
    basis: [{ kind: 'rule', name: 'core_memory_change_reported' }],
    action: { target: { type: 'core_memory_change', id: '31' }, action: 'undo', label: '撤销' },
    ...overrides,
  });

  it('runs the card operation, and the button goes away when the card updates in place', async () => {
    const performUiAction = vi.fn(async (type: string, id: string, action: string) => ({ target: { type, id }, action, result: {} }));
    const runtime = setup({ performUiAction } as never);
    push(runtime, { card: changed() });
    const line = row('core_memory:12@70');
    expect(line.getByTestId('lead-activity-label').parentElement!.textContent).toContain('常驻偏好 · ');
    const button = line.getByTestId('lead-activity-action-core_memory:12@70');
    expect(button.textContent).toBe('撤销');
    await act(async () => { fireEvent.click(button); });
    expect(performUiAction).toHaveBeenCalledWith('core_memory_change', '31', 'undo', { input: {} });
    await waitFor(() => expect(row('core_memory:12@70').getByTestId('lead-activity-action-core_memory:12@70').textContent).toBe('已撤销'));

    // 网关推来同一张卡的新版本：没有 action，按钮消失，还是一行。
    push(runtime, { card: changed({ entityVersion: 72, lastSeq: 71, summary: '你撤销了 Paimon 对常驻偏好「周报语言」的改动', action: undefined }) });
    expect(screen.getAllByTestId(/^lead-activity-core_memory:/)).toHaveLength(1);
    expect(row('core_memory:12@70').queryByTestId('lead-activity-action-core_memory:12@70')).toBeNull();
    expect(row('core_memory:12@70').getByText('你撤销了 Paimon 对常驻偏好「周报语言」的改动')).toBeTruthy();
  });

  it('draws no button on a card without an action', () => {
    const runtime = setup({ performUiAction: vi.fn() } as never);
    push(runtime, { card: card() });
    expect(row('ticket:7@10').queryByTestId('lead-activity-action-ticket:7@10')).toBeNull();
  });

  it('writes why it failed on the same line, word for word, and the whole sentence in the panel', async () => {
    const refused = new ControlPlaneClientError('这次改动之后这一条又改过，不能撤销这一次。', 'unavailable', 409);
    const performUiAction = vi.fn(async () => { throw refused; });
    const runtime = setup({ performUiAction } as never);
    push(runtime, { card: changed() });
    await act(async () => { fireEvent.click(row('core_memory:12@70').getByTestId('lead-activity-action-core_memory:12@70')); });
    // 原因在这一行里（不是这一行下面新加的一块），按钮恢复可用，可以再点。
    await waitFor(() => expect(row('core_memory:12@70').getByTestId('lead-activity-action-error').textContent)
      .toBe('撤销没有完成：这次改动之后这一条又改过，不能撤销这一次。'));
    expect(row('core_memory:12@70').getByTestId('lead-activity-action-core_memory:12@70').textContent).toBe('撤销');

    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const panel = await screen.findByTestId('lead-activity-panel');
    expect(within(panel).getByTestId('lead-activity-action-error').textContent).toBe('撤销没有完成：这次改动之后这一条又改过，不能撤销这一次。');
    expect(within(panel).getByTestId('lead-activity-action-core_memory:12@70').textContent).toBe('撤销');
  });

  it('keeps a card with an action on its own row, even when Lead handled several things with one note', () => {
    const note = { disposition: 'handled' as const, reason: '按你最近说的改', at: '2026-10-17T02:01:00.000Z' };
    const runtime = setup({ performUiAction: vi.fn() } as never);
    act(() => runtime.control.getState().replaceLeadActivity({
      watermark: 80,
      interrupts: [],
      cards: [
        changed({ kind: 'lead', state: 'handled', lead: note }),
        changed({ key: 'core_memory:13@75', entityKey: 'core_memory:13', entityVersion: 75, lastSeq: 75, kind: 'lead', state: 'handled', lead: note,
          action: { target: { type: 'core_memory_change', id: '32' }, action: 'undo', label: '撤销' } }),
      ],
    }));
    expect(screen.getAllByTestId(/^lead-activity-core_memory:/)).toHaveLength(2);
    expect(row('core_memory:13@75').getByTestId('lead-activity-action-core_memory:13@75')).toBeTruthy();
  });
});

describe('the interrupt banner above the composer', () => {
  it('stays until the user says got it, and the acknowledgement goes to the daemon', async () => {
    const acknowledgeLeadInterrupt = vi.fn(async (seqToAck: number) => interrupt({
      seq: seqToAck, entityVersion: 23, lastSeq: 22, acknowledgedAt: '2026-10-17T01:06:00.000Z',
    }));
    const runtime = setup({ acknowledgeLeadInterrupt });
    // 摘要不上横幅。
    push(runtime, { card: card() });
    expect(screen.queryByTestId('interrupt-banner')).toBeNull();

    push(runtime, { interrupt: interrupt() });
    expect(screen.getByTestId('interrupt-banner-text').textContent).toBe('提醒「交房租」到点');
    expect(screen.getByTestId('interrupt-banner-meta').textContent).toContain('依据 reminder.fire v1');
    // 别的事（新的摘要、同一条的旧版本）不让它消失。
    push(runtime, { card: card({ entityVersion: 13, lastSeq: 12, summary: '#7 第二次重试' }) });
    push(runtime, { interrupt: interrupt({ entityVersion: 19 }) });
    expect(screen.getByTestId('interrupt-banner')).toBeTruthy();

    fireEvent.click(screen.getByTestId('interrupt-banner-ack'));
    await waitFor(() => expect(screen.queryByTestId('interrupt-banner')).toBeNull());
    expect(acknowledgeLeadInterrupt).toHaveBeenCalledWith(20);
    // 确认之前发出的推送晚到了：横幅不回来。
    push(runtime, { interrupt: interrupt() });
    expect(screen.queryByTestId('interrupt-banner')).toBeNull();
  });

  it('shows the next one after the first is acknowledged on another device, and drops one resolved elsewhere', () => {
    const runtime = setup();
    push(runtime, { interrupt: interrupt() });
    push(runtime, { interrupt: interrupt({ key: 'interrupt:30', seq: 30, entityVersion: 30, lastSeq: 30, summary: '服务器磁盘快满了' }) });
    expect(screen.getByTestId('interrupt-banner-text').textContent).toBe('提醒「交房租」到点');
    expect(screen.getByTestId('interrupt-banner-meta').textContent).toContain('还有 1 条');

    push(runtime, { interrupt: interrupt({ entityVersion: 32, lastSeq: 31, acknowledgedAt: '2026-10-17T01:06:00.000Z' }) });
    expect(screen.getByTestId('interrupt-banner-text').textContent).toBe('服务器磁盘快满了');

    push(runtime, { interrupt: interrupt({ key: 'interrupt:30', seq: 30, entityVersion: 31, lastSeq: 30, summary: '服务器磁盘快满了', resolvedElsewhere: true }) });
    expect(screen.queryByTestId('interrupt-banner')).toBeNull();
  });
});
