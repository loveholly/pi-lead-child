// 外观偏好（2026-10-22）：用户在设置 → 外观里调的几个旋钮，和它们怎么变成具体的值。
// 旋钮由 protocol 的 design-preferences.ts 定义（组件库不依赖 protocol，这里只认同样形状的数据）：
//   - density：每个区域一档。<Density zone="ticket"> 读它，换成 light_compact / light_comfortable 子 theme。
//   - radius：圆角三档。withDensity 把 rounded="xl" 这类 token 换成乘过系数的像素。
//   - lineHeight、textScale：行高和字号各三档。withDensity 在换密度值的同时加上差值。字号不小于 11（可读性底线）。
//   - colors：主色、成功、警告、危险、信息。同色系的深浅按缺省调色板里的关系推导（designColorOverrides），
//     web 上写成 CSS 变量覆盖（DesignPreferencesProvider）；原生上这一版不改颜色。
import { createContext, useContext } from 'react';

import { palette, radius as radiusTokens, type RadiusToken } from './tokens';
import type { Density } from './tokens';

export type DensityZone = 'workspace' | 'ticket' | 'conversation' | 'settings';
export type RadiusLevel = 'sharp' | 'soft' | 'round';
export type LineHeightLevel = 'tight' | 'normal' | 'loose';
export type TextScaleLevel = 'small' | 'medium' | 'large';
export type PaletteRole = 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface DesignPreferences {
  density: Record<DensityZone, Density>;
  radius: RadiusLevel;
  lineHeight: LineHeightLevel;
  textScale: TextScaleLevel;
  colors: Record<PaletteRole, string>;
}

export const DEFAULT_PREFERENCES: DesignPreferences = {
  density: { workspace: 'compact', ticket: 'compact', conversation: 'standard', settings: 'standard' },
  radius: 'soft',
  lineHeight: 'normal',
  textScale: 'medium',
  colors: { accent: palette.accent, success: palette.success, warning: palette.warning, danger: palette.danger, info: palette.cyan },
};

export const DesignPreferencesContext = createContext<DesignPreferences>(DEFAULT_PREFERENCES);

export function useDesignPreferences(): DesignPreferences {
  return useContext(DesignPreferencesContext);
}

export const MIN_TEXT_SIZE = 11;
const TEXT_SCALE_DELTA: Record<TextScaleLevel, number> = { small: -1, medium: 0, large: 1 };
const LINE_HEIGHT_DELTA: Record<LineHeightLevel, number> = { tight: -2, normal: 0, loose: 2 };
const RADIUS_FACTOR: Record<RadiusLevel, number> = { sharp: 0.5, soft: 1, round: 1.5 };

/** 字号加上档位的差值，不小于 11。 */
export function scaledTextSize(size: number, level: TextScaleLevel): number {
  return Math.max(MIN_TEXT_SIZE, size + TEXT_SCALE_DELTA[level]);
}

/** 行高跟着字号走（字号加减 1 时行高加减 2），再加上行高档位的差值；不小于字号加 2。 */
export function scaledLeading(size: number, leading: number, textScale: TextScaleLevel, lineHeight: LineHeightLevel): number {
  const scaledSize = scaledTextSize(size, textScale);
  const value = leading + (scaledSize - size) * 2 + LINE_HEIGHT_DELTA[lineHeight];
  return Math.max(scaledSize + 2, value);
}

/** 圆角 token 乘上档位的系数。full 和 0 不变。 */
export function scaledRadius(token: RadiusToken, level: RadiusLevel): number | RadiusToken {
  if (level === 'soft' || token === 'full' || token === 0) return token;
  return Math.round(radiusTokens[token] * RADIUS_FACTOR[level]);
}

// —— 颜色 ——

