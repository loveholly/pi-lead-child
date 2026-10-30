import { Density } from '@pi-lead-child/components';
import {
  Box, Button, Card, ChatScroll, Column, ConversationColumn, Dot, Icon, IconButton, ImageThumbnail, KeyboardArea, LeadAvatar, MessageBubble, NoticeRow,
  Pressable, Row,
  Spacer,
  Text,
} from '@pi-lead-child/components';
import {
  blockerNoticeTicketId, CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, CHAT_IMAGES_CAPABILITY, CHAT_PLACEMENT_CAPABILITY, type ChatImageInput, isDaemonNoticeOrigin, isLeadRestartInterruption, isSystemTurnOrigin,
  ownerActionRefOfTurn, SYSTEM_TURN_ORIGINS, ticketNeedsUser,
  ticketNeedsUserLabel, ticketTurn, type ChatPlacement, type KernelTicketWorkItemV2,
  type ChannelCardDto,
  type LeadActivityCard, type ReminderCard, type SetupChecklistCard, type SetupHintCard,
  type TicketSummary,
  validateUiSurface,
} from '@pi-lead-child/protocol';
import { useEffect, useMemo, useState } from 'react';

import { placementCopyFor, steeredNoticeFor } from './steeredNotice';
import { assistantMessageHasContent } from './assistantContent';
import { leadSenderLabel, systemNoticeLabel } from './senderLabel';
import { splitMaintenanceNotice } from './maintenanceNotice';
import { LeadIdentity } from '../../components/LeadIdentity';
import { useLeadAvatarSource } from '../../components/useLeadAvatarSource';
import { WebUpdateNotice } from '../../components/WebUpdateNotice';
import { ticketContextLabel, ticketSummaryToTicket } from '../workspace/model';
import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '../../state/CompanionStateProvider';
import {
  useConnectionPhase,
  useConnectionState,
  useConversationCards,
  useLeadName,
  useLeadSessionId,
  useMessage,
  useMessageIds,
  useMessagePart,
  useMessagePartIds,
  useMessageParts,
  useLeadBusy,
  useOverview,
  useTicketInterventions,
  useTickets,
  useTurn,
  useTurnIds,
  useWorkItems,
} from '../../state/hooks';
import type { ConversationCardEntity, LeadTurnEntity, MessageEntity, MessagePart } from '../../state/types';
import { RESOURCE_KEYS } from '../../state/types';

import { CheckpointCard } from './CheckpointCard';
import { ConversationDateDivider } from './ConversationDateDivider';
import { FailureCard } from './FailureCard';
import { presentOutage } from './outagePresentation';
import { FAILURE_ACTION_LABELS, presentTurnFailure, turnFailureGroupKey, type FailureAction } from './failurePresentation';
import { InterventionCard } from './InterventionCard';
import { LeadModelPicker, LeadModelResendLink } from './LeadModelPicker';
import { MessageComposer } from './MessageComposer';
import { AssistantTurnView } from './AssistantTurnView';
import { MessagePartView } from './MessagePartView';
import { MarkdownMessage } from './MarkdownMessage';
import { TicketExecutionConversationCard } from './ConversationTicketCard';
import { canFoldCheckpoint, foldTicketDispatches, type DispatchWindow } from './dispatchCards';
import { DispatchTicketCard } from './DispatchTicketCard';
import { LeadActivityBlock, TurnActivity } from './LeadActivityBlock';
import { InterruptBanner } from './InterruptBanner';
import { LeadQueueBar } from './LeadQueueBar';
import { useComposerQueueTray } from './ComposerQueueTray';
import { leadActivityCards, reminderCards, reminderTurnCards, setupChecklistCard, setupHintCards } from '../../state/control-plane/leadActivity';
import { ReminderFireCard } from './ReminderFireCard';
import { SetupChecklistCardItem, SetupHintCardItem } from './SetupCards';
import { OwnerActionCard, OwnerActionGroupCard, OwnOwnerActionGroup, OwnOwnerActionNote } from './OwnerActionCard';
import { ChannelCardSlot } from './ChannelMessageCard';
import { useOpenTicket } from './useOpenTicket';

type LeadConversationProps = {
  compact?: boolean;
  railOpen?: boolean;
  onOpenRail?: () => void;
  // 右侧的视图面板（2026-10-30，主题 11.14 第 7 项）：开没开、点顶栏最右边的按钮时做什么。不给时顶栏没有这个按钮。
  viewsOpen?: boolean;
  onToggleViews?: () => void;
  onOpenAll?: () => void;
};

