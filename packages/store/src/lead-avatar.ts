// Lead 的形象（protocol 的 lead-avatar.ts）。存在 kv：
//   - lead.avatar：一行 JSON 元数据 { fairyEye, slots, slackEmoji?, updatedAt, updatedBy }。
//     slots 里只有上传了图的状态；slackEmoji 是设置页（或 Lead）设的值，没设时没有这个键。
//   - lead.avatar.image.<id>：每张图一行，值是 base64。id 是内容的 SHA-256 的前 24 位十六进制，同样的图同一个 id。
// 这里只读写库：校验、授权在 engine 的 lead-avatar.ts。
// 读到的值坏了（手改、截断）时不抛错：坏掉的字段按缺省值算，界面照常用系统自带的素材。
// 换图或清除时，同一个事务里删掉不再被任何状态引用的图。
import { createHash } from "node:crypto";
import {
  LEAD_AVATAR_IMAGE_ID_PATTERN, LEAD_AVATAR_MAX_BYTES, LEAD_AVATAR_MIME_TYPES, LEAD_AVATAR_SLOTS, normalizeSlackEmojiCode,
  sniffChatImageMimeType,
  type LeadAvatarAuthor, type LeadAvatarImageRef, type LeadAvatarMimeType, type LeadAvatarSlot, type LeadAvatarSlots,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const LEAD_AVATAR_KEY = "lead.avatar";
export const LEAD_AVATAR_IMAGE_KEY_PREFIX = "lead.avatar.image.";

/** 库里存的形象（还没有算 Slack 署名 emoji 的生效值）。 */
export interface StoredLeadAvatar {
  fairyEye: boolean;
  // 四种状态都有键：没上传时为 null。
  slots: LeadAvatarSlots;
  // 设置页（或 Lead）设的 Slack 署名 emoji，已经整理成短代码。空字符串表示不加 emoji；null 表示没设。
  slackEmoji: string | null;
  updatedAt: string | null;
  updatedBy: LeadAvatarAuthor | null;
}

export interface LeadAvatarImageData {
  id: string;
  mimeType: LeadAvatarMimeType;
  data: Buffer;
}

export type LeadAvatarFields = Pick<StoredLeadAvatar, "fairyEye" | "slots" | "slackEmoji">;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function emptyLeadAvatarSlots(): LeadAvatarSlots {
  return { default: null, thinking: null, muted: null, offline: null };
}

/** 一张图的 id：av_ 加内容的 SHA-256 的前 24 位十六进制。 */
export function leadAvatarImageId(data: Uint8Array): string {
  return `av_${createHash("sha256").update(data).digest("hex").slice(0, 24)}`;
}

function isMimeType(value: unknown): value is LeadAvatarMimeType {
  return typeof value === "string" && (LEAD_AVATAR_MIME_TYPES as readonly string[]).includes(value);
}

function imageKey(id: string): string {
  return `${LEAD_AVATAR_IMAGE_KEY_PREFIX}${id}`;
}

function hasImage(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 FROM kv WHERE key = ?").get(imageKey(id)) !== undefined;
}

// 一种状态的图：字段都对、图也还在时才算；否则这种状态按没上传算。
function slotRef(db: Db, value: unknown): LeadAvatarImageRef | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id !== "string" || !LEAD_AVATAR_IMAGE_ID_PATTERN.test(ref.id)) return null;
  if (!isMimeType(ref.mimeType)) return null;
  if (typeof ref.bytes !== "number" || !Number.isInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > LEAD_AVATAR_MAX_BYTES) return null;
  if (typeof ref.updatedAt !== "string") return null;
  if (!hasImage(db, ref.id)) return null;
  return { id: ref.id, mimeType: ref.mimeType, bytes: ref.bytes, updatedAt: ref.updatedAt };
}

// 设置页的 emoji：整理以后和存的一样才算（空字符串也算：不加 emoji）。
function storedEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = normalizeSlackEmojiCode(value);
  return code !== null && code === value ? code : null;
}

