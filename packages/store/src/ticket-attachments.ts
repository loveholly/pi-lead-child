// 工单附件（工单 #231，protocol 的 ticket-attachments.ts）。表在 schema.ts 的 ticket_attachments（由 SCHEMA 建，不占迁移号）。
//
// 文件存在数据目录的 attachments/item-<工单号>/ 下，库里记元数据和来源。只收图片（PNG、JPEG、GIF、WebP）和文本，
// 单个最大 10 MB：类型按内容核对，不信声明的类型。同一张工单同一个来源编号只挂一次，再挂一次返回原来那个。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  bareMimeType, formatAttachmentBytes, sniffChatImageMimeType, ticketAttachmentKindOf,
  TICKET_ATTACHMENT_ID_PATTERN, TICKET_ATTACHMENT_MAX_BYTES, TICKET_ATTACHMENT_MAX_PER_TICKET,
  type TicketAttachment, type TicketAttachmentKind, type TicketAttachmentOrigin,
} from "@pi-lead-child/protocol";

import type { Db } from "./db.js";

/** 挂附件不成的原因：invalid_input（类型、大小、内容不对）、not_found（工单或附件不存在）、limit（这张工单挂满了）。 */
export class TicketAttachmentError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "limit", message: string) {
    super(message);
    this.name = "TicketAttachmentError";
  }
}

export interface TicketAttachmentInput {
  itemId: number;
  name: string;
  mimeType: string;
  data: Uint8Array;
  // 来源里的文件编号，例如 slack:F0123、img_xxx。
  sourceRef: string;
  origin: TicketAttachmentOrigin;
  addedBy: "lead" | "user" | "system";
  now?: Date;
}

export interface CheckedAttachment {
  kind: TicketAttachmentKind;
  mimeType: string;
}

const NAME_MAX = 200;
const ORIGIN_TEXT_MAX = 200;
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/**
 * 核对一个文件能不能当附件（不写盘）：只收图片和文本，单个最大 10 MB。图片按文件头认格式（声明的类型不对时以文件头为准，
 * 认不出时拒收）；文本要是 UTF-8、不含 NUL。不行时抛 TicketAttachmentError，写清楚是哪个文件、为什么。
 */
export function checkTicketAttachment(input: { name: string; mimeType: string; data: Uint8Array }): CheckedAttachment {
  const size = input.data.byteLength;
  if (size > TICKET_ATTACHMENT_MAX_BYTES) {
    throw new TicketAttachmentError("invalid_input",
      `附件 ${input.name} 有 ${formatAttachmentBytes(size)}，超过了单个附件的上限 ${formatAttachmentBytes(TICKET_ATTACHMENT_MAX_BYTES)}`);
  }
  if (size === 0) throw new TicketAttachmentError("invalid_input", `附件 ${input.name} 是空文件`);
  const declared = bareMimeType(input.mimeType);
  const sniffed = sniffChatImageMimeType(input.data);
  if (sniffed) return { kind: "image", mimeType: sniffed };
  const kind = ticketAttachmentKindOf(declared);
  if (kind === "image") throw new TicketAttachmentError("invalid_input", `附件 ${input.name} 说是 ${declared}，但内容不是 PNG、JPEG、GIF、WebP 图片`);
  if (kind !== "text") {
    throw new TicketAttachmentError("invalid_input",
      `附件只收图片（PNG、JPEG、GIF、WebP）和文本文件，${input.name} 是 ${declared || "不知道的类型"}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.data);
  } catch {
    throw new TicketAttachmentError("invalid_input", `附件 ${input.name} 说是文本（${declared}），但内容不是 UTF-8 文字`);
  }
  if (text.includes("\u0000")) throw new TicketAttachmentError("invalid_input", `附件 ${input.name} 说是文本（${declared}），但内容里有二进制数据`);
  return { kind: "text", mimeType: declared };
}

interface AttachmentRow {
  id: string;
  item_id: number;
  name: string;
  kind: TicketAttachmentKind;
  mime_type: string;
  byte_size: number;
  sha256: string;
  storage_path: string;
  source_ref: string;
  origin_kind: "external" | "user";
  origin_source: string;
  origin_conversation: string | null;
  origin_message: string | null;
  origin_sender: string | null;
  created_at: string;
}

const COLUMNS = `id, item_id, name, kind, mime_type, byte_size, sha256, storage_path, source_ref, origin_kind, origin_source,
  origin_conversation, origin_message, origin_sender, created_at`;

function toAttachment(row: AttachmentRow): TicketAttachment {
  const origin: TicketAttachmentOrigin = row.origin_kind === "external"
    ? {
        kind: "external", source: row.origin_source,
        conversation: row.origin_conversation, message: row.origin_message, sender: row.origin_sender,
      }
    : { kind: "user", source: "chat" };
  return {
    id: row.id, ticketId: row.item_id, name: row.name, kind: row.kind, mimeType: row.mime_type, size: row.byte_size,
    sourceRef: row.source_ref, origin, createdAt: row.created_at,
  };
}

/** 附件文件的绝对路径。storage_path 跑出数据目录的 attachments/ 时报错，不去读。核查证据（review-evidence.ts）也用它。 */
export function attachmentPath(dataDir: string, storagePath: string): string {
  const root = resolve(dataDir, "attachments");
  const path = resolve(dataDir, storagePath);
  const inside = relative(root, path);
  if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`)) throw new Error("ticket attachment path escapes the attachments directory");
  return path;
}

/**
 * 把一个文件写进数据目录的 attachments/item-<工单号>/（先写临时文件再改名），返回库里记的相对路径和绝对路径。
 * 文件名是编号加按类型定的后缀。核查证据（review-evidence.ts）也用它，两者存在同一个地方。
 */
