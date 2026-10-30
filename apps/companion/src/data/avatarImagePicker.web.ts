import type { LeadAvatarUploadRequest } from '@pi-lead-child/protocol';

import { AvatarImageError, avatarImageType } from './avatarImagePicker.types';

export { AvatarImageError } from './avatarImagePicker.types';

export const canPickAvatar = true;

// 打开浏览器的文件选择，只列 PNG、GIF、WebP，选一张。浏览器要求在用户的点按里调用。
// 用户取消时有的浏览器不通知（没有 cancel 事件），Promise 就不结束：没有人在等它做别的事。
export function pickAvatarFile(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/gif,image/webp';
    input.style.display = 'none';
    const done = (file: Blob | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    // iOS Safari 只打开挂在页面上的文件框。
    document.body.appendChild(input);
    input.click();
  });
}

// 原样上传，不缩小、不重新编码：动图要保留它的帧。daemon 还会按文件头再核对一次格式。
export async function prepareAvatarImage(file: Blob): Promise<LeadAvatarUploadRequest> {
  const mimeType = avatarImageType(file);
  return { mimeType, data: await base64Of(file) };
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new AvatarImageError('这张图片读不出来'));
    reader.readAsDataURL(blob);
  });
}
