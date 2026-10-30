import { forwardRef, type ReactNode } from 'react';
import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';

import { palette, type ColorToken } from '../theme/tokens';

export type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;
export type ScrollAreaHandle = ScrollView;

export type ScrollAreaProps = {
  children?: ReactNode;
  // 在父级 flex 布局里伸展的比例。滚动区通常要占满剩余空间，所以缺省是 1。
  flex?: number;
  // 最大高度。flex 为 0 时，滚动区按内容定高，内容超过这个高度后开始滚动。
  maxH?: number;
  // 放在另一个纵向滚动区里面时设为 true。Android 需要它才能滚动内层。
  nested?: boolean;
  bg?: ColorToken;
  horizontal?: boolean;
  // 内容至少和可视区一样大，空状态可以在可视区里居中。
  fillContent?: boolean;
  showsScrollIndicator?: boolean;
  onScroll?: (event: ScrollEvent) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  // 可视区的大小变了（例如窗口变窄、对话坞展开）。
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
};

// 不用 flex 简写。react-native-web 把 flex: 0 展开成 flex: 0 1 0%，flex-basis 为 0 会让按内容定高的滚动区塌成 0 高。
// 这里写出三个分量：flex > 0 时按比例分剩余空间；flex 为 0 时按内容定高，可以收缩。
function flexStyle(flex: number): ViewStyle {
  return flex > 0
    ? { flexGrow: flex, flexShrink: 1, flexBasis: 0 }
    : { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' };
}

// 滚动区域。web 上是 react-native-web 的 ScrollView，原生上是系统滚动视图。
// 内容的内边距和间距由调用方放一个 Column 或 Row 来控制。
// ref 是 ScrollView 实例，可以调用 scrollToEnd / scrollTo。
export const ScrollArea = forwardRef<ScrollAreaHandle, ScrollAreaProps>(function ScrollArea({
  children, flex = 1, maxH, nested = false, bg, horizontal = false, fillContent = false, showsScrollIndicator, onScroll,
  onContentSizeChange, onLayout, testID,
}, ref) {
  return (
    <ScrollView
      ref={ref}
      testID={testID}
      horizontal={horizontal}
      nestedScrollEnabled={nested}
      style={{ ...flexStyle(flex), minWidth: 0, minHeight: 0, maxHeight: maxH, backgroundColor: bg ? palette[bg] : undefined }}
      contentContainerStyle={fillContent ? { flexGrow: 1 } : horizontal ? { alignItems: 'center' } : undefined}
      showsHorizontalScrollIndicator={showsScrollIndicator ?? !horizontal}
      showsVerticalScrollIndicator={showsScrollIndicator ?? true}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={onScroll ? 16 : undefined}
      onScroll={onScroll}
      onContentSizeChange={onContentSizeChange}
      onLayout={onLayout}
    >
      {children}
    </ScrollView>
  );
});
