import { Density } from '@pi-lead-child/components';
import {
  AbsenceTail, Box, Button, Card, ChatList, Column, ConversationColumn, Dot, Icon, IconButton, ImageThumbnail, ImageViewer, KeyboardArea, LeadAvatar, MessageBubble, NoticeRow,
  Pressable, Row,
  Spacer,
  Text,
} from '@pi-lead-child/components';
import {
  blockerNoticeTicketId, CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, CHAT_TURN_MODEL_CAPABILITY, leadModelSpec, type LeadModelChoice, CHAT_PLACEMENT_CAPABILITY, CHAT_PLACEMENT_PREFERENCE_CAPABILITY, type ChatImageInput, type ChatQuoteInput, CHAT_QUOTES_CAPABILITY, type ChatFile, type ChatFileInput, isDaemonNoticeOrigin, isLeadRestartInterruption, isSystemTurnOrigin,
  ownerActionRefOfTurn, SYSTEM_TURN_ORIGINS, ticketNeedsUser,
  ticketNeedsUserLabel, ticketTurn, type ChatPlacement, type KernelTicketWorkItemV2,
  type ChannelCardDto,
  type LeadActivityCard, type ReminderCard, type SetupChecklistCard, type SetupHintCard,
  type TicketSummary,
  type TopicDto,
  type ChatQuoteSource,
  validateUiSurface,
} from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { ticketsNeedingUser } from '@pi-lead-child/protocol';

import { useLocale, useMessages, type Locale } from '@/i18n';

import { conversationMessages } from './conversation.messages';
import { placementCopyFor, steeredNoticeFor } from './steeredNotice';
import { assistantMessageHasContent } from './assistantContent';
import { leadSenderLabel, systemNoticeLabel } from './senderLabel';
import { splitMaintenanceNotice } from './maintenanceNotice';
import { LeadIdentity } from '../../components/LeadIdentity';
import { HomeDrawer } from '../home/HomeDrawer';
import { HomeTopBar } from '../home/HomeTopBar';
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
  useTopics,
  useTopicsSupported,
  useTurn,
  useTurnIds,
  useWorkItems,
} from '../../state/hooks';
import type { ConversationCardEntity, LeadTurnEntity, MessageEntity, MessagePart } from '../../state/types';
import { QuoteBlock } from './QuoteViews';
import { FileChip } from './FileChip';
import { fileMessages } from './file.messages';
import { presentChatFile } from '@/data/chatFileOpen';
import { QuoteJumpContext, useQuoteJump, type QuotePartForJump } from './quoteNavigation';
import { quoteDrafts } from './quoteDrafts';
import { flashQuote } from './quoteFlash';
import { QuoteSource } from './QuoteSource';
import { SelectionReplyLayer } from './SelectionReplyLayer';
import { TopicAutoOpen, TopicConcludedRow, TopicOpenedLine, TopicSeenBaseline, TurnTopicLinks } from '@/features/topics/TopicReferences';
import { useOpenTopic } from '@/features/topics/useOpenTopic';
import { QuoteGesturesContext } from './quoteSources';
import { RESOURCE_KEYS } from '../../state/types';

