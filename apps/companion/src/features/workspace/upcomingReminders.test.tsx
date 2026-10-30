// @vitest-environment jsdom
// 等待中的提醒（工单 07）：会话里的提醒卡不重复出现，「待你」托盘里列出接下来的几条，带「重要」标记，到点前一直在。
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { WatchTimerDto } from '@pi-lead-child/protocol';

import { renderUI } from '../../../test/render';
import { InboxQueue } from './InboxQueue';
import { sortUpcoming, splitUpcoming, watchReminder, type UpcomingReminder } from './inboxModel';

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('waiting reminders in the tray', () => {
  it('lists the next reminders with their time and the important mark', () => {
    renderUI(
      <InboxQueue
        items={[]}
        inbox={null}
        notices={{ general: [], reminders: [], byTicket: {} }}
        onOpenTicket={() => {}}
        onRunAction={async () => {}}
        upcomingReminders={[
          { id: 5, title: '抢票', at: new Date(2026, 9, 18, 9, 0).toISOString(), important: true },
          { id: 6, title: '交周报', at: new Date(2026, 9, 18, 17, 30).toISOString(), important: false },
        ]}
      />,
    );
    const tray = within(screen.getByTestId('reminder-upcoming'));
    expect(tray.getByText('等待中的提醒')).toBeTruthy();
    const first = within(screen.getByTestId('reminder-upcoming-5'));
    expect(first.getByText('09:00')).toBeTruthy();
    expect(first.getByText('抢票')).toBeTruthy();
    expect(first.getByText('重要')).toBeTruthy();
    expect(within(screen.getByTestId('reminder-upcoming-6')).queryByText('重要')).toBeNull();
  });

  // 外部的人要求设的定时器（统一的消息事件 spec D16，工单 12）：写明是谁要求的；「取消」收在每行右边的「⋯」里。
  // 取消是操作层的 timer.cancel（页面和 Lead 走同一个操作）。
  it('marks a timer someone else asked for, and cancels it from the ⋯ menu', async () => {
    const onCancelTimer = vi.fn(async () => {});
    renderUI(
      <InboxQueue
        items={[]}
        inbox={null}
        notices={{ general: [], reminders: [], byTicket: {} }}
        onOpenTicket={() => {}}
        onRunAction={async () => {}}
        onCancelTimer={onCancelTimer}
        upcomingReminders={[
          { id: 6, title: '交周报', at: new Date(2026, 9, 18, 17, 30).toISOString(), important: false },
          {
            id: 'follow_up:9', timerRef: 'follow_up:9', title: '提醒用户：Sean 把权限开给 Ethan', at: new Date(2026, 9, 18, 9, 0).toISOString(),
            important: false, requester: { name: 'Ethan', sourceLabel: 'Slack' },
          },
        ]}
      />,
    );
    const external = within(screen.getByTestId('reminder-upcoming-follow_up:9'));
    expect(external.getByText('Ethan 要求')).toBeTruthy();
    // 自己的提醒不写来源，也没有「⋯」。
    expect(within(screen.getByTestId('reminder-upcoming-6')).queryByText(/要求/)).toBeNull();
    expect(screen.queryByTestId('reminder-upcoming-6-more')).toBeNull();

    fireEvent.click(screen.getByTestId('reminder-upcoming-follow_up:9-more'));
    const panel = within(await screen.findByTestId('reminder-upcoming-follow_up:9-more-panel'));
    expect(panel.getByText(/Slack 里 Ethan 要求设的/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('reminder-upcoming-follow_up:9-cancel')); });
    expect(onCancelTimer).toHaveBeenCalledWith('follow_up:9');
  });

  it('shows nothing when no reminder is waiting', () => {
    renderUI(
      <InboxQueue items={[]} inbox={null} notices={{ general: [], reminders: [], byTicket: {} }} onOpenTicket={() => {}} onRunAction={async () => {}} />,
    );
    expect(screen.queryByTestId('reminder-upcoming')).toBeNull();
  });
});

// 后台检查（.scratch/lead-watch/spec.md D5）：列在等待中的提醒里，写明谁设的，用户随时可以取消（timer.cancel）。
const watch = (id: number, patch: Partial<WatchTimerDto> = {}): WatchTimerDto => ({
  ref: `watch:${id}`, title: `盯检查 ${id}`, check: 'command', schedule: '每 10 秒查一次，最晚到 10-28 14:38',
  nextAt: new Date(2026, 9, 18, 9, id).toISOString(), running: false, lastStatus: null, lastCheckedAt: null,
  setBy: 'lead', requester: null, ...patch,
});

function renderTray(upcomingReminders: UpcomingReminder[], onCancelTimer = vi.fn(async () => {})) {
  renderUI(
    <InboxQueue
      items={[]}
      inbox={null}
      notices={{ general: [], reminders: [], byTicket: {} }}
      onOpenTicket={() => {}}
      onRunAction={async () => {}}
      onCancelTimer={onCancelTimer}
      upcomingReminders={upcomingReminders}
      leadName="Fairy"
    />,
  );
  return onCancelTimer;
}

