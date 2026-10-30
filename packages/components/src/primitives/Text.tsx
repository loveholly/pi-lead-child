import { styled, Text as TamaguiText, type GetProps, type TamaguiElement } from '@tamagui/core';
import { Platform } from 'react-native';

import { withDensity } from '../theme/density';
import { fontFaceWeights, textLeading, type FontFace, type FontSizeToken } from '../theme/tokens';

export type TextWeight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';

// 文字的语义颜色。具体色值见 tokens.palette。
export type TextTone =
  | 'default' | 'strong' | 'secondary' | 'muted' | 'faint' | 'ghost'
  | 'accent' | 'success' | 'success-dark' | 'warning' | 'warning-dark' | 'danger' | 'danger-dark'
  | 'inverse';

// 等宽字体只有三个字重；斜体只有常规和粗体两个文件。
function faceFor(weight: TextWeight | undefined, mono: boolean | undefined, italic: boolean | undefined): FontFace | undefined {
  if (mono) {
    if (weight === 'bold' || weight === 'extrabold') return 'mono-bold';
    if (weight === 'semibold') return 'mono-semibold';
    return 'mono-medium';
  }
  if (italic) return weight === 'bold' || weight === 'extrabold' ? 'bold-italic' : 'italic';
  return undefined;
}

// 选一个字体文件。web 上同时给出它的真实字重：字体文件里没有汉字，汉字回退到系统中文字体，
// 只有 font-weight 对了，加粗的中文才会变粗（2026-10-17，见 theme/config.ts）。原生上只按文件名选字体。
const onWeb = Platform.OS === 'web';
function face(name: FontFace) {
  return onWeb ? { fontFamily: name, fontWeight: fontFaceWeights[name] } : { fontFamily: name };
}

// 三个平台都由 Tamagui 渲染。嵌套的 Text 在 web 上是 span，原生上是嵌套的 RN Text，所以可以做富文本。
// TextFrame 是 Tamagui 组件（styled(TextFrame) 派生 Link、Code）；Text 是包了密度换值的版本。
export const TextFrame = styled(TamaguiText, {
  displayName: 'Text',
  fontFamily: 'regular',
  fontSize: '13',
  color: 'text',
  variants: {
    // 语义字号带上自己的行高（tokens.textLeading）；像素字号不设行高。
    size: styled.dynamic<FontSizeToken>((size) => (size in textLeading ? { fontSize: size, lineHeight: size } : { fontSize: size })),
    weight: {
      regular: face('regular'),
      medium: face('medium'),
      semibold: face('semibold'),
      bold: face('bold'),
      extrabold: face('extrabold'),
    },
    mono: { true: {}, false: {} },
    italic: { true: {}, false: {} },
    tone: {
      default: { color: 'text' },
      strong: { color: 'text-strong' },
      secondary: { color: 'text-secondary' },
      muted: { color: 'text-muted' },
      faint: { color: 'text-faint' },
      ghost: { color: 'text-ghost' },
      accent: { color: 'accent' },
      success: { color: 'success' },
      'success-dark': { color: 'success-dark' },
      warning: { color: 'warning' },
      'warning-dark': { color: 'warning-dark' },
      danger: { color: 'danger' },
      'danger-dark': { color: 'danger-dark' },
      inverse: { color: 'surface' },
    },
    align: {
      left: { text: 'left' },
      center: { text: 'center' },
      right: { text: 'right' },
    },
    // 行高，单位是像素。Tamagui v3 里数字行高是倍数，所以这里转成 "Npx"。
    leading: styled.dynamic<number>((leading) => ({ lineHeight: `${leading}px` })),
  } as const,
}).resolve((props) => {
  const special = faceFor(props.weight as TextWeight | undefined, props.mono as boolean | undefined, props.italic as boolean | undefined);
  return special ? face(special) : { fontFamily: undefined };
});

export type TextProps = GetProps<typeof TextFrame>;
// 语义字号按密度区域换字号和行高（theme/density.ts）。
export const Text = withDensity<TextProps, TamaguiElement>(TextFrame, { text: true, displayName: 'Text' });
