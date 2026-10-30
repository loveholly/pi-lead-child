// 回归：工单 #66 的执行尝试和运行日志把核查不通过、交接失败都写成「成功」，把对话写成「执行」。
// 数据取自实例上 #66 的活动流（plc show 66），只保留判断用到的字段。
import type { ActivityDto } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import type { AttemptEntity } from '@/state/types';

import { buildRunFacts, runFailureReason, runOutcome } from './runFacts';
import { TICKET_66_ACTIVITIES, TICKET_66_ATTEMPTS } from './ticket66.fixture';

type Attempt = Pick<AttemptEntity, 'id' | 'role' | 'purpose' | 'state' | 'exitCode'>;
type Activity = Pick<ActivityDto, 'kind' | 'attemptId' | 'payload'>;

const attempts: Attempt[] = [
  { id: 42, role: 'executor', purpose: 'execution', state: 'settled', exitCode: 0 },
  { id: 43, role: 'reviewer', purpose: 'review', state: 'settled', exitCode: 0 },
  { id: 44, role: 'executor', purpose: 'execution', state: 'crashed', exitCode: null },
  { id: 45, role: 'executor', purpose: 'execution', state: 'stopped', exitCode: null },
  { id: 47, role: 'executor', purpose: 'execution', state: 'crashed', exitCode: 1 },
  { id: 48, role: 'executor', purpose: 'execution', state: 'settled', exitCode: 0 },
  { id: 49, role: 'executor', purpose: 'execution', state: 'settled', exitCode: 0 },
  { id: 51, role: 'executor', purpose: 'conversation', state: 'settled', exitCode: 0 },
  { id: 71, role: 'executor', purpose: 'conversation', state: 'crashed', exitCode: 1 },
];

const activities: Activity[] = [
  { kind: 'transition', attemptId: 42, payload: { from: 'active', to: 'review', reason: 'Implementation complete; independent review requested' } },
  { kind: 'decision', attemptId: 43, payload: { decision: 'review_verdict_waiting_user', verdict: 'fail', reviewerRunId: 43 } },
  { kind: 'transition', attemptId: 44, payload: { from: 'active', to: 'blocked', reason: 'Selected model is at capacity. Please try a different model.' } },
  { kind: 'transition', attemptId: 47, payload: { from: 'active', to: 'blocked', reason: 'Failed to authenticate: OAuth session expired and could not be refreshed' } },
  { kind: 'transition', attemptId: 48, payload: { from: 'active', to: 'blocked', reason: 'run ended without terminal handoff' } },
  { kind: 'notification', attemptId: 48, payload: { kind: 'blocked', title: '运行结束，交接失败' } },
  { kind: 'transition', attemptId: 49, payload: { from: 'active', to: 'review', reason: 'recovered outcome snapshot from successful runtime output' } },
  { kind: 'crash', attemptId: 71, payload: { reason: 'No conversation found with session ID: 20fd5938-01a7-42ce-b4b4-bb1a98831c80' } },
  { kind: 'notification', attemptId: 71, payload: { kind: 'blocked', title: 'Run crashed' } },
];

function outcomeOf(id: number) {
  const facts = buildRunFacts({ attempts, activities });
  return runOutcome(attempts.find((attempt) => attempt.id === id)!, facts.get(id));
}

describe('run facts for ticket #66', () => {
  it('names the reviewer run by its verdict, not by its exit code', () => {
    expect(outcomeOf(43)).toEqual({ purposeLabel: '核查', result: '不通过', tone: 'danger' });
  });

  it('names a run that ended without a terminal handoff as a handoff failure', () => {
    expect(outcomeOf(48)).toEqual({ purposeLabel: '执行', result: '交接失败', tone: 'danger' });
  });

  it('names a run that moved the ticket to review as a delivery', () => {
    expect(outcomeOf(42)).toEqual({ purposeLabel: '执行', result: '已交付', tone: 'success' });
    expect(outcomeOf(49)).toEqual({ purposeLabel: '执行', result: '已交付', tone: 'success' });
  });

  it('names conversation runs as conversations', () => {
    expect(outcomeOf(51)).toEqual({ purposeLabel: '对话', result: '已回答', tone: 'success' });
    expect(outcomeOf(71)).toEqual({ purposeLabel: '对话', result: '没有回答（exit 1）', tone: 'danger' });
  });

  it('records which runs blocked the ticket', () => {
    const facts = buildRunFacts({ attempts, activities });
    expect(facts.get(44)?.blockedTicket).toBe(true);
    expect(facts.get(48)?.blockedTicket).toBe(true);
    // 对话 Run #71 崩溃了，但工单一直在 review：它没有让工单阻塞。
    expect(facts.get(71)?.blockedTicket).toBe(false);
  });

  it('keeps failures and stops as they are', () => {
    expect(outcomeOf(44)).toEqual({ purposeLabel: '执行', result: '失败', tone: 'danger' });
    expect(outcomeOf(47)).toEqual({ purposeLabel: '执行', result: '失败（exit 1）', tone: 'danger' });
    expect(outcomeOf(45)).toEqual({ purposeLabel: '执行', result: '已停止', tone: 'neutral' });
  });
});

