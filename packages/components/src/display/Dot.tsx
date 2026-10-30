import { View } from '@tamagui/core';
import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { palette, type ColorToken } from '../theme/tokens';

export type DotProps = {
  color?: ColorToken;
  size?: number;
  // 外圈描边，常用来把角标从底下的头像上分开。
  ring?: ColorToken;
  ringWidth?: number;
  // 向外扩散的光圈，表示在线或正在运行。
  pulse?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};

// 状态圆点。
export function Dot({ color = 'text-muted', size = 8, ring, ringWidth = 2, pulse = false, testID, accessibilityLabel }: DotProps) {
  const box = pulse ? Math.round(size * 1.75) : size;
  return (
    <View
      testID={testID}
      aria-label={accessibilityLabel}
      w={box}
      h={box}
      items="center"
      justify="center"
      shrink={0}
    >
      {pulse ? <PulseHalo color={color} size={size * 2} /> : null}
      <View
        w={size}
        h={size}
        rounded="full"
        bg={color}
        borderWidth={ring ? ringWidth : 0}
        borderColor={ring ?? 'transparent'}
      />
    </View>
  );
}

function PulseHalo({ color, size }: { color: ColorToken; size: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 1_200, easing: Easing.out(Easing.quad) }), -1, false);
    return () => cancelAnimation(progress);
  }, [progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.52 * (1 - progress.value),
    transform: [{ scale: 0.75 + progress.value * 1.15 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: palette[color] }, style]}
    />
  );
}