export function LeadConversation({ compact = false, railOpen = true, onOpenRail, onOpenAll, viewsOpen = false, onToggleViews }: LeadConversationProps) {
  const runtime = useCompanionRuntime();
  const phase = useConnectionPhase();
  const connectionState = useConnectionState();
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const sessionId = useLeadSessionId();
  const leadName = useLeadName();
  // 「当前工单」是桌面上开着详情的那一张。详情关上以后选中还留着，但它不再是当前工单：顶栏不写，
  // 会话里的卡片也不按它写「其他工单」（2026-10-16）。手机上会话和工单详情不同时出现。
  const threadOpen = useWorkspaceStore((state) => state.threadOpen);
  const openTicketId = useWorkspaceStore((state) => state.selectedTicketId);
  const selectedTicketId = !compact && threadOpen ? openTicketId : null;
  const selectedTicket = selectedTicketId === null ? undefined : tickets.find((ticket) => ticket.id === selectedTicketId);
  const messageIds = useMessageIds(sessionId);
  const turnIds = useTurnIds(sessionId);
  const turnsById = useControlPlaneStore((state) => state.turnsById);
  const messagesById = useControlPlaneStore((state) => state.messagesById);
  const { cards } = useConversationCards();
  const conversationCardPage = useControlPlaneStore(
    (state) => state.conversationCardPagesByResource[RESOURCE_KEYS.conversationCards],
  );
  const [historyRequest, setHistoryRequest] = useState({ loading: false, error: null as string | null });
  const messages = useMemo(
    () => messageIds.flatMap((messageId) => messagesById[messageId] ? [messagesById[messageId]] : []),
    [messageIds, messagesById],
  );
  // 你发的最后一条消息。它变了，说明你刚发了消息：列表回到底部（ChatScroll 的 followKey）。
  const lastUserMessageId = useMemo(() => latestSentMessageKey(messages), [messages]);
  const directTicketTurns = useMemo(
    () => turnIds.flatMap((turnId) => {
      const turn = turnsById[turnId];
      return turn?.ticketId === null || turn === undefined ? [] : [turn];
    }),
    [turnIds, turnsById],
  );
  const partIdsByMessage = useControlPlaneStore((state) => state.partIdsByMessage);
  // 「Lead 动态」的卡片（工单 06：一个对象一张卡，原地更新），按位置从旧到新。
  const leadActivityState = useControlPlaneStore((state) => state.leadActivity);
  const leadActivity = useMemo(() => leadActivityCards(leadActivityState), [leadActivityState]);
  // 「Lead 动态」里带着的主人操作（你允许了这次写入）：会话里那一行并进了那一行，不再单独画（改版稿第 2 组）。
  const carriedOwnerActionIds = useMemo(
    () => new Set(leadActivity.flatMap((card) => (card.ownerAction ? [card.ownerAction.eventId] : []))),
    [leadActivity],
  );
  // 你在这个客户端上刚做的主人操作（只显示一行记录的那种）：它的事件编号。别的设备、Lead 代做的是 null。
  const currentBindingId = runtime.currentBinding()?.id ?? null;
  const ownOwnerActionEventId = (message: MessageEntity): string | null => {
    if (message.role !== 'assistant' || !message.turnId) return null;
    if (turnsById[message.turnId]?.originKind !== SYSTEM_TURN_ORIGINS.ownerAction) return null;
    const ref = ownerActionRefOfTurn(message.turnId);
    return ref && currentBindingId !== null && ref.bindingId === currentBindingId ? ref.eventId : null;
  };
  // 外部来源的会话卡（工单 11）。会话卡、推送加会话卡放进对话；摘要投递的在「Lead 动态」里；只记录的不开卡。
  const channelCards = useControlPlaneStore((state) => state.channelCards);
  // 会话里的到点卡（工单 07）。Lead 为提醒单独回的那一轮挂在卡下面，不另起气泡。
  const reminders = useMemo(() => reminderCards(leadActivityState), [leadActivityState]);
  const reminderTurnIds = useMemo(() => new Set(reminderTurnCards(leadActivityState).keys()), [leadActivityState]);
  // 首次启动引导的两种卡（准备清单、建议）。
  const setupChecklist = useMemo(() => setupChecklistCard(leadActivityState), [leadActivityState]);
  const setupHints = useMemo(() => setupHintCards(leadActivityState), [leadActivityState]);
  const messagePartsById = useControlPlaneStore((state) => state.messagePartsById);
  const boundInterventionIds = useMemo(() => surfaceBoundInterventionIds(Object.values(messagePartsById)), [messagePartsById]);
  // Lead 在回复里引用了的外部消息卡（对象节点 ChannelCard）：卡画在那里，时间线里不再另画一张。
  const boundChannelCardIds = useMemo(() => surfaceBoundChannelCardIds(Object.values(messagePartsById)), [messagePartsById]);
  const timelineChannelCards = useMemo(
    () => channelCards.filter((card) => !boundChannelCardIds.has(card.id)),
    [boundChannelCardIds, channelCards],
  );
  // 到点过的提醒：会话里的到点卡就是这条提醒（对象组件 Reminder），设提醒那一轮的卡（ticket_execution 会话卡片，
  // 或者消息里的工单片段）不再另画一张（2026-10-27 用户：到点出现两张）。
  const firedReminderIds = useMemo(() => [...new Set(reminders.map((card) => card.reminderId))], [reminders]);
  const leadCards = useMemo(
    () => filterLeadTimelineCards(cards, turnsById)
      .filter((card) => card.kind !== 'intervention' || !boundInterventionIds.has(card.interventionId))
      .filter((card) => card.kind !== 'ticket_execution' || !firedReminderIds.includes(card.ticketId)),
    [boundInterventionIds, cards, firedReminderIds, turnsById],
  );
  const timeline = useMemo(
    () => buildLeadTimeline(messages, leadCards, directTicketTurns, {
      // 只有失败、没有内容的 Lead 主动回合才合并（例如每次心跳巡检一个 503）。
      now: new Date(),
      leadActivity,
      channelCards: timelineChannelCards,
      reminders,
      reminderTurnIds,
      setupChecklist,
      setupHints,
      isSilent: (message) => {
        if (message.role !== 'assistant' || message.state !== 'completed' || message.failure) return false;
        const turn = message.turnId ? turnsById[message.turnId] : undefined;
        if (!isSystemTurnOrigin(turn?.originKind)) return false;
        const text = messagePartsById[`${message.id}:text`];
        // 画了卡片（surface）的回合有话对用户说，即使没有文字。
        if ((partIdsByMessage[message.id] ?? []).some((partId) => messagePartsById[partId]?.kind === 'surface')) return false;
        return !(text?.kind === 'text' && text.text.trim());
      },
      failureGroupKey: (message) => {
        const turn = message.turnId ? turnsById[message.turnId] : undefined;
        const key = turnFailureGroupKey(message.failure, turn?.originKind);
        if (key === null) return null;
        const hasContent = (partIdsByMessage[message.id] ?? []).some((partId) => {
          const part = messagePartsById[partId];
          return part !== undefined && (part.kind !== 'text' || part.text.trim().length > 0);
        });
        return hasContent ? null : key;
      },
      isOwnOwnerAction: (message) => ownOwnerActionEventId(message) !== null,
      isCarriedOwnerAction: (message) => {
        const eventId = ownOwnerActionEventId(message);
        return eventId !== null && carriedOwnerActionIds.has(eventId);
      },
      isOnBehalfOwnerAction: (message) => {
        if (message.role !== 'assistant' || !message.turnId) return false;
        if (turnsById[message.turnId]?.originKind !== SYSTEM_TURN_ORIGINS.ownerAction) return false;
        // daemon 给代你做的操作的轮次编号写凭证 0（server.ts 的 owner-actions 轮询）。
        return ownerActionRefOfTurn(message.turnId)?.bindingId === 0;
      },
      // 一次停摆，一张卡片：系统的兜底通知和同一段时间里 Lead 失败的回合合在一起（mergeOutageIncidents）。
      isOutageNotice: (message) => message.role === 'assistant' && message.turnId !== null
        && turnsById[message.turnId]?.originKind === SYSTEM_TURN_ORIGINS.fallbackNotice,
    }),
    [carriedOwnerActionIds, currentBindingId, directTicketTurns, leadActivity, leadCards, messagePartsById, messages, partIdsByMessage, reminderTurnIds, reminders, setupChecklist, setupHints, timelineChannelCards, turnsById],
  );
  const cardsById = useMemo(
    () => Object.fromEntries(leadCards.map((card) => [card.id, card])) as Record<string, ConversationCardEntity>,
    [leadCards],
  );
  const suppressions = useMemo(() => buildMessagePartSuppressions(leadCards), [leadCards]);
  // 一件事，一张卡（2026-10-17）：派活的工单卡收下之后的 child 消息，记账的工单卡不画（见 ./dispatchCards）。
  const ticketsById = useControlPlaneStore((state) => state.ticketsById);
  const checkpointsById = useControlPlaneStore((state) => state.checkpointsById);
  const folded = useMemo(
    () => foldTicketDispatches(timeline, cardsById, (card) => canFoldCheckpoint(checkpointsById[card.checkpointId], ticketsById[card.ticketId])),
    [cardsById, checkpointsById, ticketsById, timeline],
  );
  const collapsedCardIds = useMemo(() => collapsedTicketCardIds(folded.items, cardsById), [cardsById, folded.items]);
  const rows = useMemo(() => groupChannelCardRuns(folded.items), [folded.items]);
  // 会话里最新的一条 Lead 消息：它的 Fairy 用彩色、会动（主题 F-5）。
  const latestLeadMessageId = useMemo(() => latestLeadMessage(
    rows,
    messagesById,
    (message) => {
      const turn = turnsById[message.turnId ?? ''];
      return systemNoticeLabel(turn?.originKind) !== null || Boolean(turn && isWithoutLeadSide(turn));
    },
  ), [rows, messagesById, turnsById]);
  const hydrated = phase === 'ready';
  const connected = connectionState === 'connected';
  const footerItems = useMemo(() => buildLeadFooterItems(tickets, workItems), [tickets, workItems]);
  const runningFooterCount = hydrated ? footerItems.filter((item) => item.tone === 'running').length : 0;

  // Lead 正忙时，这条消息插话还是排队（工单 04，spec D6）。daemon 支持时才给选：旧 daemon 只会插话。
  const leadBusy = useLeadBusy();
  const canPlace = useControlPlaneStore((state) => state.capabilities.includes(CHAT_PLACEMENT_CAPABILITY));
  const [placement, setPlacement] = useState<ChatPlacement>('steer');
  // daemon 支持排着的追问上的 Steer 和取消时（主题 11.13，2026-10-28）：发送前不再选「插话 / 排队」，
  // Lead 忙时发出的话一律先排队，排着的事都在输入卡片上半截的状态栏里，想马上插进这一轮就点那一条的 Steer。
  const canSteerQueued = useControlPlaneStore((state) => state.capabilities.includes(CHAT_FOLLOW_UP_ACTIONS_CAPABILITY));
  const queueTray = useComposerQueueTray({ leadName, actions: canSteerQueued });
  // daemon 收图片时，输入框才有「+」和粘贴图片（protocol 的 chat-images.ts）。
  const canSendImages = useControlPlaneStore((state) => state.capabilities.includes(CHAT_IMAGES_CAPABILITY));
  // 输入框右下角写 Lead 现在用的模型 id 和推理强度，点开换模型（LeadModelPicker）。
  const leadModel = useOverview()?.model;
  // 不看连接：消息先进本机发件箱，断线时显示「连接恢复后发送」，连上以后按顺序发出（2026-10-16）。
  const send = (message: string, images: ChatImageInput[]) => {
    const mode = canPlace && leadBusy ? (canSteerQueued ? 'followUp' : placement) : undefined;
    void (images.length ? runtime.sendChat(message, undefined, mode, images) : runtime.sendChat(message, undefined, mode)).catch(() => {});
  };
  const loadOlderConversationCards = async () => {
    if (!connected || historyRequest.loading) return;
    setHistoryRequest({ loading: true, error: null });
    try {
      await runtime.loadOlderConversationCards();
      setHistoryRequest({ loading: false, error: null });
    } catch (error) {
      setHistoryRequest({
        loading: false,
        error: error instanceof Error ? error.message : '暂时无法读取更早的会话卡片。',
      });
    }
  };

  // 会话按外观偏好里会话区域的密度（缺省标准）。
  return (
    <Density zone="conversation"><KeyboardArea testID="lead-conversation" bg="surface">
      <Row
        minH={compact ? 64 : 60}
        items="center"
        gap="inline-item"
        px={compact ? 18 : 22}
        borderBottomWidth={1}
        borderBottomColor="border-soft"
        bg="surface"
      >
        {/* 方案 C（主题 11.14、F-7）：左栏开着时 Fairy 在左栏头部，顶栏不放；手机上和左栏收起时 Fairy 回到顶栏。 */}
        {compact || !railOpen ? <LeadIdentity compact={!compact} /> : null}
        {selectedTicket ? (
          <Column
            testID="lead-selected-ticket-context"
            minW={0}
            maxW={360}
            shrink={1}
            pl={12} // spacing-exempt: 左侧竖线到内容的距离
            gap="text-stack"
            borderLeftWidth={1}
            borderLeftColor="border-soft"
          >
            <Text size="eyebrow" weight="bold" tone="secondary">当前工单</Text>
            <Box aria-label={selectedTicket.title}>
              <Text size="card-title" weight="extrabold" numberOfLines={1}>{`#${selectedTicket.id} · 当前工单`}</Text>
            </Box>
            <Text size="secondary" weight="semibold" tone="secondary">{ticketSummaryToTicket(selectedTicket).statusLabel}</Text>
          </Column>
        ) : null}
        <Spacer />
        {/* 执行中 N：原来在输入框上方那一行，和左栏的「在执行」是同一个数（ticketTurn）。不带图标：split 图标和旁边的侧栏按钮像。 */}
        {hydrated ? (
          <Row testID="lead-running-count" items="center" gap="icon-label" shrink={0} aria-label={`执行中 ${runningFooterCount}`}>
            <Text size="label" weight="semibold" tone="strong">执行中</Text>
            <Text size="label" weight="semibold" tone="strong" mono>{String(runningFooterCount)}</Text>
          </Row>
        ) : null}
        <WebUpdateNotice compact={compact} />
        {!railOpen && onOpenRail ? (
          <IconButton icon="sidebar" label="打开工作列表" onPress={onOpenRail} size="lg" />
        ) : null}
        {compact && onOpenAll ? (
          <IconButton icon="sidebar" label="打开工作区" onPress={onOpenAll} size="lg" iconSize={19} badge />
        ) : null}
        {/* 视图（主题 11.14 第 7 项）：最右边。面板开着时是选中态（I-6：图标变成强调色）。 */}
        {onToggleViews ? (
          <IconButton
            testID="views-toggle"
            icon="views"
            label={viewsOpen ? '收起自定义视图' : '打开自定义视图'}
            onPress={onToggleViews}
            size="lg"
            iconColor={viewsOpen ? 'accent' : undefined}
          />
        ) : null}
      </Row>

      {/* 会话流（ChatScroll）：打开时落在最底下；贴底时跟随新消息和流式输出；你往上翻时不拽回来，只给「新消息 ↓」；
          你发了消息就回到底部。内容不满一屏时照旧从上往下排（空会话的提示要居中）。 */}
      <ChatScroll key={sessionId ?? 'no-session'} testID="lead-conversation-scroll" followKey={lastUserMessageId} bottomAligned={false}>
        {/* 两边留白在手机和桌面上都是 16：会话栏窄时内容列占满减留白，宽时内容列最宽 700、居中（2026-10-16）。 */}
        {/* 块和块之间是语义间距 conversation-block，手机和桌面一样（2026-10-21，原来手机 16、桌面 20）。 */}
        <Column grow={1} gap="conversation-block" px="page-x" py={compact ? 18 : 24}>
          {hydrated && !connected ? (
            <Row
              self="center"
              items="center"
              gap="icon-label"
              px="pill-x"
              py="pill-y"
              borderWidth={1}
              borderColor="border"
              rounded="full"
              bg="surface"
            >
              <Dot color="text-muted" size={6} />
              {/* spacing-exempt: 标签字号 */}
              <Text size="11" weight="semibold" tone="secondary">显示已缓存会话 · 等待重新连接</Text>
            </Row>
          ) : null}
          {hydrated && (conversationCardPage?.hasMore || historyRequest.loading || historyRequest.error) ? (
            <Column items="center" gap="card-row">
              {historyRequest.error ? (
                <Text size="secondary" tone="danger-dark" align="center">{`更早的会话卡片加载失败：${historyRequest.error}`}</Text>
              ) : null}
              <Button
                disabled={!connected || historyRequest.loading || !conversationCardPage?.hasMore}
                label={historyRequest.loading ? '正在加载更早的会话卡片…' : historyRequest.error ? '重试加载更早的会话卡片' : '加载更早的会话卡片'}
                onPress={() => void loadOlderConversationCards()}
                testID={historyRequest.loading ? '正在加载更早的会话卡片' : '加载更早的会话卡片'}
                variant="outline"
                tone="neutral"
                shape="pill"
                size="sm"
              />
            </Column>
          ) : null}
          {hydrated ? (folded.items.length ? (
            // 一个内容列（2026-10-16）：Lead 一侧所有的块在这一列里，宽度一致；你的气泡靠右，按这一列的 70% 定宽。
            <ConversationColumn gap="conversation-block">
            {rows.map((item) => item.kind === 'channel-cards' ? (
            // 连着的几张外部消息卡是一张列表，卡和卡之间是 list-row（2026-10-21）。
            <Column key={item.key} testID="channel-card-run" w="100%" gap="list-row">
              {item.cardIds.map((cardId) => <ChannelCardSlot key={cardId} cardId={cardId} />)}
            </Column>
          ) : item.kind === 'message' ? (
            <ConversationMessage
              key={item.key}
              latest={item.messageId === latestLeadMessageId}
              cardIds={item.cardIds}
              activityIds={item.activityIds}
              cardsById={cardsById}
              collapsedCardIds={collapsedCardIds}
              compact={compact}
              dispatchScopes={folded.windows}
              messageId={item.messageId}
              selectedTicketId={selectedTicketId}
              suppressedApprovalIds={suppressions.approvalIdsByTurn[messagesById[item.messageId]?.turnId ?? '']}
              suppressedTicketIds={[...(suppressions.ticketIdsByTurn[messagesById[item.messageId]?.turnId ?? ''] ?? []), ...firedReminderIds]}
            />
          ) : item.kind === 'ticket-direct' ? (
            <TicketDirectNotice key={item.key} compact={compact} turnId={item.turnId} />
          ) : item.kind === 'failure-group' ? (
            <FailureGroup key={item.key} messageIds={item.messageIds} />
          ) : item.kind === 'owner-action-group' ? (
            <OwnerActionGroup key={item.key} messageIds={item.messageIds} own={item.own === true} />
          ) : item.kind === 'incident' ? (
            <IncidentCard
              key={item.key}
              noticeMessageIds={item.noticeMessageIds}
              failureMessageIds={item.failureMessageIds}
              recoveredAt={item.recoveredAt}
            />
          ) : item.kind === 'date' ? (
            <ConversationDateDivider key={item.key} label={item.label} />
          ) : item.kind === 'lead-activity' ? (
            <LeadActivityBlock key={item.key} ids={item.ids} defaultExpanded={false} />
          ) : item.kind === 'reminder' ? (
            <ReminderFireCard key={item.key} cardKey={item.reminderKey} />
          ) : item.kind === 'setup-checklist' ? (
            <SetupChecklistCardItem key={item.key} />
          ) : item.kind === 'setup-hint' ? (
            <SetupHintCardItem key={item.key} cardKey={item.hintKey} />
          ) : cardsById[item.cardId] ? (
            <Box key={item.key} w="100%">
              <ConversationCardView
                card={cardsById[item.cardId]!}
                collapsed={collapsedCardIds.has(item.cardId)}
                compact={compact}
                dispatchScope={folded.windows[item.cardId]}
                selectedTicketId={selectedTicketId}
              />
            </Box>
          ) : null)}
            </ConversationColumn>
          ) : (
            <EmptyConversation title="还没有来自 App 的会话" body={`这里已连接真实的 ${leadName}。发送第一条消息后，会话和工具事件会从 daemon 实时写入。`} />
          )) : (
            <EmptyConversation title={`尚未连接 ${leadName}`} body={`点击顶部的 ${leadName} 配置控制面。未连接时不会展示或写入任何模拟会话。`} />
          )}
        </Column>
      </ChatScroll>

      {/* 输入框放进和会话同样的内容列：同样的留白、同样最宽 700、同样居中，左右边和上面的对话对齐。
          原来输入框上方那一行「执行中 · 需要处理 + 工单标签 + 查看全部」去掉了（方案 C，主题 11.14）：
          执行中挪到顶栏，要你处理的事在左栏的收件箱里，排着的事在输入框上的状态栏里。 */}
      <Column
        shrink={0}
        px="page-x"
        {...(compact
          ? { pt: 'banner-y', borderTopWidth: 1, borderTopColor: 'border-soft', bg: 'surface' } as const
          : { pt: 8, pb: 20 } as const)}
      >
        <ConversationColumn testID="conversation-footer-column" gap={compact ? 0 : 11}>
        {/* interrupt 级的事（工单 06，spec D10）：输入框上方的横幅，用户点「知道了」之前一直在。 */}
        <InterruptBanner />
        <MessageComposer
          compact={compact}
          contextKey="lead"
          // 提示只写一句话，不解释输入框能做什么（2026-10-15 方案 A：不要冗余的文字提示）。
          // 断线时也能写：消息存在本机，连接恢复后发送。
          placeholder={connected ? `给 ${leadName} 发消息` : '连接恢复后发送'}
          onSend={send}
          attachImages={canSendImages}
          modelControl={<LeadModelPicker current={leadModel} />}
          // 新 daemon：排着的事在输入卡片上半截的状态栏里（主题 11.13）。
          // 旧 daemon（没有 Steer 和取消）：照旧在发送前选「插话/排队」，排着的外部消息在那一行的右边（工单 10）。
          {...(canSteerQueued
            ? { tray: queueTray }
            : canPlace && leadBusy ? { placement: { value: placement, onChange: setPlacement }, placementStatus: <LeadQueueBar /> } : {})}
        />
        </ConversationColumn>
      </Column>
    </KeyboardArea></Density>
  );
}

