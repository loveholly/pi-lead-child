// 工单详情测试共用的数据和渲染（ticketDetailSkeleton.test.tsx、ticketDetailReview.test.tsx）。
// 两个文件原来是一个，2026-11-09 拆开：一个文件要跑 20 多秒，整套并发跑时它最后一个结束。
import type {
  TicketAcceptanceCriteria, TicketDelivery, TicketExecutionPlan, TicketSummary,
} from '@pi-lead-child/protocol';
import { screen, within } from '@testing-library/react';

import { DesignPreferencesProvider } from '@pi-lead-child/components';

import { TicketThread, type TicketThreadProps } from '../src/features/tickets/TicketThread';
import { DETAIL_SECTIONS } from '../src/features/tickets/ticketDetailSections';
import { ticketSummaryToTicket } from '../src/features/workspace/model';
import { CompanionRuntimeProvider } from '../src/state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../src/state/runtime';
import { renderUI } from './render';
import { ticket66 } from './workbench';

export const BRIEF = [
  '## 背景与核心痛点',
  '当前 aish 在执行代码审查时存在严重的 Token 消耗过度与效率低下问题。',
  '## 任务目标',
  '降低 token 消耗。',
  '## 执行约束',
  '严禁调用 codex。',
].join('\n\n');

export const criteria = (overrides: Partial<TicketAcceptanceCriteria> = {}): TicketAcceptanceCriteria => ({
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

export const plan: TicketExecutionPlan = {
  ticketId: 102, revision: 3, attemptId: 118, createdAt: '2026-10-21T07:04:00.000Z', updatedAt: '2026-10-21T07:18:00.000Z',
  steps: [
    { id: 'survey', title: '现状剖析与问题定位', status: 'done', note: null },
    { id: 'tools', title: '工具使用与上下文精简指引重构', status: 'in_progress', note: null },
    { id: 'cache', title: 'Prompt Cache 友好性重构', status: 'skipped', note: '宿主架构层已经做对' },
  ],
};

export const delivery = (integration: NonNullable<TicketDelivery['workspace']>['integration']): TicketDelivery => ({
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

export function summary(overrides: Partial<TicketSummary>): TicketSummary {
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

export function renderThread(ticket: TicketSummary, props: Partial<TicketThreadProps> = {}, locale: 'en' | 'zh' = 'en') {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <DesignPreferencesProvider value={{ locale }}>
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
      </DesignPreferencesProvider>
    </CompanionRuntimeProvider>,
  );
  return screen.getByTestId('ticket-thread');
}

export function sectionOrder(thread: HTMLElement): string[] {
  const names = new Set(DETAIL_SECTIONS.map((kind) => `ticket-section-${kind}`));
  return [...thread.querySelectorAll('[data-testid]')]
    .map((element) => element.getAttribute('data-testid')!)
    .filter((id) => names.has(id))
    .map((id) => id.slice('ticket-section-'.length));
}

export function expanded(thread: HTMLElement, kind: string): boolean {
  return within(thread).getByTestId(`ticket-section-${kind}-toggle`).getAttribute('aria-expanded') === 'true';
}
