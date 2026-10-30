// 工单 06（spec D16）：服务端推送投影的变化，带 entityKey 和 entityVersion，客户端按版本应用，旧版本忽略。
// 推送和快照会乱序到达：启动时那次慢的快照可能比后来的推送晚到；确认横幅的路由回应可能比推送早到。
// 不管顺序怎样，手上留下的都是版本最新的那一份。
import { PROTOCOL_VERSION, type GatewayEvent, type LeadActivityCard, type LeadInterrupt } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { applyControlPlaneMutation } from './actions';
import { reduceGatewayEvent } from './eventReducer';
import {
  applyLeadActivityPush, applyLeadActivitySnapshot, EMPTY_LEAD_ACTIVITY, leadActivityCards, openLeadInterrupts,
} from './leadActivity';
import { adaptGatewayEvent } from './protocolAdapter';
import { createControlPlaneStore } from './store';

function card(overrides: Partial<LeadActivityCard> = {}): LeadActivityCard {
  return {
    key: 'ticket:7@10', entityKey: 'ticket:7', entityVersion: 10, lastSeq: 10,
    at: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z', ticketId: 7,
    kind: 'digest', state: 'open', summary: '第一次重试', count: 1,
    basis: [{ kind: 'order', id: 'run.transient_retry', version: 1 }], lead: null, entries: [],
    ...overrides,
  };
}

function interrupt(overrides: Partial<LeadInterrupt> = {}): LeadInterrupt {
  return {
    key: 'interrupt:20', seq: 20, entityKey: 'reminder:5', entityVersion: 20, lastSeq: 20,
    at: '2026-10-17T01:05:00.000Z', ticketId: 5, kind: 'timer.fired', summary: '提醒「开会」到点', rootCause: null,
    basis: [{ kind: 'order', id: 'reminder.fire', version: 1 }], acknowledgedAt: null, resolvedElsewhere: false,
    ...overrides,
  };
}

