// 2026-10-16 用户要求：「依据：等你处理的工单」「依据：系统通知」这类标签可以点开，看 Lead 这次回答具体依据了什么
// （哪几张工单、哪几条通知、Run 的哪些事件）。来源从这一轮工具调用的参数和结果里取，和标签同一份数据。
import { describe, expect, it } from 'vitest';

import type { MessagePart } from '../../state/types';
import { provenanceSources } from './provenance';

const tool = (id: string, name: string, args: unknown, text: string | null, truncated = false): MessagePart => ({
  kind: 'tool', id, callId: id, name, state: 'completed',
  args: { preview: JSON.stringify(args, null, 2), truncated: false, redacted: false, artifactRefs: [] },
  result: text === null ? null : {
    preview: truncated
      ? JSON.stringify({ content: [{ type: 'text', text }] }, null, 2).slice(0, 120)
      : JSON.stringify({ content: [{ type: 'text', text }] }, null, 2),
    truncated, redacted: false, artifactRefs: [],
  },
  error: null, startedAt: '2026-10-15T10:00:00.000Z', endedAt: '2026-10-15T10:00:01.000Z', textOffset: 0,
} as unknown as MessagePart);

describe('the sources behind a reply', () => {
  it('lists the tickets Lead read, by number', () => {
    expect(provenanceSources([
      tool('a', 'list_needs_user', {}, '需要用户处理的工单共 2 张（和 App 的「需要我」是同一组）：\n#1 [review] 成果快照与登记机制 — 核查未派发\n#66 [blocked] 修复 #72 的回归 — 需介入'),
      tool('b', 'get_ticket', { id: 7 }, '#7 ...'),
    ])).toEqual([
      { label: '等你处理的工单', sources: [{ kind: 'ticket', ticketId: 1 }, { kind: 'ticket', ticketId: 66 }], truncated: false },
      { label: '工单 #7 的账本', sources: [{ kind: 'ticket', ticketId: 7 }], truncated: false },
    ]);
  });

  it('shows the notifications and events as the lines Lead read', () => {
    const [inbox, run] = provenanceSources([
      tool('a', 'read_inbox', { state: 'pending' }, '#12 [attention/structural/pending] 2026-10-15 10:00:00 Run #87 的进展：读完了执行者的交付\n#13 [blocker/structural/delivered] 2026-10-15 10:02:00 交接失败'),
      tool('b', 'read_run_events', { run_id: 49 }, 'Run #49 · 3 条事件\n10:01 运行 npm test\n10:02 失败：EPERM'),
    ]);
    expect(inbox).toEqual({
      label: '系统通知',
      sources: [{ kind: 'line', text: 'Run #87 的进展：读完了执行者的交付' }, { kind: 'line', text: '交接失败' }],
      truncated: false,
    });
    expect(run).toEqual({
      label: 'Run #49 的事件',
      sources: [{ kind: 'run', runId: 49 }, { kind: 'line', text: '10:01 运行 npm test' }, { kind: 'line', text: '10:02 失败：EPERM' }],
      truncated: false,
    });
  });

  it('keeps what it can read from a cut-off result and says it was cut off', () => {
    const [needs] = provenanceSources([
      tool('a', 'list_needs_user', {}, `需要用户处理的工单共 9 张：\n#1 [review] 成果快照与登记机制 — 核查未派发\n${'#9 [ready] x — 待确认\n'.repeat(20)}`, true),
    ]);
    expect(needs!.truncated).toBe(true);
    expect(needs!.sources[0]).toEqual({ kind: 'ticket', ticketId: 1 });
  });

  it('merges calls with the same label, and skips tools that are not reads', () => {
    expect(provenanceSources([
      tool('a', 'get_ticket', { id: 7 }, null),
      tool('b', 'get_ticket', { id: 7 }, null),
      tool('c', 'add_comment', { id: 7 }, 'ok'),
    ])).toEqual([{ label: '工单 #7 的账本', sources: [{ kind: 'ticket', ticketId: 7 }], truncated: false }]);
  });
});