import { CheckpointCard } from './CheckpointCard';
import { ConversationDateDivider } from './ConversationDateDivider';
import { FailureCard } from './FailureCard';
import { presentOutage } from './outagePresentation';
import { failureActionLabels, presentTurnFailure, turnFailureGroupKey, type FailureAction } from './failurePresentation';
import { InterventionCard } from './InterventionCard';
import {
  LeadModelResendLink, leadModelTriggerText, TurnModelChip, useModelAccounts,
} from './LeadModelPicker';
import { compactErrorNotice, compactNotice } from './compactCommand';
import { LeadComposerDock } from './LeadComposerDock';
import { useConversationScope } from './conversationScope';
import type { MessageComposerHandle } from './MessageComposer';
import { AssistantTurnView } from './AssistantTurnView';
import { MessagePartView } from './MessagePartView';
import { MarkdownMessage } from './MarkdownMessage';
import { TicketExecutionConversationCard } from './ConversationTicketCard';
import { TurnCardGroupView } from './TurnCardGroupView';
import { groupTurnCards, TURN_CARD_GROUP_MIN, type TurnCardSlot } from './turnCardGroups';
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
import { ChannelCardSlot, ChannelNewsLine } from './ChannelMessageCard';
import { ChannelStackSlot } from './ChannelStackRow';
import { stackChannelConversations, type ChannelStackItem } from './channelStack';
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
  const locale = useLocale();
  const m = conversationMessages(locale);
  // 「当前工单」是桌面上开着详情的那一张。详情关上以后选中还留着，但它不再是当前工单：顶栏不写，
  // 会话里的卡片也不按它写「其他工单」（2026-10-16）。手机上会话和工单详情不同时出现。
  const threadOpen = useWorkspaceStore((state) => state.threadOpen);
  const openTicketId = useWorkspaceStore((state) => state.selectedTicketId);
  const selectedTicketId = !compact && threadOpen ? openTicketId : null;
  const selectedTicket = selectedTicketId === null ? undefined : tickets.find((ticket) => ticket.id === selectedTicketId);
  // 手机首页（主题 11.20）：抽屉开没开，和等你的工单（和角标、收件箱同一条规则，ticketNeedsUser）。
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const composerRef = useRef<MessageComposerHandle | null>(null);
  const waiting = useMemo(() => ticketsNeedingUser(tickets), [tickets]);
  const setTicketFilter = useWorkspaceStore((state) => state.setTicketFilter);
  const openWaiting = () => {
    setTicketFilter('todo');
    router.push('/tickets');
  };
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
  // 你发的最后一条消息。它变了，说明你刚发了消息：列表回到底部（ChatList 的 followKey）。
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
  // Topics (features/topics): the list gives the lines that point at them in this conversation.
  const topics = useTopics();
  const timeline = useMemo(
    () => buildLeadTimeline(messages, leadCards, directTicketTurns, {
      // 只有失败、没有内容的 Lead 主动回合才合并（例如每次心跳巡检一个 503）。
      now: new Date(),
      locale,
      leadActivity,
      channelCards: timelineChannelCards,
      reminders,
      reminderTurnIds,
      setupChecklist,
      setupHints,
      topics,
      isPendingTurn: (turnId) => {
        const turn = turnsById[turnId];
        return turn !== undefined && isUndeliveredTurn(turn);
      },
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
    [carriedOwnerActionIds, currentBindingId, directTicketTurns, leadActivity, leadCards, locale, messagePartsById, messages, partIdsByMessage, reminderTurnIds, reminders, setupChecklist, setupHints, timelineChannelCards, topics, turnsById],
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
  const footerItems = useMemo(() => buildLeadFooterItems(tickets, workItems, locale), [locale, tickets, workItems]);
  const runningFooterCount = hydrated ? footerItems.filter((item) => item.tone === 'running').length : 0;

  // Lead 正忙时，这条消息插话还是排队（工单 04，spec D6）。daemon 支持时才给选：旧 daemon 只会插话。
  const leadBusy = useLeadBusy();
  const canPlace = useControlPlaneStore((state) => state.capabilities.includes(CHAT_PLACEMENT_CAPABILITY));
  const [placement, setPlacement] = useState<ChatPlacement>('steer');
  // daemon 支持排着的追问上的 Steer 和取消时（主题 11.13，2026-10-28）：发送前不再选「插话 / 排队」，
  // Lead 忙时发出的话一律先排队，排着的事都在输入卡片上半截的状态栏里，想马上插进这一轮就点那一条的 Steer。
  const canSteerQueued = useControlPlaneStore((state) => state.capabilities.includes(CHAT_FOLLOW_UP_ACTIONS_CAPABILITY));
  const queueTray = useComposerQueueTray({ leadName, actions: canSteerQueued });
  // 输入框和它周围的东西（留白、图片和文件、模型名和换模型的浮层、/model、手机上的加号面板）在 LeadComposerDock 里：
  // 主会话和话题面板画的是同一个组件。这里只给主会话自己的那几样。
  // Lead 现在用的模型。只订阅模型这一项：订阅整个 overview 时，Lead 降级重试一次，整个会话就重画一次（2026-11-14）。
  const leadModel = useControlPlaneStore((state) => state.overview?.model);
  const modelAccounts = useModelAccounts();
  // 「只这一条」（D8）：下一条消息用的单轮模型。daemon 宣布了 chat.turn-model.v1 才有。
  const canTurnModel = useControlPlaneStore((state) => state.capabilities.includes(CHAT_TURN_MODEL_CAPABILITY));
  const [turnModel, setTurnModel] = useState<LeadModelChoice | null>(null);
  // daemon 按「Lead 忙时你发的消息」的设置放没带 mode 的消息时（设置 → Lead → 身份与风格，主题 11.13、11.19，用户 2026-11-09），
  // 输入框不再带 mode，交给 daemon；没有这个能力的旧 daemon 照旧一律排队。输入框上有「插话 / 排队」可选时，照你选的发。
  const placesByPreference = useControlPlaneStore((state) => state.capabilities.includes(CHAT_PLACEMENT_PREFERENCE_CAPABILITY));
  // 不看连接：消息先进本机发件箱，断线时显示「连接恢复后发送」，连上以后按顺序发出（2026-10-16）。
  // 引用回复（设计规范 P17）：daemon 收引用时（chat.quotes.v1）才能引用。
  const canQuote = useControlPlaneStore((state) => state.capabilities.includes(CHAT_QUOTES_CAPABILITY));
  const send = (message: string, images: ChatImageInput[], quotes?: ChatQuoteInput[], files?: ChatFileInput[]) => {
    const mode = canPlace && leadBusy ? (canSteerQueued ? (placesByPreference ? undefined : 'followUp') : placement) : undefined;
    const once = canTurnModel ? turnModel : null;
    setTurnModel(null);
    const sent = files?.length
      ? runtime.sendChat(message, undefined, mode, images.length ? images : undefined, once ?? undefined, quotes?.length ? quotes : undefined, files)
      : quotes?.length
      ? runtime.sendChat(message, undefined, mode, images.length ? images : undefined, once ?? undefined, quotes)
      : once
      ? runtime.sendChat(message, undefined, mode, images.length ? images : undefined, once)
      : images.length ? runtime.sendChat(message, undefined, mode, images) : runtime.sendChat(message, undefined, mode);
    void sent.catch(() => {});
  };
  // "Side chat" on a selected text (features/topics, P18): open a topic from it, then open its panel. The same
  // operation as Lead's open_topic. The topic's own session writes the opening while the panel is already open.
  const topicsSupported = useTopicsSupported();
  const openTopicPanel = useOpenTopic();
  const openSideTopic = useCallback((source: Extract<ChatQuoteSource, { kind: 'turn' }>, text: string) => {
    runtime.openTopic({ quote: { source, text } })
      .then((topic) => { if (topic) openTopicPanel(topic.id); })
      .catch((reason: unknown) => { console.warn('[topics] could not open a topic from the selection', reason); });
  }, [openTopicPanel, runtime]);
  // 引用浮层里按 ⌘Enter 或发送钮：托盘里的和这一段一起马上发出，正文是空的（说明就是你要说的话，P17.5）。
  const sendQuotesNow = () => {
    const quotes = quoteDrafts.getState().take();
    if (quotes.length) send('', [], quotes);
  };
  // 跳回引用的原文（P17.7、P17.8、Q-9）：先在画出来的页面里找；不在时让列表滚到那一块；还没加载的先往上加载。
  // 手机上右滑、长按一段开始引用以后：聚焦输入框、弹出键盘（P17.10）。
  const quoteGestures = useMemo(() => ({ onBegin: () => composerRef.current?.focus() }), []);
  const jumpRef = useRef<((key: string) => boolean) | null>(null);
  const loadOlderRef = useRef<(() => Promise<unknown> | undefined) | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const jumpToQuote = useCallback((quote: QuotePartForJump) => {
    if (flashQuote(quote.source, quote.text, quote.anchor)) return;
    const rowKey = () => rowsRef.current.find((row) => (quote.source.kind === 'turn'
      ? row.kind === 'message' && row.messageId.endsWith(`:${quote.source.turnId}:${quote.source.role}`)
      : row.kind === 'channel-cards' && row.cardIds.includes(quote.source.cardId)))?.key ?? null;
    let attempts = 0;
    const tryJump = () => {
      const key = rowKey();
      if (key && jumpRef.current?.(key)) {
        // 列表滚过去、那一块画出来以后再闪。
        setTimeout(() => flashQuote(quote.source, quote.text, quote.anchor), 400);
        return;
      }
      if (attempts++ >= 5) return;
      void Promise.resolve(loadOlderRef.current?.()).then(() => setTimeout(tryJump, 200));
    };
    tryJump();
  }, []);
  const loadOlderConversationCards = async () => {
    if (!connected || historyRequest.loading) return;
    setHistoryRequest({ loading: true, error: null });
    try {
      await runtime.loadOlderConversationCards();
      setHistoryRequest({ loading: false, error: null });
    } catch (error) {
      setHistoryRequest({
        loading: false,
        error: error instanceof Error ? error.message : m.history.unavailable,
      });
    }
  };
  // 更早的消息（2026-11-04）：轮次只取了最近一段，往上滚到头时一页一页取；会话卡片也有自己的一页一页。
  // 往上滚到头时两样都取。上一次没取到时不自己重试，等你点「重试」。
  const turnHistory = useControlPlaneStore((state) => state.conversationHistory);
  const olderAvailable = Boolean(conversationCardPage?.hasMore) || turnHistory.hasMore;
  const olderLoading = historyRequest.loading || turnHistory.loading;
  const olderError = historyRequest.error ?? turnHistory.error;
  const loadOlder = (retry = false) => {
    if (!connected) return;
    if (turnHistory.hasMore && (retry || !turnHistory.error)) void runtime.loadOlderConversationTurns();
    if (conversationCardPage?.hasMore && (retry || !historyRequest.error)) void loadOlderConversationCards();
  };
  // 跳回引用的原文时往上加载一页（jumpToQuote）：等它加载完再找。
  loadOlderRef.current = () => {
    if (!connected) return undefined;
    if (turnHistory.hasMore) return runtime.loadOlderConversationTurns();
    if (conversationCardPage?.hasMore) return loadOlderConversationCards();
    return undefined;
  };

  // 一块要画的东西都在 rowContext 里：它变了，看得见的块重画（ChatList 的 extraData）。
  const rowContext = useMemo(() => ({
    cardsById, collapsedCardIds, compact, firedReminderIds, latestLeadMessageId, messagesById, selectedTicketId, suppressions,
    windows: folded.windows,
  }), [cardsById, collapsedCardIds, compact, firedReminderIds, folded.windows, latestLeadMessageId, messagesById, selectedTicketId, suppressions]);
  // 两边留白在手机和桌面上都是 16：会话栏窄时内容列占满减留白，宽时内容列最宽 700、居中（2026-10-16）。
  // 一个内容列（2026-10-16）：Lead 一侧所有的块在这一列里，宽度一致；你的气泡靠右，按这一列的 70% 定宽。
  // 虚拟列表里每一块各有一个同样的列（2026-11-04）。块和块之间是语义间距 conversation-block（ChatList 的间隔）。
  const renderRow = (item: LeadConversationRow) => (
    <Box px="page-x">
      <ConversationColumn>
        <ConversationRowView item={item} context={rowContext} />
      </ConversationColumn>
    </Box>
  );
  const headerRows = [
    hydrated && !connected ? (
      <Row
        key="cached"
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
        <Text size="11" weight="semibold" tone="secondary">{m.cached}</Text>
      </Row>
    ) : null,
    hydrated && (olderAvailable || olderLoading || olderError) ? (
      <Column key="history" items="center" gap="card-row">
        {olderError ? (
          <Text size="secondary" tone="danger-dark" align="center">{m.history.failed(olderError)}</Text>
        ) : null}
        <Button
          disabled={!connected || olderLoading || !olderAvailable}
          label={olderLoading ? m.history.loading : olderError ? m.history.retry : m.history.load}
          onPress={() => loadOlder(true)}
          testID={olderLoading ? 'conversation-history-loading' : 'conversation-history-load'}
          variant="outline"
          tone="neutral"
          shape="pill"
          size="sm"
        />
      </Column>
    ) : null,
  ].filter(Boolean);
  const listHeader = (
    // spacing-exempt: 会话流上下的留白，手机 18、桌面 24（和以前的 py 一样）
    <Column px="page-x" pt={compact ? 18 : 24}>
      {headerRows.length ? <Column gap="conversation-block" pb="conversation-block">{headerRows}</Column> : null}
    </Column>
  );

  // 会话按外观偏好里会话区域的密度（缺省标准）。
  return (
    <QuoteJumpContext.Provider value={canQuote ? jumpToQuote : null}>
    <QuoteGesturesContext.Provider value={canQuote && compact ? quoteGestures : null}>
    <Density zone="conversation"><KeyboardArea testID="lead-conversation" bg={compact ? 'page' : 'surface'}>
      {/* 手机上没有顶栏，是两颗悬浮圆钮（主题 11.20 H-2，2026-11-14 方案 F）。 */}
      {compact ? (
        <HomeTopBar waitingCount={waiting.length} onOpenMenu={() => setMenuOpen(true)} onOpenWaiting={openWaiting} />
      ) : (
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
            <Text size="eyebrow" weight="bold" tone="secondary">{m.header.currentTicket}</Text>
            <Box aria-label={selectedTicket.title}>
              <Text size="card-title" weight="extrabold" numberOfLines={1}>{m.header.currentTicketTitle(selectedTicket.id)}</Text>
            </Box>
            <Text size="secondary" weight="semibold" tone="secondary">{ticketSummaryToTicket(selectedTicket, undefined, locale).statusLabel}</Text>
          </Column>
        ) : null}
        <Spacer />
        {/* 执行中 N：原来在输入框上方那一行，和左栏的「在执行」是同一个数（ticketTurn）。不带图标：split 图标和旁边的侧栏按钮像。 */}
        {hydrated ? (
          <Row testID="lead-running-count" items="center" gap="icon-label" shrink={0} aria-label={m.header.runningCount(runningFooterCount)}>
            <Text size="label" weight="semibold" tone="strong">{m.header.running}</Text>
            <Text size="label" weight="semibold" tone="strong" mono>{String(runningFooterCount)}</Text>
          </Row>
        ) : null}
        <WebUpdateNotice compact={compact} />
        {!railOpen && onOpenRail ? (
          <IconButton icon="sidebar" label={m.header.openWorkList} onPress={onOpenRail} size="lg" />
        ) : null}
        {compact && onOpenAll ? (
          <IconButton icon="sidebar" label={m.header.openWorkspace} onPress={onOpenAll} size="lg" iconSize={19} badge />
        ) : null}
        {/* 视图（主题 11.14 第 7 项）：最右边。面板开着时是选中态（I-6：图标变成强调色）。 */}
        {onToggleViews ? (
          <IconButton
            testID="views-toggle"
            icon="views"
            label={viewsOpen ? m.header.hideViews : m.header.showViews}
            onPress={onToggleViews}
            size="lg"
            iconColor={viewsOpen ? 'accent' : undefined}
          />
        ) : null}
      </Row>
      )}

      {/* 会话流（ChatList，2026-11-04 换成 Legend List，只画看得见的块）：打开时落在最底下；贴底时跟随新消息和流式输出；
          你往上翻时不拽回来，只给「新消息 ↓」；你发了消息就回到底部；往上滚到头时取更早的消息。
          内容不满一屏时照旧从上往下排（空会话的提示要居中）。 */}
      <ChatList
        key={sessionId ?? 'no-session'}
        testID="lead-conversation-scroll"
        data={hydrated ? rows : NO_ROWS}
        keyExtractor={conversationRowKey}
        renderItem={renderRow}
        extraData={rowContext}
        followKey={lastUserMessageId}
        bottomAligned={false}
        onStartReached={loadOlder}
        jumpRef={jumpRef}
        header={listHeader}
        // spacing-exempt: 会话流上下的留白，手机 18、桌面 24（和以前的 py 一样）
        footer={<Box pb={compact ? 18 : 24} />}
        empty={hydrated
          ? <EmptyConversation title={m.empty.title} body={m.empty.body(leadName)} />
          : <EmptyConversation title={m.empty.notConnectedTitle(leadName)} body={m.empty.notConnectedBody(leadName)} />}
      />

      {/* 输入框（LeadComposerDock）：和会话同样的内容列，同样的留白、同样最宽 700、同样居中，左右边和上面的对话对齐。
          原来输入框上方那一行「执行中 · 需要处理 + 工单标签 + 查看全部」去掉了（方案 C，主题 11.14）：
          执行中挪到顶栏，要你处理的事在左栏的收件箱里，排着的事在输入框上的状态栏里。 */}
      <LeadComposerDock
        compact={compact}
        contextKey="lead"
        // 提示只写一句话，不解释输入框能做什么（2026-10-15 方案 A：不要冗余的文字提示）。
        // 断线时也能写：消息存在本机，连接恢复后发送。
        placeholder={connected ? m.composer.placeholder(leadName) : m.composer.offline}
        onSend={send}
        model={leadModel}
        picker={{ onTurnModel: setTurnModel }}
        composerRef={composerRef}
        // interrupt 级的事（工单 06，spec D10）：输入框上方的横幅，用户点「知道了」之前一直在。
        above={<InterruptBanner />}
        composer={{
          quotes: canQuote,
          ...(topicsSupported ? { onSideTopic: openSideTopic } : {}),
          // /compact [provider/id] [instructions]: compact Lead's context; this text does not go to Lead.
          onCompactCommand: (request) => runtime.compactLeadContext(request).then(
            (result) => compactNotice(result, locale),
            (error: unknown) => compactErrorNotice(error, locale),
          ),
          chip: canTurnModel && turnModel ? (
            <TurnModelChip text={leadModelTriggerText(leadModelSpec(turnModel), modelAccounts, locale) ?? turnModel.model} onRemove={() => setTurnModel(null)} />
          ) : null,
          // 新 daemon：排着的事在输入卡片上半截的状态栏里（主题 11.13）。
          // 旧 daemon（没有 Steer 和取消）：照旧在发送前选「插话/排队」，排着的外部消息在那一行的右边（工单 10）。
          ...(canSteerQueued
            ? { tray: queueTray }
            : canPlace && leadBusy ? { placement: { value: placement, onChange: setPlacement }, placementStatus: <LeadQueueBar /> } : {}),
        }}
      />
      {compact ? (
        <HomeDrawer
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          waiting={waiting}
          onOpenWaiting={openWaiting}
        />
      ) : null}
      {/* 桌面上的选字回复（设计规范 P17、主题 Q-1–Q-3）：画在页面最上层，不占会话列表的位置。手机上从右滑和长按开始。 */}
      <SelectionReplyLayer enabled={canQuote && !compact} onSendNow={sendQuotesNow} {...(topicsSupported ? { onSideTopic: openSideTopic } : {})} />
      <TopicSeenBaseline />
      <TopicAutoOpen />
    </KeyboardArea></Density>
    </QuoteGesturesContext.Provider>
    </QuoteJumpContext.Provider>
  );
}

