import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';

import { Box } from '../primitives/layout';

// 「就是这里」闪一下（主题 Q-9）：accent-soft 底，170 淡入、停 600、220 淡出。系统开了减弱动态效果时不闪（P12.7）。
// 放在一块内容的第一个子元素：它铺满这块内容，不挡点击。这块内容要设 position="relative"（web 上它是这一层的
// 定位祖先），后面的内容也要设 position="relative"：web 上定位的元素按顺序画，内容才画在闪的底上面。
// signal 每变一次（一个新的非空值）闪一次；刚挂上时不闪。
export const flashTimings = { in: 170, hold: 600, out: 220 } as const;
const FLASH_MS = flashTimings.in + flashTimings.hold + flashTimings.out;

export type FlashProps = {
  /** 变成一个新的值就闪一次。null 或 0：不闪。 */
  signal: number | null | undefined;
  testID?: string;
};

export function Flash({ signal, testID }: FlashProps) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0);
  // 正在闪的那一次。闪完卸掉，不在页面里留一层看不见的底。
  const [active, setActive] = useState<number | null>(null);
  // 挂上时已有的值不算：一块内容换了对象重新挂上时（例如换了一张工单），不因为以前的一次点击再闪。
  const seen = useRef(signal);
  useEffect(() => {
    if (seen.current === signal) return;
    seen.current = signal;
    if (!signal || reduced) return;
    setActive(signal);
    opacity.value = 0;
    opacity.value = withSequence(
      withTiming(1, { duration: flashTimings.in }),
      withDelay(flashTimings.hold, withTiming(0, { duration: flashTimings.out })),
    );
  }, [opacity, reduced, signal]);
  // 闪完卸掉这一层。单独一个 effect：开始闪的 effect 重跑（例如开发时的 StrictMode）不会把它留在页面上。
  useEffect(() => {
    if (active === null) return undefined;
    const timer = setTimeout(() => setActive(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [active]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (active === null) return null;
  return (
    <Animated.View testID={testID} pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Box flex={1} bg="accent-soft" />
    </Animated.View>
  );
}
