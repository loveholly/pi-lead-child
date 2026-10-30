import { radius as radii, type ColorToken, type FontFace, type FontSizeToken, type RadiusToken } from '../theme/tokens';
import type { ButtonSize, ButtonTone, ButtonVariant } from './Button.types';

// 按钮的视觉规格。web 和原生实现都从这里取值，三个平台的尺寸和颜色因此一致。
export type ButtonSpec = {
  height: number;
  paddingX: number;
  radius: number;
  fontFace: FontFace;
  fontSize: FontSizeToken;
  iconSize: number;
  text: ColorToken;
  bg: ColorToken | 'transparent';
  hoverBg: ColorToken | 'transparent';
  border: ColorToken | 'transparent';
  borderWidth: number;
  opacity: number;
};

const SIZES: Record<ButtonSize, Pick<ButtonSpec, 'height' | 'paddingX' | 'radius' | 'fontSize' | 'iconSize'>> = {
  xs: { height: 28, paddingX: 10, radius: 8, fontSize: '12', iconSize: 13 },
  sm: { height: 32, paddingX: 12, radius: 10, fontSize: '12.5', iconSize: 15 },
  md: { height: 38, paddingX: 16, radius: 10, fontSize: '13', iconSize: 16 },
  lg: { height: 44, paddingX: 18, radius: 11, fontSize: '13', iconSize: 18 },
  xl: { height: 48, paddingX: 22, radius: 12, fontSize: '14', iconSize: 19 },
};

const STRONG: Record<ButtonTone, ColorToken> = {
  accent: 'accent',
  neutral: 'text',
  inverse: 'text',
  danger: 'danger',
  success: 'success-dark',
};

const SOFT_BG: Record<ButtonTone, ColorToken> = {
  accent: 'accent-soft',
  neutral: 'surface-muted',
  inverse: 'surface-muted',
  danger: 'danger-soft',
  success: 'success-soft',
};

const ON_LIGHT: Record<ButtonTone, ColorToken> = {
  accent: 'accent',
  neutral: 'text',
  inverse: 'text',
  danger: 'danger-dark',
  success: 'success-dark',
};

// 描边按钮的底色和边框。危险和确认类操作用同色系的浅底，其余是白底灰边。
const OUTLINE: Record<ButtonTone, { bg: ColorToken; border: ColorToken }> = {
  accent: { bg: 'surface', border: 'border-strong' },
  neutral: { bg: 'surface', border: 'border-strong' },
  inverse: { bg: 'surface', border: 'border-strong' },
  danger: { bg: 'danger-surface', border: 'danger-border' },
  success: { bg: 'success-surface', border: 'success-border' },
};

export function buttonSpec({
  variant = 'solid',
  tone = 'accent',
  size = 'md',
  shape = 'rounded',
  disabled = false,
}: {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  shape?: 'rounded' | 'pill';
  disabled?: boolean;
}): ButtonSpec {
  const sizing = SIZES[size];
  const base = {
    ...sizing,
    radius: shape === 'pill' ? sizing.height / 2 : sizing.radius,
    fontFace: (size === 'xl' ? 'extrabold' : 'bold') as FontFace,
    opacity: disabled ? 0.5 : 1,
  };
  switch (variant) {
    case 'solid':
      return { ...base, text: 'surface', bg: STRONG[tone], hoverBg: STRONG[tone], border: 'transparent', borderWidth: 0 };
    case 'outline':
      return { ...base, text: ON_LIGHT[tone], bg: OUTLINE[tone].bg, hoverBg: OUTLINE[tone].bg, border: OUTLINE[tone].border, borderWidth: 1 };
    case 'soft':
      return { ...base, text: ON_LIGHT[tone], bg: SOFT_BG[tone], hoverBg: SOFT_BG[tone], border: 'transparent', borderWidth: 0 };
    case 'ghost':
      return { ...base, text: ON_LIGHT[tone], bg: 'transparent', hoverBg: 'surface-subtle', border: 'transparent', borderWidth: 0 };
    case 'link':
      return { ...base, height: 28, paddingX: 2, text: ON_LIGHT[tone], bg: 'transparent', hoverBg: 'transparent', border: 'transparent', borderWidth: 0 };
  }
}

// 图标按钮是正方形，边长按 size 取；圆角缺省 lg（11）。
const ICON_BOXES: Record<ButtonSize, { box: number; icon: number }> = {
  xs: { box: 28, icon: 14 },
  sm: { box: 34, icon: 18 },
  md: { box: 36, icon: 19 },
  lg: { box: 40, icon: 18 },
  xl: { box: 46, icon: 20 },
};

export type IconButtonSpec = ButtonSpec & { box: number; iconColor: ColorToken };

export function iconButtonSpec({
  variant = 'outline',
  tone = 'neutral',
  size = 'md',
  disabled = false,
  rounded = 'lg',
  iconSize,
  iconColor,
}: {
  variant?: Exclude<ButtonVariant, 'link'>;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  rounded?: RadiusToken;
  iconSize?: number;
  iconColor?: ColorToken;
}): IconButtonSpec {
  const base = buttonSpec({ variant, tone, size, disabled });
  const { box, icon } = ICON_BOXES[size];
  return {
    ...base,
    box,
    height: box,
    paddingX: 0,
    radius: radii[rounded],
    iconSize: iconSize ?? icon,
    border: variant === 'outline' ? 'border-control' : base.border,
    iconColor: iconColor ?? (variant === 'solid' ? 'surface' : 'text-strong'),
  };
}
