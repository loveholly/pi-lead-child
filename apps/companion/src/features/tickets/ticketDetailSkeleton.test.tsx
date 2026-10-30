// @vitest-environment jsdom
// 工单 12：工单详情的骨架（spec 第 3 节，4.0–4.4、4.6；第四轮画板 D4-running、D4-review-pass）。
// - 每个阶段的块顺序、默认展开、出处标签都对；没有「这张工单」标题；入口叫「关联工单」。
// - 按钮的可用状态和 GET /v1/tickets/:id/actions 一致（底部操作栏另见 ticketDecisionCard.test.tsx）。
// - 已完成的工单，「还没合并」不用警告色（原则 6）。
import type {
  TicketAcceptanceCriteria, TicketAction, TicketDelivery, TicketExecutionPlan, TicketSummary,
} from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ticketSummaryToTicket } from '@/features/workspace/model';
import { CompanionRuntimeProvider } from '@/state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '@/state/runtime';

import { renderUI } from '../../../test/render';
import { setViewportWidth, ticket66, ticketAction } from '../../../test/workbench';
import { TicketThread, type TicketThreadProps } from './TicketThread';
import {
  DETAIL_SECTIONS, briefSummary, detailActionBar, detailStage, integrationBadge, nextStepText, planSteps, reviewWentAgainst,
  reviewerStatus, sectionCollapsed,
} from './ticketDetailSections';
import { legacyTicketActions } from './legacyTicketActions';
import { resetRememberedSectionsForTesting } from './useRememberedSections';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const BRIEF = [
  '## 背景与核心痛点',
  '当前 aish 在执行代码审查时存在严重的 Token 消耗过度与效率低下问题。',
  '## 任务目标',
  '降低 token 消耗。',
  '## 执行约束',
  '严禁调用 codex。',
].join('\n\n');

const criteria = (overrides: Partial<TicketAcceptanceCriteria> = {}): TicketAcceptanceCriteria => ({
  ticketId: 102,
  criteria: [1, 2, 3].map((id) => ({
    id, number: id, text: `验收标准 ${id}`, revision: 1, writtenBy: 'lead', writtenAt: '2026-10-21T07:02:00.000Z',
    editedBy: null, editedAt: null, changedAfterDelivery: null, deleted: false, confirmation: null, verdict: null,
  })),
  delivery: null,
  deliveryPending: null,
  confirmed: 0,
  ...overrides,
});

const plan: TicketExecutionPlan = {
  ticketId: 102, revision: 3, attemptId: 118, createdAt: '2026-10-21T07:04:00.000Z', updatedAt: '2026-10-21T07:18:00.000Z',
  steps: [
    { id: 'survey', title: '现状剖析与问题定位', status: 'done', note: null },
    { id: 'tools', title: '工具使用与上下文精简指引重构', status: 'in_progress', note: null },
    { id: 'cache', title: 'Prompt Cache 友好性重构', status: 'skipped', note: '宿主架构层已经做对' },
  ],
};

const delivery = (integration: NonNullable<TicketDelivery['workspace']>['integration']): TicketDelivery => ({
  ticketId: 102, attemptId: 118, source: 'isolated', files: [], truncated: false, totals: null,
  workspace: {
    workspaceId: 7, branch: 'plc/item-102-d2d16749', head: 'a'.repeat(40), target: 'aishx/task-model-routing',
    commits: 1, uncommittedFiles: 0, integration, mergedInto: null, pullRequestUrl: null,
  },
  actions: {
    merge: { available: true, reason: null, acceptsTicket: false },
    openPullRequest: { available: true, reason: null },
    abandon: { available: true, reason: null },
  },
});

function summary(overrides: Partial<TicketSummary>): TicketSummary {
  return ticket66({
    id: 102,
    title: '优化 aish code review skill：降低 Token 消耗、收敛 Bash 调用与优化 Cache',
    project: 'agent-app',
    verificationPolicy: 'independent_reviewer',
    workflowKind: 'coding',
    workspace: {
      id: 7, ownerTicketId: 102, mode: 'isolated', kind: 'isolated_child', state: 'review_hold', inherited: false, availableActions: [],
    },
    ...overrides,
  });
}

