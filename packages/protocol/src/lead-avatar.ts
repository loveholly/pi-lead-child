// Lead 的形象（设置页「Lead → 身份与风格 → 形象」，用户 2026-10-28）的线上契约。
//
// 界面上代表 Lead 的图有四种状态（主题 11.12）：默认、思考中、淡彩（答完、处理完的消息）、离线。
//   - 缺省用系统自带的一套素材（墨色方块里一颗白色四角星，四种状态各一张，客户端自带）。
//   - 用户可以给每种状态上传自己的图：PNG、GIF、WebP，每张最大 LEAD_AVATAR_MAX_BYTES。
//     没上传的状态用用户上传的默认图；默认图也没上传时，用系统自带的那一张。
//   - 隐藏开关 FairyEye：打开以后界面改用 FairyEye 矢量组件（Fairy 的眼睛，四种状态由代码画）。
//     只有用户在 Lead 的会话里发 `/fairyeye on` 才打开，`/fairyeye off` 关掉。daemon 认这条命令，不交给 Lead，
//     没有别的入口（没有路由，没有 Lead 工具）。Fairy 这个角色没有授权给别人用，所以缺省关着。
//   - Slack 署名里助手名前面的 emoji（Slack 的短代码）也在这里设：设置页的值优先，其次配置的
//     channels.slack.assistantEmoji，最后是缺省的 :robot_face:。空字符串表示不加 emoji。
// 存在 plc.db 的 kv（lead.avatar 一行元数据，lead.avatar.image.<id> 每张图一行 base64）。
// 读用 tickets:view，改用 tickets:create。设置页和 Lead 的 set_lead_avatar 工具调同一组函数（engine 的 lead-avatar.ts），
// 权限和名字、人格一样：Lead 只能在用户这一轮明确要求时代他改，这一轮读过外部原文时不能改。
// 变化时网关发 snapshot.required，payload 是 {resource: "lead-avatar"}，客户端重新 GET。
// hello.v2 的 capabilities 里有 LEAD_AVATAR_CAPABILITY 时，daemon 才有这些路由。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const LEAD_AVATAR_RESOURCE = "lead-avatar";
export const LEAD_AVATAR_CAPABILITY = "lead.avatar.v1";

// 四种状态。muted 是淡彩（答完、处理完的消息），offline 是离线。
export const LEAD_AVATAR_SLOTS = ["default", "thinking", "muted", "offline"] as const;
export type LeadAvatarSlot = typeof LEAD_AVATAR_SLOTS[number];
export const LeadAvatarSlotSchema = Type.Union(LEAD_AVATAR_SLOTS.map((slot) => Type.Literal(slot)));

export function isLeadAvatarSlot(value: unknown): value is LeadAvatarSlot {
  return typeof value === "string" && (LEAD_AVATAR_SLOTS as readonly string[]).includes(value);
}

// 收的格式：用户 2026-10-28 定的三种。不收 SVG（SVG 能带脚本），也不收 JPEG（没有透明）。
export const LEAD_AVATAR_MIME_TYPES = ["image/png", "image/gif", "image/webp"] as const;
export type LeadAvatarMimeType = typeof LEAD_AVATAR_MIME_TYPES[number];
export const LeadAvatarMimeTypeSchema = Type.Union([
  Type.Literal("image/png"), Type.Literal("image/gif"), Type.Literal("image/webp"),
]);

// 一张图最大多少字节（解码以后）。界面上的图最大 32，动图几百 KB 就够了。
export const LEAD_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
// 对应的 base64 最长多少个字符。
export const LEAD_AVATAR_MAX_BASE64_LENGTH = Math.ceil(LEAD_AVATAR_MAX_BYTES / 3) * 4;
// 上传请求体最大多少字节：base64 加上 64 KB 给 JSON 的其余部分。
export const LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES = LEAD_AVATAR_MAX_BASE64_LENGTH + 64 * 1024;
// 图的 id：内容的 SHA-256 的前 24 位十六进制。同样的图同一个 id，客户端按 id 缓存。
export const LEAD_AVATAR_IMAGE_ID_PATTERN = /^av_[0-9a-f]{24}$/;

