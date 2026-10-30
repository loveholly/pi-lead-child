import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { dataToneFill, dataToneText, type DataTone } from './tones';

export type TimelineItem = {
  /** 时间，照原样显示，例如「09:58」。 */
  at: string;
  text: string;
  tone?: DataTone;
};

export type TimelineProps = {
  items: readonly TimelineItem[];
  /**
   * regular：聊天卡片里的时间线，左边一列圆点用细线连起来，时间写在事情上面。
   * compact：工单详情的「经过」（第四轮画板），每件事一行，左边一列时间。
   */
  variant?: 'regular' | 'compact';
  testID?: string;
};

// 按给的顺序排的一串事情。
export function Timeline({ items, variant = 'regular', testID }: TimelineProps) {
  if (variant === 'compact') {
    return (
      <Column testID={testID}>
        {items.map((item, index) => (
          <Row key={index} items="baseline" gap="inline-item" py="row-y">
            <Text w={38} shrink={0} size="meta" mono tone="secondary">{item.at}</Text>
            <Text flex={1} minW={0} size="body" tone={item.tone ? dataToneText[item.tone] : 'default'}>{item.text}</Text>
          </Row>
        ))}
      </Column>
    );
  }
  return (
    <Column testID={testID}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <Row key={index} gap="timeline" items="stretch">
            {/* spacing-exempt: 光学对齐 */}
            <Column w={12} items="center" pt={5} shrink={0}>
              <Box w={8} h={8} rounded="full" bg={item.tone ? dataToneFill(item.tone) : 'text-muted'} />
              {/* spacing-exempt: 轨道线和标记的间隙 */}
              {last ? null : <Box flex={1} w={1} minH={8} mt={4} bg="border" />}
            </Column>
            <Column flex={1} minW={0} gap="text-stack" pb={last ? 0 : 12}>
              <Text size="meta" mono tone="secondary">{item.at}</Text>
              <Text size="body" tone={item.tone ? dataToneText[item.tone] : 'default'}>{item.text}</Text>
            </Column>
          </Row>
        );
      })}
    </Column>
  );
}