function EmptyConversation({ title, body }: { title: string; body: string }) {
  return (
    <Column flex={1} minH={260} items="center" justify="center" gap="text-stack" px="empty-state">
      <Text size="section-title" weight="extrabold">{title}</Text>
      <Text size="secondary" tone="secondary" align="center">{body}</Text>
    </Column>
  );
}

function ConversationMessage({
  cardIds,
  activityIds,
  cardsById,
  collapsedCardIds,
  dispatchScopes,
  messageId,
  compact,
  selectedTicketId,
  suppressedApprovalIds,
  suppressedTicketIds,
  latest = false,
}: {
  // 会话里最新的一条 Lead 消息：消息头的 Fairy 用彩色、会动；更早的用淡彩、静止（主题 F-5、11.10）。
  latest?: boolean;
  cardIds: readonly string[];
  // 挂在这一轮下面的「Lead 动态」：这一轮说过的事（foldToldActivity）。
  activityIds?: readonly string[];
  cardsById: Readonly<Record<string, ConversationCardEntity>>;
  collapsedCardIds: ReadonlySet<string>;
  /** 派活的工单卡和它管的那一段（见 ./dispatchCards）：画成合一卡片。 */
  dispatchScopes: Readonly<Record<string, DispatchWindow>>;
  messageId: string;
  compact: boolean;
  selectedTicketId: number | null;
  suppressedApprovalIds?: readonly number[];
  suppressedTicketIds?: readonly number[];
}) {
  const runtime = useCompanionRuntime();
  const message = useMessage(messageId);
  const partIds = useMessagePartIds(messageId);
  const parts = useMessageParts(messageId);
  const textPart = useMessagePart(`${messageId}:text`);
  const turn = useTurn(message?.turnId ?? '');
  const turnUserPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  // 这一轮你发的图片：「重发」时连图片一起发。
  const turnUserImages = useMessageParts(turn ? turn.userMessageId : '').filter(isImagePart);
  const overview = useOverview();
  const lead = overview?.lead;
  // Lead 现在用的模型：没有回答的那一轮点开以后写它，后面是「换个模型重发」。
  const leadModel = overview?.model;
  const leadName = useLeadName();
  const connected = useConnectionState() === 'connected';
  // 这一轮被重启打断以后，Lead 已经在自己发起的一轮里接着回复了：失败行改说「Lead 已接着回复」。
  const continued = useControlPlaneStore((state) => Boolean(turn && isLeadRestartInterruption(turn.error)
    && Object.values(state.turnsById).some((other) => other.id !== turn.id && isSystemTurnOrigin(other.originKind)
      && !isDaemonNoticeOrigin(other.originKind)
      && other.state === 'completed' && other.createdAt > turn.createdAt)));
  const delivered = useControlPlaneStore((state) => Boolean(message?.turnId && state.deliveredTurnIds[message.turnId]));
  if (!message) return null;
  if (isHiddenUserMessage(message)) return null;

  // 拿到了回答的插话轮次就是普通的助手消息；只有一句话没说就收尾的那种才是空气泡，
  // 用户由此以为 lead 没响应——实际它已收到并在当前轮里执行了（见 ./steeredNotice）。
  const hasContent = assistantMessageHasContent({ messageId, partIds, textPart });
  const rawText = textPart?.kind === 'text' ? textPart.text : '';
  const maintenanceNotice = splitMaintenanceNotice(rawText).notice;
  const user = message.role === 'user';
  // 取消了的追问（主题 11.13）：Lead 不回答它，这一轮没有助手这一侧。你的那句话照旧在，下面写「已取消」。
  // daemon 把这一轮停在 steered（和「一起回答」同一个终态），所以要在插话的提示之前判断，不然会写成「已插话」。
  // 还排着的追问也没有助手这一侧：Lead 还没开始答它，排着的事在输入框上的状态栏里，你的话下面写「排队中」。
  if (!user && turn && isWithoutLeadSide(turn)) return null;
  const steeredNotice = steeredNoticeFor(message, hasContent, turn?.placement ?? null, leadName);
  if (steeredNotice) {
    return (
      <Box items="center" py="banner-y">
        <Text size="note" tone="secondary">{steeredNotice}</Text>
      </Box>
    );
  }

  // daemon 自己写的 blocker 一行（没有通知、也没有卡片的 blocker）：一行提示，给「打开工单」。
  if (!user && turn?.originKind === SYSTEM_TURN_ORIGINS.blockerNotice && rawText.trim()) {
    return <BlockerNotice text={rawText.trim()} time={formatConversationTime(message.updatedAt)} />;
  }
  // 高风险的主人操作（工单 15）：daemon 写的卡，带「不是我」。轮次编号里带着事件编号和发出操作的凭证编号。
  // 是这个客户端自己的凭证做的（用户刚在这里点的）：只显示一行记录。
  const ownerAction = !user && turn?.originKind === SYSTEM_TURN_ORIGINS.ownerAction ? ownerActionRefOfTurn(message.turnId) : null;
  if (ownerAction && rawText.trim()) {
    const time = formatConversationTime(message.updatedAt);
    return ownerAction.bindingId === runtime.currentBinding()?.id
      ? <OwnOwnerActionNote text={rawText.trim()} time={time} />
      : <OwnerActionCard eventId={ownerAction.eventId} text={rawText.trim()} time={time} />;
  }
  // Lead 自己发起的回合也只写 Lead 的名字（方案 A）。紧凑布局里，Lead 发起的回合和系统通知仍然显示发送者和时间。
  // 是不是系统通知看这一轮的来源，不比较标签文字：Lead 的名字可以改成任何字。
  const noticeLabel = user ? null : systemNoticeLabel(turn?.originKind);
  const systemNotice = noticeLabel !== null;
  const sender = user ? '你' : noticeLabel ?? leadName;
  const showHeader = !compact || (!user && isSystemTurnOrigin(turn?.originKind));
  // 消息头前面的形象（主题 F-5）：只在桌面、只给 Lead 自己说的话，daemon 写的系统通知不加。
  // 最新一条用默认的图，回复时用思考中的图（代替摘要前的小转圈）。更早的用淡彩、静止（P12.4）。
  const replying = message.state === 'streaming' || message.state === 'queued';
  const fairyMark = !user && !systemNotice && !compact
    ? <MessageLeadAvatar name={leadName} latest={latest} replying={replying} />
    : null;
  const time = formatConversationTime(message.updatedAt);
  // 发件箱里的消息：头上写时间，状态写在气泡下面（待发送、发送中、已送达）。
  // 送到以后，Lead 忙时它怎么放的写在这里（工单 04，spec D10）：排队中、已插入、下一轮回答。
  const placementCopy = user && !message.delivery ? placementCopyFor(turn, leadName) : null;
  const deliveryCopy = !user ? null
    : message.delivery === 'pending' ? (connected ? '待发送' : '待发送 · 连接恢复后发送')
      : message.delivery === 'sending' ? '发送中'
        : delivered && !placementCopy ? '已送达' : null;
  const stateCopy = message.delivery ? time : message.state === 'queued'
    ? '发送中'
    : message.state === 'streaming'
      ? '正在回复'
      : time;
  const failure = message.failure;
  const failurePresentation = failure ? presentTurnFailure({
    failure,
    originKind: turn?.originKind,
    ticketId: null,
    // 只发了图片的消息也能「重发」。
    userText: (turnUserPart?.kind === 'text' ? turnUserPart.text : '') || (turnUserImages.length ? '[图片]' : null),
    lead,
    clock: (value) => formatConversationTime(value),
    tools: parts.flatMap((part) => part.kind === 'tool' ? [part] : []),
    continued,
  }) : null;
  const failureActions = (failurePresentation?.actions ?? []).flatMap((action) => {
    // 只有还在本地、没有送达的消息能「重试」或「移除」。
    if ((action === 'retry' || action === 'remove') && message.source !== 'optimistic') return [];
    return [{ label: FAILURE_ACTION_LABELS[action], onPress: () => runFailureAction(action) }];
  });
  const runFailureAction = (action: FailureAction) => {
    if (action === 'refresh') void runtime.refresh();
    else if (action === 'retry') void runtime.retryMessage(message.id).catch(() => {});
    else if (action === 'remove') runtime.dismissLocalMessage(message.id);
    else if (action === 'resend') resend();
  };
  // 重发这一轮：文字和图片一起。只有文字时马上发；本机没有的图片先向 daemon 取。
  const resend = () => {
    const text = turnUserPart?.kind === 'text' ? turnUserPart.text : '';
    if (!turnUserImages.length) {
      if (text.trim()) void runtime.sendChat(text).catch(() => {});
      return;
    }
    void Promise.all(turnUserImages.map((part): Promise<ChatImageInput> | ChatImageInput =>
      part.data !== undefined ? { mimeType: part.mimeType, data: part.data } : runtime.loadChatImage(part.imageId ?? '')))
      .then((images) => runtime.sendChat(text, undefined, undefined, images))
      .catch(() => {});
  };
  // 一个字也没说的助手消息不画内容区，失败了就只显示错误。和工单对话（TicketThread）同一条规则。
  // 调过工具的轮次算有内容（assistantMessageHasContent），照样画任务卡。
  const bubble = user || hasContent || message.state === 'streaming';
  // 你发的图片排在气泡上面。只发了图片的消息没有气泡。
  const userImages = user ? parts.filter(isImagePart) : [];
  const userBubble = user && (rawText.trim().length > 0 || userImages.length === 0);

  return (
    <Column
      gap={user ? 5 : 8}
      {...(user
        ? { self: 'flex-end', maxW: '70%', testID: 'user-message' } as const
        : { w: '100%' } as const)}
    >
      {/* Lead 有内容时，消息头由 AssistantTurnView 画，工具摘要接在它后面（方案 A）。 */}
      {showHeader && (user || !bubble) ? (
        fairyMark ? (
          <Row items="center" gap="inline-item">
            {fairyMark}
            <Text size="meta" weight="semibold" tone="secondary">{`${sender} · ${stateCopy}`}</Text>
          </Row>
        ) : <Text size="meta" weight="semibold" tone="secondary" align={user ? 'right' : 'left'}>{`${sender} · ${stateCopy}`}</Text>
      ) : null}
      {userImages.length ? <UserMessageImages images={userImages} /> : null}
      {bubble && userBubble ? (
        <MessageBubble testID="user-bubble">
          {partIds.map((partId) => (
            <MessagePartView
              key={partId}
              compact={compact}
              messageId={messageId}
              messageState={message.state}
              partId={partId}
              role={message.role}
            />
          ))}
        </MessageBubble>
      ) : null}
      {deliveryCopy ? (
        <Text testID="outbox-status" size="meta" tone={message.delivery === 'pending' ? 'warning-dark' : 'secondary'} align="right">
          {deliveryCopy}
        </Text>
      ) : null}
      {placementCopy ? (
        <Text testID="placement-status" size="meta" tone="secondary" align="right">{placementCopy}</Text>
      ) : null}
      {bubble && !user ? (
        // Lead 的回复不加气泡，直接排在白底上，Lead 主动发起的也一样（方案 A）。只有 daemon 自己写的系统通知铺一层浅底色。
        // 消息头、正文、依据、附件之间是 reply-block，和正文的段落间距一样（2026-10-21，原来是 10）。
        <Column gap="reply-block" {...(systemNotice ? { px: 14, py: 12, rounded: 'xl', bg: 'accent-wash' } as const : {})}>
          <AssistantTurnView
            compact={compact}
            messageId={messageId}
            messageState={message.state}
            suppressedApprovalIds={suppressedApprovalIds}
            suppressedTicketIds={suppressedTicketIds}
            renderReply={(reply) => <LeadReply reply={reply} />}
            {...(showHeader ? { header: `${sender} · ${stateCopy}` } : {})}
            {...(showHeader && fairyMark ? { headerMark: fairyMark } : {})}
            taskVariant="inline"
          />
        </Column>
      ) : null}
      {!user && activityIds?.length ? <TurnActivity ids={activityIds} /> : null}
      {!user && cardIds.map((cardId) => cardsById[cardId] ? (
        <ConversationCardView
          key={cardId}
          card={cardsById[cardId]!}
          collapsed={collapsedCardIds.has(cardId)}
          compact={compact}
          dispatchScope={dispatchScopes[cardId]}
          selectedTicketId={selectedTicketId}
        />
      ) : null)}
      {failurePresentation && !maintenanceNotice ? (
        <Box {...(user ? { self: 'flex-end', maxW: '100%' } as const : { w: '100%' } as const)}>
          <FailureCard
            headline={failurePresentation.headline}
            tone={failurePresentation.tone}
            details={failurePresentation.details}
            actions={failureActions}
            presentation={failurePresentation}
            modelSwitch={failurePresentation.actions.includes('resend') && leadModel && leadModel !== 'unknown'
              ? { current: leadModel, link: <LeadModelResendLink onSwitched={resend} /> }
              : null}
          />
        </Box>
      ) : null}
    </Column>
  );
}

