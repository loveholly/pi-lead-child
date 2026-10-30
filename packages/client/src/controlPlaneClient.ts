import {
  OwnerActionResponseSchema,
  type OwnerActionDto,
  type OwnerActionResponse,
} from '@pi-lead-child/protocol';
import {
  RuleChangeConfirmationResponseSchema,
  type RuleChangeConfirmationDto,
  type RuleChangeDecision,
  CancelTimerResponseSchema,
  ExternalTimersResponseSchema,
  TimerRequestResponseSchema,
  WatchTimersResponseSchema,
  type ExternalTimerDto,
  type WatchTimerDto,
  type TimerRequestDecision,
  type TimerRequestDto,
} from '@pi-lead-child/protocol';
import {
  ConnectionConfirmationResponseSchema,
  ConnectionFlowResponseSchema,
  ConnectionListResponseSchema,
  ConnectionResponseSchema,
  ConnectionTestResponseSchema,
  ConnectionToolListResponseSchema,
  StartConnectionResponseSchema,
  type ConnectionConfirmationDto,
  type ConnectionDto,
  type ConnectionFlowResponse,
  type ConnectionListResponse,
  type ConnectionSettingsRequest,
  type ConnectionTestResponse,
  type ConnectionToolDto,
  type StartConnectionResponse,
} from '@pi-lead-child/protocol';
import {
  ChannelSecretsRequestSchema,
  ChannelSecretsTestResultSchema,
  ChannelSettingsResponseSchema,
  ChannelHandbookResponseSchema, HandbookProposalResponseSchema, HandbookRehearsalResponseSchema, HandbookSuggestionAcceptedResponseSchema,
  HandbookSuggestionsResponseSchema, ChannelPolicyReplayResponseSchema, ChannelPolicyResponseSchema, ChannelPolicyTestResponseSchema,
  type ChannelHandbook, type ChannelHandbookDto, type HandbookProposal, type HandbookProposalRequest, type HandbookRehearsal, type HandbookRehearsalRequest,
  type HandbookSuggestions,
  type ChannelPolicyDto, type ChannelPolicyParams, type ChannelPolicyReplayResult, type ChannelPolicyTestRequest, type ChannelPolicyTestResult,
  ChannelSourceSettingsResponseSchema,
  type ChannelSecretsTestResult,
  type ChannelSettingsResponse,
  type ChannelSourceSettingsDto,
} from '@pi-lead-child/protocol';
import {
  LoopbackInvitationSchema,
  LoopbackInvitationStatusSchema,
  type LoopbackInvitation,
  type LoopbackInvitationRequest,
  type LoopbackInvitationStatus,
} from '@pi-lead-child/protocol';
import {
  StandingOrderDetailResponseSchema,
  StandingOrderListResponseSchema,
  StandingOrderProposalResponseSchema,
  type StandingOrderDetailResponse,
  type StandingOrderListResponse,
  type StandingOrderProposalResponse,
} from '@pi-lead-child/protocol';
import {
  ReplyStyleExtractResponseSchema,
  ReplyStyleResponseSchema,
  type ReplyStyleDto,
  type ReplyStyleExtractRequest,
  type ReplyStyleExtractResult,
  type ReplyStyleUpdateRequest,
} from '@pi-lead-child/protocol';
import {
  DecisionModelResponseSchema,
  ModelSettingsResponseSchema,
  MemoryHindsightResponseSchema,
  MemoryPreferencesResponseSchema,
  SetupResponseSchema,
  WidgetsResponseSchema,
  type SetupResponse,
  type WidgetDto,
  type SetupStatus,
  LeadProfileResponseSchema,
  LeadAvatarImageSchema,
  LeadAvatarResponseSchema,
  SlackEmojiPreviewSchema,
  DesignPreferencesResponseSchema,
  RuntimeSettingsResponseSchema,
  MemoryResponseSchema,
  MemorySwitchConfirmResponseSchema,
  MemorySwitchResponseSchema,
  MemoryTestResponseSchema,
  type DecisionModelDto,
  type ModelSettingsDto,
  type MemoryHindsightDto,
  type MemoryPreferencesDto,
  type LeadProfileDto,
  type LeadProfileRequest,
  type LeadAvatarDto,
  type LeadAvatarImage,
  type LeadAvatarSlackEmojiRequest,
  type LeadAvatarSlot,
  type LeadAvatarUploadRequest,
  type SlackEmojiPreview,
  type DesignPreferencesDto,
  type DesignPreferencesRequest,
  type RuntimeSettingsDto,
  type RuntimeSettingsRequest,
  type DecisionModelSettingsRequest,
  type MemorySettingsDto,
  type MemorySettingsRequest,
  type MemorySwitch,
  type MemorySwitchConfirmResponse,
  type MemoryTestResponse,
} from '@pi-lead-child/protocol';
import {
  AdminBindingListResponseSchema,
  AgendaItemSchema,
  AishCredentialStatusSchema,
  AishForgetResponseSchema,
  ActivitySchema,
  ApprovalSchema,
  AttemptSchema,
  CommandResultSchema,
  ConversationTurnSchema,
  CreatePairingResponseSchema,
  GatewayEventSchema,
  HelloV2Schema,
  HttpErrorResponseSchema,
  InboxViewSchema,
  ProjectOverviewSchema,
  TimelineResponseSchema,
  MilestoneDtoSchema,
  KernelCheckpointListResponseSchema,
  KernelCheckpointV2ListResponseSchema,
  KernelArtifactListResponseSchema,
  KernelConversationCardListResponseSchema,
  KernelInterventionListResponseSchema,
  KernelRuntimeEventListResponseSchema,
  KernelTicketWorkbenchSchema,
  KernelTicketWorkbenchV2Schema,
  KernelTicketWorkItemListResponseSchema,
  KernelTicketWorkItemV2ListResponseSchema,
  KernelTicketSchema,
  LeadDelegationStatusSchema,
  OwnBindingResponseSchema,
  LeadTrustStatusSchema,
  LeadTrustUpdateSchema,
  LinkTicketRelationRequestSchema,
  NotificationDtoSchema,
  NotificationListResponseSchema,
  LeadActivityListResponseSchema,
  LeadActivityViewSchema,
  LeadInterruptAckResponseSchema,
  LEAD_ACTIVITY_INCLUDE,
  LEAD_ACTIVITY_OPT_IN,
  LEAD_ACTIVITY_REMINDERS_INCLUDE,
  LEAD_ACTIVITY_SETUP_INCLUDE,
  leadActivityCardFromItem,
  type LeadActivityItem,
  type LeadActivityListResponse,
  ChannelCardActionResponseSchema,
  ChannelCardListResponseSchema,
  type ChannelCardAction,
  type ChannelCardActionResponse,
  type ChannelCardDto,
  type ChannelCardListResponse,
  type LeadActivityView,
  type LeadInterrupt,
  type LeadInterruptAckResponse,
  OverviewSchema,
  PairAcceptedSchema,
  PairChallengeSchema,
  PairSocketErrorSchema,
  PairingRedeemResponseSchema,
  PROTOCOL_VERSION,
  CHAT_CLIENT_MESSAGE_ID_CAPABILITY,
  CHAT_IMAGES_CAPABILITY,
  CHAT_IMAGES_INCLUDE,
  CHAT_PLACEMENT_CAPABILITY,
  ChatImageSchema,
  LeadModelCatalogSchema,
  LeadModelSwitchResultSchema,
  LEAD_QUEUE_OPT_IN,
  LeadQueueSchema,
  FollowUpActionResultSchema,
  type FollowUpAction,
  type FollowUpActionResult,
  type LeadQueue,
  type LeadQueueAction,
  type LeadModelCatalog,
  type LeadModelChoice,
  type LeadModelSwitchResult,
  type ChatImage,
  type ChatImageInput,
  TICKET_REPLY_ACTIONS_INCLUDE,
  TICKET_REPLY_ACTIONS_OPT_IN,
  type ChatPlacement,
  ProjectSummarySchema,
  RevokeBindingResponseSchema,
  RevokeTicketRelationRequestSchema,
  RuntimeRecheckResponseSchema,
  TicketDetailSchema,
  TicketRelationMutationResultSchema,
  TicketReviewRequestResultSchema,
  TicketReviewerInfoSchema,
  TicketSummarySchema,
  TicketDeliveryResponseSchema,
  DeliveryFileContentSchema,
  DeliveryActionResultSchema,
  type TicketDelivery,
  type TicketDeliveryResponse,
  type DeliveryFileContent,
  type DeliveryFileView,
  type DeliveryActionId,
  type DeliveryActionRequest,
  type DeliveryActionResult,
  TicketDeliveriesResponseSchema,
  TicketDeliverySnapshotResponseSchema,
  type DeliverySummary,
  type TicketDeliveriesResponse,
  type TicketDeliverySnapshot,
  type TicketDeliverySnapshotResponse,
  TicketAcceptanceCriteriaResponseSchema,
  type TicketAcceptanceCriteria,
  TicketReviewsResponseSchema,
  type TicketReviews,
  type TicketReviewsResponse,
  type TicketAcceptanceCriteriaResponse,
  TicketActionsResponseSchema,
  UiActionRunResponseSchema,
  UiActionsResponseSchema,
  type UiActionRunRequest,
  type UiActionRunResponse,
  type UiActionsResponse,
  type UiActionView,
  TicketActionRunResponseSchema,
  type TicketAction,
  type TicketActionId as TicketOperationId,
  type TicketActionRunRequest,
  type TicketActionRunResponse,
  type TicketActionsResponse,
  TicketExecutionPlanResponseSchema,
  type TicketExecutionPlan,
  type TicketExecutionPlanResponse,
  WorkspaceActionResultSchema,
  WsTicketResponseSchema,
  bytesToHex,
  createPairingKeyPair,
  derivePairingSessionKey,
  hashPairingSecret,
  openPairingPayload,
  parseSocketPairingUri,
  sealPairingPayload,
  type AdminBinding,
  type AgendaItem,
  type AishCredentialStatus,
  type AishForgetResponse,
  type BindingDto,
  type ActivityDto,
  type ApprovalDto,
  type AttemptDto,
  type InboxView,
  type ProjectOverview,
  type TimelineResponse,
  type MilestoneDto,
  type MilestoneCreateRequest,
  type MilestonePatchRequest,
  type CommandResult,
  type ConversationTurn,
  type CreatePairingRequest,
  type CreatePairingResponse,
  type CreateTicketRequest,
  type GatewayEvent,
  type HelloV2,
  type KernelRuntimeEvent,
  type KernelCheckpointListResponse,
  type KernelCheckpointV2ListResponse,
  type KernelArtifactListResponse,
  type KernelConversationCardListResponse,
  type KernelInterventionRef,
  type KernelInterventionListResponse,
  type KernelTicketWorkbench,
  type KernelTicketWorkbenchV2,
  type KernelTicketWorkItemListResponse,
  type KernelTicketWorkItemV2ListResponse,
  type KernelRuntimeId,
  type KernelTicket,
  type LeadDelegationStatus,
  type LeadTrustStatus,
  type LeadTrustUpdate,
  type LinkTicketRelationRequest,
  type NotificationDto,
  type NotificationListResponse,
  type Overview,
  type PairingRedeemResponse,
  type ProjectSummary,
  type RevokeTicketRelationRequest,
  type RuntimeRecheckResponse,
  type TicketDetail,
  type TicketListView,
  type TicketStatus,
  type TicketRelationMutationResult,
  type TicketReviewRequestResult,
  type TicketReviewRequest,
  type TicketReviewerInfo,
  type TicketSummary,
  type WorkspaceActionResult,
  type WorkspaceControlActionId,
  type WsCommand,
  type WsTicketResponse,
  type ResolveKernelInterventionRequest,
  type UserItemActionId,
} from '@pi-lead-child/protocol';
import { Value } from 'typebox/value';
import { Type, type TSchema } from 'typebox';

import type { ControlPlaneCredentials, CredentialStore } from './credentialStore.ts';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ControlPlaneSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionHandlers {
  onEvent?: (event: GatewayEvent) => void;
  onHello?: (hello: HelloV2) => void;
  onStateChange?: (state: ConnectionState) => void;
  onProtocolError?: (error: Error) => void;
  // 网关拒绝了凭证：签 ws ticket 时网关回 401 unauthorized，或者连着时 binding 被撤销（关闭码 4001）。
  // 这不会自己好，所以客户端停止重连，状态变成 disconnected。没有这个回调时，错误交给 onProtocolError。
  onCredentialRejected?: (error: ControlPlaneClientError) => void;
}

// 网关撤销 binding 时用的 WebSocket 关闭码（packages/gateway 的 paired-server）。
const CLOSE_BINDING_REVOKED = 4001;

export class ControlPlaneClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    // HTTP 错误响应的原文。有的路由在错误里带结构化的说明（例如委托预检的 preflight）。
    readonly body?: unknown,
  ) {
    super(message);
  }
}

// 保存通道密钥时检查没有通过（PUT /v1/channels/settings/:source 回 400，details 是每项检查的结果）。
// 密钥没有保存。result 给界面逐项显示 ✓/✗ 和说明；里面没有密钥的值。
export class ChannelSecretsRejectedError extends ControlPlaneClientError {
  constructor(message: string, readonly result: ChannelSecretsTestResult, body: unknown) {
    super(message, 'invalid_request', 400, body);
  }
}

