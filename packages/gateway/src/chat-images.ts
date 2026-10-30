// chat.send 带的图片（protocol 的 chat-images.ts）：校验，再解码成字节交给 daemon。
// 形状（格式、张数、单张长度）由 schema 管；这里管 schema 管不到的：总长度、base64 能不能解、内容是不是声明的格式。
// 声明的格式和内容对不上的图片交给模型服务，整轮都会失败，所以在收下消息之前拒收。
import { Value } from "typebox/value";

import {
  CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH, ChatImagesInputSchema, sniffChatImageMimeType, type ChatImageInput,
} from "@pi-lead-child/protocol";
import type { ChatImageData } from "@pi-lead-child/store";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type DecodedChatImages = { ok: true; images: ChatImageData[] } | { ok: false; error: string };

export function decodeChatImages(raw: unknown): DecodedChatImages {
  if (!Value.Check(ChatImagesInputSchema, raw)) {
    return { ok: false, error: "images must be 1 to 8 images, each { mimeType, data } with base64 data of at most 5 MB" };
  }
  const images = raw as ChatImageInput[];
  const total = images.reduce((sum, image) => sum + image.data.length, 0);
  if (total > CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH) return { ok: false, error: "images are too large in total" };
  const decoded: ChatImageData[] = [];
  for (const [index, image] of images.entries()) {
    if (image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
      return { ok: false, error: `image ${index + 1} is not valid base64` };
    }
    const data = Buffer.from(image.data, "base64");
    if (sniffChatImageMimeType(data) !== image.mimeType) {
      return { ok: false, error: `image ${index + 1} is not a ${image.mimeType} image` };
    }
    decoded.push({ mimeType: image.mimeType, data });
  }
  return { ok: true, images: decoded };
}
