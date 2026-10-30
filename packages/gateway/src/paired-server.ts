// Paired control-plane: authenticated HTTP snapshots + WebSocket channel transport.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { clearInterval as clearNodeInterval, setInterval as setNodeInterval } from "node:timers";
import { Value } from "typebox/value";
import {
  ADMIN_SCOPE,
  ADMIN_TOKEN_TTL_MS,
  CreatePairingRequestSchema,
  CreateTicketRequestSchema,
  KernelCheckpointListQuerySchema,
  KernelConversationCardListQuerySchema,
  KERNEL_FIDELITY_CAPABILITIES,
  KernelInterventionIdSchema,
  KernelInterventionListQuerySchema,
  KernelTicketWorkItemListQuerySchema,
  LinkTicketRelationRequestSchema,
  LoopbackInvitationRequestSchema,
  MilestoneCreateRequestSchema,
  MilestonePatchRequestSchema,
  PairConfirmSchema,
  PairHelloSchema,
  PROTOCOL_VERSION,
  CHAT_CLIENT_MESSAGE_ID_CAPABILITY,
  CHAT_PLACEMENT_CAPABILITY,
  CHAT_FOLLOW_UP_ACTIONS_CAPABILITY,
  FollowUpActionRequestSchema,
  CHAT_IMAGE_ID_PATTERN,
  CHAT_IMAGES_CAPABILITY,
  CHAT_IMAGES_INCLUDE,
  LEAD_AVATAR_CAPABILITY,
  CHAT_SEND_MAX_BYTES,
  ChatPlacementSchema,
  LeadModelChoiceSchema, LeadQueueActionRequestSchema,
  TicketChatAnswererSchema,
  TICKET_REPLY_ACTIONS_INCLUDE,
  type ChatPlacement,
  type ChatSendMode,
  ClientMessageIdSchema,
  RevokeTicketRelationRequestSchema,
  ResolveKernelInterventionRequestSchema,
  RuntimeRecheckRequestSchema,
  TICKET_LIST_VIEWS,
  TicketStatusSchema,
  gatewayEventOptIn,
  LEAD_ACTIVITY_INCLUDE,
  LEAD_ACTIVITY_REMINDERS_INCLUDE, LEAD_ACTIVITY_SETUP_INCLUDE, type SetupResponse,
  ReminderRescheduleRequestSchema,
  WsCommandSchema,
  bytesToHex,
  derivePairingSessionKey,
  hexToBytes,
  openPairingPayload,
  sealPairingPayload,
  type AdminBinding,
  type AishCredentialStatus,
  type GatewayEvent,
  type LeadInterrupt,
  type CreatePairingRequest,
  type CreateTicketRequest,
  type KernelCheckpointListQuery,
  type KernelConversationCardListQuery,
  type KernelInterventionListQuery,
  type KernelRuntimeId,
  type KernelTicketWorkItemListQuery,
  type LinkTicketRelationRequest,
  type LoopbackInvitation,
  type LoopbackInvitationRequest,
  type LoopbackInvitationStatus,
  type MilestoneDto,
  type NotificationDto,
  type RevokeTicketRelationRequest,
  type ResolveKernelInterventionRequest,
  type RuntimeRecheckResponse,
  type TicketListView,
  type Scope,
  type TicketStatus,
  USER_ITEM_ACTION_IDS,
  isOwnerActionEventId,
  type OwnerActionResponse,
  type OwnerActionSource,
  type UserItemActionId,
  type TicketActionId,
  type WsCommand,
  KERNEL_RUNTIME_IDS,
  TicketReviewRequestSchema,
  type TicketReviewRequest,
  UiActionRunRequestSchema,
  type UiActionRunRequest,
  bindingOriginOf,
  originMayDecide,
  type ChannelCardDto,
  type RuleChangeConfirmationDto,
  type RuntimeSettingsDto,
} from "@pi-lead-child/protocol";
import {
  BY_USER, createCoordinator, DelegationBlockedError, DeliveryError, grantItemDelegation, ReviewerChangeError,
  listUiActions, memoryPreferences, TicketActionError, uiActionDefinition, type DelegateInput, type DelegationGrant, type TicketActionOutcome,
  type UiActionOutcome, type UiActionServices, type UiActionTarget, type WorkspaceActionResult,
} from "@pi-lead-child/engine";
import type { UserActionService } from "./user-actions.js";
import { isApiPath, serveWebFile } from "./web-static.js";
import { handleConnectionRoute, handleOAuthCallback, OAUTH_CALLBACK_PATH, type ConnectionsService } from "./connections-routes.js";
import { handleMemoryRoute, type DecisionModelService, type MemoryService } from "./memory-routes.js";
import { handleRuntimeSettingsRoute, type RuntimeSettingsService } from "./runtime-settings-routes.js";
import { handleLeadProfileRoute } from "./lead-profile-routes.js";
import { handleLeadAvatarRoute, type LeadAvatarService } from "./lead-avatar-routes.js";
import { handleDesignPreferencesRoute } from "./design-preferences-routes.js";
import { handleDeliveryRoute } from "./delivery-routes.js";
import { handleDeliverySnapshotRoute } from "./delivery-snapshot-routes.js";
import { handleExecutionPlanRoute } from "./execution-plan-routes.js";
import { handleAcceptanceCriteriaRoute } from "./acceptance-criteria-routes.js";
import { handleReviewRoute } from "./review-routes.js";
import { handleTicketActionRoute, performUserTicketAction, type UserTicketActionContext } from "./ticket-action-routes.js";
import { performUserUiAction, type UserUiActionContext } from "./ui-action-routes.js";
import type { PullRequestRunner } from "@pi-lead-child/engine";
import { handleChannelSettingsRoute, type ChannelSettingsService } from "./channel-settings-routes.js";
import { handleStandingOrderRoute } from "./standing-order-routes.js";
import { CHANNEL_ACTION_ERRORS, handleChannelRoute, type ChannelCardService } from "./channel-routes.js";
import { handleChannelPolicyRoute } from "./channel-policy-routes.js";
import { handleHandbookRoute } from "./handbook-routes.js";
import { handleReplyStyleRoute } from "./reply-style-routes.js";
import { handleRuleChangeRoute } from "./rule-change-routes.js";
import { handleTimerRoute } from "./timer-routes.js";
import type { LeadCapability, LeadGrant, LeadGrantChannel } from "@pi-lead-child/store";
import { findClientMessageTurn, getChatImage, getItem, listWidgets, loadSetupStatus, recordClientMessageTurn, type ChatImageData } from "@pi-lead-child/store";
import { decodeChatImages } from "./chat-images.js";
import { setProjectStatus } from "@pi-lead-child/store";
import { createMilestone, type ItemMilestone } from "@pi-lead-child/store";
import { MILESTONE_KIND_LABELS } from "@pi-lead-child/protocol";
import { getRun, isTerminalRunState } from "@pi-lead-child/store";
import { InterruptAckError } from "@pi-lead-child/store";
import { InterventionConflictError } from "@pi-lead-child/engine";
import type { Db } from "@pi-lead-child/store";
import {
  latestGatewaySeq,
  listGatewayEventBatch,
  listGatewayEvents,
  itemUpdatedEvent,
  publishGatewayEvent,
} from "@pi-lead-child/store";
import { toWireAttemptState } from "@pi-lead-child/core";
import { listenOnce } from "@pi-lead-child/runtime";
import {
  authenticateToken,
  bindingScopes,
  createLoopbackBinding,
  createPairing,
  forgetAishConn,
  getAishAuthFailure,
  getAishConnStatus,
  listBindings,
  loadAishConn,
  getOrCreateGatewayIdentity,
  getBinding,
  cancelPendingPairing,
  getPairingStatus,
  getPendingPairingById,
  redeemPairing,
  redeemPairingById,
  type Binding,
} from "@pi-lead-child/store";
import type { createControlPlaneService } from "./control-plane.js";
import { createGatewayPairingInvitation, encodeQrMatrix } from "./pairing-invitation.js";
import { isThisMachineAddress, lanPairingEndpoints, type ListeningAddress, type NetworkInterfaceReader } from "./lan-endpoints.js";
import {
  delegationOwnerAction, disownOwnerAction,
  leadTrustOwnerAction, OwnerActionError, type OwnerActionDeps, type OwnerActionInput,
} from "./owner-actions.js";
import {
  isTicketRelationInputType,
} from "@pi-lead-child/store";
import {
  activeDelegationPolicy,
  listDelegationPolicies,
  revokeDelegationPolicy,
} from "@pi-lead-child/store";
import {
  ackNotification,
  getNotification,
  listNotifications,
  markInboxSeen,
  type NotificationRow,
  type NotificationState,
} from "@pi-lead-child/store";
import {
  activeLeadGrant, getStandingOrder, leadDisplayName, ownerActionView, recordOwnerAction,
} from "@pi-lead-child/store";

type ControlPlaneService = ReturnType<typeof createControlPlaneService>;

export interface LeadTrustService {
  grant(capability: LeadCapability, via: LeadGrantChannel, note?: string): LeadGrant;
  revoke(capability: LeadCapability, via: LeadGrantChannel): number;
  status(capability: LeadCapability): LeadGrant | null;
}

export interface PairedBridge {
  db: Db;
  controlPlane?: ControlPlaneService;
  // 用户控制面：确认 / 开跑 / 停下 / 验收 / 返工 / 取消 / 恢复，以及 Run 的暂停恢复。
  // 这些边在 §6.4 里只属于 user，lead 一条都没有（见 gateway/user-actions.ts 的文件头）。
  userActions?: UserActionService;
  // 用户对 lead 的授权（store/lead-grants.ts）。同样只属于 user：lead 的工具表里没有
  // 任何一条能走到这个平面，所以授权不可自授，也不可自续。
  leadTrust?: LeadTrustService;
  // 第三方账号的连接（packages/connections 的 ConnectionHub）。缺席时 /v1/connections 回 503。
  connections?: ConnectionsService;
  // 外部来源的会话卡（daemon 的通道 hub，工单 11）。缺席时没有卡，动作回 503。
  channels?: ChannelCardService;
  // Lead 的记忆和决策模型（daemon 的 MemoryController）。缺席时 /v1/memory 和 /v1/decision-model 回 503。
  memory?: MemoryService;
  decisionModel?: DecisionModelService;
  // 执行器的开关（设置页「执行器」，daemon 的 runtime-settings.ts）。缺席时 /v1/runtimes/settings 回 503。
  runtimeSettings?: RuntimeSettingsService;
  // 操作层（engine 的 ui-actions/）用的服务。daemon 只建一个对象，Lead 的工具用的是同一个。缺席时用到服务的操作报「还没有启动」。
  uiActionServices?: UiActionServices;
  // 交付页「开 PR」用的 gh。测试注入假的；缺省用本机的 gh（engine 的 delivery.ts）。
  pullRequestRunner?: PullRequestRunner;
  // 外部通道的凭据（设置页「消息通道」，daemon 的 channel-settings.ts）。缺席时 /v1/channels/settings 回 503。
  channelSettings?: ChannelSettingsService;
  // Lead 的形象（设置页「身份与风格 → 形象」）：配置的 Slack 署名 emoji 和 Slack 的预览（daemon 给）。
  // 缺席时路由照样有：配置按没配算，预览说查不了。
  leadAvatar?: LeadAvatarService;
  hello: () => Record<string, unknown>;
  chat: (message: string, origin: { label: string }) => "started" | "steered";
  // mode：用户选的放置方式（工单 04）。缺省是插话。Lead 忙时排队的消息回 queued。
  chatV2?: (command: {
    message: string;
    bindingId: number;
    bindingKind: string;
    bindingName: string;
    itemId?: number;
    commandId: string;
    mode?: ChatPlacement;
    // 用户发的图片（protocol 的 chat-images.ts），网关已经校验并解码。只有 Lead 的会话收图片。
    images?: ChatImageData[];
  }) => { mode: ChatSendMode; turnId: string };
  // 工单对话里的一条消息：daemon 一律交给这张工单的 agent（spec D13，2026-10-19）。
  ticketMessageV2?: (command: {
    message: string;
    bindingId: number;
    bindingKind: string;
    bindingName: string;
    itemId: number;
    commandId: string;
  }) => { mode: ChatSendMode; turnId: string };
  addClient: (send: (obj: unknown) => void) => () => void;
  // 用户的手动重检（工单 04）。探针要检查 daemon 执行时用的 adapter，所以由 daemon 执行。
  recheckRuntimes?: (runtime?: KernelRuntimeId) => Promise<RuntimeRecheckResponse["results"]>;
  // daemon 进程环境里的 PLC_AISH_TOKEN。只用来比对，不出网关。缺省读本进程的环境变量。
  aishEnvToken?: () => string | undefined;
  log: (line: string) => void;
}

export interface PairedServerOptions {
  port: number;
  host?: string;
  maxBodyBytes?: number;
  redeemMaxAttempts?: number;
  redeemWindowMs?: number;
  wsTicketTtlMs?: number;
  corsOrigins?: string[];
  allowLoopbackAutoPair?: boolean;
  loopbackAutoPairOrigins?: string[];
  // companion web UI 的静态导出目录（npm run build:web → dist/web）。设置后网关在 / 下提供它，
  // 并且信任自己的回环 origin 来做 loopback 自动配对。未设置时没有任何非 /v1 路由。
  webRoot?: string;
  pairingHandshakeTimeoutMs?: number;
  outboxPollMs?: number;
  // WebSocket 的心跳间隔。一个连接两个间隔里都没有回 pong（也没有发任何消息），就断开它。
  heartbeatMs?: number;
  // 读本机网卡（给手机的配对邀请从这里取局域网地址）。缺省是 os.networkInterfaces，测试注入假的网卡。
  lanInterfaces?: NetworkInterfaceReader;
  // 对端是不是这台机器（工单 15：扫码兑换和主人操作的来源）。缺省：回环地址，或者对端地址是本机网卡的地址。
  // 测试注入它来模拟局域网上的手机。
  peerIsThisMachine?: (remoteAddress: string | undefined, localAddress: string | undefined) => boolean;
}

export class PairedCommandError extends Error {
  constructor(
    readonly code: "invalid_request" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const PAIRED_COMMAND_STATUS: Record<PairedCommandError["code"], number> = {
  invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "internal_error",
    message: string,
    // 给客户端区分原因（例如交付和工单操作的 details.reason：unavailable、stale）。HttpErrorResponseSchema 允许它。
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// 读完再一次解码：一个汉字的几个字节可能分在两块里，逐块转成字符串会把它变成乱码（带图片的请求体有几 MB，分很多块）。
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (tooLarge) reject(new HttpError(413, "invalid_request", "request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function milestoneDto(milestone: ItemMilestone): MilestoneDto {
  return {
    id: milestone.id,
    ticketId: milestone.item_id,
    kind: milestone.kind,
    label: milestone.label ?? MILESTONE_KIND_LABELS[milestone.kind],
    at: milestone.at,
    allDay: milestone.all_day === 1,
    state: milestone.state,
  };
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_request", "invalid JSON body");
  }
}

function iso(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}.000Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

function notificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    ticketId: row.item_id,
    kind: row.kind,
    dedupKey: row.dedup_key,
    urgency: row.urgency,
    title: row.title,
    body: row.body,
    state: row.state,
    createdAt: iso(row.created_at) ?? row.created_at,
    deliveredAt: iso(row.delivered_at),
    deliveredVia: row.delivered_via,
    ackedAt: iso(row.acked_at),
  };
}

function integerParam(
  raw: string | null,
  name: string,
  options: { defaultValue?: number; min?: number; max?: number } = {},
): number | undefined {
  if (raw === null) return options.defaultValue;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_request", `${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, "invalid_request", `${name} is out of range`);
  }
  return value;
}

function assertQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) throw new HttpError(400, "invalid_request", `unknown query parameter: ${key}`);
  }
}

function assertSingleQueryValues(url: URL, names: readonly string[]): void {
  for (const name of names) {
    if (url.searchParams.getAll(name).length > 1) {
      throw new HttpError(400, "invalid_request", `${name} may be provided only once`);
    }
  }
}

