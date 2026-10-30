import { Column, Row, Text } from '@pi-lead-child/components';
import { ChannelCardSlot } from '../chat/ChannelMessageCard';
import { useControlPlaneStore } from '../../state/CompanionStateProvider';
import { waitingChannelCardGroups } from './inboxChannelGroups';

// 收件箱里的「外部消息」（Slack 代查与按信心代回）：还在等你处理的通道卡，按来源分组。
// 卡和对话里的是同一张（同一个 Slot，同一份 store），在哪里处理都一样。
// 它不算进「需要你」：那个数字在每个界面上和 Lead 的 list_needs_user 是同一条规则（needsUserCount 测试）。

export function InboxChannelCards() {
  const cards = useControlPlaneStore((state) => state.channelCards);
  const groups = waitingChannelCardGroups(cards);
  if (!groups.length) return null;
  return (
    <Column testID="inbox-channel-cards" gap="stacked-card" w="100%" pt="page-section">
      <Row items="center" gap="inline-item" px="section-label-x" pt="section-label-top" pb="section-label-bottom">
        <Text size="eyebrow" weight="extrabold" letterSpacing={0.3} tone="secondary">外部消息</Text>
        <Text size="meta" weight="bold" tone="muted">{String(groups.reduce((total, group) => total + group.cards.length, 0))}</Text>
      </Row>
      {groups.map((group) => (
        <Column key={group.label} gap="group-label" testID={`inbox-channel-group-${group.label}`}>
          <Row px="section-label-x">
            <Text size="eyebrow" weight="bold" tone="muted">{`${group.label} · ${group.cards.length}`}</Text>
          </Row>
          {group.cards.map((card) => <ChannelCardSlot key={card.id} cardId={card.id} />)}
        </Column>
      ))}
    </Column>
  );
}