function renderThread(ticket: TicketSummary, props: Partial<TicketThreadProps> = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <TicketThread
        ticket={ticketSummaryToTicket(ticket)}
        onClose={() => {}}
        taskDescription={{ brief: BRIEF, body: '' }}
        facts={{
          createdAt: '2026-10-21T07:02:00.000Z', createdBy: 'lead', updatedAt: '2026-10-21T07:06:00.000Z', dueAt: null,
          totalTokens: 5_981_433, totalCostUsd: 2.58, tokenBudget: null, costBudgetUsd: null,
        }}
        executor={{ runtime: 'Claude Code', model: 'sonnet', effort: 'high' }}
        reviewer={{ runtime: 'Codex', model: null, effort: null, status: 'after_delivery' }}
        acceptanceCriteria={criteria()}
        executionPlan={plan}
        {...props}
      />
    </CompanionRuntimeProvider>,
  );
  return screen.getByTestId('ticket-thread');
}

function sectionOrder(thread: HTMLElement): string[] {
  const names = new Set(DETAIL_SECTIONS.map((kind) => `ticket-section-${kind}`));
  return [...thread.querySelectorAll('[data-testid]')]
    .map((element) => element.getAttribute('data-testid')!)
    .filter((id) => names.has(id))
    .map((id) => id.slice('ticket-section-'.length));
}

function expanded(thread: HTMLElement, kind: string): boolean {
  return within(thread).getByTestId(`ticket-section-${kind}-toggle`).getAttribute('aria-expanded') === 'true';
}

beforeEach(() => {
  setViewportWidth(1280);
  localStorage.clear();
  resetRememberedSectionsForTesting();
});

afterEach(() => {
  cleanup();
  setViewportWidth(0);
});

