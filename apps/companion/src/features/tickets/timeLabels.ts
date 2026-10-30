// 工单详情里所有时间的写法。以前同一页上有 4 种格式（复核 P1-10）：本地化的日期时间、12 小时制的时分、
// 「08-19 17:42」和「2026/8/21 18:48:04」。现在只有这一种：
//   - 今天的只写时分：17:57
//   - 今年更早的带月日：8月21日 18:48
//   - 更早的再带年：2025年12月31日 23:59
// 跨天的记录带日期，不会看起来时间倒流（F17）。

/** 一个时间点。 */
export function timeLabel(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = clockTimeLabel(value);
  if (sameLocalDay(date, now)) return time;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`;
}

/** 一段时间：开始 → 结束。同一天结束的只写结束的时分。 */
export function timeRangeLabel(startedAt: string, endedAt: string | null, now: Date = new Date()): string {
  const start = timeLabel(startedAt, now);
  if (!endedAt) return `${start} → 进行中`;
  const startDate = new Date(startedAt);
  const endDate = new Date(endedAt);
  const end = validDate(startDate) && validDate(endDate) && sameLocalDay(startDate, endDate)
    ? clockTimeLabel(endedAt)
    : timeLabel(endedAt, now);
  return `${start} → ${end}`;
}

/** 几件事跨了几天时只写日期：8月19日–21日、8月30日–9月2日。都在同一天时写那一个时间点。 */
export function dayRangeLabel(startedAt: string, endedAt: string, now: Date = new Date()): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (!validDate(start) || !validDate(end) || sameLocalDay(start, end)) return timeLabel(endedAt, now);
  const year = start.getFullYear() === now.getFullYear() && end.getFullYear() === now.getFullYear()
    ? ''
    : `${start.getFullYear()}年`;
  const startDay = `${start.getMonth() + 1}月${start.getDate()}日`;
  const endDay = start.getFullYear() !== end.getFullYear()
    ? `${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`
    : start.getMonth() === end.getMonth() ? `${end.getDate()}日` : `${end.getMonth() + 1}月${end.getDate()}日`;
  return `${year}${startDay}–${endDay}`;
}

/** 只有时分（24 小时制）。用在日期已经写在分组标题里的行，例如一次 Run 的日志。 */
export function clockTimeLabel(value: string): string {
  const date = new Date(value);
  if (!validDate(date)) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function validDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}
