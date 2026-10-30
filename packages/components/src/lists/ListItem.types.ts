import type { ReactNode } from 'react';

// 列表。web 上由 Tamagui 渲染成一列行；iOS 上是 SwiftUI List，Android 上是 Compose 的列表（Expo UI）。
export type ListProps = {
  children?: ReactNode;
  testID?: string;
};

// 列表里的一行：前导元素、标题、副标题、尾随元素。
export type ListItemProps = {
  title: string;
  subtitle?: string;
  // 副标题最多显示几行，超出部分用省略号。缺省 1 行。
  subtitleLines?: number;
  leading?: ReactNode;
  trailing?: ReactNode;
  // 副标题下面的额外内容，例如进度条。
  footer?: ReactNode;
  onPress?: () => void;
  selected?: boolean;
  // 标题用等宽粗体，适合文件名、编号这类标识。
  mono?: boolean;
  testID?: string;
};