describe('the ticket detail skeleton', () => {
  it('runs the sections in one order while the ticket runs, with execution open and delivery one line', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      attempts: [{
        id: 118, runtime: 'claude', model: 'sonnet', recordedModel: 'sonnet', effort: 'high', choice: 'Claude Code · sonnet · high', purposeLabel: '执行',
        startedAt: '2026-10-21T07:03:04.000Z', endedAt: null, durationMs: null, result: '在跑', resultTone: 'running',
        failurePreview: null, failureFull: null, failureTruncated: false,
      }],
    });

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
    for (const kind of ['task', 'criteria', 'info', 'execution', 'history']) expect(expanded(thread, kind)).toBe(true);
    expect(within(thread).getByTestId('ticket-section-delivery').textContent).toContain('还没交付。');
    expect(within(thread).getByTestId('ticket-execution-now')).toBeTruthy();
    expect(within(thread).getByTestId('ticket-run-118').textContent).toContain('#118');
  });

  it('opens the criteria and the delivery while the ticket waits for acceptance, and folds the brief and the execution', () => {
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
      outcome: {
        latest: {
          id: 9, executorAttemptId: 118, summary: '调研发现 aish 做 PR 审查没有专门触发入口。', deliverables: [], validations: [],
          completeness: 'complete', missingFields: [], createdAt: '2026-10-21T07:18:55.000Z',
        },
      } as unknown as TicketThreadProps['outcome'],
    });

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
    expect(expanded(thread, 'criteria')).toBe(true);
    expect(expanded(thread, 'delivery')).toBe(true);
    expect(expanded(thread, 'task')).toBe(false);
    expect(expanded(thread, 'execution')).toBe(false);
    // 折叠后标题行右边有一句摘要。
    expect(within(thread).getByTestId('ticket-section-execution-toggle').textContent)
      .toContain('Claude Code · 约 598 万 token · $2.58');
  });

  it('opens only the delivery once the ticket is done', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), {
      outcome: {
        latest: {
          id: 9, executorAttemptId: 118, summary: '交付了三项产物。', deliverables: [], validations: [],
          completeness: 'complete', missingFields: [], createdAt: '2026-10-21T07:18:55.000Z',
        },
      } as unknown as TicketThreadProps['outcome'],
    });

    expect(expanded(thread, 'delivery')).toBe(true);
    for (const kind of ['task', 'criteria', 'info', 'execution', 'history']) expect(expanded(thread, kind)).toBe(false);
  });

  it('leaves out the execution and the delivery for a draft that never ran', () => {
    const thread = renderThread(summary({ stage: 'draft', status: 'draft', hasRun: false }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'history']);
  });

  it('labels where each block comes from', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));
    const header = (kind: string) => within(thread).getByTestId(`ticket-section-${kind}-toggle`).textContent;

    expect(header('task')).toContain('Paimon 写的');
    expect(header('criteria')).toContain('Paimon 写的');
    expect(header('info')).toContain('系统记录');
    expect(within(thread).getByTestId('ticket-execution-usage').textContent).toContain('系统记录');
    expect(within(thread).getByTestId('ticket-execution-plan').textContent).toContain('执行 agent 自述');
    expect(within(thread).getByTestId('ticket-execution-runs').textContent).toContain('系统记录');
    expect(within(thread).getByTestId('ticket-history-story').textContent).toContain('系统记录');
  });

  it('has no 这张工单 heading and calls the relation entry 关联工单', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('link', { label: '关联工单' })],
    });

    expect(within(thread).queryByText('这张工单')).toBeNull();
    expect(thread.textContent).not.toContain('建立关系');
    const relations = within(thread).getByTestId('ticket-section-relations');
    expect(within(relations).getByTestId('ticket-link-open').textContent).toBe('关联工单');
    expect(within(relations).getByTestId('ticket-split-request').textContent).toBe('拆成子工单');
  });

  it('asks Lead to split the ticket by prefilling the ticket chat', () => {
    const onPrefillChat = vi.fn();
    const onChatExpandedChange = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { onPrefillChat, onChatExpandedChange });

    fireEvent.click(within(thread).getByTestId('ticket-split-request'));

    expect(onPrefillChat).toHaveBeenCalledWith('请把 #102 拆成几张子工单：');
    expect(onChatExpandedChange).toHaveBeenCalledWith(true);
  });

  it('remembers a folded block on this device by its kind, for every ticket', () => {
    renderThread(summary({ stage: 'active', status: 'active' }));
    fireEvent.click(screen.getByTestId('ticket-section-task-toggle'));
    expect(expanded(screen.getByTestId('ticket-thread'), 'task')).toBe(false);
    expect(JSON.parse(localStorage.getItem('pi-lead-child.ticket-detail-sections.v1') ?? '{}')).toEqual({ task: true });
    cleanup();

    const other = renderThread(summary({ id: 103, stage: 'active', status: 'active' }));

    expect(expanded(other, 'task')).toBe(false);
    expect(expanded(other, 'execution')).toBe(true);
  });

  it('reads the remembered blocks back from this device', async () => {
    localStorage.setItem('pi-lead-child.ticket-detail-sections.v1', JSON.stringify({ execution: true }));
    resetRememberedSectionsForTesting();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));
    await act(async () => { await Promise.resolve(); });

    expect(expanded(thread, 'execution')).toBe(false);
  });

  it('shows the plan with the step in progress as the current step', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));
    const planBlock = within(thread).getByTestId('ticket-execution-plan');

    expect(within(planBlock).getByLabelText('进行中')).toBeTruthy();
    expect(planBlock.textContent).toContain('1/2 ·');
    expect(planBlock.textContent).toContain('跳过：宿主架构层已经做对');
  });

  it('says so when the executing agent submitted no plan', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { executionPlan: null });

    expect(within(thread).getByTestId('ticket-execution-plan').textContent).toContain('执行 agent 没有提交计划');
  });

  it('lets you confirm a criterion only when the action list allows it', () => {
    const delivered = criteria({ delivery: { sequence: 1, attemptId: 118, deliveredAt: '2026-10-21T07:18:55.000Z', latest: true } });
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
      acceptanceCriteria: delivered,
      actions: [ticketAction('confirm_criterion', { label: '确认一条验收标准' }), ticketAction('unconfirm_criterion', { label: '取消确认' })],
      onRunAction,
    });

    fireEvent.click(within(thread).getByTestId('ticket-criteria-check-2'));

    expect(onRunAction).toHaveBeenCalledWith('confirm_criterion', { input: { criterionId: 2, deliverySequence: 1 } });
    cleanup();

    const locked = renderThread(summary({ stage: 'review', status: 'review' }), {
      acceptanceCriteria: delivered,
      actions: [
        ticketAction('confirm_criterion', { available: false, reason: '最新一次交付的快照还没存好。' }),
        ticketAction('unconfirm_criterion', { available: false, reason: '最新一次交付的快照还没存好。' }),
      ],
      onRunAction,
    });
    expect(within(locked).getByTestId('ticket-criteria-check-2').getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the header actions from the action list, with the reason when one cannot be done', async () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      ticketLink: 'http://127.0.0.1:47130/ticket/102',
      actions: [
        ticketAction('set_priority', { label: '改优先级' }),
        ticketAction('set_project', { label: '改项目', available: false, reason: '这张工单是子工单，项目跟着父工单。' }),
        ticketAction('link', { label: '关联工单' }),
      ],
    });

    fireEvent.click(within(thread).getByTestId('ticket-header-more'));
    const panel = await screen.findByTestId('ticket-header-more-panel');

    // 复制的是完整的地址，不只是 /ticket/102。
    expect(within(panel).getByTestId('ticket-copy-link').textContent).toContain('http://127.0.0.1:47130/ticket/102');
    expect(within(panel).getByTestId('ticket-header-set_priority').getAttribute('role')).toBe('button');
    expect(within(panel).getByTestId('ticket-header-set_project').textContent).toContain('这张工单是子工单，项目跟着父工单。');
    expect(within(panel).getByTestId('ticket-header-set_project').getAttribute('role')).not.toBe('button');
  });

  it('principle 6: a done ticket shows 还没合并 in the neutral grey, not the warning colour', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), { delivery: delivery('unmerged') });
    fireEvent.click(within(thread).getByTestId('ticket-section-execution-toggle'));
    const workspace = within(thread).getByTestId('ticket-execution-workspace');
    const label = within(workspace).getByText('还没合并');

    // 中性徽章：灰底、次要文字色（Badge 的 neutral）。
    expect(getComputedStyle(label).color).toBe('var(--c-text-secondary)');
    expect(getComputedStyle(label.parentElement!).backgroundColor).toBe('var(--c-surface-muted)');
  });

  it('does not hang 还没合并 on the workspace while the ticket runs', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { delivery: delivery('unmerged') });

    expect(within(thread).getByTestId('ticket-execution-workspace').textContent).toContain('plc/item-102-d2d16749');
    expect(within(thread).queryByText('还没合并')).toBeNull();
  });

  it('cancelled: keeps the order, opens only the delivery, and says there is nothing to do', () => {
    const thread = renderThread(summary({ stage: 'cancelled', status: 'cancelled' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
    for (const kind of ['task', 'criteria', 'info', 'execution', 'history']) expect(expanded(thread, kind)).toBe(false);
    expect(within(thread).getByTestId('ticket-section-delivery').textContent).toContain('工单已取消，没有交付。');
    expect(within(thread).getByTestId('ticket-action-bar').textContent).toContain('工单已取消，不需要你');
  });

  it('draft: opens what the ticket is about and starts it with 确认开跑', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'draft', status: 'draft', hasRun: false }), {
      actions: [ticketAction('confirm', { label: '确认开跑' }), ticketAction('cancel', { label: '取消工单' })],
      onRunAction,
    });

    for (const kind of ['task', 'criteria', 'info', 'history']) expect(expanded(thread, kind)).toBe(true);
    fireEvent.click(within(thread).getByTestId('ticket-bar-confirm'));

    expect(onRunAction).toHaveBeenCalledWith('confirm', {});
  });

  it('done: keeps the same order of blocks', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
  });
});

