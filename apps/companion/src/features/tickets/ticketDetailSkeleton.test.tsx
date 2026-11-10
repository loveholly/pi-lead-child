// @vitest-environment happy-dom
// 工单 12：工单详情的骨架（spec 第 3 节，4.0–4.4、4.6；第四轮画板 D4-running、D4-review-pass）。
// - 每个阶段的块顺序、默认展开、出处标签都对；没有「这张工单」标题；入口叫「关联工单」。
// - 按钮的可用状态和 GET /v1/tickets/:id/actions 一致（底部操作栏另见 ticketDecisionCard.test.tsx）。
// - 已完成的工单，「还没合并」不用警告色（原则 6）。
// 复核以后的详情和确认框在 ticketDetailReview.test.tsx；共用的数据和渲染在 test/ticketDetail.tsx。
import type { TicketAction, TicketSummary } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ticketSummaryToTicket } from '@/features/workspace/model';

import { cssVar } from '../../../test/render';
import { BRIEF, criteria, delivery, expanded, plan, renderThread, sectionOrder, summary } from '../../../test/ticketDetail';
import { setViewportWidth, ticket66, ticketAction } from '../../../test/workbench';
import type { TicketThreadProps } from './TicketThread';
import {
  briefSummary, detailActionBar, detailStage, integrationBadge, nextStepText, planSteps, reviewWentAgainst,
  reviewerStatus, sectionCollapsed,
} from './ticketDetailSections';
import { legacyTicketActions } from './legacyTicketActions';
import { resetRememberedSectionsForTesting } from './useRememberedSections';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
        id: 118, runtime: 'claude', model: 'sonnet', recordedModel: 'sonnet', effort: 'high', choice: 'Claude Code · sonnet · high', purposeLabel: 'Execution',
        startedAt: '2026-10-21T07:03:04.000Z', endedAt: null, durationMs: null, result: 'Running', resultTone: 'running',
        failurePreview: null, failureFull: null, failureTruncated: false,
      }],
    });

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
    for (const kind of ['task', 'criteria', 'info', 'execution', 'history']) expect(expanded(thread, kind)).toBe(true);
    expect(within(thread).getByTestId('ticket-section-delivery').textContent).toContain('Not delivered yet.');
    expect(within(thread).getByTestId('ticket-execution-now')).toBeTruthy();
    // 设计规范 P14.6：执行记录的编号在界面上找不到，执行这一行不写它。
    const run = within(thread).getByTestId('ticket-run-118');
    expect(run.textContent).toContain('Execution');
    expect(run.textContent).not.toContain('118');
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
      .toContain('Claude Code · about 6M tokens · $2.58');
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

    expect(header('task')).toContain('Written by Paimon');
    expect(header('criteria')).toContain('Written by Paimon');
    expect(header('info')).toContain('System record');
    expect(within(thread).getByTestId('ticket-execution-usage').textContent).toContain('System record');
    expect(within(thread).getByTestId('ticket-execution-plan').textContent).toContain('Executor report');
    expect(within(thread).getByTestId('ticket-execution-runs').textContent).toContain('System record');
    expect(within(thread).getByTestId('ticket-history-story').textContent).toContain('System record');
  });

  // token 按计费拆开（用户 2026-11-06）：缓存读、缓存写、未缓存输入和输出的价钱差很多，用量一块下面再画一行四个数。
  it('shows the four billed parts of the tokens under the usage, and nothing without a breakdown', () => {
    const facts = {
      createdAt: '2026-10-21T07:02:00.000Z', createdBy: 'lead' as const, updatedAt: '2026-10-21T07:06:00.000Z', dueAt: null,
      totalTokens: 6_081_433, totalCostUsd: 2.58, tokenBudget: null, costBudgetUsd: null,
      usageParts: {
        uncachedInputTokens: 134, cacheWriteTokens: 296_699, cacheReadTokens: 5_631_822, outputTokens: 52_778, unsplitTokens: 100_000,
      },
    };
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { facts });
    const usage = within(thread).getByTestId('ticket-execution-usage').textContent;
    expect(within(thread).getByTestId('ticket-usage-parts')).toBeTruthy();
    expect(usage).toContain('Uncached input');
    expect(usage).toContain('Cache reads');
    expect(usage).toContain('about 5.6M');
    expect(usage).toContain('about 100K tokens from before this split have no breakdown.');
    cleanup();

    const zh = renderThread(summary({ stage: 'active', status: 'active' }), { facts }, 'zh');
    expect(within(zh).getByTestId('ticket-execution-usage').textContent).toContain('缓存读');
    cleanup();

    const old = renderThread(summary({ stage: 'active', status: 'active' }));
    expect(within(old).queryByTestId('ticket-usage-parts')).toBeNull();
  });

  it('has no 这张工单 heading and calls the relation entry 关联工单', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('link', { label: 'Link ticket' })],
    });

    expect(within(thread).queryByText('这张工单')).toBeNull();
    expect(thread.textContent).not.toContain('New relation');
    const relations = within(thread).getByTestId('ticket-section-relations');
    expect(within(relations).getByTestId('ticket-link-open').textContent).toBe('Link ticket');
    expect(within(relations).getByTestId('ticket-split-request').textContent).toBe('Split into child tickets');
  });

  it('asks Lead to split the ticket by prefilling the ticket chat', () => {
    const onPrefillChat = vi.fn();
    const onChatExpandedChange = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { onPrefillChat, onChatExpandedChange });

    fireEvent.click(within(thread).getByTestId('ticket-split-request'));

    expect(onPrefillChat).toHaveBeenCalledWith('Split #102 into child tickets:');
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

    expect(within(planBlock).getByLabelText('In progress')).toBeTruthy();
    expect(planBlock.textContent).toContain('1/2 ·');
    expect(planBlock.textContent).toContain('Skipped: 宿主架构层已经做对');
  });

  it('says so when the executing agent submitted no plan', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { executionPlan: null });

    expect(within(thread).getByTestId('ticket-execution-plan').textContent).toContain('The executor did not submit a plan.');
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
        ticketAction('link', { label: 'Link ticket' }),
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
    const label = within(workspace).getByText('Not merged');

    // 中性徽章：灰底、次要文字色（Badge 的 neutral）。
    expect(getComputedStyle(label).color).toBe(cssVar('--c-text-secondary'));
    expect(getComputedStyle(label.parentElement!).backgroundColor).toBe(cssVar('--c-surface-muted'));
  });

  it('does not hang 还没合并 on the workspace while the ticket runs', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { delivery: delivery('unmerged') });

    expect(within(thread).getByTestId('ticket-execution-workspace').textContent).toContain('plc/item-102-d2d16749');
    expect(within(thread).queryByText('Not merged')).toBeNull();
  });

  it('cancelled: keeps the order, opens only the delivery, and says there is nothing to do', () => {
    const thread = renderThread(summary({ stage: 'cancelled', status: 'cancelled' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'info', 'execution', 'delivery', 'history']);
    for (const kind of ['task', 'criteria', 'info', 'execution', 'history']) expect(expanded(thread, kind)).toBe(false);
    expect(within(thread).getByTestId('ticket-section-delivery').textContent).toContain('The ticket is cancelled. There is no delivery.');
    expect(within(thread).getByTestId('ticket-action-bar').textContent).toContain('The ticket is cancelled. You do not need to do anything');
  });

  it('draft: opens what the ticket is about and starts it with 确认开跑', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'draft', status: 'draft', hasRun: false }), {
      actions: [ticketAction('confirm', { label: '确认开跑' }), ticketAction('cancel', { label: 'Cancel ticket' })],
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

describe('ticketDetailSections', () => {
  const actions: TicketAction[] = [
    ticketAction('pause_run', { label: '暂停', available: false, reason: '没有正在运行的 Run 可以暂停。' }),
    ticketAction('resume_run', { label: '继续' }),
    ticketAction('stop_run', { label: '停下' }),
    ticketAction('cancel', { label: 'Cancel ticket' }),
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
      expect(integrationBadge(stage, 'unmerged')).toEqual({ label: 'Not merged', tone: 'neutral' });
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
    expect(nextStepText({ ...input, stuck: false })).toBe('Claude Code continues. You do not need to do anything now');
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

    expect(confirm.textContent).toContain('Restore this ticket?');
    expect(onLegacyAction).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByText('Restore'));
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

// 界面语言（2026-11-01）：缺省英文；外观偏好选了中文时，工单详情整页按中文写。
describe('the ticket detail in Chinese', () => {
  it('writes the section titles, the sources and the next step in Chinese', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {}, 'zh');
    const header = (kind: string) => within(thread).getByTestId(`ticket-section-${kind}-toggle`).textContent;

    expect(header('task')).toContain('任务说明');
    expect(header('task')).toContain('Paimon 写的');
    expect(header('history')).toContain('经过与记录');
    expect(within(thread).getByTestId('ticket-action-bar').textContent).toContain('Claude Code 继续做，现在不需要你');
  });
});