describe('applying Lead activity by version', () => {
  it('ignores a snapshot that is older than a push that already arrived', () => {
    const pushed = applyLeadActivityPush(EMPTY_LEAD_ACTIVITY, { card: card({ entityVersion: 13, lastSeq: 12, count: 2, summary: '第二次重试' }) });
    // 推送之前算好的快照，晚到了。
    const stale = applyLeadActivitySnapshot(pushed, { cards: [card()], interrupts: [], watermark: 11 });
    expect(stale.cards['ticket:7@10']).toMatchObject({ entityVersion: 13, summary: '第二次重试' });
    expect(stale).toBe(pushed);
  });

  it('ignores a push that is older than what it has, and takes one with the same version', () => {
    const current = applyLeadActivitySnapshot(EMPTY_LEAD_ACTIVITY, { cards: [card({ entityVersion: 13, summary: '第二次重试' })], interrupts: [], watermark: 13 });
    expect(applyLeadActivityPush(current, { card: card() })).toBe(current);
    // Lead 改口：版本不变，内容变了。
    const changed = applyLeadActivityPush(current, {
      card: card({ entityVersion: 13, summary: '第二次重试', lead: { disposition: 'no_action', reason: '改主意了', at: '2026-10-17T01:10:00.000Z' } }),
    });
    expect(changed.cards['ticket:7@10']!.lead?.reason).toBe('改主意了');
  });

  it('keeps a card the snapshot did not know about yet, and drops one the snapshot left out', () => {
    const fresh = card({ key: 'ticket:8@30', entityKey: 'ticket:8', entityVersion: 30, lastSeq: 30, ticketId: 8 });
    const pushed = applyLeadActivityPush(
      applyLeadActivitySnapshot(EMPTY_LEAD_ACTIVITY, { cards: [card()], interrupts: [], watermark: 10 }),
      { card: fresh },
    );
    // 快照在第 30 条事件之前算的：不认识那张新卡，留着；第 10 条的那张它也不列了（被别处挤出窗口），去掉。
    const older = applyLeadActivitySnapshot(pushed, { cards: [], interrupts: [], watermark: 25 });
    expect(Object.keys(older.cards)).toEqual(['ticket:8@30']);
    // 之后的快照也不列它：真的不在了。
    expect(applyLeadActivitySnapshot(older, { cards: [], interrupts: [], watermark: 31 }).cards).toEqual({});
  });

  it('does not bring back a banner the user already acknowledged when an older snapshot arrives', () => {
    const shown = applyLeadActivitySnapshot(EMPTY_LEAD_ACTIVITY, { cards: [], interrupts: [interrupt()], watermark: 20 });
    expect(openLeadInterrupts(shown).map((item) => item.seq)).toEqual([20]);
    const acked = applyLeadActivityPush(shown, {
      interrupt: interrupt({ entityVersion: 23, lastSeq: 22, acknowledgedAt: '2026-10-17T01:06:00.000Z' }),
    });
    expect(openLeadInterrupts(acked)).toEqual([]);
    // 确认之前算的快照（横幅还开着），晚到了。
    const stale = applyLeadActivitySnapshot(acked, { cards: [], interrupts: [interrupt()], watermark: 21 });
    expect(openLeadInterrupts(stale)).toEqual([]);
    // 确认之后的快照不再列它。
    expect(applyLeadActivitySnapshot(stale, { cards: [], interrupts: [], watermark: 22 }).interrupts).toEqual({});
  });

  it('hides a banner that was resolved elsewhere', () => {
    const shown = applyLeadActivityPush(EMPTY_LEAD_ACTIVITY, { interrupt: interrupt() });
    const resolved = applyLeadActivityPush(shown, { interrupt: interrupt({ entityVersion: 21, resolvedElsewhere: true }) });
    expect(openLeadInterrupts(resolved)).toEqual([]);
  });

  it('orders the cards by where they sit in the conversation', () => {
    const state = applyLeadActivitySnapshot(EMPTY_LEAD_ACTIVITY, {
      cards: [card({ key: 'b@2', at: '2026-10-17T02:00:00.000Z' }), card({ key: 'a@1', at: '2026-10-17T01:00:00.000Z' })],
      interrupts: [], watermark: 2,
    });
    expect(leadActivityCards(state).map((item) => item.key)).toEqual(['a@1', 'b@2']);
  });
});

describe('the push over the event stream', () => {
  let seq = 0;
  function event(payload: Record<string, unknown>): GatewayEvent {
    seq += 1;
    return {
      protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type: 'snapshot.required', occurredAt: '2026-10-17T01:00:00.000Z',
      requiredScope: 'chat', audienceBindingId: null, turnId: null, ticketId: 7, payload,
    };
  }

  function reduce(payload: Record<string, unknown>) {
    const adapted = adaptGatewayEvent(event(payload));
    if (!adapted.ok) throw new Error(adapted.error);
    return reduceGatewayEvent(adapted.event);
  }

  it('applies the card it carries by version, without refetching', () => {
    const store = createControlPlaneStore();
    const newer = card({ entityVersion: 13, summary: '第二次重试' });
    for (const pushed of [newer, card()]) {
      const reduction = reduce({ resource: 'lead-activity', entityKey: 'ticket:7', entityVersion: pushed.entityVersion, card: pushed });
      expect(reduction.invalidations).toEqual([]);
      for (const mutation of reduction.control) applyControlPlaneMutation(store, 'session', mutation);
    }
    expect(store.getState().leadActivity.cards['ticket:7@10']!.summary).toBe('第二次重试');
  });

  it('refetches the conversation when it cannot read the push, instead of refetching everything', () => {
    expect(reduce({ resource: 'lead-activity', entityKey: 'ticket:7', entityVersion: 3, card: { key: 'broken' } })).toMatchObject({
      control: [], invalidations: ['conversation:current'],
    });
  });
});
