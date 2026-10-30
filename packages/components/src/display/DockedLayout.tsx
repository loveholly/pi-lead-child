import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { Column } from '../primitives/layout';
import { DockMotionProvider, dockMoving, useDockMotion } from './dockMotion';

export type DockedLayoutProps = {
  /** 对话坞展开时，主体藏起来，对话坞占满。 */
  expanded: boolean;
  /** 停在底部的对话坞（ChatDock）。 */
  dock: ReactNode;
  /** 主体，通常是一个滚动区。 */
  children: ReactNode;
  testID?: string;
};

// 主体在上、对话坞在下的面板。展开时主体只是藏起来，不卸载：收起后它的滚动位置还在。
// 同一时间只有一个滚动区可见，不会出现滚动区套滚动区。
// 展开和收起有动画（./dockMotion）：主体和对话坞按进度分空余的高度，对话坞的上沿滑上去或滑下来。
// 动画播完、展开到头时，主体才藏起来；无障碍服务在展开的那一刻就不再读主体。
export function DockedLayout({ expanded, dock, children, testID }: DockedLayoutProps) {
  const motion = useDockMotion(expanded);
  const { phase, progress } = motion;
  // 依赖写明 progress：应用里 worklets 的 Babel 插件自己找出读了哪个值；测试里没有这个插件，web 上的 Reanimated 靠它。
  const mainSize = useAnimatedStyle(() => ({ flexGrow: 1 - progress.value }), [progress]);
  const dockSize = useAnimatedStyle(() => ({ flexGrow: progress.value }), [progress]);
  return (
    <Column testID={testID} flex={1} minH={0}>
      <Animated.View
        testID={testID ? `${testID}-main` : undefined}
        aria-hidden={expanded ? true : undefined}
        style={[styles.main, dockMoving(phase) ? styles.clip : null, phase === 'expanded' ? styles.hidden : null, mainSize]}
      >
        {children}
      </Animated.View>
      <Animated.View testID={testID ? `${testID}-dock` : undefined} style={[styles.dock, dockSize]}>
        <DockMotionProvider value={motion}>{dock}</DockMotionProvider>
      </Animated.View>
    </Column>
  );
}

const styles = StyleSheet.create({
  // 主体的基准是 0，按 1 - 进度伸展：收起时占满对话坞以外的高度，展开到头时高度为 0。
  main: { flexShrink: 1, flexBasis: 0, minHeight: 0 },
  // 动画中主体变矮，里面不收缩的内容不能画到对话坞上。
  clip: { overflow: 'hidden' },
  hidden: { display: 'none' },
  // 对话坞的基准是它自己的内容高度，再按进度分到空余的高度。不收缩，和收起时一样。
  dock: { flexShrink: 0, flexBasis: 'auto', minHeight: 0 },
});
