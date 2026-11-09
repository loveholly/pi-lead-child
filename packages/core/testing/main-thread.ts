// 主线程被同步代码占住的最长一段（lead-scheduler P0b 的回归测试用）。
//
// 只看定时器之间的墙上时间不可靠：机器忙的时候进程被抢占，定时器照样会晚很久（本机 8 个核跑满时，
// 一次 mkdirSync 都要 6–28 毫秒）。所以每两次触发之间，看主线程自己用掉了多少 CPU（process.threadCpuUsage
// 只算调用它的线程）：同步代码占住主线程时，CPU 时间接近墙上时间；进程被抢占、在等异步 I/O 时，CPU 时间很少。
// 垃圾回收也算在主线程的 CPU 里，但它是测试进程自己的（vitest 的进程里装着几百 MB 的模块），不是被测的代码，所以扣掉。
//
// 测试断言 maxBusyMs。另外两个数写进失败信息，帮着看清楚：
//   · maxActiveMs：事件循环不在空闲等待的时间（performance.eventLoopUtilization），包括同步系统调用里等磁盘、被抢占；
//   · maxGapMs：墙上时间。
import { performance, PerformanceObserver, type EventLoopUtilization } from "node:perf_hooks";

export interface MainThreadBusy {
  // 相邻两次定时器触发之间，主线程用掉的 CPU 时间（扣掉垃圾回收），取最长的一段（毫秒）。
  maxBusyMs: number;
  // 相邻两次触发之间，事件循环不在空闲等待的时间（扣掉垃圾回收），取最长的一段（毫秒）。
  maxActiveMs: number;
  // 相邻两次触发之间的墙上时间，取最长的一段（毫秒）。
  maxGapMs: number;
  // 这期间最长的一次垃圾回收（毫秒）。
  maxGcMs: number;
}

interface Span {
  start: number;
  end: number;
  cpu: number;
  active: number;
}

function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1_000;
}

export function mainThreadBusyMonitor(intervalMs = 2): { stop(): MainThreadBusy } {
  const spans: Span[] = [];
  const gcs: Array<{ start: number; end: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcs.push({ start: entry.startTime, end: entry.startTime + entry.duration });
  });
  observer.observe({ entryTypes: ["gc"] });
  let lastWall = performance.now();
  let lastCpu = threadCpuMs();
  let lastLoop: EventLoopUtilization = performance.eventLoopUtilization();
  const sample = () => {
    const wall = performance.now();
    const cpu = threadCpuMs();
    const loop = performance.eventLoopUtilization();
    spans.push({ start: lastWall, end: wall, cpu: cpu - lastCpu, active: performance.eventLoopUtilization(loop, lastLoop).active });
    lastWall = wall;
    lastCpu = cpu;
    lastLoop = loop;
  };
  const timer = setInterval(sample, intervalMs);
  return {
    stop() {
      sample();
      clearInterval(timer);
      for (const entry of observer.takeRecords()) gcs.push({ start: entry.startTime, end: entry.startTime + entry.duration });
      observer.disconnect();
      const result: MainThreadBusy = { maxBusyMs: 0, maxActiveMs: 0, maxGapMs: 0, maxGcMs: 0 };
      for (const span of spans) {
        const gc = gcs.reduce((sum, entry) => sum + Math.max(0, Math.min(span.end, entry.end) - Math.max(span.start, entry.start)), 0);
        result.maxBusyMs = Math.max(result.maxBusyMs, span.cpu - gc);
        result.maxActiveMs = Math.max(result.maxActiveMs, span.active - gc);
        result.maxGapMs = Math.max(result.maxGapMs, span.end - span.start);
      }
      result.maxGcMs = gcs.reduce((max, entry) => Math.max(max, entry.end - entry.start), 0);
      for (const key of Object.keys(result) as Array<keyof MainThreadBusy>) result[key] = Math.round(result[key]);
      return result;
    },
  };
}
