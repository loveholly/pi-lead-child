// 回归（复核 P1-2）：#66 的生命周期有 56 行，Run #71 的失败在页面上出现 6 次。
// 「经过」把它压成几行：每件事一行，连续的失败合成一行，对话 Run 不进来。
import { describe, expect, it } from 'vitest';

import { buildRunFacts } from './runFacts';
import { TICKET_66_ACTIVITIES, TICKET_66_ATTEMPTS, TICKET_66_CREATED } from './ticket66.fixture';
import { buildTicketStory, type TicketStoryInput } from './ticketStory';

function story66(overrides: Partial<TicketStoryInput> = {}) {
  const facts = buildRunFacts({ attempts: TICKET_66_ATTEMPTS, activities: TICKET_66_ACTIVITIES });
  return buildTicketStory({
    created: TICKET_66_CREATED,
    attempts: TICKET_66_ATTEMPTS,
    activities: TICKET_66_ACTIVITIES,
    facts,
    leadName: 'Paimon',
    ...overrides,
  });
}

describe('the story of ticket #66', () => {
  it('tells what happened in a few lines, one line for each thing', () => {
    expect(story66().map((entry) => [entry.title, entry.detail])).toEqual([
      ['你创建了工单', null],
      ['Run #42 交付', null],
      ['Run #43 核查不通过', expect.stringMatching(/^1\) npm test 全量根测试 exit 1，154 files passed、1 failed；/)],
      ['你授权 Paimon 托管，发起返工', null],
      ['5 次执行没有交付', '模型满载、你换成 Claude Code、认证失败 ×2、交接失败'],
      ['Run #49 交付', null],
      ['你派发了独立核查', null],
      ['核查 Run #73 没有完成', 'Codex 不支持模型 gpt-5.5'],
    ]);
  });

  it('keeps conversation runs and the run in flight out of the story', () => {
    const titles = story66().map((entry) => entry.title).join('\n');
    // 对话 Run #71 的失败在工单对话里；核查 Run #74 正在准备，决策卡说它。
    expect(titles).not.toMatch(/#(?:50|51|71|72|74)\b/);
  });

  it('lists each run of a group with its own reason', () => {
    const group = story66().find((entry) => entry.title === '5 次执行没有交付')!;
    expect(group.runs.map((run) => [run.title, run.reason])).toEqual([
      ['Run #44', '模型满载'],
      ['Run #45', '你换成 Claude Code'],
      ['Run #46', '认证失败'],
      ['Run #47', '认证失败'],
      ['Run #48', '交接失败'],
    ]);
    expect(group.at).toBe('2026-08-19T09:42:01.000Z');
    expect(group.until).toBe('2026-08-21T09:17:54.000Z');
    expect(group.tone).toBe('danger');
  });

  it('marks deliveries and passed reviews as success and your decisions as yours', () => {
    const tones = Object.fromEntries(story66().map((entry) => [entry.title, entry.tone]));
    expect(tones['Run #42 交付']).toBe('success');
    expect(tones['Run #43 核查不通过']).toBe('danger');
    expect(tones['你派发了独立核查']).toBe('accent');
    expect(tones['你创建了工单']).toBe('neutral');
  });
});

describe('the story of a ticket', () => {
  const base = { created: null, facts: new Map(), leadName: 'Paimon' } as const;

  it('breaks a group of failures when something else happens between them', () => {
    const attempts = TICKET_66_ATTEMPTS.filter((attempt) => attempt.id === 44 || attempt.id === 46);
    const activities = [
      ...TICKET_66_ACTIVITIES.filter((activity) => activity.attemptId === 44 || activity.attemptId === 46),
      { id: 900, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z', payload: { decision: 'rework_dispatch_requested' } },
    ];
    const facts = buildRunFacts({ attempts, activities });
    expect(buildTicketStory({ ...base, attempts, activities, facts }).map((entry) => entry.title)).toEqual([
      'Run #44 没有交付',
      '你发起返工',
      'Run #46 没有交付',
    ]);
  });

  it('writes a runtime switch on its own line when no run was stopped for it', () => {
    const activities = [{
      id: 901, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z',
      payload: { decision: 'ticket_runtime_switched', fromRuntime: 'codex', toRuntime: 'claude', previousRunId: null },
    }];
    expect(buildTicketStory({ ...base, attempts: [], activities }).map((entry) => entry.title)).toEqual([
      '你把执行 agent 换成 Claude Code',
    ]);
  });

  it('puts the creation first even when its recorded time is later', () => {
    const activities = [{
      id: 903, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z',
      payload: { decision: 'review_requested_by_user' },
    }];
    const created = { at: '2026-10-15T00:21:00.000Z', by: 'lead' as const };
    expect(buildTicketStory({ ...base, created, attempts: [], activities }).map((entry) => entry.title)).toEqual([
      'Paimon 创建了工单',
      '你派发了独立核查',
    ]);
    expect(buildTicketStory({ ...base, leadName: 'Jarvis', created, attempts: [], activities })[0]?.title).toBe('Jarvis 创建了工单');
  });

  it('ends with the acceptance when you accept the ticket', () => {
    const activities = [{
      id: 902, actor: 'user' as const, kind: 'transition' as const, attemptId: null, createdAt: '2026-08-22T00:00:00.000Z',
      payload: { from: 'review', to: 'done' },
    }];
    expect(buildTicketStory({ ...base, attempts: [], activities })).toMatchObject([{ title: '你验收通过', tone: 'success' }]);
  });
});
