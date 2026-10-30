// @vitest-environment jsdom
// 2026-10-15 方案 A：发往工单的消息在主会话里只留一行「消息尾巴」，说清这条消息现在在哪：
// 已排队（Run 不能中途接收消息）、已送达在回答、已回答、没送到交给了 Lead（写它的名字）、和下一条一起回答。
import { describe, expect, it, vi } from 'vitest';

import { ticketMessageTail } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('the tail of a ticket message', () => {
  const base = { ticketId: 66, preview: '现在是什么进展', updatedAt: '2026-10-15T10:00:03.000Z', leadName: 'Paimon' };
  it('says where the message is now', () => {
    expect(ticketMessageTail({ ...base, state: 'queued' })).toBe('你在 #66 问了「现在是什么进展」 · Run 不能中途插话 · 已排队，结束后转交');
    expect(ticketMessageTail({ ...base, state: 'streaming' })).toBe('你在 #66 问了「现在是什么进展」 · 已送达 · 正在回答');
    expect(ticketMessageTail({ ...base, state: 'completed' })).toMatch(/^你在 #66 问了「现在是什么进展」 · 已送达 · \d{2}:\d{2} 已回答$/);
    expect(ticketMessageTail({ ...base, state: 'failed' })).toBe('你在 #66 问了「现在是什么进展」 · 没送到 · 已交给 Paimon');
    expect(ticketMessageTail({ ...base, leadName: 'Jarvis', state: 'failed' })).toBe('你在 #66 问了「现在是什么进展」 · 没送到 · 已交给 Jarvis');
    expect(ticketMessageTail({ ...base, state: 'steered' })).toBe('你在 #66 问了「现在是什么进展」 · 和下一条一起回答');
  });

  it('shortens a long message', () => {
    expect(ticketMessageTail({ ...base, preview: '一'.repeat(40), state: 'queued' })).toContain(`「${'一'.repeat(24)}…」`);
  });
});
