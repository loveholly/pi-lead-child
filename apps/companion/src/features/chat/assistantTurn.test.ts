// 一轮助手回复怎么排：工作步骤（工具调用和工具之间说的话）在一张任务卡里，最后一个工具之后的话是回复，
// 放在卡片下面。先后按事件的先后：工具调用记着它开始时回复已经有多少字（textOffset）。
import { describe, expect, it } from 'vitest';

import { LEAD_RESTART_INTERRUPTED_ERROR } from '@pi-lead-child/protocol';

import type { MessagePart } from '../../state/types';
import { buildAssistantTurn } from './assistantTurn';

const MESSAGE = 'session:turn-1:assistant';

function tool(callId: string, textOffset: number, extra: Partial<Extract<MessagePart, { kind: 'tool' }>> = {}): MessagePart {
  return {
    kind: 'tool',
    id: `turn-1:${callId}`,
    callId,
    name: 'query_tickets',
    state: 'completed',
    textOffset,
    args: { preview: `{"stage":"${callId}"}`, truncated: false, redacted: false, artifactRefs: [] },
    result: { preview: '[]', truncated: false, redacted: false, artifactRefs: [] },
    error: null,
    startedAt: '2026-10-13T04:00:01.000Z',
    endedAt: '2026-10-13T04:00:02.000Z',
    ...extra,
  };
}

const text = (value: string): MessagePart => ({ kind: 'text', id: `${MESSAGE}:text`, text: value });