describe('background checks in the tray', () => {
  it('shows what it checks, how, who set it and the last result, and cancels it from the ⋯ menu', async () => {
    const onCancelTimer = renderTray([
      watchReminder(watch(3, {
        title: '盯 clime 登录', setBy: 'user', lastStatus: 'fail', lastCheckedAt: new Date(2026, 9, 18, 8, 59).toISOString(),
      })),
    ]);
    const row = within(screen.getByTestId('reminder-upcoming-watch:3'));
    expect(row.getByText('09:03')).toBeTruthy();
    expect(row.getByText('盯 clime 登录')).toBeTruthy();
    expect(row.getByText('每 10 秒查一次，最晚到 10-28 14:38')).toBeTruthy();
    expect(row.getByText('你让 Fairy 设的')).toBeTruthy();
    expect(row.getByText('上次没通过')).toBeTruthy();

    fireEvent.click(screen.getByTestId('reminder-upcoming-watch:3-more'));
    const panel = within(await screen.findByTestId('reminder-upcoming-watch:3-more-panel'));
    expect(panel.getByText('你让 Fairy 设的后台检查')).toBeTruthy();
    expect(panel.getByText('每 10 秒查一次，最晚到 10-28 14:38。上次 08:59 查过，没通过。下次 09:03 查。')).toBeTruthy();
    expect(panel.getByText('不再检查，也不会再叫醒 Fairy')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('reminder-upcoming-watch:3-cancel')); });
    expect(onCancelTimer).toHaveBeenCalledWith('watch:3');
  });

  it('names who set it: Lead, someone outside, or only the source', () => {
    renderTray([
      watchReminder(watch(1, { running: true, nextAt: null })),
      watchReminder(watch(2, { setBy: 'external', requester: { name: 'Ethan', sourceLabel: 'Slack' }, lastStatus: 'pass' })),
      watchReminder(watch(4, { setBy: 'external', requester: { name: '', sourceLabel: 'Slack' }, lastStatus: 'error' })),
    ]);
    const lead = within(screen.getByTestId('reminder-upcoming-watch:1'));
    expect(lead.getByText('Fairy 设的')).toBeTruthy();
    expect(lead.getByText('正在查')).toBeTruthy();
    const ethan = within(screen.getByTestId('reminder-upcoming-watch:2'));
    expect(ethan.getByText('Ethan（Slack）要求的')).toBeTruthy();
    expect(ethan.getByText('上次通过')).toBeTruthy();
    const unnamed = within(screen.getByTestId('reminder-upcoming-watch:4'));
    expect(unnamed.getByText('来自 Slack')).toBeTruthy();
    expect(unnamed.getByText('上次出错')).toBeTruthy();
  });

  // 同时最多 20 个后台检查（spec D5）：卡里只露出 3 个，其余收成一行，点开的浮层里一个一行，也能取消。提醒不受影响。
  it('shows three checks and folds the rest into one row that still cancels them', async () => {
    const onCancelTimer = renderTray([
      { id: 6, title: '交周报', at: new Date(2026, 9, 18, 9, 30).toISOString(), important: false },
      ...[1, 2, 3, 4, 5].map((id) => watchReminder(watch(id))),
    ]);
    for (const id of [1, 2, 3]) expect(screen.getByTestId(`reminder-upcoming-watch:${id}`)).toBeTruthy();
    expect(screen.getByTestId('reminder-upcoming-6')).toBeTruthy();
    expect(screen.queryByTestId('reminder-upcoming-watch:4')).toBeNull();
    expect(within(screen.getByTestId('reminder-upcoming')).getByText('还有 2 个后台检查')).toBeTruthy();

    fireEvent.click(screen.getByTestId('reminder-upcoming-watches-more'));
    const panel = within(await screen.findByTestId('reminder-upcoming-watches-more-panel'));
    expect(panel.getByText('盯检查 4')).toBeTruthy();
    expect(panel.getByText('盯检查 5')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('reminder-upcoming-watch:5-action')); });
    expect(onCancelTimer).toHaveBeenCalledWith('watch:5');
  });
});

describe('the tray order', () => {
  it('puts the next time first and rows without a time last', () => {
    const running = watchReminder(watch(1, { running: true, nextAt: null }));
    const later = watchReminder(watch(2, { nextAt: new Date(2026, 9, 18, 12, 0).toISOString() }));
    const reminder: UpcomingReminder = { id: 6, title: '交周报', at: new Date(2026, 9, 18, 10, 0).toISOString(), important: false };
    expect(sortUpcoming([running, later, reminder]).map((row) => row.id)).toEqual([6, 'watch:2', 'watch:1']);
  });

  it('keeps reminders in place and folds only the checks after the third', () => {
    const rows = [1, 2, 3, 4].map((id) => watchReminder(watch(id)));
    const reminder: UpcomingReminder = { id: 6, title: '交周报', at: null, important: false };
    const { shown, foldedWatches } = splitUpcoming([...rows, reminder]);
    expect(shown.map((row) => row.id)).toEqual(['watch:1', 'watch:2', 'watch:3', 6]);
    expect(foldedWatches.map((row) => row.id)).toEqual(['watch:4']);
  });
});
