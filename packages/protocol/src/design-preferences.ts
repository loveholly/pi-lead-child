// 外观偏好（设置页「外观」，2026-10-22）的线上契约：用户按自己的喜好调界面，Lead 也能代他调。
// 只开放几个旋钮，具体的 token 值由代码从旋钮算出来（components 的 theme/preferences.ts）：
//   - 每个区域的密度（工作台、工单详情、会话、设置）：紧凑、标准、宽松。
//   - 圆角、行高、字号基准：各三档。
//   - 颜色：主色（强调色）、成功、警告、危险、信息，各一个十六进制值；同色系的深浅由代码推导。
//   - 设计说明：用户自己的话（喜欢什么、不喜欢什么）。渲染不读它；Lead 用它来提出修改。
// 可读性底线（用户 2026-10-22 定）：字号最小 11，白底上的文字对比度至少 4.5:1。字号在推导里保底；
// 颜色在校验里检查：强调色会当链接文字用，必须够深；另外几种只当图标和底色，base 至少 3:1，当文字的深色变体由代码压到 4.5:1。
// 存在 plc.db 的 kv（ui.design-preferences）。读用 tickets:view，改用 tickets:create。Lead 的 update_design_preferences 工具
// 和设置页调同一个函数（engine 的 design-preferences.ts）；Lead 只能在用户这一轮明确要求时代他改。每次修改记一次主人操作。
// 变化时网关发 snapshot.required，payload 是 {resource: "design-preferences"}，客户端重新 GET。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const DESIGN_PREFERENCES_RESOURCE = "design-preferences";
export const DESIGN_NOTES_MAX_LENGTH = 1_200;

export const DENSITY_LEVELS = ["compact", "standard", "comfortable"] as const;
export type DensityLevel = typeof DENSITY_LEVELS[number];
// 区域：工作台的面板（收件箱、工单列表、项目、日程）、工单详情、会话、设置和配对。
export const DENSITY_ZONES = ["workspace", "ticket", "conversation", "settings"] as const;
export type DensityZone = typeof DENSITY_ZONES[number];
export const RADIUS_LEVELS = ["sharp", "soft", "round"] as const;
export type RadiusLevel = typeof RADIUS_LEVELS[number];
export const LINE_HEIGHT_LEVELS = ["tight", "normal", "loose"] as const;
export type LineHeightLevel = typeof LINE_HEIGHT_LEVELS[number];
export const TEXT_SCALE_LEVELS = ["small", "medium", "large"] as const;
export type TextScaleLevel = typeof TEXT_SCALE_LEVELS[number];
export const PALETTE_ROLES = ["accent", "success", "warning", "danger", "info"] as const;
export type PaletteRole = typeof PALETTE_ROLES[number];

const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));
const HexColor = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });

export const DesignDensitySchema = StrictObject({
  workspace: Literals(DENSITY_LEVELS),
  ticket: Literals(DENSITY_LEVELS),
  conversation: Literals(DENSITY_LEVELS),
  settings: Literals(DENSITY_LEVELS),
});
export type DesignDensity = Static<typeof DesignDensitySchema>;

export const DesignColorsSchema = StrictObject({
  accent: HexColor,
  success: HexColor,
  warning: HexColor,
  danger: HexColor,
  info: HexColor,
});
export type DesignColors = Static<typeof DesignColorsSchema>;

export const DesignPreferencesAuthorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type DesignPreferencesAuthor = Static<typeof DesignPreferencesAuthorSchema>;

export const DesignPreferencesFieldsSchema = StrictObject({
  density: DesignDensitySchema,
  radius: Literals(RADIUS_LEVELS),
  lineHeight: Literals(LINE_HEIGHT_LEVELS),
  textScale: Literals(TEXT_SCALE_LEVELS),
  colors: DesignColorsSchema,
  // 用户自己的话。空字符串表示没写。
  notes: Type.String({ maxLength: DESIGN_NOTES_MAX_LENGTH }),
});
export type DesignPreferencesFields = Static<typeof DesignPreferencesFieldsSchema>;

export const DesignPreferencesDtoSchema = StrictObject({
  ...DesignPreferencesFieldsSchema.properties,
  updatedAt: Type.Union([Type.String(), Type.Null()]),
  updatedBy: Type.Union([DesignPreferencesAuthorSchema, Type.Null()]),
});
export type DesignPreferencesDto = Static<typeof DesignPreferencesDtoSchema>;

export const DesignPreferencesResponseSchema = StrictObject({ designPreferences: DesignPreferencesDtoSchema });
export type DesignPreferencesResponse = Static<typeof DesignPreferencesResponseSchema>;

