import { Box, Row, Text } from '@pi-lead-child/components';

// 会话里的日期分隔线（「今天」「昨天」「10月13日 周二」，见 formatConversationDate）。会话和工单对话共用。
export function ConversationDateDivider({ label }: { label: string }) {
  return (
    // spacing-exempt: 光学对齐
    <Row testID="conversation-date-divider" items="center" gap="icon-label" py={2}>
      <Box flex={1} h={1} bg="border" />
      <Text size="meta" weight="semibold" tone="secondary">{label}</Text>
      <Box flex={1} h={1} bg="border" />
    </Row>
  );
}
