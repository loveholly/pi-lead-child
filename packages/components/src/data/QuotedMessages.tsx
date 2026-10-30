import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

export type QuotedMessage = { at: string; text: string };

export type QuotedMessagesProps = {
  sender: string;
  /** 按时间排好，最新的在最后。 */
  messages: readonly QuotedMessage[];
  /** 这次对话里对方一共发了几条。比露出的多时，写出还有几条。 */
  total: number;
  /** latest：只露出最新一条，一行；stack：露出的几条叠在一起。 */
  mode: 'latest' | 'stack';
  /** 头部已经写了发信人（外部消息卡）：不再写名字那一行。 */
  hideSender?: boolean;
  testID?: string;
};

// 别人说的话（genui v3 积木 7，2026-10-27）。原文由系统从外部消息卡取，调用方不能手写。
// 清爽主题：别人说话的气泡是 accent-soft 浅蓝底，左上角 4、其余 14（S-4、R-5），原文用 message-lead（Y-5）；
// 收起成一行、又不止一条时，前面一个「N 条」小标签（surface-muted 灰底、text-strong 字，和状态无关，不上色）。
export function QuotedMessages({ sender, messages, total, mode, hideSender = false, testID }: QuotedMessagesProps) {
  const shown = mode === 'latest' ? messages.slice(-1) : messages;
  const earlier = Math.max(0, total - shown.length);
  return (
    <Column testID={testID} gap="text-stack">
      {hideSender && !(mode === 'stack' && earlier > 0) ? null : (
        <Row items="center" gap="inline-item">
          {hideSender ? null : <Text size="meta" weight="semibold" numberOfLines={1}>{sender}</Text>}
          {mode === 'stack' && earlier > 0 ? <Text size="meta" tone="secondary">{`更早的 ${earlier} 条`}</Text> : null}
        </Row>
      )}
      <Column gap="list-row">
        {shown.map((message, index) => (
          <Row key={index} items="center" gap="inline-item">
            {mode === 'latest' && total > 1 ? (
              <Box testID={testID ? `${testID}-count` : undefined} shrink={0} bg="surface-muted" rounded="full" px="inline-item">
                <Text size="meta" weight="semibold" tone="strong">{`${total} 条`}</Text>
              </Box>
            ) : null}
            <Box
              testID={testID ? `${testID}-bubble-${index}` : undefined}
              flex={1}
              minW={0}
              bg="accent-soft"
              px="inset-x"
              py="inset-y"
              borderTopLeftRadius={4} // 别人说话的气泡（组件规格，R-5）
              borderTopRightRadius={14}
              borderBottomLeftRadius={14}
              borderBottomRightRadius={14}
            >
              <Text size="message-lead" numberOfLines={mode === 'latest' ? 1 : undefined}>{message.text}</Text>
            </Box>
            <Text size="meta" mono tone="secondary" shrink={0}>{clockOf(message.at)}</Text>
          </Row>
        ))}
      </Column>
    </Column>
  );
}

// 气泡右边的时间：本地的时:分。不是 ISO 时间时照原样显示。
function clockOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