export async function writeAttachmentFile(
  dataDir: string, itemId: number, fileId: string, mimeType: string, data: Uint8Array,
): Promise<{ storagePath: string; path: string }> {
  const extension = EXTENSIONS[mimeType] ?? ".txt";
  const storagePath = ["attachments", `item-${itemId}`, `${fileId}${extension}`].join("/");
  const path = attachmentPath(dataDir, storagePath);
  await mkdir(join(dataDir, "attachments", `item-${itemId}`), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, data, { mode: 0o600, flag: "wx" });
  await rename(temp, path);
  return { storagePath, path };
}

/** 一张工单的附件，先挂的在前。 */
export function listTicketAttachments(db: Db, itemId: number): TicketAttachment[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM ticket_attachments WHERE item_id = ? ORDER BY created_at, rowid`)
    .all(itemId) as AttachmentRow[];
  return rows.map(toAttachment);
}

export function getTicketAttachment(db: Db, itemId: number, id: string): TicketAttachment | null {
  if (!TICKET_ATTACHMENT_ID_PATTERN.test(id)) return null;
  const row = db.prepare(`SELECT ${COLUMNS} FROM ticket_attachments WHERE item_id = ? AND id = ?`).get(itemId, id) as AttachmentRow | undefined;
  return row ? toAttachment(row) : null;
}

/**
 * 挂一个附件：先核对（checkTicketAttachment），再把文件写进数据目录（先写临时文件再改名），最后记进库。
 * 同一张工单已经挂过同一个来源编号时不再写，返回原来那个（added=false）。
 */
export async function addTicketAttachment(db: Db, dataDir: string, input: TicketAttachmentInput): Promise<{ attachment: TicketAttachment; added: boolean }> {
  const name = (input.name.replace(/[\u0000-\u001f/\\]/g, " ").trim() || input.sourceRef).slice(0, NAME_MAX);
  const exists = db.prepare("SELECT 1 FROM items WHERE id = ?").get(input.itemId);
  if (!exists) throw new TicketAttachmentError("not_found", `没有工单 #${input.itemId}`);
  const existing = db.prepare(`SELECT ${COLUMNS} FROM ticket_attachments WHERE item_id = ? AND source_ref = ?`)
    .get(input.itemId, input.sourceRef) as AttachmentRow | undefined;
  if (existing) return { attachment: toAttachment(existing), added: false };
  const count = (db.prepare("SELECT COUNT(*) AS n FROM ticket_attachments WHERE item_id = ?").get(input.itemId) as { n: number }).n;
  if (count >= TICKET_ATTACHMENT_MAX_PER_TICKET) {
    throw new TicketAttachmentError("limit", `工单 #${input.itemId} 已经有 ${count} 个附件，一张工单最多 ${TICKET_ATTACHMENT_MAX_PER_TICKET} 个`);
  }
  const checked = checkTicketAttachment({ name, mimeType: input.mimeType, data: input.data });
  const id = `att_${randomBytes(12).toString("base64url")}`;
  const { storagePath, path } = await writeAttachmentFile(dataDir, input.itemId, id, checked.mimeType, input.data);
  const createdAt = (input.now ?? new Date()).toISOString();
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const origin = input.origin;
  try {
    const inserted = db.prepare(
      `INSERT INTO ticket_attachments (id, item_id, name, kind, mime_type, byte_size, sha256, storage_path, source_ref, origin_kind,
         origin_source, origin_conversation, origin_message, origin_sender, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, source_ref) DO NOTHING`,
    ).run(
      id, input.itemId, name, checked.kind, checked.mimeType, input.data.byteLength, sha256, storagePath, input.sourceRef, origin.kind,
      origin.source,
      origin.kind === "external" ? clip(origin.conversation, ORIGIN_TEXT_MAX) : null,
      origin.kind === "external" ? clip(origin.message, ORIGIN_TEXT_MAX) : null,
      origin.kind === "external" ? clip(origin.sender, ORIGIN_TEXT_MAX) : null,
      input.addedBy, createdAt,
    );
    if (inserted.changes === 0) {
      // 写盘的时候别人先挂了同一个：用那一个，删掉这次写的文件。
      await rm(path, { force: true });
      const row = db.prepare(`SELECT ${COLUMNS} FROM ticket_attachments WHERE item_id = ? AND source_ref = ?`)
        .get(input.itemId, input.sourceRef) as AttachmentRow;
      return { attachment: toAttachment(row), added: false };
    }
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return { attachment: getTicketAttachment(db, input.itemId, id)!, added: true };
}

/** 读一个附件的内容。文件不见了或者内容和记下的哈希对不上时抛错。 */
export async function readTicketAttachment(db: Db, dataDir: string, itemId: number, id: string): Promise<{ attachment: TicketAttachment; data: Buffer }> {
  if (!TICKET_ATTACHMENT_ID_PATTERN.test(id)) throw new TicketAttachmentError("not_found", `没有编号是 ${id.slice(0, 80)} 的附件`);
  const row = db.prepare(`SELECT ${COLUMNS} FROM ticket_attachments WHERE item_id = ? AND id = ?`).get(itemId, id) as AttachmentRow | undefined;
  if (!row) throw new TicketAttachmentError("not_found", `工单 #${itemId} 没有编号是 ${id} 的附件`);
  let data: Buffer;
  try {
    data = await readFile(attachmentPath(dataDir, row.storage_path));
  } catch {
    throw new TicketAttachmentError("not_found", `附件 ${row.name} 的文件不见了`);
  }
  if (createHash("sha256").update(data).digest("hex") !== row.sha256) {
    throw new TicketAttachmentError("not_found", `附件 ${row.name} 的文件和挂上时的不一样，不读它`);
  }
  return { attachment: toAttachment(row), data };
}
