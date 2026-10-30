// 会话里的日期和时间文字。纯函数：不引 React Native，设置页的模型和它们的 node 环境测试也能用（2026-10-22）。
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 日期分隔线上的字：今天、昨天；更早的写月日和星期，不是今年的再加上年。按本地日历算。
export function formatConversationDate(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const startOf = (moment: Date) => new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

export function formatConversationTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
