import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, type LayoutChangeEvent } from 'react-native';

import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { ScrollArea, type ScrollAreaHandle, type ScrollEvent } from '../primitives/ScrollArea';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';
import {
  chatFollowOnContent,
  chatFollowOnScroll,
  chatFollowToBottom,
  chatReflowAnchor,
  INITIAL_CHAT_FOLLOW,
  isNearBottom,
  type ChatFollow,
  type ChatScrollMove,
} from './stickToBottom';

export type ChatScrollProps = {
  children?: ReactNode;
  testID?: string;
  /** 变化时回到底部并继续跟随。传最后一条「你发的消息」的 id：你发消息时列表回到底部。 */
  followKey?: string | number | null;
  /** 内容不满一屏时贴在底部，像聊天一样。缺省 true。 */
  bottomAligned?: boolean;
  /** 离开底部以后有新内容时，底部按钮上的字。 */
  newContentLabel?: string;
};

/** 跟随时每一帧走完剩余距离的这一部分：先快后慢，连续变长的内容合成一段平滑的滚动。 */
const FOLLOW_EASE = 0.22;
/** 首屏一直等不到内容尺寸（例如列表是空的）时，过这么久也显示出来。 */
const POSITION_FALLBACK_MS = 600;

type WebScrollView = ScrollAreaHandle & { getScrollableNode?: () => HTMLElement | null };

// 可视区中间的那一块内容：从中线、稍上、稍下各试一次，跳过空白处（量到的是比可视区还高的外层容器）。
function middleBlock(node: HTMLElement, view: DOMRect): Element | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const x = view.left + view.width / 2;
  for (const share of [0.5, 0.4, 0.6]) {
    const element = document.elementFromPoint(x, view.top + view.height * share);
    if (element && node.contains(element) && element.getBoundingClientRect().height < view.height) return element;
  }
  return null;
}

