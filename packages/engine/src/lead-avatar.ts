// 改 Lead 的形象（设置页「身份与风格 → 形象」，用户 2026-10-28；契约在 protocol 的 lead-avatar.ts）。一份实现，几个入口：
//   - 设置页：网关的 /v1/lead/avatar 路由（gateway 的 lead-avatar-routes.ts）。
//   - Lead：set_lead_avatar 工具（lead 的 profile-tools.ts）。用户在对话里说「把这张图换成你的头像」「Slack 署名用 :sparkles:」时用它。
//   - FairyEye 的隐藏开关：只有 daemon 的 /fairyeye 命令调 setLeadAvatarFairyEye（用户的底线：只有输入 `/fairyeye on`
//     才能让矢量 FairyEye 出现）。没有路由，Lead 的工具也没有这个参数。
// 权限和名字、人格一样：Lead 只能在用户这一轮明确要求时代他改，这一轮读过外部原文时不能改。不记主人操作，只写 updatedAt、updatedBy。
// 每次真的变化以后调 publish(LEAD_AVATAR_RESOURCE)：网关发 snapshot.required，客户端重新 GET。没有变化时什么也不写。
import {
  LEAD_AVATAR_MAX_BYTES, LEAD_AVATAR_MIME_TYPES, LEAD_AVATAR_RESOURCE, LEAD_AVATAR_SLOTS, LeadAvatarSlackEmojiRequestSchema,
  LeadAvatarUploadRequestSchema, SLACK_BYLINE_EMOJI_DEFAULT, isLeadAvatarSlot, normalizeSlackEmojiCode, sniffChatImageMimeType,
  type LeadAvatarDto, type LeadAvatarMimeType, type LeadAvatarSlot, type SlackBylineEmojiSource, type SlackEmojiPreview,
} from "@pi-lead-child/protocol";
import {
  activePairedUserTurn, getStoredLeadAvatar, leadAvatarImageId, writeLeadAvatar, type Db, type LeadAvatarFields, type StoredLeadAvatar,
} from "@pi-lead-child/store";
import { Value } from "typebox/value";
import type { ChannelMarkPreview } from "./channels/types.js";
import type { ActionAttribution } from "./ticket-actions/attribution.js";

export type LeadAvatarCaller =
  | { kind: "user" }
  // external：这一轮读进了外部来源的原文（lead 的 turn-origin.ts）。
  | { kind: "lead"; turnId: string | null; external?: boolean };

export class LeadAvatarError extends Error {
  constructor(readonly code: "invalid_input" | "needs_user_turn", message: string) {
    super(message);
  }
}

interface LeadAvatarChange {
  caller: LeadAvatarCaller;
  now?: Date;
  // 配置文件里的 channels.slack.assistantEmoji（daemon 读的，没配时 undefined）：算回答里的生效值。
  configSlackEmoji?: string | undefined;
  // 改了以后调：网关发 snapshot.required（resource 是 lead-avatar），客户端重新 GET。
  publish?: (resource: typeof LEAD_AVATAR_RESOURCE) => void;
  log?: (line: string) => void;
}

export interface LeadAvatarOutcome {
  avatar: LeadAvatarDto;
  changed: boolean;
  by: ActionAttribution;
}

