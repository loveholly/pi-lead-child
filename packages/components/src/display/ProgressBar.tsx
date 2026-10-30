import { View } from '@tamagui/core';

import type { ColorToken } from '../theme/tokens';

export type ProgressBarProps = {
  // 0 到 100。超出范围的值会被截到边界上。不给时是「不知道进度」：画一小段，不报百分比（动效 Indeterminate 以后挂上，P12）。
  value?: number;
  color?: ColorToken;
  track?: ColorToken;
  height?: number;
  testID?: string;
};

// 横向进度条。宽度跟随父容器。
export function ProgressBar({ value, color = 'accent-track', track = 'border', height = 3, testID }: ProgressBarProps) {
  const known = value !== undefined;
  const percent = known ? Math.max(0, Math.min(100, value)) : 30;
  return (
    <View
      testID={testID}
      role="progressbar"
      {...(known ? { 'aria-valuenow': percent } : { 'aria-busy': true })}
      aria-valuemin={0}
      aria-valuemax={100}
      flex={1}
      h={height}
      rounded="full"
      bg={track}
      overflow="hidden"
    >
      <View h={height} w={`${percent}%`} rounded="full" bg={color} />
    </View>
  );
}
