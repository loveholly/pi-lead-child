// 外观偏好（protocol 的 design-preferences.ts）。存在 kv 的 ui.design-preferences，一行 JSON。
// 这里只读写库：校验、授权和主人操作在 engine 的 design-preferences.ts。
// 读到的值坏了（手改、截断）时不抛错：坏掉的字段按缺省值算，界面照常能画。
import {
  DEFAULT_DESIGN_PREFERENCES, DENSITY_LEVELS, DENSITY_ZONES, DESIGN_NOTES_MAX_LENGTH, LINE_HEIGHT_LEVELS, PALETTE_ROLES,
  RADIUS_LEVELS, TEXT_SCALE_LEVELS, normalizeDesignNotes, normalizeHexColor,
  type DensityLevel, type DesignColors, type DesignDensity, type DesignPreferencesAuthor, type DesignPreferencesDto,
  type DesignPreferencesFields,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const DESIGN_PREFERENCES_KEY = "ui.design-preferences";

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : null;

/** 现在的外观偏好。从没改过时是缺省值。 */
export function getDesignPreferences(db: Db): DesignPreferencesDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(DESIGN_PREFERENCES_KEY) as { value: string } | undefined;
  if (!row) return structuredClone(DEFAULT_DESIGN_PREFERENCES);
  let stored: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    stored = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    stored = {};
  }
  const densityIn = stored.density && typeof stored.density === "object" ? stored.density as Record<string, unknown> : {};
  const density = {} as DesignDensity;
  for (const zone of DENSITY_ZONES) density[zone] = oneOf<DensityLevel>(DENSITY_LEVELS, densityIn[zone]) ?? DEFAULT_DESIGN_PREFERENCES.density[zone];
  const colorsIn = stored.colors && typeof stored.colors === "object" ? stored.colors as Record<string, unknown> : {};
  const colors = {} as DesignColors;
  for (const role of PALETTE_ROLES) {
    const value = typeof colorsIn[role] === "string" ? normalizeHexColor(colorsIn[role] as string) : null;
    colors[role] = value && /^#[0-9A-F]{6}$/.test(value) ? value : DEFAULT_DESIGN_PREFERENCES.colors[role];
  }
  const notes = typeof stored.notes === "string" ? normalizeDesignNotes(stored.notes) : "";
  return {
    density,
    radius: oneOf(RADIUS_LEVELS, stored.radius) ?? DEFAULT_DESIGN_PREFERENCES.radius,
    lineHeight: oneOf(LINE_HEIGHT_LEVELS, stored.lineHeight) ?? DEFAULT_DESIGN_PREFERENCES.lineHeight,
    textScale: oneOf(TEXT_SCALE_LEVELS, stored.textScale) ?? DEFAULT_DESIGN_PREFERENCES.textScale,
    colors,
    notes: [...notes].length <= DESIGN_NOTES_MAX_LENGTH ? notes : "",
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
  };
}

/** 写入整理好、校验过的值（engine 的 updateDesignPreferences 调它）。返回写入以后的值。 */
export function writeDesignPreferences(
  db: Db, fields: DesignPreferencesFields, meta: { by: DesignPreferencesAuthor; at: Date },
): DesignPreferencesDto {
  const preferences: DesignPreferencesDto = { ...fields, updatedAt: meta.at.toISOString(), updatedBy: meta.by };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(DESIGN_PREFERENCES_KEY, JSON.stringify(preferences));
  return preferences;
}
