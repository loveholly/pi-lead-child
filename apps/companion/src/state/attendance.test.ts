// daemon 只把有人在看的连接算作"有人在听"。companion 的"有人在看"：应用在前台（web 上是标签页可见），
// 并且最近 PRESENCE_IDLE_MS（5 分钟）内有过操作（点按、键盘、触摸、滚动）。开着标签页走开的人不算。
import { PRESENCE_IDLE_MS } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { AttendanceTracker } from './attendance';

function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => { const id = next++; timers.set(id, { at: now + delayMs, callback }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

describe('AttendanceTracker', () => {
  it('counts as attended while in the foreground with recent activity, and stops after the idle time', () => {
    const time = clock();
    const changes: boolean[] = [];
    const tracker = new AttendanceTracker({ foreground: true, idleMs: PRESENCE_IDLE_MS, ...time });
    tracker.subscribe((attended) => changes.push(attended));
    // 刚打开应用算一次操作。
    expect(tracker.current()).toBe(true);
    time.advance(PRESENCE_IDLE_MS - 1);
    expect(tracker.current()).toBe(true);
    time.advance(1);
    expect(tracker.current()).toBe(false);
    expect(changes).toEqual([false]);
    // 回来动一下：马上又算有人在看。
    tracker.activity();
    expect(tracker.current()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('keeps extending while there is activity', () => {
    const time = clock();
    const tracker = new AttendanceTracker({ foreground: true, idleMs: PRESENCE_IDLE_MS, ...time });
    for (let i = 0; i < 4; i += 1) { time.advance(PRESENCE_IDLE_MS - 1_000); tracker.activity(); }
    expect(tracker.current()).toBe(true);
  });

  it('is not attended in the background, whatever the activity', () => {
    const time = clock();
    const changes: boolean[] = [];
    const tracker = new AttendanceTracker({ foreground: true, idleMs: PRESENCE_IDLE_MS, ...time });
    tracker.subscribe((attended) => changes.push(attended));
    tracker.setForeground(false);
    tracker.activity();
    expect(tracker.current()).toBe(false);
    // 切回前台本身就是一次操作。
    tracker.setForeground(true);
    expect(tracker.current()).toBe(true);
    expect(changes).toEqual([false, true]);
  });
});
