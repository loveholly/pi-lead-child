// /v1/channels/cards 的路由（Lead 事件主干 spec D10、D14，工单 11）：外部来源的会话卡，和卡上的动作。
// 契约见 protocol 的 channels.ts。
//
// 权限照现有的 scope 规则，按动作检查（protocol 的 CHANNEL_CARD_ACTION_SCOPES）：
//   - 读：chat（卡是会话的一部分）。
//   - 卡上的动作：tickets:create（「这台设备是主人」）。用草稿回复是以用户的身份在外部来源里发言，和别的修改一样要主人的设备。
// 先认调用方是谁，再读请求体（要知道是哪个动作），最后按动作查 scope。
// 请求体只有动作、看到的版本和用户写的文字，没有「代谁决定」的参数。
// 卡里的图片（工单 #529）：GET /v1/channels/files/:fileId，读要 chat。只收 Slack 的文件编号、只回图片（protocol 的 channel-files.ts）。
// 卡上的动作是操作层的操作（engine 的 ui-actions/ 的 channel_card，仓库 AGENTS.md「UI Actions」）：Lead 代你回复走同一个函数
// （用户 2026-10-23）。这里只校验请求体，再交给 perform（网关以你本人的名义调 runUiAction）。卡的状态和发送都在 daemon 的
// 通道 hub 里：发回复要用适配器和凭据，不在网关里。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  CHANNEL_CARD_ACTION_SCOPES, CHANNEL_CARD_ACTIONS, CHANNEL_CARD_NOTE_ACTIONS, CHANNEL_CARD_NOTE_MAX, CHANNEL_CARD_TEXT_ACTIONS,
  CHANNEL_CARD_TEXT_MAX, CHANNEL_CARDS_INCLUDE_LINKS, CHANNEL_FILE_ID_PATTERN, CHANNEL_FILE_MAX_BYTES, CHANNEL_IMAGE_CACHE_SECONDS,
  ChannelCardActionRequestSchema, channelCardWithoutLinks, sniffChatImageMimeType,
  type ChannelCardAction, type ChannelCardDto, type ChannelImage, type Scope,
} from "@pi-lead-child/protocol";

/** daemon 提供的卡片列表。卡上的动作经操作层（ChannelRouteContext.perform）。 */
export interface ChannelCardService {
  list(limit: number): ChannelCardDto[];
  // 按文件编号取消息附带的文件（通道 hub 的 readFile，和 Lead 的 read_channel_file 同一个函数）。没有时取图回 503。
  readFile?(fileId: string, maxBytes: number): Promise<{ id: string; name: string; mimeType: string; data: Uint8Array }>;
  // 这个文件编号在收到过的消息里出现过没有（通道 hub 的 fileOrigin）。
  fileKnown?(fileId: string): boolean;
}

export interface ChannelRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  service: ChannelCardService | undefined;
  json(status: number, value: unknown, headers?: Record<string, string>): void;
  readBody(): Promise<Record<string, unknown>>;
  // 检查 scope。不给 scope 时只认调用方（没有凭证时 401）。
  requireAuth(scope?: Scope): void;
  // 以你本人的名义做卡上的一个动作（操作层的 channel_card），返回卡的新样子。出错时抛 HttpError（网关按错误码映射）。
  perform(
    cardId: number, action: ChannelCardAction,
    input: { expectedVersion?: number; text?: string; note?: string; emoji?: string; react?: boolean }, scope: Scope,
  ): Promise<ChannelCardDto>;
}

/** 通道 hub 的错误码（engine 的 ChannelActionError）→ HTTP 状态和线上的错误码。具体原因放在 details.reason。 */
export const CHANNEL_ACTION_ERRORS: Record<string, { status: number; code: "not_found" | "conflict" | "internal_error" }> = {
  not_found: { status: 404, code: "not_found" },
  conflict: { status: 409, code: "conflict" },
  invalid_action: { status: 409, code: "conflict" },
  outbound_failed: { status: 502, code: "internal_error" },
  unavailable: { status: 503, code: "internal_error" },
};

const CARD_ACTION_PATH = /^\/v1\/channels\/cards\/([1-9][0-9]{0,15})\/actions$/;
const FILE_PATH = /^\/v1\/channels\/files\/([^/]+)$/;

// 客户端要不要卡上每条消息的链接（?include=links，见 protocol 的 CHANNEL_CARDS_INCLUDE_LINKS）。
function wantsLinks(url: URL): boolean {
  return url.searchParams.getAll("include").flatMap((value) => value.split(",")).includes(CHANNEL_CARDS_INCLUDE_LINKS);
}

const fileNotFound = (context: ChannelRouteContext, reason: string, message = "file not found") =>
  context.json(404, { error: { code: "not_found", message, details: { reason } } });

