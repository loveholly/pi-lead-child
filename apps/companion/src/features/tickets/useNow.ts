import { useEffect, useState } from 'react';

// 现在的时间（毫秒），每隔 intervalMs 更新一次。intervalMs 为 null 时不更新：没有东西在跑时不必走表。
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return undefined;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}