type ImagePart = Extract<MessagePart, { kind: 'image' }>;

function isImagePart(part: MessagePart): part is ImagePart {
  return part.kind === 'image';
}

// 你随消息发的图片：气泡上面右对齐的一排小图（和输入框里待发的图片一样大）。
function UserMessageImages({ images }: { images: readonly ImagePart[] }) {
  return (
    <Row testID="user-message-images" self="flex-end" justify="flex-end" flexWrap="wrap" gap="thumbnails">
      {images.map((image, index) => <UserMessageImage key={image.id} image={image} index={index} />)}
    </Row>
  );
}

function UserMessageImage({ image, index }: { image: ImagePart; index: number }) {
  const runtime = useCompanionRuntime();
  const local = image.data !== undefined ? `data:${image.mimeType};base64,${image.data}` : null;
  // daemon 存的图片：按 id 取一次（runtime 缓存）。取到以前是浅灰的占位块，取不到时显示提示图标。
  const [loaded, setLoaded] = useState<{ imageId: string; uri: string | null } | null>(null);
  const imageId = local ? null : image.imageId ?? null;
  useEffect(() => {
    if (!imageId) return;
    let live = true;
    runtime.loadChatImage(imageId).then(
      (loadedImage) => { if (live) setLoaded({ imageId, uri: `data:${loadedImage.mimeType};base64,${loadedImage.data}` }); },
      () => { if (live) setLoaded({ imageId, uri: null }); },
    );
    return () => { live = false; };
  }, [imageId, runtime]);
  const remote = loaded && loaded.imageId === imageId ? loaded : null;
  return (
    <ImageThumbnail
      testID={`user-message-image-${index}`}
      uri={local ?? remote?.uri ?? null}
      failed={remote !== null && remote.uri === null}
      label={`你发的图片 ${index + 1}`}
    />
  );
}

// Lead 的最后回复。切换模型的系统提示（【系统】…）单独居中显示。
function LeadReply({ reply }: { reply: string }) {
  const { notice, remainder } = splitMaintenanceNotice(reply);
  if (!notice) return reply ? <MarkdownMessage markdown={reply} /> : null;
  return (
    <>
      {remainder ? <MarkdownMessage markdown={remainder} /> : null}
      <Box items="center" py="banner-y">
        <MarkdownMessage markdown={notice} />
      </Box>
    </>
  );
}