// 独立审查（2026-10-22）以后的修复。每条一个测试。
describe('the ticket detail after the review', () => {
  const failed = () => summary({
    stage: 'review',
    status: 'review',
    reviewState: {
      state: 'review_failed', label: '核查不通过', reviewerAttemptId: 120, verdict: 'fail', reason: '第 2 条没做到。',
      deliveryRunId: 118, canRequestReview: true, reviewProgress: null,
    } as TicketSummary['reviewState'],
  });
  const reviewActions = () => [
    ticketAction('complete', { label: '验收' }),
    ticketAction('rework', { label: '打回返工' }),
    ticketAction('cancel', { label: '取消工单' }),
  ];

  async function openMore(thread: HTMLElement) {
    fireEvent.click(within(thread).getByTestId('ticket-bar-more'));
    return screen.findByTestId('ticket-bar-menu');
  }

  it('fix 1: a failed review puts 打回返工 on the main button, and 验收 behind 更多 with a confirmation', async () => {
    const onRunAction = vi.fn();
    const thread = renderThread(failed(), { actions: reviewActions(), onRunAction });
    const bar = within(thread).getByTestId('ticket-action-bar');

    expect(within(bar).queryByTestId('ticket-bar-complete')).toBeNull();
    expect(within(bar).getByTestId('ticket-bar-rework').textContent).toBe('打回返工');
    const menu = await openMore(thread);
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-complete'));
    expect(onRunAction).not.toHaveBeenCalled();
    const confirm = within(thread).getByTestId('ticket-confirm');
    expect(confirm.textContent).toContain('核查没有通过，仍要验收？');

    fireEvent.click(within(confirm).getByText('验收'));
    expect(onRunAction).toHaveBeenCalledWith('complete', {});
  });

  // 复核（2026-10-22）：等验收时合并会顺带验收。它进了「更多」以后，不能绕过修复 1 的确认。
  it('fix 1 follow-up: merging while the review went against the delivery asks first, like 验收', async () => {
    const onRunAction = vi.fn();
    const thread = renderThread(failed(), {
      delivery: delivery('unmerged'),
      actions: [...reviewActions(), ticketAction('merge', { label: '合并到原分支' })],
      onRunAction,
    });
    const menu = await openMore(thread);
    expect(within(menu).getByTestId('ticket-bar-menu-merge').textContent).toContain('核查没有通过。做之前会再问你一次。');
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-merge'));

    expect(onRunAction).not.toHaveBeenCalled();
    const confirm = within(thread).getByTestId('ticket-confirm');
    expect(confirm.textContent).toContain('核查没有通过，仍要验收并合并？');
    fireEvent.click(within(confirm).getByText('合并到原分支'));
    expect(onRunAction).toHaveBeenCalledWith('merge', { input: { expectedHead: 'a'.repeat(40), expectedTarget: 'aishx/task-model-routing' } });
  });

  it('fix 1 follow-up: merging before the reviewer has a verdict asks first too', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
      reviewer: { runtime: 'Codex', model: null, effort: null, status: 'queued' },
      delivery: delivery('unmerged'),
      actions: [ticketAction('merge', { label: '合并到原分支' })],
      onRunAction,
    });
    fireEvent.click(within(thread).getByTestId('ticket-bar-more'));

    return screen.findByTestId('ticket-bar-menu').then((menu) => {
      fireEvent.click(within(menu).getByTestId('ticket-bar-menu-merge'));
      expect(onRunAction).not.toHaveBeenCalled();
      expect(within(thread).getByTestId('ticket-confirm').textContent).toContain('不等核查，直接验收并合并？');
    });
  });

  it('opens the ticket chat for widening the sub-agent grant, which needs a scope', async () => {
    const onRunAction = vi.fn();
    const onPrefillChat = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('widen_grant', { label: '放宽子 agent 的权限' })],
      onRunAction,
      onPrefillChat,
    });
    fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-widen_grant'));

    expect(onPrefillChat).toHaveBeenCalledWith('放宽 #102 的子 agent 的权限：');
    expect(onRunAction).not.toHaveBeenCalled();
  });

  it('says so when this connection cannot read the action list', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [], actionsStatus: 'unsupported' });

    expect(within(thread).getByTestId('ticket-action-bar').textContent).toContain('这个连接读不了工单能做的操作');
  });

  it('fix 2: grants delegation from the action list, with the reason when it cannot', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('delegate', { label: '授权托管' })],
      onRunAction,
    });
    fireEvent.click(within(thread).getByTestId('lead-delegation-grant'));
    expect(onRunAction).toHaveBeenCalledWith('delegate', { input: { maxReworkCycles: 1 } });
    cleanup();

    const locked = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('delegate', { label: '授权托管', available: false, reason: '核查员都不能用，托管不起作用。' })],
      onRunAction,
    });
    expect(within(locked).getByTestId('lead-delegation-grant').getAttribute('aria-disabled')).toBe('true');
    expect(within(locked).getByTestId('ticket-section-info').textContent).toContain('核查员都不能用，托管不起作用。');
  });

  it('fix 2: falls back to the old grant when the action list has no delegate yet', () => {
    const onSetLeadDelegation = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { onSetLeadDelegation });

    fireEvent.click(within(thread).getByTestId('lead-delegation-grant'));

    expect(onSetLeadDelegation).toHaveBeenCalledWith(true);
  });

  it('fix 3: a running ticket whose dispatch failed says why instead of 现在不需要你', () => {
    const thread = renderThread(summary({
      stage: 'active',
      status: 'active',
      executionState: {
        kind: 'execution', state: 'failed', label: '派发失败', dispatchRequestId: 3, attemptId: null, reason: 'claude 没有配置。',
      } as TicketSummary['executionState'],
    }));
    const bar = within(thread).getByTestId('ticket-action-bar');

    expect(bar.textContent).toContain('派发失败');
    expect(bar.textContent).not.toContain('现在不需要你');
  });

  it('fix 4: unlinks a related ticket from its row, as the action list allows', () => {
    const onRunAction = vi.fn();
    const related = {
      ticketId: 42, kind: 'relates_to', sourceTicketId: 102, targetTicketId: 42, relationId: 7, source: 'ticket_relations', active: true,
      title: '相关的那张', relatedStage: 'active', label: '相关', group: 'related', groupLabel: '相关', stateLabel: '有效', meta: '', detail: null,
    } as unknown as NonNullable<TicketThreadProps['relations']>[number];
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      relations: [related],
      actions: [ticketAction('unlink', { label: '解除关联' })],
      onRunAction,
    });

    fireEvent.click(within(thread).getByTestId('ticket-relation-42-action'));
    expect(onRunAction).toHaveBeenCalledWith('unlink', { input: { relationId: 7 }, reason: '在工单详情里解除关联' });
    cleanup();

    const locked = renderThread(summary({ stage: 'active', status: 'active' }), {
      relations: [related],
      actions: [ticketAction('unlink', { label: '解除关联', available: false, reason: '父子关系在拆分计划里改。' })],
      onRunAction,
    });
    expect(within(locked).getByTestId('ticket-relation-42-action').getAttribute('aria-disabled')).toBe('true');
  });

  it('puts every doable action without a place of its own into 更多', async () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), {
      delivery: delivery('unmerged'),
      actions: [
        ticketAction('merge', { label: '合并到原分支' }),
        ticketAction('open_pr', { label: '开草稿 PR', external: true }),
        ticketAction('rework', { label: '打回返工' }),
        ticketAction('restore', { label: '恢复' }),
        ticketAction('set_due', { label: '设置截止' }),
        ticketAction('abandon', { label: '放弃改动', irreversible: true }),
      ],
    });
    const menu = await openMore(thread);

    expect(within(menu).getByTestId('ticket-bar-menu-rework')).toBeTruthy();
    expect(within(menu).getByTestId('ticket-bar-menu-restore')).toBeTruthy();
    expect(within(menu).getByTestId('ticket-bar-menu-abandon')).toBeTruthy();
    // 设置截止在工单信息那一行，不重复放。
    expect(within(menu).queryByTestId('ticket-bar-menu-set_due')).toBeNull();
  });

  it('says when the action list is still loading, and offers to retry when it cannot be read', () => {
    const loading = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [], actionsStatus: 'loading' });
    expect(within(loading).getByTestId('ticket-action-bar').textContent).toContain('正在读取这张工单能做的操作。');
    cleanup();

    const onRetryActions = vi.fn();
    const failedList = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [], actionsStatus: 'error', onRetryActions });
    const bar = within(failedList).getByTestId('ticket-action-bar');
    expect(bar.textContent).toContain('读不到这张工单能做的操作。');
    fireEvent.click(within(bar).getByTestId('ticket-actions-retry'));
    expect(onRetryActions).toHaveBeenCalled();
  });

  it('keeps merge, open PR and abandon unclickable until the delivery has been read', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), {
      delivery: null,
      actions: [ticketAction('merge', { label: '合并到原分支' }), ticketAction('open_pr', { label: '开草稿 PR', external: true })],
      onRunAction,
    });
    const bar = within(thread).getByTestId('ticket-action-bar');

    expect(within(bar).getByTestId('ticket-bar-merge').getAttribute('aria-disabled')).toBe('true');
    expect(bar.textContent).toContain('正在读取这次交付。');
    fireEvent.click(within(bar).getByTestId('ticket-bar-merge'));
    expect(onRunAction).not.toHaveBeenCalled();
  });

  describe('confirmations', () => {
    it('cancel: asks before cancelling the ticket', async () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [ticketAction('cancel', { label: '取消工单' })], onRunAction });
      fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-cancel'));
      const confirm = within(thread).getByTestId('ticket-confirm');

      expect(confirm.textContent).toContain('取消这张工单？');
      expect(onRunAction).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByText('取消工单'));
      expect(onRunAction).toHaveBeenCalledWith('cancel', {});
    });

    it('stop: asks before stopping the run', async () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [ticketAction('stop_run', { label: '停下' })], onRunAction });
      fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-stop_run'));

      expect(within(thread).getByTestId('ticket-confirm').textContent).toContain('停下正在跑的这次运行？');
      fireEvent.click(within(within(thread).getByTestId('ticket-confirm')).getByText('停下'));
      expect(onRunAction).toHaveBeenCalledWith('stop_run', {});
    });

    it('abandon: asks before throwing the changes away, and sends the delivery you saw', async () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'done', status: 'done' }), {
        delivery: delivery('unmerged'),
        actions: [ticketAction('abandon', { label: '放弃改动', irreversible: true })],
        onRunAction,
      });
      fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-abandon'));
      const confirm = within(thread).getByTestId('ticket-confirm');

      expect(confirm.textContent).toContain('放弃这次的改动？');
      expect(confirm.textContent).toContain('做了就收不回。');
      fireEvent.click(within(confirm).getByText('放弃改动'));
      expect(onRunAction).toHaveBeenCalledWith('abandon', {
        input: { expectedHead: 'a'.repeat(40), expectedTarget: 'aishx/task-model-routing' },
      });
    });

    it('rework: asks for what to fix and sends it as the reason', () => {
      const onRunAction = vi.fn();
      const thread = renderThread(failed(), { actions: reviewActions(), onRunAction });
      fireEvent.click(within(thread).getByTestId('ticket-bar-rework'));
      fireEvent.change(within(thread).getByTestId('ticket-rework-reason'), { target: { value: '第 2 条要改配置。' } });
      fireEvent.click(within(within(thread).getByTestId('ticket-confirm')).getByText('打回返工'));

      expect(onRunAction).toHaveBeenCalledWith('rework', { reason: '第 2 条要改配置。' });
    });

    it('skip review: asks before accepting while the reviewer has no verdict', () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
        reviewer: { runtime: 'Codex', model: null, effort: null, status: 'running' },
        actions: reviewActions(),
        onRunAction,
      });
      fireEvent.click(within(thread).getByTestId('ticket-bar-complete'));
      const confirm = within(thread).getByTestId('ticket-confirm');

      expect(confirm.textContent).toContain('不等核查，直接验收？');
      fireEvent.click(within(confirm).getByText('验收'));
      expect(onRunAction).toHaveBeenCalledWith('complete', {});
    });
  });
});

