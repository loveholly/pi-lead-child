import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row, type ColumnProps } from '../primitives/layout';
import { ScrollArea, type ScrollAreaHandle } from '../primitives/ScrollArea';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';

/** 从外面把列表滚到某一块（会话搜索的「跳到这条」，工单 #339）。 */
export type ChatListHandle = {
  /** 滚到 key 那一块，放在可视区偏上的位置。没有这一块时返回 false。 */
  scrollToKey: (key: string, options?: { animated?: boolean }) => boolean;
};

export type ChatListProps<T> = {
  /** 会话里的块，从旧到新。 */
  data: readonly T[];
  /** 每一块稳定的 key：同一块在刷新、翻页以后还是同一个 key。 */
  keyExtractor: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /**
   * 块画出来要用的、不在块里的东西（例如哪一条是最新的、卡片的表）。它变了，看得见的块重画一遍。
   * 列表按 key、块本身和它缓存每一块：只换了 renderItem 不会重画。
   */
  extraData?: unknown;
  testID?: string;
  /** 变化时回到底部并继续跟随。传最后一条「你发的消息」的 id：你发消息时列表回到底部。 */
  followKey?: string | number | null;
  /** 内容不满一屏时贴在底部，像聊天一样。缺省 true。 */
  bottomAligned?: boolean;
  /** 不在底部时，底部按钮上的字（没有新消息时）。缺省「回到最新」。 */
  newContentLabel?: string;
  /** 有 n 条新消息时，底部按钮上的字。缺省「n 条新消息」。 */
  newCountLabel?: (count: number) => string;
  /** 外面通过它把列表滚到某一块。 */
  handleRef?: Ref<ChatListHandle>;
  /** 这一块整条高亮（会话搜索命中的那条）。null 不高亮。 */
  highlightKey?: string | null;
  /** 相邻两块之间的间距。缺省是会话流的 conversation-block。 */
  gap?: ColumnProps['gap'];
  /** 第一块上面：留白、连接状态、更早的消息的加载状态。 */
  header?: ReactNode;
  /** 最后一块下面。 */
  footer?: ReactNode;
  /** 一块也没有时。 */
  empty?: ReactNode;
  /** 往上滚到快到最早的一块：取更早的。 */
  onStartReached?: () => void;
  /** 还没量过的块按这个高度估算。 */
  estimatedItemSize?: number;
};

/** 可视区以外上下各多画这么多像素：快速滚动时不露白，展开的浮层跟着卡片滚出一小段也还在（P2.6）。 */
const DRAW_DISTANCE = 1000;
/** 最后这几块一直画着：正在流的回复、刚画的卡片和表单不因为滚动被卸掉。 */
const ALWAYS_RENDER_LAST = 3;
// 一块的估计高度。会话里多数块是一行（外部消息的一行、结束行、记录块的头），四五十到七十像素。
// 以前写 160：估得太高，Legend List 准备的容器不够，滑动时临时现建（开发模式下报 No unused container available），
// 打开时滚到底也要多算好几轮才收敛（2026-11-14 手机上量过）。
const ESTIMATED_ITEM_SIZE = 72;
// 不用 flex 简写：react-native-web 把 flex: 1 展开成 flex-basis 0%，Legend List 的 web 实现直接写 DOM 样式（见 ScrollArea）。
const LIST_STYLE = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, minWidth: 0 } as const;

// 一块里的东西要因为你点了它而变高、变矮时（展开、收起工具卡片），块先调这个函数。
// 列表把这一块的顶部留在屏幕上原来的位置，上面的块和滚动位置都不动，只有这一块和它下面的内容变。
// 列表贴底跟随时也一样：不跟随，收起时整个列表就不会晚几帧再往下跳一次。卡片变完后列表还在底部，就接着跟随。
// 不在 ChatList 里（例如单独画的卡片）时是空函数。
const ChatListBlockContext = createContext<(() => void) | null>(null);
const noop = () => {};

