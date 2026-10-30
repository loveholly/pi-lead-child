import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { zIndex } from '../theme/tokens';

// 撑开（P12.1 的 Grow，主题 M-1 到 M-3）：一块内容从底边往上长出来，收起时缩回底边。
//   打开：高度 220，曲线 (0.2, 0.8, 0.2, 1)；里面的内容延后 60，用 170 淡入、上移 4（Reveal）。
//   收起：内容先用 130 淡出，高度用 170 ease-in-out 缩回。
//   减弱动态效果（P12.7）：高度直接到位，只留透明度变化。
// 内容贴着底边排：长高时先露出底下的部分，看起来是从下面那一行往上长。收好以后内容不再渲染。
const OPEN_MS = 220;
const CLOSE_MS = 170;
const REVEAL_MS = 170;
const REVEAL_DELAY_MS = 60;
const FADE_OUT_MS = 130;
const REVEAL_SHIFT = 4;
const openEasing = Easing.bezier(0.2, 0.8, 0.2, 1);
const closeEasing = Easing.inOut(Easing.ease);

export type GrowProps = {
  open: boolean;
  children: ReactNode;
  // inline：排在原来的位置，长高时把下面的内容往下推。above：贴在父元素的上沿往上长，盖在上面的内容上，
  // 不推动它们（P1、P2；输入框上的状态栏，主题 11.13）。父元素要是定位的容器（position: relative）。
  placement?: 'inline' | 'above';
  testID?: string;
};

export function Grow({ open, children, placement = 'inline', testID }: GrowProps) {
  const reduced = useReducedMotion();
  // 内容的高度放在共享值里：内容是打开时才挂上的，量出来时动画可能已经开始了，样式要跟着它变。
  const contentHeight = useSharedValue(0);
  const progress = useSharedValue(open ? 1 : 0);
  const reveal = useSharedValue(open ? 1 : 0);
  // 收起的动画结束以后不再渲染内容：高度是 0 的里面的按钮也点不到、Tab 也走不到（P13.6）。打开时先挂上，量出高度再长。
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setMounted(false), reduced ? REVEAL_MS : CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open, reduced]);

  useEffect(() => {
    if (reduced) {
      progress.value = open ? 1 : 0;
      reveal.value = withTiming(open ? 1 : 0, { duration: REVEAL_MS });
      return;
    }
    if (open) {
      progress.value = withTiming(1, { duration: OPEN_MS, easing: openEasing });
      reveal.value = withDelay(REVEAL_DELAY_MS, withTiming(1, { duration: REVEAL_MS, easing: openEasing }));
    } else {
      reveal.value = withTiming(0, { duration: FADE_OUT_MS, easing: closeEasing });
      progress.value = withTiming(0, { duration: CLOSE_MS, easing: closeEasing });
    }
  }, [open, progress, reduced, reveal]);

  const frameStyle = useAnimatedStyle(() => ({ height: progress.value * contentHeight.value }), [progress, contentHeight]);
  const contentStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * REVEAL_SHIFT }],
  }), [reveal]);

  const measure = (event: LayoutChangeEvent) => {
    contentHeight.value = event.nativeEvent.layout.height;
  };
  return (
    <Animated.View
      testID={testID}
      aria-hidden={!open}
      pointerEvents={open ? 'auto' : 'none'}
      style={[styles.frame, placement === 'above' ? styles.above : null, frameStyle]}
    >
      {mounted ? (
        <Animated.View onLayout={measure} style={[styles.content, contentStyle]}>
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', position: 'relative' },
  above: { position: 'absolute', left: 0, right: 0, bottom: '100%', zIndex: zIndex.overlay },
  content: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});

// 只给测试用：各段的时长，和主题第 10 节对得上。
export const growTimings = { OPEN_MS, CLOSE_MS, REVEAL_MS, REVEAL_DELAY_MS, FADE_OUT_MS, REVEAL_SHIFT } as const;
