// @vitest-environment jsdom
// 设置 → Lead 的名字 → 常设指令（工单 10）：清单、等你批准的提议、每条的版本历史和最近的执行记录、回滚。
// 系统写的标题、说明和 findings 里的「Lead」显示成 Lead 的名字（缺省 Paimon）；Lead 或用户写的原因原样显示。
// 契约在 packages/protocol/src/standing-orders-wire.ts；客户端方法是假的，断言的是界面发出的请求。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type {
  LeadProfileDto, StandingOrderDetailResponse, StandingOrderDto, StandingOrderExecutionDto, StandingOrderListResponse,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { connectionsRuntime, renderWithRuntime, type FakeConnectionClient } from '../../../test/connections';
import { proposal } from '../../../test/standingOrders';
import { StandingOrdersSection } from './StandingOrdersSection';
import { executionSubtitle, orderSubtitle, proposalOutcome, withLeadName } from './standingOrderModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function order(overrides: Partial<StandingOrderDto> = {}): StandingOrderDto {
  return {
    id: 'inbox.wake_lead', version: 1, title: '要叫醒 Lead 的事告诉 Lead', priority: 30, status: 'active', author: 'system',
    approvedBy: null, reason: '搬自 inbox.ts 的 inboxWakesLead', createdAt: '2026-10-17T08:00:00.000Z', seedRevision: 1,
    condition: { kinds: ['inbox.blocker', 'inbox.attention'] }, action: { type: 'rule', rule: 'inbox.wake_lead', params: {}, level: 'tell' },
    limits: null, escalateTo: null, level: 'tell', rule: 'inbox.wake_lead',
    ...overrides,
  };
}

function execution(overrides: Partial<StandingOrderExecutionDto> = {}): StandingOrderExecutionDto {
  return {
    seq: 7, kind: 'inbox.blocker', level: 'tell', subject: 'ticket:77', ticketId: 77, attemptId: null,
    summary: '工单 #77 的 Run 失败：模型额度用完', receivedAt: '2026-10-17T09:30:00.000Z', disposition: null, version: 1, effect: 'level',
    ...overrides,
  };
}

const v2 = order({ version: 2, author: 'lead', approvedBy: 'user via test-web（binding 1）', reason: 'blocker 太多，先进摘要', level: 'digest' });

function runtimeWith(client: Record<string, ReturnType<typeof vi.fn>>) {
  return connectionsRuntime([], client as unknown as Partial<FakeConnectionClient>);
}

const list = (overrides: Partial<StandingOrderListResponse> = {}): StandingOrderListResponse => ({
  items: [order(), order({ id: 'notification.batchable', title: '可批量的通知进摘要', level: 'digest', rule: null, action: { type: 'level', level: 'digest' }, author: 'user', version: 2 }),
    order({ id: 'run.failed_tell', title: 'Run 失败单独告诉 Lead', level: 'tell', rule: null, action: { type: 'level', level: 'tell' }, author: 'lead' })],
  proposals: [],
  ...overrides,
});

const detail = (overrides: Partial<StandingOrderDetailResponse> = {}): StandingOrderDetailResponse => ({
  order: v2, versions: [order(), v2], executions: [execution({ seq: 8, version: 2, level: 'digest' }), execution()], proposals: [],
  ...overrides,
});

