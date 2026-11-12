import { Row, TaskCard, Text, useKeepChatBlockInPlace } from '@pi-lead-child/components';
import { Fragment, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useMessages } from '@/i18n';

import { useControlPlaneStore, useWorkspaceStore } from '../../state/CompanionStateProvider';
import { useMessage, useMessageParts, useStreamingText } from '../../state/hooks';
import type { MessageEntity } from '../../state/types';

import { useNow } from '../tickets/useNow';
import { buildAssistantTurn } from './assistantTurn';
import { TurnCardGroupView } from './TurnCardGroupView';
import { groupTicketParts, TURN_CARD_GROUP_MIN, type TurnCardSlot } from './turnCardGroups';
import { ProvenanceChips } from './ProvenanceChips';
import { MessagePartView } from './MessagePartView';
import { turnStatusMessages } from './turnStatus.messages';

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
  const attachmentSlots = useTicketPartSlots(turn.attachmentPartIds, parts, suppressedTicketIds);
  const cardKey = `${messageId}:task`;
  // 这一步在等模型、等过了 30 秒（lead-scheduler spec D11）：还在想的这一轮写「模型回复慢」，不写「Thinking」。
  // 推送里的轮次对得上这一轮时才写；系统回合还没落成一轮时推送不带轮次，那时写在正在跑的那一轮上。
  const leadStep = useControlPlaneStore((state) => state.leadStep);
  const m = useMessages(turnStatusMessages);
  const runningTitle = leadStep?.kind === 'model_slow' && messageState === 'streaming'
    && (leadStep.turnId === null || leadStep.turnId === message?.turnId) ? m.modelSlow : null;
  const stepPrefix = `${cardKey}:`;
  const expanded = useWorkspaceStore((state) => Boolean(state.expandedMessagePartIds[cardKey]));
  const expandedStepIds = useWorkspaceStore(useShallow((state) => Object.keys(state.expandedMessagePartIds)
    .filter((key) => key.startsWith(stepPrefix))
    .map((key) => key.slice(stepPrefix.length))));
  const toggle = useWorkspaceStore((state) => state.toggleMessagePart);
  // 展开、收起工具卡片时，这条消息在会话流里原地不动：上面的消息和滚动位置不变，只有卡片和它下面的内容变（ChatList）。
  const keepInPlace = useKeepChatBlockInPlace();
  const toggleInPlace = (key: string) => {
    keepInPlace();
    toggle(key);
  };

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
          runningTitle={runningTitle}
          steps={turn.card.steps}
          durationMs={turn.card.durationMs}
          expanded={expanded}
          onExpandedChange={() => toggleInPlace(cardKey)}
          expandedStepIds={expandedStepIds}
          onStepExpandedChange={(stepId) => toggleInPlace(`${stepPrefix}${stepId}`)}
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
      {/* Three or more created reminders or tickets in one reply show as one line (P9.10, turnCardGroups.ts). */}
      {attachmentSlots.map((slot) => slot.kind === 'group' ? (
        <TurnCardGroupView key={slot.group.key} group={slot.group} />
      ) : (
        <MessagePartView
          key={slot.cardId}
          compact={compact}
          messageId={messageId}
          messageState={messageState}
          partId={slot.cardId}
          role="assistant"
          suppressedApprovalIds={suppressedApprovalIds}
          suppressedTicketIds={suppressedTicketIds}
        />
      ))}
    </>
  );
}

// Group the reply's ticket parts. The kind and stage come from the same TicketSummary / TicketDetail the single cards
// read; the selector returns a flat string so unrelated store changes do not re-render. Suppressed parts draw nothing,
// so they do not count.
function useTicketPartSlots(
  partIds: readonly string[],
  parts: ReturnType<typeof useMessageParts>,
  suppressedTicketIds: readonly number[] | undefined,
): TurnCardSlot[] {
  const ticketParts = useMemo(() => {
    const byId = new Map(parts.map((part) => [part.id, part]));
    return partIds.flatMap((partId) => {
      const part = byId.get(partId);
      return part?.kind === 'ticket' && !(suppressedTicketIds ?? []).includes(part.ticketId) ? [{ partId, ticketId: part.ticketId }] : [];
    });
  }, [partIds, parts, suppressedTicketIds]);
  const known = useControlPlaneStore((state) => ticketParts.map(({ ticketId }) => {
    const summary = state.ticketsById[ticketId] ?? state.ticketDetailsById[ticketId]?.ticket;
    return `${ticketId}:${summary?.kind ?? ''}:${summary?.stage ?? ''}`;
  }).join('|'));
  return useMemo(() => {
    const plain = partIds.map((partId) => ({ kind: 'card' as const, cardId: partId }));
    if (ticketParts.length < TURN_CARD_GROUP_MIN) return plain;
    const facts = new Map(known.split('|').filter(Boolean).map((entry) => {
      const [id, kind, stage] = entry.split(':');
      return [Number(id), { kind: kind === 'task' || kind === 'reminder' ? kind : null, stage: stage || null }] as const;
    }));
    const grouped = groupTicketParts(ticketParts, {
      itemKind: (ticketId) => facts.get(ticketId)?.kind ?? null,
      stage: (ticketId) => facts.get(ticketId)?.stage ?? null,
    });
    const groupOf = new Map<string, TurnCardSlot>();
    for (const slot of grouped) if (slot.kind === 'group') for (const id of slot.group.cardIds) groupOf.set(id, slot);
    // Keep every other attachment (approvals, artifacts, single ticket parts) in its place; a group sits at its first part.
    const placed = new Set<string>();
    return plain.flatMap((slot): TurnCardSlot[] => {
      const group = groupOf.get(slot.cardId);
      if (!group || group.kind !== 'group') return [slot];
      if (placed.has(group.group.key)) return [];
      placed.add(group.group.key);
      return [group];
    });
  }, [known, partIds, ticketParts]);
}

