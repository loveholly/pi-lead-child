import type {
  ChatImageInput,
  LeadModelCatalog,
  LeadModelChoice,
  LeadModelSwitchResult,
  ChatPlacement,
  AdminBinding,
  BindingDto,
  ChannelHandbook,
  ChannelHandbookDto,
  ChannelPolicyDto,
  HandbookProposal,
  HandbookProposalRequest,
  HandbookSuggestions,
  HandbookRehearsal,
  HandbookRehearsalRequest,
  ChannelPolicyParams,
  ChannelPolicyReplayResult,
  ChannelPolicyTestRequest,
  ChannelPolicyTestResult,
  ChannelSecretsTestResult,
  ChannelSourceSettingsDto,
  ReplyStyleDto,
  ReplyStyleExtractRequest,
  ReplyStyleExtractResult,
  ReplyStyleUpdateRequest,
  ConnectionConfirmationDto,
  ConnectionDto,
  RuleChangeConfirmationDto,
  RuleChangeDecision,
  ExternalTimerDto,
  WatchTimerDto,
  TimerRequestDecision,
  TimerRequestDto,
  ConnectionFlowResponse,
  ConnectionSettingsRequest,
  ConnectionTestResponse,
  ConnectionToolDto,
  ConversationTurn,
  GatewayEvent,
  HelloV2,
  KernelRuntimeEvent,
  LeadActivityCardAction,
  LeadActivityView,
  LoopbackInvitation,
  LoopbackInvitationRequest,
  LoopbackInvitationStatus,
  DecisionModelDto,
  RuntimeSettingsDto,
  RuntimeSettingsRequest,
  LeadProfileDto,
  LeadProfileRequest,
  LeadAvatarDto,
  LeadAvatarSlackEmojiRequest,
  LeadAvatarSlot,
  LeadAvatarUploadRequest,
  SlackEmojiPreview,
  DesignPreferencesDto,
  DesignPreferencesRequest,
  DecisionModelSettingsRequest,
  MemorySettingsDto,
  MemorySettingsRequest,
  MemorySwitch,
  MemorySwitchConfirmResponse,
  MemoryTestResponse,
  MilestonePatchRequest,
  OwnerActionDto,
  ResolveKernelInterventionRequest,
  StandingOrderDetailResponse,
  StandingOrderListResponse,
  StandingOrderProposalResponse,
  Scope,
  StartConnectionResponse,
  TicketReviewerInfo,
  TicketReviewRequest,
  UserItemActionId,
  WorkspaceControlActionId,
  DeliveryActionId,
  DeliveryActionResult,
  DeliveryFileContent,
  DeliveryFileView,
  TicketActionId as TicketOperationId,
  TicketActionRunRequest,
  TicketActionRunResponse,
  UiActionRunRequest,
  UiActionRunResponse,
  UiActionView,
  TicketSummary,
} from '@pi-lead-child/protocol';
import { LEAD_AVATAR_CAPABILITY, leadActivityCardFromItem, leadModelSpec, redactSecretText, TicketSummarySchema } from '@pi-lead-child/protocol';
import { Value } from 'typebox/value';

import {
  ControlPlaneClientError,
  selectKernelResourceVersion,
  supportsKernelCapability,
  type ConnectionHandlers,
  type ControlPlaneClient,
  type KernelConversationCardQuery,
  type LeadDelegationOptions,
  type LinkTicketRelationInput,
  type RevokeTicketRelationInput,
  type TicketActionOptions,
  type TicketRelationActionResult,
  type WorkspaceActionOptions,
} from '@pi-lead-child/client';
import { presentArtifactDownload } from '../data/artifactDownload';
import type { ControlPlaneCredentials, CredentialStore } from '@pi-lead-child/client';
import {
  ChatOutbox,
  createJsonOutboxStorage,
  shouldRecoverLoopbackCredentials,
  shouldReplaceLoopbackCredentials,
  type OutboxEntry,
  type OutboxStorage,
} from '@pi-lead-child/client';
import {
  applyControlPlaneMutation,
  createOptimisticUserMessage,
  dismissOptimisticMessage,
  markTurnDelivered,
  resolveOptimisticUserMessage,
  setOutboxMessageState,
} from './control-plane/actions';
import { reduceGatewayEvent, type StreamMutation } from './control-plane/eventReducer';
import {
  createInvalidationCoordinator,
  type InvalidationCoordinator,
} from './control-plane/invalidation';
import { adaptGatewayEvent, projectToolDisplay } from './control-plane/protocolAdapter';
import { createControlPlaneStore } from './control-plane/store';
import { rememberLeadName } from './leadName';
import { createStreamCoordinator, type StreamCoordinator, type StreamScheduler } from './streams/batching';
import { createStreamStore } from './streams/store';
import { createWorkspaceStore } from './workspace/store';
import { createWebVersionStore } from './webVersion';
import { DAEMON_OLDER_THAN_WEB, RESOURCE_KEYS, type ResourceKey, type ResourceLoadState } from './types';

export type CompanionTransport = Pick<
  ControlPlaneClient,
  | 'pair'
  | 'pairLoopback'
  | 'pairSocket'
  | 'forget'
  | 'getOverview'
  | 'getTickets'
  | 'getTicket'
  | 'getProjects'
  | 'getAgenda'
  | 'getApprovals'
  | 'getNotifications'
  | 'getInbox'
  | 'markInboxSeen'
  | 'getProjectsOverview'
  | 'setProjectArchived'
  | 'getTimeline'
  | 'updateMilestone'
  | 'getConversationTurns'
  | 'connect'
  | 'disconnect'
  | 'setPresence'
  | 'sendChat'
  | 'sendChatCommand'
  | 'resolveApproval'
  | 'ackNotification'
  | 'setLeadDelegation'
  | 'getActivities'
  | 'getAttempts'
  | 'getAttemptEvents'
  | 'getKernelCheckpoints'
  | 'getKernelWorkItems'
  | 'getKernelTicketWorkbench'
  | 'getKernelInterventions'
  | 'resolveKernelIntervention'
  | 'getKernelConversationCards'
  | 'getKernelArtifacts'
  | 'downloadArtifact'
  | 'performTicketAction'
  | 'requestTicketReview'
  | 'performWorkspaceAction'
  | 'linkTicketRelation'
  | 'revokeTicketRelation'
> & Partial<Pick<
  ControlPlaneClient,
  | 'getLeadActivity' | 'getLeadActivityView' | 'acknowledgeLeadInterrupt' | 'getChannelCards' | 'actOnChannelCard'
  | 'getLeadQueue' | 'leadQueueAction' | 'followUpAction'
  | 'rescheduleReminder' | 'checkConnection' | 'connectionLost' | 'getOwnBinding' | 'listBindings' | 'revokeBinding'
  | 'listUiActions' | 'performUiAction'
  | 'createLoopbackInvitation' | 'getLoopbackInvitationStatus' | 'cancelLoopbackInvitation'
  | 'listConnections' | 'startConnection' | 'addCustomConnection' | 'connectionFlow' | 'updateConnectionSettings'
  | 'testConnection' | 'disconnectConnection' | 'connectionTools' | 'connectionConfirmation' | 'resolveConnectionConfirmation'
  | 'getTicketDelivery' | 'getTicketDeliveryFile' | 'performDeliveryAction'
  | 'memorySwitch' | 'confirmMemorySwitch'
  | 'getMemory' | 'updateMemorySettings' | 'testMemoryEmbedding' | 'getMemoryHindsight' | 'getMemoryPreferences'
  | 'getDecisionModel' | 'updateDecisionModel' | 'testDecisionModel' | 'getModelSettings' | 'getSetup' | 'getWidgets'
  | 'getRuntimeSettings' | 'updateRuntimeSettings'
  | 'getLeadProfile' | 'updateLeadProfile'
  | 'getLeadAvatar' | 'getLeadAvatarImage' | 'uploadLeadAvatarSlot' | 'clearLeadAvatarSlot' | 'setLeadAvatarSlackEmoji' | 'previewSlackEmoji'
  | 'getDesignPreferences' | 'updateDesignPreferences'
  | 'getChannelSettings' | 'testChannelSecrets' | 'saveChannelSecrets' | 'clearChannelSecrets'
  | 'getChannelPolicy' | 'updateChannelPolicy' | 'testChannelPolicy' | 'replayChannelPolicy'
  | 'getChannelHandbook' | 'updateChannelHandbook' | 'rehearseChannelHandbook' | 'proposeChannelHandbookSituation'
  | 'getChannelHandbookSuggestions' | 'acceptChannelHandbookSuggestion' | 'dismissChannelHandbookSuggestion'
  | 'getReplyStyle' | 'updateReplyStyle' | 'extractReplyStyle'
  | 'getStandingOrders' | 'getStandingOrder' | 'rollbackStandingOrder' | 'standingOrderProposal' | 'decideStandingOrderProposal'
  | 'ruleChangeConfirmation' | 'resolveRuleChangeConfirmation'
  | 'timerRequest' | 'resolveTimerRequest' | 'externalTimers' | 'watchTimers' | 'cancelTimer'
  | 'getOwnerAction' | 'disownOwnerAction'
  | 'getTicketReviewer'
  | 'listTicketActions' | 'runTicketAction' | 'getTicketAcceptanceCriteria' | 'getTicketExecutionPlan'
  | 'getChatImage'
  | 'getLeadModels' | 'switchLeadModel'
>>;

export interface CompanionRuntimeDependencies {
  client: CompanionTransport;
  credentials: CredentialStore;
  scheduler: StreamScheduler;
  now?: () => Date;
  timezone?: () => string;
  createCommandId?: () => string;
  // 用户消息的本地发件箱存在哪里（web：localStorage；原生应用：文件）。缺省只在内存里。
  outboxStorage?: OutboxStorage;
  // 网页由 daemon 提供时：这个页面的版本，和 daemon 现在提供的版本（2026-10-20，./webVersion）。dev server 和原生应用上没有。
  webBuild?: WebBuildSource;
  // 重新加载 App，拿到新版本：web 上重新加载页面。原生应用上没有。
  reloadApp?: () => void;
}

// 网页的版本（protocol 的 web-build.ts）：current 是构建时内联进页面的，served() 读 daemon 现在提供的。
export interface WebBuildSource {
  current: string;
  served(): Promise<string | null>;
}

// 发件箱里一条消息在会话里的本地消息 id。
const outboxMessageId = (clientMessageId: string) => `optimistic:${clientMessageId}:user`;

function memoryOutboxStorage(): OutboxStorage {
  const values = new Map<string, string>();
  return createJsonOutboxStorage({
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  });
}

interface AgendaResourceScope {
  key: ResourceKey;
  from: string;
  to: string;
  timezone: string;
}

// Replayed frames arrive back to back. A gap this long means the replay is over.
const REPLAY_SETTLE_MS = 250;

export class CompanionStateRuntime {
  readonly control = createControlPlaneStore();
  readonly streams = createStreamStore();
  readonly workspace = createWorkspaceStore();
  readonly webVersion: ReturnType<typeof createWebVersionStore>;

  private streamCoordinator: StreamCoordinator;
  private invalidation: InvalidationCoordinator;
  private lifecycle = 0;
  private stopped = false;
  private everReady = false;
  private credentials: ControlPlaneCredentials | null = null;
  private activeSessionId: string | null = null;
  private pendingTurns: ConversationTurn[] | null = null;
  private controllers = new Set<AbortController>();
  private work: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private executionLoads = new Map<number, Promise<void>>();
  private attemptEventLoads = new Map<number, Promise<void>>();
  private artifactDownloadControllers = new Map<number, AbortController>();
  private commandCounter = 0;
  // 用户发的每条消息先进发件箱，再上网络（2026-10-16：睡眠时发的消息只活在内存里，从来没到 daemon）。
  private outbox: ChatOutbox;
  private outboxLoad: Promise<void> | null = null;
  private stopWatchingOutbox: (() => void) | null = null;
  // 已经画在会话里的发件箱消息（clientMessageId）。
  private shownOutboxIds = new Set<string>();
  // 向 daemon 取过的图片（用户发给 Lead 的，按 id）：同一张图只取一次。取失败的拿掉，下次再取。
  private chatImages = new Map<string, Promise<ChatImageInput>>();
  private leadAvatarImagesLoading = new Set<string>();
  private scopes = new Set<Scope>();
  private capabilities = new Set<string>();
  private currentAgendaScope: AgendaResourceScope | null = null;
  private replayThroughSeq = 0;
  private replayInvalidations = new Set<string>();
  private replaySettleHandle: unknown = null;

  constructor(readonly dependencies: CompanionRuntimeDependencies) {
    this.webVersion = createWebVersionStore(dependencies.webBuild?.current ?? null);
    this.streamCoordinator = this.createStreamCoordinator();
    this.invalidation = this.createInvalidationCoordinator();
    this.outbox = this.createOutbox(dependencies.outboxStorage ?? memoryOutboxStorage());
  }

  start(options: { loopbackEndpoint?: string | null } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const epoch = this.lifecycle;
    this.work = this.startInternal(epoch, options);
    return this.work;
  }

  async connect(): Promise<void> {
    if (this.stopped) return;
    const epoch = this.lifecycle;
    await this.connectInternal(epoch);
  }

  private async connectInternal(epoch: number): Promise<unknown[]> {
    const credentials = this.credentials ?? await this.dependencies.credentials.load();
    if (!this.isCurrent(epoch)) return [];
    if (!credentials) {
      this.control.setState({ phase: 'unpaired', connectionState: 'disconnected', error: null });
      return [];
    }
    this.credentials = credentials;
    this.scopes = new Set(credentials.binding.scopes);
    this.control.setState({ phase: 'connecting', error: null });
    const failures = await this.hydrate(credentials.binding.scopes, epoch);
    if (!this.isCurrent(epoch)) return failures;
    if (failures.length > 0 && !this.everReady) {
      this.control.setState({ phase: 'error', error: errorMessage(failures[0]) });
      return failures;
    }
    if (failures.length > 0) this.control.setState({ error: errorMessage(failures[0]) });
    await this.dependencies.client.connect(this.handlers());
    return failures;
  }

  async pair(endpoint: string, pairingCode: string): Promise<void> {
    const epoch = this.beginLifecycle();
    const controller = this.controller();
    try {
      await this.dependencies.client.pair(endpoint, pairingCode, controller.signal);
      if (!this.isCurrent(epoch)) return;
      this.control.setState({ endpointMismatch: null });
      this.credentials = await this.dependencies.credentials.load();
      await this.connect();
      const state = this.control.getState();
      if (state.phase === 'error') throw new Error(state.error ?? 'control plane hydration failed');
    } finally {
      this.controllers.delete(controller);
    }
  }

  async pairLoopback(endpoint: string): Promise<void> {
    const epoch = this.beginLifecycle();
    const controller = this.controller();
    try {
      await this.dependencies.client.pairLoopback(endpoint, 'localhost-web', controller.signal);
      if (!this.isCurrent(epoch)) return;
      this.control.setState({ endpointMismatch: null });
      this.credentials = await this.dependencies.credentials.load();
      await this.connect();
      const state = this.control.getState();
      if (state.phase === 'error') throw new Error(state.error ?? 'control plane hydration failed');
    } finally {
      this.controllers.delete(controller);
    }
  }

  async pairSocket(invitationUri: string): Promise<void> {
    const epoch = this.beginLifecycle();
    const controller = this.controller();
    try {
      await this.dependencies.client.pairSocket(invitationUri, controller.signal);
      if (!this.isCurrent(epoch)) return;
      this.control.setState({ endpointMismatch: null });
      this.credentials = await this.dependencies.credentials.load();
      await this.connect();
      const state = this.control.getState();
      if (state.phase === 'error') throw new Error(state.error ?? 'control plane hydration failed');
    } finally {
      this.controllers.delete(controller);
    }
  }