describe('the standing orders page', () => {
  it('lists every order with its version and who wrote it, and shows a pending proposal first', async () => {
    const { runtime } = runtimeWith({
      getStandingOrders: vi.fn(async () => list({ proposals: [proposal()] })),
      decideStandingOrderProposal: vi.fn(async () => ({ proposal: proposal({ state: 'approved', appliedVersion: 2 }), order: v2 })),
    });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    expect(screen.getByTestId('standing-orders-section').textContent).toContain('全部指令（3）');
    expect(screen.getByTestId('standing-order-row-inbox.wake_lead').textContent).toContain('要叫醒 Paimon 的事告诉 Paimon');
    expect(screen.getByTestId('standing-order-row-inbox.wake_lead').textContent).toContain('inbox.wake_lead · v1 · 系统写的 · 定为「单独告诉」');
    expect(screen.getByTestId('standing-order-row-notification.batchable').textContent).toContain('你改过');
    expect(screen.getByTestId('standing-order-row-run.failed_tell').textContent).toContain('Paimon新增');
    expect(screen.getByTestId('standing-order-proposal-42').textContent).toContain('要你批准');
  });

  it('opens an order: its content, the version history and the recent executions', async () => {
    const getStandingOrder = vi.fn(async () => detail());
    const { runtime } = runtimeWith({ getStandingOrders: vi.fn(async () => list()), getStandingOrder });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-row-inbox.wake_lead')); });
    expect(getStandingOrder).toHaveBeenCalledWith('inbox.wake_lead', expect.any(AbortSignal));
    const section = screen.getByTestId('standing-order-detail-inbox.wake_lead');
    expect(section.textContent).toContain('blocker 太多，先进摘要');
    expect(screen.getByTestId('standing-order-version-inbox.wake_lead-2').textContent).toContain('Paimon写的 · 批准：user via test-web');
    expect(screen.getByTestId('standing-order-version-inbox.wake_lead-2').textContent).toContain('现在');
    expect(screen.getByTestId('standing-order-execution-7').textContent).toContain('工单 #77 的 Run 失败');
    expect(screen.getByTestId('standing-order-execution-7').textContent).toContain('单独告诉');
    expect(screen.getByTestId('standing-order-execution-8').textContent).toContain('v2');
  });

  it('rolls back to an older version after you confirm, and refreshes the list', async () => {
    const getStandingOrders = vi.fn(async () => list());
    const rolledBack = detail({ order: order({ version: 3, author: 'user' }), versions: [order(), v2, order({ version: 3, author: 'user' })] });
    const rollbackStandingOrder = vi.fn(async () => rolledBack);
    const { runtime } = runtimeWith({ getStandingOrders, getStandingOrder: vi.fn(async () => detail()), rollbackStandingOrder });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-row-inbox.wake_lead')); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-rollback-inbox.wake_lead-1')); });
    expect(rollbackStandingOrder).not.toHaveBeenCalled();
    expect(screen.getByTestId('standing-order-rollback-confirm-inbox.wake_lead').textContent).toContain('写一个新版本 v3，内容和 v1 一样？');
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-rollback-yes-inbox.wake_lead')); });
    expect(rollbackStandingOrder).toHaveBeenCalledWith('inbox.wake_lead', 1);
    expect(screen.getByTestId('standing-order-version-inbox.wake_lead-3').textContent).toContain('你写的');
    expect(getStandingOrders).toHaveBeenCalledTimes(2);
  });

  it('shows why a rollback did not happen', async () => {
    const rollbackStandingOrder = vi.fn(async () => { throw new ControlPlaneClientError('现在的版本和 v1 一样，不用回滚', 'conflict', 409); });
    const { runtime } = runtimeWith({ getStandingOrders: vi.fn(async () => list()), getStandingOrder: vi.fn(async () => detail()), rollbackStandingOrder });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-row-inbox.wake_lead')); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-rollback-inbox.wake_lead-1')); });
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-rollback-yes-inbox.wake_lead')); });
    expect(screen.getByTestId('standing-order-detail-error-inbox.wake_lead').textContent).toBe('现在的版本和 v1 一样，不用回滚');
  });

  it('waits until the device is connected before it reads, so a page opened during pairing does not show an error', async () => {
    const getStandingOrders = vi.fn(async () => list());
    const { runtime } = runtimeWith({ getStandingOrders });
    runtime.control.setState({ phase: 'connecting' });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    expect(getStandingOrders).not.toHaveBeenCalled();
    expect(screen.getByTestId('standing-orders-loading')).toBeTruthy();
    await act(async () => { runtime.control.setState({ phase: 'ready' }); });
    expect(getStandingOrders).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('standing-orders-section')).toBeTruthy();
  });

  it('calls Lead by its custom name in system text, and leaves the reasons Lead wrote as they are', async () => {
    const jarvis: LeadProfileDto = { name: 'Jarvis', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };
    const pending = proposal({
      reason: '让 Lead 少被打断',
      findings: [{ tier: 'permissive', aspect: 'params', detail: 'wakeWhen 可能收窄：有的 inbox 不再叫醒 Lead' }],
    });
    const { runtime } = runtimeWith({
      getStandingOrders: vi.fn(async () => list({ proposals: [pending] })),
      getStandingOrder: vi.fn(async () => detail({
        order: order({ reason: '搬自 inbox.ts：blocker 总是叫醒 Lead' }),
        versions: [order({ reason: '搬自 inbox.ts：blocker 总是叫醒 Lead' }), v2],
      })),
    });
    runtime.control.setState({ leadProfile: jarvis });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    const card = screen.getByTestId('standing-order-proposal-42');
    expect(card.textContent).toContain('Jarvis 想修改「要叫醒 Jarvis 的事告诉 Jarvis」');
    expect(screen.getByTestId('standing-order-proposal-42-reason').textContent).toBe('Jarvis 的原因：让 Lead 少被打断');
    expect(screen.getByTestId('standing-order-proposal-42-concern-0').textContent).toBe('· wakeWhen 可能收窄：有的 inbox 不再叫醒 Jarvis');
    expect(screen.getByTestId('standing-order-row-run.failed_tell').textContent).toContain('Run 失败单独告诉 Jarvis');
    expect(screen.getByTestId('standing-order-row-run.failed_tell').textContent).toContain('Jarvis新增');
    await act(async () => { fireEvent.click(screen.getByTestId('standing-order-row-inbox.wake_lead')); });
    const section = screen.getByTestId('standing-order-detail-inbox.wake_lead');
    // 系统写的说明换名字；Lead 写的 v2 的原因原样显示。
    expect(section.textContent).toContain('搬自 inbox.ts：blocker 总是叫醒 Jarvis');
    expect(screen.getByTestId('standing-order-version-inbox.wake_lead-2').textContent).toContain('Jarvis写的');
    expect(section.textContent).toContain('你回滚直接生效，Jarvis 会在下一轮知道。');
    expect(section.textContent).not.toContain('Paimon');
  });

  it('says so when it cannot read the orders', async () => {
    const { runtime } = runtimeWith({
      getStandingOrders: vi.fn(async () => { throw new ControlPlaneClientError('missing scope: tickets:view', 'forbidden', 403); }),
    });
    await act(async () => { renderWithRuntime(<StandingOrdersSection />, runtime); });
    expect(screen.getByTestId('standing-orders-error').textContent).toBe('读不到常设指令：missing scope: tickets:view');
  });
});

