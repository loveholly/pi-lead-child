// @vitest-environment jsdom
import type { KernelIntervention } from '@pi-lead-child/protocol';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUI } from '../../../test/render';
import { buildInterventionCardViewModel, InterventionCard } from './InterventionCard';

// 2026-10-26：child #160 的已解决请求卡有两个问题。
//   1. 回答里的 Markdown 表格原样显示成 `| PR | 轮次 |` 和 `|---|`。
//   2. 末尾的署名是内部的 actor 字符串「· lead」，不是 Lead 的名字。
const TABLE_ANSWER = [
  '两个 PR 的 review 都过了：',
  '',
  '| PR | 轮次 | 结论 |',
  '|---|---|---|',
  '| #81 | 2 | 通过 |',
  '| #82 | 1 | 通过 |',
].join('\n');

function resolvedDecision(resolvedBy: string | null, text = '按现有方案继续'): KernelIntervention {
  return {
    id: 'decision:7',
    kind: 'question',
    authorityId: 7,
    ticketId: 160,
    attemptId: 73,
    audience: 'lead_or_user',
    blocking: true,
    allowCustom: true,
    state: 'resolved',
    title: '两个 PR 的 review 结果怎样？',
    detail: '请确认 review 结果。',
    options: [],
    actions: [],
    resolution: { kind: 'text', text, optionId: null },
    createdAt: '2026-10-26T08:00:00.000Z',
    resolvedBy,
    resolvedAt: '2026-10-26T08:05:00.000Z',
  };
}

describe('resolved intervention card', () => {
  // 2026-10-27 按画布重画：已解决的请求收成一行（「已解决 · Fairy 已回答，附 1 张表」），点开在浮层里看回答。
  it('renders a markdown table in the answer as a table, not as pipe text', async () => {
    renderUI(
      <InterventionCard intervention={resolvedDecision('lead', TABLE_ANSWER)} leadName="Fairy" onOpenTicket={() => {}} />,
    );
    expect(document.body.textContent).toContain('Fairy 已回答，附 1 张表');
    fireEvent.click(screen.getByTestId('surface-disclosure-intervention-decision:7-summary'));
    expect(await screen.findByTestId('markdown-table')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(screen.getByTestId('markdown-table-scroll')).toBeTruthy();
    expect(text).toContain('两个 PR 的 review 都过了');
    expect(text).toContain('#81');
    expect(text).not.toContain('|---');
    expect(text).not.toContain('| PR |');
  });

  it('signs the answer with the Lead name, not the internal actor string', () => {
    const { container } = renderUI(
      <InterventionCard intervention={resolvedDecision('lead')} leadName="Fairy" onOpenTicket={() => {}} />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('Fairy');
    expect(text).not.toMatch(/·\s*lead/u);
  });

  it('names every actor the backend writes in words for people', () => {
    const by = (resolvedBy: string | null) => buildInterventionCardViewModel(resolvedDecision(resolvedBy), 'Fairy').resolvedByLabel;

    expect(by('lead')).toBe('Fairy');
    expect(by('lead for user via turn:42')).toBe('Fairy 代你');
    expect(by('user via page')).toBe('你');
    expect(by('user via paired binding:3')).toBe('你');
    expect(by('user via slack:U123')).toBe('你');
    expect(by('system: superseded')).toBe('系统');
    expect(by(null)).toBeNull();
  });
});

// 2026-10-27：卡片头部写的是内核的占位标题「Approval required: bash」「Decision required」，不是 child 要什么。
// 画布写的是 child 自己的话：审批写它那一步（checkpoint 的标题，摘要跟在命令后面），决定写它问的那句。
describe('pending intervention card header', () => {
  const checkpoint = {
    id: 'checkpoint:1', ticketId: 160, attemptId: 73, source: 'agent_reported', kind: 'blocked', stage: null,
    title: '想把分支推到 GitHub', summary: '3 个 commit · 只推分支，不开 PR', keyFacts: [], artifactRefs: [], relatedTicketIds: [],
    nextStep: null, actionRef: { type: 'approval', id: 5 }, progress: null, proofItems: [], author: { kind: 'child' },
    createdAt: '2026-10-26T08:02:00.000Z',
  } as never;

  it('names the approval by the child step and quotes the command with its summary', () => {
    const approval: KernelIntervention = {
      id: 'approval:5', kind: 'approval', authorityId: 5, ticketId: 160, attemptId: 73, audience: 'user', state: 'pending',
      title: 'Approval required: bash', detail: 'git push origin claude/code-review-skill', actions: ['approve', 'reject', 'approve_session'],
      resolution: null, createdAt: '2026-10-26T08:02:00.000Z', resolvedBy: null, resolvedAt: null,
    };
    const { container } = renderUI(<InterventionCard intervention={approval} checkpoint={checkpoint} leadName="Fairy" onOpenTicket={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain('child #160 想把分支推到 GitHub');
    expect(text).toContain('$ git push origin claude/code-review-skill');
    expect(text).toContain('3 个 commit · 只推分支，不开 PR');
    expect(text).not.toContain('Approval required');
    expect(text).not.toContain('来自 child');
  });

  it('puts the decision question in the header, once', () => {
    const decision: KernelIntervention = {
      id: 'decision:8', kind: 'decision', authorityId: 8, ticketId: 160, attemptId: 73, audience: 'user', blocking: true, allowCustom: true,
      state: 'pending', title: 'Decision required', detail: '第二轮审查按什么粒度送？',
      options: [{ id: 'hunk', label: '只送改过的 hunk', description: '快' }, { id: 'file', label: '整个文件重送', description: '慢' }],
      actions: [{ kind: 'select', optionId: 'hunk', label: '只送改过的 hunk' }, { kind: 'select', optionId: 'file', label: '整个文件重送' }, { kind: 'dismiss', label: 'Dismiss' }],
      resolution: null, createdAt: '2026-10-26T08:04:00.000Z', resolvedBy: null, resolvedAt: null,
    };
    const { container } = renderUI(<InterventionCard intervention={decision} leadName="Fairy" onOpenTicket={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain('child #160：第二轮审查按什么粒度送？');
    expect(text.split('第二轮审查按什么粒度送？')).toHaveLength(2);
    expect(text).not.toContain('Decision required');
  });

  it('ends a resolved question with the question itself', () => {
    const { container } = renderUI(<InterventionCard intervention={resolvedDecision('lead')} leadName="Fairy" onOpenTicket={() => {}} />);
    expect(container.textContent).toContain('请确认 review 结果。 · Fairy 已回答');
  });
});
