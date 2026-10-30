// 输出游标（spec D7，工单 14）。spec 说"把字节偏移存成事件游标"。
// 这里把 output.jsonl 的字节偏移和事件的 seq 配成一对，存进 runs.output_cursor。
// runs.event_cursor 不变，它仍然是最后落库的事件的 seq。
// 工单 15 重启后从输出游标处续读：把 offset 处的那一帧重新交给 adapter，sequencer 从 seq 接着编号。
// 重新产生的事件和已经落库的事件 seq 相同，INSERT OR IGNORE 和 manager 的 event_cursor 会跳过它们。
//
// 做法：launcher 同步交付一帧时，记下这一帧的起始偏移。adapter 在 data 事件里同步产生的事件，
// 由 RuntimeEventSequencer 打上标记：{ offset: 这一帧的起点, seq: 这一帧之前最后一个事件的 seq }。
// 游标只在带标记的事件落库后前进，所以它不会超前于落库的事件。
// 限制：不在交付过程中产生的事件没有标记，例如 pi 的 RPC 回包之后异步发出的事件。
// 续读时 adapter 的状态是新的，这类事件不一定再产生，后面事件的 seq 会错位。续读 pi 之前要先处理这一点。
export interface OutputCursor {
  offset: number;
  seq: number;
}

let frameStart: number | null = null;

// launcher 交付一帧时调用。deliver 必须同步把这一帧交给 adapter。
export function deliverOutputFrame(start: number, deliver: () => void): void {
  const previous = frameStart;
  frameStart = start;
  try {
    deliver();
  } finally {
    frameStart = previous;
  }
}

// 正在交付的帧的起始偏移。不在交付过程中时为 null。
export function outputFrameStart(): number | null {
  return frameStart;
}

const cursors = new WeakMap<object, OutputCursor>();

export function tagOutputCursor(event: object, cursor: OutputCursor): void {
  cursors.set(event, cursor);
}

// 落库这个事件之后可以存下的游标。没有标记时返回 undefined。
export function outputCursorOf(event: object): OutputCursor | undefined {
  return cursors.get(event);
}
