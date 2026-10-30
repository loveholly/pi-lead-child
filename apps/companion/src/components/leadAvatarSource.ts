import type { FairyEyeState, FairyEyeTone, LeadAvatarSource } from '@pi-lead-child/components';
import { leadAvatarSlotFor, leadAvatarUpload, type LeadAvatarDto, type LeadAvatarSlot } from '@pi-lead-child/protocol';

import { leadAvatarDefaults } from './leadAvatarDefaults';

export type LeadAvatarLook = { state: FairyEyeState; tone: FairyEyeTone };

// 界面上的一个形象从哪来（主题 11.12）：
//   - daemon 说隐藏开关 fairyEye 开着（只有用户发 /fairyeye on 能打开）：FairyEye 矢量组件。
//   - 别的情况一律用图，FairyEye 不出现（用户 2026-10-28 的底线）：这种状态上传的图；没有时用上传的默认图；
//     都没有时用系统素材（F-8）。还没取到形象（刚连上、旧 daemon）也用系统素材。
//   - 上传的图还在取：同样大小的空位，不先闪一下系统素材。取不到：系统素材。
export function leadAvatarSource(
  avatar: LeadAvatarDto | null,
  images: Readonly<Record<string, string>>,
  look: LeadAvatarLook,
): LeadAvatarSource {
  if (avatar?.fairyEye === true) return { kind: 'fairy-eye' };
  const slot = leadAvatarSlotFor(look);
  return { kind: 'image', uri: slotUri(avatar, images, slot), stillUri: slot === 'thinking' ? slotUri(avatar, images, 'default') : null };
}

function slotUri(avatar: LeadAvatarDto | null, images: Readonly<Record<string, string>>, slot: LeadAvatarSlot): string | null {
  const upload = avatar ? leadAvatarUpload(avatar.slots, slot) : null;
  if (!upload) return leadAvatarDefaults[slot];
  const loaded = images[upload.id];
  if (loaded === undefined) return null;
  return loaded || leadAvatarDefaults[slot];
}