/** 库里现在的形象。从没改过时：FairyEye 关着，四种状态都没上传，没设 emoji。 */
export function getStoredLeadAvatar(db: Db): StoredLeadAvatar {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_AVATAR_KEY) as { value: string } | undefined;
  let stored: Record<string, unknown> = {};
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  const slotsIn = stored.slots !== null && typeof stored.slots === "object" && !Array.isArray(stored.slots)
    ? stored.slots as Record<string, unknown> : {};
  const slots = emptyLeadAvatarSlots();
  for (const slot of LEAD_AVATAR_SLOTS) slots[slot] = slotRef(db, slotsIn[slot]);
  return {
    fairyEye: stored.fairyEye === true,
    slots,
    slackEmoji: storedEmoji(stored.slackEmoji),
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
  };
}

/**
 * 按 id 取一张图。id 不合 LEAD_AVATAR_IMAGE_ID_PATTERN、没有这张图、数据坏了（不是 base64，或者不是 PNG、GIF、WebP）时为 null。
 * 格式按文件头算：只收这三种格式的图，存进来的时候已经核对过。
 */
export function getLeadAvatarImage(db: Db, id: string): LeadAvatarImageData | null {
  if (!LEAD_AVATAR_IMAGE_ID_PATTERN.test(id)) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(imageKey(id)) as { value: string } | undefined;
  if (!row || !row.value || row.value.length % 4 !== 0 || !BASE64.test(row.value)) return null;
  const data = Buffer.from(row.value, "base64");
  const mimeType = sniffChatImageMimeType(data);
  return isMimeType(mimeType) ? { id, mimeType, data } : null;
}

/** 库里存着的所有图的 id（测试和清理用）。 */
export function listLeadAvatarImageIds(db: Db): string[] {
  const rows = db.prepare("SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key")
    .all(LEAD_AVATAR_IMAGE_KEY_PREFIX.length, LEAD_AVATAR_IMAGE_KEY_PREFIX) as Array<{ key: string }>;
  return rows.map((row) => row.key.slice(LEAD_AVATAR_IMAGE_KEY_PREFIX.length));
}

function metadata(fields: LeadAvatarFields, meta: { by: LeadAvatarAuthor; at: Date }): Record<string, unknown> {
  const slots: Partial<Record<LeadAvatarSlot, LeadAvatarImageRef>> = {};
  for (const slot of LEAD_AVATAR_SLOTS) {
    const ref = fields.slots[slot];
    if (ref) slots[slot] = ref;
  }
  return {
    fairyEye: fields.fairyEye,
    slots,
    ...(fields.slackEmoji !== null ? { slackEmoji: fields.slackEmoji } : {}),
    updatedAt: meta.at.toISOString(),
    updatedBy: meta.by,
  };
}

/**
 * 写入整理好、校验过的形象（engine 的 lead-avatar.ts 调它），在一个事务里：
 *   - image：新上传的图，存成一行（同一个 id 已经有了就覆盖）；
 *   - 写元数据；
 *   - 删掉不再被任何状态引用的图。
 * 返回写入以后的形象。
 */
export function writeLeadAvatar(
  db: Db,
  fields: LeadAvatarFields,
  meta: { by: LeadAvatarAuthor; at: Date; image?: { id: string; data: Uint8Array } },
): StoredLeadAvatar {
  if (meta.image && !LEAD_AVATAR_IMAGE_ID_PATTERN.test(meta.image.id)) throw new Error("invalid lead avatar image id");
  const upsert = db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    if (meta.image) upsert.run(imageKey(meta.image.id), Buffer.from(meta.image.data).toString("base64"));
    upsert.run(LEAD_AVATAR_KEY, JSON.stringify(metadata(fields, meta)));
    const kept = new Set(LEAD_AVATAR_SLOTS.flatMap((slot) => (fields.slots[slot] ? [fields.slots[slot]!.id] : [])));
    const remove = db.prepare("DELETE FROM kv WHERE key = ?");
    for (const id of listLeadAvatarImageIds(db)) if (!kept.has(id)) remove.run(imageKey(id));
  })();
  return getStoredLeadAvatar(db);
}
