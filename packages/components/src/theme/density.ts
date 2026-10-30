// 密度（2026-10-22）：同一个语义名在紧凑、标准、宽松三档里取不同的值。
//
// 做法：标准值是全局 token（类型检查认它，web 和原生都直接解析）。紧凑和宽松的值放在子 theme
// light_compact / light_comfortable 里，键名加 d- 前缀。布局原语和 Text 外面包一层 withDensity：
// 一个间距属性的值是密度名字、当前 theme 里又有 d-<名字> 时，在 Tamagui 看到属性之前换成那个数；
// 没有就保持 token（标准）。文字同理，换字号和行高。
//
// 为什么不能更简单：
//   · Tamagui 3 的类型只接受 space token 做 gap/p 等属性，theme 的键不行；运行时查到 token 也不再看 theme。
//   · styled().resolve 的优先级在调用处的属性之下，覆盖不了 gap="card-row"。
import { useTheme } from '@tamagui/core';
import { createElement, forwardRef, useContext, type ComponentType, type ForwardRefExoticComponent, type PropsWithoutRef, type RefAttributes } from 'react';

import { DesignPreferencesContext, scaledLeading, scaledRadius, scaledTextSize, type DesignPreferences } from './preferences';
import { type Density, radius as radiusTokens, spacingByDensity, textLeading, textSizes, textSizesByDensity, type RadiusToken } from './tokens';

const DENSITY_INDEX: Record<Density, 0 | 1 | 2> = { compact: 0, standard: 1, comfortable: 2 };
const THEME_PREFIX = 'd-';

// 子 theme 的键：d-card-row、d-card-title-size、d-card-title-leading。
export function densityThemeValues(density: Density): Record<string, number> {
  const i = DENSITY_INDEX[density];
  const out: Record<string, number> = {};
  for (const [name, values] of Object.entries(spacingByDensity)) out[`${THEME_PREFIX}${name}`] = values[i];
  for (const [name, values] of Object.entries(textSizesByDensity)) {
    out[`${THEME_PREFIX}${name}-size`] = values[i][0];
    out[`${THEME_PREFIX}${name}-leading`] = values[i][1];
  }
  return out;
}

// 会随密度变化的间距属性（简写）。
const SPACE_PROPS = [
  'gap', 'rowGap', 'columnGap',
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
] as const;

type ThemeLike = Record<string, unknown> | undefined | null;

function themeNumber(theme: ThemeLike, key: string): number | undefined {
  if (!theme) return undefined;
  const raw = theme[key];
  const value = raw && typeof raw === 'object' && 'val' in raw ? (raw as { val: unknown }).val : raw;
  return typeof value === 'number' ? value : undefined;
}

// 按当前 theme 换掉密度名字，再按外观偏好（theme/preferences.ts）调字号、行高和圆角。没有要换的就原样返回同一个对象。
export function resolveDensityProps<P extends Record<string, unknown>>(
  props: P, theme: ThemeLike, text: boolean, preferences: DesignPreferences | null = null,
): P {
  let out: Record<string, unknown> | null = null;
  if (theme) {
    for (const key of SPACE_PROPS) {
      const value = props[key];
      if (typeof value !== 'string' || !(value in spacingByDensity)) continue;
      const resolved = themeNumber(theme, `${THEME_PREFIX}${value}`);
      if (resolved === undefined) continue;
      (out ??= { ...props })[key] = resolved;
    }
  }
  if (text) {
    const size = props.size;
    if (typeof size === 'string' && size in textSizesByDensity) {
      const name = size as keyof typeof textSizesByDensity;
      // 密度区域里是 theme 的值，否则是标准值；再按字号和行高的档位调。
      let fontSize = themeNumber(theme, `${THEME_PREFIX}${size}-size`) ?? textSizes[name];
      let leading = themeNumber(theme, `${THEME_PREFIX}${size}-leading`) ?? textLeading[name];
      const adjusted = preferences && (preferences.textScale !== 'medium' || preferences.lineHeight !== 'normal');
      if (adjusted) {
        leading = scaledLeading(fontSize, leading, preferences.textScale, preferences.lineHeight);
        fontSize = scaledTextSize(fontSize, preferences.textScale);
      }
      if (theme && themeNumber(theme, `${THEME_PREFIX}${size}-size`) !== undefined || adjusted) {
        out ??= { ...props };
        delete out.size;
        out.fontSize = fontSize;
        // 和 Text 的 leading 变体一样写成 "Npx"：Tamagui v3 的数字行高是倍数。
        out.lineHeight = `${leading}px`;
      }
    }
  }
  if (preferences && preferences.radius !== 'soft') {
    const rounded = props.rounded;
    if (typeof rounded === 'string' && rounded in radiusTokens) {
      (out ??= { ...props }).rounded = scaledRadius(rounded as RadiusToken, preferences.radius);
    }
  }
  return (out ?? props) as P;
}

// 包住一个 Tamagui 组件。读当前 theme，换掉密度名字，再交给里面的组件。ref 原样透传。
export function withDensity<P extends object, Ref>(
  Inner: ComponentType<P>,
  options: { text?: boolean; displayName: string },
): ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<Ref>> {
  const Wrapped = forwardRef<Ref, P>((props, ref) => {
    const theme = useTheme() as unknown as ThemeLike;
    const preferences = useContext(DesignPreferencesContext);
    const resolved = resolveDensityProps(props as Record<string, unknown>, theme, options.text === true, preferences) as P;
    return createElement(Inner, { ...resolved, ref } as P);
  });
  Wrapped.displayName = options.displayName;
  return Wrapped as ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<Ref>>;
}
