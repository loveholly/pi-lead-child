import { Row, TaskCard, Text } from '@pi-lead-child/components';
import { Fragment, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useWorkspaceStore } from '../../state/CompanionStateProvider';
import { useMessage, useMessageParts, useStreamingText } from '../../state/hooks';
import type { MessageEntity } from '../../state/types';

import { useNow } from '../tickets/useNow';
import { buildAssistantTurn } from './assistantTurn';
import { ProvenanceChips } from './ProvenanceChips';
import { MessagePartView } from './MessagePartView';

type AssistantTurnViewProps = {
  messageId: string;
  messageState: MessageEntity['state'];
  compact?: boolean;
  suppressedApprovalIds?: readonly number[];
  suppressedTicketIds?: readonly number[];
  // 最后的回复怎么画（主会话要把切换模型的系统提示单独居中）。回复为空时也会调用，可以返回 null。
  renderReply: (reply: string) => ReactNode;
  // 消息头（发送者和时间）。给了就由这里画，工具摘要接在它后面（方案 A，主会话）。
  header?: string;
  // 消息头前面的标记：主会话里是 Fairy（主题 F-5）。在跑时它代替摘要前面的小转圈。
  headerMark?: ReactNode;
  // card：任务卡单独一张（工单对话）。inline：工具摘要并进消息头，灰色小字（主会话，方案 A）。
  taskVariant?: 'card' | 'inline';
};

// 一轮助手回复：任务卡（工作步骤）、最后的回复和 Lead 画的卡片（按出现的先后）、附件（工单、审批、产物），从上到下。
// 主会话（LeadConversation）和工单对话（TicketThread）都用它。
// 卡片和步骤的展开状态记在 workspace store 里：同一个页面上重新渲染或滚动回来，还是展开的。
export function AssistantTurnView({
  messageId,
  messageState,
  compact = false,
  suppressedApprovalIds,
  suppressedTicketIds,
  renderReply,
  header,
  headerMark,
  taskVariant = 'card',
}: AssistantTurnViewProps) {
  const parts = useMessageParts(messageId);
  const message = useMessage(messageId);
  const failure = message?.failure ?? null;
  const startedAt = message?.createdAt ?? null;
  const endedAt = message?.updatedAt ?? null;
  const streamingText = useStreamingText(messageId);
  const textPart = parts.find((part) => part.kind === 'text');
  const text = `${textPart?.kind === 'text' ? textPart.text : ''}${streamingText ?? ''}`;
  // 还在跑的一轮，回合头每秒更新已经过去的时间。结束了的不走表。
  const now = useNow(messageState === 'streaming' || messageState === 'queued' ? 1_000 : null);
  const turn = useMemo(
    () => buildAssistantTurn({ messageId, messageState, failure, text, parts, startedAt, endedAt, now }),
    [messageId, messageState, failure, parts, text, startedAt, endedAt, now],
  );
  const cardKey = `${messageId}:task`;
  const stepPrefix = `${cardKey}:`;
  const expanded = useWorkspaceStore((state) => Boolean(state.expandedMessagePartIds[cardKey]));
  const expandedStepIds = useWorkspaceStore(useShallow((state) => Object.keys(state.expandedMessagePartIds)
    .filter((key) => key.startsWith(stepPrefix))
    .map((key) => key.slice(stepPrefix.length))));
  const toggle = useWorkspaceStore((state) => state.toggleMessagePart);

  const inline = taskVariant === 'inline';
  return (
    <>
      {header && !(inline && turn.card) ? (
        headerMark ? (
          <Row items="center" gap="inline-item">
            {headerMark}
            <Text size="meta" weight="semibold" tone="secondary" align="left">{header}</Text>
          </Row>
        ) : <Text size="meta" weight="semibold" tone="secondary" align="left">{header}</Text>
      ) : null}
      {turn.card ? (
        <TaskCard
          testID={`task-card-${messageId}`}
          variant={taskVariant}
          {...(inline && header ? { leading: header } : {})}
          {...(inline && header && headerMark ? { leadingMark: headerMark } : {})}
          status={turn.card.status}
          steps={turn.card.steps}
          durationMs={turn.card.durationMs}
          expanded={expanded}
          onExpandedChange={() => toggle(cardKey)}
          expandedStepIds={expandedStepIds}
          onStepExpandedChange={(stepId) => toggle(`${stepPrefix}${stepId}`)}
        />
      ) : null}
      {/* 回复和卡片按出现的先后排（buildAssistantTurn 的 body）。没有文字时也调一次 renderReply('')，和以前一样。 */}
      {turn.body.some((item) => item.kind === 'text') ? null : renderReply('')}
      {turn.body.map((item, index) => item.kind === 'text' ? (
        <Fragment key={`text:${index}`}>{renderReply(item.text)}</Fragment>
      ) : (
        <MessagePartView
          key={item.partId}
          compact={compact}
          messageId={messageId}
          messageState={messageState}
          partId={item.partId}
          role="assistant"
          suppressedApprovalIds={suppressedApprovalIds}
          suppressedTicketIds={suppressedTicketIds}
        />
      ))}
      {/* 依据（方案 A）：这一轮实际读过的东西，由 UI 按工具记录生成，不是 Lead 写的话。点开看具体读了什么。只在主会话里画。 */}
      {inline ? <ProvenanceChips parts={parts} /> : null}
      {turn.attachmentPartIds.map((partId) => (
        <MessagePartView
          key={partId}
          compact={compact}
          messageId={messageId}
          messageState={messageState}
          partId={partId}
          role="assistant"
          suppressedApprovalIds={suppressedApprovalIds}
          suppressedTicketIds={suppressedTicketIds}
        />
      ))}
    </>
  );
}
