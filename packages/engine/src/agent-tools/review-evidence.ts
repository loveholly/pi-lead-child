// 核查证据（工单 #503，protocol 的 review-evidence.ts）：把核查员在核查工作区里截的图挂到工单上，标明对应哪几条验收标准。
//
// 两个入口调同一个函数（attachReviewEvidence）：
//   · 核查员在核查时调 attach_review_evidence（agent-tools/definitions.ts）：只能挂自己这次核查的证据，核查在跑时才行。
//   · 已经结束的核查用操作层的 review_attempt.attach_evidence 补挂（ui-actions/review-evidence.ts）：页面入口和 Lead 的
//     perform_action。不重跑核查，不改交付、核查的结论和工单的阶段：只多几行证据。
//
// 读文件（readWorkspaceImage）只读那次核查的工作区里的文件：
//   · 路径（相对工作区，或者绝对路径）解析以后要在工作区里；`..` 跑出去的拒绝。
//   · 符号链接按真实路径算：指向工作区外的拒绝。
//   · 像密钥、凭证的文件（.env、*.pem、*.key、id_rsa、credentials*、secrets.*，.git、.ssh 里的）一律不读。
//   · 只收图片（.png、.jpg、.jpeg、.gif、.webp），类型再按内容核对（store 的 checkTicketAttachment），单个最大 10 MB。
//   · 先核对完这一次的所有文件，再写盘：一个不行就都不挂。
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  formatAttachmentBytes, REVIEW_EVIDENCE_CAPTION_MAX, REVIEW_EVIDENCE_CRITERIA_MAX, REVIEW_EVIDENCE_MAX_PER_CALL,
  REVIEW_EVIDENCE_PATH_MAX, TICKET_ATTACHMENT_MAX_BYTES,
  type ReviewEvidence, type ReviewEvidenceAddedBy, type ReviewEvidenceFile,
} from "@pi-lead-child/protocol";
import {
  addReviewEvidence, checkTicketAttachment, getItem, getRun, getWorkspace, itemUpdatedEvent, listAcceptanceCriteria,
  publishGatewayEvents, type Db,
} from "@pi-lead-child/store";
import type { Run } from "@pi-lead-child/core";

/** 挂不了的原因：invalid_input（路径、类型、标准不对）、not_found（核查、工作区、文件不在）、not_allowed（越界、敏感文件）。 */
export class ReviewEvidenceError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "not_allowed", message: string) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

// 不读的目录：版本库和密钥目录。
const SENSITIVE_DIRS = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker"]);
// 不读的文件名（和仓库的安全规定一致）：.env 和 .env.*（.env.example、.env.sample、.env.template 除外）、证书和私钥、凭证、密钥文件。
function sensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || (lower.startsWith(".env.") && !/^\.env\.(example|sample|template)$/.test(lower))) return true;
  if (/\.(pem|key|p12|pfx)$/.test(lower)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(lower)) return true;
  return lower.startsWith("credentials") || lower.startsWith("secrets.");
}

function insideOf(root: string, path: string): string | null {
  const inside = relative(root, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return inside;
}

function assertNotSensitive(inside: string, shown: string): void {
  const parts = inside.split(sep);
  if (parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase())) || parts.some(sensitiveName)) {
    throw new ReviewEvidenceError("not_allowed", `${shown} 像是密钥、凭证或版本库里的文件，不读它`);
  }
}

export interface WorkspaceImage {
  // 相对工作区的路径，分隔符是 /。
  path: string;
  name: string;
  mimeType: string;
  data: Buffer;
}

/**
 * 读工作区里的一张图片。路径可以相对工作区，也可以是工作区里的绝对路径。越界、指向工作区外的符号链接、
 * 敏感文件、不是图片的文件、太大的文件都拒绝，抛 ReviewEvidenceError，写清楚是哪个路径、为什么。
 */