const FORMAT_LABELS: Record<string, string> = {
  "image/png": "PNG", "image/gif": "GIF", "image/webp": "WebP", "image/jpeg": "JPEG",
};
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isAvatarMimeType(value: unknown): value is LeadAvatarMimeType {
  return typeof value === "string" && (LEAD_AVATAR_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Slack 署名 emoji 的生效值：设置页的值 > 配置的 channels.slack.assistantEmoji > 缺省的 :robot_face:。
 * 配置也按 normalizeSlackEmojiCode 整理；不合短代码的写法时按空字符串算（不加 emoji，和 Slack 适配器一样）。
 */
export function effectiveSlackBylineEmoji(
  settings: string | null, configSlackEmoji: string | undefined,
): { slackEmoji: string; slackEmojiSource: SlackBylineEmojiSource } {
  if (settings !== null) return { slackEmoji: settings, slackEmojiSource: "settings" };
  if (configSlackEmoji !== undefined) return { slackEmoji: normalizeSlackEmojiCode(configSlackEmoji) ?? "", slackEmojiSource: "config" };
  return { slackEmoji: SLACK_BYLINE_EMOJI_DEFAULT, slackEmojiSource: "default" };
}

function dtoOf(stored: StoredLeadAvatar, configSlackEmoji: string | undefined): LeadAvatarDto {
  return {
    fairyEye: stored.fairyEye,
    slots: { ...stored.slots },
    ...effectiveSlackBylineEmoji(stored.slackEmoji, configSlackEmoji),
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/** 现在的形象（设置页和客户端读的）。 */
export function getLeadAvatar(db: Db, options: { configSlackEmoji?: string | undefined } = {}): LeadAvatarDto {
  return dtoOf(getStoredLeadAvatar(db), options.configSlackEmoji);
}

/** Slack 署名里现在用的 emoji（生效值）。Slack 适配器每发一条消息读一次，设置页改了以后下一条就用新的。空字符串表示不加。 */
export function leadAvatarSlackEmoji(db: Db, configSlackEmoji: string | undefined): string {
  return effectiveSlackBylineEmoji(getStoredLeadAvatar(db).slackEmoji, configSlackEmoji).slackEmoji;
}

function authorize(db: Db, caller: LeadAvatarCaller): ActionAttribution {
  if (caller.kind === "user") return { actor: "user" };
  // Slack 署名对外，形象在每个界面上：这一轮读过外部原文时，即使是用户本人的一轮也不能改（和名字、人格同一条规则）。
  if (caller.external) {
    throw new LeadAvatarError(
      "needs_user_turn",
      "这一轮读过外部通道（例如 Slack）的消息，不能改形象和 Slack 署名的 emoji。请用户在新的一条消息里再说一次。",
    );
  }
  try {
    const turn = activePairedUserTurn(db, caller.turnId, "set_lead_avatar", "tickets:create");
    return { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: turn.id, bindingId: turn.origin_binding_id } };
  } catch (error) {
    throw new LeadAvatarError(
      "needs_user_turn",
      "形象和 Slack 署名的 emoji 只有用户在这一轮明确要求时你才能改"
        + `（${error instanceof Error ? error.message : String(error)}）。用户没有这样要求时，请他在设置 → 身份与风格 → 形象里改。`,
    );
  }
}

function sameFields(a: LeadAvatarFields, b: LeadAvatarFields): boolean {
  return a.fairyEye === b.fairyEye && a.slackEmoji === b.slackEmoji
    && LEAD_AVATAR_SLOTS.every((slot) => (a.slots[slot]?.id ?? null) === (b.slots[slot]?.id ?? null));
}

function fieldsOf(stored: StoredLeadAvatar): LeadAvatarFields {
  return { fairyEye: stored.fairyEye, slots: { ...stored.slots }, slackEmoji: stored.slackEmoji };
}

// 写下变化（有的话），发 publish。没有变化时什么也不写。
function apply(
  db: Db, change: LeadAvatarChange, by: ActionAttribution, current: StoredLeadAvatar, after: LeadAvatarFields,
  what: string, image?: { id: string; data: Uint8Array },
): LeadAvatarOutcome {
  if (sameFields(fieldsOf(current), after)) return { avatar: dtoOf(current, change.configSlackEmoji), changed: false, by };
  const stored = writeLeadAvatar(db, after, { by: by.actor, at: change.now ?? new Date(), ...(image ? { image } : {}) });
  change.log?.(`[lead-avatar] ${what} by ${by.actor}${by.actor === "lead" && by.onBehalfOf ? " on behalf of the user" : ""}`);
  change.publish?.(LEAD_AVATAR_RESOURCE);
  return { avatar: dtoOf(stored, change.configSlackEmoji), changed: true, by };
}

function slotOf(slot: unknown): LeadAvatarSlot {
  if (!isLeadAvatarSlot(slot)) throw new LeadAvatarError("invalid_input", `状态只能是 ${LEAD_AVATAR_SLOTS.join("、")} 之一`);
  return slot;
}

/**
 * 核对一张要上传的图，返回它的格式。规则：
 *   - 按文件头判断格式，只收 PNG、GIF、WebP（不收 SVG：能带脚本；不收 JPEG：没有透明）。
 *   - 声明的类型和文件头不一致时拒收（和发给 Lead 的图片同一条规则）：不按文件头改成别的类型存下。
 *   - 空的、超过 LEAD_AVATAR_MAX_BYTES 的拒收。
 */
export function checkLeadAvatarImage(data: Uint8Array, declared: string): LeadAvatarMimeType {
  if (!data.length) throw new LeadAvatarError("invalid_input", "图片是空的");
  if (data.length > LEAD_AVATAR_MAX_BYTES) {
    throw new LeadAvatarError(
      "invalid_input",
      `图片太大：最大 ${LEAD_AVATAR_MAX_BYTES / 1024 / 1024} MB，这张 ${(data.length / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  const sniffed = sniffChatImageMimeType(data);
  if (!isAvatarMimeType(sniffed)) {
    const found = sniffed ? `，这张是 ${FORMAT_LABELS[sniffed] ?? sniffed}` : "";
    throw new LeadAvatarError("invalid_input", `形象只收 PNG、GIF、WebP 格式的图片${found}`);
  }
  if (sniffed !== declared) {
    const label = FORMAT_LABELS[declared] ?? "声明的格式";
    throw new LeadAvatarError("invalid_input", `图片的内容是 ${FORMAT_LABELS[sniffed]}，不是 ${label}：请重新选择文件`);
  }
  return sniffed;
}

/** 解开上传的请求体（LeadAvatarUploadRequestSchema）：严格校验字段，base64 能解，再交给 setLeadAvatarSlot 核对内容。 */
export function decodeLeadAvatarUpload(raw: unknown): { data: Buffer; mimeType: LeadAvatarMimeType } {
  const declared = raw !== null && typeof raw === "object" ? (raw as { mimeType?: unknown }).mimeType : undefined;
  if (typeof declared === "string" && !isAvatarMimeType(declared)) {
    throw new LeadAvatarError("invalid_input", `形象只收 PNG、GIF、WebP 格式的图片，这张是 ${FORMAT_LABELS[declared] ?? declared.slice(0, 40)}`);
  }
  if (!Value.Check(LeadAvatarUploadRequestSchema, raw)) {
    throw new LeadAvatarError("invalid_input", "请求只能有 mimeType（image/png、image/gif、image/webp）和 data（base64，最大 2 MB 的图）");
  }
  if (raw.data.length % 4 !== 0 || !BASE64.test(raw.data)) throw new LeadAvatarError("invalid_input", "data 不是合法的 base64");
  return { data: Buffer.from(raw.data, "base64"), mimeType: raw.mimeType };
}

/** 给一种状态上传一张图。同一张图（同一个 id）再传一次算没有变化。 */
export function setLeadAvatarSlot(
  db: Db, change: LeadAvatarChange & { slot: unknown; data: Uint8Array; mimeType: string },
): LeadAvatarOutcome {
  const slot = slotOf(change.slot);
  const mimeType = checkLeadAvatarImage(change.data, change.mimeType);
  // 先认人，再动手。
  const by = authorize(db, change.caller);
  const now = change.now ?? new Date();
  const id = leadAvatarImageId(change.data);
  const current = getStoredLeadAvatar(db);
  const after: LeadAvatarFields = {
    ...fieldsOf(current),
    slots: { ...current.slots, [slot]: { id, mimeType, bytes: change.data.length, updatedAt: now.toISOString() } },
  };
  return apply(db, { ...change, now }, by, current, after, `${slot} image set`, { id, data: change.data });
}

/** 去掉一种状态上传的图（回到上传的默认图，或者系统自带的素材）。 */
export function clearLeadAvatarSlot(db: Db, change: LeadAvatarChange & { slot: unknown }): LeadAvatarOutcome {
  const slot = slotOf(change.slot);
  const by = authorize(db, change.caller);
  const current = getStoredLeadAvatar(db);
  const after: LeadAvatarFields = { ...fieldsOf(current), slots: { ...current.slots, [slot]: null } };
  return apply(db, change, by, current, after, `${slot} image cleared`);
}

/**
 * 改 Slack 署名的 emoji（设置页的值）。emoji 按 normalizeSlackEmojiCode 整理："robot_face" 和 ":robot_face:" 都行，空字符串表示不加。
 * reset 为 true 时去掉设置页的值，回到配置文件或缺省的值（这时不看 emoji）。
 */
export function setLeadAvatarSlackEmoji(
  db: Db, change: LeadAvatarChange & { emoji: string | null; reset?: boolean },
): LeadAvatarOutcome {
  const request = { emoji: change.emoji ?? "", ...(change.reset !== undefined ? { reset: change.reset } : {}) };
  if (!Value.Check(LeadAvatarSlackEmojiRequestSchema, request)) {
    throw new LeadAvatarError("invalid_input", "emoji 太长：Slack 的短代码最多 100 个字符");
  }
  let slackEmoji: string | null = null;
  if (change.reset !== true) {
    if (change.emoji === null) throw new LeadAvatarError("invalid_input", "没有给 emoji：要回到缺省的值时用 reset");
    slackEmoji = normalizeSlackEmojiCode(change.emoji);
    if (slackEmoji === null) {
      throw new LeadAvatarError(
        "invalid_input",
        `「${change.emoji.trim().slice(0, 40)}」不是 Slack 的短代码：只能用小写字母、数字、-、_、+、'，例如 :robot_face:`,
      );
    }
  }
  const by = authorize(db, change.caller);
  const current = getStoredLeadAvatar(db);
  return apply(db, change, by, current, { ...fieldsOf(current), slackEmoji }, slackEmoji === null ? "slack emoji reset" : "slack emoji set");
}

/**
 * FairyEye 的隐藏开关。只给 daemon 的 /fairyeye 命令用：用户在 Lead 的会话里发 `/fairyeye on` 或 `/fairyeye off`。
 * 没有路由调它，Lead 的工具也调不到它。记成用户改的。
 */
export function setLeadAvatarFairyEye(
  db: Db, change: Omit<LeadAvatarChange, "caller"> & { on: boolean },
): LeadAvatarOutcome {
  const current = getStoredLeadAvatar(db);
  return apply(db, { ...change, caller: { kind: "user" } }, { actor: "user" }, current, { ...fieldsOf(current), fairyEye: change.on },
    change.on ? "fairyEye on" : "fairyEye off");
}

/** daemon 回 /fairyeye 命令的一句话。name 是 Lead 的名字。 */
export function fairyEyeReply(on: boolean, changed: boolean, name: string): string {
  if (on) {
    return changed
      ? `已打开 FairyEye：界面上的 ${name} 改用 Fairy 的眼睛。发 /fairyeye off 换回形象素材。`
      : `FairyEye 已经是打开的：界面上的 ${name} 用 Fairy 的眼睛。发 /fairyeye off 换回形象素材。`;
  }
  return changed
    ? `已关掉 FairyEye：界面上的 ${name} 换回形象素材（设置 → 身份与风格 → 形象）。`
    : `FairyEye 已经是关着的：界面上的 ${name} 用形象素材（设置 → 身份与风格 → 形象）。`;
}

/**
 * 设置页的 Slack 预览（GET /v1/lead/avatar/slack-emoji/preview）。
 *   - code：用户写的 emoji。整理以后为空时 status 是 none；不合写法时是 invalid。
 *   - lookup：查工作区的自定义 emoji（daemon 给的通道 hub 的 previewDisclosureMark）。没有时 status 是 unavailable，reason 是 unavailableReason。
 *   - byline：自动回复的署名文字（不带 emoji），lookup 的结果里没有时用它。
 */
export async function slackEmojiPreview(input: {
  code: string;
  byline: () => string;
  lookup: ((mark: string) => Promise<ChannelMarkPreview>) | null;
  unavailableReason?: string;
}): Promise<SlackEmojiPreview> {
  const code = normalizeSlackEmojiCode(input.code);
  const base = { code: code ?? "", imageUrl: null, reason: null };
  if (code === null) {
    return {
      ...base, status: "invalid", byline: input.byline(),
      reason: "不是 Slack 的短代码：只能用小写字母、数字、-、_、+、'。发出去的署名不加它。",
    };
  }
  if (code === "") return { ...base, status: "none", byline: input.byline() };
  if (!input.lookup) {
    return {
      ...base, status: "unavailable", byline: input.byline(),
      reason: input.unavailableReason ?? "Slack 没有接上：在设置 → 消息通道里连上 Slack 以后才能预览。",
    };
  }
  let found: ChannelMarkPreview;
  try {
    found = await input.lookup(code);
  } catch (error) {
    return { ...base, status: "unavailable", byline: input.byline(), reason: `查不了：${error instanceof Error ? error.message : String(error)}` };
  }
  if (found.status === "custom") return { ...base, status: "custom", imageUrl: found.imageUrl, byline: found.byline };
  if (found.status === "not_found") return { ...base, status: "not_found", byline: found.byline };
  return { ...base, status: "unavailable", reason: found.reason, byline: found.byline };
}
