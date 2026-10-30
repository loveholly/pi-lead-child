import type { ColorToken, FontSizeToken } from '../theme/tokens';
import type { TextFieldSize, TextFieldVariant } from './TextField.types';

// 输入框的视觉规格。web 和原生实现都从这里取值。
export type TextFieldSpec = {
  height: number;
  paddingX: number;
  radius: number;
  fontSize: FontSizeToken;
  bg: ColorToken | 'transparent';
  border: ColorToken | 'transparent';
  borderWidth: number;
  text: ColorToken;
  placeholder: ColorToken;
};

const SIZES: Record<TextFieldSize, Pick<TextFieldSpec, 'height' | 'paddingX' | 'radius' | 'fontSize'>> = {
  sm: { height: 34, paddingX: 10, radius: 8, fontSize: '13' },
  md: { height: 40, paddingX: 12, radius: 10, fontSize: '14' },
  lg: { height: 48, paddingX: 14, radius: 12, fontSize: '14' },
};

export function textFieldSpec({
  variant = 'outline',
  size = 'md',
  fontSize,
}: {
  variant?: TextFieldVariant;
  size?: TextFieldSize;
  fontSize?: FontSizeToken;
}): TextFieldSpec {
  const sizing = SIZES[size];
  const common = { ...sizing, fontSize: fontSize ?? sizing.fontSize, text: 'text' as ColorToken, placeholder: 'text-muted' as ColorToken };
  switch (variant) {
    case 'outline':
      return { ...common, bg: 'surface', border: 'border-input', borderWidth: 1 };
    case 'filled':
      return { ...common, bg: 'workspace', border: 'border-strong', borderWidth: 1 };
    case 'plain':
      return { ...common, paddingX: 0, radius: 0, bg: 'transparent', border: 'transparent', borderWidth: 0 };
  }
}
