// @vitest-environment happy-dom
// 日程 tab（左栏改版阶段 3）。以前日程只有截止和提醒，一张工单只能有一个截止，也不知道日期是谁定的；
// 过期的东西要点到那一天才看得到。现在：顶部一句话（Lead 今天写的，或者同样事实的文案），
// 已过期在上面，然后今天、明天、之后；节点带类型和出处，节点临近而工单阻塞时标出风险，可以一键改期。
import type { TimelineEntry, TimelineResponse } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { buildTimelineView, parseMilestoneInput } from './timelineModel';
import Workbench from './Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// 2026-10-15 周四 15:46（本地 +08:00）。
const now = new Date('2026-10-15T07:46:00.000Z');

function entry(id: string, overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    id, kind: 'milestone', at: '2026-10-15T10:00:00.000Z', allDay: false, title: id, ticketId: null, project: null,
    status: 'upcoming', risk: null, editable: false, ...overrides,
  };
}

const provenance = (actor: 'lead' | 'user' | 'system', quote: string | null = null) => ({
  actor, runId: null, turnId: null, quote, confidence: actor === 'lead' ? 'high' as const : null, at: '2026-10-14T09:00:00.000Z',
});

const timeline: TimelineResponse = {
  entries: [
    entry('fire:41', { kind: 'routine_fired', at: '2026-10-15T01:00:00.000Z', title: '每日站会摘要', status: 'done', detail: '已执行 · 生成 #85', ticketId: 85 }),
    entry('reminder:90', { kind: 'reminder', at: '2026-10-15T08:30:00.000Z', title: '周会前看 #66 的核查结论', ticketId: 90 }),
    entry('milestone:12', {
      at: '2026-10-16T10:00:00.000Z', title: 'review 状态投影', ticketId: 72, editable: true,
      milestone: { id: 12, kind: 'test_handoff', label: '提测', state: 'planned' },
      provenance: provenance('lead', '明天下午六点提测'),
      risk: { reason: 'ticket_blocked', label: '工单还阻塞' },
    }),
    entry('milestone:13', {
      at: '2026-10-20T02:00:00.000Z', title: 'Dialogue Returns 业务等价迁移', ticketId: 18, editable: true,
      milestone: { id: 13, kind: 'release', label: '发布', state: 'planned' }, provenance: provenance('user'),
    }),
  ],
  overdue: [
    entry('milestone:11', {
      at: '2026-10-13T10:00:00.000Z', title: '成果快照与登记机制', ticketId: 66, editable: true, status: 'overdue',
      milestone: { id: 11, kind: 'due', label: '截止', state: 'planned' }, provenance: provenance('system'),
    }),
    entry('reminder:17', { kind: 'reminder', at: '2026-07-29T01:00:00.000Z', title: 'Working Session 会议', ticketId: 17, status: 'unacked' }),
  ],
  generatedAt: now.toISOString(),
  leadNote: null,
};

