// 项目卡片（左栏改版阶段 2，方向 A）的视图模型：只放会变的判断，安静的和归档的项目收起来。
import type { ProjectOverview } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildProjectCards } from './projectModel';

const now = new Date('2026-10-15T07:46:00.000Z');

function project(id: string, name: string, overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    id, name, status: 'active',
    counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 0 },
    leadStatus: null, lastActivityAt: null, nextMilestone: null, spend: { costUsd: 0, tokens: 0 },
    ...overrides,
  };
}

// 2026-10-15 实例上的项目（数字取自真实库的快照）。
const overviews: ProjectOverview[] = [
  project('4', 'companion-acceptance', { counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 1 }, lastActivityAt: '2026-09-04T13:25:17.000Z' }),
  project('2', 'Dialogue Returns Business Parity', {
    counts: { user: 0, running: 0, lead: 0, queued: 1, ended: 2 }, lastActivityAt: '2026-09-18T01:48:14.000Z',
  }),
  project('1', 'pi-lead-child', {
    counts: { user: 4, running: 1, lead: 5, queued: 0, ended: 8 },
    leadStatus: { text: '卡在 #72 的 review 投影；#66 正在重新核查。', at: '2026-10-15T07:43:00.000Z' },
    lastActivityAt: '2026-10-15T07:43:00.000Z',
    nextMilestone: { ticketId: 72, title: '修复 review 状态投影', kind: 'test_handoff', label: '提测', at: '2026-10-16T10:00:00.000Z', allDay: false },
    spend: { costUsd: 36.18, tokens: 316_253_687 },
  }),
  project('3', 'pi-lead-child-e2e', { status: 'archived', counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 17 } }),
  project('unknown', 'unknown', { counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 16 } }),
];

describe('buildProjectCards', () => {
  it('puts projects with open work first, the ones that wait for you on top, and folds the rest', () => {
    const cards = buildProjectCards(overviews, now);
    expect(cards.active.map((card) => card.name)).toEqual(['pi-lead-child', 'Dialogue Returns Business Parity']);
    expect(cards.quiet.map((card) => card.name)).toEqual(['companion-acceptance', '未归属']);
    expect(cards.archived.map((card) => card.name)).toEqual(['pi-lead-child-e2e']);
  });

  it('shows the counts with the ticket tab words, Lead line with its time, the next milestone and the spend', () => {
    const card = buildProjectCards(overviews, now).active[0]!;
    expect(card.legend).toEqual([
      { key: 'user', label: '等你', count: 4 },
      { key: 'running', label: '在执行', count: 1 },
      { key: 'lead', label: 'Paimon', count: 5 },
      { key: 'ended', label: '已结束', count: 8 },
    ]);
    expect(card.leadLine).toEqual({ text: '卡在 #72 的 review 投影；#66 正在重新核查。', when: '15:43 更新' });
    // 阶段 3：最近的节点（任何类型），日期用「明天 18:00」「周日」这样的说法。
    expect(card.nextMilestone).toBe('#72 提测 明天 18:00');
    expect(card.spend).toBe('$36.18');
    expect(card.stale).toBeNull();
  });

  it('says how long a project with open work has been quiet once it is a week or more', () => {
    const card = buildProjectCards(overviews, now).active[1]!;
    expect(card.stale).toBe('27 天没有动静');
    expect(card.spend).toBeNull();
  });

  it('lets you archive a real project but not the tickets without a project', () => {
    const { quiet } = buildProjectCards(overviews, now);
    expect(quiet.map((card) => card.canArchive)).toEqual([true, false]);
  });
});
