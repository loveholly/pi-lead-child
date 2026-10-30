// 2026-10-15 画布评论：「依据：Run #87 的 63 条事件」这类标签要有数据支撑，不能靠 agent 发挥。
// 标签由 UI 按这一轮实际调用过的读取工具生成，不由 Lead 写进正文：Lead 的正文可能说错，标签不会。
import { describe, expect, it } from 'vitest';

import type { MessagePart } from '../../state/types';
import { provenanceLabels } from './assistantTurn';

const tool = (id: string, name: string, args: unknown, state: 'completed' | 'failed' | 'running' = 'completed'): MessagePart => ({
  kind: 'tool', id, callId: id, name, state,
  args: { preview: JSON.stringify(args, null, 2), truncated: false, redacted: false, artifactRefs: [] },
  result: null, error: null, startedAt: '2026-10-15T10:00:00.000Z', endedAt: state === 'running' ? null : '2026-10-15T10:00:01.000Z',
  textOffset: 0,
} as unknown as MessagePart);

describe('the provenance of a reply', () => {
  it('names what Lead actually read in this turn', () => {
    expect(provenanceLabels([
      tool('a', 'read_run_events', { run_id: 87 }),
      tool('b', 'get_ticket', { id: 66 }),
      tool('c', 'read_inbox', {}),
      tool('d', 'read_run_events', { run_id: 87, since_seq: 40 }),
    ])).toEqual(['Run #87 的事件', '工单 #66 的账本', '系统通知']);
  });

  it('ignores calls that failed or never finished, tools that change things, and the card itself', () => {
    expect(provenanceLabels([
      tool('a', 'read_run_events', { run_id: 87 }, 'failed'),
      tool('b', 'get_ticket', { id: 66 }, 'running'),
      tool('c', 'add_comment', { id: 66 }),
      tool('d', 'render_ui', {}),
    ])).toEqual([]);
  });
});
