// 失败的白话说法：每个分支一句话，说清发生了什么、系统在做什么、你能做什么。
import { LEAD_RESTART_INTERRUPTED_ERROR, type ConversationToolCall, type KernelCheckpoint } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { presentRunFailureCheckpoint, presentSystemCheckpoint, presentTurnFailure, turnFailureGroupKey } from './failurePresentation';

const clock = () => '22:08';

function runFailure(overrides: Partial<KernelCheckpoint>, facts: Record<string, string>): KernelCheckpoint {
  return {
    id: 1, ticketId: 51, attemptId: 70, author: { kind: 'system', runtime: null }, source: 'system_derived',
    stage: null, kind: 'blocked', title: 'Run crashed', summary: 'Run #70 crashed',
    keyFacts: Object.entries({ Agent: 'Codex', ...facts }).map(([label, value]) => ({ label, value })),
    artifactRefs: [], relatedTicketIds: [], nextStep: null, actionRef: null, createdAt: '2026-10-13T13:45:00.000Z',
    ...overrides,
  } as KernelCheckpoint;
}

describe('presentRunFailureCheckpoint', () => {
  it('says the system retries by itself when the kernel scheduled a backoff retry', () => {
    const presented = presentRunFailureCheckpoint(runFailure({ kind: 'progress' }, {
      'Failure category': 'model_capacity', 'Failure scope': 'attempt', Needs: 'none',
    }))!;
    expect(presented).toMatchObject({ label: '自动重试中', tone: 'warning', needsUser: false });
    expect(presented.headline).toBe('工单 #51 的 Codex 遇到模型满载，系统会自动重试；你不需要操作。');
  });

  // 2026-10-19 发布评审：用量额度用完（usage_limited）以前和充值共用一个类别，App 写「账号余额不足」，和「不用充值」矛盾。
  it('says the usage quota is used up, not that the account is out of credits', () => {
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'usage_limit', 'Failure scope': 'account', Needs: 'none',
    }))!;
    expect(presented.headline).toContain('用量额度用完，在等重置');
    expect(presented.headline).not.toContain('余额');
  });

  it('names what the user has to do for an account failure', () => {
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'authentication', 'Failure scope': 'account', Needs: 'login',
    }))!;
    expect(presented).toMatchObject({ label: '需要你处理', needsUser: true });
    expect(presented.headline).toBe('工单 #51 的 Codex 认证失败，系统暂停了派发；需要你重新登录 Codex。');
  });

  it('hands the decision to the user once retries are exhausted', () => {
    const presented = presentRunFailureCheckpoint(runFailure({
      nextStep: 'Retries are exhausted (2/2); dispatch is halted. Do not retry.',
    }, { 'Failure category': 'unknown', 'Failure scope': 'unknown', Needs: 'none' }))!;
    expect(presented.headline).toBe('工单 #51 的 Codex 运行出错，自动重试已经用完；需要你决定下一步。');
    expect(presented.details).toContain('Retries are exhausted');
  });

  it('does not promise that Lead decides while Lead cannot reach its model', () => {
    const lead = {
      state: 'degraded' as const, since: null, failures: 3, reason: 'Lead 的模型服务暂时连不上', detail: '503',
      nextAttemptAt: null, lastSuccessAt: null,
    };
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'unknown', 'Failure scope': 'unknown', Needs: 'none',
    }), { lead })!;
    expect(presented).toMatchObject({ label: '等 Paimon 恢复', needsUser: true });
    expect(presented.headline)
      .toBe('工单 #51 的 Codex 运行出错，Paimon 现在连不上模型，恢复后会判断能不能安全重试；着急的话可以打开工单自己处理。');
  });

  it('tells a settled failure as history, whatever Lead\'s health is now', () => {
    const lead = {
      state: 'degraded' as const, since: null, failures: 3, reason: 'Lead 的模型服务暂时连不上', detail: '503',
      nextAttemptAt: null, lastSuccessAt: null,
    };
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'unknown', 'Failure scope': 'unknown', Needs: 'none',
    }), { lead, settled: true })!;
    expect(presented).toMatchObject({ label: '运行失败', needsUser: false });
    expect(presented.headline).toBe('工单 #51 的 Codex 运行出错。');
  });

  // 2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈。工单的 TicketSummary 说 Lead 在处理，
  // 卡片就说「Lead 处理中」，不说「需要你处理」，哪怕失败本身是配置类的。
  it('says Lead is handling it while the ticket says so, even for a configuration failure', () => {
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'runtime_configuration', 'Failure scope': 'runtime', Needs: 'config',
    }), { leadHandling: true })!;
    expect(presented).toMatchObject({ label: 'Paimon 处理中', tone: 'warning', needsUser: false });
    expect(presented.headline).toBe('工单 #51 的 Codex 配置有误，Paimon 正在处理；需要你时它会告诉你。');
  });

  it('asks the user once the ticket says Lead could not handle it', () => {
    const presented = presentRunFailureCheckpoint(runFailure({}, {
      'Failure category': 'unknown', 'Failure scope': 'unknown', Needs: 'none',
    }), { escalated: true })!;
    expect(presented).toMatchObject({ label: '需要你处理', tone: 'danger', needsUser: true });
    expect(presented.headline).toBe('工单 #51 的 Codex 运行出错，Paimon 没能处理它；需要你看一下。');
  });

  it('leaves other checkpoints alone', () => {
    expect(presentRunFailureCheckpoint(runFailure({ source: 'agent_reported' }, { 'Failure category': 'unknown' }))).toBeNull();
    expect(presentRunFailureCheckpoint(runFailure({}, {}))).toBeNull();
  });
});

