import { describe, expect, it } from 'vitest';

import { clockTimeLabel, dayRangeLabel, timeLabel, timeRangeLabel } from './timeLabels';

const now = new Date('2026-10-13T10:00:00');

describe('ticket detail time labels', () => {
  it('writes one format: the time today, the date this year, and the year before that', () => {
    expect(timeLabel('2026-10-13T08:05:00', now)).toBe('08:05');
    expect(timeLabel('2026-08-19T17:42:00', now)).toBe('8月19日 17:42');
    expect(timeLabel('2025-12-31T23:59:00', now)).toBe('2025年12月31日 23:59');
    expect(timeLabel('not a date', now)).toBe('');
  });

  it('writes a range with the end date only when it is on another day', () => {
    expect(timeRangeLabel('2026-08-21T18:27:45', '2026-08-21T18:48:04', now)).toBe('8月21日 18:27 → 18:48');
    expect(timeRangeLabel('2026-08-21T23:50:00', '2026-08-22T00:10:00', now)).toBe('8月21日 23:50 → 8月22日 00:10');
    expect(timeRangeLabel('2026-10-13T09:00:00', null, now)).toBe('09:00 → 进行中');
  });

  it('writes the days that a group of events spans', () => {
    expect(dayRangeLabel('2026-08-19T17:42:00', '2026-08-21T17:17:00', now)).toBe('8月19日–21日');
    expect(dayRangeLabel('2026-08-30T10:00:00', '2026-09-02T10:00:00', now)).toBe('8月30日–9月2日');
    expect(dayRangeLabel('2025-12-30T10:00:00', '2026-01-02T10:00:00', now)).toBe('2025年12月30日–2026年1月2日');
    expect(dayRangeLabel('2026-08-21T16:10:00', '2026-08-21T17:17:00', now)).toBe('8月21日 17:17');
  });

  it('writes the clock time in 24 hours', () => {
    expect(clockTimeLabel('2026-08-19T07:05:00')).toBe('07:05');
    expect(clockTimeLabel('2026-08-19T19:05:00')).toBe('19:05');
  });
});
