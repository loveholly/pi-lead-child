import type {
  ActivityDto,
  AgendaItem,
  ApprovalDto,
  AttemptDto,
  ChannelSettingsResponse,
  ConnectionListResponse,
  DecisionModelDto,
  ModelSettingsDto,
  SetupStatus,
  LeadAvatarDto,
  LeadProfileDto,
  DesignPreferencesDto,
  RuntimeSettingsDto,
  MemorySettingsDto,
  MemoryHindsightDto,
  MemoryPreferencesDto,
  WidgetDto,
  ConversationToolCall,
  ConversationTurn,
  KernelAttempt,
  KernelArtifact,
  KernelCheckpointV2,
  KernelConversationCard,
  KernelIntervention,
  KernelInterventionRef,
  KernelTicketTiming,
  KernelOutcomeSnapshotResource,
  KernelTicketPow,
  KernelTicketProgress,
  KernelTicketWorkItemV2,
  NotificationDto,
  Overview,
  ProjectSummary,
  TicketDetail,
  TicketReplyActionId,
  TicketSummary,
  ToolCallState,
  ToolDisplayProjection as ProtocolToolDisplayProjection,
  TurnPlacement,
  InboxView,
  ProjectOverview,
  TimelineResponse,
} from '@pi-lead-child/protocol';

import type { ConnectionState } from '@pi-lead-child/client';

export type ControlPlanePhase = 'loading' | 'unpaired' | 'connecting' | 'ready' | 'error';
export type ResourceState = 'idle' | 'loading' | 'ready' | 'stale' | 'unsupported' | 'error';
// unsupported 的一种：daemon 比网页旧，还没有这条路由（回 404）。写在 ResourceLoadState.error 里，和「还没配对、没有 scope」的
// unsupported 分开：页面只在这种时候说「daemon 还没更新」。重新连上（hello.v2）以后照样自动再取。
export const DAEMON_OLDER_THAN_WEB = 'daemon_older_than_web';
export type ResourceKey =
  | 'core'
  | 'overview'
  | 'tickets'
  | 'projects'
  | `agenda:${string}`
  | 'approvals'
  | 'notifications'
  | 'inbox'
  | 'projects-overview'
  | 'timeline'
  | 'connections'
  | 'memory'
  | 'memory-hindsight'
  | 'memory-preferences'
  | 'decision-model'
  | 'model-settings'
  | 'setup'
  | 'widgets'
  | 'runtime-settings'
  | 'lead-profile'
  | 'lead-avatar'
  | 'design-preferences'
  | 'channel-settings'
  | 'conversation:current'
  | `conversation:ticket:${number}`
  | 'work-items'
  | 'conversation-cards'
  | 'channel-cards'
  | `ticket:${number}`
  | `execution:${number}`
  | `workbench:${number}`
  | `checkpoints:${number}`
  | `artifacts:${number}`
  | `delivery:${number}`
  | `actions:${number}`
  | `acceptance-criteria:${number}`
  | `plan:${number}`
  | `interventions:${number}`
  | `conversation-cards:ticket:${number}`
  | `attempt-events:${number}`;

