import { Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { formatNumber } from './format';
import { dataToneText, type DataTone } from './tones';

export type StatItem = {
  label: string;
  value: number | string;
  unit?: string;
  /** 数值下面的一句变化说明，例如「比上周多 4 张」。 */
  change?: string;
  /** 变化说明的颜色。不给时是次要文字色。 */
  tone?: DataTone;
};

export type StatsProps = {
  items: readonly StatItem[];
  /**
   * regular：聊天卡片里的指标块，大号数字，每块至少 132 宽，放不下时换行。
   * compact：工单详情里的用量（第四轮画板），16 号数字，几块平分一行。
   */
  variant?: 'regular' | 'compact';
  testID?: string;
};

// 一行指标块。数字照原样显示：调用方给的是快照还是实时值，组件不管。
export function Stats({ items, variant = 'regular', testID }: StatsProps) {
  if (variant === 'compact') {
    return (
      // spacing-exempt: 紧凑指标块间距
      <Row testID={testID} gap={8}>
        {items.map((item, index) => (
          <Column key={index} flex={1} minW={0} px="inset-x" py="inset-y" rounded="lg" bg="surface-subtle" gap="text-stack">
            <Text size="label" weight="bold" tone="secondary" numberOfLines={1}>{item.label}</Text>
            <Row items="baseline" gap="inline-item" flexWrap="wrap">
              <Text size="stat-value" weight="extrabold">{statValue(item.value)}</Text>
              {item.unit ? <Text size="meta" tone="secondary">{item.unit}</Text> : null}
            </Row>
            {item.change ? (
              <Text size="meta" tone={item.tone ? dataToneText[item.tone] : 'secondary'}>{item.change}</Text>
            ) : null}
          </Column>
        ))}
      </Row>
    );
  }
  // 每块至少 132 宽，放不下时换行；最后一行的块会拉宽，铺满这一行。
  return (
    // spacing-exempt: 指标块间距
    <Row testID={testID} flexWrap="wrap" gap={10}>
      {items.map((item, index) => (
        <Column key={index} grow={1} flexBasis={132} minW={132} px="inset-x" py="inset-y" rounded="lg" bg="surface-subtle" gap="text-stack">
          <Text size="label" tone="secondary" numberOfLines={1}>{item.label}</Text>
          <Row items="baseline" gap="inline-item" flexWrap="wrap">
            <Text size="numeric" weight="bold">{statValue(item.value)}</Text>
            {item.unit ? <Text size="meta" tone="secondary">{item.unit}</Text> : null}
          </Row>
          {item.change ? (
            <Text size="meta" tone={item.tone ? dataToneText[item.tone] : 'secondary'}>{item.change}</Text>
          ) : null}
        </Column>
      ))}
    </Row>
  );
}

function statValue(value: number | string): string {
  return typeof value === 'number' ? formatNumber(value) : value;
}
