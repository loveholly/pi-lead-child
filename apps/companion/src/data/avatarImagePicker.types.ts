import { LEAD_AVATAR_MAX_BYTES, LEAD_AVATAR_MIME_TYPES, type LeadAvatarMimeType } from '@pi-lead-child/protocol';

// 选形象图时的错误：给用户看的一句话。
export class AvatarImageError extends Error {}

/** 选中的文件能不能当形象图（主题 F-9）：PNG、GIF、WebP，最大 2 MB。能用时返回它的类型，不能用时抛 AvatarImageError。 */
export function avatarImageType(file: { type: string; size: number }): LeadAvatarMimeType {
  if (!(LEAD_AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) throw new AvatarImageError('只能用 PNG、GIF 或 WebP');
  if (file.size > LEAD_AVATAR_MAX_BYTES) throw new AvatarImageError(`这张图有 ${formatAvatarBytes(file.size)}，最大 2 MB`);
  return file.type as LeadAvatarMimeType;
}

/** 图片大小写成「120 KB」「1.4 MB」。 */
export function formatAvatarBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
