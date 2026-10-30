import { CHAT_IMAGE_MAX_BASE64_LENGTH, type ChatImageMimeType } from '@pi-lead-child/protocol';

import { ChatImageError, composerImage, planChatImage, type ComposerImage } from './chatImagePicker.types';

export { ChatImageError, type ComposerImage } from './chatImagePicker.types';

export const canPickImages = true;

// 打开浏览器的文件选择：只列图片，可以多选。浏览器要求在用户的点按里调用。
// 用户取消时有的浏览器不通知（没有 cancel 事件），Promise 就不结束：没有人在等它做别的事。
export function pickImageFiles(): Promise<Blob[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    const done = (files: Blob[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    // iOS Safari 只打开挂在页面上的文件框。
    document.body.appendChild(input);
    input.click();
  });
}

let sequence = 0;

// 把一张选中或粘贴的图片变成可以发的样子：格式模型收、长边不超过 1568、不太大的原样发；
// 别的缩小以后重新编码（WebP，浏览器不会编 WebP 时用 JPEG）。
export async function prepareChatImage(file: Blob): Promise<ComposerImage> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new ChatImageError('只能发图片');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new ChatImageError('这张图片打不开');
  sequence += 1;
  const key = `image-${Date.now().toString(36)}-${sequence}`;
  try {
    const plan = planChatImage({ mimeType: file.type, bytes: file.size, width: bitmap.width, height: bitmap.height });
    if (plan.keep) return composerImage(key, { mimeType: plan.mimeType, data: await base64Of(file) });
    for (const scale of [1, 0.75, 0.5]) {
      const width = Math.max(1, Math.round(plan.width * scale));
      const height = Math.max(1, Math.round(plan.height * scale));
      const encoded = await encode(bitmap, width, height);
      if (encoded && encoded.data.length <= CHAT_IMAGE_MAX_BASE64_LENGTH) return composerImage(key, encoded);
    }
    throw new ChatImageError('这张图片太大了');
  } finally {
    bitmap.close();
  }
}

async function encode(
  bitmap: ImageBitmap, width: number, height: number,
): Promise<{ mimeType: ChatImageMimeType; data: string } | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const webp = await toBlob(canvas, 'image/webp', 0.9);
  if (webp?.type === 'image/webp') return { mimeType: 'image/webp', data: await base64Of(webp) };
  // JPEG 没有透明：透明的地方铺白底，不然是黑的。
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, width, height);
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.88);
  return jpeg?.type === 'image/jpeg' ? { mimeType: 'image/jpeg', data: await base64Of(jpeg) } : null;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new ChatImageError('这张图片读不出来'));
    reader.readAsDataURL(blob);
  });
}
