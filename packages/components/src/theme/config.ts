import { shorthands } from '@tamagui/config/v6';
import { createFont, createTamagui, createTokens } from '@tamagui/core';
import { Platform } from 'react-native';

import { animations } from './animations';
import { densityThemeValues } from './density';
import { breakpoints, fontFaces, fontFaceWeights, fontSizes, measure, palette, radius, space, spacing, textLeading, textSizes, zIndex } from './tokens';

// 每个字重一个 font token。family 就是已加载字体文件的名字（见 fonts.ts）。
// 行高不放进字体配置：Text 组件按字号给出行高，调用方也可以显式覆盖。
//
// 中文（2026-10-17）：字体文件里没有汉字，web 上汉字回退到系统的中文字体。原来 CSS 字重一律是 400，
// 回退的中文字体就一律按常规显示：**加粗**的中文不变粗，只有英文和数字变粗。所以 web 上：
//   · family 后面接一串中文字体，最后是 sans-serif（等宽字体是 monospace）；
//   · font-weight 用这个字体文件的真实字重（tokens 的 fontFaceWeights；Text 选字体时一起给出），
//     回退的中文字体按同样的字重显示；
//   · 字体文件本身已经是这个字重，浏览器不能再合成一次粗体（UIProvider 里关掉 font-synthesis）。
// 原生上不变：只按文件名选字体，不依赖 fontWeight。
const CJK_FALLBACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC"';
const web = Platform.OS === 'web';

export function webFontFamily(face: keyof typeof fontFaces): string {
  return `${fontFaces[face]}, ${CJK_FALLBACK}, ${face.startsWith('mono') ? 'monospace' : 'sans-serif'}`;
}

const faceFont = (face: keyof typeof fontFaces) => createFont({
  family: web ? webFontFamily(face) : fontFaces[face],
  // 像素字号和语义字号（tokens.textSizes）都是字号 token。
  size: { ...fontSizes, ...textSizes },
  // 语义字号的标准行高（tokens.textLeading）。
  lineHeight: textLeading,
  weight: { '9': web ? fontFaceWeights[face] : '400' },
  letterSpacing: { '9': 0 },
});

const fonts = Object.fromEntries(
  (Object.keys(fontFaces) as Array<keyof typeof fontFaces>).map((face) => [face, faceFont(face)]),
) as { [Face in keyof typeof fontFaces]: ReturnType<typeof faceFont> };

const size = { ...space, 44: 44, 50: 50, 52: 52, 54: 54, 56: 56, 58: 58, 60: 60, 62: 62, 64: 64, ...measure } as const;

export const tokens = createTokens({
  color: palette,
  // 像素间距和语义间距（tokens.spacing）都是 space token。
  space: { ...space, ...spacing },
  size,
  radius,
  zIndex,
});

// 只有 light 主题：应用固定用浅色外观（app.json 的 userInterfaceStyle 是 light）。
// 主题里放 Tamagui 自己会读的通用键（color、background），具体颜色都走 token。
const light = {
  color: palette.text,
  background: palette.workspace,
  'border-color': palette.border,
  'placeholder-color': palette['text-muted'],
  'outline-color': palette.accent,
};

export const config = createTamagui({
  tokens,
  fonts: { ...fonts, body: fonts.regular },
  // 密度子 theme（theme/density.ts）：<Density name="compact"> 之内，解析器从 light_compact 里取 d- 开头的值。
  themes: { light, light_compact: { ...light, ...densityThemeValues('compact') }, light_comfortable: { ...light, ...densityThemeValues('comfortable') } },
  shorthands,
  animations,
  media: {
    tablet: { minWidth: breakpoints.tablet },
    desktop: { minWidth: breakpoints.desktop },
    wide: { minWidth: breakpoints.wide },
  },
  settings: {
    defaultFont: 'body',
    onlyAllowShorthands: true,
    allowedStyleValues: 'somewhat-strict-web',
    addThemeClassName: 'html',
    styleCompat: 'web',
    shouldAddPrefersColorThemes: false,
    // 静态导出按手机宽度渲染首屏，水合后再按真实宽度更新。
    mediaQueryDefaultActive: { tablet: false, desktop: false, wide: false },
  },
});

export type UIConfig = typeof config;

declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends UIConfig {}
}
