import { CHANNEL_CARD_OPEN_STATES, type ChannelCardDto } from '@pi-lead-child/protocol';

// 收件箱「外部消息」的分组规则（InboxChannelCards.tsx 用；单独一个文件，测试不用带上组件）。

export interface ChannelCardGroup {
  label: string;
  cards: ChannelCardDto[];
}

const OPEN_STATES: ReadonlySet<string> = new Set(CHANNEL_CARD_OPEN_STATES);

/** 还在等你处理的卡（没结束的状态），按来源的显示名分组；组和组里的卡都是最近更新的在前。 */
export function waitingChannelCardGroups(cards: readonly ChannelCardDto[]): ChannelCardGroup[] {
  const waiting = cards
    .filter((card) => OPEN_STATES.has(card.state))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const groups = new Map<string, ChannelCardDto[]>();
  for (const card of waiting) {
    const list = groups.get(card.sourceLabel);
    if (list) list.push(card);
    else groups.set(card.sourceLabel, [card]);
  }
  return [...groups].map(([label, list]) => ({ label, cards: list }));
}
