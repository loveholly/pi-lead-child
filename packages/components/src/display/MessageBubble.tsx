import { styled, View, type GetProps } from '@tamagui/core';

// 会话里用户自己发的消息：浅灰底的气泡，右下角收成小圆角，指向发送的一侧。
// 里面的文字用主文字色（Text 的 default tone），字号和 Lead 的正文一样。
// 只有用户的消息用气泡。Lead 的回复直接排在白底上，不加气泡或卡片。
// 气泡本身不限宽：放在会话里时由外层给 maxW（例如 70%），右对齐也由外层决定。
export const MessageBubble = styled(View, {
  displayName: 'MessageBubble',
  gap: 8,
  px: 14,
  py: 10,
  bg: 'surface-muted',
  borderTopLeftRadius: 16,
  borderTopRightRadius: 16,
  borderBottomLeftRadius: 16,
  borderBottomRightRadius: 4,
});

export type MessageBubbleProps = GetProps<typeof MessageBubble>;
