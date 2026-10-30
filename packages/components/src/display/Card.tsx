import { styled, View, type GetProps, type TamaguiElement } from '@tamagui/core';

import { withDensity } from '../theme/density';

// 卡片：白底、细边框、圆角。tone 给出提醒类卡片的浅色底和同色系边框。
// 需要整张卡片可点时，给它 pressable、onPress 和 role="button"：pressable 带上手型光标和按下的反馈。
const CardFrame = styled(View, {
  displayName: 'Card',
  bg: 'surface',
  rounded: 'xl',
  borderWidth: 1,
  borderColor: 'border',
  variants: {
    variant: {
      outline: {},
      elevated: { borderWidth: 0, boxShadow: '0 1px 2px rgba(16,24,40,0.05)' },
      flat: { borderWidth: 0 },
    },
    tone: {
      neutral: {},
      subtle: { bg: 'surface-subtle', borderColor: 'border-soft' },
      accent: { bg: 'accent-soft', borderColor: 'accent-soft' },
      success: { bg: 'success-surface', borderColor: 'success-border' },
      warning: { bg: 'warning-surface', borderColor: 'warning-border' },
      danger: { bg: 'danger-surface', borderColor: 'danger-border' },
    },
    pressable: {
      true: { cursor: 'pointer', opacity: { default: 1, press: 0.85 } },
    },
  } as const,
  defaultVariants: { variant: 'outline', tone: 'neutral' },
});

export type CardProps = GetProps<typeof CardFrame>;
// 语义间距按密度区域换值（theme/density.ts）。
export const Card = withDensity<CardProps, TamaguiElement>(CardFrame, { displayName: 'Card' });

// 加载中的占位块。
export const Skeleton = styled(View, {
  displayName: 'Skeleton',
  bg: 'surface-muted',
  rounded: 'md',
});

export type SkeletonProps = GetProps<typeof Skeleton>;
