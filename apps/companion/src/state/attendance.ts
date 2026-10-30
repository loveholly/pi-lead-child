// companion 的"有人在看"：应用在前台（web 上是标签页可见），并且最近 idleMs 内有过用户操作
// （点按、键盘、触摸、滚动）。开着标签页走开的人不算：daemon 这时不让 lead 播报即时通知，
// 桌面通知照常弹。刚打开应用、切回前台都算一次操作。
import type { PresenceSource } from './runtime';

export interface AttendanceTrackerOptions {
  foreground: boolean;
  idleMs: number;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export class AttendanceTracker implements PresenceSource {
  private foreground: boolean;
  private lastActivity: number;
  private timer: unknown = null;
  private attended: boolean;
  private readonly listeners = new Set<(attended: boolean) => void>();

  constructor(private readonly options: AttendanceTrackerOptions) {
    this.foreground = options.foreground;
    this.lastActivity = options.now();
    this.attended = this.compute();
    this.schedule();
  }

  current(): boolean {
    return this.attended;
  }

  subscribe(listener: (attended: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (foreground) this.lastActivity = this.options.now();
    this.update();
  }

  activity(): void {
    this.lastActivity = this.options.now();
    this.update();
  }

  dispose(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private compute(): boolean {
    return this.foreground && this.options.now() - this.lastActivity < this.options.idleMs;
  }

  private update(): void {
    const next = this.compute();
    this.schedule();
    if (next === this.attended) return;
    this.attended = next;
    for (const listener of this.listeners) listener(next);
  }

  // 到 lastActivity + idleMs 时重新算一次。
  private schedule(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
    if (!this.foreground) return;
    const remaining = this.lastActivity + this.options.idleMs - this.options.now();
    if (remaining <= 0) return;
    this.timer = this.options.setTimer(() => { this.timer = null; this.update(); }, remaining);
  }
}