function BlockerNotice({ text, time }: { text: string; time: string }) {
  const openTicket = useOpenTicket();
  const ticketId = blockerNoticeTicketId(text);
  return (
    <Column testID="blocker-notice" w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{`${leadSenderLabel(SYSTEM_TURN_ORIGINS.blockerNotice)} · ${time}`}</Text>
      <FailureCard
        headline={text}
        tone="danger"
        details={null}
        actions={ticketId === null ? [] : [{ label: `打开工单 #${ticketId}`, onPress: () => openTicket(ticketId) }]}
      />
    </Column>
  );
}

// 连着出现的同一种失败合成的一张卡片（例如每次心跳巡检一个 503）：写次数和最近一次的时间。
// 一次停摆的系统卡片：开头一句（什么时候、为什么、积压几件、恢复了没有），展开看积压的事和 Lead 那几次没完成的处理。
// ChatScroll 的 followKey：你发的最后一条消息。从本机发件箱发出的消息用它的 clientMessageId：断线时发出也变（列表回到底部），
// 后来送达、本地消息换成那一轮的消息时不变（不算又发了一条，你往上翻了就不把你拽回来）。
export function latestSentMessageKey(messages: readonly MessageEntity[]): string | null {
  const latest = [...messages].reverse().find((message) => message.role === 'user');
  return latest ? latest.clientCommandId ?? latest.id : null;
}

function IncidentCard({ noticeMessageIds, failureMessageIds, recoveredAt }: {
  noticeMessageIds: readonly string[];
  failureMessageIds: readonly string[];
  recoveredAt: string | null;
}) {
  const messagesById = useControlPlaneStore((state) => state.messagesById);
  const partsById = useControlPlaneStore((state) => state.messagePartsById);
  const notices = noticeMessageIds.flatMap((id) => {
    const message = messagesById[id];
    const part = partsById[`${id}:text`];
    return message ? [{ text: part?.kind === 'text' ? part.text : '', at: message.updatedAt }] : [];
  });
  const failures = failureMessageIds.flatMap((id) => {
    const message = messagesById[id];
    return message?.failure ? [{ raw: message.failure.message, at: message.updatedAt }] : [];
  });
  const presentation = presentOutage({ notices, failures, recoveredAt, clock: formatConversationTime });
  const latest = [...notices, ...failures].map((entry) => entry.at).sort().at(-1) ?? '';
  // 和会话里别的警告一样是一行可以展开的条目（packages/components 的 NoticeRow）：收起时只有一句，
  // 点整行展开看积压的事和 Lead 那几次没完成的处理。
  return (
    <Column testID="incident-card" w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">
        {`${leadSenderLabel(SYSTEM_TURN_ORIGINS.fallbackNotice)} · ${formatConversationTime(latest)}`}
      </Text>
      <NoticeRow
        tone="warning"
        title={presentation.headline}
        details={presentation.lines.length ? presentation.lines.map((line) => `· ${line}`).join('\n') : null}
      />
    </Column>
  );
}

// 合成一行的几次代你做的操作：取每一条的文字（第一行是做了什么）和事件编号。
function OwnerActionGroup({ messageIds, own }: { messageIds: readonly string[]; own: boolean }) {
  const messagesById = useControlPlaneStore((state) => state.messagesById);
  const partsById = useControlPlaneStore((state) => state.messagePartsById);
  const items = messageIds.flatMap((id) => {
    const message = messagesById[id];
    const ref = ownerActionRefOfTurn(message?.turnId);
    const part = partsById[`${id}:text`];
    const text = part?.kind === 'text' ? part.text.trim() : '';
    return message && ref && text ? [{ eventId: ref.eventId, text, time: formatConversationTime(message.updatedAt) }] : [];
  });
  return own ? <OwnOwnerActionGroup items={items} /> : <OwnerActionGroupCard items={items} />;
}

function FailureGroup({ messageIds }: { messageIds: readonly string[] }) {
  const latestId = messageIds[messageIds.length - 1]!;
  const latest = useMessage(latestId);
  const turn = useTurn(latest?.turnId ?? '');
  const lead = useOverview()?.lead;
  const leadName = useLeadName();
  if (!latest?.failure) return null;
  const presentation = presentTurnFailure({
    failure: latest.failure,
    originKind: turn?.originKind,
    ticketId: null,
    userText: null,
    lead,
    clock: (value) => formatConversationTime(value),
  });
  // 系统自己发起的那几轮没完成：居中的系统信息行，不写发件人（画布「没有回答」状态 4）。
  if (presentation.form === 'system') {
    return (
      <FailureCard
        headline={presentation.headline}
        tone={presentation.tone}
        details={presentation.details}
        meta={`连续 ${messageIds.length} 次 · 最近 ${formatConversationTime(latest.updatedAt)}`}
        presentation={presentation}
        repeated={messageIds.length}
      />
    );
  }
  return (
    <Column w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{leadSenderLabel(turn?.originKind, leadName)}</Text>
      <FailureCard
        headline={presentation.headline}
        tone={presentation.tone}
        details={presentation.details}
        meta={`共 ${messageIds.length} 次 · 最近 ${formatConversationTime(latest.updatedAt)}`}
        presentation={presentation}
      />
    </Column>
  );
}

// 发往工单的消息在主会话里只留一行灰色的「消息尾巴」（2026-10-15 方案 A）：说清这条消息现在在哪。
// 不画红框，不给「重发」：在跑的 Run 不能中途接收消息时，消息排队，Run 结束后转交；
// 送不到时系统交给 Lead 接手（daemon 的 handTicketMessageToLead）。点这一行打开工单对话。
export function ticketMessageTail({ ticketId, preview, state, updatedAt, leadName }: {
  ticketId: number;
  preview: string;
  state: LeadTurnEntity['state'];
  updatedAt: string;
  // 送不到时交给谁：Lead 的名字（useLeadName）。
  leadName: string;
}): string {
  const quoted = preview.length > 24 ? `${preview.slice(0, 24)}…` : preview;
  const head = quoted ? `你在 #${ticketId} 问了「${quoted}」` : `你在 #${ticketId} 发了一条消息`;
  if (state === 'queued') return `${head} · Run 不能中途插话 · 已排队，结束后转交`;
  if (state === 'streaming') return `${head} · 已送达 · 正在回答`;
  if (state === 'failed') return `${head} · 没送到 · 已交给 ${leadName}`;
  if (state === 'steered') return `${head} · 和下一条一起回答`;
  return `${head} · 已送达 · ${formatConversationTime(updatedAt)} 已回答`;
}

function TicketDirectNotice({ turnId }: { turnId: string; compact: boolean }) {
  const turn = useTurn(turnId);
  const userPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  if (!turn || turn.ticketId === null) return null;
  const ticketId = turn.ticketId;
  const preview = userPart?.kind === 'text' ? userPart.text.trim() : '';
  const tail = ticketMessageTail({ ticketId, preview, state: turn.state, updatedAt: turn.updatedAt, leadName });
  return (
    <Box testID={`ticket-direct-notice-${ticketId}`} w="100%">
      <Pressable
        role="button"
        aria-label={`发给 #${ticketId} 的工单消息`}
        onPress={() => openTicket(ticketId, { chat: true })}
        feedback="highlight"
        rounded="md"
        px={4} // spacing-exempt: 一行按压区的小留白
        minH={32}
        justify="center"
      >
        <Row items="center" gap="icon-label">
          <Icon name="reply" color="text-secondary" size={13} />
          <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{tail}</Text>
        </Row>
      </Pressable>
    </Box>
  );
}

function ConversationCardView({ card, collapsed = false, compact, dispatchScope, selectedTicketId }: {
  card: ConversationCardEntity;
  collapsed?: boolean;
  compact: boolean;
  /** 给出时这是一张派活的工单卡：画成合一卡片，同一天里也不折叠成小标签。 */
  dispatchScope?: DispatchWindow;
  selectedTicketId: number | null;
}) {
  if (card.kind === 'ticket_execution' && dispatchScope) return <DispatchTicketCard card={card} scope={dispatchScope} />;
  const context = card.kind === 'checkpoint' || card.kind === 'intervention' || collapsed
    ? null
    : ticketContextLabel(selectedTicketId, card.ticketId);
  // 事项卡自己决定写不写这一行：提醒不是工单，不写「其他工单 · #3」。
  if (card.kind === 'ticket_execution') {
    return <TicketExecutionConversationCard card={card} collapsed={collapsed} compact={compact} contextLabel={context} />;
  }
  const content = card.kind === 'checkpoint'
    ? <CheckpointConversationCard card={card} />
    : <InterventionConversationCard card={card} compact={compact} />;
  return context ? (
    <Column gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{context}</Text>
      {content}
    </Column>
  ) : content;
}

function CheckpointConversationCard({ card }: { card: ConversationCardEntity & { kind: 'checkpoint' } }) {
  const checkpoint = useControlPlaneStore((state) => state.checkpointsById[card.checkpointId]);
  const currentTicket = useControlPlaneStore((state) => state.ticketsById[card.ticketId]);
  const lead = useOverview()?.lead;
  const openTicket = useOpenTicket();
  if (!checkpoint) return <CardSyncPlaceholder label={`Checkpoint #${card.checkpointId}`} />;
  return (
    <CheckpointCard
      checkpoint={checkpoint}
      currentTicket={currentTicket}
      lead={lead}
      onOpenTicket={openTicket}
      showOpenTicket={false}
    />
  );
}

function InterventionConversationCard({ card, compact }: { card: ConversationCardEntity & { kind: 'intervention' }; compact: boolean }) {
  const runtime = useCompanionRuntime();
  const connected = useConnectionState() === 'connected';
  const checkpoint = useControlPlaneStore((state) => state.checkpointsById[card.checkpointId]);
  const commandState = useWorkspaceStore((state) => state.interventionCommandStateById[card.interventionId]);
  const { interventions } = useTicketInterventions(card.ticketId);
  const intervention = interventions.find((item) => item.id === card.interventionId);
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  return (
    <InterventionCard
      checkpoint={checkpoint}
      commandState={commandState}
      compact={compact}
      intervention={intervention}
      leadName={leadName}
      onOpenTicket={openTicket}
      onResolve={connected ? (command) => runtime.resolveIntervention(card.interventionId, command) : undefined}
      showOpenTicket={false}
    />
  );
}

function CardSyncPlaceholder({ label }: { label: string }) {
  return (
    <Card gap="text-stack" p="card" rounded="xl">
      <Text size="card-title" weight="bold">{label}</Text>
      <Text size="secondary" tone="secondary">正在同步卡片详情。</Text>
    </Card>
  );
}