describe('run facts', () => {
  it('reads a superseded verdict from the review state when the activities lack it', () => {
    const facts = buildRunFacts({
      attempts,
      activities: [],
      review: {
        reviewerAttemptId: null,
        verdict: null,
        supersededReview: { reviewerAttemptId: 43, verdict: 'fail', reviewedRunId: 42, supersededByRunId: 49 },
      },
    });
    expect(facts.get(43)?.verdict).toBe('fail');
  });

  it('does not claim success for a run whose result is unknown', () => {
    const settled: Attempt = { id: 9, role: 'executor', purpose: 'execution', state: 'settled', exitCode: 0 };
    expect(runOutcome(settled)).toEqual({ purposeLabel: '执行', result: '已结束', tone: 'neutral' });
  });

  it('infers the purpose from the role when the run has none', () => {
    const reviewer: Attempt = { id: 10, role: 'reviewer', purpose: null, state: 'running', exitCode: null };
    expect(runOutcome(reviewer)).toEqual({ purposeLabel: '核查', result: '核查中', tone: 'running' });
  });

  it('ignores a verdict on a run that is not a review', () => {
    const facts = buildRunFacts({
      attempts,
      activities: [{ kind: 'decision', attemptId: 42, payload: { decision: 'x', verdict: 'pass', reviewerRunId: 42 } }],
    });
    expect(facts.get(42)?.verdict).toBeNull();
  });
});

describe('why a run of ticket #66 did not deliver', () => {
  const facts = buildRunFacts({ attempts: TICKET_66_ATTEMPTS, activities: TICKET_66_ACTIVITIES });
  const reason = (id: number) => runFailureReason(TICKET_66_ATTEMPTS.find((attempt) => attempt.id === id)!, facts.get(id)!);

  it('reads the category the server classified, and the crash text for older runs', () => {
    // #44 和 #46 早于服务端分类，只有崩溃原文；#47 和 #73 有 runtime_failure_classified。
    expect(reason(44)).toBe('模型满载');
    expect(reason(46)).toBe('认证失败');
    expect(reason(47)).toBe('认证失败');
    expect(reason(73)).toBe('Codex 不支持模型 gpt-5.5');
  });

  // 2026-10-19 发布评审：用量额度用完不是余额不足（不用充值），原因要说对。
  it('names a usage limit as a used-up quota, not as a balance problem', () => {
    const attempts = [{ id: 111, role: 'executor' as const, purpose: 'execution' as const }];
    const classified = buildRunFacts({
      attempts,
      activities: [{ kind: 'decision', attemptId: 111, payload: { decision: 'runtime_failure_classified', category: 'usage_limit' } }],
    });
    expect(runFailureReason({ state: 'crashed', runtime: 'pi', model: 'vibeproxy/claude-opus-4-6-thinking' }, classified.get(111)!)).toBe('用量额度用完');
  });

  it('says that you stopped the run to switch the agent', () => {
    expect(facts.get(45)).toMatchObject({ stoppedByUser: true, switchedTo: 'claude' });
    expect(reason(45)).toBe('你换成 Claude Code');
  });

  it('names a handoff failure and gives no reason for runs that delivered or are in flight', () => {
    expect(reason(48)).toBe('交接失败');
    expect(reason(42)).toBeNull();
    expect(reason(43)).toBeNull();
    expect(reason(74)).toBeNull();
  });

  it('names a run reclaimed by a daemon restart as interrupted', () => {
    const attempts = [{ id: 78, role: 'reviewer' as const, purpose: 'review' as const }];
    const reclaimed = buildRunFacts({
      attempts,
      activities: [{ kind: 'crash', attemptId: 78, payload: { reason: 'daemon restart: orphaned run reclaimed', pid: null } }],
    });
    expect(runFailureReason({ state: 'crashed', runtime: 'codex', model: 'gpt-5.5' }, reclaimed.get(78)!)).toBe('Run 被中断');
  });

  it('falls back to the crash text when the server could not classify the failure', () => {
    // #71 的分类是 unknown，原文说旧会话不存在了。
    expect(facts.get(71)?.failure).toBe('session_expired');
  });
});
