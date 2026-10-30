import type { RuntimeEvent, RuntimeEventInput } from "./types.js";
import { outputFrameStart, tagOutputCursor } from "./output-cursor.js";

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed) throw new Error("event queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length) return { value: this.values.shift()!, done: false };
        if (this.failure) throw this.failure;
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

export class RuntimeEventSequencer {
  private seq = 0;
  private terminal = false;
  // 输出游标（工单 14）：最近一次交付的帧的起点，以及这一帧之前最后一个事件的 seq。
  private frameStart: number | null = null;
  private seqBeforeFrame = 0;

  constructor(
    private readonly runId: number,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  event(input: RuntimeEventInput): RuntimeEvent {
    if (this.terminal) throw new Error("runtime already emitted a terminal event");
    if (input.type === "run.completed" || input.type === "run.failed") this.terminal = true;
    const start = outputFrameStart();
    if (start !== null && start !== this.frameStart) {
      this.frameStart = start;
      this.seqBeforeFrame = this.seq;
    }
    const event = {
      ...input,
      runId: this.runId,
      seq: ++this.seq,
      occurredAt: this.now(),
    } as RuntimeEvent;
    if (start !== null) tagOutputCursor(event, { offset: start, seq: this.seqBeforeFrame });
    return event;
  }

  get hasTerminalEvent(): boolean { return this.terminal; }
}