export function useKeepChatBlockInPlace(): () => void {
  return useContext(ChatListBlockContext) ?? noop;
}

function ChatBlockScope({ blockKey, keep, children }: { blockKey: string; keep: (key: string) => void; children: ReactNode }) {
  const keepThis = useCallback(() => keep(blockKey), [keep, blockKey]);
  return <ChatListBlockContext.Provider value={keepThis}>{children}</ChatListBlockContext.Provider>;
}

// 聊天列表：主会话和工单对话共用（2026-10-16，2026-11-04 换成 Legend List，只画看得见的块）。
// · 打开时落在最底下（initialScrollAtEnd）。内容不满一屏时贴底还是从上往下排，由 bottomAligned 定。
// · 贴底时内容变长（新消息、流式输出、卡片变高）跟着走（maintainScrollAtEnd）；你往上翻时松开，滚回底部时重新跟上。
// · 你往上看的时候，上面插进更早的消息、下面的卡片变高，看得见的内容都不动（maintainVisibleContentPosition，P1.4）。
// · 你不在底部时下面来了新内容：显示「新消息 ↓」，点它回到底部。
// · 你发了消息（followKey 变了）：回到底部，继续跟随。
// · 会话栏变宽、变窄时，你刚点的那一块留在原来的高度（web，anchorVisibleContent）。
// · 不开 recycleItems：消息里有局部状态（展开的工具详情、genui 表单），复用别的块的实例会串。
//   要明确写 false：legend-list 3.7 没写时在开发模式下报一条警告（2026-11-12，手机上弹出 LogBox）。
// 量不出行高的地方（测试的 DOM 环境里没有 ResizeObserver；没有它的浏览器也一样）不虚拟化，每一块都画出来（ChatListAll）。
export function ChatList<T>(props: ChatListProps<T>) {
  const measurable = Platform.OS !== 'web' || typeof ResizeObserver !== 'undefined';
  if (!measurable) return <ChatListAll {...props} />;
  // 原生上先量高度（SizedVirtualChatList）；web 上 ResizeObserver 一开始就量得到，直接挂。
  return Platform.OS === 'web' ? <VirtualChatList {...props} /> : <SizedVirtualChatList {...props} />;
}

// 先量出高度，再挂上虚拟列表（2026-11-15）。对话坞展开的第一帧、藏起来的页面里，列表的外框高度是 0：
// legend-list 在开发模式下为此弹一条「List height is 0」的 LogBox。初始滚到底、跟随底部也要一个真实的高度。
// 量到一次大于 0 就一直挂着：VirtualChatList 里只在挂上时跑一次的 effect 都要列表已经在。
function SizedVirtualChatList<T>(props: ChatListProps<T>) {
  const [sized, setSized] = useState(false);
  return (
    <View
      style={SIZED_STYLE}
      onLayout={sized ? undefined : (event) => { if (event.nativeEvent.layout.height > 0) setSized(true); }}
    >
      {sized ? <VirtualChatList {...props} /> : null}
    </View>
  );
}

const SIZED_STYLE = { flex: 1, minHeight: 0 } as const;

// web 上块的外层写 data-chat-key：按下时认出是哪一块（anchorVisibleContent）。dataSet 是 react-native-web 的属性，
// 不在 react-native 的类型里；原生上不认识，忽略。
function blockKeyProps(key: string): ViewProps {
  return { dataSet: { chatKey: key } } as unknown as ViewProps;
}

function useGapSeparator(gap: ColumnProps['gap'], testID: string | undefined) {
  return useMemo(() => function ChatListGap() {
    return <Box testID={testID ? `${testID}-gap` : undefined} pt={gap} />;
  }, [gap, testID]);
}

