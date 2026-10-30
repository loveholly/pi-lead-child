import type { MessagePart } from '../../state/types';

// 助手消息有没有可显示的内容。工单对话（TicketThread）和 lead 对话（LeadConversation）共用这一条规则。
// normalize 给每一轮都建一个文本部分。这一轮失败、一个字也没说时，它也在，只是空的。
// 所以空文本不算内容，文本以外的部分（工具、工单卡片、审批……）都算。
// 旧的工单对话只看文本部分在不在，于是画了一个空气泡，下面一条红色错误（工单 #66 的 Run #71）。
export function assistantMessageHasContent(input: {
  messageId: string;
  partIds: readonly string[];
  textPart: MessagePart | undefined;
}): boolean {
  return input.partIds.some((partId) => partId !== `${input.messageId}:text`)
    || (input.textPart?.kind === 'text' && input.textPart.text.trim().length > 0);
}
