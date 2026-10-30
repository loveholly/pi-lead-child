import { View } from '@tamagui/core';
import { useMemo } from 'react';

export type QrCodeProps = {
  // 二维码的点阵，不含静区：rows[y] 的第 x 个字符是 '1' 时，那个模块是深色。点阵由调用方编码好。
  rows: readonly string[];
  // 一个模块的边长（像素）。用整数，模块之间才不会有缝。
  moduleSize?: number;
  // 四周静区的宽度（模块数）。扫码器要靠它找到码的边界，标准要求至少 4。
  quietZone?: number;
  testID?: string;
  accessibilityLabel?: string;
};

export type QrRun = { y: number; x: number; length: number };

// 每一行里连续的深色模块合成一段。画的时候一段一个视图，不是一个模块一个视图。
export function qrDarkRuns(rows: readonly string[]): QrRun[] {
  const runs: QrRun[] = [];
  rows.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = row[x] === '1';
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push({ y, x: start, length: x - start });
        start = -1;
      }
    }
  });
  return runs;
}

// 二维码。颜色固定是白底黑码：扫码器靠反差识别，跟着主题变色可能扫不出来。
export function QrCode({ rows, moduleSize = 5, quietZone = 4, testID, accessibilityLabel }: QrCodeProps) {
  const runs = useMemo(() => qrDarkRuns(rows), [rows]);
  const side = (rows.length + quietZone * 2) * moduleSize;
  return (
    <View
      testID={testID}
      role="img"
      aria-label={accessibilityLabel}
      position="relative"
      w={side}
      h={side}
      shrink={0}
      bg="white"
    >
      {runs.map((run) => (
        <View
          key={`${run.y}:${run.x}`}
          position="absolute"
          t={(run.y + quietZone) * moduleSize}
          l={(run.x + quietZone) * moduleSize}
          w={run.length * moduleSize}
          h={moduleSize}
          bg="black"
        />
      ))}
    </View>
  );
}