describe('presentTurnFailure', () => {
  const base = { originKind: 'paired:companion', ticketId: null, userText: '在吗', lead: undefined, clock };

  // 2026-10-27 画布「没有回答」：每种失败画成哪个模式、一行里写什么、点开以后有哪几行。
  it('picks the pattern and the one-line words for each kind of failure', () => {
    const empty = presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: 'Lead 未生成回复，请重试。' } });
    expect(empty).toMatchObject({ form: 'absence', label: '没有回答', quote: '在吗', summary: null });
    expect(empty.facts).toEqual([{ label: '原因', value: 'Paimon 这次没有给出回答' }]);

    // 认证失败直接重发也一样失败：一行里先说要检查什么。
    const auth = presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: '401 Unauthorized' } });
    expect(auth).toMatchObject({ form: 'absence', summary: '请先检查 Paimon 的模型账号，再重发' });

    const restart = presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: LEAD_RESTART_INTERRUPTED_ERROR } });
    expect(restart).toMatchObject({ form: 'tail', label: '重启打断，会接着回复', actions: [] });

    const heartbeat = presentTurnFailure({
      ...base, originKind: 'system:heartbeat', userText: null,
      failure: { kind: 'turn-error', code: null, message: '503 Service Unavailable' },
    });
    expect(heartbeat).toMatchObject({ form: 'system', label: '心跳巡检没有完成', actions: [] });
    expect(heartbeat.facts.find((fact) => fact.label === '接下来')?.value).toBe('模型现在已经恢复');
  });

  it('explains an empty reply and an auth failure on a user turn', () => {
    expect(presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: 'Lead 未生成回复，请重试。' } }).headline)
      .toBe('Paimon 这次没有给出回答；你可以点「重发」再问一次。');
    expect(presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: '401 Unauthorized' } }).headline)
      .toBe('Paimon 的模型账号认证失败，这条消息没有得到回答；请先检查 Paimon 的模型账号，再点「重发」。');
  });

  it('says the model is back when a past heartbeat failure is shown after recovery', () => {
    const presented = presentTurnFailure({
      ...base, originKind: 'system:heartbeat', userText: null,
      failure: { kind: 'turn-error', code: null, message: '503: service unavailable' },
    });
    expect(presented.headline).toBe('Paimon 的模型服务暂时连不上，这次心跳巡检没有完成；模型现在已经恢复，你不需要操作。');
    expect(presented.actions).toEqual([]);
  });

  it('names a failed digest round (system:digest, ticket 04/05) in its own words', () => {
    const presented = presentTurnFailure({
      ...base, originKind: 'system:digest', userText: null,
      failure: { kind: 'turn-error', code: null, message: '503: service unavailable' },
    });
    expect(presented.headline).toBe('Paimon 的模型服务暂时连不上，这一批摘要没有处理完；模型现在已经恢复，你不需要操作。');
    expect(presented.actions).toEqual([]);
  });

  it('groups only failures of Lead-initiated turns, by origin and kind', () => {
    const unavailable = { kind: 'turn-error' as const, code: null, message: '503: x' };
    expect(turnFailureGroupKey(unavailable, 'system:heartbeat')).toBe('system:heartbeat|unavailable');
    expect(turnFailureGroupKey(unavailable, 'paired:companion')).toBeNull();
    expect(turnFailureGroupKey({ kind: 'rejected', code: null, message: 'x' }, 'system:heartbeat')).toBeNull();
  });
});