const NO_ROWS: LeadConversationRow[] = [];
const conversationRowKey = (row: LeadConversationRow) => row.key;

type ConversationRowContext = {
  cardsById: Record<string, ConversationCardEntity>;
  collapsedCardIds: ReadonlySet<string>;
  compact: boolean;
  firedReminderIds: readonly number[];
  latestLeadMessageId: string | null;
  messagesById: Record<string, MessageEntity>;
  selectedTicketId: number | null;
  suppressions: ReturnType<typeof buildMessagePartSuppressions>;
  windows: Record<string, DispatchWindow>;
};

// 会话流里的一块（ChatList 的一项）。
function ConversationRowView({ item, context }: { item: LeadConversationRow; context: ConversationRowContext }) {
  const { cardsById, collapsedCardIds, compact, firedReminderIds, latestLeadMessageId, messagesById, selectedTicketId, suppressions, windows } = context;
  if (item.kind === 'channel-cards') {
    // 连着的几张外部消息卡是一张列表，卡和卡之间是 list-row（2026-10-21）。
    return (
      <Column testID="channel-card-run" w="100%" gap="list-row">
        {item.slots.map((slot) => ('kind' in slot
          ? <ChannelStackSlot key={slot.key} cardIds={slot.cardIds} entries={slot.entries} />
          : <ChannelCardSlot key={slot.cardId} cardId={slot.cardId} />))}
      </Column>
    );
  }
  if (item.kind === 'message') {
    const turnId = messagesById[item.messageId]?.turnId ?? '';
    return (
      <ConversationMessage
        latest={item.messageId === latestLeadMessageId}
        cardIds={item.cardIds}
        activityIds={item.activityIds}
        cardsById={cardsById}
        collapsedCardIds={collapsedCardIds}
        compact={compact}
        dispatchScopes={windows}
        messageId={item.messageId}
        selectedTicketId={selectedTicketId}
        suppressedApprovalIds={suppressions.approvalIdsByTurn[turnId]}
        suppressedTicketIds={[...(suppressions.ticketIdsByTurn[turnId] ?? []), ...firedReminderIds]}
      />
    );
  }
  if (item.kind === 'ticket-direct') return <TicketDirectNotice compact={compact} turnId={item.turnId} />;
  if (item.kind === 'failure-group') return <FailureGroup messageIds={item.messageIds} />;
  if (item.kind === 'owner-action-group') return <OwnerActionGroup messageIds={item.messageIds} own={item.own === true} />;
  if (item.kind === 'incident') {
    return <IncidentCard noticeMessageIds={item.noticeMessageIds} failureMessageIds={item.failureMessageIds} recoveredAt={item.recoveredAt} />;
  }
  if (item.kind === 'date') return <ConversationDateDivider label={item.label} />;
  if (item.kind === 'lead-activity') return <LeadActivityBlock ids={item.ids} defaultExpanded={false} />;
  if (item.kind === 'channel-news') return <ChannelNewsLine cardId={item.cardId} at={item.at} />;
  if (item.kind === 'reminder') return <ReminderFireCard cardKey={item.reminderKey} />;
  if (item.kind === 'setup-checklist') return <SetupChecklistCardItem />;
  if (item.kind === 'setup-hint') return <SetupHintCardItem cardKey={item.hintKey} />;
  if (item.kind === 'topic-opened') return <TopicOpenedLine topicId={item.topicId} />;
  if (item.kind === 'topic-concluded') return <TopicConcludedRow topicId={item.topicId} />;
  const card = cardsById[item.cardId];
  // 单独成行的工单卡没有回复可以标：同一天已经完整画过的，折叠以后就不再画（见上面消息里的同一条规则）。
  if (collapsedCardIds.has(item.cardId)) return null;
  return card ? (
    <Box w="100%">
      <ConversationCardView
        card={card}
        collapsed={collapsedCardIds.has(item.cardId)}
        compact={compact}
        dispatchScope={windows[item.cardId]}
        selectedTicketId={selectedTicketId}
      />
    </Box>
  ) : null;
}