// 已经画成决定卡（render_ui 的 ChoiceGroup）的决策请求：主会话里不再另画它的介入卡片，同一个决定只有一个入口。
// 这个版本画不出来的卡（SurfaceView 只显示说明和 fallbackText，没有选项）不算：决策请求照旧有自己的卡片。
export function surfaceBoundInterventionIds(parts: Iterable<MessagePart>): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.kind !== 'surface' || !validateUiSurface(part.surface).ok) continue;
    for (const node of part.surface.nodes) {
      if (node.type === 'ChoiceGroup' && typeof node.props.decision === 'number') ids.add(`decision:${node.props.decision}`);
      // Lead 在回复里引用了这条介入请求（对象节点 Intervention）：卡画在那里，会话里不再另画一张。
      if (node.type === 'Intervention' && typeof node.props.id === 'number') ids.add(`${node.props.kind === 'approval' ? 'approval' : 'decision'}:${node.props.id}`);
    }
  }
  return ids;
}

// 画进了 Lead 回复里的外部消息卡（对象节点 ChannelCard）。这个版本画不出来的卡不算：那张卡照旧在时间线里。
export function surfaceBoundChannelCardIds(parts: Iterable<MessagePart>): Set<number> {
  const ids = new Set<number>();
  for (const part of parts) {
    if (part.kind !== 'surface' || !validateUiSurface(part.surface).ok) continue;
    for (const node of part.surface.nodes) {
      if (node.type === 'ChannelCard' && typeof node.props.card === 'number') ids.add(node.props.card);
    }
  }
  return ids;
}

// 同一天里同一张工单只完整画一次，之后的 ticket_execution 卡片折叠成小标签（2026-10-15 方案 A）。
// 日期分隔线之后重新计。
export function collapsedTicketCardIds(
  timeline: readonly LeadTimelineItem[],
  cardsById: Readonly<Record<string, ConversationCardEntity>>,
): Set<string> {
  const collapsed = new Set<string>();
  let seen = new Set<number>();
  const visit = (cardId: string) => {
    const card = cardsById[cardId];
    if (card?.kind !== 'ticket_execution') return;
    if (seen.has(card.ticketId)) collapsed.add(cardId);
    else seen.add(card.ticketId);
  };
  for (const item of timeline) {
    if (item.kind === 'date') seen = new Set();
    else if (item.kind === 'message') item.cardIds.forEach(visit);
    else if (item.kind === 'card') visit(item.cardId);
  }
  return collapsed;
}

// 事件流给每一轮都建了一条用户消息的空壳（Lead 自己发起的回合也有）。没有命令 id 的实时用户消息不显示，
// 时间线里也不排它：不然它夹在两次失败之间，同一种失败就合不成一张卡片。
export function isHiddenUserMessage(message: MessageEntity): boolean {
  return message.role === 'user' && message.source === 'live' && message.clientCommandId === null;
}

export type LeadTimelineItem =
  // activityIds：挂在这一轮下面的「Lead 动态」卡片（说过的事，见 foldToldActivity）。
  | { kind: 'message'; key: string; messageId: string; cardIds: string[]; activityIds?: string[] }
  | { kind: 'ticket-direct'; key: string; turnId: string }
  | { kind: 'card'; key: string; cardId: string }
  // 连着出现的同一种失败，合成一张卡片（见 groupRepeatedFailures）。
  | { kind: 'failure-group'; key: string; messageIds: string[] }
  // 一句话促成的几件代你做的事（画布「代你操作」状态 5）：连着的几条合成一行注脚，写件数（见 groupOwnerActions）。
  // own：你在这个客户端上连着做的几件事（改版稿第 1 组），合成一行系统信息。
  | { kind: 'owner-action-group'; key: string; messageIds: string[]; own?: boolean }
  // 一次停摆：系统的兜底通知，加上同一段时间里 Lead 那几轮失败的回合，合成一张系统卡片（见 mergeOutageIncidents）。
  // recoveredAt：之后第一次成功的 Lead 回答。
  | { kind: 'incident'; key: string; noticeMessageIds: string[]; failureMessageIds: string[]; recoveredAt: string | null }
  // 日期分隔线：这一天的第一项前面一条。
  | { kind: 'date'; key: string; label: string }
  // Lead 动态（方案 A）：连着的几件 Lead 处理了、但没有对用户说的事。at 是最后一件的时间。
  // ids 是卡片的 key（工单 06：一个对象一张卡）。
  | { kind: 'lead-activity'; key: string; ids: string[]; at: number }
  // 外部来源的一条消息（工单 11）：一个对话一张卡，按卡开出来的时间插进对话。
  | { kind: 'channel-card'; key: string; cardId: number; at: number }
  // 一次提醒到点（工单 07）：一张到点卡，位置是到点的时间。reminderKey 是提醒卡的 key。
  | { kind: 'reminder'; key: string; reminderKey: string; at: number }
  // 首次启动引导（.scratch/onboarding）：准备清单卡（Lead 第一次上线时）和建议卡（用户自己的一轮结束时）。
  | { kind: 'setup-checklist'; key: string; at: number }
  | { kind: 'setup-hint'; key: string; hintKey: string; at: number };

export type LeadTimelineOptions = {
  // 能和相邻的同一种失败合并时返回同一个键，否则返回 null。
  failureGroupKey?: (message: MessageEntity) => string | null;
  // 这条消息是不是 Lead 代你做的一次操作（注脚）。给出时，连着的几条合成一行。
  isOnBehalfOwnerAction?: (message: MessageEntity) => boolean;
  // 这条消息是不是你在这个客户端上刚做的主人操作（一行记录）。给出时，连着的几条合成一行（2026-10-28 改版稿第 1 组）。
  isOwnOwnerAction?: (message: MessageEntity) => boolean;
  // 这条主人操作已经并进了「Lead 动态」的一行（卡上带着它，ownerAction.eventId）：不再单独画（改版稿第 2 组）。
  isCarriedOwnerAction?: (message: MessageEntity) => boolean;
  // Lead 不能工作时系统发的兜底通知（system:fallback-notice）。给出时，一次停摆合成一张卡片。
  isOutageNotice?: (message: MessageEntity) => boolean;
  // 给出时，每天的第一项前面插一条日期分隔线（「今天」「昨天」按它算）。
  now?: Date;
  // Lead 处理了、但没有对用户说的事，和只显示的写入（摘要、自动处理、常设指令的修改）。
  // 按卡片的位置插进对话，连着的合成一块（方案 A「Lead 动态」，工单 06）。
  leadActivity?: readonly LeadActivityCard[];
  // 一句话也没说的 Lead 主动回合：不画成一个空回合，它做的事在 Lead 动态里（方案 A）。
  isSilent?: (message: MessageEntity) => boolean;
  // 外部来源的会话卡（工单 11）。按卡开出来的时间插进对话。
  channelCards?: readonly ChannelCardDto[];
  // 会话里的到点卡（工单 07），按到点的时间插进对话。
  reminders?: readonly ReminderCard[];
  // Lead 为提醒单独回的那些轮次：它们说的话画在到点卡下面，这里不另画一个气泡。
  reminderTurnIds?: ReadonlySet<string>;
  // 首次启动引导的两种卡，按卡的位置插进对话。
  setupChecklist?: SetupChecklistCard | null;
  setupHints?: readonly SetupHintCard[];
};

export function buildLeadTimeline(
  messages: readonly MessageEntity[],
  inputCards: readonly ConversationCardEntity[],
  directTicketTurns: readonly LeadTurnEntity[] = [],
  options: LeadTimelineOptions = {},
): LeadTimelineItem[] {
  const cardsById = new Map<string, ConversationCardEntity>();
  for (const card of inputCards) {
    const previous = cardsById.get(card.id);
    if (!previous || card.source === 'durable' || previous.source !== 'durable') cardsById.set(card.id, card);
  }
  const interventionCheckpointIds = new Set(
    [...cardsById.values()].flatMap((card) => card.kind === 'intervention' ? [card.checkpointId] : []),
  );
  const cards = [...cardsById.values()]
    .filter((card) => card.kind !== 'checkpoint' || !interventionCheckpointIds.has(card.checkpointId))
    .sort(compareConversationCards);
  const cardsByTurn = new Map<string, ConversationCardEntity[]>();
  for (const card of cards) {
    if (!card.turnId) continue;
    const grouped = cardsByTurn.get(card.turnId) ?? [];
    grouped.push(card);
    cardsByTurn.set(card.turnId, grouped);
  }

  const result: LeadTimelineItem[] = [];
  const insertionOrder = new Map<string, number>();
  let nextOrder = 0;
  const renderedCards = new Set<string>();
  const assistantMessageByTurn = new Map<string, MessageEntity>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId) continue;
    const previous = assistantMessageByTurn.get(message.turnId);
    if (!previous || Date.parse(message.updatedAt) >= Date.parse(previous.updatedAt)) {
      assistantMessageByTurn.set(message.turnId, message);
    }
  }
  for (const message of messages) {
    if (isHiddenUserMessage(message)) continue;
    if (options.isSilent?.(message)) continue;
    if (message.turnId && options.reminderTurnIds?.has(message.turnId)) continue;
    if (options.isCarriedOwnerAction?.(message)) continue;
    if (message.role === 'assistant' && message.turnId && assistantMessageByTurn.get(message.turnId)?.id !== message.id) {
      continue;
    }
    const turnCards = message.role === 'assistant' && message.turnId
      ? cardsByTurn.get(message.turnId) ?? []
      : [];
    const item: LeadTimelineItem = {
      kind: 'message',
      key: `message:${message.id}`,
      messageId: message.id,
      cardIds: turnCards.map((card) => card.id),
    };
    insertionOrder.set(item.key, nextOrder++);
    result.push(item);
    for (const card of turnCards) {
      renderedCards.add(card.id);
    }
  }
  for (const turn of directTicketTurns) {
    const item: LeadTimelineItem = {
      kind: 'ticket-direct',
      key: `ticket-direct:${turn.id}`,
      turnId: turn.id,
    };
    insertionOrder.set(item.key, nextOrder++);
    result.push(item);
  }
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const turnsById = new Map(directTicketTurns.map((turn) => [turn.id, turn]));
  result.sort((left, right) => compareTimelineItemTime(left, right, messagesById, turnsById, insertionOrder));
  for (const card of cards) {
    if (renderedCards.has(card.id)) continue;
    const cardTime = Date.parse(card.createdAt);
    const insertionIndex = result.findIndex((item) => {
      const messageTime = timelineItemTime(item, messagesById, turnsById);
      return Number.isFinite(cardTime) && Number.isFinite(messageTime) && messageTime > cardTime;
    });
    const entry: LeadTimelineItem = { kind: 'card', key: `card:${card.id}`, cardId: card.id };
    if (insertionIndex < 0) result.push(entry);
    else result.splice(insertionIndex, 0, entry);
  }
  for (const activity of foldToldActivity(result, messagesById, options.leadActivity ?? [])) {
    const at = Date.parse(activity.at);
    if (!Number.isFinite(at)) continue;
    const entry: LeadTimelineItem = { kind: 'lead-activity', key: `lead-activity:${activity.key}`, ids: [activity.key], at };
    const insertionIndex = result.findIndex((item) => {
      const time = timelineItemTime(item, messagesById, turnsById, cardsById);
      return Number.isFinite(time) && time > at;
    });
    if (insertionIndex < 0) result.push(entry);
    else result.splice(insertionIndex, 0, entry);
  }
  for (const card of options.channelCards ?? []) {
    // 摘要投递的消息在 06 的「Lead 动态」卡片里（一个对象一张卡），这里不再放一张。
    if (card.delivery === 'digest') continue;
    const at = Date.parse(card.createdAt);
    if (!Number.isFinite(at)) continue;
    const entry: LeadTimelineItem = { kind: 'channel-card', key: `channel-card:${card.id}`, cardId: card.id, at };
    const insertionIndex = result.findIndex((item) => {
      const time = timelineItemTime(item, messagesById, turnsById, cardsById);
      return Number.isFinite(time) && time > at;
    });
    if (insertionIndex < 0) result.push(entry);
    else result.splice(insertionIndex, 0, entry);
  }
  const insertAtTime = (entry: LeadTimelineItem & { at: number }) => {
    const insertionIndex = result.findIndex((item) => {
      const time = timelineItemTime(item, messagesById, turnsById, cardsById);
      return Number.isFinite(time) && time > entry.at;
    });
    if (insertionIndex < 0) result.push(entry);
    else result.splice(insertionIndex, 0, entry);
  };
  for (const reminder of options.reminders ?? []) {
    const at = Date.parse(reminder.at);
    if (!Number.isFinite(at)) continue;
    insertAtTime({ kind: 'reminder', key: `reminder:${reminder.key}`, reminderKey: reminder.key, at });
  }
  if (options.setupChecklist) {
    const at = Date.parse(options.setupChecklist.at);
    if (Number.isFinite(at)) insertAtTime({ kind: 'setup-checklist', key: options.setupChecklist.key, at });
  }
  for (const hint of options.setupHints ?? []) {
    const at = Date.parse(hint.at);
    if (Number.isFinite(at)) insertAtTime({ kind: 'setup-hint', key: hint.key, hintKey: hint.key, at });
  }
  const coalesced = coalesceLeadActivity(result);
  const grouped = options.failureGroupKey ? groupRepeatedFailures(coalesced, messagesById, options.failureGroupKey) : coalesced;
  const owned = groupOwnerActions(grouped, messagesById, (message) => (options.isOnBehalfOwnerAction?.(message) ? 'on_behalf'
    : options.isOwnOwnerAction?.(message) ? 'own' : null));
  const merged = options.isOutageNotice
    ? mergeOutageIncidents(owned, messagesById, options.isOutageNotice, options.failureGroupKey ?? (() => null))
    : owned;
  return options.now ? withDateDividers(merged, messagesById, turnsById, cardsById, options.now) : merged;
}