describe('buildTimelineView', () => {
  // 实机截图（2026-10-15）：「之后」只写时刻不写日期，看不出是哪天。之后的每一天各成一节。
  it('lists today, tomorrow and each later day, with the kind of each date and who set it', () => {
    const view = buildTimelineView(timeline, now);
    expect(view.sections.map((section) => section.label)).toEqual(['Today · Thu 15', 'Tomorrow · Fri 16', 'Tue · 10/20']);
    expect(view.sections[1]!.rows[0]).toMatchObject({ tag: { label: '提测' }, sub: 'Noted by Paimon' });
  });

  it('writes the agenda in Chinese when the interface language is Chinese', () => {
    const view = buildTimelineView(timeline, now, undefined, 'zh');
    expect(view.sections.map((section) => [section.label, section.rows.map((row) => row.id)])).toEqual([
      ['今天 · 周四 15', ['fire:41', 'reminder:90']],
      ['明天 · 周五 16', ['milestone:12']],
      ['周二 · 10/20', ['milestone:13']],
    ]);
    const handoff = view.sections[1]!.rows[0]!;
    expect(handoff).toMatchObject({
      time: '18:00', tag: { label: '提测', tone: 'warning' }, title: '#72 review 状态投影', sub: 'Paimon 记下', risk: '工单还阻塞',
    });
    // 提醒不显示内部编号；例行任务写触发的结果。
    expect(view.sections[0]!.rows.map((row) => [row.title, row.sub])).toEqual([
      ['每日站会摘要', '已执行 · 生成 #85'],
      ['周会前看 #66 的核查结论', null],
    ]);
  });

  it('puts overdue items on top with their date and how long ago', () => {
    const view = buildTimelineView(timeline, now);
    expect(view.overdue.map((row) => [row.time, row.title, row.sub])).toEqual([
      ['10/13', '#66 成果快照与登记机制', 'Overdue by 1 day · Original due date'],
      ['7/29', 'Working Session 会议', 'Fired, not acknowledged'],
    ]);
  });

  it('writes the same facts as a sentence when Lead has not written one today', () => {
    expect(buildTimelineView(timeline, now).note).toEqual({
      text: '1 item left today: 16:30 周会前看 #66 的核查结论. Tomorrow 18:00 #72 提测: 工单还阻塞. 2 more items are overdue.',
      when: null,
      byLead: false,
    });
    const written = { ...timeline, leadNote: { text: '今天还剩 1 件：16:30 看 #66 的核查结论。', at: '2026-10-15T07:30:00.000Z' } };
    expect(buildTimelineView(written, now).note).toEqual({ text: '今天还剩 1 件：16:30 看 #66 的核查结论。', when: 'Updated 15:30', byLead: true });
    // 昨天写的不算：显示今天的事实。
    const stale = { ...timeline, leadNote: { text: '昨天的话', at: '2026-10-14T07:30:00.000Z' } };
    expect(buildTimelineView(stale, now).note.byLead).toBe(false);
  });

  // 实机截图（2026-10-15）：工作日的例行任务在「之后」里列了 12 行，把节点挤下去了。之后的例行任务每个只列一次。
  it('lists a routine once under later, with how many more times it runs', () => {
    const routine = (at: string) => entry(`routine:3:${at}`, { kind: 'routine', at, title: '每日站会摘要', detail: '汇总昨天的进展' });
    const withRoutines = {
      ...timeline,
      entries: [...timeline.entries, routine('2026-10-16T01:00:00.000Z'), routine('2026-10-19T01:00:00.000Z'),
        routine('2026-10-20T01:00:00.000Z'), routine('2026-10-21T01:00:00.000Z')],
    };
    const view = buildTimelineView(withRoutines, now);
    expect(view.sections[1]!.rows.map((row) => row.id)).toContain('routine:3:2026-10-16T01:00:00.000Z');
    const later = view.sections.slice(2).flatMap((section) => section.rows).filter((row) => row.title === '每日站会摘要');
    expect(later.map((row) => [row.id, row.sub])).toEqual([
      ['routine:3:2026-10-19T01:00:00.000Z', '汇总昨天的进展 · 2 more times'],
    ]);
  });

  it('shows one day when you pick it in the week strip', () => {
    const view = buildTimelineView(timeline, now, '2026-10-20');
    expect(view.sections.map((section) => [section.label, section.rows.map((row) => row.id)])).toEqual([['Tue 20', ['milestone:13']]]);
    expect(buildTimelineView(timeline, now, '2026-10-20', 'zh').sections[0]!.label).toBe('周二 20日');
  });
});

describe('calendar entries in the agenda', () => {
  const calendar = (overrides: Partial<NonNullable<TimelineEntry['external']>>, status: TimelineEntry['status'] = 'upcoming') => entry('external:3', {
    kind: 'external', at: '2026-10-15T09:00:00.000Z', title: 'Planning', status,
    external: {
      feed: 'work', feedLabel: 'Work calendar', entryId: 3, endsAt: null, location: null, url: null, status: 'confirmed', muted: false,
      reminder: null, ...overrides,
    },
  });
  const rowOf = (value: TimelineEntry) => buildTimelineView({ ...timeline, entries: [value], overdue: [] }, now).sections[0]!.rows[0]!;

  it('says whether a calendar entry reminds you, and lets you mute it only before it starts', () => {
    expect(rowOf(calendar({ muted: true }))).toMatchObject({ sub: 'No reminder for this one', external: { entryId: 3, muted: true, canToggle: true } });
    expect(rowOf(calendar({ status: 'cancelled' }))).toMatchObject({ sub: 'Cancelled in the calendar', muted: true, external: { canToggle: false } });
    expect(rowOf(calendar({ reminder: { id: 9, at: '2026-10-15T08:55:00.000Z', level: 'tell', stage: 'acked' } }, 'done')))
      .toMatchObject({ sub: 'Reminded', external: { canToggle: false } });
    expect(rowOf(calendar({}))).toMatchObject({ tag: { label: 'Calendar' }, opensTicket: false, sub: 'No reminder', external: { canToggle: false } });
    expect(rowOf(calendar({ reminder: { id: 9, at: '2026-10-15T08:55:00.000Z', level: 'interrupt', stage: 'scheduled' } })))
      .toMatchObject({ external: { canToggle: true } });
  });
});