// 2026-10-16 07:57：Lead 建好提醒 #83 以后，部署打断了这一轮。失败行说「Lead 这次没有给出回答」，还给「重发」：
// 点了会再建一个提醒。现在失败行先说已经做完的事；做过事的一轮不给「重发」；被重启打断有自己的说法。
describe('a failed turn whose tools already did something', () => {
  const base = { originKind: 'paired:companion', ticketId: null, userText: '提醒我下周一早上关注 aish', lead: undefined, clock };
  const tool = (name: string, state: ConversationToolCall['state'], result: string | null, args: string | null = null) => ({
    name, state,
    args: args === null ? null : { preview: args, truncated: false, redacted: false, artifactRefs: [] },
    result: result === null ? null : { preview: result, truncated: false, redacted: false, artifactRefs: [] },
  });
  const reminder = tool('create_reminder', 'completed',
    '{"content":[{"type":"text","text":"created reminder #83，将于 2026-10-19T01:00:00.000Z 提醒"}]}');
  const interrupted = { kind: 'turn-error' as const, code: null, message: LEAD_RESTART_INTERRUPTED_ERROR };

  it('names the reminder it created and offers no resend after a restart interrupted it', () => {
    const presented = presentTurnFailure({ ...base, failure: interrupted, tools: [reminder] });
    expect(presented.headline).toBe('提醒 #83 已创建；回复被重启打断，Paimon 会接着回复你。');
    expect(presented.actions).toEqual([]);
    expect(presented.tone).toBe('warning');
  });

  it('has its own wording when a restart interrupted a turn with no tools', () => {
    const presented = presentTurnFailure({ ...base, failure: interrupted });
    expect(presented.headline).not.toContain('没有给出回答');
    expect(presented.headline).toBe('回复被重启打断，Paimon 会接着回复你。');
    expect(presented.actions).toEqual([]);
    expect(presented.tone).toBe('warning');
  });

  it('offers no resend for an ordinary failure either, and still says what was done', () => {
    const presented = presentTurnFailure({
      ...base, failure: { kind: 'turn-error', code: null, message: '503: service unavailable' }, tools: [reminder],
    });
    expect(presented.headline).toBe('提醒 #83 已创建；Paimon 的模型服务暂时连不上，回复没有完成。做过的事不会重做；要继续的话，直接告诉 Paimon。');
    expect(presented.actions).toEqual([]);
  });

  it('still offers resend when no tool ran', () => {
    const presented = presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: '503: service unavailable' }, tools: [] });
    expect(presented.actions).toEqual(['resend']);
  });

  it('counts tools it cannot name, and does not group restart failures of Lead-initiated turns', () => {
    const presented = presentTurnFailure({ ...base, failure: interrupted, tools: [tool('query_tickets', 'completed', '[]'), reminder] });
    expect(presented.headline).toBe('提醒 #83 已创建，另有 1 个操作已完成；回复被重启打断，Paimon 会接着回复你。');
    expect(turnFailureGroupKey(interrupted, 'system:blocker')).toBeNull();
    const system = presentTurnFailure({ ...base, originKind: 'system:blocker', userText: null, failure: interrupted });
    expect(system.headline).toBe('Paimon 的这一轮被重启打断；重启后系统会继续，你不需要操作。');
    expect(system.tone).toBe('warning');
  });

  // 审查的 NIT（3688968）。
  it('keeps the check-the-account wording for an auth failure after tools ran', () => {
    const presented = presentTurnFailure({ ...base, failure: { kind: 'turn-error', code: null, message: '401 Unauthorized' }, tools: [reminder] });
    expect(presented.headline).toBe('提醒 #83 已创建；Paimon 的模型账号认证失败，回复没有完成。请先检查 Paimon 的模型账号，再告诉 Paimon 接着做；做过的事不会重做。');
    expect(presented.actions).toEqual([]);
  });

  it('takes the item number from the tool result text, not from any # in the raw preview', () => {
    const relates = tool('create_task', 'completed',
      '{"content":[{"type":"text","text":"created task #84（ready，已可执行，无需确认）\\n关系：#84 依赖 #66"}],"details":{"ref":"#12"}}');
    expect(presentTurnFailure({ ...base, failure: interrupted, tools: [relates] }).headline).toContain('工单 #84 已创建');
    const targeted = tool('cancel_item', 'completed', '{"content":[{"type":"text","text":"cancelled (was #12 child of #66)"}]}', '{"ticket_id":91}');
    expect(presentTurnFailure({ ...base, failure: interrupted, tools: [targeted] }).headline).toContain('#91 已取消');
  });

  it('uses the restart wording in a ticket conversation too', () => {
    const presented = presentTurnFailure({ ...base, ticketId: 66, failure: interrupted, tools: [reminder] });
    expect(presented.headline).toBe('提醒 #83 已创建；回复被重启打断，Paimon 会接着回复你。');
  });

  it('says Lead already continued once a later Lead turn exists', () => {
    const presented = presentTurnFailure({ ...base, failure: interrupted, tools: [reminder], continued: true });
    expect(presented.headline).toBe('提醒 #83 已创建；回复被重启打断，Paimon 已接着回复。');
  });
});

