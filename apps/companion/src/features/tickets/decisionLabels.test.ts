// 回归：#66 的生命周期里有 13 行把机器 id 当标题（决策：rework_grant_attributed 等）。
import type { ActivityDto } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { decisionLabel } from './decisionLabels';
import { buildLifecyclePresentation } from './ticketHistory';

// #66 活动流里出现过的全部决策（plc show 66）。
const DECISIONS_ON_66 = [
  'link_ticket_relation', 'relation_execution_gate_migrated', 'review_verdict_waiting_user',
  'delegation_preflight_accepted', 'dispatch_requested', 'rework_dispatch_requested', 'ticket_runtime_switched',
  'runtime_failure_classified', 'rework_grant_attributed', 'spurious_outcome_record_removed',
  'ticket_agent_turn_text_restored', 'runtime_session_expired', '开始执行', '停止执行',
];

function activity(id: number, payload: Record<string, unknown>): ActivityDto {
  return {
    id, ticketId: 66, attemptId: null, actor: 'system', kind: 'decision', payload, sessionCursor: null,
    createdAt: `2026-10-13T10:59:${String(id).padStart(2, '0')}.000Z`,
  };
}

describe('decision titles in the lifecycle', () => {
  it('regression #66: shows no machine ids as titles', () => {
    const items = buildLifecyclePresentation({
      ticketId: 66,
      leadName: 'Paimon',
      activities: DECISIONS_ON_66.map((decision, index) => activity(index + 1, { decision })),
    });
    const titles = items.map((item) => item.title);
    expect(titles.filter((title) => /[a-z]+_[a-z_]+/.test(title))).toEqual([]);
    expect(titles.filter((title) => title.startsWith('决策：'))).toEqual([]);
    expect(titles).toContain('The rework counts against the budget that Paimon manages');
    expect(titles).toContain('Start run');
    expect(titles).toContain('Stop run');
  });

  it('regression 2026-10-21: names the reviewer and pull request decisions this release writes', () => {
    // 换核查员、Lead 派核查、开 PR 这三条决定以前没有标题，生命周期里显示成「系统记录」加机器 id。
    for (const decision of ['reviewer_runtime_switched', 'review_requested_by_lead', 'workspace_pr_opened']) {
      expect(decisionLabel(decision, 'Paimon').unknownId, decision).toBeNull();
    }
    expect(decisionLabel('reviewer_runtime_switched', 'Paimon').title).toBe('Changed the reviewer');
    expect(decisionLabel('review_requested_by_lead', 'Paimon').title).toBe('Paimon requested an independent review');
    expect(decisionLabel('review_requested_by_lead', 'Jarvis').title).toBe('Jarvis requested an independent review');
    expect(decisionLabel('workspace_pr_opened', 'Paimon').title).toBe('Opened a draft PR');
    // link_pr 登记的 PR 也写这个 id（带 linked 标记）：标题写登记，不写「开了草稿 PR」。
    expect(decisionLabel('workspace_pr_opened', 'Paimon', { linked: true }).title).toBe('Linked an existing PR');
    expect(decisionLabel('workspace_pr_opened', 'Paimon', { linked: true }, 'zh').title).toBe('登记了已有的 PR');
    // 2026-10-21：v51 按新口径重算 token 用量时给工单写的活动。
    expect(decisionLabel('token_usage_recomputed', 'Paimon')).toEqual({ title: 'Calculated the token usage again with the new method', unknownId: null });
  });

  it('names a review verdict that waits for the user by its verdict', () => {
    expect(decisionLabel('review_verdict_waiting_user', 'Paimon', { verdict: 'fail' }).title).toBe('The review failed. It waits for your decision');
    expect(decisionLabel('review_verdict_waiting_user', 'Paimon', { verdict: 'pass' }).title).toBe('The review passed. It waits for your acceptance');
  });

  // 工单 05：验收标准的三个操作写的决定。以前生命周期里显示成「系统记录」加机器 id。
  it('names the acceptance criteria decisions', () => {
    expect(decisionLabel('acceptance_criteria_edited', 'Paimon')).toEqual({ title: 'Changed the acceptance criteria', unknownId: null });
    expect(decisionLabel('criterion_confirmed', 'Paimon')).toEqual({ title: 'Confirmed an acceptance criterion', unknownId: null });
    expect(decisionLabel('criterion_unconfirmed', 'Paimon')).toEqual({ title: 'Removed the confirmation of an acceptance criterion', unknownId: null });
  });

  // 工单 11：核查没做成时的两个操作写的决定。托管下 Lead 凭证据验收要写明没有独立核查。
  it('names the review failure decisions, and says when Lead accepted without a review', () => {
    expect(decisionLabel('review_retry_requested', 'Paimon')).toEqual({ title: 'Retried the review', unknownId: null });
    expect(decisionLabel('review_verdict_discarded', 'Paimon').unknownId).toBeNull();
    expect(decisionLabel('accepted_without_review', 'Paimon', { authority: 'user' }))
      .toEqual({ title: 'Accepted directly without an independent review', unknownId: null });
    expect(decisionLabel('accepted_without_review', 'Paimon', { authority: 'delegated' }))
      .toEqual({ title: 'No independent review. Paimon accepted the ticket for you on the evidence', unknownId: null });
  });

  // 工单 08：换模型和推理强度、换执行 agent 写的决定。
  it('names the model, effort and runtime switches', () => {
    expect(decisionLabel('execution_profile_selected', 'Paimon')).toEqual({ title: 'Selected the model and reasoning effort', unknownId: null });
    expect(decisionLabel('run_profile_changed', 'Paimon')).toEqual({ title: 'Changed the model and reasoning effort', unknownId: null });
    expect(decisionLabel('executor_runtime_changed', 'Paimon')).toEqual({ title: 'Changed the executor agent', unknownId: null });
  });

  // 2026-10-19：用户在对话里要求开工一张草稿，Lead 用 authorize_start 落下这条决定。
  it('names a start the user asked for in conversation', () => {
    expect(decisionLabel('start_authorized', 'Paimon')).toEqual({ title: 'You confirmed the start in the conversation', unknownId: null });
  });

  it('keeps an unknown machine id out of the title and in the reason', () => {
    expect(decisionLabel('some_future_decision', 'Paimon')).toEqual({ title: 'System record', unknownId: 'some_future_decision' });
    const [item] = buildLifecyclePresentation({ ticketId: 66, leadName: 'Paimon', activities: [activity(1, { decision: 'some_future_decision', reason: '原因' })] });
    expect(item).toMatchObject({ title: 'System record', reason: '原因 · Record type some_future_decision' });
  });

  it('uses the title and summary of a decision checkpoint that has no decision id', () => {
    const [item] = buildLifecyclePresentation({
      ticketId: 66,
      leadName: 'Paimon',
      activities: [activity(1, { checkpointId: 5, kind: 'decision', title: '改用共享工作区', summary: '隔离工作区建不出来' })],
    });
    expect(item).toMatchObject({ title: '改用共享工作区', reason: '隔离工作区建不出来' });
  });

  it('writes the titles in Chinese when the interface language is Chinese', () => {
    expect(decisionLabel('review_requested_by_lead', 'Paimon', {}, 'zh').title).toBe('Paimon 派发了独立核查');
    expect(decisionLabel('开始执行', 'Paimon', {}, 'zh').title).toBe('开始执行');
    expect(decisionLabel('some_future_decision', 'Paimon', {}, 'zh').title).toBe('系统记录');
  });
});