  async refresh(): Promise<void> {
    const credentials = this.credentials ?? await this.dependencies.credentials.load();
    if (!credentials || this.stopped) return;
    const failures = await this.hydrate(credentials.binding.scopes, this.lifecycle);
    this.control.setState({ error: failures.length > 0 ? errorMessage(failures[0]) : null });
  }

  // 马上确认连接还活着（见 ControlPlaneClient.checkConnection）。
  checkConnection(): Promise<boolean> {
    return this.dependencies.client.checkConnection?.() ?? Promise.resolve(false);
  }

  // 读 daemon 现在提供的网页版本（2026-10-20）：每次连上（hello.v2）、每次回到前台。
  // 只提示，不自动刷新：用户可能正在输入。读不到时什么都不改。
  async checkWebBuild(): Promise<void> {
    const source = this.dependencies.webBuild;
    if (!source || this.stopped) return;
    try {
      const served = await source.served();
      if (served && !this.stopped) this.webVersion.setState({ served });
    } catch {
      // 读不到不算有新版本。
    }
  }

  // 用户收起「有新版本」的提示：这个版本不再提示，更新的版本照常提示。
  dismissWebUpdate(): void {
    this.webVersion.setState((state) => ({ dismissed: state.served }));
  }

  // 设备离线了：马上当连接已经断了。
  connectionLost(): void {
    this.dependencies.client.connectionLost?.();
  }

  // 把消息写进发件箱。它先存在本机，连着时按顺序发出去；断线时等连上再发，重新加载以后照样在。
  // mode：Lead 正忙时插话还是排队（工单 04），缺省插话。工单对话的消息一律交给工单的 agent（2026-10-19）。
  // images：发给 Lead 的图片（只有 Lead 的会话收，protocol 的 chat-images.ts）。
  async sendChat(
    message: string, ticketId?: number, mode?: ChatPlacement, images?: readonly ChatImageInput[],
  ): Promise<{ clientMessageId: string }> {
    await this.loadOutbox();
    const entry = await this.outbox.enqueue(message, ticketId, mode, images);
    return { clientMessageId: entry.clientMessageId };
  }

  // Lead 可以用的模型和推理强度（会话输入框右下角的模型选择）。
  loadLeadModels(): Promise<LeadModelCatalog> {
    const getLeadModels = this.dependencies.client.getLeadModels;
    if (!getLeadModels) return Promise.reject(new Error('这个 daemon 还不能换 Lead 的模型'));
    return getLeadModels.call(this.dependencies.client);
  }

  // 换 Lead 的模型和推理强度。马上换好时，输入框右下角的模型名马上跟着变（daemon 也会发 daemon.status.changed）。
  async switchLeadModel(choice: LeadModelChoice): Promise<LeadModelSwitchResult> {
    const switchLeadModel = this.dependencies.client.switchLeadModel;
    if (!switchLeadModel) throw new Error('这个 daemon 还不能换 Lead 的模型');
    const result = await switchLeadModel.call(this.dependencies.client, choice);
    const overview = this.control.getState().overview;
    if (result.applied === 'now' && overview) {
      this.control.setState({ overview: { ...overview, model: leadModelSpec(result.selected) } });
    }
    return result;
  }

  // 用户发给 Lead 的一张图片（会话快照里的 id）。
  loadChatImage(imageId: string): Promise<ChatImageInput> {
    const cached = this.chatImages.get(imageId);
    if (cached) return cached;
    const getChatImage = this.dependencies.client.getChatImage;
    if (!getChatImage) return Promise.reject(new Error('chat images are unavailable'));
    const loading = getChatImage.call(this.dependencies.client, imageId).then(
      (image) => ({ mimeType: image.mimeType, data: image.data }),
      (error: unknown) => {
        this.chatImages.delete(imageId);
        throw error;
      },
    );
    this.chatImages.set(imageId, loading);
    return loading;
  }

  // 用户点「重试」：发送失败的消息回到待发送。
  async retryMessage(messageId: string): Promise<void> {
    const clientMessageId = this.control.getState().messagesById[messageId]?.clientCommandId;
    if (!clientMessageId) throw new Error('local message is unavailable');
    this.outbox.retry(clientMessageId);
  }

  // 用户点「删除」：不再发这条，从会话里拿掉。
  dismissLocalMessage(messageId: string): void {
    const clientMessageId = this.control.getState().messagesById[messageId]?.clientCommandId;
    if (clientMessageId) void this.outbox.remove(clientMessageId);
    if (dismissOptimisticMessage(this.control, messageId)) {
      if (clientMessageId) this.shownOutboxIds.delete(clientMessageId);
      this.streams.getState().clearTransient({ messageIds: [messageId] });
    }
  }