export async function readWorkspaceImage(root: string, requested: string): Promise<WorkspaceImage> {
  const shown = JSON.stringify(requested.slice(0, 200));
  const trimmed = requested.trim();
  if (!trimmed || trimmed.length > REVIEW_EVIDENCE_PATH_MAX || trimmed.includes("\u0000")) {
    throw new ReviewEvidenceError("invalid_input", `路径 ${shown} 不对：要写工作区里的一个文件，最长 ${REVIEW_EVIDENCE_PATH_MAX} 个字`);
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new ReviewEvidenceError("not_found", "这次核查的工作区已经不在了，里面的截图取不到");
  }
  // 先按字面判断：解析以后要在工作区里（工作区自己的路径里可能有符号链接，例如 /tmp，两种写法都认）。
  const lexicalRoot = resolve(root);
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(lexicalRoot, trimmed);
  const lexicalInside = insideOf(lexicalRoot, candidate) ?? insideOf(rootReal, candidate);
  if (lexicalInside === null) throw new ReviewEvidenceError("not_allowed", `${shown} 不在这次核查的工作区里，不读它`);
  assertNotSensitive(lexicalInside, shown);
  // 再按真实路径判断：符号链接指向工作区外的拒绝。
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ReviewEvidenceError("not_found", `工作区里没有 ${shown}`);
  }
  const inside = insideOf(rootReal, real);
  if (inside === null) throw new ReviewEvidenceError("not_allowed", `${shown} 是指向工作区外的符号链接，不读它`);
  assertNotSensitive(inside, shown);
  const mimeType = IMAGE_TYPES[extname(real).toLowerCase()];
  if (!mimeType) {
    throw new ReviewEvidenceError("invalid_input", `${shown} 不是支持的图片：核查证据只收 .png、.jpg、.jpeg、.gif、.webp`);
  }
  // 不跟随最后一节的符号链接打开，再看打开的这个是不是普通文件、大小行不行。
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ReviewEvidenceError("not_found", `打不开 ${shown}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ReviewEvidenceError("invalid_input", `${shown} 不是一个普通文件`);
    if (stat.size > TICKET_ATTACHMENT_MAX_BYTES) {
      throw new ReviewEvidenceError("invalid_input",
        `${shown} 有 ${formatAttachmentBytes(stat.size)}，超过了单个文件的上限 ${formatAttachmentBytes(TICKET_ATTACHMENT_MAX_BYTES)}`);
    }
    const data = await handle.readFile();
    const name = basename(real);
    let checked;
    try {
      checked = checkTicketAttachment({ name, mimeType, data });
    } catch (error) {
      throw new ReviewEvidenceError("invalid_input", error instanceof Error ? error.message : String(error));
    }
    if (checked.kind !== "image") throw new ReviewEvidenceError("invalid_input", `${shown} 的内容不是图片`);
    return { path: inside.split(sep).join("/"), name, mimeType: checked.mimeType, data };
  } finally {
    await handle.close();
  }
}

/** 一次核查能读哪个目录：它的工作区；没有工作区的核查是工单的工作目录。都没有时为 null。 */
export function reviewWorkspaceRoot(db: Db, run: Pick<Run, "workspace_id" | "item_id">): string | null {
  const workspace = run.workspace_id ? getWorkspace(db, run.workspace_id) : undefined;
  if (workspace) return workspace.path;
  return getItem(db, run.item_id)?.workdir ?? null;
}

/** 一个核查员的执行记录。不是核查员的报 not_found。 */
export function reviewRunOf(db: Db, runId: number): Run {
  const run = getRun(db, runId);
  if (!run || run.role !== "reviewer") throw new ReviewEvidenceError("not_found", `没有编号是 ${runId} 的核查`);
  return run;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewEvidenceError("invalid_input", `${where} 要是一个对象`);
  return value as Record<string, unknown>;
}

/**
 * 核对一次要挂的文件清单（核查员的工具传来的是没核对过的参数）：1 到 10 项，每项 {path, criteria, caption?}。
 * criteria 是这张工单的验收标准 id（改过、删了的也认，补挂旧核查时要用）；工单有验收标准时每张图至少对应一条。
 * 返回按标准顺序排好的 id。
 */
export function normalizeEvidenceFiles(db: Db, itemId: number, raw: unknown): ReviewEvidenceFile[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > REVIEW_EVIDENCE_MAX_PER_CALL) {
    throw new ReviewEvidenceError("invalid_input", `files 要是 1 到 ${REVIEW_EVIDENCE_MAX_PER_CALL} 项的数组：每张图一项 {path, criteria, caption}`);
  }
  const known = listAcceptanceCriteria(db, itemId, { includeDeleted: true });
  const order = new Map(known.map((criterion, index) => [criterion.id, index]));
  const idList = known.map((criterion) => criterion.id).join("、") || "（没有）";
  return raw.map((entry, index) => {
    const where = `files[${index}]`;
    const file = record(entry, where);
    for (const key of Object.keys(file)) {
      if (!["path", "criteria", "caption"].includes(key)) throw new ReviewEvidenceError("invalid_input", `${where} 不认识 ${key}`);
    }
    if (typeof file.path !== "string" || !file.path.trim()) throw new ReviewEvidenceError("invalid_input", `${where}.path 要写工作区里的图片路径`);
    const criteria = file.criteria ?? [];
    if (!Array.isArray(criteria) || criteria.length > REVIEW_EVIDENCE_CRITERIA_MAX) {
      throw new ReviewEvidenceError("invalid_input", `${where}.criteria 要是验收标准 id 的数组，最多 ${REVIEW_EVIDENCE_CRITERIA_MAX} 个`);
    }
    for (const id of criteria) {
      if (!Number.isSafeInteger(id) || !order.has(id as number)) {
        throw new ReviewEvidenceError("invalid_input", `${where}.criteria 里的 ${JSON.stringify(id)} 不是这张工单的验收标准。这张工单的 id：${idList}`);
      }
    }
    if (known.length && criteria.length === 0) {
      throw new ReviewEvidenceError("invalid_input", `${where}.criteria 至少写一条：这张图证明的是哪几条验收标准（id：${idList}）`);
    }
    if (file.caption !== undefined && (typeof file.caption !== "string" || file.caption.length > REVIEW_EVIDENCE_CAPTION_MAX)) {
      throw new ReviewEvidenceError("invalid_input", `${where}.caption 要是一句话，最长 ${REVIEW_EVIDENCE_CAPTION_MAX} 个字`);
    }
    const sorted = [...new Set(criteria as number[])].sort((a, b) => order.get(a)! - order.get(b)!);
    return { path: file.path, criteria: sorted, ...(typeof file.caption === "string" ? { caption: file.caption } : {}) };
  });
}

export interface AttachReviewEvidenceResult {
  ticketId: number;
  attemptId: number;
  results: { evidence: ReviewEvidence; added: boolean }[];
}

/**
 * 把一次核查工作区里的截图挂成核查证据。先读完、核对完所有文件，再写盘、记库；一个不行就都不挂。
 * 挂上了新的时，工单的更新时间改成现在，界面重新读。不改工单的阶段、交付和核查的结论。
 */
export async function attachReviewEvidence(
  db: Db, dataDir: string, input: { runId: number; files: unknown; addedBy: ReviewEvidenceAddedBy; now?: Date },
): Promise<AttachReviewEvidenceResult> {
  const run = reviewRunOf(db, input.runId);
  const files = normalizeEvidenceFiles(db, run.item_id, input.files);
  const root = reviewWorkspaceRoot(db, run);
  if (!root) throw new ReviewEvidenceError("not_found", "这次核查没有工作区，没有地方可以取截图");
  const images: { file: ReviewEvidenceFile; image: WorkspaceImage }[] = [];
  for (const file of files) images.push({ file, image: await readWorkspaceImage(root, file.path) });
  const results: AttachReviewEvidenceResult["results"] = [];
  for (const { file, image } of images) {
    results.push(await addReviewEvidence(db, dataDir, {
      itemId: run.item_id, runId: run.id, name: image.name, mimeType: image.mimeType, data: image.data,
      sourcePath: image.path, criterionIds: file.criteria, caption: file.caption?.slice(0, REVIEW_EVIDENCE_CAPTION_MAX) ?? null,
      addedBy: input.addedBy, ...(input.now ? { now: input.now } : {}),
    }));
  }
  if (results.some((result) => result.added)) {
    db.prepare("UPDATE items SET updated_at = datetime('now') WHERE id = ?").run(run.item_id);
    publishGatewayEvents(db, [itemUpdatedEvent(run.item_id)]);
  }
  return { ticketId: run.item_id, attemptId: run.id, results };
}

/** 给 agent 看的结果：挂了什么、原来就挂过什么。 */
export function reviewEvidenceToolResult(result: AttachReviewEvidenceResult): Record<string, unknown> {
  const fact = (evidence: ReviewEvidence) => ({
    evidence_id: evidence.id, path: evidence.path, size: formatAttachmentBytes(evidence.size), criteria: evidence.criterionIds,
    ...(evidence.caption ? { caption: evidence.caption } : {}),
  });
  return {
    ticket_id: result.ticketId,
    attempt_id: result.attemptId,
    attached: result.results.filter((entry) => entry.added).map((entry) => fact(entry.evidence)),
    already_attached: result.results.filter((entry) => !entry.added).map((entry) => fact(entry.evidence)),
    note: "The user sees these images in the ticket detail, under 'Review evidence', next to the criteria they prove.",
  };
}
