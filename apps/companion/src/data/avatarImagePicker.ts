import type { LeadAvatarUploadRequest } from '@pi-lead-child/protocol';

import { AvatarImageError } from './avatarImagePicker.types';

export { AvatarImageError } from './avatarImagePicker.types';

// 兜底实现：Metro 在 web 上选 .web.ts。原生应用还没有选图片的模块，canPickAvatar 为 false，设置页不显示「上传」。
export const canPickAvatar = false;

export async function pickAvatarFile(): Promise<Blob | null> {
  return null;
}

export async function prepareAvatarImage(_file: Blob): Promise<LeadAvatarUploadRequest> {
  throw new AvatarImageError('这个平台还不能上传图片');
}
