// 发给 Lead 的图片（2026-10-25）。
//
// 用户在会话的输入框里选或粘贴图片，chat.send 带上 images：每张是 base64 的图片数据和它的 MIME 类型。
// daemon 把图片按轮次存下来，交给 Lead 的模型（pi 的 prompt、steer、followUp 都能带图片），会话快照里列出图片的 id，
// 客户端按 id 取图（GET /v1/chat/images/:id）。
//
// 线上契约：
//   · 旧 daemon 严格校验命令、不认识 images：客户端只在 hello.v2 的 capabilities 里有 CHAT_IMAGES_CAPABILITY 时带它。
//   · 会话快照的 images 和别的选收字段一样，只在 ?include=images 时才有：旧客户端严格校验整条记录。
//   · 只有 Lead 的会话收图片。工单对话交给工单的 agent，它们的运行时还不收图片，带图片的工单消息被拒收。
import { Type, type Static } from "typebox";

export const CHAT_IMAGES_CAPABILITY = "chat.images.v1";
// GET /v1/conversation/turns?include=images：每一轮带上用户发的图片。
export const CHAT_IMAGES_INCLUDE = "images";

// 模型服务都收的几种格式（Anthropic、OpenAI 都收这四种）。别的格式由客户端先转成其中一种。
export const CHAT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ChatImageMimeType = typeof CHAT_IMAGE_MIME_TYPES[number];
export const ChatImageMimeTypeSchema = Type.Union([
  Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp"), Type.Literal("image/gif"),
]);

// 一条消息最多带几张图片。
export const CHAT_IMAGE_MAX_COUNT = 8;
// 一张图片的 base64 最长多少个字符。Anthropic 对一张图片的上限是 5 MB（按 base64 算）。
export const CHAT_IMAGE_MAX_BASE64_LENGTH = 5 * 1024 * 1024;
// 一条消息所有图片的 base64 加起来最长多少个字符。客户端先缩小再发，平常一张只有几百 KB。
export const CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH = 20 * 1024 * 1024;
// 带图片的 chat.send 最大多少字节（WebSocket 的一帧和 HTTP 兜底的请求体）：图片加上 1 MB 给文字和命令的其余部分。
export const CHAT_SEND_MAX_BYTES = CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH + 1024 * 1024;
// 客户端把图片的长边缩到多少像素以内。更大的图片模型服务也会先缩小（Anthropic 建议长边不超过 1568）。
export const CHAT_IMAGE_MAX_EDGE = 1568;

// chat.send 里的一张图片。
export const ChatImageInputSchema = Type.Object({
  mimeType: ChatImageMimeTypeSchema,
  data: Type.String({ minLength: 1, maxLength: CHAT_IMAGE_MAX_BASE64_LENGTH }),
}, { additionalProperties: false });
export type ChatImageInput = Static<typeof ChatImageInputSchema>;

export const ChatImagesInputSchema = Type.Array(ChatImageInputSchema, { minItems: 1, maxItems: CHAT_IMAGE_MAX_COUNT });

// 会话快照里用户的一轮带的一张图片（include=images）。按 id 取图。
export const ChatImageRefSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  mimeType: ChatImageMimeTypeSchema,
}, { additionalProperties: false });
export type ChatImageRef = Static<typeof ChatImageRefSchema>;

// GET /v1/chat/images/:id 的回答。
export const ChatImageSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  mimeType: ChatImageMimeTypeSchema,
  data: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ChatImage = Static<typeof ChatImageSchema>;

export const CHAT_IMAGE_ID_PATTERN = /^img_[A-Za-z0-9_-]{1,64}$/;

// 按文件头判断图片的格式（PNG、JPEG、GIF、WebP）。认不出时返回 null。
// daemon 用它核对客户端声明的 MIME 类型：类型不对的图片交给模型服务，整轮都会失败。
export function sniffChatImageMimeType(bytes: Uint8Array): ChatImageMimeType | null {
  const startsWith = (offset: number, signature: readonly number[]) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF87a、GIF89a。
  if (startsWith(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  // RIFF....WEBP
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}