interface ClientDependencies {
  fetch?: typeof fetch;
  credentials: CredentialStore;
  createWebSocket?: (url: string) => ControlPlaneSocket;
  createCommandId?: () => string;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  commandTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  pairingTimeoutMs?: number;
  // 安全随机数和 SHA-256。缺省用 WebCrypto（浏览器和 Node 都有）。
  // 没有 WebCrypto 的平台（React Native）由调用方注入，客户端本身不依赖任何平台模块。
  randomBytes?: (length: number) => Promise<Uint8Array>;
  sha256?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  // 每次请求、每次（重新）连接前都问一次网关地址，不用凭证里存的 baseUrl。
  // 网关端口可能随 daemon 重启变化（plc 从 plc.sock 拿当前地址）：沿用旧地址，
  // token 可能发给后来占了那个端口的别的进程。
  resolveBaseUrl?: () => Promise<string>;
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: unknown;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface SendChatCommandInput {
  id: string;
  message: string;
  ticketId?: number;
  // 发件箱给这条消息的稳定 id。重发时不变，daemon 按它去重（protocol 的 CHAT_CLIENT_MESSAGE_ID_CAPABILITY）。
  clientMessageId?: string;
  // Lead 忙时这条消息怎么放：插话（steer，缺省）或排队（followUp）。只在 daemon 宣布了 CHAT_PLACEMENT_CAPABILITY 时带上。
  mode?: ChatPlacement;
  // 发给 Lead 的图片（protocol 的 chat-images.ts）。daemon 没有宣布 CHAT_IMAGES_CAPABILITY 时不发，报拒收。
  images?: ChatImageInput[];
}

export interface SendChatCommandResult {
  turnId: string;
  // daemon 以前收到过这条消息（同一个 clientMessageId），回答的是那时开的一轮。
  duplicate?: true;
}

export interface TicketListQuery {
  view?: TicketListView;
  kind?: 'task' | 'reminder' | 'all';
  status?: TicketStatus[];
  project?: string;
  q?: string;
}

export type TicketRestoreMode = 'root_only' | 'review_tree' | 'selected_children';

export interface TicketActionOptions {
  reason?: string;
  restoreMode?: TicketRestoreMode;
  childTicketIds?: number[];
  signal?: AbortSignal;
}

export interface WorkspaceActionOptions {
  reason?: string;
  mergeStatus?: "merged" | "abandoned";
  // 清理隔离 worktree 不可逆：用户在按钮上就地确认以后才带 true（服务端没收到时回 409，写明会删掉什么）。
  confirm?: true;
  signal?: AbortSignal;
}

export interface TicketActionResult {
  ticketId: number;
  action: UserItemActionId;
  ticket: TicketSummary | null;
}

export interface ReminderRescheduleResult {
  ticketId: number;
  remindAt: string | null;
  ticket: TicketSummary | null;
}

const ReminderRescheduleResultSchema = Type.Object({
  ticketId: Type.Integer({ minimum: 1 }),
  remindAt: Type.Union([Type.String(), Type.Null()]),
  ticket: Type.Union([TicketSummarySchema, Type.Null()]),
});

const TicketActionResultSchema = Type.Object({
  ticketId: Type.Integer({ minimum: 1 }),
  action: Type.Union([
    Type.Literal('confirm'), Type.Literal('start'), Type.Literal('complete'),
    Type.Literal('rework'), Type.Literal('ack'), Type.Literal('stop'),
    Type.Literal('unconfirm'), Type.Literal('restore'), Type.Literal('cancel'),
  ]),
  ticket: Type.Union([TicketSummarySchema, Type.Null()]),
});

export type LinkTicketRelationInput = LinkTicketRelationRequest;
export type RevokeTicketRelationInput = RevokeTicketRelationRequest;
export type TicketRelationActionResult = TicketRelationMutationResult;

export interface LeadDelegationOptions {
  maxReworkCycles?: number;
  budgetLimitTokens?: number;
  budgetLimitUsd?: number;
  effectiveUntil?: string;
  scope?: string;
  requireContinuation?: boolean;
  requiredCapabilityId?: number;
  reason?: string;
  startRework?: boolean;
  // 核查做不成时（所有核查员都不能用），由 Lead 凭它读过的证据验收，账本标明没有独立核查（工单 11，D11）。默认不勾。
  acceptWithoutReview?: boolean;
  signal?: AbortSignal;
}

export const KERNEL_RESOURCE_CAPABILITIES = {
  checkpoints: { 2: 'kernel.checkpoints.v2', 1: 'kernel.checkpoints.v1' },
  interventions: { 1: 'kernel.interventions.v1' },
  workItems: { 2: 'kernel.work-items.v2', 1: 'kernel.work-items.v1' },
  ticketWorkbench: { 2: 'kernel.ticket-workbench.v2', 1: 'kernel.ticket-workbench.v1' },
  artifacts: { 1: 'kernel.artifacts.v1' },
  conversationCards: { 1: 'kernel.conversation-cards.v1' },
} as const;

export type KernelResourceName = keyof typeof KERNEL_RESOURCE_CAPABILITIES;
export type KernelResourceVersion = 1 | 2;

export function selectKernelResourceVersion(
  capabilities: readonly string[],
  resource: KernelResourceName,
): KernelResourceVersion | null {
  const versions = KERNEL_RESOURCE_CAPABILITIES[resource] as Partial<Record<KernelResourceVersion, string>>;
  if (versions[2] && capabilities.includes(versions[2])) return 2;
  if (versions[1] && capabilities.includes(versions[1])) return 1;
  return null;
}

export function supportsKernelCapability(
  capabilities: readonly string[],
  resource: KernelResourceName,
): boolean {
  return selectKernelResourceVersion(capabilities, resource) !== null;
}

export interface KernelCursorOptions {
  afterId?: number;
  beforeId?: number;
  limit?: number;
}

export interface KernelInterventionQuery {
  ticketId?: number;
  state?: KernelInterventionRef['state'];
  ids?: string[];
}

export interface KernelConversationCardQuery extends KernelCursorOptions {
  ticketIds?: number[];
  keys?: string[];
}

export interface KernelInterventionResolutionResult {
  status: string;
  interventionId: string;
}

export interface ArtifactDownload {
  bytes: ArrayBuffer;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

const KernelInterventionResolutionResultSchema = Type.Object({
  status: Type.String(),
  interventionId: Type.String(),
}, { additionalProperties: false });

const AckNotificationResultSchema = Type.Object({
  notification: NotificationDtoSchema,
}, { additionalProperties: false });

const ProjectStatusResultSchema = Type.Object({
  projectId: Type.Integer(),
  status: Type.String(),
}, { additionalProperties: false });

const InboxSeenResultSchema = Type.Object({
  seenAt: Type.String(),
}, { additionalProperties: false });

export type NotificationStateFilter = NotificationDto['state'];

const DeliveryFileResponseSchema = Type.Object({ file: DeliveryFileContentSchema }, { additionalProperties: false });

const collection = <T>(schema: TSchema, value: unknown): T[] => {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    throw new ControlPlaneClientError('invalid collection response', 'invalid_response');
  }
  const items = (value as { items: unknown[] }).items;
  if (!items.every((item) => Value.Check(schema, item))) {
    throw new ControlPlaneClientError('response does not match the shared protocol', 'invalid_response');
  }
  return items as T[];
};

export function normalizeControlPlaneEndpoint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('control-plane endpoint is required');
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('control-plane endpoint must use http or https');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function controlPlaneBaseUrlFromSocket(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/v1\/paired\/connect\/?$/, '').replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

// chat 的 HTTP 兜底最多等多久。
const CHAT_HTTP_TIMEOUT_MS = 20_000;

export class ControlPlaneClient {
  private readonly fetcher: typeof fetch;
  private readonly createSocket: (url: string) => ControlPlaneSocket;
  private readonly idFactory: () => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly commandTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly pairingTimeoutMs: number;
  private readonly randomBytes: (length: number) => Promise<Uint8Array>;
  private readonly sha256: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  private record: ControlPlaneCredentials | null = null;
  private socket: ControlPlaneSocket | null = null;
  private handlers: ConnectionHandlers = {};
  private state: ConnectionState = 'disconnected';
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private commandCounter = 0;
  private pending = new Map<string, PendingCommand>();
  private credentialWrite = Promise.resolve();
  private eventQueue = Promise.resolve();
  private connectionGeneration = 0;
  private credentialGeneration = 0;
  private pairingCancels = new Set<() => void>();
  private heartbeatTimer: unknown = null;
  private heartbeatInFlight = false;
  // 现在有没有人在看（presence.set）。null：调用方没说过，就不发。
  private presence: boolean | null = null;
  // 最近一次 hello.v2 宣布的能力。断开以后保留：HTTP 兜底时还要用。
  private capabilities = new Set<string>();

  constructor(private readonly deps: ClientDependencies) {
    this.fetcher = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.createSocket = deps.createWebSocket ?? ((url) => new WebSocket(url) as unknown as ControlPlaneSocket);
    this.idFactory = deps.createCommandId ?? (() => `cmd_${Date.now().toString(36)}_${(++this.commandCounter).toString(36)}`);
    this.setTimer = deps.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 30_000;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? 5_000;
    this.pairingTimeoutMs = deps.pairingTimeoutMs ?? 15_000;
    this.randomBytes = deps.randomBytes ?? webCryptoRandomBytes;
    this.sha256 = deps.sha256 ?? webCryptoSha256;
  }

  async pair(endpoint: string, pairingCode: string, signal?: AbortSignal): Promise<ControlPlaneCredentials> {
    throwIfAborted(signal);
    const generation = this.credentialGeneration;
    const baseUrl = normalizeControlPlaneEndpoint(endpoint);
    const response = await this.fetcher(`${baseUrl}/v1/paired/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: pairingCode.trim().toUpperCase() }),
      signal,
    });
    return this.acceptPairingResponse(baseUrl, response, generation, signal);
  }

  async pairLoopback(endpoint: string, name = 'localhost-web', signal?: AbortSignal): Promise<ControlPlaneCredentials> {
    throwIfAborted(signal);
    const generation = this.credentialGeneration;
    const baseUrl = normalizeControlPlaneEndpoint(endpoint);
    const response = await this.fetcher(`${baseUrl}/v1/paired/loopback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal,
    });
    return this.acceptPairingResponse(baseUrl, response, generation, signal);
  }

