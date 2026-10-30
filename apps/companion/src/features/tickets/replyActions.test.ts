// 回归（复核 P1-9）：#66 的回复问「你要我现在就发起这次独立核查吗？」，按钮却在决策卡上。
// 2026-10-19：回复在问哪几个动作由 daemon 的快模型判断（不再用关键词表和问号）。这里是决策点：
// 显示的按钮 = 模型说在问的动作 ∩ 工单现在能做的动作。
import { describe, expect, it } from 'vitest';

import { replyActionButtons } from './replyActions';
import type { TicketOptionId } from './ticketState';

// #66 在 review、等核查时决策卡上的动作（ticketStatePresentation）。
const OPTIONS: { id: TicketOptionId }[] = [{ id: 'request_review' }, { id: 'complete' }, { id: 'cancel' }];

describe('buttons under a reply', () => {
  it('offers the asked actions that the ticket can take now, in the order of the options', () => {
    expect(replyActionButtons(['complete', 'request_review'], OPTIONS).map((option) => option.id))
      .toEqual(['request_review', 'complete']);
  });

  it('never makes up an action the ticket cannot take now', () => {
    expect(replyActionButtons(['rework', 'restore'], OPTIONS)).toEqual([]);
    expect(replyActionButtons(['rework'], [{ id: 'rework' as const }])).toEqual([{ id: 'rework' }]);
  });

  it('offers nothing when the model was not asked, failed, or found no question', () => {
    expect(replyActionButtons(undefined, OPTIONS)).toEqual([]);
    expect(replyActionButtons(null, OPTIONS)).toEqual([]);
    expect(replyActionButtons([], OPTIONS)).toEqual([]);
  });
});