export const RESOURCE_KEYS = {
  notifications: 'notifications' as const,
  inbox: 'inbox' as const,
  projectsOverview: 'projects-overview' as const,
  timeline: 'timeline' as const,
  connections: 'connections' as const,
  memory: 'memory' as const,
  // 设置 → 记忆的 Hindsight 部分（GET /v1/memory/hindsight）：摘要模型、写入情况、记忆库的统计。跟着 memory 的快照重取。
  memoryHindsight: 'memory-hindsight' as const,
  // 设置 → 记忆 → 常驻偏好（GET /v1/memory/preferences）：每一条和它最近一次改动、总字数和上限。跟着 memory 的快照重取。
  memoryPreferences: 'memory-preferences' as const,
  decisionModel: 'decision-model' as const,
  modelSettings: 'model-settings' as const,
  // 首次启动引导（GET /v1/setup）：7 项关键设置配没配好。大脑不能用时整页显示首次启动页。
  setup: 'setup' as const,
  // 自定义控件（GET /v1/widgets）：右侧视图面板里的全部控件，从上到下，各带所在的视图。面板开着时才取。
  widgets: 'widgets' as const,
  runtimeSettings: 'runtime-settings' as const,
  leadProfile: 'lead-profile' as const,
  leadAvatar: 'lead-avatar' as const,
  designPreferences: 'design-preferences' as const,
  channelSettings: 'channel-settings' as const,
  workItems: 'work-items' as const,
  conversationCards: 'conversation-cards' as const,
  channelCards: 'channel-cards' as const,
  // Lead 忙时排着的外部消息（工单 10，GET /v1/lead/queue）。
  leadQueue: 'lead-queue' as const,
  ticketConversation: (ticketId: number) => `conversation:ticket:${ticketId}` as const,
  agenda: (scope: string) => `agenda:${scope}` as const,
  ticket: (ticketId: number) => `ticket:${ticketId}` as const,
  workbench: (ticketId: number) => `workbench:${ticketId}` as const,
  checkpoints: (ticketId: number) => `checkpoints:${ticketId}` as const,
  artifacts: (ticketId: number) => `artifacts:${ticketId}` as const,
  // 工单的「这次交付」（2026-10-20）：改了哪些文件、改动在哪个分支、能不能合并。
  delivery: (ticketId: number) => `delivery:${ticketId}` as const,
  // 这张工单现在能做的操作（工单 03）、结构化验收标准（工单 05）、执行计划（工单 06）。都是单独的资源，不进 TicketSummary。
  actions: (ticketId: number) => `actions:${ticketId}` as const,
  acceptanceCriteria: (ticketId: number) => `acceptance-criteria:${ticketId}` as const,
  plan: (ticketId: number) => `plan:${ticketId}` as const,
  interventions: (ticketId: number) => `interventions:${ticketId}` as const,
  conversationCardsForTicket: (ticketId: number) => `conversation-cards:ticket:${ticketId}` as const,
  attemptEvents: (attemptId: number) => `attempt-events:${attemptId}` as const,
};

export interface ResourceLoadState {
  state: ResourceState;
  generation: number;
  observerCount: number;
  lastSuccessAt: number | null;
  error: string | null;
}

