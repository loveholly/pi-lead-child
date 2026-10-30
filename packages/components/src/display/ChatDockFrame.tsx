import { useId, useMemo, useRef, type ComponentType } from 'react';
import { PanResponder, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { Dot } from './Dot';
import { Icon } from './Icon';
import type { ChatDockProps, ChatDockToggleProps } from './ChatDock.types';
import { useDockMotionContext, type DockPhase } from './dockMotion';

type Toggle = ComponentType<ChatDockToggleProps>;

// 对话坞的外形，web 和原生共用。只有展开按钮不同（ChatDock.tsx / ChatDock.native.tsx）。
// 单独使用时：收起时自身高度由内容决定；展开时 flex 占满。
// 在 DockedLayout 里时：高度由 DockedLayout 按动画进度给（./dockMotion），对话坞只是填满给它的那一格。
// 基准必须是内容高度（auto）：DockedLayout 在它上面再加空余的高度。
// 收起时不能写 flex={0}：react-native-web 把它展开成 flex: 0 1 0%，基准为 0，对话坞会塌成一条线。
const SIZE = {
  expanded: { flex: 1 },
  collapsed: { grow: 0, shrink: 0, flexBasis: 'auto' },
  docked: { grow: 1, shrink: 0, flexBasis: 'auto' },
} as const;

/** 上下拖动超过这么多像素算一次滑动。更短的移动当作手抖，留给点按。 */
export const CHAT_DOCK_SWIPE_DISTANCE = 24;
/** 拖动开始的门槛：竖向移动超过它、并且比横向多，才接管手势。 */
const SWIPE_START = 8;
/** 滑动结束后这么久之内的点按不算数：鼠标拖完松开时浏览器还会补一个 click。 */
const PRESS_AFTER_SWIPE_MS = 400;

const styles = StyleSheet.create({
  // web 上浏览器默认把竖向拖动当成滚动页面，拖动事件只到第一步。把手和预览不滚动，拖动全交给对话坞。
  grab: Platform.OS === 'web' ? ({ touchAction: 'none' } as ViewStyle) : {},
  // 对话区的基准是 0：它不算进对话坞的内容高度，只分到对话坞多出来的高度。动画中它从 0 长到占满（或反过来）。
  body: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 },
});

/** 一次竖向滑动的结果：收起时上滑展开，展开时下滑收起，其他情况不变（null）。 */
export function chatDockSwipe(expanded: boolean, dy: number): boolean | null {
  if (!expanded && dy <= -CHAT_DOCK_SWIPE_DISTANCE) return true;
  if (expanded && dy >= CHAT_DOCK_SWIPE_DISTANCE) return false;
  return null;
}

