// /v1/lead/avatar 的路由（设置页「身份与风格 → 形象」，2026-10-28；契约在 protocol 的 lead-avatar.ts）。
// 网关只做认证、读请求体和错误映射，修改在 engine 的 lead-avatar.ts（Lead 的 set_lead_avatar 工具调同一组函数）。
//   - GET  /v1/lead/avatar                               tickets:view   → { leadAvatar }
//   - GET  /v1/lead/avatar/images/:id                    tickets:view   → LeadAvatarImage。id 是内容的哈希，可以长期缓存。
//   - POST /v1/lead/avatar/slots/:slot                   tickets:create，请求体 LeadAvatarUploadRequest（几 MB，单独的上限）
//   - POST /v1/lead/avatar/slots/:slot/clear             tickets:create，请求体为空
//   - POST /v1/lead/avatar/slack-emoji                   tickets:create，请求体 LeadAvatarSlackEmojiRequest
//   - GET  /v1/lead/avatar/slack-emoji/preview?code=…    tickets:view   → SlackEmojiPreview
// FairyEye 的开关没有路由：只有用户在 Lead 的会话里发 `/fairyeye on` 才打开（daemon 的命令）。
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LEAD_AVATAR_IMAGE_ID_PATTERN, LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES, LeadAvatarSlackEmojiRequestSchema, SLACK_BYLINE_EMOJI_MAX_LENGTH,
  type Scope, type SlackEmojiPreview,
} from "@pi-lead-child/protocol";
import { getLeadAvatarImage, leadDisplayName, type Db } from "@pi-lead-child/store";
import {
  autoReplyDisclosure, clearLeadAvatarSlot, decodeLeadAvatarUpload, disclosureAssistantName, disclosureOwnerName, getLeadAvatar,
  LeadAvatarError, setLeadAvatarSlackEmoji, setLeadAvatarSlot, slackEmojiPreview, type LeadAvatarOutcome,
} from "@pi-lead-child/engine";
import { Value } from "typebox/value";

/** daemon 给的东西。缺席时：配置的 emoji 按没配算，预览说查不了。 */
export interface LeadAvatarService {
  // 配置文件里的 channels.slack.assistantEmoji。没配时 undefined。
  configSlackEmoji?: () => string | undefined;
  // 设置页的 Slack 预览：daemon 问通道 hub（Slack 的 emoji.list），拼成 SlackEmojiPreview。
  previewSlackEmoji?: (code: string) => Promise<SlackEmojiPreview>;
}

export interface LeadAvatarRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  service?: LeadAvatarService;
  json(status: number, value: unknown, headers?: Record<string, string>): void;
  // 读 JSON 请求体，最多 maxBytes 个字节（不给时用网关缺省的上限）。太大时抛 413。
  readBody(maxBytes?: number): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 改了以后发 snapshot.required（resource 是 lead-avatar）。
  publish(resource: string): void;
  log(line: string): void;
}

const ROOT = "/v1/lead/avatar";
const IMAGE = /^\/v1\/lead\/avatar\/images\/([^/]+)$/;
const SLOT = /^\/v1\/lead\/avatar\/slots\/([^/]+)$/;
const SLOT_CLEAR = /^\/v1\/lead\/avatar\/slots\/([^/]+)\/clear$/;
const SLACK_EMOJI = "/v1/lead/avatar/slack-emoji";
const SLACK_EMOJI_PREVIEW = "/v1/lead/avatar/slack-emoji/preview";

function badRequest(ctx: LeadAvatarRouteContext, message: string, reason: string): void {
  // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
  ctx.json(400, { error: { code: "invalid_request", message, details: { reason } } });
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// 处理了返回 true。不是这些路由返回 false。
export async function handleLeadAvatarRoute(ctx: LeadAvatarRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
  const configSlackEmoji = () => ctx.service?.configSlackEmoji?.();

  if (req.method === "GET" && url.pathname === ROOT) {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { leadAvatar: getLeadAvatar(ctx.db, { configSlackEmoji: configSlackEmoji() }) });
    return true;
  }

  const image = url.pathname.match(IMAGE);
  if (req.method === "GET" && image) {
    ctx.requireAuth("tickets:view");
    const id = decodeSegment(image[1]!);
    if (id === null || !LEAD_AVATAR_IMAGE_ID_PATTERN.test(id)) {
      badRequest(ctx, "图的 id 不对", "invalid_input");
      return true;
    }
    const found = getLeadAvatarImage(ctx.db, id);
    if (!found) {
      ctx.json(404, { error: { code: "not_found", message: "没有这张图" } });
      return true;
    }
    // id 是内容的哈希：同一个 id 永远是同一张图。
    ctx.json(200, { id: found.id, mimeType: found.mimeType, data: found.data.toString("base64") }, {
      "cache-control": "private, max-age=31536000, immutable",
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === SLACK_EMOJI_PREVIEW) {
    ctx.requireAuth("tickets:view");
    const code = url.searchParams.get("code") ?? "";
    if (code.length > SLACK_BYLINE_EMOJI_MAX_LENGTH + 8) {
      badRequest(ctx, "code 太长：Slack 的短代码最多 100 个字符", "invalid_input");
      return true;
    }
    const preview = ctx.service?.previewSlackEmoji
      ? await ctx.service.previewSlackEmoji(code)
      : await slackEmojiPreview({
        code, lookup: null, unavailableReason: "这个 daemon 查不了 Slack 的 emoji。",
        byline: () => autoReplyDisclosure(disclosureAssistantName(leadDisplayName(ctx.db)), disclosureOwnerName(), "").parts.byline,
      });
    ctx.json(200, preview);
    return true;
  }

  if (req.method !== "POST") return false;
  const change = async (run: () => LeadAvatarOutcome | Promise<LeadAvatarOutcome>): Promise<true> => {
    try {
      const outcome = await run();
      ctx.json(200, { leadAvatar: outcome.avatar });
    } catch (error) {
      if (error instanceof LeadAvatarError) {
        badRequest(ctx, error.message, error.code);
        return true;
      }
      throw error;
    }
    return true;
  };
  const common = () => ({
    caller: { kind: "user" as const },
    configSlackEmoji: configSlackEmoji(),
    publish: (resource: string) => ctx.publish(resource),
    log: ctx.log,
  });

  const clear = url.pathname.match(SLOT_CLEAR);
  if (clear) {
    ctx.requireAuth("tickets:create");
    const slot = decodeSegment(clear[1]!);
    return change(() => clearLeadAvatarSlot(ctx.db, { ...common(), slot }));
  }

  const slot = url.pathname.match(SLOT);
  if (slot) {
    ctx.requireAuth("tickets:create");
    // 上传的请求体有几 MB（protocol 的 LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES），网关缺省的上限只有 1 MB。
    const body = await ctx.readBody(LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES);
    return change(() => {
      const upload = decodeLeadAvatarUpload(body);
      return setLeadAvatarSlot(ctx.db, { ...common(), slot: decodeSegment(slot[1]!), data: upload.data, mimeType: upload.mimeType });
    });
  }

  if (url.pathname === SLACK_EMOJI) {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(LeadAvatarSlackEmojiRequestSchema, body)) {
      badRequest(ctx, "请求只能有 emoji（文字）和 reset（true 或 false）", "invalid_input");
      return true;
    }
    return change(() => setLeadAvatarSlackEmoji(ctx.db, { ...common(), emoji: body.emoji, ...(body.reset !== undefined ? { reset: body.reset } : {}) }));
  }
  return false;
}
