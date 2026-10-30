// 设置页「形象」卡的文字（主题 11.15）。界面在 LeadAvatarSection.tsx。
import type { LeadAvatarDto, LeadAvatarSlot, SlackEmojiPreview } from '@pi-lead-child/protocol';

import type { LeadAvatarLook } from '@/components/leadAvatarSource';
import { formatAvatarBytes } from '@/data/avatarImagePicker.types';

export const LEAD_AVATAR_SLOT_LABELS: Record<LeadAvatarSlot, string> = {
  default: '默认',
  thinking: '思考中',
  muted: '淡彩',
  offline: '离线',
};

// 每个格子的预览按界面上的哪个状态画。
export const LEAD_AVATAR_SLOT_LOOKS: Record<LeadAvatarSlot, LeadAvatarLook> = {
  default: { state: 'idle', tone: 'color' },
  thinking: { state: 'thinking', tone: 'color' },
  muted: { state: 'idle', tone: 'muted' },
  offline: { state: 'idle', tone: 'quiet' },
};

/** 格子下面的一行说明：上传了的写大小；没上传、但上传了默认图的写「用默认图」；都没有时是「系统素材」。 */
export function leadAvatarSlotStatus(avatar: LeadAvatarDto, slot: LeadAvatarSlot): string {
  const own = avatar.slots[slot];
  if (own) return `已上传 · ${formatAvatarBytes(own.bytes)}`;
  if (slot !== 'default' && avatar.slots.default) return '用默认图';
  return '系统素材';
}

export const LEAD_AVATAR_FAIRY_EYE_NOTE = '现在显示的是 FairyEye。发 /fairyeye off 换回这里的素材。';

export function leadAvatarFootnote(canUpload: boolean): string {
  return canUpload
    ? 'PNG、GIF、WebP，每张最大 2 MB。没上传的状态用默认图。'
    : '在网页版上传。没上传的状态用默认图。';
}

export const SLACK_EMOJI_HELP = 'Slack 里助手名前面的 emoji，写短代码（例如 :robot_face:）。清空表示不加。';
export const SLACK_EMOJI_INVALID = '写法不对：用冒号包着小写字母、数字、-、_（例如 :robot_face:）。';

/** 预览下面的说明：查不到图时说为什么。能显示图、或者没写 emoji 时没有说明。 */
export function slackEmojiPreviewNote(preview: SlackEmojiPreview): string | null {
  if (preview.status === 'not_found') return '工作区里没有这个自定义 emoji。如果是 Slack 自带的 emoji，Slack 会显示成对应的图案。';
  if (preview.status === 'unavailable') return preview.reason ?? '现在查不了 Slack 里的 emoji。';
  if (preview.status === 'invalid') return SLACK_EMOJI_INVALID;
  return null;
}

/** 生效的 emoji 从哪来，写在保存按钮旁边。 */
export function slackEmojiSourceNote(avatar: LeadAvatarDto): string {
  if (avatar.slackEmojiSource === 'settings') return '现在用的是这里设的。';
  if (avatar.slackEmojiSource === 'config') return '现在用的是配置文件里的（channels.slack.assistantEmoji）。';
  return '现在用的是缺省值。';
}