export interface LeadSessionEntity {
  id: string;
  kind: 'lead';
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LeadTurnEntity {
  id: string;
  sessionId: string;
  ticketId: number | null;
  originBindingId: number | null;
  originKind: string;
  state: ConversationTurn['state'];
  error: string | null;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  updatedAt: string;
  // 用户的这条消息怎么放的（工单 04，protocol 的 TurnPlacement）：排队中、已插入、下一轮回答，
  // 或者没有自己的回答、和 answeredWith 那一条一起答了。只有用户的轮次有；没有时是普通的一轮。
  placement?: TurnPlacement | null;
  answeredWith?: string | null;
  // 工单 agent 的这段回复在等你决定要不要做哪几个动作（2026-10-19，daemon 用 SmartModel 判断，快照里 include=reply_actions 才有）。
  // 没有判断过时没有这个字段。界面只显示其中工单现在确实能做的（TicketChatDock 的 replyActionButtons）。
  replyActions?: readonly TicketReplyActionId[];
}

export interface MessageFailure {
  // retry-pending：用户的一轮因为断网或临时故障没答上，daemon 会自动再试一次，现在在等（code 是 network 或 model）。
  kind: 'rejected' | 'timeout-unknown' | 'turn-error' | 'retry-pending';
  code: string | null;
  message: string;
}

export interface MessageEntity {
  id: string;
  sessionId: string;
  turnId: string | null;
  ticketId: number | null;
  role: 'user' | 'assistant' | 'system';
  state: 'queued' | 'streaming' | 'completed' | 'failed' | 'steered';
  failure: MessageFailure | null;
  clientCommandId: string | null;
  // 用户从本机发件箱发出的消息走到哪一步了（packages/client 的 ChatOutbox）：待发送、发送中、发送失败。
  // 送达以后它变成那一轮的用户消息，「已送达」由 deliveredTurnIds 记着。别的消息没有这个字段。
  delivery?: 'pending' | 'sending' | 'failed';
  source: 'snapshot' | 'live' | 'optimistic';
  createdAt: string;
  updatedAt: string;
}

export type ToolDisplayProjection = ProtocolToolDisplayProjection;

export type ToolState = ToolCallState;

// 助手消息的 parts：一段文字（整轮的回复），工具调用，以及工单、审批、产物这些附件。
// 工具调用的 textOffset 说它在回复的哪个位置开始，界面据此把文字切成「工具之间的话」和「最后的回复」。
// 工具调用的字段和快照里的 toolCalls 一样（protocol 的 ConversationToolCall）：实时和刷新得到同样的 part。
export type MessagePart =
  | { kind: 'text'; id: string; text: string }
  | ({ kind: 'tool'; id: string } & ConversationToolCall)
  | { kind: 'ticket'; id: string; ticketId: number }
  | { kind: 'approval'; id: string; approvalId: number }
  | { kind: 'artifact'; id: string; artifactId: string }
  | { kind: 'agent-status'; id: string; ticketId?: number; attemptId?: number; state: string }
  // Lead 用 render_ui 画的富交互卡片（generative UI，protocol 的 ui-surfaces.ts）。
  // partial：模型还在写参数，这是「生成中」的版本；同一次调用（callId）的定稿版替换它。
  | { kind: 'surface'; id: string; callId: string; textOffset: number; partial: boolean; surface: import('@pi-lead-child/protocol').UiSurface }
  // 用户随消息发的一张图片（protocol 的 chat-images.ts）。data：本机还留着的 base64（发件箱里的、刚发出去的）；
  // imageId：daemon 存下的图片，没有 data 时按它取图。两者至少有一个。
  | { kind: 'image'; id: string; mimeType: import('@pi-lead-child/protocol').ChatImageMimeType; data?: string; imageId?: string };

export interface AttemptEntity {
  id: number;
  ticketId: number;
  role: AttemptDto['role'];
  state: AttemptDto['state'];
  model: string | null;
  effort: string | null;
  runtime: KernelAttempt['runtime'] | null;
  purpose: KernelAttempt['purpose'] | null;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  kernel: KernelAttempt | null;
}

export interface ArtifactMetadata {
  id: string;
  attemptId: number;
  name: string;
  mediaType: string | null;
  size: number | null;
}

export interface CursorPageState {
  hasMore: boolean;
  nextBeforeId: number | null;
}

export interface TicketWorkbenchIndex {
  ticketId: number;
  activeAttemptId: number | null;
  childTicketIds: number[];
  latestCheckpointIds: number[];
  interventionIds: string[];
  progress: KernelTicketProgress | null;
  pow: KernelTicketPow | null;
  // 最新一次交付的成果快照。卡片的"最新成果"和验收证据都读它（工单 #66 复核 F6/F16）。
  outcomeSnapshot?: KernelOutcomeSnapshotResource | null;
  // 工单的 token 和成本预算（工单详情的「工单信息」）。null 是没设。
  budget?: { tokenBudget: number | null; costBudgetUsd: number | null };
}

type WithoutDurableId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type TransientConversationCard = WithoutDurableId<KernelConversationCard>;

export type ConversationCardEntity = TransientConversationCard & {
  id: string;
  durableId: number | null;
  source: 'live' | 'durable';
};

// The configured loopback endpoint did not pair at startup, so the runtime kept
// the stored credentials, which point at another loopback endpoint.
export interface EndpointMismatch {
  configuredEndpoint: string;
  activeEndpoint: string;
  error: string;
}

export interface ControlPlaneData {
  phase: ControlPlanePhase;
  connectionState: ConnectionState;
  error: string | null;
  endpointMismatch: EndpointMismatch | null;
  overview: Overview | null;
  ticketsById: Record<number, TicketSummary>;
  ticketIds: number[];
  ticketDetailsById: Record<number, TicketDetail>;
  projectsById: Record<string, ProjectSummary>;
  projectIds: string[];
  agendaById: Record<string, AgendaItem>;
  agendaIds: string[];
  approvalsById: Record<number, ApprovalDto>;
  approvalIds: number[];
  notificationsById: Record<number, NotificationDto>;
  notificationIds: number[];
  // 「Lead 动态」的卡片和输入框上方的 interrupt 横幅（方案 A，工单 06）。按 key 存，按版本应用（./control-plane/leadActivity.ts）。
  leadActivity: import('./control-plane/leadActivity').LeadActivityState;
  // 外部来源的会话卡（工单 11，GET /v1/channels/cards），旧的在前。按版本应用（./control-plane/channelCards.ts）。
  channelCards: import('@pi-lead-child/protocol').ChannelCardDto[];
  // Lead 忙时排着的外部消息（工单 10，GET /v1/lead/queue 和 lead-queue 的推送）。没取到、daemon 不支持时为 null。
  leadQueue: import('@pi-lead-child/protocol').LeadQueue | null;
  /** 收件箱：等你的工单为什么在等、从什么时候开始；Lead 自己处理掉的事；你上次看的时间（GET /v1/inbox）。 */
  inboxView: InboxView | null;
  /** 项目卡片（GET /v1/projects/overview），含归档的项目；没取到时为 null。 */
  projectOverviews: ProjectOverview[] | null;
  /** 日程（GET /v1/timeline），本周一到三周后；没取到时为 null。 */
  timeline: TimelineResponse | null;
  /** 第三方账号的连接（GET /v1/connections）。设置页、角标和会话里的连接卡读它。没取到时为 null。 */
  connections: ConnectionListResponse | null;
  /** Lead 的记忆设置（GET /v1/memory）：embedding、重排、服务状态、待确认的切换。没取到时为 null。 */
  memory: MemorySettingsDto | null;
  /** 记忆的 Hindsight 部分（GET /v1/memory/hindsight）：摘要模型、写入情况、记忆库的统计。没取到时为 null。 */
  memoryHindsight: MemoryHindsightDto | null;
  /** 常驻偏好（GET /v1/memory/preferences）：每一条、最近一次改动、总字数和上限。没取到时为 null。 */
  memoryPreferences: MemoryPreferencesDto | null;
  /** 决策模型（GET /v1/decision-model）。没取到时为 null。 */
  decisionModel: DecisionModelDto | null;
  /** 设置 → 模型（GET /v1/models/settings）：大脑和直觉的分工、服务商和目录。没取到时为 null。 */
  modelSettings: ModelSettingsDto | null;
  /** 首次启动引导（GET /v1/setup）：7 项关键设置配没配好。没取到、或者 daemon 还没算过时为 null。 */
  setup: SetupStatus | null;
  /** 自定义控件（GET /v1/widgets）：视图面板里的全部控件，从上到下。没取到时为 null。 */
  widgets: WidgetDto[] | null;
  /** 执行器的开关（GET /v1/runtimes/settings）：哪些 runtime 停用了、自动核查用哪个。没取到时为 null。 */
  runtimeSettings: RuntimeSettingsDto | null;
  /** Lead 的名字、人格和互动风格（GET /v1/lead/profile）。连上以后就取，界面上称呼 Lead 的地方都读这里的名字。没取到时为 null。 */
  leadProfile: LeadProfileDto | null;
  /** Lead 的形象（GET /v1/lead/avatar）：每种状态上传的图、隐藏的 FairyEye 开关、Slack 署名的 emoji。没取到时为 null（用系统素材）。 */
  leadAvatar: LeadAvatarDto | null;
  /** 取到的形象图片，按 id：data: URI。取不到时是空字符串（用系统素材）。 */
  leadAvatarImages: Record<string, string>;
  /** 界面的外观偏好（GET /v1/design/preferences）。连上以后就取；没取到时用缺省值画。 */
  designPreferences: DesignPreferencesDto | null;
  /** 外部消息通道的凭据和状态（GET /v1/channels/settings）：每个来源一行，没有密钥的值。没取到时为 null。 */
  channelSettings: ChannelSettingsResponse | null;
  sessionsById: Record<string, LeadSessionEntity>;
  sessionIds: string[];
  turnsById: Record<string, LeadTurnEntity>;
  turnIdsBySession: Record<string, string[]>;
  messagesById: Record<string, MessageEntity>;
  messageIdsBySession: Record<string, string[]>;
  messageIdsByTicket: Record<number, string[]>;
  messagePartsById: Record<string, MessagePart>;
  partIdsByMessage: Record<string, string[]>;
  assistantMessageIdByTurnId: Record<string, string>;
  turnIdByCommandId: Record<string, string>;
  // 本机发件箱送达过的轮次（显示「已送达」）。会话快照不改它。
  deliveredTurnIds: Record<string, true>;
  attemptsById: Record<number, AttemptEntity>;
  attemptIdsByTicket: Record<number, number[]>;
  activitiesById: Record<number, ActivityDto>;
  activityIdsByTicket: Record<number, number[]>;
  artifactMetadataById: Record<string, ArtifactMetadata>;
  artifactIdsByAttempt: Record<number, string[]>;
  capabilities: string[];
  checkpointsById: Record<number, KernelCheckpointV2>;
  checkpointIdsByTicket: Record<number, number[]>;
  checkpointPagesByTicket: Record<number, CursorPageState>;
  workItemsById: Record<number, KernelTicketWorkItemV2>;
  workItemIds: number[];
  workbenchesById: Record<number, TicketWorkbenchIndex>;
  workbenchIds: number[];
  artifactsById: Record<number, KernelArtifact>;
  artifactIdsByTicket: Record<number, number[]>;
  deliveryByTicket: Record<number, import('@pi-lead-child/protocol').TicketDelivery>;
  ticketActionsByTicket: Record<number, import('@pi-lead-child/protocol').TicketAction[]>;
  acceptanceCriteriaByTicket: Record<number, import('@pi-lead-child/protocol').TicketAcceptanceCriteria>;
  // 执行 agent 还没提交计划时是 null；没读过时没有这一项。
  executionPlanByTicket: Record<number, import('@pi-lead-child/protocol').TicketExecutionPlan | null>;
  interventionRefsById: Record<string, KernelInterventionRef>;
  interventionsById: Record<string, KernelIntervention>;
  interventionIds: string[];
  interventionIdsByTicket: Record<number, string[]>;
  ticketTimingsById: Record<number, KernelTicketTiming>;
  ticketTimingIds: number[];
  conversationCardsById: Record<string, ConversationCardEntity>;
  conversationCardIds: string[];
  conversationCardKeyByDurableId: Record<number, string>;
  conversationCardPagesByResource: Record<string, CursorPageState>;
  resourceState: Partial<Record<ResourceKey, ResourceLoadState>>;
  lastAppliedGatewaySeq: number;
}

export interface ToolProgress {
  partId: string;
  state: ToolState;
  updatedAt: number;
}

export interface AgentLogEntry {
  attemptId: number;
  seq: number;
  occurredAt: string;
  kind: string;
  text: string;
  tool?: {
    callId: string;
    name: string;
    phase: 'started' | 'updated' | 'completed' | 'failed';
    args: ToolDisplayProjection | null;
    result: ToolDisplayProjection | null;
    error: string | null;
    command: string | null;
    cwd: string | null;
    exitCode: number | null;
    output: ToolDisplayProjection | null;
  };
}

export interface AgentLogBuffer {
  items: AgentLogEntry[];
  seenSeqs: Record<number, true>;
  firstSeq: number | null;
  lastSeq: number | null;
  discardThroughSeq: number | null;
  lastAccessedAt: number;
}

export interface AttemptHeartbeat {
  attemptId: number;
  state: string;
  updatedAt: number;
}

export interface StreamData {
  textByMessageId: Record<string, string>;
  textUpdatedAtByMessageId: Record<string, number>;
  toolProgressByPartId: Record<string, ToolProgress>;
  logBuffersByAttemptId: Record<number, AgentLogBuffer>;
  heartbeatByAttemptId: Record<number, AttemptHeartbeat>;
}

export type CompactPanel = 'work' | 'thread' | 'artifacts' | 'logs' | null;
export type RailView = 'inbox' | 'tickets' | 'projects' | 'agenda';
export type CompactDestination = 'conversation' | 'inbox' | 'tickets' | 'projects' | 'agenda';
export type TicketFilter = 'all' | 'todo' | 'running' | 'queued';
export type TicketGroupId = 'needs_intervention' | 'running' | 'queued' | 'lead' | 'background' | 'completed' | 'cancelled';

export interface ArtifactDownloadState {
  state: 'idle' | 'downloading' | 'succeeded' | 'error';
  error: string | null;
  retryable: boolean;
}

export interface InterventionCommandState {
  state: 'pending' | 'error' | 'succeeded';
  error: string | null;
  retryable: boolean;
}

export interface WorkspaceData {
  hydrated: boolean;
  selectedSessionId: string | null;
  selectedTicketId: number | null;
  selectedAttemptId: number | null;
  railOpen: boolean;
  threadOpen: boolean;
  // 右侧的视图面板开着（P16.2：和工单详情共用右侧的位置，打开一个时另一个收起）。手机上是盖在内容上的面板。
  viewsOpen: boolean;
  // 视图面板上选中的视图（tab）。null 时是第一个。只记在这台设备上，不同步。
  selectedView: string | null;
  /** 工单详情底部的对话坞展开着的那张工单。同一时间只有一个工单详情。 */
  ticketChatExpandedId: number | null;
  /** 每张工单的对话里，你已经看过的最后一条消息。对话坞据此标出新回复。 */
  ticketChatSeenByTicket: Record<number, string>;
  /** 打开着「证据与记录」的那张工单。桌面上它占 Lead 会话栏，手机上它在工单面板里。 */
  ticketRecordsOpenId: number | null;
  compactPanel: CompactPanel;
  compactDestination: CompactDestination;
  ticketReturnDestination: CompactDestination;
  railView: RailView;
  ticketFilter: TicketFilter;
  /** 工单 tab 只看这个项目（项目名；没有项目的工单是 'unknown'）。从项目 tab 点进来时设置。 */
  ticketProject: string | null;
  ticketQuery: string;
  collapsedTicketGroupIds: TicketGroupId[];
  scrollAnchorByContext: Record<string, string | null>;
  expandedMessagePartIds: Record<string, true>;
  composerDraftByContext: Record<string, string>;
  interventionCommandStateById: Record<string, InterventionCommandState>;
  artifactDownloadStateById: Record<number, ArtifactDownloadState>;
}