describe('standing order wording', () => {
  it('describes orders, executions and proposal outcomes', () => {
    expect(orderSubtitle(order({ level: null, rule: 'run.transient_retry', author: 'lead', version: 3 }), 'Paimon'))
      .toBe('inbox.wake_lead · v3 · Paimon写的 · 规则 run.transient_retry');
    expect(executionSubtitle(execution({ ticketId: null, subject: 'attempt:91', effect: 'merged_root_cause' })))
      .toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · inbox\.blocker · attempt:91 · v1 · merged_root_cause$/);
    expect(proposalOutcome(proposal())).toBeNull();
    expect(proposalOutcome(proposal({ state: 'expired', voidedReason: null }))?.label).toBe('过期了，没有生效');
    expect(proposalOutcome(proposal({ state: 'expired', voidedReason: 'hard_rule' }))?.label).toBe('碰到硬性安全规则，不能生效');
  });

  it('replaces the standalone word Lead with the name, and leaves identifiers alone', () => {
    expect(withLeadName('要叫醒 Lead 的事告诉 Lead', 'Jarvis')).toBe('要叫醒 Jarvis 的事告诉 Jarvis');
    expect(withLeadName('Lead', 'Jarvis')).toBe('Jarvis');
    expect(withLeadName('不打断Lead正在进行的回合', 'Jarvis')).toBe('不打断Jarvis正在进行的回合');
    expect(withLeadName('（Lead 的工具描述）, Lead.', 'Jarvis')).toBe('（Jarvis 的工具描述）, Jarvis.');
    expect(withLeadName('LeadX、xLead、Lead2、2Lead、Lead_x、lead_id、wakeLead=false、timer.lead_followup', 'Jarvis'))
      .toBe('LeadX、xLead、Lead2、2Lead、Lead_x、lead_id、wakeLead=false、timer.lead_followup');
    // 名字里的 $ 不当成替换模式。
    expect(withLeadName('告诉 Lead', '$&$1')).toBe('告诉 $&$1');
  });
});
