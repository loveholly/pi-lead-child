import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Easing, ReduceMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

// 对话坞展开和收起的动画（2026-10-16）。DockedLayout 播放动画，ChatDock 从 context 读当前的阶段。
// 进度 0 是收起，1 是展开。主体和对话坞按进度分面板里的空余高度：主体 flex-grow 是 1 - 进度，对话坞是进度。
// 这样不用量面板和对话坞的高度：对话坞的上沿从收起的位置滑到面板顶部，内容在动画中变了也跟得上。

/** 收起、展开中、展开、收起中。中间两个阶段里，预览和对话同时在，各自淡出、淡入。 */
export type DockPhase = 'collapsed' | 'expanding' | 'expanded' | 'collapsing';

export const DOCK_EXPAND_MS = 260;
export const DOCK_COLLAPSE_MS = 220;
// 和侧栏、工单面板的滑入用同一条曲线（Motion.tsx 的 panelEasing）。
const dockEasing = Easing.bezier(0.2, 0, 0, 1);

export type DockMotion = {
  phase: DockPhase;
  /** 0 是收起，1 是展开。 */
  progress: SharedValue<number>;
};

/** 展开状态和动画是否已经结束，合成一个阶段。 */
export function dockPhase(expanded: boolean, settled: boolean): DockPhase {
  if (settled) return expanded ? 'expanded' : 'collapsed';
  return expanded ? 'expanding' : 'collapsing';
}

/** 动画中的阶段：预览和对话同时在。 */
export function dockMoving(phase: DockPhase): boolean {
  return phase === 'expanding' || phase === 'collapsing';
}

// 展开状态一变，就进入动画阶段，动画播完才落到 expanded 或 collapsed。动画中途再切换，就从当前进度往回播。
// 系统设置了「减弱动态效果」时，Reanimated 直接跳到终点，阶段马上落定。
export function useDockMotion(expanded: boolean): DockMotion {
  const [state, setState] = useState({ expanded, settled: true });
  // 在渲染中改状态（不等 effect）：按钮上的字和对话坞的内容在同一帧变。
  let current = state;
  if (state.expanded !== expanded) {
    current = { expanded, settled: false };
    setState(current);
  }
  const progress = useSharedValue(expanded ? 1 : 0);
  const settle = useCallback((target: boolean) => {
    setState((prev) => (prev.expanded === target ? { expanded: target, settled: true } : prev));
  }, []);
  const last = useRef(expanded);
  useEffect(() => {
    if (last.current === expanded) return;
    last.current = expanded;
    progress.value = withTiming(
      expanded ? 1 : 0,
      { duration: expanded ? DOCK_EXPAND_MS : DOCK_COLLAPSE_MS, easing: dockEasing, reduceMotion: ReduceMotion.System },
      // 被下一次切换打断时 finished 是 false：阶段由下一次动画落定。
      (finished) => {
        if (finished) scheduleOnRN(settle, expanded);
      },
    );
  }, [expanded, progress, settle]);
  return { phase: dockPhase(current.expanded, current.settled), progress };
}

const DockMotionContext = createContext<DockMotion | null>(null);

export const DockMotionProvider = DockMotionContext.Provider;

/** 在 DockedLayout 里时是它的动画；单独使用的对话坞没有动画，得到 null。 */
export function useDockMotionContext(): DockMotion | null {
  return useContext(DockMotionContext);
}