function positiveIntegerValues(url: URL, name: string): number[] | undefined {
  const raw = url.searchParams.getAll(name);
  if (!raw.length) return undefined;
  return raw.map((value) => {
    if (!/^\d+$/.test(value)) throw new HttpError(400, "invalid_request", `${name} must be an integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new HttpError(400, "invalid_request", `${name} is out of range`);
    }
    return parsed;
  });
}

function checkpointQuery(url: URL): KernelCheckpointListQuery {
  assertQueryKeys(url, ["after_id", "before_id", "limit"]);
  assertSingleQueryValues(url, ["after_id", "before_id", "limit"]);
  const query = {
    ...(url.searchParams.has("after_id")
      ? { after_id: integerParam(url.searchParams.get("after_id"), "after_id", { min: 0 })! }
      : {}),
    ...(url.searchParams.has("before_id")
      ? { before_id: integerParam(url.searchParams.get("before_id"), "before_id", { min: 1 })! }
      : {}),
    ...(url.searchParams.has("limit")
      ? { limit: integerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 200 })! }
      : {}),
  };
  if (!Value.Check(KernelCheckpointListQuerySchema, query)) {
    throw new HttpError(400, "invalid_request", "invalid checkpoint query");
  }
  return query as KernelCheckpointListQuery;
}

function workItemQuery(url: URL): KernelTicketWorkItemListQuery {
  assertQueryKeys(url, ["ticket_id"]);
  const query = {
    ...(url.searchParams.has("ticket_id")
      ? { ticket_id: positiveIntegerValues(url, "ticket_id")! }
      : {}),
  };
  if (!Value.Check(KernelTicketWorkItemListQuerySchema, query)) {
    throw new HttpError(400, "invalid_request", "invalid work-item query");
  }
  return query as KernelTicketWorkItemListQuery;
}

function interventionQuery(url: URL): KernelInterventionListQuery {
  assertQueryKeys(url, ["ticket_id", "state", "id"]);
  assertSingleQueryValues(url, ["ticket_id", "state"]);
  const query = {
    ...(url.searchParams.has("ticket_id")
      ? { ticket_id: integerParam(url.searchParams.get("ticket_id"), "ticket_id", { min: 1 })! }
      : {}),
    ...(url.searchParams.has("state") ? { state: url.searchParams.get("state")! } : {}),
    ...(url.searchParams.has("id") ? { id: url.searchParams.getAll("id") } : {}),
  };
  if (!Value.Check(KernelInterventionListQuerySchema, query)) {
    throw new HttpError(400, "invalid_request", "invalid intervention query");
  }
  return query as KernelInterventionListQuery;
}

function conversationCardQuery(url: URL): KernelConversationCardListQuery {
  assertQueryKeys(url, ["after_id", "before_id", "limit", "ticket_id", "key"]);
  assertSingleQueryValues(url, ["after_id", "before_id", "limit"]);
  const query = {
    ...(url.searchParams.has("after_id")
      ? { after_id: integerParam(url.searchParams.get("after_id"), "after_id", { min: 0 })! }
      : {}),
    ...(url.searchParams.has("before_id")
      ? { before_id: integerParam(url.searchParams.get("before_id"), "before_id", { min: 1 })! }
      : {}),
    ...(url.searchParams.has("limit")
      ? { limit: integerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 200 })! }
      : {}),
    ...(url.searchParams.has("ticket_id")
      ? { ticket_id: positiveIntegerValues(url, "ticket_id")! }
      : {}),
    ...(url.searchParams.has("key") ? { key: url.searchParams.getAll("key") } : {}),
  };
  if (!Value.Check(KernelConversationCardListQuerySchema, query)) {
    throw new HttpError(400, "invalid_request", "invalid conversation-card query");
  }
  return query as KernelConversationCardListQuery;
}

function mapInterventionError(error: unknown): never {
  if (error instanceof InterventionConflictError) {
    throw new HttpError(409, "conflict", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new HttpError(404, "not_found", message);
  if (/audience|does not allow|explicit user/i.test(message)) {
    throw new HttpError(403, "forbidden", message);
  }
  if (/option|custom text|resolution text|required|invalid/i.test(message)) {
    throw new HttpError(400, "invalid_request", message);
  }
  throw error;
}

// 白名单，不是"把路径末段当动作名"：后者会让任何 POST /v1/tickets/1/<随便什么>
// 都走进这段代码，再靠 switch 的 default 兜底——那正是 404 该做的事。
const ITEM_ACTIONS = new Set<string>(USER_ITEM_ACTION_IDS);
// 旧的工单动作路由转调工单操作层（spec 5.11，ui-action-parity plan.md P03）。确认提醒（ack）是提醒的操作（reminder.ack）。
const TICKET_ACTION_OF_ITEM_ACTION: Record<Exclude<UserItemActionId, "ack">, TicketActionId> = {
  confirm: "confirm", start: "start", complete: "complete", rework: "rework", stop: "stop", unconfirm: "unconfirm",
  restore: "restore", cancel: "cancel",
};
const WORKSPACE_ACTIONS = new Set(["release", "cleanup"]);
const RUN_ACTIONS = new Set(["pause", "resume", "stop"]);

function mapUserActionError(error: unknown): never {
  // 换核查员的拒绝带着自己的原因码（engine 的 change-reviewer.ts）。
  if (error instanceof ReviewerChangeError) {
    if (error.code === "not_found") throw new HttpError(404, "not_found", error.message);
    if (error.code === "unknown_runtime") throw new HttpError(400, "invalid_request", error.message);
    throw new HttpError(409, "conflict", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new HttpError(404, "not_found", message);
  // "actor 'x' may not transition" 是权限问题，"illegal transition" 是状态问题——
  // 前者换个人能做，后者谁都不能做，对调用方是两件事。
  if (/may not transition/i.test(message)) throw new HttpError(403, "forbidden", message);
  if (/illegal transition|cannot restore|cannot pause|cannot resume|only a task|no runner|selected child items|workspace|active runs|terminal|no unreviewed delivery/i.test(message)) {
    throw new HttpError(409, "conflict", message);
  }
  throw error;
}

function mapTicketRelationError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new HttpError(404, "not_found", message);
  if (/cancelled|cycle|already points|canonical ticket|already superseded|conflicts|constraint/i.test(message)) {
    throw new HttpError(409, "conflict", message);
  }
  if (/invalid|reason is required|itself|existing task tree|requires|purpose|parent_of|child_of/i.test(message)) {
    throw new HttpError(400, "invalid_request", message);
  }
  throw error;
}

// 工单操作层（engine 的 ticket-actions/）的错误。操作层自己的拒绝带着原因码；底层的错误原样抛出来，按它们原来的映射走：
// 交付的 DeliveryError（details.reason 是它的 code，和以前的 /delivery 路由一样），换核查员的 ReviewerChangeError，
// 关联的错，其余按用户操作的映射。
const DELIVERY_ERROR_STATUS: Record<DeliveryError["code"], [number, HttpError["code"]]> = {
  not_found: [404, "not_found"],
  invalid_request: [400, "invalid_request"],
  unavailable: [409, "conflict"],
  failed: [409, "conflict"],
  stale: [409, "conflict"],
};

function mapTicketActionError(error: unknown, kind: "relation" | "default" = "default"): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof TicketActionError) {
    const reason = { reason: error.code };
    if (error.code === "not_found") throw new HttpError(404, "not_found", error.message, reason);
    if (error.code === "invalid_input") throw new HttpError(400, "invalid_request", error.message, reason);
    if (error.code === "unavailable" || error.code === "stale" || error.code === "needs_confirmation") {
      throw new HttpError(409, "conflict", error.message, reason);
    }
    throw new HttpError(403, "forbidden", error.message, reason);
  }
  if (error instanceof DeliveryError) {
    const [status, code] = DELIVERY_ERROR_STATUS[error.code];
    throw new HttpError(status, code, error.message, { reason: error.code });
  }
  if (kind === "relation") mapTicketRelationError(error);
  mapUserActionError(error);
}

// 控制面就是"用户本人在点"。允许调用方自称身份，等于把 §6.4 的矩阵降级成一个
// 可以随便填的 JSON 字段——lead 只要 POST 一个 {actor:'lead'} 就绕过了整套闸门。
const LEAD_CAPABILITIES = new Set<string>(["confirm_item"]);

function assertLeadCapability(value: unknown): LeadCapability {
  if (typeof value === "string" && LEAD_CAPABILITIES.has(value)) return value as LeadCapability;
  throw new HttpError(400, "invalid_request", `unknown lead capability: ${String(value)}`);
}

function assertUserActor(body: unknown): void {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const actor = (body as { actor?: unknown }).actor;
    if (actor !== undefined && actor !== "user") {
      throw new HttpError(
        403, "forbidden",
        "this control plane acts as the user only; it cannot act on behalf of another actor",
      );
    }
  }
}

// 页面的「恢复」请求体（mode、child_ticket_ids）换成工单操作 restore 的输入。取值不对时由操作层的输入校验拒绝（400）。
function restoreInput(body: unknown): Record<string, unknown> {
  const restore = (body ?? {}) as { mode?: unknown; child_ticket_ids?: unknown };
  return {
    ...(restore.mode === undefined ? {} : { mode: restore.mode }),
    ...(restore.child_ticket_ids === undefined ? {} : {
      childTicketIds: Array.isArray(restore.child_ticket_ids) ? restore.child_ticket_ids.map(Number) : restore.child_ticket_ids,
    }),
  };
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function safeBinding(binding: Binding) {
  return {
    id: binding.id,
    kind: binding.kind,
    name: binding.display_name,
    scopes: bindingScopes(binding),
  };
}

function adminBinding(binding: Binding): AdminBinding {
  return {
    id: binding.id,
    kind: binding.kind,
    name: binding.display_name,
    status: binding.status,
    scopes: bindingScopes(binding),
    lastSeenAt: iso(binding.last_seen_at),
    createdAt: iso(binding.created_at) ?? binding.created_at,
  };
}

// 授权和委托的审计渠道按 binding 的 kind 记：plc 记 cli，其他客户端记 control-plane。
function grantChannel(binding: Binding): "cli" | "control-plane" {
  return binding.kind === "cli" ? "cli" : "control-plane";
}

function aishEnvTokenState(db: Db, envToken: string | undefined): AishCredentialStatus["envToken"] {
  if (!envToken) return "unset";
  if (getAishAuthFailure(db, envToken)) return "marked_failed";
  const stored = loadAishConn(db);
  if (!stored) return "set";
  return stored.token === envToken ? "same_as_stored" : "different_from_stored";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export async function startPairedServer(
  bridge: PairedBridge,
  opts: PairedServerOptions,
): Promise<{
  port: number;
  publish: (args: Parameters<typeof publishGatewayEvent>[1]) => GatewayEvent;
  // 有人在看的、活着的 v2 连接个数（binding 有效且带 chat scope）。daemon 用它判断"有没有人在听"。
  chatListenerCount: () => number;
  // 网关启动以后有没有 v2 客户端连上过（不管在不在看）。daemon 刚重启、还没有客户端连上时，用户在不在是未知（2026-10-19）。
  clientSeenSinceStart: () => boolean;
  // 临时 admin token：只在内存里（只存哈希），只开管理路由，过期作废，daemon 重启也作废。
  issueAdminToken: (ttlMs?: number) => { accessToken: string; expiresAt: string };
  // 在另一个地址上也接受连接（同一个网关，同一套路由）。listen 失败时 reject。
  listenAlso: (host: string, port: number) => Promise<{ port: number; close(): Promise<void> }>;
  close: () => Promise<void>;
}> {
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const redeemMaxAttempts = opts.redeemMaxAttempts ?? 10;
  const redeemWindowMs = opts.redeemWindowMs ?? 60_000;
  const wsTicketTtlMs = opts.wsTicketTtlMs ?? 30_000;
  const pairingHandshakeTimeoutMs = opts.pairingHandshakeTimeoutMs ?? 15_000;
  const listenHost = opts.host ?? "127.0.0.1";
  const configuredOrigins = new Set(opts.corsOrigins ?? (process.env.PLC_CORS_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const allowLoopbackAutoPair = opts.allowLoopbackAutoPair ?? process.env.PLC_ALLOW_LOOPBACK_AUTO_PAIR === "1";
  const loopbackAutoPairOrigins = new Set(
    opts.loopbackAutoPairOrigins ?? (process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const failedRedeems = new Map<string, { count: number; resetAt: number }>();
  // listenAlso 开的其他地址上的监听，和关掉它的函数（会断开它接进来的连接）。
  const extraListeners = new Map<NetServer, () => Promise<void>>();
  // 临时 admin token 的 SHA-256 → 过期时间（毫秒）。
  const adminTokens = new Map<string, number>();
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
  const wsTickets = new Map<string, { bindingId: number; expiresAt: number }>();
  const v2Clients = new Map<WsSocket, {
    bindingId: number;
    scopes: Scope[];
    lastSentSeq: number;
    // 客户端最近一次 presence.set 说的：现在有没有人在看。没说过就是没有。
    attended: boolean;
    // 连接时用 include= 声明要收的选收事件（protocol 的 gatewayEventOptIn）。
    includes: ReadonlySet<string>;
  }>();

  // 选收事件只发给声明过要它的连接：旧客户端不认识它的类型。
  function wantsEvent(event: GatewayEvent, includes: ReadonlySet<string>): boolean {
    const optIn = gatewayEventOptIn(event);
    return optIn === null || includes.has(optIn);
  }
  // 每个 WebSocket 最近一次有动静（pong 或任何消息）的时间。
  const lastHeard = new Map<WsSocket, number>();
  let broadcastCursor = latestGatewaySeq(bridge.db);

  function deliverGatewayEvent(event: GatewayEvent): void {
    for (const [client, state] of v2Clients) {
      if (event.seq <= state.lastSentSeq) continue;
      const current = getBinding(bridge.db, state.bindingId);
      if (!current || current.status !== "active") {
        client.close(4001, "binding revoked");
        continue;
      }
      const scopes = bindingScopes(current);
      if (scopes.includes(event.requiredScope)
          && (event.audienceBindingId === null || event.audienceBindingId === current.id)
          && wantsEvent(event, state.includes)) {
        sendWs(client, event);
      }
      state.lastSentSeq = event.seq;
    }
  }

  function flushGatewayOutbox(): void {
    for (;;) {
      const events = listGatewayEventBatch(bridge.db, { afterSeq: broadcastCursor });
      if (!events.length) return;
      for (const event of events) {
        deliverGatewayEvent(event);
        broadcastCursor = event.seq;
      }
      if (events.length < 500) return;
    }
  }

  const outboxTimer = setNodeInterval(
    flushGatewayOutbox,
    opts.outboxPollMs ?? 25,
  ) as unknown as NodeJS.Timeout;
  outboxTimer.unref();

  // 心跳：半开的连接（手机断网、浏览器休眠后没有关闭握手）收不到 pong，两个间隔之后断开，
  // 不再被算作"有人在听"。
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const heartbeatTimer = setNodeInterval(() => {
    const now = Date.now();
    for (const [socket, heard] of lastHeard) {
      if (now - heard > 2 * heartbeatMs) {
        socket.terminate();
        lastHeard.delete(socket);
        continue;
      }
      try { socket.ping(); } catch { /* 已经在关闭 */ }
    }
  }, heartbeatMs) as unknown as NodeJS.Timeout;
  heartbeatTimer.unref();
  const trackLiveness = (socket: WsSocket) => {
    lastHeard.set(socket, Date.now());
    socket.on("pong", () => { if (lastHeard.has(socket)) lastHeard.set(socket, Date.now()); });
    socket.on("message", () => { if (lastHeard.has(socket)) lastHeard.set(socket, Date.now()); });
    socket.on("close", () => lastHeard.delete(socket));
  };

  let clientSeen = false;
  // "有人在听"：活着的、说自己有人在看的 v2 连接，并且它的 binding 现在仍然有效、带 chat scope。
  // binding 每次都重新读账本：撤销或改了 scope 立刻生效。
  function chatListenerCount(): number {
    let count = 0;
    for (const [socket, client] of v2Clients) {
      if (!client.attended || socket.readyState !== socket.OPEN || !lastHeard.has(socket)) continue;
      const binding = getBinding(bridge.db, client.bindingId);
      if (binding?.status === "active" && bindingScopes(binding).includes("chat")) count += 1;
    }
    return count;
  }
  const gatewayIdentity = getOrCreateGatewayIdentity(bridge.db);

  // 网关自己提供的页面：只有网关能以这些 origin 提供内容，所以它和白名单里的 origin 一样可信。
  // 没有 web UI 时没有合法页面会带这些 origin，也就不信任它们。
  function isOwnWebOrigin(origin: string): boolean {
    if (opts.webRoot === undefined) return false;
    const address = server.address();
    if (!address || typeof address === "string") return false;
    const port = address.port;
    return origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}` ||
      origin === `http://[::1]:${port}`;
  }

  // 本机网页的请求：socket 来自回环地址，有 Origin 并且是回环 origin，它还是网关自己的网页或在允许列表里。
  // 回环自动配对、给手机发配对邀请、改外部通道的凭据都用这一条规则。
  function isLoopbackPage(req: IncomingMessage): boolean {
    if (!allowLoopbackAutoPair) return false;
    const origin = req.headers.origin;
    return isLoopbackAddress(req.socket.remoteAddress) &&
      Boolean(origin) &&
      isLoopbackOrigin(origin!) &&
      (loopbackAutoPairOrigins.has(origin!) || isOwnWebOrigin(origin!));
  }

  // 设置页能不能显示填密钥的输入框（GET /v1/channels/settings 的 editable）。浏览器同源的 GET 不带 Origin，
  // 所以没有 Origin 时按调用方判断：从本机回环地址来、是本机网页自动配对的 binding（origin loopback_web）、并且有 tickets:create。
  // 这只决定页面怎么画；test、PUT、DELETE 浏览器会带 Origin，照样要 isLoopbackPage（requireLoopbackPage）。
  function editableHere(req: IncomingMessage): boolean {
    if (!allowLoopbackAutoPair) return false;
    let caller: { binding: Binding; scopes: Scope[] };
    try {
      caller = requireAuth(req);
    } catch {
      return false;
    }
    if (!caller.scopes.includes("tickets:create")) return false;
    if (req.headers.origin) return isLoopbackPage(req);
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    // 浏览器的同源请求带 Sec-Fetch-Site: same-origin（页面里的脚本改不了它），Host 是本机回环：这是这个网关提供的网页，
    // 开在这台 Mac 上。10-17 以前配对的本机网页没有记 binding 的来处（origin 为空），只能靠这一条认出来（2026-10-21）。
    const host = req.headers.host;
    if (req.headers["sec-fetch-site"] === "same-origin" && typeof host === "string" && isLoopbackOrigin(`http://${host}`)) return true;
    return bindingOriginOf(caller.binding) === "loopback_web";
  }

  // 关闭回环自动配对时，配对的这些路由都不存在。
  function requireLoopbackPage(req: IncomingMessage, refusal: string): void {
    if (!allowLoopbackAutoPair) throw new HttpError(404, "not_found", "not found");
    if (!isLoopbackPage(req)) throw new HttpError(403, "forbidden", refusal);
  }

  // 网关现在的全部监听：主监听，和 listenAlso 另开的监听。
  function listeningAddresses(): ListeningAddress[] {
    return [server, ...extraListeners.keys()].flatMap((listener) => {
      const address = listener.address();
      return address && typeof address !== "string" ? [{ address: address.address, port: address.port }] : [];
    });
  }

  function allowedOrigin(origin: string | undefined): string | null {
    if (!origin) return null;
    if (isLoopbackOrigin(origin) || configuredOrigins.has(origin) || configuredOrigins.has("*")) return origin;
    return null;
  }

  function isSameHostWebSocketOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host) return false;
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  function allowsWebSocketOrigin(req: IncomingMessage): boolean {
    return !req.headers.origin ||
      allowedOrigin(req.headers.origin) !== null ||
      isSameHostWebSocketOrigin(req);
  }

  function responseHeaders(req: IncomingMessage): Record<string, string> {
    const origin = allowedOrigin(req.headers.origin);
    return {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,idempotency-key",
        "vary": "origin",
      } : {}),
    };
  }

  // headers：覆盖缺省的响应头（例如按内容哈希取的图可以长期缓存）。
  function json(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...responseHeaders(req), ...headers });
    res.end(JSON.stringify(value));
  }

  function attachmentFilename(filename: string): string {
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename*=UTF-8''${encoded}`;
  }

  async function sendArtifactContent(
    req: IncomingMessage,
    res: ServerResponse,
    content: ReturnType<ControlPlaneService["openKernelArtifactContent"]>,
  ): Promise<void> {
    res.writeHead(200, {
      ...responseHeaders(req),
      "content-type": content.mediaType,
      "content-length": String(content.byteLength),
      "content-disposition": attachmentFilename(content.filename),
      "x-content-type-options": "nosniff",
      "x-artifact-id": String(content.artifactId),
      "x-artifact-sha256": content.sha256,
      "cache-control": "private, no-store",
      ...(allowedOrigin(req.headers.origin) ? {
        "access-control-expose-headers": "content-disposition,content-length,content-type,x-artifact-id,x-artifact-sha256",
      } : {}),
    });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        req.off("aborted", abort);
        res.off("finish", finish);
        res.off("close", close);
        content.stream.off("error", streamError);
        resolve();
      };
      const abort = () => {
        content.stream.destroy();
        if (!res.destroyed) res.destroy();
        finish();
      };
      const close = () => {
        if (!res.writableEnded) content.stream.destroy();
        finish();
      };
      const streamError = () => {
        if (!res.destroyed) res.destroy();
        finish();
      };
      req.once("aborted", abort);
      res.once("finish", finish);
      res.once("close", close);
      content.stream.once("error", streamError);
      content.stream.pipe(res);
    });
  }

  function error(req: IncomingMessage, res: ServerResponse, err: unknown): void {
    if (err instanceof HttpError) {
      json(req, res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      return;
    }
    bridge.log(`[gateway] HTTP error: ${err instanceof Error ? err.message : String(err)}`);
    json(req, res, 500, { error: { code: "internal_error", message: "internal server error" } });
  }

  function requireAuth(req: IncomingMessage, scope?: Scope): { binding: Binding; scopes: Scope[] } {
    const token = bearerOf(req);
    const binding = token ? authenticateToken(bridge.db, token) : null;
    if (!binding && token) {
      const admin = adminTokenBinding(token, scope);
      if (admin) return { binding: admin, scopes: [ADMIN_SCOPE] };
    }
    if (!binding) throw new HttpError(401, "unauthorized", "authentication required");
    const scopes = bindingScopes(binding);
    if (scope && !scopes.includes(scope)) {
      // 用户的决定：child 在这台机器上自己就能拿到的凭证做不了（protocol 的 originMayDecide）。说明只指向用户，不提别的入口。
      if (scope === "approvals:respond" && !originMayDecide(bindingOriginOf(binding))) {
        throw new HttpError(403, "forbidden",
          "missing scope: approvals:respond. Only the user decides, in the web page or on the paired phone");
      }
      throw new HttpError(403, "forbidden", `missing scope: ${scope}`);
    }
    return { binding, scopes };
  }

  // 临时 admin token 只开管理路由：别的路由（包括 ws-ticket 和 /v1/paired/me）一律 403。
  // 它没有账本里的 binding；管理路由不读调用方的 binding，这里给一个只在内存里的占位。
  function adminTokenBinding(token: string, scope: Scope | undefined): Binding | null {
    const hash = tokenHash(token);
    const expiresAt = adminTokens.get(hash);
    if (expiresAt === undefined) return null;
    if (expiresAt <= Date.now()) {
      adminTokens.delete(hash);
      return null;
    }
    if (scope !== ADMIN_SCOPE) throw new HttpError(403, "forbidden", "a temporary admin token only opens admin routes");
    const now = new Date().toISOString();
    return {
      id: 0, kind: "cli", display_name: "plc（临时 admin）", external_subject: null, token_hash: null,
      scopes: JSON.stringify([ADMIN_SCOPE]), status: "active", last_seen_at: now, created_at: now,
      conn_url: null, conn_secret: null,
    };
  }

  function issueAdminToken(ttlMs: number = ADMIN_TOKEN_TTL_MS): { accessToken: string; expiresAt: string } {
    const now = Date.now();
    for (const [hash, expiresAt] of adminTokens) if (expiresAt <= now) adminTokens.delete(hash);
    const accessToken = `adm_${randomBytes(24).toString("base64url")}`;
    adminTokens.set(tokenHash(accessToken), now + ttlMs);
    return { accessToken, expiresAt: new Date(now + ttlMs).toISOString() };
  }

  function service(): ControlPlaneService {
    if (!bridge.controlPlane) throw new HttpError(500, "internal_error", "control-plane unavailable");
    return bridge.controlPlane;
  }

  // ——— 高风险的主人操作（工单 15 第一步）———
  // 请求来自哪种客户端、是不是这台机器。是不是这台机器只看 socket（回环，或者对端地址是本机网卡的地址）；
  // 请求头可以随便填，只用来区分网页和别的客户端，不影响推送不推送。
  function peerIsThisMachine(remoteAddress: string | undefined, localAddress: string | undefined): boolean {
    if (opts.peerIsThisMachine) return opts.peerIsThisMachine(remoteAddress, localAddress);
    return isLoopbackAddress(remoteAddress) || isThisMachineAddress(remoteAddress, localAddress, opts.lanInterfaces);
  }

  function requestSource(req: IncomingMessage, binding: Binding): OwnerActionSource {
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    const fromThisMachine = peerIsThisMachine(req.socket.remoteAddress, req.socket.localAddress);
    const client = binding.kind === "cli" ? "cli"
      : req.headers.origin ? "web"
      : fromThisMachine ? "unknown" : "phone";
    return { client, deviceName: binding.display_name, loopback, fromThisMachine };
  }

  // 操作成功以后调用：记一条 owner_action.performed 事件，要推送时同时写推送用的通知（store 的 recordOwnerAction）。
  // 记不上（库出错）只写日志：操作已经做了，回 500 会让客户端以为没做成。
  function recordOwnerActionFor(req: IncomingMessage, binding: Binding, input: OwnerActionInput): void {
    try {
      recordOwnerAction(bridge.db, { ...input, undo: { ...input.undo }, credential: binding, source: requestSource(req, binding) });
    } catch (err) {
      bridge.log(`[owner-action] failed to record ${input.action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function ownerActionDeps(): OwnerActionDeps {
    return {
      db: bridge.db,
      ...(bridge.userActions ? { userActions: bridge.userActions } : {}),
      ...(bridge.leadTrust ? { leadTrust: bridge.leadTrust } : {}),
      ...(bridge.connections ? { connections: bridge.connections } : {}),
      ...(bridge.channelSettings ? { channelSettings: bridge.channelSettings } : {}),
      ...(bridge.uiActionServices?.notesMemory ? { notesMemory: bridge.uiActionServices.notesMemory } : {}),
      publish: (event) => { publish(event); },
      log: bridge.log,
    };
  }

  function requireUserActions(): UserActionService {
    if (!bridge.userActions) {
      throw new HttpError(500, "internal_error", "user control plane unavailable");
    }
    return bridge.userActions;
  }

  // 工单操作层（spec 5.11）的页面入口。宿主（拉起进程、选核查员）和用户操作服务是同一份。
  function ticketActionContext(): UserTicketActionContext {
    return {
      db: bridge.db,
      host: bridge.userActions?.host ?? {},
      ...(bridge.pullRequestRunner ? { pullRequestRunner: bridge.pullRequestRunner } : {}),
      log: bridge.log,
    };
  }

  // 工单以外的操作（engine 的 ui-actions/）的页面入口。服务和 Lead 用的是 daemon 交来的同一个对象。
  function uiActionContext(): UserUiActionContext {
    return { db: bridge.db, services: bridge.uiActionServices ?? {}, log: bridge.log };
  }

  // 以你的名义执行一个工单以外的操作（原来的路由转调它）。账本和主人操作记在发出请求的凭证名下。
  // 操作层自己的拒绝按工单操作的映射走；底层的错误（例如审批的冲突）交给 mapOther，没有时也按工单操作的映射。
  async function performUiActionAsUser(
    req: IncomingMessage,
    auth: { binding: Binding; scopes: Scope[] },
    request: { target: UiActionTarget; action: string; input?: unknown; reason?: string },
    mapOther?: (error: unknown) => never,
  ): Promise<UiActionOutcome> {
    try {
      return await performUserUiAction(uiActionContext(), {
        ...request, binding: auth.binding, scopes: auth.scopes, source: requestSource(req, auth.binding),
      });
    } catch (error) {
      if (mapOther && !(error instanceof TicketActionError)) mapOther(error);
      mapTicketActionError(error);
    }
  }

  // 以你的名义执行一个工单操作（新路由和转调它的旧路由都用）。主人操作记在发出请求的凭证名下。
  async function performAsUser(
    req: IncomingMessage,
    binding: Binding,
    request: { itemId: number; action: string; input?: unknown; reason?: string },
    errors: "relation" | "default" = "default",
  ): Promise<TicketActionOutcome> {
    requireUserActions();
    try {
      return await performUserTicketAction(ticketActionContext(), { ...request, binding, source: requestSource(req, binding) });
    } catch (error) {
      mapTicketActionError(error, errors);
    }
  }

  // clientMessageId：客户端发件箱的稳定 id。同一个 binding 发过同一个 id 时，回答那一轮（duplicate），不再开一轮。
  // WS 和 HTTP 兜底都走这里；它是同步的，先查后记之间不会插进另一条命令。
  function executeChatCommand(
    input: {
      id: string; message: string; context?: { ticketId?: number };
      clientMessageId?: string; mode?: ChatPlacement; images?: unknown;
    },
    binding: Binding,
  ): { mode: ChatSendMode; turnId: string; duplicate?: true } {
    const clientMessageId = input.clientMessageId;
    if (clientMessageId !== undefined) {
      const seen = findClientMessageTurn(bridge.db, binding.id, clientMessageId);
      if (seen) {
        const mode: ChatSendMode = seen.mode === "steered" || seen.mode === "queued" ? seen.mode : "started";
        return { mode, turnId: seen.turnId, duplicate: true };
      }
    }
    // 图片（protocol 的 chat-images.ts）：只有 Lead 的会话收。工单对话交给工单的 agent，它们的运行时还不收图片。
    let images: ChatImageData[] | undefined;
    if (input.images !== undefined) {
      if (input.context?.ticketId !== undefined) {
        throw new PairedCommandError("invalid_request", "images are only accepted in the Lead conversation");
      }
      if (!bridge.chatV2) throw new PairedCommandError("invalid_request", "this daemon does not accept images");
      const decoded = decodeChatImages(input.images);
      if (!decoded.ok) throw new PairedCommandError("invalid_request", decoded.error);
      images = decoded.images;
    }
    // 只带图片的消息可以没有文字；文字和图片都没有时拒收。
    if (!input.message.trim() && !images) throw new PairedCommandError("invalid_request", "message is required");
    const { images: _raw, ...command } = input;
    const result = startChatTurn({ ...command, ...(images ? { images } : {}) }, binding);
    if (clientMessageId !== undefined) {
      recordClientMessageTurn(bridge.db, { bindingId: binding.id, clientMessageId, turnId: result.turnId, mode: result.mode });
    }
    return result;
  }

  function startChatTurn(
    input: { id: string; message: string; context?: { ticketId?: number }; mode?: ChatPlacement; images?: ChatImageData[] },
    binding: Binding,
  ): { mode: ChatSendMode; turnId: string } {
    return input.context?.ticketId !== undefined && bridge.ticketMessageV2
      ? bridge.ticketMessageV2({
          message: input.message,
          bindingId: binding.id,
          bindingKind: binding.kind,
          bindingName: binding.display_name,
          itemId: input.context.ticketId,
          commandId: input.id,
        })
      : bridge.chatV2
      ? bridge.chatV2({
          message: input.message,
          bindingId: binding.id,
          bindingKind: binding.kind,
          bindingName: binding.display_name,
          itemId: input.context?.ticketId,
          commandId: input.id,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.images ? { images: input.images } : {}),
        })
      : {
          mode: bridge.chat(input.message, { label: `paired:${binding.kind}:${binding.display_name}` }),
          turnId: `turn_${randomBytes(12).toString("base64url")}`,
        };
  }

  function parseChatSendBody(
    body: Record<string, unknown>,
  ): {
    id: string; message: string; context?: { ticketId?: number };
    clientMessageId?: string; mode?: ChatPlacement; images?: unknown;
  } {
    if (typeof body.id !== "string" || !body.id.trim()) {
      throw new HttpError(400, "invalid_request", "id is required");
    }
    // 只带图片的消息可以没有文字（executeChatCommand 再查一次文字和图片是不是都没有）。
    if (typeof body.message !== "string" || (!body.message.trim() && body.images === undefined)) {
      throw new HttpError(400, "invalid_request", "message is required");
    }
    if (body.clientMessageId !== undefined && !Value.Check(ClientMessageIdSchema, body.clientMessageId)) {
      throw new HttpError(400, "invalid_request", "clientMessageId must be a string of 1 to 128 characters");
    }
    if (body.mode !== undefined && !Value.Check(ChatPlacementSchema, body.mode)) {
      throw new HttpError(400, "invalid_request", "mode must be steer or followUp");
    }
    const parsed = {
      id: body.id, message: body.message,
      ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId as string }),
      ...(body.mode === undefined ? {} : { mode: body.mode as ChatPlacement }),
      ...(body.images === undefined ? {} : { images: body.images }),
    };
    const context = body.context;
    if (context === undefined || context === null) return parsed;
    if (typeof context !== "object" || Array.isArray(context)) {
      throw new HttpError(400, "invalid_request", "context must be an object");
    }
    const { ticketId, answerer } = context as { ticketId?: unknown; answerer?: unknown };
    if (ticketId === undefined) return parsed;
    if (!Number.isInteger(ticketId) || Number(ticketId) < 1) {
      throw new HttpError(400, "invalid_request", "context.ticketId must be a positive integer");
    }
    // answerer 是工单 08 第一版的线上字段（chat.ticket-answerer.v1）。旧客户端还会带：形状照旧校验（和 WebSocket 上的
    // ChatSendCommandSchema 一致），值不再往下传。工单对话一律交给工单的 agent（2026-10-19）。
    if (answerer !== undefined && !Value.Check(TicketChatAnswererSchema, answerer)) {
      throw new HttpError(400, "invalid_request", "context.answerer must be lead or agent");
    }
    return { ...parsed, context: { ticketId: Number(ticketId) } };
  }

  function redeemKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  function checkRedeemRate(req: IncomingMessage): void {
    const key = redeemKey(req);
    const current = failedRedeems.get(key);
    if (!current || current.resetAt <= Date.now()) {
      failedRedeems.delete(key);
      return;
    }
    if (current.count >= redeemMaxAttempts) {
      throw new HttpError(429, "rate_limited", "too many invalid pairing attempts");
    }
  }

  function noteRedeemFailure(req: IncomingMessage): void {
    const key = redeemKey(req);
    const current = failedRedeems.get(key);
    if (!current || current.resetAt <= Date.now()) {
      failedRedeems.set(key, { count: 1, resetAt: Date.now() + redeemWindowMs });
    } else {
      current.count += 1;
    }
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      if (!allowedOrigin(req.headers.origin)) {
        json(req, res, 403, { error: { code: "forbidden", message: "origin not allowed" } });
      } else {
        res.writeHead(204, responseHeaders(req));
        res.end();
      }
      return;
    }

    try {
      // OAuth 回调不是 /v1 下的路由，要排在静态网页之前。
      if (req.method === "GET" && url.pathname === OAUTH_CALLBACK_PATH) {
        await handleOAuthCallback(req, res, url, bridge.connections, isLoopbackAddress(req.socket.remoteAddress), bridge.log);
        return;
      }

      if (
        opts.webRoot !== undefined &&
        (req.method === "GET" || req.method === "HEAD") &&
        !isApiPath(url.pathname)
      ) {
        serveWebFile(req, res, opts.webRoot, url.pathname);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/health") {
        json(req, res, 200, { ok: true, protocolVersion: 2 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/paired/loopback") {
        requireLoopbackPage(req, "loopback auto-pair is not allowed for this request");
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (body.name !== undefined && typeof body.name !== "string") {
          throw new HttpError(400, "invalid_request", "name must be a string");
        }
        const name = (typeof body.name === "string" ? body.name.trim() : "localhost-web");
        if (!name || name.length > 80) {
          throw new HttpError(400, "invalid_request", "name must be between 1 and 80 characters");
        }
        const { binding, accessToken } = createLoopbackBinding(bridge.db, { name });
        bridge.log(`[gateway] loopback auto-paired: ${binding.display_name}`);
        json(req, res, 201, { binding: safeBinding(binding), access_token: accessToken });
        return;
      }

      // 本机网页给手机生成扫码配对邀请（设置 → 设备 → 添加手机）。它不要 admin，也换不到 admin：
      // 邀请只生成 kind=companion 的配对，兑换后只有缺省的 scope（createPairing 的缺省值）。
      // 地址由网关决定：请求里的 endpoint 必须是网关给出的局域网地址之一。
      // 邀请 URI 是凭证：日志里只记名称和 kind。
      if (req.method === "POST" && url.pathname === "/v1/paired/loopback/invitations") {
        requireLoopbackPage(req, "pairing invitations are only available to the local web UI");
        requireAuth(req);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(LoopbackInvitationRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", "invalid invitation input");
        }
        const input = body as LoopbackInvitationRequest;
        const name = input.name.trim();
        if (!name) throw new HttpError(400, "invalid_request", "name must be between 1 and 80 characters");
        // 名称会写进日志和设备列表：不收控制字符（例如换行）。
        if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "invalid_request", "name must not contain control characters");
        const endpoints = lanPairingEndpoints(listeningAddresses(), opts.lanInterfaces);
        if (!endpoints.length) {
          throw new HttpError(409, "conflict",
            "the gateway does not listen on a LAN address; set PLC_GATEWAY_HOST and PLC_GATEWAY_PORT and restart the daemon");
        }
        const endpoint = input.endpoint ?? endpoints[0]!;
        if (!endpoints.includes(endpoint)) {
          throw new HttpError(400, "invalid_request", "endpoint must be one of the gateway's LAN addresses");
        }
        const invitation = createGatewayPairingInvitation(bridge.db, { endpoint, name, kind: "companion", origin: "web_invitation" });
        bridge.log(`[gateway] pairing invitation created by the local web UI: ${name} (companion)`);
        const payload: LoopbackInvitation = {
          pairingId: invitation.pairingId,
          expiresAt: invitation.expiresAt,
          uri: invitation.uri,
          qr: encodeQrMatrix(invitation.uri),
          endpoint,
          endpoints,
        };
        json(req, res, 201, payload);
        return;
      }

      // 页面轮询它，看手机有没有兑换邀请。只报状态和过期时间。只认 kind=companion 的配对。
      const invitationStatusMatch = url.pathname.match(/^\/v1\/paired\/loopback\/invitations\/(\d+)\/status$/);
      if (req.method === "POST" && invitationStatusMatch) {
        requireLoopbackPage(req, "pairing invitations are only available to the local web UI");
        requireAuth(req);
        const pairingId = Number(invitationStatusMatch[1]);
        const status = Number.isSafeInteger(pairingId) ? getPairingStatus(bridge.db, pairingId) : null;
        if (!status || status.kind !== "companion") throw new HttpError(404, "not_found", "invitation not found");
        const payload: LoopbackInvitationStatus = { pairingId: status.id, state: status.state, expiresAt: status.expiresAt };
        json(req, res, 200, payload);
        return;
      }

      // 页面关掉二维码、重新生成或离开设置页时作废它。只作废还没兑换的邀请：已经兑换出来的 binding 不受影响。
      // 已经兑换、过期或作废的邀请保持原样，照常回当前状态，所以重复调用是安全的。日志里只记编号。
      const invitationCancelMatch = url.pathname.match(/^\/v1\/paired\/loopback\/invitations\/(\d+)\/cancel$/);
      if (req.method === "POST" && invitationCancelMatch) {
        requireLoopbackPage(req, "pairing invitations are only available to the local web UI");
        requireAuth(req);
        const pairingId = Number(invitationCancelMatch[1]);
        const before = Number.isSafeInteger(pairingId) ? getPairingStatus(bridge.db, pairingId) : null;
        if (!before || before.kind !== "companion") throw new HttpError(404, "not_found", "invitation not found");
        if (cancelPendingPairing(bridge.db, pairingId)) {
          bridge.log(`[gateway] pairing invitation #${pairingId} cancelled by the local web UI`);
        }
        const status = getPairingStatus(bridge.db, pairingId)!;
        const payload: LoopbackInvitationStatus = { pairingId: status.id, state: status.state, expiresAt: status.expiresAt };
        json(req, res, 200, payload);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/paired/redeem") {
        checkRedeemRate(req);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (typeof body.pairing_code !== "string" || !body.pairing_code) {
          throw new HttpError(400, "invalid_request", "pairing_code required");
        }
        try {
          const { binding, accessToken } = redeemPairing(bridge.db, body.pairing_code);
          failedRedeems.delete(redeemKey(req));
          bridge.log(`[gateway] pairing redeemed: ${binding.display_name} (${binding.kind})`);
          json(req, res, 201, { binding: safeBinding(binding), access_token: accessToken });
        } catch (err) {
          noteRedeemFailure(req);
          throw new HttpError(400, "invalid_request", err instanceof Error ? err.message : "invalid pairing code");
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/paired/me") {
        const { binding } = requireAuth(req);
        json(req, res, 200, { binding: safeBinding(binding) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/paired/ws-ticket") {
        const { binding } = requireAuth(req);
        for (const [key, issued] of wsTickets) {
          if (issued.expiresAt <= Date.now()) wsTickets.delete(key);
        }
        const item = `wst_${randomBytes(24).toString("base64url")}`;
        const expiresAt = Date.now() + wsTicketTtlMs;
        wsTickets.set(item, { bindingId: binding.id, expiresAt });
        json(req, res, 201, { ws_ticket: item, expires_at: new Date(expiresAt).toISOString() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/send") {
        const { binding } = requireAuth(req, "chat");
        // 带图片的消息有几 MB（protocol 的 CHAT_SEND_MAX_BYTES）。
        const body = parseChatSendBody(parseJson(await readBody(req, Math.max(maxBodyBytes, CHAT_SEND_MAX_BYTES))));
        try {
          json(req, res, 200, executeChatCommand(body, binding));
        } catch (err) {
          // 拒收的消息回 4xx：客户端的发件箱把 5xx 当临时错误，会一直重发。
          if (err instanceof PairedCommandError) throw new HttpError(PAIRED_COMMAND_STATUS[err.code], err.code, err.message);
          throw err;
        }
        return;
      }

      // Lead 的模型（会话输入框右下角，protocol 的 lead-models.ts）：可选的模型、推理强度、账号前缀和额度封禁。
      if (req.method === "GET" && url.pathname === "/v1/lead/models") {
        requireAuth(req, "chat");
        const service = bridge.uiActionServices?.leadModels;
        if (!service) throw new HttpError(503, "internal_error", "Lead 的模型切换还没有启动");
        let catalog: Awaited<ReturnType<typeof service.catalog>>;
        try {
          catalog = await service.catalog();
        } catch (error) {
          throw new HttpError(503, "internal_error", `读不到模型目录：${error instanceof Error ? error.message : String(error)}`);
        }
        json(req, res, 200, catalog);
        return;
      }

      // 设置 → 模型（protocol 的 model-settings.ts，2026-10-29）：大脑和直觉的分工、服务商和它们的目录、直觉的每一条。
      // 改动走通用的操作入口（POST /v1/actions/model_settings/models/<操作>）。
      if (req.method === "GET" && url.pathname === "/v1/models/settings") {
        requireAuth(req, "tickets:view");
        const service = bridge.uiActionServices?.modelSettings;
        if (!service) throw new HttpError(503, "internal_error", "模型设置还没有启动（Lead 的会话还没建好）");
        let modelSettings: Awaited<ReturnType<typeof service.get>>;
        try {
          modelSettings = await service.get();
        } catch (error) {
          throw new HttpError(503, "internal_error", `读不到模型设置：${error instanceof Error ? error.message : String(error)}`);
        }
        json(req, res, 200, { modelSettings });
        return;
      }

      // 设置 → 记忆的 Hindsight 部分（protocol 的 memory-hindsight.ts，2026-10-29）：摘要模型、写入情况、记忆库的统计。
      // 改动走通用的操作入口（POST /v1/actions/memory_settings/memory/<操作>）。/v1/memory 的 DTO 是严格的契约，不往里加。
      if (req.method === "GET" && url.pathname === "/v1/memory/hindsight") {
        requireAuth(req, "tickets:view");
        const service = bridge.uiActionServices?.memorySettings;
        if (!service) throw new HttpError(503, "internal_error", "这台 daemon 不托管记忆服务（Hindsight）");
        let hindsight: Awaited<ReturnType<typeof service.hindsight>>;
        try {
          hindsight = await service.hindsight();
        } catch (error) {
          throw new HttpError(503, "internal_error", `读不到记忆服务的状态：${error instanceof Error ? error.message : String(error)}`);
        }
        json(req, res, 200, { hindsight });
        return;
      }

      // 设置 → 记忆 → 常驻偏好（protocol 的 core-memory.ts，2026-10-29）：每一条和它最近一次改动、总字数和上限。
      // 只读 notes 和改动记录，daemon 还在启动时也能读。改、删、撤销走通用的操作入口
      // （POST /v1/actions/core_memory/<编号>/<操作>、/v1/actions/core_memory_change/<改动编号>/undo）。
      if (req.method === "GET" && url.pathname === "/v1/memory/preferences") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { preferences: memoryPreferences(bridge.db) });
        return;
      }

      // 自定义控件（protocol 的 widgets.ts，2026-10-30）：视图面板里的全部控件，从上到下，各带所在的视图。只读 widgets 表。
      // 建、改、删、排序、视图改名走通用的操作入口（POST /v1/actions/widget_board/widgets/<操作>、/v1/actions/widget/<编号>/<操作>）。
      if (req.method === "GET" && url.pathname === "/v1/widgets") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { widgets: listWidgets(bridge.db) });
        return;
      }

      // 换 Lead 的模型：操作层的 lead_model / switch，和 Lead 的 switch_lead_model 是同一个操作。
      if (req.method === "POST" && url.pathname === "/v1/lead/model") {
        const auth = requireAuth(req, "chat");
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(LeadModelChoiceSchema, body)) {
          throw new HttpError(400, "invalid_request", "model must be provider/id and effort a level or null");
        }
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "lead_model", id: "lead" }, action: "switch", input: body,
        });
        json(req, res, 200, outcome.result);
        return;
      }

      // Lead 忙时排着的外部消息（主对话输入框上方的排队状态栏，protocol 的 lead-queue.ts，工单 10）。
      // Lead 的会话还没建好时没有排队：回一个空的。
      if (req.method === "GET" && url.pathname === "/v1/lead/queue") {
        requireAuth(req, "chat");
        json(req, res, 200, bridge.uiActionServices?.leadQueue?.snapshot() ?? { busy: false, entries: [] });
        return;
      }

      // 排到下一个、移出队列：操作层的 lead_queue，和 Lead 的 perform_action 是同一个操作。回答是操作以后的排队。
      const leadQueueMatch = url.pathname.match(/^\/v1\/lead\/queue\/(move_next|remove)$/);
      if (req.method === "POST" && leadQueueMatch) {
        const action = leadQueueMatch[1]!;
        const auth = requireAuth(req, uiActionDefinition("lead_queue", action)!.scope);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(LeadQueueActionRequestSchema, body)) throw new HttpError(400, "invalid_request", "key must be a conversation key");
        const outcome = await performUiActionAsUser(req, auth, { target: { type: "lead_queue", id: body.key }, action });
        json(req, res, 200, outcome.result);
        return;
      }

      // 用户排着的一条追问（protocol 的 lead-follow-ups.ts，用户 2026-10-28）：插进这一轮、不再发给 Lead。
      // 操作层的 follow_up，和 Lead 的 perform_action 是同一个操作。回答是这一条现在的放置。
      // 这一条已经交给 Lead（或者不存在）：404；现在插不进（例如要单独开一轮）：409。
      const followUpMatch = url.pathname.match(/^\/v1\/lead\/follow-ups\/(steer|cancel)$/);
      if (req.method === "POST" && followUpMatch) {
        const action = followUpMatch[1]!;
        const auth = requireAuth(req, uiActionDefinition("follow_up", action)!.scope);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(FollowUpActionRequestSchema, body)) throw new HttpError(400, "invalid_request", "turnId must be a turn id");
        const outcome = await performUiActionAsUser(req, auth, { target: { type: "follow_up", id: body.turnId }, action });
        json(req, res, 200, outcome.result);
        return;
      }

      // 用户发给 Lead 的一张图片（protocol 的 chat-images.ts）。会话快照（include=images）里列出 id。
      const chatImageMatch = url.pathname.match(/^\/v1\/chat\/images\/([^/]+)$/);
      if (req.method === "GET" && chatImageMatch) {
        requireAuth(req, "chat");
        const id = chatImageMatch[1]!;
        const image = CHAT_IMAGE_ID_PATTERN.test(id) ? getChatImage(bridge.db, id) : null;
        if (!image) throw new HttpError(404, "not_found", "image not found");
        json(req, res, 200, { id: image.id, mimeType: image.mimeType, data: image.data.toString("base64") });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/overview") {
        requireAuth(req, "tickets:view");
        // ?include=lead：带上 Lead 的模型调用健康。缺省不带：旧客户端严格校验，多一个字段整个快照失败。
        const include = url.searchParams.getAll("include").flatMap((value) => value.split(",")).filter(Boolean);
        if (include.some((value) => value !== "lead")) throw new HttpError(400, "invalid_request", "invalid include");
        json(req, res, 200, service().overview({ includeLead: include.includes("lead") }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/notifications") {
        requireAuth(req, "notices");
        const requestedStates = url.searchParams.getAll("state");
        const states = requestedStates.length
          ? requestedStates.map((state) => {
              if (state !== "pending" && state !== "delivered" && state !== "acked") {
                throw new HttpError(400, "invalid_request", "state must be pending, delivered, or acked");
              }
              return state as NotificationState;
            })
          : ["pending", "delivered"] as NotificationState[];
        const limit = integerParam(url.searchParams.get("limit"), "limit", { defaultValue: 100, min: 1, max: 500 });
        json(req, res, 200, {
          items: listNotifications(bridge.db, { state: states, limit }).map(notificationDto),
        });
        return;
      }

      // 收件箱（companion 左栏）：每张等你的工单为什么在等、从什么时候开始；Lead 自己处理掉的事；你上次看的时间。
      if (req.method === "GET" && url.pathname === "/v1/inbox") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, service().inboxView());
        return;
      }

      // 你看过收件箱了：「Lead 已处理」里这之前的事收成一行。
      if (req.method === "POST" && url.pathname === "/v1/inbox/seen") {
        requireAuth(req, "notices");
        const at = new Date();
        markInboxSeen(bridge.db, at);
        json(req, res, 200, { seenAt: at.toISOString() });
        return;
      }

      const notificationAckMatch = url.pathname.match(/^\/v1\/notifications\/(\d+)\/ack$/);
      if (req.method === "POST" && notificationAckMatch) {
        requireAuth(req, "notices");
        const notificationId = Number(notificationAckMatch[1]);
        const existing = getNotification(bridge.db, notificationId);
        if (!existing) throw new HttpError(404, "not_found", `notification #${notificationId} not found`);
        ackNotification(bridge.db, notificationId);
        const notification = getNotification(bridge.db, notificationId);
        if (!notification) throw new HttpError(500, "internal_error", "acked notification is unavailable");
        publish({
          type: "snapshot.required",
          requiredScope: "notices",
          itemId: notification.item_id ?? undefined,
          payload: { resource: "notifications", notificationId },
        });
        json(req, res, 200, { notification: notificationDto(notification) });
        return;
      }

      // ——— 主人操作的「不是我」（工单 15 第一步）———
      // 读：notices（和通知同一个 scope）。「不是我」：approvals:respond，并且调用方是扫码配对的手机或者网页会话
      // （protocol 的 canDisownOwnerAction）。只作废发出那次操作的凭证，请求体里没有「作废谁」的参数。
      const ownerActionMatch = url.pathname.match(/^\/v1\/owner-actions\/([^/]+)(\/disown)?$/);
      if (ownerActionMatch && (req.method === "GET" || req.method === "POST")) {
        const disown = ownerActionMatch[2] !== undefined;
        if ((req.method === "POST") !== disown) throw new HttpError(404, "not_found", "not found");
        const { binding } = requireAuth(req, disown ? "approvals:respond" : "notices");
        const eventId = decodeURIComponent(ownerActionMatch[1]!);
        if (!isOwnerActionEventId(eventId)) throw new HttpError(400, "invalid_request", "invalid owner action id");
        if (!disown) {
          const view = ownerActionView(bridge.db, eventId);
          if (!view) throw new HttpError(404, "not_found", "owner action not found");
          json(req, res, 200, { ownerAction: view } satisfies OwnerActionResponse);
          return;
        }
        try {
          const view = await disownOwnerAction(ownerActionDeps(), eventId, binding);
          json(req, res, 200, { ownerAction: view } satisfies OwnerActionResponse);
        } catch (err) {
          if (err instanceof OwnerActionError) {
            throw new HttpError(err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 409, err.code, err.message);
          }
          throw err;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/tickets") {
        requireAuth(req, "tickets:create");
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(CreateTicketRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", "invalid ticket input");
        }
        const input = body as CreateTicketRequest;
        if (!input.title.trim() || !input.brief.trim()) {
          throw new HttpError(400, "invalid_request", "title and brief must not be blank");
        }
        if (input.project !== undefined && input.projectId !== undefined) {
          throw new HttpError(400, "invalid_request", "project and projectId are mutually exclusive");
        }
        if (input.workdir !== undefined && !input.workdir.trim()) {
          throw new HttpError(400, "invalid_request", "workdir must not be blank");
        }
        if (input.project !== undefined && !input.project.trim()) {
          throw new HttpError(400, "invalid_request", "project must not be blank");
        }
        if (input.model !== undefined && !input.model.trim()) {
          throw new HttpError(400, "invalid_request", "model must not be blank");
        }
        let itemId: number;
        try {
          itemId = createCoordinator({ db: bridge.db }).createRootItem({
            title: input.title.trim(),
            brief: input.brief.trim(),
            createdBy: "user",
            ...(input.workdir === undefined ? {} : { workdir: input.workdir.trim() }),
            ...(input.workflowKind === undefined ? {} : { workflowKind: input.workflowKind }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.project === undefined ? {} : { project: input.project.trim() }),
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
            ...(input.model === undefined ? {} : { model: input.model.trim() }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            ...(input.verificationPolicy === undefined ? {} : { verificationPolicy: input.verificationPolicy }),
          });
        } catch (err) {
          throw new HttpError(
            400,
            "invalid_request",
            err instanceof Error ? err.message : "item creation failed",
          );
        }
        const created = service().getKernelTicket(itemId);
        if (!created) throw new HttpError(500, "internal_error", "created ticket is unavailable");
        publish({
          type: "ticket.created",
          requiredScope: "tickets:view",
          itemId,
          payload: { ticketId: itemId },
        });
        json(req, res, 201, created);
        return;
      }

      // ——— 管理路由（admin scope，缺省不授予）———
      // 配对码只能换到缺省的 scope：请求体里没有 scopes 字段，多给的字段按非法请求拒绝。
      if (req.method === "POST" && url.pathname === "/v1/admin/pairings") {
        requireAuth(req, ADMIN_SCOPE);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(CreatePairingRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", "invalid pairing input");
        }
        const input = body as CreatePairingRequest;
        const name = input.name.trim();
        if (!name) throw new HttpError(400, "invalid_request", "name must not be blank");
        if (input.endpoint !== undefined) {
          let invitation: ReturnType<typeof createGatewayPairingInvitation>;
          try {
            invitation = createGatewayPairingInvitation(bridge.db, { endpoint: input.endpoint, name, kind: input.kind });
          } catch (err) {
            throw new HttpError(400, "invalid_request", err instanceof Error ? err.message : "invalid endpoint");
          }
          bridge.log(`[gateway] pairing invitation created: ${name} (${input.kind})`);
          json(req, res, 201, {
            pairingId: invitation.pairingId, code: invitation.code, expiresAt: invitation.expiresAt, uri: invitation.uri,
          });
          return;
        }
        const pairing = createPairing(bridge.db, { name, kind: input.kind });
        bridge.log(`[gateway] pairing code created: ${name} (${input.kind})`);
        json(req, res, 201, { pairingId: pairing.pairingId, code: pairing.code, expiresAt: pairing.expiresAt, uri: null });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/bindings") {
        requireAuth(req, ADMIN_SCOPE);
        json(req, res, 200, { items: listBindings(bridge.db).map(adminBinding) });
        return;
      }

      const bindingRevokeMatch = url.pathname.match(/^\/v1\/admin\/bindings\/(\d+)\/revoke$/);
      if (req.method === "POST" && bindingRevokeMatch) {
        const caller = requireAuth(req, ADMIN_SCOPE);
        const bindingId = Number(bindingRevokeMatch[1]);
        if (!getBinding(bridge.db, bindingId)) throw new HttpError(404, "not_found", `binding #${bindingId} not found`);
        // 转调操作层（device 的 revoke，user_direct）：Lead 的 perform_action 调同一个操作，总是被拒。
        await performUiActionAsUser(req, caller, { target: { type: "device", id: bindingId }, action: "revoke" });
        // 已连着的 WebSocket 在下一条事件或命令时按 4001 断开（deliverGatewayEvent / handleClient）。
        bridge.log(`[gateway] binding #${bindingId} revoked`);
        json(req, res, 200, { binding: adminBinding(getBinding(bridge.db, bindingId)!) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/aish") {
        requireAuth(req, ADMIN_SCOPE);
        const status = getAishConnStatus(bridge.db);
        const envToken = (bridge.aishEnvToken ?? (() => process.env.PLC_AISH_TOKEN))();
        json(req, res, 200, {
          stored: status.stored,
          url: status.url,
          failure: status.failure ? { reason: status.failure.reason, at: status.failure.at } : null,
          envToken: aishEnvTokenState(bridge.db, envToken),
        } satisfies AishCredentialStatus);
        return;
      }

      // 只删账本里的凭证。运行中的 aish 连接保持到 daemon 重启。
      if (req.method === "POST" && url.pathname === "/v1/admin/aish/forget") {
        requireAuth(req, ADMIN_SCOPE);
        const removed = forgetAishConn(bridge.db);
        const envToken = (bridge.aishEnvToken ?? (() => process.env.PLC_AISH_TOKEN))();
        if (removed) bridge.log("[gateway] stored aish credential forgotten");
        json(req, res, 200, { removed, envTokenSet: Boolean(envToken) });
        return;
      }

      // ——— runtime 重检（工单 04）：不等退避，马上探针 ———
      if (req.method === "POST" && url.pathname === "/v1/runtimes/recheck") {
        requireAuth(req, ADMIN_SCOPE);
        if (!bridge.recheckRuntimes) throw new HttpError(500, "internal_error", "runtime recheck unavailable");
        const body = req.headers["content-length"] === "0"
          ? {}
          : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        if (!Value.Check(RuntimeRecheckRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", "runtime must be one of pi, codex, claude");
        }
        const results = await bridge.recheckRuntimes((body as { runtime?: KernelRuntimeId }).runtime);
        json(req, res, 200, { results });
        return;
      }

      // 子路由的主人操作记在上一次 requireAuth 的调用方名下。
      let routeCaller: Binding | null = null;
      let routeScopes: Scope[] = [];
      const routeAuth = (scope: Scope): Binding => {
        const auth = requireAuth(req, scope);
        routeCaller = auth.binding;
        routeScopes = auth.scopes;
        return routeCaller;
      };
      const routeOwnerAction = (input: OwnerActionInput) => {
        if (routeCaller) recordOwnerActionFor(req, routeCaller, input);
      };

      if (await handleConnectionRoute({
        req, res, url, service: bridge.connections,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => routeAuth(scope).display_name,
        ownerAction: routeOwnerAction,
      })) return;

      if (await handleMemoryRoute({
        req, res, url, memory: bridge.memory, decisionModel: bridge.decisionModel,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => routeAuth(scope).display_name,
        ownerAction: routeOwnerAction,
      })) return;

      // 首次启动引导（.scratch/onboarding）：7 项关键设置配没配好。daemon 算好存在 kv 里，这里只读。
      if (req.method === "GET" && url.pathname === "/v1/setup") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { setup: loadSetupStatus(bridge.db) } satisfies SetupResponse);
        return;
      }

      // Lead 的名字、人格和互动风格（设置页「身份与风格」）。修改和主人操作在 engine 的 lead-profile.ts。
      if (await handleLeadProfileRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => routeAuth(scope),
        requestSource: (binding) => requestSource(req, binding),
        publish: (resource) => { publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }); },
        log: bridge.log,
      })) return;

      // Lead 的形象（设置页「身份与风格 → 形象」）。修改在 engine 的 lead-avatar.ts。没有改 FairyEye 的路由。
      if (await handleLeadAvatarRoute({
        req, res, url, db: bridge.db, ...(bridge.leadAvatar ? { service: bridge.leadAvatar } : {}),
        json: (status, value, headers) => json(req, res, status, value, headers),
        readBody: async (maxBytes) => parseJson(await readBody(req, Math.max(maxBodyBytes, maxBytes ?? 0))) ?? {},
        requireAuth: (scope) => { routeAuth(scope); },
        publish: (resource) => { publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }); },
        log: bridge.log,
      })) return;

      // 界面的外观偏好（设置页「外观」）。修改和主人操作在 engine 的 design-preferences.ts。
      if (await handleDesignPreferencesRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => routeAuth(scope),
        requestSource: (binding) => requestSource(req, binding),
        publish: (resource) => { publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }); },
        log: bridge.log,
      })) return;

      if (await handleRuntimeSettingsRoute({
        req, res, url, service: bridge.runtimeSettings,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { routeAuth(scope); },
        // 设置页的开关转调操作层（runtime 的 disable、enable），和 Lead 的 perform_action 同一个函数。
        perform: async (request) => {
          const outcome = await performUiActionAsUser(req, { binding: routeCaller!, scopes: routeScopes }, {
            target: { type: "runtime", id: request.runtime }, action: request.enabled ? "enable" : "disable",
          });
          return outcome.result as RuntimeSettingsDto;
        },
      })) return;

      // 工单的每一次交付（工单 04）：交付切换读的快照，只读。
      if (await handleDeliverySnapshotRoute({
        req, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        requireAuth: (scope) => { routeAuth(scope); },
      })) return;

      // 工单操作（spec 5.11）：每个操作现在能不能做，以及执行。实现在 engine 的 ticket-actions/。
      if (await handleTicketActionRoute({
        ...ticketActionContext(),
        req, res, url,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)),
        requireAuth: (scope) => routeAuth(scope),
        requestSource: (binding) => requestSource(req, binding),
        // 操作已经做了：读不到工单摘要（没有控制面）时回 null，不回 500。
        ticket: (itemId) => bridge.controlPlane?.getItem(itemId)?.ticket ?? null,
        flush: () => flushGatewayOutbox(),
        mapError: (error) => mapTicketActionError(error),
        invalid: (message) => { throw new HttpError(400, "invalid_request", message); },
      })) return;

      // 工单的「这次交付」（2026-10-20）：文件列表、全文或改动，验收并合并、开 PR、放弃。
      // 合并、开 PR、放弃转调工单操作层：验收走同一个 completeItem，主人操作和线上事件由操作层记。
      if (await handleDeliveryRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { routeAuth(scope); },
        assertUserActor,
        perform: async (itemId, action, input) => {
          const outcome = await performAsUser(req, routeCaller!, { itemId, action, input });
          flushGatewayOutbox();
          return outcome.result;
        },
        mapError: (error) => mapTicketActionError(error),
      })) return;

      // 工单的执行计划（工单 06）：执行 agent 用 update_ticket_plan 维护的步骤列表。只读。
      if (handleExecutionPlanRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        requireAuth: (scope) => { routeAuth(scope); },
      })) return;

      // 工单的结构化验收标准和你在每次交付上的确认（工单 05）。只读：编辑和确认走工单操作。
      if (await handleAcceptanceCriteriaRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        requireAuth: (scope) => { routeAuth(scope); },
      })) return;

      // 一次交付的核查：核查员看到了什么、逐条结论（工单 10）。只读：派核查、换核查员走工单操作。
      if (await handleReviewRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        requireAuth: (scope) => { routeAuth(scope); },
      })) return;

      // 外部通道的凭据（设置页「消息通道」）：改只接受本机网页。请求体是密钥，不进日志。
      if (await handleChannelSettingsRoute({
        req, res, url, service: bridge.channelSettings,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => routeAuth(scope).display_name,
        loopbackPage: () => isLoopbackPage(req),
        editableHere: () => editableHere(req),
        ownerAction: routeOwnerAction,
      })) return;

      // 外部来源的会话卡（工单 11）：读要 chat，卡上的动作要 tickets:create。卡上的动作是操作层的 channel_card：
      // Lead 代你回复走同一个函数（用户 2026-10-23）。账本和卡上的 by 带上 binding 号，理由同常设指令。
      if (await handleChannelRoute({
        req, res, url, service: bridge.channels,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (cardId, action, input, scope) => {
          const outcome = await performUiActionAsUser(req, requireAuth(req, scope), {
            target: { type: "channel_card", id: cardId }, action, input,
          }, (error) => {
            const reason = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
            const mapped = CHANNEL_ACTION_ERRORS[reason];
            if (!mapped) throw error;
            throw new HttpError(mapped.status, mapped.code, (error as Error).message, { reason });
          });
          return outcome.result as ChannelCardDto;
        },
      })) return;

      // 设置 → 消息通道 → 自动代你处理（2026-10-23）：改参数、测一条消息、评估过去 24 小时的消息都是操作层的 channel_policy，
      // Lead 走 perform_action 调同一个函数。
      if (await handleChannelPolicyRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (source, action, input, scope) => (await performUiActionAsUser(req, requireAuth(req, scope), {
          target: { type: "channel_policy", id: source }, action, input,
        })).result,
        publish: (resource) => { publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }); },
      })) return;

      // 设置 → 消息通道 → 自动代你处理（交接说明，2026-10-30，issue 07）：改、预演都是操作层的 channel_handbook，
      // Lead 走 perform_action 调同一个函数。
      if (await handleHandbookRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (action, input, scope) => (await performUiActionAsUser(req, requireAuth(req, scope), {
          target: { type: "channel_handbook", id: "handbook" }, action, input,
        })).result,
        publish: (resource) => { publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } }); },
      })) return;

      // 设置 → 消息通道 → 代回复风格（2026-10-28）：改和提炼都是操作层的 reply_style，Lead 走 perform_action 调同一个函数。
      if (await handleReplyStyleRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (action, input, scope) => (await performUiActionAsUser(req, requireAuth(req, scope), {
          target: { type: "reply_style", id: "user" }, action, input,
        })).result,
      })) return;

      // 改规则被拦下以后的确认卡（工单 09）：读卡要 tickets:view，「确认这一次」「不改」是操作层的 rule_change.resolve
      // （user_direct），要 approvals:respond。Lead 调同一个操作总是被拒绝。
      if (await handleRuleChangeRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (id, decision) => (await performUiActionAsUser(req, requireAuth(req, "approvals:respond"), {
          target: { type: "rule_change", id }, action: "resolve", input: { decision },
        })).result as { confirmation: RuleChangeConfirmationDto },
      })) return;

      // 定时器带着来源（spec D16，工单 12）：提醒列表里外部的人要求设的定时器、取消（timer.cancel），
      // 和代价不够低时的确认卡（timer_request.resolve，user_direct）。两个都是操作层的操作，Lead 走同一个。
      if (await handleTimerRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => { requireAuth(req, scope); },
        perform: async (target, action, input) => (await performUiActionAsUser(
          req, requireAuth(req, action === "resolve" ? "approvals:respond" : "tickets:create"),
          { target, action, ...(input === undefined ? {} : { input }) },
        )).result,
      })) return;

      // 常设指令（工单 10）：清单、版本历史、执行记录，用户回滚，批准或拒绝 Lead 的提议。
      // resolvedBy 带上 binding 号：设备名是用户起的，不能让它决定「是不是用户」。
      if (await handleStandingOrderRoute({
        req, res, url, db: bridge.db,
        json: (status, value) => json(req, res, status, value),
        readBody: async () => parseJson(await readBody(req, maxBodyBytes)) ?? {},
        requireAuth: (scope) => {
          const binding = routeAuth(scope);
          return `${binding.display_name}（binding ${binding.id}）`;
        },
        publishApprovalResolved: (approvalId, status) => publish({
          type: "approval.resolved", requiredScope: "approvals:respond",
          payload: { approvalId, status, snapshotRequired: true },
        }),
        ownerAction: routeOwnerAction,
      })) return;

      // ——— 用户对 lead 的授权（store/lead-grants.ts）———
      // 与事项动作同一个 scope（tickets:create = 这台设备是主人）、同一道 assertUserActor。
      // 这条路由不接受 actor，也没有任何"代谁授权"的参数位：能按到它的只有用户本人。
      if (url.pathname === "/v1/lead/trust" && (req.method === "GET" || req.method === "POST")) {
        const { binding } = requireAuth(req, "tickets:create");
        const trust = bridge.leadTrust;
        if (!trust) throw new HttpError(500, "internal_error", "lead trust plane unavailable");
        if (req.method === "GET") {
          const capability = url.searchParams.get("capability") ?? "confirm_item";
          json(req, res, 200, { capability, grant: trust.status(assertLeadCapability(capability)) });
          return;
        }
        const body = req.headers["content-length"] === "0"
          ? {}
          : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        assertUserActor(body);
        const input = body as { capability?: unknown; granted?: unknown; note?: unknown };
        const capability = assertLeadCapability(input.capability ?? "confirm_item");
        if (typeof input.granted !== "boolean") {
          throw new HttpError(400, "invalid_request", "granted must be a boolean");
        }
        if (input.granted) {
          const activeBefore = activeLeadGrant(bridge.db, capability);
          const grant = trust.grant(
            capability, grantChannel(binding),
            typeof input.note === "string" ? input.note : undefined,
          );
          recordOwnerActionFor(req, binding, leadTrustOwnerAction(capability, {
            granted: true, grantId: grant.id, changed: activeBefore?.id !== grant.id,
          }, leadDisplayName(bridge.db)));
          json(req, res, 200, { capability, granted: true, grant });
          return;
        }
        const revoked = trust.revoke(capability, grantChannel(binding));
        if (revoked > 0) recordOwnerActionFor(req, binding, leadTrustOwnerAction(capability, { granted: false, revoked }, leadDisplayName(bridge.db)));
        json(req, res, 200, { capability, granted: false, revoked, grant: null });
        return;
      }

      if (url.pathname === "/v1/lead/delegation" && (req.method === "GET" || req.method === "POST")) {
        const { binding } = requireAuth(req, "tickets:create");
        const channel = grantChannel(binding);
        if (req.method === "GET") {
          const itemId = Number(url.searchParams.get("ticket_id") ?? "0");
          if (!Number.isSafeInteger(itemId) || itemId < 1) {
            throw new HttpError(400, "invalid_request", "ticket_id must be a positive integer");
          }
          json(req, res, 200, {
            ticketId: itemId,
            active: activeDelegationPolicy(bridge.db, itemId),
            history: listDelegationPolicies(bridge.db, itemId),
          });
          return;
        }
        const body = req.headers["content-length"] === "0"
          ? {}
          : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        assertUserActor(body);
        const input = body as {
          ticket_id?: unknown;
          granted?: unknown;
          scope?: unknown;
          max_rework_cycles?: unknown;
          budget_limit_tokens?: unknown;
          budget_limit_usd?: unknown;
          effective_until?: unknown;
          start_rework?: unknown;
          require_continuation?: unknown;
          required_capability_id?: unknown;
          accept_without_review?: unknown;
          reason?: unknown;
        };
        const itemId = Number(input.ticket_id);
        if (!Number.isSafeInteger(itemId) || itemId < 1) {
          throw new HttpError(400, "invalid_request", "ticket_id must be a positive integer");
        }
        if (typeof input.granted !== "boolean") {
          throw new HttpError(400, "invalid_request", "granted must be a boolean");
        }
        if (input.granted) {
          const item = getItem(bridge.db, itemId);
          if (input.start_rework === true && (!item || item.stage !== "review")) {
            throw new HttpError(409, "conflict", `ticket #${itemId} is not awaiting review rework`);
          }
          if (!item) throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
          // 授权托管是工单操作 delegate（engine 的 ticket-actions/delegation.ts，工单 11）：这里和 POST /v1/tickets/:id/actions/delegate
          // 调同一个函数。预检没过时照旧返回 409 和整份预检，界面把说明原样显示。
          const delegation: DelegateInput = {
            ...(typeof input.scope === "string" ? { scope: input.scope } : {}),
            ...(typeof input.max_rework_cycles === "number" ? { maxReworkCycles: input.max_rework_cycles } : {}),
            ...(typeof input.budget_limit_tokens === "number" ? { budgetLimitTokens: input.budget_limit_tokens } : {}),
            ...(typeof input.budget_limit_usd === "number" ? { budgetLimitUsd: input.budget_limit_usd } : {}),
            ...(typeof input.effective_until === "string" ? { effectiveUntil: input.effective_until } : {}),
            ...(typeof input.required_capability_id === "number" ? { requiredCapabilityId: input.required_capability_id } : {}),
            requireContinuation: input.require_continuation === true,
            startRework: input.start_rework === true,
            acceptWithoutReview: input.accept_without_review === true,
          };
          let grant: DelegationGrant;
          try {
            grant = grantItemDelegation(bridge.db, item, delegation, { by: BY_USER, createdVia: channel, channel });
          } catch (error) {
            if (!(error instanceof DelegationBlockedError)) throw error;
            json(req, res, 409, {
              error: {
                code: "delegation_preflight_failed",
                // 界面把这句话原样显示给用户（「操作未完成：…」），所以写出没过的检查，不只说「没过」。
                message: error.message,
              },
              preflight: error.preflight,
            });
            return;
          }
          publishGatewayEvent(bridge.db, itemUpdatedEvent(itemId));
          recordOwnerActionFor(req, binding, delegationOwnerAction(bridge.db, itemId, {
            granted: true, policyId: grant.policy.id, reworkStarted: grant.reworkStarted,
          }));
          json(req, res, 200, grant);
          return;
        }
        const revoked = revokeDelegationPolicy(bridge.db, {
          itemId,
          via: channel,
          reason: typeof input.reason === "string" ? input.reason : "revoked by user",
        });
        if (revoked > 0) recordOwnerActionFor(req, binding, delegationOwnerAction(bridge.db, itemId, { granted: false, revoked }));
        json(req, res, 200, { ticketId: itemId, granted: false, revoked });
        return;
      }

      // 关联工单、解除关联转调工单操作层（spec 5.11 的 link、unlink）。请求体照旧校验（reason 必填），响应照旧。
      const relationCreateMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/relations$/);
      if (req.method === "POST" && relationCreateMatch) {
        const { binding } = requireAuth(req, "tickets:create");
        const itemId = Number(relationCreateMatch[1]);
        if (!getItem(bridge.db, itemId)) {
          throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
        }
        const body = parseJson(await readBody(req, maxBodyBytes));
        assertUserActor(body);
        const input = body as Record<string, unknown>;
        const request = {
          targetTicketId: input.targetTicketId,
          relationType: input.relationType,
          executionGate: input.executionGate,
          reason: input.reason,
        };
        if (!Value.Check(LinkTicketRelationRequestSchema, request)) {
          throw new HttpError(400, "invalid_request", "invalid ticket relation input");
        }
        const typed = request as LinkTicketRelationRequest;
        if (!isTicketRelationInputType(typed.relationType)) {
          throw new HttpError(400, "invalid_request", `invalid relation type: ${typed.relationType}`);
        }
        const outcome = await performAsUser(req, binding, {
          itemId,
          action: "link",
          input: {
            targetTicketId: typed.targetTicketId, relationType: typed.relationType,
            ...(typed.executionGate ? { executionGate: typed.executionGate } : {}),
          },
          reason: typed.reason,
        }, "relation");
        flushGatewayOutbox();
        const result = outcome.result as { status: string };
        json(req, res, result.status === "created" ? 201 : 200, result);
        return;
      }

      const relationRevokeMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/relations\/(\d+)\/revoke$/);
      if (req.method === "POST" && relationRevokeMatch) {
        const { binding } = requireAuth(req, "tickets:create");
        const itemId = Number(relationRevokeMatch[1]);
        const relationId = Number(relationRevokeMatch[2]);
        if (!getItem(bridge.db, itemId)) {
          throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
        }
        const existing = bridge.db.prepare(
          "SELECT source_item_id, target_item_id FROM ticket_relations WHERE id=?",
        ).get(relationId) as { source_item_id: number; target_item_id: number } | undefined;
        if (!existing) throw new HttpError(404, "not_found", `ticket relation #${relationId} not found`);
        if (existing.source_item_id !== itemId && existing.target_item_id !== itemId) {
          throw new HttpError(404, "not_found", `ticket relation #${relationId} does not involve ticket #${itemId}`);
        }
        const body = parseJson(await readBody(req, maxBodyBytes));
        assertUserActor(body);
        const request = { reason: (body as Record<string, unknown>).reason };
        if (!Value.Check(RevokeTicketRelationRequestSchema, request)) {
          throw new HttpError(400, "invalid_request", "invalid ticket relation revoke input");
        }
        const typed = request as RevokeTicketRelationRequest;
        const outcome = await performAsUser(req, binding, {
          itemId, action: "unlink", input: { relationId }, reason: typed.reason,
        }, "relation");
        flushGatewayOutbox();
        json(req, res, 200, outcome.result);
        return;
      }

      // ——— Workspace 用户控制面（与 Lead workspace tools 共用 authority）———
      // 转调操作层的 workspace 目标（ui-action-parity plan.md P04）：Lead 的 release_workspace、cleanup_workspace 是同一个操作。
      // 主人操作（真的释放或清理了才记）和 ticket.updated 由操作层写，这里只立刻推出去。
      const workspaceActionMatch = url.pathname.match(/^\/v1\/workspaces\/(\d+)\/(release|cleanup)$/);
      if (req.method === "POST" && workspaceActionMatch) {
        const auth = requireAuth(req, "tickets:create");
        const workspaceId = Number(workspaceActionMatch[1]);
        const action = workspaceActionMatch[2] as "release" | "cleanup";
        const body = req.headers["content-length"] === "0"
          ? {}
          : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        assertUserActor(body);
        const reason = typeof body.reason === "string" ? body.reason : undefined;
        const mergeStatus = action === "release" ? (body as { merge_status?: unknown }).merge_status : undefined;
        // 清理隔离 worktree 不可逆：页面就地确认以后带 confirm: true（没带时操作层回 409，写明会发生什么）。
        const confirm = action === "cleanup" ? (body as { confirm?: unknown }).confirm : undefined;
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "workspace", id: workspaceId }, action,
          input: { ...(mergeStatus === undefined ? {} : { mergeStatus }), ...(confirm === undefined ? {} : { confirm }) },
          ...(reason ? { reason } : {}),
        });
        const result = outcome.result as WorkspaceActionResult;
        flushGatewayOutbox();
        const ticket = service().getItem(result.itemId)?.ticket ?? null;
        json(req, res, 200, {
          workspaceId: result.workspace.id, ownerTicketId: result.itemId,
          action: result.action, status: result.status, ticket,
        });
        return;
      }

      // ——— 手动派发独立核查（工单 #66）———
      // 不是 stage 的一条边，所以不在 USER_ITEM_ACTION_IDS 里：工单停在 review，
      // 只是给最新的交付排一次 reviewer。可不可以派由 reviewState.canRequestReview 同源判断。
      // body 可以带 runtime（2026-10-20）：用户选的核查员，有排着的核查就换它的核查员（engine 的 changeReviewer）。
      const reviewRequestMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/request-review$/);
      if (req.method === "POST" && reviewRequestMatch) {
        const { binding } = requireAuth(req, "tickets:create");
        const itemId = Number(reviewRequestMatch[1]);
        requireUserActions();
        const body = req.headers["content-length"] === "0"
          ? {}
          : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        assertUserActor(body);
        if (!Value.Check(TicketReviewRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", `body must be {} or {"runtime": ${KERNEL_RUNTIME_IDS.join(" | ")}}`);
        }
        if (!getItem(bridge.db, itemId)) {
          throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
        }
        // 转调工单操作层：点名核查员时是 change_reviewer，否则是 request_review。
        const runtime = (body as TicketReviewRequest).runtime;
        const outcome = await performAsUser(req, binding, runtime
          ? { itemId, action: "change_reviewer", input: { runtime } }
          : { itemId, action: "request_review" });
        const result = outcome.result as { dispatchRequestId: number; deliveryRunId: number | null };
        if (result.deliveryRunId === null) {
          throw new HttpError(409, "conflict", `item #${itemId} has no unreviewed delivery to send to an independent reviewer`);
        }
        flushGatewayOutbox();
        json(req, res, 200, {
          ticketId: itemId,
          dispatchRequestId: result.dispatchRequestId,
          deliveryRunId: result.deliveryRunId,
          ticket: service().getItem(itemId)?.ticket ?? null,
        });
        return;
      }

      // ——— 提醒改时间（工单 07）———
      // 「改时间」给 remindAt；「10 分钟后再提醒」给 snoozeMinutes（都不给时是 10 分钟以后）。权限和确认提醒一样（tickets:create）。
      // 工单以外的操作的通用页面入口（genui 卡片上的按钮，2026-10-27）：和 Lead 的 list_actions、perform_action 是同一个函数。
      // 清单只读，要 chat；执行时每个操作要自己登记的 scope（performUserUiAction 检查）。
      const uiActionsMatch = url.pathname.match(/^\/v1\/actions\/([a-z_]+)\/([A-Za-z0-9:_.@-]{1,128})(?:\/([a-z_]+))?$/);
      if (uiActionsMatch && (req.method === "GET" || req.method === "POST")) {
        const [, type, rawId, action] = uiActionsMatch as unknown as [string, string, string, string | undefined];
        const target: UiActionTarget = { type, id: decodeURIComponent(rawId) };
        if (req.method === "GET" && !action) {
          requireAuth(req, "chat");
          try {
            const actions = await listUiActions(bridge.db, target, { services: bridge.uiActionServices ?? {} });
            json(req, res, 200, { target: { type, id: String(target.id) }, actions });
          } catch (error) {
            mapTicketActionError(error);
          }
          return;
        }
        if (req.method === "POST" && action) {
          const auth = requireAuth(req, "chat");
          const body = req.headers["content-length"] === "0" ? {} : parseJson(await readBody(req, maxBodyBytes)) ?? {};
          assertUserActor(body);
          const { actor: _actor, ...request } = body as Record<string, unknown>;
          if (!Value.Check(UiActionRunRequestSchema, request)) throw new HttpError(400, "invalid_request", "body is { input?, reason? }");
          const outcome = await performUiActionAsUser(req, auth, {
            target, action,
            ...((request as UiActionRunRequest).input !== undefined ? { input: (request as UiActionRunRequest).input } : {}),
            ...((request as UiActionRunRequest).reason ? { reason: (request as UiActionRunRequest).reason! } : {}),
          });
          flushGatewayOutbox();
          json(req, res, 200, { target: outcome.target, action: outcome.action, result: outcome.result ?? null });
          return;
        }
      }

      // 改的是时间，不是一条用户的 stage 边：到点的提醒由 system 拉回等待；已确认、已取消的回 409。
      // 转调操作层的 reminder.reschedule（ui-action-parity plan.md P04）：Lead 的 reschedule_reminder 是同一个操作。
      const reminderRescheduleMatch = url.pathname.match(/^\/v1\/reminders\/(\d+)\/reschedule$/);
      if (req.method === "POST" && reminderRescheduleMatch) {
        const auth = requireAuth(req, "tickets:create");
        const itemId = Number(reminderRescheduleMatch[1]);
        const body = req.headers["content-length"] === "0" ? {} : parseJson(await readBody(req, maxBodyBytes)) ?? {};
        assertUserActor(body);
        const { actor: _actor, ...request } = body as Record<string, unknown>;
        if (!Value.Check(ReminderRescheduleRequestSchema, request)) {
          throw new HttpError(400, "invalid_request", "give remindAt (ISO time) or snoozeMinutes (1–1440)");
        }
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "reminder", id: itemId }, action: "reschedule", input: request,
        });
        flushGatewayOutbox();
        const updated = service().getItem(itemId);
        const remindAt = (outcome.result as { to: string }).to;
        json(req, res, 200, { ticketId: itemId, remindAt: updated?.remindAt ?? remindAt, ticket: updated?.ticket ?? null });
        return;
      }

      // ——— 用户控制面（spec §8）———
      // 路由按动作命名而不是 PATCH stage：一条边一个动作，与 §6.4 的矩阵一一对应。
      // 传 stage 的通用写法会让"用户能不能做这一步"退化成一个字符串比较。
      const itemActionMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/([a-z_]+)$/);
      if (req.method === "POST" && itemActionMatch) {
        const action = itemActionMatch[2];
        if (ITEM_ACTIONS.has(action)) {
          const auth = requireAuth(req, "tickets:create");
          const itemId = Number(itemActionMatch[1]);
          const body = req.headers["content-length"] === "0"
            ? {}
            : parseJson(await readBody(req, maxBodyBytes)) ?? {};
          assertUserActor(body);
          if (!getItem(bridge.db, itemId)) {
            throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
          }
          const reason = typeof (body as { reason?: unknown }).reason === "string"
            ? (body as { reason: string }).reason
            : undefined;
          // 每个动作都转调操作层（spec 5.11，ui-action-parity plan.md P03）：和 Lead 同样的检查，主人操作由操作层记。
          if (action === "ack") {
            await performUiActionAsUser(req, auth, {
              target: { type: "reminder", id: itemId }, action: "ack", ...(reason ? { reason } : {}),
            });
          } else {
            const forwarded = TICKET_ACTION_OF_ITEM_ACTION[action as Exclude<UserItemActionId, "ack">];
            await performAsUser(req, auth.binding, {
              itemId, action: forwarded, ...(reason ? { reason } : {}),
              ...(forwarded === "restore" ? { input: restoreInput(body) } : {}),
            });
          }
          // ticket.updated 由操作层写进 outbox。这里只把它立刻推出去，让 companion 先收到事件、再收到响应，不等轮询。
          flushGatewayOutbox();
          const updated = service().getItem(itemId);
          // 响应体是线上契约：键叫 ticketId / ticket，取值来自内部的 item。
          json(req, res, 200, { ticketId: itemId, action, ticket: updated?.ticket ?? null });
          return;
        }
      }

      const runActionMatch = url.pathname.match(/^\/v1\/runs\/(\d+)\/([a-z_]+)$/);
      if (req.method === "POST" && runActionMatch) {
        const action = runActionMatch[2];
        if (RUN_ACTIONS.has(action)) {
          const { binding } = requireAuth(req, "tickets:create");
          const runId = Number(runActionMatch[1]);
          requireUserActions();
          const body = req.headers["content-length"] === "0"
            ? {}
            : parseJson(await readBody(req, maxBodyBytes)) ?? {};
          assertUserActor(body);
          const run = getRun(bridge.db, runId);
          if (!run) throw new HttpError(404, "not_found", `run #${runId} not found`);
          const reason = typeof (body as { reason?: unknown }).reason === "string"
            ? (body as { reason: string }).reason
            : undefined;
          // 转调工单操作层（pause_run、resume_run、stop_run）：同样的检查；暂停和停止的主人操作（状态真的变了才记）、
          // attempt.updated 都由操作层写，这里只立刻推出去。停下一个已经结束的 Run 什么都不做，和以前一样回 200。
          if (!(action === "stop" && isTerminalRunState(run.state))) {
            await performAsUser(req, binding, {
              itemId: run.item_id, action: `${action}_run`, input: { runId }, ...(reason ? { reason } : {}),
            });
          }
          flushGatewayOutbox();
          // 线上响应键 attemptId / state：state 的值也要翻回 settled/crashed。
          const finalState = getRun(bridge.db, runId)?.state;
          json(req, res, 200, {
            attemptId: runId,
            action,
            state: finalState ? toWireAttemptState(finalState) : null,
          });
          return;
        }
      }

      // Lead 处理了、但没有对用户说的事（方案 A「Lead 动态」）。会话的一部分，所以要 chat scope。
      // include=events（工单 06）：从事件日志算的卡片（一个对象一张卡，带依据和版本）和 interrupt 横幅。
      // 不带时是旧的形状：旧客户端按 StrictObject 校验 items，多一个字段就整页失败。
      if (req.method === "GET" && url.pathname === "/v1/lead/activity") {
        requireAuth(req, "chat");
        const limit = integerParam(url.searchParams.get("limit"), "limit", { defaultValue: 100, min: 1, max: 500 })!;
        const include = new Set(url.searchParams.getAll("include").flatMap((value) => value.split(",")).filter(Boolean));
        if (include.has(LEAD_ACTIVITY_INCLUDE)) {
          // include=reminders（工单 07）：再带上会话里的提醒卡。include=setup：首次启动引导的两种卡。
          json(req, res, 200, service().leadActivityView({
            limit, reminders: include.has(LEAD_ACTIVITY_REMINDERS_INCLUDE), setup: include.has(LEAD_ACTIVITY_SETUP_INCLUDE),
          }));
          return;
        }
        json(req, res, 200, { items: service().listLeadActivity({ limit }) });
        return;
      }

      // 用户点了输入框上方横幅的「知道了」（工单 06，spec D10）：写回这条 interrupt 事件的处置。
      // 和确认通知（/v1/notifications/:id/ack）一样要 notices。别的客户端由推送收起横幅。
      const interruptAckMatch = url.pathname.match(/^\/v1\/lead\/interrupts\/(\d+)\/ack$/);
      if (req.method === "POST" && interruptAckMatch) {
        const { binding } = requireAuth(req, "notices");
        const seq = Number(interruptAckMatch[1]);
        let interrupt: LeadInterrupt;
        try {
          interrupt = service().acknowledgeInterrupt(seq, { bindingId: binding.id > 0 ? binding.id : null });
        } catch (error) {
          if (error instanceof InterruptAckError) {
            throw new HttpError(error.code === "not_found" ? 404 : 409, error.code === "not_found" ? "not_found" : "conflict", error.message);
          }
          throw error;
        }
        service().syncLeadActivity(publish);
        json(req, res, 200, { interrupt });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/conversation/turns") {
        const { scopes } = requireAuth(req, "chat");
        const itemId = integerParam(url.searchParams.get("ticket_id"), "ticket_id", { min: 1 });
        const limit = integerParam(url.searchParams.get("limit"), "limit", { defaultValue: 100, min: 1, max: 500 })!;
        // ?include=tool_calls：每一轮带上 toolCalls。?include=surfaces：每一轮带上 Lead 生成的富交互卡片。
        // ?include=placement：用户的轮次带上这条消息怎么放的（工单 04）。
        // ?include=reply_actions：工单 agent 的轮次带上回复在问你要不要做的动作（2026-10-19，protocol 的 ticket-chat.ts）。
        // 不认识的取值拒掉，免得拼错了静默拿不到。
        const include = url.searchParams.getAll("include").flatMap((value) => value.split(",")).filter(Boolean);
        // ?include=images：用户的轮次带上发的图片（protocol 的 chat-images.ts）。
        const known = new Set(["tool_calls", "surfaces", "placement", TICKET_REPLY_ACTIONS_INCLUDE, CHAT_IMAGES_INCLUDE]);
        if (include.some((value) => !known.has(value))) {
          throw new HttpError(400, "invalid_request", "invalid include");
        }
        json(req, res, 200, { items: service().listConversationTurns({
          ...(itemId === undefined ? {} : { itemId }),
          limit,
          ...(include.includes("tool_calls") ? { toolCallScopes: scopes } : {}),
          ...(include.includes("surfaces") ? { surfaceScopes: scopes } : {}),
          ...(include.includes("placement") ? { placement: true } : {}),
          ...(include.includes(TICKET_REPLY_ACTIONS_INCLUDE) ? { replyActions: true } : {}),
          ...(include.includes(CHAT_IMAGES_INCLUDE) ? { images: true } : {}),
        }) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/tickets") {
        requireAuth(req, "tickets:view");
        const rawStatuses = url.searchParams.getAll("status").flatMap((value) => value.split(",")).filter(Boolean);
        if (rawStatuses.some((status) => !Value.Check(TicketStatusSchema, status))) {
          throw new HttpError(400, "invalid_request", "invalid ticket status");
        }
        // 诉求 1 的服务端咽喉：这是任务面板拉的端点，缺省只给 task。
        // 不能指望每个消费方自己记得过滤 kind——companion 就没记得，一条 fired 的提醒
        // 因此并排出现在"进行中"里。提醒有自己的出口：/v1/agenda。
        // 显式 ?kind=reminder|all 仍然拿得到，只是必须开口要。
        // ?view=tasks|drafts|reminders|all 是 store 里定义的预设视图（spec §9）。带了 view 时，
        // kind 只在显式给出时才过滤：reminders 视图本身就只含提醒。
        const rawView = url.searchParams.get("view");
        if (rawView !== null && !(TICKET_LIST_VIEWS as readonly string[]).includes(rawView)) {
          throw new HttpError(400, "invalid_request", "invalid ticket view");
        }
        const rawKind = url.searchParams.get("kind") ?? (rawView === null ? "task" : "all");
        if (!["task", "reminder", "all"].includes(rawKind)) {
          throw new HttpError(400, "invalid_request", "invalid ticket kind");
        }
        json(req, res, 200, { items: service().listItems({
          ...(rawView === null ? {} : { view: rawView as TicketListView }),
          ...(rawKind === "all" ? {} : { kind: rawKind as "task" | "reminder" }),
          ...(rawStatuses.length ? { status: rawStatuses as TicketStatus[] } : {}),
          ...(url.searchParams.has("project") ? { project: url.searchParams.get("project")! } : {}),
          ...(url.searchParams.has("q") ? { text: url.searchParams.get("q")! } : {}),
        }) });
        return;
      }

      const itemMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)$/);
      if (req.method === "GET" && itemMatch) {
        requireAuth(req, "tickets:view");
        const detail = service().getItem(Number(itemMatch[1]));
        if (!detail) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, detail);
        return;
      }

      const activitiesMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/activities$/);
      if (req.method === "GET" && activitiesMatch) {
        requireAuth(req, "tickets:view");
        if (!service().getItem(Number(activitiesMatch[1]))) throw new HttpError(404, "not_found", "ticket not found");
        const afterId = integerParam(url.searchParams.get("after_id"), "after_id", { defaultValue: 0, min: 0 })!;
        const limit = integerParam(url.searchParams.get("limit"), "limit", { defaultValue: 100, min: 1, max: 500 })!;
        json(req, res, 200, { items: service().listActivities(Number(activitiesMatch[1]), {
          afterId,
          limit,
        }) });
        return;
      }

      // 这张工单的核查员和可选的核查员（2026-10-20）。只读，所以和工单详情一样只要 tickets:view。
      const reviewerMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/reviewer$/);
      if (req.method === "GET" && reviewerMatch) {
        requireAuth(req, "tickets:view");
        const info = service().getReviewer(Number(reviewerMatch[1]));
        if (!info) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, info);
        return;
      }

      const runsMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/attempts$/);
      if (req.method === "GET" && runsMatch) {
        requireAuth(req, "tickets:view");
        if (!service().getItem(Number(runsMatch[1]))) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, { items: service().listRuns(Number(runsMatch[1])) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/projects") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { items: service().listProjects() });
        return;
      }

      // 项目卡片（左栏改版阶段 2）：分布、Lead 的一句话、最近动静、最近的截止、累计花费，含归档的项目。
      if (req.method === "GET" && url.pathname === "/v1/projects/overview") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { items: service().projectsOverview() });
        return;
      }

      // 归档或恢复一个项目（决定 7）。每次都记一行 project_changes，actor 是 user。
      const projectStatusMatch = url.pathname.match(/^\/v1\/projects\/(\d+)\/(archive|restore)$/);
      if (req.method === "POST" && projectStatusMatch) {
        requireAuth(req, "tickets:create");
        const projectId = Number(projectStatusMatch[1]);
        const archive = projectStatusMatch[2] === "archive";
        try {
          setProjectStatus(bridge.db, projectId, archive ? "archived" : "active", {
            actor: "user", reason: archive ? "在项目 tab 归档" : "在项目 tab 恢复",
          });
        } catch (error) {
          throw new HttpError(404, "not_found", error instanceof Error ? error.message : `project #${projectId} not found`);
        }
        publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: "projects", projectId } });
        json(req, res, 200, { projectId, status: archive ? "archived" : "active" });
        return;
      }

      // 日程（左栏改版阶段 3）。/v1/agenda 原样保留给旧客户端。
      if (req.method === "GET" && url.pathname === "/v1/timeline") {
        requireAuth(req, "tickets:view");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) throw new HttpError(400, "invalid_request", "from and to are required");
        const timezone = url.searchParams.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!isTimeZone(timezone)) throw new HttpError(400, "invalid_request", "invalid timezone");
        let timeline;
        try {
          timeline = service().timeline({ from, to, timezone });
        } catch (err) {
          throw new HttpError(400, "invalid_request", err instanceof Error ? err.message : "invalid timeline range");
        }
        json(req, res, 200, timeline);
        return;
      }

      // 节点的写入（阶段 3），出处是 user。没有 DELETE：取消就是 state = cancelled，可以恢复。
      // 改动也用 POST：网关的路由都是 GET 和 POST，浏览器的 CORS 预检只放行这两种（实机上 PATCH 被挡住）。
      const milestoneCreateMatch = url.pathname.match(/^\/v1\/tickets\/(\d+)\/milestones$/);
      if (req.method === "POST" && milestoneCreateMatch) {
        requireAuth(req, "tickets:create");
        const itemId = Number(milestoneCreateMatch[1]);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(MilestoneCreateRequestSchema, body)) throw new HttpError(400, "invalid_request", "invalid milestone");
        if (!getItem(bridge.db, itemId)) throw new HttpError(404, "not_found", `ticket #${itemId} not found`);
        let milestone: ItemMilestone;
        try {
          milestone = createMilestone(bridge.db, itemId, {
            kind: body.kind, at: body.at, ...(body.allDay === undefined ? {} : { allDay: body.allDay }),
            ...(body.label === undefined ? {} : { label: body.label }),
          }, { actor: "user" });
        } catch (error) {
          throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "invalid milestone");
        }
        publish({ type: "ticket.updated", requiredScope: "tickets:view", itemId, payload: { ticketId: itemId, snapshotRequired: true } });
        json(req, res, 201, milestoneDto(milestone));
        return;
      }

      const milestonePatchMatch = url.pathname.match(/^\/v1\/milestones\/(\d+)$/);
      if (req.method === "POST" && milestonePatchMatch) {
        // 转调操作层的 milestone.update（ui-action-parity plan.md P04）：Lead 的 update_milestone 是同一个操作。
        const auth = requireAuth(req, "tickets:create");
        const milestoneId = Number(milestonePatchMatch[1]);
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(MilestonePatchRequestSchema, body)) throw new HttpError(400, "invalid_request", "invalid milestone change");
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "milestone", id: milestoneId }, action: "update", input: body,
        });
        flushGatewayOutbox();
        json(req, res, 200, milestoneDto((outcome.result as { milestone: ItemMilestone }).milestone));
        return;
      }

      const kernelProjectMatch = url.pathname.match(/^\/v1\/kernel\/projects\/(\d+)$/);
      if (req.method === "GET" && kernelProjectMatch) {
        requireAuth(req, "tickets:view");
        const project = service().getKernelProject(Number(kernelProjectMatch[1]));
        if (!project) throw new HttpError(404, "not_found", "project not found");
        json(req, res, 200, project);
        return;
      }

      const kernelTicketMatch = url.pathname.match(/^\/v1\/kernel\/tickets\/(\d+)$/);
      if (req.method === "GET" && kernelTicketMatch) {
        requireAuth(req, "tickets:view");
        const item = service().getKernelTicket(Number(kernelTicketMatch[1]));
        if (!item) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, item);
        return;
      }

      const kernelCheckpointMatch = url.pathname.match(/^\/v1\/kernel\/tickets\/(\d+)\/checkpoints$/);
      if (req.method === "GET" && kernelCheckpointMatch) {
        requireAuth(req, "tickets:view");
        const query = checkpointQuery(url);
        const page = service().listKernelCheckpoints(Number(kernelCheckpointMatch[1]), {
          ...("after_id" in query ? { afterId: query.after_id } : {}),
          ...("before_id" in query ? { beforeId: query.before_id } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        if (!page) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, page);
        return;
      }

      const kernelCheckpointV2Match = url.pathname.match(
        /^\/v1\/kernel\/v2\/tickets\/(\d+)\/checkpoints$/,
      );
      if (req.method === "GET" && kernelCheckpointV2Match) {
        requireAuth(req, "tickets:view");
        const query = checkpointQuery(url);
        const page = service().listKernelCheckpointsV2(Number(kernelCheckpointV2Match[1]), {
          ...("after_id" in query ? { afterId: query.after_id } : {}),
          ...("before_id" in query ? { beforeId: query.before_id } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        if (!page) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, page);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/work-items") {
        requireAuth(req, "tickets:view");
        const query = workItemQuery(url);
        json(req, res, 200, { items: service().listKernelWorkItems(query.ticket_id) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/v2/work-items") {
        requireAuth(req, "tickets:view");
        const query = workItemQuery(url);
        json(req, res, 200, { items: service().listKernelWorkItemsV2(query.ticket_id) });
        return;
      }

      const kernelWorkbenchMatch = url.pathname.match(/^\/v1\/kernel\/tickets\/(\d+)\/workbench$/);
      if (req.method === "GET" && kernelWorkbenchMatch) {
        requireAuth(req, "tickets:view");
        const workbench = service().getKernelTicketWorkbench(Number(kernelWorkbenchMatch[1]));
        if (!workbench) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, workbench);
        return;
      }

      const kernelWorkbenchV2Match = url.pathname.match(
        /^\/v1\/kernel\/v2\/tickets\/(\d+)\/workbench$/,
      );
      if (req.method === "GET" && kernelWorkbenchV2Match) {
        requireAuth(req, "tickets:view");
        const workbench = service().getKernelTicketWorkbenchV2(Number(kernelWorkbenchV2Match[1]));
        if (!workbench) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, workbench);
        return;
      }

      const kernelArtifactListMatch = url.pathname.match(
        /^\/v1\/kernel\/v1\/tickets\/(\d+)\/artifacts$/,
      );
      if (req.method === "GET" && kernelArtifactListMatch) {
        requireAuth(req, "tickets:view");
        assertQueryKeys(url, []);
        const items = service().listKernelArtifacts(Number(kernelArtifactListMatch[1]));
        if (!items) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, { items });
        return;
      }

      const kernelArtifactContentMatch = url.pathname.match(
        /^\/v1\/kernel\/v1\/tickets\/(\d+)\/artifacts\/(\d+)\/content$/,
      );
      if (req.method === "GET" && kernelArtifactContentMatch) {
        requireAuth(req, "tickets:view");
        assertQueryKeys(url, []);
        try {
          const content = service().openKernelArtifactContent(
            Number(kernelArtifactContentMatch[1]),
            Number(kernelArtifactContentMatch[2]),
          );
          await sendArtifactContent(req, res, content);
        } catch {
          throw new HttpError(404, "not_found", "artifact not found");
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/interventions") {
        requireAuth(req, "approvals:respond");
        const query = interventionQuery(url);
        json(req, res, 200, { items: service().listKernelInterventions({
          ...(query.ticket_id === undefined ? {} : { itemId: query.ticket_id }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.id === undefined ? {} : { ids: query.id }),
        }) });
        return;
      }

      const kernelInterventionResolveMatch = url.pathname.match(/^\/v1\/kernel\/interventions\/([^/]+)\/resolve$/);
      if (req.method === "POST" && kernelInterventionResolveMatch) {
        const auth = requireAuth(req, "approvals:respond");
        const interventionId = decodeURIComponent(kernelInterventionResolveMatch[1]);
        if (!Value.Check(KernelInterventionIdSchema, interventionId)) {
          throw new HttpError(400, "invalid_request", "invalid intervention id");
        }
        const body = parseJson(await readBody(req, maxBodyBytes));
        if (!Value.Check(ResolveKernelInterventionRequestSchema, body)) {
          throw new HttpError(400, "invalid_request", "invalid intervention resolution");
        }
        const input = body as ResolveKernelInterventionRequest;
        const approvalId = interventionId.startsWith("approval:")
          ? Number(interventionId.slice("approval:".length))
          : null;
        const decisionId = interventionId.startsWith("decision:")
          ? Number(interventionId.slice("decision:".length))
          : null;
        if ((approvalId !== null) !== (input.authority === "approval")) {
          throw new HttpError(400, "invalid_request", "intervention authority does not match path");
        }
        // 审批和决定请求转调操作层（P02，approval、decision 的 resolve）：和 Lead 的 perform_action（approval、decision 的 resolve）
        // 是同一个操作。主人操作由操作层记在这个凭证名下。
        if (approvalId !== null && input.authority === "approval") {
          const outcome = await performUiActionAsUser(req, auth, {
            target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: input.decision },
          }, mapInterventionError);
          json(req, res, 200, { status: (outcome.result as { status: string }).status, interventionId });
          return;
        }
        if (decisionId === null || input.authority !== "decision_request") {
          throw new HttpError(400, "invalid_request", "intervention authority does not match path");
        }
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "decision", id: decisionId },
          action: "resolve",
          input: input.decision === "select" ? { decision: "select", optionId: input.optionId }
            : input.decision === "respond" ? { decision: "respond", resolution: input.resolution }
            : { decision: "dismiss" },
          ...(input.decision === "dismiss" && input.reason ? { reason: input.reason } : {}),
        }, mapInterventionError);
        json(req, res, 200, { status: (outcome.result as { status: string }).status, interventionId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/conversation/cards") {
        requireAuth(req, "tickets:view");
        const query = conversationCardQuery(url);
        json(req, res, 200, service().listKernelConversationCards({
          ...("after_id" in query ? { afterId: query.after_id } : {}),
          ...("before_id" in query ? { beforeId: query.before_id } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.ticket_id === undefined ? {} : { itemIds: query.ticket_id }),
          ...(query.key === undefined ? {} : { keys: query.key }),
        }));
        return;
      }

      const kernelChildrenMatch = url.pathname.match(/^\/v1\/kernel\/tickets\/(\d+)\/children$/);
      if (req.method === "GET" && kernelChildrenMatch) {
        requireAuth(req, "tickets:view");
        const items = service().listKernelChildren(Number(kernelChildrenMatch[1]));
        if (!items) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, { items });
        return;
      }

      const kernelDependenciesMatch = url.pathname.match(/^\/v1\/kernel\/tickets\/(\d+)\/dependencies$/);
      if (req.method === "GET" && kernelDependenciesMatch) {
        requireAuth(req, "tickets:view");
        const items = service().listKernelDependencies(Number(kernelDependenciesMatch[1]));
        if (!items) throw new HttpError(404, "not_found", "ticket not found");
        json(req, res, 200, { items });
        return;
      }

      const kernelAttemptMatch = url.pathname.match(/^\/v1\/kernel\/attempts\/(\d+)$/);
      if (req.method === "GET" && kernelAttemptMatch) {
        requireAuth(req, "tickets:view");
        const run = service().getKernelAttempt(Number(kernelAttemptMatch[1]));
        if (!run) throw new HttpError(404, "not_found", "attempt not found");
        json(req, res, 200, run);
        return;
      }

      const kernelAttemptEventsMatch = url.pathname.match(/^\/v1\/kernel\/attempts\/(\d+)\/events$/);
      if (req.method === "GET" && kernelAttemptEventsMatch) {
        requireAuth(req, "tickets:view");
        const items = service().listKernelAttemptEvents(Number(kernelAttemptEventsMatch[1]));
        if (!items) throw new HttpError(404, "not_found", "attempt not found");
        json(req, res, 200, { items });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/learning/candidates") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { items: service().listKernelLearningCandidates() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/kernel/capabilities") {
        requireAuth(req, "tickets:view");
        json(req, res, 200, { items: service().listKernelCapabilities() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/agenda") {
        requireAuth(req, "tickets:view");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) throw new HttpError(400, "invalid_request", "from and to are required");
        // ?include=overdue 再带上范围之前过期的条目（日程的「已过期」区）。
        const include = url.searchParams.getAll("include").flatMap((value) => value.split(",")).filter(Boolean);
        if (include.some((value) => value !== "overdue")) throw new HttpError(400, "invalid_request", "invalid include");
        try {
          json(req, res, 200, { items: service().agenda({
            from, to,
            timezone: url.searchParams.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            includeOverdue: include.includes("overdue"),
          }) });
        } catch (err) {
          throw new HttpError(400, "invalid_request", err instanceof Error ? err.message : "invalid agenda range");
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/approvals") {
        requireAuth(req, "approvals:respond");
        json(req, res, 200, { items: service().listApprovals() });
        return;
      }

      const approvalMatch = url.pathname.match(/^\/v1\/approvals\/(\d+)\/resolve$/);
      if (req.method === "POST" && approvalMatch) {
        const auth = requireAuth(req, "approvals:respond");
        const approvalId = Number(approvalMatch[1]);
        const body = parseJson(await readBody(req, maxBodyBytes));
        const command = { authority: "approval", ...body };
        if (!Value.Check(ResolveKernelInterventionRequestSchema, command) || command.authority !== "approval") {
          throw new HttpError(400, "invalid_request", "invalid approval decision");
        }
        // 转调操作层（P02，approval 的 resolve），和 Lead 的 perform_action 是同一个操作。
        const outcome = await performUiActionAsUser(req, auth, {
          target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: command.decision },
        }, mapInterventionError);
        const { approval } = outcome.result as { approval: { status: string; session_exempt: number } };
        json(req, res, 200, { approvalId, status: approval.status, sessionExempt: Boolean(approval.session_exempt) });
        return;
      }

      throw new HttpError(404, "not_found", "not found");
    } catch (err) {
      error(req, res, err);
    }
  });

  // 带图片的 chat.send 有几 MB（protocol 的 CHAT_SEND_MAX_BYTES）。连上 WebSocket 要先配对，发命令的都是配对过的客户端。
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(maxBodyBytes, CHAT_SEND_MAX_BYTES) });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/paired/connect") {
      if (!allowsWebSocketOrigin(req)) {
        bridge.log(`[gateway] websocket origin rejected: ${req.headers.origin} host=${req.headers.host}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // 对端是不是这台机器：本机网页的邀请只有被另一台设备兑换，才算扫码配对的手机（工单 15）。
      const fromThisMachine = peerIsThisMachine(req.socket.remoteAddress, req.socket.localAddress);
      wss.handleUpgrade(req, socket, head, (ws) => handlePairingClient(ws, fromThisMachine));
      return;
    }
    if (url.pathname !== "/v1/paired/events") { socket.destroy(); return; }
    if (!allowsWebSocketOrigin(req)) {
      bridge.log(`[gateway] websocket origin rejected: ${req.headers.origin} host=${req.headers.host}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    let binding: Binding | null = null;
    // 查询参数名是线上契约：companion 发的是 ?ticket=…，不随内部改名走。
    const oneTime = url.searchParams.get("ticket");
    if (oneTime) {
      const issued = wsTickets.get(oneTime);
      wsTickets.delete(oneTime);
      if (issued && issued.expiresAt > Date.now()) binding = getBinding(bridge.db, issued.bindingId);
      if (binding?.status !== "active") binding = null;
    } else {
      const token = bearerOf(req);
      binding = token ? authenticateToken(bridge.db, token) : null;
    }
    if (!binding) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const v2 = url.searchParams.get("protocol") === String(PROTOCOL_VERSION);
    // after_seq=-1：不回放历史，只收连上之后的新事件（plc chat 用它）。其他取值按游标回放。
    const rawAfterSeq = url.searchParams.get("after_seq");
    const afterSeq = rawAfterSeq === "-1" ? -1 : Math.max(0, Number(rawAfterSeq ?? 0) || 0);
    // include=lead_health 等：这个连接要收哪些选收事件。不认识的取值忽略（旧 daemon 也忽略这个参数）。
    const includes = new Set(url.searchParams.getAll("include").flatMap((value) => value.split(",")).filter(Boolean));
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, binding!, v2, afterSeq, includes));
  });

  function sendWs(ws: WsSocket, value: unknown): void {
    try { ws.send(JSON.stringify(value)); } catch { /* closed */ }
  }

  function handlePairingClient(ws: WsSocket, fromThisMachine: boolean): void {
    let stage: "hello" | "confirm" | "done" = "hello";
    let pairingId = 0;
    let challenge = "";
    let sessionKey: Uint8Array | null = null;
    const timer = setTimeout(() => {
      sendPairingFailure(ws, "timeout", "pairing handshake timed out");
    }, pairingHandshakeTimeoutMs);

    const cleanup = () => clearTimeout(timer);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    ws.on("message", (raw) => {
      if (stage === "done") return;
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        sendPairingFailure(ws, "invalid_request", "invalid pairing JSON");
        return;
      }

      if (stage === "hello") {
        if (!Value.Check(PairHelloSchema, message)) {
          sendPairingFailure(ws, "invalid_request", "invalid pair.hello message");
          return;
        }
        const hello = message as {
          pairingId: number;
          clientPublicKey: string;
        };
        const pending = getPendingPairingById(bridge.db, hello.pairingId);
        if (!pending) {
          sendPairingFailure(ws, "invalid_pairing", "pairing offer is invalid, expired, or already used");
          return;
        }
        try {
          sessionKey = derivePairingSessionKey(
            gatewayIdentity.secretKey,
            hexToBytes(hello.clientPublicKey),
            hexToBytes(pending.socketSecretHash),
          );
        } catch {
          sendPairingFailure(ws, "invalid_request", "invalid client public key");
          return;
        }
        pairingId = pending.id;
        challenge = randomBytes(24).toString("hex");
        stage = "confirm";
        sendWs(ws, {
          type: "pair.challenge",
          protocolVersion: PROTOCOL_VERSION,
          daemonPublicKey: bytesToHex(gatewayIdentity.publicKey),
          envelope: sealPairingPayload({
            type: "pair.challenge",
            pairingId,
            challenge,
            expiresAt: pending.expiresAt,
          }, sessionKey, randomBytes(24)),
        });
        return;
      }

      if (!Value.Check(PairConfirmSchema, message) || !sessionKey) {
        sendPairingFailure(ws, "invalid_request", "invalid pair.confirm message");
        return;
      }
      try {
        const payload = openPairingPayload((message as any).envelope, sessionKey) as {
          type?: unknown; pairingId?: unknown; challenge?: unknown;
        };
        if (
          payload?.type !== "pair.confirm" ||
          payload.pairingId !== pairingId ||
          payload.challenge !== challenge
        ) {
          throw new Error("pairing proof mismatch");
        }
        const paired = redeemPairingById(bridge.db, pairingId, { peerIsThisMachine: fromThisMachine });
        stage = "done";
        clearTimeout(timer);
        bridge.log(`[gateway] socket pairing redeemed: ${paired.binding.display_name}`);
        ws.send(JSON.stringify({
          type: "pair.accepted",
          protocolVersion: PROTOCOL_VERSION,
          envelope: sealPairingPayload({
            type: "pair.accepted",
            binding: safeBinding(paired.binding),
            access_token: paired.accessToken,
          }, sessionKey, randomBytes(24)),
        }), () => ws.close(1000, "paired"));
      } catch {
        sendPairingFailure(ws, "invalid_proof", "encrypted pairing proof is invalid");
      }
    });
  }

  function sendPairingFailure(ws: WsSocket, code: string, message: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      type: "pair.error",
      protocolVersion: PROTOCOL_VERSION,
      error: { code, message },
    }), () => ws.close(4003, code.slice(0, 120)));
  }

  function sendCommandError(
    ws: WsSocket,
    id: string,
    code: "invalid_request" | "forbidden" | "not_found" | "conflict" | "protocol_version_unsupported" | "internal_error",
    message: string,
  ): void {
    sendWs(ws, { type: "command.result", id, success: false, error: { code, message } });
  }

  function replay(
    ws: WsSocket,
    binding: Binding,
    scopes: Scope[],
    afterSeq: number,
    throughSeq: number,
    includes: ReadonlySet<string>,
  ): { count: number; lastSeq: number } {
    let cursor = afterSeq;
    let count = 0;
    for (;;) {
      const events = listGatewayEvents(bridge.db, {
        afterSeq: cursor,
        throughSeq,
        bindingId: binding.id,
        scopes,
      });
      if (!events.length) break;
      const wanted = events.filter((event) => wantsEvent(event, includes));
      for (const event of wanted) sendWs(ws, event);
      count += wanted.length;
      cursor = events[events.length - 1]!.seq;
      if (events.length < 500) break;
    }
    return { count, lastSeq: throughSeq };
  }

  function handleV2Command(ws: WsSocket, binding: Binding, scopes: Scope[], raw: unknown): void {
    const candidate = raw as { id?: unknown; protocolVersion?: unknown; type?: unknown };
    const id = typeof candidate?.id === "string" ? candidate.id : "unknown";
    if (candidate?.protocolVersion !== undefined && candidate.protocolVersion !== PROTOCOL_VERSION) {
      sendCommandError(ws, id, "protocol_version_unsupported", `supported protocol version: ${PROTOCOL_VERSION}`);
      return;
    }
    if (!Value.Check(WsCommandSchema, raw)) {
      sendCommandError(ws, id, "invalid_request", "invalid WebSocket command");
      return;
    }
    const command = raw as WsCommand;
    if (command.type === "chat.send") {
      if (!scopes.includes("chat")) {
        sendCommandError(ws, command.id, "forbidden", "missing scope: chat");
        return;
      }
      try {
        const result = executeChatCommand(command, binding);
        sendWs(ws, { type: "command.result", id: command.id, success: true, data: result });
      } catch (err) {
        sendCommandError(
          ws,
          command.id,
          err instanceof PairedCommandError ? err.code : "internal_error",
          err instanceof Error ? err.message : "chat failed",
        );
      }
      return;
    }
    if (command.type === "status.get") {
      sendWs(ws, { type: "command.result", id: command.id, success: true, data: bridge.hello() });
      return;
    }
    if (command.type === "presence.set") {
      const client = v2Clients.get(ws);
      if (client) client.attended = command.attended;
      sendWs(ws, { type: "command.result", id: command.id, success: true, data: { attended: command.attended } });
      return;
    }
    const clientState = v2Clients.get(ws);
    const replayBoundary = latestGatewaySeq(bridge.db);
    const replayed = replay(
      ws,
      binding,
      scopes,
      Math.max(command.afterSeq, clientState?.lastSentSeq ?? command.afterSeq),
      replayBoundary,
      clientState?.includes ?? new Set(),
    );
    if (clientState) clientState.lastSentSeq = Math.max(clientState.lastSentSeq, replayed.lastSeq);
    sendWs(ws, {
      type: "command.result", id: command.id, success: true,
      data: { replayed: replayed.count, latestSeq: replayBoundary },
    });
  }

  function handleClient(
    ws: WsSocket, binding: Binding, v2: boolean, afterSeq: number, includes: ReadonlySet<string>,
  ): void {
    bridge.log(`[gateway] paired client connected: ${binding.display_name}`);
    trackLiveness(ws);
    const send = (obj: unknown) => sendWs(ws, obj);
    const scopes = bindingScopes(binding);
    const detach = v2 ? () => {} : bridge.addClient(send);
    if (v2) {
      const baselineSeq = latestGatewaySeq(bridge.db);
      const clientState = {
        bindingId: binding.id,
        scopes,
        lastSentSeq: afterSeq >= 0 ? afterSeq : baselineSeq,
        attended: false,
        includes,
      };
      v2Clients.set(ws, clientState);
    clientSeen = true;
      const daemon = bridge.hello();
      send({
        type: "hello.v2",
        protocolVersion: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        latestSeq: baselineSeq,
        capabilities: [
          "snapshots",
          "event-replay",
          "item-context-chat",
          "scoped-events",
          "kernel.checkpoints.v1",
          KERNEL_FIDELITY_CAPABILITIES.checkpoints,
          "kernel.interventions.v1",
          "kernel.work-items.v1",
          KERNEL_FIDELITY_CAPABILITIES.workItems,
          "kernel.ticket-workbench.v1",
          KERNEL_FIDELITY_CAPABILITIES.workbench,
          KERNEL_FIDELITY_CAPABILITIES.artifacts,
          "kernel.conversation-cards.v1",
          CHAT_CLIENT_MESSAGE_ID_CAPABILITY,
          CHAT_PLACEMENT_CAPABILITY,
          // 排着的追问能插进这一轮、能取消（daemon 交来了这个服务时）。
          ...(bridge.uiActionServices?.followUps ? [CHAT_FOLLOW_UP_ACTIONS_CAPABILITY] : []),
          // Lead 的会话收图片（只有 chatV2 的桥接收）。
          ...(bridge.chatV2 ? [CHAT_IMAGES_CAPABILITY] : []),
          // Lead 的形象（/v1/lead/avatar 的路由，protocol 的 lead-avatar.ts）。这个网关总有这些路由。
          LEAD_AVATAR_CAPABILITY,
          // 不再宣布 chat.ticket-answerer.v1（2026-10-19）：新客户端据此不带 context.answerer。
        ],
        binding: safeBinding(binding),
        daemon: {
          model: String(daemon.model ?? "unknown"),
          sessionId: String(daemon.sessionId ?? "unknown"),
          busy: Boolean(daemon.busy),
        },
      });
      if (afterSeq >= 0) {
        const replayed = replay(ws, binding, scopes, afterSeq, baselineSeq, includes);
        clientState.lastSentSeq = Math.max(clientState.lastSentSeq, replayed.lastSeq);
      }
    } else {
      send({ type: "hello", ...bridge.hello(), binding: safeBinding(binding) });
    }
    ws.on("message", (raw) => {
      const current = getBinding(bridge.db, binding.id);
      if (!current || current.status !== "active") { ws.close(4001, "binding revoked"); return; }
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const currentScopes = bindingScopes(current);
      if (v2) {
        handleV2Command(ws, current, currentScopes, msg);
        return;
      }
      if (msg.type === "chat" && typeof msg.message === "string") {
        if (!currentScopes.includes("chat")) { send({ type: "response", id: msg.id, success: false, error: "missing scope: chat" }); return; }
        const result = bridge.chat(msg.message, { label: `paired:${binding.kind}:${binding.display_name}` });
        send({ type: "response", id: msg.id, success: true });
        if (result === "steered") send({ type: "steered" });
      } else if (msg.type === "status") {
        send({ type: "response", id: msg.id, success: true, data: bridge.hello() });
      }
    });
    const cleanup = () => { detach(); v2Clients.delete(ws); };
    ws.on("close", () => { cleanup(); bridge.log(`[gateway] paired client left: ${binding.display_name}`); });
    ws.on("error", cleanup);
  }

  function publish(args: Parameters<typeof publishGatewayEvent>[1]): GatewayEvent {
    const event = publishGatewayEvent(bridge.db, args);
    flushGatewayOutbox();
    return event;
  }

  // 端口被占用之类的 listen 错误交给调用方决定（daemon 对缺省端口会退回随机端口）。
  // listen 成功之后的错误只记日志，outbox 照常推送。
  try {
    await listenOnce(server, { port: opts.port, host: listenHost }, (err) => {
      bridge.log(`[gateway] server error: ${err.message}`);
    });
  } catch (err) {
    clearNodeInterval(outboxTimer);
    clearNodeInterval(heartbeatTimer);
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  bridge.log(`[gateway] paired plane listening on ${listenHost}:${port}`);
  return {
    port,
    publish,
    chatListenerCount,
    clientSeenSinceStart: () => clientSeen,
    issueAdminToken,
    listenAlso: async (host, port) => {
      // 另开一个 TCP 监听，把连接交给同一个 HTTP server（升级成 WebSocket 也走它）。
      // net.Server.close 会等它接进来的连接自己断开，所以关的时候主动断开它们，否则停机会卡住。
      const accepted = new Set<import("node:net").Socket>();
      const extra = createNetServer((socket) => {
        accepted.add(socket);
        socket.once("close", () => accepted.delete(socket));
        server.emit("connection", socket);
      });
      await listenOnce(extra, { port, host }, (err) => bridge.log(`[gateway] ${host}:${port} error: ${err.message}`));
      const close = () => new Promise<void>((done) => {
        extraListeners.delete(extra);
        for (const socket of accepted) socket.destroy();
        accepted.clear();
        extra.close(() => done());
      });
      extraListeners.set(extra, close);
      return { port: (extra.address() as AddressInfo).port, close };
    },
    close: () => new Promise<void>((done) => {
      clearNodeInterval(outboxTimer);
      clearNodeInterval(heartbeatTimer);
      for (const close of [...extraListeners.values()]) void close();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => done());
    }),
  };
}