describe('ticketDetailSections', () => {
  const actions: TicketAction[] = [
    ticketAction('pause_run', { label: '暂停', available: false, reason: '没有正在运行的 Run 可以暂停。' }),
    ticketAction('resume_run', { label: '继续' }),
    ticketAction('stop_run', { label: '停下' }),
    ticketAction('cancel', { label: '取消工单' }),
    ticketAction('abandon', { label: '放弃改动', available: false, reason: '没有改动。' }),
  ];

  it('reads the stage from TicketSummary only', () => {
    expect(detailStage('active')).toBe('running');
    expect(detailStage('blocked')).toBe('running');
    expect(detailStage('review')).toBe('review');
    expect(detailStage('done')).toBe('done');
    expect(detailStage('cancelled')).toBe('cancelled');
  });

  it('lets your own choice override the stage default', () => {
    expect(sectionCollapsed('review', 'task')).toBe(true);
    expect(sectionCollapsed('review', 'task', { task: false })).toBe(false);
    expect(sectionCollapsed('done', 'delivery')).toBe(false);
  });

  it('puts whichever of pause and resume can be done in the same slot, and only doable actions in 更多', () => {
    const bar = detailActionBar('running', actions);

    expect(bar.primary).toBeNull();
    expect(bar.secondary?.id).toBe('resume_run');
    expect(bar.more.map((action) => action.id)).toEqual(['stop_run', 'cancel']);
  });

  it('keeps an unavailable action in its slot, disabled with its reason', () => {
    const bar = detailActionBar('running', actions.filter((action) => action.id !== 'resume_run'));

    expect(bar.secondary?.id).toBe('pause_run');
    expect(bar.secondary?.available).toBe(false);
  });

  it('sums up a folded brief with its first line of prose, not a heading', () => {
    expect(briefSummary(BRIEF, '摘要')).toBe('当前 aish 在执行代码审查时存在严重的 Token 消耗过度与效率低下问题。');
    expect(briefSummary('## 只有标题', '摘要')).toBe('只有标题');
    expect(briefSummary('', '摘要')).toBe('摘要');
  });

  it('gives the reviewer one of the six states, also after the ticket left review', () => {
    const independent = { verificationPolicy: 'independent_reviewer' as const, reviewState: undefined };
    expect(reviewerStatus({ verificationPolicy: 'lead_static', reviewState: undefined }, null)).toBeNull();
    expect(reviewerStatus(independent, null)).toBe('after_delivery');
    expect(reviewerStatus(independent, { state: 'settled', errorCode: null })).toBe('done');
    expect(reviewerStatus(independent, { state: 'settled', errorCode: 'account_deactivated' })).toBe('failed');
    expect(reviewerStatus(independent, { state: 'crashed' })).toBe('failed');
    expect(reviewerStatus(independent, { state: 'running' })).toBe('after_delivery');
    expect(reviewerStatus({ ...independent, reviewState: { ...ticket66().reviewState!, reviewProgress: 'suspended' } as never }, null)).toBe('suspended');
  });

  it('maps in_progress to the current step', () => {
    expect(planSteps(plan).map((step) => step.state)).toEqual(['done', 'current', 'skipped']);
  });

  it('never paints 还没合并 with a warning or danger tone, and hangs no badge before delivery', () => {
    for (const stage of ['review', 'done', 'cancelled'] as const) {
      expect(integrationBadge(stage, 'unmerged')).toEqual({ label: '还没合并', tone: 'neutral' });
    }
    expect(integrationBadge('running', 'unmerged')).toBeNull();
    expect(integrationBadge('running', 'conflict')?.tone).toBe('danger');
    expect(integrationBadge('done', 'conflict')?.tone).toBe('neutral');
    expect(integrationBadge('review', 'conflict')?.tone).toBe('danger');
  });

  it('recommends rework, not acceptance, when the review went against the delivery', () => {
    const review = (state: string) => ({ status: 'review' as const, reviewState: { state } as never });
    expect(reviewWentAgainst(review('review_failed'))).toBe(true);
    expect(reviewWentAgainst(review('evidence_conflict'))).toBe(true);
    expect(reviewWentAgainst(review('rework_exhausted'))).toBe(true);
    expect(reviewWentAgainst(review('review_passed'))).toBe(false);
    const bar = detailActionBar('review', [ticketAction('complete'), ticketAction('rework')], { reviewAgainst: true });
    expect(bar.primary?.id).toBe('rework');
    expect(bar.more.map((action) => action.id)).toEqual(['complete']);
  });

  it('says where a stuck running ticket stopped', () => {
    const input = {
      stage: 'running' as const, ticket: { status: 'active' as const }, agentName: 'Claude Code', paused: false,
      decisionHeadline: '派发失败', integration: null, pullRequestUrl: null,
    };
    expect(nextStepText({ ...input, stuck: false })).toBe('Claude Code 继续做，现在不需要你');
    expect(nextStepText({ ...input, stuck: true })).toBe('派发失败');
  });
});

