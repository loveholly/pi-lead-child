// 会话搜索里不碰界面的部分（工单 #339）：命中的消息在哪一行、上一条下一条循环、发送者。
import { describe, expect, it } from 'vitest';

import { cycleIndex, rowKeyForTurn, senderKind } from './conversationSearch';

const messages = {
  u1: { role: 'user', turnId: 't1' },
  a1: { role: 'assistant', turnId: 't1' },
  a2: { role: 'assistant', turnId: 't2' },
  f1: { role: 'assistant', turnId: 't3' },
};
const rows = [
  { kind: 'message', key: 'message:u1', messageId: 'u1' },
  { kind: 'message', key: 'message:a1', messageId: 'a1' },
  { kind: 'date', key: 'date:x' },
  { kind: 'message', key: 'message:a2', messageId: 'a2' },
  { kind: 'failure-group', key: 'failures:f1', messageIds: ['f1'] },
  { kind: 'ticket-direct', key: 'ticket-direct:t4', turnId: 't4' },
];

describe('rowKeyForTurn', () => {
  it('finds the row of the same side of the turn', () => {
    expect(rowKeyForTurn(rows, messages, { turnId: 't1', role: 'user' })).toBe('message:u1');
    expect(rowKeyForTurn(rows, messages, { turnId: 't1', role: 'assistant' })).toBe('message:a1');
  });

  it('falls back to another message of the turn, then to a merged group', () => {
    expect(rowKeyForTurn(rows, messages, { turnId: 't2', role: 'user' })).toBe('message:a2');
    expect(rowKeyForTurn(rows, messages, { turnId: 't3', role: 'assistant' })).toBe('failures:f1');
    expect(rowKeyForTurn(rows, messages, { turnId: 't4', role: 'user' })).toBe('ticket-direct:t4');
  });

  it('returns null when the turn has no row', () => {
    expect(rowKeyForTurn(rows, messages, { turnId: 'gone', role: 'user' })).toBeNull();
  });
});

describe('cycleIndex', () => {
  it('wraps at both ends', () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 3, 1)).toBe(1);
  });

  it('starts at the first on next and at the last on previous', () => {
    expect(cycleIndex(-1, 4, 1)).toBe(0);
    expect(cycleIndex(-1, 4, -1)).toBe(3);
  });

  it('has nothing to select when there are no matches', () => {
    expect(cycleIndex(-1, 0, 1)).toBe(-1);
  });
});

describe('senderKind', () => {
  it('tells your own messages, other people and the answers apart', () => {
    expect(senderKind({ role: 'user', originKind: 'paired:companion' })).toBe('you');
    expect(senderKind({ role: 'user', originKind: 'slack:dm' })).toBe('other');
    expect(senderKind({ role: 'assistant', originKind: 'paired:companion' })).toBe('lead');
  });
});
