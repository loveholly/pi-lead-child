// Lead 的名字、人格和互动风格（protocol 的 lead-profile.ts）。存在 kv 的 lead.profile，一行 JSON。
// 这里只读写库：校验、授权和主人操作在 engine 的 lead-profile.ts。
// 读到的值坏了（手改、截断）时不抛错：坏掉的字段按缺省值算，界面和 Lead 的提示词照常有名字可用。
import {
  DEFAULT_LEAD_PROFILE, LEAD_NAME_MAX_LENGTH, LEAD_PROFILE_TEXT_MAX_LENGTH, normalizeLeadName, normalizeLeadProfileText,
  type LeadProfileAuthor, type LeadProfileDto, type LeadProfileFields,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const LEAD_PROFILE_KEY = "lead.profile";

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = normalizeLeadProfileText(value);
  return [...clean].length <= max ? clean : null;
}

function nameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = normalizeLeadName(value);
  return clean && [...clean].length <= LEAD_NAME_MAX_LENGTH ? clean : null;
}

/** 现在的名字、人格和互动风格。从没改过时是缺省值（名字 Paimon，另外两段空）。 */
export function getLeadProfile(db: Db): LeadProfileDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_PROFILE_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_LEAD_PROFILE };
  let stored: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    stored = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    stored = {};
  }
  return {
    name: nameOf(stored.name) ?? DEFAULT_LEAD_PROFILE.name,
    persona: text(stored.persona, LEAD_PROFILE_TEXT_MAX_LENGTH) ?? "",
    interactionStyle: text(stored.interactionStyle, LEAD_PROFILE_TEXT_MAX_LENGTH) ?? "",
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
  };
}

/** 界面和系统给用户看的文字里称呼 Lead 用的名字。 */
export function leadDisplayName(db: Db): string {
  try {
    return getLeadProfile(db).name;
  } catch {
    // 还没有 kv 表的库（测试里只建了部分表）：用缺省的名字。
    return DEFAULT_LEAD_PROFILE.name;
  }
}

export function leadProfileFields(profile: LeadProfileDto): LeadProfileFields {
  return { name: profile.name, persona: profile.persona, interactionStyle: profile.interactionStyle };
}

/** 写入整理好、校验过的值（engine 的 updateLeadProfile 调它）。返回写入以后的值。 */
export function writeLeadProfile(db: Db, fields: LeadProfileFields, meta: { by: LeadProfileAuthor; at: Date }): LeadProfileDto {
  const profile: LeadProfileDto = { ...fields, updatedAt: meta.at.toISOString(), updatedBy: meta.by };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LEAD_PROFILE_KEY, JSON.stringify(profile));
  return profile;
}
