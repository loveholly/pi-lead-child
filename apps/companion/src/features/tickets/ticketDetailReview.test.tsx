// @vitest-environment jsdom
// 工单详情在复核以后（返工、验收、合并的先后和确认框），以及按操作清单放按钮。原来在 ticketDetailSkeleton.test.tsx 里，
// 2026-11-09 拆出来：那个文件一个要跑 20 多秒，整套并发跑时它最后一个结束。共用的数据和渲染在 test/ticketDetail.tsx。
import type { TicketSummary } from '@pi-lead-child/protocol';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { delivery, renderThread, summary } from '../../../test/ticketDetail';
import { setViewportWidth, ticketAction } from '../../../test/workbench';
import type { TicketThreadProps } from './TicketThread';
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

describe('the ticket detail after the review', () => {
  const failed = () => summary({
    stage: 'review',
    status: 'review',
    reviewState: {
      state: 'review_failed', label: 'Review failed', reviewerAttemptId: 120, verdict: 'fail', reason: '第 2 条没做到。',
      deliveryRunId: 118, canRequestReview: true, reviewProgress: null,
    } as TicketSummary['reviewState'],
  });
  const reviewActions = () => [
    ticketAction('complete', { label: '验收' }),
    ticketAction('rework', { label: 'Send back for rework' }),
    ticketAction('cancel', { label: 'Cancel ticket' }),
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
    expect(within(bar).getByTestId('ticket-bar-rework').textContent).toBe('Send back for rework');
    const menu = await openMore(thread);
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-complete'));
    expect(onRunAction).not.toHaveBeenCalled();
    const confirm = within(thread).getByTestId('ticket-confirm');
    expect(confirm.textContent).toContain('The review did not pass. Accept anyway?');

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
    expect(within(menu).getByTestId('ticket-bar-menu-merge').textContent).toContain('The review did not pass. You must confirm again before it runs.');
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-merge'));

    expect(onRunAction).not.toHaveBeenCalled();
    const confirm = within(thread).getByTestId('ticket-confirm');
    expect(confirm.textContent).toContain('The review did not pass. Accept and merge anyway?');
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
      expect(within(thread).getByTestId('ticket-confirm').textContent).toContain('Accept and merge without waiting for the review?');
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

    expect(onPrefillChat).toHaveBeenCalledWith('Widen the permissions of the executor of #102: ');
    expect(onRunAction).not.toHaveBeenCalled();
  });

  it('says so when this connection cannot read the action list', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [], actionsStatus: 'unsupported' });

    expect(within(thread).getByTestId('ticket-action-bar').textContent).toContain('This connection cannot read the ticket actions');
  });

  it('fix 2: grants delegation from the action list, with the reason when it cannot', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('delegate', { label: 'Delegate' })],
      onRunAction,
    });
    fireEvent.click(within(thread).getByTestId('lead-delegation-grant'));
    expect(onRunAction).toHaveBeenCalledWith('delegate', { input: { maxReworkCycles: 1 } });
    cleanup();

    const locked = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('delegate', { label: 'Delegate', available: false, reason: '核查员都不能用，托管不起作用。' })],
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
    expect(bar.textContent).not.toContain('You do not need to do anything');
  });

  it('fix 4: unlinks a related ticket from its row, as the action list allows', () => {
    const onRunAction = vi.fn();
    const related = {
      ticketId: 42, kind: 'relates_to', sourceTicketId: 102, targetTicketId: 42, relationId: 7, source: 'ticket_relations', active: true,
      title: '相关的那张', relatedStage: 'active', label: 'Related', group: 'related', groupLabel: 'Related', stateLabel: 'Active', meta: '', detail: null,
    } as unknown as NonNullable<TicketThreadProps['relations']>[number];
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      relations: [related],
      actions: [ticketAction('unlink', { label: '解除关联' })],
      onRunAction,
    });

    fireEvent.click(within(thread).getByTestId('ticket-relation-42-action'));
    expect(onRunAction).toHaveBeenCalledWith('unlink', { input: { relationId: 7 }, reason: 'Removed the link in ticket details' });
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
        ticketAction('rework', { label: 'Send back for rework' }),
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
    expect(within(loading).getByTestId('ticket-action-bar').textContent).toContain('Reading the actions for this ticket.');
    cleanup();

    const onRetryActions = vi.fn();
    const failedList = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [], actionsStatus: 'error', onRetryActions });
    const bar = within(failedList).getByTestId('ticket-action-bar');
    expect(bar.textContent).toContain('Cannot read the actions for this ticket.');
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
    expect(bar.textContent).toContain('Reading this delivery.');
    fireEvent.click(within(bar).getByTestId('ticket-bar-merge'));
    expect(onRunAction).not.toHaveBeenCalled();
  });

  describe('confirmations', () => {
    it('cancel: asks before cancelling the ticket', async () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [ticketAction('cancel', { label: 'Cancel ticket' })], onRunAction });
      fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-cancel'));
      const confirm = within(thread).getByTestId('ticket-confirm');

      expect(confirm.textContent).toContain('Cancel this ticket?');
      expect(onRunAction).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByText('Cancel ticket'));
      expect(onRunAction).toHaveBeenCalledWith('cancel', {});
    });

    it('stop: asks before stopping the run', async () => {
      const onRunAction = vi.fn();
      const thread = renderThread(summary({ stage: 'active', status: 'active' }), { actions: [ticketAction('stop_run', { label: '停下' })], onRunAction });
      fireEvent.click(within(await openMore(thread)).getByTestId('ticket-bar-menu-stop_run'));

      expect(within(thread).getByTestId('ticket-confirm').textContent).toContain('Stop the current work?');
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

      expect(confirm.textContent).toContain('Discard the changes of this delivery?');
      expect(confirm.textContent).toContain('You cannot undo this.');
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
      fireEvent.click(within(within(thread).getByTestId('ticket-confirm')).getByText('Send back for rework'));

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

      expect(confirm.textContent).toContain('Accept without waiting for the review?');
      fireEvent.click(within(confirm).getByText('验收'));
      expect(onRunAction).toHaveBeenCalledWith('complete', {});
    });
  });
});