function VirtualChatList<T>({
  data, keyExtractor, renderItem, extraData, testID, followKey, bottomAligned = true, newContentLabel: newContentLabelProp,
  newCountLabel, handleRef, highlightKey = null,
  gap = 'conversation-block', header, footer, empty, onStartReached, estimatedItemSize = ESTIMATED_ITEM_SIZE,
}: ChatListProps<T>) {
  const m = useMessages(displayMessages);
  const listRef = useRef<LegendListRef | null>(null);
  // 底部按钮（工单 #339）：不在底部就显示；离开底部以后下面多出来的块数记在 newCount 里，按钮上写条数。
  // 最后一块在变长（流式输出）时不多出块，newGrowing 只让按钮出现，不写条数。
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [newGrowing, setNewGrowing] = useState(false);
  const setNewBelow = useCallback((value: boolean) => {
    if (!value) {
      setNewCount(0);
      setNewGrowing(false);
    }
  }, []);
  const dataRef = useRef(data);
  dataRef.current = data;
  const Separator = useGapSeparator(gap, testID);
  const lastKey = data.length ? keyExtractor(data[data.length - 1]!) : null;

  // 跟着底部走的时候，新内容由列表自己跟上，不算「新消息」。
  const following = useCallback(() => {
    const state = listRef.current?.getState();
    return state ? state.isFollowingEnd || state.isAtEnd : true;
  }, []);

  // 回到底部、重新跟上时收起「新消息 ↓」。
  useEffect(() => {
    const state = listRef.current?.getState();
    if (!state) return undefined;
    const sync = () => {
      const live = listRef.current?.getState();
      setAtBottom(live ? live.isFollowingEnd || live.isAtEnd : true);
    };
    const hide = (value: boolean) => {
      if (value) setNewBelow(false);
      sync();
    };
    sync();
    const offFollowing = state.listen('isFollowingEnd', hide);
    const offEnd = state.listen('isAtEnd', hide);
    return () => {
      offFollowing();
      offEnd();
    };
  }, [setNewBelow]);

  // 最下面多了块（不是上面插进了更早的）：你不在底部时数一数多了几块。
  const previousLastKey = useRef(lastKey);
  useEffect(() => {
    const previous = previousLastKey.current;
    previousLastKey.current = lastKey;
    if (previous === null || lastKey === null || lastKey === previous || following()) return;
    const rows = dataRef.current;
    const previousIndex = rows.findIndex((item) => keyExtractor(item) === previous);
    setNewCount((count) => count + (previousIndex >= 0 ? Math.max(1, rows.length - 1 - previousIndex) : 1));
  }, [following, keyExtractor, lastKey]);

  // 你点开、收起一块（useKeepChatBlockInPlace）：锁住这一块的顶部。Legend List 贴底跟随时 anchorVisibleContent 不锁，
  // 内容变矮以后它把列表重新贴底，而且比卡片晚几帧：卡片先收起、底下空一截，接着整个列表往下跳。所以先停下跟随再锁。
  // 停下的跟随记在 resumeFollow 里：块的高度变完以后列表还在底部，就回到跟随（见 onItemSizeChanged）。
  const resumeFollow = useRef(false);
  const keepBlockInPlace = useCallback((key: string) => {
    const list = listRef.current;
    const state = list?.getState();
    if (!list || !state) return;
    if (state.isFollowingEnd) {
      list.cancelScroll();
      resumeFollow.current = true;
    }
    list.anchorVisibleContent({ key });
  }, []);

  // 最后一块变长（流式输出、卡片画完）：你不在底部时同样说一声。
  const onItemSizeChanged = useCallback((info: { size: number; previous: number; itemKey: string }) => {
    if (info.itemKey === previousLastKey.current && info.size > info.previous + 1 && !following()) setNewGrowing(true);
    if (!resumeFollow.current) return;
    requestAnimationFrame(() => {
      const state = listRef.current?.getState();
      if (!resumeFollow.current || !state || state.distanceFromEnd > 1) return;
      resumeFollow.current = false;
      void listRef.current?.scrollToEnd({ animated: false });
    });
  }, [following]);

  // web：最后一次 scroll 事件时列表停在哪里。浏览器自己把列表往回拉（见下面发消息）时还没发 scroll 事件，这里还是原来的位置。
  const lastScrollTop = useRef<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = listRef.current?.getScrollableNode() as HTMLElement | null | undefined;
    if (!node || typeof node.addEventListener !== 'function') return undefined;
    const onScroll = () => { lastScrollTop.current = node.scrollTop; };
    onScroll();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // 你发了消息：回到底部，继续跟随。第一次渲染不算。
  // web（工单 #251）：发多行消息、带图片发消息时，输入框在同一刻变矮，列表的可视区变高。这时新消息还没画出来，
  // 浏览器把 scrollTop 夹到旧内容的底部，旧内容整体往下移；接着再滚到底，看起来先往下、再往上。
  // 这个 effect 跑的时候，Legend List 还没把新消息的高度写进页面；到下一帧画出来之前才写好。
  // 所以在那一帧画之前，先回到被拉回之前的位置，再从那里滚到底：只往一个方向动。
  // 工单 #259：你本来就在底部时，直接到底，不用平滑滚动。新的块（你的消息、Lead 那一轮的占位行）刚进列表时按估算的高度排，
  // 下一帧才量出真的高度。平滑滚动还在走的时候，Legend List 把「让最后一块贴底」的修正（例如矮了 48）先记着，等滚动停下才一次补上，
  // 补的那一帧整个列表往上跳。直接到底时这个修正当场生效，画出来之前就到位了。你往上翻着的时候，照旧平滑滚回底部。
  const firstFollowKey = useRef(true);
  useEffect(() => {
    if (firstFollowKey.current) {
      firstFollowKey.current = false;
      return undefined;
    }
    const animated = !following();
    setNewBelow(false);
    void listRef.current?.scrollToEnd({ animated });
    const node = Platform.OS === 'web' ? listRef.current?.getScrollableNode() as HTMLElement | null | undefined : null;
    const before = lastScrollTop.current;
    if (!node || before === null || node.scrollTop >= before) return undefined;
    const frame = requestAnimationFrame(() => {
      if (node.scrollTop >= before) return;
      node.scrollTop = Math.min(before, node.scrollHeight - node.clientHeight);
      void listRef.current?.scrollToEnd({ animated });
    });
    return () => cancelAnimationFrame(frame);
  }, [followKey, following]);

  // web：你按下的那一块，在会话栏变宽、变窄（工单面板打开、关闭）以后留在原来的高度。
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = listRef.current?.getScrollableNode() as HTMLElement | null | undefined;
    if (!node || typeof node.addEventListener !== 'function') return undefined;
    const onPress = (event: Event) => {
      const block = event.target instanceof Element ? event.target.closest('[data-chat-key]') : null;
      const key = block?.getAttribute('data-chat-key');
      if (key) listRef.current?.anchorVisibleContent({ key });
    };
    node.addEventListener('pointerdown', onPress, { capture: true, passive: true });
    return () => node.removeEventListener('pointerdown', onPress, { capture: true });
  }, []);

  const backToBottom = useCallback(() => {
    setNewBelow(false);
    void listRef.current?.scrollToEnd({ animated: true });
  }, [setNewBelow]);

  useImperativeHandle(handleRef, () => ({
    scrollToKey: (key, options) => {
      const index = dataRef.current.findIndex((item) => keyExtractor(item) === key);
      if (index < 0 || !listRef.current) return false;
      void listRef.current.scrollToIndex({ index, animated: options?.animated ?? true, viewPosition: 0.25 });
      return true;
    },
  }), [keyExtractor]);

  const renderBlock = useCallback(({ item, index }: { item: T; index: number }) => {
    const key = keyExtractor(item);
    const block = (
      <View {...blockKeyProps(key)}>
        <ChatBlockScope blockKey={key} keep={keepBlockInPlace}>{renderItem(item, index)}</ChatBlockScope>
      </View>
    );
    // 始终包一层：高亮开关时子树不换类型，卡片里展开的状态、正在加载的图不会被重挂载丢掉。
    return key === highlightKey
      ? <Box testID={testID ? `${testID}-highlight` : undefined} bg="accent-soft" rounded="md">{block}</Box>
      : <Box rounded="md">{block}</Box>;
  }, [highlightKey, keepBlockInPlace, keyExtractor, renderItem, testID]);
  // 高亮的那一块变了，看得见的块要重画（列表按 extraData 缓存每一块）。
  const listExtra = useMemo(() => ({ extraData, highlightKey }), [extraData, highlightKey]);

  return (
    <Column testID={testID} flex={1} minH={0} position="relative">
      <LegendList
        recycleItems={false}
        ref={listRef}
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderBlock}
        extraData={listExtra}
        estimatedItemSize={estimatedItemSize}
        drawDistance={DRAW_DISTANCE}
        alwaysRender={{ bottom: ALWAYS_RENDER_LAST }}
        alignItemsAtEnd={bottomAligned}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition
        {...(onStartReached ? { onStartReached: () => onStartReached() } : {})}
        onItemSizeChanged={onItemSizeChanged}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header ? <>{header}</> : null}
        ListFooterComponent={footer ? <>{footer}</> : null}
        ListEmptyComponent={empty ? <>{empty}</> : null}
        // 键盘开着时点列表里的按钮，按钮照样生效（原生；web 上 Legend List 把多的属性写到 div 上，不传）。
        {...(Platform.OS === 'web' ? {} : { keyboardShouldPersistTaps: 'handled' as const })}
        style={LIST_STYLE}
      />
      {!atBottom ? (
        <NewContentButton
          testID={testID}
          label={newCount > 0 ? (newCountLabel ?? m.newMessagesCount)(newCount) : newContentLabelProp ?? (newGrowing ? m.newMessages : m.backToLatest)}
          onPress={backToBottom}
        />
      ) : null}
    </Column>
  );
}