// Slack 署名里助手名前面的 emoji 的缺省值（Slack 自带的 emoji，任何工作区都有；用户 2026-10-30 定，原来是自定义的 :fairy-zz:）。
export const SLACK_BYLINE_EMOJI_DEFAULT = ":robot_face:";
// 短代码最长多少个字符（冒号包着最多 100 个字符）。
export const SLACK_BYLINE_EMOJI_MAX_LENGTH = 102;

export const LeadAvatarAuthorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type LeadAvatarAuthor = Static<typeof LeadAvatarAuthorSchema>;

// 一种状态上传的图。按 id 取图（GET /v1/lead/avatar/images/:id）。
export const LeadAvatarImageRefSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  mimeType: LeadAvatarMimeTypeSchema,
  bytes: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String(),
});
export type LeadAvatarImageRef = Static<typeof LeadAvatarImageRefSchema>;

const SlotRef = Type.Union([LeadAvatarImageRefSchema, Type.Null()]);

export const LeadAvatarSlotsSchema = StrictObject({
  default: SlotRef,
  thinking: SlotRef,
  muted: SlotRef,
  offline: SlotRef,
});
export type LeadAvatarSlots = Static<typeof LeadAvatarSlotsSchema>;

// settings：设置页或 Lead 设的；config：配置文件的 channels.slack.assistantEmoji；default：缺省的 :robot_face:。
export const SlackBylineEmojiSourceSchema = Type.Union([
  Type.Literal("settings"), Type.Literal("config"), Type.Literal("default"),
]);
export type SlackBylineEmojiSource = Static<typeof SlackBylineEmojiSourceSchema>;

export const LeadAvatarDtoSchema = StrictObject({
  // 隐藏开关：true 时界面用 FairyEye 矢量组件，不用素材。只有 /fairyeye on 能打开。
  fairyEye: Type.Boolean(),
  // 每种状态上传的图。没上传时为 null。
  slots: LeadAvatarSlotsSchema,
  // 现在生效的 Slack 署名 emoji（短代码）。空字符串表示不加。
  slackEmoji: Type.String({ maxLength: SLACK_BYLINE_EMOJI_MAX_LENGTH }),
  slackEmojiSource: SlackBylineEmojiSourceSchema,
  // 最近一次修改（上传、清除、改 emoji、开关 FairyEye）。从没改过时都是 null。
  updatedAt: Type.Union([Type.String(), Type.Null()]),
  updatedBy: Type.Union([LeadAvatarAuthorSchema, Type.Null()]),
});
export type LeadAvatarDto = Static<typeof LeadAvatarDtoSchema>;

export const LeadAvatarResponseSchema = StrictObject({ leadAvatar: LeadAvatarDtoSchema });
export type LeadAvatarResponse = Static<typeof LeadAvatarResponseSchema>;

// GET /v1/lead/avatar/images/:id 的回答：base64 的图片数据。
export const LeadAvatarImageSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  mimeType: LeadAvatarMimeTypeSchema,
  data: Type.String({ minLength: 1 }),
});
export type LeadAvatarImage = Static<typeof LeadAvatarImageSchema>;

// POST /v1/lead/avatar/slots/:slot：上传一种状态的图。daemon 按文件头核对格式，不信客户端声明的类型。
export const LeadAvatarUploadRequestSchema = StrictObject({
  mimeType: LeadAvatarMimeTypeSchema,
  data: Type.String({ minLength: 1, maxLength: LEAD_AVATAR_MAX_BASE64_LENGTH }),
});
export type LeadAvatarUploadRequest = Static<typeof LeadAvatarUploadRequestSchema>;
// POST /v1/lead/avatar/slots/:slot/clear：去掉一种状态上传的图，请求体为空。回答都是 LeadAvatarResponse。

