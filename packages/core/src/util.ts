// 本地墙钟时间 + 时区偏移的 ISO 8601（如 2026-07-21T15:07:45+08:00）。
// 给 lead 注入这个而非 UTC Z——消除"数字是 UTC 还是本地"的歧义，lead 按本地时间直接推算。
// 本机时区 IANA 名（如 "Asia/Shanghai"）——供 cron 按本机时区解析用。
export function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); // 分钟，东八区 = +480
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}