// 不虚拟化：每一块都画在普通的滚动区里（测试的 DOM 环境里量不出行高，虚拟化以后一块也不画）。跟随底部、「新消息 ↓」都没有。
function ChatListAll<T>({
  data, keyExtractor, renderItem, testID, bottomAligned = true, gap = 'conversation-block', header, footer, empty,
}: ChatListProps<T>) {
  const Separator = useGapSeparator(gap, testID);
  const scrollRef = useRef<ScrollAreaHandle | null>(null);
  // 第一次有了内容时落到最底下。
  const placed = useRef(false);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    if (placed.current || height <= 0) return;
    placed.current = true;
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  return (
    <Column testID={testID} flex={1} minH={0} position="relative">
      <ScrollArea ref={scrollRef} testID={testID ? `${testID}-scroller` : undefined} fillContent onContentSizeChange={onContentSizeChange}>
        <Column grow={1} shrink={0} flexBasis="auto" justify={bottomAligned ? 'flex-end' : 'flex-start'}>
          {header}
          {data.length ? data.map((item, index) => (
            <Column key={keyExtractor(item)}>
              {renderItem(item, index)}
              {index < data.length - 1 ? <Separator /> : null}
            </Column>
          )) : empty}
          {footer}
        </Column>
      </ScrollArea>
    </Column>
  );
}

function NewContentButton({ testID, label, onPress }: { testID: string | undefined; label: string; onPress: () => void }) {
  const m = useMessages(displayMessages);
  return (
    <Box position="absolute" b={12} l={0} r={0} items="center" pointerEvents="box-none">
      <Pressable
        testID={testID ? `${testID}-new` : undefined}
        role="button"
        aria-label={m.newMessagesJump(label)}
        onPress={onPress}
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
          <Text size="12" weight="bold" tone="accent">{label}</Text>
          <Icon name="arrow-down" size={12} color="accent" weight="semibold" />
        </Row>
      </Pressable>
    </Box>
  );
}
