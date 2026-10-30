import type { TamaguiElement } from '@tamagui/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { Column, type ColumnProps } from '../primitives/layout';

export type ConversationColumnProps = {
  children?: ReactNode;
  // 块和块之间的间距。会话里用语义间距 conversation-block（tokens.spacing）。
  gap?: ColumnProps['gap'];
  testID?: string;
};

/** 内容列跟着会话栏换位置时滑过去的时长（2026-10-16）。 */
export const COLUMN_GLIDE_MS = 200;
/** 比这个距离小的移动不播动画：拖动窗口边缘时每一帧只差几像素，播动画反而跟不上。 */
export const COLUMN_GLIDE_MIN_PX = 24;
// 先快后慢（easeOutCubic），和 motion/Motion 里内容切换的曲线一样。
const COLUMN_GLIDE_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// web：会话栏变宽、变窄（工单面板打开、关闭，侧栏打开、关闭）时，居中的内容列换了位置。
// 不让它一下子跳过去：从你看到的位置滑到新位置。系统设了「减弱动态效果」时直接到位。
// 会话栏比内容列加两边留白还窄时，内容列只是占满会话栏，左边不变，也就不动。
function useColumnGlide() {
  const ref = useRef<TamaguiElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = ref.current as HTMLElement | null;
    const parent = node?.parentElement;
    if (!node || !parent || typeof ResizeObserver === 'undefined' || typeof node.animate !== 'function') return undefined;
    // 排好版的位置，不含动画里的位移：react-native-web 的元素都是 position: relative，父级就是 offsetParent。
    const laidOut = () => (node.offsetParent === parent
      ? parent.getBoundingClientRect().left + parent.clientLeft + node.offsetLeft
      : node.getBoundingClientRect().left);
    // 开始观察时浏览器先通知一次当前尺寸，那一次只记位置。
    let left: number | null = null;
    let glide: Animation | null = null;
    const observer = new ResizeObserver(() => {
      const next = laidOut();
      const previous = left;
      left = next;
      // 父级只是变高了（来了新消息），位置没变：正在播的动画接着播。
      if (previous === null || Math.abs(next - previous) < 0.5) return;
      // 上一段动画还没播完时，它还带着一段位移：从你现在看到的位置接着滑，不跳回去。
      const shift = node.getBoundingClientRect().left - next;
      glide?.cancel();
      glide = null;
      const offset = previous + shift - next;
      if (Math.abs(offset) < COLUMN_GLIDE_MIN_PX || reducedMotion()) return;
      glide = node.animate(
        [{ transform: `translateX(${Math.round(offset)}px)` }, { transform: 'translateX(0px)' }],
        { duration: COLUMN_GLIDE_MS, easing: COLUMN_GLIDE_EASING },
      );
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
      glide?.cancel();
    };
  }, []);
  return ref;
}

// 会话的内容列（2026-10-16）：Lead 一侧的块（回复、任务卡、失败卡、Lead 动态、工单卡、审批卡）都放在这一列里，
// 各自占满它，宽度一致。手机上是父级去掉两边留白以后的全宽；平板和桌面上最宽 measure.conversation（700），
// 在父级里居中（2026-10-16：靠左时宽屏右边空出半屏）。「Lead · 时间」和各块靠这一列的左边；你的气泡靠这一列的右边，
// 按这一列的百分比定宽。底栏和输入框也放进一个同样的列，和对话的左右边对齐。
// 父级变宽、变窄时，web 上这一列滑到新位置（useColumnGlide）。
export function ConversationColumn({ children, gap, testID = 'conversation-column' }: ConversationColumnProps) {
  const ref = useColumnGlide();
  return (
    <Column ref={ref} testID={testID} w="100%" maxW="conversation" self="center" gap={gap}>
      {children}
    </Column>
  );
}