describe('an assistant turn', () => {
  it('puts the narration inside the card and the final reply below it', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'completed',
      text: '我先去查一下。\n\n两种状态下都没有工单。',
      parts: [text(''), tool('review', 7), tool('active', 7)],
    });

    expect(turn.card?.steps.map((step) => step.kind === 'note' ? step.text : step.args)).toEqual([
      '我先去查一下。', '{"stage":"review"}', '{"stage":"active"}',
    ]);
    expect(turn.reply).toBe('两种状态下都没有工单。');
  });

  it('keeps text between two tools inside the card, in order', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'completed',
      text: 'A。B。C。',
      parts: [text(''), tool('one', 2), tool('two', 4)],
    });
    expect(turn.card?.steps.map((step) => step.kind === 'note' ? step.text : step.id))
      .toEqual(['A。', 'turn-1:one', 'B。', 'turn-1:two']);
    expect(turn.reply).toBe('C。');
  });

  it('has no card when the turn used no tools', () => {
    const turn = buildAssistantTurn({ messageId: MESSAGE, messageState: 'completed', text: '好的。', parts: [text('好的。')] });
    expect(turn.card).toBeNull();
    expect(turn.reply).toBe('好的。');
  });

  it('shows a Thinking card before anything arrives', () => {
    const turn = buildAssistantTurn({ messageId: MESSAGE, messageState: 'streaming', text: '', parts: [text('')] });
    expect(turn.card).toMatchObject({ status: 'thinking', steps: [] });
  });

  it('is working while a tool runs, and thinking again once it ends', () => {
    const running = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'streaming',
      text: '',
      parts: [text(''), tool('review', 0), tool('active', 0, { state: 'started', endedAt: null, result: null })],
    });
    expect(running.card?.status).toBe('working');
    const between = buildAssistantTurn({
      messageId: MESSAGE, messageState: 'streaming', text: '', parts: [text(''), tool('review', 0)],
    });
    expect(between.card?.status).toBe('thinking');
  });

  it('fails with the turn, and marks a tool that never ended as not completed', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'failed',
      text: '',
      parts: [text(''), tool('review', 0, { state: 'started', endedAt: null })],
    });
    expect(turn.card?.status).toBe('failed');
    expect(turn.card?.steps[0]).toMatchObject({ kind: 'tool', state: 'stopped' });
  });

  // 被 daemon 重启打断的一轮不是失败（2026-10-16 决定 D3）：Lead 会接着回复，卡片不画成红色的「未完成」。
  it('does not fail the card when a restart interrupted the turn', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'failed',
      failure: { kind: 'turn-error', code: null, message: LEAD_RESTART_INTERRUPTED_ERROR },
      text: '',
      parts: [text(''), tool('reminder', 0, { name: 'create_reminder' })],
    });
    expect(turn.card?.status).toBe('done');
    expect(turn.card?.steps[0]).toMatchObject({ kind: 'tool', state: 'done' });
  });

  // 评审决定：只有还在流的一轮才转圈。结束了的（completed、failed、steered）既不显示 Thinking，
  // 也没有「运行中」的一步。
  it('never shows a spinner or a running step once the turn ended', () => {
    for (const messageState of ['completed', 'failed', 'steered'] as const) {
      const turn = buildAssistantTurn({
        messageId: MESSAGE,
        messageState,
        text: '',
        parts: [text(''), tool('review', 0), tool('active', 0, { state: 'running', endedAt: null, result: null })],
      });
      expect.soft(turn.card?.status, messageState).toBe(messageState === 'failed' ? 'failed' : 'done');
      expect.soft(turn.card?.steps.map((step) => step.kind === 'tool' && step.state), messageState).toEqual(['done', 'stopped']);
    }
    const steeredEmpty = buildAssistantTurn({ messageId: MESSAGE, messageState: 'steered', text: '', parts: [text('')] });
    expect(steeredEmpty.card).toBeNull();
  });

  // 评审决定：结束在工具调用上的一轮，最后一句话作为回复，放在卡片下面。
  it('shows the last note as the reply when a finished turn ended on a tool call', () => {
    const parts = [text(''), tool('one', 2), tool('two', 4)];
    const finished = buildAssistantTurn({ messageId: MESSAGE, messageState: 'completed', text: 'A。B。', parts });
    expect(finished.reply).toBe('B。');
    expect(finished.card?.steps.map((step) => step.kind === 'note' ? step.text : step.id))
      .toEqual(['A。', 'turn-1:one', 'turn-1:two']);

    const streaming = buildAssistantTurn({ messageId: MESSAGE, messageState: 'streaming', text: 'A。B。', parts });
    expect(streaming.reply).toBe('');
    expect(streaming.card?.steps.filter((step) => step.kind === 'note')).toHaveLength(2);
  });

  // 2026-10-16：那一轮从 19:02 跑到 20:14（压缩跑了一个多小时），回合头却写「3 秒」：以前量的是第一个工具开始到
  // 最后一个工具结束。现在量这一轮从开始到结束（spec D9）。
  it('measures the turn from its start to its end, not the span of its tools', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'completed',
      text: '好了。',
      startedAt: '2026-10-16T11:02:00.000Z',
      endedAt: '2026-10-16T12:14:00.000Z',
      parts: [
        text(''),
        tool('a', 0, { startedAt: '2026-10-16T11:02:05.000Z', endedAt: '2026-10-16T11:02:06.000Z' }),
        tool('b', 0, { startedAt: '2026-10-16T11:02:06.000Z', endedAt: '2026-10-16T11:02:08.000Z' }),
      ],
    });
    expect(turn.card?.durationMs).toBe(72 * 60_000);
  });

  it('shows the time since the turn started while it is still running', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'streaming',
      text: '',
      startedAt: '2026-10-16T11:02:00.000Z',
      endedAt: '2026-10-16T11:02:00.000Z',
      now: Date.parse('2026-10-16T11:02:42.000Z'),
      parts: [text(''), tool('a', 0, { state: 'running', endedAt: null })],
    });
    expect(turn.card?.durationMs).toBe(42_000);
  });

  it('has no time when the turn has no start time', () => {
    const turn = buildAssistantTurn({ messageId: MESSAGE, messageState: 'completed', text: '好了。', parts: [text(''), tool('a', 0)] });
    expect(turn.card?.durationMs).toBeNull();
  });

  it('keeps tickets, approvals and artifacts out of the card, in their order', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'completed',
      text: '建好了。',
      parts: [
        text(''),
        tool('create', 0),
        { kind: 'ticket', id: 'turn-1:ticket:9', ticketId: 9 },
        { kind: 'approval', id: 'turn-1:approval:3', approvalId: 3 },
      ],
    });
    expect(turn.attachmentPartIds).toEqual(['turn-1:ticket:9', 'turn-1:approval:3']);
    expect(turn.card?.steps).toHaveLength(1);
  });

  // 2026-10-24 用户反馈：Lead 先画卡、后写字（线上 25 轮里 24 轮），字却画在卡片上面，越写越长，把卡片往下推，页面抖。
  // 卡片按它出现的位置（textOffset）排：之前写的字在上面，之后写的字在下面。页面只在底部长。
  it('places a card where it was drawn in the reply, so streamed text only grows below it', () => {
    const card = (callId: string, textOffset: number): MessagePart => ({
      kind: 'surface', id: `turn-1:surface:${callId}`, callId, textOffset, partial: false,
      surface: { id: `s_${callId}`, catalogVersion: 1, root: 'r', fallbackText: 'x', nodes: [{ id: 'r', type: 'Text', props: { text: 'x' } }] },
    });
    const streaming = (value: string) => buildAssistantTurn({
      messageId: MESSAGE, messageState: 'streaming', text: value, parts: [text(''), card('c1', 0)],
    }).body;
    expect(streaming('')).toEqual([{ kind: 'part', partId: 'turn-1:surface:c1' }]);
    expect(streaming('要我')).toEqual([{ kind: 'part', partId: 'turn-1:surface:c1' }, { kind: 'text', text: '要我' }]);
    expect(streaming('要我删掉吗？')).toEqual([{ kind: 'part', partId: 'turn-1:surface:c1' }, { kind: 'text', text: '要我删掉吗？' }]);

    const mixed = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'completed',
      text: '它不会自动跑。要我删掉吗？',
      parts: [text(''), card('c1', 7), { kind: 'ticket', id: 'turn-1:ticket:9', ticketId: 9 }],
    });
    expect(mixed.body).toEqual([
      { kind: 'text', text: '它不会自动跑。' },
      { kind: 'part', partId: 'turn-1:surface:c1' },
      { kind: 'text', text: '要我删掉吗？' },
    ]);
    expect(mixed.reply).toBe('它不会自动跑。要我删掉吗？');
    expect(mixed.attachmentPartIds).toEqual(['turn-1:ticket:9']);
  });

  it('keeps a tool in place while the streamed text has not caught up with its offset', () => {
    const turn = buildAssistantTurn({
      messageId: MESSAGE,
      messageState: 'streaming',
      text: '我先',
      parts: [text(''), tool('review', 7)],
    });
    expect(turn.card?.steps.map((step) => step.kind)).toEqual(['note', 'tool']);
    expect(turn.reply).toBe('');
  });
});
