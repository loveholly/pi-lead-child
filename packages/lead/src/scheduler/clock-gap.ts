// 进程停住的时间（工单「夜间挂起风暴」，2026-11-24）。
//
// 那天夜里主人合上了笔记本。Mac 睡 8–17 分钟，醒几秒（DarkWake），再睡。每次醒来，daemon 的轮询看到的墙钟都跳了一大截：
// 就地预算按墙钟算，一轮 0 次工具调用的回合一醒就「就地做了 8 分多钟」，被红线停下；交接窗口（30 秒）在下一次睡眠里
// 过去，单元挂起；挂起的单元又叫醒 Lead 开一轮，这一轮又在睡眠里过了预算……一夜挂起了约 50 个单元。
// 日志里的证据：`[slow-sql] 486011 ms get: SELECT * FROM items WHERE id = ?` 和 `probe.main_lag lateMs=485963`，
// 和 pmset 的 `Entering Sleep state due to 'Maintenance Sleep' … 488 secs` 对得上。
//
// 这里只做一件事：轮询（和交接窗口的定时器）每次被叫到时报一下现在的时间；离上一次超过 thresholdMs，
// 多出来的那一段就是进程没在跑的时间，交给调度器（clock.gap），预算和交接窗口不算它。
// 主线程被同步的活卡住几十秒也会这样算：那段时间 Lead 的这一轮同样没有往前走。

export const LEAD_CLOCK_GAP_MS_ENV = "PLC_LEAD_CLOCK_GAP_MS";
// 轮询缺省 3 秒一拍。超过 30 秒没被叫到，才算停住了：平常的卡顿（几秒）不算。
export const DEFAULT_CLOCK_GAP_MS = 30_000;

export function clockGapThreshold(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_CLOCK_GAP_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLOCK_GAP_MS;
}

export class ClockGapDetector {
  #last: number | null = null;
  readonly #thresholdMs: number;
  readonly #expectedMs: number;

  /** expectedMs：两次报到之间平常隔多久（轮询的间隔）。这一段算醒着的，不从预算里扣。 */
  constructor(options: { thresholdMs?: number; expectedMs: number }) {
    this.#thresholdMs = options.thresholdMs ?? DEFAULT_CLOCK_GAP_MS;
    this.#expectedMs = Math.max(0, options.expectedMs);
  }

  /** 报到一次。返回进程停住了多久（毫秒）；没停住时为 0。时钟往回拨时不算。 */
  observe(now: number): number {
    const last = this.#last;
    if (last === null || now > last) this.#last = now;
    if (last === null) return 0;
    const delta = now - last;
    if (delta < this.#thresholdMs) return 0;
    return Math.max(0, delta - this.#expectedMs);
  }
}