  private createOutbox(storage: OutboxStorage): ChatOutbox {
    const outbox: ChatOutbox = new ChatOutbox({
      storage,
      // 命令 id 就用 clientMessageId：daemon 在 lead.turn.started 里带回它，本地消息据此认出自己的那一轮
      // （回答先到、command.result 后到时也不会多出一条）。重发时不变，daemon 按它去重。
      send: (entry) => this.dependencies.client.sendChatCommand({
        id: entry.clientMessageId,
        message: entry.message,
        clientMessageId: entry.clientMessageId,
        ...(entry.ticketId === null ? {} : { ticketId: entry.ticketId }),
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.images?.length ? { images: entry.images } : {}),
      }),
      isConnected: () => this.control.getState().connectionState === 'connected',
      now: () => this.dependencies.now?.() ?? new Date(),
      setTimer: (callback, delayMs) => this.dependencies.scheduler.schedule(callback, delayMs),
      clearTimer: (handle) => this.dependencies.scheduler.cancel(handle),
      onChange: (entries) => { if (outbox === this.outbox) this.showOutbox(entries); },
      onDelivered: (entry) => { if (outbox === this.outbox) this.outboxDelivered(entry); },
    });
    // 另一个标签页改了发件箱：读回来（发布评审 f796c1c）。
    this.stopWatchingOutbox?.();
    this.stopWatchingOutbox = storage.subscribe?.(() => { if (outbox === this.outbox) void outbox.reload(); }) ?? null;
    return outbox;
  }

  private loadOutbox(): Promise<void> {
    this.outboxLoad ??= this.outbox.load();
    return this.outboxLoad;
  }

  // 发件箱里的消息画进会话：还没画的画上，状态跟着发件箱走，删掉的拿走。还不知道 Lead 会话时先不画，
  // 知道以后（hello 或 overview）再画。
  private showOutbox(entries: readonly OutboxEntry[] = this.outbox.entries()): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const current = new Set(entries.map((entry) => entry.clientMessageId));
    for (const clientMessageId of [...this.shownOutboxIds]) {
      if (current.has(clientMessageId)) continue;
      this.shownOutboxIds.delete(clientMessageId);
      dismissOptimisticMessage(this.control, outboxMessageId(clientMessageId));
    }
    for (const entry of entries) {
      if (entry.state === 'delivered') continue;
      const messageId = outboxMessageId(entry.clientMessageId);
      if (!this.control.getState().messagesById[messageId]) {
        createOptimisticUserMessage(this.control, {
          sessionId,
          commandId: entry.clientMessageId,
          message: entry.message,
          ...(entry.ticketId === null ? {} : { ticketId: entry.ticketId }),
          createdAt: entry.createdAt,
          ...(entry.images?.length ? { images: entry.images } : {}),
        });
      }
      setOutboxMessageState(this.control, messageId, { state: entry.state, error: entry.error });
      this.shownOutboxIds.add(entry.clientMessageId);
    }
  }

  // 送达了：本地消息变成 daemon 开的那一轮的用户消息，显示「已送达」，再取一次会话。
  private outboxDelivered(entry: OutboxEntry): void {
    this.shownOutboxIds.delete(entry.clientMessageId);
    const sessionId = this.activeSessionId;
    if (!sessionId || !entry.turnId) return;
    applyControlPlaneMutation(this.control, sessionId, {
      type: 'lead.ensure-shell',
      turnId: entry.turnId,
      ticketId: entry.ticketId,
      occurredAt: entry.createdAt,
    });
    resolveOptimisticUserMessage(this.control, {
      sessionId,
      commandId: entry.clientMessageId,
      turnId: entry.turnId,
      optimisticMessageId: outboxMessageId(entry.clientMessageId),
    });
    markTurnDelivered(this.control, entry.turnId);
    if (entry.ticketId === null) void this.refresh();
    else void this.ensureResource(RESOURCE_KEYS.ticketConversation(entry.ticketId), true).catch(() => {});
  }

  async resolveApproval(
    approvalId: number,
    decision: 'approve' | 'reject' | 'approve_session',
  ): Promise<void> {
    await this.dependencies.client.resolveApproval(approvalId, decision);
    await this.refresh();
  }

  // 改期、标完成、取消或恢复一个节点，然后重取日程和工单（工单行上的节点标签也变了）。
  async updateMilestone(milestoneId: number, patch: MilestonePatchRequest): Promise<void> {
    await this.dependencies.client.updateMilestone(milestoneId, patch);
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.timeline, true),
      this.ensureResource('tickets', true),
    ]);
  }

  // 归档或恢复一个项目，然后重取项目卡片和项目列表。
  async setProjectArchived(projectId: number, archived: boolean): Promise<void> {
    await this.dependencies.client.setProjectArchived(projectId, archived);
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.projectsOverview, true),
      this.ensureResource('projects', true),
    ]);
  }

  // 你看过收件箱了。不马上重取：这一次看的时候，「自上次查看以来」还按打开时的时间算。
  async markInboxSeen(): Promise<void> {
    await this.dependencies.client.markInboxSeen();
  }

  // 用户点了输入框上方横幅的「知道了」（工单 06）。路由回的是确认以后的样子，按版本应用：横幅收起。
  // 别的客户端由推送收起。
  async acknowledgeLeadInterrupt(seq: number): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.acknowledgeLeadInterrupt !== 'function') throw new Error('这个版本的客户端不能确认横幅');
    const interrupt = await client.acknowledgeLeadInterrupt(seq);
    this.control.getState().applyLeadActivityPush({ interrupt });
  }

  // 提醒卡上的「10 分钟后再提醒」「改时间」（工单 07）。服务端把到点的提醒拉回等待，推一条 ticket.updated 和提醒卡的变化；
  // 这里仍然显式重取这条提醒和通知：点完按钮就该看到结果，不依赖一条可能正在重连的 socket。
  async rescheduleReminder(reminderId: number, change: { remindAt?: string; snoozeMinutes?: number }): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.rescheduleReminder !== 'function') throw new Error('这个版本的客户端不能改提醒的时间');
    const result = await client.rescheduleReminder(reminderId, change);
    if (result.ticket) this.control.getState().upsertTicket(result.ticket);
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.ticket(reminderId), true),
      this.ensureResource(RESOURCE_KEYS.notifications, true),
      this.currentAgendaScope ? this.ensureResource(this.currentAgendaScope.key, true) : Promise.resolve(),
    ]);
  }

  // genui 卡片上的按钮（Action，2026-10-27）：一个工单以外的对象现在能做的操作，和 Lead 的 list_actions 同一个判断。
  // 旧服务端没有这条路由时是空数组：按钮按「读不到」画成不可用。
  async listUiActions(type: string, id: string): Promise<UiActionView[]> {
    const { client } = this.dependencies;
    if (typeof client.listUiActions !== 'function') return [];
    return client.listUiActions(type, id);
  }

  // 执行它：和 Lead 的 perform_action 同一个函数，actor 是你本人。做完以后重取这个对象相关的资源（提醒是那条提醒、通知和日程）。
  async performUiAction(type: string, id: string, action: string, request: UiActionRunRequest = {}): Promise<UiActionRunResponse> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能做这个操作');
    const result = await client.performUiAction(type, id, action, request);
    const itemId = Number(id);
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      ...(type === 'reminder' && Number.isInteger(itemId) ? [
        this.ensureResource(RESOURCE_KEYS.ticket(itemId), true),
        this.ensureResource(RESOURCE_KEYS.notifications, true),
        this.currentAgendaScope ? this.ensureResource(this.currentAgendaScope.key, true) : Promise.resolve(),
      ] : []),
    ]);
    return result;
  }

  async ackNotification(notificationId: number): Promise<void> {
    await this.dependencies.client.ackNotification(notificationId);
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.notifications, true),
      this.ensureResource('overview', true),
    ]);
  }

  async setLeadDelegation(
    ticketId: number,
    granted: boolean,
    options: Omit<LeadDelegationOptions, 'signal'> = {},
  ): Promise<void> {
    await this.dependencies.client.setLeadDelegation(ticketId, granted, options);
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true),
    ]);
  }

  // 用户控制面动作（kernel spec §6.4）。服务端会推一条 ticket.updated（snapshotRequired），
  // 事件通路本身就会失效那一批资源；这里仍然显式重取一遍，理由是"点完按钮到看见新状态"
  // 不该依赖一条可能正在重连的 socket——动作是同步语义的，用户按下去就该看到结果。
  // 事件到达时会再失效一次，那是幂等的。
  async performTicketAction(
    ticketId: number,
    action: UserItemActionId,
    options: Omit<TicketActionOptions, 'signal'> = {},
  ): Promise<void> {
    const result = await this.dependencies.client.performTicketAction(
      ticketId,
      action,
      options,
    );
    // 动作响应包含事务提交后的根工单快照。先同步写入，确保状态徽标和动作行
    // 与按钮结果同时更新；后面的全量重取负责补齐任务树中子工单等关联变化。
    if (result.ticket) this.control.getState().upsertTicket(result.ticket);
    const epoch = this.lifecycle;
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true),
      this.ensureResource(`execution:${ticketId}`, true),
      this.ensureResource(RESOURCE_KEYS.workbench(ticketId), true),
    ]);
    if (!this.isCurrent(epoch)) return;
  }

  // 手动派发独立核查。和用户动作一样：先写入响应里的工单快照，再重取相关资源。
  // runtime：用户选的核查员（2026-10-20）。有排着或挂起的核查就换它的核查员，没有就用它新排一条；
  // 核查正在跑、这个 runtime 停用或有故障时，服务端返回 409 和原因。
  async requestTicketReview(ticketId: number, options: { runtime?: TicketReviewRequest['runtime'] } = {}): Promise<void> {
    const result = options.runtime
      ? await this.dependencies.client.requestTicketReview(ticketId, { runtime: options.runtime })
      : await this.dependencies.client.requestTicketReview(ticketId);
    if (result.ticket) this.control.getState().upsertTicket(result.ticket);
    const epoch = this.lifecycle;
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true),
      this.ensureResource(`execution:${ticketId}`, true),
      this.ensureResource(RESOURCE_KEYS.workbench(ticketId), true),
    ]);
    if (!this.isCurrent(epoch)) return;
  }

  // 这张工单的核查员和可选的核查员（2026-10-20，GET /v1/tickets/:id/reviewer）。不缓存，换核查员的界面打开时读一次。
  // 不放进工单快照：工单列表是严格校验的，加字段会让旧页面整张列表加载失败。旧 daemon 没有这个接口时报错。
  async getTicketReviewer(ticketId: number, signal?: AbortSignal): Promise<TicketReviewerInfo> {
    const read = this.dependencies.client.getTicketReviewer;
    if (typeof read !== 'function') throw new Error('this connection cannot read the ticket reviewer');
    return read.call(this.dependencies.client, ticketId, signal);
  }

  async performWorkspaceAction(
    workspaceId: number,
    action: WorkspaceControlActionId,
    options: Omit<WorkspaceActionOptions, "signal"> = {},
  ): Promise<void> {
    const result = await this.dependencies.client.performWorkspaceAction(workspaceId, action, options);
    if (result.ticket) this.control.getState().upsertTicket(result.ticket);
    const epoch = this.lifecycle;
    await Promise.allSettled([
      this.ensureResource("tickets", true),
      this.ensureResource("overview", true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      this.ensureResource(RESOURCE_KEYS.ticket(result.ownerTicketId), true),
      this.ensureResource(`execution:${result.ownerTicketId}`, true),
      this.ensureResource(RESOURCE_KEYS.workbench(result.ownerTicketId), true),
    ]);
    if (!this.isCurrent(epoch)) return;
  }

  async linkTicketRelation(
    sourceTicketId: number,
    input: LinkTicketRelationInput,
  ): Promise<TicketRelationActionResult> {
    const result = await this.dependencies.client.linkTicketRelation(sourceTicketId, input);
    await this.refreshRelationResources([sourceTicketId, result.sourceTicketId, result.targetTicketId]);
    return result;
  }

  async revokeTicketRelation(
    ticketId: number,
    relationId: number,
    input: RevokeTicketRelationInput,
  ): Promise<TicketRelationActionResult> {
    const result = await this.dependencies.client.revokeTicketRelation(ticketId, relationId, input);
    await this.refreshRelationResources([ticketId, result.sourceTicketId, result.targetTicketId]);
    return result;
  }

  private async refreshRelationResources(ticketIds: number[]): Promise<void> {
    const uniqueTicketIds = [...new Set(ticketIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const epoch = this.lifecycle;
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      ...uniqueTicketIds.map((ticketId) => this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true)),
      ...uniqueTicketIds.map((ticketId) => this.ensureResource(RESOURCE_KEYS.workbench(ticketId), true)),
    ]);
    if (!this.isCurrent(epoch)) return;
  }

  ensureWorkItems(): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.workItems);
  }

  observeWorkItems(): () => void {
    return this.observeResource(RESOURCE_KEYS.workItems);
  }

  ensureTicketWorkbench(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.workbench(ticketId));
  }

  observeTicketWorkbench(ticketId: number): () => void {
    return this.observeResource(RESOURCE_KEYS.workbench(ticketId));
  }

  ensureTicketCheckpoints(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.checkpoints(ticketId));
  }

  observeTicketCheckpoints(ticketId: number): () => void {
    return this.observeResource(RESOURCE_KEYS.checkpoints(ticketId));
  }

  ensureArtifacts(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.artifacts(ticketId));
  }

  observeArtifacts(ticketId: number): () => void {
    return this.observeResource(RESOURCE_KEYS.artifacts(ticketId));
  }

  // 重取这张工单现在能做的操作：清单读不到时，底部操作栏上的「重试」。
  reloadTicketActions(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.actions(ticketId), true);
  }

  // 连着的 daemon 的地址，例如 http://127.0.0.1:47130。daemon 也在这个地址上提供网页：手机应用里没有网页的地址，
  // 复制工单链接时用它。还没配对时是 null。
  endpoint(): string | null {
    return this.credentials?.baseUrl ?? null;
  }

  ensureTicketDelivery(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.delivery(ticketId));
  }

  observeTicketDelivery(ticketId: number): () => void {
    return this.observeResource(RESOURCE_KEYS.delivery(ticketId));
  }

  // 交付里一个文件的全文或改动。按需读，不进缓存：文件可能很大，看完就关。
  async getTicketDeliveryFile(ticketId: number, path: string, view: DeliveryFileView): Promise<DeliveryFileContent> {
    if (!this.dependencies.client.getTicketDeliveryFile) throw new Error('这个版本的服务端不能预览文件。');
    return this.dependencies.client.getTicketDeliveryFile(ticketId, path, view);
  }

  // 验收并合并、开 PR、放弃改动。先写入响应里的交付，再重取工单相关的资源（验收会改工单状态）。
  // 带上界面画出来的那份交付（workspace.head、workspace.target），服务端比对（2026-10-21 审查 M2）。交付在用户看过以后
  // 变了，服务端拒绝（409，details.reason 是 stale）：重取交付，让用户看过新的再决定。
  async performDeliveryAction(ticketId: number, action: DeliveryActionId): Promise<DeliveryActionResult> {
    if (!this.dependencies.client.performDeliveryAction) throw new Error('这个版本的服务端不支持这个操作。');
    const seen = this.control.getState().deliveryByTicket[ticketId]?.workspace ?? null;
    let result: DeliveryActionResult;
    try {
      result = await this.dependencies.client.performDeliveryAction(
        ticketId, action, seen ? { expected: { head: seen.head, target: seen.target } } : {},
      );
    } catch (error) {
      if (deliveryChangedSinceSeen(error)) await Promise.allSettled([this.ensureResource(`delivery:${ticketId}`, true)]);
      throw error;
    }
    this.control.getState().replaceDelivery(ticketId, result.delivery);
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true),
      this.ensureResource(`execution:${ticketId}`, true),
      this.ensureResource(RESOURCE_KEYS.workbench(ticketId), true),
    ]);
    return result;
  }

  // 工单操作（工单 03 的操作层，spec 5.11）：页面上会改后端的按钮都走这里，和 Lead 的 ticket_action 是同一个函数。
  // 和用户动作一样：先写入响应里的工单快照，再重取这张工单相关的资源，其中包括「现在能做哪些操作」。
  // 服务端拒绝时（409，原因和清单里的 reason 一样）也重取清单：页面上的按钮可能已经过时。
  async runTicketAction(ticketId: number, action: TicketOperationId, request: TicketActionRunRequest = {}): Promise<TicketActionRunResponse> {
    const run = this.dependencies.client.runTicketAction;
    if (typeof run !== 'function') throw new Error('这个版本的服务端不支持这个操作。');
    let result: TicketActionRunResponse;
    try {
      result = await run.call(this.dependencies.client, ticketId, action, request);
    } catch (error) {
      await Promise.allSettled([this.ensureResource(RESOURCE_KEYS.actions(ticketId), true)]);
      throw error;
    }
    if (Value.Check(TicketSummarySchema, result.ticket)) this.control.getState().upsertTicket(result.ticket as TicketSummary);
    await Promise.allSettled([
      this.ensureResource('tickets', true),
      this.ensureResource('overview', true),
      this.ensureResource(RESOURCE_KEYS.workItems, true),
      this.ensureResource(RESOURCE_KEYS.ticket(ticketId), true),
      this.ensureResource(`execution:${ticketId}`, true),
      this.ensureResource(RESOURCE_KEYS.workbench(ticketId), true),
      this.ensureResource(RESOURCE_KEYS.actions(ticketId), true),
      this.ensureResource(RESOURCE_KEYS.acceptanceCriteria(ticketId), true),
    ]);
    return result;
  }

  async downloadArtifact(ticketId: number, artifactId: number): Promise<void> {
    if (this.artifactDownloadControllers.has(artifactId)) return;
    const controller = this.controller();
    this.artifactDownloadControllers.set(artifactId, controller);
    this.workspace.getState().setArtifactDownloadState(artifactId, {
      state: 'downloading', error: null, retryable: false,
    });
    try {
      const payload = await this.dependencies.client.downloadArtifact(ticketId, artifactId, controller.signal);
      await presentArtifactDownload({ artifactId, ...payload }, controller.signal);
      this.workspace.getState().setArtifactDownloadState(artifactId, {
        state: 'succeeded', error: null, retryable: false,
      });
    } catch (reason) {
      if (isAbortError(reason)) {
        this.workspace.getState().setArtifactDownloadState(artifactId, {
          state: 'idle', error: null, retryable: true,
        });
      } else {
        this.workspace.getState().setArtifactDownloadState(artifactId, {
          state: 'error', error: errorMessage(reason), retryable: true,
        });
      }
      throw reason;
    } finally {
      this.artifactDownloadControllers.delete(artifactId);
      this.controllers.delete(controller);
    }
  }

  cancelArtifactDownload(artifactId: number): void {
    this.artifactDownloadControllers.get(artifactId)?.abort();
  }

  refreshCheckpoints(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.checkpoints(ticketId), true);
  }

  async loadOlderCheckpoints(ticketId: number): Promise<void> {
    const key = RESOURCE_KEYS.checkpoints(ticketId);
    if (!this.isResourceSupported(key)) return this.markUnsupported(key);
    const page = this.control.getState().checkpointPagesByTicket[ticketId];
    if (!page?.hasMore || page.nextBeforeId === null) return;
    const epoch = this.lifecycle;
    const controller = this.controller();
    try {
      const value = await this.dependencies.client.getKernelCheckpoints(
        ticketId,
        { beforeId: page.nextBeforeId },
        controller.signal,
        this.kernelResourceVersion('checkpoints') ?? 1,
      );
      if (this.isCurrent(epoch)) this.control.getState().mergeCheckpointPage(ticketId, value, 'prepend');
    } finally {
      this.controllers.delete(controller);
    }
  }

  ensureInterventions(ticketId: number): Promise<void> {
    return this.ensureResource(RESOURCE_KEYS.interventions(ticketId));
  }

  observeInterventions(ticketId: number): () => void {
    return this.observeResource(RESOURCE_KEYS.interventions(ticketId));
  }

  ensureConversationCards(ticketId?: number): Promise<void> {
    return this.ensureResource(ticketId === undefined
      ? RESOURCE_KEYS.conversationCards
      : RESOURCE_KEYS.conversationCardsForTicket(ticketId));
  }

  observeConversationCards(ticketId?: number): () => void {
    return this.observeResource(ticketId === undefined
      ? RESOURCE_KEYS.conversationCards
      : RESOURCE_KEYS.conversationCardsForTicket(ticketId));
  }

  async loadOlderConversationCards(ticketId?: number): Promise<void> {
    const key = ticketId === undefined
      ? RESOURCE_KEYS.conversationCards
      : RESOURCE_KEYS.conversationCardsForTicket(ticketId);
    if (!this.isResourceSupported(key)) return this.markUnsupported(key);
    const page = this.control.getState().conversationCardPagesByResource[key];
    if (!page?.hasMore || page.nextBeforeId === null) return;
    const epoch = this.lifecycle;
    const generation = this.invalidation.generation(key);
    const controller = this.controller();
    try {
      const value = await this.dependencies.client.getKernelConversationCards({
        ...(ticketId === undefined ? {} : { ticketIds: [ticketId] }),
        beforeId: page.nextBeforeId,
      }, controller.signal);
      if (this.isCurrent(epoch) && this.invalidation.generation(key) === generation) {
        this.control.getState().mergeConversationCardPage(value, 'prepend', key);
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  async resolveIntervention(
    interventionId: string,
    input: ResolveKernelInterventionRequest,
  ): Promise<void> {
    if (this.control.getState().connectionState !== 'connected') {
      throw new Error('control plane is not connected');
    }
    const commandState = this.workspace.getState().interventionCommandStateById[interventionId];
    const intervention = this.control.getState().interventionsById[interventionId]
      ?? this.control.getState().interventionRefsById[interventionId];
    if (
      commandState?.state === 'pending' ||
      commandState?.state === 'succeeded' ||
      (intervention !== undefined && intervention.state !== 'pending')
    ) {
      throw new Error(`intervention ${interventionId} was already submitted or resolved`);
    }
    const epoch = this.lifecycle;
    const commandId = this.dependencies.createCommandId?.() ??
      `cmd_${Date.now().toString(36)}_${(++this.commandCounter).toString(36)}`;
    const controller = this.controller();
    this.workspace.getState().setInterventionCommandState(interventionId, {
      state: 'pending', error: null, retryable: false,
    });
    try {
      await this.dependencies.client.resolveKernelIntervention(
        interventionId,
        input,
        commandId,
        controller.signal,
      );
      if (!this.isCurrent(epoch)) return;
      if (intervention) {
        await Promise.allSettled([
          this.ensureResource(RESOURCE_KEYS.interventions(intervention.ticketId), true),
          this.ensureResource(RESOURCE_KEYS.checkpoints(intervention.ticketId), true),
          this.ensureResource(RESOURCE_KEYS.workbench(intervention.ticketId), true),
          this.ensureResource(RESOURCE_KEYS.conversationCardsForTicket(intervention.ticketId), true),
        ]);
      }
      if (!this.isCurrent(epoch)) return;
      this.workspace.getState().setInterventionCommandState(interventionId, {
        state: 'succeeded', error: null, retryable: false,
      });
    } catch (reason) {
      if (this.isCurrent(epoch)) {
        this.workspace.getState().setInterventionCommandState(interventionId, {
          state: 'error', error: errorMessage(reason), retryable: isRetryableCommandError(reason),
        });
      }
      throw reason;
    } finally {
      this.controllers.delete(controller);
    }
  }

  ensureResource(key: ResourceKey, force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.isResourceSupported(key)) return this.markUnsupported(key);
    const resource = this.control.getState().resourceState[key];
    if (!force && resource?.state === 'ready') return Promise.resolve();
    return force ? this.invalidation.refresh(key) : this.invalidation.ensure(key);
  }

  observeResource(key: ResourceKey): () => void {
    const current = this.control.getState().resourceState[key];
    this.setResourceState(key, { observerCount: (current?.observerCount ?? 0) + 1 });
    void this.ensureResource(key).catch(() => {});
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.releaseResource(key);
    };
  }

  releaseResource(key: ResourceKey): void {
    const current = this.control.getState().resourceState[key];
    const observerCount = Math.max(0, (current?.observerCount ?? 1) - 1);
    this.setResourceState(key, { observerCount });
    if (observerCount === 0) this.invalidation.release(key);
  }

  async getTicketExecution(ticketId: number) {
    await this.ensureTicketExecution(ticketId);
    const state = this.control.getState();
    return {
      activities: (state.activityIdsByTicket[ticketId] ?? []).flatMap((id) => state.activitiesById[id] ? [state.activitiesById[id]] : []),
      attempts: (state.attemptIdsByTicket[ticketId] ?? []).flatMap((id) => {
        const attempt = state.attemptsById[id];
        return attempt ? [{
          id: attempt.id,
          ticketId: attempt.ticketId,
          role: attempt.role,
          state: attempt.state,
          model: attempt.model,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
        }] : [];
      }),
    };
  }

  ensureTicketExecution(ticketId: number): Promise<void> {
    const existing = this.executionLoads.get(ticketId);
    if (existing) return existing;
    const key = `execution:${ticketId}` as const;
    const resource = this.control.getState().resourceState[key];
    if (resource?.state === 'ready') return Promise.resolve();
    const epoch = this.lifecycle;
    const controller = this.controller();
    this.setResourceState(key, { state: 'loading', error: null });
    const load = Promise.all([
      this.dependencies.client.getActivities(ticketId, controller.signal),
      this.dependencies.client.getAttempts(ticketId, controller.signal),
    ]).then(([activities, attempts]) => {
      if (!this.isCurrent(epoch)) return;
      this.control.getState().replaceActivities(ticketId, activities);
      this.control.getState().replaceAttempts(ticketId, attempts);
      this.setResourceState(key, { state: 'ready', error: null, lastSuccessAt: this.dependencies.scheduler.now() });
      this.reconcileWorkspaceSelections();
    }).catch((reason) => {
      if (this.isCurrent(epoch)) this.setResourceState(key, { state: 'error', error: errorMessage(reason) });
      throw reason;
    }).finally(() => {
      this.controllers.delete(controller);
      if (this.executionLoads.get(ticketId) === load) this.executionLoads.delete(ticketId);
    });
    this.executionLoads.set(ticketId, load);
    return load;
  }

  observeTicketExecution(ticketId: number): () => void {
    const key = `execution:${ticketId}` as const;
    const current = this.control.getState().resourceState[key];
    this.setResourceState(key, { observerCount: (current?.observerCount ?? 0) + 1 });
    void this.ensureTicketExecution(ticketId).catch(() => {});
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const latest = this.control.getState().resourceState[key];
      this.setResourceState(key, { observerCount: Math.max(0, (latest?.observerCount ?? 1) - 1) });
    };
  }

  ensureAttemptEvents(attemptId: number): Promise<void> {
    const existing = this.attemptEventLoads.get(attemptId);
    if (existing) return existing;
    const controller = this.controller();
    const epoch = this.lifecycle;
    const load = this.dependencies.client.getAttemptEvents(attemptId, controller.signal).then((events) => {
      if (!this.isCurrent(epoch)) return;
      this.streams.getState().applyBatch({}, events.map(runtimeEventLogEntry), this.dependencies.scheduler.now());
    }).finally(() => {
      this.controllers.delete(controller);
      if (this.attemptEventLoads.get(attemptId) === load) this.attemptEventLoads.delete(attemptId);
    });
    this.attemptEventLoads.set(attemptId, load);
    return load;
  }

  async forget(): Promise<void> {
    this.beginLifecycle();
    this.streamCoordinator.dispose();
    this.invalidation.dispose();
    await this.dependencies.client.forget();
    this.credentials = null;
    this.scopes.clear();
    this.capabilities.clear();
    this.activeSessionId = null;
    this.pendingTurns = null;
    this.currentAgendaScope = null;
    // 取消配对：发件箱里的消息属于原来那个 binding，不发给以后配对的 daemon。
    this.outbox.stop();
    await (this.dependencies.outboxStorage ?? memoryOutboxStorage()).save([]).catch(() => {});
    this.outbox = this.createOutbox(this.dependencies.outboxStorage ?? memoryOutboxStorage());
    this.outboxLoad = Promise.resolve();
    this.shownOutboxIds.clear();
    this.control.getState().reset();
    this.streams.getState().reset();
    this.workspace.getState().resetForForget();
    this.control.setState({ phase: 'unpaired', connectionState: 'disconnected' });
    if (!this.stopped) {
      this.streamCoordinator = this.createStreamCoordinator();
      this.invalidation = this.createInvalidationCoordinator();
    }
  }

  // 配对时保存的 binding（id、名称、类型、scope）。没有配对时是 null。
  currentBinding(): BindingDto | null {
    return this.credentials?.binding ?? null;
  }

  // 设置里的「本设备」和「已配对设备」读这三个。listBindings 和 revokeBinding 要 admin scope，
  // 普通的 companion 凭证没有它，网关回 403。
  getOwnBinding(signal?: AbortSignal): Promise<BindingDto> {
    const client = this.dependencies.client;
    if (!client.getOwnBinding) return Promise.reject(new Error('this client cannot read its binding'));
    return client.getOwnBinding(signal);
  }

  listBindings(signal?: AbortSignal): Promise<AdminBinding[]> {
    const client = this.dependencies.client;
    if (!client.listBindings) return Promise.reject(new Error('this client cannot list bindings'));
    return client.listBindings(signal);
  }

  revokeBinding(bindingId: number): Promise<AdminBinding> {
    const client = this.dependencies.client;
    if (!client.revokeBinding) return Promise.reject(new Error('this client cannot revoke bindings'));
    if (bindingId === this.credentials?.binding.id) return Promise.reject(new Error('cannot revoke this device from itself'));
    return client.revokeBinding(bindingId);
  }

  // 设置 → 设备 → 添加手机：本机网页给手机生成扫码配对邀请，再轮询它有没有被兑换。网关只在回环上开这两条路由。
  // 邀请的 uri 和 qr 是凭证：不写进 store，也不写日志，只交给调用它的界面。
  createLoopbackInvitation(input: LoopbackInvitationRequest, signal?: AbortSignal): Promise<LoopbackInvitation> {
    const client = this.dependencies.client;
    if (!client.createLoopbackInvitation) return Promise.reject(new Error('this client cannot create pairing invitations'));
    return client.createLoopbackInvitation(input, signal);
  }

  getLoopbackInvitationStatus(pairingId: number, signal?: AbortSignal): Promise<LoopbackInvitationStatus> {
    const client = this.dependencies.client;
    if (!client.getLoopbackInvitationStatus) return Promise.reject(new Error('this client cannot read pairing invitations'));
    return client.getLoopbackInvitationStatus(pairingId, signal);
  }

  cancelLoopbackInvitation(pairingId: number, signal?: AbortSignal): Promise<LoopbackInvitationStatus> {
    const client = this.dependencies.client;
    if (!client.cancelLoopbackInvitation) return Promise.reject(new Error('this client cannot cancel pairing invitations'));
    return client.cancelLoopbackInvitation(pairingId, signal);
  }

  // ——— 连接（第三方账号）———
  // 每个动作的响应里带着这个连接的新状态：先写进 store，界面马上变；网关随后推 snapshot.required，再整体重取一次。
  async startConnection(key: string, input: { token?: string } = {}): Promise<StartConnectionResponse> {
    const response = await this.connectionClient('startConnection')(key, input);
    if (response.flow === 'connected') this.upsertConnection(response.connection);
    return response;
  }

  async addCustomConnection(serverUrl: string): Promise<StartConnectionResponse> {
    const response = await this.connectionClient('addCustomConnection')(serverUrl);
    if (response.flow === 'connected') this.upsertConnection(response.connection);
    void this.ensureResource(RESOURCE_KEYS.connections, true).catch(() => {});
    return response;
  }

  async connectionFlow(flowId: string, signal?: AbortSignal): Promise<ConnectionFlowResponse> {
    const response = await this.connectionClient('connectionFlow')(flowId, signal);
    if (response.connection) this.upsertConnection(response.connection);
    return response;
  }

  async updateConnectionSettings(key: string, settings: ConnectionSettingsRequest): Promise<ConnectionDto> {
    return this.upsertConnection(await this.connectionClient('updateConnectionSettings')(key, settings));
  }

  async testConnection(key: string): Promise<ConnectionTestResponse> {
    const response = await this.connectionClient('testConnection')(key);
    this.upsertConnection(response.connection);
    return response;
  }

  async disconnectConnection(key: string): Promise<ConnectionDto> {
    const connection = this.upsertConnection(await this.connectionClient('disconnectConnection')(key));
    void this.ensureResource(RESOURCE_KEYS.connections, true).catch(() => {});
    return connection;
  }

  connectionTools(key: string, signal?: AbortSignal): Promise<ConnectionToolDto[]> {
    return this.connectionClient('connectionTools')(key, signal);
  }

  connectionConfirmation(id: string, signal?: AbortSignal): Promise<ConnectionConfirmationDto> {
    return this.connectionClient('connectionConfirmation')(id, signal);
  }

  resolveConnectionConfirmation(id: string, approve: boolean): Promise<ConnectionConfirmationDto> {
    return this.connectionClient('resolveConnectionConfirmation')(id, approve);
  }

  // 会话里的 MemorySwitchConfirm 卡：读一次记忆切换，按你的决定确认或者不切换。
  memorySwitch(id: string, signal?: AbortSignal): Promise<MemorySwitch> {
    return this.memoryClient('memorySwitch')(id, signal);
  }

  async confirmMemorySwitch(id: string, approve: boolean): Promise<MemorySwitchConfirmResponse> {
    const response = await this.memoryClient('confirmMemorySwitch')(id, approve);
    // 设置页和会话卡读同一份记忆设置：确认（或不切换）以后马上换成 daemon 回的这一份。
    this.control.setState({ memory: response.memory });
    return response;
  }

  // 设置页的「记忆」和「模型」。改完马上换成 daemon 回的设置；网关之后的 snapshot.required 也会触发重取。
  async updateMemorySettings(request: MemorySettingsRequest): Promise<MemorySettingsDto> {
    const memory = await this.memoryClient('updateMemorySettings')(request);
    this.control.setState({ memory });
    return memory;
  }

  testMemoryEmbedding(): Promise<MemoryTestResponse> {
    return this.memoryClient('testMemoryEmbedding')();
  }

  async updateDecisionModel(request: DecisionModelSettingsRequest): Promise<DecisionModelDto> {
    const decisionModel = await this.memoryClient('updateDecisionModel')(request);
    this.control.setState({ decisionModel });
    // 重排在用决策模型时，换了 key 或主机会改变实际在用的重排：记忆设置也重取一次。
    // daemon 回复之前已经生成了要确认的切换，所以等重取完再返回，调用方读到的就是切换后的记忆设置。
    await this.ensureResource(RESOURCE_KEYS.memory, true).catch(() => {});
    return decisionModel;
  }

  testDecisionModel(): Promise<MemoryTestResponse> {
    return this.memoryClient('testDecisionModel')();
  }

  // 设置 → 模型的一次改动（操作层的 model_settings，和 Lead 的 perform_action 同一个函数）。改完重取模型设置；
  // 直觉变了时重排可能跟着换，记忆设置也重取一次（daemon 回复之前已经生成了要确认的切换）。
  async modelSettingsAction(action: string, input: Record<string, unknown>): Promise<unknown> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能改模型设置');
    const outcome = await client.performUiAction('model_settings', 'models', action, { input });
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.modelSettings, true),
      this.ensureResource(RESOURCE_KEYS.setup, true),
      ...(action.includes('fast') ? [this.ensureResource(RESOURCE_KEYS.memory, true), this.ensureResource(RESOURCE_KEYS.decisionModel, true)] : []),
    ]);
    return outcome.result;
  }

  // 设置 → 记忆的 Hindsight 部分的一次操作（操作层的 memory_settings，和 Lead 的 perform_action 同一个函数）：
  // 选摘要模型、测试摘要模型、重试失败的写入。改了的操作完成后重取这一份和记忆设置（记忆服务可能在重启）；
  // 测试是只读的，不重取。网关之后的 snapshot.required（resource 是 memory）也会触发重取。
  async memorySettingsAction(action: string, input: Record<string, unknown>): Promise<unknown> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能改记忆设置');
    const outcome = await client.performUiAction('memory_settings', 'memory', action, { input });
    if (action !== 'test_summary_model') {
      await Promise.allSettled([
        this.ensureResource(RESOURCE_KEYS.memoryHindsight, true),
        this.ensureResource(RESOURCE_KEYS.memory, true),
      ]);
    }
    return outcome.result;
  }

  // 设置 → 记忆的常驻偏好和失效的事实的一次操作（2026-10-29，.scratch/hindsight-primary-memory/spec.md D5、D15）：
  //   core_memory / <编号> / update、delete；core_memory_change / <改动编号> / undo；memory_fact / <记忆编号> / restore。
  // 和 Lead 的 perform_action 同一个函数，actor 是你本人。做完重取在屏幕上的常驻偏好和 Hindsight 那一份；
  // 网关之后的 snapshot.required（resource 是 memory）也会触发重取。失败时抛出，原因是 daemon 写的那句话。
  async memoryAction(type: 'core_memory' | 'core_memory_change' | 'memory_fact', id: string, action: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能改记忆');
    const outcome = await client.performUiAction(type, id, action, { input });
    await this.refreshObservedMemory();
    return outcome.result;
  }

  // 视图面板上的一次操作（2026-10-30，.scratch/custom-views/spec.md）：widget / <编号> / update、delete，
  // widget_board / widgets / reorder。和 Lead 的 perform_action 同一个函数，actor 是你本人。做完重取控件；
  // 网关之后的 snapshot.required（resource 是 widgets）也会触发重取。失败时抛出，原因是 daemon 写的那句话。
  async widgetAction(type: 'widget' | 'widget_board', id: string, action: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能改控件');
    const outcome = await client.performUiAction(type, id, action, { input });
    await this.ensureResource(RESOURCE_KEYS.widgets, true);
    return outcome.result;
  }

  // 「Lead 动态」卡上的按钮（LeadActivityCard.action，2026-10-29：Lead 改了常驻偏好或者让一条事实失效，卡上带「撤销」）。
  // 一个操作层的操作，input 是 {}。撤销以后同一张卡原地更新、按钮消失，靠网关推的 lead-activity 快照，这里不改卡。
  // 设置 → 记忆开着时，那一份也跟着重取。
  async leadActivityCardAction(action: LeadActivityCardAction): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.performUiAction !== 'function') throw new Error('这个版本的客户端不能做这个操作');
    await client.performUiAction(action.target.type, action.target.id, action.action, { input: {} });
    await this.refreshObservedMemory();
  }

  // 设置 → 记忆在屏幕上时，重取常驻偏好和 Hindsight 那一份。没人看的不取，下次打开时再取。
  private async refreshObservedMemory(): Promise<void> {
    const resources = this.control.getState().resourceState;
    const keys = [RESOURCE_KEYS.memoryPreferences, RESOURCE_KEYS.memoryHindsight]
      .filter((key) => (resources[key]?.observerCount ?? 0) > 0);
    await Promise.allSettled(keys.map((key) => this.ensureResource(key, true)));
  }

  // 设置页的「执行器」：拨一个开关。改完马上换成 daemon 回的设置；网关之后的 snapshot.required 也会触发重取。
  async updateRuntimeSettings(request: RuntimeSettingsRequest): Promise<RuntimeSettingsDto> {
    const runtimeSettings = await this.memoryClient('updateRuntimeSettings')(request);
    this.control.setState({ runtimeSettings });
    return runtimeSettings;
  }

  // 设置页的「身份与风格」：改名字、人格和互动风格。改完马上换成 daemon 回的值；网关之后的 snapshot.required 也会触发重取。
  async updateLeadProfile(request: LeadProfileRequest): Promise<LeadProfileDto> {
    const leadProfile = await this.memoryClient('updateLeadProfile')(request);
    rememberLeadName(leadProfile.name);
    this.control.setState({ leadProfile });
    return leadProfile;
  }

  // 设置页的「形象」：上传、去掉一种状态的图，改 Slack 署名的 emoji。改完马上换成 daemon 回的值，再取新图。
  async uploadLeadAvatarSlot(slot: LeadAvatarSlot, request: LeadAvatarUploadRequest): Promise<LeadAvatarDto> {
    return this.applyLeadAvatar(await this.memoryClient('uploadLeadAvatarSlot')(slot, request));
  }

  async clearLeadAvatarSlot(slot: LeadAvatarSlot): Promise<LeadAvatarDto> {
    return this.applyLeadAvatar(await this.memoryClient('clearLeadAvatarSlot')(slot));
  }

  async setLeadAvatarSlackEmoji(request: LeadAvatarSlackEmojiRequest): Promise<LeadAvatarDto> {
    return this.applyLeadAvatar(await this.memoryClient('setLeadAvatarSlackEmoji')(request));
  }

  // Slack 署名的预览：输入框里写的短代码在 Slack 里是什么样子（不保存）。
  previewSlackEmoji(code: string, signal?: AbortSignal): Promise<SlackEmojiPreview> {
    return this.memoryClient('previewSlackEmoji')(code, signal);
  }

  private applyLeadAvatar(leadAvatar: LeadAvatarDto): LeadAvatarDto {
    this.control.setState({ leadAvatar });
    this.loadLeadAvatarImages(leadAvatar);
    return leadAvatar;
  }

  // 取形象里引用的、还没取过的图（最多四张）。取到一张就放进 leadAvatarImages；取不到时记空字符串，界面用系统素材。
  private loadLeadAvatarImages(avatar: LeadAvatarDto): void {
    const getImage = this.dependencies.client.getLeadAvatarImage;
    if (typeof getImage !== 'function') return;
    const known = this.control.getState().leadAvatarImages;
    const ids = new Set(Object.values(avatar.slots).flatMap((ref) => (ref ? [ref.id] : [])));
    for (const id of ids) {
      if (known[id] !== undefined || this.leadAvatarImagesLoading.has(id)) continue;
      this.leadAvatarImagesLoading.add(id);
      getImage.call(this.dependencies.client, id).then(
        (image) => `data:${image.mimeType};base64,${image.data}`,
        () => '',
      ).then((uri) => {
        this.leadAvatarImagesLoading.delete(id);
        this.control.setState({ leadAvatarImages: { ...this.control.getState().leadAvatarImages, [id]: uri } });
      });
    }
  }

  // 设置页的「外观」：改密度、圆角、行高、字号、颜色和设计说明。改完马上换成 daemon 回的值。
  async updateDesignPreferences(request: DesignPreferencesRequest): Promise<DesignPreferencesDto> {
    const designPreferences = await this.memoryClient('updateDesignPreferences')(request);
    this.control.setState({ designPreferences });
    return designPreferences;
  }

  // 设置页的「消息通道」：试一次密钥（不保存）、保存、断开。保存和断开以后马上换成 daemon 回的这个来源；
  // 连上、断开、出错时网关推 snapshot.required（resource 是 channel-settings），列表跟着重取。
  // 保存没通过检查时，客户端抛 ChannelSecretsRejectedError（带每项检查的结果），这里原样交给界面。
  testChannelSecrets(source: string, secrets: Record<string, string>): Promise<ChannelSecretsTestResult> {
    return this.channelSettingsClient('testChannelSecrets')(source, secrets);
  }

  async saveChannelSecrets(source: string, secrets: Record<string, string>): Promise<ChannelSourceSettingsDto> {
    return this.upsertChannelSource(await this.channelSettingsClient('saveChannelSecrets')(source, secrets));
  }

  async clearChannelSecrets(source: string): Promise<ChannelSourceSettingsDto> {
    return this.upsertChannelSource(await this.channelSettingsClient('clearChannelSecrets')(source));
  }

  // 设置 → 消息通道 → 自动代你处理（2026-10-23）：开关、授权表和信心模型的参数。面板自己保存读到的结果，改完用响应替换。
  // 测一条消息、评估过去 24 小时的消息只读。都是 async：旧客户端没有这些方法时返回失败的 Promise，不在渲染里同步抛错。
  async channelPolicy(source: string): Promise<ChannelPolicyDto> {
    return this.channelSettingsClient('getChannelPolicy')(source);
  }

  async updateChannelPolicy(source: string, params: ChannelPolicyParams): Promise<ChannelPolicyDto> {
    return this.channelSettingsClient('updateChannelPolicy')(source, params);
  }

  async testChannelPolicy(source: string, request: ChannelPolicyTestRequest): Promise<ChannelPolicyTestResult> {
    return this.channelSettingsClient('testChannelPolicy')(source, request);
  }

  async replayChannelPolicy(source: string, params: ChannelPolicyParams): Promise<ChannelPolicyReplayResult> {
    return this.channelSettingsClient('replayChannelPolicy')(source, params);
  }

  // 设置 → 消息通道 → 自动代你处理（交接说明，2026-10-30）：页面自己保存读到的结果，改完用响应替换。预演只读。
  async channelHandbook(): Promise<ChannelHandbookDto> {
    return this.channelSettingsClient('getChannelHandbook')();
  }

  async updateChannelHandbook(handbook: ChannelHandbook): Promise<ChannelHandbookDto> {
    return this.channelSettingsClient('updateChannelHandbook')(handbook);
  }

  async rehearseChannelHandbook(request: HandbookRehearsalRequest): Promise<HandbookRehearsal> {
    return this.channelSettingsClient('rehearseChannelHandbook')(request);
  }

  async proposeChannelHandbookSituation(request: HandbookProposalRequest): Promise<HandbookProposal> {
    return this.channelSettingsClient('proposeChannelHandbookSituation')(request);
  }

  async channelHandbookSuggestions(): Promise<HandbookSuggestions> {
    return this.channelSettingsClient('getChannelHandbookSuggestions')();
  }

  async acceptChannelHandbookSuggestion(key: string): Promise<{ handbook: ChannelHandbookDto; suggestions: HandbookSuggestions }> {
    return this.channelSettingsClient('acceptChannelHandbookSuggestion')(key);
  }

  async dismissChannelHandbookSuggestion(key: string): Promise<HandbookSuggestions> {
    return this.channelSettingsClient('dismissChannelHandbookSuggestion')(key);
  }

  // 设置 → 消息通道 → 代回复风格（2026-10-28）：面板自己保存读到的结果，改完用响应替换。提炼只读，结果是预览。
  async replyStyle(): Promise<ReplyStyleDto> {
    return this.channelSettingsClient('getReplyStyle')();
  }

  async updateReplyStyle(request: ReplyStyleUpdateRequest): Promise<ReplyStyleDto> {
    return this.channelSettingsClient('updateReplyStyle')(request);
  }

  async extractReplyStyle(request: ReplyStyleExtractRequest): Promise<ReplyStyleExtractResult> {
    return this.channelSettingsClient('extractReplyStyle')(request);
  }

  // 一个来源的新状态写进列表。列表还没取到时不建列表，等整体重取。
  private upsertChannelSource(next: ChannelSourceSettingsDto): ChannelSourceSettingsDto {
    const current = this.control.getState().channelSettings;
    if (current) {
      const known = current.sources.some((item) => item.source === next.source);
      const sources = known ? current.sources.map((item) => item.source === next.source ? next : item) : [...current.sources, next];
      this.control.setState({ channelSettings: { ...current, sources } });
    }
    return next;
  }

  private channelSettingsClient<K extends ChannelSettingsClientMethod>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot manage channel settings');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  // 设置 → 常设指令，以及会话里的 StandingOrderChangeConfirm 卡（工单 10）。页面和卡片自己保存读到的结果，
  // 改完（回滚、批准、拒绝）用响应里的新状态替换。
  // 都是 async：旧客户端没有这些方法时返回失败的 Promise，不在渲染里同步抛错。
  async standingOrders(signal?: AbortSignal): Promise<StandingOrderListResponse> {
    return this.standingOrderClient('getStandingOrders')(signal);
  }

  async standingOrder(id: string, signal?: AbortSignal): Promise<StandingOrderDetailResponse> {
    return this.standingOrderClient('getStandingOrder')(id, signal);
  }

  async rollbackStandingOrder(id: string, version: number): Promise<StandingOrderDetailResponse> {
    return this.standingOrderClient('rollbackStandingOrder')(id, version);
  }

  async standingOrderProposal(approvalId: number, signal?: AbortSignal): Promise<StandingOrderProposalResponse> {
    return this.standingOrderClient('standingOrderProposal')(approvalId, signal);
  }

  async decideStandingOrderProposal(approvalId: number, approve: boolean): Promise<StandingOrderProposalResponse> {
    return this.standingOrderClient('decideStandingOrderProposal')(approvalId, approve);
  }

  // 会话里改规则的确认卡（UserAction confirm_rule_change，统一的消息事件工单 09）：卡片自己保存读到的结果，
  // 决定以后用响应里的新状态替换。都是 async：旧客户端没有这些方法时返回失败的 Promise，不在渲染里同步抛错。
  async ruleChangeConfirmation(id: string, signal?: AbortSignal): Promise<RuleChangeConfirmationDto> {
    return this.ruleChangeClient('ruleChangeConfirmation')(id, signal);
  }

  async resolveRuleChangeConfirmation(id: string, decision: RuleChangeDecision): Promise<RuleChangeConfirmationDto> {
    return this.ruleChangeClient('resolveRuleChangeConfirmation')(id, decision);
  }

  // 外部的人要求设的定时器（统一的消息事件 spec D16，工单 12）：会话里的确认卡（UserAction confirm_timer）自己保存读到的结果，
  // 决定以后用响应里的新状态替换；收件箱的「等待中的提醒」列出别人要求设的定时器，可以取消（操作层的 timer.cancel）。
  async timerRequest(id: string, signal?: AbortSignal): Promise<TimerRequestDto> {
    return this.timerClient('timerRequest')(id, signal);
  }

  async resolveTimerRequest(id: string, decision: TimerRequestDecision): Promise<TimerRequestDto> {
    return this.timerClient('resolveTimerRequest')(id, decision);
  }

  async externalTimers(signal?: AbortSignal): Promise<ExternalTimerDto[]> {
    return this.timerClient('externalTimers')(signal);
  }

  // 还在等的后台检查（.scratch/lead-watch/spec.md D5）：所有来源的都列在「等待中的提醒」里，写明谁设的，可以取消。
  // 旧的 daemon 没有这个路由（404），旧的客户端没有这个方法：都返回失败的 Promise，由调用方当作没有。
  async watchTimers(signal?: AbortSignal): Promise<WatchTimerDto[]> {
    return this.timerClient('watchTimers')(signal);
  }

  async cancelTimer(ref: string): Promise<void> {
    await this.timerClient('cancelTimer')(ref);
  }

  // 高风险的主人操作（工单 15）：会话卡读它现在的样子，「不是我」撤销这次操作并作废发出它的凭证。
  getOwnerAction(eventId: string): Promise<OwnerActionDto> {
    return this.ownerActionClient('getOwnerAction')(eventId);
  }

  async disownOwnerAction(eventId: string): Promise<OwnerActionDto> {
    const view = await this.ownerActionClient('disownOwnerAction')(eventId);
    // 推送的通知已经确认，被撤销的工单、审批也变了：重取通知和总览，工单列表跟着网关的事件更新。
    await Promise.allSettled([
      this.ensureResource(RESOURCE_KEYS.notifications, true),
      this.ensureResource('overview', true),
      this.ensureResource('tickets', true),
    ]);
    return view;
  }

  private ownerActionClient<K extends 'getOwnerAction' | 'disownOwnerAction'>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot read owner actions');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  private timerClient<K extends 'timerRequest' | 'resolveTimerRequest' | 'externalTimers' | 'watchTimers' | 'cancelTimer'>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot read timers');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  private ruleChangeClient<K extends 'ruleChangeConfirmation' | 'resolveRuleChangeConfirmation'>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot read rule change confirmations');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  private standingOrderClient<K extends StandingOrderClientMethod>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot read standing orders');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  private memoryClient<K extends MemoryClientMethod>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot manage Lead memory');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  // 客户端的一个连接方法，this 绑在客户端上。旧客户端没有它时抛错。
  private connectionClient<K extends ConnectionClientMethod>(name: K): NonNullable<CompanionTransport[K]> {
    const client = this.dependencies.client;
    const method = client[name];
    if (typeof method !== 'function') throw new Error('this client cannot manage connections');
    return (method as (...args: unknown[]) => unknown).bind(client) as NonNullable<CompanionTransport[K]>;
  }

  // 一个连接的新状态写进列表。列表里还没有它（例如刚加的自定义服务器）时先不加，等整体重取。
  private upsertConnection(connection: ConnectionDto): ConnectionDto {
    const current = this.control.getState().connections;
    if (current && current.items.some((item) => item.key === connection.key)) {
      const items = current.items.map((item) => item.key === connection.key ? connection : item);
      this.control.setState({ connections: { items, attention: connectionAttention(items) } });
    }
    return connection;
  }

  // 告诉 daemon 现在有没有人在看。连接断开重连时由客户端重发。
  setPresence(attended: boolean): void {
    this.dependencies.client.setPresence(attended);
  }

  disconnect(): void {
    this.beginLifecycle();
    this.dependencies.client.disconnect();
    this.control.getState().clearTransientConversationCards();
    this.control.setState({ connectionState: 'disconnected' });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.outbox.stop();
    this.stopWatchingOutbox?.();
    this.stopWatchingOutbox = null;
    this.beginLifecycle();
    this.streamCoordinator.dispose();
    this.invalidation.dispose();
    this.dependencies.client.disconnect();
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const work = this.work;
      const events = this.eventQueue;
      await Promise.all([work, events]);
      if (work === this.work && events === this.eventQueue) return;
    }
  }

  handleEvent(event: GatewayEvent): void {
    const epoch = this.lifecycle;
    this.eventQueue = this.eventQueue.then(() => {
      if (!this.isCurrent(epoch)) return;
      const adapted = adaptGatewayEvent(event);
      if (!adapted.ok) {
        this.control.setState({ error: adapted.error, lastAppliedGatewaySeq: event.seq });
        this.invalidateForEvent(event.seq, this.expandInvalidations(adapted.invalidations));
        return;
      }
      const sessionId = this.activeSessionId;
      if (!sessionId) {
        this.control.setState({ error: 'Lead session is unavailable', lastAppliedGatewaySeq: event.seq });
        return;
      }
      const reduction = reduceGatewayEvent(adapted.event);
      for (const mutation of reduction.control) {
        applyControlPlaneMutation(this.control, sessionId, mutation);
      }
      for (const mutation of reduction.streams) this.applyStreamMutation(mutation);
      this.invalidateForEvent(event.seq, this.expandInvalidations(reduction.invalidations));
      this.control.setState({ lastAppliedGatewaySeq: event.seq });
    });
  }

  handleHello(hello: HelloV2): void {
    this.replayThroughSeq = hello.latestSeq;
    this.activeSessionId = hello.daemon.sessionId;
    this.capabilities = new Set(hello.capabilities);
    this.control.setState({ capabilities: [...hello.capabilities] });
    // Lead 的形象：界面上处处要画。daemon 有没有它要看 hello.v2 的 capabilities，hydrate 的时候还不知道，所以在这里取；
    // 每次连上都重取，断开期间的修改（例如别的设备发了 /fairyeye on）也跟上。旧 daemon 没有时用系统素材。
    if (this.isResourceSupported(RESOURCE_KEYS.leadAvatar)) {
      void this.ensureResource(RESOURCE_KEYS.leadAvatar, true).catch(() => {});
    }
    for (const [key, resource] of Object.entries(this.control.getState().resourceState)) {
      if (!resource) continue;
      if (resource.state !== 'unsupported' || resource.observerCount === 0) continue;
      const typedKey = key as ResourceKey;
      if (!this.isResourceSupported(typedKey)) continue;
      this.setResourceState(typedKey, { state: 'idle', error: null });
      void this.ensureResource(typedKey).catch(() => {});
    }
    if (this.pendingTurns) {
      this.applyConversationSnapshot(this.activeSessionId, this.pendingTurns);
      this.pendingTurns = null;
    }
    this.showOutbox();
    void this.checkWebBuild();
  }

  handlers(): ConnectionHandlers {
    return {
      onEvent: (event) => this.handleEvent(event),
      onHello: (hello) => this.handleHello(hello),
      onStateChange: (connectionState) => {
        if (this.stopped) return;
        this.control.setState({ connectionState });
        if (connectionState === 'connected') {
          this.everReady = true;
          this.control.setState({ phase: 'ready' });
          // 连上了：发件箱不等退避，马上按顺序发。
          this.outbox.connected();
        } else if (!this.everReady) {
          this.control.setState({ phase: 'connecting' });
        }
      },
      onProtocolError: (error) => {
        if (!this.stopped) this.control.setState({ error: error.message });
      },
    };
  }

  private async startInternal(
    epoch: number,
    options: { loopbackEndpoint?: string | null },
  ): Promise<void> {
    const credentials = await this.dependencies.credentials.load();
    if (!this.isCurrent(epoch)) return;
    this.credentials = credentials;
    if (credentials && shouldReplaceLoopbackCredentials(credentials, options.loopbackEndpoint)) {
      if (!await this.switchLoopbackEndpoint(epoch, credentials, options.loopbackEndpoint!)) return;
    } else if (!credentials && options.loopbackEndpoint) {
      const controller = this.controller();
      try {
        await this.dependencies.client.pairLoopback(
          options.loopbackEndpoint,
          'localhost-web',
          controller.signal,
        );
      } catch (reason) {
        if (this.isCurrent(epoch)) this.control.setState({ phase: 'unpaired', connectionState: 'disconnected', error: errorMessage(reason) });
        return;
      } finally {
        this.controllers.delete(controller);
      }
      if (!this.isCurrent(epoch)) return;
      this.credentials = await this.dependencies.credentials.load();
    }
    if (!this.credentials) {
      this.control.setState({ phase: 'unpaired', connectionState: 'disconnected', error: null });
      return;
    }
    // 先读回发件箱：上次没发出去的消息连上就发。
    await this.loadOutbox();
    if (!this.isCurrent(epoch)) return;
    const failures = await this.connectInternal(epoch);
    if (!this.isCurrent(epoch) || !this.credentials || !shouldRecoverLoopbackCredentials(
      this.credentials,
      options.loopbackEndpoint,
      failures,
    )) return;

    if (!await this.replaceLoopbackCredentials(epoch, options.loopbackEndpoint!)) return;
    await this.connectInternal(epoch);
  }

  private async replaceLoopbackCredentials(epoch: number, endpoint: string): Promise<boolean> {
    const controller = this.controller();
    try {
      await this.dependencies.client.forget();
      if (!this.isCurrent(epoch)) return false;
      this.resetForCredentialRecovery();
      this.credentials = await this.dependencies.client.pairLoopback(
        endpoint,
        'localhost-web',
        controller.signal,
      );
      return this.isCurrent(epoch);
    } catch (reason) {
      if (this.isCurrent(epoch)) {
        this.control.setState({
          phase: 'unpaired',
          connectionState: 'disconnected',
          error: errorMessage(reason),
        });
      }
      return false;
    } finally {
      this.controllers.delete(controller);
    }
  }

  // The stored binding is for another loopback port. Pair with the configured port
  // before anything is dropped. If that port refuses, the stored credentials stay
  // active and the mismatch is reported, instead of an empty, unpaired app.
  private async switchLoopbackEndpoint(
    epoch: number,
    stored: ControlPlaneCredentials,
    endpoint: string,
  ): Promise<boolean> {
    const controller = this.controller();
    try {
      const paired = await this.dependencies.client.pairLoopback(
        endpoint,
        'localhost-web',
        controller.signal,
      );
      if (!this.isCurrent(epoch)) return false;
      this.resetForCredentialRecovery();
      this.credentials = paired;
      return true;
    } catch (reason) {
      if (!this.isCurrent(epoch)) return false;
      this.control.setState({
        endpointMismatch: {
          configuredEndpoint: endpoint,
          activeEndpoint: stored.baseUrl,
          error: errorMessage(reason),
        },
      });
      return true;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private resetForCredentialRecovery(): void {
    this.credentials = null;
    this.scopes.clear();
    this.capabilities.clear();
    this.activeSessionId = null;
    this.pendingTurns = null;
    this.currentAgendaScope = null;
    this.control.getState().reset();
    this.streams.getState().reset();
  }

  private async hydrate(scopes: Scope[], epoch: number): Promise<unknown[]> {
    const scopeSet = new Set(scopes);
    const tasks: Promise<void>[] = [];
    const add = <T>(load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void) => {
      const controller = this.controller();
      tasks.push(load(controller.signal).then((value) => {
        if (this.isCurrent(epoch)) apply(value);
      }).finally(() => this.controllers.delete(controller)));
    };

    if (scopeSet.has('tickets:view')) {
      add((signal) => this.dependencies.client.getOverview(signal), (value) => {
        this.activeSessionId = value.sessionId;
        this.control.setState({ overview: value });
        if (this.pendingTurns) {
          this.applyConversationSnapshot(value.sessionId, this.pendingTurns);
          this.pendingTurns = null;
        }
        this.showOutbox();
      });
      add((signal) => this.dependencies.client.getTickets(signal), (value) => this.control.getState().replaceTickets(value));
      add((signal) => this.dependencies.client.getProjects(signal), (value) => this.control.getState().replaceProjects(value));
      const range = agendaRange(this.dependencies.now?.() ?? new Date());
      const timezone = this.dependencies.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const agendaScope = createAgendaResourceScope(range.from, range.to, timezone);
      this.currentAgendaScope = agendaScope;
      tasks.push(this.ensureResource(
        agendaScope.key,
        this.control.getState().resourceState[agendaScope.key]?.state === 'ready',
      ));
      // Lead 的名字（设置 → 身份与风格）：界面上处处要用，连上就取。旧 daemon 没有这个接口，取不到时用本机记下的名字，
      // 不算连接失败。
      if (typeof this.dependencies.client.getLeadProfile === 'function') {
        tasks.push(this.ensureResource(RESOURCE_KEYS.leadProfile, false).catch(() => {}));
      }
      // 外观偏好：连上就取，界面按它画。旧 daemon 没有这个接口时用缺省值。
      if (typeof this.dependencies.client.getDesignPreferences === 'function') {
        tasks.push(this.ensureResource(RESOURCE_KEYS.designPreferences, false).catch(() => {}));
      }
    }
    if (scopeSet.has('approvals:respond')) {
      add((signal) => this.dependencies.client.getApprovals(signal), (value) => this.control.getState().replaceApprovals(value));
    }
    if (scopeSet.has('notices')) {
      add((signal) => this.dependencies.client.getNotifications(['pending', 'delivered'], signal),
        (value) => this.control.getState().replaceNotifications(value));
    }
    if (scopeSet.has('chat')) {
      add((signal) => this.dependencies.client.getConversationTurns(undefined, signal), (value) => {
        if (this.activeSessionId) this.applyConversationSnapshot(this.activeSessionId, value);
        else this.pendingTurns = value;
      });
      add((signal) => this.loadLeadActivity(signal), (value) => this.control.getState().replaceLeadActivity(value));
      add((signal) => this.loadChannelCards(signal), (value) => this.control.getState().replaceChannelCards(value));
      add((signal) => this.loadLeadQueue(signal), (value) => { if (value) this.control.getState().replaceLeadQueue(value); });
    }

    const results = await Promise.allSettled(tasks);
    if (!this.isCurrent(epoch)) return [];
    this.reconcileWorkspaceSelections();
    return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  }

  // 外部来源的会话卡（工单 11）拉不到（旧 daemon、测试替身没有这个方法、网络抖动）时当成没有，不影响会话本身。
  private async loadChannelCards(signal: AbortSignal): Promise<import('@pi-lead-child/protocol').ChannelCardDto[]> {
    const { client } = this.dependencies;
    if (typeof client.getChannelCards !== 'function') return [];
    try {
      return await client.getChannelCards(signal);
    } catch {
      return [];
    }
  }

  // 卡上的一个动作（用草稿回复、我自己回、稍后、不回、撤回自动回复；代查的改一下再发、重新查、停止代查、发到 PR 并回复）。
  // text 是「改一下再发」时用户写的文字（send_edited），别的动作不带。带上手上的版本：卡已经变了时服务端回 409，
  // 这时重取一次卡，让用户按新的样子再决定。
  async actOnChannelCard(cardId: number, action: import('@pi-lead-child/protocol').ChannelCardAction, text?: string): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.actOnChannelCard !== 'function') throw new Error('这个 daemon 不支持通道卡片');
    const held = this.control.getState().channelCards.find((card) => card.id === cardId);
    try {
      const card = await client.actOnChannelCard(cardId, action, held?.version, text);
      this.control.getState().upsertChannelCard(card);
    } catch (error) {
      void this.invalidation.refresh(RESOURCE_KEYS.channelCards).catch(() => {});
      throw error;
    }
  }

  // Lead 忙时排着的外部消息（工单 10）。旧 daemon、测试替身没有这个方法、网络抖动时是 null：状态栏不显示，不影响会话本身。
  private async loadLeadQueue(signal: AbortSignal): Promise<import('@pi-lead-child/protocol').LeadQueue | null> {
    const { client } = this.dependencies;
    if (typeof client.getLeadQueue !== 'function') return null;
    try {
      return await client.getLeadQueue(signal);
    } catch {
      return null;
    }
  }

  // 排队面板上的「排到下一个」「移出队列」（操作层的 lead_queue）。回答是操作以后的排队，直接替换；失败时重取一次再抛出。
  async leadQueueAction(action: import('@pi-lead-child/protocol').LeadQueueAction, key: string): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.leadQueueAction !== 'function') throw new Error('这个 daemon 不支持排队');
    try {
      this.control.getState().replaceLeadQueue(await client.leadQueueAction(action, key));
    } catch (error) {
      void this.invalidation.refresh(RESOURCE_KEYS.leadQueue).catch(() => {});
      throw error;
    }
  }

  // 输入框上状态栏里，你排着的追问的「Steer」和「×」（主题 11.13，操作层的 follow_up）。
  // 结果经会话的推送回来（这一轮的 placement 变成 steered 或 cancelled），这里不改本地状态；失败时抛出，状态栏写「没有做成」。
  async followUpAction(action: import('@pi-lead-child/protocol').FollowUpAction, turnId: string): Promise<void> {
    const { client } = this.dependencies;
    if (typeof client.followUpAction !== 'function') throw new Error('这个 daemon 不支持 Steer 和取消');
    await client.followUpAction(action, turnId);
  }

  // Lead 动态拉不到（旧 daemon、测试替身没有这个方法、网络抖动）时当成没有，不影响会话本身。
  // 当成没有的快照 watermark 是 0：手上的卡（lastSeq 都大于 0）不因为它被清掉。
  private async loadLeadActivity(signal: AbortSignal): Promise<LeadActivityView> {
    const { client } = this.dependencies;
    const empty: LeadActivityView = { cards: [], interrupts: [], watermark: 0 };
    try {
      if (typeof client.getLeadActivityView === 'function') return await client.getLeadActivityView(signal);
      if (typeof client.getLeadActivity === 'function') {
        return { ...empty, cards: (await client.getLeadActivity(signal)).map(leadActivityCardFromItem) };
      }
      return empty;
    } catch {
      return empty;
    }
  }

  // After hello.v2 the gateway replays every event after the client's cursor, up
  // to hello.latestSeq. A fresh binding replays the whole history, and a browser
  // can run the 0 ms invalidation timer between two replayed frames, so each
  // replayed burst refetched the snapshots again. Replayed events only collect
  // their keys. One refetch runs at hello.latestSeq, or after the stream goes
  // quiet, because the binding may not see the event at hello.latestSeq.
  private invalidateForEvent(seq: number, keys: string[]): void {
    if (seq > this.replayThroughSeq) {
      this.flushReplayInvalidations();
      this.invalidation.invalidate(keys);
      return;
    }
    for (const key of keys) this.replayInvalidations.add(key);
    if (seq === this.replayThroughSeq) {
      this.flushReplayInvalidations();
      return;
    }
    this.cancelReplaySettle();
    this.replaySettleHandle = this.dependencies.scheduler.schedule(() => {
      this.replaySettleHandle = null;
      this.flushReplayInvalidations();
    }, REPLAY_SETTLE_MS);
  }

  private flushReplayInvalidations(): void {
    this.cancelReplaySettle();
    if (this.replayInvalidations.size === 0) return;
    const keys = [...this.replayInvalidations];
    this.replayInvalidations.clear();
    this.invalidation.invalidate(keys);
  }

  private cancelReplaySettle(): void {
    if (this.replaySettleHandle === null) return;
    this.dependencies.scheduler.cancel(this.replaySettleHandle);
    this.replaySettleHandle = null;
  }

  // 会话快照（GET /v1/conversation/turns）和流式文字对齐（2026-10-15 预览发现）：还在流的一轮，快照里已经有
  // 落库的文字，流式缓冲里也有同一段。以快照为准，只把快照之后才到的那一段留在流式缓冲里；否则同一段字显示两遍。
  // 对不上（快照更长，或者内容不同）时只用快照。
  private applyConversationSnapshot(sessionId: string, turns: ConversationTurn[], scope?: { ticketId?: number }): void {
    const before = this.control.getState();
    const carried = new Map<string, string>();
    for (const turn of turns) {
      if (turn.state !== 'streaming' && turn.state !== 'queued') continue;
      const messageId = before.assistantMessageIdByTurnId[turn.id];
      if (!messageId) continue;
      const part = before.messagePartsById[`${messageId}:text`];
      const shown = `${part?.kind === 'text' ? part.text : ''}${this.streamCoordinator.drainText(messageId)}`;
      if (shown.length > turn.assistantText.length && shown.startsWith(turn.assistantText)) {
        carried.set(turn.id, shown.slice(turn.assistantText.length));
      }
    }
    this.control.getState().replaceConversation(sessionId, turns, scope);
    const after = this.control.getState();
    for (const [turnId, text] of carried) {
      const messageId = after.assistantMessageIdByTurnId[turnId];
      if (messageId) this.streamCoordinator.appendTextDelta(messageId, text);
    }
  }

  private applyStreamMutation(mutation: StreamMutation): void {
    if (mutation.type === 'tool.set-progress') {
      this.streams.getState().setToolProgress({
        partId: mutation.partId,
        state: mutation.state,
        updatedAt: this.dependencies.scheduler.now(),
      });
      return;
    }
    if (mutation.type === 'tool.drain-progress') {
      this.streams.getState().drainToolProgress(mutation.partId);
      return;
    }
    if (!mutation.turnId) return;
    const messageId = this.control.getState().assistantMessageIdByTurnId[mutation.turnId];
    if (!messageId) return;
    if (mutation.type === 'message.append-delta') {
      this.streamCoordinator.appendTextDelta(messageId, mutation.delta);
    } else {
      this.streamCoordinator.drainText(messageId);
    }
  }

  private createStreamCoordinator(): StreamCoordinator {
    return createStreamCoordinator(this.streams, this.dependencies.scheduler);
  }

  private createInvalidationCoordinator(): InvalidationCoordinator {
    return createInvalidationCoordinator({
      scheduler: this.dependencies.scheduler,
      refresh: (key, generation, signal) => this.refreshResource(key, generation, signal),
      onStale: (key, generation) => {
        const resourceKey = key as ResourceKey;
        const resourceState = this.control.getState().resourceState;
        this.control.setState({
          resourceState: {
            ...resourceState,
            [resourceKey]: {
              state: 'stale',
              generation,
              observerCount: resourceState[resourceKey]?.observerCount ?? 0,
              lastSuccessAt: resourceState[resourceKey]?.lastSuccessAt ?? null,
              error: null,
            },
          },
        });
      },
      isObserved: (key) => !isLazyResource(key) ||
        (this.control.getState().resourceState[key as ResourceKey]?.observerCount ?? 0) > 0,
    });
  }

  private async refreshResource(key: string, generation: number, signal: AbortSignal): Promise<void> {
    const resourceKey = key as ResourceKey;
    const epoch = this.lifecycle;
    const canCommit = () => this.isCurrent(epoch) && this.invalidation.generation(key) === generation;
    if (canCommit()) this.setResourceState(resourceKey, { state: 'loading', error: null });
    try {
      if (key === 'tickets') {
        const value = await this.dependencies.client.getTickets(signal);
        if (!canCommit()) return;
        this.control.getState().replaceTickets(value);
      } else if (key === 'projects') {
        const value = await this.dependencies.client.getProjects(signal);
        if (!canCommit()) return;
        this.control.getState().replaceProjects(value);
      }
      else if (key.startsWith('agenda:')) {
        const agendaScope = this.currentAgendaScope;
        if (!agendaScope || agendaScope.key !== resourceKey) return;
        const value = await this.dependencies.client.getAgenda(
          agendaScope.from,
          agendaScope.to,
          agendaScope.timezone,
          signal,
        );
        if (!canCommit() || this.currentAgendaScope?.key !== resourceKey) return;
        this.control.getState().replaceAgenda(value);
      }
      else if (key === 'overview') {
        const value = await this.dependencies.client.getOverview(signal);
        if (!canCommit()) return;
        this.activeSessionId = value.sessionId;
        this.control.setState({ overview: value });
      } else if (key === 'approvals') {
        const value = await this.dependencies.client.getApprovals(signal);
        if (!canCommit()) return;
        this.control.getState().replaceApprovals(value);
      } else if (key === RESOURCE_KEYS.notifications) {
        const value = await this.dependencies.client.getNotifications(['pending', 'delivered'], signal);
        if (!canCommit()) return;
        this.control.getState().replaceNotifications(value);
      } else if (key === RESOURCE_KEYS.inbox) {
        const value = await this.dependencies.client.getInbox(signal);
        if (!canCommit()) return;
        this.control.getState().replaceInbox(value);
      } else if (key === RESOURCE_KEYS.timeline) {
        const range = timelineRange(this.dependencies.now?.() ?? new Date());
        const timezone = this.dependencies.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const value = await this.dependencies.client.getTimeline(range.from, range.to, timezone, signal);
        if (!canCommit()) return;
        this.control.getState().replaceTimeline(value);
      } else if (key === RESOURCE_KEYS.projectsOverview) {
        const value = await this.dependencies.client.getProjectsOverview(signal);
        if (!canCommit()) return;
        this.control.getState().replaceProjectOverviews(value);
      } else if (key === RESOURCE_KEYS.connections) {
        const value = await this.connectionClient('listConnections')(signal);
        if (!canCommit()) return;
        this.control.setState({ connections: value });
      } else if (key === RESOURCE_KEYS.memory) {
        const value = await this.memoryClient('getMemory')(signal);
        if (!canCommit()) return;
        this.control.setState({ memory: value });
      } else if (key === RESOURCE_KEYS.memoryHindsight) {
        const value = await this.memoryClient('getMemoryHindsight')(signal);
        if (!canCommit()) return;
        this.control.setState({ memoryHindsight: value });
      } else if (key === RESOURCE_KEYS.memoryPreferences) {
        const value = await this.memoryClient('getMemoryPreferences')(signal);
        if (!canCommit()) return;
        this.control.setState({ memoryPreferences: value });
      } else if (key === RESOURCE_KEYS.decisionModel) {
        const value = await this.memoryClient('getDecisionModel')(signal);
        if (!canCommit()) return;
        this.control.setState({ decisionModel: value });
      } else if (key === RESOURCE_KEYS.modelSettings) {
        const value = await this.memoryClient('getModelSettings')(signal);
        if (!canCommit()) return;
        this.control.setState({ modelSettings: value });
      } else if (key === RESOURCE_KEYS.setup) {
        const value = await this.memoryClient('getSetup')(signal);
        if (!canCommit()) return;
        this.control.setState({ setup: value });
      } else if (key === RESOURCE_KEYS.widgets) {
        const value = await this.memoryClient('getWidgets')(signal);
        if (!canCommit()) return;
        this.control.setState({ widgets: value });
      } else if (key === RESOURCE_KEYS.runtimeSettings) {
        const value = await this.memoryClient('getRuntimeSettings')(signal);
        if (!canCommit()) return;
        this.control.setState({ runtimeSettings: value });
      } else if (key === RESOURCE_KEYS.leadProfile) {
        const value = await this.memoryClient('getLeadProfile')(signal);
        if (!canCommit()) return;
        rememberLeadName(value.name);
        this.control.setState({ leadProfile: value });
      } else if (key === RESOURCE_KEYS.leadAvatar) {
        const value = await this.memoryClient('getLeadAvatar')(signal);
        if (!canCommit()) return;
        this.applyLeadAvatar(value);
      } else if (key === RESOURCE_KEYS.designPreferences) {
        const value = await this.memoryClient('getDesignPreferences')(signal);
        if (!canCommit()) return;
        this.control.setState({ designPreferences: value });
      } else if (key === RESOURCE_KEYS.channelSettings) {
        const value = await this.channelSettingsClient('getChannelSettings')(signal);
        if (!canCommit()) return;
        this.control.setState({ channelSettings: value });
      } else if (key === RESOURCE_KEYS.channelCards) {
        const value = await this.loadChannelCards(signal);
        if (!canCommit()) return;
        this.control.getState().replaceChannelCards(value);
      } else if (key === RESOURCE_KEYS.leadQueue) {
        const value = await this.loadLeadQueue(signal);
        if (!canCommit() || !value) return;
        this.control.getState().replaceLeadQueue(value);
      }
	      else if (key === 'conversation:current') {
	        const [turns, activity] = await Promise.all([
	          this.dependencies.client.getConversationTurns(undefined, signal),
	          this.loadLeadActivity(signal),
	        ]);
	        if (!canCommit()) return;
	        if (this.activeSessionId) this.applyConversationSnapshot(this.activeSessionId, turns);
	        this.control.getState().replaceLeadActivity(activity);
	      } else if (key.startsWith('conversation:ticket:')) {
	        const ticketId = Number(key.slice('conversation:ticket:'.length));
	        const turns = await this.dependencies.client.getConversationTurns(ticketId, signal);
	        if (!canCommit()) return;
	        if (this.activeSessionId) this.applyConversationSnapshot(this.activeSessionId, turns, { ticketId });
	      } else if (key === RESOURCE_KEYS.workItems) {
        const version = this.kernelResourceVersion('workItems');
        if (version === null) return;
        const value = await this.dependencies.client.getKernelWorkItems([], signal, version);
        if (!canCommit()) return;
        this.control.getState().replaceWorkItems(value.items);
      } else if (key.startsWith('workbench:')) {
        const ticketId = Number(key.slice('workbench:'.length));
        const version = this.kernelResourceVersion('ticketWorkbench');
        if (version === null) return;
        const value = await this.dependencies.client.getKernelTicketWorkbench(ticketId, signal, version);
        if (!canCommit()) return;
        this.control.getState().replaceTicketWorkbench(value);
      } else if (key.startsWith('ticket:')) {
        const ticketId = Number(key.slice('ticket:'.length));
        const value = await this.dependencies.client.getTicket(ticketId, signal);
        if (!canCommit()) return;
        this.control.getState().replaceTicketDetail(value);
      } else if (key.startsWith('checkpoints:')) {
        await this.refreshCheckpointResource(Number(key.slice('checkpoints:'.length)), signal, canCommit);
        if (!canCommit()) return;
      } else if (key.startsWith('artifacts:')) {
        const ticketId = Number(key.slice('artifacts:'.length));
        const value = await this.dependencies.client.getKernelArtifacts(ticketId, signal);
        if (!canCommit()) return;
        this.control.getState().replaceArtifacts(ticketId, value.items);
      } else if (key.startsWith('delivery:')) {
        const ticketId = Number(key.slice('delivery:'.length));
        if (!this.dependencies.client.getTicketDelivery) return;
        const value = await this.dependencies.client.getTicketDelivery(ticketId, { signal });
        if (!canCommit()) return;
        this.control.getState().replaceDelivery(ticketId, value);
      } else if (key.startsWith('actions:')) {
        const ticketId = Number(key.slice('actions:'.length));
        if (!this.dependencies.client.listTicketActions) return;
        const value = await this.dependencies.client.listTicketActions(ticketId, { signal });
        if (!canCommit()) return;
        this.control.getState().replaceTicketActions(ticketId, value);
      } else if (key.startsWith('acceptance-criteria:')) {
        const ticketId = Number(key.slice('acceptance-criteria:'.length));
        if (!this.dependencies.client.getTicketAcceptanceCriteria) return;
        const value = await this.dependencies.client.getTicketAcceptanceCriteria(ticketId, { signal });
        if (!canCommit()) return;
        this.control.getState().replaceAcceptanceCriteria(ticketId, value);
      } else if (key.startsWith('plan:')) {
        const ticketId = Number(key.slice('plan:'.length));
        if (!this.dependencies.client.getTicketExecutionPlan) return;
        const value = await this.dependencies.client.getTicketExecutionPlan(ticketId, { signal });
        if (!canCommit()) return;
        this.control.getState().replaceExecutionPlan(ticketId, value);
      } else if (key.startsWith('interventions:')) {
        const ticketId = Number(key.slice('interventions:'.length));
        const value = await this.dependencies.client.getKernelInterventions({ ticketId }, signal);
        if (!canCommit()) return;
        this.control.getState().replaceInterventions(value.items, ticketId);
      } else if (key === RESOURCE_KEYS.conversationCards || key.startsWith('conversation-cards:ticket:')) {
        await this.refreshConversationCardResource(resourceKey, signal, canCommit);
        if (!canCommit()) return;
      } else if (key.startsWith('execution:')) {
        await this.ensureTicketExecution(Number(key.slice('execution:'.length)));
        if (!canCommit()) return;
      } else if (key.startsWith('attempt-events:')) {
        await this.ensureAttemptEvents(Number(key.slice('attempt-events:'.length)));
        if (!canCommit()) return;
      }
      if (!canCommit()) return;
      this.setResourceState(resourceKey, {
        state: 'ready',
        error: null,
        lastSuccessAt: this.dependencies.scheduler.now(),
      });
      this.reconcileWorkspaceSelections();
    } catch (reason) {
      if (canCommit()) {
        if (isAbortError(reason)) {
          this.setResourceState(resourceKey, { state: 'idle', error: null });
        } else if (routeMissing(resourceKey, reason)) {
          // daemon 比网页旧，还没有这条路由：记成不支持。daemon 重启、页面重新连上以后（hello.v2）自动再取。
          this.setResourceState(resourceKey, { state: 'unsupported', error: DAEMON_OLDER_THAN_WEB });
          return;
        } else {
          this.setResourceState(resourceKey, { state: 'error', error: errorMessage(reason) });
        }
      }
      throw reason;
    }
  }

  private setResourceState(
    key: ResourceKey,
    patch: Partial<ResourceLoadState>,
  ): void {
    const resourceState = this.control.getState().resourceState;
    const current = resourceState[key] ?? {
      state: 'idle',
      generation: 0,
      observerCount: 0,
      lastSuccessAt: null,
      error: null,
    };
    this.control.setState({ resourceState: { ...resourceState, [key]: { ...current, ...patch } } });
  }

  private reconcileWorkspaceSelections(): void {
    const state = this.control.getState();
    this.workspace.getState().reconcileSelections({
      ticketIds: state.ticketIds,
      sessionIds: state.sessionIds,
      attemptIds: Object.keys(state.attemptsById).map(Number),
    });
  }

  private beginLifecycle(): number {
    this.lifecycle += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.cancelReplaySettle();
    this.replayInvalidations.clear();
    this.replayThroughSeq = 0;
    return this.lifecycle;
  }

  private controller(): AbortController {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }

  private isCurrent(epoch: number): boolean {
    return !this.stopped && epoch === this.lifecycle;
  }

  private isResourceSupported(key: ResourceKey): boolean {
    if (key === RESOURCE_KEYS.workItems) {
      return this.scopes.has('tickets:view') && supportsKernelCapability([...this.capabilities], 'workItems');
    }
	    if (key.startsWith('conversation:ticket:')) {
	      return this.scopes.has('chat');
	    }
	    if (key.startsWith('workbench:')) {
      return this.scopes.has('tickets:view') && supportsKernelCapability([...this.capabilities], 'ticketWorkbench');
    }
    if (key.startsWith('checkpoints:')) {
      return this.scopes.has('tickets:view') && supportsKernelCapability([...this.capabilities], 'checkpoints');
    }
    if (key.startsWith('artifacts:')) {
      return this.scopes.has('tickets:view') && supportsKernelCapability([...this.capabilities], 'artifacts');
    }
    if (key.startsWith('delivery:') || key.startsWith('actions:') || key.startsWith('acceptance-criteria:') || key.startsWith('plan:')) {
      return this.scopes.has('tickets:view');
    }
    if (key.startsWith('interventions:')) {
      return this.scopes.has('approvals:respond') && supportsKernelCapability([...this.capabilities], 'interventions');
    }
    if (key === RESOURCE_KEYS.notifications) {
      return this.scopes.has('notices');
    }
    if (key === RESOURCE_KEYS.inbox || key === RESOURCE_KEYS.projectsOverview || key === RESOURCE_KEYS.timeline) {
      return this.scopes.has('tickets:view');
    }
    if (key === RESOURCE_KEYS.connections) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.listConnections === 'function';
    }
    if (key === RESOURCE_KEYS.memory) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getMemory === 'function';
    }
    if (key === RESOURCE_KEYS.memoryHindsight) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getMemoryHindsight === 'function';
    }
    if (key === RESOURCE_KEYS.memoryPreferences) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getMemoryPreferences === 'function';
    }
    if (key === RESOURCE_KEYS.decisionModel) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getDecisionModel === 'function';
    }
    if (key === RESOURCE_KEYS.modelSettings) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getModelSettings === 'function';
    }
    if (key === RESOURCE_KEYS.setup) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getSetup === 'function';
    }
    if (key === RESOURCE_KEYS.widgets) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getWidgets === 'function';
    }
    if (key === RESOURCE_KEYS.runtimeSettings) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getRuntimeSettings === 'function';
    }
    if (key === RESOURCE_KEYS.leadProfile) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getLeadProfile === 'function';
    }
    if (key === RESOURCE_KEYS.leadAvatar) {
      return this.scopes.has('tickets:view') && this.capabilities.has(LEAD_AVATAR_CAPABILITY)
        && typeof this.dependencies.client.getLeadAvatar === 'function';
    }
    if (key === RESOURCE_KEYS.designPreferences) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getDesignPreferences === 'function';
    }
    if (key === RESOURCE_KEYS.channelSettings) {
      return this.scopes.has('tickets:view') && typeof this.dependencies.client.getChannelSettings === 'function';
    }
    if (key === RESOURCE_KEYS.conversationCards || key.startsWith('conversation-cards:ticket:')) {
      return this.scopes.has('tickets:view') && supportsKernelCapability([...this.capabilities], 'conversationCards');
    }
    return true;
  }

  private markUnsupported(key: ResourceKey): Promise<void> {
    this.setResourceState(key, { state: 'unsupported', error: null });
    return Promise.resolve();
  }

  private async refreshCheckpointResource(
    ticketId: number,
    signal: AbortSignal,
    canCommit: () => boolean,
  ): Promise<void> {
    const ids = this.control.getState().checkpointIdsByTicket[ticketId] ?? [];
    const afterId = ids.at(-1);
    const page = await this.dependencies.client.getKernelCheckpoints(
      ticketId,
      afterId === undefined ? {} : { afterId },
      signal,
      this.kernelResourceVersion('checkpoints') ?? 1,
    );
    if (!canCommit()) return;
    this.control.getState().mergeCheckpointPage(ticketId, page, afterId === undefined ? 'replace' : 'append');
  }

  private async refreshConversationCardResource(
    key: ResourceKey,
    signal: AbortSignal,
    canCommit: () => boolean,
  ): Promise<void> {
    const ticketId = key.startsWith('conversation-cards:ticket:')
      ? Number(key.slice('conversation-cards:ticket:'.length))
      : undefined;
    const state = this.control.getState();
    const keys = state.conversationCardIds.filter((cardKey) =>
      ticketId === undefined || state.conversationCardsById[cardKey]?.ticketId === ticketId);
    const durableIds = keys.flatMap((cardKey) => {
      const durableId = state.conversationCardsById[cardKey]?.durableId;
      return durableId === null || durableId === undefined ? [] : [durableId];
    });
    const baseQuery: KernelConversationCardQuery = ticketId === undefined ? {} : { ticketIds: [ticketId] };
    if (keys.length === 0) {
      const page = await this.dependencies.client.getKernelConversationCards(baseQuery, signal);
      if (!canCommit()) return;
      this.control.getState().mergeConversationCardPage(page, 'replace', key);
      return;
    }
    const pages = await Promise.all([
      this.dependencies.client.getKernelConversationCards({ ...baseQuery, keys }, signal),
      this.dependencies.client.getKernelConversationCards({
        ...baseQuery,
        afterId: durableIds.length === 0 ? 0 : Math.max(...durableIds),
      }, signal),
    ]);
    if (!canCommit()) return;
    this.control.getState().mergeConversationCardPage(pages[0], 'append', key);
    this.control.getState().mergeConversationCardPage(pages[1], 'append', key);
  }

  private expandInvalidations(keys: string[]): string[] {
    const expanded = new Set(keys.filter((key) => key !== 'core' && key !== 'agenda:current'));
    // 收件箱的事实（为什么在等你、Lead 已处理）跟着工单和通知变。
    if (keys.some((key) => key === 'tickets' || key === 'notifications' || key.startsWith('ticket:'))) {
      expanded.add(RESOURCE_KEYS.inbox);
    }
    // 项目卡片跟着工单和项目变。
    if (keys.some((key) => key === 'tickets' || key === 'projects' || key.startsWith('ticket:'))) {
      expanded.add(RESOURCE_KEYS.projectsOverview);
    }
    // 日程的节点、风险和出处跟着工单变；Lead 改了节点或一句话时，事件说 agenda:current。
    if (keys.some((key) => key === 'agenda:current' || key === 'tickets' || key.startsWith('ticket:'))) {
      expanded.add(RESOURCE_KEYS.timeline);
    }
    if (keys.includes('agenda:current') && this.currentAgendaScope) {
      expanded.add(this.currentAgendaScope.key);
    }
    // 会话里的提醒卡读提醒自己的 TicketDetail（ticket:<id>）。Lead 改日程的工具（建、改期、取消、确认提醒）之后，
    // daemon 推的 ticket.updated 不带编号；带编号的工单事件说的是那一张工单，不碰提醒（发布评审 3688968）。
    // 这时没结束的提醒（scheduled、fired）都放进失效列表：有人在看的重取，没人看的只标成 stale，下次挂上时重取。
    // 已确认、已取消的提醒不会再变（恢复是用户的动作，事件带编号）。提醒到点时 daemon 推一条带编号的 ticket.updated
    // （工单 07）；更早的 daemon 不推，卡片自己按时间重取一次（useConversationItemDetail）。
    const untargetedTicketUpdate = keys.includes('tickets')
      && !keys.some((key) => /^(?:ticket|workbench|execution):\d+$/.test(key));
    if (untargetedTicketUpdate) {
      for (const detail of Object.values(this.control.getState().ticketDetailsById)) {
        if (detail.ticket.kind !== 'reminder' || detail.ticket.stage === 'acked' || detail.ticket.stage === 'cancelled') continue;
        expanded.add(RESOURCE_KEYS.ticket(detail.ticket.id));
      }
    }
    // 设置 → 记忆的 Hindsight 部分和常驻偏好是单独的两份（/v1/memory 的 DTO 是严格的契约），daemon 只推 resource 是 memory 的快照。
    if (keys.includes(RESOURCE_KEYS.memory)) {
      expanded.add(RESOURCE_KEYS.memoryHindsight);
      expanded.add(RESOURCE_KEYS.memoryPreferences);
    }
    if (keys.includes('core')) {
      // lead-profile：界面上处处要用 Lead 的名字，连上就取（不是懒加载的资源）。
      for (const key of ['overview', 'tickets', 'projects', 'approvals', 'notifications', 'conversation:current', 'lead-profile', 'lead-avatar', 'design-preferences'] as ResourceKey[]) {
        expanded.add(key);
      }
      if (this.currentAgendaScope) expanded.add(this.currentAgendaScope.key);
      for (const [key, resource] of Object.entries(this.control.getState().resourceState)) {
        if (!resource) continue;
        if (resource.observerCount > 0) expanded.add(key);
      }
    }
    return [...expanded];
  }

  private kernelResourceVersion(resource: Parameters<typeof selectKernelResourceVersion>[1]) {
    return selectKernelResourceVersion([...this.capabilities], resource);
  }
}