// POST /v1/design/preferences：只给要改的字段；density 和 colors 也只给要改的键。
// Type.Partial 会丢掉 additionalProperties: false，所以部分对象显式写。
const PartialDensitySchema = StrictObject({
  workspace: Type.Optional(Literals(DENSITY_LEVELS)),
  ticket: Type.Optional(Literals(DENSITY_LEVELS)),
  conversation: Type.Optional(Literals(DENSITY_LEVELS)),
  settings: Type.Optional(Literals(DENSITY_LEVELS)),
});
const PartialColorsSchema = StrictObject({
  accent: Type.Optional(HexColor), success: Type.Optional(HexColor), warning: Type.Optional(HexColor),
  danger: Type.Optional(HexColor), info: Type.Optional(HexColor),
});

export const DesignPreferencesRequestSchema = StrictObject({
  density: Type.Optional(PartialDensitySchema),
  radius: Type.Optional(Literals(RADIUS_LEVELS)),
  lineHeight: Type.Optional(Literals(LINE_HEIGHT_LEVELS)),
  textScale: Type.Optional(Literals(TEXT_SCALE_LEVELS)),
  colors: Type.Optional(PartialColorsSchema),
  notes: Type.Optional(Type.String({ maxLength: DESIGN_NOTES_MAX_LENGTH * 2 })),
});
export type DesignPreferencesRequest = Static<typeof DesignPreferencesRequestSchema>;

// 缺省值。密度按 2026-10-22 的决定分区；颜色是 tokens.ts 调色板的基准色。
export const DEFAULT_DESIGN_COLORS: DesignColors = Object.freeze({
  accent: "#2F6AFF", success: "#12B76A", warning: "#F79009", danger: "#F04438", info: "#06AED4",
});
export const DEFAULT_DESIGN_PREFERENCES: DesignPreferencesDto = Object.freeze({
  density: Object.freeze({ workspace: "compact", ticket: "compact", conversation: "standard", settings: "standard" }),
  radius: "soft",
  lineHeight: "normal",
  textScale: "medium",
  colors: DEFAULT_DESIGN_COLORS,
  notes: "",
  updatedAt: null,
  updatedBy: null,
});

export const DENSITY_LEVEL_LABELS: Record<DensityLevel, string> = { compact: "紧凑", standard: "标准", comfortable: "宽松" };
export const DENSITY_ZONE_LABELS: Record<DensityZone, string> = { workspace: "工作台", ticket: "工单详情", conversation: "会话", settings: "设置" };
export const RADIUS_LEVEL_LABELS: Record<RadiusLevel, string> = { sharp: "小圆角", soft: "标准", round: "大圆角" };
export const LINE_HEIGHT_LEVEL_LABELS: Record<LineHeightLevel, string> = { tight: "紧", normal: "标准", loose: "松" };
export const TEXT_SCALE_LEVEL_LABELS: Record<TextScaleLevel, string> = { small: "小一号", medium: "标准", large: "大一号" };
export const PALETTE_ROLE_LABELS: Record<PaletteRole, string> = { accent: "主色", success: "成功", warning: "警告", danger: "危险", info: "信息" };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/gu;

export function normalizeDesignNotes(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(CONTROL, "").trim();
}

export function normalizeHexColor(value: string): string {
  return value.trim().toUpperCase();
}

/** 整理一次请求：只留给了的字段，颜色统一成大写。 */
export function normalizeDesignPreferencesRequest(request: DesignPreferencesRequest): DesignPreferencesRequest {
  const out: DesignPreferencesRequest = {};
  if (request.density !== undefined) {
    const density: Partial<DesignDensity> = {};
    for (const zone of DENSITY_ZONES) if (request.density[zone] !== undefined) density[zone] = request.density[zone];
    out.density = density;
  }
  if (request.radius !== undefined) out.radius = request.radius;
  if (request.lineHeight !== undefined) out.lineHeight = request.lineHeight;
  if (request.textScale !== undefined) out.textScale = request.textScale;
  if (request.colors !== undefined) {
    const colors: Partial<DesignColors> = {};
    for (const role of PALETTE_ROLES) if (request.colors[role] !== undefined) colors[role] = normalizeHexColor(request.colors[role]!);
    out.colors = colors;
  }
  if (request.notes !== undefined) out.notes = normalizeDesignNotes(request.notes);
  return out;
}

/** 把一次请求合并到现在的值上。 */
export function applyDesignPreferencesRequest(current: DesignPreferencesFields, request: DesignPreferencesRequest): DesignPreferencesFields {
  return {
    density: { ...current.density, ...(request.density ?? {}) },
    radius: request.radius ?? current.radius,
    lineHeight: request.lineHeight ?? current.lineHeight,
    textScale: request.textScale ?? current.textScale,
    colors: { ...current.colors, ...(request.colors ?? {}) },
    notes: request.notes ?? current.notes,
  };
}