// 2026-10-27：系统写的检查点画成一行系统信息。英文标题是代码里的常量，对照成中文；原文放进 details。
describe('presentSystemCheckpoint', () => {
  const reclaimed = runFailure({
    id: 2, ticketId: 2, title: 'Run reclaimed after daemon restart', summary: 'Run #1 was reclaimed because the daemon restarted while it was active.',
    keyFacts: [], nextStep: 'Recover or redispatch the interrupted item.',
  }, {});

  it('says in Chinese that the run was reclaimed, and leaves it to Lead first', () => {
    expect(presentSystemCheckpoint(reclaimed)).toMatchObject({
      text: '工单 #2 的 Run 在 daemon 重启时被收回 · Paimon 会判断要不要重新派发', needsUser: false, ok: false,
    });
    expect(presentSystemCheckpoint(reclaimed)!.details).toContain('Recover or redispatch the interrupted item.');
  });

  it('asks the user only when the ticket has a blocker for them, and says how it is now once it moved on', () => {
    expect(presentSystemCheckpoint(reclaimed, { escalated: true })).toMatchObject({ needsUser: true });
    expect(presentSystemCheckpoint(reclaimed, { settled: true, nowLabel: '现在：进行中' })!.text).toBe('工单 #2 的 Run 在 daemon 重启时被收回 · 现在：进行中');
  });

  it('marks a recovery as fine, and leaves agent checkpoints and requests alone', () => {
    const recovered = runFailure({ kind: 'progress', title: 'Run recovered after daemon restart', keyFacts: [] }, {});
    expect(presentSystemCheckpoint(recovered)).toMatchObject({ ok: true, needsUser: false, text: '工单 #51 的 Run 被收回以后，系统接着派发了' });
    expect(presentSystemCheckpoint(runFailure({ source: 'agent_reported' }, {}))).toBeNull();
    expect(presentSystemCheckpoint(runFailure({ actionRef: { type: 'approval', id: 1 } }, {}))).toBeNull();
  });
});
