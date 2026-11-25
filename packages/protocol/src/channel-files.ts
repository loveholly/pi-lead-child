// 外来消息卡里的图片（工单 #529，2026-11-25）。
//
// Slack 消息附带的图片在正文里是一行标记「[图片 名字，文件编号 slack:F…]」（engine 的 sources/slack.ts）。
// Lead 用 read_channel_file 按文件编号看图；App 的外来消息卡按同一个编号取图，画成缩略图，点开看大图。
//
// 线上契约：
//   · GET /v1/channels/files/:fileId（chat，和读卡一样）取一张图片，回 ChannelImage（base64）。
//   · fileId 只能是 Slack 的文件编号（CHANNEL_FILE_ID_PATTERN）：不收网址、本地路径，也不收别的来源。
//   · 只回图片：按文件头认格式（sniffChatImageMimeType），只认 PNG、JPEG、GIF、WebP，别的回 404（details.reason 是 not_image）。
//   · 文件要在收到过的消息里出现过（账本里有这个文件编号的标记），没有时回 404。
//   · 大小上限和 Lead 的 read_channel_file 一样（CHANNEL_FILE_MAX_BYTES）。
//   · 同一个文件编号的内容不变：回答带 private 的缓存头，客户端也按编号缓存。
//   · 旧 daemon 没有这个接口（404）：卡上照旧显示文字标记。
import { Type, type Static } from "typebox";

import { ChatImageMimeTypeSchema } from "./chat-images.ts";

// Slack 的文件编号带来源名：slack:F 开头，后面是大写字母和数字（和 engine 里 readFile 认的一样）。
export const CHANNEL_FILE_ID_PATTERN = /^slack:F[A-Z0-9]{1,30}$/;

// 一个文件最多下载多少字节（Lead 的 read_channel_file 用同一个值）。
export const CHANNEL_FILE_MAX_BYTES = 20 * 1024 * 1024;

// 图片的缓存时间（秒）。文件编号对应的内容不变；一天以后再取一次，删掉的文件不会一直留在缓存里。
export const CHANNEL_IMAGE_CACHE_SECONDS = 24 * 60 * 60;

/** GET /v1/channels/files/:fileId 的路径。 */
export function channelFilePath(fileId: string): string {
  return `/v1/channels/files/${encodeURIComponent(fileId)}`;
}

// GET /v1/channels/files/:fileId 的回答。
export const ChannelImageSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  mimeType: ChatImageMimeTypeSchema,
  data: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ChannelImage = Static<typeof ChannelImageSchema>;