// 说过的事不进「Lead 动态」（2026-10-24）。线上 21:44 那一轮 Lead 对你说了 #117 的事，同一轮里记的 4 条处置
// 又在会话里画成一块（4 行一模一样）；21:45 一轮没说话，同一件事的后续又画了一块。现在：
//   1. Lead 处理一件事的时间落在它对你说了话的那一轮里（开始到结束；Lead 一次只跑一轮）：挂在那一轮下面。
//   2. 之后还没有新的对话（下一条消息之前），同一个对象（entityKey）的后续：也挂在那一轮下面。
// 只看 Lead 已经处理掉的（state 是 handled 或 seen）摘要和 Lead 处置；还没处理的、自动处理的、指令修改照旧进「Lead 动态」。
// 处理的时间：Lead 记的处置时间，没有时是卡片最后一次更新的时间（处置也会更新它）。
// 往 items 里的消息项写 activityIds，返回没挂上的卡片。在显示时算，所以以前的会话也一样。
function foldToldActivity(
  items: readonly LeadTimelineItem[],
  messagesById: ReadonlyMap<string, MessageEntity>,
  cards: readonly LeadActivityCard[],
): LeadActivityCard[] {
  const turns = items.flatMap((item) => {
    if (item.kind !== 'message') return [];
    const message = messagesById.get(item.messageId);
    const start = message ? Date.parse(message.createdAt) : Number.NaN;
    if (!message || !Number.isFinite(start)) return [];
    const end = message.state === 'streaming' || message.state === 'queued' ? Infinity : Date.parse(message.updatedAt);
    // 失败的回合可能被合进失败卡片或停摆卡片里，不在上面挂东西。
    const told = message.role === 'assistant' && message.state !== 'failed' && !message.failure;
    return [{ item, assistant: told, start, end, objects: new Set<string>() }];
  }).sort((left, right) => left.start - right.start);
  const handledAt = (card: LeadActivityCard) => Date.parse(card.lead?.at ?? card.updatedAt);
  const foldable = (card: LeadActivityCard) => (card.kind === 'lead' || card.kind === 'digest')
    && (card.state === 'handled' || card.state === 'seen') && Number.isFinite(handledAt(card));
  const left: LeadActivityCard[] = [];
  for (const card of [...cards].sort((a, b) => (handledAt(a) || 0) - (handledAt(b) || 0))) {
    const at = handledAt(card);
    const during = foldable(card) ? turns.find((turn) => turn.assistant && at >= turn.start && at <= turn.end) : undefined;
    const previous = foldable(card) && !during ? turns.filter((turn) => turn.start <= at).at(-1) : undefined;
    const host = during ?? (previous?.assistant && previous.objects.has(card.entityKey) ? previous : undefined);
    if (!host) {
      left.push(card);
      continue;
    }
    host.item.activityIds = [...(host.item.activityIds ?? []), card.key];
    host.objects.add(card.entityKey);
  }
  // 没挂上的照旧按位置排。
  return left.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// 一次停摆，一张卡片（2026-10-16）：兜底通知把紧挨着它的 Lead 失败回合（前后都算，中间没有别的对话）收进来；
// 同一次停摆的几条旧通知（以前每次汇总一条）也合成一张。停摆以后第一次成功的 Lead 回答是恢复的时间。
function mergeOutageIncidents(
  items: readonly LeadTimelineItem[],
  messagesById: ReadonlyMap<string, MessageEntity>,
  isNotice: (message: MessageEntity) => boolean,
  failureKey: (message: MessageEntity) => string | null,
): LeadTimelineItem[] {
  const failureIds = (item: LeadTimelineItem): string[] | null => {
    if (item.kind === 'failure-group' || item.kind === 'owner-action-group') return item.messageIds;
    if (item.kind !== 'message' || item.cardIds.length > 0) return null;
    const message = messagesById.get(item.messageId);
    return message && failureKey(message) !== null ? [item.messageId] : null;
  };
  const out: LeadTimelineItem[] = [];
  let open: Extract<LeadTimelineItem, { kind: 'incident' }> | null = null;
  for (const item of items) {
    const message = item.kind === 'message' ? messagesById.get(item.messageId) : undefined;
    if (message && item.kind === 'message' && isNotice(message)) {
      const absorbed: string[] = [];
      for (let ids = out.length ? failureIds(out.at(-1)!) : null; ids; ids = out.length ? failureIds(out.at(-1)!) : null) {
        out.pop();
        absorbed.unshift(...ids);
      }
      const previous = out.at(-1);
      if (previous?.kind === 'incident') {
        previous.noticeMessageIds.push(message.id);
        previous.failureMessageIds.push(...absorbed);
        open = previous;
        continue;
      }
      open = { kind: 'incident', key: `incident:${message.id}`, noticeMessageIds: [message.id], failureMessageIds: absorbed, recoveredAt: null };
      out.push(open);
      continue;
    }
    const ids = failureIds(item);
    if (open && ids) {
      open.failureMessageIds.push(...ids);
      continue;
    }
    if (item.kind !== 'lead-activity') open = null;
    out.push(item);
  }
  // 恢复的时间：卡片之后第一次成功的 Lead 回答。
  for (let index = 0; index < out.length; index += 1) {
    const incident = out[index]!;
    if (incident.kind !== 'incident') continue;
    for (const later of out.slice(index + 1)) {
      if (later.kind !== 'message') continue;
      const reply = messagesById.get(later.messageId);
      if (reply?.role === 'assistant' && reply.state === 'completed' && !reply.failure) {
        incident.recoveredAt = reply.updatedAt;
        break;
      }
    }
  }
  return out;
}

// 连着的 Lead 动态合成一块：中间没有对话，就是同一段时间里 Lead 安静处理掉的几件事。
function coalesceLeadActivity(items: readonly LeadTimelineItem[]): LeadTimelineItem[] {
  const merged: LeadTimelineItem[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (item.kind === 'lead-activity' && previous?.kind === 'lead-activity') {
      merged[merged.length - 1] = { ...previous, ids: [...previous.ids, ...item.ids], at: item.at };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

// 会话里画的一行。连着的外部消息卡（中间没有别的东西）合成一组，画成一张列表（2026-10-21）。
export type LeadConversationRow =
  | Exclude<LeadTimelineItem, { kind: 'channel-card' }>
  | { kind: 'channel-cards'; key: string; cardIds: number[] };

export function groupChannelCardRuns(items: readonly LeadTimelineItem[]): LeadConversationRow[] {
  const rows: LeadConversationRow[] = [];
  for (const item of items) {
    if (item.kind !== 'channel-card') {
      rows.push(item);
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === 'channel-cards') previous.cardIds.push(item.cardId);
    else rows.push({ kind: 'channel-cards', key: item.key, cardIds: [item.cardId] });
  }
  return rows;
}

// 日期变了插一条分隔线。用的是每一项显示的那个时间（timelineItemTime），排序也按它。
function withDateDividers(
  items: readonly LeadTimelineItem[],
  messagesById: ReadonlyMap<string, MessageEntity>,
  turnsById: ReadonlyMap<string, LeadTurnEntity>,
  cardsById: ReadonlyMap<string, ConversationCardEntity>,
  now: Date,
): LeadTimelineItem[] {
  const withDividers: LeadTimelineItem[] = [];
  let previousDay: string | null = null;
  for (const item of items) {
    const time = timelineItemTime(item, messagesById, turnsById, cardsById);
    if (Number.isFinite(time)) {
      const date = new Date(time);
      const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      if (day !== previousDay) {
        withDividers.push({ kind: 'date', key: `date:${day}`, label: formatConversationDate(date.toISOString(), now) });
        previousDay = day;
      }
    }
    withDividers.push(item);
  }
  return withDividers;
}

// 每次心跳巡检都失败时，会话里不该一次一个红框：相邻、同一个键的失败合成一项，写次数和最近一次。
// 中间隔着别的东西（用户说了话、来了一张卡片）就不合并：那是两件事。
function groupRepeatedFailures(
  items: readonly LeadTimelineItem[],
  messagesById: ReadonlyMap<string, MessageEntity>,
  keyOf: (message: MessageEntity) => string | null,
): LeadTimelineItem[] {
  const grouped: LeadTimelineItem[] = [];
  let previousKey: string | null = null;
  for (const item of items) {
    const message = item.kind === 'message' && item.cardIds.length === 0 ? messagesById.get(item.messageId) : undefined;
    const key = message ? keyOf(message) : null;
    const previous = grouped[grouped.length - 1];
    if (key !== null && key === previousKey && item.kind === 'message'
      && (previous?.kind === 'message' || previous?.kind === 'failure-group')) {
      const messageIds = previous.kind === 'failure-group' ? previous.messageIds : [previous.messageId];
      grouped[grouped.length - 1] = {
        kind: 'failure-group', key: `failures:${messageIds[0]}`, messageIds: [...messageIds, item.messageId],
      };
    } else {
      grouped.push(item);
    }
    previousKey = key;
  }
  return grouped;
}

// 一句话促成几件事时，Lead 代你做的那几次操作连着贴进会话：合成一项（画布「代你操作」状态 5）。
// 你在这个客户端上连着做的几件事也合成一行（2026-10-28 改版稿第 1 组：三条权限设置的记录合成一行）。
// 中间隔着别的东西（你又说了话、Lead 回了一句、来了一张卡）就不合并：那是另一句话促成的。两种不混在一起。
function groupOwnerActions(
  items: readonly LeadTimelineItem[],
  messagesById: ReadonlyMap<string, MessageEntity>,
  modeOf: (message: MessageEntity) => 'on_behalf' | 'own' | null,
): LeadTimelineItem[] {
  const grouped: LeadTimelineItem[] = [];
  let previousMode: 'on_behalf' | 'own' | null = null;
  for (const item of items) {
    const message = item.kind === 'message' ? messagesById.get(item.messageId) : undefined;
    const mode = message !== undefined ? modeOf(message) : null;
    const previous = grouped[grouped.length - 1];
    if (mode !== null && mode === previousMode && item.kind === 'message'
      && (previous?.kind === 'message' || previous?.kind === 'owner-action-group')) {
      const messageIds = previous.kind === 'owner-action-group' ? previous.messageIds : [previous.messageId];
      grouped[grouped.length - 1] = {
        kind: 'owner-action-group', key: `owner-actions:${messageIds[0]}`, messageIds: [...messageIds, item.messageId],
        ...(mode === 'own' ? { own: true } : {}),
      };
    } else {
      grouped.push(item);
    }
    previousMode = mode;
  }
  return grouped;
}

export function filterLeadTimelineCards(
  cards: readonly ConversationCardEntity[],
  turnsById: Readonly<Record<string, LeadTurnEntity | undefined>>,
): ConversationCardEntity[] {
  return cards.filter((card) => {
    if (!card.turnId) return true;
    const turn = turnsById[card.turnId];
    return turn === undefined || turn.ticketId === null;
  });
}

function compareTimelineItemTime(
  left: LeadTimelineItem,
  right: LeadTimelineItem,
  messagesById: ReadonlyMap<string, MessageEntity>,
  turnsById: ReadonlyMap<string, LeadTurnEntity>,
  insertionOrder: ReadonlyMap<string, number>,
): number {
  const leftTime = timelineItemTime(left, messagesById, turnsById);
  const rightTime = timelineItemTime(right, messagesById, turnsById);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return (insertionOrder.get(left.key) ?? 0) - (insertionOrder.get(right.key) ?? 0);
}

// 一项在会话里的时间：排序用它，气泡上显示的也是它。
// 消息用 updatedAt：一轮重试过的通知播报 19:07 开始、20:28 才又失败，气泡写 20:28，就得排在 20:28
// （以前按 createdAt 排，它跑到了 19:12 的系统通知上面）。回执是用户发消息的那一刻，卡片是它写下的那一刻。
function timelineItemTime(
  item: LeadTimelineItem,
  messagesById: ReadonlyMap<string, MessageEntity>,
  turnsById: ReadonlyMap<string, LeadTurnEntity>,
  cardsById?: ReadonlyMap<string, ConversationCardEntity>,
): number {
  if (item.kind === 'message') return Date.parse(messagesById.get(item.messageId)?.updatedAt ?? '');
  if (item.kind === 'ticket-direct') return Date.parse(turnsById.get(item.turnId)?.createdAt ?? '');
  if (item.kind === 'failure-group' || item.kind === 'owner-action-group') {
    return Date.parse(messagesById.get(item.messageIds.at(-1)!)?.updatedAt ?? '');
  }
  if (item.kind === 'incident') {
    return Math.max(...[...item.noticeMessageIds, ...item.failureMessageIds]
      .map((id) => Date.parse(messagesById.get(id)?.updatedAt ?? '')).filter(Number.isFinite));
  }
  if (item.kind === 'card') return Date.parse(cardsById?.get(item.cardId)?.createdAt ?? '');
  if (item.kind === 'lead-activity' || item.kind === 'channel-card') return item.at;
  if (item.kind === 'reminder' || item.kind === 'setup-checklist' || item.kind === 'setup-hint') return item.at;
  return Number.NaN;
}

export type LeadFooterItem = {
  ticketId: number;
  // 运行中的工单是「启动中」「运行中」；需要你的工单是共用规则给的原因（例如「核查未派发」）。
  stateLabel: string;
  tone: 'running' | 'attention';
  progressPercent: number | null;
};

export function buildLeadFooterItems(
  tickets: readonly TicketSummary[],
  workItems: readonly KernelTicketWorkItemV2[],
): LeadFooterItem[] {
  const workItemsByTicket = new Map(workItems.map((item) => [item.ticketId, item]));
  return tickets.flatMap((ticket): LeadFooterItem[] => {
    // 「需要处理」和「执行中」都用共用规则（protocol 的 ticketNeedsUser、ticketTurn），
    // 和工单 tab 的分组、导航角标是同一个数。以前这里自己判断「执行中」：只看 active 加运行中的 Run，
    // 而工单 tab 把 ready 也算进去，于是一边写「执行中 0」，一边写「进行中 6」。
    const turn = ticketTurn(ticket);
    const needsUser = ticketNeedsUser(ticket);
    if (turn === 'user' && needsUser) {
      return [{
        ticketId: ticket.id, stateLabel: ticketNeedsUserLabel(needsUser), tone: 'attention', progressPercent: null,
      } satisfies LeadFooterItem];
    }
    // 在跑的子工单不列：工单 tab 也只列根工单。
    if (turn !== 'running' || ticket.parentTicketId != null) return [];
    const workItem = workItemsByTicket.get(ticket.id);
    return [{
      ticketId: ticket.id,
      stateLabel: ticket.runtime.state === 'starting' ? '启动中' : '运行中',
      tone: 'running',
      progressPercent: workItem?.progress?.percent ?? null,
    } satisfies LeadFooterItem];
  });
}

function compareConversationCards(left: ConversationCardEntity, right: ConversationCardEntity): number {
  const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (Number.isFinite(createdDifference) && createdDifference !== 0) return createdDifference;
  if (left.durableId !== null && right.durableId !== null && left.durableId !== right.durableId) {
    return left.durableId - right.durableId;
  }
  return left.id.localeCompare(right.id, undefined, { numeric: true });
}

function buildMessagePartSuppressions(cards: readonly ConversationCardEntity[]) {
  const ticketIdsByTurn: Record<string, number[]> = {};
  const approvalIdsByTurn: Record<string, number[]> = {};
  for (const card of cards) {
    if (!card.turnId) continue;
    if (card.kind === 'ticket_execution') {
      ticketIdsByTurn[card.turnId] = [...(ticketIdsByTurn[card.turnId] ?? []), card.ticketId];
    } else if (card.kind === 'intervention' && card.interventionId.startsWith('approval:')) {
      approvalIdsByTurn[card.turnId] = [
        ...(approvalIdsByTurn[card.turnId] ?? []),
        Number(card.interventionId.slice('approval:'.length)),
      ];
    }
  }
  return { ticketIdsByTurn, approvalIdsByTurn };
}

// 日期和时间的格式化在 conversationTime.ts（纯函数，设置页的模型也用；那边的测试在 node 环境跑，不能引这个 .tsx）。
export { formatConversationDate, formatConversationTime } from './conversationTime';
import { formatConversationDate, formatConversationTime } from './conversationTime';

// 会话里最新的一条 Lead 消息（主题 F-5）：从后往前找第一条助手消息，跳过 daemon 写的系统通知（它们不加 Fairy）。
// 只有它的 Fairy 用彩色、会动，一屏上动的 Fairy 只表示「现在」（P12.8）。
export function latestLeadMessage<M extends Pick<MessageEntity, 'role' | 'turnId'>>(
  rows: readonly LeadConversationRow[],
  messagesById: Readonly<Record<string, M | undefined>>,
  isSystemNotice: (message: M) => boolean,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== 'message') continue;
    const message = messagesById[row.messageId];
    if (message?.role === 'assistant' && !isSystemNotice(message)) return row.messageId;
  }
  return null;
}

// 这一轮没有 Lead 那一侧（主题 11.13）：还排着的追问（Lead 还没开始答它），和你取消了的追问（Lead 不会答它）。
// 会话里只有你的那句话，下面写「排队中」或「已取消」；也不算最新一条 Lead 消息。
export function isWithoutLeadSide(turn: Pick<LeadTurnEntity, 'placement' | 'state'>): boolean {
  return turn.placement === 'cancelled' || (turn.placement === 'queued' && turn.state === 'queued');
}

// 消息头前面的 Lead 形象（主题 F-5）。单独一个组件：消息的组件里有提前返回，hook 不能放在那里。
function MessageLeadAvatar({ name, latest, replying }: { name: string; latest: boolean; replying: boolean }) {
  const look = { tone: latest ? 'color' : 'muted', state: latest && replying ? 'thinking' : 'idle' } as const;
  const source = useLeadAvatarSource(look);
  return <LeadAvatar testID="message-fairy" size={18} name={name} tone={look.tone} state={look.state} source={source} />;
}