// 恢复、开始执行、撤回确认、释放工作区还不在操作清单里，先走旧接口、用旧的判断（legacyTicketActions.ts）。
// P03/P04 把它们登记进操作层以后，页面改读清单：这几条测试会提醒删掉旧的判断。
describe('legacy actions (not in the action list yet)', () => {
  const ids = (overrides: Partial<TicketSummary>, cancelledChildCount = 0) =>
    legacyTicketActions(ticketSummaryToTicket(summary(overrides)), { cancelledChildCount }).map((action) => action.id);
  const isolated = { id: 7, ownerTicketId: 102, mode: 'isolated', kind: 'isolated_child', state: 'active', inherited: false } as const;

  it('offers what the old judgement allows, and nothing else', () => {
    expect(ids({ stage: 'cancelled', status: 'cancelled' })).toEqual(['restore']);
    expect(ids({ stage: 'ready', status: 'ready', workspace: { ...isolated, availableActions: [] } })).toEqual(['start', 'unconfirm']);
    expect(ids({ stage: 'active', status: 'active', workspace: { ...isolated, availableActions: ['release'] } })).toEqual(['release']);
    // 旧的判断说不能做的不出现：执行中没有可释放的工作区，受阻时不给开始，已完成什么都没有。
    expect(ids({ stage: 'active', status: 'active', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    expect(ids({ stage: 'blocked', status: 'blocked', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    expect(ids({ stage: 'done', status: 'done', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    // 草稿下面还有已取消的子工单：继续恢复。
    expect(ids({ stage: 'draft', status: 'draft', hasRun: false }, 2)).toEqual(['restore']);
  });

  it('puts them into 更多 and restores a cancelled ticket after a confirmation, through the old route', async () => {
    const onLegacyAction = vi.fn();
    const ticket = summary({ stage: 'cancelled', status: 'cancelled' });
    const thread = renderThread(ticket, {
      legacyActions: legacyTicketActions(ticketSummaryToTicket(ticket)),
      onLegacyAction,
    });
    fireEvent.click(within(thread).getByTestId('ticket-bar-more'));
    const menu = await screen.findByTestId('ticket-bar-menu');
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-restore'));
    const confirm = within(thread).getByTestId('ticket-confirm');

    expect(confirm.textContent).toContain('恢复这张工单？');
    expect(onLegacyAction).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByText('恢复'));
    expect(onLegacyAction).toHaveBeenCalledWith('restore', { restoreMode: 'review_tree' });
  });

  it('starts a ready ticket from 更多 without a confirmation', async () => {
    const onLegacyAction = vi.fn();
    const ticket = summary({ stage: 'ready', status: 'ready' });
    const thread = renderThread(ticket, { legacyActions: legacyTicketActions(ticketSummaryToTicket(ticket)), onLegacyAction });
    fireEvent.click(within(thread).getByTestId('ticket-bar-more'));
    fireEvent.click(within(await screen.findByTestId('ticket-bar-menu')).getByTestId('ticket-bar-menu-start'));

    expect(onLegacyAction).toHaveBeenCalledWith('start');
  });
});