export function ChatDockFrame({
  Toggle,
  expanded,
  onExpandedChange,
  title,
  count,
  unread = false,
  unreadLabel,
  expandLabel = '展开',
  collapseLabel = '收起',
  preview,
  children,
  composer,
  bar,
  testID,
}: ChatDockProps & { Toggle: Toggle }) {
  const bodyId = `chat-dock-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const showUnread = unread && !expanded;
  // 在 DockedLayout 里时跟着它的动画：动画中预览和对话同时在，预览淡出、对话淡入（或反过来）。
  // 按钮的字、无障碍状态和 Esc 跟着 expanded 马上变。
  // 单独使用时没有动画，也不淡入淡出。idle 只是让 hook 的调用固定不变。
  const motion = useDockMotionContext();
  const phase: DockPhase = motion?.phase ?? (expanded ? 'expanded' : 'collapsed');
  const idle = useSharedValue(0);
  const progress = motion?.progress ?? idle;
  const previewFade = useAnimatedStyle(() => ({ opacity: 1 - progress.value }), [progress]);
  const bodyFade = useAnimatedStyle(() => ({ opacity: progress.value }), [progress]);
  // 手机上从把手往上滑展开、往下滑收起（方案 D）。点按仍然由展开按钮和预览处理。
  const latest = useRef({ expanded, onExpandedChange });
  latest.current = { expanded, onExpandedChange };
  const swipedAt = useRef(0);
  const swipeStartY = useRef<number | null>(null);
  const swipe = useMemo(() => {
    const vertical = (_event: unknown, gesture: { dx: number; dy: number }) => (
      Math.abs(gesture.dy) > SWIPE_START && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    );
    return PanResponder.create({
      // 记下按下的位置，但不接管：点按还交给展开按钮和预览。
      onStartShouldSetPanResponderCapture: (event) => {
        swipeStartY.current = event.nativeEvent.pageY;
        return false;
      },
      // 按下时展开按钮先成为响应者；在捕获阶段接管，竖向拖动才能交给对话坞。
      onMoveShouldSetPanResponder: vertical,
      onMoveShouldSetPanResponderCapture: vertical,
      // 接管发生在拖动途中，PanResponder 从那里重新算 dy。距离从按下的位置算。
      onPanResponderRelease: (event, gesture) => {
        const start = swipeStartY.current;
        swipeStartY.current = null;
        const dy = start === null ? gesture.dy : event.nativeEvent.pageY - start;
        const next = chatDockSwipe(latest.current.expanded, dy);
        if (next === null) return;
        swipedAt.current = Date.now();
        latest.current.onExpandedChange(next);
      },
      onPanResponderTerminate: () => {
        swipeStartY.current = null;
      },
    });
  }, []);
  const press = (next: boolean) => {
    if (Date.now() - swipedAt.current < PRESS_AFTER_SWIPE_MS) return;
    onExpandedChange(next);
  };
  return (
    <Column
      testID={testID}
      {...(motion ? SIZE.docked : expanded ? SIZE.expanded : SIZE.collapsed)}
      minH={0}
      bg="surface"
      borderTopWidth={1}
      borderTopColor="border"
      borderTopLeftRadius={16}
      borderTopRightRadius={16}
      boxShadow="0 -8px 20px rgba(16,24,40,0.07)"
    >
      <View testID={testID ? `${testID}-grab` : undefined} style={styles.grab} {...swipe.panHandlers}>
        {bar ? (
          // 有操作栏时把手在最上面，操作栏在把手和标题行之间。操作栏里的按钮照常能点：只有竖向拖动才交给对话坞。
          // spacing-exempt: 拖动把手上方留白
          <Column testID={testID ? `${testID}-bar` : undefined} pt={7} borderBottomWidth={1} borderBottomColor="border-soft">
            <Box self="center" w={38} h={5} rounded="full" bg="border-strong" />
            {bar}
          </Column>
        ) : null}
        <Toggle
          expanded={expanded}
          onPress={() => press(!expanded)}
          label={`${title}，${expanded ? collapseLabel : expandLabel}`}
          controls={bodyId}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Column w="100%" pt={bar ? 10 : 7} pb={phase === 'expanded' ? 8 : 2}>
            {bar ? null : <Box self="center" w={38} h={5} rounded="full" bg="border-strong" />}
            <Row w="100%" items="center" gap="inline-item" px="card" pt={bar ? 0 : 6}>
              <Text size="section-title" weight="extrabold" align="left">{title}</Text>
              {count ? <Text size="meta" mono tone="secondary">{count}</Text> : null}
              {showUnread ? <Dot color="accent" size={7} /> : null}
              {showUnread && unreadLabel ? <Text size="meta" weight="bold" tone="accent">{unreadLabel}</Text> : null}
              <Row ml="auto" items="center" gap="icon-label">
                {/* spacing-exempt: 按钮文字字号 */}
                <Text size="12" weight="bold" tone={expanded ? 'secondary' : 'accent'}>
                  {expanded ? collapseLabel : expandLabel}
                </Text>
                <Icon
                  name={expanded ? 'chevron-down' : 'chevron-up'}
                  size={12}
                  color={expanded ? 'text-secondary' : 'accent'}
                  weight="semibold"
                />
              </Row>
            </Row>
          </Column>
        </Toggle>
        {phase !== 'expanded' && preview ? (
          <Animated.View style={motion ? previewFade : undefined} aria-hidden={expanded ? true : undefined}>
            {/* 预览本身也能点开。它不在展开按钮里面：按钮里的文字在 web 上会继承居中对齐。 */}
            <Pressable
              testID={testID ? `${testID}-preview` : undefined}
              aria-label={`${expandLabel}${title}`}
              onPress={() => press(true)}
              feedback="none"
              px="page-x"
              pt={4} // spacing-exempt: 对话坞自己的规格
              pb="card"
            >
              {preview}
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
      {phase !== 'collapsed' ? (
        <Animated.View style={[styles.body, motion ? bodyFade : null]} aria-hidden={expanded ? undefined : true}>
          <Column id={bodyId} testID={testID ? `${testID}-body` : undefined} flex={1} minH={0}>{children}</Column>
        </Animated.View>
      ) : null}
      {composer ? <Box borderTopWidth={1} borderTopColor="border-soft">{composer}</Box> : null}
    </Column>
  );
}