export function createCompanionStateRuntime(dependencies: CompanionRuntimeDependencies) {
  return new CompanionStateRuntime(dependencies);
}

// 应用在不在前台（web：标签页可见）。daemon 只把有人在看的连接算作"有人在听"。
export interface PresenceSource {
  current(): boolean;
  subscribe(listener: (foreground: boolean) => void): () => void;
}

// 可能让连接失效或恢复的时刻：应用回到前台（web：标签页可见）、设备上线、设备离线。
export interface ConnectivitySource {
  subscribe(listener: (event: 'foreground' | 'online' | 'offline') => void): () => void;
}

export function mountCompanionRuntime(
  runtime: CompanionStateRuntime,
  options: { loopbackEndpoint?: string | null; presence?: PresenceSource; connectivity?: ConnectivitySource } = {},
): () => void {
  let active = true;
  runtime.workspace.setState({ hydrated: true });
  const presence = options.presence;
  let unsubscribePresence: (() => void) | null = null;
  if (presence) {
    runtime.setPresence(presence.current());
    unsubscribePresence = presence.subscribe((foreground) => runtime.setPresence(foreground));
  }
  // 睡眠以后，半开的 WebSocket 看起来还连着（2026-10-16）。回来、上线时马上探一次；离线时马上当它断了。
  // 回到前台时也读一次网页版本：只跑 build:web 时 daemon 不重启，没有 hello.v2。
  const unsubscribeConnectivity = options.connectivity?.subscribe((event) => {
    if (event === 'offline') runtime.connectionLost();
    else void runtime.checkConnection();
    if (event === 'foreground') void runtime.checkWebBuild();
  }) ?? null;
  void runtime.start(options).catch((reason: unknown) => {
    if (!active) return;
    const phase = runtime.control.getState().phase;
    if (phase !== 'loading' && phase !== 'connecting') return;
    runtime.control.setState({
      phase: 'error',
      connectionState: 'disconnected',
      error: errorMessage(reason),
    });
  });
  return () => {
    if (!active) return;
    active = false;
    unsubscribePresence?.();
    unsubscribeConnectivity?.();
    runtime.stop();
  };
}