describe('parseMilestoneInput', () => {
  it('reads a local date and time, and keeps the time when only the date changes', () => {
    expect(parseMilestoneInput('10/17 18:00', '2026-10-16T10:00:00.000Z', now)).toBe('2026-10-17T10:00:00.000Z');
    expect(parseMilestoneInput('2026-10-18', '2026-10-16T10:00:00.000Z', now)).toBe('2026-10-18T10:00:00.000Z');
    expect(parseMilestoneInput('10/32 18:00', '2026-10-16T10:00:00.000Z', now)).toBeNull();
    expect(parseMilestoneInput('明天', '2026-10-16T10:00:00.000Z', now)).toBeNull();
  });
});

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

describe('the agenda tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    setWidth(1280);
  });
  afterEach(() => {
    vi.useRealTimers();
    setWidth(0);
  });

  function render() {
    const client = {
      getTimeline: vi.fn(async () => timeline),
      updateMilestone: vi.fn(async () => ({})),
      getTickets: vi.fn(async () => []),
    };
    const runtime = createCompanionStateRuntime({
      client: client as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => now.getTime() },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceTimeline(timeline);
    runtime.workspace.setState({ hydrated: true });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('agenda'));
    return { client };
  }

  it('shows the sentence, the overdue items on top, and the risk next to a date', () => {
    render();
    expect(within(screen.getByTestId('agenda-note')).getByText(/1 item left today/)).toBeTruthy();
    const overdue = screen.getByTestId('agenda-overdue');
    expect(within(overdue).getByText('#66 成果快照与登记机制')).toBeTruthy();
    expect(within(screen.getByTestId('agenda-row-milestone:12')).getByText('工单还阻塞')).toBeTruthy();
  });

  it('moves a date in one step', () => {
    const { client } = render();
    const row = screen.getByTestId('agenda-row-milestone:12');
    fireEvent.click(within(row).getByTestId('agenda-edit-milestone:12'));
    const input = within(row).getByRole('textbox');
    expect((input as HTMLInputElement).value).toBe('10/16 18:00');
    fireEvent.change(input, { target: { value: '10/17 18:00' } });
    fireEvent.click(within(row).getByTestId('agenda-edit-save-milestone:12'));
    expect(client.updateMilestone).toHaveBeenCalledWith(12, { at: '2026-10-17T10:00:00.000Z' });
  });

  it('mutes the reminder of a calendar entry from its row', async () => {
    const withCalendar: TimelineResponse = {
      ...timeline,
      entries: [...timeline.entries, entry('external:7', {
        kind: 'external', at: '2026-10-15T09:00:00.000Z', title: 'Design review',
        external: {
          feed: 'work', feedLabel: 'Work calendar', entryId: 7, endsAt: null, location: 'Room 4', url: null,
          status: 'confirmed', muted: false,
          reminder: { id: 91, at: '2026-10-15T08:55:00.000Z', level: 'interrupt', stage: 'scheduled' },
        },
      })],
    };
    const client = {
      getTimeline: vi.fn(async () => withCalendar),
      updateMilestone: vi.fn(async () => ({})),
      getTickets: vi.fn(async () => []),
      performUiAction: vi.fn(async () => ({ result: null })),
    };
    const runtime = createCompanionStateRuntime({
      client: client as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => now.getTime() },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceTimeline(withCalendar);
    runtime.workspace.setState({ hydrated: true });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('agenda'));

    const row = screen.getByTestId('agenda-row-external:7');
    expect(within(row).getByText('Calendar')).toBeTruthy();
    expect(within(row).getByText(/Reminds at \d\d:55 · Important · Room 4/)).toBeTruthy();
    await act(async () => { fireEvent.click(within(row).getByTestId('agenda-mute-external:7')); });
    expect(client.performUiAction).toHaveBeenCalledWith('agenda_entry', '7', 'update', { input: { muted: true } });
  });
});

