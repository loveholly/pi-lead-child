// 核查证据（工单 #503，protocol 的 review-evidence.ts）。表在 schema.ts 的 review_evidence（由 SCHEMA 建，不占迁移号）。
//
// 文件和工单附件存在同一个地方（ticket-attachments.ts 的 writeAttachmentFile），按内容核对类型（checkTicketAttachment），
// 单个最大 10 MB，只收图片。同一次核查同一个文件内容只挂一次，再挂一次返回原来那个。
// 这里只管存和读：文件从哪个工作区来、能不能读，由调用方（engine 的 agent-tools/review-evidence.ts）先核对。
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import {
  REVIEW_EVIDENCE_CAPTION_MAX, REVIEW_EVIDENCE_ID_PATTERN, REVIEW_EVIDENCE_MAX_PER_TICKET, REVIEW_EVIDENCE_PATH_MAX,
  type ReviewEvidence, type ReviewEvidenceAddedBy,
} from "@pi-lead-child/protocol";

import type { Db } from "./db.js";
import { attachmentPath, checkTicketAttachment, TicketAttachmentError, writeAttachmentFile } from "./ticket-attachments.js";

export interface ReviewEvidenceInput {
  itemId: number;
  runId: number;
  name: string;
  mimeType: string;
  data: Uint8Array;
  // 图片在核查工作区里的相对路径。
  sourcePath: string;
  criterionIds: readonly number[];
  caption: string | null;
  addedBy: ReviewEvidenceAddedBy;
  now?: Date;
}

interface EvidenceRow {
  id: string;
  item_id: number;
  run_id: number;
  name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  storage_path: string;
  source_path: string;
  criterion_ids: string;
  caption: string | null;
  added_by: ReviewEvidenceAddedBy;
  created_at: string;
}

const COLUMNS = "id, item_id, run_id, name, mime_type, byte_size, sha256, storage_path, source_path, criterion_ids, caption, added_by, created_at";
const NAME_MAX = 200;

function criterionIdsOf(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

function toEvidence(row: EvidenceRow): ReviewEvidence {
  return {
    id: row.id, ticketId: row.item_id, attemptId: row.run_id, name: row.name, mimeType: row.mime_type, size: row.byte_size,
    criterionIds: criterionIdsOf(row.criterion_ids), caption: row.caption, path: row.source_path, addedBy: row.added_by,
    createdAt: row.created_at,
  };
}

/** 一张工单的核查证据，先挂的在前。 */
export function listReviewEvidence(db: Db, itemId: number): ReviewEvidence[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM review_evidence WHERE item_id = ? ORDER BY created_at, rowid`).all(itemId) as EvidenceRow[];
  return rows.map(toEvidence);
}

/**
 * 挂一张证据：先核对（只收图片，类型按内容认，单个最大 10 MB），再写进附件的存储，最后记进库。
 * 同一次核查已经挂过同样内容的文件时不再写，返回原来那个（added=false）。不改工单的阶段、交付和核查的结论。
 */
export async function addReviewEvidence(db: Db, dataDir: string, input: ReviewEvidenceInput): Promise<{ evidence: ReviewEvidence; added: boolean }> {
  const name = (input.name.replace(/[\u0000-\u001f/\\]/g, " ").trim() || "screenshot").slice(0, NAME_MAX);
  if (!db.prepare("SELECT 1 FROM items WHERE id = ?").get(input.itemId)) throw new TicketAttachmentError("not_found", `没有工单 #${input.itemId}`);
  const checked = checkTicketAttachment({ name, mimeType: input.mimeType, data: input.data });
  if (checked.kind !== "image") {
    throw new TicketAttachmentError("invalid_input", `核查证据只收图片（PNG、JPEG、GIF、WebP），${name} 不是图片`);
  }
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const existing = db.prepare(`SELECT ${COLUMNS} FROM review_evidence WHERE run_id = ? AND sha256 = ?`).get(input.runId, sha256) as EvidenceRow | undefined;
  if (existing) return { evidence: toEvidence(existing), added: false };
  const count = (db.prepare("SELECT COUNT(*) AS n FROM review_evidence WHERE item_id = ?").get(input.itemId) as { n: number }).n;
  if (count >= REVIEW_EVIDENCE_MAX_PER_TICKET) {
    throw new TicketAttachmentError("limit", `工单 #${input.itemId} 已经有 ${count} 张核查证据，一张工单最多 ${REVIEW_EVIDENCE_MAX_PER_TICKET} 张`);
  }
  const id = `evd_${randomBytes(12).toString("base64url")}`;
  const { storagePath, path } = await writeAttachmentFile(dataDir, input.itemId, id, checked.mimeType, input.data);
  const caption = input.caption?.trim() ? input.caption.trim().slice(0, REVIEW_EVIDENCE_CAPTION_MAX) : null;
  const criterionIds = [...new Set(input.criterionIds)];
  try {
    const inserted = db.prepare(
      `INSERT INTO review_evidence (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, sha256) DO NOTHING`,
    ).run(
      id, input.itemId, input.runId, name, checked.mimeType, input.data.byteLength, sha256, storagePath,
      input.sourcePath.slice(0, REVIEW_EVIDENCE_PATH_MAX), JSON.stringify(criterionIds), caption, input.addedBy,
      (input.now ?? new Date()).toISOString(),
    );
    if (inserted.changes === 0) {
      // 写盘的时候别人先挂了同一个：用那一个，删掉这次写的文件。
      await rm(path, { force: true });
      const row = db.prepare(`SELECT ${COLUMNS} FROM review_evidence WHERE run_id = ? AND sha256 = ?`).get(input.runId, sha256) as EvidenceRow;
      return { evidence: toEvidence(row), added: false };
    }
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  const row = db.prepare(`SELECT ${COLUMNS} FROM review_evidence WHERE id = ?`).get(id) as EvidenceRow;
  return { evidence: toEvidence(row), added: true };
}

/** 读一张证据的内容。文件不见了或者内容和记下的哈希对不上时抛错。 */
export async function readReviewEvidence(db: Db, dataDir: string, itemId: number, id: string): Promise<{ evidence: ReviewEvidence; data: Buffer }> {
  if (!REVIEW_EVIDENCE_ID_PATTERN.test(id)) throw new TicketAttachmentError("not_found", `没有编号是 ${id.slice(0, 80)} 的核查证据`);
  const row = db.prepare(`SELECT ${COLUMNS} FROM review_evidence WHERE item_id = ? AND id = ?`).get(itemId, id) as EvidenceRow | undefined;
  if (!row) throw new TicketAttachmentError("not_found", `工单 #${itemId} 没有编号是 ${id} 的核查证据`);
  let data: Buffer;
  try {
    data = await readFile(attachmentPath(dataDir, row.storage_path));
  } catch {
    throw new TicketAttachmentError("not_found", `核查证据 ${row.name} 的文件不见了`);
  }
  if (createHash("sha256").update(data).digest("hex") !== row.sha256) {
    throw new TicketAttachmentError("not_found", `核查证据 ${row.name} 的文件和挂上时的不一样，不读它`);
  }
  return { evidence: toEvidence(row), data };
}
