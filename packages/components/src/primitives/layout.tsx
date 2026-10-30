import { styled, View, type GetProps, type TamaguiElement } from '@tamagui/core';

import { withDensity } from '../theme/density';

// 布局原语。三个平台都由 Tamagui 渲染：web 上是 div，原生上是 View。
// 它们接受 Tamagui 的全部样式属性（简写形式，例如 p、px、gap、bg、rounded、items、justify），
// token 名不带 $，例如 bg="surface"、rounded="md"、p="12"。

// 语义间距按密度区域换值（theme/density.ts）：BoxFrame 是 Tamagui 组件，Box 是包了密度换值的版本。
const BoxFrame = styled(View, {
  displayName: 'Box',
  variants: {
    // 铺满最近的定位祖先。
    fill: {
      true: { position: 'absolute', t: 0, r: 0, b: 0, l: 0 },
    },
    center: {
      true: { items: 'center', justify: 'center' },
    },
  } as const,
});

export type BoxProps = GetProps<typeof BoxFrame>;
export const Box = withDensity<BoxProps, TamaguiElement>(BoxFrame, { displayName: 'Box' });

// 横向排列子元素。
const RowFrame = styled(BoxFrame, {
  displayName: 'Row',
  flexDirection: 'row',
});

export type RowProps = GetProps<typeof RowFrame>;
export const Row = withDensity<RowProps, TamaguiElement>(RowFrame, { displayName: 'Row' });

// 纵向排列子元素。和 Box 的区别只在名字：读代码时说明这里是一列。
const ColumnFrame = styled(BoxFrame, {
  displayName: 'Column',
  flexDirection: 'column',
});

export type ColumnProps = GetProps<typeof ColumnFrame>;
export const Column = withDensity<ColumnProps, TamaguiElement>(ColumnFrame, { displayName: 'Column' });

// 占满剩余空间；给了 size 时是固定大小的空白。
export const Spacer = styled(View, {
  displayName: 'Spacer',
  flex: 1,
  variants: {
    size: styled.dynamic<number>((size) => ({ flex: 0, w: size, h: size, shrink: 0 })),
  } as const,
});

export type SpacerProps = GetProps<typeof Spacer>;

// 1 像素的分隔线。横向时占满宽度，纵向时占满高度。
export const Divider = styled(View, {
  displayName: 'Divider',
  bg: 'border-soft',
  shrink: 0,
  variants: {
    vertical: {
      true: { w: 1, self: 'stretch' },
      false: { h: 1, self: 'stretch' },
    },
    tone: {
      soft: { bg: 'border-soft' },
      default: { bg: 'border' },
      strong: { bg: 'border-strong' },
    },
  } as const,
  defaultVariants: { vertical: false },
});

export type DividerProps = GetProps<typeof Divider>;
