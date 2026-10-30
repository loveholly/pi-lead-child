// 收件箱的「外部消息」（Slack 代查与按信心代回）：还在等你处理的通道卡按来源分组，结束的卡不列。
import { describe, expect, it } from 'vitest';
import { lookupCard } from '../../../test/channelLookupCards';
import { waitingChannelCardGroups } from './inboxChannelGroups';

describe('the external messages in the inbox', () => {
  it('lists the cards still waiting for the user, grouped by source, newest first', () => {
    const groups = waitingChannelCardGroups([
      lookupCard({ id: 1, state: 'open', updatedAt: '2026-10-20T08:00:00.000Z' }),
      lookupCard({ id: 2, state: 'auto_replied', updatedAt: '2026-10-20T09:00:00.000Z' }),
      lookupCard({ id: 3, state: 'replying_self', updatedAt: '2026-10-20T10:00:00.000Z' }),
      lookupCard({ id: 4, state: 'snoozed', sourceLabel: 'Mail', updatedAt: '2026-10-20T07:00:00.000Z' }),
      lookupCard({ id: 5, state: 'dismissed', updatedAt: '2026-10-20T11:00:00.000Z' }),
    ]);
    expect(groups.map((group) => ({ label: group.label, ids: group.cards.map((card) => card.id) }))).toEqual([
      { label: 'Slack', ids: [3, 1] },
      { label: 'Mail', ids: [4] },
    ]);
  });

  it('has nothing to show when every card is done', () => {
    expect(waitingChannelCardGroups([lookupCard({ id: 1, state: 'replied' }), lookupCard({ id: 2, state: 'resolved_elsewhere' })])).toEqual([]);
  });
});