// 日程取今天前后 30 天，过期的条目由服务端另外带上（include=overdue）。以前只取本周：
// 上周以前过了截止、7 月就触发了还没确认的提醒，在日程里根本看不到。
const AGENDA_DAYS_AROUND_TODAY = 30;

function agendaRange(now: Date) {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - AGENDA_DAYS_AROUND_TODAY);
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  to.setDate(to.getDate() + AGENDA_DAYS_AROUND_TODAY + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

// 日程 tab 的范围：本周一 0 点到三周后。过期区不受这个范围限制（服务端不设下限）。
function timelineRange(now: Date) {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  const to = new Date(from);
  to.setDate(to.getDate() + 21);
  return { from: from.toISOString(), to: to.toISOString() };
}

function createAgendaResourceScope(
  from: string,
  to: string,
  timezone: string,
): AgendaResourceScope {
  const scope = encodeURIComponent(JSON.stringify([from, to, timezone]));
  return { key: RESOURCE_KEYS.agenda(scope), from, to, timezone };
}

// 网页比 daemon 新的资源：旧 daemon 没有这条路由，回 404。网关先换网页、后重启 daemon（部署时网页从磁盘直接生效），
// 中间这一段页面要说清楚是 daemon 还没更新，不写「not found」（2026-10-29 部署设置 → 模型时）。
const ROUTES_NEWER_THAN_DAEMON: ReadonlySet<string> = new Set([RESOURCE_KEYS.modelSettings, RESOURCE_KEYS.memoryHindsight, RESOURCE_KEYS.memoryPreferences, RESOURCE_KEYS.setup, RESOURCE_KEYS.widgets]);

function routeMissing(key: ResourceKey, reason: unknown): boolean {
  return ROUTES_NEWER_THAN_DAEMON.has(key) && reason instanceof ControlPlaneClientError && reason.status === 404;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isRetryableCommandError(reason: unknown): boolean {
  const code = reason && typeof reason === 'object' && 'code' in reason
    ? String(reason.code)
    : '';
  return !['invalid_request', 'forbidden', 'not_paired'].includes(code);
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError';
}

type MemoryClientMethod =
  | 'memorySwitch' | 'confirmMemorySwitch' | 'getMemory' | 'updateMemorySettings' | 'testMemoryEmbedding' | 'getMemoryHindsight' | 'getMemoryPreferences'
  | 'getDecisionModel' | 'updateDecisionModel' | 'testDecisionModel' | 'getModelSettings' | 'getSetup' | 'getWidgets'
  | 'getRuntimeSettings' | 'updateRuntimeSettings'
  | 'getLeadProfile' | 'updateLeadProfile'
  | 'getLeadAvatar' | 'getLeadAvatarImage' | 'uploadLeadAvatarSlot' | 'clearLeadAvatarSlot' | 'setLeadAvatarSlackEmoji' | 'previewSlackEmoji'
  | 'getDesignPreferences' | 'updateDesignPreferences';

type ChannelSettingsClientMethod =
  | 'getChannelSettings' | 'testChannelSecrets' | 'saveChannelSecrets' | 'clearChannelSecrets'
  | 'getChannelPolicy' | 'updateChannelPolicy' | 'testChannelPolicy' | 'replayChannelPolicy'
  | 'getChannelHandbook' | 'updateChannelHandbook' | 'rehearseChannelHandbook' | 'proposeChannelHandbookSituation'
  | 'getChannelHandbookSuggestions' | 'acceptChannelHandbookSuggestion' | 'dismissChannelHandbookSuggestion'
  | 'getReplyStyle' | 'updateReplyStyle' | 'extractReplyStyle';

type StandingOrderClientMethod =
  | 'getStandingOrders' | 'getStandingOrder' | 'rollbackStandingOrder' | 'standingOrderProposal' | 'decideStandingOrderProposal';

type ConnectionClientMethod =
  | 'listConnections' | 'startConnection' | 'addCustomConnection' | 'connectionFlow' | 'updateConnectionSettings'
  | 'testConnection' | 'disconnectConnection' | 'connectionTools' | 'connectionConfirmation' | 'resolveConnectionConfirmation';

// 要你处理的连接数，和 daemon 的 attention 同一条规则：要重新授权，或者授权快到期。
export function connectionAttention(items: readonly ConnectionDto[]): number {
  return items.filter((item) => item.state === 'needs_reauth' || item.problem?.kind === 'expiring').length;
}

function isLazyResource(key: string): boolean {
	  return key === 'work-items' || key === 'conversation-cards' || key === 'connections' ||
	    key === 'memory' || key === 'memory-hindsight' || key === 'memory-preferences' || key === 'widgets' || key === 'decision-model' || key === 'model-settings' || key === 'runtime-settings' || key === 'channel-settings' ||
	    key.startsWith('conversation:ticket:') ||
	    key.startsWith('execution:') || key.startsWith('workbench:') || key.startsWith('ticket:') ||
    key.startsWith('checkpoints:') || key.startsWith('artifacts:') || key.startsWith('delivery:') || key.startsWith('interventions:') ||
    key.startsWith('actions:') || key.startsWith('acceptance-criteria:') || key.startsWith('plan:') ||
    key.startsWith('conversation-cards:ticket:') || key.startsWith('attempt-events:');
}

function runtimeEventLogEntry(event: KernelRuntimeEvent) {
  return {
    attemptId: event.attemptId,
    seq: event.seq,
    occurredAt: event.occurredAt,
    kind: event.type,
    text: runtimeEventText(event),
    ...runtimeToolLogData(event),
  };
}

function runtimeToolLogData(event: KernelRuntimeEvent) {
  if (!event.type.startsWith('tool.')) return {};
  switch (event.type) {
    case 'tool.started': {
      const args = recordValue(event.args);
      return { tool: {
        callId: event.callId,
        name: event.name,
        phase: 'started' as const,
        args: projectToolDisplay(event.args),
        result: null,
        error: null,
        command: redactNullable(stringValue(args, 'command')),
        cwd: stringValue(args, 'cwd'),
        exitCode: null,
        output: null,
      } };
    }
    case 'tool.updated':
      return { tool: {
        callId: event.callId,
        name: event.name,
        phase: 'updated' as const,
        args: null,
        result: projectToolDisplay(event.update),
        error: null,
        command: null,
        cwd: null,
        exitCode: null,
        output: null,
      } };
    case 'tool.completed': {
      const result = recordValue(event.result);
      return { tool: {
        callId: event.callId,
        name: event.name,
        phase: 'completed' as const,
        args: null,
        result: projectToolDisplay(event.result),
        error: null,
        command: null,
        cwd: null,
        exitCode: numberValue(result, 'exitCode'),
        output: projectToolDisplay(result?.output),
      } };
    }
    case 'tool.failed':
      return { tool: {
        callId: event.callId,
        name: event.name,
        phase: 'failed' as const,
        args: null,
        result: null,
        error: redactSecretText(event.error),
        command: null,
        cwd: null,
        exitCode: null,
        output: null,
      } };
  }
  return {};
}

// 日志里的命令、失败原因和 stderr 是工具的原文：密钥用 protocol 的同一套规则去掉（参数和结果走 projectToolDisplay）。
function redactNullable(value: string | null): string | null {
  return value === null ? null : redactSecretText(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: Record<string, unknown> | null, key: string): string | null {
  return typeof value?.[key] === 'string' ? value[key] : null;
}

function numberValue(value: Record<string, unknown> | null, key: string): number | null {
  return typeof value?.[key] === 'number' ? value[key] : null;
}

function runtimeEventText(event: KernelRuntimeEvent): string {
  switch (event.type) {
    case 'message.delta': return event.delta;
    case 'message.completed': return event.text;
    case 'tool.started': return `${event.name} ${projectToolDisplay(event.args)?.preview ?? ''}`.trim();
    case 'tool.updated': return `${event.name} ${projectToolDisplay(event.update)?.preview ?? ''}`.trim();
    case 'tool.completed': return `${event.name} ${projectToolDisplay(event.result)?.preview ?? ''}`.trim();
    case 'tool.failed': return `${event.name}: ${redactSecretText(event.error)}`;
    case 'runtime.stderr': return redactSecretText(event.text);
    case 'run.failed': return `${event.errorCode}: ${redactSecretText(event.error)}`;
    case 'run.completed': return event.reason ?? `exit ${event.exitCode}`;
    case 'usage.updated': return `${event.totalTokens} tokens`;
    case 'session.updated': return event.externalSessionId;
    case 'run.started': return `${event.runtime}${event.model ? ` · ${event.model}` : ''}`;
  }
  return assertNever(event);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime event: ${JSON.stringify(value)}`);
}

// 服务端说交付在用户看过以后变了（delivery-routes.ts 的 stale）。
function deliveryChangedSinceSeen(error: unknown): boolean {
  if (!(error instanceof ControlPlaneClientError) || error.status !== 409) return false;
  const body = error.body as { error?: { details?: { reason?: unknown } } } | undefined;
  return body?.error?.details?.reason === 'stale';
}
