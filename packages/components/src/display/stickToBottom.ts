// 会话流的贴底规则。抽成纯函数而不是散在组件的回调里，才测得到。
//
// 「默认滚到底部」不等于「无条件拽回底部」：用户往上翻看历史时被强制拉下来是更糟的体验。
// 规则是——默认贴底；用户上滚超过阈值就松开；滚回底部附近再重新贴上。
export const STICK_THRESHOLD_PX = 48;

export function isNearBottom(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  threshold = STICK_THRESHOLD_PX,
): boolean {
  // 内容比视口还短时永远算贴底：此时根本没有可滚动的距离，
  // 不这么判会让首屏消息不足一屏的会话永远处于"未贴底"，之后新消息就不跟了。
  if (contentHeight <= viewportHeight) return true;
  return contentHeight - (offsetY + viewportHeight) <= threshold;
}

// 只看 isNearBottom 会有一个竞态：scrollToEnd 之后内容还在继续变长（卡片异步渲染），
// 中途的 onScroll 拿着旧几何算出"未贴底"，把贴底标志松开——实测停在离底 1613px 处。
// 内容变长只会推高 scrollHeight，不会让 offsetY 变小，所以判据改成：
// **只有用户主动往上滚（offsetY 明显减少）才松开**；滚回底部附近再重新贴上。
export function nextStick(
  prev: { stuck: boolean; offsetY: number },
  next: { offsetY: number; contentHeight: number; viewportHeight: number },
  threshold = STICK_THRESHOLD_PX,
): { stuck: boolean; offsetY: number } {
  const nearBottom = isNearBottom(next.offsetY, next.contentHeight, next.viewportHeight, threshold);
  if (nearBottom) return { stuck: true, offsetY: next.offsetY };
  const scrolledUp = next.offsetY < prev.offsetY - 1;
  return { stuck: scrolledUp ? false : prev.stuck, offsetY: next.offsetY };
}

// ——— 聊天列表的跟随（ChatScroll）———
//
// 2026-10-16 用户要求（工单对话和主会话一样）：
//   · 打开会话、切换工单时落在最底下（最新一条），看不到从顶部跳下来的过程；
//   · 你发出一条消息时回到底部；
//   · agent 边回答边变长时，列表平滑地跟着内容走，不抖；
//   · 你往上翻看历史时不把你拽下来，只在底部给一个「新消息 ↓」，点它回到底部；回到底部以后继续跟随。
// 规则写成纯函数，组件只负责量尺寸和执行滚动，规则可以单独测。

export type ChatFollow = {
  /** 贴着底部：内容变长时跟着滚。 */
  stuck: boolean;
  offsetY: number;
  /** 上一次看到的内容高度。只有变高才算「有新内容」。 */
  contentHeight: number;
  /** 上一次看到的内容宽度。宽度变了是重新排版（会话栏变宽、变窄），不是新内容。0 表示还没量到。 */
  contentWidth: number;
  /** 已经落到初始位置（底部）。之前内容不显示，避免看到从顶部跳下来。 */
  positioned: boolean;
  /** 你离开底部以后，下面来了新内容：显示「新消息 ↓」。 */
  newBelow: boolean;
};

export const INITIAL_CHAT_FOLLOW: ChatFollow = { stuck: true, offsetY: 0, contentHeight: 0, contentWidth: 0, positioned: false, newBelow: false };

/**
 * 怎样滚：jump 直接到底（首屏、差得太远），follow 平滑跟随，none 不动，
 * reflow 是宽度变了重新排版：按 chatReflowAnchor 留住一块内容的高度，不往底部滚。
 */
export type ChatScrollMove = 'jump' | 'follow' | 'none' | 'reflow';

type Geometry = { offsetY: number; contentHeight: number; viewportHeight: number; contentWidth?: number };

/** 滚动了（你滚的，或者跟随滚的）：按 nextStick 更新贴底；回到底部时收起「新消息」。 */
export function chatFollowOnScroll(state: ChatFollow, geometry: Geometry, threshold = STICK_THRESHOLD_PX): ChatFollow {
  const stick = nextStick(state, geometry, threshold);
  return { ...state, ...stick, newBelow: stick.stuck ? false : state.newBelow };
}

/** 内容高度变了（新消息、流式输出、展开折叠）：决定要不要滚、怎样滚。 */
export function chatFollowOnContent(
  state: ChatFollow,
  geometry: Geometry,
): { state: ChatFollow; move: ChatScrollMove } {
  const grew = geometry.contentHeight > state.contentHeight + 1;
  const width = geometry.contentWidth ?? state.contentWidth;
  const base = { ...state, contentHeight: geometry.contentHeight, contentWidth: width };
  if (!state.positioned) {
    return { state: { ...base, positioned: geometry.contentHeight > 0, stuck: true, newBelow: false }, move: 'jump' };
  }
  // 宽度变了：同样的内容换了行，变高或变矮。不算新内容，也不往底部滚（见 chatReflowAnchor）。
  if (state.contentWidth > 0 && Math.abs(width - state.contentWidth) > 0.5) return { state: base, move: 'reflow' };
  if (state.stuck) {
    // 一次差出一整屏以上（会话刚加载完、一次来了很多条）：直接到位，不播一段长长的滚动。
    const distance = geometry.contentHeight - geometry.viewportHeight - geometry.offsetY;
    return { state: base, move: geometry.viewportHeight > 0 && distance > geometry.viewportHeight ? 'jump' : 'follow' };
  }
  return { state: { ...base, newBelow: state.newBelow || grew }, move: 'none' };
}

/** 回到底部并继续跟随：你发了消息，或者点了「新消息 ↓」。 */
export function chatFollowToBottom(state: ChatFollow): ChatFollow {
  return { ...state, stuck: true, newBelow: false };
}

// ——— 会话栏变宽、变窄（2026-10-16）———
//
// 工单面板打开、关闭时，会话栏的宽度变了，内容重新排版。实测（1440 宽，面板打开）：你点的工单卡往下跳了 19 px，
// 下面还冒出「新消息 ↓」。规则：
//   · 重新排版不是新内容：不显示「新消息 ↓」，也不因为变高而滚动（chatFollowOnContent 返回 reflow）；
//   · 你刚点的那一块（例如打开面板的工单卡）留在原来的高度；
//   · 没点过：贴着底部时留在底部；不在底部时，可视区中间的那一块留在原来的高度。

/** 你按下的那一块在这段时间里算「刚点的」。更早按的不算：那时的位置你已经不记得了。 */
export const PRESSED_ANCHOR_MS = 10_000;

/** 宽度变了以后留住哪里：你刚点的那一块、底部、可视区中间的那一块。 */
export type ChatReflowAnchor = 'pressed' | 'bottom' | 'middle';

export function chatReflowAnchor(state: ChatFollow, pressed: { visible: boolean; ageMs: number } | null): ChatReflowAnchor {
  if (pressed && pressed.visible && pressed.ageMs <= PRESSED_ANCHOR_MS) return 'pressed';
  return state.stuck ? 'bottom' : 'middle';
}