  async pairSocket(invitationUri: string, signal?: AbortSignal): Promise<ControlPlaneCredentials> {
    throwIfAborted(signal);
    const credentialGeneration = this.credentialGeneration;
    const invitation = parseSocketPairingUri(invitationUri);
    const clientPair = createPairingKeyPair(await this.randomBytes(32));
    const expectedDaemonKey = bytesToHex(invitation.daemonPublicKey);
    const baseUrl = controlPlaneBaseUrlFromSocket(invitation.endpoint);

    return new Promise((resolve, reject) => {
      const socket = this.createSocket(invitation.endpoint);
      let stage: 'challenge' | 'accepted' = 'challenge';
      let sessionKey: Uint8Array | null = null;
      let settled = false;
      const timer = this.setTimer(() => {
        fail(new ControlPlaneClientError('pairing handshake timed out', 'timeout'));
      }, this.pairingTimeoutMs);

      const close = () => {
        try { socket.close(1000, 'pairing complete'); } catch { /* already closed */ }
      };
      const cleanup = () => {
        this.pairingCancels.delete(cancel);
        signal?.removeEventListener('abort', cancel);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        cleanup();
        close();
        reject(error);
      };
      const cancel = () => fail(abortError());
      this.pairingCancels.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      const accept = async (payload: PairingRedeemResponse) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        const record: ControlPlaneCredentials = {
          baseUrl,
          accessToken: payload.access_token,
          binding: payload.binding,
          lastSeq: 0,
        };
        try {
          throwIfAborted(signal);
          if (credentialGeneration !== this.credentialGeneration) throw abortError();
          this.record = record;
          await this.saveCredentials(record, credentialGeneration);
          cleanup();
          close();
          resolve(record);
        } catch (reason) {
          this.record = null;
          cleanup();
          close();
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        }
      };

      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'pair.hello',
          protocolVersion: PROTOCOL_VERSION,
          pairingId: invitation.pairingId,
          clientPublicKey: bytesToHex(clientPair.publicKey),
        }));
      };
      socket.onerror = () => fail(new ControlPlaneClientError('pairing socket failed', 'disconnected'));
      socket.onclose = () => {
        if (!settled) fail(new ControlPlaneClientError('pairing socket closed before acceptance', 'disconnected'));
      };
      socket.onmessage = (event) => {
        void (async () => {
          let message: unknown;
          try { message = JSON.parse(String(event.data)); }
          catch { fail(new ControlPlaneClientError('invalid pairing WebSocket JSON', 'invalid_response')); return; }

          if (Value.Check(PairSocketErrorSchema, message)) {
            fail(new ControlPlaneClientError(message.error.message, message.error.code));
            return;
          }
          if (stage === 'challenge') {
            if (!Value.Check(PairChallengeSchema, message)) {
              fail(new ControlPlaneClientError('invalid pairing challenge', 'invalid_response'));
              return;
            }
            if (message.daemonPublicKey !== expectedDaemonKey) {
              fail(new ControlPlaneClientError('pairing daemon identity does not match the QR invitation', 'identity_mismatch'));
              return;
            }
            try {
              sessionKey = derivePairingSessionKey(
                clientPair.secretKey,
                invitation.daemonPublicKey,
                hashPairingSecret(invitation.pairingSecret),
              );
              const payload = openPairingPayload(message.envelope, sessionKey) as {
                type?: unknown; pairingId?: unknown; challenge?: unknown;
              };
              if (
                payload?.type !== 'pair.challenge' ||
                payload.pairingId !== invitation.pairingId ||
                typeof payload.challenge !== 'string' ||
                !/^[0-9a-f]{48}$/.test(payload.challenge)
              ) {
                throw new Error('pairing challenge mismatch');
              }
              const nonce = await this.randomBytes(24);
              if (settled) return;
              socket.send(JSON.stringify({
                type: 'pair.confirm',
                protocolVersion: PROTOCOL_VERSION,
                envelope: sealPairingPayload({
                  type: 'pair.confirm',
                  pairingId: invitation.pairingId,
                  challenge: payload.challenge,
                }, sessionKey, nonce),
              }));
              stage = 'accepted';
            } catch {
              fail(new ControlPlaneClientError('invalid encrypted pairing challenge', 'invalid_proof'));
            }
            return;
          }

          if (!sessionKey || !Value.Check(PairAcceptedSchema, message)) {
            fail(new ControlPlaneClientError('invalid pairing acceptance', 'invalid_response'));
            return;
          }
          try {
            const decrypted = openPairingPayload(message.envelope, sessionKey) as Record<string, unknown>;
            const payload = { binding: decrypted.binding, access_token: decrypted.access_token };
            if (decrypted.type !== 'pair.accepted' || !Value.Check(PairingRedeemResponseSchema, payload)) {
              throw new Error('invalid pairing acceptance payload');
            }
            await accept(payload as PairingRedeemResponse);
          } catch {
            fail(new ControlPlaneClientError('invalid encrypted pairing acceptance', 'invalid_proof'));
          }
        })();
      };
    });
  }

  private async acceptPairingResponse(
    baseUrl: string,
    response: Response,
    generation: number,
    signal?: AbortSignal,
  ): Promise<ControlPlaneCredentials> {
    const payload = await this.readJson(response);
    throwIfAborted(signal);
    if (generation !== this.credentialGeneration) throw abortError();
    if (!response.ok) throw this.responseError(response.status, payload);
    if (!Value.Check(PairingRedeemResponseSchema, payload)) {
      throw new ControlPlaneClientError('invalid pairing response', 'invalid_response', response.status);
    }
    const paired = payload as PairingRedeemResponse;
    const record = {
      baseUrl,
      accessToken: paired.access_token,
      binding: paired.binding,
      lastSeq: 0,
    };
    await this.saveCredentials(record, generation);
    this.record = record;
    return record;
  }

  async forget(): Promise<void> {
    this.credentialGeneration += 1;
    for (const cancel of [...this.pairingCancels]) cancel();
    this.disconnect();
    await this.credentialWrite;
    this.record = null;
    await this.deps.credentials.clear();
  }

  // 这个凭证对应的 binding（GET /v1/paired/me）。凭证无效时抛 401。
  async getOwnBinding(signal?: AbortSignal): Promise<BindingDto> {
    const payload = await this.request<{ binding: BindingDto }>('/v1/paired/me', OwnBindingResponseSchema, { signal });
    return payload.binding;
  }

  // include=lead：带上 Lead 的模型调用健康（会话顶栏读它）。旧 daemon 不认识这个参数，照常返回。
  async getOverview(signal?: AbortSignal): Promise<Overview> {
    return this.request('/v1/overview?include=lead', OverviewSchema, { signal });
  }

  async getTickets(signal?: AbortSignal): Promise<TicketSummary[]> {
    return collection<TicketSummary>(TicketSummarySchema, await this.requestRaw('/v1/tickets', { signal }));
  }

  // 按 store 的预设视图列工单（spec §9）。不带参数时和 getTickets 一样，只列 task。
  async listTickets(query: TicketListQuery = {}, signal?: AbortSignal): Promise<TicketSummary[]> {
    const params = new URLSearchParams();
    if (query.view !== undefined) params.set('view', query.view);
    if (query.kind !== undefined) params.set('kind', query.kind);
    for (const status of query.status ?? []) params.append('status', status);
    if (query.project !== undefined) params.set('project', query.project);
    if (query.q !== undefined) params.set('q', query.q);
    const suffix = params.size === 0 ? '' : `?${params}`;
    return collection<TicketSummary>(TicketSummarySchema, await this.requestRaw(`/v1/tickets${suffix}`, { signal }));
  }

  // 以用户身份建一条根工单。请求体里没有 actor：服务端只以 user 身份建单。
  async createTicket(input: CreateTicketRequest, signal?: AbortSignal): Promise<KernelTicket> {
    return this.request('/v1/tickets', KernelTicketSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  }

  async getTicket(ticketId: number, signal?: AbortSignal): Promise<TicketDetail> {
    return this.request(`/v1/tickets/${ticketId}`, TicketDetailSchema, { signal });
  }

  // 这张工单的核查员和可选的核查员（2026-10-20）。单独一个接口，不在 TicketSummary 里：
  // 工单列表是严格校验的，加字段会让旧页面整张列表加载失败。
  async getTicketReviewer(ticketId: number, signal?: AbortSignal): Promise<TicketReviewerInfo> {
    return this.request(`/v1/tickets/${ticketId}/reviewer`, TicketReviewerInfoSchema, { signal });
  }

  async getActivities(ticketId: number, signal?: AbortSignal): Promise<ActivityDto[]> {
    const items: ActivityDto[] = [];
    let afterId = 0;
    // 生命周期是审计视图，不能把服务端的单页上限误当成完整历史。
    for (;;) {
      const page = collection<ActivityDto>(
        ActivitySchema,
        await this.requestRaw(`/v1/tickets/${ticketId}/activities?after_id=${afterId}&limit=500`, { signal }),
      );
      items.push(...page);
      if (page.length < 500) return items;
      afterId = page[page.length - 1]!.id;
    }
  }

  async getAttempts(ticketId: number, signal?: AbortSignal): Promise<AttemptDto[]> {
    return collection<AttemptDto>(AttemptSchema, await this.requestRaw(`/v1/tickets/${ticketId}/attempts`, { signal }));
  }

  async getAttemptEvents(_attemptId: number, _signal?: AbortSignal): Promise<KernelRuntimeEvent[]> {
    const payload = await this.requestRaw(`/v1/kernel/attempts/${_attemptId}/events`, { signal: _signal });
    if (!Value.Check(KernelRuntimeEventListResponseSchema, payload)) {
      throw new ControlPlaneClientError('response does not match the shared protocol', 'invalid_response');
    }
    return payload.items as KernelRuntimeEvent[];
  }

  async getKernelCheckpoints(
    ticketId: number,
    options: KernelCursorOptions = {},
    signal?: AbortSignal,
    version: KernelResourceVersion = 1,
  ): Promise<KernelCheckpointListResponse | KernelCheckpointV2ListResponse> {
    const query = cursorQuery(options);
    const prefix = version === 2 ? '/v1/kernel/v2' : '/v1/kernel';
    return this.request(
      `${prefix}/tickets/${ticketId}/checkpoints${query}`,
      version === 2 ? KernelCheckpointV2ListResponseSchema : KernelCheckpointListResponseSchema,
      { signal },
    );
  }

  async getKernelWorkItems(
    ticketIds: number[] = [],
    signal?: AbortSignal,
    version: KernelResourceVersion = 1,
  ): Promise<KernelTicketWorkItemListResponse | KernelTicketWorkItemV2ListResponse> {
    const params = new URLSearchParams();
    for (const ticketId of ticketIds) params.append('ticket_id', String(ticketId));
    const query = params.size === 0 ? '' : `?${params}`;
    return this.request(
      `/v1/kernel${version === 2 ? '/v2' : ''}/work-items${query}`,
      version === 2 ? KernelTicketWorkItemV2ListResponseSchema : KernelTicketWorkItemListResponseSchema,
      { signal },
    );
  }

  async getKernelTicketWorkbench(
    ticketId: number,
    signal?: AbortSignal,
    version: KernelResourceVersion = 1,
  ): Promise<KernelTicketWorkbench | KernelTicketWorkbenchV2> {
    return this.request(
      `/v1/kernel${version === 2 ? '/v2' : ''}/tickets/${ticketId}/workbench`,
      version === 2 ? KernelTicketWorkbenchV2Schema : KernelTicketWorkbenchSchema,
      { signal },
    );
  }

  async getKernelArtifacts(
    ticketId: number,
    signal?: AbortSignal,
  ): Promise<KernelArtifactListResponse> {
    return this.request(
      `/v1/kernel/v1/tickets/${ticketId}/artifacts`,
      KernelArtifactListResponseSchema,
      { signal },
    );
  }

  async downloadArtifact(
    ticketId: number,
    artifactId: number,
    signal?: AbortSignal,
  ): Promise<ArtifactDownload> {
    throwIfAborted(signal);
    const record = await this.requireRecord();
    const baseUrl = await this.baseUrlFor(record);
    throwIfAborted(signal);
    const response = await this.fetcher(
      `${baseUrl}/v1/kernel/v1/tickets/${ticketId}/artifacts/${artifactId}/content`,
      { headers: { authorization: `Bearer ${record.accessToken}` }, signal },
    );
    if (!response.ok) {
      const payload = await this.readJson(response);
      throw this.responseError(response.status, payload);
    }
    const responseArtifactId = positiveHeaderInteger(response.headers.get('x-artifact-id'));
    const byteLength = nonNegativeHeaderInteger(response.headers.get('content-length'));
    const sha256 = response.headers.get('x-artifact-sha256')?.toLowerCase() ?? '';
    const mediaType = normalizedMediaType(response.headers.get('content-type'));
    const filename = attachmentFilename(response.headers.get('content-disposition'));
    if (responseArtifactId !== artifactId || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ControlPlaneClientError('artifact response metadata is invalid', 'integrity_error');
    }
    const bytes = await response.arrayBuffer();
    throwIfAborted(signal);
    if (bytes.byteLength !== byteLength) {
      throw new ControlPlaneClientError('artifact byte length does not match metadata', 'integrity_error');
    }
    const actualSha = bytesToHex(new Uint8Array(await this.sha256(bytes)));
    if (actualSha !== sha256) {
      throw new ControlPlaneClientError('artifact SHA does not match metadata', 'integrity_error');
    }
    return { bytes, filename, mediaType, byteLength, sha256 };
  }

  async getKernelInterventions(
    query: KernelInterventionQuery = {},
    signal?: AbortSignal,
  ): Promise<KernelInterventionListResponse> {
    const params = new URLSearchParams();
    if (query.ticketId !== undefined) params.set('ticket_id', String(query.ticketId));
    if (query.state !== undefined) params.set('state', query.state);
    for (const id of query.ids ?? []) params.append('id', id);
    const suffix = params.size === 0 ? '' : `?${params}`;
    return this.request(`/v1/kernel/interventions${suffix}`, KernelInterventionListResponseSchema, { signal });
  }

  async resolveKernelIntervention(
    interventionId: string,
    input: ResolveKernelInterventionRequest,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<KernelInterventionResolutionResult> {
    if (!commandId.trim()) {
      throw new ControlPlaneClientError('intervention command id is required', 'invalid_request');
    }
    return this.request(
      `/v1/kernel/interventions/${encodeURIComponent(interventionId)}/resolve`,
      KernelInterventionResolutionResultSchema,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': commandId,
        },
        body: JSON.stringify(input),
        signal,
      },
    );
  }

  async getKernelConversationCards(
    query: KernelConversationCardQuery = {},
    signal?: AbortSignal,
  ): Promise<KernelConversationCardListResponse> {
    const params = new URLSearchParams();
    for (const ticketId of query.ticketIds ?? []) params.append('ticket_id', String(ticketId));
    for (const key of query.keys ?? []) params.append('key', key);
    appendCursor(params, query);
    const suffix = params.size === 0 ? '' : `?${params}`;
    return this.request(
      `/v1/kernel/conversation/cards${suffix}`,
      KernelConversationCardListResponseSchema,
      { signal },
    );
  }

  async getProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    return collection<ProjectSummary>(ProjectSummarySchema, await this.requestRaw('/v1/projects', { signal }));
  }

  // 项目卡片：分布、Lead 的一句话、最近动静、最近的截止、累计花费，含归档的项目。
  async getProjectsOverview(signal?: AbortSignal): Promise<ProjectOverview[]> {
    return collection<ProjectOverview>(ProjectOverviewSchema, await this.requestRaw('/v1/projects/overview', { signal }));
  }

  // 归档或恢复一个项目。
  async setProjectArchived(projectId: number, archived: boolean, signal?: AbortSignal): Promise<void> {
    await this.request<{ projectId: number; status: string }>(
      `/v1/projects/${projectId}/${archived ? 'archive' : 'restore'}`,
      ProjectStatusResultSchema,
      { method: 'POST', ...(signal ? { signal } : {}) },
    );
  }

  // 日程（阶段 3）：节点、提醒、推迟开始、例行任务，带出处和风险；过期区不设下限。
  async getTimeline(from: string, to: string, timezone: string, signal?: AbortSignal): Promise<TimelineResponse> {
    const params = new URLSearchParams({ from, to, timezone });
    return this.request<TimelineResponse>(`/v1/timeline?${params}`, TimelineResponseSchema, { ...(signal ? { signal } : {}) });
  }

  // 你给工单记一个节点（出处是 user）。
  async createMilestone(ticketId: number, body: MilestoneCreateRequest, signal?: AbortSignal): Promise<MilestoneDto> {
    return this.request<MilestoneDto>(`/v1/tickets/${ticketId}/milestones`, MilestoneDtoSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
  }

  // 改期、标完成、取消或恢复一个节点。没有删除。
  async updateMilestone(milestoneId: number, patch: MilestonePatchRequest, signal?: AbortSignal): Promise<MilestoneDto> {
    return this.request<MilestoneDto>(`/v1/milestones/${milestoneId}`, MilestoneDtoSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch), ...(signal ? { signal } : {}),
    });
  }

  // 总是带上过期的条目：日程顶部的「已过期」区要看到范围之前没结束的截止和没确认的提醒。
  async getAgenda(from: string, to: string, timezone: string, signal?: AbortSignal): Promise<AgendaItem[]> {
    const params = new URLSearchParams({ from, to, timezone, include: 'overdue' });
    return collection<AgendaItem>(AgendaItemSchema, await this.requestRaw(`/v1/agenda?${params}`, { signal }));
  }

  async getApprovals(signal?: AbortSignal): Promise<ApprovalDto[]> {
    return collection<ApprovalDto>(ApprovalSchema, await this.requestRaw('/v1/approvals', { signal }));
  }

  async getNotifications(
    states: NotificationStateFilter[] = ['pending', 'delivered'],
    signal?: AbortSignal,
  ): Promise<NotificationDto[]> {
    const params = new URLSearchParams();
    for (const state of states) params.append('state', state);
    const suffix = params.size === 0 ? '' : `?${params}`;
    const payload = await this.request<NotificationListResponse>(
      `/v1/notifications${suffix}`,
      NotificationListResponseSchema,
      { signal },
    );
    return payload.items;
  }

  // Lead 处理了、但没有对用户说的事（方案 A「Lead 动态」）。旧 daemon 没有这个路由（404）时返回空表。
  async getLeadActivity(signal?: AbortSignal): Promise<LeadActivityItem[]> {
    try {
      const payload = await this.request<LeadActivityListResponse>('/v1/lead/activity', LeadActivityListResponseSchema, { signal });
      return payload.items;
    } catch (error) {
      if (error instanceof ControlPlaneClientError && error.status === 404) return [];
      throw error;
    }
  }

  // 外部来源的会话卡（工单 11）。旧 daemon 没有这个路由（404）时返回空表。
  async getChannelCards(signal?: AbortSignal): Promise<ChannelCardDto[]> {
    try {
      const payload = await this.request<ChannelCardListResponse>('/v1/channels/cards', ChannelCardListResponseSchema, { signal });
      return payload.items;
    } catch (error) {
      if (error instanceof ControlPlaneClientError && error.status === 404) return [];
      throw error;
    }
  }

  // 卡上的一个动作：用草稿回复、我自己回、稍后、不回、撤回自动回复；代查的改一下再发、重新查、停止代查、发到 PR 并回复。
  // expectedVersion 是用户看到的版本：卡已经变了时回 409。text 是用户自己写的文字（只有 send_edited 带）。
  async actOnChannelCard(
    cardId: number, action: ChannelCardAction, expectedVersion?: number, text?: string, signal?: AbortSignal,
  ): Promise<ChannelCardDto> {
    const payload = await this.request<ChannelCardActionResponse>(`/v1/channels/cards/${cardId}/actions`, ChannelCardActionResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action, ...(expectedVersion === undefined ? {} : { expectedVersion }), ...(text === undefined ? {} : { text }),
      }),
      ...(signal ? { signal } : {}),
    });
    return payload.card;
  }

  // 「Lead 动态」的卡片和 interrupt 横幅（工单 06）。旧 daemon 不认识 include=events，回的是旧的 items：换成卡片，没有横幅。
  // 没有这个路由（404）时是空的。
  async getLeadActivityView(signal?: AbortSignal): Promise<LeadActivityView> {
    let payload: unknown;
    try {
      // include=reminders（工单 07）：再要会话里的提醒卡。旧 daemon 不认识它，回的 view 没有 reminders。
      // include=setup：首次启动引导的准备清单卡和建议卡（旧 daemon 不认识，回的 view 没有这两项）。
      payload = await this.requestRaw(`/v1/lead/activity?include=${LEAD_ACTIVITY_INCLUDE},${LEAD_ACTIVITY_REMINDERS_INCLUDE},${LEAD_ACTIVITY_SETUP_INCLUDE}`, { signal });
    } catch (error) {
      if (error instanceof ControlPlaneClientError && error.status === 404) return { cards: [], interrupts: [], watermark: 0 };
      throw error;
    }
    if (Value.Check(LeadActivityViewSchema, payload)) return payload;
    if (Value.Check(LeadActivityListResponseSchema, payload)) {
      return { cards: payload.items.map(leadActivityCardFromItem), interrupts: [], watermark: 0 };
    }
    throw new ControlPlaneClientError('response does not match the shared protocol', 'invalid_response');
  }

  // 用户点了横幅上的「知道了」（工单 06）。返回确认以后的样子。
  async acknowledgeLeadInterrupt(seq: number, signal?: AbortSignal): Promise<LeadInterrupt> {
    const payload = await this.request<LeadInterruptAckResponse>(
      `/v1/lead/interrupts/${seq}/ack`,
      LeadInterruptAckResponseSchema,
      { method: 'POST', ...(signal ? { signal } : {}) },
    );
    return payload.interrupt;
  }

  // 每一轮带上工具调用（toolCalls）、Lead 生成的富交互卡片（surfaces）、用户的消息怎么放的（placement，工单 04）、
  // 工单回复在问你要不要做的动作（reply_actions，2026-10-19）和用户发的图片（images，2026-10-25），刷新以后和实时看到的一样。
  // 不认识的 include 旧 daemon 回 400 invalid include：依次退回少要一项。
  async getConversationTurns(ticketId?: number, signal?: AbortSignal): Promise<ConversationTurn[]> {
    const load = async (include: string) => {
      const params = new URLSearchParams({ include });
      if (ticketId !== undefined) params.set('ticket_id', String(ticketId));
      return collection<ConversationTurn>(ConversationTurnSchema, await this.requestRaw(`/v1/conversation/turns?${params}`, { signal }));
    };
    const full = `tool_calls,surfaces,placement,${TICKET_REPLY_ACTIONS_INCLUDE}`;
    // 用户发的图片（include=images）总是先要：页面打开时快照在 hello.v2 之前就取了，那时还不知道 daemon 的能力。
    const includes = [`${full},${CHAT_IMAGES_INCLUDE}`, full, 'tool_calls,surfaces,placement', 'tool_calls,surfaces'];
    for (const include of includes) {
      try {
        return await load(include);
      } catch (error) {
        if (!(error instanceof ControlPlaneClientError && error.status === 400 && /include/.test(error.message))) throw error;
      }
    }
    return load('tool_calls');
  }

  // Lead 可以用的模型和推理强度（会话输入框右下角的模型选择，protocol 的 lead-models.ts）。
  async getLeadModels(signal?: AbortSignal): Promise<LeadModelCatalog> {
    return this.request<LeadModelCatalog>('/v1/lead/models', LeadModelCatalogSchema, { signal });
  }

  // Lead 忙时排着的外部消息（主对话输入框上方的排队状态栏，protocol 的 lead-queue.ts，工单 10）。
  async getLeadQueue(signal?: AbortSignal): Promise<LeadQueue> {
    return this.request<LeadQueue>('/v1/lead/queue', LeadQueueSchema, { signal });
  }

  // 排到下一个、移出队列（操作层的 lead_queue，和 Lead 的 perform_action 是同一个操作）。回答是操作以后的排队。
  async leadQueueAction(action: LeadQueueAction, key: string, signal?: AbortSignal): Promise<LeadQueue> {
    return this.request<LeadQueue>(`/v1/lead/queue/${action}`, LeadQueueSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      ...(signal ? { signal } : {}),
    });
  }

  // 用户排着的一条追问：steer 插进 Lead 正在做的这一轮，cancel 不再发给 Lead（操作层的 follow_up，protocol 的 lead-follow-ups.ts）。
  // 回答是这一条现在的放置。只在 daemon 宣布了 CHAT_FOLLOW_UP_ACTIONS_CAPABILITY 时调用。
  async followUpAction(action: FollowUpAction, turnId: string, signal?: AbortSignal): Promise<FollowUpActionResult> {
    return this.request<FollowUpActionResult>(`/v1/lead/follow-ups/${action}`, FollowUpActionResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId }),
      ...(signal ? { signal } : {}),
    });
  }

  // 换 Lead 的模型和推理强度（和 Lead 的 switch_lead_model 是同一个操作）。
  async switchLeadModel(choice: LeadModelChoice, signal?: AbortSignal): Promise<LeadModelSwitchResult> {
    return this.request<LeadModelSwitchResult>('/v1/lead/model', LeadModelSwitchResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: choice.model, effort: choice.effort }),
      ...(signal ? { signal } : {}),
    });
  }

  // 用户发给 Lead 的一张图片（会话快照的 images 里的 id，protocol 的 chat-images.ts）。
  async getChatImage(imageId: string, signal?: AbortSignal): Promise<ChatImage> {
    return this.request<ChatImage>(`/v1/chat/images/${encodeURIComponent(imageId)}`, ChatImageSchema, { signal });
  }

  // 用户控制面动作（kernel spec §6.4/§8）。路由按动作命名而不是 PATCH stage——服务端
  // 的白名单与这里的动作名同源于 protocol 的 USER_ITEM_ACTION_IDS，拼错一个字母是编译错，
  // 不是运行时 404。
  //
  // 刻意**不带** actor 字段：这条平面只以 user 身份行事，服务端的 assertUserActor 会拒掉
  // 任何别的取值。把 actor 写进请求体等于给"冒名"留一个参数位。
  async performTicketAction(
    ticketId: number,
    action: UserItemActionId,
    options: TicketActionOptions = {},
  ): Promise<TicketActionResult> {
    const body: Record<string, unknown> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    if (action === 'restore') {
      if (options.restoreMode !== undefined) body.mode = options.restoreMode;
      if (options.childTicketIds !== undefined) body.child_ticket_ids = options.childTicketIds;
    }
    return this.request<TicketActionResult>(`/v1/tickets/${ticketId}/${action}`, TicketActionResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  // 给提醒改时间（工单 07）：「改时间」给 remindAt，「10 分钟后再提醒」给 snoozeMinutes。它不是 stage 的一条用户边
  // （到点的提醒由服务端拉回等待），所以不在 USER_ITEM_ACTION_IDS 里。已确认、已取消的提醒回 409。
  async rescheduleReminder(
    reminderId: number,
    change: { remindAt?: string; snoozeMinutes?: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReminderRescheduleResult> {
    return this.request<ReminderRescheduleResult>(`/v1/reminders/${reminderId}/reschedule`, ReminderRescheduleResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  // 手动派发独立核查（工单 #66）。它不是 stage 的一条边，所以不在 USER_ITEM_ACTION_IDS 里，
  // 有自己的路由。服务端用 reviewState.canRequestReview 的同一个判据决定能不能派。
  // runtime：用户选的核查员（2026-10-20）。有排着的核查就换它的核查员，没有就用它新排一条。
  async requestTicketReview(
    ticketId: number,
    options: { signal?: AbortSignal; runtime?: TicketReviewRequest['runtime'] } = {},
  ): Promise<TicketReviewRequestResult> {
    const body: TicketReviewRequest = options.runtime ? { runtime: options.runtime } : {};
    return this.request<TicketReviewRequestResult>(`/v1/tickets/${ticketId}/request-review`, TicketReviewRequestResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async performWorkspaceAction(
    workspaceId: number,
    action: WorkspaceControlActionId,
    options: WorkspaceActionOptions = {},
  ): Promise<WorkspaceActionResult> {
    const body: Record<string, unknown> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    if (options.mergeStatus !== undefined) body.merge_status = options.mergeStatus;
    if (options.confirm === true) body.confirm = true;
    return this.request<WorkspaceActionResult>(`/v1/workspaces/${workspaceId}/${action}`, WorkspaceActionResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  // 工单的「这次交付」（2026-10-20）：改了哪些文件、改动在哪个分支、能不能合并 / 开 PR / 放弃。
  async getTicketDelivery(ticketId: number, options: { signal?: AbortSignal } = {}): Promise<TicketDelivery> {
    const response = await this.request<TicketDeliveryResponse>(`/v1/tickets/${ticketId}/delivery`, TicketDeliveryResponseSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.delivery;
  }

  // 交付里一个文件的全文（full）或相对开工时的改动（diff）。只能读交付列表里的文件。
  async getTicketDeliveryFile(
    ticketId: number,
    path: string,
    view: DeliveryFileView,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeliveryFileContent> {
    const query = new URLSearchParams({ path, view }).toString();
    const response = await this.request<{ file: DeliveryFileContent }>(`/v1/tickets/${ticketId}/delivery/file?${query}`, DeliveryFileResponseSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.file;
  }

  // 这张工单的每一次交付（工单 04）：交付切换用。按顺序，最后一个是最新一次。
  async getTicketDeliveries(ticketId: number, options: { signal?: AbortSignal } = {}): Promise<DeliverySummary[]> {
    const response = await this.request<TicketDeliveriesResponse>(`/v1/tickets/${ticketId}/deliveries`, TicketDeliveriesResponseSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.deliveries;
  }

  // 第 sequence 次交付的快照。不给 revision 时是这次交付最新的一份（交付以后工作区又变过时，一次交付有几份）。
  async getTicketDeliverySnapshot(
    ticketId: number,
    sequence: number,
    options: { revision?: number; signal?: AbortSignal } = {},
  ): Promise<TicketDeliverySnapshot> {
    const query = options.revision === undefined ? '' : `?${new URLSearchParams({ revision: String(options.revision) }).toString()}`;
    const response = await this.request<TicketDeliverySnapshotResponse>(
      `/v1/tickets/${ticketId}/deliveries/${sequence}${query}`, TicketDeliverySnapshotResponseSchema, {
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return response.delivery;
  }

  // 工单的结构化验收标准和你在某次交付上的确认（工单 05）。delivery 是第几次交付（交付切换），不给时对照最新一次。
  // 编辑和确认是工单操作：edit_acceptance_criteria、confirm_criterion、unconfirm_criterion。
  async getTicketAcceptanceCriteria(
    ticketId: number,
    options: { delivery?: number; signal?: AbortSignal } = {},
  ): Promise<TicketAcceptanceCriteria> {
    const query = options.delivery === undefined ? '' : `?${new URLSearchParams({ delivery: String(options.delivery) }).toString()}`;
    const response = await this.request<TicketAcceptanceCriteriaResponse>(
      `/v1/tickets/${ticketId}/acceptance-criteria${query}`, TicketAcceptanceCriteriaResponseSchema, {
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return response.acceptanceCriteria;
  }

  // 一个工单以外的对象（提醒、执行器、外部消息卡……）现在能做的操作，和 Lead 的 list_actions 读同一个判断（2026-10-27，genui 的按钮）。
  async listUiActions(type: string, id: string | number, options: { signal?: AbortSignal } = {}): Promise<UiActionView[]> {
    const response = await this.request<UiActionsResponse>(
      `/v1/actions/${type}/${encodeURIComponent(String(id))}`, UiActionsResponseSchema, { ...(options.signal ? { signal: options.signal } : {}) },
    );
    return response.actions;
  }

  // 执行一个工单以外的操作：和 Lead 的 perform_action 是同一个函数的两个入口。不能做时服务端回 409，原因和清单里的 reason 一样。
  // 不带 actor：这个入口只以你的身份执行。
  async performUiAction(
    type: string, id: string | number, action: string, request: UiActionRunRequest = {}, options: { signal?: AbortSignal } = {},
  ): Promise<UiActionRunResponse> {
    return this.request<UiActionRunResponse>(`/v1/actions/${type}/${encodeURIComponent(String(id))}/${action}`, UiActionRunResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  // 这张工单现在能做的操作（工单 03 的操作层，spec 5.11）：每个操作能不能做、为什么。页面按这份清单决定按钮能不能点，
  // 和 Lead 的 list_ticket_actions 读同一个判断，前端不另写一套。
  async listTicketActions(ticketId: number, options: { signal?: AbortSignal } = {}): Promise<TicketAction[]> {
    const response = await this.request<TicketActionsResponse>(`/v1/tickets/${ticketId}/actions`, TicketActionsResponseSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.actions;
  }

  // 执行一个工单操作：和 Lead 的 ticket_action 是同一个函数的两个入口。不能做时服务端回 409，原因和清单里的 reason 一样。
  // 不带 actor：这个入口只以你的身份执行，账本里写你本人。
  async runTicketAction(
    ticketId: number,
    action: TicketOperationId,
    request: TicketActionRunRequest & { signal?: AbortSignal } = {},
  ): Promise<TicketActionRunResponse> {
    const { signal, ...body } = request;
    return this.request<TicketActionRunResponse>(`/v1/tickets/${ticketId}/actions/${action}`, TicketActionRunResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  // 执行 agent 维护的执行计划（工单 06）。执行 agent 还没提交计划时是 null。
  async getTicketExecutionPlan(ticketId: number, options: { signal?: AbortSignal } = {}): Promise<TicketExecutionPlan | null> {
    const response = await this.request<TicketExecutionPlanResponse>(`/v1/tickets/${ticketId}/plan`, TicketExecutionPlanResponseSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.plan;
  }

  // 一次交付的核查（工单 10）：每一次核查员看到了什么（核查包和摘要）、逐条结论。delivery 是第几次交付，不给时是最新一次。
  async getTicketReviews(
    ticketId: number,
    options: { delivery?: number; signal?: AbortSignal } = {},
  ): Promise<TicketReviews> {
    const query = options.delivery === undefined ? '' : `?${new URLSearchParams({ delivery: String(options.delivery) }).toString()}`;
    const response = await this.request<TicketReviewsResponse>(
      `/v1/tickets/${ticketId}/reviews${query}`, TicketReviewsResponseSchema, {
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return response.reviews;
  }

  // 验收并合并（工单在 review 时先验收）、推到 GitHub 开草稿 PR、放弃改动。
  // expected：用户看到的交付（workspace.head、workspace.target）。交付在那以后变了，服务端返回 409（details.reason 是 stale）。
  async performDeliveryAction(
    ticketId: number,
    action: DeliveryActionId,
    options: { signal?: AbortSignal; expected?: { head: string | null; target: string | null } } = {},
  ): Promise<DeliveryActionResult> {
    const body: DeliveryActionRequest = options.expected
      ? { expectedHead: options.expected.head, expectedTarget: options.expected.target }
      : {};
    return this.request<DeliveryActionResult>(`/v1/tickets/${ticketId}/delivery/${action}`, DeliveryActionResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async linkTicketRelation(
    sourceTicketId: number,
    input: LinkTicketRelationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TicketRelationActionResult> {
    if (!Value.Check(LinkTicketRelationRequestSchema, input)) {
      throw new ControlPlaneClientError('invalid ticket relation input', 'invalid_request');
    }
    return this.request<TicketRelationActionResult>(
      `/v1/tickets/${sourceTicketId}/relations`,
      TicketRelationMutationResultSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  async revokeTicketRelation(
    ticketId: number,
    relationId: number,
    input: RevokeTicketRelationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TicketRelationActionResult> {
    if (!Value.Check(RevokeTicketRelationRequestSchema, input)) {
      throw new ControlPlaneClientError('invalid ticket relation revoke input', 'invalid_request');
    }
    return this.request<TicketRelationActionResult>(
      `/v1/tickets/${ticketId}/relations/${relationId}/revoke`,
      TicketRelationMutationResultSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  async performAttemptAction(
    attemptId: number,
    action: 'pause' | 'resume' | 'stop',
    options: { reason?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.requestRaw(`/v1/runs/${attemptId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async resolveApproval(approvalId: number, decision: 'approve' | 'reject' | 'approve_session') {
    return this.requestRaw(`/v1/approvals/${approvalId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
  }

  // 收件箱：等你的工单为什么在等、从什么时候开始；Lead 自己处理掉的事；你上次看的时间。
  async getInbox(signal?: AbortSignal): Promise<InboxView> {
    return this.request<InboxView>('/v1/inbox', InboxViewSchema, { ...(signal ? { signal } : {}) });
  }

  async markInboxSeen(signal?: AbortSignal): Promise<string> {
    const payload = await this.request<{ seenAt: string }>('/v1/inbox/seen', InboxSeenResultSchema, {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
    return payload.seenAt;
  }

  async ackNotification(notificationId: number, signal?: AbortSignal): Promise<NotificationDto> {
    const payload = await this.request<{ notification: NotificationDto }>(
      `/v1/notifications/${notificationId}/ack`,
      AckNotificationResultSchema,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
      },
    );
    return payload.notification;
  }

  // ——— 主人操作的「不是我」（工单 15）———
  // 读一次主人操作现在的样子（推送过没有、点过「不是我」没有、结果是什么）。
  async getOwnerAction(eventId: string, signal?: AbortSignal): Promise<OwnerActionDto> {
    const payload = await this.request<OwnerActionResponse>(
      `/v1/owner-actions/${encodeURIComponent(eventId)}`,
      OwnerActionResponseSchema,
      signal ? { signal } : {},
    );
    return payload.ownerAction;
  }

  // 「不是我」：撤销这次操作，并作废发出它的凭证。只有扫码配对的手机和网页会话能点。
  async disownOwnerAction(eventId: string, signal?: AbortSignal): Promise<OwnerActionDto> {
    const payload = await this.request<OwnerActionResponse>(
      `/v1/owner-actions/${encodeURIComponent(eventId)}/disown`,
      OwnerActionResponseSchema,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}) },
    );
    return payload.ownerAction;
  }

  async setLeadDelegation(
    ticketId: number,
    granted: boolean,
    options: LeadDelegationOptions = {},
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      ticket_id: ticketId,
      granted,
    };
    if (options.maxReworkCycles !== undefined) body.max_rework_cycles = options.maxReworkCycles;
    if (options.budgetLimitTokens !== undefined) body.budget_limit_tokens = options.budgetLimitTokens;
    if (options.budgetLimitUsd !== undefined) body.budget_limit_usd = options.budgetLimitUsd;
    if (options.effectiveUntil !== undefined) body.effective_until = options.effectiveUntil;
    if (options.scope !== undefined) body.scope = options.scope;
    if (options.requireContinuation !== undefined) body.require_continuation = options.requireContinuation;
    if (options.requiredCapabilityId !== undefined) body.required_capability_id = options.requiredCapabilityId;
    if (options.reason !== undefined) body.reason = options.reason;
    if (options.startRework !== undefined) body.start_rework = options.startRework;
    if (options.acceptWithoutReview !== undefined) body.accept_without_review = options.acceptWithoutReview;
    return this.requestRaw('/v1/lead/delegation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async getLeadTrust(signal?: AbortSignal): Promise<LeadTrustStatus> {
    return this.request('/v1/lead/trust?capability=confirm_item', LeadTrustStatusSchema, { signal });
  }

  async setLeadTrust(granted: boolean, options: { note?: string; signal?: AbortSignal } = {}): Promise<LeadTrustUpdate> {
    return this.request('/v1/lead/trust', LeadTrustUpdateSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'confirm_item', granted,
        ...(options.note === undefined ? {} : { note: options.note }),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async getLeadDelegation(ticketId: number, signal?: AbortSignal): Promise<LeadDelegationStatus> {
    return this.request(`/v1/lead/delegation?ticket_id=${ticketId}`, LeadDelegationStatusSchema, { signal });
  }

  // 用户的手动重检：不等退避，马上探针。不写 runtime 就重检所有没关闭的故障。
  async recheckRuntimes(runtime?: KernelRuntimeId, signal?: AbortSignal): Promise<RuntimeRecheckResponse['results']> {
    const payload = await this.request<RuntimeRecheckResponse>('/v1/runtimes/recheck', RuntimeRecheckResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(runtime === undefined ? {} : { runtime }),
      ...(signal ? { signal } : {}),
    });
    return payload.results;
  }

  // ——— 管理路由（admin scope）———
  async createPairing(input: CreatePairingRequest, signal?: AbortSignal): Promise<CreatePairingResponse> {
    return this.request('/v1/admin/pairings', CreatePairingResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  }

  async listBindings(signal?: AbortSignal): Promise<AdminBinding[]> {
    const payload = await this.request<{ items: AdminBinding[] }>('/v1/admin/bindings', AdminBindingListResponseSchema, { signal });
    return payload.items;
  }

  async revokeBinding(bindingId: number, signal?: AbortSignal): Promise<AdminBinding> {
    const payload = await this.request<{ binding: AdminBinding }>(
      `/v1/admin/bindings/${bindingId}/revoke`,
      RevokeBindingResponseSchema,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}) },
    );
    return payload.binding;
  }

  // ——— 本机网页给手机发扫码配对邀请（只开在回环上，不要 admin）———
  // 响应里的 uri 和 qr 是凭证：调用方不写日志，也不明文显示。
  async createLoopbackInvitation(input: LoopbackInvitationRequest, signal?: AbortSignal): Promise<LoopbackInvitation> {
    return this.request('/v1/paired/loopback/invitations', LoopbackInvitationSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  }

  // 这份邀请有没有被兑换。网关要求 POST：浏览器的同源 GET 不带 Origin。
  async getLoopbackInvitationStatus(pairingId: number, signal?: AbortSignal): Promise<LoopbackInvitationStatus> {
    if (!Number.isSafeInteger(pairingId) || pairingId < 1) {
      throw new ControlPlaneClientError('pairing id must be a positive integer', 'invalid_request');
    }
    return this.request(`/v1/paired/loopback/invitations/${pairingId}/status`, LoopbackInvitationStatusSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      ...(signal ? { signal } : {}),
    });
  }

  // 作废还没兑换的邀请。已经兑换、过期或作废的不变，响应是它现在的状态。
  async cancelLoopbackInvitation(pairingId: number, signal?: AbortSignal): Promise<LoopbackInvitationStatus> {
    if (!Number.isSafeInteger(pairingId) || pairingId < 1) {
      throw new ControlPlaneClientError('pairing id must be a positive integer', 'invalid_request');
    }
    return this.request(`/v1/paired/loopback/invitations/${pairingId}/cancel`, LoopbackInvitationStatusSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      ...(signal ? { signal } : {}),
    });
  }

  // ——— 连接（第三方账号）———
  // daemon 是唯一的 OAuth 客户端：这里只拿状态和授权地址，拿不到令牌。
  async listConnections(signal?: AbortSignal): Promise<ConnectionListResponse> {
    return this.request('/v1/connections', ConnectionListResponseSchema, { signal });
  }

  // 返回浏览器授权地址、设备码，或者已经连上（复用了 gh 的登录）。token 只给 GitHub 的「粘贴令牌」用。
  async startConnection(key: string, input: { token?: string } = {}, signal?: AbortSignal): Promise<StartConnectionResponse> {
    return this.request(`/v1/connections/${encodeURIComponent(key)}/start`, StartConnectionResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
  }

  async addCustomConnection(serverUrl: string, signal?: AbortSignal): Promise<StartConnectionResponse> {
    return this.request('/v1/connections/custom', StartConnectionResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverUrl }), ...(signal ? { signal } : {}),
    });
  }

  async connectionFlow(flowId: string, signal?: AbortSignal): Promise<ConnectionFlowResponse> {
    return this.request(`/v1/connections/flows/${encodeURIComponent(flowId)}`, ConnectionFlowResponseSchema, { signal });
  }

  async updateConnectionSettings(key: string, settings: ConnectionSettingsRequest, signal?: AbortSignal): Promise<ConnectionDto> {
    const payload = await this.request<{ connection: ConnectionDto }>(`/v1/connections/${encodeURIComponent(key)}/settings`, ConnectionResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings), ...(signal ? { signal } : {}),
    });
    return payload.connection;
  }

  async testConnection(key: string, signal?: AbortSignal): Promise<ConnectionTestResponse> {
    return this.request(`/v1/connections/${encodeURIComponent(key)}/test`, ConnectionTestResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
  }

  async disconnectConnection(key: string, signal?: AbortSignal): Promise<ConnectionDto> {
    const payload = await this.request<{ connection: ConnectionDto }>(`/v1/connections/${encodeURIComponent(key)}/disconnect`, ConnectionResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
    return payload.connection;
  }

  async connectionConfirmation(id: string, signal?: AbortSignal): Promise<ConnectionConfirmationDto> {
    const payload = await this.request<{ confirmation: ConnectionConfirmationDto }>(
      `/v1/connections/confirmations/${encodeURIComponent(id)}`, ConnectionConfirmationResponseSchema, { signal },
    );
    return payload.confirmation;
  }

  // 你对一次写入的决定。允许时 daemon 执行存下的那一次调用。
  async resolveConnectionConfirmation(id: string, approve: boolean, signal?: AbortSignal): Promise<ConnectionConfirmationDto> {
    const payload = await this.request<{ confirmation: ConnectionConfirmationDto }>(
      `/v1/connections/confirmations/${encodeURIComponent(id)}/resolve`, ConnectionConfirmationResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }), ...(signal ? { signal } : {}),
      },
    );
    return payload.confirmation;
  }

  // —— Lead 的记忆和决策模型（设置页「Lead → 记忆 / 模型」，会话里的 MemorySwitchConfirm 卡）——
  // API key 只在请求里出现一次，响应里只有 apiKeySet。

  async getMemory(signal?: AbortSignal): Promise<MemorySettingsDto> {
    return (await this.request<{ memory: MemorySettingsDto }>('/v1/memory', MemoryResponseSchema, { signal })).memory;
  }

  async updateMemorySettings(request: MemorySettingsRequest, signal?: AbortSignal): Promise<MemorySettingsDto> {
    const payload = await this.request<{ memory: MemorySettingsDto }>('/v1/memory/settings', MemoryResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.memory;
  }

  // 用已存的远程 embedding 配置发一次请求。
  async testMemoryEmbedding(signal?: AbortSignal): Promise<MemoryTestResponse> {
    return this.request('/v1/memory/test', MemoryTestResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
  }

  async memorySwitch(id: string, signal?: AbortSignal): Promise<MemorySwitch> {
    return (await this.request<{ switch: MemorySwitch }>(`/v1/memory/switches/${encodeURIComponent(id)}`, MemorySwitchResponseSchema, { signal })).switch;
  }

  // 你对一次记忆切换的决定。只有带 approvals:respond 的设备能调用。
  async confirmMemorySwitch(id: string, approve: boolean, signal?: AbortSignal): Promise<MemorySwitchConfirmResponse> {
    return this.request(`/v1/memory/switches/${encodeURIComponent(id)}/confirm`, MemorySwitchConfirmResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }), ...(signal ? { signal } : {}),
    });
  }

  // 设置 → 模型（2026-10-29）：大脑和直觉的分工、服务商和它们的目录。改动走 performUiAction（model_settings）。
  async getModelSettings(signal?: AbortSignal): Promise<ModelSettingsDto> {
    return (await this.request<{ modelSettings: ModelSettingsDto }>('/v1/models/settings', ModelSettingsResponseSchema, { signal })).modelSettings;
  }

  // 设置 → 记忆的 Hindsight 部分：摘要模型、写入情况、记忆库的统计。改动走 performUiAction('memory_settings', 'memory', …)。
  async getMemoryHindsight(signal?: AbortSignal): Promise<MemoryHindsightDto> {
    return (await this.request<{ hindsight: MemoryHindsightDto }>('/v1/memory/hindsight', MemoryHindsightResponseSchema, { signal })).hindsight;
  }

  // 设置 → 记忆 → 常驻偏好：每一条和它最近一次改动、总字数和上限。改、删、撤销走 performUiAction('core_memory', <编号>, …)
  // 和 performUiAction('core_memory_change', <改动编号>, 'undo')。
  async getMemoryPreferences(signal?: AbortSignal): Promise<MemoryPreferencesDto> {
    return (await this.request<{ preferences: MemoryPreferencesDto }>('/v1/memory/preferences', MemoryPreferencesResponseSchema, { signal })).preferences;
  }

  // 自定义控件：视图面板里的全部控件，从上到下，各带所在的视图。建、排序、视图改名走 performUiAction('widget_board', 'widgets', …)，
  // 改、删走 performUiAction('widget', <编号>, …)。
  async getWidgets(signal?: AbortSignal): Promise<WidgetDto[]> {
    return (await this.request<{ widgets: WidgetDto[] }>('/v1/widgets', WidgetsResponseSchema, { signal })).widgets;
  }

  async getDecisionModel(signal?: AbortSignal): Promise<DecisionModelDto> {
    return (await this.request<{ decisionModel: DecisionModelDto }>('/v1/decision-model', DecisionModelResponseSchema, { signal })).decisionModel;
  }

  // apiKey 为 null 时删掉已存的 key；不带时保留。
  async updateDecisionModel(request: DecisionModelSettingsRequest, signal?: AbortSignal): Promise<DecisionModelDto> {
    const payload = await this.request<{ decisionModel: DecisionModelDto }>('/v1/decision-model/settings', DecisionModelResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.decisionModel;
  }

  // 执行器的开关（设置页「执行器」）：哪些 runtime 停用了、自动核查现在用哪个。
  async getRuntimeSettings(signal?: AbortSignal): Promise<RuntimeSettingsDto> {
    return (await this.request<{ runtimeSettings: RuntimeSettingsDto }>('/v1/runtimes/settings', RuntimeSettingsResponseSchema, { signal })).runtimeSettings;
  }

  async updateRuntimeSettings(request: RuntimeSettingsRequest, signal?: AbortSignal): Promise<RuntimeSettingsDto> {
    const payload = await this.request<{ runtimeSettings: RuntimeSettingsDto }>('/v1/runtimes/settings', RuntimeSettingsResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.runtimeSettings;
  }

  // 首次启动引导（.scratch/onboarding）：7 项关键设置配没配好。daemon 还没算过时 setup 是 null。
  async getSetup(signal?: AbortSignal): Promise<SetupStatus | null> {
    return (await this.request<SetupResponse>('/v1/setup', SetupResponseSchema, { signal })).setup;
  }

  // Lead 的名字、人格和互动风格（设置页「身份与风格」）。界面上称呼 Lead 的地方都用这里的名字。
  async getLeadProfile(signal?: AbortSignal): Promise<LeadProfileDto> {
    return (await this.request<{ leadProfile: LeadProfileDto }>('/v1/lead/profile', LeadProfileResponseSchema, { signal })).leadProfile;
  }

  async updateLeadProfile(request: LeadProfileRequest, signal?: AbortSignal): Promise<LeadProfileDto> {
    const payload = await this.request<{ leadProfile: LeadProfileDto }>('/v1/lead/profile', LeadProfileResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.leadProfile;
  }

  // Lead 的形象（设置页「身份与风格 → 形象」，契约在 protocol 的 lead-avatar.ts）。daemon 在 hello.v2 宣布了
  // LEAD_AVATAR_CAPABILITY 才有这些路由。FairyEye 的开关不在这里：只有在 Lead 的会话里发 `/fairyeye on` 能打开。
  async getLeadAvatar(signal?: AbortSignal): Promise<LeadAvatarDto> {
    return (await this.request<{ leadAvatar: LeadAvatarDto }>('/v1/lead/avatar', LeadAvatarResponseSchema, { signal })).leadAvatar;
  }

  // 一张上传的图（LeadAvatarDto 的 slots 里的 id）。id 是内容的哈希：同一个 id 永远是同一张图，可以按 id 缓存。
  async getLeadAvatarImage(id: string, signal?: AbortSignal): Promise<LeadAvatarImage> {
    return this.request<LeadAvatarImage>(`/v1/lead/avatar/images/${encodeURIComponent(id)}`, LeadAvatarImageSchema, { signal });
  }

  // 给一种状态上传一张图（PNG、GIF、WebP，最大 LEAD_AVATAR_MAX_BYTES）。daemon 按文件头核对格式。
  async uploadLeadAvatarSlot(slot: LeadAvatarSlot, request: LeadAvatarUploadRequest, signal?: AbortSignal): Promise<LeadAvatarDto> {
    const payload = await this.request<{ leadAvatar: LeadAvatarDto }>(
      `/v1/lead/avatar/slots/${encodeURIComponent(slot)}`, LeadAvatarResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
      },
    );
    return payload.leadAvatar;
  }

  // 去掉一种状态上传的图。
  async clearLeadAvatarSlot(slot: LeadAvatarSlot, signal?: AbortSignal): Promise<LeadAvatarDto> {
    const payload = await this.request<{ leadAvatar: LeadAvatarDto }>(
      `/v1/lead/avatar/slots/${encodeURIComponent(slot)}/clear`, LeadAvatarResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
      },
    );
    return payload.leadAvatar;
  }

  // 改 Slack 署名的 emoji。reset 为 true 时回到配置文件或缺省的值。
  async setLeadAvatarSlackEmoji(request: LeadAvatarSlackEmojiRequest, signal?: AbortSignal): Promise<LeadAvatarDto> {
    const payload = await this.request<{ leadAvatar: LeadAvatarDto }>('/v1/lead/avatar/slack-emoji', LeadAvatarResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.leadAvatar;
  }

  // 设置页的 Slack 预览：短代码在工作区里是什么样子，和署名的文字。
  async previewSlackEmoji(code: string, signal?: AbortSignal): Promise<SlackEmojiPreview> {
    const query = new URLSearchParams({ code });
    return this.request<SlackEmojiPreview>(`/v1/lead/avatar/slack-emoji/preview?${query.toString()}`, SlackEmojiPreviewSchema, { signal });
  }

  // 界面的外观偏好（设置页「外观」）。
  async getDesignPreferences(signal?: AbortSignal): Promise<DesignPreferencesDto> {
    return (await this.request<{ designPreferences: DesignPreferencesDto }>('/v1/design/preferences', DesignPreferencesResponseSchema, { signal })).designPreferences;
  }

  async updateDesignPreferences(request: DesignPreferencesRequest, signal?: AbortSignal): Promise<DesignPreferencesDto> {
    const payload = await this.request<{ designPreferences: DesignPreferencesDto }>('/v1/design/preferences', DesignPreferencesResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.designPreferences;
  }

  async testDecisionModel(signal?: AbortSignal): Promise<MemoryTestResponse> {
    return this.request('/v1/decision-model/test', MemoryTestResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
  }

  // —— 外部通道的凭据（设置页「消息通道」，契约在 protocol 的 channel-settings.ts）——
  // 响应里只有状态，没有密钥的值。密钥只在 test、PUT 的请求体里出现一次。test、PUT、DELETE 只接受本机网页。

  async getChannelSettings(signal?: AbortSignal): Promise<ChannelSettingsResponse> {
    return this.request('/v1/channels/settings', ChannelSettingsResponseSchema, { signal });
  }

  // 用这些密钥试一次，不保存。检查没过也是一个结果（ok 是 false）：
  // 网关回 400、details 是检查结果时，同样把检查结果交给调用方。
  async testChannelSecrets(source: string, secrets: Record<string, string>, signal?: AbortSignal): Promise<ChannelSecretsTestResult> {
    const init = channelSecretsInit('POST', secrets, signal);
    try {
      return await this.request(`${channelSourcePath(source)}/test`, ChannelSecretsTestResultSchema, init);
    } catch (error) {
      const result = channelSecretsCheckResult(error);
      if (result) return result;
      throw error;
    }
  }

  // daemon 先试，全部检查通过才保存并马上重连。没通过时抛 ChannelSecretsRejectedError，里面是每项检查的结果。
  async saveChannelSecrets(source: string, secrets: Record<string, string>, signal?: AbortSignal): Promise<ChannelSourceSettingsDto> {
    const init = channelSecretsInit('PUT', secrets, signal);
    try {
      const payload = await this.request<{ source: ChannelSourceSettingsDto }>(channelSourcePath(source), ChannelSourceSettingsResponseSchema, init);
      return payload.source;
    } catch (error) {
      const result = channelSecretsCheckResult(error);
      if (result && error instanceof ControlPlaneClientError) throw new ChannelSecretsRejectedError(error.message, result, error.body);
      throw error;
    }
  }

  // 删掉设置页存的密钥并断开。Keychain 或环境变量里的不动：返回的 DTO 里它们仍然 present，origin 说明来自哪里。
  async clearChannelSecrets(source: string, signal?: AbortSignal): Promise<ChannelSourceSettingsDto> {
    const payload = await this.request<{ source: ChannelSourceSettingsDto }>(channelSourcePath(source), ChannelSourceSettingsResponseSchema, {
      method: 'DELETE', ...(signal ? { signal } : {}),
    });
    return payload.source;
  }

  // —— 自动代你处理（设置 → 消息通道，契约在 protocol 的 channel-confidence.ts，2026-10-23）——
  // 读、测一条消息、评估过去 24 小时的消息要 tickets:view；改要 tickets:create。改、测、看影响都是操作层的 channel_policy。

  async getChannelPolicy(source: string, signal?: AbortSignal): Promise<ChannelPolicyDto> {
    const payload = await this.request<{ policy: ChannelPolicyDto }>(channelPolicyPath(source), ChannelPolicyResponseSchema, { signal });
    return payload.policy;
  }

  async updateChannelPolicy(source: string, params: ChannelPolicyParams, signal?: AbortSignal): Promise<ChannelPolicyDto> {
    const payload = await this.request<{ policy: ChannelPolicyDto }>(channelPolicyPath(source), ChannelPolicyResponseSchema, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), ...(signal ? { signal } : {}),
    });
    return payload.policy;
  }

  async testChannelPolicy(source: string, request: ChannelPolicyTestRequest, signal?: AbortSignal): Promise<ChannelPolicyTestResult> {
    const payload = await this.request<{ result: ChannelPolicyTestResult }>(`${channelPolicyPath(source)}/test`, ChannelPolicyTestResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.result;
  }

  async replayChannelPolicy(source: string, params: ChannelPolicyParams, signal?: AbortSignal): Promise<ChannelPolicyReplayResult> {
    const payload = await this.request<{ result: ChannelPolicyReplayResult }>(`${channelPolicyPath(source)}/replay`, ChannelPolicyReplayResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params }), ...(signal ? { signal } : {}),
    });
    return payload.result;
  }

  // —— 交接说明（设置 → 消息通道 → 自动代你处理，契约在 protocol 的 channel-handbook.ts，2026-10-30）——
  // 读、预演要 tickets:view；改要 tickets:create。改和预演都是操作层的 channel_handbook。

  async getChannelHandbook(signal?: AbortSignal): Promise<ChannelHandbookDto> {
    const payload = await this.request<{ handbook: ChannelHandbookDto }>('/v1/channels/handbook', ChannelHandbookResponseSchema, { signal });
    return payload.handbook;
  }

  async updateChannelHandbook(handbook: ChannelHandbook, signal?: AbortSignal): Promise<ChannelHandbookDto> {
    const payload = await this.request<{ handbook: ChannelHandbookDto }>('/v1/channels/handbook', ChannelHandbookResponseSchema, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(handbook), ...(signal ? { signal } : {}),
    });
    return payload.handbook;
  }

  async rehearseChannelHandbook(request: HandbookRehearsalRequest, signal?: AbortSignal): Promise<HandbookRehearsal> {
    const payload = await this.request<{ result: HandbookRehearsal }>('/v1/channels/handbook/rehearse', HandbookRehearsalResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.result;
  }

  // 页边批注（issue 08）：看建议（tickets:view），接受、不用（tickets:create）。接受回改完的交接说明和剩下的建议。
  async getChannelHandbookSuggestions(signal?: AbortSignal): Promise<HandbookSuggestions> {
    const payload = await this.request<{ suggestions: HandbookSuggestions }>('/v1/channels/handbook/suggestions', HandbookSuggestionsResponseSchema, { signal });
    return payload.suggestions;
  }

  async acceptChannelHandbookSuggestion(key: string, signal?: AbortSignal): Promise<{ handbook: ChannelHandbookDto; suggestions: HandbookSuggestions }> {
    return this.request<{ handbook: ChannelHandbookDto; suggestions: HandbookSuggestions }>(
      '/v1/channels/handbook/suggestions/accept', HandbookSuggestionAcceptedResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }), ...(signal ? { signal } : {}),
      },
    );
  }

  async dismissChannelHandbookSuggestion(key: string, signal?: AbortSignal): Promise<HandbookSuggestions> {
    const payload = await this.request<{ suggestions: HandbookSuggestions }>('/v1/channels/handbook/suggestions/dismiss', HandbookSuggestionsResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }), ...(signal ? { signal } : {}),
    });
    return payload.suggestions;
  }

  // 把一句随口的话整理成交接说明里的一句（要 tickets:create：调一次模型）。只读，不保存。
  async proposeChannelHandbookSituation(request: HandbookProposalRequest, signal?: AbortSignal): Promise<HandbookProposal> {
    const payload = await this.request<{ result: HandbookProposal }>('/v1/channels/handbook/propose', HandbookProposalResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.result;
  }

  // —— 代回复风格（设置 → 消息通道，契约在 protocol 的 reply-style.ts，2026-10-28）——
  // 读要 tickets:view；改和提炼要 tickets:create。改、提炼都是操作层的 reply_style。提炼只读，结果是给你看的预览。

  async getReplyStyle(signal?: AbortSignal): Promise<ReplyStyleDto> {
    return (await this.request<{ replyStyle: ReplyStyleDto }>('/v1/channels/reply-style', ReplyStyleResponseSchema, { signal })).replyStyle;
  }

  async updateReplyStyle(request: ReplyStyleUpdateRequest, signal?: AbortSignal): Promise<ReplyStyleDto> {
    const payload = await this.request<{ replyStyle: ReplyStyleDto }>('/v1/channels/reply-style', ReplyStyleResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.replyStyle;
  }

  async extractReplyStyle(request: ReplyStyleExtractRequest, signal?: AbortSignal): Promise<ReplyStyleExtractResult> {
    const payload = await this.request<{ result: ReplyStyleExtractResult }>('/v1/channels/reply-style/extract', ReplyStyleExtractResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
    });
    return payload.result;
  }

  // —— 常设指令（设置 → 常设指令，会话里的 StandingOrderChangeConfirm 卡；工单 10）——
  // 读要 tickets:view；回滚要 tickets:create；批准或拒绝 Lead 的提议要 approvals:respond。

  async getStandingOrders(signal?: AbortSignal): Promise<StandingOrderListResponse> {
    return this.request('/v1/standing-orders', StandingOrderListResponseSchema, { signal });
  }

  async getStandingOrder(id: string, signal?: AbortSignal): Promise<StandingOrderDetailResponse> {
    return this.request(`/v1/standing-orders/${encodeURIComponent(id)}`, StandingOrderDetailResponseSchema, { signal });
  }

  // 回滚到某一版：写一个新版本，作者是你，直接生效。返回这条指令的新详情。
  async rollbackStandingOrder(id: string, version: number, signal?: AbortSignal): Promise<StandingOrderDetailResponse> {
    return this.request(`/v1/standing-orders/${encodeURIComponent(id)}/rollback`, StandingOrderDetailResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }), ...(signal ? { signal } : {}),
    });
  }

  async standingOrderProposal(approvalId: number, signal?: AbortSignal): Promise<StandingOrderProposalResponse> {
    return this.request(`/v1/standing-order-proposals/${approvalId}`, StandingOrderProposalResponseSchema, { signal });
  }

  // 你对 Lead 一个提议的决定。只有带 approvals:respond 的设备能调用。
  async decideStandingOrderProposal(approvalId: number, approve: boolean, signal?: AbortSignal): Promise<StandingOrderProposalResponse> {
    return this.request(`/v1/standing-order-proposals/${approvalId}/decision`, StandingOrderProposalResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }), ...(signal ? { signal } : {}),
    });
  }

  // —— 改规则被拦下以后的确认卡（会话里的 UserAction confirm_rule_change；统一的消息事件工单 09）——
  // 读要 tickets:view；「确认这一次」「不改」要 approvals:respond，确认以后 daemon 只执行卡上存下的那一个操作。

  async ruleChangeConfirmation(id: string, signal?: AbortSignal): Promise<RuleChangeConfirmationDto> {
    const payload = await this.request<{ confirmation: RuleChangeConfirmationDto }>(
      `/v1/rule-changes/${encodeURIComponent(id)}`, RuleChangeConfirmationResponseSchema, { signal },
    );
    return payload.confirmation;
  }

  async resolveRuleChangeConfirmation(id: string, decision: RuleChangeDecision, signal?: AbortSignal): Promise<RuleChangeConfirmationDto> {
    const payload = await this.request<{ confirmation: RuleChangeConfirmationDto }>(
      `/v1/rule-changes/${encodeURIComponent(id)}/resolve`, RuleChangeConfirmationResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }), ...(signal ? { signal } : {}),
      },
    );
    return payload.confirmation;
  }

  // —— 外部的人要求设的定时器（统一的消息事件 spec D16，工单 12）——
  // 确认卡（会话里的 UserAction confirm_timer）：读要 tickets:view；「设定时器」「不设」要 approvals:respond。
  // 提醒列表里别人要求设的定时器：读要 tickets:view；取消是操作层的 timer.cancel，要 tickets:create。

  async timerRequest(id: string, signal?: AbortSignal): Promise<TimerRequestDto> {
    const payload = await this.request<{ request: TimerRequestDto }>(
      `/v1/timer-requests/${encodeURIComponent(id)}`, TimerRequestResponseSchema, { signal },
    );
    return payload.request;
  }

  async resolveTimerRequest(id: string, decision: TimerRequestDecision, signal?: AbortSignal): Promise<TimerRequestDto> {
    const payload = await this.request<{ request: TimerRequestDto }>(
      `/v1/timer-requests/${encodeURIComponent(id)}/resolve`, TimerRequestResponseSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }), ...(signal ? { signal } : {}),
      },
    );
    return payload.request;
  }

  async externalTimers(signal?: AbortSignal): Promise<ExternalTimerDto[]> {
    const payload = await this.request<{ timers: ExternalTimerDto[] }>('/v1/timers/external', ExternalTimersResponseSchema, { signal });
    return payload.timers;
  }

  async watchTimers(signal?: AbortSignal): Promise<WatchTimerDto[]> {
    const payload = await this.request<{ watches: WatchTimerDto[] }>('/v1/timers/watches', WatchTimersResponseSchema, { signal });
    return payload.watches;
  }

  async cancelTimer(ref: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/v1/timers/${encodeURIComponent(ref)}/cancel`, CancelTimerResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
  }

  async connectionTools(key: string, signal?: AbortSignal): Promise<ConnectionToolDto[]> {
    const payload = await this.request<{ items: ConnectionToolDto[] }>(`/v1/connections/${encodeURIComponent(key)}/tools`, ConnectionToolListResponseSchema, { signal });
    return payload.items;
  }

  async getAishStatus(signal?: AbortSignal): Promise<AishCredentialStatus> {
    return this.request('/v1/admin/aish', AishCredentialStatusSchema, { signal });
  }

  async forgetAish(signal?: AbortSignal): Promise<AishForgetResponse> {
    return this.request('/v1/admin/aish/forget', AishForgetResponseSchema, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}),
    });
  }

  async connect(handlers: ConnectionHandlers = {}): Promise<void> {
    this.handlers = handlers;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    await this.openSocket(false);
  }

  disconnect(): void {
    this.connectionGeneration += 1;
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, 'client disconnect');
    this.rejectPending(new ControlPlaneClientError('connection closed', 'disconnected'));
    this.setState('disconnected');
  }

  sendChat(message: string, ticketId?: number): Promise<Record<string, unknown>> {
    return this.sendCommand({
      type: 'chat.send', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION,
      message,
      ...(ticketId === undefined ? {} : { context: { ticketId } }),
    });
  }

  // clientMessageId 只在 daemon 宣布了 CHAT_CLIENT_MESSAGE_ID_CAPABILITY 时放进 WebSocket 命令：
  // 旧 daemon 严格校验命令，多一个字段整条拒收。HTTP 兜底总带着它：旧 daemon 的这条路由不看多出来的字段。
  async sendChatCommand(input: SendChatCommandInput, signal?: AbortSignal): Promise<SendChatCommandResult> {
    const images = input.images?.length ? input.images : undefined;
    // 旧 daemon 不收图片：只发文字会丢掉用户的图片，所以整条拒收，用户可以删掉它重写。
    if (images && !this.capabilities.has(CHAT_IMAGES_CAPABILITY)) {
      throw new ControlPlaneClientError('the daemon does not accept images yet', 'invalid_request');
    }
    const command: WsCommand = {
      type: 'chat.send',
      id: input.id,
      protocolVersion: PROTOCOL_VERSION,
      message: input.message,
      // 工单对话一律交给工单的 agent（2026-10-19）：不带 context.answerer。
      ...(input.ticketId === undefined ? {} : { context: { ticketId: input.ticketId } }),
      ...(input.clientMessageId !== undefined && this.capabilities.has(CHAT_CLIENT_MESSAGE_ID_CAPABILITY)
        ? { clientMessageId: input.clientMessageId }
        : {}),
      ...(input.mode !== undefined && this.capabilities.has(CHAT_PLACEMENT_CAPABILITY) ? { mode: input.mode } : {}),
      ...(images ? { images } : {}),
    };
    const result = await this.sendChatCommandWithFallback(command, input.clientMessageId, signal);
    if (typeof result.turnId !== 'string' || !result.turnId) {
      throw new ControlPlaneClientError('chat result is missing turnId', 'invalid_response');
    }
    return { turnId: result.turnId, ...(result.duplicate === true ? { duplicate: true as const } : {}) };
  }

  private async sendChatCommandWithFallback(
    command: WsCommand,
    clientMessageId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.sendCommand(command, signal, Math.min(this.commandTimeoutMs, 8_000));
    } catch (error) {
      if (!isChatFallbackError(error)) throw error;
      if (this.socket && this.socket.readyState === 1) this.abandonSocket('chat command fallback');
      return this.postChatCommand(command, clientMessageId, signal);
    }
  }

  // 兜底的 HTTP 请求有期限（CHAT_HTTP_TIMEOUT_MS）：网络半通时它可能一直挂着，发件箱就一直占着发不了下一条
  // （发布评审 f796c1c）。到期取消请求，报 timeout：发件箱按临时错误退避以后再发。
  private async postChatCommand(
    command: WsCommand,
    clientMessageId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (command.type !== 'chat.send') {
      throw new ControlPlaneClientError('HTTP fallback only supports chat.send', 'invalid_request');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = this.setTimer(() => { timedOut = true; controller.abort(); }, CHAT_HTTP_TIMEOUT_MS);
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    try {
      return await this.requestRaw('/v1/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: command.id,
          message: command.message,
          ...(command.context === undefined ? {} : { context: command.context }),
          ...(clientMessageId === undefined ? {} : { clientMessageId }),
          ...(command.mode === undefined ? {} : { mode: command.mode }),
          ...(command.images === undefined ? {} : { images: command.images }),
        }),
        signal: controller.signal,
      }) as Record<string, unknown>;
    } catch (error) {
      if (timedOut) throw new ControlPlaneClientError('chat request timed out', 'timeout');
      throw error;
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  // 马上确认连接还活着。回到前台、标签页可见、网络恢复时调：Mac 睡眠以后，半开的 WebSocket
  // 看起来还连着，可什么都发不出去（2026-10-16，用户的 3 条消息就这样没了）。
  // 连着时发一次 status.get，timeoutMs 内没有回答就当连接已经断了：马上转成重连中。
  // 正在等重连时，不再等退避，马上重连。返回连接是否活着。
  async checkConnection(timeoutMs = 3_000): Promise<boolean> {
    if (!this.shouldReconnect) return false;
    if (this.state === 'connected') {
      try {
        await this.sendCommand({ type: 'status.get', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION }, undefined, timeoutMs);
        return true;
      } catch {
        this.abandonSocket('connection check timed out');
        return false;
      }
    }
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      void this.openSocket(true);
    }
    return false;
  }

  // 设备离线了（浏览器的 offline 事件）：不等心跳，马上当连接已经断了。
  connectionLost(reason = 'offline'): void {
    if (this.state === 'connected') this.abandonSocket(reason);
  }

  // 告诉网关现在有没有人在看（companion：页面或应用在前台；plc chat：运行中）。
  // daemon 只把有人在看的连接算作"有人在听"。连着时马上发，每次（重新）连上之后再发一次。
  setPresence(attended: boolean): void {
    this.presence = attended;
    if (this.state === 'connected') this.sendPresence();
  }

  private sendPresence(): void {
    if (this.presence === null) return;
    void this.sendCommand({
      type: 'presence.set', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION, attended: this.presence,
    }).catch(() => { /* 连接断了：重新连上之后会再发 */ });
  }

  getStatus(): Promise<Record<string, unknown>> {
    return this.sendCommand({ type: 'status.get', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION });
  }

  resume(afterSeq: number): Promise<Record<string, unknown>> {
    return this.sendCommand({ type: 'sync.resume', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION, afterSeq });
  }

  private async requireRecord(): Promise<ControlPlaneCredentials> {
    if (this.record) return this.record;
    this.record = await this.deps.credentials.load();
    if (!this.record) throw new ControlPlaneClientError('device is not paired', 'not_paired');
    return this.record;
  }

  private async request<T>(path: string, schema: TSchema, init?: RequestInit): Promise<T> {
    const payload = await this.requestRaw(path, init);
    if (!Value.Check(schema, payload)) {
      throw new ControlPlaneClientError('response does not match the shared protocol', 'invalid_response');
    }
    return payload as T;
  }

  private async baseUrlFor(record: ControlPlaneCredentials): Promise<string> {
    return this.deps.resolveBaseUrl ? normalizeControlPlaneEndpoint(await this.deps.resolveBaseUrl()) : record.baseUrl;
  }

  private async requestRaw(path: string, init: RequestInit = {}, baseUrlOverride?: string): Promise<unknown> {
    throwIfAborted(init.signal ?? undefined);
    const record = await this.requireRecord();
    const baseUrl = baseUrlOverride ?? await this.baseUrlFor(record);
    throwIfAborted(init.signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${record.accessToken}`);
    const response = await this.fetcher(`${baseUrl}${path}`, { ...init, headers });
    const payload = await this.readJson(response);
    if (!response.ok) throw this.responseError(response.status, payload);
    return payload;
  }

  private async issueWsTicket(baseUrl: string): Promise<WsTicketResponse> {
    const payload = await this.requestRaw('/v1/paired/ws-ticket', { method: 'POST' }, baseUrl);
    if (!Value.Check(WsTicketResponseSchema, payload)) {
      throw new ControlPlaneClientError('invalid WebSocket ticket response', 'invalid_response');
    }
    return payload as WsTicketResponse;
  }

  private async openSocket(reconnecting: boolean): Promise<void> {
    this.stopHeartbeat();
    this.setState(reconnecting ? 'reconnecting' : 'connecting');
    try {
      const record = await this.requireRecord();
      const baseUrl = await this.baseUrlFor(record);
      const ticket = await this.issueWsTicket(baseUrl);
      if (!this.shouldReconnect) return;
      const generation = ++this.connectionGeneration;
      const url = new URL(baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/paired/events`;
      url.search = new URLSearchParams({
        ticket: ticket.ws_ticket,
        protocol: String(PROTOCOL_VERSION),
        after_seq: String(record.lastSeq),
        // 选收 Lead 健康（带 lead 的 daemon.status.changed）、Lead 生成的富交互卡片（带 surface 的
        // lead.tool.updated，protocol 的 ui-surfaces.ts）、「Lead 动态」的推送（工单 06）和工单回复的动作按钮
        // 有了判断结果（2026-10-19，ticket-chat.ts）、Lead 忙时排着的外部消息（工单 10，lead-queue.ts）。旧 daemon 忽略这个参数。
        include: `lead_health,ui_surfaces,${LEAD_ACTIVITY_OPT_IN},${TICKET_REPLY_ACTIONS_OPT_IN},${LEAD_QUEUE_OPT_IN}`,
      }).toString();
      const socket = this.createSocket(url.toString());
      this.socket = socket;
      socket.onopen = () => { /* hello.v2 is the readiness boundary */ };
      socket.onmessage = (event) => this.handleMessage(event.data, generation);
      socket.onerror = () => { /* close drives retry; errors carry no portable detail */ };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.stopHeartbeat();
        if (event?.code === CLOSE_BINDING_REVOKED) {
          this.credentialRejected(new ControlPlaneClientError(event.reason || 'binding revoked', 'binding_revoked', 401));
          return;
        }
        this.rejectPending(new ControlPlaneClientError('connection interrupted', 'disconnected'));
        if (this.shouldReconnect) this.scheduleReconnect();
        else this.setState('disconnected');
      };
    } catch (error) {
      // 只认网关自己的拒绝（错误体里的 code 是 unauthorized）。存着的地址上可能是别的设备在回答，
      // 它的 401 不说明凭证无效，照常重连。
      if (error instanceof ControlPlaneClientError && error.status === 401 && error.code === 'unauthorized') {
        this.credentialRejected(error);
        return;
      }
      this.handlers.onProtocolError?.(error instanceof Error ? error : new Error(String(error)));
      if (this.shouldReconnect) this.scheduleReconnect();
      else this.setState('disconnected');
    }
  }

  // 不等这个 socket 报告关闭就放下它，马上转成重连中。半开的 socket 关不掉：浏览器要等关闭握手，
  // 可能很久都不调 onclose。它之后再报告关闭或者送来消息，都对不上 this.socket 和连接代数，一律忽略。
  private abandonSocket(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.connectionGeneration += 1;
    this.stopHeartbeat();
    try { socket.close(4000, reason); } catch { /* 已经关了 */ }
    this.rejectPending(new ControlPlaneClientError('connection lost', 'disconnected'));
    this.reconnectAttempt = 0;
    if (this.shouldReconnect) this.scheduleReconnect();
    else this.setState('disconnected');
  }

  private credentialRejected(error: ControlPlaneClientError): void {
    const wasReconnecting = this.shouldReconnect;
    this.shouldReconnect = false;
    this.rejectPending(error);
    this.setState('disconnected');
    if (!wasReconnecting) return;
    if (this.handlers.onCredentialRejected) this.handlers.onCredentialRejected(error);
    else this.handlers.onProtocolError?.(error);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.setState('reconnecting');
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.openSocket(true);
    }, delay);
  }

  private handleMessage(raw: unknown, generation: number): void {
    if (generation !== this.connectionGeneration) return;
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.handlers.onProtocolError?.(new ControlPlaneClientError('invalid WebSocket JSON', 'invalid_response'));
      return;
    }
    if (Value.Check(HelloV2Schema, message)) {
      this.reconnectAttempt = 0;
      this.capabilities = new Set((message as HelloV2).capabilities);
      this.setState('connected');
      this.startHeartbeat();
      this.sendPresence();
      this.handlers.onHello?.(message as HelloV2);
      return;
    }
    if (Value.Check(CommandResultSchema, message)) {
      this.settleCommand(message as CommandResult);
      return;
    }
    if (Value.Check(GatewayEventSchema, message)) {
      this.eventQueue = this.eventQueue
        .then(() => this.acceptEvent(message as GatewayEvent, generation))
        .catch((reason) => this.handleCursorPersistenceFailure(reason, generation));
      return;
    }
    this.handlers.onProtocolError?.(new ControlPlaneClientError('unknown WebSocket message', 'invalid_response'));
  }

  private async acceptEvent(event: GatewayEvent, generation: number): Promise<void> {
    if (generation !== this.connectionGeneration) return;
    const record = await this.requireRecord();
    if (event.seq <= record.lastSeq) return;
    const credentialGeneration = this.credentialGeneration;
    const snapshot = {
      ...record,
      lastSeq: event.seq,
      binding: { ...record.binding, scopes: [...record.binding.scopes] },
    };
    await this.saveCredentials(snapshot, credentialGeneration);
    if (
      generation !== this.connectionGeneration ||
      credentialGeneration !== this.credentialGeneration
    ) return;
    this.record = snapshot;
    this.handlers.onEvent?.(event);
  }

  private sendCommand(
    command: WsCommand,
    signal?: AbortSignal,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    if (!this.socket || this.socket.readyState !== 1 || this.state !== 'connected') {
      return Promise.reject(new ControlPlaneClientError('WebSocket is not connected', 'disconnected'));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(command.id);
        if (!pending) return;
        this.pending.delete(command.id);
        this.clearTimer(pending.timeout);
        reject(abortError());
      };
      const timeout = this.setTimer(() => {
        this.pending.delete(command.id);
        signal?.removeEventListener('abort', abort);
        reject(new ControlPlaneClientError('command timed out', 'timeout'));
      }, timeoutMs);
      this.pending.set(command.id, { resolve, reject, timeout, signal, abort });
      signal?.addEventListener('abort', abort, { once: true });
      this.socket!.send(JSON.stringify(command));
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.scheduleHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private scheduleHeartbeat(): void {
    if (!this.shouldReconnect || this.state !== 'connected') return;
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      void this.runHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.shouldReconnect || this.state !== 'connected' || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.sendCommand({
        type: 'status.get', id: this.idFactory(), protocolVersion: PROTOCOL_VERSION,
      }, undefined, this.heartbeatTimeoutMs);
    } catch {
      if (this.state === 'connected') this.abandonSocket('heartbeat timeout');
      return;
    } finally {
      this.heartbeatInFlight = false;
      this.scheduleHeartbeat();
    }
  }

  private settleCommand(result: CommandResult): void {
    const pending = this.pending.get(result.id);
    if (!pending) return;
    this.pending.delete(result.id);
    this.clearTimer(pending.timeout);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    if (result.success) pending.resolve(result.data ?? {});
    else pending.reject(new ControlPlaneClientError(
      result.error?.message ?? 'command failed',
      result.error?.code ?? 'internal_error',
    ));
  }

  private rejectPending(error: Error): void {
    for (const command of this.pending.values()) {
      this.clearTimer(command.timeout);
      if (command.abort) command.signal?.removeEventListener('abort', command.abort);
      command.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { throw new ControlPlaneClientError('invalid JSON response', 'invalid_response', response.status); }
  }

  private responseError(status: number, payload: unknown): ControlPlaneClientError {
    if (Value.Check(HttpErrorResponseSchema, payload)) {
      return new ControlPlaneClientError(payload.error.message, payload.error.code, status, payload);
    }
    return new ControlPlaneClientError(`HTTP ${status}`, 'http_error', status, payload);
  }

  private saveCredentials(record: ControlPlaneCredentials, generation: number): Promise<void> {
    const write = this.credentialWrite.then(async () => {
      if (generation !== this.credentialGeneration) throw abortError();
      await this.deps.credentials.save(record);
    });
    this.credentialWrite = write.catch(() => {});
    return write;
  }

  private handleCursorPersistenceFailure(reason: unknown, generation: number): void {
    if (generation !== this.connectionGeneration) return;
    this.connectionGeneration += 1;
    this.handlers.onProtocolError?.(new ControlPlaneClientError(
      'failed to persist replay cursor',
      'cursor_persistence_failed',
    ));
    const socket = this.socket;
    if (socket) socket.close(1011, reason instanceof Error ? reason.message : 'cursor persistence failed');
  }
}

function cursorQuery(options: KernelCursorOptions): string {
  const params = new URLSearchParams();
  appendCursor(params, options);
  return params.size === 0 ? '' : `?${params}`;
}

function appendCursor(params: URLSearchParams, options: KernelCursorOptions): void {
  if (options.afterId !== undefined && options.beforeId !== undefined) {
    throw new ControlPlaneClientError('afterId and beforeId are mutually exclusive', 'invalid_request');
  }
  if (options.afterId !== undefined) params.set('after_id', String(options.afterId));
  if (options.beforeId !== undefined) params.set('before_id', String(options.beforeId));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
}

function abortError(): Error {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

// 来源的编号进了路径：只收字母、数字、点、下划线和连字符，开头不能是点（挡住 . 和 ..，URL 会把它们当成上一级）。
const CHANNEL_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

function channelSourcePath(source: string): string {
  if (!CHANNEL_SOURCE_PATTERN.test(source)) throw new ControlPlaneClientError('channel source is invalid', 'invalid_request');
  return `/v1/channels/settings/${encodeURIComponent(source)}`;
}

function channelPolicyPath(source: string): string {
  if (!CHANNEL_SOURCE_PATTERN.test(source)) throw new ControlPlaneClientError('channel source is invalid', 'invalid_request');
  return `/v1/channels/policy/${encodeURIComponent(source)}`;
}

// test、PUT 的请求。请求体先按契约校验，不合格的不发出去。
// TypeBox 的 Record 不检查键的长度，所以键另外查：1 到 100 个字符；一个来源最多声明 8 个密钥。
function channelSecretsInit(method: 'POST' | 'PUT', secrets: Record<string, string>, signal?: AbortSignal): RequestInit {
  const body = { secrets };
  const names = Object.keys(secrets);
  const namesOk = names.length >= 1 && names.length <= 8 && names.every((name) => name.length >= 1 && name.length <= 100);
  if (!namesOk || !Value.Check(ChannelSecretsRequestSchema, body)) throw new ControlPlaneClientError('channel secrets are invalid', 'invalid_request');
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) };
}

// 网关 400 的 details 是检查结果时取出来。别的错误（请求体不对、来源不存在、不是本机网页）返回 null。
function channelSecretsCheckResult(error: unknown): ChannelSecretsTestResult | null {
  if (!(error instanceof ControlPlaneClientError) || error.status !== 400) return null;
  if (!Value.Check(HttpErrorResponseSchema, error.body)) return null;
  const details = error.body.error.details;
  return Value.Check(ChannelSecretsTestResultSchema, details) ? details as ChannelSecretsTestResult : null;
}

function isChatFallbackError(error: unknown): boolean {
  return error instanceof ControlPlaneClientError &&
    (error.code === 'disconnected' || error.code === 'timeout');
}

function positiveHeaderInteger(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new ControlPlaneClientError('artifact response integer header is invalid', 'integrity_error');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ControlPlaneClientError('artifact response integer header is invalid', 'integrity_error');
  }
  return parsed;
}

function nonNegativeHeaderInteger(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new ControlPlaneClientError('artifact content length is invalid', 'integrity_error');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneClientError('artifact content length is invalid', 'integrity_error');
  }
  return parsed;
}

function normalizedMediaType(value: string | null): string {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(mediaType)) {
    throw new ControlPlaneClientError('artifact content type is invalid', 'integrity_error');
  }
  return mediaType;
}

function attachmentFilename(value: string | null): string {
  const match = /(?:^|;)\s*filename\*=UTF-8''([^;]+)(?:;|$)/i.exec(value ?? '');
  if (!match) {
    throw new ControlPlaneClientError('artifact filename is missing', 'integrity_error');
  }
  try {
    const decoded = decodeURIComponent(match[1]);
    if (!decoded || decoded.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new ControlPlaneClientError('artifact filename is invalid', 'integrity_error');
  }
}

async function webCryptoRandomBytes(length: number): Promise<Uint8Array> {
  if (!globalThis.crypto?.getRandomValues) {
    throw new ControlPlaneClientError('this platform has no WebCrypto: pass randomBytes to ControlPlaneClient', 'unsupported_platform');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function webCryptoSha256(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!globalThis.crypto?.subtle) {
    throw new ControlPlaneClientError('this platform has no WebCrypto: pass sha256 to ControlPlaneClient', 'unsupported_platform');
  }
  return globalThis.crypto.subtle.digest('SHA-256', bytes);
}
