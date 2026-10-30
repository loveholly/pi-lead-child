import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
  LinearTransition,
  ReduceMotion,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
} from 'react-native-reanimated';

import { Box, type BoxProps } from '../primitives/layout';

// 动效组件。三个平台都用 Reanimated，系统设置了"减弱动态效果"时不播放。

const panelEasing = Easing.bezier(0.2, 0, 0, 1);
const contentEasing = Easing.bezier(0.33, 1, 0.68, 1);

const panelEntering = {
  left: SlideInLeft.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System),
  right: SlideInRight.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System),
};
const panelExiting = {
  left: SlideOutLeft.duration(220).easing(panelEasing).reduceMotion(ReduceMotion.System),
  right: SlideOutRight.duration(220).easing(panelEasing).reduceMotion(ReduceMotion.System),
};
const contentEntering = {
  forward: FadeInRight.duration(170).easing(contentEasing).reduceMotion(ReduceMotion.System),
  backward: FadeInLeft.duration(170).easing(contentEasing).reduceMotion(ReduceMotion.System),
};
const contentExiting = {
  forward: FadeOutLeft.duration(130).easing(contentEasing).reduceMotion(ReduceMotion.System),
  backward: FadeOutRight.duration(130).easing(contentEasing).reduceMotion(ReduceMotion.System),
};
const layoutTransition = LinearTransition.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System);

// 动画容器在父级 flex 布局里的尺寸。它们作用在动画容器上，样式属性作用在里面的 Box 上。
export type MotionLayout = {
  grow?: number;
  basis?: number;
  minWidth?: number;
  maxWidth?: number;
};

function layoutStyle({ grow, basis, minWidth, maxWidth }: MotionLayout): ViewStyle {
  return { flexGrow: grow, flexBasis: basis, minWidth, maxWidth };
}

export type SlidePanelProps = MotionLayout & Omit<BoxProps, 'children'> & PropsWithChildren<{
  // 从哪一边滑入、滑出。
  edge: 'left' | 'right';
  // 盖在同级内容上（铺满父容器），并作为对话框暴露给无障碍服务。
  modal?: boolean;
}>;

// 从左边或右边滑入的面板，例如工作台的侧栏和工单详情。
export function SlidePanel({ edge, modal = false, grow, basis, minWidth, maxWidth, children, ...box }: SlidePanelProps) {
  return (
    <Animated.View
      role={modal ? 'dialog' : undefined}
      accessibilityViewIsModal={modal}
      collapsable={false}
      entering={panelEntering[edge]}
      exiting={panelExiting[edge]}
      style={modal ? styles.modal : layoutStyle({ grow, basis, minWidth, maxWidth })}
    >
      <Box flex={1} {...box}>{children}</Box>
    </Animated.View>
  );
}

export type LayoutTransitionProps = MotionLayout & Omit<BoxProps, 'children'> & PropsWithChildren;

// 兄弟元素出现或消失时，平滑地调整自己的尺寸和位置。
export function LayoutTransition({ grow, basis, minWidth, maxWidth, children, testID, ...box }: LayoutTransitionProps) {
  return (
    <Animated.View testID={testID} layout={layoutTransition} style={layoutStyle({ grow, basis, minWidth, maxWidth })}>
      <Box flex={1} {...box}>{children}</Box>
    </Animated.View>
  );
}

export type SwitchTransitionProps = PropsWithChildren<{
  // 内容的身份。它变化时，旧内容淡出，新内容淡入。
  transitionKey: string;
  // forward 从右侧进入，backward 从左侧进入，none 不做动画。
  direction: 'forward' | 'backward' | 'none';
}>;

// 在同一块区域里切换不同的内容，例如侧栏的收件箱、工单、项目和日程。
export function SwitchTransition({ transitionKey, direction, children }: SwitchTransitionProps) {
  return (
    <View style={styles.viewport}>
      <Animated.View
        key={transitionKey}
        collapsable={false}
        entering={direction === 'none' ? undefined : contentEntering[direction]}
        exiting={direction === 'none' ? undefined : contentExiting[direction]}
        style={StyleSheet.absoluteFill}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  modal: { ...StyleSheet.absoluteFill, zIndex: 20 },
  viewport: { flex: 1, overflow: 'hidden' },
});