// 外来消息卡里的一张图片（工单 #529，protocol 的 channel-files.ts）：只收 Slack 的文件编号，只回图片。
async function serveImage(context: ChannelRouteContext, raw: string): Promise<void> {
  context.requireAuth("chat");
  let fileId: string;
  try {
    fileId = decodeURIComponent(raw);
  } catch {
    fileNotFound(context, "invalid_id", "not a Slack file id");
    return;
  }
  // 不是 slack:F… 的一律不认：网址、本地路径、别的来源都到不了 readFile。
  if (!CHANNEL_FILE_ID_PATTERN.test(fileId)) {
    fileNotFound(context, "invalid_id", "not a Slack file id");
    return;
  }
  const service = context.service;
  if (!service?.readFile) {
    context.json(503, { error: { code: "internal_error", message: "no channel source can read files", details: { reason: "unavailable" } } });
    return;
  }
  // 只取收到过的消息里出现过的文件。
  if (!service.fileKnown?.(fileId)) {
    fileNotFound(context, "unknown_file");
    return;
  }
  let file: Awaited<ReturnType<NonNullable<ChannelCardService["readFile"]>>>;
  try {
    file = await service.readFile(fileId, CHANNEL_FILE_MAX_BYTES);
  } catch (error) {
    // 通道 hub 的错误码：not_found（Slack 里没有、删掉了）回 404，别的（没接上、缺权限、太大）回 503。原因不带出去，日志里有。
    const reason = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unavailable";
    if (reason === "not_found") fileNotFound(context, "not_found");
    else context.json(503, { error: { code: "internal_error", message: "the file could not be read", details: { reason: "unavailable" } } });
    return;
  }
  // 按文件头认格式，不信来源说的类型：只回四种位图（SVG 这类能带脚本的不回）。
  const mimeType = sniffChatImageMimeType(file.data);
  if (!mimeType) {
    fileNotFound(context, "not_image", "the file is not an image");
    return;
  }
  const image: ChannelImage = { id: file.id, name: file.name, mimeType, data: Buffer.from(file.data).toString("base64") };
  context.json(200, image, { "cache-control": `private, max-age=${CHANNEL_IMAGE_CACHE_SECONDS}` });
}

const textActions = CHANNEL_CARD_TEXT_ACTIONS.join(", ");
const noteActions = CHANNEL_CARD_NOTE_ACTIONS.join(", ");
// 400 的说明从常量生成：加了动作不用再改这里。
const INVALID_ACTION_MESSAGE = `body must be { action, expectedVersion?, text?, note?, emoji?, react? }: `
  + `action is one of ${CHANNEL_CARD_ACTIONS.join(", ")}; expectedVersion is a positive integer; `
  + `text is 1 to ${CHANNEL_CARD_TEXT_MAX} characters and goes only with ${textActions}; `
  + `note is 1 to ${CHANNEL_CARD_NOTE_MAX} characters, and emoji (a name like white_check_mark) and react (boolean) go only with ${noteActions}`;

const invalidRequest = (context: ChannelRouteContext, message: string) =>
  context.json(400, { error: { code: "invalid_request", message } });

/** 处理通道的路由。不是这些路径时返回 false。 */
export async function handleChannelRoute(context: ChannelRouteContext): Promise<boolean> {
  const { req, url } = context;
  if (req.method === "GET" && url.pathname === "/v1/channels/cards") {
    context.requireAuth("chat");
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? 100 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      context.json(400, { error: { code: "invalid_request", message: "limit must be an integer from 1 to 500" } });
      return true;
    }
    // 没有接任何来源时没有卡。
    const items = context.service?.list(limit) ?? [];
    context.json(200, { items: wantsLinks(url) ? items : items.map(channelCardWithoutLinks) });
    return true;
  }
  const file = req.method === "GET" ? FILE_PATH.exec(url.pathname) : null;
  if (file) {
    await serveImage(context, file[1]!);
    return true;
  }
  const match = req.method === "POST" ? CARD_ACTION_PATH.exec(url.pathname) : null;
  if (!match) return false;
  context.requireAuth();
  const body = await context.readBody();
  if (!Value.Check(ChannelCardActionRequestSchema, body)) {
    invalidRequest(context, INVALID_ACTION_MESSAGE);
    return true;
  }
  const request = body as { action: ChannelCardAction; expectedVersion?: number; text?: string; note?: string; emoji?: string; react?: boolean };
  const takesText = CHANNEL_CARD_TEXT_ACTIONS.includes(request.action);
  if (takesText && !request.text?.trim()) {
    invalidRequest(context, `${request.action} needs text: what to send, 1 to ${CHANNEL_CARD_TEXT_MAX} characters`);
    return true;
  }
  if (!takesText && request.text !== undefined) {
    invalidRequest(context, `${request.action} does not take text; only ${textActions} does`);
    return true;
  }
  const takesNote = CHANNEL_CARD_NOTE_ACTIONS.includes(request.action);
  if (takesNote && !request.note?.trim()) {
    invalidRequest(context, `${request.action} needs note: what was done, 1 to ${CHANNEL_CARD_NOTE_MAX} characters`);
    return true;
  }
  if (!takesNote && (request.note !== undefined || request.emoji !== undefined || request.react !== undefined)) {
    invalidRequest(context, `${request.action} does not take note, emoji or react; only ${noteActions} does`);
    return true;
  }
  const scope = CHANNEL_CARD_ACTION_SCOPES[request.action];
  context.requireAuth(scope);
  if (!context.service) {
    context.json(503, { error: { code: "internal_error", message: "no channel source is connected", details: { reason: "unavailable" } } });
    return true;
  }
  const card = await context.perform(Number(match[1]), request.action, {
    ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}),
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.note !== undefined ? { note: request.note } : {}),
    ...(request.emoji !== undefined ? { emoji: request.emoji } : {}),
    ...(request.react !== undefined ? { react: request.react } : {}),
  }, scope);
  context.json(200, { card: wantsLinks(url) ? card : channelCardWithoutLinks(card) });
  return true;
}