function EmptyConversation({ title, body }: { title: string; body: string }) {
  return (
    <Column flex={1} minH={260} items="center" justify="center" gap="text-stack" px="empty-state">
      <Text size="section-title" weight="extrabold">{title}</Text>
      <Text size="secondary" tone="secondary" align="center">{body}</Text>
    </Column>
  );
}

// One message of a conversation with Lead. The main conversation draws its rows with it, and so does the panel of a
// topic (features/topics, with no cards): one component, so your message, its images and files, Lead's reply and a
// failure look and work the same in both. What differs in a topic comes from the conversation scope (conversationScope.ts).
export function ConversationMessage({
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
  // null: the main conversation. A topic gives where "Send again" goes and the wording of its fixed errors.
  const scope = useConversationScope();
  const message = useMessage(messageId);
  const partIds = useMessagePartIds(messageId);
  const parts = useMessageParts(messageId);
  // 点气泡里的引用跳回原文（quoteNavigation.ts）。hook 放在最前面：后面有提前返回。
  const jumpToQuoteSource = useQuoteJump();
  const textPart = useMessagePart(`${messageId}:text`);
  const turn = useTurn(message?.turnId ?? '');
  const turnUserPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  // 这一轮你发的图片：「重发」时连图片一起发。
  const turnUserParts = useMessageParts(turn ? turn.userMessageId : '');
  const turnUserImages = turnUserParts.filter(isImagePart);
  const turnUserFiles = turnUserParts.filter(isFilePart);
  // 重发时引用一起带上（设计规范 P17）：原文、说明、来源都和第一次一样，daemon 再核对一次。
  const turnUserQuotes: ChatQuoteInput[] = turnUserParts.filter(isQuotePart).map((part) => ({
    source: part.source, text: part.text, ...(part.note ? { note: part.note } : {}), ...(part.anchor ? { anchor: part.anchor } : {}),
  }));
  // Lead 的状态和模型只在这一轮失败时用到（失败的说法、「换个模型重发」）。没失败的消息不订阅它们：
  // Lead 降级重试时 overview 一直在变，订阅了就每条消息都跟着重画（2026-11-14）。
  const failed = Boolean(message?.failure);
  const lead = useControlPlaneStore((state) => (failed ? state.overview?.lead : undefined));
  // Lead 现在用的模型：没有回答的那一轮点开以后写它，后面是「换个模型重发」。
  const leadModel = useControlPlaneStore((state) => (failed ? state.overview?.model : undefined));
  const leadName = useLeadName();
  const locale = useLocale();
  const m = conversationMessages(locale);
  const connected = useConnectionState() === 'connected';
  // 这一轮被重启打断以后，Lead 已经在自己发起的一轮里接着回复了：失败行改说「Lead 已接着回复」。
  const continued = useControlPlaneStore((state) => Boolean(turn && isLeadRestartInterruption(turn.error)
    && Object.values(state.turnsById).some((other) => other.id !== turn.id && isSystemTurnOrigin(other.originKind)
      && !isDaemonNoticeOrigin(other.originKind)
      && other.state === 'completed' && other.createdAt > turn.createdAt)));
  const delivered = useControlPlaneStore((state) => Boolean(message?.turnId && state.deliveredTurnIds[message.turnId]));
  const cardSlots = useTurnCardSlots(cardIds, cardsById, dispatchScopes);
  if (!message) return null;
  if (!scope && isHiddenUserMessage(message)) return null;
  // In a topic, a turn that Lead started (the opening) has no message from you: only Lead's side of it is drawn.
  if (scope && message.role === 'user' && !(textPart?.kind === 'text' && textPart.text.trim()) && !parts.some((part) => isImagePart(part) || isFilePart(part))) return null;

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
  const steeredNotice = steeredNoticeFor(message, hasContent, turn?.placement ?? null, leadName, locale);
  if (steeredNotice) {
    return (
      <Box items="center" py="banner-y">
        <Text size="note" tone="secondary">{steeredNotice}</Text>
      </Box>
    );
  }

  // daemon 自己写的 blocker 一行（没有通知、也没有卡片的 blocker）：一行提示，给「打开工单」。
  if (!user && turn?.originKind === SYSTEM_TURN_ORIGINS.blockerNotice && rawText.trim()) {
    return <BlockerNotice text={rawText.trim()} time={formatConversationTime(message.updatedAt, undefined, locale)} />;
  }
  // 高风险的主人操作（工单 15）：daemon 写的卡，带「不是我」。轮次编号里带着事件编号和发出操作的凭证编号。
  // 是这个客户端自己的凭证做的（用户刚在这里点的）：只显示一行记录。
  const ownerAction = !user && turn?.originKind === SYSTEM_TURN_ORIGINS.ownerAction ? ownerActionRefOfTurn(message.turnId) : null;
  if (ownerAction && rawText.trim()) {
    const time = formatConversationTime(message.updatedAt, undefined, locale);
    return ownerAction.bindingId === runtime.currentBinding()?.id
      ? <OwnOwnerActionNote text={rawText.trim()} time={time} />
      : <OwnerActionCard eventId={ownerAction.eventId} text={rawText.trim()} time={time} />;
  }
  // Lead 自己发起的回合也只写 Lead 的名字（方案 A）。紧凑布局里，Lead 发起的回合和系统通知仍然显示发送者和时间。
  // 是不是系统通知看这一轮的来源，不比较标签文字：Lead 的名字可以改成任何字。
  const noticeLabel = user ? null : systemNoticeLabel(turn?.originKind, locale);
  const systemNotice = noticeLabel !== null;
  const sender = user ? m.you : noticeLabel ?? leadName;
  const showHeader = !compact || (!user && isSystemTurnOrigin(turn?.originKind));
  // 消息头前面的形象（主题 F-5）：只在桌面、只给 Lead 自己说的话，daemon 写的系统通知不加。
  // 最新一条用默认的图，回复时用思考中的图（代替摘要前的小转圈）。更早的用淡彩、静止（P12.4）。
  const replying = message.state === 'streaming' || message.state === 'queued';
  const fairyMark = !user && !systemNotice && !compact
    ? <MessageLeadAvatar name={leadName} latest={latest} replying={replying} />
    : null;
  // 气泡上的时间（2026-11-09）：你的话是发出的时刻，Lead 的回答是开始回答的时刻，和它在会话里的位置一致
  // （conversationMessageTimes）；回答用了多久写在回合头上。以前写结束的时刻，排序改了以后时间会前后颠倒。
  const time = formatConversationTime(message.createdAt, undefined, locale);
  // 发件箱里的消息：头上写时间，状态写在气泡下面（待发送、发送中、已送达）。
  // 送到以后，Lead 忙时它怎么放的写在这里（工单 04，spec D10）：排队中、已插入、下一轮回答。
  const placementCopy = user && !message.delivery ? placementCopyFor(turn, leadName, locale) : null;
  const deliveryCopy = !user ? null
    : message.delivery === 'pending' ? (connected ? m.delivery.pending : m.delivery.pendingOffline)
      : message.delivery === 'sending' ? m.delivery.sending
        : delivered && !placementCopy ? m.delivery.delivered : null;
  const stateCopy = message.delivery ? time : message.state === 'queued'
    ? m.delivery.sending
    : message.state === 'streaming'
      ? m.delivery.replying
      : time;
  const failure = message.failure;
  const failurePresentation = failure ? presentTurnFailure({
    failure,
    originKind: turn?.originKind,
    ticketId: null,
    // 只发了图片的消息也能「重发」。
    userText: (turnUserPart?.kind === 'text' ? turnUserPart.text : '') || (turnUserImages.length ? m.imageOnly : null),
    lead,
    clock: (value) => formatConversationTime(value, undefined, locale),
    tools: parts.flatMap((part) => part.kind === 'tool' ? [part] : []),
    continued,
    locale,
  }) : null;
  // A topic's fixed error (conversationScope.ts): its own headline and details, and "Send again".
  const fixedFailure = failure && scope ? scope.fixedFailure(failure.message) : null;
  const failureActions = (fixedFailure ? ['resend' as const] : failurePresentation?.actions ?? []).flatMap((action) => {
    // 只有还在本地、没有送达的消息能「重试」或「移除」。
    if ((action === 'retry' || action === 'remove') && message.source !== 'optimistic') return [];
    // A conversation that takes no message now (a closed topic) has no "Send again".
    if (action === 'resend' && scope && !scope.send) return [];
    return [{ label: failureActionLabels(locale)[action], onPress: () => runFailureAction(action) }];
  });
  const runFailureAction = (action: FailureAction) => {
    if (action === 'refresh') void runtime.refresh();
    else if (action === 'retry') void runtime.retryMessage(message.id).catch(() => {});
    else if (action === 'remove') runtime.dismissLocalMessage(message.id);
    else if (action === 'resend') resend();
  };
  // 重发这一轮：文字、图片和文件一起。只有文字时马上发；本机没有的图片和文件先向 daemon 取。
  // turnModel：「换个模型重发」里点了「只这一条」时，重发的这一次用的模型。
  const resend = (turnModel?: LeadModelChoice) => {
    const text = turnUserPart?.kind === 'text' ? turnUserPart.text : '';
    const quotes = turnUserQuotes.length ? turnUserQuotes : undefined;
    // A topic: the same words, images and files go to the topic again.
    if (scope) {
      const send = scope.send;
      if (!send) return;
      void Promise.all([
        Promise.all(turnUserImages.map((part): Promise<ChatImageInput> | ChatImageInput =>
          part.data !== undefined ? { mimeType: part.mimeType, data: part.data } : runtime.loadChatImage(part.imageId ?? ''))),
        Promise.all(turnUserFiles.map((part): Promise<ChatFileInput> | ChatFileInput =>
          part.data !== undefined
            ? { name: part.name, mimeType: part.mimeType, data: part.data }
            : runtime.loadChatFile(part.fileId ?? '').then((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data })))),
      ]).then(([images, files]) => send(text, { images, files })).catch(() => {});
      return;
    }
    if (turnUserFiles.length) {
      void Promise.all([
        Promise.all(turnUserImages.map((part): Promise<ChatImageInput> | ChatImageInput =>
          part.data !== undefined ? { mimeType: part.mimeType, data: part.data } : runtime.loadChatImage(part.imageId ?? ''))),
        Promise.all(turnUserFiles.map((part): Promise<ChatFileInput> | ChatFileInput =>
          part.data !== undefined
            ? { name: part.name, mimeType: part.mimeType, data: part.data }
            : runtime.loadChatFile(part.fileId ?? '').then((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data })))),
      ])
        .then(([images, files]) => runtime.sendChat(text, undefined, undefined, images.length ? images : undefined, turnModel, quotes, files))
        .catch(() => {});
      return;
    }
    if (!turnUserImages.length) {
      if (quotes) void runtime.sendChat(text, undefined, undefined, undefined, turnModel, quotes).catch(() => {});
      else if (text.trim()) void (turnModel ? runtime.sendChat(text, undefined, undefined, undefined, turnModel) : runtime.sendChat(text)).catch(() => {});
      return;
    }
    void Promise.all(turnUserImages.map((part): Promise<ChatImageInput> | ChatImageInput =>
      part.data !== undefined ? { mimeType: part.mimeType, data: part.data } : runtime.loadChatImage(part.imageId ?? '')))
      .then((images) => (quotes
        ? runtime.sendChat(text, undefined, undefined, images, turnModel, quotes)
        : runtime.sendChat(text, undefined, undefined, images, turnModel)))
      .catch(() => {});
  };
  // 一个字也没说的助手消息不画内容区，失败了就只显示错误。和工单对话（TicketThread）同一条规则。
  // 调过工具的轮次算有内容（assistantMessageHasContent），照样画任务卡。
  const bubble = user || hasContent || message.state === 'streaming';
  // 你发的图片排在气泡上面。只发了图片的消息没有气泡。
  const userImages = user ? parts.filter(isImagePart) : [];
  // 你发的文件：图片下面一张张文件卡（主题 A-4），点开用系统预览或分享。
  const userFiles = user ? parts.filter(isFilePart) : [];
  // 你引用的几段话画在气泡里、正文上面（设计规范 P17.7）。只带了引用的消息也有气泡。
  const userQuotes = user ? parts.filter(isQuotePart) : [];
  const userBubble = user && (rawText.trim().length > 0 || userQuotes.length > 0 || (userImages.length === 0 && userFiles.length === 0));

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
      {userFiles.length ? <UserMessageFiles files={userFiles} /> : null}
      {bubble && userBubble ? (
        <QuoteSourceFor turnId={scope ? null : message.turnId} role="user" text={rawText}>
        <MessageBubble testID="user-bubble">
          {userQuotes.length ? (
            <Column gap="card-row" testID="user-message-quotes">
              {userQuotes.map((quote) => <QuoteBlock key={quote.id} quote={quote} {...(jumpToQuoteSource ? { onJump: () => jumpToQuoteSource(quote) } : {})} />)}
            </Column>
          ) : null}
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
        </QuoteSourceFor>
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
        <QuoteSourceFor turnId={systemNotice || scope ? null : message.turnId} role="assistant" text={rawText}>
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
        </QuoteSourceFor>
      ) : null}
      {/* 回答写到一半被你的插话打断（2026-11-10，设计规范 P10.2）：写出的字照原样留着，后面接一个琥珀虚线胶囊写原因。
          你自己打断的，没有「重发」：Lead 在插话那一轮里接着做。 */}
      {!user && hasContent && turn?.interrupted === 'steer' ? (
        <AbsenceTail testID="interrupted-by-steer" text={m.steered.interruptedBySteer} />
      ) : null}
      {!user && activityIds?.length ? <TurnActivity ids={activityIds} /> : null}
      {/* The topics that Lead opened in this turn: one line each, at the end of the reply (features/topics, P18). */}
      {!user ? <TurnTopicLinks turnId={message.turnId} /> : null}
      {/* Three or more same-kind cards of this turn (reminders, new tickets) show as one line (P9.10, turnCardGroups.ts). */}
      {!user && cardSlots.map((slot) => slot.kind === 'group' ? (
        <TurnCardGroupView key={slot.group.key} group={slot.group} />
      ) : cardsById[slot.cardId] && !(collapsedCardIds.has(slot.cardId) && !rawText.trim()) ? (
        // 折叠成小标签的工单卡说的是「这一段回复也动了这张工单」：回复一个字也没有时，标签没有可以标的，不画
        // （2026-11-15 用户截图：#367 的整卡下面紧跟着一个孤零零的 #367 小标签）。
        <ConversationCardView
          key={slot.cardId}
          card={cardsById[slot.cardId]!}
          collapsed={collapsedCardIds.has(slot.cardId)}
          compact={compact}
          dispatchScope={dispatchScopes[slot.cardId]}
          selectedTicketId={selectedTicketId}
        />
      ) : null)}
      {fixedFailure ? (
        <Box w="100%">
          <FailureCard headline={fixedFailure.headline} tone="warning" details={fixedFailure.details} actions={failureActions} />
        </Box>
      ) : failurePresentation && !maintenanceNotice ? (
        <Box {...(user ? { self: 'flex-end', maxW: '100%' } as const : { w: '100%' } as const)}>
          <FailureCard
            headline={failurePresentation.headline}
            tone={failurePresentation.tone}
            details={failurePresentation.details}
            actions={failureActions}
            presentation={failurePresentation}
            // "Send again with another model" changes Lead's main model: not offered in a topic, which has its own.
            modelSwitch={!scope && failurePresentation.actions.includes('resend') && leadModel && leadModel !== 'unknown'
              ? { current: leadModel, link: <LeadModelResendLink onResend={resend} /> }
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

type FilePart = Extract<MessagePart, { kind: 'file' }>;
function isFilePart(part: MessagePart): part is FilePart {
  return part.kind === 'file';
}

// 你随消息发的文件（主题 A-4）：右对齐，一张一行。点开：本机还有数据的直接打开，daemon 存的先按 id 取（runtime 缓存）。
// web 上下载，手机上交给系统的分享面板。打不开时在下面写一句。
function UserMessageFiles({ files }: { files: readonly FilePart[] }) {
  const runtime = useCompanionRuntime();
  const m = useMessages(fileMessages);
  const [failed, setFailed] = useState<string | null>(null);
  const open = (file: FilePart) => {
    setFailed(null);
    const loaded: Promise<ChatFile> = file.data !== undefined
      ? Promise.resolve({ id: file.fileId ?? file.id, name: file.name, mimeType: file.mimeType, size: file.size, data: file.data })
      : runtime.loadChatFile(file.fileId ?? '');
    loaded.then(presentChatFile).catch(() => setFailed(m.openFailed(file.name)));
  };
  return (
    <Column testID="user-message-files" self="flex-end" items="flex-end" gap="thumbnails">
      {files.map((file, index) => (
        <FileChip
          key={file.id}
          testID={`user-message-file-${index}`}
          variant="sent"
          name={file.name}
          mimeType={file.mimeType}
          size={file.size}
          onPress={() => open(file)}
        />
      ))}
      {failed ? <Text size="note" tone="danger">{failed}</Text> : null}
    </Column>
  );
}

// 能引用的一段（设计规范 P17.1）：有轮次的 Lead 回答和你的消息。daemon 自己写的系统通知、没有轮次的本地消息不能引用。
function QuoteSourceFor({ turnId, role, text, children }: {
  turnId: string | null | undefined; role: 'assistant' | 'user'; text: string; children: ReactNode;
}) {
  if (!turnId || !text.trim()) return <>{children}</>;
  return <QuoteSource source={{ kind: 'turn', turnId, role }} texts={[text]}>{children}</QuoteSource>;
}

type QuotePart = Extract<MessagePart, { kind: 'quote' }>;
function isQuotePart(part: MessagePart): part is QuotePart {
  return part.kind === 'quote';
}

// 你随消息发的图片：气泡上面右对齐的一排小图（和输入框里待发的图片一样大）。点一张全屏看大图（通用的 ImageViewer），
// 左右滑看这条消息的别的图。
function UserMessageImages({ images }: { images: readonly ImagePart[] }) {
  const m = conversationMessages(useLocale());
  const shown = useChatImageUris(images);
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <Row testID="user-message-images" self="flex-end" justify="flex-end" flexWrap="wrap" gap="thumbnails">
      {images.map((image, index) => (
        <ImageThumbnail
          key={image.id}
          testID={`user-message-image-${index}`}
          uri={shown[index]?.uri ?? null}
          failed={shown[index]?.failed ?? false}
          label={m.yourImage(index + 1)}
          onPress={() => setViewing(index)}
        />
      ))}
      <ImageViewer
        testID="user-message-image-viewer"
        open={viewing !== null}
        items={images.map((image, index) => ({
          key: image.id, uri: shown[index]?.uri ?? null, failed: shown[index]?.failed ?? false, label: m.yourImage(index + 1),
        }))}
        initialIndex={viewing ?? 0}
        onClose={() => setViewing(null)}
      />
    </Row>
  );
}

// 每张图的地址：本机还留着数据的直接用；daemon 存的按 id 取一次（runtime 缓存）。取到以前是 null（浅灰的占位块），取不到时 failed。
function useChatImageUris(images: readonly ImagePart[]): readonly { uri: string | null; failed: boolean }[] {
  const runtime = useCompanionRuntime();
  const [loaded, setLoaded] = useState<Readonly<Record<string, string | null>>>({});
  const wanted = images.flatMap((image) => (image.data === undefined && image.imageId ? [image.imageId] : []));
  const wantedKey = wanted.join(',');
  useEffect(() => {
    if (!wantedKey) return undefined;
    let live = true;
    for (const imageId of wantedKey.split(',')) {
      runtime.loadChatImage(imageId).then(
        (image) => { if (live) setLoaded((old) => ({ ...old, [imageId]: `data:${image.mimeType};base64,${image.data}` })); },
        () => { if (live) setLoaded((old) => ({ ...old, [imageId]: null })); },
      );
    }
    return () => { live = false; };
  }, [wantedKey, runtime]);
  return images.map((image) => {
    if (image.data !== undefined) return { uri: `data:${image.mimeType};base64,${image.data}`, failed: false };
    const remote = image.imageId ? loaded[image.imageId] : undefined;
    return { uri: remote ?? null, failed: remote === null };
  });
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
  const locale = useLocale();
  const ticketId = blockerNoticeTicketId(text);
  return (
    <Column testID="blocker-notice" w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{`${leadSenderLabel(SYSTEM_TURN_ORIGINS.blockerNotice, undefined, locale)} · ${time}`}</Text>
      <FailureCard
        headline={text}
        tone="danger"
        details={null}
        actions={ticketId === null ? [] : [{ label: conversationMessages(locale).openTicket(ticketId), onPress: () => openTicket(ticketId) }]}
      />
    </Column>
  );
}

// 连着出现的同一种失败合成的一张卡片（例如每次心跳巡检一个 503）：写次数和最近一次的时间。
// 一次停摆的系统卡片：开头一句（什么时候、为什么、积压几件、恢复了没有），展开看积压的事和 Lead 那几次没完成的处理。
// ChatList 的 followKey：你在这台设备上发的最后一条消息，用它的 clientMessageId：断线时发出也变（列表回到底部），
// 后来送达、本地消息换成那一轮的消息时不变（不算又发了一条，你往上翻了就不把你拽回来）。
// 没有 clientMessageId 的不算（2026-11-04）：Lead 自己开的一轮先垫上的空消息、别的设备和外部来源的消息都不是你在这里发的，
// 以前它们也会把正在往上看的你拽回底部。
export function latestSentMessageKey(messages: readonly MessageEntity[]): string | null {
  const latest = [...messages].reverse().find((message) => message.role === 'user' && message.clientCommandId !== null);
  return latest?.clientCommandId ?? null;
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
  const locale = useLocale();
  const clock = (value: string) => formatConversationTime(value, undefined, locale);
  const presentation = presentOutage({ notices, failures, recoveredAt, clock, locale });
  const latest = [...notices, ...failures].map((entry) => entry.at).sort().at(-1) ?? '';
  // 和会话里别的警告一样是一行可以展开的条目（packages/components 的 NoticeRow）：收起时只有一句，
  // 点整行展开看积压的事和 Lead 那几次没完成的处理。
  return (
    <Column testID="incident-card" w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">
        {`${leadSenderLabel(SYSTEM_TURN_ORIGINS.fallbackNotice, undefined, locale)} · ${clock(latest)}`}
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
  const locale = useLocale();
  const items = messageIds.flatMap((id) => {
    const message = messagesById[id];
    const ref = ownerActionRefOfTurn(message?.turnId);
    const part = partsById[`${id}:text`];
    const text = part?.kind === 'text' ? part.text.trim() : '';
    return message && ref && text ? [{ eventId: ref.eventId, text, time: formatConversationTime(message.updatedAt, undefined, locale) }] : [];
  });
  return own ? <OwnOwnerActionGroup items={items} /> : <OwnerActionGroupCard items={items} />;
}

function FailureGroup({ messageIds }: { messageIds: readonly string[] }) {
  const latestId = messageIds[messageIds.length - 1]!;
  const latest = useMessage(latestId);
  const turn = useTurn(latest?.turnId ?? '');
  const lead = useOverview()?.lead;
  const leadName = useLeadName();
  const locale = useLocale();
  const m = conversationMessages(locale);
  if (!latest?.failure) return null;
  const clock = (value: string) => formatConversationTime(value, undefined, locale);
  const presentation = presentTurnFailure({
    failure: latest.failure,
    originKind: turn?.originKind,
    ticketId: null,
    userText: null,
    lead,
    clock,
    locale,
  });
  // 系统自己发起的那几轮没完成：居中的系统信息行，不写发件人（画布「没有回答」状态 4）。
  if (presentation.form === 'system') {
    return (
      <FailureCard
        headline={presentation.headline}
        tone={presentation.tone}
        details={presentation.details}
        meta={m.repeatedInRow(messageIds.length, clock(latest.updatedAt))}
        presentation={presentation}
        repeated={messageIds.length}
      />
    );
  }
  return (
    <Column w="100%" gap="reply-block">
      <Text size="meta" weight="semibold" tone="secondary">{leadSenderLabel(turn?.originKind, leadName, locale)}</Text>
      <FailureCard
        headline={presentation.headline}
        tone={presentation.tone}
        details={presentation.details}
        meta={m.repeatedTotal(messageIds.length, clock(latest.updatedAt))}
        presentation={presentation}
      />
    </Column>
  );
}

// 发往工单的消息在主会话里只留一行灰色的「消息尾巴」（2026-10-15 方案 A）：说清这条消息现在在哪。
// 不画红框，不给「重发」：在跑的 Run 不能中途接收消息时，消息排队，Run 结束后转交；
// 送不到时系统交给 Lead 接手（daemon 的 handTicketMessageToLead）。点这一行打开工单对话。
export function ticketMessageTail({ ticketId, preview, state, updatedAt, leadName, locale = 'en' }: {
  ticketId: number;
  preview: string;
  state: LeadTurnEntity['state'];
  updatedAt: string;
  // 送不到时交给谁：Lead 的名字（useLeadName）。
  leadName: string;
  locale?: Locale;
}): string {
  const m = conversationMessages(locale).tail;
  const quoted = preview.length > 24 ? `${preview.slice(0, 24)}…` : preview;
  const head = quoted ? m.asked(ticketId, quoted) : m.sent(ticketId);
  if (state === 'queued') return m.queued(head);
  if (state === 'streaming') return m.streaming(head);
  if (state === 'failed') return m.failed(head, leadName);
  if (state === 'steered') return m.steered(head);
  return m.answered(head, formatConversationTime(updatedAt, undefined, locale));
}

function TicketDirectNotice({ turnId }: { turnId: string; compact: boolean }) {
  const turn = useTurn(turnId);
  const userPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  const openTicket = useOpenTicket();
  const leadName = useLeadName();
  const locale = useLocale();
  if (!turn || turn.ticketId === null) return null;
  const ticketId = turn.ticketId;
  const preview = userPart?.kind === 'text' ? userPart.text.trim() : '';
  const tail = ticketMessageTail({ ticketId, preview, state: turn.state, updatedAt: turn.updatedAt, leadName, locale });
  return (
    <Box testID={`ticket-direct-notice-${ticketId}`} w="100%">
      <Pressable
        role="button"
        aria-label={conversationMessages(locale).tail.label(ticketId)}
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

// Group this turn's cards (turnCardGroups.ts). The facts come from the same TicketSummary / TicketDetail the cards read;
// the selector returns a flat string so the store does not re-render on unrelated changes.
function useTurnCardSlots(
  cardIds: readonly string[],
  cardsById: Readonly<Record<string, ConversationCardEntity>>,
  dispatchScopes: Readonly<Record<string, DispatchWindow>>,
): TurnCardSlot[] {
  const ticketIds = useMemo(() => [...new Set(cardIds.flatMap((cardId) => {
    const card = cardsById[cardId];
    return card?.kind === 'ticket_execution' ? [card.ticketId] : [];
  }))], [cardIds, cardsById]);
  const known = useControlPlaneStore((state) => ticketIds.map((ticketId) => {
    const summary = state.ticketsById[ticketId] ?? state.ticketDetailsById[ticketId]?.ticket;
    return `${ticketId}:${summary?.kind ?? ''}:${summary?.stage ?? ''}`;
  }).join('|'));
  return useMemo(() => {
    const facts = new Map(known.split('|').filter(Boolean).map((entry) => {
      const [id, kind, stage] = entry.split(':');
      return [Number(id), { kind: kind === 'task' || kind === 'reminder' ? kind : null, stage: stage || null }] as const;
    }));
    if (cardIds.length < TURN_CARD_GROUP_MIN) return cardIds.map((cardId) => ({ kind: 'card' as const, cardId }));
    return groupTurnCards(cardIds, cardsById, {
      itemKind: (ticketId) => facts.get(ticketId)?.kind ?? null,
      stage: (ticketId) => facts.get(ticketId)?.stage ?? null,
      isDispatch: (cardId) => dispatchScopes[cardId] !== undefined,
    });
  }, [cardIds, cardsById, dispatchScopes, known]);
}

function ConversationCardView({ card, collapsed = false, compact, dispatchScope, selectedTicketId }: {
  card: ConversationCardEntity;
  collapsed?: boolean;
  compact: boolean;
  /** 给出时这是一张派活的工单卡：画成合一卡片，同一天里也不折叠成小标签。 */
  dispatchScope?: DispatchWindow;
  selectedTicketId: number | null;
}) {
  const locale = useLocale();
  if (card.kind === 'ticket_execution' && dispatchScope) return <DispatchTicketCard card={card} scope={dispatchScope} />;
  const context = card.kind === 'checkpoint' || card.kind === 'intervention' || collapsed
    ? null
    : ticketContextLabel(selectedTicketId, card.ticketId, locale);
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
    <Card gap="text-stack" p="card" variant="float">
      <Text size="card-title" weight="bold">{label}</Text>
      <Text size="secondary" tone="secondary">{conversationMessages(useLocale()).syncing}</Text>
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
  // 卡开出来以后，对方隔着别的内容又发来的消息（2026-10-30 用户）：卡固定在开出来的位置，这里在后来的位置写一行
  // 「张三 来了新消息」。中间没有别的内容的几条合成一行，at 是最后一条的时间，count 是条数。
  | { kind: 'channel-news'; key: string; cardId: number; at: number; count: number }
  // 同一个外部对话里连续的几行（结束行、「回答中」的卡、「来了新消息」）合成一行（工单 #537，见 ./channelStack）。
  | ChannelStackItem
  // 一次提醒到点（工单 07）：一张到点卡，位置是到点的时间。reminderKey 是提醒卡的 key。
  | { kind: 'reminder'; key: string; reminderKey: string; at: number }
  // 首次启动引导（.scratch/onboarding）：准备清单卡（Lead 第一次上线时）和建议卡（用户自己的一轮结束时）。
  | { kind: 'setup-checklist'; key: string; at: number }
  | { kind: 'setup-hint'; key: string; hintKey: string; at: number }
  // Topics (features/topics, design rules P18). opened: you opened a topic from a selected text, a system line at
  // that time. concluded: a topic brought its conclusion back, an end row at that time.
  | { kind: 'topic-opened'; key: string; topicId: number; at: number }
  | { kind: 'topic-concluded'; key: string; topicId: number; at: number };

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
  // 日期分隔线的语言，缺省英文。
  locale?: Locale;
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
  // 这一轮的消息还没送到 Lead（排队中、已插入）：它的两行排在最后，送到时不挪位置（conversationMessageTimes）。
  isPendingTurn?: (turnId: string) => boolean;
  // Topics (features/topics): a line when you opened one from a selected text, and a row when one brought a
  // conclusion back. A topic that Lead opened has its line in that reply of Lead instead (TurnTopicLinks).
  topics?: readonly TopicDto[];
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
    // 列表的 key（工单 #259）：你在这台设备上发的消息用发送时就有的 clientMessageId。送达以后，本地消息换成 daemon 那一轮的消息，
    // id 变了，key 不变：会话列表不把这一行卸掉再挂上、重新量一遍高度。万一同一个 clientMessageId 出现两次，后一条用自己的 id。
    const sentKey = message.role === 'user' && message.clientCommandId ? `message:sent:${message.clientCommandId}` : null;
    const item: LeadTimelineItem = {
      kind: 'message',
      key: sentKey && !insertionOrder.has(sentKey) ? sentKey : `message:${message.id}`,
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
  const messageTimes = conversationMessageTimes(messages, assistantMessageByTurn, options.isPendingTurn, (options.now ?? new Date()).getTime());
  result.sort((left, right) => compareTimelineItemTime(left, right, messagesById, turnsById, insertionOrder, messageTimes));
  for (const card of cards) {
    if (renderedCards.has(card.id)) continue;
    const cardTime = Date.parse(card.createdAt);
    const insertionIndex = result.findIndex((item) => {
      const messageTime = timelineItemTime(item, messagesById, turnsById, undefined, messageTimes);
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
      const time = timelineItemTime(item, messagesById, turnsById, cardsById, messageTimes);
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
      const time = timelineItemTime(item, messagesById, turnsById, cardsById, messageTimes);
      return Number.isFinite(time) && time > at;
    });
    if (insertionIndex < 0) result.push(entry);
    else result.splice(insertionIndex, 0, entry);
  }
  const insertAtTime = (entry: LeadTimelineItem & { at: number }) => {
    const insertionIndex = result.findIndex((item) => {
      const time = timelineItemTime(item, messagesById, turnsById, cardsById, messageTimes);
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
  for (const topic of options.topics ?? []) {
    const openedAt = Date.parse(topic.createdAt);
    if (topic.openedBy === 'user' && Number.isFinite(openedAt)) {
      insertAtTime({ kind: 'topic-opened', key: `topic-opened:${topic.id}`, topicId: topic.id, at: openedAt });
    }
    const concludedAt = topic.conclusion && topic.concludedAt ? Date.parse(topic.concludedAt) : Number.NaN;
    if (Number.isFinite(concludedAt)) {
      insertAtTime({ kind: 'topic-concluded', key: `topic-concluded:${topic.id}`, topicId: topic.id, at: concludedAt });
    }
  }
  const itemTime = (item: LeadTimelineItem) => timelineItemTime(item, messagesById, turnsById, cardsById, messageTimes);
  for (const card of options.channelCards ?? []) placeChannelNews(result, card, itemTime);
  const stacked = stackChannelConversations(result, options.channelCards ?? [], options.now ?? new Date());
  const coalesced = coalesceLeadActivity(stacked);
  const grouped = options.failureGroupKey ? groupRepeatedFailures(coalesced, messagesById, options.failureGroupKey) : coalesced;
  const owned = groupOwnerActions(grouped, messagesById, (message) => (options.isOnBehalfOwnerAction?.(message) ? 'on_behalf'
    : options.isOwnOwnerAction?.(message) ? 'own' : null));
  const merged = options.isOutageNotice
    ? mergeOutageIncidents(owned, messagesById, options.isOutageNotice, options.failureGroupKey ?? (() => null))
    : owned;
  return options.now ? withDateDividers(merged, messagesById, turnsById, cardsById, options.now, options.locale ?? 'en', messageTimes) : merged;
}

// 卡开出来以后对方又发的消息（2026-10-30 用户：「Ethan 来了新消息」，背后是那张卡；不在会话里写系统的词，例如卡的编号）。
// 一个对话一张卡，卡固定在开出来的位置（P4.1），后来的消息只更新那张卡，用户在底部看不到。所以每条后来的消息按时间找位置：
// 紧跟在这张卡、或者这张卡已有的一行后面时并进去；中间隔着别的内容时另起一行。行只追加、原地更新，不移动（P1）。
// 卡带着最近几条消息（recent），更早的不在里面，所以只看得到最近几条。
function placeChannelNews(result: LeadTimelineItem[], card: ChannelCardDto, timeOf: (item: LeadTimelineItem) => number): void {
  if (card.delivery === 'digest') return;
  const opened = Date.parse(card.createdAt);
  const later = (card.recent ?? []).map((message) => Date.parse(message.at))
    .filter((at) => Number.isFinite(at) && at > opened).sort((left, right) => left - right);
  for (const at of later) {
    let index = result.findIndex((item) => {
      const time = timeOf(item);
      return Number.isFinite(time) && time > at;
    });
    if (index < 0) index = result.length;
    const before = result[index - 1];
    if (before?.kind === 'channel-card' && before.cardId === card.id) continue;
    if (before?.kind === 'channel-news' && before.cardId === card.id) {
      before.at = at;
      before.count += 1;
      continue;
    }
    result.splice(index, 0, { kind: 'channel-news', key: `channel-news:${card.id}:${at}`, cardId: card.id, at, count: 1 });
  }
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
// 同一个对话叠起来的一行（channel-stack）也是列表里的一项。cardIds 是这一组里所有的卡（引用跳回原文时按它找），
// slots 是列表里的每一项：一张卡，或者叠起来的一行。
export type ChannelCardSlotItem = { cardId: number } | ChannelStackItem;
export type LeadConversationRow =
  | Exclude<LeadTimelineItem, { kind: 'channel-card' } | ChannelStackItem>
  | { kind: 'channel-cards'; key: string; cardIds: number[]; slots: ChannelCardSlotItem[] };

export function groupChannelCardRuns(items: readonly LeadTimelineItem[]): LeadConversationRow[] {
  const rows: LeadConversationRow[] = [];
  for (const item of items) {
    if (item.kind !== 'channel-card' && item.kind !== 'channel-stack') {
      rows.push(item);
      continue;
    }
    const slot: ChannelCardSlotItem = item.kind === 'channel-card' ? { cardId: item.cardId } : item;
    const cardIds = item.kind === 'channel-card' ? [item.cardId] : item.cardIds;
    const previous = rows.at(-1);
    if (previous?.kind === 'channel-cards') {
      previous.cardIds.push(...cardIds);
      previous.slots.push(slot);
    } else {
      rows.push({ kind: 'channel-cards', key: item.key, cardIds: [...cardIds], slots: [slot] });
    }
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
  locale: Locale,
  messageTimes?: ReadonlyMap<string, number>,
): LeadTimelineItem[] {
  const withDividers: LeadTimelineItem[] = [];
  let previousDay: string | null = null;
  for (const item of items) {
    const time = timelineItemTime(item, messagesById, turnsById, cardsById, messageTimes);
    if (Number.isFinite(time)) {
      const date = new Date(time);
      const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      if (day !== previousDay) {
        withDividers.push({ kind: 'date', key: `date:${day}`, label: formatConversationDate(date.toISOString(), now, locale) });
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
  messageTimes?: ReadonlyMap<string, number>,
): number {
  const leftTime = timelineItemTime(left, messagesById, turnsById, undefined, messageTimes);
  const rightTime = timelineItemTime(right, messagesById, turnsById, undefined, messageTimes);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return (insertionOrder.get(left.key) ?? 0) - (insertionOrder.get(right.key) ?? 0);
}

// 一条消息在会话里的位置（2026-11-09，P1.1、P1.4：一行出现以后不再挪动）：
// - Lead 的回答：开始回答的时刻（消息的 createdAt；排队、插话的一轮是送到 Lead 的那一刻，见 actions.ts 的 lead.start-turn）。
//   以前用 updatedAt：正在回答的一轮按发出的时刻排，答完才跳到结束的时刻。插话那一轮因此排在前一轮的回答上面，答完又往下跳。
//   重试的一轮重新开始时 createdAt 也改成那一刻（restartLeadTurn、daemon 的 reopenTurn），照旧排到后面。
// - 你的话：发出的时刻；要等别的轮次答完才送到的（排队、插话），放在送到的那一刻，紧挨着它的回答。
//   这样会话的先后就是 Lead 看到的先后：前一轮在你这句话送到之前写的回答在它上面，看过它以后写的在它下面。
// - 还没送到的（排队中、已插入）：这一轮的两行都排在最后，像输入框上方的排队栏一样跟着底部，送到时不挪位置。
function conversationMessageTimes(
  messages: readonly MessageEntity[],
  answerByTurn: ReadonlyMap<string, MessageEntity>,
  isPendingTurn: ((turnId: string) => boolean) | undefined,
  now: number,
): Map<string, number> {
  const times = new Map<string, number>();
  for (const message of messages) {
    const turnId = message.turnId;
    if (turnId && isPendingTurn?.(turnId)) {
      times.set(message.id, now);
      continue;
    }
    const at = Date.parse(message.createdAt);
    if (message.role !== 'user' || !turnId) {
      times.set(message.id, at);
      continue;
    }
    const answerAt = Date.parse(answerByTurn.get(turnId)?.createdAt ?? '');
    times.set(message.id, Number.isFinite(answerAt) && answerAt > at ? answerAt : at);
  }
  return times;
}

// 一项在会话里的时间：排序用它。消息的位置见 conversationMessageTimes（没给时用 updatedAt）。
// 回执是用户发消息的那一刻，卡片是它写下的那一刻。
function timelineItemTime(
  item: LeadTimelineItem,
  messagesById: ReadonlyMap<string, MessageEntity>,
  turnsById: ReadonlyMap<string, LeadTurnEntity>,
  cardsById?: ReadonlyMap<string, ConversationCardEntity>,
  messageTimes?: ReadonlyMap<string, number>,
): number {
  if (item.kind === 'message') {
    return messageTimes?.get(item.messageId) ?? Date.parse(messagesById.get(item.messageId)?.updatedAt ?? '');
  }
  if (item.kind === 'ticket-direct') return Date.parse(turnsById.get(item.turnId)?.createdAt ?? '');
  if (item.kind === 'failure-group' || item.kind === 'owner-action-group') {
    return Date.parse(messagesById.get(item.messageIds.at(-1)!)?.updatedAt ?? '');
  }
  if (item.kind === 'incident') {
    return Math.max(...[...item.noticeMessageIds, ...item.failureMessageIds]
      .map((id) => Date.parse(messagesById.get(id)?.updatedAt ?? '')).filter(Number.isFinite));
  }
  if (item.kind === 'card') return Date.parse(cardsById?.get(item.cardId)?.createdAt ?? '');
  if (item.kind === 'lead-activity' || item.kind === 'channel-card' || item.kind === 'channel-news' || item.kind === 'channel-stack') return item.at;
  if (item.kind === 'reminder' || item.kind === 'setup-checklist' || item.kind === 'setup-hint') return item.at;
  if (item.kind === 'topic-opened' || item.kind === 'topic-concluded') return item.at;
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
  locale: Locale = 'en',
): LeadFooterItem[] {
  const m = conversationMessages(locale).footer;
  const workItemsByTicket = new Map(workItems.map((item) => [item.ticketId, item]));
  return tickets.flatMap((ticket): LeadFooterItem[] => {
    // 「需要处理」和「执行中」都用共用规则（protocol 的 ticketNeedsUser、ticketTurn），
    // 和工单 tab 的分组、导航角标是同一个数。以前这里自己判断「执行中」：只看 active 加运行中的 Run，
    // 而工单 tab 把 ready 也算进去，于是一边写「执行中 0」，一边写「进行中 6」。
    const turn = ticketTurn(ticket);
    const needsUser = ticketNeedsUser(ticket);
    if (turn === 'user' && needsUser) {
      return [{
        ticketId: ticket.id, stateLabel: ticketNeedsUserLabel(needsUser, locale), tone: 'attention', progressPercent: null,
      } satisfies LeadFooterItem];
    }
    // 在跑的子工单不列：工单 tab 也只列根工单。
    if (turn !== 'running' || ticket.parentTicketId != null) return [];
    const workItem = workItemsByTicket.get(ticket.id);
    return [{
      ticketId: ticket.id,
      stateLabel: ticket.runtime.state === 'starting' ? m.starting : m.running,
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

// 这一轮你的话还没送到 Lead（2026-11-09）：排队中，或者已插入、还在路上（包括赶不上这一轮、下一轮回答的）。
// 送到时 daemon 发 lead.turn.started（started），这一轮回到 streaming。会话把它排在最后（conversationMessageTimes）。
export function isUndeliveredTurn(turn: Pick<LeadTurnEntity, 'placement' | 'state'>): boolean {
  if (turn.state === 'queued') return turn.placement === 'queued';
  return turn.state === 'steered' && (turn.placement === 'steered' || turn.placement === 'next_turn');
}

// 消息头前面的 Lead 形象（主题 F-5）。单独一个组件：消息的组件里有提前返回，hook 不能放在那里。
function MessageLeadAvatar({ name, latest, replying }: { name: string; latest: boolean; replying: boolean }) {
  const look = { tone: latest ? 'color' : 'muted', state: latest && replying ? 'thinking' : 'idle' } as const;
  const source = useLeadAvatarSource(look);
  return <LeadAvatar testID="message-fairy" size={18} name={name} tone={look.tone} state={look.state} source={source} />;
}