const DEFAULT_ROLE_BASE: Record<PaletteRole, string> = {
  accent: palette.accent, success: palette.success, warning: palette.warning, danger: palette.danger, info: palette.cyan,
};
// 每个角色带哪些调色板键。变体按它和基准色在缺省调色板里的关系推导。
const ROLE_KEYS: Record<PaletteRole, readonly (keyof typeof palette)[]> = {
  accent: ['accent', 'accent-strong', 'accent-soft', 'accent-wash', 'accent-glow', 'accent-muted', 'accent-track', 'ink-accent'],
  success: ['success', 'success-dark', 'success-soft', 'success-surface', 'success-border', 'success-strong', 'success-wash', 'success-line'],
  warning: ['warning', 'warning-dark', 'warning-soft', 'warning-surface', 'warning-border', 'warning-wash', 'warning-cream', 'warning-line'],
  danger: ['danger', 'danger-dark', 'danger-soft', 'danger-surface', 'danger-border', 'danger-tint', 'danger-wash', 'danger-cream', 'danger-line', 'danger-divider'],
  info: ['cyan'],
};
// 当文字用的变体：压深到白底上至少 4.5:1（可读性底线）。
const TEXT_KEYS = new Set<string>(['accent', 'accent-strong', 'success-dark', 'warning-dark', 'danger-dark', 'success-strong']);

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
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
function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
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

/** 把缺省调色板里 variant 相对 base 的关系（色相差、饱和度和明度的靠拢程度）搬到新的 base 上。 */
export function shiftLike(defaultBase: string, defaultVariant: string, base: string): string {
  const [h0, s0, l0] = rgbToHsl(hexToRgb(defaultBase));
  const [h1, s1, l1] = rgbToHsl(hexToRgb(defaultVariant));
  const [h, s, l] = rgbToHsl(hexToRgb(base));
  const wrap = (x: number) => ((x % 1) + 1) % 1;
  const towards = (d0: number, d1: number, x: number) => {
    if (d1 === d0) return x;
    if (d1 > d0) return x + (1 - x) * ((d1 - d0) / (1 - d0 || 1));
    return x * (d1 / (d0 || 1));
  };
  return rgbToHex(hslToRgb([wrap(h + (h1 - h0)), Math.min(1, towards(s0, s1, s)), Math.min(1, towards(l0, l1, l))]));
}

export function darkenToContrast(hex: string, ratio: number, against = '#FFFFFF'): string {
  const [h, s] = rgbToHsl(hexToRgb(hex));
  let [, , l] = rgbToHsl(hexToRgb(hex));
  let out = hex.toUpperCase();
  for (let i = 0; i < 40 && contrastRatio(out, against) < ratio; i++) {
    l = Math.max(0, l - 0.02);
    out = rgbToHex(hslToRgb([h, s, l]));
  }
  return out;
}

/** 用户选的五个颜色 → 调色板里要换的键和值。和缺省一样的角色不出现在结果里。 */
export function designColorOverrides(colors: Record<PaletteRole, string>): Partial<Record<keyof typeof palette, string>> {
  const out: Partial<Record<keyof typeof palette, string>> = {};
  for (const role of Object.keys(ROLE_KEYS) as PaletteRole[]) {
    const base = colors[role]?.toUpperCase();
    if (!base || base === DEFAULT_ROLE_BASE[role].toUpperCase()) continue;
    for (const key of ROLE_KEYS[role]) {
      let value = shiftLike(DEFAULT_ROLE_BASE[role], palette[key], base);
      if (TEXT_KEYS.has(key)) value = darkenToContrast(value, 4.5);
      out[key] = value;
    }
  }
  return out;
}

/** web 上的 CSS 变量覆盖（Tamagui 的颜色 token 是 --c-<键>）。没有要换的时返回空串。 */
export function designColorCss(colors: Record<PaletteRole, string>): string {
  const overrides = designColorOverrides(colors);
  const entries = Object.entries(overrides);
  if (!entries.length) return '';
  return `:root{${entries.map(([key, value]) => `--c-${key}:${value}`).join(';')}}`;
}