// 聊天列表：主会话和工单对话共用（2026-10-16）。规则见 ./stickToBottom 的 chatFollow*。
// · 内容区不能写 flex 1：react-native-web 给它 flex-basis 0、min-height 0，内容会缩成一屏高，
//   贴底对齐时多出来的部分溢出到顶部之外，滚不到（工单对话滚不动就是这样）。这里只伸展、不收缩。
// · 首屏落到底部以后才显示内容，看不到从顶部跳下来。
// · 贴底时内容变长：web 上每一帧缓动到底部（连续的流式输出合成一段滚动，不抖）；原生上用系统的动画滚动。
// · 你往上翻（滚轮向上、拖动）时立刻松开跟随；下面来了新内容时显示「新消息 ↓」。
// · 会话栏变宽、变窄（工单面板打开、关闭）时重新排版：不算新内容；web 上你刚点的那一块留在原来的高度
//   （规则见 ./stickToBottom 的 chatReflowAnchor）。在 ResizeObserver 里改滚动位置，画出来之前就改好，看不到跳。
export function ChatScroll({ children, testID, followKey, bottomAligned = true, newContentLabel = '新消息' }: ChatScrollProps) {
  const scrollRef = useRef<ScrollAreaHandle | null>(null);
  const follow = useRef<ChatFollow>(INITIAL_CHAT_FOLLOW);
  const viewportHeight = useRef(0);
  const frame = useRef<number | null>(null);
  // web：手指按在列表上时不跟随，和拖动抢位置会抖。
  const touching = useRef(false);
  // web：你最近按下的那一块，和宽度变了以后要留住的那一块（及它离可视区顶部的距离，宽度变之前量的）。
  const pressed = useRef<{ element: Element; at: number } | null>(null);
  const anchor = useRef<{ element: Element; top: number } | null>(null);
  // 可视区的高度（onLayout 量的）。只有高度变了（对话坞展开、键盘弹出）才回到底部，宽度变了不算。
  const layoutHeight = useRef(0);
  const [positioned, setPositioned] = useState(false);
  const [newBelow, setNewBelow] = useState(false);

  const apply = useCallback((next: ChatFollow) => {
    follow.current = next;
    setPositioned(next.positioned);
    setNewBelow(next.newBelow);
  }, []);

  const webNode = useCallback((): HTMLElement | null => {
    if (Platform.OS !== 'web') return null;
    return (scrollRef.current as WebScrollView | null)?.getScrollableNode?.() ?? null;
  }, []);

  const stopFollowing = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // web：记下宽度变了以后要留住哪一块、它现在离可视区顶部多远。滚动、按下、内容变了以后都重新记。
  const rememberAnchor = useCallback(() => {
    const node = webNode();
    if (!node) return;
    const view = node.getBoundingClientRect();
    const press = pressed.current;
    const shows = (element: Element) => {
      if (!element.isConnected || !node.contains(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom;
    };
    const kind = chatReflowAnchor(follow.current, press ? { visible: shows(press.element), ageMs: Date.now() - press.at } : null);
    const element = kind === 'pressed' ? press!.element : kind === 'middle' ? middleBlock(node, view) : null;
    anchor.current = element ? { element, top: element.getBoundingClientRect().top - view.top } : null;
  }, [webNode]);

  // web：宽度变了，内容已经重新排好版。把记下的那一块挪回原来的高度；没有要留的块、又贴着底部时，留在底部。
  const keepAnchor = useCallback(() => {
    const node = webNode();
    if (!node) return;
    const saved = anchor.current;
    if (saved && saved.element.isConnected) {
      stopFollowing();
      const top = saved.element.getBoundingClientRect().top - node.getBoundingClientRect().top;
      node.scrollTop += top - saved.top;
      // 留住了这一块，可能就不在底部了：之后来的新内容给「新消息 ↓」，不把你拽走。
      apply({ ...follow.current, stuck: isNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight), offsetY: node.scrollTop });
    } else if (follow.current.stuck) {
      stopFollowing();
      node.scrollTop = node.scrollHeight;
    }
  }, [apply, stopFollowing, webNode]);

  const moveToBottom = useCallback((move: ChatScrollMove) => {
    if (move === 'none') return;
    const node = webNode();
    // 重新排版：web 上 keepAnchor 已经在 ResizeObserver 里处理好了；原生上贴底时留在底部。
    if (move === 'reflow') {
      if (!node && follow.current.stuck) scrollRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (!node) {
      scrollRef.current?.scrollToEnd({ animated: move === 'follow' });
      return;
    }
    if (move === 'jump') {
      stopFollowing();
      node.scrollTop = node.scrollHeight;
      return;
    }
    // 已经在跟随：下一帧会读到新的目标高度，不用再起一个。手指按着时等松开。
    if (frame.current !== null || touching.current) return;
    const step = () => {
      frame.current = null;
      if (!follow.current.stuck) return;
      const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
      if (gap <= 0.5) return;
      node.scrollTop += Math.max(1, Math.ceil(gap * FOLLOW_EASE));
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [stopFollowing, webNode]);

  // web：滚轮向上、手指按下时立刻松开跟随，不和你抢。之后的滚动事件按 nextStick 决定要不要重新贴上。
  useEffect(() => {
    const node = webNode();
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      // 只在真能往上滚时松开：内容不满一屏、或者已经在顶部时，滚轮不会产生滚动事件，松开了就再也贴不回来。
      if (event.deltaY >= 0 || node.scrollTop <= 0 || node.scrollHeight <= node.clientHeight) return;
      stopFollowing();
      if (follow.current.stuck) follow.current = { ...follow.current, stuck: false };
    };
    const onTouchStart = () => {
      touching.current = true;
      stopFollowing();
    };
    const onTouchEnd = () => {
      touching.current = false;
    };
    const onPress = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      pressed.current = { element: event.target, at: Date.now() };
      rememberAnchor();
    };
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchEnd, { passive: true });
    node.addEventListener('pointerdown', onPress, { capture: true, passive: true });
    node.addEventListener('scroll', rememberAnchor, { passive: true });
    // 宽度变了（工单面板打开、关闭）：内容重新排版。第一次量到宽度不算。
    let width = node.getBoundingClientRect().width;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      if (Math.abs(next - width) <= 0.5) return;
      const first = width === 0;
      width = next;
      if (!first) keepAnchor();
    });
    resize?.observe(node);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('pointerdown', onPress, { capture: true });
      node.removeEventListener('scroll', rememberAnchor);
      resize?.disconnect();
      stopFollowing();
    };
  }, [keepAnchor, rememberAnchor, stopFollowing, webNode]);

  // 一直量不到内容尺寸时也要显示出来，不能一直是空白。
  useEffect(() => {
    const timer = setTimeout(() => {
      if (follow.current.positioned) return;
      apply({ ...follow.current, positioned: true });
      moveToBottom('jump');
    }, POSITION_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [apply, moveToBottom]);

  // 你发了消息：回到底部，继续跟随。第一次渲染不算。
  const firstFollowKey = useRef(true);
  useEffect(() => {
    if (firstFollowKey.current) {
      firstFollowKey.current = false;
      return;
    }
    apply(chatFollowToBottom(follow.current));
    moveToBottom('follow');
  }, [apply, followKey, moveToBottom]);

  const onScroll = useCallback((event: ScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewportHeight.current = layoutMeasurement.height;
    apply(chatFollowOnScroll(follow.current, {
      offsetY: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    }));
  }, [apply]);

  const onContentSizeChange = useCallback((width: number, height: number) => {
    const node = webNode();
    const decision = chatFollowOnContent(follow.current, {
      offsetY: node ? node.scrollTop : follow.current.offsetY,
      contentHeight: height,
      viewportHeight: node ? node.clientHeight : viewportHeight.current,
      contentWidth: width,
    });
    apply(decision.state);
    moveToBottom(decision.move);
    // 内容变了（展开一张卡、来了新消息）：要留住的那一块可能挪了位置。
    if (decision.move !== 'reflow') rememberAnchor();
  }, [apply, moveToBottom, rememberAnchor, webNode]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    const heightChanged = Math.abs(height - layoutHeight.current) > 0.5;
    layoutHeight.current = height;
    viewportHeight.current = height;
    // 可视区变矮（对话坞展开、键盘弹出）时，贴底的列表要留在底部。只是宽度变了不算，见 keepAnchor。
    if (heightChanged && follow.current.stuck && follow.current.positioned) moveToBottom('jump');
  }, [moveToBottom]);

  const backToBottom = useCallback(() => {
    apply(chatFollowToBottom(follow.current));
    moveToBottom('follow');
  }, [apply, moveToBottom]);

  return (
    <Column flex={1} minH={0} position="relative">
      <ScrollArea
        ref={scrollRef}
        testID={testID}
        fillContent
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
      >
        <Column
          testID={testID ? `${testID}-content` : undefined}
          grow={1}
          shrink={0}
          flexBasis="auto"
          justify={bottomAligned ? 'flex-end' : 'flex-start'}
          opacity={positioned ? 1 : 0}
        >
          {children}
        </Column>
      </ScrollArea>
      {newBelow ? (
        <Box position="absolute" b={12} l={0} r={0} items="center" pointerEvents="box-none">
          <Pressable
            testID={testID ? `${testID}-new` : undefined}
            role="button"
            aria-label={`${newContentLabel}，回到底部`}
            onPress={backToBottom}
            feedback="highlight"
            rounded="full"
            px="pill-x"
            minH={30}
            justify="center"
            bg="surface"
            borderWidth={1}
            borderColor="border"
            boxShadow="0 4px 12px rgba(16,24,40,0.12)"
          >
            <Row items="center" gap="icon-label">
              {/* spacing-exempt: 按钮文字字号 */}
              <Text size="12" weight="bold" tone="accent">{newContentLabel}</Text>
              <Icon name="arrow-down" size={12} color="accent" weight="semibold" />
            </Row>
          </Pressable>
        </Box>
      ) : null}
    </Column>
  );
}
