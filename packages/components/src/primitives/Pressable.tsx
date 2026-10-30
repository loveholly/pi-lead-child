import { styled, View, type GetProps, type TamaguiElement } from '@tamagui/core';

import { withDensity } from '../theme/density';

// 可以点的区域：卡片、列表行、自定义内容的按钮。三个平台都由 Tamagui 渲染，所以里面可以放任意布局。
// 原生按钮控件（只有文字和图标）用 Button，它在 iOS/Android 上是 SwiftUI/Compose 的按钮。
const PressableFrame = styled(View, {
  displayName: 'Pressable',
  role: 'button',
  cursor: 'pointer',
  variants: {
    // 按下时的反馈。highlight 适合铺满宽度的行，opacity 适合小块内容。
    feedback: {
      opacity: { opacity: { default: 1, press: 0.72 } },
      highlight: { bg: { default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' } },
      none: {},
    },
    disabled: {
      true: { opacity: 0.5, cursor: 'default', pointerEvents: 'none' },
    },
  } as const,
  defaultVariants: { feedback: 'opacity' },
});

export type PressableProps = GetProps<typeof PressableFrame>;
// 语义间距按密度区域换值（theme/density.ts）。
export const Pressable = withDensity<PressableProps, TamaguiElement>(PressableFrame, { displayName: 'Pressable' });
