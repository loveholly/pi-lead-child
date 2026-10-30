import type { ReactNode } from 'react';

// 停在面板底部的对话区（「对话坞」）。收起时只露出标题、最新一条的预览和输入框；
// 展开时对话占满面板，面板的其余内容由 DockedLayout 藏起来。组件不知道对话里是什么，
// 预览、对话列表和输入框都由调用方传进来。
export type ChatDockProps = {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  title: string;
  /** 标题旁的计数，例如消息条数。 */
  count?: string;
  /** 有还没看过的新内容。收起时标题旁亮一个圆点，有 unreadLabel 时再写一个词。 */
  unread?: boolean;
  unreadLabel?: string;
  expandLabel?: string;
  collapseLabel?: string;
  /** 收起时显示的预览。点预览也会展开。 */
  preview?: ReactNode;
  /** 展开时显示的内容。调用方自己放滚动区。 */
  children?: ReactNode;
  /** 输入框。收起和展开时都在。 */
  composer?: ReactNode;
  /**
   * 对话坞上面的操作栏（ActionBar），和对话坞共用一个外框（第四轮画板）。
   * 给了它，把手移到操作栏上面，操作栏和标题行之间有一条分隔线。收起和展开时都在。
   */
  bar?: ReactNode;
  testID?: string;
};

// 展开和收起的按钮。web 和原生各给一个实现（ChatDock.tsx / ChatDock.native.tsx），
// 都是 button 角色，并报告展开状态。
export type ChatDockToggleProps = {
  expanded: boolean;
  onPress: () => void;
  /** 无障碍名称。 */
  label: string;
  /** 被展开的区域的 id。区域只在展开时存在，所以实现只在 expanded 时引用它。 */
  controls: string;
  children: ReactNode;
  testID?: string;
};