export function designPreferencesFields(dto: DesignPreferencesDto): DesignPreferencesFields {
  return { density: { ...dto.density }, radius: dto.radius, lineHeight: dto.lineHeight, textScale: dto.textScale, colors: { ...dto.colors }, notes: dto.notes };
}

export function sameDesignPreferences(a: DesignPreferencesFields, b: DesignPreferencesFields): boolean {
  return DENSITY_ZONES.every((zone) => a.density[zone] === b.density[zone])
    && a.radius === b.radius && a.lineHeight === b.lineHeight && a.textScale === b.textScale
    && PALETTE_ROLES.every((role) => a.colors[role] === b.colors[role])
    && a.notes === b.notes;
}

// —— 颜色的计算：对比度和同色系推导。纯函数，组件库和校验都用 ——

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** WCAG 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度，1 到 21。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * 同色系推导：缺省调色板里 variant 和 base 的 HSL 差，搬到用户选的 base 上。
 * 例如 accent-soft 是 accent 变浅、变淡；用户换了主色，accent-soft 就是新主色同样变浅、变淡。
 */
export function shiftLike(defaultBase: string, defaultVariant: string, base: string): string {
  const [h0, s0, l0] = rgbToHsl(hexToRgb(defaultBase));
  const [h1, s1, l1] = rgbToHsl(hexToRgb(defaultVariant));
  const [h, s, l] = rgbToHsl(hexToRgb(base));
  const wrap = (x: number) => ((x % 1) + 1) % 1;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  // 饱和度和明度按比例靠向 0 或 1，变体是浅色时保持浅，深色时保持深。
  const towards = (from: number, d0: number, d1: number, x: number) => {
    if (d1 === d0) return x;
    if (d1 > d0) return x + (1 - x) * ((d1 - d0) / (1 - d0 || 1));
    return x * (d1 / (d0 || 1));
  };
  return rgbToHex(hslToRgb([wrap(h + (h1 - h0)), clamp01(towards(s0, s0, s1, s)), clamp01(towards(l0, l0, l1, l))]));
}

/** 压深到白底上至少 ratio 的对比度（文字用）。本来就够深时原样返回。 */
export function darkenToContrast(hex: string, ratio: number, against = "#FFFFFF"): string {
  let [h, s, l] = rgbToHsl(hexToRgb(hex));
  let out = hex.toUpperCase();
  for (let i = 0; i < 40 && contrastRatio(out, against) < ratio; i++) {
    l = Math.max(0, l - 0.02);
    out = rgbToHex(hslToRgb([h, s, l]));
  }
  return out;
}

export const ACCENT_TEXT_CONTRAST = 4.5;
// 成功、警告、危险、信息只当图标、圆点和底色，当文字时用推导出来的深色变体。缺省的橙色是 2.1:1、青色是 2.6:1，
// 所以这里只挡接近白色的值；WCAG 对图形的 3:1 由深色变体和描边承担。
export const TONE_BASE_CONTRAST = 2;

/** 整理以后的修改有什么问题，用户能看懂的一句话。没有问题时返回 null。 */
export function designPreferencesProblem(request: DesignPreferencesRequest): string | null {
  const touched = request.density !== undefined || request.radius !== undefined || request.lineHeight !== undefined
    || request.textScale !== undefined || request.colors !== undefined || request.notes !== undefined;
  if (!touched) return "没有要改的内容";
  if (request.notes !== undefined && [...request.notes].length > DESIGN_NOTES_MAX_LENGTH) return `设计说明最多 ${DESIGN_NOTES_MAX_LENGTH} 个字`;
  if (request.colors) {
    for (const role of PALETTE_ROLES) {
      const value = request.colors[role];
      if (value === undefined) continue;
      if (!/^#[0-9A-F]{6}$/.test(value)) return `${PALETTE_ROLE_LABELS[role]}要写成 #RRGGBB`;
      const ratio = contrastRatio(value, "#FFFFFF");
      if (role === "accent" && ratio < ACCENT_TEXT_CONTRAST) {
        return `主色太浅：它会当链接文字用，白底上的对比度要至少 ${ACCENT_TEXT_CONTRAST}:1，现在是 ${ratio.toFixed(2)}:1`;
      }
      if (role !== "accent" && ratio < TONE_BASE_CONTRAST) {
        return `${PALETTE_ROLE_LABELS[role]}色太浅：白底上的对比度要至少 ${TONE_BASE_CONTRAST}:1，现在是 ${ratio.toFixed(2)}:1`;
      }
    }
  }
  return null;
}
