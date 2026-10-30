// 设置 → 外观（2026-10-22）的文字和表单规则。页面在 AppearanceSection.tsx。
import {
  DEFAULT_DESIGN_PREFERENCES, DENSITY_LEVEL_LABELS, DENSITY_LEVELS, DENSITY_ZONES, LINE_HEIGHT_LEVEL_LABELS, LINE_HEIGHT_LEVELS,
  PALETTE_ROLES, RADIUS_LEVEL_LABELS, RADIUS_LEVELS, TEXT_SCALE_LEVEL_LABELS, TEXT_SCALE_LEVELS,
  designPreferencesProblem, normalizeDesignPreferencesRequest,
  type DensityLevel, type DesignPreferencesDto, type DesignPreferencesFields, type DesignPreferencesRequest,
  type LineHeightLevel, type RadiusLevel, type TextScaleLevel,
} from '@pi-lead-child/protocol';

import { formatConversationDate, formatConversationTime } from '@/features/chat/conversationTime';

export const APPEARANCE_DESCRIPTION = '界面的疏密、圆角、字号、行高和颜色。保存以后网页立即生效；也可以在对话里直接说「卡片太挤了」「圆角大一点」，助手会改这里。';
export const DENSITY_HELP = '每个区域一档。列表和工单详情是扫读的界面，缺省紧凑；会话和设置是阅读和填写的界面，缺省标准。';
export const COLORS_HELP = '写 #RRGGBB。主色会当链接文字用，白底上要够深；同色系的浅底、深字由系统推导。';
export const NOTES_HELP = '用你自己的话写你对界面的偏好：喜欢什么、不喜欢什么。界面不读它；助手在你要求改外观时会参考它。';
export const NOTES_PLACEHOLDER = '例如：喜欢大圆角和宽松的留白；不要太多颜色；数字要大。';

export const DENSITY_OPTIONS = DENSITY_LEVELS.map((value) => ({ value, label: DENSITY_LEVEL_LABELS[value] }));
export const RADIUS_OPTIONS = RADIUS_LEVELS.map((value) => ({ value, label: RADIUS_LEVEL_LABELS[value] }));
export const LINE_HEIGHT_OPTIONS = LINE_HEIGHT_LEVELS.map((value) => ({ value, label: LINE_HEIGHT_LEVEL_LABELS[value] }));
export const TEXT_SCALE_OPTIONS = TEXT_SCALE_LEVELS.map((value) => ({ value, label: TEXT_SCALE_LEVEL_LABELS[value] }));

// 表单里的字段都是字符串（useServerForm 的要求）：密度和颜色按键展开。
export type AppearanceForm = Record<string, string>;

export function appearanceForm(fields: DesignPreferencesFields): AppearanceForm {
  const form: AppearanceForm = { radius: fields.radius, lineHeight: fields.lineHeight, textScale: fields.textScale, notes: fields.notes };
  for (const zone of DENSITY_ZONES) form[`density.${zone}`] = fields.density[zone];
  for (const role of PALETTE_ROLES) form[`colors.${role}`] = fields.colors[role];
  return form;
}

/** 这次要发的修改：只带改了的字段（颜色按整理以后的值比较）。没有改时返回 null。 */
export function appearanceChanges(form: AppearanceForm, saved: DesignPreferencesFields): DesignPreferencesRequest | null {
  const request: DesignPreferencesRequest = {};
  for (const zone of DENSITY_ZONES) {
    const value = form[`density.${zone}`] as DensityLevel;
    if (value !== saved.density[zone]) (request.density ??= {})[zone] = value;
  }
  if (form.radius !== saved.radius) request.radius = form.radius as RadiusLevel;
  if (form.lineHeight !== saved.lineHeight) request.lineHeight = form.lineHeight as LineHeightLevel;
  if (form.textScale !== saved.textScale) request.textScale = form.textScale as TextScaleLevel;
  for (const role of PALETTE_ROLES) {
    const value = (form[`colors.${role}`] ?? '').trim().toUpperCase();
    if (value !== saved.colors[role]) (request.colors ??= {})[role] = value;
  }
  const notes = (form.notes ?? '').replace(/\r\n?/gu, '\n').trim();
  if (notes !== saved.notes) request.notes = notes;
  return Object.keys(request).length ? request : null;
}

/** 保存之前的检查：有问题时返回用户能看懂的一句话。 */
export function appearanceFormProblem(request: DesignPreferencesRequest): string | null {
  return designPreferencesProblem(normalizeDesignPreferencesRequest(request));
}

/** 「恢复缺省」要发的修改：和缺省不一样的字段。已经是缺省时返回 null。 */
export function appearanceResetRequest(saved: DesignPreferencesFields): DesignPreferencesRequest | null {
  return appearanceChanges(appearanceForm({ ...DEFAULT_DESIGN_PREFERENCES, notes: saved.notes }), saved);
}

/** 「最近一次修改」那一行。从没改过时返回 null。 */
export function appearanceUpdatedLine(preferences: DesignPreferencesDto, leadName: string, now: Date): string | null {
  if (!preferences.updatedAt) return null;
  const when = `${formatConversationDate(preferences.updatedAt, now)} ${formatConversationTime(preferences.updatedAt)}`.trim();
  const who = preferences.updatedBy === 'lead' ? `${leadName} 在对话里按你的要求改的` : '你改的';
  return `最近一次修改：${when}，${who}。`;
}