// POST /v1/lead/avatar/slack-emoji：改 Slack 署名的 emoji。写 "robot_face" 或 ":robot_face:" 都行，空字符串表示不加。
// reset 为 true 时去掉设置页的值，回到配置文件或缺省的值（这时不看 emoji）。
export const LeadAvatarSlackEmojiRequestSchema = StrictObject({
  emoji: Type.String({ maxLength: SLACK_BYLINE_EMOJI_MAX_LENGTH + 8 }),
  reset: Type.Optional(Type.Boolean()),
});
export type LeadAvatarSlackEmojiRequest = Static<typeof LeadAvatarSlackEmojiRequestSchema>;

// GET /v1/lead/avatar/slack-emoji/preview?code=<短代码>：设置页的 Slack 预览。
//   none：没写 emoji，署名只有文字。custom：工作区里的自定义 emoji，imageUrl 是它的图（Slack 的 CDN，动图会动）。
//   not_found：工作区的自定义 emoji 里没有它（可能是 Slack 自带的 emoji，也可能写错了）。
//   invalid：不合短代码的写法，发出去的署名不加它。
//   unavailable：查不了（Slack 没连上，或者 Slack 应用没有 emoji:read 权限），reason 说明为什么。
// byline 是署名的文字部分（不带 emoji），和真的发出去的一样，例如「Paimon (Assistant) · auto-reply for Leo」。
export const SlackEmojiPreviewStatusSchema = Type.Union([
  Type.Literal("none"), Type.Literal("custom"), Type.Literal("not_found"), Type.Literal("invalid"), Type.Literal("unavailable"),
]);
export type SlackEmojiPreviewStatus = Static<typeof SlackEmojiPreviewStatusSchema>;

export const SlackEmojiPreviewSchema = StrictObject({
  // 整理以后的短代码（":robot_face:"）。没写或不合写法时是空字符串。
  code: Type.String({ maxLength: SLACK_BYLINE_EMOJI_MAX_LENGTH }),
  status: SlackEmojiPreviewStatusSchema,
  imageUrl: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  byline: Type.String(),
});
export type SlackEmojiPreview = Static<typeof SlackEmojiPreviewSchema>;

/**
 * 用户写的 emoji 整理成 Slack 的短代码：去掉两头的空白，没有冒号时补上。空的返回 ""（不加 emoji）。
 * 不合写法（冒号包着小写字母、数字、-、_、+、'，https://slack.com/help/articles/206870177）时返回 null。
 */
export function normalizeSlackEmojiCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const code = trimmed.startsWith(":") && trimmed.endsWith(":") && trimmed.length > 1 ? trimmed : `:${trimmed.replace(/^:|:$/g, "")}:`;
  return /^:[a-z0-9_+'-]{1,100}:$/.test(code) ? code : null;
}

/**
 * Lead 的会话里的 /fairyeye 命令：整条消息只有 `/fairyeye on` 或 `/fairyeye off`（不分大小写，两头和中间的空白不算）。
 * 别的消息返回 null，照常交给 Lead。
 */
export function parseFairyEyeCommand(message: string): "on" | "off" | null {
  const match = /^\/fairyeye\s+(on|off)$/i.exec(message.trim());
  return match ? (match[1]!.toLowerCase() as "on" | "off") : null;
}

/** 界面上的一个状态（空闲或思考中，三种色调）对应哪个图。离线优先，其次淡彩，其次思考中。 */
export function leadAvatarSlotFor(look: { state: "idle" | "thinking"; tone: "color" | "muted" | "quiet" }): LeadAvatarSlot {
  if (look.tone === "quiet") return "offline";
  if (look.tone === "muted") return "muted";
  return look.state === "thinking" ? "thinking" : "default";
}

/** 一种状态用哪张上传的图：这种状态自己的；没有时用上传的默认图；都没有时为 null（用系统自带的素材）。 */
export function leadAvatarUpload(slots: LeadAvatarSlots, slot: LeadAvatarSlot): LeadAvatarImageRef | null {
  return slots[slot] ?? slots.default ?? null;
}
