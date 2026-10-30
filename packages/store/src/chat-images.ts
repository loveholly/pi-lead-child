// 用户发给 Lead 的图片（protocol 的 chat-images.ts）。表在 schema.ts 的 chat_images（由 SCHEMA 建，不占迁移号）。
import { randomBytes } from "node:crypto";

import type { ChatImageMimeType, ChatImageRef } from "@pi-lead-child/protocol";

import type { Db } from "./db.js";

export interface ChatImageData {
  mimeType: ChatImageMimeType;
  data: Buffer;
}

export interface StoredChatImage extends ChatImageData {
  id: string;
  turnId: string;
}

const isoNow = (now?: Date) => (now ?? new Date()).toISOString();

// 存下一轮带的图片，按给的顺序。返回每张的 id。调用方和建这一轮放在同一个事务里。
export function insertChatImages(db: Db, turnId: string, images: readonly ChatImageData[], now?: Date): ChatImageRef[] {
  const insert = db.prepare(
    `INSERT INTO chat_images (id, turn_id, position, mime_type, data, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = isoNow(now);
  return images.map((image, position) => {
    const id = `img_${randomBytes(12).toString("base64url")}`;
    insert.run(id, turnId, position, image.mimeType, image.data, image.data.length, createdAt);
    return { id, mimeType: image.mimeType };
  });
}

// 一轮带的图片，按发送时的顺序。没有时是空数组。
export function listTurnChatImages(db: Db, turnId: string): ChatImageData[] {
  const rows = db.prepare(
    "SELECT mime_type, data FROM chat_images WHERE turn_id = ? ORDER BY position",
  ).all(turnId) as Array<{ mime_type: ChatImageMimeType; data: Buffer }>;
  return rows.map((row) => ({ mimeType: row.mime_type, data: row.data }));
}

// 几轮各带了哪些图片（不读图片数据）。没有图片的轮次不在结果里。
export function listChatImageRefs(db: Db, turnIds: readonly string[]): Map<string, ChatImageRef[]> {
  const refs = new Map<string, ChatImageRef[]>();
  if (!turnIds.length) return refs;
  const select = db.prepare(
    `SELECT id, turn_id, mime_type FROM chat_images
     WHERE turn_id IN (SELECT value FROM json_each(?)) ORDER BY turn_id, position`,
  );
  for (const row of select.all(JSON.stringify(turnIds)) as Array<{ id: string; turn_id: string; mime_type: ChatImageMimeType }>) {
    const list = refs.get(row.turn_id) ?? [];
    list.push({ id: row.id, mimeType: row.mime_type });
    refs.set(row.turn_id, list);
  }
  return refs;
}

export function getChatImage(db: Db, id: string): StoredChatImage | null {
  const row = db.prepare("SELECT id, turn_id, mime_type, data FROM chat_images WHERE id = ?").get(id) as
    { id: string; turn_id: string; mime_type: ChatImageMimeType; data: Buffer } | undefined;
  return row ? { id: row.id, turnId: row.turn_id, mimeType: row.mime_type, data: row.data } : null;
}
