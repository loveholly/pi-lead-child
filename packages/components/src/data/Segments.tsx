import { Box, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { dataToneFill, type DataTone } from './tones';

export type SegmentItem = { label: string; tone?: DataTone };

export type SegmentsProps = {
  items: readonly SegmentItem[];
  /** 跟在格子后面的一句话，例如「4/5 通过」。 */
  summary?: string;
  testID?: string;
};

// 一排小格（genui v3 积木 10，2026-10-27）：每格一个色块和一个标签，表示几个独立的结果。
// 清爽主题：8px 小方块、圆角 2，色调只给方块（A-3）。没给色调的格是中性灰。
const SQUARE = 8;

export function Segments({ items, summary, testID }: SegmentsProps) {
  return (
    <Row testID={testID} items="center" gap="inline-item" flexWrap="wrap">
      {items.map((item, index) => (
        <Row key={index} items="center" gap="icon-label">
          <Box
            testID={testID ? `${testID}-square-${index}` : undefined}
            w={SQUARE}
            h={SQUARE}
            rounded={2} // 小方块的圆角（组件规格，清爽主题）
            bg={item.tone ? dataToneFill(item.tone) : 'text-faint'}
          />
          <Text size="meta" tone="secondary" numberOfLines={1}>{item.label}</Text>
        </Row>
      ))}
      {summary ? <Text size="meta" weight="semibold">{summary}</Text> : null}
    </Row>
  );
}
