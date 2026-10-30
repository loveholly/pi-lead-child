import { Box, Button, Column, MessageBubble, Text } from '@pi-lead-child/components';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { AssistantTurnView } from '@/features/chat/AssistantTurnView';
import { ConversationDateDivider } from '@/features/chat/ConversationDateDivider';
import { FailureCard } from '@/features/chat/FailureCard';
import { formatConversationDate, formatConversationTime } from '@/features/chat/LeadConversation';
import { MarkdownMessage } from '@/features/chat/MarkdownMessage';
import { MessagePartView } from '@/features/chat/MessagePartView';
import { assistantMessageHasContent } from '@/features/chat/assistantContent';
import { FAILURE_ACTION_LABELS, presentTurnFailure } from '@/features/chat/failurePresentation';
import { useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadName, useMessage, useMessagePart, useMessagePartIds, useMessageParts, useOverview, useTurn } from '@/state/hooks';

// 工单对话：你和这张工单的执行 agent 之间的消息。和主会话一样：你的消息是浅灰气泡，agent 的回复直接排在白底上，
// 跨天时插日期分隔线，失败用白话的失败卡（原文在展开以后）。
export function TicketConversation({
  ticketId,
  messageIds,
  onResend,
  now = new Date(),
}: {
  ticketId: number;
  messageIds: readonly string[];
  /** 「重发」：把这一轮你说的话再发给工单一次。 */
  onResend?: (text: string) => void;
  now?: Date;
}) {
  const dates = useControlPlaneStore(useShallow((state) => messageIds.map((id) => state.messagesById[id]?.createdAt ?? '')));
  let previousDay = '';
  return (
    <Column testID="ticket-conversation" gap="conversation-block">
      {messageIds.map((messageId, index) => {
        const day = dates[index] ? formatConversationDate(dates[index]!, now) : '';
        const divider = day && day !== previousDay ? day : null;
        if (day) previousDay = day;
        return (
          <Column key={messageId} gap="conversation-block">
            {divider ? <ConversationDateDivider label={divider} /> : null}
            <TicketConversationMessage
              ticketId={ticketId}
              messageId={messageId}
              onResend={onResend}
              latest={index === messageIds.length - 1}
            />
          </Column>
        );
      })}
    </Column>
  );
}

function TicketConversationMessage({
  ticketId,
  messageId,
  onResend,
  latest,
}: {
  ticketId: number;
  messageId: string;
  onResend?: (text: string) => void;
  /** 对话里最后一条。它总是完整显示。 */
  latest: boolean;
}) {
  const message = useMessage(messageId);
  const turn = useTurn(message?.turnId ?? '');
  const partIds = useMessagePartIds(messageId);
  const parts = useMessageParts(messageId);
  const textPart = useMessagePart(`${messageId}:text`);
  const userPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  const lead = useOverview()?.lead;
  const leadName = useLeadName();
  if (!message) return null;
  // agent 这一轮一个字也没说时不画气泡，失败了就只显示错误（工单 #66 的 Run #71）。还在回答的那一轮照常画。
  const bubble = message.role !== 'assistant' || message.state === 'streaming'
    || assistantMessageHasContent({ messageId, partIds, textPart });
  if (!bubble && !message.failure) return null;
  const user = message.role === 'user';
  const stateCopy = message.state === 'queued'
    ? '发送中'
    : message.state === 'streaming'
      ? '正在回答'
      : formatConversationTime(message.updatedAt);
  const userText = userPart?.kind === 'text' ? userPart.text : null;
  const failure = message.failure ? presentTurnFailure({
    failure: message.failure,
    originKind: turn?.originKind,
    ticketId,
    userText,
    lead,
    clock: (value) => formatConversationTime(value),
    tools: parts.flatMap((part) => part.kind === 'tool' ? [part] : []),
  }) : null;
  const failureActions = (failure?.actions ?? []).flatMap((action) => action === 'resend' && userText && onResend
    ? [{ label: FAILURE_ACTION_LABELS.resend, onPress: () => onResend(userText) }]
    : []);
  return (
    // 你的气泡靠内容列的右边，最宽 70%，和主会话一样（2026-10-16）。
    <Column gap="reply-block" {...(user ? { self: 'flex-end', maxW: '70%', testID: 'ticket-user-message' } as const : { self: 'stretch', maxW: '100%' } as const)}>
      <Text size="meta" weight="semibold" tone="secondary" align={user ? 'right' : 'left'}>
        {`${user ? '你' : ticketConversationSenderLabel(turn?.originKind, leadName)} · ${stateCopy}`}
      </Text>
      {bubble && user ? (
        <MessageBubble testID="ticket-message-bubble">
          {partIds.map((partId) => (
            <MessagePartView
              key={partId}
              compact
              messageId={messageId}
              messageState={message.state}
              partId={partId}
              role={message.role}
            />
          ))}
        </MessageBubble>
      ) : bubble ? (
        // 助手这一轮：任务卡、回复、附件（AssistantTurnView）。调过工具的轮次算有内容，照样画。
        <Column testID="ticket-message-bubble" gap="reply-block">
          <AssistantTurnView
            compact
            messageId={messageId}
            messageState={message.state}
            renderReply={(reply) => reply
              ? <FoldableReply markdown={reply} foldable={!latest && message.state !== 'streaming'} />
              : null}
          />
        </Column>
      ) : null}
      {failure ? <FailureCard headline={failure.headline} tone={failure.tone} details={failure.details} actions={failureActions} /> : null}
    </Column>
  );
}

/** 超过这么多字的回复默认折起来。 */
export const LONG_REPLY_CHARS = 600;

// 长回复默认只显示开头几行，带「展开全文 · 约 N 字」（复核 P2-5）。#66 的三条回复约 1,700、2,900、700 字，
// 挤在窄栏里要翻好几屏。最后一条和还在写的那条不折：你正在看它。
function FoldableReply({ markdown, foldable }: { markdown: string; foldable: boolean }) {
  const [open, setOpen] = useState(false);
  if (!foldable || markdown.length <= LONG_REPLY_CHARS) return <MarkdownMessage markdown={markdown} />;
  const size = (Math.round(markdown.length / 100) * 100).toLocaleString('en-US');
  return (
    <Column gap="reply-block">
      <Box testID="ticket-reply-body" {...(open ? {} : { maxH: 200, overflow: 'hidden' as const })}>
        <MarkdownMessage markdown={markdown} />
      </Box>
      <Box self="flex-start">
        <Button
          label={open ? '收起' : `展开全文 · 约 ${size} 字`}
          onPress={() => setOpen((value) => !value)}
          testID="ticket-reply-toggle"
          variant="link"
          size="xs"
        />
      </Box>
    </Column>
  );
}

// 谁回答了工单对话的这一轮：执行 agent 的轮次以 :ticket-agent 结尾。2026-10-19 起工单对话一律交给工单的 agent；
// 在那之前（工单 08 的第一版），一些消息由 Lead 回答，它的轮次和主会话一样是 paired:<kind>（带工单号），
// 更早 daemon 合成的回执是 paired:<kind>:ticket。这些旧轮次照样写 Lead 的名字（leadName）。
// 还不知道来源（例如这一轮还没开始，占位的 originKind 是 live）时按以前的写法写执行 agent。
export function ticketConversationSenderLabel(originKind: string | undefined, leadName: string): string {
  if (originKind?.endsWith(':ticket-system')) return '系统';
  if (originKind?.startsWith('paired:') && !originKind.endsWith(':ticket-agent')) return leadName;
  return '执行 agent';
}
